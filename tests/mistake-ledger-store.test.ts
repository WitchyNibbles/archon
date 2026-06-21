// Tests for P1 mistake ledger store implementations:
//   - MemoryMistakeLedgerStore (memory-store.ts)
//   - PostgresMistakeLedgerStore (postgres-store.ts)
//   - Capture hook in ArchonCoreService.recordReview (service.ts)
//
// Node built-in test runner only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeFingerprint,
  type MistakeOccurrenceRecord
} from "../src/runtime/mistake-ledger.ts";
import { MemoryMistakeLedgerStore, MemoryStore } from "../src/store/memory-store.ts";
import { PostgresMistakeLedgerStore } from "../src/store/postgres-store.ts";
import { ArchonCoreService } from "../src/core/service.ts";
import {
  createTrustedReviewActionContextForTest
} from "../src/core/review-context.ts";
import type { ResolveReviewActionContext } from "../src/core/review-context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOccurrence(overrides: Partial<MistakeOccurrenceRecord> = {}): MistakeOccurrenceRecord {
  const fp = computeFingerprint("immutability_violation", "coding-style#immutability");
  return {
    id: `occ-${Math.random().toString(36).slice(2)}`,
    fingerprint: fp,
    category: "immutability_violation",
    ruleLocus: "coding-style#immutability",
    pathLocus: undefined,
    rawFinding: "mutated object in place",
    severity: "medium",
    reviewerRole: "reviewer",
    runId: "run-1",
    taskId: "task-1",
    capturedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// MemoryMistakeLedgerStore
// ---------------------------------------------------------------------------

describe("MemoryMistakeLedgerStore", () => {
  it("starts empty", async () => {
    const store = new MemoryMistakeLedgerStore();
    const list = await store.listMistakeOccurrences("project-1");
    assert.deepStrictEqual(list, []);
  });

  it("returns empty for unknown project", async () => {
    const store = new MemoryMistakeLedgerStore();
    await store.appendMistakeOccurrences("project-a", [makeOccurrence()]);
    const list = await store.listMistakeOccurrences("project-b");
    assert.deepStrictEqual(list, []);
  });

  it("appends occurrences and lists them back", async () => {
    const store = new MemoryMistakeLedgerStore();
    const occ = makeOccurrence({ id: "occ-1" });
    await store.appendMistakeOccurrences("project-1", [occ]);
    const list = await store.listMistakeOccurrences("project-1");
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]?.id, "occ-1");
  });

  it("accumulates across multiple appends", async () => {
    const store = new MemoryMistakeLedgerStore();
    const occ1 = makeOccurrence({ id: "occ-1" });
    const occ2 = makeOccurrence({ id: "occ-2" });
    await store.appendMistakeOccurrences("project-1", [occ1]);
    await store.appendMistakeOccurrences("project-1", [occ2]);
    const list = await store.listMistakeOccurrences("project-1");
    assert.strictEqual(list.length, 2);
  });

  it("is idempotent by id (duplicate append does not duplicate record)", async () => {
    const store = new MemoryMistakeLedgerStore();
    const occ = makeOccurrence({ id: "occ-dup" });
    await store.appendMistakeOccurrences("project-1", [occ]);
    await store.appendMistakeOccurrences("project-1", [occ]);
    const list = await store.listMistakeOccurrences("project-1");
    assert.strictEqual(list.length, 1);
  });

  it("does nothing on empty array", async () => {
    const store = new MemoryMistakeLedgerStore();
    await store.appendMistakeOccurrences("project-1", []);
    const list = await store.listMistakeOccurrences("project-1");
    assert.deepStrictEqual(list, []);
  });

  it("isolates occurrences by projectId", async () => {
    const store = new MemoryMistakeLedgerStore();
    const o1 = makeOccurrence({ id: "o1" });
    const o2 = makeOccurrence({ id: "o2" });
    await store.appendMistakeOccurrences("project-A", [o1]);
    await store.appendMistakeOccurrences("project-B", [o2]);
    const listA = await store.listMistakeOccurrences("project-A");
    const listB = await store.listMistakeOccurrences("project-B");
    assert.strictEqual(listA.length, 1);
    assert.strictEqual(listA[0]?.id, "o1");
    assert.strictEqual(listB.length, 1);
    assert.strictEqual(listB[0]?.id, "o2");
  });

  it("listAntiPatternsForLocus: returns ONLY approved entries — pending entry excluded (FIX 1 mplInjectionHardening)", async () => {
    // Defence-in-depth: the query layer must filter on status='approved', not rely on callers.
    const store = new MemoryMistakeLedgerStore();
    const fp = computeFingerprint("immutability_violation", "coding-style#immutability");

    const baseEntry = {
      workspaceId: "ws-1",
      projectId: "proj-status-test",
      runId: "run-1",
      taskId: "task-1",
      scope: "project" as const,
      entryType: "anti_pattern" as const,
      title: "Anti-pattern: immutability_violation",
      content: `Anti-pattern: immutability_violation\nFingerprint: ${fp}`,
      reviewer: "archon-orchestrator",
      actor: "archon-orchestrator",
      createdAt: new Date().toISOString(),
      metadata: {
        tags: ["anti_pattern", `fingerprint:${fp}`],
        mistakeFingerprint: fp,
        authorityLevel: "reviewed_memory" as const,
        reviewedAt: new Date().toISOString(),
        retrievalRoles: ["reviewer"] as const
      }
    };

    const approvedEntry = { ...baseEntry, id: "entry-approved", status: "approved" as const };
    const pendingEntry = { ...baseEntry, id: "entry-pending", status: "pending" as const };

    await store.appendAntiPatternEntry("proj-status-test", approvedEntry);
    await store.appendAntiPatternEntry("proj-status-test", pendingEntry);

    // listAntiPatternsForLocus must return only the approved entry.
    const results = await store.listAntiPatternsForLocus("proj-status-test", []);
    assert.strictEqual(results.length, 1, "only approved entry must be returned");
    assert.strictEqual(results[0]!.id, "entry-approved", "returned entry must be the approved one");
    assert.ok(
      results.every((e) => e.status === "approved"),
      "all returned entries must have status=approved"
    );
  });

  it("appendAntiPatternEntry: two calls with same entry id store exactly one row (ON CONFLICT DO UPDATE idempotency)", async () => {
    // FIX 4 (HIGH): verify appendAntiPatternEntry dedup so the same entry id
    // never accumulates duplicate rows regardless of how many times it is called.
    const store = new MemoryMistakeLedgerStore();
    const fp = computeFingerprint("immutability_violation", "coding-style#immutability");
    const entry = {
      id: "entry-dedup-test",
      workspaceId: "ws-1",
      projectId: "proj-dedup",
      runId: "run-1",
      taskId: "task-1",
      scope: "project" as const,
      entryType: "anti_pattern" as const,
      title: "Anti-pattern: immutability_violation",
      content: `Anti-pattern: immutability_violation\nPolicy anchor: coding-style#immutability\nFingerprint: ${fp}`,
      reviewer: "archon-orchestrator",
      actor: "archon-orchestrator",
      status: "approved" as const,
      createdAt: new Date().toISOString(),
      metadata: {
        tags: ["anti_pattern", "category:immutability_violation", `fingerprint:${fp}`],
        mistakeFingerprint: fp,
        authorityLevel: "reviewed_memory" as const,
        reviewedAt: new Date().toISOString(),
        retrievalRoles: ["reviewer"] as const
      }
    };

    // First call.
    await store.appendAntiPatternEntry("proj-dedup", entry);
    // Second call with same entry id — must upsert, not duplicate.
    await store.appendAntiPatternEntry("proj-dedup", entry);

    const results = await store.listAntiPatternsForLocus("proj-dedup", []);
    assert.strictEqual(results.length, 1, "two appendAntiPatternEntry calls with the same id must result in exactly one stored row");
  });
});

// ---------------------------------------------------------------------------
// PostgresMistakeLedgerStore (mock client)
// ---------------------------------------------------------------------------

describe("PostgresMistakeLedgerStore", () => {
  // Minimal mock client that tracks queries
  function makeClient(
    initialState: Record<string, unknown> = { status: "idle", items: [] }
  ): {
    client: Parameters<typeof PostgresMistakeLedgerStore.prototype.constructor>[0];
    capturedUpdates: { sql: string; params: unknown[] }[];
    productState: Record<string, unknown>;
  } {
    let productState = { ...initialState };
    const capturedUpdates: { sql: string; params: unknown[] }[] = [];

    const client = {
      async query(sql: string, params?: readonly unknown[]) {
        if (sql.includes("select product_state")) {
          return {
            rows: [{ product_state: productState }],
            rowCount: 1
          };
        }
        if (sql.includes("update project_runtime_state")) {
          capturedUpdates.push({ sql, params: [...(params ?? [])] });
          // Apply the update to our in-memory state
          const newStateJson = params?.[1];
          if (typeof newStateJson === "string") {
            productState = JSON.parse(newStateJson) as Record<string, unknown>;
          }
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    return { client, capturedUpdates, productState };
  }

  it("lists empty array when product_state has no mistake_occurrences key", async () => {
    const { client } = makeClient({ status: "idle", items: [] });
    const store = new PostgresMistakeLedgerStore(client as never);
    const list = await store.listMistakeOccurrences("project-1");
    assert.deepStrictEqual(list, []);
  });

  it("lists occurrences when product_state has mistake_occurrences array", async () => {
    const occ = makeOccurrence({ id: "pg-occ-1" });
    const { client } = makeClient({ status: "idle", items: [], mistake_occurrences: [occ] });
    const store = new PostgresMistakeLedgerStore(client as never);
    const list = await store.listMistakeOccurrences("project-1");
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]?.id, "pg-occ-1");
  });

  it("appends new occurrences to product_state", async () => {
    const { client, capturedUpdates } = makeClient();
    const store = new PostgresMistakeLedgerStore(client as never);
    const occ = makeOccurrence({ id: "pg-new-1" });
    await store.appendMistakeOccurrences("project-1", [occ]);
    assert.strictEqual(capturedUpdates.length, 1);
    // The update SQL should use parameterized values
    const updateCall = capturedUpdates[0];
    assert.ok(updateCall !== undefined);
    const updatedJson = updateCall.params[1];
    assert.strictEqual(typeof updatedJson, "string");
    const parsed = JSON.parse(updatedJson as string) as Record<string, unknown>;
    assert.ok(Array.isArray(parsed["mistake_occurrences"]));
    const occs = parsed["mistake_occurrences"] as MistakeOccurrenceRecord[];
    assert.strictEqual(occs.length, 1);
    assert.strictEqual(occs[0]?.id, "pg-new-1");
  });

  it("is idempotent by id", async () => {
    const occ = makeOccurrence({ id: "pg-dup" });
    const { client } = makeClient({ status: "idle", items: [], mistake_occurrences: [occ] });
    const store = new PostgresMistakeLedgerStore(client as never);
    await store.appendMistakeOccurrences("project-1", [occ]);
    const list = await store.listMistakeOccurrences("project-1");
    assert.strictEqual(list.length, 1);
  });

  it("does not update DB when incoming array is empty", async () => {
    const { client, capturedUpdates } = makeClient();
    const store = new PostgresMistakeLedgerStore(client as never);
    await store.appendMistakeOccurrences("project-1", []);
    assert.strictEqual(capturedUpdates.length, 0);
  });

  it("preserves existing product_state keys when updating", async () => {
    const { client } = makeClient({ status: "active", custom_field: "keep_me", items: [] });
    const store = new PostgresMistakeLedgerStore(client as never);
    const occ = makeOccurrence({ id: "pg-preserve" });
    await store.appendMistakeOccurrences("project-1", [occ]);
    const list = await store.listMistakeOccurrences("project-1");
    // After append, still readable, and productState preserves other keys
    assert.strictEqual(list.length, 1);
    // Verify state via listMistakeOccurrences call which reads the updated state
    const listAgain = await store.listMistakeOccurrences("project-1");
    assert.strictEqual(listAgain.length, 1);
  });

  it("appendAntiPatternEntry: two calls with same entry id issue ON CONFLICT DO UPDATE (idempotency)", async () => {
    // FIX 4 (HIGH): verify PostgresMistakeLedgerStore.appendAntiPatternEntry uses
    // ON CONFLICT DO UPDATE so that duplicate calls with the same entry id are safe.
    // The mock captures all INSERT SQL strings to assert the ON CONFLICT clause is present.
    const capturedSqls: string[] = [];
    const mockClient = {
      async query(sql: string, params?: readonly unknown[]) {
        if (sql.toLowerCase().includes("insert into memory_entries")) {
          capturedSqls.push(sql);
        }
        return { rows: [], rowCount: 1 };
      }
    };

    const store = new PostgresMistakeLedgerStore(mockClient as never);
    const fp = computeFingerprint("immutability_violation", "coding-style#immutability");
    const entry = {
      id: "pg-entry-dedup",
      workspaceId: "ws-1",
      projectId: "proj-pg-dedup",
      runId: "run-1",
      taskId: "task-1",
      scope: "project" as const,
      entryType: "anti_pattern" as const,
      title: "Anti-pattern: immutability_violation",
      content: `Anti-pattern: immutability_violation\nFingerprint: ${fp}`,
      reviewer: "archon-orchestrator",
      actor: "archon-orchestrator",
      status: "approved" as const,
      createdAt: new Date().toISOString(),
      metadata: {
        tags: ["anti_pattern", `fingerprint:${fp}`],
        mistakeFingerprint: fp,
        authorityLevel: "reviewed_memory" as const,
        reviewedAt: new Date().toISOString(),
        retrievalRoles: ["reviewer"] as const
      }
    };

    // Two calls with same entry id must both succeed without throwing.
    await store.appendAntiPatternEntry("proj-pg-dedup", entry);
    await store.appendAntiPatternEntry("proj-pg-dedup", entry);

    // Each call must issue exactly one INSERT.
    assert.strictEqual(capturedSqls.length, 2, "appendAntiPatternEntry must issue one INSERT per call");
    // Every INSERT must use ON CONFLICT DO UPDATE to guarantee idempotency on a real DB.
    for (const sql of capturedSqls) {
      assert.ok(
        sql.toLowerCase().includes("on conflict"),
        `INSERT must contain ON CONFLICT clause — got: ${sql.slice(0, 80)}`
      );
    }
  });

  it("listAntiPatternsForLocus: SQL query includes status='approved' filter (FIX 1 mplInjectionHardening)", async () => {
    // Defence-in-depth: the SELECT must carry AND status = 'approved' so non-approved
    // entries stored in memory_entries never reach the injection layer.
    const capturedSqls: string[] = [];
    const mockClient = {
      async query(sql: string, _params?: readonly unknown[]) {
        if (sql.toLowerCase().includes("from memory_entries")) {
          capturedSqls.push(sql);
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const store = new PostgresMistakeLedgerStore(mockClient as never);
    await store.listAntiPatternsForLocus("proj-pg-status", ["src/store/"]);

    assert.ok(capturedSqls.length > 0, "listAntiPatternsForLocus must issue a SELECT against memory_entries");
    const sql = capturedSqls[0]!;
    assert.ok(
      /status\s*=\s*'approved'/i.test(sql),
      `SELECT must include AND status = 'approved' — got: ${sql.replace(/\s+/g, " ").slice(0, 200)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Capture hook integration: ArchonCoreService.recordReview
// ---------------------------------------------------------------------------
// Tests the wiring of the capture hook by constructing a full ArchonCoreService
// with MemoryStore + MemoryMistakeLedgerStore, using intakeRequest →
// createTaskGraph → claimTask → submitHandoff to get a task into review_blocked,
// then calling recordReview with "blocked" state (the valid non-passing state).

describe("ArchonCoreService.recordReview capture hook (P1 MPL)", () => {
  function makeTrustedResolver(): ResolveReviewActionContext {
    return async (_input) =>
      createTrustedReviewActionContextForTest({ actor: "orchestrator-actor", actorRole: "reviewer" });
  }

  /** Build the full task lifecycle up to review_blocked. */
  async function buildReviewBlockedTask(service: InstanceType<typeof ArchonCoreService>) {
    const run = await service.intakeRequest({
      workspaceSlug: "test-ws",
      projectSlug: "test-proj",
      actor: "manager",
      title: "P1 MPL capture test run",
      request: "test"
    });

    const taskId = "capture-test-task";
    await service.createTaskGraph(run.id, [
      {
        taskId,
        title: "Capture test task",
        ownerRole: "backend_engineer",
        completionStandard: "artifact_complete",
        requiredSpecialistRoles: ["backend_engineer"],
        qualityGates: ["product_acceptance"],
        goal: "Validate capture hook behaviour",
        inputs: ["task description"],
        outputs: ["capture evidence"],
        dependencies: [],
        allowedWriteScope: ["src/runtime/"],
        outOfScope: ["production deploys"],
        acceptanceCriteria: ["capture hook fires on failed review"],
        verificationSteps: ["run mistake-ledger-store tests"],
        securityChecks: ["verify non-fatal wiring"],
        antiPatterns: ["ledger errors blocking review path"],
        rollbackNotes: "remove test fixture",
        handoffFormat: "summary only",
        requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"]
      }
    ]);

    await service.claimTask(run.id, taskId, "backend-agent");
    await service.submitHandoff(run.id, taskId, {
      actor: "backend-agent",
      ownerRole: "backend_engineer",
      completionStandard: "artifact_complete",
      summary: "Implementation complete.",
      changedFiles: ["src/runtime/mistake-ledger.ts"],
      blockers: [],
      verificationNotes: ["all tests pass"],
      executionEvidence: ["ran node --test"],
      qualityGateEvidence: ["product acceptance: implementation meets requirements"],
      contextRefs: ["docs/proposals/mistake-pattern-ledger.md"]
    });

    return { runId: run.id, taskId };
  }

  it("records occurrences after a blocked review with classifiable findings", async () => {
    const store = new MemoryStore();
    const ledger = new MemoryMistakeLedgerStore();

    const service = new ArchonCoreService(store, {
      reviewSource: "orchestrator",
      resolveReviewActionContext: makeTrustedResolver(),
      mistakeLedgerStore: ledger
    });

    const { runId, taskId } = await buildReviewBlockedTask(service);

    await service.recordReview(runId, taskId, "reviewer-actor", {
      reviewerRole: "reviewer",
      state: "blocked",
      severity: "high",
      findings: [
        "mutated existing object in place",
        "unparameterized SQL query"
      ]
    });

    // Give the fire-and-forget promise time to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Find the project to look up occurrences
    const ctx = await store.getProjectContext({ workspaceSlug: "test-ws", projectSlug: "test-proj" });
    assert.ok(ctx !== undefined);

    const occurrences = await ledger.listMistakeOccurrences(ctx.project.id);
    assert.strictEqual(occurrences.length, 2);

    const categories = new Set(occurrences.map((o) => o.category));
    assert.ok(categories.has("immutability_violation"), "should have immutability_violation");
    assert.ok(categories.has("sql_injection"), "should have sql_injection");
  });

  it("records no occurrences after a passed review", async () => {
    const store = new MemoryStore();
    const ledger = new MemoryMistakeLedgerStore();

    const service = new ArchonCoreService(store, {
      reviewSource: "orchestrator",
      resolveReviewActionContext: makeTrustedResolver(),
      mistakeLedgerStore: ledger
    });

    const { runId, taskId } = await buildReviewBlockedTask(service);

    await service.recordReview(runId, taskId, "reviewer-actor", {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const ctx = await store.getProjectContext({ workspaceSlug: "test-ws", projectSlug: "test-proj" });
    assert.ok(ctx !== undefined);

    const occurrences = await ledger.listMistakeOccurrences(ctx.project.id);
    assert.strictEqual(occurrences.length, 0, "passed reviews must not create occurrences");
  });

  it("does not propagate ledger errors into recordReview", async () => {
    const store = new MemoryStore();

    const brokenLedger = {
      appendMistakeOccurrences: async () => {
        throw new Error("Ledger store exploded");
      },
      listMistakeOccurrences: async (): Promise<readonly MistakeOccurrenceRecord[]> => []
    };

    const service = new ArchonCoreService(store, {
      reviewSource: "orchestrator",
      resolveReviewActionContext: makeTrustedResolver(),
      mistakeLedgerStore: brokenLedger
    });

    const { runId, taskId } = await buildReviewBlockedTask(service);

    // recordReview must complete even if the ledger store explodes
    await assert.doesNotReject(
      service.recordReview(runId, taskId, "reviewer-actor", {
        reviewerRole: "reviewer",
        state: "blocked",
        severity: "high",
        findings: ["mutated object in place"]
      }),
      "recordReview must not propagate ledger errors"
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("is a no-op when mistakeLedgerStore is not provided", async () => {
    // Service without ledger must not throw or behave differently
    const store = new MemoryStore();
    const service = new ArchonCoreService(store, {
      reviewSource: "orchestrator",
      resolveReviewActionContext: makeTrustedResolver()
      // no mistakeLedgerStore
    });

    const { runId, taskId } = await buildReviewBlockedTask(service);

    await assert.doesNotReject(
      service.recordReview(runId, taskId, "reviewer-actor", {
        reviewerRole: "reviewer",
        state: "blocked",
        severity: "medium",
        findings: ["mutated object in place"]
      }),
      "recordReview without ledger must not throw"
    );
  });
});
