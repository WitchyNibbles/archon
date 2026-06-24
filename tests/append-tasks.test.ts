// Tests for store.appendTasks (ArchonStore interface) and
// ArchonCoreService.appendTasks (service method).
//
// All tests use MemoryStore (fast, no DB required) and the real
// ArchonCoreService, matching the harness pattern used throughout this repo.
//
// Required scenarios:
//   1. Append N tasks to a run with M existing → total M+N, existing M untouched
//   2. Duplicate task_key collision → rejected, loud error, NOTHING inserted
//   3. Dangling dependency edge → rejected, atomic rollback
//   4. Appended tasks carry correct class + required reviews (same mapping as createTaskGraph)
//   5. task_queue reflects the union after append
//   6. Regression: createTaskGraph + replaceTasks still behave as before (delete-then-insert)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/store/memory-store.ts";
import { ArchonCoreService } from "../src/core/service.ts";
import type { TaskPacketInput } from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid TaskPacketInput for use in tests. */
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

/** Boot a run via intakeRequest and return the runId. */
async function makeRun(service: ArchonCoreService): Promise<string> {
  const run = await service.intakeRequest({
    workspaceSlug: "test-ws",
    projectSlug: "test-proj",
    actor: "manager",
    title: `Test run ${randomUUID()}`,
    request: "test request"
  });
  return run.id;
}

// ---------------------------------------------------------------------------
// 1. Append adds N tasks to a run with M existing → total M+N, existing untouched
// ---------------------------------------------------------------------------

describe("store.appendTasks: additive — M existing + N appended = M+N total", () => {
  it("appends without touching existing tasks", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    // Seed 2 tasks via createTaskGraph.
    await service.createTaskGraph(runId, [
      makePacket({ taskId: "task-a" }),
      makePacket({ taskId: "task-b" })
    ]);

    const before = await store.getTasksByRun(runId);
    assert.equal(before.length, 2, "expected 2 tasks before append");
    const beforeKeys = new Set(before.map((t) => t.packet.taskId));
    assert.ok(beforeKeys.has("task-a"));
    assert.ok(beforeKeys.has("task-b"));

    // Append 3 more tasks. task-c depends on task-a (existing), task-e depends on task-d (new).
    const appended = await service.appendTasks(runId, [
      makePacket({ taskId: "task-c", dependencies: ["task-a"] }),
      makePacket({ taskId: "task-d" }),
      makePacket({ taskId: "task-e", dependencies: ["task-d"] })
    ]);

    assert.equal(appended.length, 3, "service returns the 3 appended TaskRecords");

    const after = await store.getTasksByRun(runId);
    assert.equal(after.length, 5, "total should be 5 after appending 3");

    // Original tasks unchanged.
    const afterKeys = new Set(after.map((t) => t.packet.taskId));
    assert.ok(afterKeys.has("task-a"), "task-a must survive");
    assert.ok(afterKeys.has("task-b"), "task-b must survive");
    assert.ok(afterKeys.has("task-c"), "task-c appended");
    assert.ok(afterKeys.has("task-d"), "task-d appended");
    assert.ok(afterKeys.has("task-e"), "task-e appended");

    // Original records are byte-identical (status, claimedBy unchanged).
    const taskA = after.find((t) => t.packet.taskId === "task-a")!;
    assert.equal(taskA.status, "ready");
    assert.equal(taskA.claimedBy, undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. Duplicate task_key collision → rejected, loud error, NOTHING inserted
// ---------------------------------------------------------------------------

describe("store.appendTasks: duplicate task_key collision → atomic rejection", () => {
  it("throws a descriptive error and inserts nothing when task_key already exists", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [
      makePacket({ taskId: "existing-task" })
    ]);

    const countBefore = (await store.getTasksByRun(runId)).length;
    assert.equal(countBefore, 1);

    await assert.rejects(
      () => service.appendTasks(runId, [
        makePacket({ taskId: "new-task" }),         // would be new
        makePacket({ taskId: "existing-task" })     // collision
      ]),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.ok(
          err.message.includes("existing-task"),
          `error must name the colliding key; got: ${err.message}`
        );
        assert.ok(
          err.message.includes("already exists"),
          `error must say 'already exists'; got: ${err.message}`
        );
        return true;
      }
    );

    // Nothing was inserted — count is still 1.
    const countAfter = (await store.getTasksByRun(runId)).length;
    assert.equal(countAfter, countBefore, "no tasks should have been inserted on collision");
  });

  it("throws when the same key appears twice in the appended batch itself", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [makePacket({ taskId: "seed" })]);
    const countBefore = (await store.getTasksByRun(runId)).length;

    await assert.rejects(
      () => service.appendTasks(runId, [
        makePacket({ taskId: "dup" }),
        makePacket({ taskId: "dup" })   // same key in batch
      ]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("dup"));
        return true;
      }
    );

    const countAfter = (await store.getTasksByRun(runId)).length;
    assert.equal(countAfter, countBefore, "no tasks inserted on intra-batch duplicate");
  });
});

// ---------------------------------------------------------------------------
// 3. Dangling dependency edge → rejected, atomic rollback
// ---------------------------------------------------------------------------

describe("store.appendTasks: dangling dependency → atomic rejection", () => {
  it("throws when a dependency key is absent from both existing and incoming tasks", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [makePacket({ taskId: "root" })]);
    const countBefore = (await store.getTasksByRun(runId)).length;

    await assert.rejects(
      () => service.appendTasks(runId, [
        makePacket({ taskId: "new-task", dependencies: ["ghost-key"] })
      ]),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.ok(
          err.message.includes("ghost-key"),
          `error must name the dangling dependency; got: ${err.message}`
        );
        assert.ok(
          err.message.includes("dangling"),
          `error must say 'dangling'; got: ${err.message}`
        );
        return true;
      }
    );

    const countAfter = (await store.getTasksByRun(runId)).length;
    assert.equal(countAfter, countBefore, "nothing inserted when dependency is dangling");
  });

  it("allows a dependency on an existing run task", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [makePacket({ taskId: "foundation" })]);

    // Should not throw — "foundation" exists in the run.
    const appended = await service.appendTasks(runId, [
      makePacket({ taskId: "builds-on-foundation", dependencies: ["foundation"] })
    ]);
    assert.equal(appended.length, 1);

    const all = await store.getTasksByRun(runId);
    assert.equal(all.length, 2);
  });

  it("allows a dependency within the incoming batch itself", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [makePacket({ taskId: "seed" })]);

    // task-y depends on task-x, both in the same append batch.
    const appended = await service.appendTasks(runId, [
      makePacket({ taskId: "task-x" }),
      makePacket({ taskId: "task-y", dependencies: ["task-x"] })
    ]);
    assert.equal(appended.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 4. Appended tasks carry correct class + required reviews (same as createTaskGraph)
// ---------------------------------------------------------------------------

describe("store.appendTasks: class and requiredReviews mapping", () => {
  it("assigns prototype_slice class for product_acceptance gate (no release gate)", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [makePacket({ taskId: "seed" })]);

    const appended = await service.appendTasks(runId, [
      makePacket({
        taskId: "proto-task",
        qualityGates: ["product_acceptance"],
        requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"]
      })
    ]);

    const task = appended[0]!;
    assert.equal(task.class, "prototype_slice", "non-release task must be prototype_slice");
    assert.deepEqual(
      task.packet.requiredReviews.sort(),
      ["qa_engineer", "reviewer", "security_reviewer"].sort()
    );
  });

  it("assigns release_candidate class for release_readiness_required gate", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [makePacket({ taskId: "seed" })]);

    const appended = await service.appendTasks(runId, [
      makePacket({
        taskId: "release-task",
        qualityGates: ["release_readiness_required"],
        requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"]
      })
    ]);

    const task = appended[0]!;
    assert.equal(task.class, "release_candidate", "release gate must produce release_candidate class");
  });

  it("class on appended task matches what createTaskGraph would produce for same packet", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    // Reference: create via createTaskGraph (replaces existing).
    const packet = makePacket({
      taskId: "reference-task",
      qualityGates: ["product_acceptance"]
    });
    const created = await service.createTaskGraph(runId, [packet]);
    const createdClass = created[0]!.class;

    // Reset — start fresh run for append path.
    const runId2 = await makeRun(service);
    await service.createTaskGraph(runId2, [makePacket({ taskId: "seed2" })]);
    const appendedTasks = await service.appendTasks(runId2, [
      { ...packet, taskId: "appended-task" }
    ]);
    const appendedClass = appendedTasks[0]!.class;

    assert.equal(
      appendedClass,
      createdClass,
      "appendTasks class must match createTaskGraph class for same packet"
    );
  });
});

// ---------------------------------------------------------------------------
// 5. task_queue reflects the union after append
// ---------------------------------------------------------------------------

describe("service.appendTasks: task_queue rebuilt over full union", () => {
  it("task_queue contains both existing and appended task ids after append", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [
      makePacket({ taskId: "original-1" }),
      makePacket({ taskId: "original-2" })
    ]);

    await service.appendTasks(runId, [
      makePacket({ taskId: "appended-1" }),
      makePacket({ taskId: "appended-2" })
    ]);

    // Retrieve the rebuilt runtime state.
    const run = await store.getRun(runId);
    assert.ok(run, "run must exist");

    const state = await store.getProjectRuntimeState(run!.projectId);
    assert.ok(state, "project runtime state must exist");

    const queueIds = new Set(state!.taskQueue.tasks.map((t) => t.id));
    assert.ok(queueIds.has("original-1"), "queue must contain original-1");
    assert.ok(queueIds.has("original-2"), "queue must contain original-2");
    assert.ok(queueIds.has("appended-1"), "queue must contain appended-1");
    assert.ok(queueIds.has("appended-2"), "queue must contain appended-2");
    assert.equal(queueIds.size, 4, "queue must have exactly 4 entries");
  });

  it("does NOT change run status after append", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [makePacket({ taskId: "original" })]);

    const runBefore = await store.getRun(runId);
    const statusBefore = runBefore!.status;

    await service.appendTasks(runId, [makePacket({ taskId: "new-task" })]);

    const runAfter = await store.getRun(runId);
    assert.equal(
      runAfter!.status,
      statusBefore,
      "appendTasks must not change run status"
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Regression: createTaskGraph + replaceTasks still behave as before
// ---------------------------------------------------------------------------

describe("regression: createTaskGraph + replaceTasks delete-then-insert semantics intact", () => {
  it("createTaskGraph wipes old tasks and inserts fresh set", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    // First decomposition.
    await service.createTaskGraph(runId, [
      makePacket({ taskId: "old-a" }),
      makePacket({ taskId: "old-b" })
    ]);

    let tasks = await store.getTasksByRun(runId);
    assert.equal(tasks.length, 2);

    // Second decomposition should replace entirely.
    await service.createTaskGraph(runId, [
      makePacket({ taskId: "new-x" })
    ]);

    tasks = await store.getTasksByRun(runId);
    assert.equal(tasks.length, 1, "createTaskGraph replaces — only new-x should remain");
    assert.equal(tasks[0]!.packet.taskId, "new-x");
  });

  it("replaceTasks on store deletes all tasks for the run then inserts the new set", async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    const runId = "regression-run-" + randomUUID();

    const workspaceId = "ws-1";
    const projectId = "proj-1";

    const makeTaskRecord = (taskId: string): import("../src/domain/types.ts").TaskRecord => ({
      id: randomUUID(),
      runId,
      workspaceId,
      projectId,
      class: "prototype_slice",
      packet: makePacket({ taskId }),
      status: "ready",
      createdAt: now,
      updatedAt: now
    });

    // First replace.
    await store.replaceTasks([makeTaskRecord("r-task-1"), makeTaskRecord("r-task-2")]);
    assert.equal((await store.getTasksByRun(runId)).length, 2);

    // Second replace wipes the first set.
    await store.replaceTasks([makeTaskRecord("r-task-3")]);
    const after = await store.getTasksByRun(runId);
    assert.equal(after.length, 1, "replaceTasks must wipe the old set");
    assert.equal(after[0]!.packet.taskId, "r-task-3");
  });

  it("appendTasks does NOT affect tasks in a different run", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);

    const runId1 = await makeRun(service);
    const runId2 = await makeRun(service);

    await service.createTaskGraph(runId1, [makePacket({ taskId: "run1-task" })]);
    await service.createTaskGraph(runId2, [makePacket({ taskId: "run2-task" })]);

    // Append to run1 only.
    await service.appendTasks(runId1, [makePacket({ taskId: "run1-extra" })]);

    const run1Tasks = await store.getTasksByRun(runId1);
    const run2Tasks = await store.getTasksByRun(runId2);

    assert.equal(run1Tasks.length, 2, "run1 should have 2 tasks");
    assert.equal(run2Tasks.length, 1, "run2 must be untouched");
    assert.equal(run2Tasks[0]!.packet.taskId, "run2-task");
  });
});

// ---------------------------------------------------------------------------
// 7. appendTasks returns empty array and is a no-op when taskPackets is empty
// ---------------------------------------------------------------------------

describe("service.appendTasks: empty packet list is a no-op", () => {
  it("returns empty array and does not change task count", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);
    const runId = await makeRun(service);

    await service.createTaskGraph(runId, [makePacket({ taskId: "existing" })]);

    const result = await service.appendTasks(runId, []);
    assert.deepEqual(result, [], "must return empty array");

    const tasks = await store.getTasksByRun(runId);
    assert.equal(tasks.length, 1, "task count unchanged");
  });
});
