#!/usr/bin/env python3
"""Opt-in authenticated proof that the kernel's gate is real.

In a fresh throwaway repository this runs the actual pipeline: a real check
under the real ``bwrap`` profile, then three real reviewer sessions of the
installed Claude Code engine. It asserts the sequence that cannot be faked —

1. the first ``verify`` **fails** on the real check and the run enters repair;
2. after the source is repaired, a fresh ``verify`` runs the real check and
   three Witnesses, each with a distinct ``session_id`` and a present
   ``structured_output``, and the gate reaches ``verified``;
3. one subsequent edit to a verified file flips the run straight back to
   ``repair``, because evidence binds to the candidate;
4. a planted egress attempt executed under the same check profile is denied.

The implementation steps are scripted, so this is not evidence about native
manager conversation or subagent delegation — that is ``native_smoke.py``.

Nothing here runs without ``--allow-live``: it spends real model quota. Without
an authenticated engine the script self-reports UNRESOLVED and spends nothing.
Recorded denial shapes for the check profile are in
``docs/evidence/2026-09-22-confinement.json``; this script records what it
observes rather than asserting a retyped error string.

Exit status: 0 PASS, 1 FAIL, 3 UNRESOLVED.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import archon  # noqa: E402
from archon.claude_adapter import ClaudeAdapter  # noqa: E402
from archon.models import CheckSpec, Policy  # noqa: E402
from archon.service import ArchonService  # noqa: E402
from archon.store import Store  # noqa: E402
from archon.verification import VerificationRunner  # noqa: E402
from archon.workspace import Workspace  # noqa: E402

ROLES = ("reviewer", "qa_engineer", "security_reviewer")
# Two independent egress attempts; either succeeding means the profile leaked.
EGRESS_PROBE = (
    "import socket, sys\n"
    "failures = []\n"
    "try:\n"
    "    socket.getaddrinfo('example.com', 443)\n"
    "    print('RESOLVED')\n"
    "except OSError as exc:\n"
    "    failures.append(f'{type(exc).__name__}: {exc}')\n"
    "try:\n"
    "    socket.create_connection(('93.184.216.34', 443), timeout=5).close()\n"
    "    print('CONNECTED')\n"
    "except OSError as exc:\n"
    "    failures.append(f'{type(exc).__name__}: {exc}')\n"
    "print('\\n'.join(failures))\n"
    "sys.exit(7 if len(failures) == 2 else 0)\n"
)
BROKEN_CALCULATOR = (
    '"""Integer summation for the live smoke fixture."""\n\n'
    "def subtotal(values):\n    return sum(values) + 1\n"
)
FIXED_CALCULATOR = (
    '"""Integer summation for the live smoke fixture."""\n\n'
    "def subtotal(values):\n    return sum(values)\n"
)
INVOICE = (
    '"""Invoice wrapper for integer amounts."""\n\n'
    "from calculator import subtotal\n\n\n"
    "def invoice_total(values):\n    return subtotal(values)\n"
)
VERIFY_SCRIPT = (
    "from calculator import subtotal\n"
    "from invoice import invoice_total\n"
    "for values, expected in [([], 0), ([2, 3], 5), ([-2, 3], 1)]:\n"
    "    assert subtotal(values) == expected, values\n"
    "    assert invoice_total(values) == expected, values\n"
    "print('SMOKE_CHECKS_OK')\n"
)


class SmokeError(RuntimeError):
    """The live pipeline did not behave as the gate requires."""


class Unresolved(RuntimeError):
    """The run could not be attempted, so nothing was proven and nothing spent."""


def emit(message: str) -> None:
    print(message, flush=True)


def fixture_git(root: Path, *args: str) -> None:
    """Administrative Git setup only; every measured command runs through the kernel."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="Archon live smoke", GIT_AUTHOR_EMAIL="smoke@example.invalid",
        GIT_COMMITTER_NAME="Archon live smoke", GIT_COMMITTER_EMAIL="smoke@example.invalid",
        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
    )
    subprocess.run(["git", "-c", f"core.hooksPath={os.devnull}", "-C", str(root), *args],
                   env=env, check=True, capture_output=True, timeout=60)


def preflight() -> dict[str, Any]:
    """Free, local checks first: never start a paid run that cannot possibly pass."""
    for tool in ("bwrap", "socat", "git", "claude"):
        if shutil.which(tool) is None:
            raise Unresolved(f"{tool} is not on PATH")
    probe = subprocess.run([shutil.which("claude") or "claude", "auth", "status"],
                           capture_output=True, text=True, timeout=30, check=False)
    record = {}
    if probe.stdout.strip().startswith("{"):
        try:
            record = json.loads(probe.stdout)
        except json.JSONDecodeError:
            record = {}
    if probe.returncode != 0 or not record.get("loggedIn"):
        raise Unresolved("claude auth status does not report a logged-in engine")
    return {"logged_in": True, "subscription": record.get("subscriptionType")}


def build_fixture(root: Path) -> Path:
    repository = root / "consumer"
    repository.mkdir(parents=True)
    (repository / ".gitignore").write_text("__pycache__/\n", encoding="utf-8")
    (repository / "calculator.py").write_text(BROKEN_CALCULATOR, encoding="utf-8")
    (repository / "verify.py").write_text(VERIFY_SCRIPT, encoding="utf-8")
    fixture_git(repository, "init", "--initial-branch=main")
    fixture_git(repository, "add", ".gitignore", "calculator.py", "verify.py")
    fixture_git(repository, "commit", "-m", "Create isolated live smoke fixture")
    return repository


def source_hashes() -> dict[str, str]:
    package = Path(archon.__file__).parent
    return {
        str(path.relative_to(package)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(package.rglob("*.py"))
    }


async def wait_for(runner: VerificationRunner, store: Store, run_id: str, job_id: str,
                   timeout: int) -> None:
    """Wait with progress, so a long real review is legible rather than silent."""
    task = asyncio.create_task(runner.wait(job_id))
    deadline = asyncio.get_running_loop().time() + timeout
    while not task.done():
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            task.cancel()
            raise SmokeError("live verification exceeded the smoke time budget")
        await asyncio.wait({task}, timeout=min(20.0, remaining))
        if not task.done():
            emit("  progress: " + ", ".join(
                f"{job['kind']}:{job.get('role') or '-'}={job['state']}"
                for job in store.list_jobs(run_id)
            ))
    await task


def start_run(service: ArchonService, timeout: int) -> str:
    started = service.start(
        "Provide an integer subtotal and an invoice wrapper that delegates to it.",
        acceptance=[
            {"acceptance_id": "sum", "description":
             "For finite lists of integers, subtotal returns their sum, including empty and negative input."},
            {"acceptance_id": "wrapper", "description":
             "invoice_total delegates to subtotal and returns the same result."},
        ],
        tasks=[
            {"task_id": "calculator", "title": "Implement the integer subtotal",
             "acceptance": ["sum"], "allowed_paths": ["calculator.py"]},
            {"task_id": "invoice", "title": "Add the invoice wrapper", "acceptance": ["wrapper"],
             "depends_on": ["calculator"], "allowed_paths": ["invoice.py"]},
        ],
        checks=[{"name": "fixture", "argv": [sys.executable, "-B", "verify.py"],
                 "acceptance_ids": ["sum", "wrapper"], "timeout_seconds": 60}],
        policy={"review_timeout_seconds": min(timeout, 900), "max_parallel_reviews": 3},
    )
    return str(started["run"]["run_id"])


def claim(service: ArchonService, run_id: str, task_id: str, summary: str) -> None:
    service.task_update(run_id, task_id, "implementing")
    service.task_update(run_id, task_id, "verifying", summary=summary)


async def egress_probe(adapter: ClaudeAdapter, runner: VerificationRunner, run_id: str,
                       policy: Policy) -> dict[str, Any]:
    """Run a planted egress attempt under the very profile checks run in."""
    candidate = runner.current_candidate(run_id)
    spec = CheckSpec(name="planted-egress", argv=[sys.executable, "-I", "-c", EGRESS_PROBE],
                     acceptance_ids=[], timeout_seconds=60)
    result = await adapter.run_command(spec, candidate, policy, invocation_id="planted-egress")
    observed = {"exit_code": result.exit_code, "stdout": result.stdout[-2000:],
                "stderr": result.stderr[-2000:],
                "sandbox_profile_digest": getattr(result, "sandbox_profile_digest", None),
                "recorded_shapes": "docs/evidence/2026-09-22-confinement.json"}
    if result.exit_code == 0 or "RESOLVED" in result.stdout or "CONNECTED" in result.stdout:
        raise SmokeError(f"the check profile permitted egress: {observed}")
    return observed


def review_evidence(store: Store, run_id: str) -> list[dict[str, Any]]:
    return [item for item in store.list_evidence(run_id) if item["kind"] == "review"]


def assert_three_witnesses(reviews: list[dict[str, Any]]) -> dict[str, Any]:
    sessions = {str(item["payload"].get("session_id")) for item in reviews}
    roles = {str(item["payload"].get("role") or item.get("role")) for item in reviews}
    if len(reviews) != 3 or len(sessions) != 3:
        raise SmokeError(f"expected three reviews in three distinct sessions, saw {len(reviews)}"
                         f" in {len(sessions)}")
    if roles != set(ROLES):
        raise SmokeError(f"the three Witness roles were not all present: {sorted(roles)}")
    missing = [item["payload"].get("role") for item in reviews
               if not (item["payload"].get("payload") or {}).get("decision")]
    if missing:
        raise SmokeError(f"a review was accepted without structured output: {missing}")
    return {"session_ids": sorted(sessions),
            "roles": sorted(roles),
            "cost_usd": [item["payload"].get("cost_usd") for item in reviews]}


async def failing_round(service: ArchonService, runner: VerificationRunner, store: Store,
                        run_id: str, timeout: int) -> str:
    """The real check must fail on the broken fixture, and say so in a receipt."""
    first = await service.verify(run_id)
    await wait_for(runner, store, run_id, first["job_id"], timeout)
    failed = service.verification_status(first["job_id"])
    if failed["run"]["state"] != "repair":
        raise SmokeError(f"a failing real check did not enter repair: {failed['run']['state']}")
    if not any(item["kind"] == "check" and item["payload"]["result"]["exit_code"] != 0
               for item in store.list_evidence(run_id)):
        raise SmokeError("no failed command receipt was recorded")
    return str(first["job_id"])


async def pipeline(repository: Path, state: Path, timeout: int, report: dict[str, Any]) -> None:
    workspace = Workspace(repository, state_root=state)
    store = Store(workspace.state_dir)
    adapter = ClaudeAdapter(receipt_root=workspace.state_dir / "supervisors")
    runner = VerificationRunner(workspace, store, adapter)
    service = ArchonService(workspace, store, runner)
    try:
        run_id = start_run(service, timeout)
        report.update(run_id=run_id, branch=service.status(run_id)["run"]["spec"]["branch"])
        claim(service, run_id, "calculator", "Initial subtotal implementation prepared.")
        service.task_update(run_id, "invoice", "implementing")
        (repository / "invoice.py").write_text(INVOICE, encoding="utf-8")
        service.task_update(run_id, "invoice", "verifying", summary="Invoice delegates to subtotal.")

        emit("1/4 dispatching the intentionally failing real check")
        report["failed_check_job"] = await failing_round(service, runner, store, run_id, timeout)

        emit("2/4 probing the check profile with a planted egress attempt")
        policy = Policy.model_validate(store.get_run(run_id)["spec"]["policy"])
        report["egress_denied"] = await egress_probe(adapter, runner, run_id, policy)

        emit("3/4 repairing the source and dispatching three real Witnesses")
        (repository / "calculator.py").write_text(FIXED_CALCULATOR, encoding="utf-8")
        claim(service, run_id, "calculator", "Removed the incorrect offset the real check caught.")
        claim(service, run_id, "invoice", "Rechecked the wrapper after repairing its dependency.")
        second = await service.verify(run_id)
        await wait_for(runner, store, run_id, second["job_id"], timeout)
        final = service.verification_status(second["job_id"])
        if final["run"]["state"] != "verified":
            raise SmokeError("the repaired candidate did not reach verified; inspect the recorded"
                             f" diagnostics: {final['next_action']}")
        report["verified_job"] = second["job_id"]
        report["gate"] = final["run"]["gate"]
        report["witnesses"] = assert_three_witnesses(review_evidence(store, run_id))

        emit("4/4 mutating a verified file; the gate must fall back to repair")
        (repository / "calculator.py").write_text(
            FIXED_CALCULATOR + "\n# A later unverified edit.\n", encoding="utf-8")
        stale = service.status(run_id)
        report["state_after_edit"] = stale["run"]["state"]
        if stale["run"]["state"] != "repair":
            raise SmokeError("a post-verification edit did not invalidate the verified state")
        report["evidence"] = store.list_evidence(run_id)
    finally:
        await runner.close()
        await adapter.close()
        store.close()


def write_report(output: Path, report: dict[str, Any]) -> Path:
    report["finished_at"] = datetime.now(UTC).isoformat()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    output.chmod(0o600)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--allow-live", action="store_true",
                        help="Required: authorizes real reviewer sessions that spend model quota")
    parser.add_argument("--output", type=Path, help="Where to write the evidence report")
    parser.add_argument("--timeout", type=int, default=900, help="Bound each verification round")
    args = parser.parse_args(argv)
    if not 60 <= args.timeout <= 3600:
        parser.error("--timeout must be between 60 and 3600 seconds")
    report: dict[str, Any] = {
        "kind": "authenticated-verification-pipeline",
        "started_at": datetime.now(UTC).isoformat(),
        "implementation_mode": "scripted fixture; native delegation is native_smoke.py's evidence",
        "python": sys.version.split()[0],
        "source_sha256": source_hashes(),
    }
    root = Path(tempfile.mkdtemp(prefix="archon-live-"))
    root.chmod(0o700)
    output = args.output.resolve() if args.output else root / "report.json"
    report["fixture_root"] = str(root)
    try:
        if not args.allow_live:
            raise Unresolved("--allow-live was not passed, so no authenticated session was started")
        report["auth"] = preflight()
        report["engine_version"] = subprocess.run(
            ["claude", "--version"], capture_output=True, text=True, timeout=30, check=False,
        ).stdout.strip()
        emit(f"Fresh live fixture: {root}")
        asyncio.run(pipeline(build_fixture(root), root / "private-state", args.timeout, report))
        report["verdict"] = "PASS"
        status = 0
    except Unresolved as exc:
        report.update(verdict="UNRESOLVED", reason=str(exc))
        status = 3
    except Exception as exc:  # noqa: BLE001 - a failure is reported with its evidence, never raised
        report.update(verdict="FAIL", reason=f"{type(exc).__name__}: {exc}")
        status = 1
    destination = write_report(output, report)
    print(json.dumps({"verdict": report["verdict"], "report": str(destination),
                      "reason": report.get("reason")}, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
