// Phase 6 — Adversarial regression fixtures (TDD §22.4).
//
// These tests verify that safety boundaries are enforced:
// - Agents cannot continue past context 70% without a committed handoff.
// - Vague (too-short) handoff summaries are rejected at commit time.
// - Spawn depth limits are enforced.
// - Scope containment is enforced for subagent writes.
// - Debate decisions require evidence refs even if arguments didn't.
//
// Uses node:test (the project test runner). No DB required.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContextBudgetMonitor } from "../src/runtime/context-budget.ts";
import type { ContextBudgetStoreLike } from "../src/runtime/context-budget.ts";
import { HandoffController } from "../src/runtime/handoff-controller.ts";
import type { HandoffStoreLike } from "../src/runtime/handoff-controller.ts";
import type { HandoffRecord } from "../src/store/agent-runtime-store.ts";
import { SubtaskScheduler } from "../src/runtime/subtask-scheduler.ts";
import type { SubtaskStoreLike, ParentInvocationStoreLike, ParentInvocationRef } from "../src/runtime/subtask-scheduler.ts";
import { DebateController } from "../src/runtime/debate-controller.ts";
import type { DebateStoreLike } from "../src/runtime/debate-controller.ts";
import type { ContextSample, DebateSession, DebateArgument } from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

function buildContextBudgetStore(opts: {
  latestSample?: { usedPercentage: number };
  hasHandoff?: boolean;
} = {}): ContextBudgetStoreLike {
  return {
    async recordContextSample() { /* no-op */ },
    async getLatestContextSample(invocationId): Promise<ContextSample | undefined> {
      if (opts.latestSample === undefined) return undefined;
      return {
        invocationId,
        runId: "run-adv",
        taskId: "task-adv",
        source: "sdk",
        usedPercentage: opts.latestSample.usedPercentage,
        sampledAt: new Date().toISOString(),
        raw: {}
      };
    },
    async hasCommittedHandoff() {
      return opts.hasHandoff ?? false;
    }
  };
}

// ---------------------------------------------------------------------------
// 1. Agent continues after 70% without committed handoff → evaluatePreToolUse "deny"
// ---------------------------------------------------------------------------

describe("phase6 adversarial: agent continues past 70% without handoff", () => {
  it("evaluatePreToolUse denies non-safe tool when context >= 70 and no handoff committed", async () => {
    const store = buildContextBudgetStore({
      latestSample: { usedPercentage: 72 },
      hasHandoff: false
    });

    const monitor = new ContextBudgetMonitor(store);
    const result = await monitor.evaluatePreToolUse("inv-adv-1", "Write");

    assert.strictEqual(result.decision, "deny");
    assert.ok(
      typeof result.reason === "string" && result.reason.length > 0,
      "deny must carry a reason"
    );
  });

  it("evaluatePreToolUse allows handoff-safe tool at 72% even without committed handoff", async () => {
    const store = buildContextBudgetStore({
      latestSample: { usedPercentage: 72 },
      hasHandoff: false
    });

    const monitor = new ContextBudgetMonitor(store);
    const result = await monitor.evaluatePreToolUse("inv-adv-safe", "mcp__archon__create_handoff");

    assert.strictEqual(result.decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// 2. Vague handoff → commit() rejects when summary is too short (<10 chars)
// ---------------------------------------------------------------------------

describe("phase6 adversarial: vague handoff commit rejected", () => {
  it("HandoffController.commit rejects when summary is too short", async () => {
    const mockHandoffStore: HandoffStoreLike = {
      async createHandoff() { throw new Error("should not be called"); },
      async getLatestUnconsumedHandoff() { return undefined; },
      async markHandoffConsumed() { /* no-op */ },
      async updateAgentInvocationStatus() { /* no-op */ }
    };

    const controller = new HandoffController(mockHandoffStore);

    const vagueSummary = "done"; // only 4 chars — below the 10-char minimum

    const rawPacket = {
      schemaVersion: 1,
      handoffId: "ho-vague-1",
      runId: "run-vague",
      taskId: "task-vague",
      fromInvocationId: "inv-from-vague",
      fromRole: "planner",
      toRole: "planner",
      reason: "context_threshold_70",
      contextUsedPct: 72,
      status: "in_progress",
      summary: vagueSummary,
      scope: { allowedWriteScope: [], touchedPaths: [] },
      decisions: [],
      openQuestions: [],
      evidenceRefs: ["some-evidence"],
      nextActions: ["do something"],
      risks: [],
      createdAt: new Date().toISOString()
    };

    await assert.rejects(
      async () => controller.commit({ invocationId: "inv-from-vague", rawPacket }),
      (err: Error) => {
        assert.ok(
          err.message.includes("summary") || err.message.includes("10 characters"),
          `expected summary validation error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("HandoffController.commit rejects when evidenceRefs is empty for in_progress status", async () => {
    const mockHandoffStore: HandoffStoreLike = {
      async createHandoff() { throw new Error("should not be called"); },
      async getLatestUnconsumedHandoff() { return undefined; },
      async markHandoffConsumed() { /* no-op */ },
      async updateAgentInvocationStatus() { /* no-op */ }
    };

    const controller = new HandoffController(mockHandoffStore);

    const rawPacket = {
      schemaVersion: 1,
      handoffId: "ho-no-evidence",
      runId: "run-adv",
      taskId: "task-adv",
      fromInvocationId: "inv-from-adv",
      fromRole: "planner",
      toRole: "planner",
      reason: "context_threshold_70",
      contextUsedPct: 70,
      status: "in_progress",
      summary: "This is a valid summary with enough characters",
      scope: { allowedWriteScope: [], touchedPaths: [] },
      decisions: [],
      openQuestions: [],
      evidenceRefs: [],     // empty — should be rejected
      nextActions: ["continue work"],
      risks: [],
      createdAt: new Date().toISOString()
    };

    await assert.rejects(
      async () => controller.commit({ invocationId: "inv-from-adv", rawPacket }),
      (err: Error) => {
        assert.ok(
          err.message.toLowerCase().includes("evidence"),
          `expected evidenceRefs error, got: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Unauthorized nested subagent (depth > maxChildDepth) → requestSubtask fails
// ---------------------------------------------------------------------------

describe("phase6 adversarial: unauthorized nested subagent beyond depth", () => {
  it("requestSubtask returns ok:false when child depth exceeds maxChildDepth", async () => {
    const parentId = "inv-parent-deep";

    const parentRef: ParentInvocationRef = {
      status: "running",
      taskId: "task-depth-adv",
      runId: "run-depth-adv",
      allowedWriteScope: ["src/"],
      depth: 3,  // parent is already at depth 3; child would be 4
      spawnPolicy: {
        canSpawnSubagents: true,
        allowedSubagentTypes: ["codebase_scout"],
        maxChildDepth: 2,
        maxConcurrentChildren: 4,
        maxTotalChildrenPerTask: 20
      }
    };

    const mockInvocationStore: ParentInvocationStoreLike = {
      async getInvocation(id) {
        return id === parentId ? parentRef : undefined;
      }
    };

    const mockSubtaskStore: SubtaskStoreLike = {
      async createSubtask() { throw new Error("should not be called"); },
      async updateSubtaskResult() { /* no-op */ },
      async listSubtasksForTask() { return []; }
    };

    const scheduler = new SubtaskScheduler(mockSubtaskStore, mockInvocationStore);
    const outcome = await scheduler.requestSubtask(parentId, {
      subagentType: "codebase_scout",
      title: "Unauthorized scout",
      prompt: "analyze",
      allowedTools: ["Read"],
      allowedWriteScope: [],
      maxTurns: 5,
      stopCondition: "when done"
    });

    assert.strictEqual(outcome.ok, false);
    assert.ok(
      !outcome.ok && outcome.reason.toLowerCase().includes("depth"),
      `expected depth error, got: ${!outcome.ok ? outcome.reason : "n/a"}`
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Subagent writes outside allowed scope → requestSubtask fails with scope error
// ---------------------------------------------------------------------------

describe("phase6 adversarial: subagent write scope violation", () => {
  it("requestSubtask returns ok:false when child write scope escapes parent scope", async () => {
    const parentId = "inv-parent-scope";

    const parentRef: ParentInvocationRef = {
      status: "running",
      taskId: "task-scope-adv",
      runId: "run-scope-adv",
      allowedWriteScope: ["src/runtime/"],    // parent can only write here
      depth: 0,
      spawnPolicy: {
        canSpawnSubagents: true,
        allowedSubagentTypes: ["test_writer"],
        maxChildDepth: 3,
        maxConcurrentChildren: 4,
        maxTotalChildrenPerTask: 20
      }
    };

    const mockInvocationStore: ParentInvocationStoreLike = {
      async getInvocation(id) {
        return id === parentId ? parentRef : undefined;
      }
    };

    const mockSubtaskStore: SubtaskStoreLike = {
      async createSubtask() { throw new Error("should not be called"); },
      async updateSubtaskResult() { /* no-op */ },
      async listSubtasksForTask() { return []; }
    };

    const scheduler = new SubtaskScheduler(mockSubtaskStore, mockInvocationStore);
    const outcome = await scheduler.requestSubtask(parentId, {
      subagentType: "test_writer",
      title: "Scope escaper",
      prompt: "write tests AND modify production DB",
      allowedTools: ["Write"],
      allowedWriteScope: ["src/runtime/", "src/store/"],  // src/store/ is outside parent scope
      maxTurns: 10,
      stopCondition: "when done"
    });

    assert.strictEqual(outcome.ok, false);
    assert.ok(
      !outcome.ok && (outcome.reason.toLowerCase().includes("scope") || outcome.reason.toLowerCase().includes("containment") || outcome.reason.toLowerCase().includes("write")),
      `expected scope error, got: ${!outcome.ok ? outcome.reason : "n/a"}`
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Debate: addArgument without evidenceRefs succeeds; finalizeDecision
//    without evidenceRefs rejects.
// ---------------------------------------------------------------------------

describe("phase6 adversarial: debate evidence requirements", () => {
  it("addArgument succeeds when no evidenceRefs provided (evidence is optional per design)", async () => {
    let argumentAdded = false;

    const mockDebateStore: DebateStoreLike = {
      async createDebateSession(data): Promise<DebateSession> {
        return {
          id: data.id,
          runId: data.runId,
          taskId: data.taskId,
          topic: data.topic,
          triggerKind: data.triggerKind,
          status: data.status,
          createdAt: data.createdAt ?? new Date().toISOString()
        };
      },
      async addDebateArgument(): Promise<DebateArgument> {
        argumentAdded = true;
        return {
          id: "arg-1",
          debateSessionId: "session-1",
          round: 1,
          role: "reviewer",
          position: "This approach needs more analysis",
          evidenceRefs: [],
          critiques: [],
          createdAt: new Date().toISOString()
        };
      },
      async updateDebateDecision() { /* no-op */ }
    };

    const controller = new DebateController(mockDebateStore);

    // addArgument with no evidenceRefs — must succeed
    await controller.addArgument("session-1", {
      role: "reviewer",
      round: 1,
      position: "This approach needs more analysis",
      evidenceRefs: undefined    // intentionally absent
    });

    assert.ok(argumentAdded, "addArgument should have been called");
  });

  it("finalizeDecision rejects when evidenceRefs is empty", async () => {
    const mockDebateStore: DebateStoreLike = {
      async createDebateSession(data): Promise<DebateSession> {
        return {
          id: data.id,
          runId: data.runId,
          taskId: data.taskId,
          topic: data.topic,
          triggerKind: data.triggerKind,
          status: data.status,
          createdAt: new Date().toISOString()
        };
      },
      async addDebateArgument(): Promise<DebateArgument> {
        return {
          id: "arg-2",
          debateSessionId: "session-2",
          round: 1,
          role: "reviewer",
          position: "position",
          evidenceRefs: [],
          critiques: [],
          createdAt: new Date().toISOString()
        };
      },
      async updateDebateDecision() { throw new Error("should not be called — validation must fail first"); }
    };

    const controller = new DebateController(mockDebateStore);

    await assert.rejects(
      async () =>
        controller.finalizeDecision("session-2", {
          outcome: "approved",
          vote: { approve: 2, rework: 0, reject: 0 },
          dissent: { owner: "security_reviewer", summary: "no objections raised" },
          conditions: [],
          evidenceRefs: []   // empty — must be rejected
        }),
      (err: Error) => {
        assert.ok(
          err.message.toLowerCase().includes("evidence"),
          `expected evidenceRefs validation error, got: ${err.message}`
        );
        return true;
      }
    );
  });
});
