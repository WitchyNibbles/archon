/**
 * Tests for src/admin/sweep-orphans.ts
 *
 * TDD approach: enforcing double — every unexpected query throws.
 * Mirrors the forge-prune-orphans.test.ts harness structure.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-sweep-orphans.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findSweepCandidates,
  computeSweptRunIds,
  sweepOrphansCommand,
  SCAN_ROW_CAP
} from "../src/admin/sweep-orphans.ts";
import type {
  SweepTaskRow,
  SweepRunRow,
  ReviewCount,
  ApprovalCount,
  SweepOrphansDeps,
  SqlQueryResult
} from "../src/admin/sweep-orphans.ts";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-06-27T12:00:00.000Z";
const NOW = new Date(NOW_ISO);
// 14d default cutoff
const CUTOFF_14D = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000);
// Run created 20 days ago — BEFORE cutoff → eligible
const OLD_CREATED_AT = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
// Run created 7 days ago — AFTER cutoff → too recent
const RECENT_CREATED_AT = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTask(
  overrides: Partial<SweepTaskRow> & { id: string; run_id: string; task_key: string }
): SweepTaskRow {
  return { status: "in_progress", ...overrides };
}

function makeRun(overrides: Partial<SweepRunRow> & { id: string }): SweepRunRow {
  return {
    title: "Test run",
    status: "in_progress",
    created_at: OLD_CREATED_AT,
    ...overrides
  };
}

function makeReviewCount(run_id: string, task_key: string, review_count: number): ReviewCount {
  return { run_id, task_key, review_count };
}

function makeApprovalCount(run_id: string, task_key: string, approval_count: number): ApprovalCount {
  return { run_id, task_key, approval_count };
}

function noLocks(): ReadonlySet<string> { return new Set(); }
function withLock(run_id: string, task_key: string): ReadonlySet<string> {
  return new Set([`${run_id}:${task_key}`]);
}

// ---------------------------------------------------------------------------
// findSweepCandidates — pure predicate tests
// ---------------------------------------------------------------------------

describe("findSweepCandidates — pure predicate", () => {
  it("selects an old twinless in_progress orphan (no reviews, no approvals, no lock)", () => {
    const task = makeTask({ id: "t1", run_id: "run-old", task_key: "daemonExtractFoo" });
    const run = makeRun({ id: "run-old" });

    const { candidates } = findSweepCandidates(
      [task], [run], [], [], noLocks(), null, CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.id, "t1");
    assert.ok(candidates[0]!.run_age_days >= 20, "run_age_days should reflect age");
  });

  it("selects a 'ready' status row (both in_progress and ready are eligible)", () => {
    const task = makeTask({ id: "t1", run_id: "run-old", task_key: "myTask", status: "ready" });
    const run = makeRun({ id: "run-old" });

    const { candidates } = findSweepCandidates(
      [task], [run], [], [], noLocks(), null, CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.status, "ready");
  });

  it("EXCLUDES the active run (run_id === activeRunId)", () => {
    const task = makeTask({ id: "t1", run_id: "run-active", task_key: "myTask" });
    const run = makeRun({ id: "run-active" });

    const { candidates } = findSweepCandidates(
      [task], [run], [], [], noLocks(), "run-active", CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 0, "active run must be excluded");
  });

  it("EXCLUDES recent runs (run.created_at >= cutoff)", () => {
    const task = makeTask({ id: "t1", run_id: "run-recent", task_key: "myTask" });
    const run = makeRun({ id: "run-recent", created_at: RECENT_CREATED_AT });

    const { candidates } = findSweepCandidates(
      [task], [run], [], [], noLocks(), null, CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 0, "recent run must be excluded");
  });

  it("EXCLUDES tasks with ≥1 review (any state)", () => {
    const task = makeTask({ id: "t1", run_id: "run-old", task_key: "myTask" });
    const run = makeRun({ id: "run-old" });
    const reviews = [makeReviewCount("run-old", "myTask", 1)];

    const { candidates } = findSweepCandidates(
      [task], [run], reviews, [], noLocks(), null, CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 0, "task with any review must be excluded");
  });

  it("EXCLUDES tasks with ≥1 approval (any decision)", () => {
    const task = makeTask({ id: "t1", run_id: "run-old", task_key: "myTask" });
    const run = makeRun({ id: "run-old" });
    const approvals = [makeApprovalCount("run-old", "myTask", 1)];

    const { candidates } = findSweepCandidates(
      [task], [run], [], approvals, noLocks(), null, CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 0, "task with any approval must be excluded");
  });

  it("EXCLUDES tasks with an active lock", () => {
    const task = makeTask({ id: "t1", run_id: "run-old", task_key: "myTask" });
    const run = makeRun({ id: "run-old" });
    const locks = withLock("run-old", "myTask");

    const { candidates } = findSweepCandidates(
      [task], [run], [], [], locks, null, CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 0, "locked task must be excluded");
  });

  it("EXCLUDES non-candidate statuses (approved, done, blocked, review_blocked)", () => {
    const run = makeRun({ id: "run-old" });
    for (const status of ["approved", "done", "blocked", "review_blocked"]) {
      const task = makeTask({ id: "t1", run_id: "run-old", task_key: "myTask", status });
      const { candidates } = findSweepCandidates(
        [task], [run], [], [], noLocks(), null, CUTOFF_14D, NOW, null
      );
      assert.equal(candidates.length, 0, `status="${status}" must not be a candidate`);
    }
  });

  it("allow-list intersects with safety predicate: excluded run_id is not a candidate", () => {
    const task1 = makeTask({ id: "t1", run_id: "run-A", task_key: "taskA" });
    const task2 = makeTask({ id: "t2", run_id: "run-B", task_key: "taskB" });
    const runA = makeRun({ id: "run-A" });
    const runB = makeRun({ id: "run-B" });
    const allowList = new Set(["run-A"]); // only run-A is in the allow-list

    const { candidates } = findSweepCandidates(
      [task1, task2], [runA, runB], [], [], noLocks(), null, CUTOFF_14D, NOW, allowList
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.id, "t1", "only run-A task passes the allow-list filter");
  });

  it("allow-list intersects with safety predicate: active run in allow-list is still excluded", () => {
    const task = makeTask({ id: "t1", run_id: "run-active", task_key: "myTask" });
    const run = makeRun({ id: "run-active" });
    const allowList = new Set(["run-active"]); // in allow-list but also the active run

    const { candidates } = findSweepCandidates(
      [task], [run], [], [], noLocks(), "run-active", CUTOFF_14D, NOW, allowList
    );

    assert.equal(candidates.length, 0, "active run must be excluded even if in allow-list");
  });

  it("selects multiple old twinless orphans across different runs", () => {
    const task1 = makeTask({ id: "t1", run_id: "run-1", task_key: "daemonExtractA" });
    const task2 = makeTask({ id: "t2", run_id: "run-2", task_key: "daemonExtractB" });
    const task3 = makeTask({ id: "t3", run_id: "run-3", task_key: "daemonExtractC" });
    const runs = [
      makeRun({ id: "run-1" }),
      makeRun({ id: "run-2" }),
      makeRun({ id: "run-3" })
    ];

    const { candidates } = findSweepCandidates(
      [task1, task2, task3], runs, [], [], noLocks(), null, CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 3);
    const ids = candidates.map((c) => c.id).sort();
    assert.deepEqual(ids, ["t1", "t2", "t3"]);
  });

  it("skips task when run row is missing (defensive)", () => {
    const task = makeTask({ id: "t1", run_id: "run-ghost", task_key: "myTask" });
    // No run row for run-ghost → task skipped defensively

    const { candidates } = findSweepCandidates(
      [task], [], [], [], noLocks(), null, CUTOFF_14D, NOW, null
    );

    assert.equal(candidates.length, 0, "task without run row must be skipped");
  });
});

// ---------------------------------------------------------------------------
// computeSweptRunIds — pure unit tests
// ---------------------------------------------------------------------------

describe("computeSweptRunIds — pure", () => {
  it("marks a run swept when ALL its tasks are candidates", () => {
    const candidate: SweepTaskRow = { id: "t1", run_id: "run-A", task_key: "foo", status: "in_progress" };
    const candidateRows = [{ id: "t1", run_id: "run-A", task_key: "foo", status: "in_progress", run_created_at: OLD_CREATED_AT, run_age_days: 20 }];
    const allRunTasks = [candidate];

    const swept = computeSweptRunIds(candidateRows, allRunTasks);
    assert.ok(swept.includes("run-A"), "run-A should be swept");
  });

  it("does NOT mark a run swept when it has a surviving non-done task", () => {
    const candidateRows = [{ id: "t1", run_id: "run-A", task_key: "foo", status: "in_progress", run_created_at: OLD_CREATED_AT, run_age_days: 20 }];
    const allRunTasks: SweepTaskRow[] = [
      { id: "t1", run_id: "run-A", task_key: "foo", status: "in_progress" },
      { id: "t2", run_id: "run-A", task_key: "bar", status: "in_progress" } // survivor
    ];

    const swept = computeSweptRunIds(candidateRows, allRunTasks);
    assert.ok(!swept.includes("run-A"), "run-A must not be swept while t2 survives");
  });

  it("counts already-done tasks as non-blocking for sweep computation", () => {
    const candidateRows = [{ id: "t1", run_id: "run-A", task_key: "foo", status: "in_progress", run_created_at: OLD_CREATED_AT, run_age_days: 20 }];
    const allRunTasks: SweepTaskRow[] = [
      { id: "t1", run_id: "run-A", task_key: "foo", status: "in_progress" },
      { id: "t2", run_id: "run-A", task_key: "bar", status: "done" } // already done
    ];

    const swept = computeSweptRunIds(candidateRows, allRunTasks);
    assert.ok(swept.includes("run-A"), "run-A should be swept — t2 is already done");
  });

  it("returns empty when candidates is empty", () => {
    const swept = computeSweptRunIds([], []);
    assert.deepEqual([...swept], []);
  });
});

// ---------------------------------------------------------------------------
// Command test harness
// ---------------------------------------------------------------------------

interface CommandScenario {
  tasks: SweepTaskRow[];
  runs: SweepRunRow[];
  reviews: ReviewCount[];
  approvals: ApprovalCount[];
  activeLockPairs: Array<{ run_id: string; task_key: string }>;
  activeRunId: string | null;
  projectId: string | null;
  // All tasks for the candidate run_ids (for swept-run computation)
  allRunTasks?: SweepTaskRow[];
}

/**
 * Build fake deps with an enforcing query dispatcher.
 * Any unexpected query pattern throws — no permissive fallthrough.
 */
function buildFakeDeps(scenario: CommandScenario): {
  deps: SweepOrphansDeps;
  spies: {
    writtenLines: string[];
    writtenFiles: Array<{ path: string; content: string }>;
    transactionCalls: number;
    updateTasksQueries: Array<{ text: string; values: readonly unknown[] | undefined }>;
    updateRunsQueries: Array<{ text: string; values: readonly unknown[] | undefined }>;
  };
} {
  const writtenLines: string[] = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];
  const updateTasksQueries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  const updateRunsQueries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];

  const spies = {
    writtenLines,
    writtenFiles,
    transactionCalls: 0,
    updateTasksQueries,
    updateRunsQueries
  };

  const deps: SweepOrphansDeps = {
    dataRoot: "/fake/data-root",
    repoRoot: "/fake/repo-root",
    now: () => NOW_ISO,
    writeLine: (line) => { writtenLines.push(line); },
    writeFile: async (p, c) => { writtenFiles.push({ path: p, content: c }); },
    withTransaction: async (work) => {
      spies.transactionCalls += 1;
      return work();
    },
    query: async (text, values): Promise<SqlQueryResult> => {
      const lower = text.toLowerCase().replace(/\s+/g, " ").trim();

      // project_runtime_state
      if (lower.includes("from project_runtime_state")) {
        return {
          rows: scenario.projectId !== null || scenario.activeRunId !== null
            ? [{ project_id: scenario.projectId ?? "proj-1", active_run_id: scenario.activeRunId }]
            : [],
          rowCount: scenario.projectId !== null ? 1 : 0
        };
      }

      // Status-filtered candidate tasks (has "in_progress" in SQL)
      if (lower.includes("from tasks") && lower.includes("in_progress")) {
        const rows = scenario.tasks.map((t) => ({ ...t }));
        return { rows, rowCount: rows.length };
      }

      // Runs select
      if (lower.includes("from runs") && lower.includes("select id")) {
        const ids = (values?.[0] as string[] | undefined) ?? [];
        const rows = scenario.runs
          .filter((r) => ids.includes(r.id))
          .map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }

      // Review counts
      if (lower.includes("from reviews") && lower.includes("review_count")) {
        const runIds = (values?.[0] as string[] | undefined) ?? [];
        const rows = scenario.reviews
          .filter((r) => runIds.includes(r.run_id))
          .map((r) => ({
            run_id: r.run_id,
            task_key: r.task_key,
            review_count: String(r.review_count)
          }));
        return { rows, rowCount: rows.length };
      }

      // Approval counts
      if (lower.includes("from approvals") && lower.includes("approval_count")) {
        const runIds = (values?.[0] as string[] | undefined) ?? [];
        const rows = scenario.approvals
          .filter((a) => runIds.includes(a.run_id))
          .map((a) => ({
            run_id: a.run_id,
            task_key: a.task_key,
            approval_count: String(a.approval_count)
          }));
        return { rows, rowCount: rows.length };
      }

      // Active locks
      if (lower.includes("from locks") && lower.includes("active")) {
        const runIds = (values?.[0] as string[] | undefined) ?? [];
        const rows = scenario.activeLockPairs
          .filter((l) => runIds.includes(l.run_id))
          .map((l) => ({ run_id: l.run_id, task_key: l.task_key }));
        return { rows, rowCount: rows.length };
      }

      // All tasks for run_ids (for swept-run computation — no status filter)
      if (
        lower.includes("from tasks") &&
        lower.includes("run_id = any") &&
        !lower.includes("in_progress")
      ) {
        const runIds = (values?.[0] as string[] | undefined) ?? [];
        const allTasks = scenario.allRunTasks ?? scenario.tasks;
        const rows = allTasks
          .filter((t) => runIds.includes(t.run_id))
          .map((t) => ({ ...t }));
        return { rows, rowCount: rows.length };
      }

      // UPDATE tasks
      if (lower.includes("update tasks") && lower.includes("done")) {
        updateTasksQueries.push({ text, values });
        return { rows: [], rowCount: (values?.[0] as unknown[])?.length ?? 0 };
      }

      // UPDATE runs
      if (lower.includes("update runs") && lower.includes("done")) {
        updateRunsQueries.push({ text, values });
        return { rows: [], rowCount: (values?.[0] as unknown[])?.length ?? 0 };
      }

      throw new Error(
        `[enforcing fake] Unexpected query in test: ${text.slice(0, 120)}`
      );
    }
  };

  return { deps, spies };
}

/** Scenario with exactly one sweep candidate. */
function buildOneCandidateScenario(): CommandScenario {
  const tasks: SweepTaskRow[] = [
    { id: "t-orphan", run_id: "run-orphan", task_key: "daemonExtractFoo", status: "in_progress" }
  ];
  return {
    tasks,
    runs: [{ id: "run-orphan", title: "Orphan run", status: "in_progress", created_at: OLD_CREATED_AT }],
    reviews: [],
    approvals: [],
    activeLockPairs: [],
    activeRunId: "run-active",
    projectId: "proj-1",
    allRunTasks: tasks
  };
}

// ---------------------------------------------------------------------------
// sweepOrphansCommand — dry-run
// ---------------------------------------------------------------------------

describe("sweepOrphansCommand — dry-run", () => {
  it("prints candidates and does NOT call withTransaction or write any files", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand([], deps);

    assert.equal(spies.transactionCalls, 0, "dry-run must not start a transaction");
    assert.equal(spies.writtenFiles.length, 0, "dry-run must not write any files");
    assert.equal(spies.updateTasksQueries.length, 0, "dry-run must not update tasks");
    assert.equal(spies.updateRunsQueries.length, 0, "dry-run must not update runs");

    const output = spies.writtenLines.join("\n");
    assert.ok(output.includes("DRY-RUN"), "output must say DRY-RUN");
    assert.ok(output.includes("daemonExtractFoo"), "output must list the candidate task_key");
    assert.ok(output.includes("dry-run — pass --confirm"), "output must instruct how to confirm");
  });

  it("prints (none) when no status-filtered tasks are found", async () => {
    const scenario: CommandScenario = {
      tasks: [],
      runs: [],
      reviews: [],
      approvals: [],
      activeLockPairs: [],
      activeRunId: null,
      projectId: "proj-1"
    };
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand([], deps);

    const output = spies.writtenLines.join("\n");
    assert.ok(output.includes("(none)"), "should print (none) for empty candidate list");
    assert.equal(spies.transactionCalls, 0);
  });

  it("prints (none) when tasks exist but all are filtered by predicate (e.g., all recent)", async () => {
    const scenario: CommandScenario = {
      tasks: [{ id: "t1", run_id: "run-recent", task_key: "myTask", status: "in_progress" }],
      runs: [{ id: "run-recent", title: "Recent run", status: "in_progress", created_at: RECENT_CREATED_AT }],
      reviews: [],
      approvals: [],
      activeLockPairs: [],
      activeRunId: "run-active",
      projectId: "proj-1",
      allRunTasks: [{ id: "t1", run_id: "run-recent", task_key: "myTask", status: "in_progress" }]
    };
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand([], deps);

    const output = spies.writtenLines.join("\n");
    assert.ok(output.includes("(none)"), "all predicate-filtered tasks must show (none)");
    assert.equal(spies.transactionCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// sweepOrphansCommand — confirm mode
// ---------------------------------------------------------------------------

describe("sweepOrphansCommand — confirm mode", () => {
  it("writes backup BEFORE issuing UPDATE queries (backup-first contract)", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);

    const callOrder: string[] = [];
    const originalWriteFile = deps.writeFile;
    deps.writeFile = async (p, c) => { callOrder.push("writeFile"); return originalWriteFile(p, c); };
    const originalWithTransaction = deps.withTransaction;
    deps.withTransaction = async (work) => {
      callOrder.push("transaction");
      return originalWithTransaction(work);
    };

    await sweepOrphansCommand(["--confirm"], deps);

    assert.ok(
      callOrder.indexOf("writeFile") < callOrder.indexOf("transaction"),
      "backup (writeFile) must happen before the transaction"
    );
  });

  it("writes exactly one backup file with correct structure", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand(["--confirm"], deps);

    assert.equal(spies.writtenFiles.length, 1, "exactly one backup file");
    const backup = JSON.parse(spies.writtenFiles[0]!.content) as {
      generatedAt: string;
      command: string;
      olderThanDays: number;
      cutoffDate: string;
      activeRunId: string | null;
      candidateTasks: unknown[];
      affectedRuns: unknown[];
      sweptRunIds: unknown[];
    };
    assert.equal(backup.command, "sweep-orphans");
    assert.ok(backup.generatedAt, "backup has generatedAt");
    assert.equal(backup.olderThanDays, 14, "default olderThanDays is 14");
    assert.ok(backup.cutoffDate, "backup has cutoffDate");
    assert.equal(backup.candidateTasks.length, 1);
    assert.equal(backup.activeRunId, "run-active");
  });

  it("issues UPDATE tasks then UPDATE runs inside a transaction", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand(["--confirm"], deps);

    assert.equal(spies.transactionCalls, 1, "exactly one transaction");
    assert.equal(spies.updateTasksQueries.length, 1, "one UPDATE tasks query");
    // run-orphan has only one task (the candidate) so it becomes swept
    assert.equal(spies.updateRunsQueries.length, 1, "one UPDATE runs query (run fully swept)");

    // Task update must pass candidate IDs via parameterized placeholder.
    const taskUpdateValues = spies.updateTasksQueries[0]!.values;
    assert.ok(Array.isArray(taskUpdateValues), "UPDATE tasks values must be an array");
    assert.ok(
      (taskUpdateValues[0] as string[]).includes("t-orphan"),
      "t-orphan must be in the UPDATE list"
    );
  });

  it("uses parameterized queries (any($1)) — does not interpolate IDs into SQL", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand(["--confirm"], deps);

    for (const q of [...spies.updateTasksQueries, ...spies.updateRunsQueries]) {
      assert.ok(
        q.text.includes("$1"),
        `UPDATE query must use parameterized placeholder: ${q.text}`
      );
      assert.ok(
        !q.text.includes("t-orphan") && !q.text.includes("run-orphan"),
        "UPDATE query must not interpolate IDs into SQL text"
      );
    }
  });

  it("does NOT issue UPDATE queries when there are no candidates", async () => {
    const scenario: CommandScenario = {
      tasks: [],
      runs: [],
      reviews: [],
      approvals: [],
      activeLockPairs: [],
      activeRunId: null,
      projectId: "proj-1"
    };
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand(["--confirm"], deps);

    assert.equal(spies.transactionCalls, 0, "no transaction when nothing to sweep");
    assert.equal(spies.writtenFiles.length, 0, "no backup file when nothing to sweep");
    assert.equal(spies.updateTasksQueries.length, 0);
  });

  it("refuses with no writable backup path (writeFile throws → no mutations)", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    deps.writeFile = async () => { throw new Error("disk full"); };

    await assert.rejects(
      () => sweepOrphansCommand(["--confirm"], deps),
      /disk full/
    );

    assert.equal(
      spies.updateTasksQueries.length,
      0,
      "no UPDATE queries must fire when backup write fails"
    );
    assert.equal(spies.transactionCalls, 0, "no transaction when backup fails");
  });

  it("uses default backup path within dataRoot/sweep-backups/", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand(["--confirm"], deps);

    assert.equal(spies.writtenFiles.length, 1);
    const backupPath = spies.writtenFiles[0]!.path;
    assert.ok(
      backupPath.startsWith("/fake/data-root/sweep-backups/"),
      `backup must be under dataRoot/sweep-backups/, got: ${backupPath}`
    );
    assert.ok(backupPath.endsWith(".json"), "backup path must end with .json");
  });

  it("honours --backup override path within dataRoot", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    const customPath = "/fake/data-root/my-backup.json";
    await sweepOrphansCommand(["--confirm", "--backup", customPath], deps);

    assert.equal(spies.writtenFiles.length, 1);
    assert.equal(spies.writtenFiles[0]!.path, customPath);
  });

  it("rejects --backup path outside both dataRoot and repoRoot", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);

    await assert.rejects(
      () => sweepOrphansCommand(["--confirm", "--backup", "/etc/shadow.json"], deps),
      /outside both dataRoot/
    );
  });

  it("rejects a relative --backup path", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);

    await assert.rejects(
      () => sweepOrphansCommand(["--confirm", "--backup", "relative/path.json"], deps),
      /must be absolute/
    );
  });

  it("rejects a --backup path not ending with .json", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);

    await assert.rejects(
      () => sweepOrphansCommand(["--confirm", "--backup", "/fake/data-root/backup.txt"], deps),
      /must end with \.json/
    );
  });

  it("rejects a --backup path with .. directory traversal", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);
    // Starts with dataRoot prefix but resolves outside both roots.
    const traversalPath = "/fake/data-root/../etc/passwd.json";

    await assert.rejects(
      () => sweepOrphansCommand(["--confirm", "--backup", traversalPath], deps),
      /outside both dataRoot/,
      "path traversal via .. must be rejected"
    );
  });

  it("does NOT update runs when the run has additional surviving tasks", async () => {
    // run-orphan has t-orphan (candidate) AND t-survivor (in_progress, not a candidate
    // because it has a review). So run-orphan is NOT swept.
    const tasks: SweepTaskRow[] = [
      { id: "t-orphan", run_id: "run-orphan", task_key: "daemonExtractFoo", status: "in_progress" }
    ];
    const scenario: CommandScenario = {
      tasks,
      runs: [{ id: "run-orphan", title: "Orphan run", status: "in_progress", created_at: OLD_CREATED_AT }],
      reviews: [],
      approvals: [],
      activeLockPairs: [],
      activeRunId: "run-active",
      projectId: "proj-1",
      allRunTasks: [
        ...tasks,
        { id: "t-survivor", run_id: "run-orphan", task_key: "survivingTask", status: "in_progress" }
      ]
    };
    const { deps, spies } = buildFakeDeps(scenario);

    await sweepOrphansCommand(["--confirm"], deps);

    assert.equal(spies.updateTasksQueries.length, 1, "tasks must be updated");
    assert.equal(
      spies.updateRunsQueries.length,
      0,
      "run must NOT be swept — t-survivor survives"
    );
  });
});

// ---------------------------------------------------------------------------
// sweepOrphansCommand — argument validation
// ---------------------------------------------------------------------------

describe("sweepOrphansCommand — argument validation", () => {
  it("rejects --older-than 0 (must be positive)", async () => {
    const { deps } = buildFakeDeps(buildOneCandidateScenario());
    await assert.rejects(
      () => sweepOrphansCommand(["--older-than", "0"], deps),
      /--older-than must be a positive integer/
    );
  });

  it("rejects --older-than with a non-integer value", async () => {
    const { deps } = buildFakeDeps(buildOneCandidateScenario());
    await assert.rejects(
      () => sweepOrphansCommand(["--older-than", "abc"], deps),
      /--older-than must be a positive integer/
    );
  });

  it("rejects --older-than with a float value", async () => {
    const { deps } = buildFakeDeps(buildOneCandidateScenario());
    await assert.rejects(
      () => sweepOrphansCommand(["--older-than", "7.5"], deps),
      /--older-than must be a positive integer/
    );
  });

  it("accepts a valid positive integer for --older-than", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);
    // Should not throw
    await sweepOrphansCommand(["--older-than", "30"], deps);
  });

  it("rejects --allow-list id with invalid characters (spaces, slashes, etc.)", async () => {
    const { deps } = buildFakeDeps(buildOneCandidateScenario());
    await assert.rejects(
      () => sweepOrphansCommand(["--allow-list", "valid-id,bad id!"], deps),
      /invalid --allow-list id/
    );
  });

  it("rejects --allow-list id with slash (path traversal prevention)", async () => {
    const { deps } = buildFakeDeps(buildOneCandidateScenario());
    await assert.rejects(
      () => sweepOrphansCommand(["--allow-list", "../etc/passwd"], deps),
      /invalid --allow-list id/
    );
  });

  it("accepts valid UUIDs in --allow-list (UUID chars match the pattern)", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);
    // UUID-like strings are valid under ^[A-Za-z0-9_-]+$
    await sweepOrphansCommand(
      ["--allow-list", "d112e7ac-3c2d-409c-94d2-f918eb0a4abc"],
      deps
    );
  });

  it("exports SCAN_ROW_CAP (verifies the constant is accessible)", () => {
    assert.ok(SCAN_ROW_CAP > 0, "SCAN_ROW_CAP must be a positive number");
    assert.equal(typeof SCAN_ROW_CAP, "number");
  });
});
