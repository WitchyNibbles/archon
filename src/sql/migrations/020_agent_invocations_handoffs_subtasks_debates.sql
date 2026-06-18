-- Phase 1: Archon Agentic Loop Runtime schema.
--
-- Adds six tables for agent invocation tracking, context sampling, context
-- handoffs, specialist subtasks, and multi-agent debate sessions.
--
-- Safe to run on fresh databases and databases that have run migrations 001-019.
-- All CREATE TABLE statements use IF NOT EXISTS for idempotency.
-- Indexes use IF NOT EXISTS (Postgres 9.5+).
--
-- ROLLBACK PLAN (new forward migration):
--   Drop in reverse dependency order:
--     DROP TABLE IF EXISTS agent_debate_arguments;
--     DROP TABLE IF EXISTS agent_debate_sessions;
--     DROP TABLE IF EXISTS agent_subtasks;
--     DROP TABLE IF EXISTS agent_handoffs;
--     DROP TABLE IF EXISTS agent_context_samples;
--     DROP TABLE IF EXISTS agent_invocations;

-- ---------------------------------------------------------------------------
-- agent_invocations
-- ---------------------------------------------------------------------------
-- Every Archon-managed agent invocation registers a runtime identity here.
-- parent_invocation_id is nullable (NULL for root/top-level invocations).
-- run_id is UUID to match runs.id; task_id is TEXT (advisory, not FK).

create table if not exists agent_invocations (
  id                   text        primary key,
  run_id               uuid        not null references runs(id) on delete cascade,
  task_id              text        not null,
  parent_invocation_id text        references agent_invocations(id),
  role                 text        not null,
  agent_kind           text        not null,
  model                text        not null,
  effort               text        not null,
  status               text        not null,
  context_policy_id    text        not null,
  session_id           text,
  transcript_path      text,
  depth                integer     not null default 0,
  started_at           timestamptz not null default now(),
  ended_at             timestamptz,
  metadata             jsonb       not null default '{}'::jsonb
);

create index if not exists agent_invocations_run_task_idx
  on agent_invocations(run_id, task_id);

create index if not exists agent_invocations_parent_idx
  on agent_invocations(parent_invocation_id)
  where parent_invocation_id is not null;

create index if not exists agent_invocations_status_idx
  on agent_invocations(status);

-- ---------------------------------------------------------------------------
-- agent_context_samples
-- ---------------------------------------------------------------------------
-- Periodic context-window usage snapshots for an invocation.
-- Used by ContextBudgetMonitor to detect the 70% threshold.

create table if not exists agent_context_samples (
  id                    bigserial   primary key,
  invocation_id         text        not null references agent_invocations(id) on delete cascade,
  run_id                uuid        not null references runs(id) on delete cascade,
  task_id               text        not null,
  source                text        not null,
  used_percentage       numeric(5,2),
  remaining_percentage  numeric(5,2),
  current_usage_tokens  integer,
  context_window_size   integer,
  sampled_at            timestamptz not null default now(),
  raw                   jsonb       not null default '{}'::jsonb
);

create index if not exists agent_context_samples_invocation_time_idx
  on agent_context_samples(invocation_id, sampled_at desc);

create index if not exists agent_context_samples_run_task_idx
  on agent_context_samples(run_id, task_id);

-- ---------------------------------------------------------------------------
-- agent_handoffs
-- ---------------------------------------------------------------------------
-- Durable handoff packets persisted when an agent crosses the context threshold
-- or encounters a role boundary.  to_invocation_id is NULL until the
-- continuation invocation is created and consumes this handoff.

create table if not exists agent_handoffs (
  id                  text        primary key,
  run_id              uuid        not null references runs(id) on delete cascade,
  task_id             text        not null,
  from_invocation_id  text        not null references agent_invocations(id),
  to_invocation_id    text        references agent_invocations(id),
  from_role           text        not null,
  to_role             text        not null,
  reason              text        not null,
  status              text        not null,
  context_used_pct    numeric(5,2),
  packet              jsonb       not null,
  authority_label     text        not null default 'runtime_authoritative',
  created_at          timestamptz not null default now(),
  consumed_at         timestamptz
);

create index if not exists agent_handoffs_run_task_created_idx
  on agent_handoffs(run_id, task_id, created_at desc);

create index if not exists agent_handoffs_unconsumed_idx
  on agent_handoffs(run_id, task_id)
  where consumed_at is null;

-- ---------------------------------------------------------------------------
-- agent_subtasks
-- ---------------------------------------------------------------------------
-- Bounded subtasks spawned by a specialist owner to a lower-level subagent.
-- child_invocation_id is NULL until the subagent is started.

create table if not exists agent_subtasks (
  id                   text        primary key,
  run_id               uuid        not null references runs(id) on delete cascade,
  task_id              text        not null,
  parent_invocation_id text        not null references agent_invocations(id),
  child_invocation_id  text        references agent_invocations(id),
  subagent_type        text        not null,
  title                text        not null,
  prompt               text        not null,
  allowed_tools        text[]      not null default array[]::text[],
  allowed_write_scope  text[]      not null default array[]::text[],
  status               text        not null,
  result_packet        jsonb,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz
);

create index if not exists agent_subtasks_run_task_idx
  on agent_subtasks(run_id, task_id);

create index if not exists agent_subtasks_parent_idx
  on agent_subtasks(parent_invocation_id);

create index if not exists agent_subtasks_status_idx
  on agent_subtasks(status);

-- ---------------------------------------------------------------------------
-- agent_debate_sessions
-- ---------------------------------------------------------------------------
-- One row per multi-agent debate invocation.  decision is NULL until the
-- debate reaches a conclusion.

create table if not exists agent_debate_sessions (
  id           text        primary key,
  run_id       uuid        not null references runs(id) on delete cascade,
  task_id      text,
  topic        text        not null,
  trigger_kind text        not null,
  status       text        not null,
  decision     jsonb,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists agent_debate_sessions_run_idx
  on agent_debate_sessions(run_id);

create index if not exists agent_debate_sessions_run_task_idx
  on agent_debate_sessions(run_id, task_id)
  where task_id is not null;

-- ---------------------------------------------------------------------------
-- agent_debate_arguments
-- ---------------------------------------------------------------------------
-- One row per argument/critique/vote contribution within a debate session.
-- evidence_refs and critiques are TEXT[] arrays for compactness.

create table if not exists agent_debate_arguments (
  id                text        primary key,
  debate_session_id text        not null references agent_debate_sessions(id) on delete cascade,
  round             integer     not null,
  role              text        not null,
  position          text        not null,
  evidence_refs     text[]      not null default array[]::text[],
  critiques         text[]      not null default array[]::text[],
  vote              text,
  created_at        timestamptz not null default now()
);

create index if not exists agent_debate_arguments_session_round_idx
  on agent_debate_arguments(debate_session_id, round);
