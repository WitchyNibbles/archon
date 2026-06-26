// Phase 2 — Context Budget Monitor unit tests.
//
// Uses node:test + node:assert/strict.  No real database connection.
// All store operations are covered by an in-memory stub.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ContextBudgetMonitor,
  defaultArchonContextPolicy,
  resolveDaemonContextMonitorMode,
  type ContextBudgetStoreLike,
  type ContextThresholdEvent
} from "../src/runtime/context-budget.ts";
import type { ContextSample } from "../src/domain/types.ts";
import type { RecordContextSampleInput } from "../src/store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// In-memory store stub
// ---------------------------------------------------------------------------

class StubStore implements ContextBudgetStoreLike {
  readonly samples: RecordContextSampleInput[] = [];
  private committedHandoffs = new Set<string>();

  async recordContextSample(data: RecordContextSampleInput): Promise<void> {
    this.samples.push({ ...data });
  }

  async getLatestContextSample(invocationId: string): Promise<ContextSample | undefined> {
    const matching = this.samples.filter((s) => s.invocationId === invocationId);
    if (matching.length === 0) return undefined;
    const last = matching[matching.length - 1]!;
    return {
      invocationId: last.invocationId,
      runId: last.runId,
      taskId: last.taskId,
      source: last.source,
      usedPercentage: last.usedPercentage,
      sampledAt: last.sampledAt ?? new Date().toISOString(),
      raw: last.raw ?? {}
    };
  }

  async hasCommittedHandoff(invocationId: string): Promise<boolean> {
    return this.committedHandoffs.has(invocationId);
  }

  addHandoff(invocationId: string): void {
    this.committedHandoffs.add(invocationId);
  }

  reset(): void {
    this.samples.length = 0;
    this.committedHandoffs.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monitor(store: StubStore, policy?: Parameters<typeof ContextBudgetMonitor>[1]): ContextBudgetMonitor {
  return new ContextBudgetMonitor(store, policy);
}

// ---------------------------------------------------------------------------
// defaultArchonContextPolicy
// ---------------------------------------------------------------------------

describe("defaultArchonContextPolicy", () => {
  it("has handoffPct=70, warningPct=60, hardStopPct=80", () => {
    assert.equal(defaultArchonContextPolicy.handoffPct, 70);
    assert.equal(defaultArchonContextPolicy.warningPct, 60);
    assert.equal(defaultArchonContextPolicy.hardStopPct, 80);
  });
});

// ---------------------------------------------------------------------------
// evaluate — state machine (pure, no I/O)
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.evaluate", () => {
  it("returns normal below warningPct", () => {
    const m = monitor(new StubStore());
    assert.equal(m.evaluate(0), "normal");
    assert.equal(m.evaluate(59.9), "normal");
  });

  it("returns warning at warningPct (60)", () => {
    const m = monitor(new StubStore());
    assert.equal(m.evaluate(60), "warning");
    assert.equal(m.evaluate(69.9), "warning");
  });

  it("returns handoff_required at handoffPct (70)", () => {
    const m = monitor(new StubStore());
    assert.equal(m.evaluate(70), "handoff_required");
    assert.equal(m.evaluate(79.9), "handoff_required");
  });

  it("returns hard_stop at hardStopPct (80)", () => {
    const m = monitor(new StubStore());
    assert.equal(m.evaluate(80), "hard_stop");
    assert.equal(m.evaluate(100), "hard_stop");
  });

  it("context sample at 69.9 does not trigger handoff_required", () => {
    const m = monitor(new StubStore());
    const state = m.evaluate(69.9);
    assert.notEqual(state, "handoff_required");
    assert.notEqual(state, "hard_stop");
  });

  it("context sample at 70.0 triggers handoff_required", () => {
    const m = monitor(new StubStore());
    assert.equal(m.evaluate(70.0), "handoff_required");
  });

  it("context sample at 80.0 triggers hard_stop", () => {
    const m = monitor(new StubStore());
    assert.equal(m.evaluate(80.0), "hard_stop");
  });

  it("respects custom policy thresholds", () => {
    const m = monitor(new StubStore(), { warningPct: 50, handoffPct: 65, hardStopPct: 75 });
    assert.equal(m.evaluate(49.9), "normal");
    assert.equal(m.evaluate(50), "warning");
    assert.equal(m.evaluate(65), "handoff_required");
    assert.equal(m.evaluate(75), "hard_stop");
  });
});

// ---------------------------------------------------------------------------
// getCurrentState — in-memory cache
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.getCurrentState", () => {
  it("returns normal for unknown invocation", () => {
    const m = monitor(new StubStore());
    assert.equal(m.getCurrentState("inv-unknown"), "normal");
  });

  it("returns cached state after recordSample", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 65);
    assert.equal(m.getCurrentState("inv-1"), "warning");
  });
});

// ---------------------------------------------------------------------------
// recordSample — persistence + events
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.recordSample", () => {
  it("persists the sample to the store", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 55);
    assert.equal(store.samples.length, 1);
    assert.equal(store.samples[0]!.usedPercentage, 55);
    assert.equal(store.samples[0]!.invocationId, "inv-1");
  });

  it("returns normal state for sub-warning sample", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const state = await m.recordSample("inv-1", "run-1", "task-1", "auto", 30);
    assert.equal(state, "normal");
  });

  it("returns warning state at 60%", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const state = await m.recordSample("inv-1", "run-1", "task-1", "sdk", 60);
    assert.equal(state, "warning");
  });

  it("returns handoff_required state at 70%", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const state = await m.recordSample("inv-1", "run-1", "task-1", "sdk", 70);
    assert.equal(state, "handoff_required");
  });

  it("returns hard_stop state at 80%", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const state = await m.recordSample("inv-1", "run-1", "task-1", "sdk", 80);
    assert.equal(state, "hard_stop");
  });

  it("emits warning event on transition to warning", async () => {
    const store = new StubStore();
    const m = monitor(store);
    let event: ContextThresholdEvent | undefined;
    m.on("warning", (evt) => { event = evt; });
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 65);
    assert.ok(event, "warning event should have been emitted");
    assert.equal(event!.newState, "warning");
    assert.equal(event!.previousState, "normal");
    assert.equal(event!.invocationId, "inv-1");
  });

  it("emits handoff_required event on transition", async () => {
    const store = new StubStore();
    const m = monitor(store);
    let event: ContextThresholdEvent | undefined;
    m.on("handoff_required", (evt) => { event = evt; });
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 72);
    assert.ok(event, "handoff_required event should have been emitted");
    assert.equal(event!.newState, "handoff_required");
  });

  it("emits hard_stop event on transition", async () => {
    const store = new StubStore();
    const m = monitor(store);
    let event: ContextThresholdEvent | undefined;
    m.on("hard_stop", (evt) => { event = evt; });
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 85);
    assert.ok(event, "hard_stop event should have been emitted");
    assert.equal(event!.newState, "hard_stop");
  });

  it("does not emit duplicate events for same state on repeated samples", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const events: ContextThresholdEvent[] = [];
    m.on("warning", (evt) => events.push(evt));
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 65);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 68);
    assert.equal(events.length, 1, "warning event should fire only once for same state");
  });

  it("state can revert from warning back to normal", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 65);
    assert.equal(m.getCurrentState("inv-1"), "warning");
    // If usage drops below warning, evaluate returns normal
    // (note: stateCache updates on each recordSample)
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 50);
    assert.equal(m.getCurrentState("inv-1"), "normal");
  });

  it("passes rawData to the store", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const raw = { tokens: 12_000, windowSize: 20_000 };
    await m.recordSample("inv-1", "run-1", "task-1", "sdk", 60, raw);
    assert.deepEqual(store.samples[0]!.raw, raw);
  });
});

// ---------------------------------------------------------------------------
// getThresholdCrossed
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.getThresholdCrossed", () => {
  it("returns false when no samples exist", async () => {
    const store = new StubStore();
    const m = monitor(store);
    assert.equal(await m.getThresholdCrossed("inv-1"), false);
  });

  it("returns false when sample is below handoffPct", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await store.recordContextSample({ invocationId: "inv-1", runId: "r", taskId: "t", source: "auto", usedPercentage: 69, sampledAt: new Date().toISOString(), raw: {} });
    assert.equal(await m.getThresholdCrossed("inv-1"), false);
  });

  it("returns true when sample is at handoffPct (70)", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await store.recordContextSample({ invocationId: "inv-1", runId: "r", taskId: "t", source: "auto", usedPercentage: 70, sampledAt: new Date().toISOString(), raw: {} });
    assert.equal(await m.getThresholdCrossed("inv-1"), true);
  });

  it("returns true when sample is above handoffPct", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await store.recordContextSample({ invocationId: "inv-1", runId: "r", taskId: "t", source: "auto", usedPercentage: 80, sampledAt: new Date().toISOString(), raw: {} });
    assert.equal(await m.getThresholdCrossed("inv-1"), true);
  });

  it("returns true for hard_stop state (80%)", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await store.recordContextSample({ invocationId: "inv-1", runId: "r", taskId: "t", source: "auto", usedPercentage: 80, sampledAt: new Date().toISOString(), raw: {} });
    assert.equal(await m.getThresholdCrossed("inv-1"), true);
  });
});

// ---------------------------------------------------------------------------
// getStateFromStore
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.getStateFromStore", () => {
  it("returns normal when no samples", async () => {
    const store = new StubStore();
    const m = monitor(store);
    assert.equal(await m.getStateFromStore("inv-1"), "normal");
  });

  it("derives state from latest sample usedPercentage", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await store.recordContextSample({ invocationId: "inv-1", runId: "r", taskId: "t", source: "auto", usedPercentage: 72, sampledAt: new Date().toISOString(), raw: {} });
    const state = await m.getStateFromStore("inv-1");
    assert.equal(state, "handoff_required");
  });

  it("updates the in-memory cache", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await store.recordContextSample({ invocationId: "inv-1", runId: "r", taskId: "t", source: "auto", usedPercentage: 72, sampledAt: new Date().toISOString(), raw: {} });
    await m.getStateFromStore("inv-1");
    assert.equal(m.getCurrentState("inv-1"), "handoff_required");
  });
});

// ---------------------------------------------------------------------------
// buildStatusSummary
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.buildStatusSummary", () => {
  it("returns non-empty string for unknown invocation", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const summary = await m.buildStatusSummary("inv-unknown");
    assert.ok(summary.length > 0, "summary must be non-empty");
    assert.ok(summary.includes("inv-unknown"));
  });

  it("includes the invocation id in the summary", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const summary = await m.buildStatusSummary("inv-abc");
    assert.ok(summary.includes("inv-abc"));
  });

  it("includes state in the summary when sample exists", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 72);
    const summary = await m.buildStatusSummary("inv-1");
    assert.ok(summary.includes("handoff_required"), `expected 'handoff_required' in: ${summary}`);
  });

  it("includes handoff committed note when handoff exists", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 72);
    store.addHandoff("inv-1");
    const summary = await m.buildStatusSummary("inv-1");
    assert.ok(summary.includes("handoff committed"), `expected 'handoff committed' in: ${summary}`);
  });

  it("does not include handoff note when no handoff", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 72);
    const summary = await m.buildStatusSummary("inv-1");
    assert.ok(!summary.includes("handoff committed"), `unexpected 'handoff committed' in: ${summary}`);
  });
});

// ---------------------------------------------------------------------------
// isHandoffSafeTool (static)
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.isHandoffSafeTool", () => {
  it("returns true for the real registered handoff tools (bare and mcp-qualified)", () => {
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("archon_handoff_prepare"), true);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("archon_handoff_commit"), true);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("mcp__archon__archon_handoff_prepare"), true);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("mcp__archon__archon_handoff_commit"), true);
  });

  it("returns true for context sample and next-action tools (bare and mcp-qualified)", () => {
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("archon_context_sample"), true);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("archon_next_action"), true);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("mcp__archon__archon_context_sample"), true);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("mcp__archon__archon_next_action"), true);
  });

  it("returns false for tool names that are not registered MCP tools", () => {
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("mcp__archon__create_handoff"), false);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("mcp__archon__record_checkpoint"), false);
  });

  it("returns true for diagnostic tools", () => {
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("Read"), true);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("TodoRead"), true);
  });

  it("returns false for write tools", () => {
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("Write"), false);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("Edit"), false);
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("TodoWrite"), false);
  });

  it("returns false for spawn / agent tools", () => {
    assert.equal(ContextBudgetMonitor.isHandoffSafeTool("Agent"), false);
  });
});

// ---------------------------------------------------------------------------
// evaluatePreToolUse — PreToolUse hook decision
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.evaluatePreToolUse", () => {
  it("allows any tool when state is normal", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 50);
    const result = await m.evaluatePreToolUse("inv-1", "Write");
    assert.equal(result.decision, "allow");
  });

  it("allows any tool when no samples recorded", async () => {
    const store = new StubStore();
    const m = monitor(store);
    const result = await m.evaluatePreToolUse("inv-1", "Edit");
    assert.equal(result.decision, "allow");
  });

  it("allows handoff-safe tools when in handoff_required", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 72);
    const result = await m.evaluatePreToolUse("inv-1", "mcp__archon__archon_handoff_commit");
    assert.equal(result.decision, "allow");
  });

  it("denies non-handoff tools when in handoff_required and no handoff committed", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 72);
    const result = await m.evaluatePreToolUse("inv-1", "Write");
    assert.equal(result.decision, "deny");
    assert.ok(result.reason !== undefined, "reason must be provided when denying");
  });

  it("allows non-handoff tools when in handoff_required but handoff already committed", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 72);
    store.addHandoff("inv-1");
    const result = await m.evaluatePreToolUse("inv-1", "Write");
    assert.equal(result.decision, "allow");
  });

  it("denies non-handoff tools in hard_stop without committed handoff", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 85);
    const result = await m.evaluatePreToolUse("inv-1", "Edit");
    assert.equal(result.decision, "deny");
  });

  it("denies non-handoff tools in hard_stop even when a handoff was committed", async () => {
    // A committed handoff bypasses handoff_required but NOT hard_stop, since the
    // handoff may have been committed in the same over-budget turn.
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 85);
    store.addHandoff("inv-1");
    const result = await m.evaluatePreToolUse("inv-1", "Edit");
    assert.equal(result.decision, "deny");
  });

  it("deny reason references the tool name", async () => {
    const store = new StubStore();
    const m = monitor(store);
    await m.recordSample("inv-1", "run-1", "task-1", "auto", 72);
    const result = await m.evaluatePreToolUse("inv-1", "Write");
    assert.ok(result.reason?.includes("Write"), `expected tool name in reason: ${result.reason}`);
  });
});

// ---------------------------------------------------------------------------
// ContextBudgetStoreLike interface — hasCommittedHandoff
// ---------------------------------------------------------------------------

describe("StubStore.hasCommittedHandoff", () => {
  it("returns false when no handoff added", async () => {
    const store = new StubStore();
    assert.equal(await store.hasCommittedHandoff("inv-1"), false);
  });

  it("returns true after addHandoff", async () => {
    const store = new StubStore();
    store.addHandoff("inv-1");
    assert.equal(await store.hasCommittedHandoff("inv-1"), true);
  });

  it("returns false for different invocation", async () => {
    const store = new StubStore();
    store.addHandoff("inv-1");
    assert.equal(await store.hasCommittedHandoff("inv-2"), false);
  });
});

// ---------------------------------------------------------------------------
// resolveDaemonContextMonitorMode — P3 enforce-default unit tests
// ---------------------------------------------------------------------------

describe("resolveDaemonContextMonitorMode", () => {
  it("unset → enforce (enforce-default)", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(resolveDaemonContextMonitorMode(env), "enforce");
  });

  it("empty string → enforce", () => {
    const env: NodeJS.ProcessEnv = { ARCHON_CONTEXT_MONITOR: "" };
    assert.equal(resolveDaemonContextMonitorMode(env), "enforce");
  });

  it("\"enforce\" → enforce", () => {
    const env: NodeJS.ProcessEnv = { ARCHON_CONTEXT_MONITOR: "enforce" };
    assert.equal(resolveDaemonContextMonitorMode(env), "enforce");
  });

  it("\"observe\" → observe (kill switch)", () => {
    const env: NodeJS.ProcessEnv = { ARCHON_CONTEXT_MONITOR: "observe" };
    assert.equal(resolveDaemonContextMonitorMode(env), "observe");
  });

  it("garbage value → enforce", () => {
    const env: NodeJS.ProcessEnv = { ARCHON_CONTEXT_MONITOR: "garbage" };
    assert.equal(resolveDaemonContextMonitorMode(env), "enforce");
  });

  it("case-sensitive: \"Observe\" → enforce (not kill switch)", () => {
    const env: NodeJS.ProcessEnv = { ARCHON_CONTEXT_MONITOR: "Observe" };
    assert.equal(resolveDaemonContextMonitorMode(env), "enforce");
  });

  it("case-sensitive: \"OBSERVE\" → enforce (not kill switch)", () => {
    const env: NodeJS.ProcessEnv = { ARCHON_CONTEXT_MONITOR: "OBSERVE" };
    assert.equal(resolveDaemonContextMonitorMode(env), "enforce");
  });

  it("defaults to process.env when no env arg provided", () => {
    const saved = process.env.ARCHON_CONTEXT_MONITOR;
    try {
      process.env.ARCHON_CONTEXT_MONITOR = "observe";
      assert.equal(resolveDaemonContextMonitorMode(), "observe");
      process.env.ARCHON_CONTEXT_MONITOR = "enforce";
      assert.equal(resolveDaemonContextMonitorMode(), "enforce");
      delete process.env.ARCHON_CONTEXT_MONITOR;
      assert.equal(resolveDaemonContextMonitorMode(), "enforce");
    } finally {
      if (saved !== undefined) {
        process.env.ARCHON_CONTEXT_MONITOR = saved;
      } else {
        delete process.env.ARCHON_CONTEXT_MONITOR;
      }
    }
  });
});
