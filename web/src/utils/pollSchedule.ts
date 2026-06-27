/**
 * Poll schedule — dashQuality S2 bounded backoff (council C3).
 *
 * The dashboard polls the static snapshot on a bounded interval (no SSE/websocket —
 * the browser reads JSON only, preserving the R2-C seam). On a steady, healthy feed
 * we poll at BASE_POLL_INTERVAL_MS. On consecutive errors we back off exponentially,
 * capped hard at MAX_POLL_INTERVAL_MS so a persistently-down feed degrades to an
 * occasional retry rather than a tight failing loop.
 *
 * Pure + dependency-free so it can be unit-tested with the root node:test runner
 * (tests/dash-poll-schedule.test.ts).
 */

/** Steady poll cadence when the last poll succeeded. */
export const BASE_POLL_INTERVAL_MS = 10_000;

/** Hard ceiling on the backed-off interval. Backoff never exceeds this. */
export const MAX_POLL_INTERVAL_MS = 120_000;

/**
 * Delay before the next poll, given the number of consecutive failures since the
 * last success.
 *
 *   0 errors            → base interval (steady poll)
 *   N (N > 0) errors     → min(base * 2^N, cap)  (exponential backoff, hard cap)
 *
 * Defensive: negative / NaN / fractional inputs are coerced to a safe non-negative
 * integer so a corrupt counter can never produce a sub-base or NaN delay.
 */
export function nextPollDelayMs(
  consecutiveErrors: number,
  base: number = BASE_POLL_INTERVAL_MS,
  cap: number = MAX_POLL_INTERVAL_MS
): number {
  const safeErrors =
    Number.isFinite(consecutiveErrors) && consecutiveErrors > 0
      ? Math.floor(consecutiveErrors)
      : 0;

  if (safeErrors === 0) {
    return base;
  }

  const backoff = base * 2 ** safeErrors;
  return Math.min(backoff, cap);
}
