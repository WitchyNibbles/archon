import type { HandoffRecord, LockRecord } from "../../domain/types.ts";
import type { SqlClient, JsonRow } from "./shared.ts";

export async function createLock(client: SqlClient, lock: LockRecord): Promise<void> {
  await client.query(
    `insert into locks (id, workspace_id, project_id, run_id, task_id, scope_paths, status)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [lock.id, lock.workspaceId, lock.projectId, lock.runId, lock.taskId, lock.scopePaths, lock.status]
  );
}

export async function releaseLocksForTask(
  client: SqlClient,
  runId: string,
  taskId: string,
  releasedAt: string
): Promise<void> {
  await client.query(
    `update locks
     set status = 'released',
         released_at = $3
     where run_id = $1 and task_id = $2 and status = 'active'`,
    [runId, taskId, releasedAt]
  );
}

export async function getActiveLocks(client: SqlClient, projectId: string): Promise<LockRecord[]> {
  const result = await client.query<JsonRow<LockRecord>>(
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

export async function saveHandoff(client: SqlClient, handoff: HandoffRecord): Promise<void> {
  await client.query(
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

export async function getHandoffs(
  client: SqlClient,
  runId: string,
  taskId: string
): Promise<HandoffRecord[]> {
  const result = await client.query<JsonRow<HandoffRecord>>(
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
