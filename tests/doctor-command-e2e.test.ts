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
 */

import test from "node:test";
import assert from "node:assert/strict";
import { doctorCommand, handleDoctorCommandError } from "../src/runtime.ts";

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
