import test from "node:test";
import assert from "node:assert/strict";

import {
  parseGitPorcelain,
  selectUncommittedDeliverables,
  evaluateCommitGuard
} from "../src/workflow.ts";

// ─── parseGitPorcelain ───────────────────────────────────────────────────────

test("parseGitPorcelain: parses modified, staged, and untracked entries", () => {
  const out = [
    " M src/workflow.ts", // unstaged modified
    "M  src/a.ts", // staged modified
    "A  src/b.ts", // staged add
    "?? tests/new.ts", // untracked
    "MM src/c.ts" // staged + unstaged
  ].join("\n");
  assert.deepEqual(parseGitPorcelain(out).sort(), [
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/workflow.ts",
    "tests/new.ts"
  ]);
});

test("parseGitPorcelain: rename yields the new path", () => {
  assert.deepEqual(parseGitPorcelain("R  src/old.ts -> src/new.ts"), ["src/new.ts"]);
});

test("parseGitPorcelain: ignores blank lines and trailing whitespace", () => {
  assert.deepEqual(parseGitPorcelain("\n M a.ts\n\n"), ["a.ts"]);
});

test("parseGitPorcelain: empty input yields empty array", () => {
  assert.deepEqual(parseGitPorcelain(""), []);
  assert.deepEqual(parseGitPorcelain("   \n  "), []);
});

test("parseGitPorcelain: dedupes repeated paths", () => {
  assert.deepEqual(parseGitPorcelain(" M a.ts\nM  a.ts"), ["a.ts"]);
});

// ─── selectUncommittedDeliverables ───────────────────────────────────────────

test("selectUncommittedDeliverables: returns in-scope code paths", () => {
  const result = selectUncommittedDeliverables(
    ["src/workflow.ts", "tests/foo.test.ts", "README.md"],
    ["src/workflow.ts", "tests"]
  );
  assert.deepEqual(result.sort(), ["src/workflow.ts", "tests/foo.test.ts"]);
});

test("selectUncommittedDeliverables: excludes paths outside the write scope", () => {
  const result = selectUncommittedDeliverables(
    ["src/other.ts", "docs/x.md"],
    ["src/workflow.ts", "tests"]
  );
  assert.deepEqual(result, []);
});

test("selectUncommittedDeliverables: excludes .archon live workflow state even when in scope", () => {
  // advance-active-task itself mutates .archon/work — that churn must never block.
  const result = selectUncommittedDeliverables(
    [".archon/work/task-queue.json", ".archon/ACTIVE", "src/workflow.ts"],
    ["src/workflow.ts", ".archon/work"]
  );
  assert.deepEqual(result, ["src/workflow.ts"]);
});

test("selectUncommittedDeliverables: matches a directory scope entry by prefix", () => {
  const result = selectUncommittedDeliverables(
    ["tests/a/b/deep.test.ts"],
    ["tests"]
  );
  assert.deepEqual(result, ["tests/a/b/deep.test.ts"]);
});

test("selectUncommittedDeliverables: does NOT treat a sibling prefix as in scope", () => {
  // "tests-extra/x" must not match scope entry "tests".
  const result = selectUncommittedDeliverables(["tests-extra/x.ts"], ["tests"]);
  assert.deepEqual(result, []);
});

test("selectUncommittedDeliverables: normalizes ./ and backslashes before matching", () => {
  const result = selectUncommittedDeliverables(
    ["./src/workflow.ts", "tests\\win.test.ts"],
    ["src/workflow.ts", "tests"]
  );
  assert.deepEqual(result.sort(), ["src/workflow.ts", "tests/win.test.ts"]);
});

test("selectUncommittedDeliverables: empty scope matches nothing", () => {
  assert.deepEqual(selectUncommittedDeliverables(["src/a.ts"], []), []);
});

test("selectUncommittedDeliverables: returns sorted unique results", () => {
  const result = selectUncommittedDeliverables(
    ["src/b.ts", "src/a.ts", "src/a.ts"],
    ["src"]
  );
  assert.deepEqual(result, ["src/a.ts", "src/b.ts"]);
});

// ─── evaluateCommitGuard ─────────────────────────────────────────────────────

test("evaluateCommitGuard: applied + in-scope uncommitted + no override → blocks", () => {
  const r = evaluateCommitGuard({
    mode: "applied",
    uncommittedInScope: ["src/workflow.ts"],
    allowOverride: false,
    taskId: "t1"
  });
  assert.equal(r.block, true);
  assert.match(r.reason ?? "", /refusing to close task "t1"/);
  assert.match(r.reason ?? "", /src\/workflow\.ts/);
  assert.match(r.reason ?? "", /--allow-uncommitted/);
});

test("evaluateCommitGuard: applied + override → does not block", () => {
  const r = evaluateCommitGuard({
    mode: "applied",
    uncommittedInScope: ["src/workflow.ts"],
    allowOverride: true,
    taskId: "t1"
  });
  assert.equal(r.block, false);
  assert.equal(r.reason, undefined);
});

test("evaluateCommitGuard: applied + clean tree → does not block", () => {
  const r = evaluateCommitGuard({
    mode: "applied",
    uncommittedInScope: [],
    allowOverride: false,
    taskId: "t1"
  });
  assert.equal(r.block, false);
});

test("evaluateCommitGuard: dry_run never blocks even with uncommitted deliverables", () => {
  const r = evaluateCommitGuard({
    mode: "dry_run",
    uncommittedInScope: ["src/workflow.ts", "tests/x.test.ts"],
    allowOverride: false,
    taskId: "t1"
  });
  assert.equal(r.block, false);
});

test("evaluateCommitGuard: truncates the listed paths and reports the overflow count", () => {
  const many = Array.from({ length: 13 }, (_, i) => `src/file${i}.ts`);
  const r = evaluateCommitGuard({
    mode: "applied",
    uncommittedInScope: many,
    allowOverride: false,
    taskId: "t1"
  });
  assert.equal(r.block, true);
  assert.match(r.reason ?? "", /and 3 more/);
  assert.match(r.reason ?? "", /13 uncommitted change\(s\)/);
});
