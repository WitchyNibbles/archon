/**
 * TDD tests for init-task idempotency (W2 — archonClosureLoop).
 *
 * Problem: executeInitTaskCommand calls randomUUID() unconditionally on every
 * invocation, causing every repeated init-task call (e.g. manager control-writes
 * for the same logical task) to create a NEW run, fragment run history, and
 * produce orphan in_progress tasks.
 *
 * Fix: before creating a new run, check whether a task row with the SAME
 * task_key (the --id argument) already exists for this project with
 * status = in_progress. If so, reuse its run_id + task id; do NOT create a new
 * run and do NOT overwrite activeRunId in saveProjectRuntimeState.
 *
 * Idempotency key: (project, task_key, in_progress).
 * Concurrent worktrees with DIFFERENT task ids are unaffected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory-store.ts";
import { executeInitTaskCommand } from "../src/admin/init-task.ts";
import type { ProjectRuntimeStateRecord, RunRecord, TaskRecord } from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Enforcing store double: delegates to MemoryStore for real semantics but
// adds call counters to verify the idempotency path is taken.
// ---------------------------------------------------------------------------

class CountingStore extends MemoryStore {
  createRunCalls = 0;
  replaceTasksCalls = 0;
  updateTaskCalls = 0;
  saveStateCalls = 0;

  override async createRun(run: RunRecord): Promise<void> {
    this.createRunCalls++;
    return super.createRun(run);
  }

  override async replaceTasks(tasks: TaskRecord[]): Promise<void> {
    this.replaceTasksCalls++;
    return super.replaceTasks(tasks);
  }

  override async updateTask(task: TaskRecord): Promise<void> {
    this.updateTaskCalls++;
    return super.updateTask(task);
  }

  override async saveProjectRuntimeState(state: ProjectRuntimeStateRecord): Promise<void> {
    this.saveStateCalls++;
    return super.saveProjectRuntimeState(state);
  }
}

// ---------------------------------------------------------------------------
// Shared options builder — write packet markdown is disabled so no real FS I/O.
// ---------------------------------------------------------------------------

function baseOpts(
  store: CountingStore,
  overrides: Partial<Parameters<typeof executeInitTaskCommand>[0]> = {}
): Parameters<typeof executeInitTaskCommand>[0] {
  return {
    store,
    workspaceSlug: "test-ws",
    workspaceName: "Test Workspace",
    projectSlug: "test-proj",
    projectName: "Test Project",
    repoPath: "/dev/null/fake-repo",
    id: "my-task",
    title: "My Task",
    ownerRole: "backend_engineer",
    goal: "Test goal.",
    allowedWriteScope: ["src/admin", "tests"],
    writePacketMarkdown: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Test 1: second call with same in_progress task_key → reuses run_id + task,
//         no new run created, pointer not clobbered.
// ---------------------------------------------------------------------------

test("init-task idempotency: second call with same in_progress task_key reuses run_id", async () => {
  const store = new CountingStore();

  // First call — fresh cycle.
  const result1 = await executeInitTaskCommand(baseOpts(store));

  // Verify the first call behaved as a fresh cycle.
  assert.equal(store.createRunCalls, 1, "first call must create exactly one run");
  assert.equal(store.replaceTasksCalls, 1, "first call must insert the task via replaceTasks");
  assert.equal(store.saveStateCalls, 1, "first call must save runtime state once");

  // Second call with the SAME task id — task is still in_progress.
  const result2 = await executeInitTaskCommand(baseOpts(store));

  // Run must be reused, not a new one.
  assert.equal(
    result2.runId,
    result1.runId,
    "second call must reuse the same runId, not create a new one"
  );
  assert.equal(
    result2.taskId,
    result1.taskId,
    "second call must return the same taskId"
  );

  // createRun must NOT have been called again.
  assert.equal(
    store.createRunCalls,
    1,
    "createRun must only be called once (fresh cycle only); second call must not create a new run"
  );

  // replaceTasks must NOT have been called again (reuse uses updateTask instead).
  assert.equal(
    store.replaceTasksCalls,
    1,
    "replaceTasks must not be called on the reuse path"
  );

  // updateTask must have been called once (scope re-application on reuse).
  assert.equal(
    store.updateTaskCalls,
    1,
    "updateTask must be called once on the reuse path to re-apply scope"
  );

  // The state pointer must NOT be clobbered: activeRunId still points to the
  // original run after the second call.
  const projectId = `project:test-ws:test-proj`;
  const state = await store.getProjectRuntimeState(projectId);
  assert.ok(state, "project runtime state must exist");
  assert.equal(
    state.activeRunId,
    result1.runId,
    "activeRunId must still point to the original run after the reuse call"
  );
  assert.equal(
    store.saveStateCalls,
    1,
    "saveProjectRuntimeState must NOT be called on the reuse path (pointer not clobbered)"
  );
});

// ---------------------------------------------------------------------------
// Test 2: task_key exists but is terminal (done) → fresh cycle, new run.
// ---------------------------------------------------------------------------

test("init-task idempotency: terminal task (done) → new run created (fresh cycle)", async () => {
  const store = new CountingStore();

  // First call — creates the task in_progress.
  const result1 = await executeInitTaskCommand(baseOpts(store));

  // Manually transition the task to done (simulating the task completing).
  const projectId = `project:test-ws:test-proj`;
  const state1 = await store.getProjectRuntimeState(projectId);
  assert.ok(state1?.activeRunId, "state must have activeRunId after first call");

  const existingTask = await store.getTask(state1.activeRunId!, "my-task");
  assert.ok(existingTask, "task must exist after first call");

  // Mark the task as done.
  const doneTask: TaskRecord = { ...existingTask, status: "done", updatedAt: new Date().toISOString() };
  await store.updateTask(doneTask);

  // Reset counters to isolate the second call.
  store.createRunCalls = 0;
  store.replaceTasksCalls = 0;
  store.saveStateCalls = 0;

  // Second call — prior task is terminal, must start a fresh cycle.
  const result2 = await executeInitTaskCommand(baseOpts(store));

  assert.notEqual(
    result2.runId,
    result1.runId,
    "terminal task must trigger a fresh cycle with a new runId"
  );
  assert.equal(
    store.createRunCalls,
    1,
    "fresh cycle must create exactly one new run"
  );
  assert.equal(
    store.replaceTasksCalls,
    1,
    "fresh cycle must call replaceTasks once"
  );
  assert.equal(
    store.saveStateCalls,
    1,
    "fresh cycle must call saveProjectRuntimeState once"
  );

  // The state pointer must now point to the new run.
  const state2 = await store.getProjectRuntimeState(projectId);
  assert.equal(
    state2?.activeRunId,
    result2.runId,
    "activeRunId must point to the new fresh-cycle run"
  );
});

// ---------------------------------------------------------------------------
// Test 3: different task_key → new run, unaffected by existing in_progress.
// ---------------------------------------------------------------------------

test("init-task idempotency: different task_key always creates new run, isolated from others", async () => {
  const store = new CountingStore();

  // First call for task X.
  const resultX = await executeInitTaskCommand(baseOpts(store, { id: "task-x" }));
  assert.equal(store.createRunCalls, 1, "first call must create one run");

  // Reset counters.
  store.createRunCalls = 0;
  store.replaceTasksCalls = 0;
  store.saveStateCalls = 0;

  // Call for a DIFFERENT task Y — must create a new run, even though X is in_progress.
  const resultY = await executeInitTaskCommand(baseOpts(store, { id: "task-y" }));

  assert.notEqual(
    resultY.runId,
    resultX.runId,
    "different task_key must produce a different runId"
  );
  assert.equal(
    resultY.taskId,
    "task-y",
    "different task_key must produce the correct taskId"
  );
  assert.equal(
    store.createRunCalls,
    1,
    "task-y call must create exactly one new run"
  );
  assert.equal(
    store.replaceTasksCalls,
    1,
    "task-y call must call replaceTasks once"
  );
  assert.equal(
    store.saveStateCalls,
    1,
    "task-y call must call saveProjectRuntimeState once"
  );

  // task-x task must still be in_progress, untouched.
  const projectId = `project:test-ws:test-proj`;
  const finalState = await store.getProjectRuntimeState(projectId);
  // After task-y call, the state pointer reflects task-y (the latest call).
  // But task-x's task record must still exist and be in_progress.
  const taskX = await store.getTask(resultX.runId, "task-x");
  assert.ok(taskX, "task-x must still exist in its run");
  assert.equal(taskX.status, "in_progress", "task-x must remain in_progress");
  assert.ok(finalState, "final state must exist");
});

// ---------------------------------------------------------------------------
// Test 4: scope re-application on reuse → updates scope, no duplicate task row.
// ---------------------------------------------------------------------------

test("init-task idempotency: scope re-application on reuse updates scope without duplicate rows", async () => {
  const store = new CountingStore();

  // First call with narrow scope.
  const result1 = await executeInitTaskCommand(
    baseOpts(store, { id: "scoped-task", allowedWriteScope: ["src/admin"] })
  );
  assert.deepEqual(result1.allowedWriteScope, ["src/admin"], "first call scope must match");

  const projectId = `project:test-ws:test-proj`;
  const state1 = await store.getProjectRuntimeState(projectId);
  const taskAfterFirst = await store.getTask(state1!.activeRunId!, "scoped-task");
  assert.ok(taskAfterFirst, "task must exist after first call");
  assert.deepEqual(
    taskAfterFirst.packet.allowedWriteScope,
    ["src/admin"],
    "task scope after first call must be ['src/admin']"
  );

  // Reset counters.
  store.createRunCalls = 0;
  store.replaceTasksCalls = 0;
  store.updateTaskCalls = 0;
  store.saveStateCalls = 0;

  // Second call with expanded scope — task is still in_progress.
  const result2 = await executeInitTaskCommand(
    baseOpts(store, { id: "scoped-task", allowedWriteScope: ["src/admin", "tests"] })
  );

  // Same run reused.
  assert.equal(result2.runId, result1.runId, "must reuse same runId");
  assert.equal(result2.taskId, result1.taskId, "must reuse same taskId");

  // Scope must be updated in the returned result.
  assert.deepEqual(
    result2.allowedWriteScope,
    ["src/admin", "tests"],
    "returned scope must reflect the new scope"
  );

  // No duplicate rows: replaceTasks must NOT have been called.
  assert.equal(
    store.replaceTasksCalls,
    0,
    "replaceTasks must not be called on reuse path — no duplicate task rows"
  );
  assert.equal(
    store.createRunCalls,
    0,
    "createRun must not be called on reuse path"
  );
  assert.equal(
    store.updateTaskCalls,
    1,
    "updateTask must be called once to update the scope"
  );

  // Verify the task record in the store has the updated scope.
  const taskAfterSecond = await store.getTask(result1.runId, "scoped-task");
  assert.ok(taskAfterSecond, "task must still exist after second (reuse) call");
  assert.deepEqual(
    taskAfterSecond.packet.allowedWriteScope,
    ["src/admin", "tests"],
    "task's scope in store must be updated to the new scope"
  );

  // Verify there is exactly ONE task in the run (no duplicates).
  const allTasks = await store.getTasksByRun(result1.runId);
  assert.equal(allTasks.length, 1, "must be exactly one task in the run — no duplicate rows");
});
