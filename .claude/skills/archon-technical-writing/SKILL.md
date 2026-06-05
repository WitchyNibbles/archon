---
name: archon-technical-writing
description: Operator-facing docs, release notes, migration guidance, and source-of-truth writing for archon.
---

# Archon Technical Writing

Use when updating README content, operator docs, setup guidance, release notes, migration notes, or human-readable workflow artifacts.

Goal: make the current behavior easy to understand and safe to operate.

1. Identify audience and task.
2. Describe current truth, not aspirational behavior.
3. Surface prerequisites, caveats, and rollback or recovery steps early.
4. Prefer concise instructions, exact commands, and explicit outcomes.
5. When docs summarize code behavior, confirm they match the current implementation.
6. Call out any remaining documentation gap instead of smoothing it over.

## Rules

- do not use marketing language where operator guidance is needed
- do not bury prerequisites or breaking changes
- do not document behavior that the repo does not actually ship
- keep examples realistic and runnable

## Output

Return audience, changed behavior, commands or procedures, caveats, and any remaining doc gaps.
