-- qdrant_collection was required at creation time but Qdrant has been removed.
-- Give the column a safe default so new registrations succeed until phase 3 drops it.
-- Guarded so the replay-all migration runner stays idempotent after migration 014
-- drops the column.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'runtime_project_registrations'
      and column_name = 'qdrant_collection'
  ) then
    alter table runtime_project_registrations
      alter column qdrant_collection set default '';
  end if;
end $$;
