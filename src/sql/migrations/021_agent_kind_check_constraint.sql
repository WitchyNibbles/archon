-- Defense-in-depth for SDD §18.3 review independence and §20 spawn controls.
--
-- The TypeScript `agentKinds` enum (src/domain/types.ts) is the only thing that
-- currently constrains agent_invocations.agent_kind. A direct-to-DB write (or a
-- future store method) using an unexpected kind would silently evade the
-- review-independence gate, which keys "implementer" off agent_kind. This adds a
-- DB-level CHECK so the column can only hold known kinds.
--
-- Idempotent: migrate() re-runs every migration file, so the constraint is added
-- only when absent. Safe on existing rows (all current values are in the set).
--
-- ROLLBACK PLAN (new forward migration):
--   ALTER TABLE agent_invocations DROP CONSTRAINT IF EXISTS agent_invocations_agent_kind_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_invocations_agent_kind_check'
      AND conrelid = 'agent_invocations'::regclass
  ) THEN
    ALTER TABLE agent_invocations
      ADD CONSTRAINT agent_invocations_agent_kind_check
      CHECK (agent_kind IN (
        'root_manager',
        'specialist_owner',
        'subagent',
        'reviewer',
        'debate_participant'
      ));
  END IF;
END
$$;
