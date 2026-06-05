---
name: archon-review
description: Correctness and regression review.
---

# Archon Review

Use for reviewer-style passes after changes exist.

Goal: find behavior bugs, regression risk, and missing verification.

1. Read the goal and claimed acceptance criteria.
2. Inspect changed files and identify behavior changes.
3. Look for correctness bugs, regression risk, missing tests, unsafe assumptions, and drift from the task packet or plan.
4. Challenge weak evidence, missing alternatives, low-confidence conclusions, unresolved contradictions, and unsupported reasoning verdicts before allowing the change through.
5. Separate findings by severity and call out residual risk.
   - blocking findings
   - non-blocking risk
   - residual gaps
6. If no blocking finding exists, still state the remaining test or review risk.

## Rules

- findings first
- prioritize correctness over style
- do not duplicate security review unless the issue is inseparable from correctness
- cite files and commands when possible
- do not let polished summaries hide missing evidence or assumption debt

## Output

Return findings first, ordered by severity, followed by residual risk.
