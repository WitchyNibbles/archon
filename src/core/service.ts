import { randomUUID } from "node:crypto";
import {
  deriveTaskQueueEvidence,
  type TaskClass,
  type TaskStatus as QueueTaskStatus,
  type TaskQueue
} from "../archon/task-queue.ts";
import {
  validateReviewAction,
  validateHandoff,
  normalizeIntakeRequest,
  normalizeRetrievalMetadata,
  normalizeSearchInput,
  validateMemoryPromotion,
  validatePlanInput,
  validateTaskPacket,
  effectiveRequiredReviewsForTask,
  isReviewFloorReduced
} from "../domain/contracts.ts";
import { requiredGateReviews } from "../domain/types.ts";
import { isOptOutClass } from "../domain/task-class.ts";
import {
  canRoleAccessSearchResult,
  collectUnsatisfiedReviewRoles,
  evaluateReviewDecision,
  findBlockingReasonsForTask,
  findTaskDependencies,
  getRoleRetrievalGuidance
} from "./policy.ts";
import {
  buildAutonomousExecutionSnapshot,
  collectAutonomousExecutionBlockers,
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
  validateUnderstandingMapRecord,
  runRequiresAutonomousExecution,
  selectAutonomousNextTarget
} from "../runtime/autonomous-execution.ts";
import { generateRepoInventory } from "../runtime/repo-inventory.ts";
import { buildRuntimeTraceRegistry } from "../runtime/runtime-trace-registry.ts";
import { annotateConflictSignals, isProvenancedSearchResult } from "./search-memory-results.ts";
import type {
  ResolveReviewActionContext,
  ReviewActionContextResolverInput
} from "./review-context.ts";
import type {
  AnalysisPhase,
  ArchitectureDecisionRecord,
  AutonomousExecutionSnapshot,
  AutonomousExecutionState,
  CheckpointRecord,
  CoverageGapRecord,
  CoverageItemRecord,
  CoverageManifestRecord,
  DuplicateFamilyRecord,
  ExternalEvalRecord,
  HandoffInput,
  IntakeRequestInput,
  LockRecord,
  MemoryPromotionInput,
  MigrationLedgerEntryRecord,
  ParityRequirementRecord,
  PlanArtifact,
  PlanInput,
  ProgressProofRecord,
  ProjectRuntimeMetadata,
  RuntimeTraceAuthorityLabel,
  RuntimeTraceCaptureInput,
  RuntimeTraceRecord,
  RuntimeTraceRegistrySummary,
  RunExecutionPlan,
  RunResumeSnapshot,
  ReviewInput,
  ReviewRecord,
  ReviewFloorReductionRecord,
  RecoveryApplyResult,
  RecoveryInspectionReport,
  RecoveryIssue,
  RecoveryAction,
  RoutingRecommendation,
  RoutingRecommendationReport,
  RunRecord,
  RunStatusSnapshot,
  SearchMemoryInput,
  SearchMemoryResult,
  SensitiveActionControlRecord,
  TaskPacketInput,
  TaskRecord,
  UnderstandingMapRecord
} from "../domain/types.ts";
import type { ArchonStore } from "../store/types.ts";
import { assessTaskPacketReasoning } from "./reasoning-quality.ts";

export interface HandoffLifecycleEvent {
  runId: string;
  taskId: string;
  actor: string;
}

export interface ArchonCoreServiceOptions {
  resolveReviewActionContext?: ResolveReviewActionContext | undefined;
  // Provenance recorded on reviews/approvals written through this service.
  // "orchestrator" (default) marks orchestrator-written records; "seed" marks
  // synthetic local proof seeds that are never trusted as completion authority.
  reviewSource?: "orchestrator" | "seed" | undefined;
  onHandoff?: ((event: HandoffLifecycleEvent) => Promise<void>) | undefined;
}

export interface ExecuteReviewRecommendationResult {
  executed: boolean;
  taskId?: string | undefined;
  actor?: string | undefined;
  reviewRole?: RoutingRecommendation["targetReviewRole"] | undefined;
  evidence: string[];
}

export interface ExecuteContinuationActionResult {
  executed: boolean;
  taskId?: string | undefined;
  evidence: string[];
}

export interface DirectiveExecutionStep {
  directiveKind: RunExecutionPlan["directive"]["kind"];
  outcome: "executed" | "unsupported" | "blocked" | "complete";
  taskId?: string | undefined;
  actor?: string | undefined;
  reviewRole?: RoutingRecommendation["targetReviewRole"] | undefined;
  nextDirectiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
  evidence: string[];
}

export interface ExecuteDirectiveStepOptions {
  staleAfterHours?: number | undefined;
  ownerActor?: string | undefined;
  maxReviewDispatchSteps?: number | undefined;
  executeReviewRecommendation?: (input: {
    runId: string;
    directive: Extract<RunExecutionPlan["directive"], { kind: "dispatch_reviews" }>;
  }) => Promise<ExecuteReviewRecommendationResult>;
  executeContinuationAction?: (input: {
    runId: string;
    directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
    action: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>["actions"][number];
  }) => Promise<ExecuteContinuationActionResult>;
}

export interface DirectiveExecutionResult {
  runId: string;
  initialPlan: RunExecutionPlan;
  steps: DirectiveExecutionStep[];
  finalPlan: RunExecutionPlan;
  snapshot: RunStatusSnapshot;
}

function timestamp(): string {
  return new Date().toISOString();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function profileHasBroadRewriteScope(profile: AutonomousExecutionState["profile"]): boolean {
  return profile === "legacy_rewrite" || profile === "modernization_program";
}

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

function deriveNativeAutonomousDirective(input: {
  autonomousExecution: AutonomousExecutionSnapshot;
  blockers: readonly string[];
  terminalTasks: boolean;
}): RunExecutionPlan["directive"] | undefined {
  const { autonomousExecution, blockers, terminalTasks } = input;
  const { state, comprehensionSummary, coverageSummary, phaseReadiness, blockingGaps } = autonomousExecution;
  const manifestThresholds = state.manifest?.thresholds;
  const leadingRationale = terminalTasks
    ? "all tasks are terminal, but autonomous execution still requires native runtime remediation"
    : "no owner-dispatch task is available, and autonomous execution still requires native runtime remediation";

  const inventoryThreshold = manifestThresholds?.inventoryCompleteness;
  const rewriteClaimPhase =
    profileHasBroadRewriteScope(state.profile) &&
    (state.phase === "modernization_strategy" || state.phase === "migration_sequencing");
  const openInventoryGaps = rewriteClaimPhase
    ? state.gaps.filter((gap) => gap.status === "open" && gap.kind === "missing_inventory")
    : [];
  const inventoryBlockers = uniqueStrings([
    ...blockers.filter(
      (blocker) =>
        /inventory completeness|understanding map missing|modernization artifact missing|inventory gap open|dynamic discovery/i.test(blocker)
    ),
    ...openInventoryGaps.map((gap) => gap.description)
  ]);
  const needsInventoryRebuild =
    ((typeof inventoryThreshold === "number" &&
      (comprehensionSummary?.inventoryCompleteness ?? 0) < inventoryThreshold) ||
      inventoryBlockers.length > 0);
  if (needsInventoryRebuild) {
    const missingUnderstandingKinds = comprehensionSummary?.missingUnderstandingKinds ?? [];
    const missingEvidence = uniqueStrings([
      ...(comprehensionSummary?.missingEvidence ?? []),
      ...missingUnderstandingKinds.map((kind) => `understanding map missing: ${kind}`)
    ]);
    return {
      kind: "rebuild_inventory",
      missingUnderstandingKinds,
      missingEvidence,
      blockers:
        inventoryBlockers.length > 0
          ? inventoryBlockers
          : missingEvidence.length > 0
            ? missingEvidence
            : ["repo inventory remains incomplete for autonomous execution"],
      nextActions: uniqueStrings([
        ...missingUnderstandingKinds.map((kind) => `rebuild understanding map: ${kind}`),
        ...openInventoryGaps.flatMap((gap) => gap.suggestedNextActions),
        ...missingEvidence,
        ...state.pendingInvestigations
      ]),
      rationale: [
        leadingRationale,
        "comprehension evidence is still below the inventory threshold required for native continuation"
      ]
    };
  }

  const traceGapBlockers = blockingGaps.filter(
    (gap) => gap.status === "open" && gap.blocking && gap.kind === "missing_runtime_trace"
  );
  const traceBlockers = uniqueStrings([
    ...blockers.filter((blocker) => /runtime trace|risky trace/i.test(blocker)),
    ...phaseReadiness.reasons.filter((reason) => /runtime trace|risky trace/i.test(reason)),
    ...traceGapBlockers.map((gap) => gap.description)
  ]);
  const traceThreshold = manifestThresholds?.runtimeTraceCoverage;
  const tracePhaseActive =
    state.phase === "runtime_tracing" || phaseReadiness.phase === "runtime_tracing";
  const needsRuntimeTrace =
    traceGapBlockers.length > 0 ||
    ((tracePhaseActive || traceBlockers.length > 0) &&
      typeof traceThreshold === "number" &&
      coverageSummary.runtimeTraceCoverage < traceThreshold) ||
    traceBlockers.length > 0;
  if (needsRuntimeTrace) {
    return {
      kind: "trace_runtime",
      targetIds: uniqueStrings(traceGapBlockers.map((gap) => gap.targetId)),
      gapIds: uniqueStrings(traceGapBlockers.map((gap) => gap.id)),
      blockers:
        traceBlockers.length > 0
          ? traceBlockers
          : ["runtime trace coverage remains below the autonomous threshold"],
      nextActions: uniqueStrings(traceGapBlockers.flatMap((gap) => gap.suggestedNextActions)),
      rationale: [
        leadingRationale,
        "risky runtime paths still require trace-backed evidence before autonomous completion"
      ]
    };
  }

  const checkpointBlockers = uniqueStrings([
    ...blockers.filter((blocker) =>
      /progress proof|checkpoint|compressed context|compaction/i.test(blocker)
    ),
    ...phaseReadiness.reasons.filter((reason) =>
      /progress proof|checkpoint|compressed context|compaction/i.test(reason)
    )
  ]);
  if (checkpointBlockers.length > 0) {
    const latestCheckpoint = state.checkpoints.at(-1);
    const latestProof = state.progressProofs.at(-1);
    return {
      kind: "checkpoint",
      checkpointId: latestCheckpoint?.checkpointId,
      progressProofId: latestProof?.proofId,
      blockers: checkpointBlockers,
      nextActions: uniqueStrings([
        ...(latestCheckpoint?.nextActions ?? []),
        ...(latestProof?.whyNext ? [latestProof.whyNext] : [])
      ]),
      rationale: [
        leadingRationale,
        "checkpoint, progress-proof, or compaction evidence is still missing for native continuation"
      ]
    };
  }

  const pendingInvestigations = uniqueStrings(state.pendingInvestigations);
  if (pendingInvestigations.length > 0) {
    return {
      kind: "dispatch_subagents",
      pendingInvestigations,
      blockers: pendingInvestigations.map((investigation) => `pending investigation: ${investigation}`),
      nextActions: uniqueStrings(
        pendingInvestigations.flatMap((investigation) => [
          investigation,
          `dispatch subagent investigation: ${investigation}`
        ])
      ),
      rationale: [
        leadingRationale,
        "bounded autonomous investigations are still queued and need native subagent dispatch planning"
      ]
    };
  }

  const migrationPhaseActive =
    state.phase === "modernization_strategy" || state.phase === "migration_sequencing";
  if (migrationPhaseActive && (phaseReadiness.status === "blocked" || blockers.length > 0)) {
    const migrationBlockers = uniqueStrings(
      blockers.length > 0 ? [...blockers] : [...phaseReadiness.reasons]
    );
    return {
      kind: "replan_migration",
      phase: state.phase,
      fallbackPhase: phaseReadiness.fallbackPhase,
      blockers:
        migrationBlockers.length > 0
          ? migrationBlockers
          : ["migration sequencing still requires a runtime-backed replanning pass"],
      nextActions: uniqueStrings([
        phaseReadiness.fallbackPhase
          ? `replan toward ${phaseReadiness.fallbackPhase}`
          : `replan ${state.phase}`,
        ...phaseReadiness.reasons
      ]),
      rationale: [
        leadingRationale,
        "migration-phase readiness has fallen back and now requires an explicit runtime-backed replanning step"
      ]
    };
  }

  return undefined;
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

function parseHoursSince(createdAt: string, now: string): number | undefined {
  const createdAtMs = Date.parse(createdAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(createdAtMs) || Number.isNaN(nowMs) || nowMs < createdAtMs) {
    return undefined;
  }

  return Number(((nowMs - createdAtMs) / (1000 * 60 * 60)).toFixed(2));
}

const LOOP_HISTORY_TAG = "runtime_loop_history";
const LOOP_HISTORY_ACTOR = "archon-runtime-loop";
const LOOP_HISTORY_QUERY_PREFIX = "runtime loop history";

function parseWorkspaceSlugFromId(workspaceId: string): string | undefined {
  return workspaceId.startsWith("workspace:") ? workspaceId.slice("workspace:".length) : undefined;
}

function parseProjectSelectorFromId(projectId: string):
  | { workspaceSlug: string; projectSlug: string }
  | undefined {
  const parts = projectId.split(":");
  if (parts.length < 3 || parts[0] !== "project") {
    return undefined;
  }

  return {
    workspaceSlug: parts[1]!,
    projectSlug: parts.slice(2).join(":")
  };
}

function buildDefaultTaskQueue(): TaskQueue {
  return {
    project_status: "idle",
    current_task_id: null,
    tasks: []
  };
}

function buildDefaultProductState(): Record<string, unknown> {
  return {
    status: "idle",
    items: []
  };
}

function asProjectRuntimeMetadata(
  metadata: ProjectRuntimeMetadata | Record<string, unknown> | undefined
): ProjectRuntimeMetadata {
  return { ...(metadata ?? {}) };
}

function readAutonomousExecutionState(
  metadata: ProjectRuntimeMetadata | Record<string, unknown> | undefined
): AutonomousExecutionState | undefined {
  const candidate = (metadata as ProjectRuntimeMetadata | undefined)?.autonomousExecution;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  return {
    ...candidate,
    understandingMaps: candidate.understandingMaps ?? [],
    runtimeTraces: candidate.runtimeTraces ?? [],
    duplicateFamilies: candidate.duplicateFamilies ?? [],
    architectureDecisions: candidate.architectureDecisions ?? [],
    migrationLedger: candidate.migrationLedger ?? [],
    parityMatrix: candidate.parityMatrix ?? [],
    externalEvals: candidate.externalEvals ?? [],
    sensitiveActionControls: candidate.sensitiveActionControls ?? []
  };
}

function mapTaskStatusToQueueStatus(status: TaskRecord["status"]): QueueTaskStatus {
  switch (status) {
    case "ready":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "approved":
    case "done":
      return "done";
    case "blocked":
    case "review_blocked":
      return "blocked";
  }
}

// Derive the class for a plan-created task from its quality gates.
//
// SECURITY (Option B condition 3): this MUST NEVER return an OPT_OUT_TASK_CLASSES
// value. Opt-out classes are review-floor-reducible, and qualityGates is a mutable,
// packet-author-controlled field — deriving an opt-out class from it would resurrect
// exactly the Option A hole the council rejected (a plan packet could omit quality
// gates to land in docs_only and become eligible for a single-reviewer close).
// Opt-out classification may ONLY be assigned explicitly via the validated
// init-task --class path, never derived here. The default is the non-opt-out
// prototype_slice; a defense-in-depth guard rejects any opt-out result outright.
function mapTaskPacketToQueueClass(packet: TaskPacketInput): TaskClass {
  const derived: TaskClass = packet.qualityGates.includes("release_readiness_required")
    ? "release_candidate"
    : "prototype_slice";
  // Invariant guard: a derived class can never be opt-out (review-floor-reducible).
  return isOptOutClass(derived) ? "prototype_slice" : derived;
}

function buildRuntimeTaskQueue(runStatus: RunRecord["status"], tasks: readonly TaskRecord[], activeTaskId?: string | undefined): TaskQueue {
  return {
    project_status: runStatus,
    current_task_id: activeTaskId ?? tasks.find((task) => task.status === "in_progress")?.packet.taskId ?? null,
    tasks: tasks.map((task) => ({
      id: task.packet.taskId,
      title: task.packet.title,
      status: mapTaskStatusToQueueStatus(task.status),
      // Read the authoritative immutable TaskRecord.class — never re-derive from
      // the mutable qualityGates here (that was the Option A pattern the council
      // rejected; re-deriving in the queue export would resurrect a spoofable
      // shadow even though gate sites use task.class).
      class: task.class,
      depends_on: [...task.packet.dependencies],
      acceptance_criteria: [...task.packet.acceptanceCriteria],
      verification: [...task.packet.verificationSteps],
      evidence: deriveTaskQueueEvidence({
        taskId: task.packet.taskId,
        verification: task.packet.verificationSteps,
        qualityGates: task.packet.qualityGates
      }),
      blocker:
        task.status === "blocked"
          ? "runtime task blocked"
          : task.status === "review_blocked"
            ? "awaiting required reviews"
            : null
    }))
  };
}

function deriveRunStatus(tasks: readonly TaskRecord[]): RunRecord["status"] {
  if (tasks.length === 0) {
    return "decomposed";
  }

  if (tasks.every((task) => task.status === "done")) {
    return "done";
  }

  if (tasks.some((task) => task.status === "in_progress")) {
    return "in_progress";
  }

  if (tasks.some((task) => task.status === "review_blocked")) {
    return "review_blocked";
  }

  if (tasks.every((task) => task.status === "approved" || task.status === "done")) {
    return "approved";
  }

  return "ready";
}

export class ArchonCoreService {
  private readonly store: ArchonStore;
  private readonly resolveReviewActionContext?: ResolveReviewActionContext | undefined;
  private readonly reviewSource: "orchestrator" | "seed";
  private readonly onHandoff?: ((event: HandoffLifecycleEvent) => Promise<void>) | undefined;

  constructor(store: ArchonStore, options: ArchonCoreServiceOptions = {}) {
    this.store = store;
    this.resolveReviewActionContext = options.resolveReviewActionContext;
    this.reviewSource = options.reviewSource ?? "orchestrator";
    this.onHandoff = options.onHandoff;
  }

  private async saveAutonomousExecutionState(
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

  private async ensureDirectiveExecutionAuthority(
    runId: string,
    directive: RunExecutionPlan["directive"]
  ): Promise<void> {
    const run = await this.requireRun(runId);
    const registration = await this.store.getProjectRuntimeRegistration(run.projectId);
    if (!registration) {
      throw new Error(
        "directive execution requires runtime registration for the target project; run doctor --repair or bootstrap-project before executing directives"
      );
    }

    const runtimeState = await this.store.getProjectRuntimeState(run.projectId);
    if (!runtimeState || runtimeState.activeRunId !== runId) {
      throw new Error(
        "directive execution requires the target run to be the active authoritative runtime run"
      );
    }

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
    const nextState = await this.saveAutonomousExecutionState(run, (current, now) => ({
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

  async upsertCoverageItems(runId: string, items: CoverageItemRecord[]): Promise<AutonomousExecutionState> {
    const run = await this.requireRun(runId);
    const errors = items.flatMap((item) => validateCoverageItemRecord(item));
    if (errors.length > 0) {
      throw new Error(`Invalid coverage item: ${errors.join("; ")}`);
    }
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    return this.saveAutonomousExecutionState(run, (current, now) => {
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
    const nextState = await this.saveAutonomousExecutionState(run, (current, now) => {
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
    const nextState = await this.saveAutonomousExecutionState(run, (current, now) => {
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

  async getRuntimeTraceRegistry(runId: string): Promise<RuntimeTraceRegistrySummary> {
    const snapshot = await this.getStatus(runId);
    const state = snapshot.autonomousExecution?.state;
    if (!state) {
      throw new Error("runtime trace registry requires autonomous execution state");
    }

    return buildRuntimeTraceRegistry(state);
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

    return this.saveAutonomousExecutionState(run, (current, now) => {
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

  async intakeRequest(input: IntakeRequestInput): Promise<RunRecord> {
    const { workspace, project } = await this.store.ensureProjectContext(input);
    const now = timestamp();
    const run: RunRecord = {
      id: randomUUID(),
      workspaceId: workspace.id,
      projectId: project.id,
      actor: input.actor,
      title: input.title.trim(),
      request: input.request.trim(),
      summary: normalizeIntakeRequest(input),
      status: "intake",
      createdAt: now,
      updatedAt: now
    };
    await this.store.createRun(run);
    const existingState = await this.store.getProjectRuntimeState(project.id);
    await this.store.saveProjectRuntimeState({
      projectId: project.id,
      workspaceId: workspace.id,
      activeRunId: run.id,
      activeTaskId: existingState?.activeTaskId,
      taskQueue: existingState?.taskQueue ?? buildDefaultTaskQueue(),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now
    });
    return run;
  }

  async createPlan(plan: PlanInput): Promise<PlanArtifact> {
    const run = await this.requireRun(plan.runId);
    const validationErrors = validatePlanInput(plan);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid plan: ${validationErrors.join("; ")}`);
    }

    const now = timestamp();
    const artifact: PlanArtifact = {
      id: randomUUID(),
      runId: run.id,
      kind: "plan",
      title: plan.title,
      content: plan,
      createdAt: now
    };

    await this.store.savePlan(artifact);
    await this.store.saveWorkflowDocument({
      id: randomUUID(),
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      runId: run.id,
      kind: "plan",
      title: artifact.title,
      body: JSON.stringify(plan, null, 2),
      metadata: {
        source: "runtime_plan"
      },
      createdAt: now,
      updatedAt: now
    });
    await this.store.updateRun({
      ...run,
      status: "planned",
      updatedAt: now
    });
    return artifact;
  }

  async createTaskGraph(runId: string, taskPackets: TaskPacketInput[]): Promise<TaskRecord[]> {
    const run = await this.requireRun(runId);
    const knownTaskIds = new Set(taskPackets.map((packet) => packet.taskId));
    const validationErrors = taskPackets.flatMap((packet) =>
      validateTaskPacket(packet).map((error) => `${packet.taskId}: ${error}`)
    );

    for (const packet of taskPackets) {
      for (const dependency of packet.dependencies) {
        if (!knownTaskIds.has(dependency)) {
          validationErrors.push(`${packet.taskId}: unknown dependency ${dependency}`);
        }
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`Invalid task graph: ${validationErrors.join("; ")}`);
    }

    const now = timestamp();
    const tasks: TaskRecord[] = taskPackets.map((packet) => ({
      id: randomUUID(),
      runId,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      class: mapTaskPacketToQueueClass(packet),
      packet,
      status: "ready",
      createdAt: now,
      updatedAt: now
    }));

    await this.store.replaceTasks(tasks);
    for (const task of tasks) {
      await this.store.saveWorkflowDocument({
        id: randomUUID(),
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        runId: task.runId,
        taskId: task.packet.taskId,
        kind: "task_packet",
        title: task.packet.title,
        body: JSON.stringify(task.packet, null, 2),
        metadata: {
          source: "runtime_task_graph"
        },
        createdAt: now,
        updatedAt: now
      });
    }
    await this.store.updateRun({
      ...run,
      status: "decomposed",
      updatedAt: now
    });
    const existingState = await this.store.getProjectRuntimeState(run.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      activeRunId: run.id,
      activeTaskId: existingState?.activeTaskId,
      taskQueue: buildRuntimeTaskQueue("decomposed", tasks, existingState?.activeTaskId),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now
    });

    if (runRequiresAutonomousExecution(tasks)) {
      await this.saveAutonomousExecutionState(run, (current, currentNow) =>
        current ??
        createAutonomousExecutionState({
          now: currentNow
        })
      );
    }

    return tasks;
  }

  async claimTask(runId: string, taskId: string, actor: string): Promise<TaskRecord> {
    const task = await this.requireTask(runId, taskId);
    if (task.status !== "ready") {
      throw new Error(`Task ${taskId} must be ready before it can be claimed`);
    }

    const allTasks = await this.store.getTasksByRun(runId);
    const activeLocks = await this.store.getActiveLocks(task.projectId);
    const blockers = await this.findTaskBlockers(task, allTasks, activeLocks);

    if (blockers.length > 0) {
      throw new Error(`Task cannot be claimed: ${blockers.join("; ")}`);
    }

    const claimedTask: TaskRecord = {
      ...task,
      status: "in_progress",
      claimedBy: actor,
      updatedAt: timestamp()
    };

    await this.store.updateTask(claimedTask);
    await this.store.createLock({
      id: randomUUID(),
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      runId,
      taskId,
      scopePaths: [...task.packet.allowedWriteScope],
      status: "active",
      createdAt: timestamp()
    });
    await this.bumpRunState(runId, "in_progress");
    const existingState = await this.store.getProjectRuntimeState(task.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      activeRunId: runId,
      activeTaskId: taskId,
      taskQueue: buildRuntimeTaskQueue("in_progress", allTasks.map((candidate) =>
        candidate.packet.taskId === taskId ? claimedTask : candidate
      ), taskId),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? timestamp(),
      updatedAt: timestamp()
    });
    return claimedTask;
  }

  async submitHandoff(runId: string, taskId: string, handoff: HandoffInput) {
    const task = await this.requireTask(runId, taskId);
    if (task.status !== "in_progress") {
      throw new Error(`Task ${taskId} must be in progress before handoff`);
    }

    const validationErrors = validateHandoff(handoff);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid handoff: ${validationErrors.join("; ")}`);
    }

    if (handoff.ownerRole !== task.packet.ownerRole) {
      throw new Error(`Invalid handoff: ownerRole must match task ownerRole ${task.packet.ownerRole}`);
    }

    if (handoff.completionStandard !== task.packet.completionStandard) {
      throw new Error(
        `Invalid handoff: completionStandard must match task completionStandard ${task.packet.completionStandard}`
      );
    }

    const record = {
      id: randomUUID(),
      runId,
      taskId,
      actor: handoff.actor,
      ownerRole: handoff.ownerRole,
      completionStandard: handoff.completionStandard,
      summary: handoff.summary,
      changedFiles: [...handoff.changedFiles],
      blockers: [...handoff.blockers],
      verificationNotes: [...handoff.verificationNotes],
      executionEvidence: [...handoff.executionEvidence],
      qualityGateEvidence: [...handoff.qualityGateEvidence],
      contextRefs: [...handoff.contextRefs],
      createdAt: timestamp()
    };

    await this.store.saveHandoff(record);
    await this.store.updateTask({
      ...task,
      status: "review_blocked",
      updatedAt: timestamp()
    });
    await this.bumpRunState(runId, "review_blocked");
    const allTasks = await this.store.getTasksByRun(runId);
    const reviewBlockedTasks = allTasks.map((candidate) =>
      candidate.packet.taskId === taskId
        ? {
            ...candidate,
            status: "review_blocked" as const,
            updatedAt: record.createdAt
          }
        : candidate
    );
    const existingState = await this.store.getProjectRuntimeState(task.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      activeRunId: runId,
      activeTaskId: taskId,
      taskQueue: buildRuntimeTaskQueue("review_blocked", reviewBlockedTasks, taskId),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? record.createdAt,
      updatedAt: record.createdAt
    });

    if (this.onHandoff) {
      await this.onHandoff({ runId, taskId, actor: handoff.actor }).catch(() => {
        // ingestion errors must never block handoff completion
      });
    }

    return record;
  }

  async recordReview(runId: string, taskId: string, actor: string, review: ReviewInput) {
    if (!this.resolveReviewActionContext) {
      throw new Error("recordReview requires a trusted review action context resolver");
    }

    const task = await this.requireTask(runId, taskId);
    if (task.status !== "review_blocked") {
      throw new Error(`Task ${taskId} must be review_blocked before reviews can be recorded`);
    }

    let context;
    try {
      context = await this.resolveReviewActionContext({
        runId,
        taskId,
        actor,
        reviewerRole: review.reviewerRole,
        reviewState: review.state
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid review action: ${message}`);
    }

    const validationErrors = validateReviewAction(context, review);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid review action: ${validationErrors.join("; ")}`);
    }

    const reviewRecord: ReviewRecord = {
      id: randomUUID(),
      runId,
      taskId,
      reviewerRole: review.reviewerRole,
      actor: context.actor,
      actorRole: context.actorRole,
      source: this.reviewSource,
      state: review.state,
      severity: review.severity,
      findings: [...review.findings],
      waiverReason: review.waiverReason,
      evidenceRefs: [...(review.evidenceRefs ?? [])],
      createdAt: timestamp()
    };

    await this.store.saveReview(reviewRecord);
    const reviews = await this.store.getReviews(runId, taskId);
    const decision = evaluateReviewDecision(task, reviews);

    await this.store.saveApproval({
      id: randomUUID(),
      runId,
      taskId,
      actor: context.actor,
      actorRole: context.actorRole,
      source: this.reviewSource,
      decision: decision.decision,
      rationale:
        decision.blockers.length > 0 ? decision.blockers.join("; ") : "All required reviews passed",
      createdAt: timestamp()
    });

    const nextStatus = decision.decision === "approved" ? "approved" : "review_blocked";
    const updatedTask: TaskRecord = {
      ...task,
      status: nextStatus,
      updatedAt: timestamp()
    };

    if (nextStatus === "approved") {
      // Condition 5: a task may never be approved under a reduced review floor
      // without a durable provenance row. Use the same shared predicate the gate
      // decision used so the floor decision and its audit record cannot drift.
      if (isReviewFloorReduced(task)) {
        const effectiveFloor = effectiveRequiredReviewsForTask(task);
        const droppedRoles = requiredGateReviews.filter((role) => !effectiveFloor.includes(role));
        await this.store.saveReviewFloorReduction({
          id: randomUUID(),
          runId,
          taskId,
          derivedClass: task.class,
          droppedRoles: [...droppedRoles],
          effectiveFloor: [...effectiveFloor],
          writeScopeSnapshot: [...task.packet.allowedWriteScope],
          basis: "opt_out_class+scope_review_safe",
          source: "runtime",
          decidedAt: updatedTask.updatedAt
        } satisfies ReviewFloorReductionRecord);
      }
      await this.store.releaseLocksForTask(runId, taskId, timestamp());
    }

    await this.store.updateTask(updatedTask);
    await this.bumpRunState(runId, nextStatus);
    const allTasks = await this.store.getTasksByRun(runId);
    const syncedTasks = allTasks.map((candidate) =>
      candidate.packet.taskId === taskId ? updatedTask : candidate
    );
    const existingState = await this.store.getProjectRuntimeState(task.projectId);
    const activeTaskId = syncedTasks.find((candidate) => candidate.status === "in_progress")?.packet.taskId;
    await this.store.saveProjectRuntimeState({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      activeRunId: runId,
      activeTaskId,
      taskQueue: buildRuntimeTaskQueue(deriveRunStatus(syncedTasks), syncedTasks, activeTaskId),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: nextStatus === "approved" ? runId : existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? timestamp(),
      updatedAt: timestamp()
    });
    await this.store.saveWorkflowDocument({
      id: randomUUID(),
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      runId,
      taskId,
      kind: "review_summary",
      title: `Review summary: ${taskId}`,
      body: JSON.stringify(
        {
          review: reviewRecord,
          blockers: decision.blockers,
          status: nextStatus
        },
        null,
        2
      ),
      metadata: {
        source: "runtime_review",
        evidenceRefs: reviewRecord.evidenceRefs ?? []
      },
      createdAt: reviewRecord.createdAt,
      updatedAt: reviewRecord.createdAt
    });
    return {
      review: reviewRecord,
      blockers: decision.blockers,
      task: updatedTask
    };
  }

  async failTask(runId: string, taskId: string, reason: string) {
    const task = await this.requireTask(runId, taskId);
    const failedAt = timestamp();
    const updatedTask: TaskRecord = {
      ...task,
      status: "blocked",
      claimedBy: undefined,
      updatedAt: failedAt
    };

    await this.store.releaseLocksForTask(runId, taskId, failedAt);
    await this.store.updateTask(updatedTask);

    const allTasks = await this.store.getTasksByRun(runId);
    const syncedTasks = allTasks.map((candidate) =>
      candidate.packet.taskId === taskId ? updatedTask : candidate
    );
    const nextRunStatus = deriveRunStatus(syncedTasks);
    const run = await this.requireRun(runId);
    await this.store.updateRun({
      ...run,
      status: nextRunStatus,
      updatedAt: failedAt
    });

    const existingState = await this.store.getProjectRuntimeState(task.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      activeRunId: runId,
      activeTaskId: undefined,
      taskQueue: buildRuntimeTaskQueue(nextRunStatus, syncedTasks),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: {
        ...(existingState?.metadata ?? {}),
        seedFailure: {
          runId,
          taskId,
          reason,
          failedAt,
          recoveryState: "requires_reproof"
        }
      },
      createdAt: existingState?.createdAt ?? failedAt,
      updatedAt: failedAt
    });
  }

  async promoteMemory(runId: string, input: MemoryPromotionInput) {
    const run = await this.requireRun(runId);
    const errors = validateMemoryPromotion(input);
    if (errors.length > 0) {
      throw new Error(`Memory promotion rejected: ${errors.join("; ")}`);
    }

    const createdAt = timestamp();
    const metadata = normalizeRetrievalMetadata({
      ...input.metadata,
      reviewedAt: input.metadata?.reviewedAt ?? createdAt,
      authorityLevel: input.metadata?.authorityLevel ?? "reviewed_memory"
    });

    const entry = {
      id: randomUUID(),
      workspaceId: run.workspaceId,
      projectId: input.scope === "project" ? run.projectId : undefined,
      runId,
      taskId: input.sourceTaskId,
      scope: input.scope,
      entryType: input.entryType,
      title: input.title,
      content: input.content,
      reviewer: input.reviewer,
      actor: input.actor,
      status: "approved" as const,
      metadata,
      createdAt
    };

    await this.store.saveMemoryEntry(entry);
    await this.bumpRunState(runId, "memorized");
    return entry;
  }

  async searchMemory(input: SearchMemoryInput): Promise<SearchMemoryResult[]> {
    const normalized = normalizeSearchInput(input);
    const results = await this.store.searchMemory({
      workspaceSlug: normalized.workspaceSlug,
      projectSlug: normalized.projectSlug,
      query: normalized.query,
      limit: normalized.limit,
      includeGlobal: normalized.includeGlobal,
      queryEmbedding: normalized.queryEmbedding,
      embeddingModel: normalized.embeddingModel,
      requesterRole: normalized.requesterRole
    });

    return annotateConflictSignals(
      results
        .filter((result) => canRoleAccessSearchResult(result, normalized.requesterRole))
        .filter(isProvenancedSearchResult)
    );
  }

  async getStatus(runId: string): Promise<RunStatusSnapshot> {
    const run = await this.requireRun(runId);
    const plan = await this.store.getPlan(runId);
    const tasks = await this.store.getTasksByRun(runId);
    const activeLocks = await this.store.getActiveLocks(run.projectId);
    const runtimeState = await this.store.getProjectRuntimeState(run.projectId);
    const autonomousExecutionState = readAutonomousExecutionState(runtimeState?.metadata);
    const blockerEntries = await Promise.all(
      tasks.map(async (task) => ({
        taskId: task.packet.taskId,
        blockers: await this.findTaskBlockers(task, tasks, activeLocks)
      }))
    );
    const blockers = blockerEntries.flatMap((entry) => entry.blockers);
    const blockerMap = new Map(blockerEntries.map((entry) => [entry.taskId, entry.blockers]));
    const nextTaskIds = tasks
      .filter((task) => (blockerMap.get(task.packet.taskId) ?? []).length === 0)
      .filter((task) => task.status === "ready")
      .map((task) => task.packet.taskId);

    return {
      run,
      plan,
      tasks,
      activeLocks,
      blockers,
      nextTaskIds,
      autonomousExecution:
        autonomousExecutionState && autonomousExecutionState.enabled
          ? buildAutonomousExecutionSnapshot(autonomousExecutionState)
          : undefined
    };
  }

  async getExecutionPlan(
    runId: string,
    options: {
      staleAfterHours?: number | undefined;
    } = {}
  ): Promise<RunExecutionPlan> {
    const snapshot = await this.getStatus(runId);
    const routing = await this.recommendRouting(runId);
    const recovery = await this.inspectRecovery(runId, {
      staleAfterHours: options.staleAfterHours
    });
    const autonomousExecution = snapshot.autonomousExecution;
    const autonomousExecutionBlockers = autonomousExecution
      ? collectAutonomousExecutionBlockers(autonomousExecution.state, snapshot.tasks)
      : [];
    const autonomousNextTarget = autonomousExecution
      ? selectAutonomousNextTarget(autonomousExecution.state)
      : undefined;
    const allTasksTerminal =
      snapshot.tasks.length > 0 && snapshot.tasks.every((task) => task.status === "approved" || task.status === "done");
    const nativeAutonomousDirective =
      autonomousExecution &&
      !autonomousNextTarget &&
      (autonomousExecutionBlockers.length > 0 ||
        autonomousExecution.state.pendingInvestigations.length > 0 ||
        autonomousExecution.state.phase === "modernization_strategy" ||
        autonomousExecution.state.phase === "migration_sequencing")
        ? deriveNativeAutonomousDirective({
            autonomousExecution,
            blockers: autonomousExecutionBlockers,
            terminalTasks: allTasksTerminal
          })
        : undefined;

    const safeRecoveryActions = recovery.actions.filter((action) => action.safeToApply);
    if (safeRecoveryActions.length > 0) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "apply_recovery",
          actions: safeRecoveryActions,
          rationale: [
            "runtime recovery surfaced safe corrective actions before further routing",
            ...safeRecoveryActions.map((action) => `${action.kind}: ${action.rationale.join("; ")}`)
          ]
        }
      };
    }

    const reviewRecommendations = routing.recommendations.filter(
      (recommendation) => recommendation.recommendation === "review_dispatch"
    );
    if (reviewRecommendations.length > 0) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "dispatch_reviews",
          recommendations: reviewRecommendations,
          rationale: [
            "one or more tasks are blocked on required authenticated reviews",
            ...reviewRecommendations.map(
              (recommendation) =>
                `${recommendation.taskId}: ${recommendation.rationale.join("; ")}`
            )
          ]
        }
      };
    }

    const ownerRecommendation = routing.recommendations.find(
      (recommendation) => recommendation.recommendation === "owner_dispatch"
    );
    if (ownerRecommendation) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "dispatch_owner",
          recommendation: ownerRecommendation,
          rationale: [
            "a ready task with satisfied dependencies is available for execution",
            ...ownerRecommendation.rationale
          ]
        }
      };
    }

    if (allTasksTerminal) {
      const reasoningAssessments = snapshot.tasks.map((task) => ({
        taskId: task.packet.taskId,
        assessment: assessTaskPacketReasoning(task.packet)
      }));
      const reasoningBlockers = reasoningAssessments.flatMap(({ taskId, assessment }) =>
        assessment.blockers.map((warning) => `${taskId}: ${warning.message}`)
      );
      if (reasoningBlockers.length > 0) {
        return {
          mode: "runtime_authoritative",
          runId,
          runStatus: snapshot.run.status,
          autonomousExecution,
          directive: {
            kind: "blocked",
            blockers: reasoningBlockers,
            rationale: [
              "all tasks are terminal, but strict reasoning blockers still prevent final completion",
              ...reasoningBlockers.map((warning) => `reasoning-quality: ${warning}`)
            ]
          }
        };
      }

      const reasoningWarnings = reasoningAssessments.flatMap(({ taskId, assessment }) =>
        assessment.warnings.map((warning) => `${taskId}: ${warning.message}`)
      );
      if (nativeAutonomousDirective) {
        return {
          mode: "runtime_authoritative",
          runId,
          runStatus: snapshot.run.status,
          autonomousExecution,
          directive: nativeAutonomousDirective
        };
      }
      if (autonomousExecutionBlockers.length > 0 && autonomousNextTarget) {
        return {
          mode: "runtime_authoritative",
          runId,
          runStatus: snapshot.run.status,
          autonomousExecution,
          directive: {
            kind: "continue_analysis",
            targetId: autonomousNextTarget.targetId,
            source: autonomousNextTarget.source,
            actions: autonomousNextTarget.actions,
            nextActions: autonomousNextTarget.nextActions,
            blockers: autonomousExecutionBlockers,
            rationale: [
              "all tasks are terminal, but autonomous continuation still has an actionable next target",
              ...autonomousExecutionBlockers.map((blocker) => `autonomous-execution: ${blocker}`),
              ...autonomousNextTarget.rationale
            ]
          }
        };
      }

      if (autonomousExecutionBlockers.length > 0) {
        return {
          mode: "runtime_authoritative",
          runId,
          runStatus: snapshot.run.status,
          autonomousExecution,
          directive: {
            kind: "blocked",
            blockers: autonomousExecutionBlockers,
            rationale: [
              "all tasks are terminal, but autonomous execution requirements still block completion",
              ...autonomousExecutionBlockers.map((blocker) => `autonomous-execution: ${blocker}`)
            ]
          }
        };
      }

      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "complete",
          rationale: [
            "all tasks have reached terminal approved or done states",
            ...(reasoningWarnings.length > 0
              ? [
                  "reasoning-quality: derived warnings remain advisory-only",
                  ...reasoningWarnings.map(
                    (warning) => `reasoning-quality: ${warning}`
                  )
                ]
              : [])
          ]
        }
      };
    }

    if (
      nativeAutonomousDirective &&
      snapshot.tasks.every((task) => task.status !== "in_progress")
    ) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: nativeAutonomousDirective
      };
    }

    if (
      autonomousNextTarget &&
      snapshot.tasks.every((task) => task.status !== "in_progress")
    ) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "continue_analysis",
          targetId: autonomousNextTarget.targetId,
          source: autonomousNextTarget.source,
          actions: autonomousNextTarget.actions,
          nextActions: autonomousNextTarget.nextActions,
          blockers: autonomousExecutionBlockers,
          rationale: [
            "no ready task is available, but autonomous continuation can still advance from persisted runtime evidence",
            ...autonomousNextTarget.rationale
          ]
        }
      };
    }

    const blockers = this.collectExecutionBlockers(snapshot, routing, recovery);
    return {
      mode: "runtime_authoritative",
      runId,
      runStatus: snapshot.run.status,
      autonomousExecution,
      directive: {
        kind: "blocked",
        blockers,
        rationale: [
          blockers.length > 0
            ? "runtime state has no executable next step"
            : "run has no executable next step and no task graph progress can be derived"
        ]
      }
    };
  }

  async resumeRun(runId: string): Promise<RunResumeSnapshot> {
    const snapshot = await this.getStatus(runId);
    const executionPlan = await this.getExecutionPlan(runId);
    return {
      ...snapshot,
      executionPlan
    };
  }

  async executeDirectiveStep(
    runId: string,
    options: ExecuteDirectiveStepOptions = {}
  ): Promise<DirectiveExecutionResult> {
    const staleAfterHours = options.staleAfterHours;
    const initialPlan = await this.getExecutionPlan(runId, { staleAfterHours });
    await this.ensureDirectiveExecutionAuthority(runId, initialPlan.directive);
    const steps: DirectiveExecutionStep[] = [];
    let finalPlan = initialPlan;

    if (initialPlan.directive.kind === "dispatch_owner") {
      const recommendation = initialPlan.directive.recommendation;
      const actor = options.ownerActor?.trim() || recommendation.targetRole;
      if (!actor) {
        steps.push({
          directiveKind: "dispatch_owner",
          outcome: "unsupported",
          taskId: recommendation.taskId,
          nextDirectiveKind: finalPlan.directive.kind,
          evidence: [
            "owner dispatch did not execute because no owner actor was supplied",
            "runtime state was left unchanged"
          ]
        });
      } else {
        await this.claimTask(runId, recommendation.taskId, actor);
        finalPlan = await this.getExecutionPlan(runId, { staleAfterHours });
        steps.push({
          directiveKind: "dispatch_owner",
          outcome: "executed",
          taskId: recommendation.taskId,
          actor,
          nextDirectiveKind: finalPlan.directive.kind,
          evidence: [
            `claimed ${recommendation.taskId} as ${actor}`,
            `re-evaluated runtime plan and reached ${finalPlan.directive.kind}`
          ]
        });
      }
    } else if (initialPlan.directive.kind === "dispatch_reviews") {
      const executeReviewRecommendation = options.executeReviewRecommendation;
      if (!executeReviewRecommendation) {
        steps.push({
          directiveKind: "dispatch_reviews",
          outcome: "unsupported",
          taskId: initialPlan.directive.recommendations[0]?.taskId,
          reviewRole: initialPlan.directive.recommendations[0]?.targetReviewRole,
          nextDirectiveKind: finalPlan.directive.kind,
          evidence: [
            "no supported authenticated review executor was supplied",
            "review dispatch failed closed without fabricating progress"
          ]
        });
      } else {
        const maxReviewDispatchSteps = Math.max(
          1,
          options.maxReviewDispatchSteps ?? initialPlan.directive.recommendations.length
        );

        for (let index = 0; index < maxReviewDispatchSteps; index += 1) {
          if (finalPlan.directive.kind !== "dispatch_reviews") {
            break;
          }

          const result = await executeReviewRecommendation({
            runId,
            directive: finalPlan.directive
          });
          if (!result.executed) {
            steps.push({
              directiveKind: "dispatch_reviews",
              outcome: "unsupported",
              taskId: result.taskId ?? finalPlan.directive.recommendations[0]?.taskId,
              actor: result.actor,
              reviewRole: result.reviewRole ?? finalPlan.directive.recommendations[0]?.targetReviewRole,
              nextDirectiveKind: finalPlan.directive.kind,
              evidence:
                result.evidence.length > 0
                  ? [...result.evidence]
                  : ["review dispatch executor declined to apply the next authenticated review"]
            });
            break;
          }

          finalPlan = await this.getExecutionPlan(runId, { staleAfterHours });
          steps.push({
            directiveKind: "dispatch_reviews",
            outcome: "executed",
            taskId: result.taskId,
            actor: result.actor,
            reviewRole: result.reviewRole,
            nextDirectiveKind: finalPlan.directive.kind,
            evidence: [
              ...result.evidence,
              `re-evaluated runtime plan and reached ${finalPlan.directive.kind}`
            ]
          });
        }
      }
    } else if (initialPlan.directive.kind === "complete") {
      steps.push({
        directiveKind: "complete",
        outcome: "complete",
        nextDirectiveKind: finalPlan.directive.kind,
        evidence: ["all tasks are already terminal; no further directive execution was needed"]
      });
    } else if (initialPlan.directive.kind === "blocked") {
      steps.push({
        directiveKind: "blocked",
        outcome: "blocked",
        nextDirectiveKind: finalPlan.directive.kind,
        evidence:
          initialPlan.directive.blockers.length > 0
            ? [...initialPlan.directive.blockers]
            : ["run has no executable next step"]
      });
    } else if (initialPlan.directive.kind === "continue_analysis") {
      const executeContinuationAction = options.executeContinuationAction;
      const nextAction = initialPlan.directive.actions[0];
      if (!executeContinuationAction || !nextAction) {
        steps.push({
          directiveKind: "continue_analysis",
          outcome: "unsupported",
          nextDirectiveKind: finalPlan.directive.kind,
          evidence: [
            `next target remains ${initialPlan.directive.targetId}`,
            ...initialPlan.directive.actions.map((action) => `action:${action.kind}`),
            ...initialPlan.directive.nextActions
          ]
        });
      } else {
        const result = await executeContinuationAction({
          runId,
          directive: initialPlan.directive,
          action: nextAction
        });
        if (!result.executed) {
          steps.push({
            directiveKind: "continue_analysis",
            outcome: "unsupported",
            taskId: result.taskId ?? initialPlan.directive.targetId,
            nextDirectiveKind: finalPlan.directive.kind,
            evidence:
              result.evidence.length > 0
                ? [...result.evidence]
                : ["continuation executor declined to apply the next typed autonomous action"]
          });
        } else {
          finalPlan = await this.getExecutionPlan(runId, { staleAfterHours });
          steps.push({
            directiveKind: "continue_analysis",
            outcome: "executed",
            taskId: result.taskId ?? initialPlan.directive.targetId,
            nextDirectiveKind: finalPlan.directive.kind,
            evidence: [
              ...result.evidence,
              `re-evaluated runtime plan and reached ${finalPlan.directive.kind}`
            ]
          });
        }
      }
    } else if (initialPlan.directive.kind === "apply_recovery") {
      steps.push({
        directiveKind: "apply_recovery",
        outcome: "blocked",
        nextDirectiveKind: finalPlan.directive.kind,
        evidence: [
          "safe recovery must be applied explicitly before directive execution can continue"
        ]
      });
    } else if (
      initialPlan.directive.kind === "dispatch_subagents" ||
      initialPlan.directive.kind === "rebuild_inventory" ||
      initialPlan.directive.kind === "trace_runtime" ||
      initialPlan.directive.kind === "checkpoint" ||
      initialPlan.directive.kind === "replan_migration"
    ) {
      steps.push({
        directiveKind: initialPlan.directive.kind,
        outcome: "blocked",
        nextDirectiveKind: finalPlan.directive.kind,
        evidence: [
          ...initialPlan.directive.blockers,
          ...(initialPlan.directive.nextActions.length > 0
            ? initialPlan.directive.nextActions.map((action) => `next:${action}`)
            : ["native autonomous remediation requires explicit operator or worker execution"])
        ]
      });
    }

    if (steps.length > 0) {
      await this.persistLoopExecutionHistory(runId, steps);
    }

    const snapshot = await this.getStatus(runId);
    return {
      runId,
      initialPlan,
      steps,
      finalPlan,
      snapshot
    };
  }

  async getLoopExecutionHistory(
    runId: string,
    options: {
      limit?: number | undefined;
      requesterRole?: TaskPacketInput["requiredSpecialistRoles"][number] | undefined;
    } = {}
  ): Promise<SearchMemoryResult[]> {
    const run = await this.requireRun(runId);
    const workspaceSlug = parseWorkspaceSlugFromId(run.workspaceId);
    const projectSelector = parseProjectSelectorFromId(run.projectId);

    if (!workspaceSlug || !projectSelector || projectSelector.workspaceSlug !== workspaceSlug) {
      return [];
    }

    const results = await this.store.searchMemory({
      workspaceSlug,
      projectSlug: projectSelector.projectSlug,
      query: `${LOOP_HISTORY_QUERY_PREFIX} ${runId}`,
      limit: Math.max(1, options.limit ?? 10),
      includeGlobal: false,
      requesterRole: options.requesterRole ?? "planner"
    });

    return annotateConflictSignals(
      results
        .filter((result) => canRoleAccessSearchResult(result, options.requesterRole ?? "planner"))
        .filter(isProvenancedSearchResult)
        .filter(
          (result) =>
            result.provenance.runId === runId && result.metadata.tags.includes(LOOP_HISTORY_TAG)
        )
        .sort((left, right) => right.provenance.createdAt.localeCompare(left.provenance.createdAt))
    );
  }

  async recommendRouting(runId: string): Promise<RoutingRecommendationReport> {
    const snapshot = await this.getStatus(runId);
    const blockerMap = new Map<string, string[]>();
    const recommendations: RoutingRecommendation[] = [];

    for (const task of snapshot.tasks) {
      const blockers = await this.findTaskBlockers(task, snapshot.tasks, snapshot.activeLocks);
      const reasoningAssessment = assessTaskPacketReasoning(task.packet);
      const reasoningBlockers = reasoningAssessment.blockers.map((warning) => warning.message);
      const effectiveBlockers = [...blockers, ...reasoningBlockers];
      blockerMap.set(task.packet.taskId, effectiveBlockers);
      const ownerRole = task.packet.ownerRole as TaskPacketInput["requiredSpecialistRoles"][number];
      const reasoningRationale = reasoningAssessment.warnings.map(
        (warning) => `reasoning-quality: ${warning.message}`
      );
      const reasoningBlockingRationale = reasoningAssessment.blockers.map(
        (warning) => `reasoning-quality: ${warning.message}`
      );
      const reasoningCheckpoint =
        reasoningAssessment.status === "warn"
          ? "resolve or explicitly record reasoning-quality warnings before finalizing the task"
          : "reasoning-quality block includes evidence, alternatives, and a verification plan";

      if (task.status === "ready" && effectiveBlockers.length === 0) {
        recommendations.push({
          taskId: task.packet.taskId,
          taskStatus: task.status,
          recommendation: "owner_dispatch",
          authorityLabel: "derived_only",
          targetRole: ownerRole,
          rationale: [
            "task is ready with dependencies satisfied",
            `owner role is ${ownerRole}`,
            ...reasoningRationale,
            ...reasoningBlockingRationale
          ],
          blockers: [],
          allowedWriteScope: [...task.packet.allowedWriteScope],
          retrievalGuidance: getRoleRetrievalGuidance(ownerRole),
          approvalCheckpoints: [
            "manager must explicitly choose to route this task",
            `writer must claim ${task.packet.taskId} before edits`,
            `required reviews before completion: ${task.packet.requiredReviews.join(", ")}`,
            reasoningCheckpoint
          ]
        });
        continue;
      }

      if (task.status === "review_blocked") {
        const reviews = await this.store.getReviews(runId, task.packet.taskId);
        const missingReviewRoles = collectUnsatisfiedReviewRoles(task, reviews);

        for (const reviewRole of missingReviewRoles) {
          recommendations.push({
            taskId: task.packet.taskId,
            taskStatus: task.status,
            recommendation: "review_dispatch",
            authorityLabel: "derived_only",
            targetRole: reviewRole,
            targetReviewRole: reviewRole,
            rationale: [`review gate ${reviewRole} is still unsatisfied`],
            blockers:
              effectiveBlockers.length > 0
                ? [...effectiveBlockers]
                : [`missing required review: ${reviewRole}`],
            allowedWriteScope: [],
            retrievalGuidance: getRoleRetrievalGuidance(reviewRole),
            approvalCheckpoints: [
              "review actor must authenticate through the trusted review identity resolver",
              "manager must persist or attach authenticated reviewer evidence before completion",
              reasoningCheckpoint
            ]
          });
          if (reasoningRationale.length > 0) {
            recommendations[recommendations.length - 1]!.rationale.push(...reasoningRationale);
          }
          if (reasoningBlockingRationale.length > 0) {
            recommendations[recommendations.length - 1]!.rationale.push(...reasoningBlockingRationale);
          }
        }
        continue;
      }

      if (task.status === "in_progress" || effectiveBlockers.length > 0) {
        recommendations.push({
          taskId: task.packet.taskId,
          taskStatus: task.status,
          recommendation: "wait",
          authorityLabel: "derived_only",
          targetRole: ownerRole,
          rationale:
            task.status === "in_progress" && task.claimedBy
              ? [`task is already claimed by ${task.claimedBy}`]
              : ["task is not yet ready for routing"],
          blockers: [...effectiveBlockers],
          allowedWriteScope: [...task.packet.allowedWriteScope],
          retrievalGuidance: getRoleRetrievalGuidance(ownerRole),
          approvalCheckpoints: [
            "do not route an overlapping writer while the task remains claimed or blocked",
            "clear blockers before assigning the next specialist",
            reasoningCheckpoint
          ]
        });
        if (reasoningRationale.length > 0) {
          recommendations[recommendations.length - 1]!.rationale.push(...reasoningRationale);
        }
        if (reasoningBlockingRationale.length > 0) {
          recommendations[recommendations.length - 1]!.rationale.push(...reasoningBlockingRationale);
        }
      }
    }

    return {
      mode: "advisory_only",
      runId: snapshot.run.id,
      recommendations
    };
  }

  async inspectRecovery(
    runId: string,
    options: {
      staleAfterHours?: number | undefined;
      now?: string | undefined;
    } = {}
  ): Promise<RecoveryInspectionReport> {
    const staleAfterHours = options.staleAfterHours ?? 24;
    if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
      throw new Error(`staleAfterHours must be a non-negative integer: ${staleAfterHours}`);
    }

    const snapshot = await this.getStatus(runId);
    const now = options.now ?? timestamp();
    const issues: RecoveryIssue[] = [];
    const actions: RecoveryAction[] = [];
    const taskById = new Map(snapshot.tasks.map((task) => [task.packet.taskId, task]));

    for (const task of snapshot.tasks) {
      const ageHours = parseHoursSince(task.updatedAt, now);
      const reviews = await this.store.getReviews(runId, task.packet.taskId);
      const handoffs = await this.store.getHandoffs(runId, task.packet.taskId);

      if (task.status === "in_progress" && ageHours !== undefined && ageHours >= staleAfterHours) {
        const actionId = `reset-task:${task.packet.taskId}`;
        issues.push({
          id: `stalled-task:${task.packet.taskId}`,
          authorityLabel: "derived_only",
          kind: "stalled_task",
          taskId: task.packet.taskId,
          ageHours,
          details: [
            `task has been in progress for ${ageHours} hours`,
            task.claimedBy ? `claimed by ${task.claimedBy}` : "task is unclaimed"
          ],
          suggestedActionIds: handoffs.length === 0 ? [actionId] : []
        });

        if (handoffs.length === 0) {
          actions.push({
            id: actionId,
            authorityLabel: "derived_only",
            kind: "reset_task_to_ready",
            taskId: task.packet.taskId,
            safeToApply: true,
            rationale: [
              "stalled in-progress task has no recorded handoff",
              "safe reset releases writer lock and requeues the task"
            ]
          });
        }
      }

      if (task.status === "review_blocked" && ageHours !== undefined && ageHours >= staleAfterHours) {
        const missingReviewRoles = collectUnsatisfiedReviewRoles(task, reviews);
        if (missingReviewRoles.length > 0) {
          const actionId = `request-reviews:${task.packet.taskId}`;
          issues.push({
            id: `stale-review:${task.packet.taskId}`,
            authorityLabel: "derived_only",
            kind: "stale_review_block",
            taskId: task.packet.taskId,
            ageHours,
            details: [
              `task has been waiting on review for ${ageHours} hours`,
              `missing reviews: ${missingReviewRoles.join(", ")}`
            ],
            suggestedActionIds: [actionId]
          });
          actions.push({
            id: actionId,
            authorityLabel: "derived_only",
            kind: "request_missing_reviews",
            taskId: task.packet.taskId,
            safeToApply: false,
            rationale: [
              `missing authenticated reviews: ${missingReviewRoles.join(", ")}`,
              "operator action required; no state change is applied automatically"
            ]
          });
        }
      }

      if (task.status === "approved") {
        const decision = evaluateReviewDecision(task, reviews);
        if (decision.decision !== "approved") {
          const actionId = `reblock-approved:${task.packet.taskId}`;
          issues.push({
            id: `stale-approval:${task.packet.taskId}`,
            authorityLabel: "derived_only",
            kind: "stale_approval",
            taskId: task.packet.taskId,
            details: [`approval is stale: ${decision.blockers.join("; ")}`],
            suggestedActionIds: [actionId]
          });
          actions.push({
            id: actionId,
            authorityLabel: "derived_only",
            kind: "reblock_stale_approval",
            taskId: task.packet.taskId,
            safeToApply: true,
            rationale: [
              "task is approved but current review evidence no longer satisfies required gates",
              "safe reblock restores explicit review state before routing dependents"
            ]
          });
        }
      }
    }

    for (const lock of snapshot.activeLocks) {
      const task = taskById.get(lock.taskId);
      if (task && (task.status === "in_progress" || task.status === "review_blocked")) {
        continue;
      }

      const actionId = `release-lock:${lock.taskId}`;
      issues.push({
        id: `orphan-lock:${lock.taskId}`,
        authorityLabel: "derived_only",
        kind: "orphan_lock",
        taskId: task?.packet.taskId,
        lockTaskId: lock.taskId,
        ageHours: parseHoursSince(lock.createdAt, now),
        details: [
          `active lock exists for ${lock.taskId}`,
          task ? `task status is ${task.status}` : "task no longer exists for this active lock"
        ],
        suggestedActionIds: [actionId]
      });
      actions.push({
        id: actionId,
        authorityLabel: "derived_only",
        kind: "release_orphan_lock",
        taskId: lock.taskId,
        safeToApply: true,
        rationale: [
          "active lock does not correspond to an in-progress task",
          "safe release restores routing capacity without approving work"
        ]
      });
    }

    const uniqueIssues = dedupeById(issues);
    const uniqueActions = dedupeById(actions);

    return {
      mode: "advisory_only",
      runId: snapshot.run.id,
      staleAfterHours,
      issues: uniqueIssues,
      actions: uniqueActions,
      summary: {
        totalIssues: uniqueIssues.length,
        safeActions: uniqueActions.filter((action) => action.safeToApply).length,
        blockedTasks: uniqueIssues.flatMap((issue) => (issue.taskId ? [issue.taskId] : [])),
        staleTaskIds: uniqueIssues
          .filter((issue) => issue.kind === "stalled_task" || issue.kind === "stale_review_block")
          .flatMap((issue) => (issue.taskId ? [issue.taskId] : [])),
        orphanLockTaskIds: uniqueIssues
          .filter((issue) => issue.kind === "orphan_lock")
          .flatMap((issue) => (issue.lockTaskId ? [issue.lockTaskId] : []))
      }
    };
  }

  async applyRecovery(
    runId: string,
    actionIds: readonly string[],
    options: {
      staleAfterHours?: number | undefined;
      now?: string | undefined;
    } = {}
  ): Promise<RecoveryApplyResult> {
    const inspection = await this.inspectRecovery(runId, options);
    const selectableActionIds =
      actionIds.length > 0
        ? new Set(actionIds)
        : new Set(inspection.actions.filter((action) => action.safeToApply).map((action) => action.id));
    const actionMap = new Map(inspection.actions.map((action) => [action.id, action]));
    const appliedActionIds: string[] = [];
    const skippedActionIds: string[] = [];
    const appliedAt = options.now ?? timestamp();

    for (const actionId of selectableActionIds) {
      const action = actionMap.get(actionId);
      if (!action || !action.taskId) {
        skippedActionIds.push(actionId);
        continue;
      }

      if (!action.safeToApply) {
        skippedActionIds.push(actionId);
        continue;
      }

      if (action.kind === "release_orphan_lock") {
        const run = await this.requireRun(runId);
        const ownerLock = (await this.store.getActiveLocks(run.projectId)).find(
          (lock) => lock.taskId === action.taskId && lock.status === "active"
        );
        await this.store.releaseLocksForTask(ownerLock?.runId ?? runId, action.taskId, appliedAt);
        appliedActionIds.push(actionId);
        continue;
      }

      const task = await this.requireTask(runId, action.taskId);
      if (action.kind === "reset_task_to_ready") {
        const handoffs = await this.store.getHandoffs(runId, action.taskId);
        if (task.status !== "in_progress" || handoffs.length > 0) {
          skippedActionIds.push(actionId);
          continue;
        }

        await this.store.updateTask({
          ...task,
          status: "ready",
          claimedBy: undefined,
          updatedAt: appliedAt
        });
        await this.store.releaseLocksForTask(runId, action.taskId, appliedAt);
        appliedActionIds.push(actionId);
        continue;
      }

      if (action.kind === "reblock_stale_approval") {
        if (task.status !== "approved") {
          skippedActionIds.push(actionId);
          continue;
        }

        await this.store.updateTask({
          ...task,
          status: "review_blocked",
          updatedAt: appliedAt
        });
        appliedActionIds.push(actionId);
        continue;
      }

      skippedActionIds.push(actionId);
    }

    await this.syncRunState(runId);

    return {
      mode: "applied",
      runId,
      appliedActionIds,
      skippedActionIds,
      snapshot: await this.getStatus(runId)
    };
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return run;
  }

  private async persistLoopExecutionHistory(
    runId: string,
    steps: readonly DirectiveExecutionStep[]
  ): Promise<void> {
    if (steps.length === 0) {
      return;
    }

    const run = await this.requireRun(runId);
    const recordedAt = timestamp();

    for (const [index, step] of steps.entries()) {
      await this.store.saveMemoryEntry({
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        runId,
        taskId: step.taskId,
        scope: "project",
        entryType: "fact",
        title: `${LOOP_HISTORY_QUERY_PREFIX} ${runId} ${step.directiveKind} ${step.outcome}`,
        content: [
          `runId=${runId}`,
          `step=${index + 1}`,
          `directive=${step.directiveKind}`,
          `outcome=${step.outcome}`,
          step.taskId ? `taskId=${step.taskId}` : undefined,
          step.actor ? `actor=${step.actor}` : undefined,
          step.reviewRole ? `reviewRole=${step.reviewRole}` : undefined,
          step.nextDirectiveKind ? `nextDirective=${step.nextDirectiveKind}` : undefined,
          ...step.evidence.map((evidence) => `evidence=${evidence}`)
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        reviewer: LOOP_HISTORY_ACTOR,
        actor: LOOP_HISTORY_ACTOR,
        status: "approved",
        metadata: normalizeRetrievalMetadata({
          tags: [
            LOOP_HISTORY_TAG,
            `run:${runId}`,
            `directive:${step.directiveKind}`,
            `outcome:${step.outcome}`,
            `step:${index + 1}`,
            ...(step.taskId ? [`task:${step.taskId}`] : []),
            ...(step.actor ? [`actor:${step.actor}`] : []),
            ...(step.reviewRole ? [`reviewRole:${step.reviewRole}`] : []),
            ...(step.nextDirectiveKind ? [`next:${step.nextDirectiveKind}`] : [])
          ],
          reviewedAt: recordedAt,
          staleAfterDays: 3650,
          authorityLevel: "operational_context"
        }),
        createdAt: recordedAt
      });
    }

    await this.store.updateRun({
      ...run,
      updatedAt: recordedAt
    });
  }

  private async requireTask(runId: string, taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(runId, taskId);
    if (!task) {
      throw new Error(`Unknown task ${taskId} for run ${runId}`);
    }
    return task;
  }

  private async bumpRunState(runId: string, status: RunRecord["status"]) {
    const run = await this.requireRun(runId);
    await this.store.updateRun({
      ...run,
      status,
      updatedAt: timestamp()
    });
  }

  private async syncRunState(runId: string) {
    const run = await this.requireRun(runId);
    const tasks = await this.store.getTasksByRun(runId);
    await this.store.updateRun({
      ...run,
      status: deriveRunStatus(tasks),
      updatedAt: timestamp()
    });
  }

  private async findTaskBlockers(
    task: TaskRecord,
    allTasks: readonly TaskRecord[],
    activeLocks: readonly LockRecord[]
  ): Promise<string[]> {
    const blockers = findBlockingReasonsForTask(task, allTasks, activeLocks);

    for (const dependency of findTaskDependencies(task.packet, allTasks)) {
      if (dependency.status !== "approved") {
        continue;
      }

      const reviews = await this.store.getReviews(dependency.runId, dependency.packet.taskId);
      const decision = evaluateReviewDecision(dependency, reviews);
      if (decision.decision === "approved") {
        continue;
      }

      blockers.push(
        `dependency ${dependency.packet.taskId} has stale approval: ${decision.blockers.join("; ")}`
      );
    }

    return blockers;
  }

  private collectExecutionBlockers(
    snapshot: RunStatusSnapshot,
    routing: RoutingRecommendationReport,
    recovery: RecoveryInspectionReport
  ): string[] {
    const blockers = new Set<string>();

    for (const blocker of snapshot.blockers) {
      blockers.add(blocker);
    }

    for (const recommendation of routing.recommendations) {
      if (recommendation.recommendation !== "wait") {
        continue;
      }

      if (recommendation.blockers.length > 0) {
        for (const blocker of recommendation.blockers) {
          blockers.add(blocker);
        }
        continue;
      }

      for (const rationale of recommendation.rationale) {
        blockers.add(rationale);
      }
    }

    for (const issue of recovery.issues) {
      for (const detail of issue.details) {
        blockers.add(detail);
      }
    }

    if (blockers.size === 0 && snapshot.tasks.length === 0) {
      blockers.add("run has no task graph");
    }

    return [...blockers];
  }
}

function dedupeById<T extends { id: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }

    seen.add(entry.id);
    deduped.push(entry);
  }

  return deduped;
}
