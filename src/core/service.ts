import { AutonomousExecutionStore } from "./autonomous-execution-store.ts";
import { TaskLifecycleManager } from "./task-lifecycle.ts";
import { StatusExecutionPlanner } from "./status-execution-planner.ts";
import { DirectiveExecutionManager } from "./directive-execution.ts";
import { RecoveryManager } from "./recovery-manager.ts";
import { MemorySearchManager } from "./memory-search-manager.ts";
import { GateClosureManager } from "./gate-closure-manager.ts";
import type { HandoffLifecycleEvent } from "./gate-closure-manager.ts";
import type {
  DirectiveExecutionResult,
  ExecuteDirectiveStepOptions
} from "./directive-execution.ts";
import type {
  ResolveReviewActionContext
} from "./review-context.ts";
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
  RecoveryApplyResult,
  RecoveryInspectionReport,
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

// HandoffLifecycleEvent is DEFINED in ./gate-closure-manager.ts (the gate cluster
// that fires it) and re-exported here so existing consumers that import it from
// "../core/service.ts" keep working unchanged — the public type surface of this
// module is preserved across the slice-5 split.
export type { HandoffLifecycleEvent } from "./gate-closure-manager.ts";

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

// ArchonCoreService is a thin COMPOSITION ROOT. Every domain cluster lives in its
// own extracted manager (audit F5 / architecture-runtime-debt §3.4); this class
// owns only the constructor wiring, the shared require/run-status private helpers,
// and public delegate stubs that preserve the API + type surface unchanged.
export class ArchonCoreService {
  private readonly store: ArchonStore;
  // Autonomous-execution analysis state (coverage, gaps, checkpoints, traces,
  // evidence ledgers) is owned by this extracted store; the public methods below
  // delegate to it. See src/core/autonomous-execution-store.ts (audit F5).
  private readonly autonomousExecution: AutonomousExecutionStore;
  // Run/task lifecycle transitions (intake -> plan -> task graph -> append ->
  // claim -> fail) plus the run-status mutators (bumpRunState/syncRunState) are
  // owned by this extracted manager; the public methods below delegate to it, and
  // the gate/closure and recovery managers drive run status through the private
  // bumpRunState/syncRunState delegates. See src/core/task-lifecycle.ts.
  private readonly taskLifecycle: TaskLifecycleManager;
  // Status + execution-plan derivation (getStatus/getExecutionPlan/
  // recommendRouting/resumeRun) is owned by this extracted planner; the public
  // methods below delegate to it. See src/core/status-execution-planner.ts.
  private readonly statusPlanner: StatusExecutionPlanner;
  // Directive execution loop (executeDirectiveStep) + loop-execution history
  // (getLoopExecutionHistory) are owned by this extracted manager; the public
  // methods below delegate to it. See src/core/directive-execution.ts.
  private readonly directiveExecution: DirectiveExecutionManager;
  // Recovery cluster (inspectRecovery/applyRecovery) is owned by this extracted
  // manager; the public methods below delegate to it. The advisory-only authority
  // boundary is enforced inside the manager. See src/core/recovery-manager.ts.
  private readonly recovery: RecoveryManager;
  // Memory/search cluster (promoteMemory/searchMemory/getRuntimeTraceRegistry) is
  // owned by this extracted manager; the P0 promotion trust gate is enforced
  // inside the manager, not bypassed. See src/core/memory-search-manager.ts.
  private readonly memorySearch: MemorySearchManager;
  // Gate/closure cluster (submitHandoff/recordReview/findTaskBlockers) — the
  // completion authority of the runtime — is owned by this extracted manager; the
  // public methods below delegate to it, and findTaskBlockers is injected FROM it
  // INTO the lifecycle manager and status planner. The review trust-context,
  // floor-reduction provenance, and mistake-ledger capture ordering are enforced
  // inside the manager. See src/core/gate-closure-manager.ts (audit F5, slice 5).
  private readonly gateClosure: GateClosureManager;

  constructor(store: ArchonStore, options: ArchonCoreServiceOptions = {}) {
    this.store = store;
    // WIRING INVARIANT (durable — resolves the slice-4 carried LOW).
    // Every cross-manager dependency below is a LAZY `this.<field>` arrow closure,
    // evaluated only when the wrapped method is actually invoked at runtime — and
    // every manager constructor ONLY STORES its deps, never invokes them. So no
    // closure can read a manager field before it is assigned: construction order
    // among the managers is immaterial to correctness, even for the mutually-
    // referencing pairs (statusPlanner<->recovery, gateClosure<->taskLifecycle,
    // and the gateClosure->memorySearch->statusPlanner->gateClosure ring). A
    // closure could only observe a pre-initialization (undefined) field if it
    // were rewritten to read the field EAGERLY at construction time (e.g.
    // `const r = this.recovery;` captured outside the arrow). That regression is
    // guarded by tests/service-constructor-wiring.test.ts, which constructs the
    // service and immediately drives every mutually-recursive path — it fails
    // fast if any cross-manager dep is converted from a lazy `this.<field>` read
    // into an eager capture. Do NOT destructure a manager field into a closure.
    this.autonomousExecution = new AutonomousExecutionStore({
      store,
      requireRun: (runId) => this.requireRun(runId)
    });
    this.memorySearch = new MemorySearchManager({
      store,
      requireRun: (runId) => this.requireRun(runId),
      getStatus: (runId) => this.statusPlanner.getStatus(runId),
      bumpRunState: (runId, status) => this.bumpRunState(runId, status),
      resolveReviewActionContext: options.resolveReviewActionContext
    });
    this.gateClosure = new GateClosureManager({
      store,
      requireTask: (runId, taskId) => this.requireTask(runId, taskId),
      bumpRunState: (runId, status) => this.bumpRunState(runId, status),
      reviewSource: options.reviewSource ?? "orchestrator",
      onHandoff: options.onHandoff,
      resolveReviewActionContext: options.resolveReviewActionContext,
      mistakeLedgerStore: options.mistakeLedgerStore,
      antiPatternDraftStore: options.antiPatternDraftStore,
      promoteMemory: (runId, input) => this.memorySearch.promoteMemory(runId, input)
    });
    this.taskLifecycle = new TaskLifecycleManager({
      store,
      requireRun: (runId) => this.requireRun(runId),
      requireTask: (runId, taskId) => this.requireTask(runId, taskId),
      findTaskBlockers: (task, allTasks, activeLocks) =>
        this.gateClosure.findTaskBlockers(task, allTasks, activeLocks),
      saveAutonomousExecutionState: (run, update) => this.autonomousExecution.saveState(run, update)
    });
    this.statusPlanner = new StatusExecutionPlanner({
      store,
      requireRun: (runId) => this.requireRun(runId),
      findTaskBlockers: (task, allTasks, activeLocks) =>
        this.gateClosure.findTaskBlockers(task, allTasks, activeLocks),
      inspectRecovery: (runId, inspectOptions) => this.recovery.inspectRecovery(runId, inspectOptions)
    });
    this.recovery = new RecoveryManager({
      store,
      requireRun: (runId) => this.requireRun(runId),
      requireTask: (runId, taskId) => this.requireTask(runId, taskId),
      getStatus: (runId) => this.statusPlanner.getStatus(runId),
      syncRunState: (runId) => this.syncRunState(runId)
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
    return this.memorySearch.getRuntimeTraceRegistry(runId);
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

  // Gate/closure cluster is owned by GateClosureManager (audit F5 / service.ts
  // split slice 5). These delegate; the review trust-context checks, floor-
  // reduction provenance, and mistake-ledger capture ordering are enforced inside
  // the manager and the public API is unchanged.
  async submitHandoff(runId: string, taskId: string, handoff: HandoffInput) {
    return this.gateClosure.submitHandoff(runId, taskId, handoff);
  }

  async recordReview(runId: string, taskId: string, actor: string, review: ReviewInput) {
    return this.gateClosure.recordReview(runId, taskId, actor, review);
  }

  async failTask(runId: string, taskId: string, reason: string) {
    return this.taskLifecycle.failTask(runId, taskId, reason);
  }

  // Memory/search cluster is owned by MemorySearchManager (audit F5 / service.ts
  // split slice 4). These delegate; the public API — and the P0 promotion trust
  // gate enforced inside the manager — is unchanged.
  async promoteMemory(runId: string, input: MemoryPromotionInput) {
    return this.memorySearch.promoteMemory(runId, input);
  }

  async searchMemory(input: SearchMemoryInput): Promise<SearchMemoryResult[]> {
    return this.memorySearch.searchMemory(input);
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

  // Recovery cluster is owned by RecoveryManager (audit F5 / service.ts split
  // slice 4). These delegate; the advisory-only authority boundary is enforced
  // inside the manager and the public API is unchanged.
  async inspectRecovery(
    runId: string,
    options: {
      staleAfterHours?: number | undefined;
      now?: string | undefined;
    } = {}
  ): Promise<RecoveryInspectionReport> {
    return this.recovery.inspectRecovery(runId, options);
  }

  async applyRecovery(
    runId: string,
    actionIds: readonly string[],
    options: {
      staleAfterHours?: number | undefined;
      now?: string | undefined;
    } = {}
  ): Promise<RecoveryApplyResult> {
    return this.recovery.applyRecovery(runId, actionIds, options);
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
  // split slice 2). These private delegates keep the gate/closure and recovery
  // managers driving run status through the same code path as the lifecycle
  // transitions (gateClosure.bumpRunState and recovery.syncRunState are injected
  // from these).
  private async bumpRunState(runId: string, status: RunRecord["status"]) {
    return this.taskLifecycle.bumpRunState(runId, status);
  }

  private async syncRunState(runId: string) {
    return this.taskLifecycle.syncRunState(runId);
  }
}
