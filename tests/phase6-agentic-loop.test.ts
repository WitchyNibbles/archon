// Phase 6 — AgenticLoopController unit tests.
//
// All tests use an in-memory mock store; no DB connection required.
// Uses node:test (the project test runner).

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AgenticLoopController } from "../src/runtime/agentic-loop.ts";
import type { AgenticLoopStoreLike, TaskSummary } from "../src/runtime/agentic-loop.ts";
import type { ContextSample } from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Minimal in-memory mock store
// ---------------------------------------------------------------------------

function buildMockStore(opts: {
  nextTask?: TaskSummary | null;
  activeTask?: TaskSummary | null;
  activeInvocation?: string | null;
  pendingHandoffs?: number;
} = {}): {
  store: AgenticLoopStoreLike;
  invocations: Map<string, string>;
  contextSamples: Map<string, number>;
} {
  const invocations = new Map<string, string>(); // invocationId → status
  const invocationTaskIds = new Map<string, string>(); // invocationId → taskId
  const contextSamples = new Map<string, number>(); // invocationId → usedPercentage

  const store: AgenticLoopStoreLike = {
    // ContextBudgetStoreLike
    async recordContextSample(data) {
      if (data.usedPercentage !== undefined) {
        contextSamples.set(data.invocationId, data.usedPercentage);
      }
    },
    async getLatestContextSample(invocationId): Promise<ContextSample | undefined> {
      const pct = contextSamples.get(invocationId);
      if (pct === undefined) return undefined;
      return {
        invocationId,
        runId: "test-run",
        taskId: "test-task",
        source: "sdk",
        usedPercentage: pct,
        sampledAt: new Date().toISOString(),
        raw: {}
      };
    },
    async hasCommittedHandoff() {
      return false;
    },
    // AgenticLoopStoreLike
    async getNextTask() {
      return opts.nextTask ?? null;
    },
    async createInvocation(data) {
      const invocationId = `inv-${data.taskId}-${Date.now()}`;
      invocations.set(invocationId, "running");
      invocationTaskIds.set(invocationId, data.taskId);
      return invocationId;
    },
    async updateInvocationStatus(invocationId, status) {
      invocations.set(invocationId, status);
    },
    async getInvocationStatus(invocationId) {
      return invocations.get(invocationId);
    },
    async getInvocationTaskId(invocationId) {
      return invocationTaskIds.get(invocationId);
    },
    async getActiveTask() {
      return opts.activeTask ?? null;
    },
    async getActiveInvocation() {
      return opts.activeInvocation ?? null;
    },
    async countPendingHandoffs() {
      return opts.pendingHandoffs ?? 0;
    }
  };

  return { store, invocations, contextSamples };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("phase6 agentic loop controller", () => {
  it("selectNextTask returns null when no tasks in queue", async () => {
    const { store } = buildMockStore({ nextTask: null });
    const controller = new AgenticLoopController(store, { runId: "run-1" });
    const task = await controller.selectNextTask();
    assert.strictEqual(task, null);
  });

  it("selectNextTask returns task when one is available", async () => {
    const expected: TaskSummary = { id: "task-abc", title: "Test Task", status: "ready" };
    const { store } = buildMockStore({ nextTask: expected });
    const controller = new AgenticLoopController(store, { runId: "run-2" });
    const task = await controller.selectNextTask();
    assert.deepEqual(task, expected);
  });

  it("startInvocation creates invocation record with status running", async () => {
    const { store, invocations } = buildMockStore();
    const controller = new AgenticLoopController(store, { runId: "run-3" });
    const invocationId = await controller.startInvocation("task-1", "backend_engineer");
    assert.ok(typeof invocationId === "string" && invocationId.length > 0);
    assert.strictEqual(invocations.get(invocationId), "running");
  });

  it("onContextSample at 69% returns warn", async () => {
    const { store } = buildMockStore();
    const controller = new AgenticLoopController(store, { runId: "run-4" });
    const action = await controller.onContextSample("inv-warn", 69);
    assert.strictEqual(action, "warn");
  });

  it("onContextSample at 70% returns handoff_required", async () => {
    const { store } = buildMockStore();
    const controller = new AgenticLoopController(store, { runId: "run-5" });
    const action = await controller.onContextSample("inv-handoff", 70);
    assert.strictEqual(action, "handoff_required");
  });

  it("onContextSample at 80% returns hard_stop", async () => {
    const { store } = buildMockStore();
    const controller = new AgenticLoopController(store, { runId: "run-6" });
    const action = await controller.onContextSample("inv-stop", 80);
    assert.strictEqual(action, "hard_stop");
  });

  it("onTaskComplete updates invocation status to completed", async () => {
    const { store, invocations } = buildMockStore();
    const controller = new AgenticLoopController(store, { runId: "run-7" });
    const invocationId = await controller.startInvocation("task-done", "reviewer");
    assert.strictEqual(invocations.get(invocationId), "running");
    await controller.onTaskComplete(invocationId, "task-done");
    assert.strictEqual(invocations.get(invocationId), "completed");
  });

  it("getLoopStatus returns correct contextState and activeTask", async () => {
    const activeTask: TaskSummary = { id: "task-active", title: "Active Task", status: "in_progress" };
    const { store } = buildMockStore({
      activeTask,
      activeInvocation: "inv-active",
      pendingHandoffs: 2
    });
    const controller = new AgenticLoopController(store, { runId: "run-8" });

    // Record a context sample so the state cache is populated.
    await controller.onContextSample("inv-active", 72);

    const status = await controller.getLoopStatus("run-8");
    assert.strictEqual(status.runId, "run-8");
    assert.deepEqual(status.activeTask, activeTask);
    assert.strictEqual(status.activeInvocation, "inv-active");
    assert.strictEqual(status.contextState, "handoff_required");
    assert.strictEqual(status.handoffsPending, 2);
    assert.strictEqual(status.cycleCount, 0); // onContextSample does not increment cycles; only startInvocation does
  });

  it("loop respects maxCycles safety stop", async () => {
    const { store } = buildMockStore({ nextTask: { id: "t1", title: "Task 1", status: "ready" } });
    const controller = new AgenticLoopController(store, { runId: "run-9", maxCycles: 2 });

    // Consume both allowed cycles.
    await controller.startInvocation("t1", "planner");
    await controller.startInvocation("t1", "planner");

    // Third start must throw.
    await assert.rejects(
      async () => controller.startInvocation("t1", "planner"),
      (err: Error) => {
        assert.ok(err.message.includes("maxCycles"), `expected maxCycles in message, got: ${err.message}`);
        return true;
      }
    );
  });
});
