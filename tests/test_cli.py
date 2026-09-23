"""Exercise the installed administrative interface through its real entry point."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from archon.cli import _criteria, _dispatch, _human, _parser, _read_json
from archon.sandbox import probe_bwrap

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "claude"

# doctor reports local prerequisites; its exit code legitimately depends on them.
#
# This guard used to ask `shutil.which("bwrap")` — whether the binary exists.
# GitHub runners ship it and refuse to run it ("bwrap: loopback: Failed
# RTM_NEWADDR: Operation not permitted"), so the guard did not fire, the tests
# ran against an unusable runtime, and the first CI run of this repository
# failed on them. Presence is not capability, which is the same mistake as
# reading an absent file as a denial. Ask the real probe instead.
_PROBE = probe_bwrap()
PREREQUISITES = pytest.mark.skipif(
    not (_PROBE.available and shutil.which("socat")),
    reason=f"doctor reports prerequisites it cannot use: {_PROBE.message}",
)


def cli(repo: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    environment.update(env or {})
    return subprocess.run(
        [sys.executable, "-m", "archon", "--repo", str(repo),
         "--state-home", str(repo.parent / "state"), "--json", *args],
        env=environment, capture_output=True, text=True, timeout=60, check=False,
    )


def fake_engine(tmp_path: Path, version: str) -> dict[str, str]:
    """Put the recorded fake ``claude`` on PATH: a version string, never a model call."""
    directory = tmp_path / f"engine-{version}"
    directory.mkdir(exist_ok=True)
    shim = directory / "claude"
    shim.write_text(
        "#!/bin/sh\nexec " + shlex.quote(sys.executable) + " "
        + shlex.quote(str(FIXTURES / "fake_claude.py")) + ' "$@"\n',
        encoding="utf-8",
    )
    shim.chmod(0o755)
    return {"PATH": f"{directory}{os.pathsep}{os.environ['PATH']}", "FAKE_CLAUDE_VERSION": version}


@pytest.fixture
def cli_repo(
    tmp_path: Path, git_init: Callable[[Path], None], git_environment: dict[str, str]
) -> Path:
    """A consumer repository the developer's own Git configuration cannot reach.

    A bare ``git init`` here inherited ``~/.gitconfig``: an init template, a global
    ``core.hooksPath``, ``init.defaultBranch``.  The shared fixtures own that
    isolation so every repository a test creates is built the same way.
    """
    repo = tmp_path / "consumer"
    repo.mkdir()
    git_init(repo)
    subprocess.run(
        ["git", "-C", str(repo), "-c", f"core.hooksPath={os.devnull}",
         "commit", "--allow-empty", "-qm", "baseline"],
        env=git_environment, check=True, capture_output=True,
    )
    return repo


def test_acceptance_parser_rejects_missing_identifiers() -> None:
    assert _criteria(["AC-1:Working output"])[0]["description"] == "Working output"
    with pytest.raises(ValueError, match="ID:DESCRIPTION"):
        _criteria(["No stable identifier"])


def test_claims_cannot_set_verified_state() -> None:
    with pytest.raises(SystemExit):
        _parser().parse_args(["task", "update", "task-1", "--state", "verified"])


def test_json_input_is_bounded(tmp_path: Path) -> None:
    path = tmp_path / "oversized.json"
    path.write_bytes(b" " * (1_048_576 + 1))
    with pytest.raises(ValueError, match="1 MiB"):
        _read_json(path)


def test_help_and_bad_argument_exit_codes(cli_repo: Path) -> None:
    help_result = cli(cli_repo, "--help")
    assert help_result.returncode == 0
    assert "mcp" in help_result.stdout
    invalid = cli(cli_repo, "task", "update", "task-1", "--state", "verified")
    assert invalid.returncode == 2


def test_status_returns_json_without_creating_a_run(cli_repo: Path) -> None:
    result = cli(cli_repo, "status")
    assert result.returncode == 0, result.stderr
    assert isinstance(json.loads(result.stdout), dict)


def test_start_task_checkpoint_and_cancel(cli_repo: Path) -> None:
    start = cli(cli_repo, "start", "--goal", "Build the greeting", "--acceptance", "AC-1:Print hello")
    assert start.returncode == 0, start.stdout + start.stderr
    started = json.loads(start.stdout)
    run_id = started.get("run_id") or started.get("run", {}).get("run_id")
    assert run_id
    added = cli(cli_repo, "task", "add", "--run", run_id, "--id", "greeting", "--title", "Greeting",
                "--role", "implementation", "--acceptance", "AC-1", "--path", "hello.py")
    assert added.returncode == 0, added.stdout + added.stderr
    checkpoint = cli(cli_repo, "checkpoint", "save", "--run", run_id, "--summary", "Ready to implement")
    assert checkpoint.returncode == 0, checkpoint.stdout + checkpoint.stderr
    shown = cli(cli_repo, "checkpoint", "show", "--run", run_id)
    assert json.loads(shown.stdout)["checkpoint"]["context"]["summary"] == "Ready to implement"
    checks = cli_repo.parent / "checks.json"
    checks.write_text(json.dumps([{"name": "greeting", "argv": ["python", "hello.py"],
                                   "acceptance_ids": ["AC-1"]}]))
    amended = cli(cli_repo, "plan", "--run", run_id, "--checks", str(checks))
    assert amended.returncode == 0, amended.stdout + amended.stderr
    assert json.loads(amended.stdout)["run"]["spec"]["checks"][0]["name"] == "greeting"
    cancelled = cli(cli_repo, "cancel", run_id)
    assert cancelled.returncode == 0, cancelled.stdout + cancelled.stderr


def test_invalid_repo_reports_actionable_json(tmp_path: Path) -> None:
    result = cli(tmp_path, "start", "--goal", "Do work", "--acceptance", "AC-1:Done")
    assert result.returncode != 0
    error = json.loads(result.stdout)["error"]
    assert error["message"]


@PREREQUISITES
def test_install_doctor_and_removal_through_cli(cli_repo: Path, tmp_path: Path) -> None:
    """Claude Code has no Codex ``command/exec``: checks are kernel-run argv under bwrap.

    So the runtime block reports observed local confinement and supervision
    capability, and says in words that it never made an authenticated call.
    """
    instructions = cli_repo / "CLAUDE.md"
    instructions.write_text("Project instructions remain here.\n")
    installed = cli(cli_repo, "init")
    assert installed.returncode == 0, installed.stdout + installed.stderr
    assert json.loads(installed.stdout)["installed"] is True
    engine = fake_engine(tmp_path, "2.1.278")
    checked = cli(cli_repo, "doctor", env=engine)
    assert checked.returncode == 0, checked.stdout + checked.stderr
    report = json.loads(checked.stdout)
    runtime = report["runtime"]
    assert runtime["engine_version"] == "2.1.278"
    assert runtime["engine_version_tested"] is True
    assert runtime["bwrap"]["available"] is True, runtime["bwrap"]
    assert runtime["pidfd"] is True
    assert runtime["crash_recovery"] == "linux-subreaper-receipt"
    assert runtime["structured_reviews"] is True
    # doctor spends nothing, so it must never imply an authenticated engine.
    assert runtime["live_authenticated"] is None
    assert "no live authenticated invocation and no spend" in runtime["measurement"]
    assert report["hook_trust"] == "not_observable"
    removed = cli(cli_repo, "uninstall")
    assert removed.returncode == 0, removed.stdout + removed.stderr
    assert instructions.read_text().strip().endswith("Project instructions remain here.")
    assert "BEGIN ARCHON NATIVE" not in instructions.read_text()


@PREREQUISITES
def test_doctor_warns_and_exits_zero_on_an_untested_engine(cli_repo: Path, tmp_path: Path) -> None:
    """AC-22: version drift names the spike runner and never blocks the repository."""
    assert cli(cli_repo, "init").returncode == 0
    drifted = cli(cli_repo, "doctor", env=fake_engine(tmp_path, "99.1.0"))
    assert drifted.returncode == 0, drifted.stdout + drifted.stderr
    report = json.loads(drifted.stdout)
    assert report["ok"] is True and report["problems"] == []
    assert any("99.1.0" in warning and "run_all.py" in warning for warning in report["warnings"]), report
    assert report["runtime"]["engine_version_tested"] is False
    assert "spike" in report["runtime"]["warning"].lower()


def test_doctor_never_reports_failure_without_naming_a_problem(cli_repo: Path) -> None:
    """A verdict with no reason and no remedy is not a diagnostic.

    Deliberately carries no prerequisite guard: it must hold on a host with a
    working sandbox *and* on one without, which is the whole point. The first CI
    run of this repository returned ``ok: false`` with ``problems: []`` because
    GitHub runners refuse bubblewrap and `_doctor` flipped the verdict without
    recording why. The two AC-22 tests skip where the runtime is unusable, so
    this is what still covers that host on CI.
    """
    assert cli(cli_repo, "init").returncode == 0
    completed = cli(cli_repo, "doctor")
    report = json.loads(completed.stdout)

    assert (completed.returncode == 0) is (report["ok"] is True), report
    if report["ok"] is False:
        assert report["problems"], "doctor reported failure and named nothing to fix"
        assert all(isinstance(problem, str) and problem.strip() for problem in report["problems"])
    # Version drift is a warning and never a problem, on every host (AC-22).
    assert not any("outside the tested range" in problem for problem in report["problems"]), report


def test_spikes_subcommand_passes_the_book_its_arguments_and_never_authorizes_spend(
    cli_repo: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``archon spikes`` is the documented remedy doctor names; live spend stays opt-in."""
    from archon import cli as module

    observed: dict[str, Any] = {}

    def record(argv, **kwargs):
        observed.update(argv=argv, kwargs=kwargs)
        return subprocess.CompletedProcess(argv, 0, stdout="report", stderr="")

    monkeypatch.setattr(module.subprocess, "run", record)
    args = module._parser().parse_args(["spikes", "--id", "S5", "S7", "--budget-usd", "0.5"])
    report, code = module._spikes(args)
    assert code == 0 and report["allow_live"] is False
    assert observed["argv"][1].endswith("scripts/spikes/run_all.py")
    assert observed["argv"][2:] == ["--id", "S5", "S7", "--budget-usd", "0.5"]
    assert "--allow-live" not in observed["argv"]
    authorized = module._parser().parse_args(["spikes", "--allow-live"])
    report, _ = module._spikes(authorized)
    assert report["allow_live"] is True and "--allow-live" in observed["argv"]


def test_wait_reports_a_paused_usage_window_as_unfinished_not_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A closed provider window is a pause: the CLI reports wait and never a failure."""
    resume_at = 1_800_000_000

    async def wait(job_id, timeout_seconds=30):
        assert timeout_seconds == 0
        return {"job_id": job_id, "run_id": "run_demo", "state": "paused",
                "next_action": {"action": "wait", "run_id": "run_demo", "task_id": None,
                                "reason": "A verification job is paused for a provider usage window.",
                                "inputs": {"job_id": job_id, "resume_at": resume_at}}}

    async def close():
        return None

    runtime = SimpleNamespace(service=SimpleNamespace(wait=wait), runner=None, close=close)
    monkeypatch.setattr("archon.mcp_server.open_runtime", lambda *args: runtime)
    args = _parser().parse_args(["wait", "job_demo", "--timeout", "0"])
    result, code = asyncio.run(_dispatch(args))
    assert result["state"] == "paused"
    assert result["next_action"]["action"] == "wait"
    assert code == 3, "A parked job is unfinished work, not a failed gate"
    rendered = _human(result)
    assert "job job_demo" in rendered and str(resume_at) in rendered
    assert "2027-01-15" in rendered, rendered


def test_mcp_startup_error_never_uses_transport_stdout(tmp_path: Path) -> None:
    failed = cli(tmp_path, "mcp")
    assert failed.returncode != 0
    assert failed.stdout == ""
    assert failed.stderr


def test_verify_exit_code_requires_fresh_final_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """A finished successful job cannot hide a candidate mutation during final reporting."""
    closed = []

    async def start(run_id):
        return {"job_id": "job_demo", "state": "queued"}

    async def wait(job_id):
        return {"job_id": job_id, "state": "succeeded"}

    async def close():
        closed.append(True)

    final_status = {"job": {"job_id": "job_demo", "state": "succeeded"},
                    "run": {"state": "repair"}, "next_action": {"action": "verify"}}
    runtime = SimpleNamespace(
        service=SimpleNamespace(verify=start, verification_status=lambda job_id: final_status),
        runner=SimpleNamespace(wait=wait), close=close,
    )
    monkeypatch.setattr("archon.mcp_server.open_runtime", lambda *args: runtime)
    result, code = asyncio.run(_dispatch(_parser().parse_args(["verify"])))
    assert result == final_status
    assert code == 1
    assert closed == [True]


def test_recover_owns_execution_until_a_fresh_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """CLI recovery cannot abandon its retry when the administrative process exits."""
    observed = []

    async def recover(*args):
        observed.append(("recover", args))
        return {"job_id": "job_demo", "state": "queued"}

    async def wait(job_id):
        observed.append(("wait", job_id))
        return {"job_id": job_id, "state": "succeeded"}

    async def close():
        observed.append(("close",))

    final = {"job": {"job_id": "job_demo", "state": "succeeded"},
             "run": {"state": "verified"}}
    runtime = SimpleNamespace(
        service=SimpleNamespace(recover=recover, verification_status=lambda job_id: final),
        runner=SimpleNamespace(wait=wait), close=close,
    )
    monkeypatch.setattr("archon.mcp_server.open_runtime", lambda *args: runtime)
    args = _parser().parse_args([
        "recover", "job_demo", "--attempt", "1", "--candidate-digest", "a" * 64,
        "--checks-digest", "b" * 64, "--observations", "No interrupted effects remain.",
    ])
    result, code = asyncio.run(_dispatch(args))
    assert code == 0 and result == final
    assert observed == [
        ("recover", ("job_demo", 1, "a" * 64, "b" * 64, "No interrupted effects remain.")),
        ("wait", "job_demo"), ("close",),
    ]


def test_doctor_reports_a_missing_engine_and_never_raises(
    cli_repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """QA-H1: nothing ran doctor with the engine absent, so the path was unasserted.

    Three mutations of it each left the suite green.  This drives the real
    ``_doctor`` coroutine with an empty PATH, which is the only host state that
    reproduces an uninstalled Claude Code without touching the user's own.
    """
    from archon.cli import _doctor

    empty = tmp_path / "no-tools"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))

    report = asyncio.run(_doctor(cli_repo))

    assert report["ok"] is False
    assert report["runtime"]["engine_version"] is None
    assert report["runtime"]["available"] is False
    assert "not found on PATH" in report["runtime"]["warning"]
    assert any("Claude Code CLI" in problem for problem in report["problems"]), report["problems"]


def test_doctor_sees_the_engine_when_it_is_on_path(
    cli_repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Positive control: the absence above is the engine, not the empty PATH."""
    from archon.cli import _doctor

    environment = fake_engine(tmp_path, "2.1.278")
    monkeypatch.setenv("PATH", environment["PATH"])
    monkeypatch.setenv("FAKE_CLAUDE_VERSION", environment["FAKE_CLAUDE_VERSION"])
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))

    report = asyncio.run(_doctor(cli_repo))

    assert report["runtime"]["engine_version"] == "2.1.278"
    assert not any("Claude Code CLI" in problem for problem in report["problems"])
