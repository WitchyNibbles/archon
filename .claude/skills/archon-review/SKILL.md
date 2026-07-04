---
name: archon-review
description: Correctness and regression review gate. Use when changes exist and the reviewer gate must be satisfied — encodes the no-buts severity bar, where review records must be written (runtime DB via review-orchestrator when connected), the review artifact format, and the workflow-proof completion check.
---

# Archon Review

Use for reviewer-style passes after changes exist.

Goal: find behavior bugs, regression risk, and missing verification — and record the
gate where the runtime will actually honor it.

## Where the gate is recorded (read this first)

`CLAUDE.md` sets `review_authority=runtime_orchestrated_only` and
`review_artifact_trust=runtime_records_only`. Governing policy:
`.archon/rules/review-gate-policy.md` and `.archon/rules/review-identity-policy.md`.

| Runtime state | Trusted record | What satisfies the gate | What does NOT |
|---|---|---|---|
| Connected (normal) | Orchestrator-written DB review rows | Spawn `review-orchestrator`; it runs the role reviews and writes records via `record-review`/`save-review` with verified identity | Standalone review agents' text output; self-written markdown in `.archon/work/reviews/` (the Stop hook rejects markdown when the runtime is connected) |
| Offline (no runtime configured) | Markdown review exports | `review-<task>-<role>.md` files under `.archon/work/reviews/` following `.archon/templates/review-gate.md`, validated by the workflow checker | Files missing task id, role, or state; unauthorized waivers |

**Known failure mode:** running standalone review agents against a live runtime produces
review text but no DB record — the task stays open, the Stop hook blocks session close,
and control-layer writes stay locked. If a runtime is connected, always record through
`review-orchestrator`.

## Review pass

1. Read the goal, the task packet (`.archon/work/tasks/task-<task-id>.md`), and claimed acceptance criteria.
2. Inspect changed files and identify behavior changes.
3. Look for correctness bugs, regression risk, missing tests, unsafe assumptions, and drift from the task packet or plan.
4. Judge solution quality, not just correctness: a low-cost shortcut where a better long-term solution fit the user's goal is a **blocking** finding (review-gate-policy).
5. Challenge weak evidence, missing alternatives, low-confidence conclusions, unresolved contradictions, and unsupported reasoning verdicts before allowing the change through.
6. Classify every finding CRITICAL / HIGH / MEDIUM / LOW.

## The no-buts bar (when `passed` may be recorded)

Per `.archon/rules/review-gate-policy.md`:

- a review records `passed` ONLY when every finding it raised — at ANY severity,
  including MEDIUM and LOW — is resolved OR carries an explicit recorded justification
  (owner + reason). Open findings keep the review `blocked`.
- "noted as advisory" is not a justification; there is no silent carry-over.
- "no blocking findings" is necessary but not sufficient: affirmatively state the work
  is finished to the no-buts bar before passing.
- waivers require actor, actor role, waiver authority, and reason, with
  orchestrator-recorded provenance; unauthorized waivers block.

## Artifact format (evidence layer)

Markdown exports remain evidence even when the DB is authoritative. Location and naming:
`.archon/work/reviews/review-<task-id>-<role>.md` where `<role>` is the runtime role id
(`reviewer`, `qa_engineer`, `security_reviewer` — snake_case in filenames and DB).
Structure follows `.archon/templates/review-gate.md` (task id, reviewer role, actor,
provenance status, review state, severity, findings, verification evidence, waiver
fields, decision).

## Completion check

Before claiming the gate is satisfied, run the canonical workflow check from CLAUDE.md:

```
npx tsx ./src/admin.ts workflow-proof --run-id latest --task-id <task-id>
```

(`bash scripts/check-archon-workflow-live.sh [--task-id <task-id>]` is the documented
local-live alias.) The proof failing with "missing required review" means the DB has no
orchestrator record for that role — record it properly; do not fall back to markdown on
a connected runtime.

## Rules

- findings first, ordered by severity
- prioritize correctness over style
- do not duplicate security review unless the issue is inseparable from correctness
- cite files and commands; keep evidence concrete
- do not let polished summaries hide missing evidence or assumption debt

## Output

Return findings first, ordered by severity, then residual risk, then the recording
status of the gate (where the record was written, and the workflow-proof result).
