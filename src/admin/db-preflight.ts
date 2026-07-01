/**
 * DB-level preflight checks for archon doctor.
 *
 * All functions are injectable (accept a DbQueryFn) so they can be unit-tested
 * without a live database connection. The caller is responsible for providing
 * a queryFn that delegates to a real pg client (or a test stub).
 *
 * Reuses pgvectorGuidance from db-error-scrub — do NOT duplicate that logic here.
 */
import { pgvectorGuidance } from "./db-error-scrub.ts";

// ---------------------------------------------------------------------------
// Injectable query interface
// ---------------------------------------------------------------------------

/**
 * Minimal query interface injected by callers.
 * Accepts an SQL string plus optional positional params.
 * Returns `rows` as read-only records (values are unknown, narrowed by callers).
 */
export type DbQueryFn = (
  sql: string,
  params?: readonly unknown[]
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;

// ---------------------------------------------------------------------------
// Required schema constants
// ---------------------------------------------------------------------------

/**
 * Core tables that must exist for the archon runtime to function.
 * Mirrors the check in verifySetup; kept here as a shared constant so both
 * the doctor preflight and verifySetup stay in sync.
 */
export const REQUIRED_TABLES: readonly string[] = [
  "workspaces",
  "projects",
  "runs",
  "tasks",
  "task_dependencies",
  "artifacts",
  "handoffs",
  "approvals",
  "reviews",
  "locks",
  "memory_entries",
  "embedding_jobs",
  "runtime_project_registrations",
  "runtime_migration_journals"
];

/**
 * Table-column pairs that must exist (added by later migrations).
 * Format: "table_name.column_name".
 */
export const REQUIRED_COLUMNS: readonly string[] = [
  "artifacts.metadata",
  "memory_entries.metadata",
  "handoffs.owner_role",
  "handoffs.completion_standard",
  "handoffs.execution_evidence",
  "handoffs.quality_gate_evidence",
  "reviews.actor",
  "reviews.actor_role",
  "reviews.source",
  "approvals.actor",
  "approvals.actor_role",
  "approvals.source"
];

// ---------------------------------------------------------------------------
// pgvector check
// ---------------------------------------------------------------------------

export interface PgvectorCheckResult {
  readonly ok: boolean;
  readonly availableOnServer: boolean;
  readonly enabledInDatabase: boolean;
  /** Operator-facing message (no secrets). */
  readonly message: string;
}

/**
 * Checks whether the pgvector extension is enabled in the connected database.
 *
 * Distinguishes three states:
 *   1. Enabled   → ok: true
 *   2. Available on server but not enabled → ok: false, guidance to CREATE EXTENSION
 *   3. Not available on server at all      → ok: false, guidance to install package/image
 */
export async function checkPgvector(
  query: DbQueryFn
): Promise<PgvectorCheckResult> {
  const [availableResult, enabledResult] = await Promise.all([
    query(
      `SELECT name FROM pg_available_extensions WHERE name = 'vector'`
    ),
    query(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
    )
  ]);

  const availableOnServer = availableResult.rows.length > 0;
  const enabledInDatabase = enabledResult.rows.length > 0;
  const guidance = pgvectorGuidance(availableOnServer, enabledInDatabase);

  return {
    ok: guidance.ok,
    availableOnServer,
    enabledInDatabase,
    message: guidance.message
  };
}

// ---------------------------------------------------------------------------
// Migrations check
// ---------------------------------------------------------------------------

export interface MigrationsCheckResult {
  readonly ok: boolean;
  readonly missingTables: readonly string[];
  readonly missingColumns: readonly string[];
  /** Operator-facing message (no secrets). */
  readonly message: string;
}

/**
 * Checks whether all required migrations have been applied to the database.
 *
 * Performs two queries against information_schema:
 *   1. Checks that all REQUIRED_TABLES exist in public schema.
 *   2. Checks that all REQUIRED_COLUMNS exist in the relevant tables.
 *
 * Returns ok: true only when both sets are fully satisfied.
 * On failure, lists the specific missing items so the operator can diagnose.
 */
export async function checkMigrationsCurrent(
  query: DbQueryFn
): Promise<MigrationsCheckResult> {
  // -- Table check --
  const tableRows = await query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1)`,
    [REQUIRED_TABLES as string[]]
  );

  const foundTables = new Set(
    tableRows.rows.map((row) => String(row["table_name"] ?? ""))
  );
  const missingTables = REQUIRED_TABLES.filter((t) => !foundTables.has(t));

  // -- Column check --
  // Build (table_name, column_name) pairs from REQUIRED_COLUMNS constants.
  const columnPairs = REQUIRED_COLUMNS.map((entry) => {
    const dot = entry.indexOf(".");
    return {
      table: entry.slice(0, dot),
      column: entry.slice(dot + 1),
      key: entry
    };
  });

  // Only query for tables that actually exist (avoids spurious column failures
  // when tables are also missing).
  const existingTableNames = columnPairs
    .map((p) => p.table)
    .filter((t) => foundTables.has(t));

  const columnRows =
    existingTableNames.length > 0
      ? await query(
          `SELECT table_name, column_name
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = ANY($1)`,
          [existingTableNames]
        )
      : { rows: [] };

  const foundColumnKeys = new Set(
    columnRows.rows.map(
      (row) => `${String(row["table_name"] ?? "")}.${String(row["column_name"] ?? "")}`
    )
  );

  // Only report a column as missing when its TABLE exists.  If the table itself
  // is missing we already report that under missingTables — reporting the
  // column again is redundant and inflates the failure count.
  const missingColumns = columnPairs
    .filter((p) => foundTables.has(p.table) && !foundColumnKeys.has(p.key))
    .map((p) => p.key);

  const ok = missingTables.length === 0 && missingColumns.length === 0;

  let message: string;
  if (ok) {
    message = "all required migrations are applied";
  } else {
    const parts: string[] = [];
    if (missingTables.length > 0) {
      parts.push(`missing tables: ${missingTables.join(", ")}`);
    }
    if (missingColumns.length > 0) {
      parts.push(`missing columns: ${missingColumns.join(", ")}`);
    }
    message = `migrations not current — ${parts.join("; ")} — run: archon migrate`;
  }

  return { ok, missingTables, missingColumns, message };
}

// ---------------------------------------------------------------------------
// Pgvector repair
// ---------------------------------------------------------------------------

export interface PgvectorRepairResult {
  readonly applied: boolean;
  /** Operator-facing error or guidance if repair was not applied. */
  readonly guidance?: string | undefined;
}

/**
 * Attempts to enable the pgvector extension in the current database.
 *
 * Runs: `CREATE EXTENSION IF NOT EXISTS vector`
 *
 * This may fail if:
 *   - The extension is not installed on the server (install the package first).
 *   - The connected user lacks CREATE privilege on the database.
 *
 * Returns `applied: true` if the command succeeded.
 * Returns `applied: false` with operator-facing guidance on error.
 *
 * Does NOT throw — callers can safely ignore or log the result.
 */
export async function repairPgvectorExtension(
  query: DbQueryFn
): Promise<PgvectorRepairResult> {
  try {
    await query("CREATE EXTENSION IF NOT EXISTS vector");
    return { applied: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    if (
      lower.includes("permission denied") ||
      lower.includes("must be superuser") ||
      lower.includes("must be owner")
    ) {
      return {
        applied: false,
        guidance:
          "pgvector repair requires superuser or CREATE privilege — " +
          "connect as a superuser and run: CREATE EXTENSION IF NOT EXISTS vector; " +
          "or enable pgvector via your managed Postgres provider's extension settings"
      };
    }

    if (lower.includes("could not open extension control file")) {
      return {
        applied: false,
        guidance:
          "pgvector is not installed on this PostgreSQL server — " +
          "install the pgvector package (e.g. apt install postgresql-16-pgvector) " +
          "or use a pgvector-capable image (e.g. pgvector/pgvector:0.8.2-pg18)"
      };
    }

    return {
      applied: false,
      guidance: `pgvector repair failed: ${msg}`
    };
  }
}
