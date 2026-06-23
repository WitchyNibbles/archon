// Daemon split (loop-monolith decomposition, 6i): the dispatch_reviews directive
// handler, lifted out of executeDaemonCommandFromArgs.
//
// handleDaemonReviewDispatch used to be a ~237-line if-block inside the daemon
// loop. It is now a module-level function taking per-cycle inputs plus an
// explicit dependency bag. The loop keeps a thin wrapper closure that supplies
// the deps, so the call site stays behavior-preserving while the handler becomes
// independently testable.
//
// latestSessionId is read through `getSessionId` (a live getter, NOT a captured
// value). The review-dispatch handler only READS the session id — it never
// writes it back. The getter is still required so it observes whatever value
// runDaemonCodexTurn may have written earlier in the same cycle.
//
// Review-queue helpers are imported directly (NOT threaded through the deps bag)
// following the pattern established in operator-continuation.ts.
import path from "node:path";
import type { RunExecutionPlan } from "../domain/types.ts";
import type {
  DirectiveExecutionResult,
  ExecuteDirectiveStepOptions
} from "../core/service.ts";
import type { RecordReviewCommandInput } from "../review.ts";
import {
  archiveConsumedDaemonReviewQueueEntries,
  archiveFailedDaemonReviewQueueEntries,
  archiveStaleDaemonReviewQueueEntries,
  readDaemonReviewQueueState
} from "./review-queue.ts";
import { writeDaemonReviewQueueStatus } from "./state-writers.ts";
import type {
  DaemonReviewQueueEntry,
  FailedDaemonReviewQueueEntry,
  StaleDaemonReviewQueueEntry
} from "./review-queue.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type { DaemonCommandResult, DaemonCycleRecord } from "../daemon.ts";
import type { DaemonBlockedResultBuilder } from "./codex-turn.ts";

/** Callback type alias matching the optional executeDirectiveStep surface. */
export type ExecuteDirectiveStepFn = (
  runId: string,
  input: Omit<ExecuteDirectiveStepOptions, "executeReviewRecommendation"> & {
    reviewCommands: readonly RecordReviewCommandInput[];
  }
) => Promise<DirectiveExecutionResult>;

/** Per-cycle inputs the handler receives from the loop. */
export interface DaemonReviewDispatchInput {
  directive: Extract<RunExecutionPlan["directive"], { kind: "dispatch_reviews" }>;
  cycle: number;
  activeRunId: string;
  activeTaskId: string;
  now: () => Date;
  cwd: string;
  reviewInputDir: string;
}

/** Stable (per-invocation) dependencies the handler needs from the loop. */
export interface DaemonReviewDispatchDeps {
  /** Optional — when absent the handler immediately returns review_execution_unsupported. */
  executeDirectiveStep: ExecuteDirectiveStepFn | undefined;
  staleAfterHours: number;
  /** The loop's cycle accumulator; mutated by push (ref-safe). */
  cycles: DaemonCycleRecord[];
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
  blockedResult: DaemonBlockedResultBuilder;
}

/**
 * Handles a dispatch_reviews directive: drains usable review action files from
 * the review input queue, dispatches them via executeDirectiveStep, archives
 * consumed/failed/stale entries, and writes a queue status file. Returns a
 * blocked result when the queue is empty, unsupported, or no dispatched step
 * matched; returns `undefined` (the continue signal) when reviews were applied.
 */
export async function handleDaemonReviewDispatch(
  input: DaemonReviewDispatchInput,
  deps: DaemonReviewDispatchDeps
): Promise<DaemonCommandResult | undefined> {
  const { directive, cycle, activeRunId, activeTaskId, now, cwd, reviewInputDir } = input;
  const { cycles } = deps;

  if (!deps.executeDirectiveStep) {
    cycles.push({
      cycle,
      directiveKind: directive.kind,
      action: "blocked",
      runId: activeRunId,
      taskId: activeTaskId,
      sessionId: deps.getSessionId() ?? null,
      summary: "runtime surface does not support authenticated review execution"
    });

    return deps.blockedResult({
      blockerKind: "review_execution_unsupported",
      reason: "required authenticated reviews block the active run",
      cycle,
      activeRunId,
      activeTaskId,
      directiveKind: directive.kind,
      nextActions: []
    });
  }

  let queuedReviewEntries: DaemonReviewQueueEntry[];
  let failedReviewEntries: FailedDaemonReviewQueueEntry[];
  try {
    const queueState = await readDaemonReviewQueueState(reviewInputDir);
    queuedReviewEntries = queueState.entries;
    failedReviewEntries = queueState.failedEntries;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cycles.push({
      cycle,
      directiveKind: directive.kind,
      action: "blocked",
      runId: activeRunId,
      taskId: activeTaskId,
      sessionId: deps.getSessionId() ?? null,
      summary: `review input queue error: ${message}`
    });

    return deps.blockedResult({
      blockerKind: "review_queue",
      reason: `review input queue error: ${message}`,
      cycle,
      activeRunId,
      activeTaskId,
      directiveKind: directive.kind,
      nextActions: []
    });
  }

  const expectedReviewTargets = directive.recommendations.map(
    (recommendation) => `${recommendation.taskId}:${recommendation.targetReviewRole ?? "unknown"}`
  );
  if (failedReviewEntries.length > 0) {
    const timestamp = now().toISOString();
    await archiveFailedDaemonReviewQueueEntries(failedReviewEntries, cwd, timestamp);
    await writeDaemonReviewQueueStatus(cwd, {
      state: "failed",
      reviewInputDir,
      reason: `${failedReviewEntries.length} queued review action file(s) were invalid and moved to failed-review-actions`,
      expectedReviewTargets,
      queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
      failedFiles: failedReviewEntries.map((entry) => ({
        file: path.basename(entry.filePath),
        error: entry.error
      })),
      updatedAt: timestamp
    });
  }

  if (queuedReviewEntries.length === 0) {
    await writeDaemonReviewQueueStatus(cwd, {
      state: failedReviewEntries.length > 0 ? "failed" : "blocked",
      reviewInputDir,
      reason: `required authenticated reviews are pending; no usable review action files were found in ${reviewInputDir}`,
      expectedReviewTargets,
      failedFiles: failedReviewEntries.map((entry) => ({
        file: path.basename(entry.filePath),
        error: entry.error
      })),
      updatedAt: now().toISOString()
    });
    cycles.push({
      cycle,
      directiveKind: directive.kind,
      action: "blocked",
      runId: activeRunId,
      taskId: activeTaskId,
      sessionId: deps.getSessionId() ?? null,
      summary: `required authenticated reviews are pending; no review action files were found in ${reviewInputDir}`
    });

    return deps.blockedResult({
      blockerKind: "review_queue",
      reason: "required authenticated reviews block the active run",
      cycle,
      activeRunId,
      activeTaskId,
      directiveKind: directive.kind,
      nextActions: [],
      detailFiles: {
        reviewQueueStatus: ".archon/work/daemon/review-queue-status.json"
      }
    });
  }

  const executionResult = await deps.executeDirectiveStep(activeRunId, {
    staleAfterHours: deps.staleAfterHours,
    reviewCommands: queuedReviewEntries.map((entry) => entry.command)
  });

  const consumedEntries: DaemonReviewQueueEntry[] = [];
  const staleEntries: StaleDaemonReviewQueueEntry[] = [];
  for (const step of executionResult.steps) {
    if (
      step.directiveKind !== "dispatch_reviews" ||
      step.outcome !== "executed" ||
      !step.taskId ||
      !step.reviewRole
    ) {
      continue;
    }

    const matchIndex = queuedReviewEntries.findIndex(
      (entry) =>
        entry.command.runId === activeRunId &&
        entry.command.taskId === step.taskId &&
        entry.command.review.reviewerRole === step.reviewRole &&
        (step.actor ? entry.command.actor === step.actor : true)
    );
    if (matchIndex >= 0) {
      const consumed = queuedReviewEntries.splice(matchIndex, 1)[0]!;
      consumedEntries.push(consumed);
    }

    cycles.push({
      cycle,
      directiveKind: directive.kind,
      action: "record_review",
      runId: activeRunId,
      taskId: step.taskId,
      sessionId: deps.getSessionId() ?? null,
      summary: `recorded ${step.reviewRole}${step.actor ? ` via ${step.actor}` : ""}`
    });
  }

  if (consumedEntries.length > 0) {
    await archiveConsumedDaemonReviewQueueEntries(consumedEntries, cwd);
  }

  if (queuedReviewEntries.length > 0) {
    staleEntries.push(
      ...queuedReviewEntries.map((entry) => ({
        filePath: entry.filePath,
        reason: "queued review action no longer matched the active runtime review directives"
      }))
    );
    await archiveStaleDaemonReviewQueueEntries(
      staleEntries,
      cwd,
      now().toISOString(),
      expectedReviewTargets
    );
    queuedReviewEntries = [];
  }

  if (!executionResult.steps.some((step) => step.directiveKind === "dispatch_reviews" && step.outcome === "executed")) {
    const unsupportedStep = executionResult.steps.find((step) => step.directiveKind === "dispatch_reviews");
    const mismatchReason =
      staleEntries.length > 0
        ? `queued review actions did not match the pending runtime review directives from ${reviewInputDir}`
        : undefined;
    const detailedReason =
      unsupportedStep?.evidence.join(" | ") ||
      `queued review actions did not match the pending runtime review directives from ${reviewInputDir}`;
    await writeDaemonReviewQueueStatus(cwd, {
      state: "blocked",
      reviewInputDir,
      reason: mismatchReason ? `${mismatchReason}: ${detailedReason}` : detailedReason,
      expectedReviewTargets,
      queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
      failedFiles: failedReviewEntries.map((entry) => ({
        file: path.basename(entry.filePath),
        error: entry.error
      })),
      staleFiles: staleEntries.map((entry) => ({
        file: path.basename(entry.filePath),
        reason: entry.reason
      })),
      updatedAt: now().toISOString()
    });
    cycles.push({
      cycle,
      directiveKind: directive.kind,
      action: "blocked",
      runId: activeRunId,
      taskId: activeTaskId,
      sessionId: deps.getSessionId() ?? null,
      summary:
        mismatchReason ? `${mismatchReason}: ${detailedReason}` : detailedReason
    });

    return deps.blockedResult({
      blockerKind: "review_queue",
      reason: "required authenticated reviews block the active run",
      cycle,
      activeRunId,
      activeTaskId,
      directiveKind: directive.kind,
      nextActions: [],
      detailFiles: {
        reviewQueueStatus: ".archon/work/daemon/review-queue-status.json"
      }
    });
  }

  await writeDaemonReviewQueueStatus(cwd, {
    state: "processed",
    reviewInputDir,
    reason: "queued authenticated review actions were applied",
    expectedReviewTargets,
    consumedFiles: consumedEntries.map((entry) => path.basename(entry.filePath)),
    queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
    failedFiles: failedReviewEntries.map((entry) => ({
      file: path.basename(entry.filePath),
      error: entry.error
    })),
    staleFiles: staleEntries.map((entry) => ({
      file: path.basename(entry.filePath),
      reason: entry.reason
    })),
    updatedAt: now().toISOString()
  });

  return undefined;
}
