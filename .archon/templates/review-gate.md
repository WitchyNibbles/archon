# Review Gate Template

## Task ID

`<task-id>`

## Reviewer role

`reviewer | qa_engineer | security_reviewer`

## Actor

`<recorded-actor-id>`

## Actor role

`reviewer | qa_engineer | security_reviewer | planner | solution_architect`

## Provenance status

`summary_only | runtime_verified | legacy_backfill`

This markdown file is a manager-written summary. `runtime_verified` means the handoff cites a trusted runtime or authenticated source elsewhere. `summary_only` and `legacy_backfill` are documentation states, not gate proof by themselves.

## Review state

`pending | passed | blocked | waived`

This template records summary state only. The workflow checker validates state, decision, and waiver-field consistency, but trusted reviewer authority and final blocking decisions still come from runtime evidence plus manager/reviewer policy. `pending` and `blocked` remain blocking states for completion.

## Severity

`low | medium | high | critical`

## Specialist execution evidence

List the evidence used to trust the claimed specialist ownership for this task.

## Quality gate evidence

List the evidence used to trust the declared quality gates for this task.

When `council_review_required` applies, cite the DAC decision packet, recorded outcome, dissent owner, and any approval conditions or exception expiry carried into implementation.

## Reasoning quality findings

Call out weak assumptions, missing alternatives, contradictory evidence, low confidence, or exhausted budgets here.

## Findings

## Residual risk

## Verification evidence

List exact commands, fixtures, or repro steps used for this gate.

When `Provenance status` is `runtime_verified` for `specialist_verified` work, include at least one `Runtime proof:` line here that names the authenticated runtime artifact or check summarized by this markdown.

For `qa_engineer` reviews on tasks with `playwright_required = true`, cite Playwright evidence refs here, including the desktop/mobile coverage and any browser artifact paths or runtime evidence refs used to support approval.

## Waiver authority

`none | manager | security_exception`

Use `none` for `pending`, `passed`, and `blocked` reviews. Use `manager` for waived `reviewer` or `qa_engineer` gates recorded by `planner` or `solution_architect`. Use `security_exception` for waived `security_reviewer` gates recorded by `security_reviewer`.

## Waiver reason

Do not waive a required gate without actor, actor role, authority, and explicit reason. Unauthorized waivers remain blocking.

## Decision

`approved | blocked | waived`

## Source handoff

Manager-written summary of reviewer output. Cite the trusted source here when `Provenance status` is `runtime_verified`, because the markdown file alone is not proof.

For `specialist_verified` work with `runtime_verified` provenance, include a `Runtime proof:` line here that points to the same authenticated runtime artifact summarized above.
