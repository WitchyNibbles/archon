// Phase 1 (ahrP1Sampling) — pure context usage helpers.
//
// These functions are intentionally side-effect-free so they can be tested
// without a database or Claude CLI connection.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// ---------------------------------------------------------------------------
// computeUsedPct
// ---------------------------------------------------------------------------

/**
 * Compute the context window used percentage from a token usage snapshot.
 *
 * Formula: 100 * (inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens) / contextWindowTokens
 *
 * Returns undefined when:
 *   - usage is undefined (no data yet)
 *   - contextWindowTokens is 0 or negative (division-by-zero guard)
 *
 * Does NOT clamp to [0, 100] — callers may observe >100% when token counts
 * exceed the declared window size.
 */
export function computeUsedPct(
  usage: TokenUsage | undefined,
  contextWindowTokens: number
): number | undefined {
  if (usage === undefined) return undefined;
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return undefined;

  const totalTokens =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0) +
    (usage.outputTokens ?? 0);

  return (100 * totalTokens) / contextWindowTokens;
}

// ---------------------------------------------------------------------------
// resolveModelContextTokens
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Read the model's context window size from the environment.
 *
 * Env var: ARCHON_MODEL_CONTEXT_TOKENS (default 200000)
 *
 * Falls back to the default when the var is absent, empty, zero, negative, or
 * non-numeric. Accepts floating-point values (Claude's reported window may not
 * be an exact integer).
 */
export function resolveModelContextTokens(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.ARCHON_MODEL_CONTEXT_TOKENS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONTEXT_WINDOW_TOKENS;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  return parsed;
}

// ---------------------------------------------------------------------------
// mergeUsedPct
// ---------------------------------------------------------------------------

/**
 * Merge two context usage signals using the conservative (max) strategy.
 *
 * - Both defined → return the larger of the two (conservative: assume worst case)
 * - One defined → return that signal
 * - Neither defined → return undefined
 */
export function mergeUsedPct(
  cliPct: number | undefined,
  selfReportPct: number | undefined
): number | undefined {
  if (cliPct === undefined && selfReportPct === undefined) return undefined;
  if (cliPct === undefined) return selfReportPct;
  if (selfReportPct === undefined) return cliPct;
  return Math.max(cliPct, selfReportPct);
}
