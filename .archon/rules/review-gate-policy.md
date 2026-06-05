# Review Gate Policy

- required task gates are `reviewer`, `security_reviewer`, and `qa_engineer`
- `council_review_required` is a quality gate, not a fourth review role; it governs pre-implementation decision quality and does not replace the required review trio
- `release_readiness_required` is a quality gate, not a fourth review gate; release-sensitive work must still surface explicit release-readiness evidence in handoffs or review summaries
- under `runtime_authenticated_only` review authority, a task may declare `review_exports=runtime_optional` and complete live verification before markdown review exports exist; if review exports are present they must still validate as evidence summaries
- a required gate satisfies completion only when its latest satisfying review has authenticated actor provenance
- a latest review state of `passed` satisfies completion only with authenticated provenance
- a `waived` gate satisfies completion only when the review stores actor, actor role, waiver authority, waiver reason, authenticated provenance, and the waiver is authorized by runtime policy
- `pending` and `blocked` remain blocking states
- handoffs must include changed files, verification notes, and context refs before review starts
- legacy-backfilled review rows are compatibility history and do not satisfy required gates
- unauthorized or actorless waivers block completion
