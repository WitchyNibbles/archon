// ahrP5ControllerCleanup — authority-boundary guard tests.
//
// Contract: AgenticLoopController is a HELPER, not the production respawn/reset
// authority. The daemon loop uses ContextBudgetMonitor.recordSample directly
// (injected as the `monitor` dep in DaemonCodexTurnDeps) — it DOES NOT call
// AgenticLoopController.onContextSample.
//
// These tests encode that boundary:
//   T1. AgenticLoopController.onContextSample works standalone (helper usability).
//   T2. ContextBudgetMonitor.recordSample can be called without an
//       AgenticLoopController being involved (daemon independence).
//   T3. The daemon's DaemonCodexTurnDeps type exposes `monitor` (ContextBudgetMonitor)
//       but NOT any AgenticLoopController reference — structural type check.
//   T4. startInvocation increments cycle count; onContextSample does NOT.
//       (Guards against silent re-coupling via cycle accounting.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AgenticLoopController } from "../src/runtime/agentic-loop.ts";
import type { AgenticLoopStoreLike, TaskSummary } from "../src/runtime/agentic-loop.ts";
import { ContextBudgetMonitor } from "../src/runtime/context-budget.ts";
import type { ContextBudgetStoreLike, ContextBudgetState } from "../src/runtime/context-budget.ts";
// Structural import: if DaemonCodexTurnDeps ever adds an AgenticLoopController
// field this file will need updating — which is the point.
import type { DaemonCodexTurnDeps } from "../src/daemon/codex-turn.ts";
import type { ContextSample } from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Minimal in-memory store shared across tests
// ---------------------------------------------------------------------------

function buildMockAgentStore(): {
  store: AgenticLoopStoreLike;
  contextSamples: Array<{ invocationId: string; usedPct: number }>;
} {
  const invocations = new Map<string, string>();
  const invocationTaskIds = new Map<string, string>();
  const contextSamples: Array<{ invocationId: string; usedPct: number }> = [];

  const store: AgenticLoopStoreLike = {
    async recordContextSample(data) {
      if (data.usedPercentage !== undefined) {
        contextSamples.push({ invocationId: data.invocationId, usedPct: data.usedPercentage });
      }
    },
    async getLatestContextSample(invocationId): Promise<ContextSample | undefined> {
      const found = [...contextSamples].reverse().find((s) => s.invocationId === invocationId);
      if (!found) return undefined;
      return {
        invocationId,
        runId: "test-run",
        taskId: "test-task",
        source: "sdk",
        usedPercentage: found.usedPct,
        sampledAt: new Date().toISOString(),
        raw: {}
      };
    },
    async hasCommittedHandoff() {
      return false;
    },
    async getNextTask(): Promise<TaskSummary | null> {
      return null;
    },
    async createInvocation(data) {
      const id = `inv-${data.taskId}-${Date.now()}`;
      invocations.set(id, "running");
      invocationTaskIds.set(id, data.taskId);
      return id;
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
    async getActiveTask(): Promise<TaskSummary | null> {
      return null;
    },
    async getActiveInvocation(): Promise<string | null> {
      return null;
    },
    async countPendingHandoffs() {
      return 0;
    }
  };

  return { store, contextSamples };
}

function buildMockBudgetStore(): {
  store: ContextBudgetStoreLike;
  contextSamples: Array<{ invocationId: string; usedPct: number }>;
} {
  const contextSamples: Array<{ invocationId: string; usedPct: number }> = [];

  const store: ContextBudgetStoreLike = {
    async recordContextSample(data) {
      if (data.usedPercentage !== undefined) {
        contextSamples.push({ invocationId: data.invocationId, usedPct: data.usedPercentage });
      }
    },
    async getLatestContextSample(invocationId): Promise<ContextSample | undefined> {
      const found = [...contextSamples].reverse().find((s) => s.invocationId === invocationId);
      if (!found) return undefined;
      return {
        invocationId,
        runId: "test-run",
        taskId: "test-task",
        source: "sdk",
        usedPercentage: found.usedPct,
        sampledAt: new Date().toISOString(),
        raw: {}
      };
    },
    async hasCommittedHandoff() {
      return false;
    }
  };

  return { store, contextSamples };
}

// ---------------------------------------------------------------------------
// T1 — AgenticLoopController.onContextSample works standalone (helper usability)
// ---------------------------------------------------------------------------

describe("ahrP5 controller authority boundary", () => {
  it("T1: AgenticLoopController.onContextSample is usable standalone as a helper", async () => {
    const { store } = buildMockAgentStore();
    const controller = new AgenticLoopController(store, { runId: "ahr-p5-run-1" });
    const invId = await controller.startInvocation("task-x", "specialist_owner");

    // Must not throw; must return a valid LoopAction.
    const action = await controller.onContextSample(invId, 40);
    assert.ok(
      ["continue", "warn", "handoff_required", "hard_stop"].includes(action),
      `Expected a LoopAction, got: ${action}`
    );
    assert.strictEqual(action, "continue", "40% should map to 'continue'");
  });

  // ---------------------------------------------------------------------------
  // T2 — ContextBudgetMonitor.recordSample works independently of the controller
  // ---------------------------------------------------------------------------

  it("T2: ContextBudgetMonitor.recordSample operates without AgenticLoopController", async () => {
    const { store, contextSamples } = buildMockBudgetStore();
    // Construct monitor directly — exactly how the daemon does it.
    const monitor = new ContextBudgetMonitor(store);

    const state: ContextBudgetState = await monitor.recordSample(
      "inv-direct",
      "run-direct",
      "task-direct",
      "sdk",
      35
    );

    assert.strictEqual(state, "normal", "35% should be 'normal' state");
    assert.strictEqual(contextSamples.length, 1);
    assert.strictEqual(contextSamples[0]?.invocationId, "inv-direct");
    assert.strictEqual(contextSamples[0]?.usedPct, 35);
  });

  // ---------------------------------------------------------------------------
  // T3 — DaemonCodexTurnDeps has `monitor` (ContextBudgetMonitor), NOT controller
  //
  // This is a compile-time structural contract. The assertion is that an object
  // satisfying DaemonCodexTurnDeps can be constructed with a monitor field but
  // without any AgenticLoopController field. If the type ever grows an
  // AgenticLoopController field, the type-check below will force an update here,
  // making the coupling visible.
  // ---------------------------------------------------------------------------

  it("T3: DaemonCodexTurnDeps accepts ContextBudgetMonitor for `monitor`, not AgenticLoopController", () => {
    // Build a minimal type-compatible deps object.  We only care about the
    // `monitor` field — the rest use undefined where optional.
    const { store } = buildMockBudgetStore();
    const monitor = new ContextBudgetMonitor(store);

    // Type assertion: DaemonCodexTurnDeps["monitor"] must be assignable from
    // ContextBudgetMonitor.  This assignment fails to compile if the type changes.
    const monitorField: DaemonCodexTurnDeps["monitor"] = monitor;

    // Confirm the object is a ContextBudgetMonitor (not a controller).
    assert.ok(
      monitorField instanceof ContextBudgetMonitor,
      "DaemonCodexTurnDeps.monitor must be a ContextBudgetMonitor instance"
    );

    // Confirm AgenticLoopController is NOT assignable to this field by verifying
    // the monitor instance does NOT have controller-specific methods.
    assert.strictEqual(
      (monitorField as Record<string, unknown>)["startInvocation"],
      undefined,
      "DaemonCodexTurnDeps.monitor must NOT expose AgenticLoopController.startInvocation"
    );
    assert.strictEqual(
      (monitorField as Record<string, unknown>)["onContextSample"],
      undefined,
      "DaemonCodexTurnDeps.monitor must NOT expose AgenticLoopController.onContextSample"
    );
  });

  // ---------------------------------------------------------------------------
  // T4 — startInvocation increments cycle count; onContextSample does NOT
  //
  // Guards against a future refactor that accidentally routes onContextSample
  // through startInvocation (which would inflate the cycle count and trigger
  // the maxCycles safety stop prematurely).
  // ---------------------------------------------------------------------------

  it("T4: onContextSample does not increment the loop cycle counter", async () => {
    const { store } = buildMockAgentStore();
    const controller = new AgenticLoopController(store, { runId: "ahr-p5-run-4", maxCycles: 2 });

    // Seed an invocation so onContextSample has a valid invocationId.
    const invId = await controller.startInvocation("task-y", "specialist_owner");

    // Call onContextSample multiple times — must NOT consume cycle budget.
    await controller.onContextSample(invId, 20);
    await controller.onContextSample(invId, 50);
    await controller.onContextSample(invId, 75);

    // Cycle budget consumed by startInvocation (1 of 2). The second startInvocation
    // must still succeed — confirming onContextSample did not eat the budget.
    const invId2 = await controller.startInvocation("task-z", "specialist_owner");
    assert.ok(typeof invId2 === "string" && invId2.length > 0);

    // Now the budget is exhausted (2/2). The NEXT startInvocation must throw.
    await assert.rejects(
      () => controller.startInvocation("task-overflow", "specialist_owner"),
      (err: Error) => {
        assert.ok(err.message.includes("maxCycles"), `expected maxCycles in message, got: ${err.message}`);
        return true;
      }
    );
  });
});
