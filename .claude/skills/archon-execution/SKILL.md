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
6. Move completed work into the `reviewer`, `qa_engineer`, and `security_reviewer` gates (runtime role ids): with a connected runtime, record them via `review-orchestrator` (see `archon-review`); handoffs follow `.archon/templates/handoff.md`.
7. Capture owner role, completion standard, specialist evidence, and quality-gate evidence.
8. The manager persists review gate files under `.archon/work/reviews/` (naming `review-<task-id>-<role>.md`, structure per `.archon/templates/review-gate.md`) when the reviewer roles are read-only — evidence layer only; runtime records remain the completion authority.
9. Run the canonical workflow check `npx tsx ./src/admin.ts workflow-proof --run-id latest --task-id <task-id>` before claiming the substantive slice is complete (`bash scripts/check-archon-workflow-live.sh [--task-id <task-id>]` is the documented local-live alias).
10. Promote only reviewed durable memory.
11. At slice close (gates passed), run `/archon-retro` to record the promotion decision — repo facts to `.archon/memory/`, process lessons to `/archon-skill-evolution`, or an explicit "nothing to promote".

## Agent routing

Agent-tool `subagent_type` names (kebab-case, matching `.claude/agents/`; the runtime's
gate role ids in DB records and review filenames stay snake_case):

- architecture and sequencing handoff: `solution-architect`
- decomposition, dependencies, and worker routing: `planner`
- documentation, release-note, and standards verification: `docs-researcher`
- UI, flow, accessibility: `frontend-designer`
- server logic, API, auth, data: `backend-engineer`
- deploy, env, secrets, monitoring: `infra-engineer`
- build, test, typecheck, or setup failure resolution: `build-resolver`
- correctness and regression review: `reviewer`
- threat review and abuse cases: `security-reviewer`
- tests and regressions: `qa-engineer`
- gate recording against a live runtime: `review-orchestrator`

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
