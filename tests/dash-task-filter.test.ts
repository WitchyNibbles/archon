/**
 * Unit tests for dashQuality S3a in-run Blocked filter (pure logic).
 *
 * Root node:test runner; web→src wall unaffected (type imports erase at runtime).
 * Run: node --experimental-strip-types --test tests/dash-task-filter.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  filterTasks,
  countBlocked,
  isBlockedTask,
  BLOCKED_STATUSES,
} from "../web/src/utils/taskFilter.ts";
import type { TaskQueueEntryViewModel } from "../web/src/types/dashboard.ts";

function task(
  taskId: string,
  status: TaskQueueEntryViewModel["status"]
): TaskQueueEntryViewModel {
  return { taskId, title: `T ${taskId}`, status, ownerRole: "planner", blockers: [], updatedAt: "2026-06-27T00:00:00Z" };
}

const queue: TaskQueueEntryViewModel[] = [
  task("a", "in_progress"),
  task("b", "blocked"),
  task("c", "review_blocked"),
  task("d", "ready"),
  task("e", "done"),
  task("f", "approved"),
];

describe("taskFilter — S3a Blocked filter", () => {
  it("BLOCKED_STATUSES is exactly {blocked, review_blocked}", () => {
    assert.deepEqual([...BLOCKED_STATUSES].sort(), ["blocked", "review_blocked"]);
  });

  it("isBlockedTask true only for blocked + review_blocked", () => {
    assert.equal(isBlockedTask(task("x", "blocked")), true);
    assert.equal(isBlockedTask(task("x", "review_blocked")), true);
    assert.equal(isBlockedTask(task("x", "in_progress")), false);
    assert.equal(isBlockedTask(task("x", "ready")), false);
    assert.equal(isBlockedTask(task("x", "done")), false);
    assert.equal(isBlockedTask(task("x", "approved")), false);
  });

  it("countBlocked counts both blocked statuses", () => {
    assert.equal(countBlocked(queue), 2);
    assert.equal(countBlocked([]), 0);
    assert.equal(countBlocked([task("x", "in_progress")]), 0);
  });

  it("filter 'all' returns the same reference (no needless copy)", () => {
    assert.equal(filterTasks(queue, "all"), queue);
  });

  it("filter 'blocked' returns only blocked tasks, preserving order", () => {
    const result = filterTasks(queue, "blocked");
    assert.deepEqual(result.map((t) => t.taskId), ["b", "c"]);
  });

  it("filter 'blocked' on a queue with none blocked returns empty (honest empty state)", () => {
    const result = filterTasks([task("a", "in_progress"), task("d", "ready")], "blocked");
    assert.deepEqual(result, []);
  });

  it("filterTasks never mutates the input", () => {
    const input = [...queue];
    const snapshot = input.map((t) => t.taskId);
    filterTasks(input, "blocked");
    assert.deepEqual(input.map((t) => t.taskId), snapshot);
  });
});
