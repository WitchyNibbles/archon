// Daemon split (loop-monolith decomposition, 6k): the complete directive handler,
// lifted out of executeDaemonCommandFromArgs.
//
// TWO-WAY outcome (matches the 6i pattern from review-dispatch.ts):
//   DaemonCommandResult — caller must `return result` (either "completed" or blocked)
//   undefined           — caller must `continue` (advance issued; next task in queue)
//
// classifyAdvanceFailure was previously defined and exported from daemon.ts (~line 858).
// It is MOVED here to avoid a value cycle: if this module imported it from daemon.ts,
// and daemon.ts imports from this module, the circular reference would be a runtime
// problem. Moving it here keeps the dependency graph acyclic. daemon.ts re-exports
// classifyAdvanceFailure so that existing callers (e.g. tests/daemon-guard-throw.test.ts
// importing from "../src/daemon.ts") continue to resolve unchanged.
//
// latestSessionId is read through `getSessionId` (a live getter, NOT a captured
// value). The handler only READS the session id — it never writes it back.
// This mirrors the read-only getter pattern established in continue-analysis.ts (6j).
//
// advanceActiveTask is injected via the deps bag (NOT a direct module import) so that
// unit tests can supply a fake implementation and cover the success paths without
// reaching a live DB. The production wiring in daemon.ts passes
// executeAdvanceActiveTaskCommandFromArgs directly. The type alias AdvanceActiveTaskFn
// uses ExecuteAdvanceActiveTaskCommandOptions (the minimal required type) to avoid
// importing ExecuteDaemonCommandOptions (a wider type) into this leaf — widening is
// safe because ExecuteDaemonCommandOptions extends ExecuteAdvanceActiveTaskCommandOptions.
import type { AdvanceActiveTaskCommandResult, ExecuteAdvanceActiveTaskCommandOptions } from "../workflow.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type {
  DaemonCommandResult,
  DaemonCycleRecord,
  ExecuteDaemonCommandOptions
} from "../daemon.ts";
import type { DaemonBlockedResultBuilder } from "./codex-turn.ts";
import type { ProjectRuntimeStateRecord, RunExecutionPlan } from "../domain/types.ts";

// ---------------------------------------------------------------------------
// classifyAdvanceFailure (moved from daemon.ts ~line 858)
// ---------------------------------------------------------------------------

// Map an advance-active-task failure to an operator-actionable blocker. The commit
// guard (advanceCommitGuard) throws with a recognizable signature when in-scope
// deliverables are uncommitted; that case gets a dedicated, recoverable blocker
// with commit guidance. Any other advance failure surfaces as runtime_blocked so a
// throw never escapes the daemon loop as an unhandled exception. Pure and
// unit-testable.
export function classifyAdvanceFailure(error: unknown): {
  blockerKind: "uncommitted_deliverables" | "runtime_blocked";
  reason: string;
  nextActions: string[];
} {
  const message = error instanceof Error ? error.message : String(error);
  // Match the commit guard's specific phrasing (src/workflow.ts evaluateCommitGuard).
  // The second arm is anchored to "inside its write scope" so a generic future error
  // that merely mentions "uncommitted change(s)" is not misclassified as a guard hit.
  if (/refusing to close task|uncommitted change\(s\) inside its write scope/i.test(message)) {
    return {
      blockerKind: "uncommitted_deliverables",
      reason: message,
      nextActions: [
        "Commit the active task's uncommitted in-scope deliverables, then re-run the daemon.",
        "Or run advance-active-task --apply --allow-uncommitted if leaving them uncommitted is intentional."
      ]
    };
  }
  return {
    blockerKind: "runtime_blocked",
    reason: `advance-active-task failed: ${message}`,
    nextActions: [
      "Resolve the advance-active-task failure (see reason), then re-run the daemon."
    ]
  };
}

// ---------------------------------------------------------------------------
// AdvanceActiveTaskFn — injectable type alias
// ---------------------------------------------------------------------------

/**
 * The subset of executeAdvanceActiveTaskCommandFromArgs that this handler needs.
 * Injecting it via the deps bag lets unit tests supply a fake and cover success
 * paths without a live DB. Production wiring passes the real function from workflow.ts.
 */
export type AdvanceActiveTaskFn = (
  args: readonly string[],
  options: ExecuteAdvanceActiveTaskCommandOptions
) => Promise<{ format: "json" | "text"; result: AdvanceActiveTaskCommandResult }>;

// ---------------------------------------------------------------------------
// Input / deps types
// ---------------------------------------------------------------------------

/** Per-cycle inputs the handler receives from the loop. */
export interface DaemonCompleteInput {
  directive: Extract<RunExecutionPlan["directive"], { kind: "complete" }>;
  cycle: number;
  activeRunId: string;
  activeTaskId: string;
}

/** Stable (per-invocation) dependencies the handler needs from the loop. */
export interface DaemonCompleteDeps {
  options: ExecuteDaemonCommandOptions;
  workspaceSlug: string;
  projectSlug: string;
  /** Project id for re-reading runtime state after the final advance (refreshes task ids). */
  projectId: string;
  /** The loop's cycle accumulator; mutated by push (ref-safe). */
  cycles: DaemonCycleRecord[];
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
  blockedResult: DaemonBlockedResultBuilder;
  /** Injectable advance function — production: executeAdvanceActiveTaskCommandFromArgs. */
  advanceActiveTask: AdvanceActiveTaskFn;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles a complete directive: calls executeAdvanceActiveTaskCommandFromArgs,
 * catches commit-guard and other advance failures and surfaces them as structured
 * blockers, and pushes a cycle record for every path.
 *
 * Returns:
 *   - a DaemonCommandResult when the task list is exhausted (status "completed")
 *     or an advance failure must block the loop (status "blocked")
 *   - undefined when advance succeeded and a next task exists (loop must `continue`)
 */
export async function handleDaemonComplete(
  input: DaemonCompleteInput,
  deps: DaemonCompleteDeps
): Promise<DaemonCommandResult | undefined> {
  const { directive, cycle, activeRunId, activeTaskId } = input;
  const {
    options,
    workspaceSlug,
    projectSlug,
    projectId,
    cycles,
    getSessionId,
    blockedResult,
    advanceActiveTask
  } = deps;

  let advanced: Awaited<ReturnType<AdvanceActiveTaskFn>>;
  try {
    advanced = await advanceActiveTask(
      [
        "--workspace-slug",
        workspaceSlug,
        "--project-slug",
        projectSlug,
        "--run-id",
        activeRunId,
        "--apply",
        "--format",
        "json"
      ],
      options
    );
  } catch (error) {
    // advance-active-task can throw — most notably the commit guard when the
    // task's in-scope deliverables are uncommitted. Surface it as a structured
    // blocker so the autonomy loop pauses for the operator instead of crashing.
    const failure = classifyAdvanceFailure(error);
    cycles.push({
      cycle,
      directiveKind: directive.kind,
      action: "blocked",
      runId: activeRunId,
      taskId: activeTaskId,
      sessionId: getSessionId() ?? null,
      summary: failure.reason
    });
    return blockedResult({
      blockerKind: failure.blockerKind,
      reason: failure.reason,
      cycle,
      activeRunId,
      activeTaskId,
      directiveKind: directive.kind,
      nextActions: failure.nextActions
    });
  }

  cycles.push({
    cycle,
    directiveKind: directive.kind,
    action: advanced.result.nextTaskId ? "advance_active_task" : "complete",
    runId: activeRunId,
    taskId: activeTaskId,
    sessionId: getSessionId() ?? null,
    summary: advanced.result.nextTaskId
      ? `advanced to ${advanced.result.nextTaskId}`
      : "advanced the final active task and closed the queue"
  });

  if (!advanced.result.nextTaskId) {
    const refreshedState: ProjectRuntimeStateRecord | undefined =
      await options.getProjectRuntimeState(projectId);
    return {
      authorityLabel: "derived_only" as const,
      workspaceSlug,
      projectSlug,
      status: "completed" as const,
      reason: "daemon advanced the final active task and no next task remains",
      activeRunId: refreshedState?.activeRunId ?? null,
      activeTaskId: refreshedState?.activeTaskId ?? null,
      sessionId: getSessionId() ?? null,
      cycles
    };
  }

  // Next task exists — signal the loop to continue.
  return undefined;
}
