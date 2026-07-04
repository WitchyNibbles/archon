/**
 * Unit tests for AutonomousExecutionStore (src/core/autonomous-execution-store.ts).
 *
 * This module was extracted from ArchonCoreService (audit F5 / service.ts split
 * slice 1). These tests exercise the store class DIRECTLY against a MemoryStore
 * double + an injected requireRun, covering the cold-spot cluster methods that
 * had no direct coverage before the split: runtime-trace capture/import, gap
 * closing, checkpointRun defaulting + workflow-doc persistence, recordProgressProof
 * epoch/phase transitions, validation error paths, and the requireRun failure path.
 *
 * The delegation from ArchonCoreService to this store stays covered by the
 * existing service-level tests (tests/autonomous-enable.test.ts and the daemon
 * suites).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { AutonomousExecutionStore } from "../src/core/autonomous-execution-store.ts";
import { ArchonCoreService } from "../src/core/service.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import type { ArchonStore } from "../src/store/types.ts";
import type { RunRecord } from "../src/domain/types.ts";

// ────────────────────────────────────────────────────────────────────────────
// Harness: a real MemoryStore double + a run seeded through intakeRequest, then
// an AutonomousExecutionStore wired to the SAME store with a requireRun that
// mirrors the private helper on ArchonCoreService (getRun + throw-on-missing).
// ────────────────────────────────────────────────────────────────────────────

async function makeStoreHarness(): Promise<{
  store: ArchonStore;
  autonomous: AutonomousExecutionStore;
  runId: string;
}> {
  const store = new MemoryStore();
  // Seed a real, valid RunRecord (avoids fabricating IntakeSummary by hand).
  const service = new ArchonCoreService(store);
  const run = await service.intakeRequest({
    workspaceSlug: "ws-store-test",
    projectSlug: "proj-store-test",
    actor: "operator",
    title: "autonomous-execution-store unit test run",
    request: "exercise the extracted store directly"
  });

  const requireRun = async (runId: string): Promise<RunRecord> => {
    const found = await store.getRun(runId);
    if (!found) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return found;
  };

  const autonomous = new AutonomousExecutionStore({ store, requireRun });
  return { store, autonomous, runId: run.id };
}

// ────────────────────────────────────────────────────────────────────────────
// requireRun failure path
// ────────────────────────────────────────────────────────────────────────────

test("AutonomousExecutionStore: unknown run rejects via injected requireRun", async () => {
  const { autonomous } = await makeStoreHarness();
  await assert.rejects(
    () => autonomous.upsertCoverageItems("run-does-not-exist", []),
    /Unknown run: run-does-not-exist/
  );
});

// ────────────────────────────────────────────────────────────────────────────
// configure + getAutonomousExecutionState round-trip
// ────────────────────────────────────────────────────────────────────────────

test("AutonomousExecutionStore.configureAutonomousExecution: enables and persists state", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  const state = await autonomous.configureAutonomousExecution(runId, {
    profile: "standard_delivery",
    phase: "risk_analysis"
  });
  assert.equal(state.enabled, true);
  assert.equal(state.phase, "risk_analysis");

  const readBack = await autonomous.getAutonomousExecutionState(runId);
  assert.equal(readBack?.enabled, true);
  assert.equal(readBack?.phase, "risk_analysis");
});

test("AutonomousExecutionStore.configureAutonomousExecution: persists a coverage_manifest workflow doc", async () => {
  const { autonomous, store, runId } = await makeStoreHarness();

  await autonomous.configureAutonomousExecution(runId, {
    manifest: {
      runId,
      profile: "standard_delivery",
      requiredCategories: ["routes"],
      thresholds: {
        criticalItemCoverage: 1,
        criticalItemValidation: 1,
        callsiteCoverage: 1,
        runtimeTraceCoverage: 1
      }
    }
  });

  const run = await store.getRun(runId);
  const docs = await store.listWorkflowDocuments({
    projectId: run!.projectId,
    kind: "coverage_manifest"
  });
  assert.equal(docs.length, 1, "one coverage_manifest doc persisted");
});

test("AutonomousExecutionStore.configureAutonomousExecution: invalid manifest throws", async () => {
  const { autonomous, runId } = await makeStoreHarness();
  await assert.rejects(
    () =>
      autonomous.configureAutonomousExecution(runId, {
        // empty requiredCategories is invalid
        manifest: {
          runId,
          profile: "standard_delivery",
          requiredCategories: [],
          thresholds: { criticalItemCoverage: 1 }
        }
      }),
    /Invalid coverage manifest/
  );
});

// ────────────────────────────────────────────────────────────────────────────
// coverage gaps — validation + merge
// ────────────────────────────────────────────────────────────────────────────

test("AutonomousExecutionStore.upsertCoverageGaps: invalid gap throws, valid gap merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertCoverageGaps(runId, [
        // empty id is invalid
        {
          id: "",
          targetId: "t1",
          kind: "missing_runtime_trace",
          severity: "high",
          description: "d",
          blocking: true,
          evidenceRefs: [],
          createdBy: "unit",
          suggestedNextActions: [],
          status: "open"
        }
      ]),
    /Invalid coverage gap/
  );

  const state = await autonomous.upsertCoverageGaps(runId, [
    {
      id: "gap-1",
      targetId: "target-1",
      kind: "missing_runtime_trace",
      severity: "high",
      description: "no runtime trace yet",
      blocking: true,
      evidenceRefs: ["gap://e1"],
      createdBy: "unit",
      suggestedNextActions: ["capture a trace"],
      status: "open"
    }
  ]);
  assert.equal(state.gaps.length, 1);
  assert.equal(state.gaps[0]?.id, "gap-1");
  assert.equal(state.gaps[0]?.status, "open");
});

// ────────────────────────────────────────────────────────────────────────────
// runtime traces — capture stamps runtime_capture, import stamps operator_import,
// a trace closes a matching open missing_runtime_trace gap and marks the coverage
// item runtimeTraced.
// ────────────────────────────────────────────────────────────────────────────

test("AutonomousExecutionStore.captureRuntimeTrace: stamps runtime_capture authority", async () => {
  const { autonomous, runId } = await makeStoreHarness();
  const state = await autonomous.captureRuntimeTrace(runId, {
    targetId: "target-1",
    kind: "route",
    risky: false,
    sideEffects: [],
    evidenceRefs: ["trace://e1"]
  });
  assert.equal(state.runtimeTraces?.length, 1);
  assert.equal(state.runtimeTraces?.[0]?.authorityLabel, "runtime_capture");
});

test("AutonomousExecutionStore.importRuntimeTrace: stamps operator_import authority", async () => {
  const { autonomous, runId } = await makeStoreHarness();
  const state = await autonomous.importRuntimeTrace(runId, {
    targetId: "target-1",
    kind: "route",
    risky: false,
    sideEffects: [],
    evidenceRefs: ["trace://e1"]
  });
  assert.equal(state.runtimeTraces?.[0]?.authorityLabel, "operator_import");
});

test("AutonomousExecutionStore.captureRuntimeTrace: closes matching gap and marks coverage item traced", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await autonomous.upsertCoverageItems(runId, [
    {
      id: "target-1",
      category: "routes",
      state: "discovered",
      criticality: "high",
      sources: ["src/route.ts"],
      evidenceRefs: ["handoff:h1"],
      lastUpdatedAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  await autonomous.upsertCoverageGaps(runId, [
    {
      id: "gap-target-1",
      targetId: "target-1",
      kind: "missing_runtime_trace",
      severity: "high",
      description: "needs a trace",
      blocking: true,
      evidenceRefs: ["gap://e1"],
      createdBy: "unit",
      suggestedNextActions: ["capture a trace"],
      status: "open"
    }
  ]);

  const state = await autonomous.captureRuntimeTrace(runId, {
    targetId: "target-1",
    kind: "route",
    risky: false,
    sideEffects: [],
    evidenceRefs: ["trace://e1"]
  });

  const gap = state.gaps.find((g) => g.id === "gap-target-1");
  assert.equal(gap?.status, "closed", "missing_runtime_trace gap closed by trace");
  const item = state.coverageItems.find((i) => i.id === "target-1");
  assert.equal(item?.runtimeTraced, true, "coverage item marked runtimeTraced");
  assert.ok(item?.evidenceRefs.includes("trace://e1"), "trace evidence merged into item");
});

// ────────────────────────────────────────────────────────────────────────────
// checkpointRun — defaulting + workflow doc persistence + lastSuccessful tracking
// ────────────────────────────────────────────────────────────────────────────

test("AutonomousExecutionStore.checkpointRun: defaults derived fields and persists checkpoint_summary doc", async () => {
  const { autonomous, store, runId } = await makeStoreHarness();

  const state = await autonomous.checkpointRun(runId, {
    checkpointId: "cp-1",
    phase: "risk_analysis",
    activeTargets: ["target-1"],
    recentEvidenceRefs: ["ev://1"],
    openGaps: ["gap-1"],
    nextActions: ["do next"],
    createdAt: "2026-07-04T00:00:00.000Z"
  });

  assert.equal(state.checkpoints.length, 1);
  const cp = state.checkpoints[0]!;
  assert.equal(cp.authorityLabel, "runtime_authoritative");
  assert.equal(cp.runId, runId);
  assert.ok(cp.compressedContextRef?.includes("cp-1"), "compressedContextRef defaulted");
  assert.ok(cp.compressedContextSummary?.includes("phase=risk_analysis"), "summary defaulted");
  assert.deepEqual(cp.compressedContextSourceRefs, ["ev://1"], "source refs default to evidence");
  assert.equal(state.lastSuccessfulCheckpointId, "cp-1");

  const run = await store.getRun(runId);
  const docs = await store.listWorkflowDocuments({
    projectId: run!.projectId,
    kind: "checkpoint_summary"
  });
  assert.equal(docs.length, 1, "one checkpoint_summary doc persisted");
});

test("AutonomousExecutionStore.checkpointRun: operator_import does not advance lastSuccessfulCheckpointId", async () => {
  const { autonomous, runId } = await makeStoreHarness();
  const state = await autonomous.checkpointRun(
    runId,
    {
      checkpointId: "cp-import",
      phase: "risk_analysis",
      activeTargets: [],
      recentEvidenceRefs: [],
      openGaps: [],
      nextActions: [],
      createdAt: "2026-07-04T00:00:00.000Z"
    },
    { authorityLabel: "operator_import" }
  );
  assert.equal(state.lastCheckpointId, "cp-import");
  assert.equal(state.lastSuccessfulCheckpointId, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// recordProgressProof — phase advance, epoch bump on phase change, doc persistence
// ────────────────────────────────────────────────────────────────────────────

test("AutonomousExecutionStore.recordProgressProof: advances phase, bumps epoch, persists doc", async () => {
  const { autonomous, store, runId } = await makeStoreHarness();

  // Baseline discovery-phase state.
  await autonomous.configureAutonomousExecution(runId, { phase: "discovery" });

  const state = await autonomous.recordProgressProof(runId, {
    cycle: 1,
    proofId: "proof-1",
    phaseBefore: "discovery",
    phaseAfter: "inventory",
    evidenceRefs: ["ev://p1"],
    coverageDelta: { validated: 1 },
    nextTarget: "target-1",
    whyNext: "inventory is the next unblocked phase",
    createdAt: "2026-07-04T00:00:00.000Z"
  });

  assert.equal(state.phase, "inventory", "phase advanced to phaseAfter");
  assert.equal(state.lastProgressProofId, "proof-1");
  assert.equal(state.executionEpoch, 2, "epoch bumped on phase change (1 -> 2)");
  assert.equal(state.progressProofs.length, 1);

  const run = await store.getRun(runId);
  const docs = await store.listWorkflowDocuments({
    projectId: run!.projectId,
    kind: "progress_proof"
  });
  assert.equal(docs.length, 1, "one progress_proof doc persisted");
});
