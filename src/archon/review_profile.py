"""The reviewer's engine-side profile: tool catalog, permissions, and schema.

Split out of :mod:`archon.claude_adapter`, which was over the 800-line limit, so
the three lists a reviewer session is confined by are one small readable unit.
Nothing here starts a process; it renders the JSON the engine is handed and the
JSON schema the structured review must satisfy.

The deny lists are **derived, never restated**.  ``REVIEW_DENY_READ`` carried its
own copy of three home directories while :data:`archon.sandbox.DEFAULT_MASKED`
masked six, and the two drifted: ``~/.claude/.credentials.json`` sat outside the
reviewer's deny list while the same reviewer held ``Bash(cat *)`` and
``Bash(python3 -c *)``, and the engine's ``denyRead`` is the only read barrier a
shell-issued read meets on Linux (live probe P5).  A reviewer could read the
account's OAuth token into its own context, from where it reaches the review
prose, the ``ReviewPayload`` and the evidence shown to the manager (SEC-C1).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from . import sandbox
from .models import ReviewPayload

#: The reviewer catalog asked for with ``--tools`` and asserted on ``system/init``.
REVIEW_TOOLS: tuple[str, ...] = ("Read", "Grep", "Glob", "Bash")
#: The engine auto-injects this tool whenever ``--json-schema`` is passed, even
#: under an explicit ``--tools`` allowlist (measured at 2.1.278).  It is the only
#: catalog member the kernel did not name, and it is required: without it the
#: session cannot produce a structured review at all.
STRUCTURED_OUTPUT_TOOL = "StructuredOutput"
REQUIRED_PERMISSION_MODE = "dontAsk"
#: Set both in the generated settings and in the reviewer process environment, so
#: a repository hook that somehow fires can tell it is inside a managed review.
MANAGED_REVIEW_ENV = "ARCHON_MANAGED_REVIEW"

REVIEW_ALLOW: tuple[str, ...] = (
    "Read", "Grep", "Glob",
    "Bash(cat *)", "Bash(ls *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)",
    "Bash(grep *)", "Bash(rg *)", "Bash(find *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
    "Bash(sed -n *)", "Bash(python3 -c *)", "Bash(python -c *)", "Bash(node -e *)",
)  # fmt: skip
#: ``Agent`` is the permission-rule name; ``Task`` is the live literal catalog name
#: of the subagent tool in a headless session at 2.1.278.  Both are denied, though
#: the explicit ``--tools`` allowlist is what structurally excludes them.
REVIEW_DENY: tuple[str, ...] = (
    "Write", "Edit", "NotebookEdit", "Agent", "Task", "WebFetch", "WebSearch", "Skill",
    "EnterWorktree", "ExitWorktree", "Monitor", "SendMessage", "CronCreate", "RemoteTrigger",
    "Bash(git commit *)", "Bash(git push *)", "Bash(git checkout *)", "Bash(git reset *)",
    "Bash(rm *)", "Bash(mv *)", "Bash(cp *)", "Bash(curl *)", "Bash(wget *)", "Bash(ssh *)",
    "Bash(sudo *)", "Bash(tee *)", "Bash(> *)",
)  # fmt: skip

#: Engine credential state that ``DEFAULT_MASKED`` does not reach.  ``~/.claude.json``
#: is the OAuth account record and is a *sibling* of ``~/.claude``, not a member of
#: it, so masking the directory never covered it (SEC-C1).  ``~/.claude`` itself is
#: named here as well as inherited: the reviewer's protection against reading the
#: credential it was launched with may not depend on another module's list.
CREDENTIAL_DENY_READ: tuple[Path, ...] = (
    Path("~/.claude"),
    Path("~/.claude.json"),
    Path("~/.claude.json.backup"),
)

#: ``store.Store`` opens ``<state_dir>/state.sqlite3`` in WAL mode; the sidecars
#: carry committed rows that have not been checkpointed back into the main file,
#: so denying only the database would still leave recent review payloads readable.
#: ``tests/test_claude_adapter.py`` asserts this name against a real ``Store``.
DATABASE_NAME = "state.sqlite3"
DATABASE_SIDECARS: tuple[str, ...] = ("-wal", "-shm")

#: The floor of the reviewer's ``denyRead``: everything the kernel's own check
#: profile masks, plus the engine credential paths that profile does not reach.
#: A test asserts ``set(sandbox.DEFAULT_MASKED) <= set(REVIEW_DENY_READ)``, because
#: the drift between the two lists is the defect, not the length of either.
REVIEW_DENY_READ: tuple[str, ...] = (
    *(str(path) for path in sandbox.DEFAULT_MASKED),
    *(str(path) for path in CREDENTIAL_DENY_READ),
)

SCHEMA_UNSUPPORTED_KEYWORDS: frozenset[str] = frozenset(
    {
        "title", "description", "default", "minLength", "maxLength", "pattern", "format",
        "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
        "minItems", "maxItems", "patternProperties",
    }
)  # fmt: skip


def _ordered(entries: Iterable[str]) -> list[str]:
    """Stable de-duplication: the rendered list is compared in tests and in review."""
    seen: list[str] = []
    for entry in entries:
        if entry not in seen:
            seen.append(entry)
    return seen


def database_paths(state_root: Path) -> tuple[str, ...]:
    """The kernel's evidence database and its WAL sidecars, as literal paths."""
    database = state_root / DATABASE_NAME
    return (str(database), *(f"{database}{suffix}" for suffix in DATABASE_SIDECARS))


def reviewer_deny_read(receipt_root: Path, state_root: Path) -> list[str]:
    """Every path a reviewer session may not read.

    Two additions beyond the inherited mask floor, both measured live:

    * the supervisor receipt root, which holds another invocation's control
      directory and its copied credential; and
    * the evidence database, which is the *sibling* of that receipt root.  Masking
      only ``supervisors/`` left ``state.sqlite3`` readable under the read-only
      root bind, so a repository-authored check could dump every recorded review
      payload and a ``security_reviewer`` launched third could read the other two
      reviewers' verdicts before writing its own (SEC-H2).  Writes were already
      impossible, so this is disclosure, not forgery — but it is exactly the
      three-independent-approvals property the gate rests on.

    ``snapshots/`` stays readable: it is the frozen candidate the reviewer reads.
    """
    return _ordered(
        [*REVIEW_DENY_READ, str(receipt_root), *database_paths(state_root)]
    )


def review_schema() -> dict[str, Any]:
    """The provider-facing subset of the local review schema.

    Keyword stripping keeps the schema inside the strict structured-output subset
    the engine will accept; ``ReviewPayload.model_validate`` keeps every dropped
    constraint and remains the only authority over a returned payload.
    """
    schema = ReviewPayload.model_json_schema()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for keyword in SCHEMA_UNSUPPORTED_KEYWORDS:
                node.pop(keyword, None)
            if node.get("type") == "object" and "properties" in node:
                node["required"] = list(node["properties"])
                node["additionalProperties"] = False
            for child in list(node.values()):
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(schema)
    return schema


def review_settings(
    snapshot: Path, scratch: Path, receipt_root: Path, state_root: Path
) -> dict[str, Any]:
    """Render the engine-side sandbox the reviewer session runs under.

    Bare-name denies remove a tool from the catalog, which is the layer that was
    measured to hold; path-scoped denies are defence in depth only.  The snapshot
    is already read-only on disk.
    """
    return {
        "permissions": {
            "defaultMode": REQUIRED_PERMISSION_MODE,
            "allow": list(REVIEW_ALLOW),
            "deny": list(REVIEW_DENY),
        },
        "sandbox": {
            "enabled": True,
            "failIfUnavailable": True,
            "autoAllowBashIfSandboxed": True,
            "allowUnsandboxedCommands": False,
            "filesystem": {
                "allowWrite": [str(scratch)],
                "denyWrite": [str(snapshot)],
                "denyRead": reviewer_deny_read(receipt_root, state_root),
            },
            "network": {"allowedDomains": [], "strictAllowlist": True, "allowLocalBinding": False},
        },
        "attribution": {"commit": "", "pr": "", "sessionUrl": False},
        "env": {MANAGED_REVIEW_ENV: "1"},
    }


def reviewer_tool_catalog(tools: Sequence[str] = REVIEW_TOOLS) -> set[str]:
    """The catalog a hermetic ``system/init`` must report back, as a set."""
    return set(tools) | {STRUCTURED_OUTPUT_TOOL}
