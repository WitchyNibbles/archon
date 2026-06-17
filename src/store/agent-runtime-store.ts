// Agent Runtime Store — Phase 1 of the Archon Agentic Loop Runtime.
//
// Provides typed store methods for agent_invocations, agent_context_samples,
// agent_handoffs, agent_subtasks, agent_debate_sessions, and
// agent_debate_arguments.
//
// Separated from postgres-store.ts to keep that file under the 800-line limit.

import type { SqlClient } from "./postgres-store.ts";
import type {
  AgentInvocation,
  ContextSample,
  Subtask,
  DebateSession,
  DebateArgument
} from "../domain/types.ts";

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

    await this.client.query(
      `insert into agent_invocations
         (id, run_id, task_id, parent_invocation_id, role, agent_kind, model,
          effort, status, context_policy_id, session_id, transcript_path,
          started_at, metadata)
       values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
}
