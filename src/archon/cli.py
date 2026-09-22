"""Administrative command line and local MCP entry point.

Normal engineering work stays in the Claude Code conversation. These commands
expose the same kernel operations for setup, inspection, capability probing and
automated diagnostics. Every subcommand here is documented in
``docs/operations.md``; nothing documented there is missing from this parser.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 1_048_576
MAX_CAPTURED_OUTPUT = 65_536
SPIKE_RUNNER = ("scripts", "spikes", "run_all.py")
# A job that is still queued, running, or parked on a provider usage window has
# not failed; it simply has no result yet.
UNFINISHED_EXIT = 3
FAILED_JOB_STATES = frozenset({"failed", "cancelled", "interrupted"})


def _setup_commands(commands: argparse._SubParsersAction) -> None:
    """Installation, host entry points, and the capability spike book."""
    init = commands.add_parser("init", help="Install the repository-local Claude Code integration")
    init.add_argument("--migrate", action="store_true", help="Migrate recognized legacy Archon or DevGod integration")
    init.add_argument("--fable", action="store_true", help="Let the Oracle agent use fable; otherwise it pins opus/max")
    init.add_argument("--gitignore", action="store_true", help="Create .gitignore when absent to exclude private state")
    commands.add_parser("doctor", help="Inspect installation and local runtime capabilities")
    commands.add_parser("uninstall", help="Remove only Archon-owned repository integration")
    commands.add_parser("mcp", help="Run the local stdio MCP server")
    commands.add_parser("hook", help="Handle one native Claude Code lifecycle event from stdin")

    spikes = commands.add_parser("spikes", help="Run the capability spike book and record its evidence")
    spikes.add_argument("--id", nargs="+", metavar="ID", help="Run only these spike ids (default: the whole book)")
    spikes.add_argument("--allow-live", action="store_true",
                        help="Authorize live engine calls that spend real money; without it live spikes self-report UNRESOLVED")
    spikes.add_argument("--budget-usd", type=float, help="Total live-spend ceiling for this run")


def _work_commands(commands: argparse._SubParsersAction) -> None:
    """Recording an accepted plan and the progress claimed against it."""
    start = commands.add_parser("start", help="Start an accepted goal on a local delivery branch")
    start.add_argument("--goal", required=True)
    start.add_argument("--acceptance", action="append", required=True, metavar="ID:DESCRIPTION")
    start.add_argument("--branch", help="Delivery branch name; automatically generated when omitted")
    start.add_argument("--tasks", type=Path, help="JSON array of accepted task specifications")
    start.add_argument("--checks", type=Path, help="JSON array of accepted check specifications")
    start.add_argument("--decisions", type=Path, help="JSON object of accepted design decisions")

    plan = commands.add_parser("plan", help="Add or amend task scopes and accepted verification checks")
    plan.add_argument("--run", dest="run_id")
    plan.add_argument("--tasks", type=Path, help="JSON array of task specifications to add or amend")
    plan.add_argument("--checks", type=Path, help="JSON array replacing accepted check specifications")

    for name in ("status", "next", "resume", "cancel"):
        command = commands.add_parser(name, help=f"{name.capitalize()} the selected or current run")
        command.add_argument("run_id", nargs="?")

    task = commands.add_parser("task", help="Record task plans and implementation claims")
    task_commands = task.add_subparsers(dest="task_command", required=True)
    add = task_commands.add_parser("add", help="Add or replace one planned task")
    add.add_argument("--run", dest="run_id")
    add.add_argument("--id", required=True, dest="task_id")
    add.add_argument("--title", required=True)
    add.add_argument("--role", required=True)
    add.add_argument("--acceptance", action="append", required=True)
    add.add_argument("--depends-on", action="append", default=[])
    add.add_argument("--path", action="append", required=True)
    update = task_commands.add_parser("update", help="Record implementation progress; cannot grant verification")
    update.add_argument("task_id")
    update.add_argument("--run", dest="run_id")
    update.add_argument("--state", choices=("planned", "implementing", "repair", "blocked"))
    update.add_argument("--complete", action="store_true", help="Claim implementation complete for verification")
    update.add_argument("--summary", default="")
    listing = task_commands.add_parser("list", help="Show tasks in the run")
    listing.add_argument("--run", dest="run_id")

    checkpoint = commands.add_parser("checkpoint", help="Save or inspect continuation context")
    checkpoint_commands = checkpoint.add_subparsers(dest="checkpoint_command", required=True)
    save = checkpoint_commands.add_parser("save")
    save.add_argument("--run", dest="run_id")
    save.add_argument("--summary", required=True)
    save.add_argument("--decisions", type=Path)
    save.add_argument("--next-action", action="append", default=[])
    show = checkpoint_commands.add_parser("show")
    show.add_argument("--run", dest="run_id")


def _execution_commands(commands: argparse._SubParsersAction) -> None:
    """The commands that own a job's outcome."""
    verify = commands.add_parser("verify", help="Execute checks and independent reviews; wait for the result")
    verify.add_argument("run_id", nargs="?")
    recover = commands.add_parser("recover", help="Record inspection of interrupted effects and safely rerun verification")
    recover.add_argument("job_id")
    recover.add_argument("--attempt", type=int, required=True)
    recover.add_argument("--candidate-digest", required=True)
    recover.add_argument("--checks-digest", required=True)
    recover.add_argument("--observations", required=True, help="Manager's inspection of possible effects; never a passing receipt")
    wait = commands.add_parser("wait", help="Wait for a job owned by a running MCP service")
    wait.add_argument("job_id")
    wait.add_argument("--timeout", type=float, default=30.0, help="Maximum wait in seconds (0–60)")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="archon", description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="Consuming Git worktree")
    parser.add_argument("--state-home", type=Path, help="Private state location (default: XDG_STATE_HOME)")
    parser.add_argument("--json", action="store_true", help="Print structured JSON")
    commands = parser.add_subparsers(dest="command", required=True)
    _setup_commands(commands)
    _work_commands(commands)
    _execution_commands(commands)
    return parser


def _read_json(path: Path) -> Any:
    with path.open("rb") as stream:
        data = stream.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("JSON input exceeds the 1 MiB limit")
    return json.loads(data)


def _criteria(values: list[str]) -> list[dict[str, str]]:
    result = []
    for value in values:
        key, separator, description = value.partition(":")
        if not separator or not key.strip() or not description.strip():
            raise ValueError("Acceptance must use ID:DESCRIPTION")
        result.append({"acceptance_id": key.strip(), "description": description.strip()})
    return result


def _action_line(action: dict[str, Any]) -> str:
    """Render the deterministic next action the way a person has to act on it."""
    inputs = action.get("inputs") or {}
    job_id = inputs.get("job_id") or (inputs.get("job_ids") or [None])[0]
    parts = [f"next_action: {action.get('action', 'unknown')}"]
    if action.get("task_id"):
        parts.append(f"task {action['task_id']}")
    if job_id:
        parts.append(f"job {job_id}")
    resume_at = inputs.get("resume_at")
    if isinstance(resume_at, (int, float)) and not isinstance(resume_at, bool):
        moment = datetime.fromtimestamp(float(resume_at), UTC).isoformat(timespec="seconds")
        parts.append(f"resumes at {moment} (epoch {int(resume_at)})")
    line = " · ".join(parts)
    reason = action.get("reason")
    return f"{line}\n  {reason}" if reason else line


def _human(value: Any) -> str:
    """Keep inspectable structured detail without leaking protocol chatter."""
    if isinstance(value, dict):
        if "error" in value:
            error = value["error"]
            if isinstance(error, dict):
                return f"{error.get('code', 'error')}: {error.get('message', error)}"
            return str(error)
        lines = []
        for key, item in value.items():
            if key == "next_action" and isinstance(item, dict) and item.get("action"):
                lines.append(_action_line(item))
            elif isinstance(item, (dict, list)):
                lines.append(f"{key}: {json.dumps(item, ensure_ascii=False, sort_keys=True)}")
            elif item is not None:
                lines.append(f"{key}: {item}")
        return "\n".join(lines) or "No active Archon run."
    if isinstance(value, list):
        return "\n".join(_human(item) for item in value) or "No records."
    return str(value)


def _print(value: Any, *, as_json: bool, error: bool = False) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True) if as_json else _human(value),
          file=sys.stderr if error and not as_json else sys.stdout)


def _record(service: Any, args: argparse.Namespace) -> Any:
    """Task scopes, implementation claims, and continuation context.

    None of these can grant verification: an update may claim readiness, never a
    verified state, and a checkpoint stores the manager's own words verbatim.
    """
    from .mcp_server import selected_run
    from .models import TaskSpec

    run_id = selected_run(service, args.run_id)
    if args.command == "checkpoint":
        if args.checkpoint_command != "save":
            return {"run_id": run_id, "checkpoint": service.status(run_id)["run"].get("checkpoint")}
        return service.checkpoint(run_id, {
            "summary": args.summary,
            "decisions": _read_json(args.decisions) if args.decisions else {},
            "next_actions": args.next_action,
        })
    if args.task_command == "add":
        spec = TaskSpec(task_id=args.task_id, title=args.title, owner_role=args.role,
                        acceptance=args.acceptance, depends_on=args.depends_on,
                        allowed_paths=args.path)
        return service.plan(run_id, [spec])
    if args.task_command == "list":
        return {"run_id": run_id, "tasks": service.status(run_id)["tasks"]}
    if args.complete and args.state:
        raise ValueError("Use either --complete or --state for a task update")
    if not args.complete and not args.state:
        raise ValueError("Task update requires --state or --complete")
    return service.task_update(run_id, args.task_id,
                               "verifying" if args.complete else args.state, summary=args.summary)


def _job_state(result: Any) -> str | None:
    job = result.get("job", result) if isinstance(result, dict) else {}
    state = job.get("state", job.get("status"))
    return str(state) if state is not None else None


async def _execute(runtime: Any, args: argparse.Namespace) -> tuple[Any, int]:
    """The three commands that own a job's outcome rather than just recording one."""
    from .mcp_server import jsonable, wait_for_job

    service = runtime.service
    if args.command == "wait":
        result = await wait_for_job(service, args.job_id, args.timeout)
        state = _job_state(result)
        if state == "succeeded":
            return result, 0
        return result, 1 if state in FAILED_JOB_STATES else UNFINISHED_EXIT
    if args.command == "recover":
        started = jsonable(await service.recover(
            args.job_id, args.attempt, args.candidate_digest, args.checks_digest, args.observations,
        ))
    else:
        started = jsonable(await service.verify(args.run_id))
    job_id = started.get("job", started)["job_id"]
    # The CLI has no resident loop after exit, so it owns execution until the job
    # completes; only MCP can return promptly while keeping its worker alive.
    await runtime.runner.wait(job_id)
    result = jsonable(service.verification_status(job_id))
    state = _job_state(result)
    if state == "succeeded" and result.get("run", {}).get("state") == "verified":
        return result, 0
    # A closed provider usage window parks the job; the manager waits it out and
    # resumes. That is unfinished work, never a failed gate.
    return result, UNFINISHED_EXIT if state == "paused" else 1


async def _dispatch(args: argparse.Namespace) -> tuple[Any, int]:
    from .mcp_server import jsonable, open_runtime, selected_run
    from .models import AcceptanceCriterion, CheckSpec, TaskSpec

    runtime = open_runtime(args.repo, args.state_home)
    try:
        service = runtime.service
        command = args.command
        if command == "start":
            result = service.start(
                args.goal,
                [AcceptanceCriterion.model_validate(item) for item in _criteria(args.acceptance)],
                [TaskSpec.model_validate(item) for item in _read_json(args.tasks)] if args.tasks else [],
                [CheckSpec.model_validate(item) for item in _read_json(args.checks)] if args.checks else [],
                decisions=_read_json(args.decisions) if args.decisions else {},
                branch=args.branch,
            )
        elif command == "status":
            result = service.status(args.run_id)
        elif command == "next":
            result = service.next_action(args.run_id)
        elif command == "resume":
            result = service.resume(args.run_id)
        elif command == "cancel":
            result = await service.cancel(args.run_id)
        elif command == "plan":
            if args.tasks is None and args.checks is None:
                raise ValueError("Plan requires --tasks or --checks")
            tasks = [TaskSpec.model_validate(item) for item in _read_json(args.tasks)] if args.tasks else []
            checks = [CheckSpec.model_validate(item) for item in _read_json(args.checks)] if args.checks else None
            result = service.plan(selected_run(service, args.run_id), tasks, checks=checks)
        elif command in {"task", "checkpoint"}:
            result = _record(service, args)
        elif command in {"verify", "recover", "wait"}:
            return await _execute(runtime, args)
        else:
            raise ValueError(f"Unsupported command: {command}")
        return jsonable(result), 0
    finally:
        await runtime.close()


def _spike_runner() -> Path:
    """The spike book ships with the source checkout, never inside the wheel."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent.joinpath(*SPIKE_RUNNER)
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "The capability spike book lives in the Archon source checkout, not in the installed "
        "distribution. Clone the repository and run `uv run python scripts/spikes/run_all.py`."
    )


def _spikes(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    """Shell out to the spike book; live spend stays opt-in for every run."""
    runner = _spike_runner()
    argv = [sys.executable, str(runner)]
    if args.id:
        argv.extend(["--id", *args.id])
    if args.allow_live:
        argv.append("--allow-live")
    if args.budget_usd is not None:
        argv.extend(["--budget-usd", str(args.budget_usd)])
    completed = subprocess.run(argv, cwd=runner.parents[2], text=True,
                               capture_output=args.json, check=False)
    report: dict[str, Any] = {"command": argv, "returncode": completed.returncode,
                              "allow_live": bool(args.allow_live),
                              "evidence": str(runner.parents[2] / "docs" / "evidence")}
    if args.json:
        report["stdout"] = (completed.stdout or "")[-MAX_CAPTURED_OUTPUT:]
        report["stderr"] = (completed.stderr or "")[-MAX_CAPTURED_OUTPUT:]
    return report, completed.returncode


async def _doctor(repo: Path) -> dict[str, Any]:
    from importlib.metadata import version

    from . import install
    from .claude_adapter import ClaudeAdapter

    result = install.doctor(repo)
    adapter = ClaudeAdapter()
    try:
        capabilities = await adapter.capabilities()
    finally:
        await adapter.close()
    result["runtime"] = {"python": sys.version.split()[0], "mcp": version("mcp"), **capabilities}
    result["ok"] = bool(result.get("ok", True) and capabilities.get("available"))
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "mcp":
            from .mcp_server import create_server

            create_server(args.repo, args.state_home).run(transport="stdio")
            return 0
        if args.command == "hook":
            from .hooks import main as hook_main

            hook_args = ["--repo", str(args.repo)]
            if args.state_home is not None:
                hook_args.extend(["--state-home", str(args.state_home)])
            return hook_main(hook_args)
        if args.command == "spikes":
            result, code = _spikes(args)
            _print(result, as_json=args.json)
            return code
        if args.command in {"init", "doctor", "uninstall"}:
            from . import install

            if args.command == "init":
                result = install.init(args.repo, migrate=args.migrate, state_home=args.state_home,
                                      fable=args.fable, gitignore=args.gitignore)
            elif args.command == "doctor":
                result = asyncio.run(_doctor(args.repo))
            else:
                result = getattr(install, args.command)(args.repo)
            _print(result, as_json=args.json)
            return 0 if result.get("ok", True) else 1
        result, code = asyncio.run(_dispatch(args))
        _print(result, as_json=args.json)
        return code
    except KeyboardInterrupt:
        _print({"error": {"code": "interrupted", "message": "Execution interrupted; recorded work is preserved."}},
               as_json=args.json and args.command != "mcp", error=True)
        return 130
    except Exception as exc:
        from .mcp_server import error_payload

        _print(error_payload(exc), as_json=args.json and args.command != "mcp", error=True)
        return 2 if isinstance(exc, (ValueError, KeyError)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
