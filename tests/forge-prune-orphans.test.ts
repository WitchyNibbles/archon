/**
 * Tests for src/admin/prune-orphans.ts
 *
 * TDD approach: verifies the pure predicate and command behavior with fake deps.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-prune-orphans.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findOrphanCandidates,
  pruneOrphansCommand
} from "../src/admin/prune-orphans.ts";
import type {
  TaskRow,
  ReviewCount,
  ApprovalCount,
  PruneOrphansDeps,
  SqlQueryResult
} from "../src/admin/prune-orphans.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRow> & { id: string; run_id: string; task_key: string }): TaskRow {
  return {
    status: "in_progress",
    ...overrides
  };
}

function makeReviewCount(
  run_id: string,
  task_key: string,
  distinct_passed_roles: number
): ReviewCount {
  return { run_id, task_key, distinct_passed_roles };
}

function makeApprovalCount(
  run_id: string,
  task_key: string,
  approval_count: number
): ApprovalCount {
  return { run_id, task_key, approval_count };
}

// ---------------------------------------------------------------------------
// findOrphanCandidates — pure predicate tests
// ---------------------------------------------------------------------------

describe("findOrphanCandidates — pure predicate", () => {
  it("selects a task row that meets all three clauses", () => {
    // Run A: has a sealed twin for task_key "myTask"
    const sealedTask = makeTask({
      id: "sealed-uuid",
      run_id: "run-A",
      task_key: "myTask",
      status: "approved" // will be excluded from candidates by clause (a)
    });
    // Run B: orphan stub for same task_key
    const orphanTask = makeTask({
      id: "orphan-uuid",
      run_id: "run-B",
      task_key: "myTask",
      status: "in_progress"
    });

    const tasks = [sealedTask, orphanTask];
    const reviews = [makeReviewCount("run-A", "myTask", 3)];
    const approvals = [makeApprovalCount("run-A", "myTask", 1)];

    const plan = findOrphanCandidates(tasks, reviews, approvals);

    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]!.id, "orphan-uuid");
  });

  it("does NOT select a sealed row itself (clause a: status check)", () => {
    const sealedTask = makeTask({
      id: "sealed-uuid",
      run_id: "run-A",
      task_key: "myTask",
      status: "approved"
    });
    const reviews = [makeReviewCount("run-A", "myTask", 3)];
    const approvals = [makeApprovalCount("run-A", "myTask", 1)];

    const plan = findOrphanCandidates([sealedTask], reviews, approvals);

    assert.equal(plan.candidates.length, 0, "sealed row must not be a candidate");
  });

  it("does NOT select a row with any reviews (clause b)", () => {
    // The sealed twin is in run-A; run-B task has 1 review.
    const sealedTask = makeTask({ id: "s", run_id: "run-A", task_key: "myTask", status: "approved" });
    const candidate = makeTask({ id: "c", run_id: "run-B", task_key: "myTask", status: "in_progress" });
    const tasks = [sealedTask, candidate];
    const reviews = [
      makeReviewCount("run-A", "myTask", 3),
      makeReviewCount("run-B", "myTask", 1) // run-B has 1 passed review → not safe to prune
    ];
    const approvals = [makeApprovalCount("run-A", "myTask", 1)];

    const plan = findOrphanCandidates(tasks, reviews, approvals);

    assert.equal(plan.candidates.length, 0, "row with reviews must be excluded");
  });

  it("does NOT select a row with any approvals (clause b)", () => {
    const sealedTask = makeTask({ id: "s", run_id: "run-A", task_key: "myTask", status: "approved" });
    const candidate = makeTask({ id: "c", run_id: "run-B", task_key: "myTask", status: "in_progress" });
    const tasks = [sealedTask, candidate];
    const reviews = [makeReviewCount("run-A", "myTask", 3)];
    const approvals = [
      makeApprovalCount("run-A", "myTask", 1),
      makeApprovalCount("run-B", "myTask", 1) // run-B has an approval → not safe
    ];

    const plan = findOrphanCandidates(tasks, reviews, approvals);

    assert.equal(plan.candidates.length, 0, "row with approvals must be excluded");
  });

  it("does NOT select an in_progress row whose task_key has NO sealed twin (clause c — twinless daemonExtract* case)", () => {
    // Simulates the 5 twinless daemonExtract* orphans: in_progress, 0 reviews,
    // 0 approvals, but NO sealed twin in any other run.
    const orphan = makeTask({ id: "d", run_id: "run-X", task_key: "daemonExtractFoo", status: "in_progress" });

    const plan = findOrphanCandidates([orphan], [], []);

    assert.equal(plan.candidates.length, 0, "twinless orphan must not be selected");
  });

  it("does NOT select approved/done/blocked/review_blocked rows (clause a)", () => {
    // Even if task_key has a sealed twin and no reviews, these statuses are forbidden.
    const sealed = makeTask({ id: "s", run_id: "run-A", task_key: "myTask", status: "approved" });
    const reviews = [makeReviewCount("run-A", "myTask", 3)];
    const approvals = [makeApprovalCount("run-A", "myTask", 1)];

    for (const status of ["approved", "done", "blocked", "review_blocked"]) {
      const task = makeTask({ id: "t", run_id: "run-B", task_key: "myTask", status });
      const plan = findOrphanCandidates([sealed, task], reviews, approvals);
      assert.equal(
        plan.candidates.length,
        0,
        `status="${status}" must not be a candidate`
      );
    }
  });

  it("selects a 'ready' status row as a candidate (in_progress + ready are both valid)", () => {
    const sealedTask = makeTask({ id: "s", run_id: "run-A", task_key: "myTask", status: "done" });
    const readyOrphan = makeTask({ id: "r", run_id: "run-B", task_key: "myTask", status: "ready" });
    const reviews = [makeReviewCount("run-A", "myTask", 3)];
    const approvals = [makeApprovalCount("run-A", "myTask", 1)];

    const plan = findOrphanCandidates([sealedTask, readyOrphan], reviews, approvals);

    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]!.id, "r");
  });

  it("requires ≥3 distinct passed roles for the sealed twin (2 is not enough)", () => {
    const notQuiteSealedTask = makeTask({ id: "s", run_id: "run-A", task_key: "myTask", status: "in_progress" });
    const candidate = makeTask({ id: "c", run_id: "run-B", task_key: "myTask", status: "in_progress" });
    const reviews = [
      makeReviewCount("run-A", "myTask", 2), // only 2 roles — not sealed
      makeReviewCount("run-B", "myTask", 0)
    ];
    const approvals = [makeApprovalCount("run-A", "myTask", 1)];

    const plan = findOrphanCandidates([notQuiteSealedTask, candidate], reviews, approvals);

    assert.equal(plan.candidates.length, 0, "twin with only 2 reviews is not sealed");
  });

  it("requires ≥1 approval for the sealed twin (3 reviews alone is not enough)", () => {
    const notQuiteSealedTask = makeTask({ id: "s", run_id: "run-A", task_key: "myTask", status: "in_progress" });
    const candidate = makeTask({ id: "c", run_id: "run-B", task_key: "myTask", status: "in_progress" });
    const reviews = [makeReviewCount("run-A", "myTask", 3)];
    // No approvals for run-A — not sealed.
    const approvals: ApprovalCount[] = [];

    const plan = findOrphanCandidates([notQuiteSealedTask, candidate], reviews, approvals);

    assert.equal(plan.candidates.length, 0, "twin with 0 approvals is not sealed");
  });

  it("selects multiple candidates across multiple runs for the same task_key", () => {
    // task_key "forgePhase0Skeleton" has 3 orphan stubs and 1 sealed run.
    const sealed = makeTask({ id: "s0", run_id: "run-S", task_key: "forgePhase0Skeleton", status: "approved" });
    const orphan1 = makeTask({ id: "o1", run_id: "run-1", task_key: "forgePhase0Skeleton", status: "in_progress" });
    const orphan2 = makeTask({ id: "o2", run_id: "run-2", task_key: "forgePhase0Skeleton", status: "in_progress" });
    const reviews = [makeReviewCount("run-S", "forgePhase0Skeleton", 3)];
    const approvals = [makeApprovalCount("run-S", "forgePhase0Skeleton", 1)];

    const plan = findOrphanCandidates([sealed, orphan1, orphan2], reviews, approvals);

    assert.equal(plan.candidates.length, 2);
    const ids = plan.candidates.map((t) => t.id).sort();
    assert.deepEqual(ids, ["o1", "o2"]);
  });
});

// ---------------------------------------------------------------------------
// findOrphanCandidates — empty-run computation tests
// ---------------------------------------------------------------------------

describe("findOrphanCandidates — empty-run computation", () => {
  it("marks a run as emptied when ALL its tasks are candidates", () => {
    const sealed = makeTask({ id: "s", run_id: "run-A", task_key: "myTask", status: "approved" });
    // run-B has ONLY the orphan candidate.
    const orphan = makeTask({ id: "c", run_id: "run-B", task_key: "myTask", status: "in_progress" });
    const reviews = [makeReviewCount("run-A", "myTask", 3)];
    const approvals = [makeApprovalCount("run-A", "myTask", 1)];

    const plan = findOrphanCandidates([sealed, orphan], reviews, approvals);

    assert.ok(plan.emptiedRunIds.includes("run-B"), "run-B should be in emptiedRunIds");
    assert.ok(!plan.emptiedRunIds.includes("run-A"), "run-A (sealed) should not be emptied");
  });

  it("does NOT mark a run as emptied when it has at least one surviving task", () => {
    const sealed = makeTask({ id: "s", run_id: "run-A", task_key: "taskX", status: "approved" });
    // run-B has a candidate (taskX) AND a surviving real task (taskY).
    const orphan = makeTask({ id: "c1", run_id: "run-B", task_key: "taskX", status: "in_progress" });
    const survivor = makeTask({ id: "c2", run_id: "run-B", task_key: "taskY", status: "in_progress" });
    const reviews = [makeReviewCount("run-A", "taskX", 3)];
    const approvals = [makeApprovalCount("run-A", "taskX", 1)];

    const plan = findOrphanCandidates([sealed, orphan, survivor], reviews, approvals);

    // orphan is a candidate, but survivor is NOT (no twin for taskY).
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]!.id, "c1");
    assert.ok(!plan.emptiedRunIds.includes("run-B"), "run-B should NOT be emptied (survivor remains)");
  });

  it("returns empty emptiedRunIds when there are no candidates", () => {
    const task = makeTask({ id: "t", run_id: "run-A", task_key: "foo", status: "in_progress" });
    const plan = findOrphanCandidates([task], [], []);
    assert.equal(plan.emptiedRunIds.length, 0);
  });

  it("does NOT prune a run that contains BOTH a sealed task AND a candidate for a different task_key", () => {
    // run-A: sealed task for "taskX" AND a candidate stub for "taskY".
    // "taskY" has a sealed twin in run-B (separate run). So run-A contains:
    //   - sealedX: sealed row (not a candidate by clause a)
    //   - orphanY: candidate (in_progress, no reviews, twin exists in run-B)
    // After removing orphanY, run-A still has sealedX → NOT emptied.
    const sealedX = makeTask({ id: "sx", run_id: "run-A", task_key: "taskX", status: "approved" });
    const orphanY = makeTask({ id: "oy", run_id: "run-A", task_key: "taskY", status: "in_progress" });
    const sealedY = makeTask({ id: "sy", run_id: "run-B", task_key: "taskY", status: "approved" });

    const reviews = [
      makeReviewCount("run-A", "taskX", 3),
      makeReviewCount("run-B", "taskY", 3)
    ];
    const approvals = [
      makeApprovalCount("run-A", "taskX", 1),
      makeApprovalCount("run-B", "taskY", 1)
    ];

    const plan = findOrphanCandidates([sealedX, orphanY, sealedY], reviews, approvals);

    // orphanY is the only candidate.
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]!.id, "oy");
    // run-A is NOT emptied — sealedX survives.
    assert.ok(!plan.emptiedRunIds.includes("run-A"),
      "run-A must not be emptied because sealedX survives");
    // run-B is not emptied either — sealedY survives.
    assert.ok(!plan.emptiedRunIds.includes("run-B"),
      "run-B must not be emptied because sealedY survives");
  });
});

// ---------------------------------------------------------------------------
// pruneOrphansCommand — command behavior tests
// ---------------------------------------------------------------------------

/** Build a minimal set of tasks+reviews+approvals that produces exactly one candidate. */
function buildOneCandidateScenario(): {
  tasks: TaskRow[];
  reviews: ReviewCount[];
  approvals: ApprovalCount[];
} {
  return {
    tasks: [
      makeTask({ id: "sealed-id", run_id: "run-sealed", task_key: "myTask", status: "approved" }),
      makeTask({ id: "orphan-id", run_id: "run-orphan", task_key: "myTask", status: "in_progress" })
    ],
    reviews: [makeReviewCount("run-sealed", "myTask", 3)],
    approvals: [makeApprovalCount("run-sealed", "myTask", 1)]
  };
}

/**
 * Build fake deps that return canned query results.
 * All mutation hooks are spied on (tracked via arrays/counters).
 */
function buildFakeDeps(scenario: {
  tasks: TaskRow[];
  reviews: ReviewCount[];
  approvals: ApprovalCount[];
}): {
  deps: PruneOrphansDeps;
  spies: {
    writtenLines: string[];
    writtenFiles: Array<{ path: string; content: string }>;
    transactionCalls: number;
    deleteTasksQueries: Array<{ text: string; values: readonly unknown[] | undefined }>;
    deleteRunsQueries: Array<{ text: string; values: readonly unknown[] | undefined }>;
  };
} {
  const writtenLines: string[] = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];
  const deleteTasksQueries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  const deleteRunsQueries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];

  const spies = { writtenLines, writtenFiles, transactionCalls: 0, deleteTasksQueries, deleteRunsQueries };

  const deps: PruneOrphansDeps = {
    dataRoot: "/fake/data-root",
    repoRoot: "/fake/repo-root",
    now: () => "2026-06-25T12:00:00.000Z",
    writeLine: (line) => { writtenLines.push(line); },
    writeFile: async (filePath, content) => {
      writtenFiles.push({ path: filePath, content });
    },
    withTransaction: async (work) => {
      spies.transactionCalls += 1;
      return work();
    },
    query: async (text, values): Promise<SqlQueryResult> => {
      const lower = text.toLowerCase().replace(/\s+/g, " ").trim();

      // Tasks query
      if (lower.includes("from tasks") && lower.includes("select id, run_id, task_key, status")) {
        return {
          rows: scenario.tasks.map((t) => ({ ...t })),
          rowCount: scenario.tasks.length
        };
      }

      // Review counts query
      if (lower.includes("from reviews") && lower.includes("distinct_passed_roles")) {
        return {
          rows: scenario.reviews.map((r) => ({
            run_id: r.run_id,
            task_key: r.task_key,
            distinct_passed_roles: String(r.distinct_passed_roles)
          })),
          rowCount: scenario.reviews.length
        };
      }

      // Approval counts query
      if (lower.includes("from approvals") && lower.includes("approval_count")) {
        return {
          rows: scenario.approvals.map((a) => ({
            run_id: a.run_id,
            task_key: a.task_key,
            approval_count: String(a.approval_count)
          })),
          rowCount: scenario.approvals.length
        };
      }

      // Runs query (for backup)
      if (lower.includes("from runs") && lower.includes("select id")) {
        const ids = (values?.[0] as string[] | undefined) ?? [];
        return {
          rows: ids.map((id) => ({
            id,
            title: `Run ${id}`,
            status: "in_progress",
            created_at: "2026-06-01T00:00:00.000Z"
          })),
          rowCount: ids.length
        };
      }

      // Delete tasks
      if (lower.includes("delete from tasks")) {
        deleteTasksQueries.push({ text, values });
        return { rows: [], rowCount: (values?.[0] as unknown[])?.length ?? 0 };
      }

      // Delete runs
      if (lower.includes("delete from runs")) {
        deleteRunsQueries.push({ text, values });
        return { rows: [], rowCount: (values?.[0] as unknown[])?.length ?? 0 };
      }

      throw new Error(`Unexpected query in fake deps: ${text}`);
    }
  };

  return { deps, spies };
}

describe("pruneOrphansCommand — dry-run", () => {
  it("prints candidates and does NOT call withTransaction or write any files", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await pruneOrphansCommand([], deps);

    assert.equal(spies.transactionCalls, 0, "dry-run must not start a transaction");
    assert.equal(spies.writtenFiles.length, 0, "dry-run must not write any files");
    assert.equal(spies.deleteTasksQueries.length, 0, "dry-run must not delete tasks");
    assert.equal(spies.deleteRunsQueries.length, 0, "dry-run must not delete runs");

    const allOutput = spies.writtenLines.join("\n");
    assert.ok(allOutput.includes("DRY-RUN"), "output should say DRY-RUN");
    assert.ok(allOutput.includes("orphan-id"), "output should list the orphan task id");
    assert.ok(allOutput.includes("dry-run — pass --confirm"), "output should instruct how to confirm");
  });

  it("prints (none) when there are no candidates", async () => {
    const scenario = { tasks: [], reviews: [], approvals: [] };
    const { deps, spies } = buildFakeDeps(scenario);

    await pruneOrphansCommand([], deps);

    const allOutput = spies.writtenLines.join("\n");
    assert.ok(allOutput.includes("(none)"), "should print (none) for empty candidate list");
    assert.equal(spies.transactionCalls, 0);
  });
});

describe("pruneOrphansCommand — confirm mode", () => {
  it("writes backup before issuing deletes, in correct order", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);

    const callOrder: string[] = [];
    const originalWriteFile = deps.writeFile;
    deps.writeFile = async (p, c) => {
      callOrder.push("writeFile");
      return originalWriteFile(p, c);
    };
    const originalWithTransaction = deps.withTransaction;
    deps.withTransaction = async (work) => {
      callOrder.push("transaction");
      return originalWithTransaction(work);
    };

    await pruneOrphansCommand(["--confirm"], deps);

    // Backup must be written BEFORE the transaction starts.
    assert.ok(callOrder.indexOf("writeFile") < callOrder.indexOf("transaction"),
      "backup (writeFile) must happen before the transaction");
  });

  it("writes exactly one backup file with correct structure", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await pruneOrphansCommand(["--confirm"], deps);

    assert.equal(spies.writtenFiles.length, 1, "exactly one backup file");
    const backup = JSON.parse(spies.writtenFiles[0]!.content) as {
      generatedAt: string;
      candidateTasks: TaskRow[];
      affectedRuns: unknown[];
      emptiedRunIds: string[];
    };
    assert.ok(backup.generatedAt, "backup has generatedAt");
    assert.equal(backup.candidateTasks.length, 1);
    assert.equal(backup.candidateTasks[0]!.id, "orphan-id");
  });

  it("issues delete-tasks query then delete-runs query inside a transaction", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await pruneOrphansCommand(["--confirm"], deps);

    assert.equal(spies.transactionCalls, 1, "exactly one transaction");
    assert.equal(spies.deleteTasksQueries.length, 1, "one delete-tasks query");
    assert.equal(spies.deleteRunsQueries.length, 1, "one delete-runs query");

    // Task delete must pass the candidate IDs.
    const taskDeleteValues = spies.deleteTasksQueries[0]!.values;
    assert.ok(Array.isArray(taskDeleteValues), "delete tasks values must be an array");
    assert.ok((taskDeleteValues[0] as string[]).includes("orphan-id"),
      "orphan-id must be in the delete list");

    // Run delete must pass the emptied run IDs.
    const runDeleteValues = spies.deleteRunsQueries[0]!.values;
    assert.ok(Array.isArray(runDeleteValues), "delete runs values must be an array");
    assert.ok((runDeleteValues[0] as string[]).includes("run-orphan"),
      "run-orphan must be in the emptied-run delete list");
  });

  it("uses parameterized queries (any($1)) for deletes — not string interpolation", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await pruneOrphansCommand(["--confirm"], deps);

    for (const q of [...spies.deleteTasksQueries, ...spies.deleteRunsQueries]) {
      assert.ok(q.text.includes("$1"), `delete query must use parameterized placeholder: ${q.text}`);
      assert.ok(!q.text.includes("orphan-id"), "delete query must not interpolate IDs into SQL text");
    }
  });

  it("does not delete anything when there are no candidates", async () => {
    const scenario = { tasks: [], reviews: [], approvals: [] };
    const { deps, spies } = buildFakeDeps(scenario);

    await pruneOrphansCommand(["--confirm"], deps);

    assert.equal(spies.transactionCalls, 0, "no transaction when nothing to delete");
    assert.equal(spies.writtenFiles.length, 0, "no backup file when nothing to delete");
  });

  it("uses default backup path within dataRoot when no --backup flag", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    await pruneOrphansCommand(["--confirm"], deps);

    assert.equal(spies.writtenFiles.length, 1);
    const backupPath = spies.writtenFiles[0]!.path;
    assert.ok(backupPath.startsWith("/fake/data-root/prune-backups/"),
      `backup path should be under dataRoot/prune-backups/, got: ${backupPath}`);
    assert.ok(backupPath.endsWith(".json"), "backup path must end with .json");
  });

  it("uses --backup override path when provided and within dataRoot", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps, spies } = buildFakeDeps(scenario);

    const customPath = "/fake/data-root/custom-backup.json";
    await pruneOrphansCommand(["--confirm", "--backup", customPath], deps);

    assert.equal(spies.writtenFiles.length, 1);
    assert.equal(spies.writtenFiles[0]!.path, customPath);
  });

  it("rejects --backup path outside both dataRoot and repoRoot", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);

    await assert.rejects(
      () => pruneOrphansCommand(["--confirm", "--backup", "/etc/shadow.json"], deps),
      /outside both dataRoot/
    );
  });

  it("rejects a --backup path that is a relative path", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);

    await assert.rejects(
      () => pruneOrphansCommand(["--confirm", "--backup", "relative/path.json"], deps),
      /must be absolute/
    );
  });

  it("rejects a --backup path not ending with .json", async () => {
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);

    await assert.rejects(
      () => pruneOrphansCommand(["--confirm", "--backup", "/fake/data-root/backup.txt"], deps),
      /must end with \.json/
    );
  });

  it("rejects a --backup path that uses .. traversal to escape dataRoot (e.g. /dataRoot/../etc/passwd.json)", async () => {
    // This is the critical traversal test: the raw string starts with the dataRoot prefix
    // but `..` causes it to resolve outside the boundary. The guard must normalize first.
    const scenario = buildOneCandidateScenario();
    const { deps } = buildFakeDeps(scenario);
    // deps.dataRoot is "/fake/data-root"; this path starts with "/fake/data-root/"
    // but resolves to "/fake/etc/passwd.json" — outside both roots.
    const traversalPath = "/fake/data-root/../etc/passwd.json";

    await assert.rejects(
      () => pruneOrphansCommand(["--confirm", "--backup", traversalPath], deps),
      /outside both dataRoot/,
      "path traversal via .. must be rejected even when raw string contains dataRoot prefix"
    );
  });
});
