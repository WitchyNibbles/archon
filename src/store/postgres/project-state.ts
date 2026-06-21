import type {
  WorkspaceRecord,
  ProjectRecord,
  RuntimeProjectRegistrationRecord,
  RuntimeMigrationJournalRecord,
  ProjectRuntimeStateRecord,
  WorkflowDocumentRecord
} from "../../domain/types.ts";
import type { SqlClient, JsonRow } from "./shared.ts";
import { now } from "./shared.ts";

export async function ensureProjectContext(
  client: SqlClient,
  params: {
    workspaceSlug: string;
    workspaceName?: string | undefined;
    projectSlug: string;
    projectName?: string | undefined;
    repoPath?: string | undefined;
  }
): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord }> {
  const workspace = {
    id: `workspace:${params.workspaceSlug}`,
    slug: params.workspaceSlug,
    name: params.workspaceName ?? params.workspaceSlug,
    createdAt: now()
  };

  await client.query(
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

  await client.query(
    `insert into projects (id, workspace_id, slug, name, repo_path)
     values ($1, $2, $3, $4, $5)
     on conflict (workspace_id, slug) do update
     set name = excluded.name,
         repo_path = excluded.repo_path`,
    [project.id, project.workspaceId, project.slug, project.name, project.repoPath ?? null]
  );

  return { workspace, project };
}

export async function getProjectContext(
  client: SqlClient,
  params: { workspaceSlug: string; projectSlug: string }
): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined> {
  const result = await client.query<JsonRow<{ workspace: WorkspaceRecord; project: ProjectRecord }>>(
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

export async function saveProjectRuntimeRegistration(
  client: SqlClient,
  registration: RuntimeProjectRegistrationRecord
): Promise<void> {
  await client.query(
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

export async function getProjectRuntimeRegistration(
  client: SqlClient,
  projectId: string
): Promise<RuntimeProjectRegistrationRecord | undefined> {
  const result = await client.query<JsonRow<RuntimeProjectRegistrationRecord>>(
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

export async function saveRuntimeMigrationJournal(
  client: SqlClient,
  journal: RuntimeMigrationJournalRecord
): Promise<void> {
  await client.query(
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

export async function listRuntimeMigrationJournals(
  client: SqlClient,
  projectId: string
): Promise<RuntimeMigrationJournalRecord[]> {
  const result = await client.query<JsonRow<RuntimeMigrationJournalRecord>>(
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

export async function saveProjectRuntimeState(
  client: SqlClient,
  state: ProjectRuntimeStateRecord
): Promise<void> {
  await client.query(
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

export async function getProjectRuntimeState(
  client: SqlClient,
  projectId: string
): Promise<ProjectRuntimeStateRecord | undefined> {
  const result = await client.query<JsonRow<ProjectRuntimeStateRecord>>(
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

export async function saveWorkflowDocument(
  client: SqlClient,
  document: WorkflowDocumentRecord
): Promise<void> {
  await client.query(
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

export async function listWorkflowDocuments(
  client: SqlClient,
  params: {
    projectId: string;
    runId?: string | undefined;
    taskId?: string | undefined;
    kind?: WorkflowDocumentRecord["kind"] | undefined;
  }
): Promise<WorkflowDocumentRecord[]> {
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

  const result = await client.query<JsonRow<WorkflowDocumentRecord>>(
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
