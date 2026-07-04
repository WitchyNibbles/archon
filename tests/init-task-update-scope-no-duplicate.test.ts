/**
 * RED-first regression tests for the closureLoop bug 1 (audit auditDebt202607):
 *
 * `init-task --update-scope` on an EXISTING task that was no longer strictly
 * in_progress (e.g. review_blocked / approved — "gated work") created a DUPLICATE
 * run + duplicate task row and repointed active_run_id/active_task_id at the
 * duplicate, orphaning the original gated run. Live 2026-07-04: duplicate run
 * 8f3417ab shadowed the gated original eca0047f.
 *
 * Fix: --update-scope must locate the existing task by task_key regardless of the
 * active pointer OR the task's status, and update its allowed_write_scope in place
 * (same run, same task row). It must NEVER create a new run or task, and never move
 * the active pointer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory-store.ts";
import { executeInitTaskCommand } from "../src/admin/init-task.ts";
import type { ProjectRuntimeStateRecord, RunRecord, TaskRecord } from "../src/domain/types.ts";

const PROJECT_ID = "project:test-ws:test-proj";

class CountingStore extends MemoryStore {
  createRunCalls = 0;
  replaceTasksCalls = 0;

  override async createRun(run: RunRecord): Promise<void> {
    this.createRunCalls++;
    return super.createRun(run);
  }

  override async replaceTasks(tasks: TaskRecord[]): Promise<void> {
    this.replaceTasksCalls++;
    return super.replaceTasks(tasks);
  }
}

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
    id: "gated-task",
    title: "Gated Task",
    ownerRole: "backend_engineer",
    goal: "Test goal.",
    allowedWriteScope: ["src/admin"],
    writePacketMarkdown: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Test 1 (the repro): --update-scope on a GATED (review_blocked) task must edit
//         it in place — no duplicate run, no duplicate task row, no repoint.
// ---------------------------------------------------------------------------

test("init-task --update-scope: gated (review_blocked) task is edited in place, no duplicate run", async () => {
  const store = new CountingStore();

  // Establish the task; it is created in_progress.
  const created = await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin"] }));
  assert.equal(store.createRunCalls, 1);

  // Simulate the task entering a gating status — the real 2026-07-04 state where
  // the run "kept the gated work" but was no longer strictly in_progress.
  const gated = await store.getTask(created.runId, "gated-task");
  assert.ok(gated, "task must exist after creation");
  await store.updateTask({ ...gated, status: "review_blocked", updatedAt: new Date().toISOString() });

  // Reset creation counters to isolate the --update-scope call.
  store.createRunCalls = 0;
  store.replaceTasksCalls = 0;

  // --update-scope with a DIFFERENT scope on the gated task.
  const updated = await executeInitTaskCommand(
    baseOpts(store, { allowedWriteScope: ["src/admin", "tests"], updateScope: true })
  );

  // SAME run — no duplicate created.
  assert.equal(updated.runId, created.runId, "must reuse the original run, not fork a duplicate");
  assert.equal(store.createRunCalls, 0, "--update-scope must NEVER create a new run");
  assert.equal(store.replaceTasksCalls, 0, "--update-scope must NEVER create a new task row");

  // Scope updated in place.
  assert.deepEqual(updated.allowedWriteScope, ["src/admin", "tests"]);
  assert.equal(updated.scopePreserved, false);

  // Exactly one task in the run — the original, edited in place.
  const tasksInRun = await store.getTasksByRun(created.runId);
  assert.equal(tasksInRun.length, 1, "no duplicate task row");
  assert.equal(tasksInRun[0]!.status, "review_blocked", "status untouched; only scope changed");
  assert.deepEqual(tasksInRun[0]!.packet.allowedWriteScope, ["src/admin", "tests"]);

  // Active pointer still on the original run (never repointed to a duplicate).
  const state = await store.getProjectRuntimeState(PROJECT_ID);
  assert.equal(state!.activeRunId, created.runId, "active_run_id must stay on the original run");
});

// ---------------------------------------------------------------------------
// Test 2: --update-scope also finds the task when the active pointer has moved
//         OFF its run entirely (the precise duplicate-shadow scenario).
// ---------------------------------------------------------------------------

test("init-task --update-scope: edits the task in place even when the active pointer moved to another run", async () => {
  const store = new CountingStore();

  const created = await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin"] }));

  // Gate the task, then move the active pointer to a DIFFERENT (unrelated) run —
  // exactly the corrupted state a prior duplicate left behind.
  const gated = await store.getTask(created.runId, "gated-task");
  await store.updateTask({ ...gated!, status: "review_blocked", updatedAt: new Date().toISOString() });

  const strayRun: RunRecord = { ...(await store.getRun(created.runId))!, id: "stray-run-id" };
  await store.createRun(strayRun);
  const stateBefore = (await store.getProjectRuntimeState(PROJECT_ID))!;
  const repointed: ProjectRuntimeStateRecord = {
    ...stateBefore,
    activeRunId: "stray-run-id",
    updatedAt: new Date().toISOString()
  };
  await store.saveProjectRuntimeState(repointed);

  store.createRunCalls = 0;
  store.replaceTasksCalls = 0;

  const updated = await executeInitTaskCommand(
    baseOpts(store, { allowedWriteScope: ["src/admin", "tests"], updateScope: true })
  );

  // The scope edit lands on the ORIGINAL run that actually holds the task.
  assert.equal(updated.runId, created.runId, "must edit the run that holds the task, not the stray pointer run");
  assert.equal(store.createRunCalls, 0, "no duplicate run");
  assert.equal(store.replaceTasksCalls, 0, "no duplicate task row");

  const task = await store.getTask(created.runId, "gated-task");
  assert.deepEqual(task!.packet.allowedWriteScope, ["src/admin", "tests"]);

  // The pointer is NOT touched by init-task — pointer reconciliation is elsewhere.
  const stateAfter = await store.getProjectRuntimeState(PROJECT_ID);
  assert.equal(stateAfter!.activeRunId, "stray-run-id", "init-task must not move the active pointer");
});

// ---------------------------------------------------------------------------
// Test 3: --update-scope with NO existing task fails loudly — never a create.
// ---------------------------------------------------------------------------

test("init-task --update-scope: errors when there is no task to update (never silently creates)", async () => {
  const store = new CountingStore();

  await assert.rejects(
    executeInitTaskCommand(baseOpts(store, { id: "does-not-exist", updateScope: true })),
    /no existing task with id "does-not-exist" to update/,
    "--update-scope must refuse to create a fresh run/task"
  );
  assert.equal(store.createRunCalls, 0, "no run may be created on a failed --update-scope");
  assert.equal(store.replaceTasksCalls, 0, "no task row may be created on a failed --update-scope");
});
