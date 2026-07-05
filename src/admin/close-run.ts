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
  /**
   * Best-effort: clear the active-task pointer when a run is sealed (avoids a
   * dangling pointer). `sealedTaskKeys` are the task keys that just went terminal
   * in the sealed run — the caller uses them to clear a pointer whose task key
   * matches even when the pointer has moved to a different run (closureLoop bug 3).
   */
  onRunSealed?: (runId: string, sealedTaskKeys: readonly string[]) => Promise<void>;
  now: () => string;
  writeLine: (line: string) => void;
}

/**
 * Should a sealed run clear the dangling active-task pointer?
 *
 * Original rule: clear only when the pointer's run is the run being sealed. That
 * missed the case where a duplicate/fork moved the pointer to another run while
 * the ORIGINAL run (holding the same task key) was the one sealed — the stale
 * active_task_id then survived (closureLoop bug 3; live 2026-07-04). The pointer
 * identifies work by task KEY, so also clear when the pointer's active_task_id
 * matches a task key that just went terminal in the sealed run, regardless of
 * which run the pointer currently holds. In the healthy single-run case both
 * conditions coincide, so this is purely additive for the cross-run case.
 */
export function shouldClearDanglingActiveTaskPointer(input: {
  activeRunId: string | null | undefined;
  activeTaskId: string | null | undefined;
  sealedRunId: string;
  sealedTaskKeys: readonly string[];
}): boolean {
  if (!input.activeTaskId) {
    return false;
  }
  if (input.activeRunId === input.sealedRunId) {
    return true;
  }
  return input.sealedTaskKeys.includes(input.activeTaskId);
}

/**
 * Accept BOTH the `--confirm` (close-run's native) and `--apply`
 * (reconcile-runtime-state's native) mutate flags, so the two closure commands
 * share one mutate-vs-dry-run vocabulary. Alias only — no breaking change.
 */
export function isMutateConfirmed(args: readonly string[]): boolean {
  return args.includes("--confirm") || args.includes("--apply");
}

export interface CloseRunResult {
  plan: ClosurePlan;
  applied: boolean;
  sealedRun: boolean;
}

/**
 * Explicit escape hatch for sealing a run with no recorded retro decision.
 * Requires a non-empty, human-readable `reason` — there is no silent bypass.
 */
export interface AcknowledgeNoRetro {
  reason: string;
}

export interface ReconcileRunClosureOptions {
  /**
   * Bypasses the retro-required seal gate (auditP3RetroLoop fix #1) with an
   * explicit, recorded reason. The reason is printed to the operator-visible
   * log so the bypass is auditable, not silent.
   */
  acknowledgeNoRetro?: AcknowledgeNoRetro | undefined;
}

const RETRO_COMMAND_HINT =
  "npx tsx ./src/admin.ts record-retro --task-id <id> " +
  "--outcome <memory_promoted|skill_patched|discarded|postmortem_filed|nothing_to_promote> --source orchestrator";

function hasRecordedRetroDecision(tasks: readonly TaskRecord[]): boolean {
  return tasks.some((task) => {
    const outcome = task.packet.retroOutcome;
    return typeof outcome === "string" && outcome.trim().length > 0;
  });
}

/**
 * Reconcile terminal closure for a run. Fetches per-task evidence, computes the
 * pure plan, prints it, and (only with `confirm`) advances closeable tasks to
 * `done` and seals the run when every task is terminal.
 *
 * Sealing is gated on a real, auditable retro decision (auditP3RetroLoop fix
 * #1): at least one task in the run must carry a `packet.retroOutcome` recorded
 * via `record-retro`, or the caller must pass an explicit `acknowledgeNoRetro`
 * reason. This is the one concrete chokepoint this module already owns — it is
 * intentionally NOT wired into the universal per-task workflow-proof check or
 * task-activation flow, which would retroactively block every other in-flight
 * task across the repo that has never recorded a retro decision.
 */
export async function reconcileRunClosure(
  runId: string,
  confirm: boolean,
  deps: CloseRunDeps,
  options?: ReconcileRunClosureOptions
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
  // Retro decision recorded on ANY task in this run counts (an initiative
  // typically closes with one retro pass covering the whole run's slice).
  let retroBlocked = false;
  let retroAcknowledgedReason: string | undefined;
  // Idempotent: only seal a run that is not already terminal — re-running
  // close-run on a fully-closed run must not re-write the run or re-fire the
  // sealed hook.
  if (plan.sealRun && snapshot.run.status !== "done") {
    const acknowledge = options?.acknowledgeNoRetro;
    const retroRecorded = hasRecordedRetroDecision(snapshot.tasks);
    if (!retroRecorded && (!acknowledge || acknowledge.reason.trim().length === 0)) {
      // Real, auditable gate (auditP3RetroLoop fix #1): do NOT seal. No task in
      // this run has a recorded retro decision, and no (non-empty) explicit
      // acknowledgement was supplied — there is no silent bypass.
      retroBlocked = true;
    } else {
      if (!retroRecorded && acknowledge) {
        retroAcknowledgedReason = acknowledge.reason;
      }
      await deps.updateRun({ ...snapshot.run, status: "done", updatedAt: deps.now() });
      sealedRun = true;
      if (deps.onRunSealed) {
        // A sealed run means every task in it is terminal; the full key set is what
        // the pointer clear matches against (cross-run stale-pointer case).
        const sealedTaskKeys = snapshot.tasks.map((task) => task.packet.taskId);
        await deps.onRunSealed(runId, sealedTaskKeys);
      }
    }
  }

  deps.writeLine(`  advanced ${plan.closeable.length} task(s) to done.`);
  if (sealedRun) {
    if (retroAcknowledgedReason !== undefined) {
      deps.writeLine(`  retro gap acknowledged: ${retroAcknowledgedReason}`);
    }
    deps.writeLine("  sealed the run (status → done).");
    // Learning loop (audit F5): a sealed run is an initiative-closure moment —
    // nudge the operator to run the retro before the next initiative so the
    // learning compounds instead of being lost. Emitted only on an actual seal
    // (sealedRun === true), never on dry-run or an already-sealed re-run.
    deps.writeLine(
      `  next: run \`${RETRO_COMMAND_HINT}\` to record the promotion decision ` +
        "(repo facts → .archon/memory/, process lessons → /archon-skill-evolution, or an explicit " +
        "\"nothing to promote\") before starting the next initiative."
    );
  } else if (retroBlocked) {
    deps.writeLine("  BLOCKED: no task in this run has recorded a retro decision (packet.retroOutcome).");
    deps.writeLine(`  next: run \`${RETRO_COMMAND_HINT}\` first,`);
    deps.writeLine(
      "  or re-run close-run with --acknowledge-no-retro \"<reason>\" to explicitly acknowledge the gap (no silent bypass)."
    );
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
  deps: CloseRunDeps,
  options?: ReconcileRunClosureOptions
): Promise<CloseAllRunsResult> {
  const results: CloseAllRunsResult["results"] = [];
  let sealedCount = 0;
  let wouldSealCount = 0;
  let advancedCount = 0;
  deps.writeLine(`close-run --all: ${confirm ? "CONFIRM" : "DRY-RUN"} over ${runIds.length} non-terminal run(s)`);
  for (const runId of runIds) {
    const result = await reconcileRunClosure(runId, confirm, deps, options);
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
