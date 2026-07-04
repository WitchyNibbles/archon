# service.ts decomposition — seam plan

Parent: audit F5 / architecture-runtime-debt.md §3.4. service.ts 2911 lines, class ~612-2911.

## STATUS: COMPLETE ✅ (slice 5 / #159 — gates/closure, final slice)

service.ts is now a thin composition root (467 lines: manager wiring + delegate
stubs + shared require/run-status helpers). Every domain cluster lives in its own
deps-injected manager. Public API + type surface unchanged across all 5 slices.

### Before / after (service.ts line trajectory)

| Milestone                         | service.ts lines | ratchet |
| --------------------------------- | ---------------- | ------- |
| baseline (pre-split)              | 2911             | —       |
| post-S1 autonomous-exec store     | ~2400            | —       |
| post-S2 task-lifecycle            | ~1950            | —       |
| post-S4 status/execution (#157)   | 1079             | —       |
| post-slice-4 recovery+memory (#158) | 756            | 775     |
| post-slice-5 gates/closure (#159) | **467**          | **475** |

Net: 2911 → 467 (−84%). The class is now composition-root-only.

### Module inventory (extracted managers, all under `src/core/`)

| Module                        | Owns                                                        | ratchet |
| ----------------------------- | ----------------------------------------------------------- | ------- |
| project-runtime-state.ts      | shared primitives (timestamp, defaults, state reader)       | 75      |
| autonomous-execution-store.ts | S1 — coverage/gaps/checkpoints/traces/evidence ledgers      | 675     |
| task-lifecycle.ts             | S2 — intake→plan→graph→append→claim→fail + run-status mutators | 450   |
| status-execution-planner.ts   | S4 — getStatus/getExecutionPlan/recommendRouting/resumeRun  | 725     |
| directive-execution.ts        | S4 — executeDirectiveStep + loop-execution history          | 475     |
| recovery-manager.ts           | S5 — inspectRecovery/applyRecovery (advisory-only)          | 350     |
| memory-search-manager.ts      | S6 — promoteMemory/searchMemory/getRuntimeTraceRegistry     | 175     |
| gate-closure-manager.ts       | S3 — submitHandoff/recordReview/findTaskBlockers (authority) | 425    |
| service.ts                    | composition root — wiring + delegate stubs + require helpers | 475    |

Direct manager unit suites: recovery-manager (10), memory-search-manager (8),
status-execution-planner, directive-execution, task-lifecycle, and now
gate-closure-manager (20) + service-constructor-wiring (1). Net suite 3137 → 3158.

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
6. S3 gates/closure          → ~290 out       ✅ DONE (slice 5, #159 — completion authority)

service.ts line trajectory: 2911 → 1079 (post-S4/slice 3) → 756 (post-slice 4) → 467 (post-slice 5, split COMPLETE).

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

## Slice 5 extraction (S3 gates/closure — final slice, #159) ✅
- New `src/core/gate-closure-manager.ts`: class GateClosureManager(deps {store, requireTask, bumpRunState, reviewSource, onHandoff?, resolveReviewActionContext?, mistakeLedgerStore?, antiPatternDraftStore?, promoteMemory}); owns submitHandoff + recordReview + findTaskBlockers. HandoffLifecycleEvent moved here and re-exported from service.ts (public type surface preserved).
- Trust boundary preserved verbatim, same order: (1) recordReview throws without a resolver before touching state; (2) resolved context validated by validateReviewAction — actor/actorRole come from the CONTEXT only; (3) `source` on review + approval = injected reviewSource; (4) floor-reduction provenance uses the SAME isReviewFloorReduced / effectiveRequiredReviewsForTask predicates that drove the gate decision (no drift); (5) fireMistakeCapture runs BEFORE fireDistillation, both non-blocking; distillation promotes through the injected `promoteMemory` delegate so the P0 promotion trust gate still runs.
- findTaskBlockers moved off the class INTO the gate manager; re-pointed the lifecycle + planner `findTaskBlockers` injections to `(t,a,l) => this.gateClosure.findTaskBlockers(...)`. Same behavior.
- Slice-4 carried LOW fixed: constructor wiring invariant made explicit + enforced. Every cross-manager dep is a lazy `this.<field>` arrow closure evaluated only at call time; manager constructors only store deps. New `tests/service-constructor-wiring.test.ts` constructs the service and immediately drives every mutually-recursive path (statusPlanner↔recovery, gateClosure↔taskLifecycle, gateClosure→memorySearch→statusPlanner ring) — fails fast if any dep is ever converted from a lazy read into an eager pre-init capture.
- Direct unit tests: tests/gate-closure-manager.test.ts (20 — both-directions gate: approves only when floor met, refuses every trust/state/floor violation; reduced-floor provenance row; capture-before-distillation ordering; stale-dependency reblock) + tests/service-constructor-wiring.test.ts (1).
- Ratchet regenerated: service.ts 775 → 475; new entry gate-closure-manager 425; nothing raised.
- tsc clean, lint 0 warnings, full suite 3158 pass / 0 fail (modulo the 4 dist-dependent packaging tests when dist is unbuilt — CI arbitrates).
