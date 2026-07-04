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
1. S1 autonomous-exec store  → ~500 lines out  (THIS SLICE)
2. S2 task-lifecycle         → ~450
3. S4 status/execution-plan  → ~600
4. S5 recovery               → ~370
5. S6 memory/search          → ~150
6. S3 gates/closure          → ~450 (last; completion authority moves once pattern proven)

## Slice 1 extraction
- New `src/core/project-runtime-state.ts`: shared primitives (timestamp, uniqueStrings, buildDefaultTaskQueue, buildDefaultProductState, readAutonomousExecutionState) — moved+imported to break cycle.
- New `src/core/autonomous-execution-store.ts`: class AutonomousExecutionStore(deps {store, requireRun}); owns saveState + cluster methods + cluster-only helpers.
- ArchonCoreService holds `autonomousExecution` instance, delegates. saveState exposed for createTaskGraph. Public API unchanged.
