---
name: superpowers-finishing-development-branch
description: Repo-local wrapper for final branch hygiene before handoff or publish. Use when a task needs clean final diff review, commit summary discipline, or publish-prep checks.
---

# Superpowers Finishing Development Branch

Use when a branch is approaching handoff, publish, or merge preparation.

Goal: make the final branch easy to review and safe to hand off.

1. Confirm the branch contains only the intended task slices.
2. Review recent commits for mixed concerns or missing verification.
3. Check that commit messages are brief, conventional, and scoped to the actual slices.
4. Summarize verification evidence and remaining known risks.
5. Call out anything that must be fixed before push or PR creation.

## Anti-patterns

- hidden unrelated changes in the branch
- vague commit messages
- handoff with no test or verification summary
- pretending branch cleanup happened when it did not

## Output

Return:
- branch readiness
- cleanup needed
- verification summary
- publish blockers
