"""Deterministic tests for the Claude Code execution adapter.

No test here invokes the real ``claude`` binary, opens a network connection, or
spends anything.  Reviewer tests replay recorded ``stream-json`` fixtures through
a fake engine (``tests/fixtures/claude/fake_claude.py``); check tests run real
commands under real bubblewrap and skip when the host cannot confine.  Both paths
go through the real subreaper supervisor, so process ownership, kernel PID
handles and nonce-bound termination receipts are exercised rather than stubbed.
"""

from __future__ import annotations

import asyncio
import functools
import json
import stat
import sys
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

import pytest

from archon.claude_adapter import (
    REVIEW_TOOLS,
    STRUCTURED_OUTPUT_TOOL,
    AdapterError,
    ClaudeAdapter,
    _isolated_config_dir,
    _purge_credentials,
    parse_reset_time,
    review_schema,
    review_settings,
    tested_engine_range,
)
from archon.models import Candidate, CheckSpec, Policy, RateLimited, ReviewDecision
from archon.sandbox import probe_bwrap

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "claude"
FAKE_CLAUDE = FIXTURES / "fake_claude.py"
LAUNCH_SHIM = FIXTURES / "launch_shim.py"
DIGEST = "a" * 64
CHECKS_DIGEST = "b" * 64
PACKET_TOKEN = "packet-token-6f1c2a"
ARGV_MUST_NOT_CONTAIN = (PACKET_TOKEN, "independent reviewer", "StructuredOutput tool")
ENGINE_VARIABLES = (
    "FAKE_CLAUDE_STREAM",
    "FAKE_CLAUDE_RECORD",
    "FAKE_CLAUDE_EXIT",
    "FAKE_CLAUDE_DELAY",
    "FAKE_CLAUDE_HOLD",
    "FAKE_CLAUDE_VERSION",
)

_BWRAP = probe_bwrap()
needs_bwrap = pytest.mark.skipif(
    not _BWRAP.available, reason=f"bubblewrap unavailable: {_BWRAP.reason}"
)

def runs_async[T](test: Callable[..., Coroutine[Any, Any, T]]) -> Callable[..., T]:
    """Run one coroutine test on its own loop; the suite has no async plugin."""

    @functools.wraps(test)
    def wrapper(*args: Any, **kwargs: Any) -> T:
        return asyncio.run(test(*args, **kwargs))

    return wrapper


@pytest.fixture(autouse=True)
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep every test away from the real ``~/.claude`` and real credentials."""
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / ".credentials.json").write_text('{"token": "not-a-real-token"}')
    monkeypatch.setenv("HOME", str(home))
    for name in ENGINE_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    return home


@pytest.fixture
def receipt_root(tmp_path: Path) -> Path:
    root = tmp_path / "state" / "supervisors"
    root.mkdir(parents=True)
    root.chmod(0o700)
    return root


@pytest.fixture
def snapshot(tmp_path: Path) -> Path:
    path = tmp_path / "snapshot"
    path.mkdir()
    (path / "module.py").write_text("value = 1\n", encoding="utf-8")
    return path


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    path = tmp_path / "project"
    path.mkdir()
    (path / "module.py").write_text("value = 1\n", encoding="utf-8")
    return path


@pytest.fixture
def adapter(receipt_root: Path) -> ClaudeAdapter:
    return ClaudeAdapter(
        receipt_root=receipt_root,
        claude_bin=str(FAKE_CLAUDE),
        launcher_command=(sys.executable, str(LAUNCH_SHIM)),
    )


def make_candidate(repo_root: Path, snapshot_path: Path | None = None) -> Candidate:
    return Candidate(
        repo_id="fixture",
        repo_root=str(repo_root),
        branch="archon/delivery",
        base_revision="0" * 40,
        head_revision="1" * 40,
        candidate_digest=DIGEST,
        checks_digest=CHECKS_DIGEST,
        snapshot_path=None if snapshot_path is None else str(snapshot_path),
    )


def use_stream(monkeypatch: pytest.MonkeyPatch, name: str, **environment: str) -> None:
    monkeypatch.setenv("FAKE_CLAUDE_STREAM", str(FIXTURES / name))
    for key, value in environment.items():
        monkeypatch.setenv(key, value)


def review_packet() -> dict[str, Any]:
    return {"acceptance": ["AC-1"], "evidence_ids": ["ev_1"], "diff": PACKET_TOKEN}


async def review(adapter: ClaudeAdapter, snapshot: Path, workspace: Path, **kwargs: Any) -> Any:
    return await adapter.run_review(
        "reviewer", make_candidate(workspace, snapshot), review_packet(), Policy(), **kwargs
    )


def control_dirs(receipt_root: Path) -> list[Path]:
    return sorted(path for path in receipt_root.glob("runtime-*") if path.is_dir())


def recorded(path: Path) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return payload


# --------------------------------------------------------------------- reviews


@runs_async
async def test_review_accepts_validated_structured_output(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_stream(monkeypatch, "success.jsonl")
    result = await review(adapter, snapshot, workspace)

    assert result.error is None
    assert result.payload is not None
    assert result.payload.decision == ReviewDecision.APPROVE
    assert result.session_id and result.result_uuid == "result-0001"
    assert result.cost_usd == pytest.approx(0.0421)
    assert result.succeeded
    assert adapter.termination_confirmed(result.invocation_id)


@runs_async
async def test_review_session_id_is_kernel_issued_and_echoed(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = workspace.parent / "record.json"
    use_stream(monkeypatch, "success.jsonl", FAKE_CLAUDE_RECORD=str(record))
    result = await review(adapter, snapshot, workspace)

    argv = recorded(record)["argv"]
    assert argv[argv.index("--session-id") + 1] == result.session_id


@pytest.mark.parametrize(
    ("fixture", "marker"),
    [
        ("init-session-mismatch.jsonl", "session identity"),
        ("init-foreign-tool.jsonl", "tool catalog"),
        ("init-no-schema-tool.jsonl", STRUCTURED_OUTPUT_TOOL),
        ("init-mcp-attached.jsonl", "MCP servers"),
        ("init-skills-attached.jsonl", "skills"),
        ("init-permission-mode.jsonl", "permission mode"),
        ("init-model-family.jsonl", "routed family"),
    ],
)
@runs_async
async def test_review_refuses_a_session_that_is_not_hermetic(
    adapter: ClaudeAdapter,
    snapshot: Path,
    workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
    fixture: str,
    marker: str,
) -> None:
    use_stream(monkeypatch, fixture)
    result = await review(adapter, snapshot, workspace)

    assert result.payload is None and not result.succeeded
    assert result.error is not None
    assert "not hermetic" in result.error and marker in result.error


@runs_async
async def test_review_aborts_on_a_tool_outside_the_catalog(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_stream(monkeypatch, "unexpected-tool-use.jsonl")
    result = await review(adapter, snapshot, workspace)

    assert result.payload is None
    assert result.error is not None and "outside its catalog" in result.error
    assert "'Write'" in result.error


@runs_async
async def test_rate_limit_rejected_event_pauses_with_its_own_reset(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_stream(monkeypatch, "rate-limit-rejected.jsonl", FAKE_CLAUDE_EXIT="1")
    with pytest.raises(RateLimited) as caught:
        await review(adapter, snapshot, workspace)

    assert caught.value.resume_at == 1790100000
    assert caught.value.window == "five_hour"


@runs_async
async def test_usage_limit_result_string_pauses_too(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The only exhaustion channel ever seen in the field is the result string."""
    use_stream(monkeypatch, "usage-limit-result.jsonl", FAKE_CLAUDE_EXIT="1")
    with pytest.raises(RateLimited) as caught:
        await review(adapter, snapshot, workspace)

    assert caught.value.resume_at > 0
    assert caught.value.window == "usage_limit_message"


@pytest.mark.parametrize(
    ("fixture", "marker"),
    [
        ("malformed-json.jsonl", "malformed JSON"),
        ("invalid-payload.jsonl", "failed local validation"),
        ("null-structured-output.jsonl", "no structured output"),
        ("max-turns-exhausted.jsonl", "exhausted its turn bound"),
        ("no-result.jsonl", "without validated structured evidence"),
    ],
)
@runs_async
async def test_review_rejects_unusable_evidence(
    adapter: ClaudeAdapter,
    snapshot: Path,
    workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
    fixture: str,
    marker: str,
) -> None:
    use_stream(monkeypatch, fixture)
    result = await review(adapter, snapshot, workspace)

    assert result.payload is None and not result.succeeded
    assert result.error is not None and marker in result.error


@runs_async
async def test_truncated_reviewer_output_fails_rather_than_passing(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_stream(monkeypatch, "oversized.jsonl")
    policy = Policy(max_output_bytes=1024)
    result = await adapter.run_review(
        "reviewer", make_candidate(workspace, snapshot), review_packet(), policy
    )

    assert result.payload is None and not result.succeeded
    assert result.error is not None and "exceeded its recorded size limit" in result.error


@runs_async
async def test_cancellation_during_startup_leaves_no_late_transport(
    adapter: ClaudeAdapter,
    snapshot: Path,
    workspace: Path,
    receipt_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_stream(monkeypatch, "success.jsonl", FAKE_CLAUDE_DELAY="30")
    invocation_id = "review_cancel_case"

    async def cancel_once(event: dict[str, Any]) -> None:
        if event.get("kind") == "provider_process":
            await adapter.cancel(invocation_id)

    result = await review(
        adapter, snapshot, workspace, on_event=cancel_once, invocation_id=invocation_id
    )

    assert result.payload is None and result.error is not None
    receipts = [path / "stopped.json" for path in control_dirs(receipt_root)]
    assert receipts and all(path.is_file() for path in receipts)
    assert recorded(receipts[0])["descendants_reaped"] is True


@runs_async
async def test_concurrent_reviews_get_separate_jobs_and_sessions(
    adapter: ClaudeAdapter,
    snapshot: Path,
    workspace: Path,
    receipt_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_stream(monkeypatch, "success.jsonl")
    first, second = await asyncio.gather(
        review(adapter, snapshot, workspace, invocation_id="review_one"),
        review(adapter, snapshot, workspace, invocation_id="review_two"),
    )

    assert first.succeeded and second.succeeded
    assert first.session_id != second.session_id
    directories = control_dirs(receipt_root)
    assert len(directories) == 2
    assert all((path / "job" / "settings.json").is_file() for path in directories)


@runs_async
async def test_role_prompt_and_packet_never_reach_the_command_line(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = workspace.parent / "record.json"
    use_stream(monkeypatch, "success.jsonl", FAKE_CLAUDE_RECORD=str(record))
    await review(adapter, snapshot, workspace)

    observed = recorded(record)
    rendered = " ".join(observed["argv"])
    assert not any(term in rendered for term in ARGV_MUST_NOT_CONTAIN)
    assert PACKET_TOKEN in observed["stdin"]

    prompt = Path(observed["argv"][observed["argv"].index("--append-system-prompt-file") + 1])
    assert prompt.is_file() and stat.S_IMODE(prompt.stat().st_mode) == 0o600
    assert stat.S_IMODE(prompt.parent.stat().st_mode) == 0o700
    assert "independent reviewer" in prompt.read_text(encoding="utf-8")


@runs_async
async def test_reviewer_argv_carries_the_full_hermeticity_flag_set(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = workspace.parent / "record.json"
    use_stream(monkeypatch, "success.jsonl", FAKE_CLAUDE_RECORD=str(record))
    await review(adapter, snapshot, workspace)
    argv = recorded(record)["argv"]

    def value_of(flag: str) -> str:
        return str(argv[argv.index(flag) + 1])

    assert argv[0] == "-p"
    assert value_of("--output-format") == "stream-json"
    assert value_of("--tools") == ",".join(REVIEW_TOOLS)
    assert value_of("--permission-mode") == "dontAsk"
    assert value_of("--permission-prompts") == "none"
    assert value_of("--setting-sources") == ""
    assert value_of("--model") == "opus" and value_of("--effort") == "high"
    assert value_of("--max-budget-usd") == "3"
    assert json.loads(value_of("--json-schema"))["additionalProperties"] is False
    for flag in (
        "--verbose",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--settings",
        "--session-id",
    ):
        assert flag in argv


@runs_async
async def test_review_requires_a_snapshot_distinct_from_the_repository(
    adapter: ClaudeAdapter, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_stream(monkeypatch, "success.jsonl")
    missing = await adapter.run_review(
        "reviewer", make_candidate(workspace), review_packet(), Policy()
    )
    same = await adapter.run_review(
        "reviewer", make_candidate(workspace, workspace), review_packet(), Policy()
    )

    assert missing.error is not None and "frozen candidate snapshot" in missing.error
    assert same.error is not None and "separate from the repository" in same.error


@runs_async
async def test_review_records_permission_denials_as_a_bounded_artifact(
    adapter: ClaudeAdapter,
    snapshot: Path,
    workspace: Path,
    receipt_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_stream(monkeypatch, "success.jsonl")
    await review(adapter, snapshot, workspace)

    denials = recorded(control_dirs(receipt_root)[0] / "permission-denials.json")
    assert denials and denials[0]["tool_name"] == "Write"  # type: ignore[index]


@runs_async
async def test_copied_credentials_do_not_outlive_the_session(
    adapter: ClaudeAdapter,
    snapshot: Path,
    workspace: Path,
    receipt_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_stream(monkeypatch, "success.jsonl")
    await review(adapter, snapshot, workspace)

    assert not any((path / "config").exists() for path in control_dirs(receipt_root))


def test_isolated_config_dir_copies_only_the_credential(tmp_path: Path) -> None:
    control = tmp_path / "runtime-x"
    control.mkdir()
    config = _isolated_config_dir(control)

    assert config is not None
    assert [path.name for path in config.iterdir()] == [".credentials.json"]
    assert stat.S_IMODE((config / ".credentials.json").stat().st_mode) == 0o600
    _purge_credentials(control)
    assert not config.exists()


def test_isolated_config_dir_falls_back_when_no_credential_file_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = tmp_path / "empty-home"
    empty.mkdir()
    monkeypatch.setenv("HOME", str(empty))
    control = tmp_path / "runtime-y"
    control.mkdir()

    assert _isolated_config_dir(control) is None


# ---------------------------------------------------------------------- checks


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_check_passes_and_binds_its_confinement_digest(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    spec = CheckSpec(name="echo", argv=["/bin/sh", "-c", "echo confined"], timeout_seconds=30)
    result = await adapter.run_command(spec, make_candidate(workspace), Policy())

    assert result.exit_code == 0 and result.error is None
    assert result.succeeded and not result.truncated
    assert "confined" in result.stdout
    assert result.sandbox_profile_digest is not None
    assert len(result.sandbox_profile_digest) == 64
    assert result.argv == list(spec.argv)
    assert adapter.termination_confirmed(result.invocation_id)


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_failing_check_reports_its_own_exit_code(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    spec = CheckSpec(
        name="fail", argv=["/bin/sh", "-c", "echo boom >&2; exit 3"], timeout_seconds=30
    )
    result = await adapter.run_command(spec, make_candidate(workspace), Policy())

    assert result.exit_code == 3 and result.error is None and not result.succeeded
    assert "boom" in result.stderr


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_a_blocked_read_is_a_check_failure_not_a_confinement_failure(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    """A read the profile prevents is a real check outcome, and stays one."""
    spec = CheckSpec(
        name="secrets", argv=["/bin/sh", "-c", "cat ~/.ssh/id_rsa"], timeout_seconds=30
    )
    result = await adapter.run_command(spec, make_candidate(workspace), Policy())

    assert result.exit_code not in (0, None)
    assert result.error is None and not result.succeeded


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_confinement_failure_is_never_reported_as_a_check_result(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    spec = CheckSpec(name="missing", argv=["/nonexistent/archon-check"], timeout_seconds=30)
    result = await adapter.run_command(spec, make_candidate(workspace), Policy())

    assert not result.succeeded
    assert result.error is not None and "confinement failed" in result.error.lower()
    assert "not a check outcome" in result.error


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_check_timeout_terminates_the_owned_process_and_does_not_pass(
    adapter: ClaudeAdapter, workspace: Path, receipt_root: Path
) -> None:
    spec = CheckSpec(name="sleep", argv=["/bin/sleep", "60"], timeout_seconds=1)
    result = await adapter.run_command(spec, make_candidate(workspace), Policy())

    assert result.timed_out and not result.succeeded
    assert result.error is not None and "time limit" in result.error
    assert recorded(control_dirs(receipt_root)[0] / "stopped.json")["descendants_reaped"] is True


@runs_async
async def test_check_refuses_a_working_directory_outside_the_repository(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    spec = CheckSpec(name="absent", argv=["/bin/true"], cwd="not/there")
    result = await adapter.run_command(spec, make_candidate(workspace), Policy())

    assert result.error is not None and "inside the active repository" in result.error
    assert result.exit_code is None and not result.succeeded


@runs_async
async def test_adapter_refuses_to_verify_the_repository_it_runs_from(
    adapter: ClaudeAdapter,
) -> None:
    """Self-hosting guard: Archon may not verify a tree holding its own runtime."""
    own_repo = Path(__file__).resolve().parents[1]
    result = await adapter.run_command(
        CheckSpec(name="self", argv=["/bin/true"]), make_candidate(own_repo), Policy()
    )

    assert result.error is not None and "inside the repository under verification" in result.error
    assert result.exit_code is None


@runs_async
async def test_closing_the_adapter_refuses_further_work(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    await adapter.close()
    result = await adapter.run_command(
        CheckSpec(name="late", argv=["/bin/true"]), make_candidate(workspace), Policy()
    )

    assert result.error is not None and "closed" in result.error


# ---------------------------------------------------------------- capabilities


@runs_async
async def test_capabilities_measures_locally_and_never_invokes_a_model(
    adapter: ClaudeAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_CLAUDE_VERSION", "2.1.278 (Claude Code)")
    capabilities = await adapter.capabilities()

    assert capabilities["engine_version"] == "2.1.278"
    assert capabilities["structured_reviews"] is True
    assert capabilities["platform"] == sys.platform
    assert capabilities["live_authenticated"] is None
    assert "no live authenticated invocation" in capabilities["measurement"]
    assert capabilities["crash_recovery"] == "linux-subreaper-receipt"
    assert isinstance(capabilities["tested_range"], list)


@runs_async
async def test_an_untested_engine_version_warns_and_never_blocks(
    adapter: ClaudeAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_CLAUDE_VERSION", "9.9.9 (Claude Code)")
    monkeypatch.setattr("archon.claude_adapter.tested_engine_range", lambda: ["2.1.278", "2.1.278"])
    capabilities = await adapter.capabilities()

    assert capabilities["engine_version_tested"] is False
    assert capabilities["warning"] is not None
    assert "outside the tested range" in capabilities["warning"]
    assert capabilities["available"] is True


def test_tested_range_is_derived_from_recorded_evidence() -> None:
    assert all(isinstance(version, str) for version in tested_engine_range())


# ------------------------------------------------------------------- rendering


def test_review_schema_drops_provider_hostile_keywords() -> None:
    schema = review_schema()
    rendered = json.dumps(schema)

    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    for keyword in ("maxLength", "pattern", "minItems", "title", "default"):
        assert f'"{keyword}"' not in rendered


def test_review_settings_deny_by_bare_name_and_confine_writes(tmp_path: Path) -> None:
    settings = review_settings(tmp_path / "snap", tmp_path / "scratch", tmp_path / "state")

    assert settings["permissions"]["defaultMode"] == "dontAsk"
    assert {"Write", "Edit", "Agent", "Task"} <= set(settings["permissions"]["deny"])
    assert settings["sandbox"]["failIfUnavailable"] is True
    assert settings["sandbox"]["network"]["allowedDomains"] == []
    assert settings["sandbox"]["filesystem"]["denyWrite"] == [str(tmp_path / "snap")]
    assert str(tmp_path / "state") in settings["sandbox"]["filesystem"]["denyRead"]
    assert settings["env"]["ARCHON_MANAGED_REVIEW"] == "1"


def test_launcher_argv_matches_the_archon_launch_contract(
    receipt_root: Path, tmp_path: Path
) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    adapter = ClaudeAdapter(receipt_root=receipt_root)
    job = adapter._new_invocation("check_1", "check", elsewhere)
    argv = adapter._launcher_argv(job, ["bwrap", "--unshare-net", "--", "/bin/true"])

    assert argv[0] == sys.executable and argv[1] == "-I"
    assert Path(argv[2]).name == "launcher.py"
    assert argv[3:7] == [str(job.control_dir), job.nonce, "check", "--"]
    assert argv[7:] == ["bwrap", "--unshare-net", "--", "/bin/true"]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("usage window five_hour resetsAt 1790100000", 1790100000),
        ("resets at 1790100000000", 1790100000),
    ],
)
def test_parse_reset_time_prefers_an_explicit_epoch(text: str, expected: int) -> None:
    assert parse_reset_time(text) == expected


def test_parse_reset_time_reads_a_local_clock_message() -> None:
    message = "You've hit your session limit · resets 2:10pm (Europe/Madrid)"
    now = 1790000000.0

    assert now < parse_reset_time(message, now=now) <= now + 86_400


def test_parse_reset_time_still_pauses_when_it_cannot_parse() -> None:
    now = 1790000000.0

    assert parse_reset_time("you are out of quota", now=now) == int(now) + 3600


def test_adapter_error_is_never_a_pause() -> None:
    assert issubclass(AdapterError, RuntimeError)
    assert not issubclass(AdapterError, RateLimited)
