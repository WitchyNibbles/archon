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
import os
import shutil
import signal
import stat
import sys
import time
from collections.abc import Callable, Coroutine, Iterator
from pathlib import Path
from tempfile import mkdtemp
from typing import Any

import pytest

from archon.claude_adapter import (
    REVIEW_ALLOW,
    REVIEW_DENY,
    REVIEW_TOOLS,
    STRUCTURED_OUTPUT_TOOL,
    AdapterError,
    ClaudeAdapter,
    _confinement_failure,
    review_schema,
    review_settings,
    reviewer_deny_read,
    tested_engine_range,
)
from archon.credentials import isolated_config_dir, purge_credentials
from archon.models import Candidate, CheckSpec, Policy, RateLimited, ReviewDecision
from archon.review_profile import CREDENTIAL_DENY_READ
from archon.sandbox import DEFAULT_MASKED, probe_bwrap
from archon.stream import _resume_at, parse_reset_time

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


#: ``--tmpfs /tmp`` hides every pytest path, so a mask test staged there cannot
#: tell a denial from an absence.  ``/var/tmp`` is an ordinary directory the
#: profile does not touch.
UNMASKED_TEMP = Path("/var/tmp")
usable_unmasked_temp = pytest.mark.skipif(
    not UNMASKED_TEMP.is_dir()
    or any(path.is_symlink() for path in (UNMASKED_TEMP, *UNMASKED_TEMP.parents)),
    reason="no unmasked temporary directory on this host",
)


@pytest.fixture
def unmasked_state() -> Iterator[Path]:
    root = Path(mkdtemp(prefix="archon-state-", dir=UNMASKED_TEMP))
    root.chmod(0o700)
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def adapter_outside_tmp(unmasked_state: Path) -> ClaudeAdapter:
    supervisors = unmasked_state / "supervisors"
    supervisors.mkdir(mode=0o700)
    return ClaudeAdapter(
        receipt_root=supervisors,
        claude_bin=str(FAKE_CLAUDE),
        launcher_command=(sys.executable, str(LAUNCH_SHIM)),
    )


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


def receipts(receipt_root: Path) -> list[Path]:
    """The receipt lives in its own directory inside the control directory (SEC-M1)."""
    return [path / "receipt" / "stopped.json" for path in control_dirs(receipt_root)]


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
    written = receipts(receipt_root)
    assert written and all(path.is_file() for path in written)
    assert recorded(written[0])["descendants_reaped"] is True


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
    config = isolated_config_dir(control)

    assert config is not None
    assert [path.name for path in config.iterdir()] == [".credentials.json"]
    assert stat.S_IMODE((config / ".credentials.json").stat().st_mode) == 0o600
    purge_credentials(control)
    assert not config.exists()


def test_isolated_config_dir_falls_back_when_no_credential_file_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = tmp_path / "empty-home"
    empty.mkdir()
    monkeypatch.setenv("HOME", str(empty))
    control = tmp_path / "runtime-y"
    control.mkdir()

    assert isolated_config_dir(control) is None


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
    assert recorded(receipts(receipt_root)[0])["descendants_reaped"] is True


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


def rendered_settings(tmp_path: Path) -> dict[str, Any]:
    return review_settings(
        tmp_path / "snap", tmp_path / "scratch", tmp_path / "state" / "supervisors",
        tmp_path / "state",
    )


def test_review_settings_pins_every_field_the_plan_specifies(tmp_path: Path) -> None:
    """QA-M1: flipping ``allowUnsandboxedCommands`` to True left the suite green.

    ``enabled``, ``autoAllowBashIfSandboxed``, ``strictAllowlist``,
    ``allowLocalBinding``, the whole allow list and ``attribution`` were unasserted
    too, though the build contract specifies all of them.  The object is compared
    whole so no field can be changed silently.
    """
    settings = rendered_settings(tmp_path)

    assert settings == {
        "permissions": {
            "defaultMode": "dontAsk",
            "allow": list(REVIEW_ALLOW),
            "deny": list(REVIEW_DENY),
        },
        "sandbox": {
            "enabled": True,
            "failIfUnavailable": True,
            "autoAllowBashIfSandboxed": True,
            "allowUnsandboxedCommands": False,
            "filesystem": {
                "allowWrite": [str(tmp_path / "scratch")],
                "denyWrite": [str(tmp_path / "snap")],
                "denyRead": reviewer_deny_read(
                    tmp_path / "state" / "supervisors", tmp_path / "state"
                ),
            },
            "network": {
                "allowedDomains": [],
                "strictAllowlist": True,
                "allowLocalBinding": False,
            },
        },
        "attribution": {"commit": "", "pr": "", "sessionUrl": False},
        "env": {"ARCHON_MANAGED_REVIEW": "1"},
    }
    assert "Read" in settings["permissions"]["allow"]
    assert {"Write", "Edit", "Agent", "Task"} <= set(settings["permissions"]["deny"])


def test_the_reviewer_deny_list_cannot_drift_below_the_check_profile_mask(
    tmp_path: Path,
) -> None:
    """SEC-C1: the reviewer denied three home paths while the check profile masked six.

    ``~/.claude/.credentials.json`` (0600 on this host) was therefore readable by a
    reviewer holding ``Bash(cat *)`` and ``Bash(python3 -c *)``, and ``denyRead`` is
    the only read barrier a shell-issued read meets (live probe P5).  The drift is
    the defect, so the mask set is asserted as a floor rather than restated.
    """
    denied = set(rendered_settings(tmp_path)["sandbox"]["filesystem"]["denyRead"])

    assert {str(path) for path in DEFAULT_MASKED} <= denied
    assert {str(path) for path in CREDENTIAL_DENY_READ} <= denied
    # The OAuth account record is a *sibling* of ~/.claude, so masking the
    # directory never covered it; both it and its backup are named explicitly.
    assert "~/.claude.json" in denied and "~/.claude.json.backup" in denied
    assert "~/.claude" in denied
    # Declared here as well as inherited: while this package was being repaired the
    # mask set was briefly rewritten without ~/.claude, and the reviewer's defence
    # against reading the credential it was launched with may not be hostage to it.
    assert {"~/.claude", "~/.claude.json", "~/.claude.json.backup"} <= {
        str(path) for path in CREDENTIAL_DENY_READ
    }


def test_the_reviewer_cannot_read_the_evidence_database_or_another_receipt(
    tmp_path: Path,
) -> None:
    """SEC-H2: only ``supervisors/`` was denied, and ``state.sqlite3`` is its sibling.

    A reviewer could read every recorded payload, finding and checkpoint, and a
    ``security_reviewer`` launched after the other two could read their verdicts —
    which is exactly the three-independent-approvals property the gate rests on.
    ``snapshots/`` stays readable: it is the candidate under review.
    """
    denied = rendered_settings(tmp_path)["sandbox"]["filesystem"]["denyRead"]
    state = tmp_path / "state"

    assert str(state / "supervisors") in denied
    assert str(state / "state.sqlite3") in denied
    assert str(state / "state.sqlite3-wal") in denied
    assert str(state / "state.sqlite3-shm") in denied
    assert not any(entry == str(state / "snapshots") for entry in denied)
    assert not any(entry == str(state) for entry in denied)


def test_the_denied_database_name_is_the_one_the_store_actually_opens(
    tmp_path: Path,
) -> None:
    """A restated filename is the defect SEC-C1 was; this pins it to the writer."""
    from archon.store import Store

    state = tmp_path / "live-state"
    state.mkdir()
    store = Store(state)
    try:
        assert str(store.path) in reviewer_deny_read(state / "supervisors", state)
    finally:
        store.close()


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
    assert argv[3:7] == [str(job.receipt_dir), job.nonce, "check", "--"]
    assert argv[7:] == ["bwrap", "--unshare-net", "--", "/bin/true"]
    # SEC-M1: the supervisor is handed a directory that holds nothing but the
    # receipt, so no writable path the child keeps shares a parent with it.
    assert job.receipt_dir.parent == job.control_dir
    assert list(job.receipt_dir.iterdir()) == []
    assert stat.S_IMODE(job.receipt_dir.stat().st_mode) == 0o700


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


# ------------------------------------------------- the confinement discriminator


@pytest.mark.parametrize(
    ("sandbox_exit", "stderr", "is_fault"),
    [
        (0, "", False),
        (3, "boom\n", False),
        # SEC-H4: the child owns the same stderr stream bwrap writes to, so the
        # prefix it can print must not decide anything.
        (1, "bwrap: Creating new namespace failed\n", False),
        (None, "bwrap: Can't find source path /absent: No such file or directory\n", True),
        (None, "bwrap: execvp /nonexistent/archon-check: No such file or directory\n", True),
        (None, "", True),
    ],
)
def test_a_confinement_fault_is_decided_by_the_sandbox_status_never_by_stderr(
    sandbox_exit: int | None, stderr: str, is_fault: bool
) -> None:
    """The three bwrap 0.9.0 cases, plus a child forging the prefix.

    Measured: a clean run emits ``{"child-pid": …}`` then ``{"exit-code": N}``; a
    bind-setup failure and an exec failure both stop after ``child-pid``.  So a
    missing ``exit-code`` is the fault, and the ``bwrap:`` line is diagnosis only.
    """
    failure = _confinement_failure(sandbox_exit, stderr)

    assert (failure is not None) is is_fault
    if is_fault and stderr:
        assert stderr.strip() in failure  # type: ignore[operator]


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_a_check_forging_the_bwrap_prefix_is_still_recorded_as_a_failed_check(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    """SEC-H4, end to end: the repository may not classify its own evidence."""
    spec = CheckSpec(
        name="forge",
        argv=["/bin/sh", "-c", "echo 'bwrap: Creating new namespace failed' >&2; exit 1"],
        timeout_seconds=30,
    )
    result = await adapter.run_command(spec, make_candidate(workspace), Policy())

    assert result.exit_code == 1 and not result.succeeded
    assert result.error is None, "a forged prefix was accepted as a runtime fault"
    assert "bwrap:" in result.stderr


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_a_bind_setup_failure_is_a_confinement_fault_not_a_check_result(
    adapter: ClaudeAdapter, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The second of the three cases: bwrap stops before the child ever runs.

    The bad bind stands in for a host-level bind that vanished between render and
    dispatch; the profile itself is still rendered by ``sandbox.render_bwrap``.
    """
    import archon.claude_adapter as module

    original = module.render_bwrap

    def unbindable(profile: Any, command: Any, cwd: Any, *args: Any, **kwargs: Any) -> list[str]:
        argv = original(profile, command, cwd, *args, **kwargs)
        return [argv[0], "--bind", "/nonexistent-archon-source", "/mnt-archon", *argv[1:]]

    monkeypatch.setattr(module, "render_bwrap", unbindable)
    result = await adapter.run_command(
        CheckSpec(name="bind", argv=["/bin/true"], timeout_seconds=30),
        make_candidate(workspace),
        Policy(),
    )

    assert not result.succeeded
    assert result.error is not None and "confinement failed" in result.error.lower()
    assert "not a check outcome" in result.error
    assert "Can't find source path" in result.error


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_the_status_pipe_does_not_reach_the_confined_child(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    """Positive control for the discriminator: bwrap writes, the child cannot.

    If the child held the descriptor it could write its own ``exit-code`` and
    forge the very decision this mechanism exists to take away from it.
    """
    probe = "import os,sys\nprint([fd for fd in range(64) if os.path.exists(f'/proc/self/fd/{fd}')])"
    spec = CheckSpec(name="fds", argv=[sys.executable, "-I", "-c", probe], timeout_seconds=60)
    result = await adapter.run_command(spec, make_candidate(workspace), Policy())

    assert result.exit_code == 0 and result.error is None, result.error
    # 0, 1, 2 and the interpreter's own transient descriptor for /proc/self/fd.
    assert "[0, 1, 2, 3]" in result.stdout or "[0, 1, 2]" in result.stdout


# --------------------------------------------------------- credential lifetime


def plant_credential(receipt_root: Path, name: str, owner: dict[str, Any] | None) -> Path:
    control = receipt_root / name
    (control / "config").mkdir(parents=True)
    (control / "config" / ".credentials.json").write_text('{"token": "stranded"}')
    if owner is not None:
        (control / "owner.json").write_text(json.dumps(owner))
    return control


def test_a_credential_stranded_by_an_abnormal_exit_is_swept_at_construction(
    receipt_root: Path,
) -> None:
    """SEC-M2: SIGKILL, OOM and a crash run no ``finally`` and nothing swept after.

    Control directories accumulated with a copy of the account credential inside.
    """
    from archon.launcher import read_boot_id, read_process

    own = read_process(os.getpid())
    assert own is not None
    dead = plant_credential(
        receipt_root, "runtime-dead", {"pid": own["pid"], "start_ticks": 1, "boot_id": read_boot_id()}
    )
    unmarked = plant_credential(receipt_root, "runtime-unmarked", None)
    # Positive control: a live owner's copy must survive, or a second Archon on
    # the same state root would de-authenticate a running reviewer.
    live = plant_credential(
        receipt_root,
        "runtime-live",
        {"pid": own["pid"], "start_ticks": own["start_ticks"], "boot_id": read_boot_id()},
    )

    adapter = ClaudeAdapter(receipt_root=receipt_root)

    assert not (dead / "config").exists()
    assert not (unmarked / "config").exists()
    assert (live / "config" / ".credentials.json").is_file()
    assert set(adapter.swept_credentials) == {dead, unmarked}


def test_a_terminating_signal_purges_copied_credentials_and_keeps_the_previous_handler(
    receipt_root: Path,
) -> None:
    """SEC-M2: the docstring's promise held for returns and exceptions, not signals."""
    from archon.credentials import purge_on_signal, register_control_dir

    control = plant_credential(receipt_root, "runtime-signalled", None)
    register_control_dir(control)
    chained: list[int] = []
    purge_on_signal(lambda number, frame: chained.append(number))(signal.SIGTERM, None)

    assert not (control / "config").exists()
    assert chained == [signal.SIGTERM], "the process's own SIGTERM behaviour was swallowed"


def test_the_reviewer_config_directory_refuses_a_planted_symlink(tmp_path: Path) -> None:
    """SEC-L2: ``mkdir(exist_ok=True)`` succeeds on a symlink that names a directory.

    Only the leaf was ``O_NOFOLLOW``-guarded, so the 0600 credential copy landed
    wherever the link pointed.
    """
    control = tmp_path / "runtime-linked"
    control.mkdir()
    elsewhere = tmp_path / "attacker"
    elsewhere.mkdir(mode=0o700)
    (control / "config").symlink_to(elsewhere)

    assert isolated_config_dir(control) is None
    assert not (elsewhere / ".credentials.json").exists()


def test_the_reviewer_config_directory_refuses_a_pre_planted_credential(
    tmp_path: Path,
) -> None:
    """A copy is created, never written over something already holding that name."""
    control = tmp_path / "runtime-planted"
    (control / "config").mkdir(parents=True, mode=0o700)
    (control / "config" / ".credentials.json").write_text("planted")

    assert isolated_config_dir(control) is None
    assert (control / "config" / ".credentials.json").read_text() == "planted"


# ------------------------------------------------------- pauses and capability


def test_a_rejected_rate_limit_with_no_reset_time_pauses_into_the_future() -> None:
    """CORR-M1: the fallback was ``int(time.time())``, so the job requeued at once.

    A pause deliberately costs no attempt, so an immediate resume against a window
    that is still closed has nothing bounding it.  ``parse_reset_time`` already
    floors an unparseable signal; this is the same floor.
    """
    now = 1790000000.0

    assert _resume_at(1790100000, now=now) == 1790100000
    assert _resume_at(None, now=now) == int(now) + 3600
    assert _resume_at("soon", now=now) == int(now) + 3600
    assert _resume_at(True, now=now) == int(now) + 3600


@runs_async
async def test_a_rejected_rate_limit_event_without_a_reset_still_pauses_forward(
    adapter: ClaudeAdapter, snapshot: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_stream(monkeypatch, "rate-limit-no-reset.jsonl", FAKE_CLAUDE_EXIT="1")
    before = int(time.time())
    with pytest.raises(RateLimited) as caught:
        await review(adapter, snapshot, workspace)

    assert caught.value.resume_at >= before + 3600
    assert caught.value.window == "five_hour"


@runs_async
async def test_capabilities_report_a_missing_engine_without_pretending_it_is_there(
    receipt_root: Path,
) -> None:
    """QA-H1: three separate mutations of the missing-CLI path left the suite green.

    Nothing constructed an adapter with the engine absent, so "not found on PATH"
    was never asserted anywhere.
    """
    adapter = ClaudeAdapter(receipt_root=receipt_root, claude_bin="archon-absent-engine")
    capabilities = await adapter.capabilities()

    assert capabilities["engine_version"] is None
    assert capabilities["engine_binary"] is None
    assert capabilities["available"] is False
    assert capabilities["warning"] is not None
    assert "not found on PATH" in capabilities["warning"]
    assert "archon doctor" in capabilities["warning"]


@runs_async
async def test_a_present_engine_is_the_positive_control_for_the_missing_one(
    adapter: ClaudeAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The absence above must be the engine, not a broken probe on this host."""
    monkeypatch.setenv("FAKE_CLAUDE_VERSION", "2.1.278 (Claude Code)")
    capabilities = await adapter.capabilities()

    assert capabilities["engine_version"] == "2.1.278"
    assert capabilities["engine_binary"] is not None


# --------------------------------------------------------------- the evidence


def evidence_directory() -> Path:
    directory = Path(__file__).resolve().parents[1] / "docs" / "evidence"
    assert directory.is_dir(), "the recorded spike evidence is the control for this suite"
    return directory


def recorded_versions() -> list[str]:
    """Parse the evidence independently of the code under test."""
    found = set()
    for path in sorted(evidence_directory().glob("*-spike-*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        version = record.get("engine_version")
        if isinstance(version, str) and record.get("verdict") != "FAIL":
            found.add(version)
    return sorted(found, key=lambda value: tuple(int(part) for part in value.split(".")))


def test_the_tested_engine_range_is_never_empty_and_names_the_recorded_versions() -> None:
    """QA-H2: ``all(isinstance(v, str) for v in ...)`` passes over an empty list.

    Stubbing the range to ``[]`` failed only two tests, both behind a prerequisite
    skip needing bubblewrap *and* socat — which is the defect the last commit fixed
    in the wheel, left unlocked.  This compares against the evidence files, parsed
    here rather than by the function under test.
    """
    versions = recorded_versions()
    assert versions, "no usable spike evidence on record; the control itself failed"

    tested = tested_engine_range()

    assert tested == [versions[0], versions[-1]]
    assert len(tested) == 2
    assert all(version and version[0].isdigit() for version in tested)


def test_the_installer_and_the_adapter_locate_the_same_evidence() -> None:
    """Their docstrings say the two must agree; nothing asserted that they do."""
    from archon import install
    from archon.claude_adapter import _evidence_directory

    adapter_directory = _evidence_directory()

    assert adapter_directory is not None
    assert adapter_directory.resolve() == install._evidence_directory().resolve()
    installer_versions = install._tested_versions()
    assert installer_versions
    assert (installer_versions[0], installer_versions[-1]) == tuple(tested_engine_range())


# ----------------------------------------------------------- fixture fidelity


#: Fields the recorded ``system/init`` does not carry, so the fixtures' values for
#: them are invented and attest nothing.  Adding a new invented field fails the
#: drift test rather than quietly widening this ceiling.
UNATTESTED_INIT_FIELDS = frozenset({"cwd", "uuid", "type", "subtype"})


def recorded_init() -> dict[str, Any]:
    """The one literal ``system/init`` shape on record (live probe P6)."""
    record = json.loads(
        (evidence_directory() / "2026-09-22-live-probes.json").read_text(encoding="utf-8")
    )
    init = record["probes"]["P6_session_identity_and_hermeticity"]["init"]
    assert isinstance(init, dict) and "skills" in init
    return dict(init)


def fixture_inits() -> dict[str, dict[str, Any]]:
    events = {}
    for path in sorted(FIXTURES.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if event.get("type") == "system" and event.get("subtype") == "init":
                events[path.name] = event
                break
    return events


def test_the_recorded_fixtures_do_not_drift_from_the_recorded_engine() -> None:
    """QA-M5: the fixtures are the sole control for the whole review path.

    Nothing compared them with ``docs/evidence/``, so an invented field or a
    changed type would have been indistinguishable from an engine fact.
    """
    reference = recorded_init()
    inits = fixture_inits()
    assert inits, "the reviewer fixtures are the control for this suite"

    for name, event in inits.items():
        missing = set(reference) - set(event)
        assert not missing, f"{name} omits recorded init fields {sorted(missing)}"
        for key, value in reference.items():
            assert type(event[key]) is type(value), f"{name}:{key} contradicts the record"
        invented = set(event) - set(reference) - UNATTESTED_INIT_FIELDS
        assert not invented, f"{name} invents unrecorded init fields {sorted(invented)}"


def test_the_hermetic_fixture_matches_the_recorded_hermetic_session() -> None:
    """``skills: []`` and ``mcp_servers: []`` are attested; ``agents`` is never empty."""
    reference = recorded_init()
    success = fixture_inits()["success.jsonl"]

    assert success["skills"] == reference["skills"] == []
    assert success["mcp_servers"] == reference["mcp_servers"] == []
    assert success["permissionMode"] == reference["permissionMode"] == "dontAsk"
    # P6 ran with `--tools Read` and still reported five agents, so a fixture
    # asserting an empty agent list would contradict the record.
    assert reference["agents"] and success["agents"]


def test_the_unattested_fixture_fields_are_declared_rather_than_assumed() -> None:
    """Label the ceiling: these appear in no evidence file and prove nothing."""
    reference = recorded_init()
    extras: set[str] = set()
    for event in fixture_inits().values():
        extras |= set(event) - set(reference)

    assert extras == {"type", "subtype", "cwd", "uuid"}


def test_the_check_profile_masks_the_whole_state_root_not_only_the_receipts(
    adapter: ClaudeAdapter, receipt_root: Path, workspace: Path
) -> None:
    """SEC-H2: the profile was handed the receipt root, and the database is its sibling."""
    job = adapter._new_invocation("check_mask", "check", workspace, repo_root=workspace)
    profile = adapter._check_profile(job, workspace)

    assert profile.state_dir == receipt_root.parent
    assert receipt_root.parent in profile.masked_paths()
    assert receipt_root.parent.resolve() != receipt_root.resolve()


@pytest.mark.sandbox
@needs_bwrap
@usable_unmasked_temp
@runs_async
async def test_a_check_cannot_read_the_evidence_database_beside_its_receipt_root(
    adapter_outside_tmp: ClaudeAdapter, unmasked_state: Path, workspace: Path
) -> None:
    """SEC-H2 under real bubblewrap, with the positive control the rule requires.

    The state root has to live outside ``/tmp`` for this to prove anything: the
    profile already replaces ``/tmp`` with a tmpfs, so a pytest ``tmp_path`` state
    root is hidden whether or not the mask is right — a denial indistinguishable
    from an absence.  The worktree read is the paired control.

    The reviewer half of SEC-H2 is not covered here: it needs a live authenticated
    session, so only the generated ``denyRead`` list is asserted.
    """
    marker = "archon-planted-evidence-marker-4f1b"
    database = unmasked_state / "state.sqlite3"
    database.write_text(marker, encoding="utf-8")
    (workspace / "control.txt").write_text(marker, encoding="utf-8")
    spec = CheckSpec(
        name="dump",
        argv=["/bin/sh", "-c", f"cat {database} 2>&1; echo ---; cat control.txt"],
        timeout_seconds=60,
    )

    result = await adapter_outside_tmp.run_command(spec, make_candidate(workspace), Policy())

    assert result.error is None, result.error
    # The control read must succeed, or the "denial" above is just a broken probe.
    assert result.stdout.split("---")[1].strip() == marker
    assert result.stdout.count(marker) == 1, "the check read the kernel's evidence database"


# -------------------------------------------------- binding evidence to a profile


def test_the_expected_profile_digest_is_derived_and_shape_sensitive(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    """The gate could assert a digest was present, never that it was the right one.

    So a ``CommandResult`` naming any other self-consistent profile still passed.
    The accessor re-derives the digest through the same construction
    ``run_command`` uses; these assertions prove it is a real confinement hash and
    not a constant, without quoting a value that the mask set keeps changing.
    """
    from archon.sandbox import DEFAULT_MASKED, CheckProfile, prepare_scratch

    digest = adapter.check_profile_digest(make_candidate(workspace), Policy())

    assert len(digest) == 64 and set(digest) <= set("0123456789abcdef")
    assert digest == adapter.check_profile_digest(make_candidate(workspace), Policy())
    # A narrower mask must hash differently, or the digest binds nothing.
    narrowed = CheckProfile(
        worktree=workspace.resolve(),
        scratch=prepare_scratch(workspace.parent / "narrow-scratch"),
        state_dir=adapter._state_root(),
        home=Path.home().resolve(),
        masked=DEFAULT_MASKED[:-1],
    )
    assert narrowed.digest() != digest


def test_the_expected_profile_digest_leaves_no_scratch_behind(
    adapter: ClaudeAdapter, receipt_root: Path, workspace: Path
) -> None:
    """It renders a real profile, so it makes a real directory; it must clean up.

    The name also stays outside ``runtime-*`` so the credential sweep never sees it.
    """
    adapter.check_profile_digest(make_candidate(workspace), Policy())

    assert list(receipt_root.glob("digest-*")) == []
    assert control_dirs(receipt_root) == []


@pytest.mark.sandbox
@needs_bwrap
@runs_async
async def test_a_recorded_check_digest_equals_the_one_the_kernel_would_render(
    adapter: ClaudeAdapter, workspace: Path
) -> None:
    """The binding itself: what a check recorded is what the kernel expected.

    Both sides come from the same construction, so this fails if either the
    accessor or ``run_command`` starts rendering a different confinement.
    """
    candidate = make_candidate(workspace)
    policy = Policy()
    spec = CheckSpec(name="echo", argv=["/bin/sh", "-c", "echo bound"], timeout_seconds=30)

    result = await adapter.run_command(spec, candidate, policy)

    assert result.exit_code == 0 and result.error is None, result.error
    assert result.sandbox_profile_digest == adapter.check_profile_digest(candidate, policy)
