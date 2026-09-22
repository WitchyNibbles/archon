"""Native Claude Code lifecycle hooks: advisory context, bounded Stop continuation,
and one small `PreToolUse` guard.

Handlers read only fields Claude Code actually delivers on stdin. They never open
`transcript_path`, never infer context-usage percentages, never run project
commands, never authorize a tool, and never mark implementation or review work
verified. Every handler is inert when no Archon run exists in the worktree and
when `ARCHON_MANAGED_REVIEW=1` is set, so a managed reviewer is never steered by
the harness whose work it is judging. Every handler **fails open**: if the kernel
is unreachable the session continues and a `systemMessage` says so. An
unavailable hook never manufactures passing evidence and never denies a tool.

`PreCompact` only checkpoints; Claude Code cannot inject context from it. The
post-compaction channel that reaches the model is `SessionStart` with
`source: compact` (research §1.6, spike S8); `PostCompact` is not one of the
groups `init` writes, so it is inert here. `Stop` always yields on
`stop_hook_active: true` (spike S7) and its continuation budget is additionally
bounded by a private, per-session, flock'd counter, so a restart cannot reset it.

Guard ceiling, stated honestly
------------------------------
The `PreToolUse` guard is a short, fixed pattern table over `tool_input`. It runs
as the same uid as the agent it guards, so an agent that wants to route around it
can: `python -c`, a helper script, a here-doc, a renamed binary, or any spelling
the table does not list will pass. The table catches the obvious, repeatedly observed
shapes; the security reviewer's diff scan catches more; the final report labels
what neither caught. It is a speed bump with receipts, not a sandbox -- the OS
sandbox (`bwrap` for checks, settings sandbox for reviewers) is the boundary that
actually holds. This file deliberately stays a pattern table: a predecessor
shipped a 3,572-line shell parser for this job and it was theatre.

Each row carries the *canonical* spellings of the failure it names, because a row
that misses the short form of its own flag is not a ceiling, it is a hole: `-n` is
`--no-verify`, `: >` empties a file as surely as `rm`, `install -m` sets the same
bit `chmod +x` does. Still out of reach and deliberately not chased, since
enumerating unsafe shapes never converges: `sed -i` over a test body, an `Edit`
that replaces a whole test file with nothing, `printf` into `.git/hooks` followed
by a separate chmod in another turn, and anything a wrapper script spells for the
model. Those are the diff scan's and the reviewer's job.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

MAX_INPUT = 64 * 1024
MAX_CONTEXT = 4800
MAX_REASON = 2000
MAX_SUBJECT = 8192
MAX_FIELD = 256
MAX_STATE_BYTES = 8192
MAX_INSPECTED_PATHS = 256
MAX_SEGMENTS = 64
# AC-21 fixes this bound in words: the Stop hook yields on `stop_hook_active` after
# eight continuations. Eight is the engine's own cap on consecutive Stop blocks
# (spike S7), so a larger number here would only be a budget the engine never lets
# us spend; tests pin the literal, not this name.
MAX_STOP_CONTINUATIONS = 8
MAX_SAME_ACTION = 2

REVIEW_ENV = "ARCHON_MANAGED_REVIEW"
LIFECYCLE_EVENTS = frozenset({"SessionStart", "PreCompact", "SubagentStart", "SubagentStop", "Stop"})
EVENTS = LIFECYCLE_EVENTS | {"PreToolUse"}
CHECKPOINT_EVENTS = frozenset({"PreCompact", "SubagentStop", "Stop"})
GUARDED_TOOLS = frozenset({"Bash", "Edit", "Write", "NotebookEdit"})
OBSERVED_FIELDS = ("session_id", "source", "trigger", "agent_id", "agent_type", "permission_mode")
ACTIONABLE = frozenset({"implement", "continue", "inspect", "verify", "repair", "resume", "plan", "wait"})
QUIET_RUN_STATES = frozenset({"verified", "blocked", "paused", "cancelled", "planning"})

SUBAGENT_SCOPE = (
    "Execute only your assigned specialist scope and report back to the parent manager. "
    "Do not start another Archon run, do not dispatch reviewers, and do not mark anything "
    "verified; the kernel owns verification. Honor existing repository controls.\n"
)
SUMMARY_HEADER = (
    "Archon persisted workflow data. Restore the accepted scope through the Archon MCP "
    "status tool and follow current user steering.\n"
)
FAIL_OPEN_MESSAGE = (
    "Archon lifecycle state was unavailable, so this hook did nothing. The manager can "
    "recover through the Archon MCP status/resume tools; verified completion still "
    "requires the kernel gate."
)


# --- Guard table (docs/assets.md "Guard table"); rule -> reason -------------------


@dataclasses.dataclass(frozen=True)
class GuardRule:
    """One `PreToolUse` deny rule. `field` selects the bounded subject string.

    `citation` names the observed failure the row exists for. "No mechanism without
    a run that needed it" is an iron rule, so a row that cannot name one does not
    ship; where the record holds only a review or a design note, the citation says
    so in those words rather than dressing it up as a run.
    """

    rule_id: str
    tools: frozenset[str]
    field: str  # "command" | "target" | "text"
    pattern: re.Pattern[str]
    reason: str
    citation: str
    requires: str = ""  # see `_condition` for the recognised conditions


# `git restore` is the modern spelling of `git checkout --` and shares its row.
_CANDIDATE_MUTATORS = r"\bgit\s+(?:checkout|reset|clean|stash|restore)\b"
_MANAGED_PATHS = r"(?:\.archon/|\.claude/agents/archon-|\.claude/skills/archon-manager(?:/|\b))"
_MANAGED_BLOCK = r"(?:BEGIN|END)\s+ARCHON\s+NATIVE"
CLAUDE_MD = re.compile(r"CLAUDE(?:\.local)?\.md")

MUTATING_COMMAND = re.compile(
    r"\brm\b|\bmv\b|\bcp\b|\bdd\b|\btee\b|\btruncate\b|\bchmod\b|\bchown\b|\bln\b"
    r"|\bsed\b[^\n]*(?<![\w-])-i|>"
)
DELETION_COMMAND = re.compile(r"\b(?:rm|unlink|shred)\b|\bgit\s+rm\b|\btruncate\b")
# `: > tests/test_x.py` empties a declared test file while naming no deletion verb,
# so the redirection operators are part of the same row; which file a redirection
# empties is decided by its target, never by the rest of the command line.
REDIRECTION = r">>?"
REDIRECT_TARGET = re.compile(r">>?\s*([^\s;&|<>]+)")
TEST_DELETION = re.compile(DELETION_COMMAND.pattern + "|" + REDIRECTION)
TEST_FILENAME = re.compile(
    r"(?:^|[\s\"'/])(?:test_[^\s\"'/]+|[^\s\"'/]+_test\.[A-Za-z0-9]+"
    r"|[^\s\"'/]+\.test\.[A-Za-z0-9]+|[^\s\"'/]+_spec\.[A-Za-z0-9]+)"
)
DEFAULT_TEST_PATHS = ("tests/", "test/", "spec/", "specs/", "__tests__/")
# Shell separators only: one clause's verb must not condemn the next clause's path.
SEGMENT = re.compile(r"[;&|\n]+")

# Commit-hook bypass, in the spellings that mean exactly the same thing:
# `--no-verify`, its short form `-n` on a `git commit`, and pointing the engine's
# hook path somewhere empty. A quoted commit message is data, not a flag vector,
# so the short form is read only outside quotes -- but an explicit `--no-verify`
# is honoured inside them too, because `sh -c "git commit --no-verify"` is real.
QUOTED = re.compile(r"'[^']*'|\"[^\"]*\"")
EXPLICIT_BYPASS = re.compile(
    r"(?<![\w-])--no-verify(?![\w-])|core\.hooksPath(?:\s*=|\s+[^\s;&|-])"
)
GIT_COMMIT = re.compile(r"\bgit\b(?=[^\n]*\bcommit\b)")
SHORT_NO_VERIFY = re.compile(r"(?<![\w-])-[A-Za-z]*n[A-Za-z]*(?![\w-])")
COMMIT_BYPASS = re.compile(EXPLICIT_BYPASS.pattern + "|" + SHORT_NO_VERIFY.pattern)

# Writing an empty body over a declared test file is `rm` by another tool.
CONTENT_FIELDS = ("content", "new_source", "new_string")
ANY_TARGET = re.compile(r"\S")

# A .git/hooks entry becomes live code the moment it is executable, whichever of
# the three usual spellings put the bit there: an explicit chmod, `install -m`, or
# a `cp -p` that carries the mode across from an already-executable source.
HOOK_INJECTION = re.compile(
    r"(?:\bchmod\b(?=[^\n;&|]*(?:\+x|(?<![\w])[0-7]*[1357][0-7]{0,2}(?![\w])))"
    r"|\binstall\b(?=[^\n;&|]*(?<![\w-])-m(?![\w-]))"
    r"|\bcp\b(?=[^\n;&|]*(?<![\w-])-p(?![\w-])))"
    r"(?=[^\n;&|]*\.git/hooks)"
)

_MANAGED_REASON = (
    "Managed-file edit outside `archon init`: .archon/, .claude/agents/archon-*, and "
    ".claude/skills/archon-manager/ are written by init and are the harness's own "
    "record. Change them with `archon init`, not from inside a run."
)
_MANAGED_CITATION = (
    "project-companion magic-tower 2026-09-17 H3: a worker's attempt-1 diff deleted "
    "`.companion/`, the harness's own record; one full attempt ($4.58) was lost."
)

GUARD_RULES: tuple[GuardRule, ...] = (
    GuardRule(
        "no_verify",
        frozenset({"Bash"}),
        "command",
        COMMIT_BYPASS,
        "Commit-hook bypass: --no-verify (or its short form -n, or an emptied "
        "core.hooksPath) skips the repository's own checks, which is the shape an agent "
        "reaches for when those checks fail. Fix the failure and commit normally.",
        "project-companion magic-tower 2026-09-17 H5: the transcript scan was worth "
        "keeping for exactly two shapes, Bash `--no-verify` and `rm` of repository test "
        "paths. The short and core.hooksPath spellings were added after an Archon release "
        "gate observed `git commit -n` and `git -c core.hooksPath=/dev/null commit` "
        "passing this row unchallenged.",
        requires="commit_hook_bypass",
    ),
    GuardRule(
        "force_push",
        frozenset({"Bash"}),
        "command",
        re.compile(
            r"\bgit\s+push\b[^\n;&|]*?(?:--force(?:-with-lease)?(?![\w-])"
            r"|(?<![\w-])-f(?![\w-])|\s\+[A-Za-z0-9_./~^-]+(?=[:\s]|$))"
        ),
        "History rewrite: force-pushing discards the commits that recorded evidence refers "
        "to. Delivery ends on a local branch; publication is a separate human instruction.",
        "Weakest citation in this table: docs/assets.md names a TypeScript-Archon "
        "seal-tamper finding, and no run reproducing it is on record here. The row is "
        "kept because evidence binds to commits, and labelled rather than dressed up.",
    ),
    GuardRule(
        "test_deletion",
        frozenset({"Bash"}),
        "command",
        TEST_DELETION,
        "Test deletion: this command removes, truncates, or overwrites a declared test "
        "path. Measured agents delete tests rather than report an impossible task; repair "
        "the code or record the task as blocked instead.",
        "Measured reward hacking (docs/research): ~49% of impossible tasks bypassed by "
        "deleting tests or hardcoding (Sep 2026), METR 30% unprompted on RE-Bench. "
        "companion H5 narrowed the transcript scan to `rm` of repository test paths; the "
        "redirection spelling was added after a release gate observed `: > tests/test_x.py` "
        "empty a declared test file without naming a deletion verb.",
        requires="test_target",
    ),
    GuardRule(
        "test_truncation_write",
        frozenset({"Write", "NotebookEdit"}),
        "target",
        ANY_TARGET,  # the target and the empty body are both decided by the condition
        "Test truncation: writing an empty body over a declared test path deletes the "
        "test as surely as `rm` does. Repair the code or record the task as blocked; a "
        "test that must change should change to something that still asserts.",
        "An Archon release gate observed that the Bash-only test-deletion row watches "
        "`rm tests/test_x.py` while the same worker can empty the same file with `Write`, "
        "which reaches the identical outcome unguarded.",
        requires="emptied_test_file",
    ),
    GuardRule(
        "candidate_mutation",
        frozenset({"Bash"}),
        "command",
        re.compile(_CANDIDATE_MUTATORS),
        "Candidate mutation mid-verification: a verification job is running against this "
        "worktree's candidate, and checkout/reset/clean/stash/restore would change the "
        "sources under it. Wait for the job, then repair against fresh evidence.",
        "devgod-recovery freshness rule (evidence binds to a candidate; a source change "
        "invalidates the result being produced) plus companion H3, where an unsupervised "
        "git-level base move produced a diff that deleted work nobody asked it to touch.",
        requires="verification_running",
    ),
    GuardRule(
        "managed_files_bash",
        frozenset({"Bash"}),
        "command",
        re.compile(_MANAGED_PATHS),
        _MANAGED_REASON,
        _MANAGED_CITATION,
        requires="mutating_command",
    ),
    GuardRule(
        "managed_files_write",
        frozenset({"Edit", "Write", "NotebookEdit"}),
        "target",
        re.compile(_MANAGED_PATHS),
        _MANAGED_REASON,
        _MANAGED_CITATION,
    ),
    GuardRule(
        "managed_claude_block",
        GUARDED_TOOLS,
        "text",
        re.compile(_MANAGED_BLOCK),
        "Managed CLAUDE.md block: the <!-- BEGIN ARCHON NATIVE --> ... <!-- END ARCHON "
        "NATIVE --> span belongs to `archon init`. Edit your own instructions outside it.",
        _MANAGED_CITATION,
        # Documentation that merely quotes the marker is not an edit to the block.
        requires="claude_md",
    ),
    GuardRule(
        "hook_injection",
        frozenset({"Bash"}),
        "command",
        HOOK_INJECTION,
        "Hook injection: making a .git/hooks entry executable installs code that runs on "
        "every future commit, outside any review. Put the logic in a tracked check instead.",
        "Security review of the overlay (docs/assets.md guard table); no run on record "
        "reproduces it, and the row is labelled rather than dressed up. `install -m` and "
        "`cp -p` were added after a release gate observed both put the bit there without "
        "a chmod, which is the spelling the row already claimed to cover.",
    ),
)


# --- Bounded readers over the delivered payload -----------------------------------


def _string(value: Any, limit: int = MAX_FIELD) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _command(tool_input: Mapping[str, Any]) -> str:
    return _string(tool_input.get("command"), MAX_SUBJECT)


def _targets(tool_input: Mapping[str, Any]) -> str:
    paths = [_string(tool_input.get(key), MAX_FIELD * 4) for key in ("file_path", "notebook_path", "path")]
    return "\n".join(path for path in paths if path)[:MAX_SUBJECT]


def _segments(command: str) -> list[str]:
    return [segment for segment in SEGMENT.split(command)[:MAX_SEGMENTS] if segment.strip()]


def _text(tool_input: Mapping[str, Any]) -> str:
    values = [_string(value, MAX_SUBJECT) for value in tool_input.values()]
    return "\n".join(value for value in values if value)[:MAX_SUBJECT]


def _test_paths(status: Mapping[str, Any]) -> tuple[str, ...]:
    """Declared test paths from the accepted plan, plus conventional directories."""
    paths = set(DEFAULT_TEST_PATHS)
    tasks = status.get("tasks")
    for task in tasks[:MAX_INSPECTED_PATHS] if isinstance(tasks, list) else ():
        spec = task.get("spec") if isinstance(task, Mapping) else None
        declared = spec.get("allowed_paths") if isinstance(spec, Mapping) else None
        for path in declared[:MAX_INSPECTED_PATHS] if isinstance(declared, list) else ():
            text = _string(path, MAX_FIELD).strip()
            segments = [segment.lower() for segment in text.split("/") if segment]
            # Declared paths cover repositories whose suites do not live in tests/.
            if text and any("test" in segment or "spec" in segment for segment in segments):
                paths.add(text)
    return tuple(sorted(paths))


def _is_test_path(text: str, status: Mapping[str, Any]) -> bool:
    return bool(TEST_FILENAME.search(text)) or any(path in text for path in _test_paths(status))


def _new_content(tool_input: Mapping[str, Any]) -> str:
    """Everything the call would leave in the file it names."""
    return "".join(_string(tool_input.get(key), MAX_SUBJECT) for key in CONTENT_FIELDS)


def _commit_bypass(subject: str) -> bool:
    """`git commit -n` is `--no-verify`; a message that merely mentions `-n` is not."""
    if EXPLICIT_BYPASS.search(subject):
        return True
    bare = QUOTED.sub(" ", subject)
    return bool(GIT_COMMIT.search(bare) and SHORT_NO_VERIFY.search(bare))


def _deletes_a_test(subject: str, status: Mapping[str, Any]) -> bool:
    """A deletion verb condemns the clause; a redirection condemns only its target."""
    if DELETION_COMMAND.search(subject) and _is_test_path(subject, status):
        return True
    targets = REDIRECT_TARGET.findall(subject)[:MAX_INSPECTED_PATHS]
    return any(_is_test_path(target, status) for target in targets)


def _condition(rule: GuardRule, subject: str, target: str, status: Mapping[str, Any],
               tool_input: Mapping[str, Any]) -> bool:
    if rule.requires == "verification_running":
        jobs = status.get("jobs")
        return isinstance(jobs, list) and any(
            isinstance(job, Mapping) and job.get("state") == "running" for job in jobs
        )
    if rule.requires == "commit_hook_bypass":
        return _commit_bypass(subject)
    if rule.requires == "test_target":
        return _deletes_a_test(subject, status)
    if rule.requires == "emptied_test_file":
        # Writing a test is the work; writing nothing over one is the deletion. A
        # payload carrying no body field at all is a shape this guard does not
        # understand, and an unrecognised shape is never denied.
        if not any(key in tool_input for key in CONTENT_FIELDS):
            return False
        return _is_test_path(subject, status) and not _new_content(tool_input).strip()
    if rule.requires == "mutating_command":
        return bool(MUTATING_COMMAND.search(subject))
    if rule.requires == "claude_md":
        # Scoped to the edited file, so prose quoting the marker stays writable.
        return bool(CLAUDE_MD.search(target))
    return True


def _guard(status: Mapping[str, Any], payload: Mapping[str, Any]) -> GuardRule | None:
    """Return the first matching deny rule, or None. Never raises on odd input."""
    tool = _string(payload.get("tool_name"))
    tool_input = payload.get("tool_input")
    if tool not in GUARDED_TOOLS or not isinstance(tool_input, Mapping):
        return None
    command = _command(tool_input) if tool == "Bash" else ""
    target = command or _targets(tool_input)
    fields = {"target": [target], "text": [_text(tool_input)]}
    for rule in GUARD_RULES:
        if tool not in rule.tools:
            continue
        # A Bash pattern and its condition must hold within one clause of the command.
        for subject in _segments(command) if rule.field == "command" else fields[rule.field]:
            if subject and rule.pattern.search(subject) and _condition(
                rule, subject, target, status, tool_input
            ):
                return rule
    return None


# --- Emitted shapes ----------------------------------------------------------------


def _context(event: str, text: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text[:MAX_CONTEXT]}}


def _deny(rule: GuardRule) -> dict[str, Any]:
    # The command itself is never echoed back: it may carry repository secrets.
    reason = (
        f"Archon guard `{rule.rule_id}` denied this call. {rule.reason} "
        "This guard is advisory and catches obvious shapes only; the security review still "
        "scans the diff. If the run genuinely needs this, record it as a blocker instead."
    )
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason[:MAX_REASON],
        }
    }


def _summary(status: Mapping[str, Any]) -> str:
    run = status.get("run") or {}
    checkpoint = run.get("checkpoint") or {}
    data = {
        "run_id": run.get("run_id"),
        "state": run.get("state"),
        "checkpoint": checkpoint.get("context"),
        "next_action": status.get("next_action"),
    }
    # Recorded decisions are data to restore, not authority the hook invents.
    body = json.dumps(data, ensure_ascii=True, default=str)
    return SUMMARY_HEADER + body[: MAX_CONTEXT - len(SUMMARY_HEADER)]


def _observed(payload: Mapping[str, Any]) -> dict[str, str]:
    observed = {key: _string(payload.get(key)) for key in OBSERVED_FIELDS}
    return {key: value for key, value in observed.items() if value}


def _observation(service: Any, run_id: str, event: str, payload: Mapping[str, Any],
                 extra: Mapping[str, str] | None = None) -> None:
    store = getattr(service, "store", None)
    if store is None:
        return
    data = {**_observed(payload), **(extra or {})}
    digest = hashlib.sha256(json.dumps([run_id, event, data], sort_keys=True).encode()).hexdigest()
    store.append_event(run_id, "native_hook", {"event": event, **data}, event_key="hook:" + digest)


def _checkpoint(service: Any, run: Mapping[str, Any], event: str, payload: Mapping[str, Any]) -> None:
    context = dict((run.get("checkpoint") or {}).get("context") or {})
    # Retain the manager's decisions verbatim; observing a lifecycle edge infers none.
    context["native_lifecycle"] = {"event": event, **_observed(payload)}
    service.checkpoint(run["run_id"], context)


def _continuation(service: Any, status: Mapping[str, Any], payload: Mapping[str, Any]) -> bool:
    """Lock a tiny private per-session counter, bounding retries even across restart."""
    workspace = getattr(service, "workspace", None)
    if workspace is None:
        return False
    session = payload.get("session_id")
    if not isinstance(session, str) or not session or len(session) > MAX_FIELD:
        return False
    directory = Path(workspace.state_dir) / "native-hooks"
    if any(parent.is_symlink() for parent in [*directory.parents, directory]):
        raise ValueError("Private hook state refuses symlinked parents")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = hashlib.sha256((str(workspace.worktree_id) + ":" + session).encode()).hexdigest()
    path = directory / f"{key}.json"
    # On supported local Unix hosts flock serializes concurrent duplicate hooks.
    import fcntl

    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "r+", encoding="utf-8") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        raw = stream.read(MAX_STATE_BYTES + 1)
        try:
            state = json.loads(raw) if raw else {}
            if not isinstance(state, dict) or len(raw) > MAX_STATE_BYTES:
                state = {}
        except ValueError:
            state = {}
        run = status["run"]
        if state.get("run_id") != run["run_id"]:
            state = {"run_id": run["run_id"], "count": 0, "same": 0}
        action = status.get("next_action") or {}
        # Checkpoint timestamps and hook events are not evidence of progress.
        progress = {
            "state": run.get("state"),
            "tasks": [{k: item.get(k) for k in ("task_id", "state")} for item in status.get("tasks", [])],
            "jobs": [{k: item.get(k) for k in ("job_id", "state", "attempt")} for item in status.get("jobs", [])],
        }
        fingerprint = hashlib.sha256(json.dumps(progress, sort_keys=True, default=str).encode()).hexdigest()
        unchanged = state.get("fingerprint") == fingerprint
        same = state.get("same", 0) + 1 if unchanged else 1
        count = state.get("count", 0) if unchanged else 0
        limit = MAX_STOP_CONTINUATIONS if action.get("action") == "wait" else MAX_SAME_ACTION
        if count >= limit or same > limit:
            return False
        state.update({"count": count + 1, "same": same, "fingerprint": fingerprint})
        stream.seek(0)
        stream.write(json.dumps(state))
        stream.truncate()
        stream.flush()
        os.fsync(stream.fileno())
        return True


def _stop(service: Any, status: Mapping[str, Any], run: Mapping[str, Any],
          payload: Mapping[str, Any]) -> dict[str, Any]:
    # Claude Code caps consecutive Stop blocks at eight and then re-enters with
    # stop_hook_active; the contract is to yield immediately on that signal (S7).
    if payload.get("stop_hook_active") is True:
        return {}
    if run.get("state") in QUIET_RUN_STATES or payload.get("permission_mode") == "plan":
        return {}
    action = status.get("next_action") or {}
    if action.get("action") not in ACTIONABLE:
        return {}
    if not _continuation(service, status, payload):
        return {}
    waiting = action.get("action") == "wait"
    reason = (
        "Continue the accepted Archon task using the MCP status and next action. "
        + (
            "Verification jobs are still active. Use the MCP wait tool for the recorded job "
            "IDs, observe their completion, and continue verification or repair without "
            "asking the user to wake you. "
            if waiting
            else ""
        )
        + "Handle routine implementation, verification dispatch, repair, and checkpointing "
        "automatically. Respect current user steering, cancellation, and the host's actual "
        "permission boundaries. Do not claim verified completion without the kernel gate. "
        "Recorded next action: " + json.dumps(action, ensure_ascii=True, default=str)
    )
    return {"decision": "block", "reason": reason[:MAX_CONTEXT]}


def handle_event(payload: Mapping[str, Any], *, repo: Path | str | None = None,
                 state_home: Path | str | None = None, service: Any = None) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        return {}
    event = payload.get("hook_event_name")
    if not isinstance(event, str) or event not in EVENTS or os.environ.get(REVIEW_ENV) == "1":
        return {}
    owned_store = None
    try:
        if service is None:
            from .service import ArchonService
            from .store import Store
            from .workspace import Workspace

            cwd = repo if repo is not None else payload.get("cwd")
            if not isinstance(cwd, (str, Path)):
                return {}
            workspace = Workspace(Path(cwd), state_root=state_home)
            # Never create operational state in a repository that has no run.
            if not (workspace.state_dir / "state.sqlite3").exists():
                return {}
            owned_store = Store(workspace.state_dir)
            if not owned_store.list_runs(workspace.worktree_id):
                return {}
            service = ArchonService(workspace, owned_store)
        status = service.status()
        run = status.get("run")
        if not isinstance(run, dict) or not run.get("run_id"):
            return {}
        if event == "PreToolUse":
            rule = _guard(status, payload)
            if rule is None:
                return {}
            _observation(service, run["run_id"], event, payload,
                         {"rule": rule.rule_id, "tool": _string(payload.get("tool_name"))})
            return _deny(rule)
        _observation(service, run["run_id"], event, payload)
        if event in CHECKPOINT_EVENTS:
            _checkpoint(service, run, event, payload)
        if event == "SubagentStart":
            return _context(event, SUBAGENT_SCOPE + _summary(status))
        if event == "SessionStart":
            # PreCompact cannot inject; source "compact" is the channel that lands.
            return _context(event, _summary(status))
        if event != "Stop":
            return {}
        return _stop(service, status, run, payload)
    except Exception:
        # Hooks fail open. An unavailable hook never creates passing evidence,
        # never denies a tool call, and never wedges the session.
        return {"systemMessage": FAIL_OPEN_MESSAGE}
    finally:
        if owned_store is not None and hasattr(owned_store, "close"):
            owned_store.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Archon native Claude Code lifecycle hook")
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--state-home", type=Path)
    args = parser.parse_args(argv)
    result: dict[str, Any] = {}
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        payload = json.loads(raw) if 0 < len(raw) <= MAX_INPUT else None
        if isinstance(payload, dict):
            result = handle_event(payload, repo=args.repo, state_home=args.state_home)
    except (ValueError, UnicodeError, OSError):
        result = {}
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
