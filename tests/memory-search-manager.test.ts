/**
 * Direct unit tests for MemorySearchManager (src/core/memory-search-manager.ts).
 *
 * This module was extracted from ArchonCoreService (audit F5 / service.ts split
 * slice 4). These tests exercise the manager class DIRECTLY against a MemoryStore
 * double + injected deps (requireRun / getStatus / bumpRunState / resolver), so a
 * drift in the promotion trust gate, search filtering, or the runtime-trace
 * registry guard fails here rather than only through the service-level suites.
 *
 * Coverage targets the cold paths the service-level suites don't isolate:
 *   - promoteMemory: missing-resolver rejection; unsealed-context rejection
 *     (P0 trust gate); invalid-input rejection; the sealed happy path where
 *     authorityLevel is forced to "reviewed_memory" and reviewer/actor come from
 *     the resolver, never the caller.
 *   - searchMemory: normalize → store → role/provenance filter → annotate wiring.
 *   - getRuntimeTraceRegistry: the exact "requires autonomous execution state"
 *     throw when the status snapshot has no enabled autonomous state, and the
 *     registry summary when it does.
 *
 * getStatus is wired to a real StatusExecutionPlanner over the SAME store so the
 * enabled-gating guard that drives the registry throw is exercised end to end.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MemorySearchManager } from "../src/core/memory-search-manager.ts";
import { StatusExecutionPlanner } from "../src/core/status-execution-planner.ts";
import { TaskLifecycleManager } from "../src/core/task-lifecycle.ts";
import { AutonomousExecutionStore } from "../src/core/autonomous-execution-store.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import {
  createTrustedReviewActionContextForTest
} from "../src/core/review-context.ts";
import type { ResolveReviewActionContext } from "../src/core/review-context.ts";
import { findBlockingReasonsForTask } from "../src/core/policy.ts";
import type { ArchonStore } from "../src/store/types.ts";
import type { LockRecord, MemoryPromotionInput, RunRecord, TaskRecord } from "../src/domain/types.ts";

interface Harness {
  store: ArchonStore;
  manager: MemorySearchManager;
  lifecycle: TaskLifecycleManager;
  autonomous: AutonomousExecutionStore;
}

function makeHarness(resolver?: ResolveReviewActionContext): Harness {
  const store = new MemoryStore();
  const requireRun = async (runId: string): Promise<RunRecord> => {
    const found = await store.getRun(runId);
    if (!found) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return found;
  };
  const findTaskBlockers = async (
    task: TaskRecord,
    allTasks: readonly TaskRecord[],
    activeLocks: readonly LockRecord[]
  ): Promise<string[]> => findBlockingReasonsForTask(task, allTasks, activeLocks);
  const autonomous = new AutonomousExecutionStore({ store, requireRun });
  const lifecycle = new TaskLifecycleManager({
    store,
    requireRun,
    requireTask: async (runId, taskId) => {
      const found = await store.getTask(runId, taskId);
      if (!found) {
        throw new Error(`Unknown task ${taskId} for run ${runId}`);
      }
      return found;
    },
    findTaskBlockers,
    saveAutonomousExecutionState: (run, update) => autonomous.saveState(run, update)
  });
  const planner = new StatusExecutionPlanner({
    store,
    requireRun,
    findTaskBlockers,
    inspectRecovery: async () => {
      throw new Error("inspectRecovery not exercised in these tests");
    }
  });
  const manager = new MemorySearchManager({
    store,
    requireRun,
    getStatus: (runId) => planner.getStatus(runId),
    bumpRunState: async () => undefined,
    resolveReviewActionContext: resolver
  });

  return { store, manager, lifecycle, autonomous };
}

function trustedResolver(): ResolveReviewActionContext {
  return async () =>
    createTrustedReviewActionContextForTest({
      actor: "orchestrator-actor",
      actorRole: "reviewer"
    });
}

async function seedRun(lifecycle: TaskLifecycleManager, slug: string): Promise<RunRecord> {
  return lifecycle.intakeRequest({
    workspaceSlug: `ws-${slug}`,
    projectSlug: `proj-${slug}`,
    actor: "manager",
    title: `memory/search test run ${slug}`,
    request: "exercise the extracted memory/search manager directly"
  });
}

function basePromotion(sourceRunId: string): MemoryPromotionInput {
  return {
    scope: "project",
    entryType: "decision",
    title: "Test decision",
    content: "Authoritative decision content.",
    sourceRunId,
    sourceTaskId: "task-1",
    reviewer: "spoofed_reviewer",
    actor: "spoofed_actor"
  };
}

// ────────────────────────────────────────────────────────────────────────────
// promoteMemory — trust gate
// ────────────────────────────────────────────────────────────────────────────

test("promoteMemory: no resolver → rejects", async () => {
  const { manager, lifecycle } = makeHarness(/* no resolver */);
  const run = await seedRun(lifecycle, "noresolver");
  await assert.rejects(
    () => manager.promoteMemory(run.id, basePromotion(run.id)),
    /trusted promotion context resolver/
  );
});

test("promoteMemory: unsealed context → rejects (P0 trust gate)", async () => {
  // Resolver returns a plain object that was NOT sealed via the trusted factory.
  const unsealed: ResolveReviewActionContext = async () =>
    ({ actor: "attacker", actorRole: "reviewer" }) as never;
  const { manager, lifecycle } = makeHarness(unsealed);
  const run = await seedRun(lifecycle, "unsealed");
  await assert.rejects(
    () => manager.promoteMemory(run.id, basePromotion(run.id)),
    /sealed trusted review action context/
  );
});

test("promoteMemory: invalid input → rejects with validation errors", async () => {
  const { manager, lifecycle } = makeHarness(trustedResolver());
  const run = await seedRun(lifecycle, "invalid");
  // Empty reviewer trips the contract-layer validation (reviewer is required).
  const bad = { ...basePromotion(run.id), reviewer: "" };
  await assert.rejects(
    () => manager.promoteMemory(run.id, bad),
    /Memory promotion rejected/
  );
});

test("promoteMemory: sealed happy path derives actor/reviewer from context, forces reviewed_memory", async () => {
  const { manager, lifecycle } = makeHarness(trustedResolver());
  const run = await seedRun(lifecycle, "green");

  const entry = await manager.promoteMemory(run.id, {
    ...basePromotion(run.id),
    // Caller attempts to inject a spoofed authority level — must be stripped.
    metadata: { authorityLevel: "runtime_derived" } as never
  });

  assert.equal(entry.status, "approved");
  assert.equal(entry.reviewer, "orchestrator-actor", "reviewer from resolver, not caller");
  assert.equal(entry.actor, "orchestrator-actor", "actor from resolver, not caller");
  assert.equal(
    entry.metadata.authorityLevel,
    "reviewed_memory",
    "authorityLevel always reviewed_memory regardless of caller input"
  );
  // Confirm the entry was persisted (and is provenanced) by round-tripping it
  // through the manager's own search path.
  const found = await manager.searchMemory({
    workspaceSlug: "ws-green",
    projectSlug: "proj-green",
    query: "Authoritative decision",
    requesterRole: "reviewer"
  });
  assert.ok(found.some((r) => r.title === entry.title), "promoted entry is retrievable");
});

// ────────────────────────────────────────────────────────────────────────────
// searchMemory — normalize → filter → annotate
// ────────────────────────────────────────────────────────────────────────────

test("searchMemory: returns a promoted provenanced entry for an allowed role", async () => {
  const { manager, lifecycle } = makeHarness(trustedResolver());
  const run = await seedRun(lifecycle, "search");
  await manager.promoteMemory(run.id, {
    ...basePromotion(run.id),
    title: "Searchable decision",
    content: "unique-token-payload for the search query"
  });

  const results = await manager.searchMemory({
    workspaceSlug: "ws-search",
    projectSlug: "proj-search",
    query: "unique-token-payload",
    requesterRole: "reviewer"
  });

  assert.ok(results.length >= 1, "promoted entry is searchable");
  assert.ok(
    results.every((r) => r.citation.canonicalRef.trim().length > 0),
    "every returned result is provenanced (has a canonical ref)"
  );
});

test("searchMemory: empty query result set when nothing matches the project", async () => {
  const { manager, lifecycle } = makeHarness(trustedResolver());
  await seedRun(lifecycle, "empty");
  const results = await manager.searchMemory({
    workspaceSlug: "ws-empty",
    projectSlug: "proj-empty",
    query: "no-such-content",
    requesterRole: "reviewer"
  });
  assert.deepEqual(results, []);
});

// ────────────────────────────────────────────────────────────────────────────
// getRuntimeTraceRegistry — enabled-state guard
// ────────────────────────────────────────────────────────────────────────────

test("getRuntimeTraceRegistry: no autonomous state → throws exact message", async () => {
  const { manager, lifecycle } = makeHarness();
  const run = await seedRun(lifecycle, "noreg");
  await assert.rejects(
    () => manager.getRuntimeTraceRegistry(run.id),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "runtime trace registry requires autonomous execution state");
      return true;
    }
  );
});

test("getRuntimeTraceRegistry: enabled autonomous state → returns registry summary", async () => {
  const { manager, lifecycle, autonomous } = makeHarness();
  const run = await seedRun(lifecycle, "reg");
  await autonomous.configureAutonomousExecution(run.id, { profile: "standard_delivery" });

  const registry = await manager.getRuntimeTraceRegistry(run.id);

  assert.equal(typeof registry.totalTraces, "number");
  assert.ok(Array.isArray(registry.targets), "registry carries a targets array");
});
