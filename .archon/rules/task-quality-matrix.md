# Task Quality Matrix

Use task-type quality gates in addition to the generic review trio.

## Global rules

- all substantive work still requires `reviewer`, `security_reviewer`, and `qa_engineer`
- `specialist_verified` tasks must name at least one required specialist role
- the task packet must list the relevant quality gates explicitly
- handoffs and review gates must cite evidence for the claimed specialist execution and quality checks
- refactors and rewrites must preserve intended behavior and include regression evidence for relevant good-path and bad-path cases
- discovered `CRITICAL` or `HIGH` defects in touched scope must be fixed or carried as explicit blockers before completion

## Gate guidance

### `product_acceptance`

- use for ambiguous, customer-facing, or flow-heavy work
- requires user/problem/value framing and measurable success criteria

### `council_review_required`

- use for substantive roadmap, governance, architecture-significant, or user-flow-heavy work that needs cross-functional critique before implementation
- requires a council decision packet, rotating council membership, a named dissent owner, and a recorded outcome
- should not be applied to trivial work, tightly local bug fixes, or implementation tasks already covered by an approved parent council decision

### `frontend_acceptance`

- use for UI or human-facing artifact work
- requires clarity, consistency, and intentional visual or interaction choices

### `accessibility_acceptance`

- use when visual or interactive output exists
- requires keyboard, semantic, and readability checks appropriate to the surface

### `responsive_acceptance`

- use when the surface must work across viewport sizes or layout contexts

### `tdd_required`

- use for new behavior or bug fixes where a meaningful failing test can exist

### `e2e_required`

- use for critical user, setup, install, or upgrade flows

### `regression_safety_required`

- use for refactors, rewrites, migrations, and behavior-preserving hardening work
- requires explicit invariants, regression checks, and negative-case coverage for the touched flow

### `release_readiness_required`

- use for package, installer, migration, setup, or rollout-sensitive work
- requires explicit release-readiness evidence in handoffs or review summaries
- is a mandatory quality gate for release-sensitive work, not an additional review role

### `performance_check_required`

- use when retrieval, indexing, large data, or latency-sensitive behavior changes

### `setup_replay_required`

- use when setup, bootstrap, migrations, or environment-sensitive flows change

### `coverage_ledger_required`

- use when completion depends on measurable subsystem or analysis coverage, not only task status
- requires a coverage manifest plus touched-scope ledger evidence

### `progress_proof_required`

- use when the task must prove stateful forward progress across loop cycles
- requires at least one recorded progress proof with coverage or gap deltas

### `checkpoint_resume_required`

- use when the task must survive interruption without losing execution authority
- requires at least one checkpoint with resume-ready next actions

### `memory_compaction_required`

- use when long-running work needs compressed context linked back to authoritative state
- requires the latest checkpoint to cite a compressed context reference

### `reasoning_dual_required`

- use when a task is being upgraded from legacy reasoning semantics into the new structured model
- dual is an explicit compatibility mode, not the default
- requires explicit reasoning policy, attempt records, verification records, and a verdict, but does not yet hard-block completion on every reasoning deficiency

### `reasoning_strict_required`

- strict is the default mode for new substantive reasoning work
- use when the task should hard-block routing or final completion on missing reasoning attempts, trace refs, verification records, critic verification, or unsupported verdicts
- requires explicit reasoning policy, attempt records, verification records, and a verdict
