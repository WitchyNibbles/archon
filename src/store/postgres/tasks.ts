import type { TaskRecord, PlanArtifact } from "../../domain/types.ts";
import type { SqlClient, JsonRow } from "./shared.ts";

export async function savePlan(client: SqlClient, plan: PlanArtifact): Promise<void> {
  await client.query(
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

export async function getPlan(client: SqlClient, runId: string): Promise<PlanArtifact | undefined> {
  const result = await client.query<JsonRow<PlanArtifact>>(
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

export async function replaceTasks(client: SqlClient, tasks: TaskRecord[]): Promise<void> {
  if (tasks.length === 0) {
    return;
  }

  const runId = tasks[0]!.runId;
  await client.query(`delete from task_dependencies where task_id in (select id from tasks where run_id = $1)`, [runId]);
  await client.query(`delete from tasks where run_id = $1`, [runId]);

  for (const task of tasks) {
    await client.query(
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
      await client.query(
        `insert into task_dependencies (task_id, depends_on_task_key) values ($1, $2)`,
        [task.id, dependency]
      );
    }
  }
}

export async function getTasksByRun(client: SqlClient, runId: string): Promise<TaskRecord[]> {
  const result = await client.query<JsonRow<TaskRecord>>(
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

export async function getTask(
  client: SqlClient,
  runId: string,
  taskId: string
): Promise<TaskRecord | undefined> {
  const result = await client.query<JsonRow<TaskRecord>>(
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

export async function updateTask(client: SqlClient, task: TaskRecord): Promise<void> {
  // Guard: the `class` column is immutable after INSERT. Verify the caller
  // is not attempting to mutate it by comparing with the persisted value.
  const existing = await client.query<{ class: string }>(
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
  await client.query(
    `update tasks
     set status = $2,
         claimed_by = $3,
         payload = $4::jsonb,
         updated_at = now()
     where id = $1`,
    [task.id, task.status, task.claimedBy ?? null, JSON.stringify(task.packet)]
  );
}
