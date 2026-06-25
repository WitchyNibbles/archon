/**
 * @module admin/prune-orphans
 *
 * Prune-orphans admin verb — safety-first cleanup of duplicate task rows
 * left behind by repeated `init-task` calls that create a new run per
 * invocation.
 *
 * Security contract (class: security_sensitive):
 *   - DRY-RUN BY DEFAULT.  Zero mutation unless `--confirm` is passed.
 *   - Before any delete, write a pre-delete JSON backup.
 *   - Deletes happen in a single transaction: tasks first (FK cascade
 *     handles task_dependencies), then emptied run rows.
 *   - Parameterized queries only — never string-interpolated SQL.
 *   - The predicate (findOrphanCandidates) is PURE and unit-tested in
 *     isolation. It must never select a sealed/reviewed/approved/twinless row.
 *
 * A task row is a candidate IFF ALL THREE clauses hold:
 *   (a) status ∈ {in_progress, ready}
 *   (b) 0 distinct passed-review roles AND 0 approvals for (run_id, task_key)
 *   (c) A SEALED twin exists: another row with the SAME task_key (different
 *       run_id) that has ≥3 distinct passed-review roles AND ≥1 approval.
 *
 * The 5 twinless daemonExtract* orphans satisfy (a)+(b) but NOT (c), so
 * they are excluded by design.
 *
 * Backup path: <dataRoot>/prune-backups/orphans-<ISO>.json
 * Override with --backup <absolute-path> (repo/dataRoot-guarded).
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskRow {
  /** UUID primary key of the tasks table row. */
  id: string;
  run_id: string;
  task_key: string;
  status: string;
}

export interface RunRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

/**
 * Per-(run_id, task_key) counts fetched from the DB before the pure
 * predicate is applied.
 */
export interface ReviewCount {
  run_id: string;
  task_key: string;
  /** Count of DISTINCT passed-review roles. */
  distinct_passed_roles: number;
}

export interface ApprovalCount {
  run_id: string;
  task_key: string;
  /** Count of approvals (any decision). */
  approval_count: number;
}

/** Result of the pure predicate computation. */
export interface OrphanPlan {
  /** Task rows safe to delete (meet all three clauses). */
  candidates: readonly TaskRow[];
  /**
   * run_ids that would have ZERO tasks remaining after removing candidates.
   * These runs should be deleted after the candidate tasks are removed.
   */
  emptiedRunIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Pure predicate — no IO, fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Compute the prune plan given the raw DB rows and their counts.
 *
 * This function is PURE: no IO, no side effects, deterministic output.
 *
 * Safety invariants enforced here:
 *   - Never selects a row with status approved/done/blocked/review_blocked.
 *   - Never selects a row that has any reviews or approvals.
 *   - Never selects a row whose task_key has no sealed twin.
 */
export function findOrphanCandidates(
  tasks: readonly TaskRow[],
  reviewCounts: readonly ReviewCount[],
  approvalCounts: readonly ApprovalCount[]
): OrphanPlan {
  // Build lookup maps for O(1) access.
  const reviewMap = new Map<string, number>();
  for (const rc of reviewCounts) {
    reviewMap.set(`${rc.run_id}:${rc.task_key}`, rc.distinct_passed_roles);
  }

  const approvalMap = new Map<string, number>();
  for (const ac of approvalCounts) {
    approvalMap.set(`${ac.run_id}:${ac.task_key}`, ac.approval_count);
  }

  // Build sealed-twin set: task_keys that have at least one sealed row
  // (a different run_id with ≥3 distinct passed roles + ≥1 approval).
  // We need all task_keys with a sealed twin — the sealed row is NOT a
  // candidate itself (it fails clause (a) by design, but we exclude it
  // explicitly by only collecting task_keys of rows that ARE sealed).
  const sealedTaskKeys = new Set<string>();
  for (const task of tasks) {
    const reviewCount = reviewMap.get(`${task.run_id}:${task.task_key}`) ?? 0;
    const approvalCount = approvalMap.get(`${task.run_id}:${task.task_key}`) ?? 0;
    if (reviewCount >= 3 && approvalCount >= 1) {
      // This row is sealed — its task_key can be a twin for other rows.
      sealedTaskKeys.add(task.task_key);
    }
  }

  // Identify candidate rows.
  const candidates: TaskRow[] = [];
  const CANDIDATE_STATUSES = new Set(["in_progress", "ready"]);

  for (const task of tasks) {
    // Clause (a): status must be in_progress or ready.
    if (!CANDIDATE_STATUSES.has(task.status)) {
      continue;
    }

    // Clause (b): zero reviews AND zero approvals for this (run_id, task_key).
    const reviewCount = reviewMap.get(`${task.run_id}:${task.task_key}`) ?? 0;
    const approvalCount = approvalMap.get(`${task.run_id}:${task.task_key}`) ?? 0;
    if (reviewCount > 0 || approvalCount > 0) {
      continue;
    }

    // Clause (c): a sealed twin must exist under a DIFFERENT run_id.
    // The sealed twin is identified by task_key being in sealedTaskKeys.
    // We additionally verify the sealed row is not THIS row (different run_id
    // is implicit because a sealed row has ≥3 reviews and this row has 0).
    if (!sealedTaskKeys.has(task.task_key)) {
      continue;
    }

    candidates.push(task);
  }

  // Compute which run_ids would become empty after removing candidates.
  const candidateIds = new Set(candidates.map((t) => t.id));

  // Group all tasks by run_id.
  const tasksByRun = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const existing = tasksByRun.get(task.run_id);
    if (existing) {
      existing.push(task);
    } else {
      tasksByRun.set(task.run_id, [task]);
    }
  }

  const emptiedRunIds: string[] = [];
  for (const [runId, runTasks] of tasksByRun) {
    const surviving = runTasks.filter((t) => !candidateIds.has(t.id));
    if (surviving.length === 0) {
      emptiedRunIds.push(runId);
    }
  }

  return { candidates, emptiedRunIds };
}

// ---------------------------------------------------------------------------
// SqlClient interface (injected — no real DB required for tests)
// ---------------------------------------------------------------------------

export interface SqlQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface SqlClient {
  query(
    text: string,
    values?: readonly unknown[]
  ): Promise<SqlQueryResult>;
}

// ---------------------------------------------------------------------------
// Deps interface — all IO injected for unit testing
// ---------------------------------------------------------------------------

export interface PruneOrphansDeps {
  /** Execute a raw parameterized SQL query. */
  query: SqlClient["query"];
  /** Execute work inside a BEGIN/COMMIT/ROLLBACK transaction. */
  withTransaction: <T>(work: () => Promise<T>) => Promise<T>;
  /** Write a file to the given absolute path (creates parent dirs as needed). */
  writeFile: (filePath: string, content: string) => Promise<void>;
  /** Return current ISO timestamp string. */
  now: () => string;
  /** Write a line to stdout. */
  writeLine: (line: string) => void;
  /**
   * Absolute path to the data root (e.g. process.env.ARCHON_DATA_ROOT or cwd).
   * Used to compute the default backup path.
   */
  dataRoot: string;
  /**
   * Repo root used for path-traversal guard on --backup.
   * Must be an absolute path.
   */
  repoRoot: string;
}

// ---------------------------------------------------------------------------
// DB query helpers (used in pruneOrphansCommand; injected via deps in tests)
// ---------------------------------------------------------------------------

interface TaskRowDb {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
}

interface ReviewCountDb {
  run_id: string;
  task_key: string;
  distinct_passed_roles: string; // Postgres returns bigint as string
}

interface ApprovalCountDb {
  run_id: string;
  task_key: string;
  approval_count: string; // Postgres returns bigint as string
}

interface RunRowDb {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

async function fetchAllTasks(query: SqlClient["query"]): Promise<TaskRow[]> {
  const result = await query(
    `select id, run_id, task_key, status from tasks`
  );
  return result.rows.map((row) => {
    const r = row as unknown as TaskRowDb;
    return { id: r.id, run_id: r.run_id, task_key: r.task_key, status: r.status };
  });
}

async function fetchReviewCounts(query: SqlClient["query"]): Promise<ReviewCount[]> {
  // Count DISTINCT passed-review roles per (run_id, task_key).
  // reviews.task_id is the task_key (text), reviews.run_id is the run UUID.
  const result = await query(
    `select
       r.run_id,
       r.task_id as task_key,
       count(distinct r.reviewer_role) as distinct_passed_roles
     from reviews r
     where r.state = 'passed'
     group by r.run_id, r.task_id`
  );
  return result.rows.map((row) => {
    const r = row as unknown as ReviewCountDb;
    return {
      run_id: r.run_id,
      task_key: r.task_key,
      distinct_passed_roles: parseInt(r.distinct_passed_roles, 10)
    };
  });
}

async function fetchApprovalCounts(query: SqlClient["query"]): Promise<ApprovalCount[]> {
  const result = await query(
    `select
       a.run_id,
       a.task_id as task_key,
       count(*) as approval_count
     from approvals a
     group by a.run_id, a.task_id`
  );
  return result.rows.map((row) => {
    const r = row as unknown as ApprovalCountDb;
    return {
      run_id: r.run_id,
      task_key: r.task_key,
      approval_count: parseInt(r.approval_count, 10)
    };
  });
}

async function fetchRunsByIds(
  query: SqlClient["query"],
  runIds: readonly string[]
): Promise<RunRow[]> {
  if (runIds.length === 0) return [];
  // Parameterized query using ANY($1) to avoid IN-list injection.
  const result = await query(
    `select id, title, status, created_at from runs where id = any($1)`,
    [runIds]
  );
  return result.rows.map((row) => {
    const r = row as unknown as RunRowDb;
    return { id: r.id, title: r.title, status: r.status, created_at: r.created_at };
  });
}

// ---------------------------------------------------------------------------
// Path guard for --backup
// ---------------------------------------------------------------------------

/**
 * Validate and resolve a --backup override path.
 *
 * Security:
 *   - Must be absolute (rejects relative paths to avoid cwd-relative escapes).
 *   - Must be within repoRoot OR dataRoot (whichever is given).
 *   - Must end with .json.
 */
function resolveBackupPath(
  rawPath: string,
  dataRoot: string,
  repoRoot: string
): string {
  if (!path.isAbsolute(rawPath)) {
    throw new Error(
      `prune-orphans: --backup path must be absolute, got: "${rawPath}"`
    );
  }
  if (!rawPath.endsWith(".json")) {
    throw new Error(
      `prune-orphans: --backup path must end with .json, got: "${rawPath}"`
    );
  }
  // Normalize FIRST to collapse any `..` segments before the bounds check.
  // path.resolve collapses `../` lexically, which is correct for a
  // not-yet-existing backup target (no symlink resolution needed here —
  // we just need to prevent directory traversal via `..`).
  const resolved = path.resolve(rawPath);
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const sep = path.sep;

  const withinData =
    resolved === resolvedDataRoot || resolved.startsWith(`${resolvedDataRoot}${sep}`);
  const withinRepo =
    resolved === resolvedRepoRoot || resolved.startsWith(`${resolvedRepoRoot}${sep}`);

  if (!withinData && !withinRepo) {
    throw new Error(
      `prune-orphans: --backup path "${rawPath}" resolves to "${resolved}" which is ` +
        `outside both dataRoot ("${resolvedDataRoot}") and repoRoot ("${resolvedRepoRoot}"). ` +
        `Refusing to write outside these boundaries.`
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function parseFlag(args: readonly string[], flag: string): string | undefined {
  const prefixed = `--${flag}`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === prefixed) return args[i + 1];
    if (args[i]?.startsWith(`${prefixed}=`)) {
      return args[i]!.slice(prefixed.length + 1);
    }
  }
  return undefined;
}

/**
 * Main entry point for the `prune-orphans` admin verb.
 *
 * Dry-run by default. Pass `--confirm` to mutate.
 * On `--confirm`: write backup then delete in a single transaction.
 */
export async function pruneOrphansCommand(
  args: readonly string[],
  deps: PruneOrphansDeps
): Promise<void> {
  const confirm = args.includes("--confirm");
  const backupFlag = parseFlag(args, "backup");

  // 1. Fetch raw rows sequentially — a single pg.Client cannot handle
  //    concurrent queries on the same connection (DeprecationWarning in pg@8,
  //    broken in pg@9). Each await fully completes before the next starts.
  const tasks = await fetchAllTasks(deps.query);
  const reviewCounts = await fetchReviewCounts(deps.query);
  const approvalCounts = await fetchApprovalCounts(deps.query);

  // 2. Pure predicate.
  const plan = findOrphanCandidates(tasks, reviewCounts, approvalCounts);
  const { candidates, emptiedRunIds } = plan;

  // 3. Always print the plan.
  deps.writeLine(`prune-orphans: ${confirm ? "CONFIRM" : "DRY-RUN"}`);
  deps.writeLine(`  candidate tasks (${candidates.length}):`);

  if (candidates.length === 0) {
    deps.writeLine("    (none)");
  } else {
    for (const t of candidates) {
      deps.writeLine(`    task_key="${t.task_key}" run_id="${t.run_id}" status="${t.status}" id="${t.id}"`);
    }
  }

  deps.writeLine(`  runs that would be emptied (${emptiedRunIds.length}):`);
  if (emptiedRunIds.length === 0) {
    deps.writeLine("    (none)");
  } else {
    for (const runId of emptiedRunIds) {
      deps.writeLine(`    run_id="${runId}"`);
    }
  }

  if (!confirm) {
    deps.writeLine("  (dry-run — pass --confirm to mutate)");
    return;
  }

  if (candidates.length === 0) {
    deps.writeLine("  nothing to delete — exiting.");
    return;
  }

  // 4. Fetch full run rows for backup.
  const affectedRunIds = [...new Set([
    ...candidates.map((t) => t.run_id),
    ...emptiedRunIds
  ])];
  const affectedRuns = await fetchRunsByIds(deps.query, affectedRunIds);

  // 5. Write pre-delete JSON backup.
  const backupTimestamp = deps.now().replace(/[:.]/g, "-");
  const defaultBackupPath = path.join(
    deps.dataRoot,
    "prune-backups",
    `orphans-${backupTimestamp}.json`
  );
  const backupPath = backupFlag
    ? resolveBackupPath(backupFlag, deps.dataRoot, deps.repoRoot)
    : defaultBackupPath;

  const backupPayload = JSON.stringify(
    {
      generatedAt: deps.now(),
      candidateTasks: candidates,
      affectedRuns,
      emptiedRunIds
    },
    null,
    2
  );

  await deps.writeFile(backupPath, backupPayload);
  deps.writeLine(`  backup written to: ${backupPath}`);

  // 6. Delete in a single transaction: tasks first, then emptied runs.
  //    FK on task_dependencies.task_id ON DELETE CASCADE handles dependency edges.
  const candidateTaskIds = candidates.map((t) => t.id);

  await deps.withTransaction(async () => {
    // Delete candidate tasks by UUID primary key.
    await deps.query(
      `delete from tasks where id = any($1)`,
      [candidateTaskIds]
    );

    // Delete emptied runs by UUID primary key.
    if (emptiedRunIds.length > 0) {
      await deps.query(
        `delete from runs where id = any($1)`,
        [emptiedRunIds]
      );
    }
  });

  deps.writeLine(`  deleted ${candidateTaskIds.length} task row(s).`);
  deps.writeLine(`  deleted ${emptiedRunIds.length} run row(s).`);
  deps.writeLine("  done.");
}
