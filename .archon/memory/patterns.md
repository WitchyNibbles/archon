# Patterns

Approaches that worked repeatedly in this repo, and anti-patterns to avoid. Prefer
editing an existing pattern over adding a near-duplicate.

## Monolith split (module extraction)

```
role: backend-engineer
domain: runtime
scope: src/core/service.ts, src/runtime/daemon.ts
status: active
pattern: split a large module by extracting each command into a module function returning a typed result union (e.g. DaemonCommandResult | undefined — 3-way union if it can fall through, plain return if single-exit, factory if it needs a reusable closure dependency); inject heavy commands via deps for testability; break a value import cycle by moving the shared value and re-exporting it
decision: daemon.ts split 5702->1558 lines across PRs #39-#49; service.ts split in slices #155-159 — all merged green with the review trio
constraint: main-repo writes are blocked by stale active-task scope — run large refactor slices in a worktree agent
```

## Gate -> repair -> re-gate loop

```
role: qa-engineer
domain: testing
scope: archon-autopilot, archon-repair-loop
status: active
pattern: run the task verification commands exactly as written (good-path AND bad-path); on failure invoke /archon-repair-loop; repeat until verification passes, a real blocker exists, or the bounded repair budget is exhausted
constraint: never mark work done on a single passing command while other required unit/integration/e2e/negative/review evidence is still missing
```

## Runtime-recorded review gate

```
role: reviewer
domain: review
scope: review-orchestrator, .archon/hooks Stop gate
status: active
pattern: on a connected runtime, record reviewer/qa_engineer/security_reviewer gates via review-orchestrator so an orchestrator DB row exists
constraint: running standalone review agents against a live runtime produces review text but no DB record — the task stays open, the Stop hook blocks close, and control-layer writes stay locked (known failure mode)
```
