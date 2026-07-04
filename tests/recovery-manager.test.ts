/**
 * Direct unit tests for RecoveryManager (src/core/recovery-manager.ts).
 *
 * This module was extracted from ArchonCoreService (audit F5 / service.ts split
 * slice 4). These tests exercise the manager class DIRECTLY against a MemoryStore
 * double + injected deps (requireRun / requireTask / getStatus / syncRunState),
 * so a drift in recovery issue/action derivation or the safe-apply mutation path
 * fails here rather than only through the service-level suites.
 *
 * Coverage targets the cold paths the service-level suites don't isolate:
 *   - inspectRecovery: staleAfterHours validation guard; stalled_task with and
 *     without a recorded handoff (suggestedActionIds / reset-action gating);
 *     stale_review_block (unsafe action); orphan_lock derivation + summary
 *     aggregation.
 *   - applyRecovery: reset_task_to_ready (task → ready, lock released);
 *     release_orphan_lock; skip on unknown actionId; skip on an explicitly
 *     selected unsafe action (request_missing_reviews stays operator-only).
 *
 * getStatus is wired to a real StatusExecutionPlanner over the SAME store so the
 * manager reads real derived snapshots rather than hand-built fixtures.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { RecoveryManager } from "../src/core/recovery-manager.ts";
import { StatusExecutionPlanner } from "../src/core/status-execution-planner.ts";
import { TaskLifecycleManager } from "../src/core/task-lifecycle.ts";
import { AutonomousExecutionStore } from "../src/core/autonomous-execution-store.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import { findBlockingReasonsForTask, findTaskDependencies, evaluateReviewDecision } from "../src/core/policy.ts";
import type { ArchonStore } from "../src/store/types.ts";
import type {
  LockRecord,
  RunRecord,
  TaskPacketInput,
  TaskRecord
} from "../src/domain/types.ts";

interface Harness {
  store: ArchonStore;
  recovery: RecoveryManager;
  lifecycle: TaskLifecycleManager;
}

function makeHarness(): Harness {
  const store = new MemoryStore();
  const requireRun = async (runId: string): Promise<RunRecord> => {
    const found = await store.getRun(runId);
    if (!found) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return found;
  };
  const requireTask = async (runId: string, taskId: string): Promise<TaskRecord> => {
    const found = await store.getTask(runId, taskId);
    if (!found) {
      throw new Error(`Unknown task ${taskId} for run ${runId}`);
    }
    return found;
  };
  const autonomous = new AutonomousExecutionStore({ store, requireRun });
  // Real blocker derivation (including stale-dependency reblock) so the planner
  // snapshot the recovery manager reads is production-shaped.
  const findTaskBlockers = async (
    task: TaskRecord,
    allTasks: readonly TaskRecord[],
    activeLocks: readonly LockRecord[]
  ): Promise<string[]> => {
    const blockers = findBlockingReasonsForTask(task, allTasks, activeLocks);
    for (const dependency of findTaskDependencies(task.packet, allTasks)) {
      if (dependency.status !== "approved") {
        continue;
      }
      const reviews = await store.getReviews(dependency.runId, dependency.packet.taskId);
      const decision = evaluateReviewDecision(dependency, reviews);
      if (decision.decision !== "approved") {
        blockers.push(`dependency ${dependency.packet.taskId} has stale approval`);
      }
    }
    return blockers;
  };
  const lifecycle = new TaskLifecycleManager({
    store,
    requireRun,
    requireTask,
    findTaskBlockers,
    saveAutonomousExecutionState: (run, update) => autonomous.saveState(run, update)
  });
  const planner = new StatusExecutionPlanner({
    store,
    requireRun,
    findTaskBlockers,
    // recovery is the OTHER half of the closure pair; the planner only calls
    // inspectRecovery from getExecutionPlan, which these tests don't exercise.
    inspectRecovery: (runId) => recovery.inspectRecovery(runId)
  });
  const recovery = new RecoveryManager({
    store,
    requireRun,
    requireTask,
    getStatus: (runId) => planner.getStatus(runId),
    syncRunState: (runId) => lifecycle.syncRunState(runId)
  });

  return { store, recovery, lifecycle };
}

function makePacket(overrides: Partial<TaskPacketInput> & { taskId: string }): TaskPacketInput {
  return {
    title: `Task ${overrides.taskId}`,
    ownerRole: "backend_engineer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["backend_engineer"],
    qualityGates: ["product_acceptance"],
    goal: "test goal",
    inputs: [],
    outputs: [],
    dependencies: [],
    allowedWriteScope: ["src/"],
    outOfScope: [],
    acceptanceCriteria: ["passes tests"],
    verificationSteps: ["npm test"],
    securityChecks: ["validate inputs"],
    antiPatterns: ["no hardcoded secrets"],
    rollbackNotes: "revert to previous state",
    handoffFormat: "summary only",
    requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"],
    reasoningPolicy: { mode: "legacy" },
    ...overrides
  };
}

async function seedRun(lifecycle: TaskLifecycleManager, slug: string): Promise<string> {
  const run = await lifecycle.intakeRequest({
    workspaceSlug: `ws-${slug}`,
    projectSlug: `proj-${slug}`,
    actor: "manager",
    title: `recovery test run ${slug}`,
    request: "exercise the extracted recovery manager directly"
  });
  return run.id;
}

// hours-in-the-future timestamp so age >= staleAfterHours (default 24).
function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

// ────────────────────────────────────────────────────────────────────────────
// inspectRecovery — validation guard
// ────────────────────────────────────────────────────────────────────────────

test("inspectRecovery: negative staleAfterHours throws", async () => {
  const { recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "neg");
  await assert.rejects(
    () => recovery.inspectRecovery(runId, { staleAfterHours: -1 }),
    /staleAfterHours must be a non-negative integer/
  );
});

test("inspectRecovery: non-integer staleAfterHours throws", async () => {
  const { recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "frac");
  await assert.rejects(
    () => recovery.inspectRecovery(runId, { staleAfterHours: 2.5 }),
    /staleAfterHours must be a non-negative integer/
  );
});

// ────────────────────────────────────────────────────────────────────────────
// inspectRecovery — stalled_task
// ────────────────────────────────────────────────────────────────────────────

test("inspectRecovery: stalled in-progress task with no handoff → issue + safe reset action", async () => {
  const { recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "stalled");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  await lifecycle.claimTask(runId, "task-a", "backend_engineer");

  const report = await recovery.inspectRecovery(runId, { now: hoursFromNow(48) });

  const issue = report.issues.find((i) => i.kind === "stalled_task");
  assert.ok(issue, "stalled_task issue derived");
  assert.equal(issue?.taskId, "task-a");
  assert.deepEqual(issue?.suggestedActionIds, ["reset-task:task-a"]);
  const action = report.actions.find((a) => a.kind === "reset_task_to_ready");
  assert.ok(action?.safeToApply, "reset action is safe to apply");
  assert.equal(report.summary.safeActions, 1);
  assert.deepEqual(report.summary.staleTaskIds, ["task-a"]);
});

test("inspectRecovery: stalled in-progress task WITH a handoff → issue but no reset action", async () => {
  const { store, recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "stalledhandoff");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  const claimed = await lifecycle.claimTask(runId, "task-a", "backend_engineer");
  // Record a handoff directly against the still-in-progress task to exercise the
  // handoffs.length !== 0 branch (suggestedActionIds empty, no reset action).
  await store.saveHandoff({
    id: randomUUID(),
    runId,
    taskId: "task-a",
    actor: "backend_engineer",
    ownerRole: claimed.packet.ownerRole,
    completionStandard: claimed.packet.completionStandard,
    summary: "wip handoff",
    changedFiles: [],
    blockers: [],
    verificationNotes: [],
    executionEvidence: [],
    qualityGateEvidence: [],
    contextRefs: [],
    createdAt: new Date().toISOString()
  });

  const report = await recovery.inspectRecovery(runId, { now: hoursFromNow(48) });

  const issue = report.issues.find((i) => i.kind === "stalled_task");
  assert.ok(issue, "stalled_task issue still derived");
  assert.deepEqual(issue?.suggestedActionIds, [], "no suggested action when a handoff exists");
  assert.equal(
    report.actions.some((a) => a.kind === "reset_task_to_ready"),
    false,
    "no reset action emitted when a handoff exists"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// inspectRecovery — stale_review_block (unsafe, operator-only)
// ────────────────────────────────────────────────────────────────────────────

test("inspectRecovery: stale review_blocked task with missing reviews → unsafe request action", async () => {
  const { store, recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "review");
  const [task] = await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  // Force review_blocked with no recorded reviews.
  await store.updateTask({ ...task, status: "review_blocked", updatedAt: new Date().toISOString() });

  const report = await recovery.inspectRecovery(runId, { now: hoursFromNow(48) });

  const issue = report.issues.find((i) => i.kind === "stale_review_block");
  assert.ok(issue, "stale_review_block issue derived");
  const action = report.actions.find((a) => a.kind === "request_missing_reviews");
  assert.ok(action, "request_missing_reviews action derived");
  assert.equal(action?.safeToApply, false, "request action is operator-only, never auto-safe");
  assert.equal(report.summary.safeActions, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// inspectRecovery — orphan_lock
// ────────────────────────────────────────────────────────────────────────────

test("inspectRecovery: active lock for a non-in-progress task → orphan_lock issue + safe release", async () => {
  const { store, recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "orphan");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  const claimed = await lifecycle.claimTask(runId, "task-a", "backend_engineer");
  // Move the task out of in_progress WITHOUT releasing its lock → orphan lock.
  await store.updateTask({ ...claimed, status: "approved", updatedAt: new Date().toISOString() });

  const report = await recovery.inspectRecovery(runId);

  const issue = report.issues.find((i) => i.kind === "orphan_lock");
  assert.ok(issue, "orphan_lock issue derived");
  assert.equal(issue?.lockTaskId, "task-a");
  assert.deepEqual(report.summary.orphanLockTaskIds, ["task-a"]);
  const action = report.actions.find((a) => a.kind === "release_orphan_lock");
  assert.ok(action?.safeToApply, "release action is safe to apply");
});

// ────────────────────────────────────────────────────────────────────────────
// applyRecovery
// ────────────────────────────────────────────────────────────────────────────

test("applyRecovery: reset_task_to_ready resets the task and releases its lock", async () => {
  const { store, recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "apply-reset");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  const run = await store.getRun(runId);
  await lifecycle.claimTask(runId, "task-a", "backend_engineer");

  const result = await recovery.applyRecovery(runId, [], { now: hoursFromNow(48) });

  assert.deepEqual(result.appliedActionIds, ["reset-task:task-a"]);
  const task = await store.getTask(runId, "task-a");
  assert.equal(task?.status, "ready", "task reset to ready");
  assert.equal(task?.claimedBy, undefined, "claim cleared");
  const active = await store.getActiveLocks(run!.projectId);
  assert.equal(active.length, 0, "lock released");
});

test("applyRecovery: release_orphan_lock releases the orphan lock", async () => {
  const { store, recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "apply-orphan");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  const run = await store.getRun(runId);
  const claimed = await lifecycle.claimTask(runId, "task-a", "backend_engineer");
  await store.updateTask({ ...claimed, status: "approved", updatedAt: new Date().toISOString() });

  const result = await recovery.applyRecovery(runId, ["release-lock:task-a"]);

  assert.deepEqual(result.appliedActionIds, ["release-lock:task-a"]);
  const active = await store.getActiveLocks(run!.projectId);
  assert.equal(active.length, 0, "orphan lock released");
});

test("applyRecovery: unknown actionId is skipped, not applied", async () => {
  const { recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "apply-unknown");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  await lifecycle.claimTask(runId, "task-a", "backend_engineer");

  const result = await recovery.applyRecovery(runId, ["reset-task:does-not-exist"], {
    now: hoursFromNow(48)
  });

  assert.deepEqual(result.appliedActionIds, []);
  assert.deepEqual(result.skippedActionIds, ["reset-task:does-not-exist"]);
});

test("applyRecovery: explicitly selected unsafe action (request_missing_reviews) is skipped", async () => {
  const { store, recovery, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "apply-unsafe");
  const [task] = await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  await store.updateTask({ ...task, status: "review_blocked", updatedAt: new Date().toISOString() });

  const result = await recovery.applyRecovery(runId, ["request-reviews:task-a"], {
    now: hoursFromNow(48)
  });

  assert.deepEqual(result.appliedActionIds, [], "unsafe action never auto-applied");
  assert.deepEqual(result.skippedActionIds, ["request-reviews:task-a"]);
  const after = await store.getTask(runId, "task-a");
  assert.equal(after?.status, "review_blocked", "task state unchanged by a skipped unsafe action");
});
