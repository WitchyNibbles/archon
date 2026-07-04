---
name: archon-autopilot
description: Full-project autonomous delivery loop until the product goal is complete or a real blocker exists.
---

# Archon Autopilot

Use for full-project or multi-phase execution when Archon must keep moving without waiting after each slice.

Goal: continue planning, implementing, verifying, repairing, reviewing, and selecting the next task until the product-level goal is complete or a real blocker exists.

## Required reads

Read, in order:

1. project requirements or brief
2. `CLAUDE.md`
3. `.archon/ACTIVE`
4. `.archon/work/product-state.md`
5. `.archon/work/task-queue.json`
6. the active task packet and any directly dependent task packets

If `product-state.md` or `task-queue.json` is missing, initialize it from `.archon/templates/` before continuing.

## Loop

1. Restate the product goal, clarified user intent, global acceptance criteria, current milestone, and stopping criteria.
2. Determine whether the product-level goal is complete.
3. If complete, stop and report the evidence.
4. If incomplete, select the first unblocked task where:
   - `status` is not `done`
   - every dependency is `done`
   - the task is not blocked
5. Refuse to execute a task packet that lacks:
   - acceptance criteria
   - verification commands
   - rollback notes where the change can require rollback
   - owner role
   - expected artifacts
6. Implement the smallest vertical slice that can produce real evidence and advances the full product, not just the current subtask.
7. Run the task verification commands exactly as written, including good-path and bad-path coverage required by the task gates.
8. If verification fails or acceptance evidence is incomplete, invoke `/archon-repair-loop`.
9. Repeat repair until verification passes, a real blocker exists, or the bounded repair budget is exhausted.
10. Record review evidence according to task class.
11. Update:
    - `.archon/work/product-state.md`
    - `.archon/work/task-queue.json`
    - `.archon/ACTIVE`
12. Run `/archon-retro` to record the promotion decision (repo facts to `.archon/memory/`, process lessons to `/archon-skill-evolution`, or an explicit "nothing to promote") before selecting the next task — this compounds the learning so the next task is cheaper.
13. Select the next unblocked task and continue immediately unless a stop condition is met.
14. Do not wait for the user to say "continue" between internal tasks; only stop for real blockers, approval-matrix actions, or explicit planning-only requests.

## Hard rules

- do not stop after intake, architecture, planning, or one implementation slice
- a completed phase is not a completed product
- never mark work done without verification evidence
- never stop after a single passing command when other required unit, integration, E2E, negative-case, or review evidence is still missing
- stop only when all product-level acceptance criteria are complete, a real blocker requires user input, verification cannot proceed after documented repair attempts, or the user explicitly requested planning only
