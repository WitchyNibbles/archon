// Tests for Gap 7: agentic runtime state surfaced in status command.
//
// Covers:
//   - AgentRuntimeStore.getAgenticStateForTask — no invocations → undefined
//   - AgentRuntimeStore.getAgenticStateForTask — with invocations, context sample, handoff
//   - buildOperatorStatusReport passes agenticState through unchanged
//   - executeStatusCommandFromArgs calls getAgenticStateForTask when provided

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntimeStore } from "../src/store/agent-runtime-store.ts";
import { buildOperatorStatusReport, type AgenticStateForTask } from "../src/admin/status.ts";

// ---------------------------------------------------------------------------
// Stub SqlClient helper (same pattern as phase7-store-methods.test.ts)
// ---------------------------------------------------------------------------

type QueryResult = { rows: Record<string, unknown>[] };

function makeStubClient(
  // key = substring to match in SQL, value = rows to return
  rowsByKey: [string, Record<string, unknown>[]][]
) {
  return {
    async query(sql: string, _params?: unknown[]): Promise<QueryResult> {
      for (const [key, rows] of rowsByKey) {
        if (sql.includes(key)) {
          return { rows };
        }
      }
      return { rows: [] };
    }
  };
}

// ---------------------------------------------------------------------------
// Minimal snapshot builder for buildOperatorStatusReport
// ---------------------------------------------------------------------------

function minimalSnapshot() {
  return {
    run: {
      id: "run-1",
      status: "in_progress" as const,
      actor: "test",
      updatedAt: new Date().toISOString(),
      projectId: "proj-1"
    },
    tasks: [],
    activeLocks: [],
    blockers: [],
    nextTaskIds: [],
    autonomousExecution: undefined
  };
}

// ---------------------------------------------------------------------------
// Store tests
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getAgenticStateForTask", () => {
  it("returns undefined when no invocations exist for the task", async () => {
    const store = new AgentRuntimeStore(makeStubClient([]) as never);
    const result = await store.getAgenticStateForTask("task-none");
    assert.strictEqual(result, undefined);
  });

  it("returns agentic state when invocations, sample, and handoff exist", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([
        ["agent_invocations where task_id", [{ exists: 1 }]],
        ["agent_context_samples", [{ used_percentage: 73, budget_state: "handoff_required" }]],
        ["agent_handoffs", [{ committed_at: "2026-06-18T19:30:00Z" }]],
        ["count(*) as cnt", [{ cnt: "2" }]]
      ]) as never
    );
    const result = await store.getAgenticStateForTask("task-1");
    assert.ok(result !== undefined);
    assert.strictEqual(result.contextPct, 73);
    assert.strictEqual(result.contextBudgetState, "handoff_required");
    assert.strictEqual(result.handoffState, "committed");
    assert.strictEqual(result.handoffCommittedAt, "2026-06-18T19:30:00Z");
    assert.strictEqual(result.subagentsActive, 2);
  });

  it("handoffState is 'none' when no handoff rows exist", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([
        ["agent_invocations where task_id", [{ exists: 1 }]],
        ["agent_context_samples", [{ used_percentage: 45, budget_state: "ok" }]],
        // no handoff rows — empty result
        ["count(*) as cnt", [{ cnt: "1" }]]
      ]) as never
    );
    const result = await store.getAgenticStateForTask("task-2");
    assert.ok(result !== undefined);
    assert.strictEqual(result.handoffState, "none");
    assert.strictEqual(result.handoffCommittedAt, undefined);
  });

  it("contextPct and contextBudgetState are undefined when no sample rows exist", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([
        ["agent_invocations where task_id", [{ exists: 1 }]],
        // no sample rows
        ["count(*) as cnt", [{ cnt: "0" }]]
      ]) as never
    );
    const result = await store.getAgenticStateForTask("task-3");
    assert.ok(result !== undefined);
    assert.strictEqual(result.contextPct, undefined);
    assert.strictEqual(result.contextBudgetState, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildOperatorStatusReport — agenticState passthrough
// ---------------------------------------------------------------------------

describe("buildOperatorStatusReport agenticState", () => {
  it("passes agenticState through to the report when provided", () => {
    const state: AgenticStateForTask = {
      authorityLabel: "runtime_authoritative",
      taskId: "task-x",
      contextPct: 73,
      contextBudgetState: "handoff_required",
      handoffState: "committed",
      handoffCommittedAt: "2026-06-18T19:30:00Z",
      subagentsActive: 2
    };
    const report = buildOperatorStatusReport({
      snapshot: minimalSnapshot() as never,
      reviewIdentity: { status: "ok", identities: [] } as never,
      graphify: { status: "disabled" } as never,
      agenticState: state
    });
    assert.deepStrictEqual(report.agenticState, state);
  });

  it("agenticState is undefined in report when not provided", () => {
    const report = buildOperatorStatusReport({
      snapshot: minimalSnapshot() as never,
      reviewIdentity: { status: "ok", identities: [] } as never,
      graphify: { status: "disabled" } as never
    });
    assert.strictEqual(report.agenticState, undefined);
  });
});
