import type { TaskRecord, PlanArtifact } from "../../domain/types.ts";
import type { SqlClient, JsonRow } from "./shared.ts";
import { withTransaction } from "./shared.ts";

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

/**
 * Append new tasks to an existing run WITHOUT deleting any existing tasks.
 *
 * Integrity checks (all run before any insert, inside a transaction so a failed
 * check inserts NOTHING):
 *   1. Every task in `tasks` must share the same runId.
 *   2. No task_key in `tasks` may already exist in the run.
 *   3. Every dependency key referenced by an appended task must resolve to either
 *      an existing task in the run OR another task in the appended batch.
 */
export async function appendTasks(client: SqlClient, tasks: TaskRecord[]): Promise<void> {
  if (tasks.length === 0) {
    return;
  }

  const runId = tasks[0]!.runId;

  // Validate: all tasks must belong to the same run.
  for (const task of tasks) {
    if (task.runId !== runId) {
      throw new Error(
        `appendTasks: all tasks must share the same runId; ` +
        `expected '${runId}', found '${task.runId}' on task '${task.packet.taskId}'`
      );
    }
  }

  await withTransaction(client, async () => {
    // Fetch existing task keys for this run within the transaction so the check
    // is serialised against concurrent writes.
    const existingResult = await client.query<{ task_key: string }>(
      `select task_key from tasks where run_id = $1`,
      [runId]
    );
    const existingKeys = new Set(existingResult.rows.map((row) => row.task_key));

    // Check 1: no duplicate task keys (intra-batch or collision with existing).
    const seenInBatch = new Set<string>();
    for (const task of tasks) {
      if (seenInBatch.has(task.packet.taskId)) {
        throw new Error(
          `appendTasks: task_key '${task.packet.taskId}' appears more than once in the appended batch`
        );
      }
      seenInBatch.add(task.packet.taskId);
      if (existingKeys.has(task.packet.taskId)) {
        throw new Error(
          `appendTasks: task_key '${task.packet.taskId}' already exists in run '${runId}'`
        );
      }
    }

    // Build the full set of known keys: existing + incoming batch (after duplicate check).
    const incomingKeys = seenInBatch;

    // Check 2: no dangling dependency edges.
    const allKnownKeys = new Set([...existingKeys, ...incomingKeys]);
    for (const task of tasks) {
      for (const dep of task.packet.dependencies) {
        if (!allKnownKeys.has(dep)) {
          throw new Error(
            `appendTasks: task '${task.packet.taskId}' has a dangling dependency '${dep}' ` +
            `that is not present in the run or the appended batch`
          );
        }
      }
    }

    // All checks passed — perform INSERT-only writes (mirrors replaceTasks insert half).
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
  });
}
