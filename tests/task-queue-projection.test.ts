/**
 * Direct unit tests for src/core/task-queue-projection.ts.
 *
 * These pure, store-free projection functions were extracted from
 * ArchonCoreService (audit F5 / service.ts split slice 2) and shared between the
 * TaskLifecycleManager and the gate/closure methods still on the service. Slice 2
 * covered them only transitively through the service-level suites; this file is
 * the carried-over slice-2 gate item — direct table tests over the cold branches
 * so a drift in status mapping, queue projection, or run-status derivation fails
 * here rather than only through a higher-level integration test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRuntimeTaskQueue,
  deriveRunStatus,
  mapTaskStatusToQueueStatus
} from "../src/core/task-queue-projection.ts";
import type { TaskClass } from "../src/archon/task-queue.ts";
import type { TaskPacketInput, TaskRecord } from "../src/domain/types.ts";

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

function makeTask(overrides: {
  taskId: string;
  status: TaskRecord["status"];
  class?: TaskClass;
  packet?: Partial<TaskPacketInput>;
}): TaskRecord {
  return {
    id: `id-${overrides.taskId}`,
    runId: "run-1",
    workspaceId: "workspace:ws",
    projectId: "project:ws:proj",
    class: overrides.class ?? "prototype_slice",
    packet: makePacket({ taskId: overrides.taskId, ...overrides.packet }),
    status: overrides.status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

// ────────────────────────────────────────────────────────────────────────────
// mapTaskStatusToQueueStatus — every branch of the status projection
// ────────────────────────────────────────────────────────────────────────────

test("mapTaskStatusToQueueStatus: maps each TaskRecord status to its queue status", () => {
  assert.equal(mapTaskStatusToQueueStatus("ready"), "pending");
  assert.equal(mapTaskStatusToQueueStatus("in_progress"), "in_progress");
  assert.equal(mapTaskStatusToQueueStatus("approved"), "done");
  assert.equal(mapTaskStatusToQueueStatus("done"), "done");
  assert.equal(mapTaskStatusToQueueStatus("blocked"), "blocked");
  assert.equal(mapTaskStatusToQueueStatus("review_blocked"), "blocked");
});

// ────────────────────────────────────────────────────────────────────────────
// buildRuntimeTaskQueue — current_task_id resolution, class passthrough, blockers
// ────────────────────────────────────────────────────────────────────────────

test("buildRuntimeTaskQueue: empty task set yields null current_task_id and no tasks", () => {
  const queue = buildRuntimeTaskQueue("decomposed", []);
  assert.equal(queue.project_status, "decomposed");
  assert.equal(queue.current_task_id, null, "no active task and no in_progress task");
  assert.deepEqual(queue.tasks, []);
});

test("buildRuntimeTaskQueue: explicit activeTaskId wins over any in_progress task", () => {
  const tasks = [
    makeTask({ taskId: "task-a", status: "in_progress" }),
    makeTask({ taskId: "task-b", status: "ready" })
  ];
  const queue = buildRuntimeTaskQueue("in_progress", tasks, "task-b");
  assert.equal(queue.current_task_id, "task-b", "activeTaskId overrides in_progress fallback");
});

test("buildRuntimeTaskQueue: falls back to the in_progress task when no activeTaskId given", () => {
  const tasks = [
    makeTask({ taskId: "task-a", status: "ready" }),
    makeTask({ taskId: "task-b", status: "in_progress" })
  ];
  const queue = buildRuntimeTaskQueue("in_progress", tasks);
  assert.equal(queue.current_task_id, "task-b", "in_progress task is the fallback current task");
});

test("buildRuntimeTaskQueue: current_task_id is null when nothing is active or in_progress", () => {
  const tasks = [makeTask({ taskId: "task-a", status: "ready" })];
  const queue = buildRuntimeTaskQueue("ready", tasks);
  assert.equal(queue.current_task_id, null);
});

test("buildRuntimeTaskQueue: projects the immutable TaskRecord.class, never re-derives it", () => {
  // The queue must read task.class (immutable at INSERT), NOT re-derive from the
  // mutable qualityGates — a release_candidate class must survive even when the
  // packet's qualityGates omit release_readiness_required.
  const tasks = [
    makeTask({
      taskId: "task-a",
      status: "ready",
      class: "release_candidate",
      packet: { qualityGates: ["product_acceptance"] }
    })
  ];
  const queue = buildRuntimeTaskQueue("ready", tasks);
  assert.equal(queue.tasks[0]?.class, "release_candidate", "authoritative class projected verbatim");
});

test("buildRuntimeTaskQueue: emits blocker text for blocked and review_blocked tasks only", () => {
  const tasks = [
    makeTask({ taskId: "task-ready", status: "ready" }),
    makeTask({ taskId: "task-blocked", status: "blocked" }),
    makeTask({ taskId: "task-review", status: "review_blocked" })
  ];
  const queue = buildRuntimeTaskQueue("review_blocked", tasks);
  const byId = new Map(queue.tasks.map((task) => [task.id, task]));
  assert.equal(byId.get("task-ready")?.blocker, null, "ready task carries no blocker");
  assert.equal(byId.get("task-blocked")?.blocker, "runtime task blocked");
  assert.equal(byId.get("task-review")?.blocker, "awaiting required reviews");
});

test("buildRuntimeTaskQueue: copies packet fields and derives evidence per task", () => {
  const tasks = [
    makeTask({
      taskId: "task-a",
      status: "ready",
      packet: {
        dependencies: ["dep-1"],
        acceptanceCriteria: ["ac-1"],
        verificationSteps: ["npm test"]
      }
    })
  ];
  const entry = buildRuntimeTaskQueue("ready", tasks).tasks[0];
  assert.deepEqual(entry?.depends_on, ["dep-1"], "dependencies copied as a fresh array");
  assert.deepEqual(entry?.acceptance_criteria, ["ac-1"]);
  assert.deepEqual(entry?.verification, ["npm test"]);
  assert.ok(Array.isArray(entry?.evidence), "evidence derived from verification + gates");
});

// ────────────────────────────────────────────────────────────────────────────
// deriveRunStatus — every branch, in precedence order
// ────────────────────────────────────────────────────────────────────────────

test("deriveRunStatus: empty task set is decomposed", () => {
  assert.equal(deriveRunStatus([]), "decomposed");
});

test("deriveRunStatus: all-done is done", () => {
  const tasks = [
    makeTask({ taskId: "a", status: "done" }),
    makeTask({ taskId: "b", status: "done" })
  ];
  assert.equal(deriveRunStatus(tasks), "done");
});

test("deriveRunStatus: any in_progress wins over blocked/ready siblings", () => {
  const tasks = [
    makeTask({ taskId: "a", status: "in_progress" }),
    makeTask({ taskId: "b", status: "blocked" })
  ];
  assert.equal(deriveRunStatus(tasks), "in_progress");
});

test("deriveRunStatus: review_blocked outranks approved/ready when no task is in_progress", () => {
  const tasks = [
    makeTask({ taskId: "a", status: "review_blocked" }),
    makeTask({ taskId: "b", status: "approved" })
  ];
  assert.equal(deriveRunStatus(tasks), "review_blocked");
});

test("deriveRunStatus: all approved-or-done (with at least one approved) is approved", () => {
  const tasks = [
    makeTask({ taskId: "a", status: "approved" }),
    makeTask({ taskId: "b", status: "done" })
  ];
  assert.equal(deriveRunStatus(tasks), "approved");
});

test("deriveRunStatus: a mixed set with a blocked task falls through to ready", () => {
  const tasks = [
    makeTask({ taskId: "a", status: "blocked" }),
    makeTask({ taskId: "b", status: "ready" })
  ];
  assert.equal(deriveRunStatus(tasks), "ready");
});

test("deriveRunStatus: a single blocked task is ready (the failTask post-state)", () => {
  assert.equal(deriveRunStatus([makeTask({ taskId: "a", status: "blocked" })]), "ready");
});
