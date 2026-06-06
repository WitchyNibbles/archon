---
name: archon-debugging
description: Systematic debugging and build resolution.
---

# Archon Debugging

Use when a command, setup flow, build, typecheck, or test path is broken.

Goal: fix the real root cause with the smallest credible change.

1. Reproduce the failure and capture the exact command.
2. Narrow the failing boundary before editing.
3. Form one hypothesis at a time and record the attempt with evidence, verification, and outcome.
4. If the first hypothesis fails or conflicting evidence appears, record it as counter-evidence and test the next most plausible hypothesis within the debug budget.
5. Keep or add a trace ref when the failure path is non-trivial.
6. When repo-local Grafana configuration is present, use Grafana logs as advisory evidence to confirm failure timing, affected services, and counter-evidence before patching. If the configuration is partial or the tool is unavailable, say that explicitly instead of acting like Grafana does not exist.
7. Make one scoped fix.
8. Re-run the relevant verification immediately.
9. Repeat only if the failure persists.

- do not bundle multiple guesses in one patch
- do not disable checks to hide the symptom
- prefer root cause over surface cleanup
- do not make strong negative claims from a narrow pass when broader evidence or an alternate hypothesis has not been checked
- stop and report when the debug budget is exhausted instead of looping on guesses
- record repro, attempts tried, root cause, fix, and verification in the handoff

## Output

Return repro, root cause, exact fix, and proof.
