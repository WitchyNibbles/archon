import test from "node:test";
import assert from "node:assert/strict";

// Direct test of the extracted review-queue leaf module (daemon split). Imports from
// the module path (not the daemon.ts re-export) to lock the module boundary.
import {
  resolveDaemonReviewInputDir,
  resolveDaemonOperatorActionDir,
  normalizeOperatorContinuationActionCommand
} from "../src/daemon/review-queue.ts";

test("resolveDaemonReviewInputDir: default and explicit flag", () => {
  assert.equal(
    resolveDaemonReviewInputDir([], { cwd: "/repo", env: {} }),
    "/repo/.archon/review-actions"
  );
  assert.equal(
    resolveDaemonReviewInputDir(["--review-input-dir", "/custom/dir"], { cwd: "/repo", env: {} }),
    "/custom/dir"
  );
});

test("resolveDaemonOperatorActionDir: default and env override", () => {
  assert.equal(
    resolveDaemonOperatorActionDir([], { cwd: "/repo", env: {} }),
    "/repo/.archon/operator-actions"
  );
  assert.equal(
    resolveDaemonOperatorActionDir([], { cwd: "/repo", env: { ARCHON_OPERATOR_ACTION_DIR: "/abs/ops" } }),
    "/abs/ops"
  );
});

test("normalizeOperatorContinuationActionCommand: rejects non-JSON and non-objects", () => {
  assert.throws(() => normalizeOperatorContinuationActionCommand("not json"), /valid JSON/);
  assert.throws(() => normalizeOperatorContinuationActionCommand("[]"), /must be a JSON object/);
});
