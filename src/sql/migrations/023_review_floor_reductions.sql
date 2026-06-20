-- Option B review-floor relaxation (slice 3): review_floor_reductions provenance table.
--
-- First-class columns (not JSON) so the reduction audit is queryable without
-- parsing. A row is written at gate-decision time when a review-floor reduction
-- occurs. Idempotent on (run_id, task_id, decided_at) via UNIQUE constraint +
-- ON CONFLICT DO NOTHING in the store method.
--
-- Only written when ARCHON_REVIEW_FLOOR_REDUCTION is truthy. The table is
-- otherwise empty — a missing row means no reduction occurred (full trio).
--
-- Idempotent: each step is guarded.
--
-- ROLLBACK PLAN (new forward migration):
--   DROP TABLE IF EXISTS review_floor_reductions;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'review_floor_reductions'
  ) THEN
    CREATE TABLE review_floor_reductions (
      id             text        NOT NULL PRIMARY KEY,
      run_id         text        NOT NULL,
      task_id        text        NOT NULL,
      derived_class  text        NOT NULL,
      dropped_roles  text[]      NOT NULL,
      effective_floor text[]     NOT NULL,
      write_scope_snapshot text[] NOT NULL,
      basis          text        NOT NULL DEFAULT 'opt_out_class_safe_scope',
      source         text        NOT NULL DEFAULT 'runtime',
      decided_at     timestamptz NOT NULL DEFAULT now()
    );
  END IF;

  -- Unique constraint: one provenance row per (run_id, task_id, decided_at).
  -- Prevents double-writes when the gate is evaluated multiple times in the
  -- same second; ON CONFLICT DO NOTHING in the store is idempotent.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'review_floor_reductions_unique_decision'
      AND conrelid = 'review_floor_reductions'::regclass
  ) THEN
    ALTER TABLE review_floor_reductions
      ADD CONSTRAINT review_floor_reductions_unique_decision
      UNIQUE (run_id, task_id, decided_at);
  END IF;
END
$$;
