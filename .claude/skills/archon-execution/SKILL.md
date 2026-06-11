---
name: archon-execution
description: Move planned archon work into implementation.
---

# Archon Execution

Use after planning is good enough to build from explicit task packets.

Goal: ship the smallest clean increment without bypassing gates.

1. Restate milestone, active packet, completion standard, and roles.
2. Confirm the packet came from architect + planner handoff.
3. Enforce write scope, completion standard, required roles, and quality gates.
4. Spawn only the agents needed for the active slice via the Agent tool with explicit `model` routing.
5. Manager coordinates; non-trivial work stays with the named specialist owner.
6. Move completed work into `reviewer`, `qa_engineer`, and `security_reviewer` handoff.
7. Capture owner role, completion standard, specialist evidence, and quality-gate evidence.
8. The manager persists review gate files under `.archon/work/reviews/` when the reviewer roles are read-only.
9. Run `node --experimental-strip-types scripts/check-archon-workflow.ts --task-id <task-id>` before claiming the substantive slice is complete.
10. Promote only reviewed durable memory.

## Agent routing

- architecture and sequencing handoff: `solution_architect`
- decomposition, dependencies, and worker routing: `planner`
- documentation, release-note, and standards verification: `docs_researcher`
- UI, flow, accessibility: `frontend_designer`
- server logic, API, auth, data: `backend_engineer`
- deploy, env, secrets, monitoring: `infra_engineer`
- build, test, typecheck, or setup failure resolution: `build_resolver`
- correctness and regression review: `reviewer`
- threat review and abuse cases: `security_reviewer`
- tests and regressions: `qa_engineer`

## Token discipline

- subagents use caveman format
- target 4-6 lines per handoff, 8 lines max for review gates
- prefer `blk:` over `block:`
- no broad status essays
- keep evidence concrete: file, risk, behavior, test

## Done bar

Do not call the slice done unless:

- the code works or the exact blocker is known
- handoffs are explicit
- specialist ownership matched the task packet
- required reviews passed
- verification evidence exists
- the workflow checker passes for the current task id
- write locks were released
