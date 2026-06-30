/**
 * @module admin/close-run
 *
 * `archon close-run` — the manager/interactive surface for the closureLoop W1
 * terminal-closure reconciler. Dry-run by default (it mutates runtime state):
 * it advances gate-satisfied `approved` tasks to `done` (provenance-checked) and
 * seals fully-terminal runs.
 *
 * The reconcile orchestrator (`reconcileRunClosure`) is deps-injected so it can
 * be driven by this command AND, later, by the daemon's `complete`-directive
 * handler — the council's "both surfaces" condition. All gate logic lives in the
 * pure `planRunClosure` (core/closure-reconciler).
 */

import type {
  TaskRecord,
  RunRecord,
  ReviewRecord,
  ApprovalRecord,
  ReviewFloorReductionRecord,
  RunStatusSnapshot
} from "../domain/types.ts";
import {
  planRunClosure,
  buildTaskEvidence,
  type ClosurePlan,
  type ClosureTaskEvidence
} from "../core/closure-reconciler.ts";

export interface CloseRunDeps {
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getReviews: (runId: string, taskId: string) => Promise<ReviewRecord[]>;
  getApprovals: (runId: string, taskId: string) => Promise<ApprovalRecord[]>;
  getReviewFloorReductions: (runId: string, taskId: string) => Promise<ReviewFloorReductionRecord[]>;
  updateTask: (task: TaskRecord) => Promise<void>;
  updateRun: (run: RunRecord) => Promise<void>;
  /** Best-effort: clear the active-task pointer when a run is sealed (avoids a dangling pointer). */
  onRunSealed?: (runId: string) => Promise<void>;
  now: () => string;
  writeLine: (line: string) => void;
}

export interface CloseRunResult {
  plan: ClosurePlan;
  applied: boolean;
  sealedRun: boolean;
}

/**
 * Reconcile terminal closure for a run. Fetches per-task evidence, computes the
 * pure plan, prints it, and (only with `confirm`) advances closeable tasks to
 * `done` and seals the run when every task is terminal.
 */
export async function reconcileRunClosure(
  runId: string,
  confirm: boolean,
  deps: CloseRunDeps
): Promise<CloseRunResult> {
  const snapshot = await deps.getStatusSnapshot(runId);

  // Fetch evidence sequentially — a single pg client cannot multiplex queries.
  const evidence: ClosureTaskEvidence[] = [];
  for (const task of snapshot.tasks) {
    const taskId = task.packet.taskId;
    const reviews = await deps.getReviews(runId, taskId);
    const approvals = await deps.getApprovals(runId, taskId);
    const reductions = await deps.getReviewFloorReductions(runId, taskId);
    evidence.push(buildTaskEvidence(task, reviews, approvals, reductions));
  }

  const plan = planRunClosure(evidence);

  deps.writeLine(`close-run: ${confirm ? "CONFIRM" : "DRY-RUN"} (run ${runId})`);
  deps.writeLine(`  approved-but-not-closed: ${plan.closeable.length + plan.blocked.length}`);
  deps.writeLine(`  closeable → done (${plan.closeable.length}): ${plan.closeable.join(", ") || "(none)"}`);
  if (plan.blocked.length > 0) {
    deps.writeLine(`  BLOCKED (provenance gap — not advanced) (${plan.blocked.length}):`);
    for (const block of plan.blocked) {
      deps.writeLine(`    ${block.taskId}: ${block.reason}`);
    }
  }
  if (plan.nonTerminal.length > 0) {
    deps.writeLine(`  non-terminal (run not sealable) (${plan.nonTerminal.length}): ${plan.nonTerminal.join(", ")}`);
  }
  deps.writeLine(`  seal run: ${plan.sealRun ? "yes (all tasks terminal)" : "no"}`);

  if (!confirm) {
    deps.writeLine("  (dry-run — re-run with --confirm to advance closeable tasks and seal the run)");
    return { plan, applied: false, sealedRun: false };
  }

  if (plan.closeable.length === 0 && !plan.sealRun) {
    deps.writeLine("  nothing to close — exiting.");
    return { plan, applied: false, sealedRun: false };
  }

  const tasksById = new Map(snapshot.tasks.map((task) => [task.packet.taskId, task]));
  for (const taskId of plan.closeable) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    await deps.updateTask({ ...task, status: "done", updatedAt: deps.now() });
  }

  let sealedRun = false;
  // Idempotent: only seal a run that is not already terminal — re-running
  // close-run on a fully-closed run must not re-write the run or re-fire the
  // sealed hook.
  if (plan.sealRun && snapshot.run.status !== "done") {
    await deps.updateRun({ ...snapshot.run, status: "done", updatedAt: deps.now() });
    sealedRun = true;
    if (deps.onRunSealed) {
      await deps.onRunSealed(runId);
    }
  }

  deps.writeLine(`  advanced ${plan.closeable.length} task(s) to done.`);
  if (sealedRun) {
    deps.writeLine("  sealed the run (status → done).");
  } else if (plan.sealRun) {
    deps.writeLine("  run already sealed.");
  } else {
    deps.writeLine("  run left open (non-terminal or blocked tasks remain).");
  }
  return { plan, applied: true, sealedRun };
}

export interface CloseAllRunsResult {
  results: { runId: string; sealedRun: boolean; advanced: number }[];
  /** Runs actually sealed (always 0 in dry-run — sealing requires `confirm`). */
  sealedCount: number;
  /**
   * Sum of `plan.closeable.length` across runs. With `confirm` these are tasks
   * actually advanced to done; in dry-run they are the closeable CANDIDATES that
   * WOULD be advanced. (sealedCount is the confirm-only mutation counter.)
   */
  advancedCount: number;
}

/**
 * Batch closure: reconcile every supplied run id (the caller resolves these to
 * the project's non-terminal runs). Dry-run/confirm semantics are per-run via
 * `reconcileRunClosure`; this is a thin, deterministic loop over them.
 */
export async function reconcileAllRuns(
  runIds: readonly string[],
  confirm: boolean,
  deps: CloseRunDeps
): Promise<CloseAllRunsResult> {
  const results: CloseAllRunsResult["results"] = [];
  let sealedCount = 0;
  let wouldSealCount = 0;
  let advancedCount = 0;
  deps.writeLine(`close-run --all: ${confirm ? "CONFIRM" : "DRY-RUN"} over ${runIds.length} non-terminal run(s)`);
  for (const runId of runIds) {
    const result = await reconcileRunClosure(runId, confirm, deps);
    const advanced = result.plan.closeable.length;
    results.push({ runId, sealedRun: result.sealedRun, advanced });
    if (result.sealedRun) sealedCount += 1;
    if (result.plan.sealRun) wouldSealCount += 1;
    advancedCount += advanced;
  }
  deps.writeLine(
    confirm
      ? `close-run --all: sealed ${sealedCount}/${runIds.length} run(s); advanced ${advancedCount} task(s).`
      : `close-run --all: ${wouldSealCount}/${runIds.length} run(s) seal-ready; ${advancedCount} task(s) closeable.`
  );
  return { results, sealedCount, advancedCount };
}
