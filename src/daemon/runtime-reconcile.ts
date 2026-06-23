// Daemon split (loop-monolith decomposition, 6m): the attemptRuntimeReconcile
// loop closure, lifted out of executeDaemonCommandFromArgs.
//
// createDaemonRuntimeReconcile is a factory that takes stable (per-invocation)
// deps once and returns the (cycle: number) => Promise<...> closure that the
// codex-turn runner and other handlers already receive as `attemptRuntimeReconcile`.
//
// The reconcile command (executeReconcileRuntimeStateCommandFromArgs) is injected
// as a dep (`reconcileRuntimeState: ReconcileRuntimeStateFn`) for unit testability
// — exactly the same pattern used in split 6k for advanceActiveTask. The production
// wiring in daemon.ts passes executeReconcileRuntimeStateCommandFromArgs directly.
//
// latestSessionId is read through `getSessionId` (a live getter, NOT a captured
// snapshot). The closure reads the session id at push time so the cycle record
// reflects the most-recent codex turn session id.
import type { ReconcileRuntimeStateCommandResult, ExecuteReconcileRuntimeStateCommandOptions } from "../runtime.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type { DaemonCycleRecord } from "../daemon.ts";

// ---------------------------------------------------------------------------
// ReconcileRuntimeStateFn — injectable type alias
// ---------------------------------------------------------------------------

/**
 * The subset of executeReconcileRuntimeStateCommandFromArgs that this factory
 * needs. Injecting it via the deps bag lets unit tests supply a fake and cover
 * all paths without a live DB or filesystem. Production wiring passes the real
 * function from runtime.ts.
 */
export type ReconcileRuntimeStateFn = (
  args: readonly string[],
  options: ExecuteReconcileRuntimeStateCommandOptions
) => Promise<{ format: "json" | "text"; result: ReconcileRuntimeStateCommandResult }>;

// ---------------------------------------------------------------------------
// Factory deps
// ---------------------------------------------------------------------------

/** Stable (per-invocation) dependencies the factory needs from the loop. */
export interface DaemonRuntimeReconcileFactoryDeps {
  workspaceSlug: string;
  projectSlug: string;
  staleAfterHours: number;
  options: ExecuteReconcileRuntimeStateCommandOptions;
  /** The loop's cycle accumulator; mutated by push (ref-safe). */
  cycles: DaemonCycleRecord[];
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
  /** Injectable reconcile function — production: executeReconcileRuntimeStateCommandFromArgs. */
  reconcileRuntimeState: ReconcileRuntimeStateFn;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns the loop's attemptRuntimeReconcile callback. The returned function
 * runs the reconcile command in preview mode, applies it when a safe repair
 * action is warranted, pushes a cycle record, and returns the applied result —
 * exactly as the inline closure did before extraction.
 */
export function createDaemonRuntimeReconcile(
  deps: DaemonRuntimeReconcileFactoryDeps
): (cycle: number) => Promise<ReconcileRuntimeStateCommandResult | undefined> {
  const { workspaceSlug, projectSlug, staleAfterHours, options, cycles, getSessionId, reconcileRuntimeState } = deps;

  return async (cycle: number): Promise<ReconcileRuntimeStateCommandResult | undefined> => {
    const baseArgs = [
      "--workspace-slug",
      workspaceSlug,
      "--project-slug",
      projectSlug,
      "--stale-after-hours",
      String(staleAfterHours),
      "--format",
      "json"
    ] as const;

    const preview = await reconcileRuntimeState(baseArgs, options);
    const repairAction = preview.result.repairAction;
    const shouldApply =
      repairAction === "rebuild_missing_runtime_state" ||
      repairAction === "sync_active_task_to_in_progress" ||
      repairAction === "activate_owner_dispatch_target";

    if (!preview.result.runtimeStateChanged || !shouldApply) {
      return undefined;
    }

    const { result } = await reconcileRuntimeState(
      [
        ...baseArgs,
        "--apply"
      ],
      options
    );

    cycles.push({
      cycle,
      directiveKind: result.executionPlanDirectiveKind ?? "blocked",
      action: "reconcile_runtime_state",
      runId: result.activeRunId ?? "none",
      taskId: result.activeTaskId,
      sessionId: getSessionId() ?? null,
      summary: `${result.repairAction}: ${result.reason}`
    });

    return result;
  };
}
