---
name: archon-e2e
description: Critical flow and install journey verification.
---

# Archon E2E

Use when unit or service tests are not enough to trust the workflow.

Goal: prove the important journey works in a realistic environment.

1. Identify the journey and trust boundaries.
2. Cover happy, edge, failure, and regression paths.
3. Prefer replayable commands and stable fixtures.
4. For setup or installer work, include bootstrap, upgrade, and rollback when feasible.
5. Record rerunnable evidence.

Do not approve a critical flow on unit tests alone.
- keep the matrix lean but include at least one failure-path check
- call out missing harness or environment blockers instead of pretending coverage exists
- if no executable E2E harness exists, define the exact gap and the minimum harness slice needed

## Output

Return the verification matrix, commands or repro steps, and any blocking gap.
