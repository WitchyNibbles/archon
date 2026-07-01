import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeExecutionConnectionFailure } from "../src/runtime.ts";

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
