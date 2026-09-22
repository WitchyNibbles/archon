"""Hook behavior: advisory only, bounded, fail-open, and never self-locking.

Every assertion here is about what a hook may *not* do -- deny a tool it was not
asked to guard, block a session it cannot read state for, mark work verified, or
write outside its own private state -- plus the small set of shapes it must deny.
"""

from __future__ import annotations

import os
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from archon import hooks


class FakeStore:
    def __init__(self) -> None:
        self.observations: dict[str, Any] = {}

    def append_event(self, run_id, kind, payload, *, job_id=None, event_key=None):
        self.observations[event_key] = (run_id, kind, payload)


class FakeService:
    def __init__(self, state_dir: Path) -> None:
        self.workspace = SimpleNamespace(state_dir=state_dir, worktree_id="worktree")
        self.store = FakeStore()
        self.saved: list[tuple[str, dict]] = []
        self.data = {
            "run": {
                "run_id": "run1",
                "state": "active",
                "checkpoint": {"context": {"decisions": ["Keep the native Claude Code UX"],
                                           "next": "Implement task"}},
            },
            "tasks": [{"task_id": "t1", "state": "planned",
                       "spec": {"task_id": "t1", "allowed_paths": ["src/feature.py"]}}],
            "jobs": [],
            "evidence": {"checks": [], "reviews": [], "truncated": False},
            "next_action": {"action": "implement", "run_id": "run1", "task_id": "t1",
                            "reason": "Ready", "inputs": {}},
        }

    def status(self) -> dict:
        return deepcopy(self.data)

    def checkpoint(self, run_id: str, context: dict) -> None:
        self.saved.append((run_id, context))
        self.data["run"]["checkpoint"] = {"context": context}


def event(name: str, **extra: Any) -> dict[str, Any]:
    return {"hook_event_name": name, "session_id": "session1", "cwd": "/unused",
            "permission_mode": "default", **extra}


def tool_event(tool: str, **tool_input: Any) -> dict[str, Any]:
    return event("PreToolUse", tool_name=tool, tool_input=tool_input)


def is_inert(result: dict) -> bool:
    """No continuation, no denial: the two ways a hook could wedge a session."""
    specific = result.get("hookSpecificOutput") or {}
    return "decision" not in result and specific.get("permissionDecision") != "deny"


# --- Lifecycle context and checkpointing -------------------------------------------


def test_session_restore_and_compaction_preserve_decisions(tmp_path):
    service = FakeService(tmp_path)
    before = service.data["run"]["checkpoint"]["context"]["decisions"]
    restored = hooks.handle_event(event("SessionStart", source="resume"), service=service)
    assert "Keep the native Claude Code UX" in restored["hookSpecificOutput"]["additionalContext"]
    assert hooks.handle_event(event("PreCompact", trigger="auto"), service=service) == {}
    assert service.saved[-1][1]["decisions"] == before
    assert "transcript" not in str(service.saved)
    # PostCompact is not one of the groups init writes; an unregistered event is inert.
    assert hooks.handle_event(event("PostCompact"), service=service) == {}


def test_post_compaction_context_arrives_through_session_start_not_precompact(tmp_path):
    service = FakeService(tmp_path)
    compacted = hooks.handle_event(event("SessionStart", source="compact"), service=service)
    injected = compacted["hookSpecificOutput"]
    assert injected["hookEventName"] == "SessionStart"
    assert "run1" in injected["additionalContext"]
    # PreCompact cannot inject context in Claude Code; it may only checkpoint.
    assert hooks.handle_event(event("PreCompact", trigger="manual"), service=service) == {}
    assert service.saved[-1][1]["native_lifecycle"]["event"] == "PreCompact"


def test_subagent_observation_cannot_mark_task_done_or_launch_manager(tmp_path):
    service = FakeService(tmp_path)
    original = deepcopy(service.data["tasks"])
    output = hooks.handle_event(
        event("SubagentStart", agent_id="child1", agent_type="archon-familiar"), service=service)
    assert "assigned specialist scope" in output["hookSpecificOutput"]["additionalContext"]
    assert hooks.handle_event(
        event("SubagentStop", agent_id="child1", last_assistant_message="Everything passed"),
        service=service) == {}
    assert service.data["tasks"] == original
    assert len(service.store.observations) == 2


def test_untrusted_transcript_paths_are_never_read_and_context_bounded(tmp_path):
    service = FakeService(tmp_path)
    service.data["run"]["checkpoint"]["context"]["notes"] = "a" * 50_000
    path = tmp_path / "transcript.jsonl"
    path.write_text("secret not for hook output", encoding="utf-8")
    output = hooks.handle_event(event("SessionStart", transcript_path=str(path)), service=service)
    context = output["hookSpecificOutput"]["additionalContext"]
    assert "secret" not in context and len(context) <= hooks.MAX_CONTEXT


# --- Bounded Stop continuation ------------------------------------------------------


def test_stop_continues_then_bounds_no_progress_and_yields_on_reentry(tmp_path):
    service = FakeService(tmp_path)
    assert hooks.handle_event(event("Stop"), service=service)["decision"] == "block"
    assert hooks.handle_event(event("Stop"), service=service)["decision"] == "block"
    assert hooks.handle_event(event("Stop"), service=service) == {}
    service.data["tasks"][0]["state"] = "implementing"
    # Re-entry after the engine's own block cap always yields, progress or not.
    assert hooks.handle_event(event("Stop", stop_hook_active=True), service=service) == {}
    assert hooks.handle_event(event("Stop"), service=service)["decision"] == "block"


def test_continuation_budget_resets_on_genuine_task_progress(tmp_path):
    service = FakeService(tmp_path)
    for index in range(hooks.MAX_STOP_CONTINUATIONS + 3):
        service.data["tasks"].append({"task_id": f"task{index}", "state": "verifying", "spec": {}})
        assert hooks.handle_event(event("Stop"), service=service)["decision"] == "block"
    assert hooks.handle_event(event("Stop"), service=service)["decision"] == "block"
    service.data["next_action"]["reason"] = "Rewording cannot count as progress"
    assert hooks.handle_event(event("Stop"), service=service) == {}


def test_stop_waits_for_active_reviews_without_user_wakeup(tmp_path):
    service = FakeService(tmp_path)
    service.data["run"]["state"] = "verifying"
    service.data["jobs"] = [{"job_id": "gate", "state": "running", "attempt": 1}]
    service.data["next_action"] = {"action": "wait", "inputs": {"job_ids": ["gate"]}}
    for _ in range(hooks.MAX_STOP_CONTINUATIONS):
        result = hooks.handle_event(event("Stop"), service=service)
        assert result["decision"] == "block" and "MCP wait tool" in result["reason"]
    assert hooks.handle_event(event("Stop"), service=service) == {}
    service.data["jobs"][0]["state"] = "succeeded"
    service.data["next_action"] = {"action": "verify"}
    assert hooks.handle_event(event("Stop"), service=service)["decision"] == "block"


@pytest.mark.parametrize("state", ["verified", "blocked", "paused", "cancelled", "planning"])
def test_stop_respects_terminal_and_paused_states(tmp_path, state):
    service = FakeService(tmp_path)
    service.data["run"]["state"] = state
    assert hooks.handle_event(event("Stop"), service=service) == {}


@pytest.mark.parametrize("action", ["report", "stop", "run_start", "unknown"])
def test_stop_does_not_spin_when_nothing_actionable(tmp_path, action):
    service = FakeService(tmp_path)
    service.data["next_action"]["action"] = action
    assert hooks.handle_event(event("Stop"), service=service) == {}


def test_stop_yields_in_plan_mode(tmp_path):
    service = FakeService(tmp_path)
    assert hooks.handle_event(event("Stop", permission_mode="plan"), service=service) == {}


def test_malicious_session_id_is_hashed_for_private_path(tmp_path):
    service = FakeService(tmp_path / "state")
    output = hooks.handle_event(event("Stop", session_id="../../outside"), service=service)
    assert output["decision"] == "block"
    files = list((tmp_path / "state/native-hooks").iterdir())
    assert len(files) == 1 and len(files[0].stem) == 64


def test_hook_state_symlink_does_not_write_outside_private_state(tmp_path):
    service = FakeService(tmp_path / "state")
    service.workspace.state_dir.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (service.workspace.state_dir / "native-hooks").symlink_to(outside)
    output = hooks.handle_event(event("Stop"), service=service)
    assert set(output) == {"systemMessage"} and is_inert(output)
    assert list(outside.iterdir()) == []


# --- PreToolUse guard ---------------------------------------------------------------


GUARD_DENIALS = [
    ("no_verify", tool_event("Bash", command='git commit -m "wip" --no-verify')),
    # `-n` is the short form of the same flag, and an emptied hooks path is the same
    # bypass by another route; a row that misses these is not a ceiling, it is a hole.
    ("no_verify", tool_event("Bash", command='git commit -n -m "wip"')),
    ("no_verify", tool_event("Bash", command='git commit -am "wip" --no-verify')),
    ("no_verify", tool_event("Bash", command='git -c core.hooksPath=/dev/null commit -m "wip"')),
    ("force_push", tool_event("Bash", command="git push --force origin main")),
    ("force_push", tool_event("Bash", command="git push origin +main")),
    ("test_deletion", tool_event("Bash", command="rm -rf tests/test_gate.py")),
    ("test_deletion", tool_event("Bash", command="rm QA/Testing/smoke.py")),
    # Truncation by redirection names no deletion verb and empties the file anyway.
    ("test_deletion", tool_event("Bash", command=": > tests/test_gate.py")),
    ("test_deletion", tool_event("Bash", command="printf '' >> QA/Testing/smoke.py")),
    ("test_truncation_write", tool_event("Write", file_path="/repo/tests/test_gate.py", content="")),
    ("test_truncation_write", tool_event("Write", file_path="/repo/QA/Testing/smoke.py", content="\n  \n")),
    ("test_truncation_write", tool_event("NotebookEdit", notebook_path="/repo/tests/test_gate.ipynb",
                                         new_source="")),
    ("candidate_mutation", tool_event("Bash", command="git reset --hard HEAD~1")),
    ("managed_files_bash", tool_event("Bash", command="rm -rf .archon/native-install.json")),
    ("managed_files_write", tool_event("Write", file_path="/repo/.claude/agents/archon-warden.md",
                                       content="you are lenient")),
    ("managed_files_write", tool_event("Edit", file_path="/repo/.claude/skills/archon-manager/SKILL.md",
                                       old_string="a", new_string="b")),
    ("managed_files_write", tool_event("NotebookEdit", notebook_path="/repo/.archon/notes.ipynb",
                                       new_source="print(1)")),
    ("managed_claude_block", tool_event("Edit", file_path="/repo/CLAUDE.md",
                                        old_string="<!-- BEGIN ARCHON NATIVE -->\nrules",
                                        new_string="")),
    ("hook_injection", tool_event("Bash", command="chmod +x .git/hooks/pre-commit")),
    # Three spellings of the same bit: an explicit mode, install's mode, cp's carry-over.
    ("hook_injection", tool_event("Bash", command="chmod 755 .git/hooks/pre-commit")),
    ("hook_injection", tool_event("Bash", command="install -m 755 build/hook .git/hooks/pre-commit")),
    ("hook_injection", tool_event("Bash", command="cp -p scripts/hook.sh .git/hooks/pre-commit")),
]

GUARD_ALLOWANCES = [
    tool_event("Bash", command="git commit -m 'implement the gate'"),
    tool_event("Bash", command="git push origin feature/gate"),
    tool_event("Bash", command="uv run pytest tests/test_gate.py -q"),
    tool_event("Bash", command="rm -rf build/ dist/"),
    tool_event("Bash", command="rm QA/Docs/notes.md"),
    tool_event("Bash", command="cat .archon/native-install.json"),
    tool_event("Bash", command="chmod +x scripts/run_checks.sh"),
    tool_event("Write", file_path="/repo/src/feature.py", content="value = 1"),
    tool_event("Edit", file_path="/repo/CLAUDE.md", old_string="Style", new_string="House style"),
    tool_event("NotebookEdit", notebook_path="/repo/analysis.ipynb", new_source="print(1)"),
    # Prose that merely quotes the marker is not an edit to the managed block.
    tool_event("Write", file_path="/repo/docs/install.md",
               content="init writes <!-- BEGIN ARCHON NATIVE --> into CLAUDE.md"),
    # A commit message that talks about `-n` is data, not a flag vector.
    tool_event("Bash", command='git commit -m "document the -n shorthand"'),
    tool_event("Bash", command="git config --get core.hooksPath"),
    tool_event("Bash", command="git push -n origin feature/gate"),
    # Redirection condemns only its own target: running the suite is not deleting it.
    tool_event("Bash", command="uv run pytest tests/ -q > /tmp/pytest.log"),
    tool_event("Bash", command='echo "release note" > docs/notes.md'),
    tool_event("Bash", command="grep -n assert tests/test_gate.py"),
    tool_event("Bash", command="cp -p src/feature.py src/feature_backup.py"),
    tool_event("Bash", command="install -m 644 config/app.toml build/app.toml"),
    # Writing a test is the work the worker is here for; only emptying one is deletion.
    tool_event("Write", file_path="/repo/tests/test_gate.py",
               content="def test_gate() -> None:\n    assert gate().verified\n"),
]


def guarded_service(tmp_path: Path) -> FakeService:
    service = FakeService(tmp_path)
    service.data["run"]["state"] = "verifying"
    service.data["jobs"] = [{"job_id": "gate", "state": "running", "attempt": 1}]
    service.data["tasks"][0]["spec"]["allowed_paths"] = ["src/feature.py", "QA/Testing/smoke.py"]
    return service


@pytest.mark.parametrize("rule_id,payload", GUARD_DENIALS, ids=[f"{r}-{i}" for i, (r, _) in enumerate(GUARD_DENIALS)])
def test_every_guard_row_denies_with_a_reason(tmp_path, rule_id, payload):
    service = guarded_service(tmp_path)
    output = hooks.handle_event(payload, service=service)["hookSpecificOutput"]
    assert output["hookEventName"] == "PreToolUse"
    assert output["permissionDecision"] == "deny"
    assert rule_id in output["permissionDecisionReason"]
    assert len(output["permissionDecisionReason"]) <= hooks.MAX_REASON
    # The denial is auditable but never echoes the command, which may carry secrets.
    assert payload["tool_input"].get("command", "\0") not in output["permissionDecisionReason"]
    assert any(item[2]["rule"] == rule_id for item in service.store.observations.values())


@pytest.mark.parametrize("payload", GUARD_ALLOWANCES,
                         ids=[f"allow-{index}" for index in range(len(GUARD_ALLOWANCES))])
def test_benign_calls_on_guarded_tools_are_allowed(tmp_path, payload):
    service = guarded_service(tmp_path)
    assert hooks.handle_event(payload, service=service) == {}
    assert not service.store.observations


def test_candidate_mutation_is_only_denied_while_verification_runs(tmp_path):
    service = FakeService(tmp_path)
    reset = tool_event("Bash", command="git checkout -- src/feature.py")
    assert hooks.handle_event(reset, service=service) == {}
    service.data["jobs"] = [{"job_id": "gate", "state": "running", "attempt": 1}]
    denied = hooks.handle_event(reset, service=service)["hookSpecificOutput"]
    assert denied["permissionDecision"] == "deny"


def test_guard_ignores_unmatched_tools_and_malformed_tool_input(tmp_path):
    service = guarded_service(tmp_path)
    assert hooks.handle_event(tool_event("Read", file_path="/repo/.archon/state"), service=service) == {}
    assert hooks.handle_event(event("PreToolUse", tool_name="Bash", tool_input="rm -rf tests"),
                              service=service) == {}
    assert hooks.handle_event(event("PreToolUse", tool_name=None, tool_input={}), service=service) == {}
    assert hooks.handle_event(tool_event("Bash"), service=service) == {}


def test_guard_is_inert_without_an_archon_run(tmp_path, git_repo, monkeypatch):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    payload = {**tool_event("Bash", command="git push --force origin main"), "cwd": str(git_repo)}
    assert hooks.handle_event(payload) == {}


# --- Inertness, fail-open, and malformed input ---------------------------------------


def test_managed_reviewer_noops_all_hooks_without_state_access(tmp_path, monkeypatch):
    service = guarded_service(tmp_path)
    monkeypatch.setenv(hooks.REVIEW_ENV, "1")
    for name in hooks.EVENTS:
        assert hooks.handle_event(event(name), service=service) == {}
    for _, payload in GUARD_DENIALS:
        assert hooks.handle_event(payload, service=service) == {}
    assert not service.saved and not service.store.observations


def test_hook_failure_never_claims_verified(tmp_path):
    service = FakeService(tmp_path)

    def explode() -> dict:
        raise RuntimeError("secret failure detail")

    service.status = explode  # type: ignore[method-assign]
    output = hooks.handle_event(event("Stop"), service=service)
    assert set(output) == {"systemMessage"} and is_inert(output)
    assert "secret failure detail" not in output["systemMessage"]
    assert "verified" in output["systemMessage"]


@pytest.mark.parametrize("name", sorted(hooks.EVENTS))
def test_absent_state_directory_is_inert_for_every_event(tmp_path, git_repo, name):
    payload = {**event(name), "cwd": str(git_repo), "tool_name": "Bash",
               "tool_input": {"command": "git push --force origin main"}}
    assert hooks.handle_event(payload, state_home=tmp_path / "state") == {}


@pytest.mark.parametrize("name", sorted(hooks.EVENTS))
def test_unreadable_state_directory_fails_open_for_every_event(tmp_path, git_repo, name):
    state_home = tmp_path / "state"
    state_home.mkdir()
    payload = {**event(name), "cwd": str(git_repo), "tool_name": "Bash",
               "tool_input": {"command": "git push --force origin main"}}
    os.chmod(state_home, 0o000)
    try:
        output = hooks.handle_event(payload, state_home=state_home)
    finally:
        os.chmod(state_home, 0o700)
    assert set(output) <= {"systemMessage"} and is_inert(output)


@pytest.mark.parametrize("payload", [{}, None, [], {"hook_event_name": []},
                                     {"hook_event_name": "PermissionRequest"},
                                     {"hook_event_name": "Stop"}])
def test_unknown_or_malformed_events_are_inert(payload):
    assert hooks.handle_event(payload) == {}


# --- Real kernel --------------------------------------------------------------------


def test_real_kernel_restores_run_without_execution_adapter(tmp_path, git_repo, monkeypatch):
    from archon.service import ArchonService
    from archon.store import Store
    from archon.workspace import Workspace

    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    workspace = Workspace(git_repo)
    store = Store(workspace.state_dir)
    service = ArchonService(workspace, store)
    started = service.start(
        "Implement the gate",
        [{"acceptance_id": "ac1", "description": "The gate works"}],
        [{"task_id": "t1", "title": "Build the gate", "acceptance": ["ac1"],
          "allowed_paths": ["feature.py"]}],
    )
    run_id = started["run"]["run_id"]
    service.checkpoint(run_id, {"decisions": {"ux": "Native Claude Code"}})
    store.close()

    output = hooks.handle_event({**event("SessionStart", source="startup"), "cwd": str(git_repo)})
    assert "Native Claude Code" in output["hookSpecificOutput"]["additionalContext"]
    assert hooks.handle_event({**event("PreCompact"), "cwd": str(git_repo)}) == {}
    denied = hooks.handle_event({**tool_event("Bash", command="git commit --no-verify -m x"),
                                 "cwd": str(git_repo)})
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    blocked = hooks.handle_event({**event("Stop"), "cwd": str(git_repo)})
    assert blocked["decision"] == "block"

    store = Store(workspace.state_dir)
    observed = store.events(run_id)
    assert any(item["kind"] == "native_hook" for item in observed)
    assert not store.list_jobs(run_id)
    store.close()


def test_every_guard_row_names_the_failure_it_prevents() -> None:
    """Iron rule: no mechanism without a run that needed it.

    A row whose citation is a review or a design note says so in those words, so the
    weak ones stay visible instead of being dressed up as observed runs.
    """
    exercised = {rule_id for rule_id, _payload in GUARD_DENIALS}

    for rule in hooks.GUARD_RULES:
        assert len(rule.citation.split()) >= 10, f"{rule.rule_id} cites nothing concrete"
        assert rule.reason.strip() and rule.field in {"command", "target", "text"}
        assert rule.tools <= hooks.GUARDED_TOOLS
    assert len({rule.rule_id for rule in hooks.GUARD_RULES}) == len(hooks.GUARD_RULES)
    assert exercised == {rule.rule_id for rule in hooks.GUARD_RULES}


def test_a_declared_test_path_outside_tests_is_protected_from_every_spelling(tmp_path):
    """The plan's own allowed_paths decide what a test file is, not just `tests/`."""
    service = guarded_service(tmp_path)
    for command in ("rm QA/Testing/smoke.py", ": > QA/Testing/smoke.py",
                    "truncate -s 0 QA/Testing/smoke.py"):
        denied = hooks.handle_event(tool_event("Bash", command=command), service=service)
        assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    emptied = hooks.handle_event(
        tool_event("Write", file_path="/repo/QA/Testing/smoke.py", content=""), service=service)
    assert emptied["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_the_stop_continuation_budget_is_eight_and_not_a_number_the_test_derives(tmp_path):
    """AC-21 fixes the bound in words; a loop over the constant would pass at any value."""
    service = FakeService(tmp_path)
    service.data["run"]["state"] = "verifying"
    service.data["jobs"] = [{"job_id": "gate", "state": "running", "attempt": 1}]
    service.data["next_action"] = {"action": "wait", "inputs": {"job_ids": ["gate"]}}

    assert hooks.MAX_STOP_CONTINUATIONS == 8
    blocked = 0
    for _ in range(64):
        if hooks.handle_event(event("Stop"), service=service).get("decision") != "block":
            break
        blocked += 1
    assert blocked == 8
