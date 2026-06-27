/**
 * Unit tests for dashQuality S3a task drill-down selectors (pure logic).
 *
 * Root node:test runner; web→src wall unaffected.
 * Run: node --experimental-strip-types --test tests/dash-task-detail.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { blockersForTask, hasBlockerDetail } from "../web/src/utils/taskDetail.ts";
import type { BlockerViewModel } from "../web/src/types/dashboard.ts";

function blocker(id: string, taskId: string | undefined): BlockerViewModel {
  return {
    id,
    kind: "review_missing",
    reason: `reason ${id}`,
    nextActions: [`do ${id}`],
    ...(taskId !== undefined ? { taskId } : {}),
    advisory: false,
  };
}

const blockers: BlockerViewModel[] = [
  blocker("b1", "alpha"),
  blocker("b2", "beta"),
  blocker("b3", "alpha"),
  blocker("b4", undefined), // run-level — not attributable to any task
];

describe("taskDetail — S3a drill-down", () => {
  it("returns only blockers whose taskId matches, in order", () => {
    const result = blockersForTask("alpha", blockers);
    assert.deepEqual(result.map((b) => b.id), ["b1", "b3"]);
  });

  it("excludes run-level blockers (no taskId)", () => {
    const result = blockersForTask("alpha", blockers);
    assert.ok(!result.some((b) => b.id === "b4"));
  });

  it("returns empty for a task with no attributable blockers", () => {
    assert.deepEqual(blockersForTask("gamma", blockers), []);
    assert.deepEqual(blockersForTask("alpha", []), []);
  });

  it("hasBlockerDetail reflects presence of attributable blockers", () => {
    assert.equal(hasBlockerDetail("alpha", blockers), true);
    assert.equal(hasBlockerDetail("beta", blockers), true);
    assert.equal(hasBlockerDetail("gamma", blockers), false);
    assert.equal(hasBlockerDetail("alpha", []), false);
  });

  it("never mutates the input", () => {
    const input = [...blockers];
    const snapshot = input.map((b) => b.id);
    blockersForTask("alpha", input);
    assert.deepEqual(input.map((b) => b.id), snapshot);
  });
});
