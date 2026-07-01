import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeExecutionConnectionFailure,
  isRuntimeExecutionPreflightConnectionError
} from "../src/runtime.ts";
import { scrubPgError } from "../src/admin/db-error-scrub.ts";

// A fresh consuming-repo install with ARCHON_CORE_DATABASE_URL set but no reachable
// Postgres must surface BOTH recovery paths: start/point-at a database (full runtime)
// and the supported local-only escape hatch (unset the URL). Previously the guidance
// only mentioned restoring Postgres, leaving local-only mode undiscoverable.

test("buildRuntimeExecutionConnectionFailure: connection error surfaces full-runtime and local-only paths", () => {
  const failure = buildRuntimeExecutionConnectionFailure(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

  assert.match(failure.blockers[0]!, /database unavailable/);
  assert.match(failure.reason, /runtime execution preflight failed/);
  assert.equal(failure.activeRunId, null);

  const actions = failure.nextActions.join("\n");
  // Full-runtime path
  assert.match(actions, /setup:local|ARCHON_CORE_DATABASE_URL/);
  // Local-only escape hatch
  assert.match(actions, /local-only/);
  assert.match(actions, /unset `ARCHON_CORE_DATABASE_URL`/);
});

test("buildRuntimeExecutionConnectionFailure: missing URL is reported distinctly and still offers local-only", () => {
  const failure = buildRuntimeExecutionConnectionFailure(new Error("ARCHON_CORE_DATABASE_URL is required"));

  assert.match(failure.blockers[0]!, /ARCHON_CORE_DATABASE_URL is missing/);
  const actions = failure.nextActions.join("\n");
  assert.match(actions, /local-only/);
});

// Condition 12 — credential scrub: blockers/reason must not contain usernames or
// passwords even when the raw pg error includes them.

test("buildRuntimeExecutionConnectionFailure: scrubs pg auth-failure user name before embedding", () => {
  // Realistic pg error format: user name appears in the 'for user "..."' fragment
  const rawPgError = new Error(
    'FATAL: password authentication failed for user "secretdbuser"'
  );
  const failure = buildRuntimeExecutionConnectionFailure(rawPgError);

  const combined = [failure.blockers.join(" "), failure.reason].join(" ");
  // The specific user name from the pg error must not appear
  assert.doesNotMatch(combined, /secretdbuser/);
});

test("buildRuntimeExecutionConnectionFailure: scrubs ENOTFOUND host name before embedding", () => {
  // pg DNS-failure errors include the hostname in the message
  const rawPgError = new Error("getaddrinfo ENOTFOUND secret-host.database.internal");
  const failure = buildRuntimeExecutionConnectionFailure(rawPgError);

  const combined = [failure.blockers.join(" "), failure.reason].join(" ");
  assert.doesNotMatch(combined, /secret-host/);
  assert.doesNotMatch(combined, /database\.internal/);
});

test("buildRuntimeExecutionConnectionFailure: scrubs full URL when pg embeds it in error text", () => {
  const rawPgError = new Error(
    "connection to server postgres://bob:hunter2@secret.host/mydb failed"
  );
  const failure = buildRuntimeExecutionConnectionFailure(rawPgError);

  const combined = [failure.blockers.join(" "), failure.reason].join(" ");
  assert.doesNotMatch(combined, /bob/);
  assert.doesNotMatch(combined, /hunter2/);
  assert.doesNotMatch(combined, /secret\.host/);
  assert.doesNotMatch(combined, /mydb/);
});

// Condition 12 — SSL guidance: SSL errors must surface actionable sslmode advice.

test("buildRuntimeExecutionConnectionFailure: SSL error includes sslmode guidance in nextActions", () => {
  const sslError = new Error("FATAL: SSL connection required");
  const failure = buildRuntimeExecutionConnectionFailure(sslError, "postgres://user:pass@host/db");

  const actions = failure.nextActions.join("\n");
  assert.match(actions, /sslmode/);
  // Must not leak the URL or credentials
  assert.doesNotMatch(actions, /pass/);
});

// Condition 12 — credential scrub: ECONNREFUSED/ETIMEDOUT ip:port must be scrubbed.

test("buildRuntimeExecutionConnectionFailure: ECONNREFUSED ip:port is scrubbed from blockers/reason", () => {
  const failure = buildRuntimeExecutionConnectionFailure(
    new Error("connect ECONNREFUSED 10.42.0.1:5432")
  );
  const combined = [failure.blockers.join(" "), failure.reason].join(" ");
  assert.doesNotMatch(combined, /10\.42\.0\.1/);
  assert.doesNotMatch(combined, /\b5432\b/);
  assert.match(combined, /ECONNREFUSED \[redacted\]/);
});

// isRuntimeExecutionPreflightConnectionError — detection coverage

test("isRuntimeExecutionPreflightConnectionError: recognises ECONNREFUSED", () => {
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:5533")),
    true
  );
});

test("isRuntimeExecutionPreflightConnectionError: recognises ECONNRESET", () => {
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("read ECONNRESET")),
    true
  );
});

test("isRuntimeExecutionPreflightConnectionError: recognises Connection terminated unexpectedly", () => {
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(
      new Error("Connection terminated unexpectedly")
    ),
    true
  );
});

test("isRuntimeExecutionPreflightConnectionError: recognises EHOSTUNREACH", () => {
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("connect EHOSTUNREACH 10.0.0.1:5432")),
    true
  );
});

test("isRuntimeExecutionPreflightConnectionError: recognises ENETUNREACH", () => {
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("connect ENETUNREACH 10.0.0.1:5432")),
    true
  );
});

test("isRuntimeExecutionPreflightConnectionError: returns false for domain errors", () => {
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("Project default/archon is not bootstrapped")),
    false
  );
  assert.equal(
    isRuntimeExecutionPreflightConnectionError(new Error("doctor could not resolve project context")),
    false
  );
});

// withClientUsing scrub wiring — db.ts throw sites route through scrubPgError

test("scrubPgError: wiring — db.ts throw-site output does not contain credentials", () => {
  // Simulate what withClientUsing does: scrubPgError wraps the raw pg error
  // and strips credentials before the error crosses the module boundary.
  const rawPgError = new Error(
    'connect ECONNREFUSED 10.42.0.17:5432 — password=hunter2 for user "dbadmin"'
  );
  const scrubbed = scrubPgError(rawPgError);
  assert.doesNotMatch(scrubbed.message, /10\.42\.0\.17/);
  assert.doesNotMatch(scrubbed.message, /hunter2/);
  assert.doesNotMatch(scrubbed.message, /dbadmin/);
  assert.match(scrubbed.message, /ECONNREFUSED \[redacted\]/);
});
