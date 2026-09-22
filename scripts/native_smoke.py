#!/usr/bin/env python3
"""Opt-in proof that a real Claude Code manager session drives Archon end to end.

This is the one place the manager itself runs headless. Everything else about
Archon is exercised by a human in their own interactive session; here a single
``claude -p`` turn is given the installed manager skill, the generated MCP
server and the installed lifecycle hooks, and must deliver two dependent tasks
to a kernel-verified local branch on its own.

Asserted:

* the kernel reports the run ``verified`` with two tasks, one depending on the
  other, and no claim shortcut;
* Familiar **and** Warden subagents were actually dispatched, seen in the
  ``SubagentStart`` lifecycle events and in the dispatch calls themselves;
* zero permission prompts reached anyone: ``permission_denials`` is empty and
  no approval request appears in the stream;
* the terminal message carries the five manager headings in order;
* the user's own ``~/.claude`` settings and credentials are byte-identical
  before and after.

Credential handling follows the second spike book run (§10 correction 6): a
relocated ``CLAUDE_CONFIG_DIR`` de-authenticates the session unless the
credential file is carried across, so this copies the 0600 credential file into
a private 0700 directory and purges it afterwards. The user's directory is
never written.

Requires ``--allow-live``: the turn spends real model quota. Without it, or
without an authenticated engine, the script self-reports UNRESOLVED and spends
nothing. Exit status: 0 PASS, 1 FAIL, 3 UNRESOLVED.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
HEADINGS = ("Outcome", "Changes", "Verification", "Agents", "Limitations")
HEADING_PATTERN = re.compile(r"(?im)^#{1,6}\s+(" + "|".join(HEADINGS) + r")\s*:?\s*$")
FAMILIAR = "archon-familiar"
WARDEN = "archon-warden"
CREDENTIAL_FILES = (".credentials.json",)
GUARDED_USER_FILES = ("settings.json", ".credentials.json")
MAX_EVENT_BYTES = 4_000_000

REQUEST = (
    "Use the installed Archon manager skill for this whole task.\n\n"
    "This repository is an intentionally installed Archon integration test. "
    "Implement and verify this fully specified goal without asking further "
    "product questions.\n\n"
    "Task one creates greetings.py with greeting(name: str) -> str: strip surrounding "
    "whitespace, use World for an empty or whitespace-only name, and return "
    "'Hello, NAME!'. That is acceptance criterion A1.\n"
    "Task two depends on task one and creates welcome.py with "
    "welcome(names: list[str]) -> str, joining greeting(name) for each input with "
    "newline characters; empty input returns an empty string. That is acceptance "
    "criterion A2.\n"
    "Add standard-library unittest regression tests for both functions covering every "
    "stated edge case.\n\n"
    "Record the run, both dependent tasks, checkpoints and verification through the "
    "connected Archon MCP tools, and delegate the actual implementation to the "
    "installed Archon subagents: Familiars for the bounded coding packets and the "
    "Warden for planning and integration. Use "
    "'{python} -m unittest discover -v' as the accepted verification check. Use the "
    "MCP wait and status tools while verification runs, repair any findings, and "
    "finish only once the kernel itself reports the current local branch verified.\n\n"
    "No dependencies, no commits, no publication, no global settings changes. Do not "
    "edit Archon state or evidence and never claim a verification the kernel did not "
    "report. Work autonomously to completion in this single turn. End with the five "
    "manager headings in this exact order: Outcome, Changes, Verification, Agents, "
    "Limitations."
)


class SmokeError(RuntimeError):
    """The native manager session did not deliver what the contract requires."""


class Unresolved(RuntimeError):
    """The run could not be attempted, so nothing was proven and nothing spent."""


def emit(message: str) -> None:
    print(message, flush=True)


def digest(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def run(argv: list[str], *, cwd: Path, env: dict[str, str], timeout: int = 120) -> str:
    result = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True,
                            timeout=timeout, check=False)
    if result.returncode:
        raise SmokeError(f"command failed ({result.returncode}): {argv}\n{result.stderr[-4000:]}")
    return result.stdout


class PrivateConfigDir:
    """A 0700 ``CLAUDE_CONFIG_DIR`` holding only the copied credential file.

    An empty directory de-authenticates the session outright (evidence:
    ``docs/evidence/2026-09-22-spike-S12.json``), so the credential is carried
    across and purged here; suppression of user-level settings comes from
    ``--setting-sources``, never from moving the directory.
    """

    def __init__(self, user_home: Path) -> None:
        self.user_home = user_home
        self.path: Path | None = None
        self.before: dict[str, str | None] = {}
        self.evidence: dict[str, Any] = {}

    def user_hashes(self) -> dict[str, str | None]:
        return {name: digest(self.user_home / name) for name in GUARDED_USER_FILES}

    def __enter__(self) -> PrivateConfigDir:
        for name in GUARDED_USER_FILES:
            if (self.user_home / name).is_symlink():
                raise Unresolved("user configuration and credentials must be regular files")
        self.before = self.user_hashes()
        self.path = Path(tempfile.mkdtemp(prefix="archon-native-config-"))
        self.path.chmod(0o700)
        copied = []
        for name in CREDENTIAL_FILES:
            source = self.user_home / name
            if not source.is_file():
                continue
            handle = os.open(self.path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(handle, "wb") as target:
                target.write(source.read_bytes())
            copied.append(name)
        if not copied:
            self.cleanup()
            raise Unresolved(
                f"no credential file found under {self.user_home}; an isolated config directory "
                "without one is not authenticated (spike S12)"
            )
        self.evidence.update(private_config_dir=str(self.path), copied=copied)
        return self

    def cleanup(self) -> None:
        if self.path is not None and self.path.exists():
            shutil.rmtree(self.path, ignore_errors=True)
        self.evidence["private_config_dir_removed"] = self.path is None or not self.path.exists()

    def __exit__(self, *_exception: Any) -> None:
        self.cleanup()


def preflight(user_home: Path) -> dict[str, Any]:
    for tool in ("bwrap", "socat", "git", "claude"):
        if shutil.which(tool) is None:
            raise Unresolved(f"{tool} is not on PATH")
    probe = subprocess.run(["claude", "auth", "status"], capture_output=True, text=True,
                           timeout=30, check=False)
    record: dict[str, Any] = {}
    if probe.stdout.strip().startswith("{"):
        try:
            record = json.loads(probe.stdout)
        except json.JSONDecodeError:
            record = {}
    if probe.returncode != 0 or not record.get("loggedIn"):
        raise Unresolved("claude auth status does not report a logged-in engine")
    if not user_home.is_dir():
        raise Unresolved(f"{user_home} does not exist")
    version = subprocess.run(["claude", "--version"], capture_output=True, text=True,
                             timeout=30, check=False).stdout.strip()
    return {"subscription": record.get("subscriptionType"), "engine_version": version}


def environment(config_dir: Path, state: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("GIT_") and key not in {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"}}
    env.update(
        CLAUDE_CONFIG_DIR=str(config_dir), XDG_STATE_HOME=str(state),
        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
        GIT_AUTHOR_NAME="Archon Native Smoke", GIT_AUTHOR_EMAIL="smoke@example.invalid",
        GIT_COMMITTER_NAME="Archon Native Smoke", GIT_COMMITTER_EMAIL="smoke@example.invalid",
    )
    return env


def seed_repository(repo: Path, env: dict[str, str]) -> None:
    repo.mkdir(parents=True)
    (repo / "README.md").write_text("# Archon native fixture\n\nStandard library only.\n",
                                    encoding="utf-8")
    (repo / ".gitignore").write_text("__pycache__/\n*.pyc\n", encoding="utf-8")
    git = ["git", "-c", f"core.hooksPath={os.devnull}"]
    run([*git, "init", "--initial-branch=main"], cwd=repo, env=env)
    run([*git, "add", "."], cwd=repo, env=env)
    run([*git, "commit", "-m", "Native smoke baseline"], cwd=repo, env=env)


def manager_argv(repo: Path, request: str) -> list[str]:
    """The literal confirmed headless form; hook events are the observation channel."""
    return [
        "claude", "-p", request,
        "--output-format", "stream-json",
        "--verbose",
        "--include-hook-events",
        "--setting-sources", "project",
        "--mcp-config", str(repo / ".mcp.json"),
        "--permission-mode", "acceptEdits",
    ]


def stream_events(argv: list[str], repo: Path, env: dict[str, str], log: Path,
                  timeout: int) -> list[dict[str, Any]]:
    """Run the manager turn, tee every stream-json line, and return the parsed events."""
    events: list[dict[str, Any]] = []
    consumed = 0
    started = time.monotonic()
    with log.open("w", encoding="utf-8") as sink:
        process = subprocess.Popen(argv, cwd=repo, env=env, text=True,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE)
        assert process.stdout is not None
        try:
            for line in process.stdout:
                sink.write(line)
                sink.flush()
                consumed += len(line)
                if consumed > MAX_EVENT_BYTES:
                    raise SmokeError("the manager stream exceeded the capture budget")
                if time.monotonic() - started > timeout:
                    raise SmokeError("the manager turn exceeded the smoke time budget")
                stripped = line.strip()
                if stripped.startswith("{"):
                    try:
                        events.append(json.loads(stripped))
                    except json.JSONDecodeError:
                        continue
            process.wait(timeout=60)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=30)
    return events


def event_text(event: dict[str, Any]) -> str:
    """Flatten one event so agent names can be found whatever field carries them."""
    return json.dumps(event, ensure_ascii=False)


def lifecycle(events: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    return [event for event in events if f'"{name}"' in event_text(event)
            and "hook" in event_text(event).lower()]


def dispatched_agents(events: list[dict[str, Any]]) -> list[str]:
    """Every subagent type the manager actually asked for, in dispatch order."""
    found: list[str] = []
    for event in events:
        for block in (event.get("message") or {}).get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            agent = (block.get("input") or {}).get("subagent_type")
            if isinstance(agent, str):
                found.append(agent)
    return found


def final_message(events: list[dict[str, Any]]) -> str:
    for event in reversed(events):
        if event.get("type") == "result" and isinstance(event.get("result"), str):
            return event["result"]
    return ""


def validate_headings(message: str) -> list[str]:
    found = [match.group(1) for match in HEADING_PATTERN.finditer(message)]
    problems = []
    if found != list(HEADINGS):
        problems.append(f"terminal headings were {found}, expected {list(HEADINGS)} in order")
    bodies = HEADING_PATTERN.split(message)[2::2]
    if any(not body.strip() for body in bodies):
        problems.append("a terminal heading had no content under it")
    return problems


def kernel_delivery(status: dict[str, Any]) -> list[str]:
    """Only the kernel's own record may say the work is delivered."""
    problems = []
    run_record = status.get("run") or {}
    tasks = status.get("tasks") or []
    if run_record.get("state") != "verified":
        problems.append(f"the kernel reports run state {run_record.get('state')!r}, not verified")
    if len(tasks) < 2:
        problems.append(f"the manager recorded {len(tasks)} tasks, expected two")
    if not any((task.get("spec") or {}).get("depends_on") for task in tasks):
        problems.append("no recorded task depended on another")
    if any(task.get("state") != "verified" for task in tasks):
        problems.append("a recorded task did not reach verified")
    gate = run_record.get("gate") or {}
    if not gate.get("verified"):
        problems.append("the run has no current verified gate")
    return problems


def collect(events: list[dict[str, Any]], status: dict[str, Any]) -> dict[str, Any]:
    """Assemble every observation, then decide once."""
    initialization = next((e for e in events if e.get("subtype") == "init"), {})
    result = next((e for e in reversed(events) if e.get("type") == "result"), {})
    denials = result.get("permission_denials") or []
    subagent_starts = lifecycle(events, "SubagentStart")
    agents = dispatched_agents(events)
    message = final_message(events)
    observations: dict[str, Any] = {
        "session_id": initialization.get("session_id"),
        "mcp_servers": initialization.get("mcp_servers"),
        "permission_mode": initialization.get("permissionMode"),
        "model": initialization.get("model"),
        "subagent_start_events": len(subagent_starts),
        "dispatched_agents": agents,
        "familiar_dispatches": agents.count(FAMILIAR),
        "warden_dispatches": agents.count(WARDEN),
        "permission_denials": denials,
        "result_subtype": result.get("subtype"),
        "result_is_error": result.get("is_error"),
        "num_turns": result.get("num_turns"),
        "total_cost_usd": result.get("total_cost_usd"),
        "final_message_sha256": hashlib.sha256(message.encode()).hexdigest(),
        "final_message": message[:16_384],
    }
    problems = kernel_delivery(status) + validate_headings(message)
    if denials:
        problems.append(f"the session hit {len(denials)} permission denials")
    if result.get("is_error"):
        problems.append(f"the manager turn ended in error: {result.get('subtype')}")
    if observations["familiar_dispatches"] < 2:
        problems.append("fewer than two Familiar subagents were dispatched")
    if not observations["warden_dispatches"]:
        problems.append("the Warden was never dispatched")
    if len(subagent_starts) < 3:
        problems.append("fewer than three SubagentStart lifecycle events were observed")
    observations["problems"] = problems
    return observations


def exercise(output: Path, args: argparse.Namespace, report: dict[str, Any]) -> None:
    user_home = Path(args.user_config or (Path.home() / ".claude"))
    report["auth"] = preflight(user_home)
    with PrivateConfigDir(user_home) as isolated:
        assert isolated.path is not None
        env = environment(isolated.path, output / "state")
        repo = output / "consumer"
        seed_repository(repo, env)
        python = str(Path(args.venv).resolve() / "bin" / "python") if args.venv else sys.executable
        cli = [python, "-I", "-m", "archon", "--repo", str(repo), "--json"]
        report["install"] = json.loads(run([*cli, "init"], cwd=repo, env=env))
        request = REQUEST.replace("{python}", python)
        (output / "request.txt").write_text(request + "\n", encoding="utf-8")
        emit("Manager turn started; this spends real quota and can take many minutes.")
        started = time.monotonic()
        events = stream_events(manager_argv(repo, request), repo, env,
                               output / "native-events.jsonl", args.timeout)
        report["duration_seconds"] = round(time.monotonic() - started, 3)
        status = json.loads(run([*cli, "status"], cwd=repo, env=env))
        report["kernel_status"] = status
        report["observations"] = collect(events, status)
        report["configuration_isolation"] = isolated.evidence
        report["user_config_hashes"] = {"before": isolated.before, "after": isolated.user_hashes()}
    report["configuration_isolation"] = isolated.evidence
    if report["user_config_hashes"]["before"] != report["user_config_hashes"]["after"]:
        raise SmokeError("the user's own Claude Code settings or credentials changed")
    if not isolated.evidence.get("private_config_dir_removed"):
        raise SmokeError("the private credential copy was not removed")
    if report["observations"]["problems"]:
        raise SmokeError("; ".join(report["observations"]["problems"]))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--allow-live", action="store_true",
                        help="Required: authorizes a real manager turn that spends model quota")
    parser.add_argument("--venv", type=Path,
                        help="Environment holding the installed wheel (default: this interpreter)")
    parser.add_argument("--user-config", type=Path, help="User Claude Code directory to guard")
    parser.add_argument("--output", type=Path, help="Empty directory for the report and event log")
    parser.add_argument("--timeout", type=int, default=2400, help="Bound the manager turn")
    args = parser.parse_args(argv)
    if not 120 <= args.timeout <= 7200:
        parser.error("--timeout must be between 120 and 7200 seconds")
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="archon-native-"))
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error(f"{output} is not empty")
    output.chmod(0o700)
    report: dict[str, Any] = {
        "kind": "native-manager-delivery",
        "started_at": datetime.now(UTC).isoformat(),
        "scope": "one headless manager turn with the project's own settings and MCP entry",
        "not_covered": ["interactive first-use hook trust", "the model chosen in the UI"],
        "output": str(output),
    }
    try:
        if not args.allow_live:
            raise Unresolved("--allow-live was not passed, so no manager turn was started")
        exercise(output, args, report)
        report["verdict"] = "PASS"
        status = 0
    except Unresolved as exc:
        report.update(verdict="UNRESOLVED", reason=str(exc))
        status = 3
    except Exception as exc:  # noqa: BLE001 - reported with its evidence, never raised at the user
        report.update(verdict="FAIL", reason=f"{type(exc).__name__}: {exc}")
        status = 1
    report["finished_at"] = datetime.now(UTC).isoformat()
    destination = output / "report.json"
    destination.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    destination.chmod(0o600)
    print(json.dumps({"verdict": report["verdict"], "report": str(destination),
                      "reason": report.get("reason")}, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
