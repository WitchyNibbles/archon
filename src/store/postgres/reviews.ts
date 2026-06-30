import { randomUUID } from "node:crypto";
import type { ReviewRecord, ApprovalRecord, ReviewFloorReductionRecord, ReviewFinding } from "../../domain/types.ts";
import type { SqlClient, JsonRow } from "./shared.ts";

export async function saveReview(client: SqlClient, review: ReviewRecord): Promise<void> {
  await client.query(
    `insert into reviews (
       id, workspace_id, project_id, run_id, task_id, reviewer_role, actor, actor_role,
       source, state, severity, findings, waiver_reason, evidence_refs, finding_details
     )
     select $1, r.workspace_id, r.project_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
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
      review.evidenceRefs ?? [],
      review.findingDetails !== undefined ? JSON.stringify(review.findingDetails) : null
    ]
  );
}

export async function getReviews(
  client: SqlClient,
  runId: string,
  taskId: string
): Promise<ReviewRecord[]> {
  const result = await client.query<JsonRow<ReviewRecord>>(
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
        'createdAt', created_at,
        'findingDetails', finding_details
     ) as payload
     from reviews
     where run_id = $1
       and task_id = $2
     order by created_at asc`,
    [runId, taskId]
  );
  return result.rows.map((row) => {
    const record = row.payload;
    // finding_details is stored as JSONB — Postgres returns it as a parsed object.
    // If null (no structured details), strip the field so the type remains clean.
    if (record.findingDetails === null) {
      return { ...record, findingDetails: undefined };
    }
    return record;
  });
}

export async function getOrchestratorReviews(
  client: SqlClient,
  taskId: string
): Promise<{ role: string; outcome: string; source: string }[]> {
  const result = await client.query<{ role: string; outcome: string; source: string }>(
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

export async function saveOrchestratorReview(
  client: SqlClient,
  input: {
    taskId: string;
    role: string;
    outcome: string;
    findings: string;
    workspaceId: string;
    projectId: string;
    runId?: string | null | undefined;
    findingDetails?: readonly ReviewFinding[] | undefined;
  }
): Promise<void> {
  const id = randomUUID();
  const state = input.outcome === "passed" ? "passed" : "blocked";
  // Two-authorities fix: persist the run id so the Stop-hook's run-scoped review
  // query can no longer be satisfied by a run-agnostic (null) review row that
  // would otherwise apply to every run.
  await client.query(
    `insert into reviews (
       id, workspace_id, project_id, run_id, task_id, reviewer_role, actor, actor_role,
       state, severity, findings, waiver_reason, evidence_refs, source, finding_details
     )
     values ($1, $2, $3, $4, $5, $6, 'review-orchestrator', $9,
             $7, 'low', $8, null, '{}', 'orchestrator', $10)`,
    [
      id,
      input.workspaceId,
      input.projectId,
      input.runId ?? null,
      input.taskId,
      input.role,
      state,
      input.findings.trim() ? [input.findings] : [],
      input.role,
      input.findingDetails !== undefined ? JSON.stringify(input.findingDetails) : null
    ]
  );
}

export async function saveApproval(client: SqlClient, approval: ApprovalRecord): Promise<void> {
  await client.query(
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

export async function getApprovals(
  client: SqlClient,
  runId: string,
  taskId: string
): Promise<ApprovalRecord[]> {
  const result = await client.query<JsonRow<ApprovalRecord>>(
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

export async function saveReviewFloorReduction(
  client: SqlClient,
  record: ReviewFloorReductionRecord
): Promise<void> {
  await client.query(
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

export async function getReviewFloorReductions(
  client: SqlClient,
  runId: string,
  taskId: string
): Promise<ReviewFloorReductionRecord[]> {
  const result = await client.query<JsonRow<ReviewFloorReductionRecord>>(
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
       and source = 'orchestrator'
     order by decided_at asc`,
    [runId, taskId]
  );
  return result.rows.map((row) => row.payload);
}
