/**
 * End-to-end tests for doctorCommand JSON output shapes.
 *
 * Covers the three operator-facing output paths without requiring a real Postgres
 * connection for the two error cases:
 *
 *   1. URL-invalid  → JSON { ok: false, blockers, nextActions, reason } + exitCode 1
 *   2. Connection failure → same JSON shape + exitCode 1
 *   3. Success path (real DB needed — skipped in unit env, behaviour verified structurally)
 *
 * Also asserts the URL-validation-before-connect ordering (URL parse failure must
 * short-circuit without attempting withClient).
 *
 * Section 4 covers the P2 injection surface: checkPgvector / checkMigrations wiring
 * inside executeDoctorCommandFromArgs (no live DB required — stubs injected).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { doctorCommand, executeDoctorCommandFromArgs, handleDoctorCommandError, isRuntimeExecutionPreflightConnectionError } from "../src/runtime.ts";
import type { DoctorCheckObservation, ExecuteDoctorCommandOptions } from "../src/runtime.ts";
import { composeDatabaseUrlFromParts, loadDotEnv } from "../src/admin/db.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture console.log output and process.exitCode during `fn()`. */
async function captureDoctor(
  overrideEnv: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<{ output: string; exitCode: number | undefined }> {
  const origEnv = { ...process.env };
  const origExitCode = process.exitCode;
  let captured = "";
  let fnExitCode: number | undefined;

  const origLog = console.log;
  console.log = (msg: unknown) => {
    captured = String(msg);
  };

  // Apply env overrides
  for (const [key, val] of Object.entries(overrideEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  try {
    await fn();
  } finally {
    console.log = origLog;
    // Capture exitCode produced by fn() before restoring
    fnExitCode = process.exitCode as number | undefined;
    // Restore env
    for (const key of Object.keys(overrideEnv)) {
      if (key in origEnv) {
        process.env[key] = origEnv[key];
      } else {
        delete process.env[key];
      }
    }
    process.exitCode = origExitCode as number | undefined;
  }

  return { output: captured, exitCode: fnExitCode };
}

// ---------------------------------------------------------------------------
// Test 1: URL-invalid path
// ---------------------------------------------------------------------------

test("doctorCommand: invalid ARCHON_CORE_DATABASE_URL emits JSON with ok=false + exitCode 1", async () => {
  const { output, exitCode } = await captureDoctor(
    { ARCHON_CORE_DATABASE_URL: "mysql://user:pass@host/db" },
    () => doctorCommand([])
  );

  assert.ok(output.length > 0, "expected JSON output on stdout");
  const report = JSON.parse(output) as Record<string, unknown>;

  assert.equal(report.ok, false, "ok must be false for invalid URL");
  assert.ok(
    Array.isArray(report.blockers) && (report.blockers as unknown[]).length > 0,
    "blockers must be a non-empty array"
  );
  assert.ok(
    typeof report.reason === "string" && (report.reason as string).length > 0,
    "reason must be a non-empty string"
  );
  assert.equal(exitCode, 1, "process.exitCode must be 1 for URL-invalid path");
});

test("doctorCommand: URL-invalid path short-circuits before DB connection", async () => {
  // If withClient were called with an unparseable URL, pg would throw with a
  // different error. We can detect the short-circuit by inspecting the blocker text.
  const { output } = await captureDoctor(
    { ARCHON_CORE_DATABASE_URL: "postgres://host:999999/db" },
    () => doctorCommand([])
  );

  const report = JSON.parse(output) as Record<string, unknown>;
  assert.equal(report.ok, false);
  // The blocker must come from the URL validation, not a pg connection error
  const blockers = report.blockers as string[];
  const blockerText = blockers.join(" ");
  // URL validation guidance is about scheme/format, not "database unavailable"
  assert.doesNotMatch(blockerText, /database unavailable/i);
});

// ---------------------------------------------------------------------------
// Test 2: Connection-failure path
// ---------------------------------------------------------------------------

test("doctorCommand: connection failure emits JSON with ok=false, scrubbed blockers, exitCode 1", async () => {
  // Point at a guaranteed-refused port so pg fails immediately without a real server.
  // Port 1 is typically reserved/refused on loopback.
  const badUrl = "postgres://testuser:testpassword@127.0.0.1:1/archon";
  const { output, exitCode } = await captureDoctor(
    { ARCHON_CORE_DATABASE_URL: badUrl },
    () => doctorCommand([])
  );

  assert.ok(output.length > 0, "expected JSON output");
  const report = JSON.parse(output) as Record<string, unknown>;

  assert.equal(report.ok, false, "ok must be false for connection failure");
  assert.ok(Array.isArray(report.blockers), "blockers must be an array");
  assert.ok(Array.isArray(report.nextActions), "nextActions must be present");
  assert.equal(exitCode, 1, "process.exitCode must be 1 for connection failure");

  // Credential scrub: user and password must not appear in any output field.
  const allText = JSON.stringify(report);
  assert.doesNotMatch(allText, /testpassword/, "password must be scrubbed from JSON output");
  assert.doesNotMatch(allText, /testuser/, "username must be scrubbed from JSON output");
});

test("doctorCommand: connection-failure nextActions include both full-runtime and local-only paths", async () => {
  const { output } = await captureDoctor(
    { ARCHON_CORE_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/archon" },
    () => doctorCommand([])
  );

  const report = JSON.parse(output) as Record<string, unknown>;
  const actions = (report.nextActions as string[]).join("\n");
  assert.match(actions, /setup:local|ARCHON_CORE_DATABASE_URL/);
  assert.match(actions, /local-only/);
});

// ---------------------------------------------------------------------------
// Test 3: Narrow catch — domain errors re-throw, not swallowed as connection errors
// ---------------------------------------------------------------------------

// The narrow-catch logic in doctorCommand's two withClient blocks is extracted
// into handleDoctorCommandError so BOTH branches are testable without a live DB
// (doctorCommand itself uses the module-level withClient, which needs a real
// server to reach the domain-error path inside the callback).

test("handleDoctorCommandError: a genuine connection error is absorbed into JSON + exitCode 1 (no throw)", async () => {
  const origLog = console.log;
  const origExit = process.exitCode;
  let captured = "";
  console.log = (msg: unknown) => { captured = String(msg); };
  try {
    // Must NOT throw for a connection error.
    assert.doesNotThrow(() =>
      handleDoctorCommandError(
        new Error("connect ECONNREFUSED 10.42.0.9:5432"),
        "postgres://u:p@10.42.0.9:5432/db"
      )
    );
    const report = JSON.parse(captured) as Record<string, unknown>;
    assert.equal(report.ok, false, "connection error must produce ok=false JSON");
    assert.equal(process.exitCode, 1, "connection error must set exitCode 1");
    // Credential/host scrub still holds on this surface.
    assert.doesNotMatch(captured, /10\.42\.0\.9/, "host must be scrubbed");
  } finally {
    console.log = origLog;
    process.exitCode = origExit as number | undefined;
  }
});

test("handleDoctorCommandError: a non-connection domain error RE-THROWS (not mis-reported as DB unavailable)", () => {
  const domainError = new Error("project not bootstrapped");
  let logged = false;
  const origLog = console.log;
  console.log = () => { logged = true; };
  try {
    // The re-throw branch: the exact same error object must propagate.
    assert.throws(
      () => handleDoctorCommandError(domainError, "postgres://u:p@host:5432/db"),
      (err: unknown) => err === domainError,
      "a domain error must propagate unchanged, not be swallowed into JSON"
    );
    assert.equal(logged, false, "no JSON must be emitted for a domain error");
  } finally {
    console.log = origLog;
  }
});

// ---------------------------------------------------------------------------
// Section 4: P2 injection surface — checkPgvector / checkMigrations wiring
// ---------------------------------------------------------------------------
//
// executeDoctorCommandFromArgs is tested here with stub injections so the DB
// preflight wiring can be verified without a live Postgres connection.
//
// Strategy:
//   - findProjectContext returns a minimal context → the function does not throw
//     "not bootstrapped"
//   - getProjectRuntimeRegistration returns undefined → registration/repoPath/
//     dataRoot checks are all ok=false (expected — this is not the focus here)
//   - inspectReviewIdentity returns a stub → no filesystem access
//   - checkPgvector / checkMigrations are the injected stubs under test
// ---------------------------------------------------------------------------

/** Minimal stub options shared across injection tests. */
function makeStubOptions(
  overrides: Partial<ExecuteDoctorCommandOptions> = {}
): ExecuteDoctorCommandOptions {
  return {
    // Required by type but never called when no runId is resolved:
    getStatusSnapshot: () => Promise.reject(new Error("getStatusSnapshot should not be called in these tests")),
    // Returns a minimal context so the function does not throw "not bootstrapped":
    findProjectContext: () =>
      Promise.resolve({
        workspace: {
          id: "ws-001",
          slug: "test-workspace",
          name: "Test Workspace",
          createdAt: "2026-01-01T00:00:00Z"
        },
        project: {
          id: "proj-001",
          workspaceId: "ws-001",
          slug: "test-project",
          name: "Test Project",
          createdAt: "2026-01-01T00:00:00Z"
        }
      }),
    // No registration → registration/repoPath/dataRoot checks are ok=false.
    getProjectRuntimeRegistration: () => Promise.resolve(undefined),
    // Stub so it doesn't read the filesystem for review-identity bindings:
    inspectReviewIdentity: () =>
      Promise.resolve({
        authorityLabel: "derived_only" as const,
        adapterConfigured: false,
        adapterExists: false,
        availableBackends: [],
        bindingsPresent: false,
        bindingsPath: "/stub/bindings.json",
        bindingsUseShippedTemplate: false,
        liveTrustReady: false,
        notes: ["stub: no review identity configured"]
      }),
    cwd: process.cwd(),
    ...overrides
  };
}

/** Args that give resolveProjectSelector a workspace + project slug. */
const STUB_ARGS = ["--workspace-slug", "test-workspace", "--project-slug", "test-project"] as const;

// -- Test 4.1: checks.pgvector absent when no injection --

test("executeDoctorCommandFromArgs: checks.pgvector absent when checkPgvector not injected", async () => {
  const report = await executeDoctorCommandFromArgs([...STUB_ARGS], makeStubOptions());
  assert.ok(!("pgvector" in report.checks), "checks.pgvector must be absent when not injected");
});

// -- Test 4.2: checks.migrations absent when no injection --

test("executeDoctorCommandFromArgs: checks.migrations absent when checkMigrations not injected", async () => {
  const report = await executeDoctorCommandFromArgs([...STUB_ARGS], makeStubOptions());
  assert.ok(!("migrations" in report.checks), "checks.migrations must be absent when not injected");
});

// -- Test 4.3: ok=true pgvector check is included and does NOT add a blocker --

test("executeDoctorCommandFromArgs: ok=true pgvector check is present in report.checks, not a blocker", async () => {
  const pgvectorOk: DoctorCheckObservation = {
    authorityLabel: "runtime_authoritative",
    ok: true,
    summary: "pgvector extension is enabled"
  };

  const report = await executeDoctorCommandFromArgs(
    [...STUB_ARGS],
    makeStubOptions({ checkPgvector: async () => pgvectorOk })
  );

  assert.ok("pgvector" in report.checks, "checks.pgvector must be present when injected");
  assert.equal(report.checks.pgvector?.ok, true, "checks.pgvector.ok must be true");
  assert.equal(
    report.checks.pgvector?.summary,
    "pgvector extension is enabled",
    "summary must be passed through"
  );
  assert.ok(
    !report.blockers.includes("pgvector extension is enabled"),
    "ok=true pgvector must not appear in blockers"
  );
});

// -- Test 4.4: ok=false pgvector check adds a blocker --

test("executeDoctorCommandFromArgs: ok=false pgvector check is a blocker", async () => {
  const pgvectorFail: DoctorCheckObservation = {
    authorityLabel: "runtime_authoritative",
    ok: false,
    summary: "pgvector extension is not enabled — run: CREATE EXTENSION IF NOT EXISTS vector"
  };

  const report = await executeDoctorCommandFromArgs(
    [...STUB_ARGS],
    makeStubOptions({ checkPgvector: async () => pgvectorFail })
  );

  assert.ok("pgvector" in report.checks, "checks.pgvector must be present");
  assert.equal(report.checks.pgvector?.ok, false, "checks.pgvector.ok must be false");
  assert.ok(
    report.blockers.includes(pgvectorFail.summary),
    "ok=false pgvector summary must appear in report.blockers"
  );
  assert.equal(report.ok, false, "report.ok must be false when pgvector is a blocker");
});

// -- Test 4.5: ok=true migrations check is present and not a blocker --

test("executeDoctorCommandFromArgs: ok=true migrations check is present, not a blocker", async () => {
  const migrationsOk: DoctorCheckObservation = {
    authorityLabel: "runtime_authoritative",
    ok: true,
    summary: "all required migrations are applied"
  };

  const report = await executeDoctorCommandFromArgs(
    [...STUB_ARGS],
    makeStubOptions({ checkMigrations: async () => migrationsOk })
  );

  assert.ok("migrations" in report.checks, "checks.migrations must be present when injected");
  assert.equal(report.checks.migrations?.ok, true);
  assert.ok(!report.blockers.includes(migrationsOk.summary), "ok=true migrations must not be a blocker");
});

// -- Test 4.6: ok=false migrations check adds a blocker --

test("executeDoctorCommandFromArgs: ok=false migrations check is a blocker", async () => {
  const migrationsFail: DoctorCheckObservation = {
    authorityLabel: "runtime_authoritative",
    ok: false,
    summary: "migrations not current — missing tables: tasks — run: archon migrate"
  };

  const report = await executeDoctorCommandFromArgs(
    [...STUB_ARGS],
    makeStubOptions({ checkMigrations: async () => migrationsFail })
  );

  assert.ok("migrations" in report.checks, "checks.migrations must be present");
  assert.equal(report.checks.migrations?.ok, false);
  assert.ok(
    report.blockers.includes(migrationsFail.summary),
    "ok=false migrations summary must appear in report.blockers"
  );
  assert.equal(report.ok, false, "report.ok must be false when migrations is a blocker");
});

// -- Test 4.7: both checks injected and both ok=false → both are blockers --

test("executeDoctorCommandFromArgs: both ok=false checks produce two blockers", async () => {
  const pgvectorFail: DoctorCheckObservation = {
    authorityLabel: "runtime_authoritative",
    ok: false,
    summary: "pgvector not enabled"
  };
  const migrationsFail: DoctorCheckObservation = {
    authorityLabel: "runtime_authoritative",
    ok: false,
    summary: "migrations not current"
  };

  const report = await executeDoctorCommandFromArgs(
    [...STUB_ARGS],
    makeStubOptions({
      checkPgvector: async () => pgvectorFail,
      checkMigrations: async () => migrationsFail
    })
  );

  assert.ok(
    report.blockers.includes(pgvectorFail.summary),
    "pgvector blocker must be in report.blockers"
  );
  assert.ok(
    report.blockers.includes(migrationsFail.summary),
    "migrations blocker must be in report.blockers"
  );
  assert.equal(report.ok, false);
});

// ---------------------------------------------------------------------------
// Section 5: auth error classification (H2) + ARCHON_POSTGRES_* normalization (H1)
// ---------------------------------------------------------------------------

test("isRuntimeExecutionPreflightConnectionError: classifies pg auth failures as connection errors", () => {
  // pg auth errors must be absorbed into structured JSON, not re-thrown.
  // scrubPgError redacts usernames so patterns match on stable surrounding text.
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("password authentication failed for user [redacted]")),
    true,
    "auth failure message must be classified as a connection error"
  );
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("role [redacted] does not exist")),
    true,
    "missing-role message must be classified as a connection error"
  );
  // Unrelated domain errors must NOT be absorbed
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("project not bootstrapped")),
    false,
    "domain errors must not be misclassified as connection errors"
  );
});

test("loadDotEnv normalization: composeDatabaseUrlFromParts produces a URL when ARCHON_CORE_DATABASE_URL is absent", () => {
  // loadDotEnv calls composeDatabaseUrlFromParts(process.env) at the end and
  // injects the result as ARCHON_CORE_DATABASE_URL when the explicit URL is absent.
  // We test the building block in isolation (calling loadDotEnv() directly would
  // pick up the project .env file and race with ARCHON_POSTGRES_* test values).
  const testEnv: NodeJS.ProcessEnv = {
    ARCHON_POSTGRES_USER: "appuser",
    ARCHON_POSTGRES_PASSWORD: "s3cr3t",
    ARCHON_POSTGRES_DB: "appdb"
    // ARCHON_CORE_DATABASE_URL intentionally absent
  };

  const composed = composeDatabaseUrlFromParts(testEnv);
  assert.ok(composed !== undefined,
    "composeDatabaseUrlFromParts must return a URL when all three POSTGRES parts are set");
  // This is exactly what loadDotEnv injects: composed must be a valid postgres:// URL
  assert.match(composed!, /^postgres:\/\//,
    "composed URL must use postgres:// scheme");
  assert.ok(composed!.includes("appuser") || composed!.includes(encodeURIComponent("appuser")),
    "composed URL must contain the user");
  assert.ok(composed!.includes("appdb") || composed!.includes(encodeURIComponent("appdb")),
    "composed URL must contain the db name");
  // Confirm the normalization condition: this is the URL that loadDotEnv would
  // inject into process.env.ARCHON_CORE_DATABASE_URL when it is absent.
  assert.ok(
    !testEnv.ARCHON_CORE_DATABASE_URL,
    "the test env must not have ARCHON_CORE_DATABASE_URL set (pre-normalization state)"
  );
});
