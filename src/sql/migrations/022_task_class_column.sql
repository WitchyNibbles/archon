-- Option B review-floor relaxation (slice 2): immutable task class column.
--
-- Adds a `class text NOT NULL` column to `tasks` with a CHECK constraint
-- ensuring only the 7 canonical TaskClass values are accepted. New INSERTs must
-- supply the class; existing rows are backfilled to `prototype_slice` (the
-- safe, most-reviewed default — matches `normalizeTaskClass` legacy alias).
--
-- The column is intentionally NOT updated by `updateTask` — the application
-- layer in src/store/postgres-store.ts enforces immutability (throws if the
-- caller tries to change it). The DB constraint provides defense-in-depth.
--
-- Idempotent: migrate() re-runs all migrations; each step is guarded.
--
-- ROLLBACK PLAN (new forward migration):
--   ALTER TABLE tasks DROP COLUMN IF EXISTS class;

DO $$
BEGIN
  -- Step 1: add column with a temporary default for backfill (no NOT NULL yet).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'class'
  ) THEN
    ALTER TABLE tasks ADD COLUMN class text DEFAULT 'prototype_slice';
  END IF;

  -- Step 2: backfill any null rows (handles the transient state before the
  -- NOT NULL constraint is applied — safe to re-run).
  UPDATE tasks SET class = 'prototype_slice' WHERE class IS NULL;

  -- Step 3: add NOT NULL constraint if absent.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks'
      AND column_name = 'class'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE tasks ALTER COLUMN class SET NOT NULL;
  END IF;

  -- Step 4: add CHECK constraint if absent.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_class_check'
      AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_class_check
      CHECK (class IN (
        'prototype_slice',
        'security_sensitive',
        'release_candidate',
        'docs_only',
        'memory_curation',
        'state_sync',
        'scaffold_only'
      ));
  END IF;

  -- Step 5: drop the default so future INSERTs must supply class explicitly.
  -- (The application always supplies it; this forces omission to be an error.)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks'
      AND column_name = 'class'
      AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE tasks ALTER COLUMN class DROP DEFAULT;
  END IF;
END
$$;
