-- Add provenance tracking to review records
-- source='orchestrator' means written by review-orchestrator agent (trusted gate)
-- source='self' means written by the task agent itself (NOT trusted for gate)
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'self';
CREATE INDEX IF NOT EXISTS reviews_source_task_idx ON reviews (task_id, source) WHERE source = 'orchestrator';
