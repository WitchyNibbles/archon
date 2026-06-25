/**
 * @module forge/spend-cap
 *
 * Run-level spend-cap token bucket for the opt-in API image provider (P5-S5, CC-10, U2).
 *
 * Deny-by-default is HARDCODED here: an absent / empty / zero / negative / non-integer cap
 * yields an unconfigured bucket that denies every debit. Only a positive integer cap allows
 * spending, and only up to that many units per process run. This is the financial gate — it is
 * never a config default that could be flipped to "allow".
 *
 * Extracted from asset-provider.ts to keep that module under the 800-line limit.
 */

/**
 * Run-level spend-cap token bucket (CC-10, U2).
 * Absent/zero/negative/unparseable cap → deny (hardcoded; never a config default).
 * Positive integer → allow; debit BEFORE each API call; deny once exhausted.
 */
export class SpendCapBucket {
  readonly #cap: number | null;
  #remaining: number;

  constructor(capString: string | undefined) {
    if (capString === undefined || capString.trim() === "") {
      this.#cap = null; this.#remaining = 0; return;
    }
    const parsed = Number(capString.trim());
    if (!Number.isInteger(parsed) || parsed <= 0 || !Number.isFinite(parsed)) {
      this.#cap = null; this.#remaining = 0; return;
    }
    this.#cap = parsed;
    this.#remaining = parsed;
  }

  get isConfigured(): boolean { return this.#cap !== null; }
  get hasRemaining(): boolean { return this.#cap !== null && this.#remaining > 0; }
  get remaining(): number { return this.#remaining; }

  /**
   * Atomically reserve one unit of budget. Returns true if a unit was reserved
   * (the caller may spend), false if the bucket is unconfigured or exhausted.
   *
   * This single check-and-decrement is the financial gate: callers MUST use
   * `tryDebit()` (not `hasRemaining` + a separate decrement) before each API call,
   * so two concurrent async `generate()` invocations cannot both observe remaining
   * budget and then both spend (the TOCTOU window a separate getter/method left open).
   * JS runs this method to completion without yielding (no `await`), so the check and
   * the decrement are atomic with respect to other callers.
   */
  tryDebit(): boolean {
    if (this.#cap === null || this.#remaining <= 0) {
      return false;
    }
    this.#remaining -= 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Run-level bucket singleton (one per process run; injectable via deps for tests)
// ---------------------------------------------------------------------------

let runBucket: SpendCapBucket | undefined;

/**
 * Returns (or creates) the process-level SpendCapBucket from the cap string.
 * Tests override via `deps.spendCapBucket`; otherwise the first call seeds the singleton.
 */
export function getRunBucket(capString: string | undefined): SpendCapBucket {
  if (runBucket === undefined) {
    runBucket = new SpendCapBucket(capString);
  }
  return runBucket;
}

/** Reset the run-level bucket. TEST USE ONLY. */
export function resetRunBucket(): void {
  runBucket = undefined;
}
