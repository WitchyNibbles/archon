create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists workspaces (
  id text primary key,
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  slug text not null,
  name text not null,
  repo_path text,
  created_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists runs (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  actor text not null,
  title text not null,
  request_text text not null,
  intake_summary jsonb not null,
  status text not null check (status in ('intake', 'planned', 'decomposed', 'ready', 'in_progress', 'review_blocked', 'approved', 'memorized', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  task_key text not null,
  title text not null,
  owner_role text not null,
  status text not null check (status in ('ready', 'in_progress', 'review_blocked', 'approved', 'done', 'blocked')),
  allowed_write_scope text[] not null default '{}',
  out_of_scope text[] not null default '{}',
  acceptance_criteria text[] not null default '{}',
  verification_steps text[] not null default '{}',
  required_reviews text[] not null default '{}',
  security_checks text[] not null default '{}',
  anti_patterns text[] not null default '{}',
  rollback_notes text not null,
  handoff_format text not null,
  payload jsonb not null,
  claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, task_key)
);

create table if not exists task_dependencies (
  task_id uuid not null references tasks(id) on delete cascade,
  depends_on_task_key text not null,
  primary key (task_id, depends_on_task_key)
);

create table if not exists artifacts (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  kind text not null,
  title text not null,
  content jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536),
  embedding_model text,
  created_at timestamptz not null default now()
);

create table if not exists handoffs (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  task_id text not null,
  actor text not null,
  summary text not null,
  changed_files text[] not null default '{}',
  blockers text[] not null default '{}',
  verification_notes text[] not null default '{}',
  context_refs text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists approvals (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  task_id text not null,
  actor text not null,
  decision text not null check (decision in ('approved', 'blocked', 'waived')),
  rationale text not null,
  created_at timestamptz not null default now()
);

create table if not exists reviews (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  task_id text not null,
  reviewer_role text not null,
  state text not null check (state in ('pending', 'passed', 'blocked', 'waived')),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  findings text[] not null default '{}',
  waiver_reason text,
  evidence_refs text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists locks (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  task_id text not null,
  scope_paths text[] not null default '{}',
  status text not null check (status in ('active', 'released')),
  created_at timestamptz not null default now(),
  released_at timestamptz
);

create table if not exists memory_entries (
  id uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text references projects(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  task_id text,
  scope text not null check (scope in ('global', 'project')),
  entry_type text not null check (entry_type in ('fact', 'decision', 'pattern', 'lesson')),
  title text not null,
  content text not null,
  reviewer text not null,
  actor text not null,
  status text not null check (status in ('proposed', 'approved', 'rejected')),
  source_path text,
  source_anchor text,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536),
  embedding_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text references projects(id) on delete cascade,
  source_table text not null,
  source_id text not null,
  embedding_model text not null,
  status text not null check (status in ('pending', 'processing', 'done', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table artifacts
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table memory_entries
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_runs_project_status on runs(project_id, status);
create index if not exists idx_tasks_run_status on tasks(run_id, status);
create index if not exists idx_locks_project_status on locks(project_id, status);
create index if not exists idx_memory_scope_status on memory_entries(workspace_id, scope, status);
create index if not exists idx_memory_entries_metadata on memory_entries using gin (metadata);
create index if not exists idx_artifacts_run_kind on artifacts(run_id, kind);
create index if not exists idx_artifacts_metadata on artifacts using gin (metadata);
create unique index if not exists idx_embedding_jobs_source_model on embedding_jobs(source_table, source_id, embedding_model);
