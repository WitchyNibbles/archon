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
