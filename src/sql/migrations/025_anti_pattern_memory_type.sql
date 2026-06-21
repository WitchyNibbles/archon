-- MPL P2: add "anti_pattern" to memory_entries.entry_type CHECK constraint.
--
-- The initial schema (001) defined the constraint as:
--   check (entry_type in ('fact', 'decision', 'pattern', 'lesson'))
--
-- This migration extends it to include 'anti_pattern' so that distilled
-- mistake patterns produced by the MPL P2 distillation path can be stored
-- in memory_entries via promoteMemory.
--
-- Idempotent: the existing constraint is dropped by name if it exists, then
-- re-added with the expanded value list. The drop-if-exists guard prevents
-- failures on repeated application.
--
-- ROLLBACK PLAN (new forward migration):
--   -- Remove anti_pattern from the constraint (forward migration — no data loss
--   -- if no anti_pattern rows exist; if they do exist, delete them first):
--   ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_entries_entry_type_check;
--   ALTER TABLE memory_entries ADD CONSTRAINT memory_entries_entry_type_check
--     CHECK (entry_type IN ('fact', 'decision', 'pattern', 'lesson'));

-- Step 1: drop the old constraint if it exists (name may vary — try both forms).
ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_entries_entry_type_check;

-- Step 2: re-add with anti_pattern included.
ALTER TABLE memory_entries
  ADD CONSTRAINT memory_entries_entry_type_check
  CHECK (entry_type IN ('fact', 'decision', 'pattern', 'lesson', 'anti_pattern'));
