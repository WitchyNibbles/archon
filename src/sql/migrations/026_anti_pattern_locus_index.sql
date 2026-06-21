-- MPL P3: index on memory_entries for locus-filtered anti-pattern queries.
--
-- listAntiPatternsForLocus (PostgresMistakeLedgerStore) queries:
--   WHERE project_id = $1 AND entry_type = 'anti_pattern'
--
-- Without an index this is a full table scan on memory_entries. This index
-- makes the indexed path explicit (council condition 7 requirement).
--
-- Idempotent: CREATE INDEX IF NOT EXISTS is safe to re-run.
-- CONCURRENTLY: avoids locking the table during index build on live systems.
-- Note: CONCURRENTLY cannot run inside a transaction; the migration runner
-- must execute this outside an explicit BEGIN/COMMIT if it wraps statements.
--
-- ROLLBACK PLAN (forward migration — no data loss):
--   DROP INDEX IF EXISTS idx_memory_entries_anti_pattern_project;
--
-- Verification:
--   \d memory_entries  -- should show idx_memory_entries_anti_pattern_project
--   EXPLAIN SELECT id FROM memory_entries WHERE project_id = 'x' AND entry_type = 'anti_pattern';
--   -- Bitmap Index Scan or Index Scan on idx_memory_entries_anti_pattern_project expected

CREATE INDEX IF NOT EXISTS idx_memory_entries_anti_pattern_project
  ON memory_entries (project_id, entry_type)
  WHERE entry_type = 'anti_pattern';
