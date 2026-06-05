---
name: superpowers-systematic-debugging
description: Repo-local wrapper for disciplined debugging. Use when a failure needs hypothesis control, tighter repro boundaries, and incremental verification.
---

# Superpowers Systematic Debugging

Use when diagnosing build, runtime, test, setup, or integration failures.

Goal: move from symptom to root cause with controlled, falsifiable steps.

1. Reproduce the failure before editing anything.
2. Narrow the boundary:
   - inputs
   - environment
   - subsystem
   - first failing assertion or log
3. Change one variable at a time.
4. After each attempted fix, rerun the narrowest command that can falsify the hypothesis.
5. If the first hypothesis fails, try the next plausible one and record why the prior path was rejected.

## Anti-patterns

- editing before repro
- bundling multiple guesses
- "works on my machine" with no constrained proof
- disabling a check instead of fixing the cause

## Output

Return:
- repro command
- root-cause hypothesis
- fix tried
- proof of result
