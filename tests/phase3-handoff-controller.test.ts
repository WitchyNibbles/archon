// Phase 3 — Handoff Controller unit tests.
//
// Uses node:test + node:assert/strict.  No real database connection.
// All store operations are covered by an in-memory stub.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  HandoffController,
  type HandoffStoreLike
} from "../src/runtime/handoff-controller.ts";
import {
  ContinuationContextBuilder
} from "../src/runtime/continuation-context.ts";
import type { HandoffRecord } from "../src/store/agent-runtime-store.ts";
import type { AgentInvocation } from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// In-memory store stub
// ---------------------------------------------------------------------------

interface StatusUpdate {
  id: string;
  status: AgentInvocation["status"];
  metadata?: Record<string, unknown> | undefined;
}

class StubStore implements HandoffStoreLike {
  readonly handoffs: HandoffRecord[] = [];
  readonly statusUpdates: StatusUpdate[] = [];
  readonly consumed = new Map<string, string>(); // handoffId → toInvocationId

  async createHandoff(
    data: Parameters<HandoffStoreLike["createHandoff"]>[0]
  ): Promise<HandoffRecord> {
    const record: HandoffRecord = {
      id: data.id,
      runId: data.runId,
      taskId: data.taskId,
      fromInvocationId: data.fromInvocationId,
      toInvocationId: data.toInvocationId,
      fromRole: data.fromRole,
      toRole: data.toRole,
      reason: data.reason,
      status: data.status,
      contextUsedPct: data.contextUsedPct,
      packet: { ...data.packet },
      authorityLabel: data.authorityLabel ?? "runtime_authoritative",
      createdAt: data.createdAt ?? new Date().toISOString(),
      consumedAt: undefined
    };
    this.handoffs.push(record);
    return { ...record };
  }

  async getLatestUnconsumedHandoff(
    runId: string,
    taskId: string
  ): Promise<HandoffRecord | undefined> {
    const matching = this.handoffs
      .filter((h) => h.runId === runId && h.taskId === taskId && h.consumedAt === undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const found = matching[0];
    return found !== undefined ? { ...found } : undefined;
  }

  async markHandoffConsumed(handoffId: string, toInvocationId: string): Promise<void> {
    this.consumed.set(handoffId, toInvocationId);
    const row = this.handoffs.find((h) => h.id === handoffId);
    if (row !== undefined) {
      // Mutate the stub's internal row to mark as consumed
      (row as { consumedAt?: string }).consumedAt = new Date().toISOString();
      (row as { toInvocationId?: string }).toInvocationId = toInvocationId;
    }
  }

  async updateAgentInvocationStatus(
    id: string,
    status: AgentInvocation["status"],
    metadata?: Record<string, unknown> | undefined
  ): Promise<void> {
    this.statusUpdates.push({ id, status, metadata });
  }

  reset(): void {
    this.handoffs.length = 0;
    this.statusUpdates.length = 0;
    this.consumed.clear();
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeValidPacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    handoffId: "ho_test_001",
    runId: "run-aaa",
    taskId: "task-bbb",
    fromInvocationId: "inv-111",
    fromRole: "backend_engineer",
    toRole: "backend_engineer",
    reason: "context_threshold_70",
    contextUsedPct: 72,
    status: "in_progress",
    summary: "Implemented DB schema and store methods. Tests remain.",
    scope: {
      allowedWriteScope: ["src/store/**", "tests/**"],
      touchedPaths: ["src/store/postgres-store.ts"]
    },
    decisions: [
      { decision: "Use Zod for validation", rationale: "Already adopted in schemas." }
    ],
    openQuestions: [],
    evidenceRefs: ["tests/phase1-agentic-schema.test.ts"],
    nextActions: ["Add integration tests", "Run npm test"],
    risks: [],
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HandoffController", () => {
  let store: StubStore;
  let controller: HandoffController;

  beforeEach(() => {
    store = new StubStore();
    controller = new HandoffController(store);
  });

  // -------------------------------------------------------------------------
  // Test 1 — prepare transitions invocation to handoff_requested
  // -------------------------------------------------------------------------

  it("prepare transitions invocation status to handoff_requested", async () => {
    const result = await controller.prepare({
      invocationId: "inv-111",
      runId: "run-aaa",
      taskId: "task-bbb",
      fromRole: "backend_engineer",
      toRole: "backend_engineer",
      reason: "context_threshold_70",
      contextUsedPct: 72
    });

    assert.equal(result.newStatus, "handoff_requested");
    assert.equal(store.statusUpdates.length, 1);
    assert.equal(store.statusUpdates[0]?.id, "inv-111");
    assert.equal(store.statusUpdates[0]?.status, "handoff_requested");
  });

  // -------------------------------------------------------------------------
  // Test 2 — prepare returns HandoffTemplate with handoffId and jsonTemplate
  // -------------------------------------------------------------------------

  it("prepare returns HandoffTemplate with pre-filled handoffId and jsonTemplate", async () => {
    const result = await controller.prepare({
      invocationId: "inv-222",
      runId: "run-bbb",
      taskId: "task-ccc",
      fromRole: "backend_engineer",
      toRole: "backend_engineer",
      reason: "role_boundary",
      contextUsedPct: undefined
    });

    assert.ok(typeof result.template.handoffId === "string");
    assert.ok(result.template.handoffId.startsWith("ho_"));
    assert.ok(typeof result.template.createdAt === "string");
    assert.ok(typeof result.template.markdownTemplate === "string");
    assert.ok(result.template.markdownTemplate.includes("Archon Handoff Required"));
    assert.ok(typeof result.template.jsonTemplate === "object");
    assert.equal(result.template.jsonTemplate["fromRole"], "backend_engineer");
    assert.equal(result.template.jsonTemplate["runId"], "run-bbb");
    assert.equal(result.template.jsonTemplate["taskId"], "task-ccc");
  });

  // -------------------------------------------------------------------------
  // Test 3 — commit validates packet and persists to store
  // -------------------------------------------------------------------------

  it("commit validates packet and persists HandoffRecord", async () => {
    const packet = makeValidPacket();
    const result = await controller.commit({
      invocationId: "inv-111",
      rawPacket: packet
    });

    assert.equal(result.newStatus, "handoff_written");
    assert.equal(store.handoffs.length, 1);
    assert.equal(store.handoffs[0]?.id, "ho_test_001");
    assert.equal(store.handoffs[0]?.fromRole, "backend_engineer");
    assert.equal(store.handoffs[0]?.reason, "context_threshold_70");
  });

  // -------------------------------------------------------------------------
  // Test 4 — commit transitions invocation to handoff_written
  // -------------------------------------------------------------------------

  it("commit transitions invocation status to handoff_written", async () => {
    const packet = makeValidPacket();
    const result = await controller.commit({
      invocationId: "inv-111",
      rawPacket: packet
    });

    assert.equal(result.newStatus, "handoff_written");
    const writtenUpdate = store.statusUpdates.find((u) => u.status === "handoff_written");
    assert.ok(writtenUpdate !== undefined, "Expected a handoff_written status update");
    assert.equal(writtenUpdate.id, "inv-111");
  });

  // -------------------------------------------------------------------------
  // Test 5 — commit rejects invalid packet (missing summary)
  // -------------------------------------------------------------------------

  it("commit throws on invalid packet — missing summary", async () => {
    const badPacket = makeValidPacket({ summary: "short" }); // < 10 chars
    await assert.rejects(
      () => controller.commit({ invocationId: "inv-111", rawPacket: badPacket }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("validation failed"),
          `Expected 'validation failed' in: ${err.message}`
        );
        return true;
      }
    );
  });

  // -------------------------------------------------------------------------
  // Test 6 — commit rejects packet missing evidenceRefs when status != blocked
  // -------------------------------------------------------------------------

  it("commit throws on packet with empty evidenceRefs when status is not blocked", async () => {
    const badPacket = makeValidPacket({ evidenceRefs: [], status: "in_progress" });
    await assert.rejects(
      () => controller.commit({ invocationId: "inv-111", rawPacket: badPacket }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("evidenceRefs"),
          `Expected 'evidenceRefs' in: ${err.message}`
        );
        return true;
      }
    );
  });

  // -------------------------------------------------------------------------
  // Test 7 — commit rejects context_threshold_70 packet missing contextUsedPct
  // -------------------------------------------------------------------------

  it("commit throws on context_threshold_70 packet missing contextUsedPct", async () => {
    const badPacket = makeValidPacket({ reason: "context_threshold_70", contextUsedPct: undefined });
    await assert.rejects(
      () => controller.commit({ invocationId: "inv-111", rawPacket: badPacket }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("contextUsedPct"),
          `Expected 'contextUsedPct' in: ${err.message}`
        );
        return true;
      }
    );
  });

  // -------------------------------------------------------------------------
  // Test 8 — getLatestForTask returns latest unconsumed handoff
  // -------------------------------------------------------------------------

  it("getLatestForTask returns latest unconsumed handoff for run+task", async () => {
    await controller.commit({ invocationId: "inv-111", rawPacket: makeValidPacket() });

    const found = await controller.getLatestForTask("run-aaa", "task-bbb");
    assert.ok(found !== undefined, "Expected a handoff record");
    assert.equal(found.id, "ho_test_001");
  });

  it("getLatestForTask returns undefined when no handoff exists", async () => {
    const found = await controller.getLatestForTask("run-zzz", "task-zzz");
    assert.equal(found, undefined);
  });

  // -------------------------------------------------------------------------
  // Test 9 — buildContinuationPrompt builds compact prompt from record
  // -------------------------------------------------------------------------

  it("buildContinuationPrompt builds compact prompt containing role, taskId, runId, and nextActions", async () => {
    await controller.commit({ invocationId: "inv-111", rawPacket: makeValidPacket() });
    const record = await controller.getLatestForTask("run-aaa", "task-bbb");
    assert.ok(record !== undefined);

    const prompt = controller.buildContinuationPrompt(record);

    assert.ok(typeof prompt === "string");
    assert.ok(prompt.includes("backend_engineer"), `Expected role in prompt: ${prompt}`);
    assert.ok(prompt.includes("task-bbb"), `Expected taskId in prompt: ${prompt}`);
    assert.ok(prompt.includes("run-aaa"), `Expected runId in prompt: ${prompt}`);
    assert.ok(prompt.includes("Add integration tests"), `Expected nextAction in prompt: ${prompt}`);
    assert.ok(
      prompt.includes("If context reaches 70%"),
      `Expected handoff rule in prompt: ${prompt}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 10 — consume marks handoff consumed
  // -------------------------------------------------------------------------

  it("consume marks handoff consumed and returns ConsumeResult", async () => {
    await controller.commit({ invocationId: "inv-111", rawPacket: makeValidPacket() });

    const consumeResult = await controller.consume({
      handoffId: "ho_test_001",
      toInvocationId: "inv-222",
      runId: "run-aaa",
      taskId: "task-bbb"
    });

    assert.equal(consumeResult.toInvocationId, "inv-222");
    assert.ok(store.consumed.has("ho_test_001"), "Expected handoff to be marked consumed");
    assert.equal(store.consumed.get("ho_test_001"), "inv-222");
  });
});

// ---------------------------------------------------------------------------
// ContinuationContextBuilder tests
// ---------------------------------------------------------------------------

describe("ContinuationContextBuilder", () => {
  let store: StubStore;
  let builder: ContinuationContextBuilder;

  beforeEach(() => {
    store = new StubStore();
    builder = new ContinuationContextBuilder(store);
  });

  it("buildBundle returns initial-invocation prompt when no handoff exists", async () => {
    const bundle = await builder.buildBundle({
      runId: "run-aaa",
      taskId: "task-bbb",
      role: "backend_engineer"
    });

    assert.equal(bundle.role, "backend_engineer");
    assert.equal(bundle.runId, "run-aaa");
    assert.equal(bundle.taskId, "task-bbb");
    assert.equal(bundle.latestHandoff, undefined);
    assert.ok(bundle.continuationPrompt.includes("first invocation"));
    assert.equal(bundle.evidenceRefs.length, 0);
    assert.equal(bundle.nextActions.length, 0);
  });

  it("buildBundle returns handoff-based prompt when handoff exists", async () => {
    const controller = new HandoffController(store);
    await controller.commit({
      invocationId: "inv-111",
      rawPacket: makeValidPacket()
    });

    const bundle = await builder.buildBundle({
      runId: "run-aaa",
      taskId: "task-bbb",
      role: "backend_engineer"
    });

    assert.ok(bundle.latestHandoff !== undefined);
    assert.ok(bundle.continuationPrompt.includes("backend_engineer"));
    assert.ok(bundle.continuationPrompt.includes("task-bbb"));
    assert.deepEqual([...bundle.evidenceRefs], ["tests/phase1-agentic-schema.test.ts"]);
    assert.deepEqual([...bundle.nextActions], ["Add integration tests", "Run npm test"]);
    assert.ok(typeof bundle.assembledAt === "string");
  });
});
