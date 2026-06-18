// Phase 1: Agentic Loop Runtime — schema and Zod validation unit tests.
//
// Tests cover:
//   - HandoffPacketV1Schema: valid packet, missing required fields, invalid roles
//   - SubagentResultPacketV1Schema: valid packet, missing evidence for completed
//   - ContextPolicySchema: defaults applied
//
// Uses node:test + node:assert/strict (no vitest).

import test from "node:test";
import assert from "node:assert/strict";
import {
  HandoffPacketV1Schema,
  SubagentResultPacketV1Schema,
  ContextPolicySchema
} from "../src/domain/handoff-schemas.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validHandoffPacket(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    handoffId: "ho_test_001",
    runId: "run_abc",
    taskId: "task_xyz",
    fromInvocationId: "ainv_be_001",
    fromRole: "backend_engineer",
    toRole: "backend_engineer",
    reason: "context_threshold_70",
    contextUsedPct: 72,
    status: "needs_followup",
    summary: "Implemented the task queue migration. Integration tests remain.",
    scope: {
      allowedWriteScope: ["src/store/**", "tests/**"],
      touchedPaths: ["src/store/postgres-store.ts"],
      lockedPaths: ["CLAUDE.md"]
    },
    decisions: [
      { decision: "Use DB as authority", rationale: "workflow proof already treats runtime as authority" }
    ],
    openQuestions: ["Should failed subagent packets be retryable?"],
    evidenceRefs: ["migration:020_agent.sql", "test:phase1-agentic-schema.test.ts"],
    nextActions: ["Add integration tests", "Run npm test"],
    risks: [
      { severity: "medium", risk: "CLI stream may not expose exact pct", mitigation: "Use SDK wrapper" }
    ],
    createdAt: "2026-06-17T10:30:00.000Z"
  };
}

function validSubagentResultPacket(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    subtaskId: "subtask_test_001",
    parentInvocationId: "ainv_be_001",
    subagentType: "test_writer",
    status: "completed",
    summary: "Added tests for handoff packet validation and context thresholds.",
    evidenceRefs: ["tests/phase1-agentic-schema.test.ts"],
    changedPaths: ["tests/phase1-agentic-schema.test.ts"],
    openQuestions: [],
    risks: [],
    nextActions: ["Parent should run npm test."],
    confidence: "medium"
  };
}

// ---------------------------------------------------------------------------
// HandoffPacketV1Schema — valid
// ---------------------------------------------------------------------------

test("HandoffPacketV1Schema: accepts a well-formed packet", () => {
  const result = HandoffPacketV1Schema.safeParse(validHandoffPacket());
  assert.ok(result.success, `Expected success but got: ${JSON.stringify(result.error?.issues)}`);
});

test("HandoffPacketV1Schema: parses all required string fields", () => {
  const result = HandoffPacketV1Schema.safeParse(validHandoffPacket());
  assert.ok(result.success);
  assert.equal(result.data.handoffId, "ho_test_001");
  assert.equal(result.data.reason, "context_threshold_70");
  assert.equal(result.data.contextUsedPct, 72);
});

// ---------------------------------------------------------------------------
// HandoffPacketV1Schema — missing required fields
// ---------------------------------------------------------------------------

test("HandoffPacketV1Schema: rejects packet missing schemaVersion", () => {
  const packet = validHandoffPacket();
  delete packet["schemaVersion"];
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
  const paths = result.error.issues.map((i) => i.path[0]);
  assert.ok(paths.includes("schemaVersion"), `Expected schemaVersion in errors, got: ${JSON.stringify(paths)}`);
});

test("HandoffPacketV1Schema: rejects packet missing summary", () => {
  const packet = validHandoffPacket();
  delete packet["summary"];
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
});

test("HandoffPacketV1Schema: rejects packet with too-short summary", () => {
  const packet = { ...validHandoffPacket(), summary: "short" };
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
  const hasMessage = result.error.issues.some((i) => i.path.includes("summary"));
  assert.ok(hasMessage, "Expected summary error");
});

test("HandoffPacketV1Schema: rejects packet missing fromInvocationId", () => {
  const packet = validHandoffPacket();
  delete packet["fromInvocationId"];
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
});

test("HandoffPacketV1Schema: rejects packet missing evidenceRefs when not blocked", () => {
  const packet = { ...validHandoffPacket(), evidenceRefs: [], status: "needs_followup" };
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
  const hasEvidenceError = result.error.issues.some((i) => i.path.includes("evidenceRefs"));
  assert.ok(hasEvidenceError, "Expected evidenceRefs error for non-blocked packet");
});

test("HandoffPacketV1Schema: allows empty evidenceRefs when status is blocked", () => {
  const packet = {
    ...validHandoffPacket(),
    evidenceRefs: [],
    nextActions: ["Unblock first"],
    status: "blocked"
  };
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(result.success, `Expected success but got: ${JSON.stringify(result.error?.issues)}`);
});

test("HandoffPacketV1Schema: rejects packet missing nextActions when not completed", () => {
  const packet = { ...validHandoffPacket(), nextActions: [], status: "needs_followup" };
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
  const hasNextActionsError = result.error.issues.some((i) => i.path.includes("nextActions"));
  assert.ok(hasNextActionsError, "Expected nextActions error for non-completed packet");
});

test("HandoffPacketV1Schema: allows empty nextActions when status is completed", () => {
  const packet = { ...validHandoffPacket(), nextActions: [], status: "completed" };
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(result.success, `Expected success but got: ${JSON.stringify(result.error?.issues)}`);
});

// ---------------------------------------------------------------------------
// HandoffPacketV1Schema — invalid roles and enums
// ---------------------------------------------------------------------------

test("HandoffPacketV1Schema: rejects invalid reason enum", () => {
  const packet = { ...validHandoffPacket(), reason: "because_i_felt_like_it" };
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
  const hasReasonError = result.error.issues.some((i) => i.path.includes("reason"));
  assert.ok(hasReasonError, `Expected reason error, got: ${JSON.stringify(result.error.issues)}`);
});

test("HandoffPacketV1Schema: accepts all valid reason values", () => {
  const reasons = [
    "context_threshold_70",
    "role_boundary",
    "blocked",
    "review_required",
    "manual",
    "precompact_fallback",
    "crash_recovery"
  ] as const;

  for (const reason of reasons) {
    const packet = {
      ...validHandoffPacket(),
      reason,
      // context_threshold_70 requires contextUsedPct; others do not
      contextUsedPct: reason === "context_threshold_70" ? 72 : undefined
    };
    const result = HandoffPacketV1Schema.safeParse(packet);
    assert.ok(result.success, `Reason '${reason}' should be valid. Got: ${JSON.stringify(result.error?.issues)}`);
  }
});

test("HandoffPacketV1Schema: rejects context_threshold_70 without contextUsedPct", () => {
  const packet = validHandoffPacket();
  delete packet["contextUsedPct"];
  // reason is already context_threshold_70
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
  const hasError = result.error.issues.some((i) => i.path.includes("contextUsedPct"));
  assert.ok(hasError, "Expected contextUsedPct error for context_threshold_70 reason");
});

test("HandoffPacketV1Schema: rejects invalid risk severity", () => {
  const packet = {
    ...validHandoffPacket(),
    risks: [{ severity: "catastrophic", risk: "bad thing", mitigation: "fix it" }]
  };
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
});

test("HandoffPacketV1Schema: rejects wrong schemaVersion", () => {
  const packet = { ...validHandoffPacket(), schemaVersion: 2 };
  const result = HandoffPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
  const hasError = result.error.issues.some((i) => i.path.includes("schemaVersion"));
  assert.ok(hasError);
});

// ---------------------------------------------------------------------------
// SubagentResultPacketV1Schema — valid
// ---------------------------------------------------------------------------

test("SubagentResultPacketV1Schema: accepts a well-formed completed packet", () => {
  const result = SubagentResultPacketV1Schema.safeParse(validSubagentResultPacket());
  assert.ok(result.success, `Expected success but got: ${JSON.stringify(result.error?.issues)}`);
});

test("SubagentResultPacketV1Schema: accepts blocked packet without evidence", () => {
  const packet = {
    ...validSubagentResultPacket(),
    status: "blocked",
    evidenceRefs: [],
    nextActions: ["Unblock parent first"]
  };
  const result = SubagentResultPacketV1Schema.safeParse(packet);
  assert.ok(result.success, `Expected success but got: ${JSON.stringify(result.error?.issues)}`);
});

// ---------------------------------------------------------------------------
// SubagentResultPacketV1Schema — invalid
// ---------------------------------------------------------------------------

test("SubagentResultPacketV1Schema: rejects completed packet with empty evidenceRefs", () => {
  const packet = { ...validSubagentResultPacket(), evidenceRefs: [], status: "completed" };
  const result = SubagentResultPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
  const hasError = result.error.issues.some((i) => i.path.includes("evidenceRefs"));
  assert.ok(hasError, "Expected evidenceRefs error for completed packet");
});

test("SubagentResultPacketV1Schema: rejects invalid confidence value", () => {
  const packet = { ...validSubagentResultPacket(), confidence: "very_sure" };
  const result = SubagentResultPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
});

test("SubagentResultPacketV1Schema: rejects invalid status value", () => {
  const packet = { ...validSubagentResultPacket(), status: "running" };
  const result = SubagentResultPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
});

test("SubagentResultPacketV1Schema: rejects too-short summary", () => {
  const packet = { ...validSubagentResultPacket(), summary: "done" };
  const result = SubagentResultPacketV1Schema.safeParse(packet);
  assert.ok(!result.success);
});

// ---------------------------------------------------------------------------
// ContextPolicySchema — defaults
// ---------------------------------------------------------------------------

test("ContextPolicySchema: applies default handoffPct of 70", () => {
  const result = ContextPolicySchema.safeParse({
    policyId: "default",
    appliesTo: "all_archon_agents"
  });
  assert.ok(result.success, `Expected success but got: ${JSON.stringify(result.error?.issues)}`);
  assert.equal(result.data.handoffPct, 70);
});

test("ContextPolicySchema: applies default warningPct of 60", () => {
  const result = ContextPolicySchema.safeParse({
    policyId: "default",
    appliesTo: "all_archon_agents"
  });
  assert.ok(result.success);
  assert.equal(result.data.warningPct, 60);
});

test("ContextPolicySchema: applies default hardStopPct of 80", () => {
  const result = ContextPolicySchema.safeParse({
    policyId: "default",
    appliesTo: "all_archon_agents"
  });
  assert.ok(result.success);
  assert.equal(result.data.hardStopPct, 80);
});

test("ContextPolicySchema: accepts explicit override of handoffPct", () => {
  const result = ContextPolicySchema.safeParse({
    policyId: "strict",
    handoffPct: 65,
    warningPct: 55,
    hardStopPct: 75,
    appliesTo: "all_archon_agents"
  });
  assert.ok(result.success);
  assert.equal(result.data.handoffPct, 65);
});

test("ContextPolicySchema: rejects invalid appliesTo", () => {
  const result = ContextPolicySchema.safeParse({
    policyId: "test",
    appliesTo: "some_specific_agent"
  });
  assert.ok(!result.success);
});

test("ContextPolicySchema: accepts optional maxTurns and maxOutputTokens", () => {
  const result = ContextPolicySchema.safeParse({
    policyId: "bounded",
    maxTurns: 50,
    maxOutputTokens: 8000,
    appliesTo: "all_archon_agents"
  });
  assert.ok(result.success);
  assert.equal(result.data.maxTurns, 50);
  assert.equal(result.data.maxOutputTokens, 8000);
});
