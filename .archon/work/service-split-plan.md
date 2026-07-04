# service.ts decomposition — seam plan

Parent: audit F5 / architecture-runtime-debt.md §3.4. service.ts 2911 lines, class ~612-2911.

## Method clusters (by private-state coupling)
- autonomous-exec state (S1): saveState + 18 upsert/config/checkpoint/trace/repo-inventory methods. Deps: store, requireRun. LOWEST coupling — only store+requireRun, no gate/review touch.
- task lifecycle (S2): intakeRequest, createPlan, createTaskGraph, appendTasks, claimTask, failTask, syncRunState, bumpRunState. Deps: store, requireRun/Task, deriveRunStatus, queue builders.
- gates & closure (S3): submitHandoff, recordReview, review-context/mistake-capture, collectUnsatisfiedReviewRoles, findTaskBlockers. Deps: store, review helpers, onHandoff, ledger stores. HIGHEST coupling (completion authority) — move LAST.
- status & execution plan (S4): getStatus, getExecutionPlan, resumeRun, executeDirectiveStep, getLoopExecutionHistory, recommendRouting, collectExecutionBlockers, persistLoopExecutionHistory. Deps: snapshot/blocker free-fns, directive helpers.
- recovery (S5): inspectRecovery, applyRecovery. Deps: store, recovery free-fns.
- memory (S6): promoteMemory, searchMemory, getRuntimeTraceRegistry(uses getStatus). Deps: store, search helpers.

## Slice order (rough line counts)
1. S1 autonomous-exec store  → ~500 lines out  ✅ DONE (#155)
2. S2 task-lifecycle         → ~450           ✅ DONE (#156)
3. S4 status/execution-plan  → ~600           ✅ DONE (#157, split across status-execution-planner.ts + directive-execution.ts)
4. S5 recovery               → ~370           ✅ DONE (slice 4)
5. S6 memory/search          → ~150           ✅ DONE (slice 4)
6. S3 gates/closure          → ~450 (final slice; completion authority moves once pattern proven)

service.ts line trajectory: 2911 → 1079 (post-S4/slice 3) → 756 (post-slice 4).

## Slice 1 extraction
- New `src/core/project-runtime-state.ts`: shared primitives (timestamp, uniqueStrings, buildDefaultTaskQueue, buildDefaultProductState, readAutonomousExecutionState) — moved+imported to break cycle.
- New `src/core/autonomous-execution-store.ts`: class AutonomousExecutionStore(deps {store, requireRun}); owns saveState + cluster methods + cluster-only helpers.
- ArchonCoreService holds `autonomousExecution` instance, delegates. saveState exposed for createTaskGraph. Public API unchanged.

## Slice 4 extraction (S5 recovery + S6 memory/search — batched, one commit each)
- New `src/core/recovery-manager.ts`: class RecoveryManager(deps {store, requireRun, requireTask, getStatus, syncRunState}); owns inspectRecovery + applyRecovery + cluster-only free-fns (parseHoursSince, dedupeById). getStatus injected as `(runId) => statusPlanner.getStatus(runId)`; the class re-points the planner's `inspectRecovery` dep to `(runId, opts) => recovery.inspectRecovery(...)`. Both directions are class-bound runtime closures — no import cycle (mirrors slice 3 wiring shape). Advisory-only authority boundary (derived_only labels, request_missing_reviews stays safeToApply:false) preserved.
- New `src/core/memory-search-manager.ts`: class MemorySearchManager(deps {store, requireRun, getStatus, bumpRunState, resolveReviewActionContext?}); owns promoteMemory + searchMemory + getRuntimeTraceRegistry. P0 promotion trust gate (isTrustedReviewActionContext, forced authorityLevel reviewed_memory, resolver-derived reviewer/actor) enforced inside the manager, not bypassed. getRuntimeTraceRegistry preserves exact `"runtime trace registry requires autonomous execution state"` throw via the planner's enabled-gating guard. recordReview (still on class) binds its distillation hook to the class `promoteMemory` delegate, so the gate still runs on the autonomous path.
- ArchonCoreService holds `recovery` + `memorySearch` instances; the 5 public methods (inspectRecovery, applyRecovery, promoteMemory, searchMemory, getRuntimeTraceRegistry) delegate. Public API + type surface unchanged.
- Direct unit tests: tests/recovery-manager.test.ts (10) + tests/memory-search-manager.test.ts (8).
- Ratchet regenerated: service.ts 1100 → 775; new entries recovery-manager 350, memory-search-manager 175; nothing raised.

## Final slice (S3 gates/closure) — remaining on the class
- ~756 lines currently on service.ts. The remaining domain cluster is submitHandoff + recordReview (~270 lines of bodies) plus their review-context/mistake-capture/floor-reduction glue and the findTaskBlockers dependency-staleness helper.
- After S3 extracts to a closure/gate manager, service.ts becomes a thin composition root: constructor wiring + ~5 manager fields + public delegate stubs + the shared requireRun/requireTask/bumpRunState/syncRunState private helpers. Estimated residual class: ~400–450 lines (est. ~300 lines out in the final slice).
- S3 is highest coupling (completion authority: onHandoff, ledger stores, reviewSource, review-floor provenance). Move last, once the deps-injection + closure-wiring pattern is proven across slices 1–4.
