/**
 * Credential scrubbing for Postgres error messages.
 *
 * Before surfacing any pg error to the operator (console output, JSON report,
 * or re-thrown Error), route the text through `scrubPgCredentials` to strip
 * userinfo, host, and password tokens that pg may embed in error messages.
 *
 * Pure functions — no side effects, safe to call in tests without a real DB.
 */

// ---------------------------------------------------------------------------
// Core scrub helper
// ---------------------------------------------------------------------------

/**
 * Removes credential-sensitive fragments from a Postgres error string:
 *  - Full `postgres[ql]://` URLs (user, password, host, port are all redacted)
 *  - `for user "name"` / `for user 'name'` auth-failure fragments
 *  - `getaddrinfo ENOTFOUND <hostname>` host leaks
 *  - Key-value connection string tokens: `password=`, `user=`, `host=`
 *
 * Returns the scrubbed string. Input is not mutated.
 */
export function scrubPgCredentials(text: string): string {
  // 1. Redact full postgres:// URLs — keep scheme only.
  //    Matches user:pass@host:port/db and any trailing query/fragment.
  let result = text.replace(
    /postgres(?:ql)?:\/\/[^\s"'<>]*/gi,
    "postgres://[redacted]"
  );

  // 2. Redact "for user" fragments that appear in pg auth-failure messages,
  //    e.g.: password authentication failed for user "archon"
  result = result.replace(
    /\bfor user\s+["'][^"']*["']/gi,
    "for user [redacted]"
  );

  // 3. Redact ENOTFOUND <hostname> — host token leaks via DNS lookups.
  result = result.replace(
    /\bENOTFOUND\s+\S+/g,
    "ENOTFOUND [redacted]"
  );

  // 4. Redact libpq-style key=value tokens in connection strings.
  result = result.replace(/\bpassword=[^\s&;'"]+/gi, "password=[redacted]");
  result = result.replace(/\buser=[^\s&;'"]+/gi, "user=[redacted]");
  result = result.replace(/\bhost=[^\s&;'"]+/gi, "host=[redacted]");

  return result;
}

/**
 * Wraps an unknown thrown value as an Error whose message has been scrubbed of
 * credentials.  The original error chain is not preserved (intentional — the
 * original message may contain credentials).
 */
export function scrubPgError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = scrubPgCredentials(raw);
  return new Error(scrubbed);
}

// ---------------------------------------------------------------------------
// URL parse validation
// ---------------------------------------------------------------------------

export type DatabaseUrlParseResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly guidance: string };

/**
 * Validates that `url` is syntactically a valid postgres:// or postgresql://
 * URL.  Returns `{ valid: true }` on success, or `{ valid: false, guidance }`
 * with an actionable operator message on failure.
 */
export function validateDatabaseUrl(url: string): DatabaseUrlParseResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      valid: false,
      guidance:
        "ARCHON_CORE_DATABASE_URL is not a valid URL — if the password or username " +
        "contains special characters (@, /, ?, #, etc.), percent-encode them " +
        "(e.g. @ → %40, # → %23, / → %2F)"
    };
  }

  if (!/^postgres(?:ql)?:$/i.test(parsed.protocol)) {
    return {
      valid: false,
      guidance:
        `ARCHON_CORE_DATABASE_URL must use the postgres:// or postgresql:// scheme ` +
        `(detected scheme: ${parsed.protocol})`
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// SSL error detection + guidance
// ---------------------------------------------------------------------------

/**
 * Returns true when the error looks like a TLS/SSL negotiation failure from pg.
 */
export function isSslError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("ssl") ||
    lower.includes("pg_hba.conf") ||
    lower.includes("tls")
  );
}

/**
 * Builds a human-readable action string for an SSL connection failure.
 * `currentUrl` is used only for detecting whether the caller already set
 * `sslmode`; it is never echoed into the output.
 */
export function buildSslGuidance(currentUrl: string): string {
  let existingSslMode: string | null = null;
  try {
    existingSslMode = new URL(currentUrl).searchParams.get("sslmode");
  } catch {
    // unparseable URL — guidance is still useful without the existing mode
  }

  if (existingSslMode === "require") {
    return (
      "SSL connection error with sslmode=require already set — try changing to " +
      "?sslmode=disable in ARCHON_CORE_DATABASE_URL if the server does not " +
      "support SSL, or check the server-side SSL configuration"
    );
  }

  if (existingSslMode === "disable") {
    return (
      "SSL connection error with sslmode=disable set — the server may require SSL; " +
      "try changing to ?sslmode=require in ARCHON_CORE_DATABASE_URL"
    );
  }

  return (
    "SSL connection error — append ?sslmode=require to ARCHON_CORE_DATABASE_URL " +
    "if the server requires SSL, or ?sslmode=disable if the server does not support SSL"
  );
}

// ---------------------------------------------------------------------------
// pgvector guidance
// ---------------------------------------------------------------------------

export interface PgvectorGuidanceResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Pure branching logic for pgvector availability/enablement state.
 *
 * @param availableOnServer  true when `pg_available_extensions` contains 'vector'
 * @param enabledInDatabase  true when `pg_extension` contains 'vector'
 */
export function pgvectorGuidance(
  availableOnServer: boolean,
  enabledInDatabase: boolean
): PgvectorGuidanceResult {
  if (enabledInDatabase) {
    return { ok: true, message: "pgvector is enabled" };
  }

  if (availableOnServer) {
    return {
      ok: false,
      message:
        "pgvector is installed on the server but not enabled in this database — " +
        "connect as a superuser and run: CREATE EXTENSION vector"
    };
  }

  return {
    ok: false,
    message:
      "pgvector is not installed on this PostgreSQL server — " +
      "install the pgvector package (e.g. apt install postgresql-16-pgvector) " +
      "or use a pgvector-capable image (e.g. pgvector/pgvector:0.8.2-pg18)"
  };
}
