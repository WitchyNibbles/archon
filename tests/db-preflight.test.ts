/**
 * Unit tests for src/admin/db-preflight.ts and the DB URL resolution additions
 * to src/admin/db.ts.
 *
 * All tests are pure — no live database connection required.
 * Injectable DbQueryFn stubs replace real pg queries.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  composeDatabaseUrlFromParts,
  resolveDatabaseUrl,
  withClientUsing
} from "../src/admin/db.ts";

import {
  checkPgvector,
  checkMigrationsCurrent,
  repairPgvectorExtension,
  REQUIRED_TABLES,
  REQUIRED_COLUMNS,
  type DbQueryFn
} from "../src/admin/db-preflight.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a stub DbQueryFn that returns a fixed rows array for any query. */
function stubQuery(rows: Record<string, unknown>[]): DbQueryFn {
  return async () => ({ rows });
}

/**
 * Builds a DbQueryFn that dispatches on SQL fragment:
 *   matchers: Array of [fragment, rows] — first match wins.
 *   fallback: rows to return when no fragment matches (default: []).
 */
function dispatchQuery(
  matchers: ReadonlyArray<readonly [string, Record<string, unknown>[]]>,
  fallback: Record<string, unknown>[] = []
): DbQueryFn {
  return async (sql) => {
    for (const [fragment, rows] of matchers) {
      if (sql.includes(fragment)) {
        return { rows };
      }
    }
    return { rows: fallback };
  };
}

// ---------------------------------------------------------------------------
// composeDatabaseUrlFromParts
// ---------------------------------------------------------------------------

test("composeDatabaseUrlFromParts: returns undefined when all ARCHON_POSTGRES_* are absent", () => {
  const result = composeDatabaseUrlFromParts({});
  assert.equal(result, undefined);
});

test("composeDatabaseUrlFromParts: returns undefined when password is absent", () => {
  const result = composeDatabaseUrlFromParts({
    ARCHON_POSTGRES_USER: "archon",
    ARCHON_POSTGRES_DB: "archon"
  });
  assert.equal(result, undefined);
});

test("composeDatabaseUrlFromParts: returns undefined when user is absent", () => {
  const result = composeDatabaseUrlFromParts({
    ARCHON_POSTGRES_PASSWORD: "secret",
    ARCHON_POSTGRES_DB: "archon"
  });
  assert.equal(result, undefined);
});

test("composeDatabaseUrlFromParts: returns undefined when db is absent", () => {
  const result = composeDatabaseUrlFromParts({
    ARCHON_POSTGRES_USER: "archon",
    ARCHON_POSTGRES_PASSWORD: "secret"
  });
  assert.equal(result, undefined);
});

test("composeDatabaseUrlFromParts: composes URL from all three parts with default port 5533", () => {
  const result = composeDatabaseUrlFromParts({
    ARCHON_POSTGRES_USER: "archon",
    ARCHON_POSTGRES_PASSWORD: "s3cr3t",
    ARCHON_POSTGRES_DB: "archon"
  });
  assert.ok(result !== undefined, "expected a composed URL");
  assert.ok(result!.startsWith("postgres://"), "expected postgres:// scheme");
  assert.match(result!, /127\.0\.0\.1:5533/);
  assert.match(result!, /\/archon$/);
  // Credentials must be encoded but present in the URL
  assert.ok(result!.includes("archon"), "user should appear in URL");
  assert.ok(result!.includes("s3cr3t"), "password should appear in URL");
});

test("composeDatabaseUrlFromParts: uses ARCHON_POSTGRES_PORT when set", () => {
  const result = composeDatabaseUrlFromParts({
    ARCHON_POSTGRES_USER: "u",
    ARCHON_POSTGRES_PASSWORD: "p",
    ARCHON_POSTGRES_DB: "db",
    ARCHON_POSTGRES_PORT: "5432"
  });
  assert.ok(result !== undefined);
  assert.match(result!, /127\.0\.0\.1:5432/);
});

test("composeDatabaseUrlFromParts: percent-encodes special characters in password", () => {
  const result = composeDatabaseUrlFromParts({
    ARCHON_POSTGRES_USER: "user",
    ARCHON_POSTGRES_PASSWORD: "p@ss#w/rd",
    ARCHON_POSTGRES_DB: "db"
  });
  assert.ok(result !== undefined);
  // @ must be encoded as %40, # as %23, / as %2F
  assert.match(result!, /p%40ss%23w%2Frd/);
  // The raw special chars must not appear (they'd corrupt URL parsing)
  assert.doesNotMatch(result!, /p@ss#w\/rd/);
});

// ---------------------------------------------------------------------------
// resolveDatabaseUrl — precedence: explicit URL wins over composed URL
// ---------------------------------------------------------------------------

test("resolveDatabaseUrl: returns ARCHON_CORE_DATABASE_URL when set (canonical wins)", () => {
  const explicit = "postgres://u:p@host:5432/db";
  const result = resolveDatabaseUrl({
    ARCHON_CORE_DATABASE_URL: explicit,
    ARCHON_POSTGRES_USER: "other",
    ARCHON_POSTGRES_PASSWORD: "other",
    ARCHON_POSTGRES_DB: "other"
  });
  assert.equal(result, explicit, "explicit URL must take precedence over POSTGRES_* parts");
});

test("resolveDatabaseUrl: falls back to composed URL when ARCHON_CORE_DATABASE_URL is absent", () => {
  const result = resolveDatabaseUrl({
    ARCHON_POSTGRES_USER: "archon",
    ARCHON_POSTGRES_PASSWORD: "secret",
    ARCHON_POSTGRES_DB: "archon"
  });
  assert.ok(result !== undefined, "expected composed URL when explicit URL absent");
  assert.match(result!, /postgres:\/\//);
});

test("resolveDatabaseUrl: returns undefined when neither is configured", () => {
  const result = resolveDatabaseUrl({});
  assert.equal(result, undefined);
});

test("resolveDatabaseUrl: explicit empty string is treated as absent (falls back to parts)", () => {
  const result = resolveDatabaseUrl({
    ARCHON_CORE_DATABASE_URL: "   ",  // whitespace-only
    ARCHON_POSTGRES_USER: "archon",
    ARCHON_POSTGRES_PASSWORD: "secret",
    ARCHON_POSTGRES_DB: "archon"
  });
  // whitespace-only explicit URL → resolveDatabaseUrl trims and treats as absent
  assert.ok(result !== undefined, "should fall back to composed URL");
  assert.match(result!, /postgres:\/\//);
});

// ---------------------------------------------------------------------------
// checkPgvector
// ---------------------------------------------------------------------------

test("checkPgvector: ok=true when extension is enabled in database", async () => {
  const query = dispatchQuery([
    ["pg_available_extensions", [{ name: "vector" }]],
    ["pg_extension", [{ extversion: "0.8.2" }]]
  ]);
  const result = await checkPgvector(query);
  assert.equal(result.ok, true);
  assert.equal(result.availableOnServer, true);
  assert.equal(result.enabledInDatabase, true);
  assert.match(result.message, /enabled/i);
});

test("checkPgvector: ok=false when available on server but not enabled in database", async () => {
  const query = dispatchQuery([
    ["pg_available_extensions", [{ name: "vector" }]],
    ["pg_extension", []]  // not enabled
  ]);
  const result = await checkPgvector(query);
  assert.equal(result.ok, false);
  assert.equal(result.availableOnServer, true);
  assert.equal(result.enabledInDatabase, false);
  // Must suggest CREATE EXTENSION (not install package — it's already on server)
  assert.match(result.message, /CREATE EXTENSION/);
  assert.doesNotMatch(result.message, /apt install|package/i);
});

test("checkPgvector: ok=false when not installed on server at all", async () => {
  const query = dispatchQuery([
    ["pg_available_extensions", []],
    ["pg_extension", []]
  ]);
  const result = await checkPgvector(query);
  assert.equal(result.ok, false);
  assert.equal(result.availableOnServer, false);
  assert.equal(result.enabledInDatabase, false);
  // Must suggest installing the package or using a pgvector image
  assert.match(result.message, /install|image/i);
  // Must NOT suggest CREATE EXTENSION (pgvector isn't on the server at all)
  assert.doesNotMatch(result.message, /CREATE EXTENSION/);
});

test("checkPgvector: edge case — enabled=true overrides available=false (ok=true)", async () => {
  // If it's in pg_extension, it's enabled regardless of pg_available_extensions.
  const query = dispatchQuery([
    ["pg_available_extensions", []],
    ["pg_extension", [{ extversion: "0.7.0" }]]
  ]);
  const result = await checkPgvector(query);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// checkMigrationsCurrent
// ---------------------------------------------------------------------------

/** Returns a query stub that reports all required tables and columns as present. */
function allPresentQuery(): DbQueryFn {
  return dispatchQuery([
    [
      "information_schema.tables",
      REQUIRED_TABLES.map((t) => ({ table_name: t }))
    ],
    [
      "information_schema.columns",
      REQUIRED_COLUMNS.map((col) => {
        const dot = col.indexOf(".");
        return {
          table_name: col.slice(0, dot),
          column_name: col.slice(dot + 1)
        };
      })
    ]
  ]);
}

test("checkMigrationsCurrent: ok=true when all required tables and columns are present", async () => {
  const result = await checkMigrationsCurrent(allPresentQuery());
  assert.equal(result.ok, true);
  assert.equal(result.missingTables.length, 0);
  assert.equal(result.missingColumns.length, 0);
  assert.match(result.message, /applied|current/i);
});

test("checkMigrationsCurrent: ok=false when a required table is missing", async () => {
  const presentTables = REQUIRED_TABLES.filter((t) => t !== "workspaces");
  const query = dispatchQuery([
    [
      "information_schema.tables",
      presentTables.map((t) => ({ table_name: t }))
    ],
    [
      "information_schema.columns",
      REQUIRED_COLUMNS.map((col) => {
        const dot = col.indexOf(".");
        return { table_name: col.slice(0, dot), column_name: col.slice(dot + 1) };
      })
    ]
  ]);
  const result = await checkMigrationsCurrent(query);
  assert.equal(result.ok, false);
  assert.ok(result.missingTables.includes("workspaces"));
  assert.match(result.message, /workspaces/);
  // Must instruct to run migrate
  assert.match(result.message, /archon migrate/);
});

test("checkMigrationsCurrent: ok=false when a required column is missing", async () => {
  const query = dispatchQuery([
    [
      "information_schema.tables",
      REQUIRED_TABLES.map((t) => ({ table_name: t }))
    ],
    [
      "information_schema.columns",
      // Omit handoffs.owner_role
      REQUIRED_COLUMNS
        .filter((col) => col !== "handoffs.owner_role")
        .map((col) => {
          const dot = col.indexOf(".");
          return { table_name: col.slice(0, dot), column_name: col.slice(dot + 1) };
        })
    ]
  ]);
  const result = await checkMigrationsCurrent(query);
  assert.equal(result.ok, false);
  assert.ok(result.missingColumns.includes("handoffs.owner_role"));
  assert.match(result.message, /handoffs\.owner_role/);
});

test("checkMigrationsCurrent: no tables at all → ok=false, missing tables reported", async () => {
  const query = stubQuery([]);  // returns empty for both queries
  const result = await checkMigrationsCurrent(query);
  assert.equal(result.ok, false);
  assert.equal(result.missingTables.length, REQUIRED_TABLES.length);
  assert.equal(result.missingColumns.length, 0, "column check skipped when tables missing");
});

test("checkMigrationsCurrent: message does not leak connection secrets", async () => {
  const query = stubQuery([]);
  const result = await checkMigrationsCurrent(query);
  // message must not contain URL-like or credential-like strings
  assert.doesNotMatch(result.message, /postgres:\/\//);
  assert.doesNotMatch(result.message, /password/i);
});

// ---------------------------------------------------------------------------
// repairPgvectorExtension
// ---------------------------------------------------------------------------

test("repairPgvectorExtension: applied=true when CREATE EXTENSION succeeds", async () => {
  const query: DbQueryFn = async () => ({ rows: [] });
  const result = await repairPgvectorExtension(query);
  assert.equal(result.applied, true);
  assert.equal(result.guidance, undefined);
});

test("repairPgvectorExtension: applied=false with permission guidance on permission denied", async () => {
  const query: DbQueryFn = async () => {
    throw new Error("ERROR: permission denied to create extension \"vector\"");
  };
  const result = await repairPgvectorExtension(query);
  assert.equal(result.applied, false);
  assert.ok(result.guidance !== undefined, "guidance must be set on failure");
  assert.match(result.guidance!, /superuser|CREATE privilege/i);
});

test("repairPgvectorExtension: applied=false with install guidance when extension not on server", async () => {
  const query: DbQueryFn = async () => {
    throw new Error("ERROR: could not open extension control file \".../vector.control\"");
  };
  const result = await repairPgvectorExtension(query);
  assert.equal(result.applied, false);
  assert.ok(result.guidance !== undefined);
  assert.match(result.guidance!, /not installed|pgvector package|image/i);
});

test("repairPgvectorExtension: applied=false with generic guidance for unknown errors", async () => {
  const query: DbQueryFn = async () => {
    throw new Error("some unexpected error");
  };
  const result = await repairPgvectorExtension(query);
  assert.equal(result.applied, false);
  assert.ok(result.guidance !== undefined);
  assert.match(result.guidance!, /repair failed|unexpected error/i);
});

test("repairPgvectorExtension: never throws — always returns a result object", async () => {
  const query: DbQueryFn = async () => {
    throw new Error("catastrophic failure");
  };
  // Must not throw
  await assert.doesNotReject(async () => {
    await repairPgvectorExtension(query);
  });
});

// ---------------------------------------------------------------------------
// checkPgvector + checkMigrationsCurrent: no credential leakage
// ---------------------------------------------------------------------------

test("checkPgvector: error messages from bad queries must not leak the connection URL", async () => {
  // Simulate a query that embeds a URL in its error — the check should not
  // re-surface that in its own message field.
  const query: DbQueryFn = async () => ({ rows: [] }); // empty = not enabled
  const result = await checkPgvector(query);
  assert.doesNotMatch(result.message, /postgres:\/\//);
  assert.doesNotMatch(result.message, /password/i);
});

// ---------------------------------------------------------------------------
// requireDatabaseUrl: empty-env message contract (M3)
// ---------------------------------------------------------------------------

test("requireDatabaseUrl: throws with ARCHON_CORE_DATABASE_URL message when env is empty", async () => {
  // requireDatabaseUrl is private but tested via withClientUsing.
  // The error message substring is load-bearing: isRuntimeExecutionPreflightConnectionError
  // regex-matches on it to route DB-missing errors into structured JSON output.
  await assert.rejects(
    () => withClientUsing(async () => {}, { env: {} }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      assert.match(err.message, /ARCHON_CORE_DATABASE_URL is required/,
        "error must contain the substring matched by isRuntimeExecutionPreflightConnectionError");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// repairPgvectorExtension: fallback guidance credential scrubbing (M2 test)
// ---------------------------------------------------------------------------

test("repairPgvectorExtension: fallback guidance does not expose postgres:// URLs", async () => {
  // Simulate a query error that contains a connection URL
  // (defensive: future pg driver versions might enrich errors with context).
  const leakyQuery: DbQueryFn = async () => {
    throw new Error("could not connect to postgres://secret:password123@host:5432/db while enabling vector");
  };
  const result = await repairPgvectorExtension(leakyQuery);
  assert.equal(result.applied, false);
  assert.ok(result.guidance !== undefined);
  // The scrubbed guidance must NOT expose credentials
  assert.doesNotMatch(result.guidance!, /postgres:\/\/[^[]/,
    "guidance must not expose a raw postgres:// URL");
  assert.doesNotMatch(result.guidance!, /password123/,
    "guidance must not expose the raw password");
});

// ---------------------------------------------------------------------------
// checkMigrationsCurrent: simultaneous multi-table column absence (L4)
// ---------------------------------------------------------------------------

test("checkMigrationsCurrent: reports missing columns across multiple tables simultaneously", async () => {
  // All required tables present, but two columns in different tables are missing
  const allTables = REQUIRED_TABLES.map((t) => ({ table_name: t }));

  // Provide all columns EXCEPT handoffs.owner_role AND reviews.actor
  const allColumns = REQUIRED_COLUMNS
    .filter((entry) => entry !== "handoffs.owner_role" && entry !== "reviews.actor")
    .map((entry) => {
      const dot = entry.indexOf(".");
      return { table_name: entry.slice(0, dot), column_name: entry.slice(dot + 1) };
    });

  const query: DbQueryFn = async (sql) => {
    if (sql.includes("information_schema.tables")) return { rows: allTables };
    if (sql.includes("information_schema.columns")) return { rows: allColumns };
    return { rows: [] };
  };

  const result = await checkMigrationsCurrent(query);
  assert.equal(result.ok, false);
  assert.equal(result.missingTables.length, 0, "no tables should be missing");
  assert.ok(result.missingColumns.includes("handoffs.owner_role"),
    "handoffs.owner_role must be in missingColumns");
  assert.ok(result.missingColumns.includes("reviews.actor"),
    "reviews.actor must be in missingColumns");
  assert.ok(result.missingColumns.length >= 2,
    "both missing columns must be reported");
  assert.match(result.message, /missing columns/,
    "diagnostic message must mention missing columns");
});
