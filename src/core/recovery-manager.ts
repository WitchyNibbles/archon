// Recovery inspection + application manager.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4).
// This is slice 4 of the ArchonCoreService decomposition and owns the recovery
// cluster (plan seam S5): inspectRecovery (advisory-only issue/action derivation)
// and applyRecovery (safe-action mutation), plus the two cluster-only free
// functions they use — parseHoursSince and dedupeById.
//
// CLOSURE WIRING (audit F5, slice 3 note preserved). inspectRecovery and
// getStatus are mutually referencing runtime closures, bound by the owning class:
//   - This manager depends on `getStatus` (injected). Both inspectRecovery and
//     applyRecovery read the status snapshot through it.
//   - StatusExecutionPlanner.getExecutionPlan depends on `inspectRecovery`; the
//     class injects `(runId, opts) => this.recovery.inspectRecovery(...)` into the
//     planner. The reverse edge — this manager's getStatus — resolves to
//     `(runId) => this.statusPlanner.getStatus(runId)`.
// Both directions are closures bound by ArchonCoreService, so no
// service.ts / recovery-manager.ts / status-execution-planner.ts import cycle
// forms. This module imports only leaf helpers (policy, project-runtime-state)
// and domain types.
//
// AUTHORITY NOTE: every issue and action this manager emits carries
// authorityLabel "derived_only" and mode "advisory_only" — recovery never writes
// trusted completion authority. applyRecovery only performs the safe, reversible
// state transitions the operator selects (reset stalled task, reblock stale
// approval, release orphan lock); request_missing_reviews is never auto-applied
// (safeToApply: false). This authority boundary is unchanged by the extraction.

import {
  collectUnsatisfiedReviewRoles,
  evaluateReviewDecision
} from "./policy.ts";
import { timestamp } from "./project-runtime-state.ts";
import type { ArchonStore } from "../store/types.ts";
import type {
  RecoveryAction,
  RecoveryApplyResult,
  RecoveryInspectionReport,
  RecoveryIssue,
  RunRecord,
  RunStatusSnapshot,
  TaskRecord
} from "../domain/types.ts";

function parseHoursSince(createdAt: string, now: string): number | undefined {
  const createdAtMs = Date.parse(createdAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(createdAtMs) || Number.isNaN(nowMs) || nowMs < createdAtMs) {
    return undefined;
  }

  return Number(((nowMs - createdAtMs) / (1000 * 60 * 60)).toFixed(2));
}

function dedupeById<T extends { id: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }

    seen.add(entry.id);
    deduped.push(entry);
  }

  return deduped;
}

export interface RecoveryManagerDeps {
  store: ArchonStore;
  requireRun: (runId: string) => Promise<RunRecord>;
  requireTask: (runId: string, taskId: string) => Promise<TaskRecord>;
  getStatus: (runId: string) => Promise<RunStatusSnapshot>;
  syncRunState: (runId: string) => Promise<void>;
}

export class RecoveryManager {
  private readonly store: ArchonStore;
  private readonly requireRun: (runId: string) => Promise<RunRecord>;
  private readonly requireTask: (runId: string, taskId: string) => Promise<TaskRecord>;
  private readonly getStatus: (runId: string) => Promise<RunStatusSnapshot>;
  private readonly syncRunState: (runId: string) => Promise<void>;

  constructor(deps: RecoveryManagerDeps) {
    this.store = deps.store;
    this.requireRun = deps.requireRun;
    this.requireTask = deps.requireTask;
    this.getStatus = deps.getStatus;
    this.syncRunState = deps.syncRunState;
  }

  async inspectRecovery(
    runId: string,
    options: {
      staleAfterHours?: number | undefined;
      now?: string | undefined;
    } = {}
  ): Promise<RecoveryInspectionReport> {
    const staleAfterHours = options.staleAfterHours ?? 24;
    if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
      throw new Error(`staleAfterHours must be a non-negative integer: ${staleAfterHours}`);
    }

    const snapshot = await this.getStatus(runId);
    const now = options.now ?? timestamp();
    const issues: RecoveryIssue[] = [];
    const actions: RecoveryAction[] = [];
    const taskById = new Map(snapshot.tasks.map((task) => [task.packet.taskId, task]));

    for (const task of snapshot.tasks) {
      const ageHours = parseHoursSince(task.updatedAt, now);
      const reviews = await this.store.getReviews(runId, task.packet.taskId);
      const handoffs = await this.store.getHandoffs(runId, task.packet.taskId);

      if (task.status === "in_progress" && ageHours !== undefined && ageHours >= staleAfterHours) {
        const actionId = `reset-task:${task.packet.taskId}`;
        issues.push({
          id: `stalled-task:${task.packet.taskId}`,
          authorityLabel: "derived_only",
          kind: "stalled_task",
          taskId: task.packet.taskId,
          ageHours,
          details: [
            `task has been in progress for ${ageHours} hours`,
            task.claimedBy ? `claimed by ${task.claimedBy}` : "task is unclaimed"
          ],
          suggestedActionIds: handoffs.length === 0 ? [actionId] : []
        });

        if (handoffs.length === 0) {
          actions.push({
            id: actionId,
            authorityLabel: "derived_only",
            kind: "reset_task_to_ready",
            taskId: task.packet.taskId,
            safeToApply: true,
            rationale: [
              "stalled in-progress task has no recorded handoff",
              "safe reset releases writer lock and requeues the task"
            ]
          });
        }
      }

      if (task.status === "review_blocked" && ageHours !== undefined && ageHours >= staleAfterHours) {
        const missingReviewRoles = collectUnsatisfiedReviewRoles(task, reviews);
        if (missingReviewRoles.length > 0) {
          const actionId = `request-reviews:${task.packet.taskId}`;
          issues.push({
            id: `stale-review:${task.packet.taskId}`,
            authorityLabel: "derived_only",
            kind: "stale_review_block",
            taskId: task.packet.taskId,
            ageHours,
            details: [
              `task has been waiting on review for ${ageHours} hours`,
              `missing reviews: ${missingReviewRoles.join(", ")}`
            ],
            suggestedActionIds: [actionId]
          });
          actions.push({
            id: actionId,
            authorityLabel: "derived_only",
            kind: "request_missing_reviews",
            taskId: task.packet.taskId,
            safeToApply: false,
            rationale: [
              `missing authenticated reviews: ${missingReviewRoles.join(", ")}`,
              "operator action required; no state change is applied automatically"
            ]
          });
        }
      }

      if (task.status === "approved") {
        const decision = evaluateReviewDecision(task, reviews);
        if (decision.decision !== "approved") {
          const actionId = `reblock-approved:${task.packet.taskId}`;
          issues.push({
            id: `stale-approval:${task.packet.taskId}`,
            authorityLabel: "derived_only",
            kind: "stale_approval",
            taskId: task.packet.taskId,
            details: [`approval is stale: ${decision.blockers.join("; ")}`],
            suggestedActionIds: [actionId]
          });
          actions.push({
            id: actionId,
            authorityLabel: "derived_only",
            kind: "reblock_stale_approval",
            taskId: task.packet.taskId,
            safeToApply: true,
            rationale: [
              "task is approved but current review evidence no longer satisfies required gates",
              "safe reblock restores explicit review state before routing dependents"
            ]
          });
        }
      }
    }

    for (const lock of snapshot.activeLocks) {
      const task = taskById.get(lock.taskId);
      if (task && (task.status === "in_progress" || task.status === "review_blocked")) {
        continue;
      }

      const actionId = `release-lock:${lock.taskId}`;
      issues.push({
        id: `orphan-lock:${lock.taskId}`,
        authorityLabel: "derived_only",
        kind: "orphan_lock",
        taskId: task?.packet.taskId,
        lockTaskId: lock.taskId,
        ageHours: parseHoursSince(lock.createdAt, now),
        details: [
          `active lock exists for ${lock.taskId}`,
          task ? `task status is ${task.status}` : "task no longer exists for this active lock"
        ],
        suggestedActionIds: [actionId]
      });
      actions.push({
        id: actionId,
        authorityLabel: "derived_only",
        kind: "release_orphan_lock",
        taskId: lock.taskId,
        safeToApply: true,
        rationale: [
          "active lock does not correspond to an in-progress task",
          "safe release restores routing capacity without approving work"
        ]
      });
    }

    const uniqueIssues = dedupeById(issues);
    const uniqueActions = dedupeById(actions);

    return {
      mode: "advisory_only",
      runId: snapshot.run.id,
      staleAfterHours,
      issues: uniqueIssues,
      actions: uniqueActions,
      summary: {
        totalIssues: uniqueIssues.length,
        safeActions: uniqueActions.filter((action) => action.safeToApply).length,
        blockedTasks: uniqueIssues.flatMap((issue) => (issue.taskId ? [issue.taskId] : [])),
        staleTaskIds: uniqueIssues
          .filter((issue) => issue.kind === "stalled_task" || issue.kind === "stale_review_block")
          .flatMap((issue) => (issue.taskId ? [issue.taskId] : [])),
        orphanLockTaskIds: uniqueIssues
          .filter((issue) => issue.kind === "orphan_lock")
          .flatMap((issue) => (issue.lockTaskId ? [issue.lockTaskId] : []))
      }
    };
  }

  async applyRecovery(
    runId: string,
    actionIds: readonly string[],
    options: {
      staleAfterHours?: number | undefined;
      now?: string | undefined;
    } = {}
  ): Promise<RecoveryApplyResult> {
    const inspection = await this.inspectRecovery(runId, options);
    const selectableActionIds =
      actionIds.length > 0
        ? new Set(actionIds)
        : new Set(inspection.actions.filter((action) => action.safeToApply).map((action) => action.id));
    const actionMap = new Map(inspection.actions.map((action) => [action.id, action]));
    const appliedActionIds: string[] = [];
    const skippedActionIds: string[] = [];
    const appliedAt = options.now ?? timestamp();

    for (const actionId of selectableActionIds) {
      const action = actionMap.get(actionId);
      if (!action || !action.taskId) {
        skippedActionIds.push(actionId);
        continue;
      }

      if (!action.safeToApply) {
        skippedActionIds.push(actionId);
        continue;
      }

      if (action.kind === "release_orphan_lock") {
        const run = await this.requireRun(runId);
        const ownerLock = (await this.store.getActiveLocks(run.projectId)).find(
          (lock) => lock.taskId === action.taskId && lock.status === "active"
        );
        await this.store.releaseLocksForTask(ownerLock?.runId ?? runId, action.taskId, appliedAt);
        appliedActionIds.push(actionId);
        continue;
      }

      const task = await this.requireTask(runId, action.taskId);
      if (action.kind === "reset_task_to_ready") {
        const handoffs = await this.store.getHandoffs(runId, action.taskId);
        if (task.status !== "in_progress" || handoffs.length > 0) {
          skippedActionIds.push(actionId);
          continue;
        }

        await this.store.updateTask({
          ...task,
          status: "ready",
          claimedBy: undefined,
          updatedAt: appliedAt
        });
        await this.store.releaseLocksForTask(runId, action.taskId, appliedAt);
        appliedActionIds.push(actionId);
        continue;
      }

      if (action.kind === "reblock_stale_approval") {
        if (task.status !== "approved") {
          skippedActionIds.push(actionId);
          continue;
        }

        await this.store.updateTask({
          ...task,
          status: "review_blocked",
          updatedAt: appliedAt
        });
        appliedActionIds.push(actionId);
        continue;
      }

      skippedActionIds.push(actionId);
    }

    await this.syncRunState(runId);

    return {
      mode: "applied",
      runId,
      appliedActionIds,
      skippedActionIds,
      snapshot: await this.getStatus(runId)
    };
  }
}
