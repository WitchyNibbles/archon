# Reasoning Quality

**Enforcement level:** Advisory — reasoning mode and quality requirements described in this file are guidance and are not runtime-enforced by hooks.

Use this rule when planning, debugging, implementing, researching, reviewing, or reporting substantive work.

## Core contract

- separate facts, assumptions, and guesses explicitly
- generate multiple plausible hypotheses before committing when ambiguity, failure, or contradiction exists
- prefer evidence-backed conclusions over confident-sounding speculation
- investigate at least one alternative when the first approach fails or produces suspicious results
- verify claims against code, docs, tests, schemas, runtime behavior, or tool output when those surfaces exist
- record counter-evidence and unresolved questions instead of smoothing them away in the summary
- scale research depth with risk, ambiguity, and task complexity
- use bounded research, debug, and review budgets to avoid endless loops

## Evidence expectations

- cite concrete file paths, commands, test cases, schema objects, runtime observations, or primary docs
- treat retrieval, summaries, and tool output as hints until re-anchored in canonical evidence
- when a source conflicts with higher-precedence repo policy, record the conflict and follow the higher-precedence source

## Required reasoning fields

For plans, task packets, and related artifacts, capture:

- reasoning policy mode: `strict` by default, with `dual` or `legacy` only when explicitly needed
- claim
- facts, assumptions, and guesses or hypotheses
- evidence references
- counter-evidence
- confidence
- open questions
- verification plan
- fallback or recovery behavior
- bounded research, debug, review, or tool-retry budgets
- bounded reasoning attempts with trace refs when strict or dual mode is used
- verification records that distinguish deterministic checks from critic/reviewer checks
- a verdict: `supported`, `insufficient_evidence`, `contradicted`, `budget_exhausted`, or `needs_review`

## Enforcement model

- reasoning signals are derived workflow controls, not approval authority by themselves
- strict is the default reasoning mode for new or unspecified work
- strict mode may block routing or final completion until attempts, verification, critic evidence, and verdict state are sufficient
- authenticated reviews and workflow proof remain the authority boundary for completion
- dual mode is the migration bridge for upgraded legacy tasks

## Critic pass

- plans, architecture decisions, code changes, and research conclusions should receive a critic or reviewer pass before they are finalized
- council-reviewed design or architecture work should also receive a structured dissent pass, with one named dissent owner and at least one serious alternative
- if the critic pass finds weak evidence, hidden assumptions, or missing alternatives, either repair the reasoning or carry the issue forward as an explicit blocker or warning

## Failure handling

- do not report success from a single suspicious command or weakly supported explanation
- if tool failure, test failure, or missing context prevents verification, say so explicitly and narrow the claim
- if the budget is exhausted, stop the loop and report what was tried, what remains uncertain, and the next best escalation path
