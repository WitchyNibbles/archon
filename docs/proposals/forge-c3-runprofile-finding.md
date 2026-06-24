# C3 Finding — `frontend_forge` run-profile materialization mechanism

**Condition:** §13 **C3** of `docs/proposals/forge-phase1-architecture.md` (pre-start blocker for P1-S5).
**Owner role:** solution_architect · **Status:** recorded; **P1-S5 paused** by user decision U2 (do groundwork first).
**Verdict:** Create-time pipeline is ADDITIVE within `src/forge`; mid-run repair injection requires a small,
hard-gated ENGINE addition (no safe additive task-writer exists today).

## Findings (code-backed)

1. **Single task-graph writer.** `ArchonCoreService.createTaskGraph(runId, taskPackets)`
   (`src/core/service.ts:1199`) is the sole writer. It validates packets + dependency edges, maps each
   `TaskPacketInput` → `TaskRecord` (class via `mapTaskPacketToQueueClass`), calls `store.replaceTasks`
   (`:1231`), flips run status to `decomposed`, rebuilds `project_runtime_state.task_queue` (`:1255-1266`).
   The decompose SHAPE is supplied by the CALLER (manager/planner) — the engine does not generate tasks
   from a profile. `store.replaceTasks` (`src/store/postgres/tasks.ts:42-44`) is a **delete-by-runId then
   insert** — a full-set replace, NOT additive. Store task-write surface is exactly two methods:
   `replaceTasks` + `updateTask` (`src/store/types.ts:110-113`); `updateTask` cannot change `class`
   (`tasks.ts:139-150`).

2. **Fixed task presence is supported.** The engine has no fixed decompose shape of its own — it
   materializes whatever packet array the caller hands `createTaskGraph`. A `frontend_forge` profile CAN
   declare a fixed ~15-stage packet set, materialized as ordinary gated tasks reusing the EXISTING
   reviewer/qa/security path. No second gate path, no second source of truth. Option A is sound for create-time.

3. **Mid-run injection (the repair edge) — NO safe writer today.** The visual-critic `rework` must spawn a
   repair task after the run's tasks already exist. The only writers are `replaceTasks` (delete-all-by-runId
   → would wipe the in-flight pipeline) and `updateTask` (mutate one row, cannot add). `init-task.ts:267`'s
   `replaceTasks([task])` is single-seed only and destructive if a run already has tasks.

4. **Confirmed attach points.**
   - **Create-time (ADDITIVE, P1-S5 core):** new `src/forge` code builds the 15-stage `TaskPacketInput[]`
     from static profile data and calls the EXISTING `createTaskGraph(runId, packets)`. New profile data +
     a `buildForgePipelinePackets(profile): TaskPacketInput[]` helper + one existing call. No engine change.
     Do NOT overload the `RunProfile` union (`src/domain/types.ts:236`) — it feeds coverage/rewrite-readiness
     analysis; thread the forge template as forge-local data.
   - **Mid-run repair (ENGINE-MODIFYING, separate scoped+hard-gated task):** add an additive single-writer
     `ArchonCoreService.appendTasks(runId, taskPackets)` backed by a new `store.appendTasks` that INSERTs
     without delete-by-runId, validates new dependency edges against existing task keys, and rebuilds
     `task_queue`. Reviewer + security_reviewer hard gate (touches task-graph integrity).

5. **PS-5 tripwire (static-data-only).** The create-time profile CAN be pure static data (no conditional
   branching). The ONE risk: don't express "repair task exists only when the critic fails" as create-time
   conditional presence. Keep the profile static (model the repair stage as a normal review-blocked
   dependent dispatched when its gate trips) and push dynamic repair-task creation into the separate
   mid-run `appendTasks` path. Do NOT let dynamic repair logic leak into the static template.

## Implications for the paused keystone

- **P1-S5 (run-profile)** when it resumes: additive within `src/forge` + the existing `createTaskGraph`.
- **New groundwork task (recommended before/with S5): `appendTasks` additive task-writer** — the single
  most expensive/least-reversible item; building it carefully (its own hard gate) de-risks the repair edge.
- Single-writer integrity is the dominant risk: the mid-run writer MUST be a new non-destructive INSERT,
  never a reuse of `replaceTasks`.

_Read scope: `src/core/service.ts` (createTaskGraph @1199, intakeRequest @1127), `src/store/postgres/tasks.ts`
(replaceTasks @37, updateTask @139), `src/store/types.ts` (@110-113), `src/domain/types.ts` (runProfiles @236,
TaskPacketInput @480), `src/admin/init-task.ts` (@267)._
