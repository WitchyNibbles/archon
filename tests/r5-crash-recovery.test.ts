// Tests for R5: crash_recovery continuation.
//
// Covers:
//   - HandoffController.recoverCrashedInvocation builds a valid crash_recovery
//     packet and transitions the invocation to handoff_written
//   - recoverOrphanedInvocations lists + recovers each orphan, tolerating none
//   - AgentRuntimeStore.listRecoverableInvocations issues a threshold query and
//     maps rows

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HandoffController } from "../src/runtime/handoff-controller.ts";
import { recoverOrphanedInvocations } from "../src/runtime/crash-recovery.ts";
import type { CrashRecoveryStoreLike, RecoverableInvocation } from "../src/runtime/crash-recovery.ts";
import { AgentRuntimeStore } from "../src/store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// In-memory handoff store stub
// ---------------------------------------------------------------------------

function makeHandoffStore(orphans: RecoverableInvocation[] = []) {
  const created: Record<string, unknown>[] = [];
  const statusUpdates: { id: string; status: string }[] = [];
  const store: CrashRecoveryStoreLike = {
    async createHandoff(data) {
      created.push(data);
      return {
        id: data.id,
        runId: data.runId,
        taskId: data.taskId,
        fromInvocationId: data.fromInvocationId,
        fromRole: data.fromRole,
        toRole: data.toRole,
        reason: data.reason,
        status: data.status,
        packet: data.packet,
        authorityLabel: "runtime_authoritative",
        createdAt: data.createdAt ?? new Date().toISOString()
      };
    },
    async getLatestUnconsumedHandoff() {
      return undefined;
    },
    async markHandoffConsumed() {
      /* no-op */
    },
    async updateAgentInvocationStatus(id, status) {
      statusUpdates.push({ id, status });
    },
    async listRecoverableInvocations() {
      return orphans;
    }
  };
  return { store, created, statusUpdates };
}

// ---------------------------------------------------------------------------
// recoverCrashedInvocation
// ---------------------------------------------------------------------------

describe("HandoffController.recoverCrashedInvocation", () => {
  it("commits a valid crash_recovery packet and marks the invocation handoff_written", async () => {
    const { store, created, statusUpdates } = makeHandoffStore();
    const controller = new HandoffController(store);

    const result = await controller.recoverCrashedInvocation({
      invocationId: "ainv_crashed",
      runId: "run-1",
      taskId: "task-1",
      role: "backend_engineer",
      contextUsedPct: 74
    });

    assert.strictEqual(result.newStatus, "handoff_written");
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].reason, "crash_recovery");
    const packet = created[0].packet as Record<string, unknown>;
    assert.strictEqual(packet.status, "needs_followup");
    assert.ok(Array.isArray(packet.evidenceRefs) && (packet.evidenceRefs as unknown[]).length > 0);
    assert.ok(Array.isArray(packet.nextActions) && (packet.nextActions as unknown[]).length > 0);
    // prepare() -> handoff_requested, commit() -> handoff_written
    assert.deepStrictEqual(
      statusUpdates.map((u) => u.status),
      ["handoff_requested", "handoff_written"]
    );
  });

  it("falls back to a runtime evidence ref when none is supplied", async () => {
    const { store, created } = makeHandoffStore();
    const controller = new HandoffController(store);
    await controller.recoverCrashedInvocation({
      invocationId: "ainv_x",
      runId: "run-1",
      taskId: "task-1",
      role: "reviewer"
    });
    const packet = created[0].packet as Record<string, unknown>;
    assert.deepStrictEqual(packet.evidenceRefs, ["runtime://invocation/ainv_x"]);
  });
});

// ---------------------------------------------------------------------------
// recoverOrphanedInvocations
// ---------------------------------------------------------------------------

describe("recoverOrphanedInvocations", () => {
  it("recovers each orphaned invocation", async () => {
    const orphans: RecoverableInvocation[] = [
      { invocationId: "ainv_1", runId: "run-1", taskId: "task-1", role: "backend_engineer", contextUsedPct: 72 },
      { invocationId: "ainv_2", runId: "run-1", taskId: "task-2", role: "frontend_designer", contextUsedPct: 81 }
    ];
    const { store, created } = makeHandoffStore(orphans);
    const results = await recoverOrphanedInvocations(store, "run-1");
    assert.strictEqual(results.length, 2);
    assert.strictEqual(created.length, 2);
    assert.deepStrictEqual(
      results.map((r) => r.invocationId).sort(),
      ["ainv_1", "ainv_2"]
    );
  });

  it("returns an empty array when there are no orphans", async () => {
    const { store } = makeHandoffStore([]);
    const results = await recoverOrphanedInvocations(store, "run-1");
    assert.deepStrictEqual(results, []);
  });

  it("isolates per-orphan failures: recovers the others, then rethrows", async () => {
    const orphans: RecoverableInvocation[] = [
      { invocationId: "ainv_ok", runId: "run-1", taskId: "task-1", role: "backend_engineer", contextUsedPct: 72 },
      { invocationId: "ainv_bad", runId: "run-1", taskId: "task-2", role: "reviewer", contextUsedPct: 75 }
    ];
    const committed: string[] = [];
    const store: CrashRecoveryStoreLike = {
      async createHandoff(data) {
        committed.push(data.fromInvocationId);
        return {
          id: data.id,
          runId: data.runId,
          taskId: data.taskId,
          fromInvocationId: data.fromInvocationId,
          fromRole: data.fromRole,
          toRole: data.toRole,
          reason: data.reason,
          status: data.status,
          packet: data.packet,
          authorityLabel: "runtime_authoritative",
          createdAt: data.createdAt ?? new Date().toISOString()
        };
      },
      async getLatestUnconsumedHandoff() {
        return undefined;
      },
      async markHandoffConsumed() {},
      async updateAgentInvocationStatus(id) {
        // Fail the second orphan during its prepare() status update.
        if (id === "ainv_bad") {
          throw new Error("simulated DB failure for ainv_bad");
        }
      },
      async listRecoverableInvocations() {
        return orphans;
      }
    };

    await assert.rejects(
      () => recoverOrphanedInvocations(store, "run-1"),
      /crash recovery failed for 1 invocation/
    );
    // The good orphan was still recovered despite the bad one failing.
    assert.deepStrictEqual(committed, ["ainv_ok"]);
  });
});

// ---------------------------------------------------------------------------
// AgentRuntimeStore.listRecoverableInvocations
// ---------------------------------------------------------------------------

describe("AgentRuntimeStore.listRecoverableInvocations", () => {
  it("queries the threshold + no-handoff condition and maps rows", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        capturedSql = sql;
        capturedParams = params ?? [];
        return {
          rows: [
            { id: "ainv_1", run_id: "run-1", task_id: "task-1", role: "backend_engineer", max_used_pct: "73.50" }
          ]
        };
      }
    };
    const store = new AgentRuntimeStore(client as never);
    const result = await store.listRecoverableInvocations("run-1", 70);

    assert.match(capturedSql, /ended_at is null/);
    assert.match(capturedSql, /agent_handoffs/);
    assert.deepStrictEqual(capturedParams, ["run-1", 70]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].invocationId, "ainv_1");
    assert.strictEqual(result[0].contextUsedPct, 73.5);
  });

  it("maps a null max_used_pct to undefined", async () => {
    const client = {
      async query() {
        return {
          rows: [{ id: "ainv_2", run_id: "run-1", task_id: "task-2", role: "reviewer", max_used_pct: null }]
        };
      }
    };
    const store = new AgentRuntimeStore(client as never);
    const result = await store.listRecoverableInvocations("run-1", 70);
    assert.strictEqual(result[0].contextUsedPct, undefined);
  });
});
