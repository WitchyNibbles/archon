alter table memory_entries
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table artifacts
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_memory_entries_metadata on memory_entries using gin (metadata);
create index if not exists idx_artifacts_metadata on artifacts using gin (metadata);
