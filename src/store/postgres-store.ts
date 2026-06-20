import { randomUUID } from "node:crypto";
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
import {
  buildArtifactSearchResult,
  canRoleAccessRetrievalMetadata,
  compareMemorySearchResults
} from "../core/policy.ts";
import { DEFAULT_RETRIEVAL_ROLE } from "../domain/contracts.ts";
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
export interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<SqlQueryResult<Row>>;
}

interface JsonRow<T> {
  payload: T;
}

interface ArtifactHydrationRow {
  id: string;
  runId: string;
  kind: MarkdownArtifactRecord["kind"];
  title: string;
  content: string;
  sourcePath: string | null;
  sourceAnchor: string | null;
  metadata: MarkdownArtifactRecord["metadata"] | null;
  createdAt: string;
}

function now(): string {
  return new Date().toISOString();
}

async function withTransaction<T>(client: SqlClient, work: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const value = await work();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export class PostgresStore implements ArchonStore {
  private readonly client: SqlClient;
  private readonly embeddingJobs: PostgresEmbeddingJobs;

  constructor(client: SqlClient) {
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
    const workspace = {
      id: `workspace:${params.workspaceSlug}`,
      slug: params.workspaceSlug,
      name: params.workspaceName ?? params.workspaceSlug,
      createdAt: now()
    };

    await this.client.query(
      `insert into workspaces (id, slug, name)
       values ($1, $2, $3)
       on conflict (slug) do update set name = excluded.name`,
      [workspace.id, workspace.slug, workspace.name]
    );

    const project = {
      id: `project:${params.workspaceSlug}:${params.projectSlug}`,
      workspaceId: workspace.id,
      slug: params.projectSlug,
      name: params.projectName ?? params.projectSlug,
      repoPath: params.repoPath,
      createdAt: now()
    };

    await this.client.query(
      `insert into projects (id, workspace_id, slug, name, repo_path)
       values ($1, $2, $3, $4, $5)
       on conflict (workspace_id, slug) do update
       set name = excluded.name,
           repo_path = excluded.repo_path`,
      [project.id, project.workspaceId, project.slug, project.name, project.repoPath ?? null]
    );

    return { workspace, project };
  }

  async getProjectContext(params: {
    workspaceSlug: string;
    projectSlug: string;
  }): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined> {
    const result = await this.client.query<JsonRow<{ workspace: WorkspaceRecord; project: ProjectRecord }>>(
      `select jsonb_build_object(
          'workspace', jsonb_build_object(
            'id', w.id,
            'slug', w.slug,
            'name', w.name,
            'createdAt', w.created_at
          ),
          'project', jsonb_build_object(
            'id', p.id,
            'workspaceId', p.workspace_id,
            'slug', p.slug,
            'name', p.name,
            'repoPath', p.repo_path,
            'createdAt', p.created_at
          )
       ) as payload
       from projects p
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1 and p.slug = $2`,
      [params.workspaceSlug, params.projectSlug]
    );

    return result.rows[0]?.payload;
  }

  async saveProjectRuntimeRegistration(registration: RuntimeProjectRegistrationRecord): Promise<void> {
    await this.client.query(
      `insert into runtime_project_registrations (
         project_id,
         workspace_id,
         repo_path,
         runtime_profile,
         data_root,
         install_manifest_path,
         manifest,
         provenance
       )
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       on conflict (project_id) do update
       set workspace_id = excluded.workspace_id,
           repo_path = excluded.repo_path,
           runtime_profile = excluded.runtime_profile,
           data_root = excluded.data_root,
           install_manifest_path = excluded.install_manifest_path,
           manifest = excluded.manifest,
           provenance = excluded.provenance,
           updated_at = now()`,
      [
        registration.projectId,
        registration.workspaceId,
        registration.repoPath,
        registration.runtimeProfile,
        registration.dataRoot,
        registration.installManifestPath ?? null,
        JSON.stringify(registration.manifest),
        JSON.stringify(registration.provenance)
      ]
    );
  }

  async getProjectRuntimeRegistration(
    projectId: string
  ): Promise<RuntimeProjectRegistrationRecord | undefined> {
    const result = await this.client.query<JsonRow<RuntimeProjectRegistrationRecord>>(
      `select jsonb_build_object(
          'projectId', project_id,
          'workspaceId', workspace_id,
          'repoPath', repo_path,
          'runtimeProfile', runtime_profile,
          'dataRoot', data_root,
          'installManifestPath', install_manifest_path,
          'manifest', manifest,
          'provenance', provenance,
          'createdAt', created_at,
          'updatedAt', updated_at
       ) as payload
       from runtime_project_registrations
       where project_id = $1`,
      [projectId]
    );
    return result.rows[0]?.payload;
  }

  async saveRuntimeMigrationJournal(journal: RuntimeMigrationJournalRecord): Promise<void> {
    await this.client.query(
      `insert into runtime_migration_journals (
         id,
         workspace_id,
         project_id,
         run_id,
         phase,
         status,
         backup_manifest_path,
         verification_report_path,
         rollback_state,
         details
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       on conflict (id) do update
       set workspace_id = excluded.workspace_id,
           project_id = excluded.project_id,
           run_id = excluded.run_id,
           phase = excluded.phase,
           status = excluded.status,
           backup_manifest_path = excluded.backup_manifest_path,
           verification_report_path = excluded.verification_report_path,
           rollback_state = excluded.rollback_state,
           details = excluded.details,
           updated_at = now()`,
      [
        journal.id,
        journal.workspaceId,
        journal.projectId,
        journal.runId ?? null,
        journal.phase,
        journal.status,
        journal.backupManifestPath,
        journal.verificationReportPath,
        journal.rollbackState,
        JSON.stringify(journal.details)
      ]
    );
  }

  async listRuntimeMigrationJournals(projectId: string): Promise<RuntimeMigrationJournalRecord[]> {
    const result = await this.client.query<JsonRow<RuntimeMigrationJournalRecord>>(
      `select jsonb_build_object(
          'id', id,
          'workspaceId', workspace_id,
          'projectId', project_id,
          'runId', run_id,
          'phase', phase,
          'status', status,
          'backupManifestPath', backup_manifest_path,
          'verificationReportPath', verification_report_path,
          'rollbackState', rollback_state,
          'details', details,
          'createdAt', created_at,
          'updatedAt', updated_at
       ) as payload
       from runtime_migration_journals
       where project_id = $1
       order by created_at asc`,
      [projectId]
    );
    return result.rows.map((row) => row.payload);
  }

  async saveProjectRuntimeState(state: ProjectRuntimeStateRecord): Promise<void> {
    await this.client.query(
      `insert into project_runtime_state (
         project_id,
         workspace_id,
         active_run_id,
         active_task_id,
         task_queue,
         product_state,
         last_verified_run_id,
         metadata
       )
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb)
       on conflict (project_id) do update
       set workspace_id = excluded.workspace_id,
           active_run_id = excluded.active_run_id,
           active_task_id = excluded.active_task_id,
           task_queue = excluded.task_queue,
           product_state = excluded.product_state,
           last_verified_run_id = excluded.last_verified_run_id,
           metadata = excluded.metadata,
           updated_at = now()`,
      [
        state.projectId,
        state.workspaceId,
        state.activeRunId ?? null,
        state.activeTaskId ?? null,
        JSON.stringify(state.taskQueue),
        JSON.stringify(state.productState),
        state.lastVerifiedRunId ?? null,
        JSON.stringify(state.metadata)
      ]
    );
  }

  async getProjectRuntimeState(projectId: string): Promise<ProjectRuntimeStateRecord | undefined> {
    const result = await this.client.query<JsonRow<ProjectRuntimeStateRecord>>(
      `select jsonb_build_object(
          'projectId', project_id,
          'workspaceId', workspace_id,
          'activeRunId', active_run_id,
          'activeTaskId', active_task_id,
          'taskQueue', task_queue,
          'productState', product_state,
          'lastVerifiedRunId', last_verified_run_id,
          'metadata', metadata,
          'createdAt', created_at,
          'updatedAt', updated_at
       ) as payload
       from project_runtime_state
       where project_id = $1`,
      [projectId]
    );

    return result.rows[0]?.payload;
  }

  async saveWorkflowDocument(document: WorkflowDocumentRecord): Promise<void> {
    await this.client.query(
      `insert into workflow_documents (
         id,
         workspace_id,
         project_id,
         run_id,
         task_id,
         kind,
         title,
         body,
         metadata
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       on conflict (id) do update
       set workspace_id = excluded.workspace_id,
           project_id = excluded.project_id,
           run_id = excluded.run_id,
           task_id = excluded.task_id,
           kind = excluded.kind,
           title = excluded.title,
           body = excluded.body,
           metadata = excluded.metadata,
           updated_at = now()`,
      [
        document.id,
        document.workspaceId,
        document.projectId,
        document.runId ?? null,
        document.taskId ?? null,
        document.kind,
        document.title,
        document.body,
        JSON.stringify(document.metadata)
      ]
    );
  }

  async listWorkflowDocuments(params: {
    projectId: string;
    runId?: string | undefined;
    taskId?: string | undefined;
    kind?: WorkflowDocumentRecord["kind"] | undefined;
  }): Promise<WorkflowDocumentRecord[]> {
    const clauses = ["project_id = $1"];
    const values: unknown[] = [params.projectId];

    if (params.runId) {
      values.push(params.runId);
      clauses.push(`run_id = $${values.length}`);
    }
    if (params.taskId) {
      values.push(params.taskId);
      clauses.push(`task_id = $${values.length}`);
    }
    if (params.kind) {
      values.push(params.kind);
      clauses.push(`kind = $${values.length}`);
    }

    const result = await this.client.query<JsonRow<WorkflowDocumentRecord>>(
      `select jsonb_build_object(
          'id', id,
          'workspaceId', workspace_id,
          'projectId', project_id,
          'runId', run_id,
          'taskId', task_id,
          'kind', kind,
          'title', title,
          'body', body,
          'metadata', metadata,
          'createdAt', created_at,
          'updatedAt', updated_at
       ) as payload
       from workflow_documents
       where ${clauses.join(" and ")}
       order by created_at asc`,
      values
    );

    return result.rows.map((row) => row.payload);
  }

  async createRun(run: RunRecord): Promise<void> {
    await this.client.query(
      `insert into runs (id, workspace_id, project_id, actor, title, request_text, intake_summary, status)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        run.id,
        run.workspaceId,
        run.projectId,
        run.actor,
        run.title,
        run.request,
        JSON.stringify(run.summary),
        run.status
      ]
    );
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const result = await this.client.query<JsonRow<RunRecord>>(
      `select jsonb_build_object(
          'id', id,
          'workspaceId', workspace_id,
          'projectId', project_id,
          'actor', actor,
          'title', title,
          'request', request_text,
          'summary', intake_summary,
          'status', status,
          'createdAt', created_at,
          'updatedAt', updated_at
       ) as payload
       from runs
       where id = $1`,
      [runId]
    );
    return result.rows[0]?.payload;
  }

  async findLatestRun(params: { workspaceSlug: string; projectSlug: string }): Promise<RunRecord | undefined> {
    const result = await this.client.query<JsonRow<RunRecord>>(
      `select jsonb_build_object(
          'id', r.id,
          'workspaceId', r.workspace_id,
          'projectId', r.project_id,
          'actor', r.actor,
          'title', r.title,
          'request', r.request_text,
          'summary', r.intake_summary,
          'status', r.status,
          'createdAt', r.created_at,
          'updatedAt', r.updated_at
       ) as payload
       from runs r
       join projects p on p.id = r.project_id
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1 and p.slug = $2
       order by r.updated_at desc
       limit 1`,
      [params.workspaceSlug, params.projectSlug]
    );
    return result.rows[0]?.payload;
  }

  async findLatestRunForTask(params: {
    workspaceSlug: string;
    projectSlug: string;
    taskId: string;
  }): Promise<RunRecord | undefined> {
    const result = await this.client.query<JsonRow<RunRecord>>(
      `select jsonb_build_object(
          'id', r.id,
          'workspaceId', r.workspace_id,
          'projectId', r.project_id,
          'actor', r.actor,
          'title', r.title,
          'request', r.request_text,
          'summary', r.intake_summary,
          'status', r.status,
          'createdAt', r.created_at,
          'updatedAt', r.updated_at
       ) as payload
       from runs r
       join projects p on p.id = r.project_id
       join workspaces w on w.id = p.workspace_id
       join tasks t on t.run_id = r.id
       where w.slug = $1 and p.slug = $2 and t.task_key = $3
       order by r.updated_at desc
       limit 1`,
      [params.workspaceSlug, params.projectSlug, params.taskId]
    );
    return result.rows[0]?.payload;
  }

  async findRunsByProjectActivity(params: {
    workspaceSlug: string;
    projectSlug: string;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    timezone: string;
  }): Promise<RunRecord[]> {
    const result = await this.client.query<JsonRow<RunRecord>>(
      `select jsonb_build_object(
          'id', r.id,
          'workspaceId', r.workspace_id,
          'projectId', r.project_id,
          'actor', r.actor,
          'title', r.title,
          'request', r.request_text,
          'summary', r.intake_summary,
          'status', r.status,
          'createdAt', r.created_at,
          'updatedAt', r.updated_at
       ) as payload
       from runs r
       join projects p on p.id = r.project_id
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1
         and p.slug = $2
         and (
           ($3::date is null and $4::date is null)
           or ((r.created_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
           or ((r.updated_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
           or exists (
             select 1
             from artifacts a
             where a.run_id = r.id
               and a.kind = 'plan'
               and ((a.created_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
           )
           or exists (
             select 1
             from tasks t
             where t.run_id = r.id
               and (
                 ((t.created_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
                 or ((t.updated_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
               )
           )
           or exists (
             select 1
             from handoffs h
             where h.run_id = r.id
               and ((h.created_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
           )
           or exists (
             select 1
             from reviews rv
             where rv.run_id = r.id
               and ((rv.created_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
           )
           or exists (
             select 1
             from approvals ap
             where ap.run_id = r.id
               and ((ap.created_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
           )
           or exists (
             select 1
             from memory_entries me
             where me.run_id = r.id
               and ((me.created_at at time zone $5)::date between coalesce($3::date, '-infinity'::date) and coalesce($4::date, 'infinity'::date))
           )
         )
       order by ((r.updated_at at time zone $5)::date) asc, r.created_at asc`,
      [
        params.workspaceSlug,
        params.projectSlug,
        params.dateFrom ?? null,
        params.dateTo ?? null,
        params.timezone
      ]
    );
    return result.rows.map((row) => row.payload);
  }

  async updateRun(run: RunRecord): Promise<void> {
    await this.client.query(
      `update runs
       set actor = $2,
           title = $3,
           request_text = $4,
           intake_summary = $5::jsonb,
           status = $6,
           updated_at = now()
       where id = $1`,
      [run.id, run.actor, run.title, run.request, JSON.stringify(run.summary), run.status]
    );
  }

  async savePlan(plan: PlanArtifact): Promise<void> {
    await this.client.query(
      `insert into artifacts (id, workspace_id, project_id, run_id, task_id, kind, title, content, metadata)
       select $1, r.workspace_id, r.project_id, $2, null, 'plan', $3, $4, $5::jsonb
       from runs r
       where r.id = $2
       on conflict (id) do update
       set title = excluded.title,
           content = excluded.content,
           metadata = excluded.metadata`,
      [plan.id, plan.runId, plan.title, JSON.stringify(plan.content), JSON.stringify({ kind: "plan" })]
    );
  }

  async getPlan(runId: string): Promise<PlanArtifact | undefined> {
    const result = await this.client.query<JsonRow<PlanArtifact>>(
      `select jsonb_build_object(
          'id', id,
          'runId', run_id,
          'kind', 'plan',
          'title', title,
          'content', content::jsonb,
          'createdAt', created_at
       ) as payload
       from artifacts
       where run_id = $1 and kind = 'plan'
       order by created_at desc
       limit 1`,
      [runId]
    );
    return result.rows[0]?.payload;
  }

  async replaceTasks(tasks: TaskRecord[]): Promise<void> {
    if (tasks.length === 0) {
      return;
    }

    const runId = tasks[0]!.runId;
    await this.client.query(`delete from task_dependencies where task_id in (select id from tasks where run_id = $1)`, [runId]);
    await this.client.query(`delete from tasks where run_id = $1`, [runId]);

    for (const task of tasks) {
      await this.client.query(
        `insert into tasks (
          id, workspace_id, project_id, run_id, task_key, title, owner_role, status,
          allowed_write_scope, out_of_scope, acceptance_criteria, verification_steps,
          required_reviews, security_checks, anti_patterns, rollback_notes, handoff_format,
          payload, claimed_by, "class"
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15, $16, $17,
          $18::jsonb, $19, $20
        )`,
        [
          task.id,
          task.workspaceId,
          task.projectId,
          task.runId,
          task.packet.taskId,
          task.packet.title,
          task.packet.ownerRole,
          task.status,
          task.packet.allowedWriteScope,
          task.packet.outOfScope,
          task.packet.acceptanceCriteria,
          task.packet.verificationSteps,
          task.packet.requiredReviews,
          task.packet.securityChecks,
          task.packet.antiPatterns,
          task.packet.rollbackNotes,
          task.packet.handoffFormat,
          JSON.stringify(task.packet),
          task.claimedBy ?? null,
          task.class
        ]
      );

      for (const dependency of task.packet.dependencies) {
        await this.client.query(
          `insert into task_dependencies (task_id, depends_on_task_key) values ($1, $2)`,
          [task.id, dependency]
        );
      }
    }
  }

  async getTasksByRun(runId: string): Promise<TaskRecord[]> {
    const result = await this.client.query<JsonRow<TaskRecord>>(
      `select jsonb_build_object(
          'id', id,
          'runId', run_id,
          'workspaceId', workspace_id,
          'projectId', project_id,
          'class', "class",
          'packet', payload::jsonb,
          'status', status,
          'claimedBy', claimed_by,
          'createdAt', created_at,
          'updatedAt', updated_at
       ) as payload
       from tasks
       where run_id = $1
       order by created_at asc`,
      [runId]
    );
    return result.rows.map((row) => row.payload);
  }

  async getTask(runId: string, taskId: string): Promise<TaskRecord | undefined> {
    const result = await this.client.query<JsonRow<TaskRecord>>(
      `select jsonb_build_object(
          'id', id,
          'runId', run_id,
          'workspaceId', workspace_id,
          'projectId', project_id,
          'class', "class",
          'packet', payload::jsonb,
          'status', status,
          'claimedBy', claimed_by,
          'createdAt', created_at,
          'updatedAt', updated_at
       ) as payload
       from tasks
       where run_id = $1 and task_key = $2`,
      [runId, taskId]
    );
    return result.rows[0]?.payload;
  }

  async updateTask(task: TaskRecord): Promise<void> {
    // Guard: the `class` column is immutable after INSERT. Verify the caller
    // is not attempting to mutate it by comparing with the persisted value.
    const existing = await this.client.query<{ class: string }>(
      `select "class" from tasks where id = $1`,
      [task.id]
    );
    if (existing.rows.length > 0) {
      const persistedClass = existing.rows[0]!.class;
      if (persistedClass !== task.class) {
        throw new Error(
          `updateTask: cannot mutate immutable field 'class' on task ${task.id} ` +
          `(persisted='${persistedClass}', attempted='${task.class}')`
        );
      }
    }
    await this.client.query(
      `update tasks
       set status = $2,
           claimed_by = $3,
           payload = $4::jsonb,
           updated_at = now()
       where id = $1`,
      [task.id, task.status, task.claimedBy ?? null, JSON.stringify(task.packet)]
    );
  }

  async createLock(lock: LockRecord): Promise<void> {
    await this.client.query(
      `insert into locks (id, workspace_id, project_id, run_id, task_id, scope_paths, status)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [lock.id, lock.workspaceId, lock.projectId, lock.runId, lock.taskId, lock.scopePaths, lock.status]
    );
  }

  async releaseLocksForTask(runId: string, taskId: string, releasedAt: string): Promise<void> {
    await this.client.query(
      `update locks
       set status = 'released',
           released_at = $3
       where run_id = $1 and task_id = $2 and status = 'active'`,
      [runId, taskId, releasedAt]
    );
  }

  async getActiveLocks(projectId: string): Promise<LockRecord[]> {
    const result = await this.client.query<JsonRow<LockRecord>>(
      `select jsonb_build_object(
          'id', id,
          'workspaceId', workspace_id,
          'projectId', project_id,
          'runId', run_id,
          'taskId', task_id,
          'scopePaths', scope_paths,
          'status', status,
          'createdAt', created_at,
          'releasedAt', released_at
       ) as payload
       from locks
       where project_id = $1 and status = 'active'`,
      [projectId]
    );
    return result.rows.map((row) => row.payload);
  }

  async saveHandoff(handoff: HandoffRecord): Promise<void> {
    await this.client.query(
      `insert into handoffs (
         id, workspace_id, project_id, run_id, task_id, actor, owner_role, completion_standard, summary,
         changed_files, blockers, verification_notes, execution_evidence, quality_gate_evidence, context_refs
       )
       select $1, r.workspace_id, r.project_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       from runs r
       where r.id = $2`,
      [
        handoff.id,
        handoff.runId,
        handoff.taskId,
        handoff.actor,
        handoff.ownerRole,
        handoff.completionStandard,
        handoff.summary,
        handoff.changedFiles,
        handoff.blockers,
        handoff.verificationNotes,
        handoff.executionEvidence,
        handoff.qualityGateEvidence,
        handoff.contextRefs
      ]
    );
  }

  async getHandoffs(runId: string, taskId: string): Promise<HandoffRecord[]> {
    const result = await this.client.query<JsonRow<HandoffRecord>>(
      `select jsonb_build_object(
          'id', id,
          'runId', run_id,
          'taskId', task_id,
          'actor', actor,
          'ownerRole', owner_role,
          'completionStandard', completion_standard,
          'summary', summary,
          'changedFiles', changed_files,
          'blockers', blockers,
          'verificationNotes', verification_notes,
          'executionEvidence', execution_evidence,
          'qualityGateEvidence', quality_gate_evidence,
          'contextRefs', context_refs,
          'createdAt', created_at
       ) as payload
       from handoffs
       where run_id = $1
         and task_id = $2
       order by created_at asc`,
      [runId, taskId]
    );
    return result.rows.map((row) => row.payload);
  }

  async saveReview(review: ReviewRecord): Promise<void> {
    await this.client.query(
      `insert into reviews (
         id, workspace_id, project_id, run_id, task_id, reviewer_role, actor, actor_role,
         source, state, severity, findings, waiver_reason, evidence_refs
       )
       select $1, r.workspace_id, r.project_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       from runs r
       where r.id = $2`,
      [
        review.id,
        review.runId,
        review.taskId,
        review.reviewerRole,
        review.actor,
        review.actorRole,
        review.source,
        review.state,
        review.severity,
        review.findings,
        review.waiverReason ?? null,
        review.evidenceRefs ?? []
      ]
    );
  }

  async getReviews(runId: string, taskId: string): Promise<ReviewRecord[]> {
    const result = await this.client.query<JsonRow<ReviewRecord>>(
      `select jsonb_build_object(
          'id', id,
          'runId', run_id,
          'taskId', task_id,
          'reviewerRole', reviewer_role,
          'actor', actor,
          'actorRole', actor_role,
          'source', source,
          'state', state,
          'severity', severity,
          'findings', findings,
          'waiverReason', waiver_reason,
          'evidenceRefs', evidence_refs,
          'createdAt', created_at
       ) as payload
       from reviews
       where run_id = $1
         and task_id = $2
       order by created_at asc`,
      [runId, taskId]
    );
    return result.rows.map((row) => row.payload);
  }

  async getOrchestratorReviews(taskId: string): Promise<{ role: string; outcome: string; source: string }[]> {
    const result = await this.client.query<{ role: string; outcome: string; source: string }>(
      `select
         reviewer_role as role,
         state as outcome,
         source
       from reviews
       where task_id = $1
         and source = 'orchestrator'
       order by created_at asc`,
      [taskId]
    );
    return result.rows;
  }

  async saveOrchestratorReview(input: {
    taskId: string;
    role: string;
    outcome: string;
    findings: string;
    workspaceId: string;
    projectId: string;
    runId?: string | null | undefined;
  }): Promise<void> {
    const id = randomUUID();
    const state = input.outcome === "passed" ? "passed" : "blocked";
    // Two-authorities fix: persist the run id so the Stop-hook's run-scoped review
    // query can no longer be satisfied by a run-agnostic (null) review row that
    // would otherwise apply to every run.
    await this.client.query(
      `insert into reviews (
         id, workspace_id, project_id, run_id, task_id, reviewer_role, actor, actor_role,
         state, severity, findings, waiver_reason, evidence_refs, source
       )
       values ($1, $2, $3, $4, $5, $6, 'review-orchestrator', $9,
               $7, 'low', $8, null, '{}', 'orchestrator')`,
      [
        id,
        input.workspaceId,
        input.projectId,
        input.runId ?? null,
        input.taskId,
        input.role,
        state,
        input.findings.trim() ? [input.findings] : [],
        input.role
      ]
    );
  }

  async saveApproval(approval: ApprovalRecord): Promise<void> {
    await this.client.query(
      `insert into approvals (
         id, workspace_id, project_id, run_id, task_id, actor, actor_role, source, decision, rationale
       )
       select $1, r.workspace_id, r.project_id, $2, $3, $4, $5, $6, $7, $8
       from runs r
       where r.id = $2`,
      [
        approval.id,
        approval.runId,
        approval.taskId,
        approval.actor,
        approval.actorRole,
        approval.source,
        approval.decision,
        approval.rationale
      ]
    );
  }

  async getApprovals(runId: string, taskId: string): Promise<ApprovalRecord[]> {
    const result = await this.client.query<JsonRow<ApprovalRecord>>(
      `select jsonb_build_object(
          'id', id,
          'runId', run_id,
          'taskId', task_id,
          'actor', actor,
          'actorRole', actor_role,
          'source', source,
          'decision', decision,
          'rationale', rationale,
          'createdAt', created_at
       ) as payload
       from approvals
       where run_id = $1
         and task_id = $2
       order by created_at asc`,
      [runId, taskId]
    );
    return result.rows.map((row) => row.payload);
  }

  async saveReviewFloorReduction(record: ReviewFloorReductionRecord): Promise<void> {
    await this.client.query(
      `insert into review_floor_reductions (
         id, run_id, task_id, derived_class, dropped_roles, effective_floor,
         write_scope_snapshot, basis, source, decided_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (run_id, task_id, decided_at) do nothing`,
      [
        record.id,
        record.runId,
        record.taskId,
        record.derivedClass,
        record.droppedRoles,
        record.effectiveFloor,
        record.writeScopeSnapshot,
        record.basis,
        record.source,
        record.decidedAt
      ]
    );
  }

  async getReviewFloorReductions(runId: string, taskId: string): Promise<ReviewFloorReductionRecord[]> {
    const result = await this.client.query<JsonRow<ReviewFloorReductionRecord>>(
      `select jsonb_build_object(
          'id', id,
          'runId', run_id,
          'taskId', task_id,
          'derivedClass', derived_class,
          'droppedRoles', dropped_roles,
          'effectiveFloor', effective_floor,
          'writeScopeSnapshot', write_scope_snapshot,
          'basis', basis,
          'source', source,
          'decidedAt', decided_at
       ) as payload
       from review_floor_reductions
       where run_id = $1
         and task_id = $2
       order by decided_at asc`,
      [runId, taskId]
    );
    return result.rows.map((row) => row.payload);
  }

  async saveMemoryEntry(entry: MemoryEntryRecord): Promise<void> {
    await this.client.query(
      `insert into memory_entries (
         id, workspace_id, project_id, run_id, task_id, scope, entry_type, title,
         content, reviewer, actor, status, source_path, source_anchor, metadata
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
      [
        entry.id,
        entry.workspaceId,
        entry.projectId ?? null,
        entry.runId ?? null,
        entry.taskId ?? null,
        entry.scope,
        entry.entryType,
        entry.title,
        entry.content,
        entry.reviewer,
        entry.actor,
        entry.status,
        entry.sourcePath ?? null,
        entry.sourceAnchor ?? null,
        JSON.stringify(entry.metadata ?? {})
      ]
    );
  }

  async listMemoryEntries(params: {
    runId: string;
    taskId?: string | undefined;
    entryType?: MemoryEntryRecord["entryType"] | undefined;
    status?: MemoryEntryRecord["status"] | undefined;
  }): Promise<MemoryEntryRecord[]> {
    const result = await this.client.query<JsonRow<MemoryEntryRecord>>(
      `select jsonb_build_object(
          'id', id,
          'workspaceId', workspace_id,
          'projectId', project_id,
          'runId', run_id,
          'taskId', task_id,
          'scope', scope,
          'entryType', entry_type,
          'title', title,
          'content', content,
          'reviewer', reviewer,
          'actor', actor,
          'status', status,
          'sourcePath', source_path,
          'sourceAnchor', source_anchor,
          'metadata', metadata,
          'createdAt', created_at
       ) as payload
       from memory_entries
       where run_id = $1
         and ($2::text is null or task_id = $2)
         and ($3::text is null or entry_type = $3)
         and ($4::text is null or status = $4)
       order by created_at asc`,
      [params.runId, params.taskId ?? null, params.entryType ?? null, params.status ?? null]
    );
    return result.rows.map((row) => row.payload);
  }

  async replaceMarkdownArtifacts(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    artifacts: readonly MarkdownArtifactRecord[];
  }): Promise<void> {
    await withTransaction(this.client, async () => {
      await this.client.query(
        `delete from embedding_jobs
         where source_table = 'artifacts'
           and project_id = $1`,
        [input.projectId]
      );

      await this.client.query(
        `delete from artifacts
         where project_id = $1
           and kind = 'markdown_chunk'`,
       [input.projectId]
      );

      for (const artifact of input.artifacts) {
        await this.client.query(
          `insert into artifacts (
             id, workspace_id, project_id, run_id, task_id, kind, title, content, metadata
           )
           values ($1, $2, $3, $4, null, 'markdown_chunk', $5, $6::jsonb, $7::jsonb)`,
          [
            artifact.id,
            artifact.workspaceId,
            artifact.projectId,
            input.runId,
            artifact.title,
            JSON.stringify({ text: artifact.content }),
            JSON.stringify({
              ...artifact.metadata,
              sourcePath: artifact.sourcePath,
              sourceAnchor: artifact.sourceAnchor ?? null
            })
          ]
        );
      }
    });

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
    if (artifactIds.length === 0) {
      return [];
    }

    const result = await this.client.query<ArtifactHydrationRow>(
      `select
         a.id,
         a.run_id as "runId",
         a.kind,
         a.title,
         coalesce(a.content->>'text', a.content::text) as content,
         a.metadata->>'sourcePath' as "sourcePath",
         a.metadata->>'sourceAnchor' as "sourceAnchor",
         a.metadata as metadata,
         a.created_at as "createdAt"
       from artifacts a
       join projects p on p.id = a.project_id
       where p.slug = $1
         and a.id::text = any($2::text[])`,
      [projectSlug, artifactIds]
    );

    const byId = new Map(
      result.rows.map((row) => [
        row.id,
        {
          id: row.id,
          runId: row.runId,
          kind: row.kind,
          title: row.title,
          content: row.content,
          sourcePath: row.sourcePath ?? undefined,
          sourceAnchor: row.sourceAnchor ?? undefined,
          metadata: row.metadata ?? {},
          createdAt: row.createdAt
        }
      ])
    );

    return artifactIds.map((artifactId) => byId.get(artifactId)).filter(Boolean) as Array<
      Pick<
        MarkdownArtifactRecord,
        "id" | "title" | "content" | "sourcePath" | "sourceAnchor" | "createdAt" | "kind" | "metadata" | "runId"
      >
    >;
  }
}
