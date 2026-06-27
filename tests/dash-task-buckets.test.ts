/**
 * Unit tests for the dashQuality S1 task-bucketing logic — the void fix (C13/qa).
 *
 * `bucketTasks` is the core grouping that makes every task visible (the old
 * swimlane dropped every non-review task). Pure, web-local, no React/DOM — tested
 * here with the root node:test runner (root tsconfig excludes tests/; `import type`
 * is erased at runtime; the one-directional R2-C web→src wall is unaffected).
 *
 * Run: node --experimental-strip-types --test tests/dash-task-buckets.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bucketTasks, BUCKETS } from "../web/src/utils/taskBuckets.ts";
import type { TaskQueueEntryViewModel } from "../web/src/types/dashboard.ts";

function task(taskId: string, status: string): TaskQueueEntryViewModel {
  // Only `status` and `taskId` matter to bucketTasks; the rest satisfies the shape.
  return {
    taskId,
    title: taskId,
    status,
    ownerRole: "backend_engineer",
    blockers: [],
  } as unknown as TaskQueueEntryViewModel;
}

describe("bucketTasks — the S1 void fix (full taskQueue, no drops)", () => {
  it("every valid task status routes into exactly one bucket", () => {
    const tasks = [
      task("t-ready", "ready"),
      task("t-inprog", "in_progress"),
      task("t-revblocked", "review_blocked"),
      task("t-approved", "approved"),
      task("t-done", "done"),
      task("t-blocked", "blocked"),
    ];
    const buckets = bucketTasks(tasks);
    const total =
      (buckets.get("blocked")?.length ?? 0) +
      (buckets.get("in_progress")?.length ?? 0) +
      (buckets.get("ready")?.length ?? 0) +
      (buckets.get("done")?.length ?? 0);
    // No valid task is dropped — this is the void fix's core guarantee.
    assert.equal(total, tasks.length, "all 6 valid statuses must land in a bucket");
  });

  it("routes each status to the correct bucket (incl. review_blocked → blocked, approved → done)", () => {
    const buckets = bucketTasks([
      task("a", "blocked"),
      task("b", "review_blocked"),
      task("c", "in_progress"),
      task("d", "ready"),
      task("e", "approved"),
      task("f", "done"),
    ]);
    assert.deepEqual(buckets.get("blocked")?.map((t) => t.taskId), ["a", "b"]);
    assert.deepEqual(buckets.get("in_progress")?.map((t) => t.taskId), ["c"]);
    assert.deepEqual(buckets.get("ready")?.map((t) => t.taskId), ["d"]);
    assert.deepEqual(buckets.get("done")?.map((t) => t.taskId), ["e", "f"]);
  });

  it("preserves task order within a bucket", () => {
    const buckets = bucketTasks([
      task("first", "done"),
      task("second", "done"),
      task("third", "done"),
    ]);
    assert.deepEqual(buckets.get("done")?.map((t) => t.taskId), ["first", "second", "third"]);
  });

  it("always returns all four bucket keys, even when empty", () => {
    const buckets = bucketTasks([]);
    for (const b of BUCKETS) {
      assert.ok(buckets.has(b.id), `bucket "${b.id}" must always be present`);
      assert.equal(buckets.get(b.id)?.length, 0);
    }
  });

  it("silently omits a task whose status is not recognised (defensive drop)", () => {
    const buckets = bucketTasks([
      task("good", "in_progress"),
      task("bogus", "not_a_real_status"),
    ]);
    const total =
      (buckets.get("blocked")?.length ?? 0) +
      (buckets.get("in_progress")?.length ?? 0) +
      (buckets.get("ready")?.length ?? 0) +
      (buckets.get("done")?.length ?? 0);
    assert.equal(total, 1, "only the valid task is bucketed; the bogus-status task is dropped");
    assert.deepEqual(buckets.get("in_progress")?.map((t) => t.taskId), ["good"]);
  });
});
