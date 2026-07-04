import type { RunRecord } from "../../domain/types.ts";
import type { SqlClient, JsonRow } from "./shared.ts";

export async function createRun(client: SqlClient, run: RunRecord): Promise<void> {
  await client.query(
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

export async function getRun(client: SqlClient, runId: string): Promise<RunRecord | undefined> {
  const result = await client.query<JsonRow<RunRecord>>(
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

export async function findLatestRun(
  client: SqlClient,
  params: { workspaceSlug: string; projectSlug: string }
): Promise<RunRecord | undefined> {
  const result = await client.query<JsonRow<RunRecord>>(
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

export async function findLatestRunForTask(
  client: SqlClient,
  params: { workspaceSlug: string; projectSlug: string; taskId: string }
): Promise<RunRecord | undefined> {
  const result = await client.query<JsonRow<RunRecord>>(
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
     order by (case when r.status = 'in_progress' then 0 else 1 end) asc, r.updated_at desc
     limit 1`,
    [params.workspaceSlug, params.projectSlug, params.taskId]
  );
  return result.rows[0]?.payload;
}

export async function findRunsByProjectActivity(
  client: SqlClient,
  params: {
    workspaceSlug: string;
    projectSlug: string;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    timezone: string;
  }
): Promise<RunRecord[]> {
  const result = await client.query<JsonRow<RunRecord>>(
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

export async function updateRun(client: SqlClient, run: RunRecord): Promise<void> {
  await client.query(
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
