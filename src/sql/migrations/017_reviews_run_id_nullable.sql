-- Allow orchestrator-submitted reviews to exist without a run context.
-- The review-orchestrator agent saves reviews via the save-review CLI which
-- has no run_id; making this nullable lets those rows insert cleanly.
ALTER TABLE reviews ALTER COLUMN run_id DROP NOT NULL;
