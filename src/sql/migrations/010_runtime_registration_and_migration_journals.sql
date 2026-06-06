create table if not exists runtime_project_registrations (
  project_id text primary key references projects(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  repo_path text not null,
  runtime_profile text not null,
  data_root text not null,
  qdrant_url text,
  qdrant_collection text not null,
  install_manifest_path text,
  manifest jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists runtime_migration_journals (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  phase text not null,
  status text not null,
  backup_manifest_path text not null,
  verification_report_path text not null,
  rollback_state text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_runtime_project_registrations_workspace
  on runtime_project_registrations(workspace_id);

create index if not exists idx_runtime_migration_journals_project_created
  on runtime_migration_journals(project_id, created_at);
