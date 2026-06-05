---
name: archon-tdd
description: Test-first delivery for behavior changes.
---

# Archon TDD

Use before implementing behavior changes when QA should not catch test gaps after the fact.

Goal: force red-green-refactor with explicit evidence.

1. Restate the behavior change and smallest failure to prove first.
2. Write the failing test before implementation.
3. Run the smallest relevant test command and capture the failure.
4. Implement the minimum change for green.
5. Rerun focused tests, then broader checks.
6. Refactor only after green while preserving coverage and gate behavior.

- do not start with implementation when a meaningful failing test can be written first
- prefer the smallest behavioral test that proves the requirement
- if true RED is impossible because the harness does not exist yet, say why and create the harness first
- include rollback notes for schema, policy, or installer changes

## Output

Return the failing test target, the green target, and the exact verification commands.
