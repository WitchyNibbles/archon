---
name: archon-qa-verification
description: QA gate and verification matrices. Use when a task needs a verification plan or the qa_engineer gate must be satisfied — encodes the no-buts severity bar, runtime-recorded gate requirements, the qa-findings artifact convention, and the workflow-proof completion check.
---

# Archon QA Verification

Use when a task needs a verification plan or a blocking QA gate.

Goal: make completion claims falsifiable — and record the gate where the runtime will
actually honor it.

## Where the gate is recorded

Same authority model as `archon-review` (`review_authority=runtime_orchestrated_only`,
`review_artifact_trust=runtime_records_only`; policy in
`.archon/rules/review-gate-policy.md`):

- **Runtime connected (normal):** the `qa_engineer` gate is satisfied only by an
  orchestrator-written DB record — spawn `review-orchestrator`, which runs the QA review
  and records it with verified identity. Standalone QA agent output and self-written
  markdown do NOT satisfy the gate; the task stays open and the Stop hook blocks close.
- **Offline (no runtime configured):** markdown export
  `.archon/work/reviews/review-<task-id>-qa_engineer.md` per
  `.archon/templates/review-gate.md`, validated by the workflow checker.

## Verification pass

1. Restate the acceptance criteria from the task packet (`.archon/work/tasks/task-<task-id>.md`).
2. Build a lean matrix covering happy, edge, failure, and regression paths — every
   criterion maps to at least one exact, replayable command; both directions for
   guard-type changes (the bypass shape is blocked AND the legitimate shape passes).
3. If retrieval or memory changed, add provenance, freshness, and authority checks
   (contradiction handling; redaction or exposure boundaries).
4. Run the commands or require their captured output — a matrix without executed
   evidence is a plan, not a gate.
5. Call out missing acceptance criteria instead of inventing them.
6. Classify gaps and defects CRITICAL / HIGH / MEDIUM / LOW.

## The no-buts bar

A QA review records `passed` only when every finding at every severity is resolved or
carries an explicit recorded justification (owner + reason). Open findings — including
MEDIUM and LOW — keep the gate `blocked`. "Looks good" without executed verification
evidence is never a pass. Tasks with `playwright_required = true` must cite Playwright
evidence (desktop/mobile coverage, artifact paths) in the gate record.

## Artifact conventions

- Structured findings: `.archon/work/qa-findings-<task-id>.json` (repair rounds append
  `-r2`, `-r3`, …). Give each finding an id, severity, repro, and expected/actual.
- Gate summary export (evidence layer): `.archon/work/reviews/review-<task-id>-qa_engineer.md`
  per `.archon/templates/review-gate.md`. Role ids are snake_case in filenames and DB.

## Completion check

The canonical workflow check (CLAUDE.md `workflow_check`):

```
npx tsx ./src/admin.ts workflow-proof --run-id latest --task-id <task-id>
```

(`bash scripts/check-archon-workflow-live.sh [--task-id <task-id>]` is the documented
local-live alias.)

## Rules

- do not approve vague "looks good" work
- do not skip setup/install verification when packaging or bootstrapping changed
- never trust a worker's "pre-existing failure" claim — reproduce on master and isolate
  the environment before accepting it
- keep the verification set lean but real

## Output

Return the verification matrix, the exact commands with their observed results, any
blocking gap ordered by severity, and the recording status of the gate (where the
record was written, and the workflow-proof result).
