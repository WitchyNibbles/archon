// Daemon split (loop-monolith decomposition, 6n — THE FINAL CUT): the loop tail,
// lifted out of executeDaemonCommandFromArgs.
//
// This is the very last block in the daemon loop body. It handles two things:
//
//   1. dispatch_owner mismatch guard — when the runtime wants a different task than
//      the one currently active, attempt reconcile first; if reconcile did not fix
//      the pointer, block with "active_task_mismatch".
//
//   2. codex fallthrough turn — runs for a matching dispatch_owner directive (after
//      the mismatch guard), OR for any other directive kind that reaches the loop
//      tail; summaryAction is "run_codex_owner" for dispatch_owner, otherwise
//      "run_codex_analysis"; returns undefined (loop-around) when the codex turn
//      made progress, or a blocked result when it stalled.
//
// TWO-WAY outcome:
//   DaemonCommandResult — caller must `return result` (blocked or stalled result)
//   undefined           — fall through to the next loop cycle (was: `continue` from
//                         the reconcile path, or natural loop-around after the codex
//                         turn returned undefined)
//
// Both exits from the original code that advanced to the next loop cycle — the
// explicit `continue` after `reconciled?.runtimeStateChanged` and the implicit
// fall-through when `runDaemonCodexTurn` returned undefined — map to `return undefined`
// here. Since this is the LOOP TAIL (last code in the for-body), returning undefined
// is exactly equivalent to both continuations.
//
// attemptRuntimeReconcile, runDaemonCodexTurn, blockedResult, cycles, and the
// read-only session getter are all threaded through the deps bag — never captured
// as closures — so unit tests can inject fakes without reaching a live DB.
// This mirrors the pattern established in complete.ts (6k) and continue-analysis.ts (6j).
import type { ReconcileRuntimeStateCommandResult } from "../runtime.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type { DaemonCommandResult, DaemonCycleRecord } from "../daemon.ts";
import type { DaemonBlockedResultBuilder, DaemonCodexTurnInput } from "./codex-turn.ts";
import type { RunExecutionPlan } from "../domain/types.ts";

// ---------------------------------------------------------------------------
// Input / deps types
// ---------------------------------------------------------------------------

/** Per-cycle inputs the handler receives from the loop. */
export interface DaemonDispatchOwnerTurnInput {
  directive: RunExecutionPlan["directive"];
  cycle: number;
  activeRunId: string;
  activeTaskId: string;
}

/** Stable (per-invocation) dependencies the handler needs from the loop. */
export interface DaemonDispatchOwnerTurnDeps {
  /** Attempt a runtime reconcile; returns undefined when no repair was applied. */
  attemptRuntimeReconcile: (cycle: number) => Promise<ReconcileRuntimeStateCommandResult | undefined>;
  /** Run a single codex turn; returns undefined when the loop should continue. */
  runDaemonCodexTurn: (input: DaemonCodexTurnInput) => Promise<DaemonCommandResult | undefined>;
  /** Build a blocked DaemonCommandResult from structured input. */
  blockedResult: DaemonBlockedResultBuilder;
  /** The loop's cycle accumulator; mutated by push (ref-safe). */
  cycles: DaemonCycleRecord[];
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles the loop tail: the dispatch_owner mismatch guard and the codex
 * fallthrough turn (dispatch_owner when tasks match, or any other directive
 * kind reaching the loop tail).
 *
 * Returns:
 *   - a DaemonCommandResult when a task-pointer mismatch cannot be reconciled,
 *     or when the codex turn stalls / blocks
 *   - undefined when the reconcile fixed the pointer (was: `continue`) or when
 *     the codex turn made progress and the loop should cycle again (was:
 *     natural loop-around after `if (codexResult) return codexResult`)
 */
export async function handleDaemonDispatchOwnerTurnStep(
  input: DaemonDispatchOwnerTurnInput,
  deps: DaemonDispatchOwnerTurnDeps
): Promise<DaemonCommandResult | undefined> {
  const { directive, cycle, activeRunId, activeTaskId } = input;
  const { attemptRuntimeReconcile, runDaemonCodexTurn, blockedResult, cycles, getSessionId } = deps;

  if (directive.kind === "dispatch_owner" && directive.recommendation.taskId !== activeTaskId) {
    const reconciled = await attemptRuntimeReconcile(cycle);
    if (reconciled?.runtimeStateChanged) {
      // Reconcile fixed the pointer — next cycle will re-read the directive.
      return undefined;
    }
    cycles.push({
      cycle,
      directiveKind: directive.kind,
      action: "blocked",
      runId: activeRunId,
      taskId: activeTaskId,
      sessionId: getSessionId() ?? null,
      summary: `runtime wants ${directive.recommendation.taskId} but active task is ${activeTaskId}`
    });

    return blockedResult({
      blockerKind: "active_task_mismatch",
      reason: "runtime active-task pointer does not match the owner dispatch target",
      cycle,
      activeRunId,
      activeTaskId,
      directiveKind: directive.kind,
      nextActions: [
        "inspect `npm run archon:status -- --format json` to compare the active runtime task and owner dispatch target",
        "run `npm run archon:reconcile` to align the active runtime task with the authoritative owner-dispatch target"
      ]
    });
  }

  const codexResult = await runDaemonCodexTurn({
    directive,
    summaryAction: directive.kind === "dispatch_owner" ? "run_codex_owner" : "run_codex_analysis",
    activeRunId,
    activeTaskId
  });
  if (codexResult) {
    return codexResult;
  }

  // codexResult was undefined — loop should cycle again (was: natural loop-around).
  return undefined;
}
