# Review Gate Policy

## Completion bar (what "passed" must mean)

The gate proves the work is genuinely finished, not merely that a review happened.

- a review records `passed` ONLY when every finding it raised is resolved, OR
  carries an explicit, recorded, defensible justification (owner + reason). An
  open finding at ANY severity — CRITICAL, HIGH, MEDIUM, or LOW — keeps the review
  `blocked`, never `passed`. There is no silent "non-blocking advisory" carry-over.
- a finding may only be left unresolved by recording WHY it is acceptable now
  (e.g. genuinely out of scope with a follow-up owner, or a deliberate trade-off
  the user's intent supports). "Noted as advisory" is not a justification.
- every review also judges SOLUTION QUALITY, not just correctness: does the change
  pursue the best durable solution for the user's actual goal, or a low-cost
  shortcut? A shortcut where a better long-term solution was available is a
  blocking finding, not a style nit.
- "no blocking findings" is necessary but not sufficient: the reviewer must
  affirmatively state the work is finished to the no-buts bar before it passes.

## Gate roles and provenance

- required task gates are `reviewer`, `security_reviewer`, and `qa_engineer`
- `council_review_required` is a quality gate, not a fourth review role; it governs pre-implementation decision quality and does not replace the required review trio
- `release_readiness_required` is a quality gate, not a fourth review gate; release-sensitive work must still surface explicit release-readiness evidence in handoffs or review summaries
- under `runtime_orchestrated_only` review authority, a task may declare `review_exports=runtime_optional` and complete live verification before markdown review exports exist; if review exports are present they must still validate as evidence summaries
- a required gate satisfies completion only when its latest satisfying review has orchestrator-recorded actor provenance
- a latest review state of `passed` satisfies completion only with orchestrator-recorded provenance
- a `waived` gate satisfies completion only when the review stores actor, actor role, waiver authority, waiver reason, orchestrator-recorded provenance, and the waiver is authorized by runtime policy
- `pending` and `blocked` remain blocking states
- handoffs must include changed files, verification notes, and context refs before review starts
- legacy-backfilled review rows are compatibility history and do not satisfy required gates
- unauthorized or actorless waivers block completion
