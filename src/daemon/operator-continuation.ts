// Daemon split (loop-monolith decomposition, 6g): the operator-required
// continuation handler, lifted out of executeDaemonCommandFromArgs.
//
// This is the structural slice of the loop monolith. The handler used to be a
// nested closure capturing the loop's mutable state. It is now a module-level
// function that takes per-cycle inputs plus an explicit dependency bag. The two
// other loop closures it relied on — blockedResult and runDaemonCodexTurn — are
// passed in as callbacks, so this handler stays behavior-preserving while
// becoming independently testable.
//
// latestSessionId is read through `getSessionId` (a live getter, NOT a captured
// value) so the holder/ref semantics survive: runDaemonCodexTurn mutates the
// loop's session id, and any read here must observe the current value.
import {
  resolveContinuationCapabilities,
  selectLocalContinuationProvider,
  type ContinueAnalysisDirectiveClassification
} from "../admin/autonomous-summary.ts";
import type { RunExecutionPlan } from "../domain/types.ts";
import {
  archiveConsumedDaemonOperatorActionQueueEntries,
  archiveFailedDaemonOperatorActionQueueEntries,
  matchesDaemonOperatorContinuationAction,
  readDaemonOperatorActionQueueState
} from "./review-queue.ts";
import type {
  DaemonOperatorActionQueueEntry,
  FailedDaemonOperatorActionQueueEntry
} from "./review-queue.ts";
import {
  clearDaemonAutomationEnvelope,
  writeDaemonAutomationEnvelope,
  writeDaemonContinuationStatus
} from "./state-writers.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type { DaemonCommandResult, DaemonCycleRecord } from "../daemon.ts";

/**
 * Input to the loop's blockedResult builder. Mirrors the inline shape declared
 * in executeDaemonCommandFromArgs so the closure can be passed as a dependency.
 */
export interface DaemonBlockedResultInput {
  blockerKind:
    | "bootstrapping"
    | "runtime_preflight"
    | "missing_active_runtime"
    | "review_queue"
    | "review_execution_unsupported"
    | "operator_required_continuation"
    | "workflow_proof_failure"
    | "scope_expansion_required"
    | "runtime_blocked"
    | "recovery_required"
    | "runtime_task_missing"
    | "active_task_mismatch"
    | "uncommitted_deliverables";
  reason: string;
  cycle: number;
  activeRunId: string | null;
  activeTaskId: string | null;
  directiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
  nextActions?: string[] | undefined;
  detailFiles?:
    | {
        continuationStatus?: string | undefined;
        reviewQueueStatus?: string | undefined;
        scopeExpansionRequest?: string | undefined;
      }
    | undefined;
}

export type DaemonBlockedResultBuilder = (
  input: DaemonBlockedResultInput
) => Promise<DaemonCommandResult>;

export type DaemonCodexTurnRunner = (input: {
  directive: RunExecutionPlan["directive"];
  summaryAction: "run_codex_owner" | "run_codex_analysis";
  activeRunId: string;
  activeTaskId: string;
  operatorNotes?: string | undefined;
}) => Promise<DaemonCommandResult | undefined>;

/** Stable (per-invocation) dependencies the handler needs from the loop. */
export interface DaemonOperatorContinuationDeps {
  operatorActionDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  workspaceSlug: string;
  projectSlug: string;
  /** The loop's cycle accumulator; mutated by push (ref-safe). */
  cycles: DaemonCycleRecord[];
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
  blockedResult: DaemonBlockedResultBuilder;
  runDaemonCodexTurn: DaemonCodexTurnRunner;
}

export interface DaemonOperatorContinuationInput {
  directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
  classification: ContinueAnalysisDirectiveClassification;
  cycle: number;
  activeRunId: string;
  activeTaskId: string;
}

/**
 * Handles an operator-required continuation directive: drains a matching queued
 * operator action (running a codex turn with the operator notes if present),
 * otherwise records the blocked continuation status / automation envelope and
 * returns a blocked result. Returns `undefined` when the loop should continue.
 */
export async function handleDaemonOperatorRequiredContinuation(
  input: DaemonOperatorContinuationInput,
  deps: DaemonOperatorContinuationDeps
): Promise<DaemonCommandResult | undefined> {
  const { cycle, activeRunId, activeTaskId } = input;
  const { operatorActionDir, cwd, env, now, workspaceSlug, projectSlug, cycles } = deps;

  let queuedOperatorActions: DaemonOperatorActionQueueEntry[];
  let failedOperatorActions: FailedDaemonOperatorActionQueueEntry[];
  try {
    const queueState = await readDaemonOperatorActionQueueState(operatorActionDir);
    queuedOperatorActions = queueState.entries;
    failedOperatorActions = queueState.failedEntries;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cycles.push({
      cycle,
      directiveKind: input.directive.kind,
      action: "blocked",
      runId: activeRunId,
      taskId: activeTaskId,
      sessionId: deps.getSessionId() ?? null,
      summary: `operator action queue error: ${message}`
    });

    return deps.blockedResult({
      blockerKind: "operator_required_continuation",
      reason: `operator action queue error: ${message}`,
      cycle,
      activeRunId,
      activeTaskId,
      directiveKind: input.directive.kind,
      nextActions: [...input.directive.nextActions]
    });
  }

  if (failedOperatorActions.length > 0) {
    await archiveFailedDaemonOperatorActionQueueEntries(failedOperatorActions, cwd, now().toISOString());
  }

  const matchingOperatorAction = queuedOperatorActions.find((entry) =>
    matchesDaemonOperatorContinuationAction({
      entry,
      runId: activeRunId,
      taskId: activeTaskId,
      directive: input.directive,
      classification: input.classification
    })
  );

  if (matchingOperatorAction) {
    await archiveConsumedDaemonOperatorActionQueueEntries([matchingOperatorAction], cwd);
    const codexResult = await deps.runDaemonCodexTurn({
      directive: input.directive,
      summaryAction: "run_codex_analysis",
      activeRunId,
      activeTaskId,
      operatorNotes: matchingOperatorAction.command.action.operatorNotes
    });
    return codexResult;
  }

  const providerSelection = selectLocalContinuationProvider({
    executionMode: input.classification.executionMode,
    continuationIntent: input.classification.continuationIntent,
    capabilities: resolveContinuationCapabilities(env)
  });
  const updatedAt = now().toISOString();
  await writeDaemonContinuationStatus(cwd, {
    state: "blocked",
    directiveKind: "continue_analysis",
    executionMode: "operator_required",
    targetId: input.directive.targetId,
    source: input.directive.source,
    sourceId:
      input.classification.action?.kind === "resume_target"
        ? input.classification.action.sourceId
        : undefined,
    actionKind: input.classification.action?.kind,
    provider: providerSelection.provider,
    wakeOwner: providerSelection.wakeOwner,
    scheduleKind: providerSelection.scheduleKind,
    schedule: providerSelection.schedule,
    summary: input.classification.summary,
    nextActions: [...input.directive.nextActions],
    blockers: [...input.directive.blockers],
    updatedAt
  });
  if (
    (providerSelection.provider === "claude_app_thread_automation" ||
      providerSelection.provider === "claude_app_standalone_automation" ||
      providerSelection.provider === "claude_cli_exec_scheduler") &&
    providerSelection.wakeOwner === "operator" &&
    providerSelection.scheduleKind !== "none" &&
    providerSelection.scheduleKind !== "manual" &&
    typeof providerSelection.schedule === "string" &&
    (input.classification.continuationIntent === "defer_same_thread" ||
      input.classification.continuationIntent === "defer_fresh_run") &&
    (input.directive.source === "checkpoint" || input.directive.source === "progress_proof")
  ) {
    await writeDaemonAutomationEnvelope(cwd, {
      provider: providerSelection.provider,
      wakeOwner: "operator",
      continuationIntent: input.classification.continuationIntent,
      targetMode: input.classification.continuationIntent === "defer_same_thread" ? "same_thread" : "fresh_run",
      scheduleKind: providerSelection.scheduleKind,
      schedule: providerSelection.schedule,
      targetId: input.directive.targetId,
      source: input.directive.source,
      sourceId:
        input.classification.action?.kind === "resume_target"
          ? input.classification.action.sourceId
          : undefined,
      summary: input.classification.summary,
      nextActions: [...input.directive.nextActions],
      workspaceSlug,
      projectSlug,
      activeRunId,
      activeTaskId,
      updatedAt
    });
  } else {
    await clearDaemonAutomationEnvelope(cwd);
  }
  cycles.push({
    cycle,
    directiveKind: input.directive.kind,
    action: "blocked",
    runId: activeRunId,
    taskId: activeTaskId,
    sessionId: deps.getSessionId() ?? null,
    summary: input.classification.summary
  });

  return deps.blockedResult({
    blockerKind: "operator_required_continuation",
    reason: input.classification.summary,
    cycle,
    activeRunId,
    activeTaskId,
    directiveKind: input.directive.kind,
    nextActions: [...input.directive.nextActions],
    detailFiles: {
      continuationStatus: ".archon/work/daemon/continuation-status.json",
      ...(providerSelection.provider === "claude_app_thread_automation" ||
      providerSelection.provider === "claude_app_standalone_automation" ||
      providerSelection.provider === "claude_cli_exec_scheduler"
        ? {
            automationEnvelope: ".archon/work/daemon/automation-envelope.json"
          }
        : {})
    }
  });
}
