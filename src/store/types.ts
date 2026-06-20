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
