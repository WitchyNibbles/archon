// Agent Runtime Store — Phase 1 of the Archon Agentic Loop Runtime.
//
// Provides typed store methods for agent_invocations, agent_context_samples,
// agent_handoffs, agent_subtasks, agent_debate_sessions, and
// agent_debate_arguments.
//
// Separated from postgres-store.ts to keep that file under the 800-line limit.

import { randomUUID } from "node:crypto";
import type { SqlClient } from "./postgres-store.ts";
import type {
  AgentInvocation,
  ContextSample,
  Subtask,
  DebateSession,
  DebateArgument
} from "../domain/types.ts";
import type { TaskSummary } from "../runtime/agentic-loop.ts";

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Input shapes for write operations
// ---------------------------------------------------------------------------

export interface CreateAgentInvocationInput {
  id: string;
  runId: string;
  taskId: string;
  parentInvocationId?: string | undefined;
  role: string;
  agentKind: AgentInvocation["agentKind"];
  model: string;
  effort: string;
  status: AgentInvocation["status"];
  contextPolicyId: string;
  sessionId?: string | undefined;
  transcriptPath?: string | undefined;
  /** Spawn depth — 0 for root invocations, parent.depth + 1 for child invocations. */
  depth?: number | undefined;
  startedAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RecordContextSampleInput {
  invocationId: string;
  runId: string;
  taskId: string;
  source: ContextSample["source"];
  usedPercentage?: number | undefined;
  remainingPercentage?: number | undefined;
  currentUsageTokens?: number | undefined;
  contextWindowSize?: number | undefined;
  sampledAt?: string | undefined;
  raw?: Record<string, unknown> | undefined;
}

export interface CreateHandoffInput {
  id: string;
  runId: string;
  taskId: string;
  fromInvocationId: string;
  toInvocationId?: string | undefined;
  fromRole: string;
  toRole: string;
  reason: string;
  status: string;
  contextUsedPct?: number | undefined;
  packet: Record<string, unknown>;
  authorityLabel?: string | undefined;
  createdAt?: string | undefined;
}

export interface HandoffRecord {
  id: string;
  runId: string;
  taskId: string;
  fromInvocationId: string;
  toInvocationId?: string | undefined;
  fromRole: string;
  toRole: string;
  reason: string;
  status: string;
  contextUsedPct?: number | undefined;
  packet: Record<string, unknown>;
  authorityLabel: string;
  createdAt: string;
  consumedAt?: string | undefined;
}

export interface CreateSubtaskInput {
  id: string;
  runId: string;
  taskId: string;
  parentInvocationId: string;
  childInvocationId?: string | undefined;
  subagentType: string;
  title: string;
  prompt: string;
  allowedTools?: string[] | undefined;
  allowedWriteScope?: string[] | undefined;
  status: string;
  createdAt?: string | undefined;
}

export interface CreateDebateSessionInput {
  id: string;
  runId: string;
  taskId?: string | undefined;
  topic: string;
  triggerKind: string;
  status: string;
  createdAt?: string | undefined;
}

export interface AddDebateArgumentInput {
  id: string;
  debateSessionId: string;
  round: number;
  role: string;
  position: string;
  evidenceRefs?: string[] | undefined;
  critiques?: string[] | undefined;
  vote?: string | undefined;
  createdAt?: string | undefined;
}

// ---------------------------------------------------------------------------
// AgentRuntimeStore
// ---------------------------------------------------------------------------

export class AgentRuntimeStore {
  private readonly client: SqlClient;

  constructor(client: SqlClient) {
    this.client = client;
  }

  // -------------------------------------------------------------------------
  // agent_invocations
  // -------------------------------------------------------------------------

  async createAgentInvocation(data: CreateAgentInvocationInput): Promise<AgentInvocation> {
    const startedAt = data.startedAt ?? now();
    const metadata = data.metadata ?? {};
    const depth = data.depth ?? 0;

    await this.client.query(
      `insert into agent_invocations
         (id, run_id, task_id, parent_invocation_id, role, agent_kind, model,
          effort, status, context_policy_id, session_id, transcript_path,
          depth, started_at, metadata)
       values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        data.id,
        data.runId,
        data.taskId,
        data.parentInvocationId ?? null,
        data.role,
        data.agentKind,
        data.model,
        data.effort,
        data.status,
        data.contextPolicyId,
        data.sessionId ?? null,
        data.transcriptPath ?? null,
        depth,
        startedAt,
        JSON.stringify(metadata)
      ]
    );

    return {
      id: data.id,
      runId: data.runId,
      taskId: data.taskId,
      parentInvocationId: data.parentInvocationId,
      role: data.role,
      agentKind: data.agentKind,
      model: data.model,
      effort: data.effort,
      status: data.status,
      contextPolicyId: data.contextPolicyId,
      sessionId: data.sessionId,
      transcriptPath: data.transcriptPath,
      startedAt,
      endedAt: undefined,
      metadata
    };
  }

  async updateAgentInvocationStatus(
    id: string,
    status: AgentInvocation["status"],
    metadata?: Record<string, unknown> | undefined
  ): Promise<void> {
    if (metadata !== undefined) {
      await this.client.query(
        `update agent_invocations
         set status = $1,
             ended_at = case when $1 in ('completed','blocked','failed') then now() else ended_at end,
             metadata = metadata || $2::jsonb
         where id = $3`,
        [status, JSON.stringify(metadata), id]
      );
    } else {
      await this.client.query(
        `update agent_invocations
         set status = $1,
             ended_at = case when $1 in ('completed','blocked','failed') then now() else ended_at end
         where id = $2`,
        [status, id]
      );
    }
  }

  // -------------------------------------------------------------------------
  // agent_context_samples
  // -------------------------------------------------------------------------

  async recordContextSample(data: RecordContextSampleInput): Promise<void> {
    const sampledAt = data.sampledAt ?? now();
    const raw = data.raw ?? {};

    await this.client.query(
      `insert into agent_context_samples
         (invocation_id, run_id, task_id, source, used_percentage,
          remaining_percentage, current_usage_tokens, context_window_size,
          sampled_at, raw)
       values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        data.invocationId,
        data.runId,
        data.taskId,
        data.source,
        data.usedPercentage ?? null,
        data.remainingPercentage ?? null,
        data.currentUsageTokens ?? null,
        data.contextWindowSize ?? null,
        sampledAt,
        JSON.stringify(raw)
      ]
    );
  }

  async getLatestContextSample(invocationId: string): Promise<ContextSample | undefined> {
    interface SampleRow {
      id: string;
      invocation_id: string;
      run_id: string;
      task_id: string;
      source: string;
      used_percentage: string | null;
      remaining_percentage: string | null;
      current_usage_tokens: string | null;
      context_window_size: string | null;
      sampled_at: string;
      raw: Record<string, unknown>;
    }

    const result = await this.client.query<SampleRow>(
      `select id, invocation_id, run_id, task_id, source,
              used_percentage, remaining_percentage, current_usage_tokens,
              context_window_size, sampled_at, raw
       from agent_context_samples
       where invocation_id = $1
       order by sampled_at desc
       limit 1`,
      [invocationId]
    );

    const row = result.rows[0];
    if (row === undefined) return undefined;

    return {
      id: Number(row.id),
      invocationId: row.invocation_id,
      runId: row.run_id,
      taskId: row.task_id,
      source: row.source as ContextSample["source"],
      usedPercentage: row.used_percentage !== null ? Number(row.used_percentage) : undefined,
      remainingPercentage: row.remaining_percentage !== null ? Number(row.remaining_percentage) : undefined,
      currentUsageTokens: row.current_usage_tokens !== null ? Number(row.current_usage_tokens) : undefined,
      contextWindowSize: row.context_window_size !== null ? Number(row.context_window_size) : undefined,
      sampledAt: row.sampled_at,
      raw: row.raw
    };
  }

  // -------------------------------------------------------------------------
  // agent_handoffs
  // -------------------------------------------------------------------------

  async createHandoff(data: CreateHandoffInput): Promise<HandoffRecord> {
    const createdAt = data.createdAt ?? now();
    const authorityLabel = data.authorityLabel ?? "runtime_authoritative";

    await this.client.query(
      `insert into agent_handoffs
         (id, run_id, task_id, from_invocation_id, to_invocation_id,
          from_role, to_role, reason, status, context_used_pct,
          packet, authority_label, created_at)
       values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        data.id,
        data.runId,
        data.taskId,
        data.fromInvocationId,
        data.toInvocationId ?? null,
        data.fromRole,
        data.toRole,
        data.reason,
        data.status,
        data.contextUsedPct ?? null,
        JSON.stringify(data.packet),
        authorityLabel,
        createdAt
      ]
    );

    return {
      id: data.id,
      runId: data.runId,
      taskId: data.taskId,
      fromInvocationId: data.fromInvocationId,
      toInvocationId: data.toInvocationId,
      fromRole: data.fromRole,
      toRole: data.toRole,
      reason: data.reason,
      status: data.status,
      contextUsedPct: data.contextUsedPct,
      packet: data.packet,
      authorityLabel,
      createdAt,
      consumedAt: undefined
    };
  }

  async getLatestUnconsumedHandoff(runId: string, taskId: string): Promise<HandoffRecord | undefined> {
    interface HandoffRow {
      id: string;
      run_id: string;
      task_id: string;
      from_invocation_id: string;
      to_invocation_id: string | null;
      from_role: string;
      to_role: string;
      reason: string;
      status: string;
      context_used_pct: string | null;
      packet: Record<string, unknown>;
      authority_label: string;
      created_at: string;
      consumed_at: string | null;
    }

    const result = await this.client.query<HandoffRow>(
      `select id, run_id, task_id, from_invocation_id, to_invocation_id,
              from_role, to_role, reason, status, context_used_pct,
              packet, authority_label, created_at, consumed_at
       from agent_handoffs
       where run_id = $1::uuid
         and task_id = $2
         and consumed_at is null
       order by created_at desc
       limit 1`,
      [runId, taskId]
    );

    const row = result.rows[0];
    if (row === undefined) return undefined;

    return {
      id: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      fromInvocationId: row.from_invocation_id,
      toInvocationId: row.to_invocation_id ?? undefined,
      fromRole: row.from_role,
      toRole: row.to_role,
      reason: row.reason,
      status: row.status,
      contextUsedPct: row.context_used_pct !== null ? Number(row.context_used_pct) : undefined,
      packet: row.packet,
      authorityLabel: row.authority_label,
      createdAt: row.created_at,
      consumedAt: row.consumed_at ?? undefined
    };
  }

  async markHandoffConsumed(handoffId: string, toInvocationId: string): Promise<void> {
    await this.client.query(
      `update agent_handoffs
       set consumed_at = now(),
           to_invocation_id = $1
       where id = $2
         and consumed_at is null`,
      [toInvocationId, handoffId]
    );
  }

  // -------------------------------------------------------------------------
  // agent_subtasks
  // -------------------------------------------------------------------------

  async createSubtask(data: CreateSubtaskInput): Promise<Subtask> {
    const createdAt = data.createdAt ?? now();

    await this.client.query(
      `insert into agent_subtasks
         (id, run_id, task_id, parent_invocation_id, child_invocation_id,
          subagent_type, title, prompt, allowed_tools, allowed_write_scope,
          status, created_at)
       values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        data.id,
        data.runId,
        data.taskId,
        data.parentInvocationId,
        data.childInvocationId ?? null,
        data.subagentType,
        data.title,
        data.prompt,
        data.allowedTools ?? [],
        data.allowedWriteScope ?? [],
        data.status,
        createdAt
      ]
    );

    return {
      id: data.id,
      runId: data.runId,
      taskId: data.taskId,
      parentInvocationId: data.parentInvocationId,
      childInvocationId: data.childInvocationId,
      subagentType: data.subagentType,
      title: data.title,
      prompt: data.prompt,
      allowedTools: data.allowedTools ?? [],
      allowedWriteScope: data.allowedWriteScope ?? [],
      status: data.status,
      resultPacket: undefined,
      createdAt,
      completedAt: undefined
    };
  }

  async updateSubtaskResult(
    id: string,
    resultPacket: Record<string, unknown>,
    status: string
  ): Promise<void> {
    await this.client.query(
      `update agent_subtasks
       set result_packet = $1::jsonb,
           status = $2,
           completed_at = now()
       where id = $3`,
      [JSON.stringify(resultPacket), status, id]
    );
  }

  // -------------------------------------------------------------------------
  // agent_debate_sessions
  // -------------------------------------------------------------------------

  async createDebateSession(data: CreateDebateSessionInput): Promise<DebateSession> {
    const createdAt = data.createdAt ?? now();

    await this.client.query(
      `insert into agent_debate_sessions
         (id, run_id, task_id, topic, trigger_kind, status, created_at)
       values ($1, $2::uuid, $3, $4, $5, $6, $7)`,
      [
        data.id,
        data.runId,
        data.taskId ?? null,
        data.topic,
        data.triggerKind,
        data.status,
        createdAt
      ]
    );

    return {
      id: data.id,
      runId: data.runId,
      taskId: data.taskId,
      topic: data.topic,
      triggerKind: data.triggerKind,
      status: data.status,
      decision: undefined,
      createdAt,
      completedAt: undefined
    };
  }

  async addDebateArgument(data: AddDebateArgumentInput): Promise<DebateArgument> {
    const createdAt = data.createdAt ?? now();

    await this.client.query(
      `insert into agent_debate_arguments
         (id, debate_session_id, round, role, position,
          evidence_refs, critiques, vote, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        data.id,
        data.debateSessionId,
        data.round,
        data.role,
        data.position,
        data.evidenceRefs ?? [],
        data.critiques ?? [],
        data.vote ?? null,
        createdAt
      ]
    );

    return {
      id: data.id,
      debateSessionId: data.debateSessionId,
      round: data.round,
      role: data.role,
      position: data.position,
      evidenceRefs: data.evidenceRefs ?? [],
      critiques: data.critiques ?? [],
      vote: data.vote,
      createdAt
    };
  }

  async updateDebateDecision(
    sessionId: string,
    decision: Record<string, unknown>
  ): Promise<void> {
    await this.client.query(
      `update agent_debate_sessions
       set decision = $1::jsonb,
           status = 'completed',
           completed_at = now()
       where id = $2`,
      [JSON.stringify(decision), sessionId]
    );
  }

  // ---------------------------------------------------------------------------
  // Gap-A: additional methods needed by MCP wiring and CLI commands
  // ---------------------------------------------------------------------------

  async hasCommittedHandoff(invocationId: string): Promise<boolean> {
    const result = await this.client.query(
      `select 1 from agent_handoffs
       where from_invocation_id = $1
         and consumed_at is null
         and status in ('handoff_written', 'needs_followup')
       limit 1`,
      [invocationId]
    );
    return result.rows.length > 0;
  }

  /**
   * SDD §20.2 / TDD §8.2: true if the given invocation has recorded any context
   * sample at or beyond the handoff threshold. Used by the subtask scheduler to
   * deny spawning once a parent has crossed the threshold.
   */
  async hasInvocationCrossedThreshold(invocationId: string, thresholdPct = 70): Promise<boolean> {
    const result = await this.client.query(
      `select 1 from agent_context_samples
       where invocation_id = $1 and used_percentage >= $2
       limit 1`,
      [invocationId, thresholdPct]
    );
    return result.rows.length > 0;
  }

  /**
   * SDD §18.3 review independence.
   *
   * Returns the implementing-role surface for a task so workflow-proof can verify
   * that no role which implemented the task also satisfied a required review gate,
   * and that no reviewer invocation descends from the implementing invocation.
   *
   *   hasInvocations         — true if any implementing invocations exist for the task
   *   implementerRoles       — distinct roles of implementing invocations
   *   subagentReviewerRoles  — roles of reviewer/debate invocations whose parent chain
   *                            reaches an implementing invocation (subagent-approves-parent)
   *
   * "Implementer" = agent_kind in (specialist_owner, subagent): both can write code.
   * root_manager / review_orchestrator legitimately spawn reviewers, so they are NOT
   * implementers and their reviewer children are not flagged as self-review.
   *
   * The reviewer→implementer relationship is resolved transitively over
   * parent_invocation_id so a multi-hop chain (reviewer → intermediary → implementer)
   * cannot evade the check.
   */
  async checkReviewIndependenceForTask(taskId: string): Promise<{
    hasInvocations: boolean;
    implementerRoles: string[];
    subagentReviewerRoles: string[];
  }> {
    const result = await this.client.query(
      `select id, role, agent_kind, parent_invocation_id from agent_invocations
       where task_id = $1`,
      [taskId]
    );
    const rows = result.rows as {
      id: string;
      role: string;
      agent_kind: string;
      parent_invocation_id: string | null;
    }[];

    const implementerKinds = new Set(["specialist_owner", "subagent"]);
    const implementers = rows.filter((row) => implementerKinds.has(row.agent_kind));
    if (implementers.length === 0) {
      return { hasInvocations: false, implementerRoles: [], subagentReviewerRoles: [] };
    }

    const implementerRoles = Array.from(new Set(implementers.map((row) => row.role)));
    const implementerIds = new Set(implementers.map((row) => row.id));
    const parentOf = new Map(rows.map((row) => [row.id, row.parent_invocation_id]));

    const reviewerKinds = new Set(["reviewer", "debate_participant"]);
    const reviewers = rows.filter((row) => reviewerKinds.has(row.agent_kind));

    const subagentReviewerRoles: string[] = [];
    for (const reviewer of reviewers) {
      // Walk the parent chain; flag if any ancestor is an implementing invocation.
      let cursor: string | null | undefined = reviewer.parent_invocation_id;
      const seen = new Set<string>();
      while (cursor !== undefined && cursor !== null && !seen.has(cursor)) {
        if (implementerIds.has(cursor)) {
          subagentReviewerRoles.push(reviewer.role);
          break;
        }
        seen.add(cursor);
        cursor = parentOf.get(cursor);
      }
    }

    return {
      hasInvocations: true,
      implementerRoles,
      subagentReviewerRoles: Array.from(new Set(subagentReviewerRoles))
    };
  }

  async listSubtasksForTask(taskId: string): Promise<Subtask[]> {
    const result = await this.client.query(
      `select id, run_id, task_id, parent_invocation_id, child_invocation_id,
              subagent_type, title, prompt, allowed_tools, allowed_write_scope,
              status, result_packet, created_at, completed_at
       from agent_subtasks
       where task_id = $1
       order by created_at asc`,
      [taskId]
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      runId: row.run_id as string,
      taskId: row.task_id as string,
      parentInvocationId: row.parent_invocation_id as string,
      childInvocationId: (row.child_invocation_id ?? undefined) as string | undefined,
      subagentType: row.subagent_type as string,
      title: row.title as string,
      prompt: row.prompt as string,
      allowedTools: (row.allowed_tools ?? []) as string[],
      allowedWriteScope: (row.allowed_write_scope ?? []) as string[],
      status: row.status as Subtask["status"],
      resultPacket: (row.result_packet ?? undefined) as Record<string, unknown> | undefined,
      createdAt: row.created_at as string,
      completedAt: (row.completed_at ?? undefined) as string | undefined
    }));
  }

  async getInvocationById(invocationId: string): Promise<AgentInvocation | undefined> {
    const result = await this.client.query(
      `select id, run_id, task_id, parent_invocation_id, role, agent_kind,
              model, effort, status, context_policy_id, session_id,
              transcript_path, started_at, ended_at, metadata
       from agent_invocations
       where id = $1`,
      [invocationId]
    );
    if (result.rows.length === 0) return undefined;
     
    const row = result.rows[0]!;
    return {
      id: row.id as string,
      runId: row.run_id as string,
      taskId: row.task_id as string,
      parentInvocationId: (row.parent_invocation_id ?? undefined) as string | undefined,
      role: row.role as string,
      agentKind: row.agent_kind as AgentInvocation["agentKind"],
      model: row.model as string,
      effort: row.effort as string,
      status: row.status as AgentInvocation["status"],
      contextPolicyId: row.context_policy_id as string,
      sessionId: (row.session_id ?? undefined) as string | undefined,
      transcriptPath: (row.transcript_path ?? undefined) as string | undefined,
      startedAt: row.started_at as string,
      endedAt: (row.ended_at ?? undefined) as string | undefined,
      metadata: (row.metadata ?? {}) as Record<string, unknown>
    };
  }

  async listInvocationsForRun(
    runId: string,
    taskId?: string | undefined
  ): Promise<AgentInvocation[]> {
    const params: unknown[] = [runId];
    const taskFilter = taskId !== undefined ? `and task_id = $2` : "";
    if (taskId !== undefined) params.push(taskId);
    const result = await this.client.query(
      `select id, run_id, task_id, parent_invocation_id, role, agent_kind,
              model, effort, status, context_policy_id, session_id,
              transcript_path, started_at, ended_at, metadata
       from agent_invocations
       where run_id = $1 ${taskFilter}
       order by started_at asc`,
      params
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      runId: row.run_id as string,
      taskId: row.task_id as string,
      parentInvocationId: (row.parent_invocation_id ?? undefined) as string | undefined,
      role: row.role as string,
      agentKind: row.agent_kind as AgentInvocation["agentKind"],
      model: row.model as string,
      effort: row.effort as string,
      status: row.status as AgentInvocation["status"],
      contextPolicyId: row.context_policy_id as string,
      sessionId: (row.session_id ?? undefined) as string | undefined,
      transcriptPath: (row.transcript_path ?? undefined) as string | undefined,
      startedAt: row.started_at as string,
      endedAt: (row.ended_at ?? undefined) as string | undefined,
      metadata: (row.metadata ?? {}) as Record<string, unknown>
    }));
  }

  /**
   * Return invocations that crossed the handoff threshold, have no end state,
   * and have no committed handoff — presumed crashed and eligible for a
   * crash_recovery continuation (TDD §20).
   */
  async listRecoverableInvocations(
    runId: string,
    handoffPct: number
  ): Promise<
    {
      invocationId: string;
      runId: string;
      taskId: string;
      role: string;
      contextUsedPct?: number | undefined;
    }[]
  > {
    // Only `running` invocations are treated as crash orphans. `handoff_requested`
    // is deliberately excluded: recoverCrashedInvocation calls prepare() first
    // (which flips status to handoff_requested) before commit() inserts the
    // handoff row. Restricting detection to `running` means once recovery starts
    // the invocation no longer matches this query, closing the prepare→commit
    // double-recovery window for the sequential daemon loop.
    //
    // The `not exists (... agent_handoffs ...)` clause is intentionally unscoped
    // by handoff status: any prior handoff (committed or consumed) means this
    // invocation already transferred its work to a successor invocation, so it is
    // not an orphan — the successor, if it also crashes, is detected on its own id.
    const result = await this.client.query(
      `select i.id, i.run_id, i.task_id, i.role,
              (select max(s.used_percentage)
                 from agent_context_samples s
                where s.invocation_id = i.id) as max_used_pct
         from agent_invocations i
        where i.run_id = $1
          and i.ended_at is null
          and i.status = 'running'
          and exists (
            select 1 from agent_context_samples s
             where s.invocation_id = i.id
               and s.used_percentage >= $2
          )
          and not exists (
            select 1 from agent_handoffs h
             where h.from_invocation_id = i.id
          )
        order by i.started_at asc`,
      [runId, handoffPct]
    );
    return result.rows.map((row) => {
      const rawPct = row.max_used_pct;
      const contextUsedPct =
        rawPct === null || rawPct === undefined ? undefined : Number(rawPct);
      return {
        invocationId: row.id as string,
        runId: row.run_id as string,
        taskId: row.task_id as string,
        role: row.role as string,
        contextUsedPct
      };
    });
  }

  /**
   * Aggregate agentic-runtime counters for a run from the invocation, handoff,
   * context-sample, subtask, and debate tables (§19.1 observability).
   */
  async getAgenticMetrics(
    runId: string,
    handoffPct: number
  ): Promise<{
    invocationsTotal: number;
    invocationsByStatus: { label: string; count: number }[];
    handoffsTotal: number;
    handoffsByReason: { label: string; count: number }[];
    contextThresholdCrossedTotal: number;
    subtasksTotal: number;
    subtasksByStatus: { label: string; count: number }[];
    debateSessionsTotal: number;
    debateSessionsByStatus: { label: string; count: number }[];
  }> {
    const toLabeled = (rows: Record<string, unknown>[]): { label: string; count: number }[] =>
      rows.map((row) => ({
        label: String(row.label ?? "unknown"),
        count: Number(row.count ?? 0)
      }));
    const sum = (rows: { count: number }[]): number =>
      rows.reduce((total, row) => total + row.count, 0);

    const [invocations, handoffs, thresholdCrossed, subtasks, debates] = await Promise.all([
      this.client.query(
        `select status as label, count(*)::int as count
           from agent_invocations where run_id = $1 group by status order by status`,
        [runId]
      ),
      this.client.query(
        `select reason as label, count(*)::int as count
           from agent_handoffs where run_id = $1 group by reason order by reason`,
        [runId]
      ),
      this.client.query(
        `select count(distinct invocation_id)::int as count
           from agent_context_samples where run_id = $1 and used_percentage >= $2`,
        [runId, handoffPct]
      ),
      this.client.query(
        `select s.status as label, count(*)::int as count
           from agent_subtasks s where s.run_id = $1 group by s.status order by s.status`,
        [runId]
      ),
      this.client.query(
        `select status as label, count(*)::int as count
           from agent_debate_sessions where run_id = $1 group by status order by status`,
        [runId]
      )
    ]);

    const invocationsByStatus = toLabeled(invocations.rows);
    const handoffsByReason = toLabeled(handoffs.rows);
    const subtasksByStatus = toLabeled(subtasks.rows);
    const debateSessionsByStatus = toLabeled(debates.rows);

    return {
      invocationsTotal: sum(invocationsByStatus),
      invocationsByStatus,
      handoffsTotal: sum(handoffsByReason),
      handoffsByReason,
      contextThresholdCrossedTotal: Number(thresholdCrossed.rows[0]?.count ?? 0),
      subtasksTotal: sum(subtasksByStatus),
      subtasksByStatus,
      debateSessionsTotal: sum(debateSessionsByStatus),
      debateSessionsByStatus
    };
  }

  async listHandoffsForTask(runId: string, taskId: string): Promise<HandoffRecord[]> {
    const result = await this.client.query(
      `select id, run_id, task_id, from_invocation_id, to_invocation_id,
              from_role, to_role, reason, status, context_used_pct, packet,
              authority_label, created_at, consumed_at
       from agent_handoffs
       where run_id = $1 and task_id = $2
       order by created_at desc`,
      [runId, taskId]
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      runId: row.run_id as string,
      taskId: row.task_id as string,
      fromInvocationId: row.from_invocation_id as string,
      toInvocationId: (row.to_invocation_id ?? undefined) as string | undefined,
      fromRole: row.from_role as string,
      toRole: row.to_role as string,
      reason: row.reason as string,
      status: row.status as string,
      contextUsedPct: (row.context_used_pct ?? undefined) as number | undefined,
      packet: (row.packet ?? {}) as Record<string, unknown>,
      authorityLabel: (row.authority_label ?? "runtime") as string,
      createdAt: row.created_at as string,
      consumedAt: (row.consumed_at ?? undefined) as string | undefined
    }));
  }

  async listDebateSessionsForRun(
    runId: string,
    taskId?: string | undefined
  ): Promise<DebateSession[]> {
    const params: unknown[] = [runId];
    const taskFilter = taskId !== undefined ? `and task_id = $2` : "";
    if (taskId !== undefined) params.push(taskId);
    const result = await this.client.query(
      `select id, run_id, task_id, topic, trigger_kind, status,
              decision, created_at, completed_at
       from agent_debate_sessions
       where run_id = $1 ${taskFilter}
       order by created_at desc`,
      params
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      runId: row.run_id as string,
      taskId: (row.task_id ?? undefined) as string | undefined,
      topic: row.topic as string,
      triggerKind: row.trigger_kind as DebateSession["triggerKind"],
      status: row.status as DebateSession["status"],
      decision: (row.decision ?? undefined) as Record<string, unknown> | undefined,
      createdAt: row.created_at as string,
      completedAt: (row.completed_at ?? undefined) as string | undefined
    }));
  }

  async getDebateSession(sessionId: string): Promise<DebateSession | null> {
    const result = await this.client.query(
      `select id, run_id, task_id, topic, trigger_kind, status,
              decision, created_at, completed_at
       from agent_debate_sessions
       where id = $1`,
      [sessionId]
    );
    if (result.rows.length === 0) return null;
     
    const row = result.rows[0]!;
    return {
      id: row.id as string,
      runId: row.run_id as string,
      taskId: (row.task_id ?? undefined) as string | undefined,
      topic: row.topic as string,
      triggerKind: row.trigger_kind as DebateSession["triggerKind"],
      status: row.status as DebateSession["status"],
      decision: (row.decision ?? undefined) as Record<string, unknown> | undefined,
      createdAt: row.created_at as string,
      completedAt: (row.completed_at ?? undefined) as string | undefined
    };
  }

  async getInvocationForSpawning(invocationId: string): Promise<
    | { status: string; taskId: string; runId: string; role: string; depth: number; metadata: Record<string, unknown> }
    | undefined
  > {
    const result = await this.client.query(
      `select status, task_id, run_id, role, coalesce(depth, 0) as depth, metadata
       from agent_invocations
       where id = $1`,
      [invocationId]
    );
    if (result.rows.length === 0) return undefined;
     
    const row = result.rows[0]!;
    return {
      status: row.status as string,
      taskId: row.task_id as string,
      runId: row.run_id as string,
      role: row.role as string,
      depth: Number(row.depth),
      metadata: (row.metadata ?? {}) as Record<string, unknown>
    };
  }

  /**
   * AC11 handoff presence check.
   *
   * Returns:
   *   hasInvocations — true if any agent_invocations rows exist for this task (managed run)
   *   hasContextThreshold — true if any context sample for the task has used_percentage >= 70
   *   hasHandoff — true if at least one agent_handoffs row exists for the task with
   *                reason = 'context_threshold_70' or 'precompact_fallback'
   */
  async checkHandoffPresenceForTask(taskId: string): Promise<{
    hasInvocations: boolean;
    hasContextThreshold: boolean;
    hasHandoff: boolean;
  }> {
    const invResult = await this.client.query(
      `select 1 from agent_invocations where task_id = $1 limit 1`,
      [taskId]
    );
    const hasInvocations = invResult.rows.length > 0;

    if (!hasInvocations) {
      return { hasInvocations: false, hasContextThreshold: false, hasHandoff: false };
    }

    const sampleResult = await this.client.query(
      `select 1 from agent_context_samples
       where task_id = $1 and used_percentage >= 70
       limit 1`,
      [taskId]
    );
    const hasContextThreshold = sampleResult.rows.length > 0;

    if (!hasContextThreshold) {
      return { hasInvocations: true, hasContextThreshold: false, hasHandoff: false };
    }

    const handoffResult = await this.client.query(
      `select 1 from agent_handoffs
       where task_id = $1
         and reason in ('context_threshold_70', 'precompact_fallback')
       limit 1`,
      [taskId]
    );
    const hasHandoff = handoffResult.rows.length > 0;

    return { hasInvocations: true, hasContextThreshold: true, hasHandoff };
  }

  /**
   * Returns a snapshot of agentic runtime state for a given task for status display.
   * Queries agent_invocations, agent_context_samples, and agent_handoffs.
   * Returns undefined if no invocations exist for the task.
   */
  async getAgenticStateForTask(taskId: string): Promise<{
    contextPct: number | undefined;
    contextBudgetState: string | undefined;
    handoffState: "committed" | "pending" | "none";
    handoffCommittedAt: string | undefined;
    subagentsActive: number;
  } | undefined> {
    const invResult = await this.client.query(
      `select 1 from agent_invocations where task_id = $1 limit 1`,
      [taskId]
    );
    if (invResult.rows.length === 0) return undefined;

    const [sampleResult, handoffResult, activeResult] = await Promise.all([
      this.client.query(
        `select used_percentage, budget_state
         from agent_context_samples
         where task_id = $1
         order by sampled_at desc
         limit 1`,
        [taskId]
      ),
      this.client.query(
        `select committed_at
         from agent_handoffs
         where task_id = $1
         order by committed_at desc
         limit 1`,
        [taskId]
      ),
      this.client.query(
        `select count(*) as cnt
         from agent_invocations
         where task_id = $1 and status = 'active'`,
        [taskId]
      )
    ]);

     
    const latestSample = sampleResult.rows[0] as { used_percentage: number | null; budget_state: string | null } | undefined;
     
    const latestHandoff = handoffResult.rows[0] as { committed_at: string | null } | undefined;
     
    const activeCount = Number((activeResult.rows[0] as { cnt: string } | undefined)?.cnt ?? 0);

    return {
      contextPct: latestSample?.used_percentage ?? undefined,
      contextBudgetState: latestSample?.budget_state ?? undefined,
      handoffState: latestHandoff
        ? latestHandoff.committed_at
          ? "committed"
          : "pending"
        : "none",
      handoffCommittedAt: latestHandoff?.committed_at ?? undefined,
      subagentsActive: activeCount
    };
  }

  // -------------------------------------------------------------------------
  // AgenticLoopStoreLike bridge methods
  // -------------------------------------------------------------------------

  /**
   * Return the next ready task for the given run, or null if none.
   * Maps to AgenticLoopStoreLike.getNextTask.
   */
  async getNextTask(runId: string): Promise<TaskSummary | null> {
    const result = await this.client.query(
      `select task_key as id, title, status
       from tasks
       where run_id = $1::uuid and status = 'ready'
       order by created_at asc
       limit 1`,
      [runId]
    );
    const row = result.rows[0] as { id: string; title: string; status: string } | undefined;
    if (row === undefined) return null;
    return { id: row.id, title: row.title, status: row.status };
  }

  /**
   * Create an agent invocation record with status "running".
   * Returns the new invocationId.
   * Maps to AgenticLoopStoreLike.createInvocation.
   */
  async createInvocation(data: {
    runId: string;
    taskId: string;
    role: string;
    startedAt: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.createAgentInvocation({
      id,
      runId: data.runId,
      taskId: data.taskId,
      role: data.role,
      agentKind: "specialist_owner",
      model: "sonnet",
      effort: "high",
      status: "running",
      contextPolicyId: "default",
      startedAt: data.startedAt
    });
    return id;
  }

  /**
   * Update the status of an invocation record.
   * Maps to AgenticLoopStoreLike.updateInvocationStatus.
   */
  async updateInvocationStatus(
    invocationId: string,
    status: string,
    metadata?: Record<string, unknown> | undefined
  ): Promise<void> {
    await this.updateAgentInvocationStatus(
      invocationId,
      status as AgentInvocation["status"],
      metadata
    );
  }

  /**
   * Return the current status string of an invocation, or undefined.
   * Maps to AgenticLoopStoreLike.getInvocationStatus.
   */
  async getInvocationStatus(invocationId: string): Promise<string | undefined> {
    const inv = await this.getInvocationById(invocationId);
    return inv?.status;
  }

  /**
   * Return the taskId for the given invocation, or undefined.
   * Maps to AgenticLoopStoreLike.getInvocationTaskId.
   */
  async getInvocationTaskId(invocationId: string): Promise<string | undefined> {
    const result = await this.client.query(
      `select task_id from agent_invocations where id = $1`,
      [invocationId]
    );
    const row = result.rows[0] as { task_id: string } | undefined;
    return row?.task_id;
  }

  /**
   * Return the currently active (in_progress) task for a run, or null.
   * Maps to AgenticLoopStoreLike.getActiveTask.
   */
  async getActiveTask(runId: string): Promise<TaskSummary | null> {
    const result = await this.client.query(
      `select task_key as id, title, status
       from tasks
       where run_id = $1::uuid and status = 'in_progress'
       order by updated_at desc
       limit 1`,
      [runId]
    );
    const row = result.rows[0] as { id: string; title: string; status: string } | undefined;
    if (row === undefined) return null;
    return { id: row.id, title: row.title, status: row.status };
  }

  /**
   * Return the currently active (running) invocation ID for a run, or null.
   * Maps to AgenticLoopStoreLike.getActiveInvocation.
   */
  async getActiveInvocation(runId: string): Promise<string | null> {
    const result = await this.client.query(
      `select id
       from agent_invocations
       where run_id = $1::uuid and status = 'running'
       order by started_at desc
       limit 1`,
      [runId]
    );
    const row = result.rows[0] as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Count pending (unconsumed) handoffs for a run.
   * Maps to AgenticLoopStoreLike.countPendingHandoffs.
   */
  async countPendingHandoffs(runId: string): Promise<number> {
    const result = await this.client.query(
      `select count(*) as cnt
       from agent_handoffs
       where run_id = $1::uuid and consumed_at is null`,
      [runId]
    );
    const row = result.rows[0] as { cnt: string } | undefined;
    return Number(row?.cnt ?? 0);
  }
}
