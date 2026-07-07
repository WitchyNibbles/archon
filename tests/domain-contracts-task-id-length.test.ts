import test from "node:test";
import assert from "node:assert/strict";

import { validateTaskPacket, MAX_TASK_ID_LENGTH } from "../src/domain/contracts.ts";
import { buildInitiativeRecords } from "../src/admin/init-task.ts";

// ---------------------------------------------------------------------------
// Round-13 MEDIUM fix (contributing cause): task ids are agent-chosen,
// unbounded strings — one contributing factor in the round-13 vocabulary-
// laundering CRITICAL (why-vocabulary.ts). validateTaskPacket now bounds
// taskId length; admin/init-task.ts's buildInitiativeRecords shares the
// SAME MAX_TASK_ID_LENGTH constant.
// ---------------------------------------------------------------------------

function validPacket(taskId: string) {
  const { task } = buildInitiativeRecords({
    id: "valid-base-task-id",
    title: "Valid base task",
    ownerRole: "backend_engineer",
    goal: "A goal.",
    allowedWriteScope: ["src", "tests"],
    workspaceId: "ws1",
    projectId: "p1",
    runId: "run-uuid",
    taskUuid: "task-uuid",
    now: "2026-07-07T00:00:00.000Z"
  });
  return { ...task.packet, taskId };
}

test("validateTaskPacket: a taskId at exactly MAX_TASK_ID_LENGTH is valid", () => {
  const packet = validPacket("a".repeat(MAX_TASK_ID_LENGTH));
  const errors = validateTaskPacket(packet);
  assert.equal(
    errors.some((e) => e.includes("taskId must be at most")),
    false,
    `unexpected length error: ${JSON.stringify(errors)}`
  );
});

test("validateTaskPacket: a taskId one character over MAX_TASK_ID_LENGTH is rejected", () => {
  const packet = validPacket("a".repeat(MAX_TASK_ID_LENGTH + 1));
  const errors = validateTaskPacket(packet);
  assert.ok(
    errors.some((e) => e.includes("taskId must be at most")),
    `expected a length error, got: ${JSON.stringify(errors)}`
  );
});

test("validateTaskPacket: an empty taskId still reports the original 'required' error, not a length error", () => {
  const packet = validPacket("");
  const errors = validateTaskPacket(packet);
  assert.ok(errors.includes("taskId is required"));
  assert.equal(errors.some((e) => e.includes("must be at most")), false);
});
