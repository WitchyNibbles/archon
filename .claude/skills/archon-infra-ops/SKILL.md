---
name: archon-infra-ops
description: Environment, CI, deploy-surface, rollback, observability, and operational-safety workflow for archon.
---

# Archon Infra Ops

Use when the task changes CI, environments, setup flows, bootstrap paths, migrations, secrets handling, or operator runbooks.

Goal: keep delivery surfaces safe, replayable, observable, and reversible.

1. Restate the operational surface being changed.
2. List environment assumptions and trust boundaries.
3. Verify rollout path, rollback path, and health checks.
4. Include observability or diagnostics expectations.
5. Call out manual operator steps and env changes explicitly.
6. Prefer small reversible changes over broad infra rewrites.
7. Require setup or replay verification when the install or runtime path changed.

## Rules

- do not hide operational assumptions in code comments only
- do not approve runtime or migration changes without rollback notes
- do not expand secret or permission scope casually
- do not treat local success as enough when the operator path changed

## Output

Return env assumptions, deploy or setup impact, rollback path, health checks, and operator caveats.
