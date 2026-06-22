// Tests for the 8 new AgentRuntimeStore methods added in Phase 7 (gap-a).
//
// Uses a stub SqlClient that returns fixed query results.
// No real database connection is required.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntimeStore } from "../src/store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// Stub SqlClient helper
// ---------------------------------------------------------------------------

type QueryResult = { rows: Record<string, unknown>[] };

function makeStubClient(rowsByQuery: Map<string, Record<string, unknown>[]>) {
  return {
    async query(sql: string, _params?: unknown[]): Promise<QueryResult> {
      // Match by a keyword in the SQL to keep stubs simple.
      for (const [key, rows] of rowsByQuery) {
        if (sql.includes(key)) {
          return { rows };
        }
      }
      return { rows: [] };
    }
  };
}

// ---------------------------------------------------------------------------
// hasCommittedHandoff
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.hasCommittedHandoff", () => {
  it("returns true when a row exists", async () => {
    const client = makeStubClient(
      new Map([["agent_handoffs", [{ "?column?": 1 }]]])
    );
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const result = await store.hasCommittedHandoff("inv-1");
    assert.equal(result, true);
  });

  it("returns false when no rows exist", async () => {
    const client = makeStubClient(new Map([["agent_handoffs", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const result = await store.hasCommittedHandoff("inv-2");
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// listSubtasksForTask
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.listSubtasksForTask", () => {
  it("maps rows to Subtask objects", async () => {
    const rows = [
      {
        id: "sub-1",
        run_id: "run-1",
        task_id: "task-1",
        parent_invocation_id: "inv-parent",
        child_invocation_id: "inv-child",
        subagent_type: "backend_engineer",
        title: "Do the thing",
        prompt: "Prompt text",
        allowed_tools: ["Bash"],
        allowed_write_scope: ["src/"],
        status: "completed",
        result_packet: { ok: true },
        created_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T01:00:00Z"
      }
    ];
    const client = makeStubClient(new Map([["agent_subtasks", rows]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const subtasks = await store.listSubtasksForTask("task-1");
    assert.equal(subtasks.length, 1);
    const s = subtasks[0];
    assert.equal(s.id, "sub-1");
    assert.equal(s.runId, "run-1");
    assert.equal(s.taskId, "task-1");
    assert.equal(s.parentInvocationId, "inv-parent");
    assert.equal(s.childInvocationId, "inv-child");
    assert.equal(s.subagentType, "backend_engineer");
    assert.equal(s.status, "completed");
    assert.deepEqual(s.allowedTools, ["Bash"]);
    assert.deepEqual(s.allowedWriteScope, ["src/"]);
    assert.deepEqual(s.resultPacket, { ok: true });
  });

  it("returns empty array when no rows", async () => {
    const client = makeStubClient(new Map([["agent_subtasks", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const subtasks = await store.listSubtasksForTask("task-none");
    assert.deepEqual(subtasks, []);
  });
});

// ---------------------------------------------------------------------------
// getInvocationById
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getInvocationById", () => {
  it("returns an AgentInvocation when row exists", async () => {
    const rows = [
      {
        id: "inv-1",
        run_id: "run-1",
        task_id: "task-1",
        parent_invocation_id: null,
        role: "backend_engineer",
        agent_kind: "subagent",
        model: "claude-sonnet-4-6",
        effort: "medium",
        status: "running",
        context_policy_id: "default",
        session_id: null,
        transcript_path: null,
        depth: 0,
        started_at: "2024-01-01T00:00:00Z",
        completed_at: null,
        metadata: {}
      }
    ];
    const client = makeStubClient(new Map([["agent_invocations", rows]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const inv = await store.getInvocationById("inv-1");
    assert.ok(inv !== undefined);
    assert.equal(inv.id, "inv-1");
    assert.equal(inv.role, "backend_engineer");
    assert.equal(inv.status, "running");
  });

  it("returns undefined when no row exists", async () => {
    const client = makeStubClient(new Map([["agent_invocations", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const inv = await store.getInvocationById("inv-missing");
    assert.equal(inv, undefined);
  });
});

// ---------------------------------------------------------------------------
// listInvocationsForRun
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.listInvocationsForRun", () => {
  it("returns invocations for a run", async () => {
    const rows = [
      {
        id: "inv-a",
        run_id: "run-1",
        task_id: "task-1",
        parent_invocation_id: null,
        role: "planner",
        agent_kind: "root",
        model: "claude-opus-4-8",
        effort: "high",
        status: "completed",
        context_policy_id: "default",
        session_id: null,
        transcript_path: null,
        depth: 0,
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T02:00:00Z",
        metadata: {}
      }
    ];
    const client = makeStubClient(new Map([["agent_invocations", rows]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const invocations = await store.listInvocationsForRun("run-1");
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].id, "inv-a");
  });

  it("returns empty array for unknown run", async () => {
    const client = makeStubClient(new Map([["agent_invocations", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const invocations = await store.listInvocationsForRun("run-none");
    assert.deepEqual(invocations, []);
  });
});

// ---------------------------------------------------------------------------
// listHandoffsForTask
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.listHandoffsForTask", () => {
  it("returns handoff records for a run+task", async () => {
    const rows = [
      {
        id: "hnd-1",
        run_id: "run-1",
        task_id: "task-1",
        from_invocation_id: "inv-a",
        to_invocation_id: null,
        from_role: "planner",
        to_role: "backend_engineer",
        reason: "context_limit",
        status: "written",
        context_used_pct: 75,
        packet: { nextActions: ["continue"] },
        authority_label: "runtime",
        created_at: "2024-01-01T00:00:00Z",
        consumed_at: null
      }
    ];
    const client = makeStubClient(new Map([["agent_handoffs", rows]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const handoffs = await store.listHandoffsForTask("run-1", "task-1");
    assert.equal(handoffs.length, 1);
    const h = handoffs[0];
    assert.equal(h.id, "hnd-1");
    assert.equal(h.fromRole, "planner");
    assert.equal(h.toRole, "backend_engineer");
    assert.equal(h.reason, "context_limit");
    assert.equal(h.status, "written");
  });

  it("returns empty array when no handoffs", async () => {
    const client = makeStubClient(new Map([["agent_handoffs", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const handoffs = await store.listHandoffsForTask("run-none", "task-none");
    assert.deepEqual(handoffs, []);
  });
});

// ---------------------------------------------------------------------------
// listDebateSessionsForRun
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.listDebateSessionsForRun", () => {
  it("returns debate sessions for a run", async () => {
    const rows = [
      {
        id: "deb-1",
        run_id: "run-1",
        task_id: "task-1",
        topic: "Should we use postgres?",
        trigger_kind: "manual",
        status: "completed",
        decision: { outcome: "approved" },
        created_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T01:00:00Z"
      }
    ];
    const client = makeStubClient(new Map([["agent_debate_sessions", rows]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const sessions = await store.listDebateSessionsForRun("run-1");
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.id, "deb-1");
    assert.equal(s.topic, "Should we use postgres?");
    assert.equal(s.status, "completed");
    assert.deepEqual(s.decision, { outcome: "approved" });
  });

  it("returns empty array when no sessions", async () => {
    const client = makeStubClient(new Map([["agent_debate_sessions", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const sessions = await store.listDebateSessionsForRun("run-none");
    assert.deepEqual(sessions, []);
  });
});

// ---------------------------------------------------------------------------
// getDebateSession
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getDebateSession", () => {
  it("returns session when found", async () => {
    const rows = [
      {
        id: "deb-1",
        run_id: "run-1",
        task_id: "task-1",
        topic: "Architecture decision",
        trigger_kind: "auto",
        status: "open",
        decision: null,
        created_at: "2024-01-01T00:00:00Z",
        completed_at: null
      }
    ];
    const client = makeStubClient(new Map([["agent_debate_sessions", rows]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const session = await store.getDebateSession("deb-1");
    assert.ok(session !== null);
    assert.equal(session.id, "deb-1");
    assert.equal(session.status, "open");
    assert.equal(session.decision, undefined);
  });

  it("returns null when not found", async () => {
    const client = makeStubClient(new Map([["agent_debate_sessions", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const session = await store.getDebateSession("deb-missing");
    assert.equal(session, null);
  });
});

// ---------------------------------------------------------------------------
// getInvocationForSpawning
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.getInvocationForSpawning", () => {
  it("returns a spawning record with coalesced depth", async () => {
    const rows = [
      {
        status: "running",
        task_id: "task-1",
        run_id: "run-1",
        role: "planner",
        depth: 2,
        metadata: { someKey: "someValue" }
      }
    ];
    const client = makeStubClient(new Map([["agent_invocations", rows]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const record = await store.getInvocationForSpawning("inv-1");
    assert.ok(record !== undefined);
    assert.equal(record.status, "running");
    assert.equal(record.taskId, "task-1");
    assert.equal(record.runId, "run-1");
    assert.equal(record.role, "planner");
    assert.equal(record.depth, 2);
    assert.deepEqual(record.metadata, { someKey: "someValue" });
  });

  it("coalesces null depth to 0", async () => {
    const rows = [
      {
        status: "pending",
        task_id: "task-1",
        run_id: "run-1",
        role: "backend_engineer",
        depth: 0, // coalesce(null, 0) => 0 in the stub
        metadata: {}
      }
    ];
    const client = makeStubClient(new Map([["agent_invocations", rows]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const record = await store.getInvocationForSpawning("inv-root");
    assert.ok(record !== undefined);
    assert.equal(record.depth, 0);
  });

  it("returns undefined when not found", async () => {
    const client = makeStubClient(new Map([["agent_invocations", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    const record = await store.getInvocationForSpawning("inv-missing");
    assert.equal(record, undefined);
  });
});

// ---------------------------------------------------------------------------
// hasInvocationCrossedThreshold (SDD §20.2 / TDD §8.2)
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.hasInvocationCrossedThreshold", () => {
  it("returns true when a sample at/over threshold exists", async () => {
    const client = makeStubClient(new Map([["agent_context_samples", [{ "?column?": 1 }]]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    assert.equal(await store.hasInvocationCrossedThreshold("inv-1"), true);
  });

  it("returns false when no over-threshold sample exists", async () => {
    const client = makeStubClient(new Map([["agent_context_samples", []]]));
    const store = new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
    assert.equal(await store.hasInvocationCrossedThreshold("inv-2"), false);
  });
});

// ---------------------------------------------------------------------------
// checkReviewIndependenceForTask (SDD §18.3)
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.checkReviewIndependenceForTask", () => {
  // The store now issues a single `select ... from agent_invocations where task_id`
  // query and resolves implementer/reviewer relationships in TypeScript, so the
  // stub returns the full invocation graph keyed on "agent_invocations".
  function graph(rows: Record<string, unknown>[]) {
    const client = makeStubClient(new Map([["agent_invocations", rows]]));
    return new AgentRuntimeStore(client as Parameters<typeof AgentRuntimeStore>[0]);
  }

  it("returns hasInvocations=false when no implementing invocations exist", async () => {
    const store = graph([
      { id: "r1", role: "reviewer", agent_kind: "reviewer", parent_invocation_id: null }
    ]);
    const result = await store.checkReviewIndependenceForTask("task-1");
    assert.equal(result.hasInvocations, false);
    assert.deepEqual(result.implementerRoles, []);
    assert.deepEqual(result.subagentReviewerRoles, []);
  });

  it("returns distinct implementer roles and treats subagent kind as an implementer (C2)", async () => {
    const store = graph([
      { id: "a", role: "backend_engineer", agent_kind: "specialist_owner", parent_invocation_id: null },
      { id: "b", role: "backend_engineer", agent_kind: "specialist_owner", parent_invocation_id: null },
      { id: "c", role: "patch_writer", agent_kind: "subagent", parent_invocation_id: "a" }
    ]);
    const result = await store.checkReviewIndependenceForTask("task-1");
    assert.equal(result.hasInvocations, true);
    assert.deepEqual(result.implementerRoles.sort(), ["backend_engineer", "patch_writer"]);
    assert.deepEqual(result.subagentReviewerRoles, []);
  });

  it("flags a reviewer whose immediate parent is the implementer", async () => {
    const store = graph([
      { id: "a", role: "backend_engineer", agent_kind: "specialist_owner", parent_invocation_id: null },
      { id: "r", role: "reviewer", agent_kind: "reviewer", parent_invocation_id: "a" }
    ]);
    const result = await store.checkReviewIndependenceForTask("task-1");
    assert.deepEqual(result.subagentReviewerRoles, ["reviewer"]);
  });

  it("flags a reviewer that descends from the implementer through a non-implementer intermediary (C1 two-hop)", async () => {
    const store = graph([
      { id: "a", role: "backend_engineer", agent_kind: "specialist_owner", parent_invocation_id: null },
      // intermediary is root_manager (NOT an implementer kind) but its parent is the implementer
      { id: "mid", role: "root_manager", agent_kind: "root_manager", parent_invocation_id: "a" },
      { id: "r", role: "reviewer", agent_kind: "reviewer", parent_invocation_id: "mid" }
    ]);
    const result = await store.checkReviewIndependenceForTask("task-1");
    assert.deepEqual(result.subagentReviewerRoles, ["reviewer"]);
  });

  it("does NOT flag a reviewer spawned by root_manager (legitimate independent review)", async () => {
    const store = graph([
      { id: "a", role: "backend_engineer", agent_kind: "specialist_owner", parent_invocation_id: null },
      { id: "rm", role: "root_manager", agent_kind: "root_manager", parent_invocation_id: null },
      { id: "r", role: "reviewer", agent_kind: "reviewer", parent_invocation_id: "rm" }
    ]);
    const result = await store.checkReviewIndependenceForTask("task-1");
    assert.deepEqual(result.subagentReviewerRoles, []);
  });

  it("flags a debate_participant that descends from the implementer", async () => {
    const store = graph([
      { id: "a", role: "backend_engineer", agent_kind: "specialist_owner", parent_invocation_id: null },
      { id: "d", role: "security_reviewer", agent_kind: "debate_participant", parent_invocation_id: "a" }
    ]);
    const result = await store.checkReviewIndependenceForTask("task-1");
    assert.deepEqual(result.subagentReviewerRoles, ["security_reviewer"]);
  });

  it("terminates on a cyclic parent chain without flagging", async () => {
    const store = graph([
      { id: "a", role: "backend_engineer", agent_kind: "specialist_owner", parent_invocation_id: null },
      { id: "x", role: "reviewer", agent_kind: "reviewer", parent_invocation_id: "y" },
      { id: "y", role: "reviewer", agent_kind: "reviewer", parent_invocation_id: "x" }
    ]);
    const result = await store.checkReviewIndependenceForTask("task-1");
    assert.deepEqual(result.subagentReviewerRoles, []);
  });
});
