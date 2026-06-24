import type {
  ApprovalRecord,
  HandoffRecord,
  LockRecord,
  MemoryEntryRecord,
  MarkdownArtifactRecord,
  PlanArtifact,
  ProjectRuntimeStateRecord,
  ProjectRecord,
  ReviewFloorReductionRecord,
  ReviewRecord,
  RuntimeMigrationJournalRecord,
  RuntimeProjectRegistrationRecord,
  RetrievalRole,
  RunRecord,
  SearchMemoryResult,
  TaskRecord,
  WorkflowDocumentRecord,
  WorkspaceRecord
} from "../domain/types.ts";
import type { AntiPatternDraft, MistakeOccurrenceRecord } from "../runtime/mistake-ledger.ts";

export type EmbeddingJobSourceTable = "artifacts" | "memory_entries";

export type EmbeddingJobStatus = "pending" | "processing" | "done" | "failed";

export interface EmbeddingJobRecord {
  id: string;
  workspaceId: string;
  projectId?: string | undefined;
  sourceTable: EmbeddingJobSourceTable;
  sourceId: string;
  embeddingModel: string;
  status: EmbeddingJobStatus;
  errorMessage?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface QueueEmbeddingJobInput {
  workspaceId: string;
  projectId?: string | undefined;
  sourceTable: EmbeddingJobSourceTable;
  sourceId: string;
  embeddingModel: string;
}

export interface LeaseEmbeddingJobsInput {
  limit: number;
}

export interface CompleteEmbeddingJobInput {
  jobId: string;
  sourceTable: EmbeddingJobSourceTable;
  sourceId: string;
  embeddingModel: string;
  embedding: readonly number[];
}

export interface EmbeddingSourceRecord {
  sourceTable: EmbeddingJobSourceTable;
  sourceId: string;
  title: string;
  content: string;
}

export interface ArchonStore {
  ensureProjectContext(params: {
    workspaceSlug: string;
    workspaceName?: string | undefined;
    projectSlug: string;
    projectName?: string | undefined;
    repoPath?: string | undefined;
  }): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord }>;
  getProjectContext(params: {
    workspaceSlug: string;
    projectSlug: string;
  }): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  saveProjectRuntimeRegistration(registration: RuntimeProjectRegistrationRecord): Promise<void>;
  getProjectRuntimeRegistration(projectId: string): Promise<RuntimeProjectRegistrationRecord | undefined>;
  saveRuntimeMigrationJournal(journal: RuntimeMigrationJournalRecord): Promise<void>;
  listRuntimeMigrationJournals(projectId: string): Promise<RuntimeMigrationJournalRecord[]>;
  saveProjectRuntimeState(state: ProjectRuntimeStateRecord): Promise<void>;
  getProjectRuntimeState(projectId: string): Promise<ProjectRuntimeStateRecord | undefined>;
  saveWorkflowDocument(document: WorkflowDocumentRecord): Promise<void>;
  listWorkflowDocuments(params: {
    projectId: string;
    runId?: string | undefined;
    taskId?: string | undefined;
    kind?: WorkflowDocumentRecord["kind"] | undefined;
  }): Promise<WorkflowDocumentRecord[]>;
  createRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  findLatestRun(params: { workspaceSlug: string; projectSlug: string }): Promise<RunRecord | undefined>;
  findLatestRunForTask(params: {
    workspaceSlug: string;
    projectSlug: string;
    taskId: string;
  }): Promise<RunRecord | undefined>;
  findRunsByProjectActivity(params: {
    workspaceSlug: string;
    projectSlug: string;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    timezone: string;
  }): Promise<RunRecord[]>;
  updateRun(run: RunRecord): Promise<void>;
  savePlan(plan: PlanArtifact): Promise<void>;
  getPlan(runId: string): Promise<PlanArtifact | undefined>;
  replaceTasks(tasks: TaskRecord[]): Promise<void>;
  /**
   * Append new tasks to an existing run without deleting any existing tasks.
   * Throws if any task_key in `tasks` already exists in the run, if any
   * dependency edge is dangling (key absent from both existing run tasks and
   * the appended batch), or if tasks span more than one runId.
   * Implementations must be atomic: a failed integrity check inserts NOTHING.
   */
  appendTasks(tasks: TaskRecord[]): Promise<void>;
  getTasksByRun(runId: string): Promise<TaskRecord[]>;
  getTask(runId: string, taskId: string): Promise<TaskRecord | undefined>;
  updateTask(task: TaskRecord): Promise<void>;
  createLock(lock: LockRecord): Promise<void>;
  releaseLocksForTask(runId: string, taskId: string, releasedAt: string): Promise<void>;
  getActiveLocks(projectId: string): Promise<LockRecord[]>;
  saveHandoff(handoff: HandoffRecord): Promise<void>;
  getHandoffs(runId: string, taskId: string): Promise<HandoffRecord[]>;
  saveReview(review: ReviewRecord): Promise<void>;
  getReviews(runId: string, taskId: string): Promise<ReviewRecord[]>;
  saveApproval(approval: ApprovalRecord): Promise<void>;
  getApprovals(runId: string, taskId: string): Promise<ApprovalRecord[]>;
  /** Write an idempotent provenance row when a review-floor reduction occurs (Option B, slice 3). */
  saveReviewFloorReduction(record: ReviewFloorReductionRecord): Promise<void>;
  /** Read review-floor reduction provenance rows for a task (Option B; hook/runtime authority). */
  getReviewFloorReductions(runId: string, taskId: string): Promise<ReviewFloorReductionRecord[]>;
  saveMemoryEntry(entry: MemoryEntryRecord): Promise<void>;
  listMemoryEntries(params: {
    runId: string;
    taskId?: string | undefined;
    entryType?: MemoryEntryRecord["entryType"] | undefined;
    status?: MemoryEntryRecord["status"] | undefined;
  }): Promise<MemoryEntryRecord[]>;
  replaceMarkdownArtifacts(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    artifacts: readonly MarkdownArtifactRecord[];
  }): Promise<void>;
  queueEmbeddingJob(input: QueueEmbeddingJobInput): Promise<EmbeddingJobRecord>;
  leaseEmbeddingJobs(input: LeaseEmbeddingJobsInput): Promise<EmbeddingJobRecord[]>;
  getEmbeddingSource(sourceTable: EmbeddingJobSourceTable, sourceId: string): Promise<EmbeddingSourceRecord | undefined>;
  completeEmbeddingJob(input: CompleteEmbeddingJobInput): Promise<void>;
  failEmbeddingJob(jobId: string, errorMessage: string): Promise<void>;
  searchMemory(params: {
    workspaceSlug: string;
    projectSlug: string;
    query: string;
    limit: number;
    includeGlobal: boolean;
    queryEmbedding?: readonly number[] | undefined;
    embeddingModel?: string | undefined;
    requesterRole?: RetrievalRole | undefined;
  }): Promise<SearchMemoryResult[]>;
}

// ---------------------------------------------------------------------------
// MistakeLedgerStoreLike — minimal interface for P1 occurrence store
// ---------------------------------------------------------------------------
// Raw occurrences are persisted in project_runtime_state JSONB (productState)
// under the key "mistake_occurrences". Only the distilled anti_pattern (P2+)
// will land in memory_entries. This keeps write-volume out of the search layer.

export interface MistakeLedgerStoreLike {
  /**
   * Append a batch of mistake occurrence records. Implementations must be
   * idempotent by record id (upsert semantics). Must not throw on empty array.
   */
  appendMistakeOccurrences(
    projectId: string,
    occurrences: readonly MistakeOccurrenceRecord[]
  ): Promise<void>;

  /**
   * Return all occurrence records for the project, across all runs.
   * Used by collectMistakeMetrics for cross-run recurrence counting.
   */
  listMistakeOccurrences(projectId: string): Promise<readonly MistakeOccurrenceRecord[]>;

  /**
   * Append (or upsert) a promoted anti_pattern MemoryEntryRecord to the project's
   * anti-pattern store. Used by P3 injection store implementations.
   * Idempotent by entry.id.
   */
  appendAntiPatternEntry(
    projectId: string,
    entry: import("../domain/types.ts").MemoryEntryRecord
  ): Promise<void>;

  /**
   * Return anti_pattern MemoryEntryRecord entries for the given project whose
   * locus (symbolLocus in tags, or universal when absent) matches any of the
   * provided scope globs. Implementations must use an indexed path — NOT a
   * full JSONB scan. Migration 026 adds the required index.
   *
   * Filtering for supersededBy and staleness is done by the caller (injector).
   */
  listAntiPatternsForLocus(
    projectId: string,
    locusGlobs: readonly string[]
  ): Promise<readonly import("../domain/types.ts").MemoryEntryRecord[]>;
}

// ---------------------------------------------------------------------------
// AntiPatternDraftStoreLike — MPL P2 draft candidate persistence
// ---------------------------------------------------------------------------
// Pending anti-pattern drafts (review_required candidates) are stored here
// until a human reviewer promotes them. autonomous candidates are promoted
// immediately and never stored here.

export interface AntiPatternDraftStoreLike {
  /**
   * Persist an anti-pattern draft candidate.
   * Idempotent by draft id (upsert semantics: later record with same id wins).
   * Must not throw on an already-stored id — silently updates.
   */
  appendAntiPatternDraft(projectId: string, draft: AntiPatternDraft): Promise<void>;

  /**
   * Return all anti-pattern drafts for the project (all statuses).
   * Callers may filter by status (pending/promoted) as needed.
   */
  listAntiPatternDrafts(projectId: string): Promise<readonly AntiPatternDraft[]>;
}
