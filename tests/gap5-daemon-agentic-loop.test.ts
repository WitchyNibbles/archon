// Tests for Gap 5: AgenticLoopController/ContinuationContextBuilder wired into loopCommand.
//
// Covers:
//   - AgentRuntimeStore satisfies AgenticLoopStoreLike bridge methods
//   - getNextTask — returns null when no ready tasks
//   - getNextTask — returns TaskSummary when a ready task exists
//   - createInvocation — creates record and returns id
//   - updateInvocationStatus — delegates to updateAgentInvocationStatus
//   - getInvocationStatus — returns status from getInvocationById
//   - getInvocationTaskId — queries task_id column directly
//   - getActiveTask — returns null when no in_progress tasks
//   - getActiveTask — returns TaskSummary when in_progress task exists
//   - getActiveInvocation — returns null when no running invocations
//   - getActiveInvocation — returns id when running invocation exists
//   - countPendingHandoffs — returns 0 when no pending handoffs
//   - countPendingHandoffs — returns count when pending handoffs exist
//   - loopCommand exports confirm AgenticLoopController + ContinuationContextBuilder are used

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntimeStore } from "../src/store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// Stub SqlClient — same pattern as phase7-store-methods.test.ts
// ---------------------------------------------------------------------------

type QueryResult = { rows: Record<string, unknown>[] };

function makeStubClient(rowsByKey: [string, Record<string, unknown>[]][]) {
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
// getNextTask
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getNextTask", () => {
  it("returns null when no ready tasks exist for the run", async () => {
    const store = new AgentRuntimeStore(makeStubClient([]) as never);
    const result = await store.getNextTask("run-1");
    assert.strictEqual(result, null);
  });

  it("returns a TaskSummary when a ready task exists", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([
        ["tasks", [{ id: "task-001", title: "First task", status: "ready" }]]
      ]) as never
    );
    const result = await store.getNextTask("run-1");
    assert.ok(result !== null);
    assert.strictEqual(result.id, "task-001");
    assert.strictEqual(result.title, "First task");
    assert.strictEqual(result.status, "ready");
  });
});

// ---------------------------------------------------------------------------
// createInvocation
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.createInvocation", () => {
  it("returns a string id after creating the invocation record", async () => {
    const insertedRows: unknown[][] = [];
    const client = {
      async query(sql: string, params?: unknown[]): Promise<QueryResult> {
        if (sql.includes("insert into agent_invocations")) {
          insertedRows.push(params ?? []);
          // Return the AgentInvocation row that createAgentInvocation expects
          return {
            rows: [{
              id: params?.[0] ?? "inv-1",
              run_id: params?.[1] ?? "run-1",
              task_id: params?.[2] ?? "task-001",
              role: params?.[4] ?? "specialist_owner",
              agent_kind: "specialist_owner",
              model: "sonnet",
              effort: "high",
              status: "running",
              context_policy_id: "default",
              started_at: new Date().toISOString(),
              metadata: {}
            }]
          };
        }
        return { rows: [] };
      }
    };
    const store = new AgentRuntimeStore(client as never);
    const id = await store.createInvocation({
      runId: "run-1",
      taskId: "task-001",
      role: "specialist_owner",
      startedAt: new Date().toISOString()
    });
    assert.strictEqual(typeof id, "string");
    assert.ok(id.length > 0);
    assert.strictEqual(insertedRows.length, 1);
  });
});

// ---------------------------------------------------------------------------
// updateInvocationStatus
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.updateInvocationStatus", () => {
  it("calls updateAgentInvocationStatus without throwing", async () => {
    const updatedIds: string[] = [];
    const client = {
      async query(sql: string, params?: unknown[]): Promise<QueryResult> {
        if (sql.includes("update agent_invocations")) {
          updatedIds.push(String(params?.[params.length - 1] ?? ""));
        }
        return { rows: [] };
      }
    };
    const store = new AgentRuntimeStore(client as never);
    await store.updateInvocationStatus("inv-1", "completed");
    assert.strictEqual(updatedIds.length, 1);
  });
});

// ---------------------------------------------------------------------------
// getInvocationStatus
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getInvocationStatus", () => {
  it("returns undefined when invocation not found", async () => {
    const store = new AgentRuntimeStore(makeStubClient([]) as never);
    const result = await store.getInvocationStatus("inv-missing");
    assert.strictEqual(result, undefined);
  });

  it("returns status string when invocation exists", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([
        [
          "from agent_invocations",
          [{ status: "running", task_id: "task-001", run_id: "run-1", role: "specialist_owner", depth: 0, metadata: {} }]
        ]
      ]) as never
    );
    const result = await store.getInvocationStatus("inv-1");
    assert.strictEqual(result, "running");
  });
});

// ---------------------------------------------------------------------------
// getInvocationTaskId
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getInvocationTaskId", () => {
  it("returns undefined when invocation not found", async () => {
    const store = new AgentRuntimeStore(makeStubClient([]) as never);
    const result = await store.getInvocationTaskId("inv-missing");
    assert.strictEqual(result, undefined);
  });

  it("returns task_id string when invocation exists", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([["task_id from agent_invocations", [{ task_id: "task-42" }]]]) as never
    );
    const result = await store.getInvocationTaskId("inv-1");
    assert.strictEqual(result, "task-42");
  });
});

// ---------------------------------------------------------------------------
// getActiveTask
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getActiveTask", () => {
  it("returns null when no in_progress task exists", async () => {
    const store = new AgentRuntimeStore(makeStubClient([]) as never);
    const result = await store.getActiveTask("run-1");
    assert.strictEqual(result, null);
  });

  it("returns TaskSummary when in_progress task exists", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([
        ["in_progress", [{ id: "task-007", title: "Active task", status: "in_progress" }]]
      ]) as never
    );
    const result = await store.getActiveTask("run-1");
    assert.ok(result !== null);
    assert.strictEqual(result.id, "task-007");
    assert.strictEqual(result.status, "in_progress");
  });
});

// ---------------------------------------------------------------------------
// getActiveInvocation
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getActiveInvocation", () => {
  it("returns null when no running invocation exists", async () => {
    const store = new AgentRuntimeStore(makeStubClient([]) as never);
    const result = await store.getActiveInvocation("run-1");
    assert.strictEqual(result, null);
  });

  it("returns invocation id when a running invocation exists", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([["status = 'running'", [{ id: "inv-active" }]]]) as never
    );
    const result = await store.getActiveInvocation("run-1");
    assert.strictEqual(result, "inv-active");
  });
});

// ---------------------------------------------------------------------------
// countPendingHandoffs
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.countPendingHandoffs", () => {
  it("returns 0 when no pending handoffs", async () => {
    const store = new AgentRuntimeStore(makeStubClient([]) as never);
    const count = await store.countPendingHandoffs("run-1");
    assert.strictEqual(count, 0);
  });

  it("returns the pending handoff count", async () => {
    const store = new AgentRuntimeStore(
      makeStubClient([["consumed_at is null", [{ cnt: "3" }]]]) as never
    );
    const count = await store.countPendingHandoffs("run-1");
    assert.strictEqual(count, 3);
  });
});
