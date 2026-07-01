/**
 * Fail-fast archon config validator.
 *
 * Call validateArchonConfig(process.env) right after loadDotEnv() to surface
 * ALL configuration problems at startup — not deep inside a command handler.
 *
 * Design:
 *  - Pure function: no I/O, no process.exit — callers decide what to do with
 *    the result.
 *  - Aggregated errors: every invalid or missing var is listed at once, so
 *    the operator sees the full picture in a single run.
 *  - Optional `required` list: callers can declare which schema keys must be
 *    present for their context (e.g. daemon requires PROJECT_SLUG).
 */
import type { ZodError } from "zod";
import { archonConfigSchema } from "./schema.ts";
import type { ArchonConfig } from "./schema.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Successful validation result with the parsed, default-applied config. */
export interface ValidateSuccess {
  readonly ok: true;
  readonly config: ArchonConfig;
}

/** Failed validation result with an aggregated, human-readable error list. */
export interface ValidateFailure {
  readonly ok: false;
  /** Every failing var is listed here — one entry per field. */
  readonly errors: readonly string[];
  /** Single message suitable for printing: one line per error. */
  readonly message: string;
}

export type ValidateResult = ValidateSuccess | ValidateFailure;

/** Options for validateArchonConfig. */
export interface ValidateOptions {
  /**
   * Keys from the schema that MUST be present (non-empty) in the environment.
   * Any key listed here that resolves to undefined after parsing is added to
   * the error list.  Use this to enforce runtime-specific requirements.
   *
   * Example (daemon startup):
   *   required: ["ARCHON_CORE_DATABASE_URL", "ARCHON_PROJECT_SLUG"]
   */
  readonly required?: readonly (keyof ArchonConfig)[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Validate all ARCHON_* environment variables in `env`.
 *
 * Returns either a parsed config (with defaults applied) or an aggregated list
 * of errors — one entry per failing variable — so the operator sees everything
 * wrong in a single startup message rather than discovering problems one at a
 * time.
 *
 * @param env - Environment object (typically process.env or a subset thereof).
 * @param options - Optional: declare additional required keys.
 */
export function validateArchonConfig(
  env: Record<string, string | undefined>,
  options?: ValidateOptions
): ValidateResult {
  const errors: string[] = [];

  // --- Format / shape validation via Zod -----------------------------------
  const parsed = archonConfigSchema.safeParse(env);

  if (!parsed.success) {
    errors.push(...formatZodErrors(parsed.error));
  }

  // --- Required-key presence check -----------------------------------------
  if (options?.required && options.required.length > 0) {
    // Use the partially-parsed data when available; fall back to raw env.
    const data: Record<string, unknown> = parsed.success
      ? (parsed.data as Record<string, unknown>)
      : (env as Record<string, unknown>);

    for (const key of options.required) {
      const val = data[key];
      if (val === undefined || val === null || val === "") {
        errors.push(`${key}: required but not set`);
      }
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      message: errors.join("\n"),
    };
  }

  // Zod parse succeeded and all required keys are present.
  return {
    ok: true,
    config: (parsed as { success: true; data: ArchonConfig }).data,
  };
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/** Convert a ZodError into one human-readable string per failing field. */
function formatZodErrors(zodError: ZodError): string[] {
  // Group issues by their first path element (the env var name).
  const byKey = new Map<string, string[]>();

  for (const issue of zodError.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "unknown";
    const messages = byKey.get(key) ?? [];
    messages.push(issue.message);
    byKey.set(key, messages);
  }

  return Array.from(byKey.entries()).map(
    ([key, messages]) => `${key}: ${messages.join("; ")}`
  );
}

/**
 * Throw if the result is a failure, logging all errors to stderr first.
 * Convenience wrapper for CLI entrypoints that want a synchronous fail-fast.
 */
export function assertValidArchonConfig(
  result: ValidateResult
): asserts result is ValidateSuccess {
  if (!result.ok) {
    const header = "archon: configuration error — fix the following before starting:";
    process.stderr.write(`${header}\n${result.message}\n`);
    process.exit(1);
  }
}
