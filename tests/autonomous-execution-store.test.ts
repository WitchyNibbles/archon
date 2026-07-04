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
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

// ────────────────────────────────────────────────────────────────────────────
// Slice-2 carried item (2a): direct unit coverage for the store methods that
// lacked it — disableAutonomousExecution, getAutonomousExecutionState (unset
// path), upsertCoverageItems/UnderstandingMaps/RuntimeTraces and the six evidence
// ledgers, plus filesystem-backed generateRepoInventory. Each exercises the
// validate → merge → persist path DIRECTLY against the MemoryStore double, so a
// future logic drift in an unpopular ledger method fails here rather than silently.
// ────────────────────────────────────────────────────────────────────────────

test("AutonomousExecutionStore.getAutonomousExecutionState: undefined before any state is written", async () => {
  const { autonomous, runId } = await makeStoreHarness();
  const state = await autonomous.getAutonomousExecutionState(runId);
  assert.equal(state, undefined, "no autonomous state until a store method writes it");
});

test("AutonomousExecutionStore.disableAutonomousExecution: flips enabled false and persists", async () => {
  const { autonomous, runId } = await makeStoreHarness();
  await autonomous.configureAutonomousExecution(runId, { phase: "discovery" });

  const disabled = await autonomous.disableAutonomousExecution(runId);
  assert.equal(disabled.enabled, false);

  const readBack = await autonomous.getAutonomousExecutionState(runId);
  assert.equal(readBack?.enabled, false, "disabled flag persisted through the store");
});

test("AutonomousExecutionStore.disableAutonomousExecution: seeds a disabled state when none exists", async () => {
  const { autonomous, runId } = await makeStoreHarness();
  // No prior configure — disable must default a base state then flip enabled.
  const disabled = await autonomous.disableAutonomousExecution(runId);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.phase, "discovery", "defaulted base state before disabling");
});

test("AutonomousExecutionStore.upsertCoverageItems: invalid item throws, valid item merges + enables", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertCoverageItems(runId, [
        // no sources is invalid (validateCoverageItemRecord requires >=1 source)
        {
          id: "item-bad",
          category: "routes",
          state: "discovered",
          criticality: "high",
          sources: [],
          evidenceRefs: ["handoff:h1"],
          lastUpdatedAt: "2026-07-04T00:00:00.000Z"
        }
      ]),
    /Invalid coverage item/
  );

  const state = await autonomous.upsertCoverageItems(runId, [
    {
      id: "item-1",
      category: "routes",
      state: "discovered",
      criticality: "high",
      sources: ["src/route.ts"],
      evidenceRefs: ["handoff:h1"],
      lastUpdatedAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.enabled, true);
  assert.equal(state.coverageItems.length, 1);
  assert.equal(state.coverageItems[0]?.id, "item-1");
});

test("AutonomousExecutionStore.upsertUnderstandingMaps: invalid map throws, valid map merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertUnderstandingMaps(runId, [
        // missing sourceRefs/evidenceRefs is invalid
        { kind: "repo_map", itemCount: 3, sourceRefs: [], evidenceRefs: [], updatedAt: "2026-07-04T00:00:00.000Z" }
      ]),
    /Invalid understanding map/
  );

  const state = await autonomous.upsertUnderstandingMaps(runId, [
    {
      kind: "repo_map",
      itemCount: 3,
      analyzedCount: 2,
      sourceRefs: ["src/"],
      evidenceRefs: ["map://e1"],
      updatedAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.understandingMaps?.length, 1);
  assert.equal(state.understandingMaps?.[0]?.kind, "repo_map");
});

test("AutonomousExecutionStore.upsertRuntimeTraces: prepares authority default + validates, then merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  // risky trace with no sideEffects is invalid
  await assert.rejects(
    () =>
      autonomous.upsertRuntimeTraces(runId, [
        {
          traceId: "t-bad",
          targetId: "target-1",
          kind: "route",
          risky: true,
          sideEffects: [],
          evidenceRefs: ["trace://e1"],
          createdAt: "2026-07-04T00:00:00.000Z"
        }
      ]),
    /Invalid runtime trace/
  );

  // No authorityLabel supplied — prepareRuntimeTraceRecord defaults runtime_capture.
  const state = await autonomous.upsertRuntimeTraces(runId, [
    {
      traceId: "t-ok",
      targetId: "target-1",
      kind: "route",
      risky: false,
      sideEffects: [],
      evidenceRefs: ["trace://e1"],
      createdAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.runtimeTraces?.length, 1);
  assert.equal(state.runtimeTraces?.[0]?.authorityLabel, "runtime_capture", "default authority stamped");
});

test("AutonomousExecutionStore.upsertDuplicateFamilies: invalid record throws, valid record merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertDuplicateFamilies(runId, [
        // no members is invalid
        {
          familyId: "fam-1",
          capability: "auth",
          members: [],
          intentionalVariants: [],
          accidentalDivergences: [],
          parityRequirements: [],
          evidenceRefs: ["dup://e1"],
          lastUpdatedAt: "2026-07-04T00:00:00.000Z"
        }
      ]),
    /Invalid duplicate family/
  );

  const state = await autonomous.upsertDuplicateFamilies(runId, [
    {
      familyId: "fam-1",
      capability: "auth",
      members: [{ itemId: "a", kind: "shared_core" }, { itemId: "b", kind: "accidental_divergence" }],
      intentionalVariants: [],
      accidentalDivergences: ["b"],
      parityRequirements: [],
      evidenceRefs: ["dup://e1"],
      lastUpdatedAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.duplicateFamilies?.length, 1);
  assert.equal(state.duplicateFamilies?.[0]?.familyId, "fam-1");
});

test("AutonomousExecutionStore.upsertArchitectureDecisions: invalid record throws, valid record merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertArchitectureDecisions(runId, [
        // empty title is invalid
        {
          decisionId: "adr-1",
          title: "",
          status: "accepted",
          options: ["a", "b"],
          chosenOption: "a",
          boundedContexts: ["core"],
          consistencyNeeds: ["strong"],
          rationale: ["because"],
          evidenceRefs: ["adr://e1"],
          lastUpdatedAt: "2026-07-04T00:00:00.000Z"
        }
      ]),
    /Invalid architecture decision/
  );

  const state = await autonomous.upsertArchitectureDecisions(runId, [
    {
      decisionId: "adr-1",
      title: "Adopt repository pattern",
      status: "accepted",
      options: ["a", "b"],
      chosenOption: "a",
      boundedContexts: ["core"],
      consistencyNeeds: ["strong"],
      rationale: ["testability"],
      evidenceRefs: ["adr://e1"],
      lastUpdatedAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.architectureDecisions?.length, 1);
  assert.equal(state.architectureDecisions?.[0]?.decisionId, "adr-1");
});

test("AutonomousExecutionStore.upsertMigrationLedgerEntries: invalid record throws, valid record merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertMigrationLedgerEntries(runId, [
        // unsupported strategy is invalid
        {
          entryId: "mig-1",
          boundedContext: "billing",
          sourceModels: ["legacy"],
          targetModels: ["new"],
          strategy: "not_a_strategy" as never,
          consistencyClass: "strong",
          ownership: "team-a",
          rolloutSteps: ["step-1"],
          rollbackPlan: ["revert"],
          evidenceRefs: ["mig://e1"],
          lastUpdatedAt: "2026-07-04T00:00:00.000Z"
        }
      ]),
    /Invalid migration ledger entry/
  );

  const state = await autonomous.upsertMigrationLedgerEntries(runId, [
    {
      entryId: "mig-1",
      boundedContext: "billing",
      sourceModels: ["legacy"],
      targetModels: ["new"],
      strategy: "expand_contract",
      consistencyClass: "strong",
      ownership: "team-a",
      rolloutSteps: ["step-1"],
      rollbackPlan: ["revert"],
      evidenceRefs: ["mig://e1"],
      lastUpdatedAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.migrationLedger?.length, 1);
  assert.equal(state.migrationLedger?.[0]?.entryId, "mig-1");
});

test("AutonomousExecutionStore.upsertParityRequirements: invalid record throws, valid record merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertParityRequirements(runId, [
        // missing acceptanceChecks is invalid
        {
          requirementId: "par-1",
          capability: "checkout",
          status: "planned",
          legacyRefs: ["legacy://c"],
          targetRefs: ["new://c"],
          acceptanceChecks: [],
          evidenceRefs: ["par://e1"],
          lastUpdatedAt: "2026-07-04T00:00:00.000Z"
        }
      ]),
    /Invalid parity requirement/
  );

  const state = await autonomous.upsertParityRequirements(runId, [
    {
      requirementId: "par-1",
      capability: "checkout",
      status: "planned",
      legacyRefs: ["legacy://c"],
      targetRefs: ["new://c"],
      acceptanceChecks: ["totals match"],
      evidenceRefs: ["par://e1"],
      lastUpdatedAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.parityMatrix?.length, 1);
  assert.equal(state.parityMatrix?.[0]?.requirementId, "par-1");
});

test("AutonomousExecutionStore.upsertExternalEvals: invalid record throws, valid record merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertExternalEvals(runId, [
        // empty harness is invalid
        {
          evalId: "eval-1",
          label: "smoke",
          scope: "repo_local",
          harness: "",
          artifactRef: "artifact://a",
          evidenceRefs: ["eval://e1"],
          createdAt: "2026-07-04T00:00:00.000Z"
        }
      ]),
    /Invalid external eval/
  );

  const state = await autonomous.upsertExternalEvals(runId, [
    {
      evalId: "eval-1",
      label: "smoke",
      scope: "repo_local",
      harness: "node --test",
      artifactRef: "artifact://a",
      evidenceRefs: ["eval://e1"],
      createdAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.externalEvals?.length, 1);
  assert.equal(state.externalEvals?.[0]?.evalId, "eval-1");
});

test("AutonomousExecutionStore.upsertSensitiveActionControls: invalid record throws, valid record merges", async () => {
  const { autonomous, runId } = await makeStoreHarness();

  await assert.rejects(
    () =>
      autonomous.upsertSensitiveActionControls(runId, [
        // empty summary is invalid
        {
          controlId: "ctrl-1",
          actionType: "approval",
          enforcement: "authenticated_runtime",
          summary: "",
          evidenceRefs: ["ctrl://e1"],
          createdAt: "2026-07-04T00:00:00.000Z"
        }
      ]),
    /Invalid sensitive action control/
  );

  const state = await autonomous.upsertSensitiveActionControls(runId, [
    {
      controlId: "ctrl-1",
      actionType: "approval",
      enforcement: "authenticated_runtime",
      summary: "approvals must be runtime-authenticated",
      evidenceRefs: ["ctrl://e1"],
      createdAt: "2026-07-04T00:00:00.000Z"
    }
  ]);
  assert.equal(state.sensitiveActionControls?.length, 1);
  assert.equal(state.sensitiveActionControls?.[0]?.controlId, "ctrl-1");
});

test("AutonomousExecutionStore.generateRepoInventory: scans a repo root and merges coverage items", async () => {
  const { autonomous, runId } = await makeStoreHarness();
  const repoRoot = await mkdtemp(path.join(tmpdir(), "archon-repo-inventory-"));
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0" }, null, 2)
    );
    await writeFile(
      path.join(repoRoot, "src", "sample.ts"),
      "export function sample(): number {\n  return 1;\n}\n"
    );

    const state = await autonomous.generateRepoInventory(runId, {
      repoRoot,
      now: "2026-07-04T00:00:00.000Z"
    });

    assert.equal(state.enabled, true);
    assert.ok(state.coverageItems.length > 0, "repo scan produced coverage items");
    assert.ok(
      (state.understandingMaps?.length ?? 0) > 0,
      "repo scan produced understanding maps"
    );

    const readBack = await autonomous.getAutonomousExecutionState(runId);
    assert.equal(
      readBack?.coverageItems.length,
      state.coverageItems.length,
      "generated coverage items persisted through the store"
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
