import test from "node:test";
import assert from "node:assert/strict";

import { buildInitiativeRecords } from "../src/admin/init-task.ts";
import { MAX_TASK_ID_LENGTH } from "../src/domain/contracts.ts";

// ---------------------------------------------------------------------------
// Round-13 MEDIUM fix (contributing cause): task ids are agent-chosen,
// unbounded strings. buildInitiativeRecords (the `init-task` CLI's own
// creation-time validation, separate from validateTaskPacket) now bounds
// `--id` length to the SAME shared MAX_TASK_ID_LENGTH constant.
// ---------------------------------------------------------------------------

function baseInput(id: string) {
  return {
    id,
    title: "A task",
    ownerRole: "backend_engineer",
    goal: "A goal.",
    allowedWriteScope: ["src", "tests"],
    workspaceId: "ws1",
    projectId: "p1",
    runId: "run-uuid",
    taskUuid: "task-uuid",
    now: "2026-07-07T00:00:00.000Z"
  };
}

test("buildInitiativeRecords: an --id at exactly MAX_TASK_ID_LENGTH is accepted", () => {
  const id = "a".repeat(MAX_TASK_ID_LENGTH);
  const { task } = buildInitiativeRecords(baseInput(id));
  assert.equal(task.packet.taskId, id);
});

test("buildInitiativeRecords: an --id one character over MAX_TASK_ID_LENGTH is rejected", () => {
  const id = "a".repeat(MAX_TASK_ID_LENGTH + 1);
  assert.throws(() => buildInitiativeRecords(baseInput(id)), /must be at most \d+ characters/);
});

test("buildInitiativeRecords: an --id far over MAX_TASK_ID_LENGTH (e.g. the round-13 gate's secret-shaped repro) is rejected", () => {
  const id = "hunter2Aa1SuperSecret9".repeat(10);
  assert.throws(() => buildInitiativeRecords(baseInput(id)), /must be at most \d+ characters/);
});
