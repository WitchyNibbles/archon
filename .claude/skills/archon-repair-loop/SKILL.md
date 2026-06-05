---
name: archon-repair-loop
description: Bounded repair loop for failed verification commands.
---

# Archon Repair Loop

Use when a verification command fails during execution.

Goal: make the smallest safe repair, rerun the failing command, then rerun the broader gate until the task is proven green or a real blocker exists.

## Loop

1. Capture:
   - exact command
   - exit code
   - relevant output
   - likely related files
2. Classify the failure:
   - implementation bug
   - test expectation issue
   - missing dependency
   - environment or setup issue
   - scope conflict
   - unknown
3. Apply the smallest safe fix that matches the classification.
4. Re-run the failed command.
5. If it passes, re-run the broader relevant gate.
6. Repeat until: verification passes, a real blocker is found, or the repair budget is exhausted.

## Blocker report

If repair stops without a passing result:
- what failed
- what was tried
- the exact command and relevant output
- the likely related files
- the suggested human decision

## Hard rules

- do not skip failed tests
- do not mark a task done after failed verification
- do not claim success from static reasoning alone
- prefer bounded, reversible fixes over broad refactors inside repair mode
