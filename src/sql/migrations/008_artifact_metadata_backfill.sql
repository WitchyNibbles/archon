alter table artifacts
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_artifacts_metadata on artifacts using gin (metadata);
