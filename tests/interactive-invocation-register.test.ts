// interactive-invocation-register — unit tests for upsertInteractiveInvocationRow.
//
// Fix: interactiveInvocationRegister. Interactive root sessions mint a synthetic
// invocationId (inv_interactive_<uuid>) but historically had NO backing
// agent_invocations row. Every handoff-commit surface (MCP archon_handoff_commit,
// PreCompact parachute, context sampling) resolves from_invocation_id against
// agent_invocations (NOT NULL FK), so a missing row means the context guard can
// demand a handoff that can never be committed.
//
// upsertInteractiveInvocationRow is the single, idempotent creation point reused
// by both archon-session-start.mjs (eager) and archon-pre-compact.mjs (backstop).
// These tests pin its contract:
//   - fresh insert → created:true, with the correct root_manager identity row
//   - Postgres 23505 (unique_violation) → alreadyExisted:true (idempotent success)
//   - any other error → structuralError set (surfaced, NOT swallowed)
//   - never throws

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  upsertInteractiveInvocationRow,
  type InteractiveInvocationCreator
} from "../src/runtime/interactive-parachute.ts";
import type { CreateAgentInvocationInput } from "../src/store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// Store doubles
// ---------------------------------------------------------------------------

class RecordingCreator implements InteractiveInvocationCreator {
  readonly calls: CreateAgentInvocationInput[] = [];
  async createAgentInvocation(data: CreateAgentInvocationInput): Promise<unknown> {
    this.calls.push(data);
    return { id: data.id };
  }
}

class ThrowingCreator implements InteractiveInvocationCreator {
  readonly err: unknown;
  constructor(err: unknown) {
    this.err = err;
  }
  async createAgentInvocation(): Promise<unknown> {
    throw this.err;
  }
}

const ROW = {
  id: "inv_interactive_abc123",
  runId: "11111111-1111-1111-1111-111111111111",
  taskId: "interactiveInvocationRegister",
  role: "interactive",
  startedAt: "2026-07-01T12:00:00.000Z"
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upsertInteractiveInvocationRow", () => {
  it("fresh insert creates a root_manager invocation row and reports created", async () => {
    const store = new RecordingCreator();
    const result = await upsertInteractiveInvocationRow(store, ROW);

    assert.deepEqual(result, { created: true, alreadyExisted: false });
    assert.equal(store.calls.length, 1);
    const call = store.calls[0]!;
    assert.equal(call.id, ROW.id);
    assert.equal(call.runId, ROW.runId);
    assert.equal(call.taskId, ROW.taskId);
    assert.equal(call.role, ROW.role);
    assert.equal(call.startedAt, ROW.startedAt);
    // Identity defaults for the interactive root session.
    assert.equal(call.agentKind, "root_manager");
    assert.equal(call.status, "running");
    assert.equal(call.effort, "high");
    assert.equal(call.contextPolicyId, "default");
    assert.equal(typeof call.model, "string");
  });

  it("Postgres 23505 (unique_violation) is idempotent success, not an error", async () => {
    const store = new ThrowingCreator({ code: "23505", message: "duplicate key" });
    const result = await upsertInteractiveInvocationRow(store, ROW);

    assert.deepEqual(result, { created: false, alreadyExisted: true });
  });

  it("a structural error (e.g. FK 23503) is surfaced, not swallowed", async () => {
    const store = new ThrowingCreator({
      code: "23503",
      message: 'insert or update on table "agent_invocations" violates foreign key constraint'
    });
    const result = await upsertInteractiveInvocationRow(store, ROW);

    assert.equal(result.created, false);
    assert.equal(result.alreadyExisted, false);
    assert.ok(
      typeof result.structuralError === "string" && result.structuralError.includes("foreign key"),
      "structuralError must carry the underlying failure so callers can log it loudly"
    );
  });

  it("a non-Error throw (no code) is treated as structural, never rethrown", async () => {
    const store = new ThrowingCreator("connection refused");
    const result = await upsertInteractiveInvocationRow(store, ROW);

    assert.equal(result.created, false);
    assert.equal(result.alreadyExisted, false);
    assert.ok((result.structuralError ?? "").includes("connection refused"));
  });
});
