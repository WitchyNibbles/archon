create table if not exists project_runtime_state (
  project_id text primary key references projects(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  active_run_id uuid references runs(id) on delete set null,
  active_task_id text,
  task_queue jsonb not null default '{"project_status":"idle","current_task_id":null,"tasks":[]}'::jsonb,
  product_state jsonb not null default '{"status":"idle","items":[]}'::jsonb,
  last_verified_run_id uuid references runs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workflow_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  run_id uuid references runs(id) on delete cascade,
  task_id text,
  kind text not null,
  title text not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_runtime_state_workspace on project_runtime_state(workspace_id);
create index if not exists idx_workflow_documents_project_kind on workflow_documents(project_id, kind, created_at desc);
create index if not exists idx_workflow_documents_run_task on workflow_documents(run_id, task_id, created_at desc);
