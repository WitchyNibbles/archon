/**
 * Fail-fast archon config validator.
 *
 * Call validateArchonConfig(process.env, { required: [...] }) right after
 * loadDotEnv() to surface ALL configuration problems at startup — not deep
 * inside a command handler.
 *
 * Design:
 *  - Pure function: no I/O, no process.exit — callers decide what to do with
 *    the result.
 *  - Aggregated errors: every invalid or missing var is listed at once, so
 *    the operator sees the full picture in a single run.
 *  - Immutable accumulation: no array mutation; errors are built with spread.
 *  - Optional `required` list: callers declare which schema keys must be
 *    present for their command context (e.g. DB commands need DATABASE_URL).
 *  - Default-aware required check: a required key that has a schema-level
 *    default is never spuriously flagged absent, even when the overall parse
 *    fails due to an unrelated format error.
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
   * Any key listed here that resolves to undefined after parsing (or has no
   * schema default) is added to the error list.  Use this to enforce
   * command-specific requirements without modifying the base schema.
   *
   * Example (daemon startup):
   *   required: ["ARCHON_CORE_DATABASE_URL", "ARCHON_PROJECT_SLUG"]
   *
   * Keys that have a schema-level default (e.g. ARCHON_WORKSPACE_SLUG →
   * "default") are NEVER flagged absent, even when the overall parse fails
   * for an unrelated format error.
   */
  readonly required?: readonly (keyof ArchonConfig)[];
}

// ---------------------------------------------------------------------------
// Schema defaults cache
// ---------------------------------------------------------------------------

/**
 * Lazily-computed schema defaults: the result of parsing an empty env.
 * Used to determine whether a required key has a schema-level default so we
 * do not spuriously flag it absent when the overall parse fails for an
 * unrelated reason.
 */
let _schemaDefaults: Record<string, unknown> | null = null;
function getSchemaDefaults(): Record<string, unknown> {
  if (_schemaDefaults === null) {
    const r = archonConfigSchema.safeParse({});
    _schemaDefaults = r.success ? (r.data as Record<string, unknown>) : {};
  }
  return _schemaDefaults;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Validate all ARCHON_* environment variables in `env`.
 *
 * Returns either a parsed config (with defaults applied) or an aggregated
 * list of errors — one entry per failing variable — so the operator sees
 * everything wrong in a single startup message rather than discovering
 * problems one at a time.
 *
 * @param env - Environment object (typically process.env or a subset thereof).
 * @param options - Optional: declare additional required keys for this caller.
 */
export function validateArchonConfig(
  env: Record<string, string | undefined>,
  options?: ValidateOptions
): ValidateResult {
  // --- Format / shape validation via Zod -----------------------------------
  const parsed = archonConfigSchema.safeParse(env);
  const zodErrors: readonly string[] = parsed.success
    ? []
    : formatZodErrors(parsed.error);

  // --- Required-key presence check -----------------------------------------
  const requiredErrors: string[] = [];
  if (options?.required && options.required.length > 0) {
    // For presence check we use:
    //   - parsed.data when the parse succeeded (has defaults applied), OR
    //   - schema defaults merged with raw env when the parse failed
    //     (this prevents spuriously flagging schema-defaulted keys absent
    //     just because a *different* field had a format error).
    const defaults = getSchemaDefaults();
    const presenceData: Record<string, unknown> = parsed.success
      ? (parsed.data as Record<string, unknown>)
      : { ...defaults, ...(env as Record<string, unknown>) };

    for (const key of options.required) {
      const val = presenceData[key];
      if (val === undefined || val === null || val === "") {
        requiredErrors.push(`${key}: required but not set`);
      }
    }
  }

  const errors: readonly string[] = [...zodErrors, ...requiredErrors];

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
function formatZodErrors(zodError: ZodError): readonly string[] {
  // Group issues by their first path element (the env var name).
  const byKey = new Map<string, string[]>();

  for (const issue of zodError.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "unknown";
    const existing = byKey.get(key) ?? [];
    byKey.set(key, [...existing, issue.message]);
  }

  return Array.from(byKey.entries()).map(
    ([key, messages]) => `${key}: ${messages.join("; ")}`
  );
}

// ---------------------------------------------------------------------------
// CLI helper
// ---------------------------------------------------------------------------

/**
 * Assert the validation result is successful; if not, write all errors to
 * stderr and terminate with exit code 1.
 *
 * @remarks
 * **CLI entrypoints only.** This function calls `process.exit(1)`, which makes
 * it unsuitable for library code, MCP servers, daemon internals, or tests.
 * Non-CLI callers — including the daemon loop, MCP server startup, and any
 * test code — MUST use the pure {@link validateArchonConfig} and handle the
 * `{ ok: false }` result themselves.
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
