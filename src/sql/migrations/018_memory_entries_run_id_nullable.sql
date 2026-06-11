-- Allow memory entries to be saved without a run context.
-- The ingestion pipeline saves entries from .archon/memory/ files on task
-- close, outside any run, so run_id must be nullable.
ALTER TABLE memory_entries ALTER COLUMN run_id DROP NOT NULL;
