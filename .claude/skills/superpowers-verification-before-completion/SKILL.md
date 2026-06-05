---
name: superpowers-verification-before-completion
description: Repo-local wrapper for completion discipline. Use when review or approval work needs an explicit final verification pass before anything is called done.
---

# Superpowers Verification Before Completion

Use before approval, handoff, or completion claims.

Goal: block "probably done" from being mistaken for verified completion.

1. Re-state the claimed outcome.
2. Check the strongest available proof:
   - tests
   - runtime/workflow proof
   - browser evidence
   - artifact or export verification
3. Compare the proof against the acceptance criteria, not against a vague intuition.
4. If evidence is missing, stale, contradictory, or weaker than the claim, do not approve.
5. Record residual risk even when the slice passes.

## Anti-patterns

- approving because the diff looks reasonable
- substituting code review for runtime or browser proof
- ignoring stale or contradictory evidence
- treating missing verification as a minor note

## Output

Return:
- claim checked
- proof inspected
- blockers or gaps
- residual risk
