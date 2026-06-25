// Phase 3 (ahrP3RespawnBudget): per-task respawn budget resolver.
//
// Reads ARCHON_MAX_RESPAWNS_PER_TASK from the environment and returns a
// clamped integer in [1, 50]. Invalid values (non-numeric, out-of-range,
// non-integer, empty, or absent) fall back to the default of 8.
//
// SEC-MED-1: values outside [1, 50] resolve to the default, not the raw
// value, so that a misconfigured env var cannot open an unbounded respawn loop.

/** Default number of allowed respawns per task when the env var is absent or invalid. */
export const DEFAULT_RESPAWN_BUDGET = 8;

/** Minimum allowed respawn budget (inclusive). */
export const MIN_RESPAWN_BUDGET = 1;

/** Maximum allowed respawn budget (inclusive). */
export const MAX_RESPAWN_BUDGET = 50;

/**
 * Resolve the per-task respawn budget from `ARCHON_MAX_RESPAWNS_PER_TASK`.
 *
 * Rules:
 * - absent or empty → DEFAULT_RESPAWN_BUDGET (8)
 * - non-integer or non-finite → DEFAULT_RESPAWN_BUDGET (8)
 * - value < MIN_RESPAWN_BUDGET (1) → DEFAULT_RESPAWN_BUDGET (8)
 * - value > MAX_RESPAWN_BUDGET (50) → DEFAULT_RESPAWN_BUDGET (8)
 * - valid integer in [1, 50] → that value
 *
 * Never throws. Reads process.env at call time so tests can override freely.
 */
export function resolveRespawnBudget(): number {
  const raw = process.env["ARCHON_MAX_RESPAWNS_PER_TASK"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RESPAWN_BUDGET;
  }
  const parsed = Number(raw.trim());
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_RESPAWN_BUDGET ||
    parsed > MAX_RESPAWN_BUDGET
  ) {
    return DEFAULT_RESPAWN_BUDGET;
  }
  return parsed;
}
