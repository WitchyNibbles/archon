---
name: archon-intake
description: First-pass intake, risk triage, and staffing.
---

# Archon Intake

Use for substantive requests by default.

Goal: turn the ask into a clarified brief, risk triage, architecture handoff, planner handoff, and stop/go.

1. Normalize goal, audience, constraints, risks, unknowns, success criteria, and stop/go.
2. Ask 1-4 concise clarifying questions before planning when the request is ambiguous, outcome-sensitive, or has multiple plausible interpretations.
3. Bias those questions toward intended outcome, primary user/operator, constraints or non-goals, and the concrete done criteria.
4. If clarification is not required, state the operating assumptions explicitly in the brief before continuing.
5. Record the first-pass facts, competing hypotheses, evidence gaps, confidence, and a bounded investigation budget in the brief.
6. Keep manager/root shallow; do not do deep investigation or implementation design directly.
7. Use no more than two shallow inspections before trivial classification or bounded investigation.
8. Create or update `.archon/ACTIVE` and the matching intake brief — initialize the brief from `.archon/templates/intake-brief.md` (write it as `.archon/work/brief-<task-id>.md`).
9. Route ambiguous or user-flow-heavy work through `product-strategist`.
10. Run bounded evidence gathering when ownership, call flow, or behavior is unclear.
11. Treat refactors as behavior-preserving improvement work: surface touched-scope risks and route them into planning instead of hiding behind "refactor only".
12. Hand evidence to `solution-architect`, then hand architecture to `planner`.
13. Preserve the trivial fast path for low-risk mechanical work.
14. Stop before implementation if the user asked for planning only.

Manager checklist:

- confirm request, success criteria, constraints, completion bar, and main risk
- capture clarifying questions and answers or explicit assumptions
- do not proceed past intake while direction-setting questions are still unanswered unless the user explicitly accepts assumptions
- confirm whether the user expects end-to-end completion or planning only
- distinguish known facts from inferred assumptions before handoff
- do not exceed two shallow inspections before delegation
- require current task id and matching brief before worker execution

Default chain (Agent-tool `subagent_type` names — kebab-case, matching `.claude/agents/`;
the runtime's gate role ids like `qa_engineer` stay snake_case in DB records and review
filenames):

- `product-strategist`
- `solution-architect`
- `security-reviewer`
- `qa-engineer`
- `planner`

Use caveman format for specialist handoffs.
