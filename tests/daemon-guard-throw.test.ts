import test from "node:test";
import assert from "node:assert/strict";

import { classifyAdvanceFailure } from "../src/daemon.ts";

test("classifyAdvanceFailure: commit-guard throw → uncommitted_deliverables with commit guidance", () => {
  const err = new Error(
    'advance-active-task refusing to close task "t1": 2 uncommitted change(s) inside its write scope are not committed: src/a.ts, tests/b.ts. Commit the task\'s deliverables first, or pass --allow-uncommitted to override.'
  );
  const r = classifyAdvanceFailure(err);
  assert.equal(r.blockerKind, "uncommitted_deliverables");
  assert.match(r.reason, /refusing to close task "t1"/);
  assert.ok(r.nextActions.length > 0);
  assert.ok(r.nextActions.some((a) => /commit/i.test(a)));
  assert.ok(r.nextActions.some((a) => /--allow-uncommitted/.test(a)));
});

test("classifyAdvanceFailure: matches on the 'uncommitted change(s)' signature alone", () => {
  const r = classifyAdvanceFailure(new Error("3 uncommitted change(s) inside its write scope"));
  assert.equal(r.blockerKind, "uncommitted_deliverables");
});

test("classifyAdvanceFailure: a bare 'uncommitted change(s)' mention without the guard phrase is runtime_blocked", () => {
  // Guards against the loose-second-arm misclassification: only the guard's full
  // phrase ("... inside its write scope") should map to uncommitted_deliverables.
  const r = classifyAdvanceFailure(new Error("git reported 2 uncommitted change(s) in submodule"));
  assert.equal(r.blockerKind, "runtime_blocked");
});

test("classifyAdvanceFailure: generic advance error → runtime_blocked, reason preserved", () => {
  const r = classifyAdvanceFailure(new Error("runtime queue current_task_id mismatch"));
  assert.equal(r.blockerKind, "runtime_blocked");
  assert.match(r.reason, /runtime queue current_task_id mismatch/);
  assert.ok(r.nextActions.length > 0);
});

test("classifyAdvanceFailure: non-Error throw is stringified into the reason", () => {
  const r = classifyAdvanceFailure("boom");
  assert.equal(r.blockerKind, "runtime_blocked");
  assert.match(r.reason, /boom/);
});
