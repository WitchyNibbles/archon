import test from "node:test";
import assert from "node:assert/strict";

import {
  parseGitPorcelain,
  selectUncommittedDeliverables,
  evaluateCommitGuard,
  computeAdvanceCommitGuard,
  formatAdvanceActiveTaskCommandResult
} from "../src/workflow.ts";
import type { RunStatusSnapshot } from "../src/domain/types.ts";

type AdvanceResult = Parameters<typeof formatAdvanceActiveTaskCommandResult>[0];

function fakeSnapshot(
  tasks: ReadonlyArray<{ taskId: string; allowedWriteScope: string[] }>
): RunStatusSnapshot {
  return {
    tasks: tasks.map((t) => ({ packet: { taskId: t.taskId, allowedWriteScope: t.allowedWriteScope } }))
  } as unknown as RunStatusSnapshot;
}

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

test("parseGitPorcelain: rename with ' -> ' in the original name resolves to the final new path", () => {
  // lastIndexOf must pick the true separator, not an arrow inside the old name.
  assert.deepEqual(parseGitPorcelain("R  src/a -> b.ts -> src/new.ts"), ["src/new.ts"]);
});

test("parseGitPorcelain: decodes octal-escaped quoted non-ASCII path", () => {
  // git quotes paths with non-ASCII bytes; "café" → c a f \303\251 (é = UTF-8 C3 A9).
  assert.deepEqual(parseGitPorcelain('?? "src/caf\\303\\251.ts"'), ["src/café.ts"]);
});

test("parseGitPorcelain: decodes standard C-escapes in quoted path", () => {
  assert.deepEqual(parseGitPorcelain('A  "a\\tb.ts"'), ["a\tb.ts"]);
});

test("parseGitPorcelain: ' -> ' in a non-rename filename is not treated as a rename", () => {
  // status " M" is not R/C, so the literal arrow stays part of the path.
  assert.deepEqual(parseGitPorcelain(" M weird -> name.ts"), ["weird -> name.ts"]);
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

// ─── computeAdvanceCommitGuard (wiring seam) ─────────────────────────────────

test("computeAdvanceCommitGuard: applied + in-scope uncommitted → blocks, reports the path", async () => {
  const { uncommittedInScope, guard } = await computeAdvanceCommitGuard({
    runId: "r1",
    activeTaskId: "t1",
    mode: "applied",
    allowOverride: false,
    cwd: "/repo",
    getStatusSnapshot: async () => fakeSnapshot([{ taskId: "t1", allowedWriteScope: ["src/workflow.ts"] }]),
    getUncommittedPaths: () => ["src/workflow.ts", ".archon/work/task-queue.json"]
  });
  assert.deepEqual(uncommittedInScope, ["src/workflow.ts"]); // .archon excluded
  assert.equal(guard.block, true);
});

test("computeAdvanceCommitGuard: dry_run reports but does not block", async () => {
  const { uncommittedInScope, guard } = await computeAdvanceCommitGuard({
    runId: "r1",
    activeTaskId: "t1",
    mode: "dry_run",
    allowOverride: false,
    cwd: "/repo",
    getStatusSnapshot: async () => fakeSnapshot([{ taskId: "t1", allowedWriteScope: ["src/workflow.ts"] }]),
    getUncommittedPaths: () => ["src/workflow.ts"]
  });
  assert.deepEqual(uncommittedInScope, ["src/workflow.ts"]);
  assert.equal(guard.block, false);
});

test("computeAdvanceCommitGuard: override does not block", async () => {
  const { guard } = await computeAdvanceCommitGuard({
    runId: "r1",
    activeTaskId: "t1",
    mode: "applied",
    allowOverride: true,
    cwd: "/repo",
    getStatusSnapshot: async () => fakeSnapshot([{ taskId: "t1", allowedWriteScope: ["src"] }]),
    getUncommittedPaths: () => ["src/a.ts"]
  });
  assert.equal(guard.block, false);
});

test("computeAdvanceCommitGuard: resolves scope from the MATCHING task id, not another", async () => {
  // Two tasks; the uncommitted path is in t2's scope but not the active t1's scope.
  const { uncommittedInScope, guard } = await computeAdvanceCommitGuard({
    runId: "r1",
    activeTaskId: "t1",
    mode: "applied",
    allowOverride: false,
    cwd: "/repo",
    getStatusSnapshot: async () =>
      fakeSnapshot([
        { taskId: "t1", allowedWriteScope: ["docs"] },
        { taskId: "t2", allowedWriteScope: ["src"] }
      ]),
    getUncommittedPaths: () => ["src/a.ts"]
  });
  assert.deepEqual(uncommittedInScope, []);
  assert.equal(guard.block, false);
});

test("computeAdvanceCommitGuard: active task absent from snapshot fails open (no block)", async () => {
  const { uncommittedInScope, guard } = await computeAdvanceCommitGuard({
    runId: "r1",
    activeTaskId: "missing",
    mode: "applied",
    allowOverride: false,
    cwd: "/repo",
    getStatusSnapshot: async () => fakeSnapshot([{ taskId: "t1", allowedWriteScope: ["src"] }]),
    getUncommittedPaths: () => ["src/a.ts"]
  });
  assert.deepEqual(uncommittedInScope, []);
  assert.equal(guard.block, false);
});

test("computeAdvanceCommitGuard: clean tree does not block", async () => {
  const { guard } = await computeAdvanceCommitGuard({
    runId: "r1",
    activeTaskId: "t1",
    mode: "applied",
    allowOverride: false,
    cwd: "/repo",
    getStatusSnapshot: async () => fakeSnapshot([{ taskId: "t1", allowedWriteScope: ["src"] }]),
    getUncommittedPaths: () => []
  });
  assert.equal(guard.block, false);
});

// ─── formatAdvanceActiveTaskCommandResult ────────────────────────────────────

test("formatAdvanceActiveTaskCommandResult: surfaces the uncommitted-in-scope list", () => {
  const text = formatAdvanceActiveTaskCommandResult({
    mode: "dry_run",
    taskId: "t1",
    nextTaskId: null,
    proof: { runId: "r1" },
    queue: { current_task_id: "t1" },
    uncommittedInScope: ["src/a.ts", "tests/b.ts"]
  } as unknown as AdvanceResult);
  assert.match(text, /uncommitted-in-scope: src\/a\.ts, tests\/b\.ts/);
});

test("formatAdvanceActiveTaskCommandResult: shows 'none' when clean", () => {
  const text = formatAdvanceActiveTaskCommandResult({
    mode: "applied",
    taskId: "t1",
    nextTaskId: null,
    proof: { runId: "r1" },
    queue: { current_task_id: null },
    uncommittedInScope: []
  } as unknown as AdvanceResult);
  assert.match(text, /uncommitted-in-scope: none/);
});
