-- MPL P1.5: structured review findings.
--
-- Adds an optional JSONB column carrying structured ReviewFinding entries
-- (message, severity, category, file, line, symbol) alongside the existing
-- free-text findings[] array. This is the locus channel the Mistake Pattern
-- Ledger reads to compute symbolLocus and finer fingerprints.
--
-- Additive and backward-compatible: the column is nullable, the existing
-- findings text array and the review trust gate (canReviewRecordSatisfyGate /
-- evaluateReviewDecision) are unchanged. A NULL/absent value means the review
-- carried only free-text findings (P1 behavior).
--
-- Idempotent: guarded with IF NOT EXISTS.
--
-- ROLLBACK PLAN (new forward migration):
--   ALTER TABLE reviews DROP COLUMN IF EXISTS finding_details;

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS finding_details jsonb;
