import {
  buildArtifactSearchResult,
  buildMemorySearchResult,
  buildWorkflowDocumentSearchResult,
  canRoleAccessRetrievalMetadata,
  compareMemorySearchResults,
  scoreSearchableResult
} from "../core/policy.ts";
import { DEFAULT_RETRIEVAL_ROLE } from "../domain/contracts.ts";
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
import type {
  ArchonStore,
  CompleteEmbeddingJobInput,
  EmbeddingJobRecord,
  EmbeddingJobSourceTable,
  EmbeddingSourceRecord,
  LeaseEmbeddingJobsInput,
  MistakeLedgerStoreLike,
  QueueEmbeddingJobInput
} from "./types.ts";
import type { MistakeOccurrenceRecord } from "../runtime/mistake-ledger.ts";

function zonedIsoDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function isoDateWithinRange(
  isoDate: string,
  range: { dateFrom?: string | undefined; dateTo?: string | undefined }
): boolean {
  if (range.dateFrom && isoDate < range.dateFrom) {
    return false;
  }

  if (range.dateTo && isoDate > range.dateTo) {
    return false;
  }

  return true;
}

interface EmbeddingVectorRecord {
  embedding: readonly number[];
  embeddingModel: string;
  updatedAt: string;
}

function embeddingJobKey(input: Pick<QueueEmbeddingJobInput, "sourceTable" | "sourceId" | "embeddingModel">): string {
  return `${input.sourceTable}:${input.sourceId}:${input.embeddingModel}`;
}

function matchesWorkflowDocumentQuery(document: WorkflowDocumentRecord, query: string): boolean {
  return (
    scoreSearchableResult(
      {
        title: document.title,
        content: document.body,
        scope: "project"
      },
      query,
      true
    ) > 4
  );
}

function cloneProjectRuntimeState(
  state: ProjectRuntimeStateRecord | undefined
): ProjectRuntimeStateRecord | undefined {
  return state ? structuredClone(state) : undefined;
}

export class MemoryStore implements ArchonStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly plans = new Map<string, PlanArtifact>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly locks = new Map<string, LockRecord>();
  private readonly handoffs = new Map<string, HandoffRecord>();
  private readonly reviews = new Map<string, ReviewRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly reviewFloorReductions = new Map<string, ReviewFloorReductionRecord>();
  private readonly memoryEntries = new Map<string, MemoryEntryRecord>();
  private readonly markdownArtifacts = new Map<string, MarkdownArtifactRecord>();
  private readonly runtimeProjectRegistrations = new Map<string, RuntimeProjectRegistrationRecord>();
  private readonly runtimeMigrationJournals = new Map<string, RuntimeMigrationJournalRecord>();
  private readonly projectRuntimeStates = new Map<string, ProjectRuntimeStateRecord>();
  private readonly workflowDocuments = new Map<string, WorkflowDocumentRecord>();
  private readonly embeddingJobs = new Map<string, EmbeddingJobRecord>();
  private readonly artifactEmbeddings = new Map<string, EmbeddingVectorRecord>();
  private readonly memoryEntryEmbeddings = new Map<string, EmbeddingVectorRecord>();

  async ensureProjectContext(params: {
    workspaceSlug: string;
    workspaceName?: string | undefined;
    projectSlug: string;
    projectName?: string | undefined;
    repoPath?: string | undefined;
  }): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord }> {
    const now = new Date().toISOString();
    const workspace =
      this.workspaces.get(params.workspaceSlug) ??
      {
        id: `workspace:${params.workspaceSlug}`,
        slug: params.workspaceSlug,
        name: params.workspaceName ?? params.workspaceSlug,
        createdAt: now
      };
    this.workspaces.set(workspace.slug, workspace);

    const projectKey = `${params.workspaceSlug}:${params.projectSlug}`;
    const project =
      this.projects.get(projectKey) ??
      {
        id: `project:${projectKey}`,
        workspaceId: workspace.id,
        slug: params.projectSlug,
        name: params.projectName ?? params.projectSlug,
        repoPath: params.repoPath,
        createdAt: now
      };
    this.projects.set(projectKey, project);

    return { workspace, project };
  }

  async getProjectContext(params: {
    workspaceSlug: string;
    projectSlug: string;
  }): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined> {
    const workspace = this.workspaces.get(params.workspaceSlug);
    const project = this.projects.get(`${params.workspaceSlug}:${params.projectSlug}`);
    if (!workspace || !project) {
      return undefined;
    }

    return { workspace, project };
  }

  async saveProjectRuntimeRegistration(registration: RuntimeProjectRegistrationRecord): Promise<void> {
    this.runtimeProjectRegistrations.set(registration.projectId, registration);
  }

  async getProjectRuntimeRegistration(projectId: string): Promise<RuntimeProjectRegistrationRecord | undefined> {
    return this.runtimeProjectRegistrations.get(projectId);
  }

  async saveRuntimeMigrationJournal(journal: RuntimeMigrationJournalRecord): Promise<void> {
    this.runtimeMigrationJournals.set(journal.id, journal);
  }

  async listRuntimeMigrationJournals(projectId: string): Promise<RuntimeMigrationJournalRecord[]> {
    return [...this.runtimeMigrationJournals.values()]
      .filter((journal) => journal.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async saveProjectRuntimeState(state: ProjectRuntimeStateRecord): Promise<void> {
    this.projectRuntimeStates.set(state.projectId, cloneProjectRuntimeState(state)!);
  }

  async getProjectRuntimeState(projectId: string): Promise<ProjectRuntimeStateRecord | undefined> {
    return cloneProjectRuntimeState(this.projectRuntimeStates.get(projectId));
  }

  async saveWorkflowDocument(document: WorkflowDocumentRecord): Promise<void> {
    this.workflowDocuments.set(document.id, document);
  }

  async listWorkflowDocuments(params: {
    projectId: string;
    runId?: string | undefined;
    taskId?: string | undefined;
    kind?: WorkflowDocumentRecord["kind"] | undefined;
  }): Promise<WorkflowDocumentRecord[]> {
    return [...this.workflowDocuments.values()]
      .filter((document) => document.projectId === params.projectId)
      .filter((document) => (params.runId ? document.runId === params.runId : true))
      .filter((document) => (params.taskId ? document.taskId === params.taskId : true))
      .filter((document) => (params.kind ? document.kind === params.kind : true))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, run);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }

  async findLatestRun(params: { workspaceSlug: string; projectSlug: string }): Promise<RunRecord | undefined> {
    const project = this.projects.get(`${params.workspaceSlug}:${params.projectSlug}`);
    if (!project) {
      return undefined;
    }

    return [...this.runs.values()]
      .filter((run) => run.projectId === project.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async findLatestRunForTask(params: {
    workspaceSlug: string;
    projectSlug: string;
    taskId: string;
  }): Promise<RunRecord | undefined> {
    const project = this.projects.get(`${params.workspaceSlug}:${params.projectSlug}`);
    if (!project) {
      return undefined;
    }

    const runs = [...this.runs.values()]
      .filter((run) => run.projectId === project.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    for (const run of runs) {
      const hasTask = [...this.tasks.values()].some(
        (task) => task.runId === run.id && task.packet.taskId === params.taskId
      );
      if (hasTask) {
        return run;
      }
    }

    return undefined;
  }

  async findRunsByProjectActivity(params: {
    workspaceSlug: string;
    projectSlug: string;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    timezone: string;
  }): Promise<RunRecord[]> {
    const project = this.projects.get(`${params.workspaceSlug}:${params.projectSlug}`);
    if (!project) {
      return [];
    }

    return [...this.runs.values()]
      .filter((run) => run.projectId === project.id)
      .filter((run) => {
        const plan = this.plans.get(run.id);

        const activityTimestamps = [
          run.createdAt,
          run.updatedAt,
          ...(plan ? [plan.createdAt] : []),
          ...awaitableTaskDates(run.id, this.tasks),
          ...awaitableCreatedDates(run.id, [], this.handoffs),
          ...awaitableCreatedDates(run.id, [], this.reviews),
          ...awaitableCreatedDates(run.id, [], this.approvals),
          ...awaitableMemoryEntryDates(run.id, this.memoryEntries)
        ];

        return activityTimestamps.some((timestamp) =>
          isoDateWithinRange(zonedIsoDate(timestamp, params.timezone), {
            dateFrom: params.dateFrom,
            dateTo: params.dateTo
          })
        );
      })
      .sort((left, right) => {
        const leftDate = zonedIsoDate(left.updatedAt, params.timezone);
        const rightDate = zonedIsoDate(right.updatedAt, params.timezone);
        if (leftDate === rightDate) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return leftDate.localeCompare(rightDate);
      });
  }

  async updateRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, run);
  }

  async savePlan(plan: PlanArtifact): Promise<void> {
    this.plans.set(plan.runId, plan);
  }

  async getPlan(runId: string): Promise<PlanArtifact | undefined> {
    return this.plans.get(runId);
  }

  async replaceTasks(tasks: TaskRecord[]): Promise<void> {
    for (const task of [...this.tasks.values()]) {
      if (task.runId === tasks[0]?.runId) {
        this.tasks.delete(task.id);
      }
    }

    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }

  async getTasksByRun(runId: string): Promise<TaskRecord[]> {
    return [...this.tasks.values()].filter((task) => task.runId === runId);
  }

  async getTask(runId: string, taskId: string): Promise<TaskRecord | undefined> {
    return [...this.tasks.values()].find(
      (task) => task.runId === runId && task.packet.taskId === taskId
    );
  }

  async updateTask(task: TaskRecord): Promise<void> {
    // Guard: the `class` field is immutable after creation. Throw if the
    // caller attempts to change it.
    const existing = this.tasks.get(task.id);
    if (existing !== undefined && existing.class !== task.class) {
      throw new Error(
        `updateTask: cannot mutate immutable field 'class' on task ${task.id} ` +
        `(persisted='${existing.class}', attempted='${task.class}')`
      );
    }
    this.tasks.set(task.id, task);
  }

  async createLock(lock: LockRecord): Promise<void> {
    this.locks.set(lock.id, lock);
  }

  async releaseLocksForTask(runId: string, taskId: string, releasedAt: string): Promise<void> {
    for (const lock of this.locks.values()) {
      if (lock.runId === runId && lock.taskId === taskId && lock.status === "active") {
        this.locks.set(lock.id, {
          ...lock,
          status: "released",
          releasedAt
        });
      }
    }
  }

  async getActiveLocks(projectId: string): Promise<LockRecord[]> {
    return [...this.locks.values()].filter(
      (lock) => lock.projectId === projectId && lock.status === "active"
    );
  }

  async saveHandoff(handoff: HandoffRecord): Promise<void> {
    this.handoffs.set(handoff.id, handoff);
  }

  async getHandoffs(runId: string, taskId: string): Promise<HandoffRecord[]> {
    return [...this.handoffs.values()].filter((handoff) => handoff.runId === runId && handoff.taskId === taskId);
  }

  async saveReview(review: ReviewRecord): Promise<void> {
    this.reviews.set(review.id, review);
  }

  async getReviews(runId: string, taskId: string): Promise<ReviewRecord[]> {
    return [...this.reviews.values()].filter((review) => review.runId === runId && review.taskId === taskId);
  }

  async saveApproval(approval: ApprovalRecord): Promise<void> {
    this.approvals.set(approval.id, approval);
  }

  async getApprovals(runId: string, taskId: string): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()].filter((approval) => approval.runId === runId && approval.taskId === taskId);
  }

  async saveReviewFloorReduction(record: ReviewFloorReductionRecord): Promise<void> {
    // Idempotent: key on (runId, taskId, decidedAt) — same as the DB UNIQUE constraint.
    const key = `${record.runId}:${record.taskId}:${record.decidedAt}`;
    if (!this.reviewFloorReductions.has(key)) {
      this.reviewFloorReductions.set(key, record);
    }
  }

  async getReviewFloorReductions(runId: string, taskId: string): Promise<ReviewFloorReductionRecord[]> {
    return [...this.reviewFloorReductions.values()]
      .filter((record) => record.runId === runId && record.taskId === taskId)
      .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt));
  }

  async saveMemoryEntry(entry: MemoryEntryRecord): Promise<void> {
    this.memoryEntries.set(entry.id, entry);
  }

  async listMemoryEntries(params: {
    runId: string;
    taskId?: string | undefined;
    entryType?: MemoryEntryRecord["entryType"] | undefined;
    status?: MemoryEntryRecord["status"] | undefined;
  }): Promise<MemoryEntryRecord[]> {
    return [...this.memoryEntries.values()]
      .filter((entry) => entry.runId === params.runId)
      .filter((entry) => (params.taskId ? entry.taskId === params.taskId : true))
      .filter((entry) => (params.entryType ? entry.entryType === params.entryType : true))
      .filter((entry) => (params.status ? entry.status === params.status : true))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async replaceMarkdownArtifacts(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    artifacts: readonly MarkdownArtifactRecord[];
  }): Promise<void> {
    const incomingIds = new Set(input.artifacts.map((artifact) => artifact.id));

    for (const artifact of [...this.markdownArtifacts.values()]) {
      if (artifact.projectId !== input.projectId) {
        continue;
      }

      if (incomingIds.has(artifact.id)) {
        continue;
      }

      this.markdownArtifacts.delete(artifact.id);
      this.artifactEmbeddings.delete(artifact.id);
      for (const job of [...this.embeddingJobs.values()]) {
        if (job.sourceTable === "artifacts" && job.sourceId === artifact.id) {
          this.embeddingJobs.delete(job.id);
        }
      }
    }

    for (const artifact of input.artifacts) {
      this.markdownArtifacts.set(artifact.id, artifact);
    }
  }

  async queueEmbeddingJob(input: QueueEmbeddingJobInput): Promise<EmbeddingJobRecord> {
    const timestamp = new Date().toISOString();
    this.clearDerivedEmbedding(input.sourceTable, input.sourceId);

    const existing = [...this.embeddingJobs.values()].find(
      (job) =>
        job.sourceTable === input.sourceTable &&
        job.sourceId === input.sourceId &&
        job.embeddingModel === input.embeddingModel
    );

    if (existing) {
      const queuedJob: EmbeddingJobRecord = {
        ...existing,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        status: "pending",
        errorMessage: undefined,
        updatedAt: timestamp
      };
      this.embeddingJobs.set(existing.id, queuedJob);
      return queuedJob;
    }

    const job: EmbeddingJobRecord = {
      id: `embedding-job:${embeddingJobKey(input)}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      sourceTable: input.sourceTable,
      sourceId: input.sourceId,
      embeddingModel: input.embeddingModel,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.embeddingJobs.set(job.id, job);
    return job;
  }

  async leaseEmbeddingJobs(input: LeaseEmbeddingJobsInput): Promise<EmbeddingJobRecord[]> {
    const leasedAt = new Date().toISOString();
    const pendingJobs = [...this.embeddingJobs.values()]
      .filter((job) => job.status === "pending")
      .sort((left, right) => {
        const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
        if (createdAtComparison !== 0) {
          return createdAtComparison;
        }

        return left.id.localeCompare(right.id);
      })
      .slice(0, input.limit)
      .map((job) => ({
        ...job,
        status: "processing" as const,
        updatedAt: leasedAt
      }));

    for (const job of pendingJobs) {
      this.embeddingJobs.set(job.id, job);
    }

    return pendingJobs;
  }

  async getEmbeddingSource(
    sourceTable: EmbeddingJobSourceTable,
    sourceId: string
  ): Promise<EmbeddingSourceRecord | undefined> {
    if (sourceTable === "memory_entries") {
      const entry = this.memoryEntries.get(sourceId);
      if (!entry) {
        return undefined;
      }

      return {
        sourceTable,
        sourceId,
        title: entry.title,
        content: entry.content
      };
    }

    const markdownArtifact = this.markdownArtifacts.get(sourceId);
    if (markdownArtifact) {
      return {
        sourceTable,
        sourceId,
        title: markdownArtifact.title,
        content: markdownArtifact.content
      };
    }

    const plan = [...this.plans.values()].find((candidate) => candidate.id === sourceId);
    if (plan) {
      return {
        sourceTable,
        sourceId,
        title: plan.title,
        content: JSON.stringify(plan.content)
      };
    }

    return undefined;
  }

  async completeEmbeddingJob(input: CompleteEmbeddingJobInput): Promise<void> {
    const existingJob = this.embeddingJobs.get(input.jobId);
    const completedAt = new Date().toISOString();

    if (!existingJob) {
      throw new Error(`embedding job not found: ${input.jobId}`);
    }

    if (
      existingJob.status !== "processing" ||
      existingJob.sourceTable !== input.sourceTable ||
      existingJob.sourceId !== input.sourceId ||
      existingJob.embeddingModel !== input.embeddingModel
    ) {
      throw new Error(`embedding job is not leased for completion: ${input.jobId}`);
    }

    this.setDerivedEmbedding(input.sourceTable, input.sourceId, {
      embedding: [...input.embedding],
      embeddingModel: input.embeddingModel,
      updatedAt: completedAt
    });
    this.embeddingJobs.set(input.jobId, {
      ...existingJob,
      status: "done",
      errorMessage: undefined,
      updatedAt: completedAt
    });
  }

  async failEmbeddingJob(jobId: string, errorMessage: string): Promise<void> {
    const existingJob = this.embeddingJobs.get(jobId);

    if (!existingJob) {
      throw new Error(`embedding job not found: ${jobId}`);
    }

    if (existingJob.status !== "processing") {
      throw new Error(`embedding job is not leased for failure: ${jobId}`);
    }

    this.embeddingJobs.set(jobId, {
      ...existingJob,
      status: "failed",
      errorMessage,
      updatedAt: new Date().toISOString()
    });
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
    const requesterRole = params.requesterRole ?? DEFAULT_RETRIEVAL_ROLE;
    const projectKey = `${params.workspaceSlug}:${params.projectSlug}`;
    const project = this.projects.get(projectKey);
    const memoryResults = [...this.memoryEntries.values()]
      .filter((entry) => entry.status === "approved")
      .filter((entry) => {
        const sameProject = project ? entry.projectId === project.id : false;
        const sameWorkspace = project ? entry.workspaceId === project.workspaceId : false;
        return sameProject || (sameWorkspace && params.includeGlobal && entry.scope === "global");
      })
      .filter((entry) => canRoleAccessRetrievalMetadata(entry.metadata, requesterRole))
      .map((entry) => {
        const sameProject = project ? entry.projectId === project.id : false;
        const baseResult = buildMemorySearchResult(
          entry,
          params.query,
          sameProject,
          sameProject ? params.projectSlug : undefined
        );
        return {
          ...baseResult,
          score: baseResult.score + this.vectorScoreBoost(entry.id, params.queryEmbedding, params.embeddingModel)
        };
      });

    const artifactResults = project
      ? [...this.markdownArtifacts.values()]
          .filter((artifact) => artifact.projectId === project.id)
          .filter((artifact) => canRoleAccessRetrievalMetadata(artifact.metadata, requesterRole))
          .map((artifact) => {
            const baseResult = buildArtifactSearchResult(artifact, params.query, params.projectSlug);
            return {
              ...baseResult,
              score: baseResult.score + this.vectorScoreBoost(artifact.id, params.queryEmbedding, params.embeddingModel, "artifacts")
            };
          })
      : [];

    const workflowDocumentResults = project
      ? [...this.workflowDocuments.values()]
          .filter((document) => document.projectId === project.id)
          .filter((document) => matchesWorkflowDocumentQuery(document, params.query))
          .filter((document) => canRoleAccessRetrievalMetadata(document.metadata, requesterRole))
          .map((document) => buildWorkflowDocumentSearchResult(document, params.query, params.projectSlug))
      : [];

    return [...memoryResults, ...artifactResults, ...workflowDocumentResults]
      .sort(compareMemorySearchResults)
      .slice(0, params.limit);
  }

  private clearDerivedEmbedding(sourceTable: EmbeddingJobSourceTable, sourceId: string): void {
    this.embeddingMapFor(sourceTable).delete(sourceId);
  }

  private setDerivedEmbedding(
    sourceTable: EmbeddingJobSourceTable,
    sourceId: string,
    embedding: EmbeddingVectorRecord
  ): void {
    this.embeddingMapFor(sourceTable).set(sourceId, embedding);
  }

  private embeddingMapFor(sourceTable: EmbeddingJobSourceTable): Map<string, EmbeddingVectorRecord> {
    return sourceTable === "artifacts" ? this.artifactEmbeddings : this.memoryEntryEmbeddings;
  }

  private vectorScoreBoost(
    entryId: string,
    queryEmbedding?: readonly number[] | undefined,
    embeddingModel?: string | undefined,
    sourceTable: EmbeddingJobSourceTable = "memory_entries"
  ): number {
    if (!queryEmbedding || !embeddingModel) {
      return 0;
    }

    const embeddingRecord = this.embeddingMapFor(sourceTable).get(entryId);
    if (!embeddingRecord || embeddingRecord.embeddingModel !== embeddingModel) {
      return 0;
    }

    return cosineSimilarity(queryEmbedding, embeddingRecord.embedding) * 6;
  }
}

function awaitableTaskDates(
  runId: string,
  tasks: ReadonlyMap<string, TaskRecord>
): string[] {
  return [...tasks.values()]
    .filter((task) => task.runId === runId)
    .flatMap((task) => [task.createdAt, task.updatedAt]);
}

function awaitableCreatedDates<RecordShape extends { runId: string; taskId: string; createdAt: string }>(
  runId: string,
  _taskIds: readonly string[],
  records: ReadonlyMap<string, RecordShape>
): string[] {
  return [...records.values()]
    .filter((record) => record.runId === runId)
    .map((record) => record.createdAt);
}

function awaitableMemoryEntryDates(
  runId: string,
  memoryEntries: ReadonlyMap<string, MemoryEntryRecord>
): string[] {
  return [...memoryEntries.values()]
    .filter((entry) => entry.runId === runId)
    .map((entry) => entry.createdAt);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

// ---------------------------------------------------------------------------
// MemoryMistakeLedgerStore — in-memory implementation for tests
// ---------------------------------------------------------------------------

/**
 * In-memory MistakeLedgerStoreLike for tests and local-only usage.
 * Persists occurrences in a Map<projectId, MistakeOccurrenceRecord[]>.
 * Idempotent by record id (upsert semantics: later record with same id wins).
 */
export class MemoryMistakeLedgerStore implements MistakeLedgerStoreLike {
  private readonly occurrences = new Map<string, Map<string, MistakeOccurrenceRecord>>();

  async appendMistakeOccurrences(
    projectId: string,
    incoming: readonly MistakeOccurrenceRecord[]
  ): Promise<void> {
    if (incoming.length === 0) {
      return;
    }
    const byId = this.occurrences.get(projectId) ?? new Map<string, MistakeOccurrenceRecord>();
    for (const occ of incoming) {
      byId.set(occ.id, occ);
    }
    this.occurrences.set(projectId, byId);
  }

  async listMistakeOccurrences(projectId: string): Promise<readonly MistakeOccurrenceRecord[]> {
    const byId = this.occurrences.get(projectId);
    return byId ? [...byId.values()] : [];
  }
}
