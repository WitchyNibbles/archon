import { randomUUID } from "node:crypto";
import {
  validateReviewAction,
  validateHandoff,
  normalizeRetrievalMetadata,
  normalizeSearchInput,
  validateMemoryPromotion,
  effectiveRequiredReviewsForTask,
  isReviewFloorReduced
} from "../domain/contracts.ts";
import { requiredGateReviews } from "../domain/types.ts";
import {
  canRoleAccessSearchResult,
  collectUnsatisfiedReviewRoles,
  evaluateReviewDecision,
  findBlockingReasonsForTask,
  findTaskDependencies
} from "./policy.ts";
import { buildRuntimeTraceRegistry } from "../runtime/runtime-trace-registry.ts";
import { AutonomousExecutionStore } from "./autonomous-execution-store.ts";
import { TaskLifecycleManager } from "./task-lifecycle.ts";
import { StatusExecutionPlanner } from "./status-execution-planner.ts";
import { DirectiveExecutionManager } from "./directive-execution.ts";
import type {
  DirectiveExecutionResult,
  ExecuteDirectiveStepOptions
} from "./directive-execution.ts";
import { buildRuntimeTaskQueue, deriveRunStatus } from "./task-queue-projection.ts";
import {
  buildDefaultProductState,
  timestamp
} from "./project-runtime-state.ts";
import { annotateConflictSignals, isProvenancedSearchResult } from "./search-memory-results.ts";
import type {
  ResolveReviewActionContext
} from "./review-context.ts";
import { isTrustedReviewActionContext } from "./review-context.ts";
import { fireMistakeCapture, fireDistillation } from "../runtime/mistake-capture.ts";
import type { AntiPatternDraftStoreLike, MistakeLedgerStoreLike } from "../store/types.ts";
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
  HandoffInput,
  IntakeRequestInput,
  LockRecord,
  MemoryPromotionInput,
  MigrationLedgerEntryRecord,
  ParityRequirementRecord,
  PlanArtifact,
  PlanInput,
  ProgressProofRecord,
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
  // P1 MPL: optional mistake ledger store for occurrence capture.
  // If omitted, the capture hook is a no-op — never blocks the review path.
  mistakeLedgerStore?: MistakeLedgerStoreLike | undefined;
  // P2 MPL: optional store for pending anti-pattern draft candidates.
  // If omitted, review_required distillation candidates are silently dropped.
  // Autonomous candidates still promote through promoteMemory when configured.
  antiPatternDraftStore?: AntiPatternDraftStoreLike | undefined;
}

// Directive-execution I/O contracts are DEFINED in ./directive-execution.ts and
// re-exported here so existing consumers that import them from "../core/service.ts"
// (daemon, admin, tests) keep working unchanged — the public type surface of this
// module is preserved across the slice-3 split.
export type {
  ExecuteReviewRecommendationResult,
  ExecuteContinuationActionResult,
  DirectiveExecutionStep,
  ExecuteDirectiveStepOptions,
  DirectiveExecutionResult
} from "./directive-execution.ts";

function parseHoursSince(createdAt: string, now: string): number | undefined {
  const createdAtMs = Date.parse(createdAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(createdAtMs) || Number.isNaN(nowMs) || nowMs < createdAtMs) {
    return undefined;
  }

  return Number(((nowMs - createdAtMs) / (1000 * 60 * 60)).toFixed(2));
}

export class ArchonCoreService {
  private readonly store: ArchonStore;
  private readonly resolveReviewActionContext?: ResolveReviewActionContext | undefined;
  private readonly reviewSource: "orchestrator" | "seed";
  private readonly onHandoff?: ((event: HandoffLifecycleEvent) => Promise<void>) | undefined;
  private readonly mistakeLedgerStore?: MistakeLedgerStoreLike | undefined;
  private readonly antiPatternDraftStore?: AntiPatternDraftStoreLike | undefined;
  // Autonomous-execution analysis state (coverage, gaps, checkpoints, traces,
  // evidence ledgers) is owned by this extracted store; the public methods below
  // delegate to it. See src/core/autonomous-execution-store.ts (audit F5).
  private readonly autonomousExecution: AutonomousExecutionStore;
  // Run/task lifecycle transitions (intake -> plan -> task graph -> append ->
  // claim -> fail) plus the run-status mutators (bumpRunState/syncRunState) are
  // owned by this extracted manager; the public methods below delegate to it, and
  // gate/closure/recovery methods still on this class drive run status through the
  // private bumpRunState/syncRunState delegates. See src/core/task-lifecycle.ts.
  private readonly taskLifecycle: TaskLifecycleManager;
  // Status + execution-plan derivation (getStatus/getExecutionPlan/
  // recommendRouting/resumeRun) is owned by this extracted planner; the public
  // methods below delegate to it. inspectRecovery (recovery cluster, still on
  // this class) is injected because getExecutionPlan calls it, and the class's
  // own recovery/registry methods call this.getStatus (which delegates back to
  // the planner) — both directions are runtime closures, so no import cycle
  // forms. See src/core/status-execution-planner.ts (audit F5, slice 3).
  private readonly statusPlanner: StatusExecutionPlanner;
  // Directive execution loop (executeDirectiveStep) + loop-execution history
  // (getLoopExecutionHistory/persistLoopExecutionHistory) are owned by this
  // extracted manager; the public methods below delegate to it. getStatus/
  // getExecutionPlan (the planner) and claimTask (the lifecycle manager) are
  // injected. See src/core/directive-execution.ts (audit F5, slice 3).
  private readonly directiveExecution: DirectiveExecutionManager;

  constructor(store: ArchonStore, options: ArchonCoreServiceOptions = {}) {
    this.store = store;
    this.resolveReviewActionContext = options.resolveReviewActionContext;
    this.reviewSource = options.reviewSource ?? "orchestrator";
    this.onHandoff = options.onHandoff;
    this.mistakeLedgerStore = options.mistakeLedgerStore;
    this.antiPatternDraftStore = options.antiPatternDraftStore;
    this.autonomousExecution = new AutonomousExecutionStore({
      store,
      requireRun: (runId) => this.requireRun(runId)
    });
    this.taskLifecycle = new TaskLifecycleManager({
      store,
      requireRun: (runId) => this.requireRun(runId),
      requireTask: (runId, taskId) => this.requireTask(runId, taskId),
      findTaskBlockers: (task, allTasks, activeLocks) =>
        this.findTaskBlockers(task, allTasks, activeLocks),
      saveAutonomousExecutionState: (run, update) => this.autonomousExecution.saveState(run, update)
    });
    this.statusPlanner = new StatusExecutionPlanner({
      store,
      requireRun: (runId) => this.requireRun(runId),
      findTaskBlockers: (task, allTasks, activeLocks) =>
        this.findTaskBlockers(task, allTasks, activeLocks),
      inspectRecovery: (runId, inspectOptions) => this.inspectRecovery(runId, inspectOptions)
    });
    this.directiveExecution = new DirectiveExecutionManager({
      store,
      requireRun: (runId) => this.requireRun(runId),
      claimTask: (runId, taskId, actor) => this.claimTask(runId, taskId, actor),
      getStatus: (runId) => this.statusPlanner.getStatus(runId),
      getExecutionPlan: (runId, planOptions) => this.statusPlanner.getExecutionPlan(runId, planOptions)
    });
  }

  async getAutonomousExecutionState(runId: string): Promise<AutonomousExecutionState | undefined> {
    return this.autonomousExecution.getAutonomousExecutionState(runId);
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
    return this.autonomousExecution.configureAutonomousExecution(runId, input);
  }

  async disableAutonomousExecution(runId: string): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.disableAutonomousExecution(runId);
  }

  async upsertCoverageItems(runId: string, items: CoverageItemRecord[]): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertCoverageItems(runId, items);
  }

  async upsertUnderstandingMaps(
    runId: string,
    maps: UnderstandingMapRecord[]
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertUnderstandingMaps(runId, maps);
  }

  async captureRuntimeTrace(
    runId: string,
    trace: RuntimeTraceCaptureInput
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.captureRuntimeTrace(runId, trace);
  }

  async importRuntimeTrace(
    runId: string,
    trace: RuntimeTraceCaptureInput
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.importRuntimeTrace(runId, trace);
  }

  async upsertRuntimeTraces(
    runId: string,
    traces: RuntimeTraceRecord[]
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertRuntimeTraces(runId, traces);
  }

  async upsertDuplicateFamilies(
    runId: string,
    records: DuplicateFamilyRecord[]
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertDuplicateFamilies(runId, records);
  }

  async upsertArchitectureDecisions(
    runId: string,
    records: ArchitectureDecisionRecord[]
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertArchitectureDecisions(runId, records);
  }

  async upsertMigrationLedgerEntries(
    runId: string,
    records: MigrationLedgerEntryRecord[]
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertMigrationLedgerEntries(runId, records);
  }

  async upsertParityRequirements(
    runId: string,
    records: ParityRequirementRecord[]
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertParityRequirements(runId, records);
  }

  async upsertExternalEvals(
    runId: string,
    records: ExternalEvalRecord[]
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertExternalEvals(runId, records);
  }

  async upsertSensitiveActionControls(
    runId: string,
    records: SensitiveActionControlRecord[]
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertSensitiveActionControls(runId, records);
  }

  async upsertCoverageGaps(runId: string, gaps: CoverageGapRecord[]): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.upsertCoverageGaps(runId, gaps);
  }

  async recordProgressProof(
    runId: string,
    proof: ProgressProofRecord
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.recordProgressProof(runId, proof);
  }

  async checkpointRun(
    runId: string,
    checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">,
    options: {
      authorityLabel?: CheckpointRecord["authorityLabel"] | undefined;
    } = {}
  ): Promise<AutonomousExecutionState> {
    return this.autonomousExecution.checkpointRun(runId, checkpoint, options);
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
    return this.autonomousExecution.generateRepoInventory(runId, input);
  }

  // Task-lifecycle transitions are owned by TaskLifecycleManager (audit F5 /
  // service.ts split slice 2). These delegate; the public API is unchanged.
  async intakeRequest(input: IntakeRequestInput): Promise<RunRecord> {
    return this.taskLifecycle.intakeRequest(input);
  }

  async createPlan(plan: PlanInput): Promise<PlanArtifact> {
    return this.taskLifecycle.createPlan(plan);
  }

  async createTaskGraph(runId: string, taskPackets: TaskPacketInput[]): Promise<TaskRecord[]> {
    return this.taskLifecycle.createTaskGraph(runId, taskPackets);
  }

  async appendTasks(runId: string, taskPackets: TaskPacketInput[]): Promise<TaskRecord[]> {
    return this.taskLifecycle.appendTasks(runId, taskPackets);
  }

  async claimTask(runId: string, taskId: string, actor: string): Promise<TaskRecord> {
    return this.taskLifecycle.claimTask(runId, taskId, actor);
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

    // P2.1 / P1.5: when findingDetails is supplied, derive findings[] from the message
    // fields so the free-text view always matches the structured records and callers
    // cannot record divergent text.  Three sub-cases:
    //   • Accepted pass (all findingDetails have disposition="accepted"): derive from
    //     findingDetails — makes findings[] canonical for the P2.1 accepted path.
    //   • Non-passing review (blocked/failed) with findingDetails: derive from
    //     findingDetails so reviewers don't double-author (P1.5 behaviour).
    //   • Clean pass with provenance-only findingDetails (no acceptance disposition):
    //     keep findings[] from the caller (normally []) so the gate is not broken by
    //     deriving non-empty findings that lack acceptance records.
    const allFindingDetailsAccepted =
      review.findingDetails !== undefined &&
      review.findingDetails.length > 0 &&
      review.findingDetails.every((f) => f.disposition === "accepted");
    const shouldDeriveFromDetails =
      allFindingDetailsAccepted ||
      (review.state !== "passed" &&
       review.findingDetails !== undefined &&
       review.findingDetails.length > 0);
    const derivedFindings: string[] = shouldDeriveFromDetails
      ? review.findingDetails!.map((f) => f.message)
      : [...review.findings];

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
      findings: derivedFindings,
      waiverReason: review.waiverReason,
      evidenceRefs: [...(review.evidenceRefs ?? [])],
      createdAt: timestamp(),
      findingDetails: review.findingDetails !== undefined ? [...review.findingDetails] : undefined
    };

    await this.store.saveReview(reviewRecord);

    // P1 MPL capture hook — non-fatal; must never block the review path.
    // Delegated to fireMistakeCapture (FIX 3: extracted glue function, see module scope above).
    if (this.mistakeLedgerStore) {
      fireMistakeCapture(reviewRecord, task.projectId, this.mistakeLedgerStore);
    }

    // P2 MPL distillation hook — non-fatal; runs after capture, never blocks review path.
    // Requires both mistakeLedgerStore (to read occurrences) and resolveReviewActionContext
    // (to create a sealed trusted context for autonomous promotion through promoteMemory).
    // SECURITY: promoteMemory is bound here — P0 trust gate (isTrustedReviewActionContext)
    // is enforced inside promoteMemory, not bypassed. actorRole: "reviewer" in the
    // MemoryPromotionInput satisfies the anti_pattern role-gate (council condition 2).
    // The resolver provides the sealed WeakSet-registered context (council condition 1).
    // If antiPatternDraftStore is absent, review_required candidates persist to a no-op store.
    // resolveReviewActionContext is guaranteed non-null here (checked above at line ~1405).
    if (this.mistakeLedgerStore && this.antiPatternDraftStore) {
      fireDistillation(
        runId,
        task.projectId,
        this.mistakeLedgerStore,
        this.antiPatternDraftStore,
        this.promoteMemory.bind(this)
      );
    }

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
    return this.taskLifecycle.failTask(runId, taskId, reason);
  }

  async promoteMemory(runId: string, input: MemoryPromotionInput) {
    if (!this.resolveReviewActionContext) {
      throw new Error("promoteMemory requires a trusted promotion context resolver");
    }

    const run = await this.requireRun(runId);
    const errors = validateMemoryPromotion(input);
    if (errors.length > 0) {
      throw new Error(`Memory promotion rejected: ${errors.join("; ")}`);
    }

    let context;
    try {
      context = await this.resolveReviewActionContext({
        runId,
        taskId: input.sourceTaskId ?? "",
        actor: input.actor,
        reviewerRole: "reviewer",
        reviewState: "passed"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Memory promotion rejected: invalid promotion context: ${message}`);
    }

    // FINDING 1: mirror recordReview's trust gate — the resolver must return a
    // WeakSet-registered TrustedReviewActionContext.  A plain unsealed object
    // returned by a malicious or misconfigured resolver must be rejected here.
    if (!isTrustedReviewActionContext(context)) {
      throw new Error(
        "Memory promotion rejected: promotion context must be a sealed trusted review action context"
      );
    }

    const createdAt = timestamp();
    // FINDING 2: authorityLevel is always "reviewed_memory" for promoted
    // memory entries regardless of caller input — strip any caller-supplied
    // value before passing through normalizeRetrievalMetadata.
    const { authorityLevel: _discardedAuthorityLevel, ...callerMetadata } = input.metadata ?? {};
    const metadata = normalizeRetrievalMetadata({
      ...callerMetadata,
      reviewedAt: callerMetadata.reviewedAt ?? createdAt,
      authorityLevel: "reviewed_memory"
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
      // NON-BLOCKING (by design): input.reviewer and input.actor are silently
      // discarded here — the stored values always come from the trusted resolver
      // context.  Callers should not rely on those input fields being stored.
      // Follow-up: mistake-pattern-ledger.md tracks this as a pattern to
      // address in a future MemoryPromotionInput type revision.
      reviewer: context.actor,
      actor: context.actor,
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
    return this.statusPlanner.getStatus(runId);
  }

  async getExecutionPlan(
    runId: string,
    options: {
      staleAfterHours?: number | undefined;
    } = {}
  ): Promise<RunExecutionPlan> {
    return this.statusPlanner.getExecutionPlan(runId, options);
  }

  async resumeRun(runId: string): Promise<RunResumeSnapshot> {
    return this.statusPlanner.resumeRun(runId);
  }

  async executeDirectiveStep(
    runId: string,
    options: ExecuteDirectiveStepOptions = {}
  ): Promise<DirectiveExecutionResult> {
    return this.directiveExecution.executeDirectiveStep(runId, options);
  }

  async getLoopExecutionHistory(
    runId: string,
    options: {
      limit?: number | undefined;
      requesterRole?: TaskPacketInput["requiredSpecialistRoles"][number] | undefined;
    } = {}
  ): Promise<SearchMemoryResult[]> {
    return this.directiveExecution.getLoopExecutionHistory(runId, options);
  }

  async recommendRouting(runId: string): Promise<RoutingRecommendationReport> {
    return this.statusPlanner.recommendRouting(runId);
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

  private async requireTask(runId: string, taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(runId, taskId);
    if (!task) {
      throw new Error(`Unknown task ${taskId} for run ${runId}`);
    }
    return task;
  }

  // Run-status mutators are owned by TaskLifecycleManager (audit F5 / service.ts
  // split slice 2). These private delegates keep gate/closure/recovery methods
  // still on this class (recordReview, submitHandoff, promoteMemory, applyRecovery)
  // driving run status through the same code path as the lifecycle transitions.
  private async bumpRunState(runId: string, status: RunRecord["status"]) {
    return this.taskLifecycle.bumpRunState(runId, status);
  }

  private async syncRunState(runId: string) {
    return this.taskLifecycle.syncRunState(runId);
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
