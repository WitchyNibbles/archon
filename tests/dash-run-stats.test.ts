/**
 * Unit tests for dashQuality S4 run-level rollup stats (pure logic).
 *
 * Root node:test runner; web→src wall unaffected (type imports erase at runtime).
 * Run: node --experimental-strip-types --test tests/dash-run-stats.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeRunStats } from "../web/src/utils/runStats.ts";
import type {
  ReviewGateViewModel,
  TaskQueueEntryViewModel,
} from "../web/src/types/dashboard.ts";

function task(
  taskId: string,
  status: TaskQueueEntryViewModel["status"]
): TaskQueueEntryViewModel {
  return {
    taskId,
    title: `Task ${taskId}`,
    status,
    ownerRole: "backend_engineer",
    blockers: [],
    updatedAt: "2026-06-24T00:00:00Z",
  };
}

function gate(
  taskId: string,
  role: ReviewGateViewModel["role"],
  state: ReviewGateViewModel["state"]
): ReviewGateViewModel {
  return { taskId, role, state };
}

describe("computeRunStats — task bucket counts", () => {
  it("counts each status into its bucket and totals them", () => {
    const stats = computeRunStats(
      [
        task("a", "review_blocked"),
        task("b", "blocked"),
        task("c", "in_progress"),
        task("d", "ready"),
        task("e", "approved"),
        task("f", "done"),
      ],
      []
    );
    assert.equal(stats.total, 6);
    assert.equal(stats.blocked, 2, "blocked + review_blocked → blocked bucket");
    assert.equal(stats.inProgress, 1);
    assert.equal(stats.ready, 1);
    assert.equal(stats.done, 2, "approved + done → done bucket");
  });

  it("returns zeroed stats and 0 doneFraction for an empty queue", () => {
    const stats = computeRunStats([], []);
    assert.equal(stats.total, 0);
    assert.equal(stats.blocked, 0);
    assert.equal(stats.done, 0);
    assert.equal(stats.doneFraction, 0, "no divide-by-zero on an empty run");
  });

  it("computes doneFraction as done/total", () => {
    const stats = computeRunStats(
      [task("a", "done"), task("b", "done"), task("c", "blocked"), task("d", "ready")],
      []
    );
    assert.equal(stats.doneFraction, 0.5);
  });

  it("emits segments in BLOCKED → IN PROGRESS → READY → DONE order", () => {
    const stats = computeRunStats([task("a", "blocked"), task("b", "done")], []);
    assert.deepEqual(
      stats.segments.map((s) => s.id),
      ["blocked", "in_progress", "ready", "done"]
    );
    assert.equal(stats.segments[0]?.count, 1);
    assert.equal(stats.segments[3]?.count, 1);
  });
});

describe("computeRunStats — review gate tally", () => {
  it("counts passed + waived as passed, and blocked separately", () => {
    const stats = computeRunStats(
      [task("a", "review_blocked")],
      [
        gate("a", "reviewer", "pending"),
        gate("a", "security_reviewer", "blocked"),
        gate("a", "qa_engineer", "passed"),
        gate("a", "reviewer", "waived"),
      ]
    );
    assert.equal(stats.gatesTotal, 4);
    assert.equal(stats.gatesPassed, 2, "passed + waived");
    assert.equal(stats.gatesBlocked, 1);
  });

  it("matches the committed fixture's gate shape (1 passed, 1 blocked of 6)", () => {
    // Mirrors web/public/snapshot.json: 6 gates, qa passed on alpha, sec blocked on alpha.
    const gates: ReviewGateViewModel[] = [
      gate("sample-task-alpha", "reviewer", "pending"),
      gate("sample-task-alpha", "security_reviewer", "blocked"),
      gate("sample-task-alpha", "qa_engineer", "passed"),
      gate("sample-task-beta", "reviewer", "pending"),
      gate("sample-task-beta", "security_reviewer", "pending"),
      gate("sample-task-beta", "qa_engineer", "pending"),
    ];
    const stats = computeRunStats([], gates);
    assert.equal(stats.gatesTotal, 6);
    assert.equal(stats.gatesPassed, 1);
    assert.equal(stats.gatesBlocked, 1);
  });
});
