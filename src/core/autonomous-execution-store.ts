// Autonomous-execution state store.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4).
// Owns the run's autonomous-execution analysis state: coverage items, gaps,
// checkpoints, progress proofs, runtime traces, and the various evidence
// ledgers. This is the LOWEST-coupling seam of ArchonCoreService — every method
// depends only on `store` + `requireRun`, never on gate/review/task-lifecycle
// private state, which is why it moves first.
//
// ArchonCoreService holds one AutonomousExecutionStore instance and delegates to
// it; the class's public API is unchanged. `saveState` is public because
// createTaskGraph (still on ArchonCoreService) seeds autonomous state through it.

import { randomUUID } from "node:crypto";
import {
  createAutonomousExecutionState,
  mergeArchitectureDecisions,
  mergeDuplicateFamilies,
  mergeExternalEvalRecords,
  mergeCoverageGaps,
  mergeCoverageItems,
  mergeMigrationLedgerEntries,
  mergeParityRequirements,
  mergeRuntimeTraces,
  mergeSensitiveActionControls,
  mergeUnderstandingMaps,
  validateArchitectureDecisionRecord,
  validateDuplicateFamilyRecord,
  validateExternalEvalRecord,
  validateCoverageGapRecord,
  validateCoverageItemRecord,
  validateCoverageManifestRecord,
  validateMigrationLedgerEntryRecord,
  validateParityRequirementRecord,
  validateProgressProofRecord,
  validateRuntimeTraceRecord,
  validateSensitiveActionControlRecord,
  validateUnderstandingMapRecord
} from "../runtime/autonomous-execution.ts";
import { generateRepoInventory } from "../runtime/repo-inventory.ts";
import {
  asProjectRuntimeMetadata,
  buildDefaultProductState,
  buildDefaultTaskQueue,
  readAutonomousExecutionState,
  timestamp,
  uniqueStrings
} from "./project-runtime-state.ts";
import type { ArchonStore } from "../store/types.ts";
import type {
  AnalysisPhase,
  ArchitectureDecisionRecord,
  AutonomousExecutionState,
  CheckpointRecord,
  CoverageGapRecord,
  CoverageItemRecord,
  CoverageManifestRecord,
  DuplicateFamilyRecord,
  ExternalEvalRecord,
  MigrationLedgerEntryRecord,
  ParityRequirementRecord,
  ProgressProofRecord,
  RuntimeTraceAuthorityLabel,
  RuntimeTraceCaptureInput,
  RuntimeTraceRecord,
  RunRecord,
  SensitiveActionControlRecord,
  UnderstandingMapRecord
} from "../domain/types.ts";

function normalizeRuntimeTraceAuthorityLabel(
  authorityLabel: RuntimeTraceAuthorityLabel | undefined
): RuntimeTraceAuthorityLabel {
  return authorityLabel ?? "runtime_capture";
}

function prepareRuntimeTraceRecord(
  trace: RuntimeTraceRecord,
  defaultAuthorityLabel: RuntimeTraceAuthorityLabel
): RuntimeTraceRecord {
  return {
    ...trace,
    authorityLabel: normalizeRuntimeTraceAuthorityLabel(trace.authorityLabel ?? defaultAuthorityLabel),
    sideEffects: uniqueStrings(trace.sideEffects),
    evidenceRefs: uniqueStrings(trace.evidenceRefs)
  };
}

function mergeTraceEvidenceIntoCoverageItems(
  items: readonly CoverageItemRecord[],
  traces: readonly RuntimeTraceRecord[]
): CoverageItemRecord[] {
  const byTarget = new Map<string, { evidenceRefs: string[]; latestCreatedAt: string }>();
  for (const trace of traces) {
    const existing = byTarget.get(trace.targetId);
    if (!existing) {
      byTarget.set(trace.targetId, {
        evidenceRefs: [...trace.evidenceRefs],
        latestCreatedAt: trace.createdAt
      });
      continue;
    }

    existing.evidenceRefs = uniqueStrings([...existing.evidenceRefs, ...trace.evidenceRefs]);
    if (existing.latestCreatedAt.localeCompare(trace.createdAt) < 0) {
      existing.latestCreatedAt = trace.createdAt;
    }
  }

  return items.map((item) => {
    const traceEvidence = byTarget.get(item.id);
    if (!traceEvidence) {
      return item;
    }

    return {
      ...item,
      runtimeTraced: true,
      evidenceRefs: uniqueStrings([...item.evidenceRefs, ...traceEvidence.evidenceRefs]),
      lastUpdatedAt:
        item.lastUpdatedAt.localeCompare(traceEvidence.latestCreatedAt) >= 0
          ? item.lastUpdatedAt
          : traceEvidence.latestCreatedAt
    };
  });
}

function closeMissingRuntimeTraceGaps(
  gaps: readonly CoverageGapRecord[],
  traces: readonly RuntimeTraceRecord[]
): CoverageGapRecord[] {
  const tracedTargetIds = new Set(traces.map((trace) => trace.targetId));
  return gaps.map((gap) =>
    gap.kind === "missing_runtime_trace" && gap.status === "open" && tracedTargetIds.has(gap.targetId)
      ? { ...gap, status: "closed" }
      : gap
  );
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function buildCompressedContextSummary(
  checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">
): string {
  const targets =
    checkpoint.activeTargets.length > 0 ? checkpoint.activeTargets.join(", ") : `checkpoint:${checkpoint.checkpointId}`;
  const gaps = checkpoint.openGaps.length > 0 ? checkpoint.openGaps.join(", ") : "none";
  return `phase=${checkpoint.phase}; targets=${targets}; open-gaps=${gaps}`;
}

export interface AutonomousExecutionStoreDeps {
  store: ArchonStore;
  requireRun: (runId: string) => Promise<RunRecord>;
}

export class AutonomousExecutionStore {
  private readonly store: ArchonStore;
  private readonly requireRun: (runId: string) => Promise<RunRecord>;

  constructor(deps: AutonomousExecutionStoreDeps) {
    this.store = deps.store;
    this.requireRun = deps.requireRun;
  }

  /**
   * @internal Public only for cross-module wiring, not part of the store's
   * caller-facing surface. `saveState` is the primitive every other method here
   * builds on, and it is also the single seam through which the extracted
   * task-lifecycle manager seeds autonomous-execution state during createTaskGraph
   * (injected as `saveAutonomousExecutionState` — see src/core/task-lifecycle.ts).
   * Its public-ness is bounded by that wiring: no runtime/admin/daemon/mcp caller
   * invokes it directly, and it must not be treated as a stable external API. If
   * the task-lifecycle seam is later inlined or reshaped, this may become private.
   */
  async saveState(
    run: RunRecord,
    update: (current: AutonomousExecutionState | undefined, now: string) => AutonomousExecutionState
  ): Promise<AutonomousExecutionState> {
    const now = timestamp();
    const existingState = await this.store.getProjectRuntimeState(run.projectId);
    const metadata = asProjectRuntimeMetadata(existingState?.metadata);
    const nextAutonomousExecution = update(readAutonomousExecutionState(metadata), now);

    await this.store.saveProjectRuntimeState({
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      activeRunId: existingState?.activeRunId ?? run.id,
      activeTaskId: existingState?.activeTaskId,
      taskQueue: existingState?.taskQueue ?? buildDefaultTaskQueue(),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: {
        ...metadata,
        autonomousExecution: {
          ...nextAutonomousExecution,
          updatedAt: now
        }
      },
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now
    });

    return {
      ...nextAutonomousExecution,
      updatedAt: now
    };
  }

  async getAutonomousExecutionState(runId: string): Promise<AutonomousExecutionState | undefined> {
    const run = await this.requireRun(runId);
    const state = await this.store.getProjectRuntimeState(run.projectId);
    return readAutonomousExecutionState(state?.metadata);
  }

  async configureAutonomousExecution(
    runId: string,
    input: {
      profile?: AutonomousExecutionState["profile"] | undefined;
      phase?: AnalysisPhase | undefined;
      manifest?: CoverageManifestRecord | undefined;
      pendingInvestigations?: string[] | undefined;
    }
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    if (input.manifest) {
      const errors = validateCoverageManifestRecord(input.manifest);
      if (errors.length > 0) {
        throw new Error(`Invalid coverage manifest: ${errors.join("; ")}`);
      }
    }
    const nextState = await this.saveState(run, (current, now) => ({
      ...(current ?? createAutonomousExecutionState({
        now,
        profile: input.profile,
        manifest: input.manifest,
        phase: input.phase
      })),
      enabled: true,
      profile: input.profile ?? current?.profile ?? "standard_delivery",
      phase: input.phase ?? current?.phase ?? "discovery",
      manifest: input.manifest ?? current?.manifest,
      pendingInvestigations: input.pendingInvestigations ?? current?.pendingInvestigations ?? [],
      coverageItems: current?.coverageItems ?? [],
      gaps: current?.gaps ?? [],
      checkpoints: current?.checkpoints ?? [],
      progressProofs: current?.progressProofs ?? [],
      understandingMaps: current?.understandingMaps ?? [],
      runtimeTraces: current?.runtimeTraces ?? [],
      duplicateFamilies: current?.duplicateFamilies ?? [],
      architectureDecisions: current?.architectureDecisions ?? [],
      migrationLedger: current?.migrationLedger ?? [],
      parityMatrix: current?.parityMatrix ?? [],
      externalEvals: current?.externalEvals ?? [],
      sensitiveActionControls: current?.sensitiveActionControls ?? [],
      executionEpoch: current?.executionEpoch ?? 1
    }));

    if (nextState.manifest) {
      await this.store.saveWorkflowDocument({
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        runId: run.id,
        kind: "coverage_manifest",
        title: `coverage manifest ${run.id}`,
        body: JSON.stringify(nextState.manifest, null, 2),
        metadata: {
          source: "runtime_autonomous_execution"
        },
        createdAt: nextState.updatedAt,
        updatedAt: nextState.updatedAt
      });
    }

    return nextState;
  }

  /**
   * Disable autonomous execution for a run without clearing any accumulated
   * analysis state (coverage items, gaps, checkpoints, etc.). The daemon will
   * return a `blocked` directive until `configureAutonomousExecution` is called
   * again to re-enable.
   */
  async disableAutonomousExecution(runId: string): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: false
      };
    });
  }

  async upsertCoverageItems(runId: string, items: CoverageItemRecord[]): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = items.flatMap((item) => validateCoverageItemRecord(item));
    if (errors.length > 0) {
      throw new Error(`Invalid coverage item: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        coverageItems: mergeCoverageItems(base.coverageItems, items)
      };
    });
  }

  async upsertUnderstandingMaps(
    runId: string,
    maps: UnderstandingMapRecord[]
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = maps.flatMap((map) => validateUnderstandingMapRecord(map));
    if (errors.length > 0) {
      throw new Error(`Invalid understanding map: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        understandingMaps: mergeUnderstandingMaps(base.understandingMaps ?? [], maps)
      };
    });
  }

  async captureRuntimeTrace(
    runId: string,
    trace: RuntimeTraceCaptureInput
  ): Promise<AutonomousExecutionState> {
    const now = timestamp();
    return this.upsertRuntimeTraces(runId, [
      {
        traceId: trace.traceId?.trim() || `trace:${randomUUID()}`,
        targetId: trace.targetId,
        kind: trace.kind,
        risky: trace.risky,
        sideEffects: [...trace.sideEffects],
        evidenceRefs: [...trace.evidenceRefs],
        createdAt: trace.createdAt ?? now,
        authorityLabel: "runtime_capture"
      }
    ]);
  }

  async importRuntimeTrace(
    runId: string,
    trace: RuntimeTraceCaptureInput
  ): Promise<AutonomousExecutionState> {
    const now = timestamp();
    return this.upsertRuntimeTraces(runId, [
      {
        traceId: trace.traceId?.trim() || `trace:${randomUUID()}`,
        targetId: trace.targetId,
        kind: trace.kind,
        risky: trace.risky,
        sideEffects: [...trace.sideEffects],
        evidenceRefs: [...trace.evidenceRefs],
        createdAt: trace.createdAt ?? now,
        authorityLabel: "operator_import"
      }
    ]);
  }

  async upsertRuntimeTraces(
    runId: string,
    traces: RuntimeTraceRecord[]
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const preparedTraces = traces.map((trace) => prepareRuntimeTraceRecord(trace, "runtime_capture"));
    const errors = preparedTraces.flatMap((trace) => validateRuntimeTraceRecord(trace));
    if (errors.length > 0) {
      throw new Error(`Invalid runtime trace: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        coverageItems: mergeTraceEvidenceIntoCoverageItems(base.coverageItems, preparedTraces),
        gaps: closeMissingRuntimeTraceGaps(base.gaps, preparedTraces),
        runtimeTraces: mergeRuntimeTraces(base.runtimeTraces ?? [], preparedTraces)
      };
    });
  }

  async upsertDuplicateFamilies(
    runId: string,
    records: DuplicateFamilyRecord[]
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = records.flatMap((record) => validateDuplicateFamilyRecord(record));
    if (errors.length > 0) {
      throw new Error(`Invalid duplicate family: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        duplicateFamilies: mergeDuplicateFamilies(base.duplicateFamilies ?? [], records)
      };
    });
  }

  async upsertArchitectureDecisions(
    runId: string,
    records: ArchitectureDecisionRecord[]
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = records.flatMap((record) => validateArchitectureDecisionRecord(record));
    if (errors.length > 0) {
      throw new Error(`Invalid architecture decision: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        architectureDecisions: mergeArchitectureDecisions(base.architectureDecisions ?? [], records)
      };
    });
  }

  async upsertMigrationLedgerEntries(
    runId: string,
    records: MigrationLedgerEntryRecord[]
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = records.flatMap((record) => validateMigrationLedgerEntryRecord(record));
    if (errors.length > 0) {
      throw new Error(`Invalid migration ledger entry: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        migrationLedger: mergeMigrationLedgerEntries(base.migrationLedger ?? [], records)
      };
    });
  }

  async upsertParityRequirements(
    runId: string,
    records: ParityRequirementRecord[]
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = records.flatMap((record) => validateParityRequirementRecord(record));
    if (errors.length > 0) {
      throw new Error(`Invalid parity requirement: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        parityMatrix: mergeParityRequirements(base.parityMatrix ?? [], records)
      };
    });
  }

  async upsertExternalEvals(
    runId: string,
    records: ExternalEvalRecord[]
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = records.flatMap((record) => validateExternalEvalRecord(record));
    if (errors.length > 0) {
      throw new Error(`Invalid external eval: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        externalEvals: mergeExternalEvalRecords(base.externalEvals ?? [], records)
      };
    });
  }

  async upsertSensitiveActionControls(
    runId: string,
    records: SensitiveActionControlRecord[]
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = records.flatMap((record) => validateSensitiveActionControlRecord(record));
    if (errors.length > 0) {
      throw new Error(`Invalid sensitive action control: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        sensitiveActionControls: mergeSensitiveActionControls(
          base.sensitiveActionControls ?? [],
          records
        )
      };
    });
  }

  async upsertCoverageGaps(runId: string, gaps: CoverageGapRecord[]): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = gaps.flatMap((gap) => validateCoverageGapRecord(gap));
    if (errors.length > 0) {
      throw new Error(`Invalid coverage gap: ${errors.join("; ")}`);
    }
    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        gaps: mergeCoverageGaps(base.gaps, gaps)
      };
    });
  }

  async recordProgressProof(
    runId: string,
    proof: ProgressProofRecord
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = validateProgressProofRecord(proof);
    if (errors.length > 0) {
      throw new Error(`Invalid progress proof: ${errors.join("; ")}`);
    }
    const nextState = await this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      const progressProofs = [...base.progressProofs, proof].sort((left, right) => left.cycle - right.cycle);
      const nextExecutionEpoch =
        base.phase !== proof.phaseAfter ? base.executionEpoch + 1 : base.executionEpoch;
      return {
        ...base,
        enabled: true,
        phase: proof.phaseAfter,
        progressProofs,
        lastProgressProofId: proof.proofId,
        executionEpoch: nextExecutionEpoch
      };
    });

    await this.store.saveWorkflowDocument({
      id: randomUUID(),
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      runId: run.id,
      kind: "progress_proof",
      title: `progress proof ${proof.proofId}`,
      body: JSON.stringify(proof, null, 2),
      metadata: {
        source: "runtime_autonomous_execution"
      },
      createdAt: proof.createdAt,
      updatedAt: nextState.updatedAt
    });

    return nextState;
  }

  async checkpointRun(
    runId: string,
    checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">,
    options: {
      authorityLabel?: CheckpointRecord["authorityLabel"] | undefined;
    } = {}
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    let fullCheckpoint: CheckpointRecord | undefined;
    const nextState = await this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      const compressedContextSourceRefs = uniqueNonEmpty(
        checkpoint.compressedContextSourceRefs ?? checkpoint.recentEvidenceRefs
      );
      const storedCheckpoint: CheckpointRecord = {
        ...checkpoint,
        authorityLabel: options.authorityLabel ?? "runtime_authoritative",
        runId,
        executionEpoch: checkpoint.executionEpoch ?? base.executionEpoch,
        compressedContextRef:
          checkpoint.compressedContextRef?.trim() ||
          `memory://checkpoint/${checkpoint.checkpointId}/compressed-context`,
        compressedContextSummary:
          checkpoint.compressedContextSummary?.trim() || buildCompressedContextSummary(checkpoint),
        compressedContextSourceRefs,
        compressedContextGeneratedAt: checkpoint.compressedContextGeneratedAt ?? checkpoint.createdAt
      };
      fullCheckpoint = storedCheckpoint;
      const checkpoints = [...base.checkpoints, storedCheckpoint].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      );
      return {
        ...base,
        enabled: true,
        phase: checkpoint.phase,
        checkpoints,
        lastCheckpointId: checkpoint.checkpointId,
        lastSuccessfulCheckpointId:
          fullCheckpoint.authorityLabel === "runtime_authoritative"
            ? checkpoint.checkpointId
            : base.lastSuccessfulCheckpointId
      };
    });

    if (!fullCheckpoint) {
      throw new Error("checkpoint persistence failed to produce a checkpoint record");
    }

    await this.store.saveWorkflowDocument({
      id: randomUUID(),
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      runId: run.id,
      kind: "checkpoint_summary",
      title: `checkpoint ${checkpoint.checkpointId}`,
      body: JSON.stringify(fullCheckpoint, null, 2),
      metadata: {
        source:
          fullCheckpoint.authorityLabel === "runtime_authoritative"
            ? "runtime_autonomous_execution"
            : "operator_checkpoint_import"
      },
      createdAt: checkpoint.createdAt,
      updatedAt: nextState.updatedAt
    });

    return nextState;
  }

  async generateRepoInventory(
    runId: string,
    input: {
      repoRoot: string;
      now?: string | undefined;
    }
  ): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const generated = await generateRepoInventory({
      repoRoot: input.repoRoot,
      now: input.now
    });

    return this.saveState(run, (current, now) => {
      const base = current ?? createAutonomousExecutionState({ now });
      return {
        ...base,
        enabled: true,
        coverageItems: mergeCoverageItems(base.coverageItems, generated.coverageItems),
        gaps: mergeCoverageGaps(base.gaps, generated.gaps),
        understandingMaps: mergeUnderstandingMaps(base.understandingMaps ?? [], generated.understandingMaps)
      };
    });
  }
}
