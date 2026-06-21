import type {
  ApprovalRecord,
  HandoffRecord,
  LockRecord,
  MarkdownArtifactRecord,
  MemoryEntryRecord,
  PlanArtifact,
  ProjectRuntimeStateRecord,
  ProjectRecord,
  RetrievalRole,
  ReviewFloorReductionRecord,
  ReviewRecord,
  RuntimeMigrationJournalRecord,
  RuntimeProjectRegistrationRecord,
  RunRecord,
  SearchMemoryResult,
  TaskRecord,
  WorkflowDocumentRecord,
  WorkspaceRecord
} from "../domain/types.ts";
import { PostgresEmbeddingJobs } from "./postgres-embedding-jobs.ts";
import { searchMemory } from "./postgres-memory-search.ts";
import type {
  CompleteEmbeddingJobInput,
  ArchonStore,
  EmbeddingJobRecord,
  EmbeddingJobSourceTable,
  EmbeddingSourceRecord,
  LeaseEmbeddingJobsInput,
  QueueEmbeddingJobInput
} from "./types.ts";

// Sub-module free functions
import { ensureProjectContext, getProjectContext, saveProjectRuntimeRegistration, getProjectRuntimeRegistration, saveRuntimeMigrationJournal, listRuntimeMigrationJournals, saveProjectRuntimeState, getProjectRuntimeState, saveWorkflowDocument, listWorkflowDocuments } from "./postgres/project-state.ts";
import { createRun, getRun, findLatestRun, findLatestRunForTask, findRunsByProjectActivity, updateRun } from "./postgres/runs.ts";
import { savePlan, getPlan, replaceTasks, getTasksByRun, getTask, updateTask } from "./postgres/tasks.ts";
import { createLock, releaseLocksForTask, getActiveLocks, saveHandoff, getHandoffs } from "./postgres/handoffs-locks.ts";
import { saveReview, getReviews, getOrchestratorReviews, saveOrchestratorReview, saveApproval, getApprovals, saveReviewFloorReduction, getReviewFloorReductions } from "./postgres/reviews.ts";
import { saveMemoryEntry, listMemoryEntries, replaceMarkdownArtifacts, loadArtifactsByIds } from "./postgres/memory.ts";

export type { SqlQueryResult, SqlClient } from "./postgres/shared.ts";

// Re-export so that existing importers (daemon.ts, mcp/server.ts, tests) work unchanged.
export { PostgresMistakeLedgerStore } from "./postgres-mistake-ledger-store.ts";

export class PostgresStore implements ArchonStore {
  private readonly client: import("./postgres/shared.ts").SqlClient;
  private readonly embeddingJobs: PostgresEmbeddingJobs;

  constructor(client: import("./postgres/shared.ts").SqlClient) {
    this.client = client;
    this.embeddingJobs = new PostgresEmbeddingJobs(client);
  }

  async ensureProjectContext(params: {
    workspaceSlug: string;
    workspaceName?: string | undefined;
    projectSlug: string;
    projectName?: string | undefined;
    repoPath?: string | undefined;
  }): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord }> {
    return ensureProjectContext(this.client, params);
  }

  async getProjectContext(params: {
    workspaceSlug: string;
    projectSlug: string;
  }): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined> {
    return getProjectContext(this.client, params);
  }

  async saveProjectRuntimeRegistration(registration: RuntimeProjectRegistrationRecord): Promise<void> {
    return saveProjectRuntimeRegistration(this.client, registration);
  }

  async getProjectRuntimeRegistration(
    projectId: string
  ): Promise<RuntimeProjectRegistrationRecord | undefined> {
    return getProjectRuntimeRegistration(this.client, projectId);
  }

  async saveRuntimeMigrationJournal(journal: RuntimeMigrationJournalRecord): Promise<void> {
    return saveRuntimeMigrationJournal(this.client, journal);
  }

  async listRuntimeMigrationJournals(projectId: string): Promise<RuntimeMigrationJournalRecord[]> {
    return listRuntimeMigrationJournals(this.client, projectId);
  }

  async saveProjectRuntimeState(state: ProjectRuntimeStateRecord): Promise<void> {
    return saveProjectRuntimeState(this.client, state);
  }

  async getProjectRuntimeState(projectId: string): Promise<ProjectRuntimeStateRecord | undefined> {
    return getProjectRuntimeState(this.client, projectId);
  }

  async saveWorkflowDocument(document: WorkflowDocumentRecord): Promise<void> {
    return saveWorkflowDocument(this.client, document);
  }

  async listWorkflowDocuments(params: {
    projectId: string;
    runId?: string | undefined;
    taskId?: string | undefined;
    kind?: WorkflowDocumentRecord["kind"] | undefined;
  }): Promise<WorkflowDocumentRecord[]> {
    return listWorkflowDocuments(this.client, params);
  }

  async createRun(run: RunRecord): Promise<void> {
    return createRun(this.client, run);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return getRun(this.client, runId);
  }

  async findLatestRun(params: { workspaceSlug: string; projectSlug: string }): Promise<RunRecord | undefined> {
    return findLatestRun(this.client, params);
  }

  async findLatestRunForTask(params: {
    workspaceSlug: string;
    projectSlug: string;
    taskId: string;
  }): Promise<RunRecord | undefined> {
    return findLatestRunForTask(this.client, params);
  }

  async findRunsByProjectActivity(params: {
    workspaceSlug: string;
    projectSlug: string;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    timezone: string;
  }): Promise<RunRecord[]> {
    return findRunsByProjectActivity(this.client, params);
  }

  async updateRun(run: RunRecord): Promise<void> {
    return updateRun(this.client, run);
  }

  async savePlan(plan: PlanArtifact): Promise<void> {
    return savePlan(this.client, plan);
  }

  async getPlan(runId: string): Promise<PlanArtifact | undefined> {
    return getPlan(this.client, runId);
  }

  async replaceTasks(tasks: TaskRecord[]): Promise<void> {
    return replaceTasks(this.client, tasks);
  }

  async getTasksByRun(runId: string): Promise<TaskRecord[]> {
    return getTasksByRun(this.client, runId);
  }

  async getTask(runId: string, taskId: string): Promise<TaskRecord | undefined> {
    return getTask(this.client, runId, taskId);
  }

  async updateTask(task: TaskRecord): Promise<void> {
    return updateTask(this.client, task);
  }

  async createLock(lock: LockRecord): Promise<void> {
    return createLock(this.client, lock);
  }

  async releaseLocksForTask(runId: string, taskId: string, releasedAt: string): Promise<void> {
    return releaseLocksForTask(this.client, runId, taskId, releasedAt);
  }

  async getActiveLocks(projectId: string): Promise<LockRecord[]> {
    return getActiveLocks(this.client, projectId);
  }

  async saveHandoff(handoff: HandoffRecord): Promise<void> {
    return saveHandoff(this.client, handoff);
  }

  async getHandoffs(runId: string, taskId: string): Promise<HandoffRecord[]> {
    return getHandoffs(this.client, runId, taskId);
  }

  async saveReview(review: ReviewRecord): Promise<void> {
    return saveReview(this.client, review);
  }

  async getReviews(runId: string, taskId: string): Promise<ReviewRecord[]> {
    return getReviews(this.client, runId, taskId);
  }

  async getOrchestratorReviews(taskId: string): Promise<{ role: string; outcome: string; source: string }[]> {
    return getOrchestratorReviews(this.client, taskId);
  }

  async saveOrchestratorReview(input: {
    taskId: string;
    role: string;
    outcome: string;
    findings: string;
    workspaceId: string;
    projectId: string;
    runId?: string | null | undefined;
    findingDetails?: readonly import("../domain/types.ts").ReviewFinding[] | undefined;
  }): Promise<void> {
    return saveOrchestratorReview(this.client, input);
  }

  async saveApproval(approval: ApprovalRecord): Promise<void> {
    return saveApproval(this.client, approval);
  }

  async getApprovals(runId: string, taskId: string): Promise<ApprovalRecord[]> {
    return getApprovals(this.client, runId, taskId);
  }

  async saveReviewFloorReduction(record: ReviewFloorReductionRecord): Promise<void> {
    return saveReviewFloorReduction(this.client, record);
  }

  async getReviewFloorReductions(runId: string, taskId: string): Promise<ReviewFloorReductionRecord[]> {
    return getReviewFloorReductions(this.client, runId, taskId);
  }

  async saveMemoryEntry(entry: MemoryEntryRecord): Promise<void> {
    return saveMemoryEntry(this.client, entry);
  }

  async listMemoryEntries(params: {
    runId: string;
    taskId?: string | undefined;
    entryType?: MemoryEntryRecord["entryType"] | undefined;
    status?: MemoryEntryRecord["status"] | undefined;
  }): Promise<MemoryEntryRecord[]> {
    return listMemoryEntries(this.client, params);
  }

  async replaceMarkdownArtifacts(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    artifacts: readonly MarkdownArtifactRecord[];
  }): Promise<void> {
    return replaceMarkdownArtifacts(this.client, input);
  }

  async queueEmbeddingJob(input: QueueEmbeddingJobInput): Promise<EmbeddingJobRecord> {
    return this.embeddingJobs.queueEmbeddingJob(input);
  }

  async leaseEmbeddingJobs(input: LeaseEmbeddingJobsInput): Promise<EmbeddingJobRecord[]> {
    return this.embeddingJobs.leaseEmbeddingJobs(input);
  }

  async getEmbeddingSource(
    sourceTable: EmbeddingJobSourceTable,
    sourceId: string
  ): Promise<EmbeddingSourceRecord | undefined> {
    return this.embeddingJobs.getEmbeddingSource(sourceTable, sourceId);
  }

  async completeEmbeddingJob(input: CompleteEmbeddingJobInput): Promise<void> {
    return this.embeddingJobs.completeEmbeddingJob(input);
  }

  async failEmbeddingJob(jobId: string, errorMessage: string): Promise<void> {
    return this.embeddingJobs.failEmbeddingJob(jobId, errorMessage);
  }

  async searchMemory(params: {
    workspaceSlug: string;
    projectSlug: string;
    query: string;
    limit: number;
    includeGlobal: boolean;
    queryEmbedding?: readonly number[] | undefined;
    embeddingModel?: string | undefined;
    requesterRole?: RetrievalRole | undefined;
  }): Promise<SearchMemoryResult[]> {
    return searchMemory(this.client, params);
  }

  private async loadArtifactsByIds(
    projectSlug: string,
    artifactIds: readonly string[]
  ): Promise<
    Array<
      Pick<
        MarkdownArtifactRecord,
        "id" | "title" | "content" | "sourcePath" | "sourceAnchor" | "createdAt" | "kind" | "metadata" | "runId"
      >
    >
  > {
    return loadArtifactsByIds(this.client, projectSlug, artifactIds);
  }
}
