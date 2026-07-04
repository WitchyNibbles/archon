/**
 * Unit tests for TaskLifecycleManager (src/core/task-lifecycle.ts).
 *
 * This module was extracted from ArchonCoreService (audit F5 / service.ts split
 * slice 2). These tests exercise the manager class DIRECTLY against a MemoryStore
 * double + injected deps (requireRun/requireTask/findTaskBlockers/
 * saveAutonomousExecutionState), so a future logic drift in a lifecycle
 * transition fails here rather than only through the service-level suites.
 *
 * Coverage targets the cold spots that the service-level tests do not isolate:
 *   - intakeRequest seeds project_runtime_state with a default queue
 *   - createPlan validation error path + plan/workflow-doc persistence + run->planned
 *   - createTaskGraph validation errors (bad packet, unknown dependency) and the
 *     autonomous-execution seeding branch (a coverage_ledger_required gate)
 *   - appendTasks empty-batch short-circuit
 *   - claimTask non-ready rejection + injected-blocker rejection + happy path
 *   - failTask blocks the task and records the seedFailure recovery metadata
 *   - bumpRunState / syncRunState run-status mutation
 *
 * The delegation from ArchonCoreService to this manager stays covered by the
 * existing service-level tests (tests/append-tasks.test.ts, tests/autonomous-enable.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { TaskLifecycleManager } from "../src/core/task-lifecycle.ts";
import { AutonomousExecutionStore } from "../src/core/autonomous-execution-store.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import type { ArchonStore } from "../src/store/types.ts";
import type { LockRecord, PlanInput, RunRecord, TaskPacketInput, TaskRecord } from "../src/domain/types.ts";

// ────────────────────────────────────────────────────────────────────────────
// Harness: a real MemoryStore double wired to a TaskLifecycleManager whose
// injected deps mirror the private helpers on ArchonCoreService. findTaskBlockers
// is a controllable stub (blockersRef.value) so the blocker-rejection cold path
// is deterministic; saveAutonomousExecutionState delegates to a real
// AutonomousExecutionStore on the SAME store so the seeding path is exercised end
// to end rather than mocked.
// ────────────────────────────────────────────────────────────────────────────

interface Harness {
  store: ArchonStore;
  manager: TaskLifecycleManager;
  autonomous: AutonomousExecutionStore;
  blockersRef: { value: string[] };
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
  const blockersRef: { value: string[] } = { value: [] };
  const findTaskBlockers = async (
    _task: TaskRecord,
    _allTasks: readonly TaskRecord[],
    _activeLocks: readonly LockRecord[]
  ): Promise<string[]> => blockersRef.value;

  const manager = new TaskLifecycleManager({
    store,
    requireRun,
    requireTask,
    findTaskBlockers,
    saveAutonomousExecutionState: (run, update) => autonomous.saveState(run, update)
  });

  return { store, manager, autonomous, blockersRef };
}

async function seedRun(manager: TaskLifecycleManager): Promise<string> {
  const run = await manager.intakeRequest({
    workspaceSlug: "ws-lifecycle",
    projectSlug: "proj-lifecycle",
    actor: "manager",
    title: "task-lifecycle unit test run",
    request: "exercise the extracted lifecycle manager directly"
  });
  return run.id;
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
    ...overrides
  };
}

function makePlan(runId: string, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    runId,
    title: "Lifecycle plan",
    summary: "A minimal valid plan",
    milestones: ["m1"],
    decisions: ["d1"],
    residualRisks: ["r1"],
    acceptanceCriteria: ["criteria met"],
    ...overrides
  };
}

// ────────────────────────────────────────────────────────────────────────────
// intakeRequest
// ────────────────────────────────────────────────────────────────────────────

test("TaskLifecycleManager.intakeRequest: creates run in intake status and seeds runtime state", async () => {
  const { store, manager } = makeHarness();
  const run = await manager.intakeRequest({
    workspaceSlug: "ws-intake",
    projectSlug: "proj-intake",
    actor: "manager",
    title: "  padded title  ",
    request: "  padded request  "
  });

  assert.equal(run.status, "intake");
  assert.equal(run.title, "padded title", "title trimmed");
  assert.equal(run.request, "padded request", "request trimmed");

  const persisted = await store.getRun(run.id);
  assert.equal(persisted?.id, run.id);
  const runtimeState = await store.getProjectRuntimeState(run.projectId);
  assert.equal(runtimeState?.activeRunId, run.id, "run set active in runtime state");
  assert.deepEqual(runtimeState?.taskQueue.tasks, [], "default empty queue seeded");
});

// ────────────────────────────────────────────────────────────────────────────
// createPlan
// ────────────────────────────────────────────────────────────────────────────

test("TaskLifecycleManager.createPlan: invalid plan throws with field errors", async () => {
  const { manager } = makeHarness();
  const runId = await seedRun(manager);
  await assert.rejects(
    () => manager.createPlan(makePlan(runId, { title: "", milestones: [] })),
    /Invalid plan:.*plan\.title is required/
  );
});

test("TaskLifecycleManager.createPlan: persists plan + workflow doc and advances run to planned", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);

  const artifact = await manager.createPlan(makePlan(runId));
  assert.equal(artifact.kind, "plan");
  assert.equal(artifact.runId, runId);

  const run = await store.getRun(runId);
  assert.equal(run?.status, "planned", "run advanced to planned");

  const docs = await store.listWorkflowDocuments({ projectId: run!.projectId, kind: "plan" });
  assert.equal(docs.length, 1, "one plan workflow doc persisted");
});

// ────────────────────────────────────────────────────────────────────────────
// createTaskGraph
// ────────────────────────────────────────────────────────────────────────────

test("TaskLifecycleManager.createTaskGraph: rejects an unknown dependency edge", async () => {
  const { manager } = makeHarness();
  const runId = await seedRun(manager);
  await assert.rejects(
    () => manager.createTaskGraph(runId, [makePacket({ taskId: "task-a", dependencies: ["ghost"] })]),
    /Invalid task graph:.*unknown dependency ghost/
  );
});

test("TaskLifecycleManager.createTaskGraph: rejects an invalid packet, inserting nothing", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);
  await assert.rejects(
    // empty taskId is an invalid packet
    () => manager.createTaskGraph(runId, [makePacket({ taskId: "" })]),
    /Invalid task graph/
  );
  const tasks = await store.getTasksByRun(runId);
  assert.equal(tasks.length, 0, "no tasks inserted on validation failure");
});

test("TaskLifecycleManager.createTaskGraph: decomposes tasks, rebuilds queue, sets run decomposed", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);

  const tasks = await manager.createTaskGraph(runId, [
    makePacket({ taskId: "task-a" }),
    makePacket({ taskId: "task-b", dependencies: ["task-a"] })
  ]);
  assert.equal(tasks.length, 2);

  const run = await store.getRun(runId);
  assert.equal(run?.status, "decomposed");

  const runtimeState = await store.getProjectRuntimeState(run!.projectId);
  assert.equal(runtimeState?.taskQueue.project_status, "decomposed");
  assert.equal(runtimeState?.taskQueue.tasks.length, 2, "queue rebuilt over the task graph");

  // Non-autonomous gates → no autonomous-execution state seeded.
  const autonomousState = await store.getProjectRuntimeState(run!.projectId);
  assert.equal(
    (autonomousState?.metadata as { autonomousExecution?: unknown } | undefined)?.autonomousExecution,
    undefined,
    "no autonomous state for a non-autonomous task graph"
  );
});

test("TaskLifecycleManager.createTaskGraph: seeds autonomous-execution state for an autonomous gate", async () => {
  const { manager, autonomous } = makeHarness();
  const runId = await seedRun(manager);

  await manager.createTaskGraph(runId, [
    makePacket({ taskId: "task-auto", qualityGates: ["coverage_ledger_required"] })
  ]);

  const state = await autonomous.getAutonomousExecutionState(runId);
  assert.ok(state, "autonomous execution state seeded via saveAutonomousExecutionState");
  assert.equal(state?.enabled, true);
});

// ────────────────────────────────────────────────────────────────────────────
// appendTasks
// ────────────────────────────────────────────────────────────────────────────

test("TaskLifecycleManager.appendTasks: empty batch short-circuits without a store write", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);
  await manager.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  const appended = await manager.appendTasks(runId, []);
  assert.deepEqual(appended, [], "empty batch returns []");

  const tasks = await store.getTasksByRun(runId);
  assert.equal(tasks.length, 1, "no tasks added by an empty append");
});

test("TaskLifecycleManager.appendTasks: adds tasks and rebuilds the queue over the union", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);
  await manager.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  const appended = await manager.appendTasks(runId, [
    makePacket({ taskId: "task-b", dependencies: ["task-a"] })
  ]);
  assert.equal(appended.length, 1);

  const tasks = await store.getTasksByRun(runId);
  assert.equal(tasks.length, 2);
  const run = await store.getRun(runId);
  const runtimeState = await store.getProjectRuntimeState(run!.projectId);
  assert.equal(runtimeState?.taskQueue.tasks.length, 2, "queue rebuilt over existing + appended");
});

// ────────────────────────────────────────────────────────────────────────────
// claimTask
// ────────────────────────────────────────────────────────────────────────────

test("TaskLifecycleManager.claimTask: rejects a task that is not ready", async () => {
  const { manager } = makeHarness();
  const runId = await seedRun(manager);
  await manager.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  await manager.claimTask(runId, "task-a", "backend_engineer");
  // Second claim: task is now in_progress, not ready.
  await assert.rejects(
    () => manager.claimTask(runId, "task-a", "backend_engineer"),
    /must be ready before it can be claimed/
  );
});

test("TaskLifecycleManager.claimTask: surfaces injected blockers", async () => {
  const { manager, blockersRef } = makeHarness();
  const runId = await seedRun(manager);
  await manager.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  blockersRef.value = ["dependency task-x not approved"];
  await assert.rejects(
    () => manager.claimTask(runId, "task-a", "backend_engineer"),
    /Task cannot be claimed: dependency task-x not approved/
  );
});

test("TaskLifecycleManager.claimTask: claims a ready task, creates a lock, bumps run to in_progress", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);
  await manager.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  const claimed = await manager.claimTask(runId, "task-a", "backend_engineer");
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.claimedBy, "backend_engineer");

  const run = await store.getRun(runId);
  assert.equal(run?.status, "in_progress", "run bumped to in_progress");
  const locks = await store.getActiveLocks(run!.projectId);
  assert.equal(locks.length, 1, "an active lock was created for the claimed task");
  assert.equal(locks[0]?.taskId, "task-a");

  const runtimeState = await store.getProjectRuntimeState(run!.projectId);
  assert.equal(runtimeState?.activeTaskId, "task-a", "active task pointer set");
});

// ────────────────────────────────────────────────────────────────────────────
// failTask
// ────────────────────────────────────────────────────────────────────────────

test("TaskLifecycleManager.failTask: blocks the task, releases locks, records seedFailure", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);
  await manager.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  await manager.claimTask(runId, "task-a", "backend_engineer");

  await manager.failTask(runId, "task-a", "reproduction failed");

  const task = await store.getTask(runId, "task-a");
  assert.equal(task?.status, "blocked", "failed task marked blocked");
  assert.equal(task?.claimedBy, undefined, "claim cleared on failure");

  const run = await store.getRun(runId);
  // The run status is re-derived from the post-failure task set. A single
  // blocked task is neither done, in_progress, review_blocked, nor
  // approved/done, so deriveRunStatus falls through to "ready".
  assert.equal(run?.status, "ready", "run status re-derived after task failure");
  const locks = await store.getActiveLocks(run!.projectId);
  assert.equal(locks.length, 0, "locks released on failure");

  const runtimeState = await store.getProjectRuntimeState(run!.projectId);
  const seedFailure = (runtimeState?.metadata as { seedFailure?: { reason?: string; recoveryState?: string } })
    ?.seedFailure;
  assert.equal(seedFailure?.reason, "reproduction failed");
  assert.equal(seedFailure?.recoveryState, "requires_reproof");
  assert.equal(runtimeState?.activeTaskId, undefined, "active task pointer cleared on failure");
});

// ────────────────────────────────────────────────────────────────────────────
// bumpRunState / syncRunState
// ────────────────────────────────────────────────────────────────────────────

test("TaskLifecycleManager.bumpRunState: sets the run status directly", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);
  await manager.bumpRunState(runId, "review_blocked");
  const run = await store.getRun(runId);
  assert.equal(run?.status, "review_blocked");
});

test("TaskLifecycleManager.syncRunState: derives run status from the task set", async () => {
  const { store, manager } = makeHarness();
  const runId = await seedRun(manager);
  await manager.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  await manager.claimTask(runId, "task-a", "backend_engineer");

  // Force the run status away from the derived value, then re-sync.
  await manager.bumpRunState(runId, "intake");
  await manager.syncRunState(runId);

  const run = await store.getRun(runId);
  assert.equal(run?.status, "in_progress", "syncRunState derived in_progress from the claimed task");
});

// ────────────────────────────────────────────────────────────────────────────
// requireRun propagation
// ────────────────────────────────────────────────────────────────────────────

test("TaskLifecycleManager: unknown run rejects via injected requireRun", async () => {
  const { manager } = makeHarness();
  await assert.rejects(
    () => manager.createPlan(makePlan("run-does-not-exist")),
    /Unknown run: run-does-not-exist/
  );
});
