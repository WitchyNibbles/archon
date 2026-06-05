---
name: superpowers-test-driven-development
description: Repo-local wrapper for strict red-green-refactor sequencing. Use when new behavior or bug fixes need a smallest-failing-test-first workflow.
---

# Superpowers Test-Driven Development

Use for new features, bug fixes, and behavior changes where a failing test can define the requirement.

Goal: keep implementation honest by proving the requirement with the smallest failing test first.

1. Write the narrowest failing test that captures the required behavior.
2. Keep the first RED focused on one requirement, not the whole system.
3. Make the smallest implementation change that turns RED to GREEN.
4. Refactor only after GREEN is established.
5. End with the exact command that proves the behavior and no broader change than needed.

## Anti-patterns

- code first, tests later
- giant failing suites with no clear first requirement
- mixing harness work and behavior proof without saying so
- claiming TDD after only adding post-hoc tests

## Output

Return:
- first failing test
- green proof
- refactor notes
- remaining edge cases
