/**
 * @module admin/sweep-orphans
 *
 * Sweep-orphans admin verb — reversible close of historical twinless orphan
 * tasks whose work merged long ago but are stuck in_progress/ready because
 * prune-orphans requires a sealed twin (≥3 reviews + approval under a
 * different run_id) and these tasks have none.
 *
 * Security contract (class: security_sensitive):
 *   - DRY-RUN BY DEFAULT.  Zero mutation unless `--confirm` is passed.
 *   - Before any mutation, write a pre-sweep JSON backup.
 *   - Mutations (UPDATE tasks + UPDATE runs) happen in a single transaction.
 *   - MARK-CLOSED only: sets status='done'. Never DELETE rows.
 *   - Parameterized queries only — never string-interpolated SQL.
 *   - The predicate (findSweepCandidates) is PURE and unit-tested in isolation.
 *   - Candidate scan is BOUNDED by SCAN_ROW_CAP to prevent runaway reads.
 *
 * Candidate predicate (DB-internal signals only):
 *   status IN ('in_progress','ready')
 *   AND 0 reviews (any state) for (run_id, task_key)
 *   AND 0 approvals (any decision) for (run_id, task_key)
 *   AND run.created_at < cutoff  (default: now - 14 days; --older-than <days>)
 *   AND run_id != project_runtime_state.active_run_id
 *   AND no active lock row for (run_id, task_key)
 *   [AND run_id IN allow_list]   (optional: --allow-list <id,id,...>)
 *
 * Backup path: <dataRoot>/sweep-backups/sweep-<ISO>.json
 * Override with --backup <absolute-path> (repo/dataRoot-guarded).
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum rows the status-filtered task scan will return. */
export const SCAN_ROW_CAP = 500;

/** Default cutoff in days (runs older than this are sweep candidates). */
export const DEFAULT_OLDER_THAN_DAYS = 14;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweepTaskRow {
  id: string;       // UUID (tasks.id PK)
  run_id: string;   // UUID
  task_key: string;
  status: string;
}

export interface SweepRunRow {
  id: string;
  title: string;
  status: string;
  created_at: string; // ISO timestamp string
}

export interface ReviewCount {
  run_id: string;
  task_key: string;
  review_count: number;
}

export interface ApprovalCount {
  run_id: string;
  task_key: string;
  approval_count: number;
}

export interface SweepCandidateRow {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
  run_created_at: string;
  run_age_days: number;
}

export interface SweepPlan {
  candidates: readonly SweepCandidateRow[];
}

// ---------------------------------------------------------------------------
// Pure predicates — no IO, fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Compute the sweep plan given raw DB rows.
 *
 * PURE: no IO, no side effects, deterministic output.
 *
 * Safety invariants enforced here:
 *   - Only selects in_progress or ready rows.
 *   - Never selects the active run.
 *   - Never selects rows with any review or approval record.
 *   - Never selects rows with an active lock.
 *   - Never selects runs newer than the cutoff.
 *   - When allowList is provided, restricts to those run_ids (AND with predicate).
 */
export function findSweepCandidates(
  tasks: readonly SweepTaskRow[],
  runs: readonly SweepRunRow[],
  reviewCounts: readonly ReviewCount[],
  approvalCounts: readonly ApprovalCount[],
  activeLockKeys: ReadonlySet<string>, // "run_id:task_key" composite keys
  activeRunId: string | null,
  cutoff: Date,
  nowDate: Date,
  allowList: ReadonlySet<string> | null // set of run_ids; null = no filter
): SweepPlan {
  const runMap = new Map<string, SweepRunRow>();
  for (const run of runs) {
    runMap.set(run.id, run);
  }

  const reviewMap = new Map<string, number>();
  for (const rc of reviewCounts) {
    reviewMap.set(`${rc.run_id}:${rc.task_key}`, rc.review_count);
  }

  const approvalMap = new Map<string, number>();
  for (const ac of approvalCounts) {
    approvalMap.set(`${ac.run_id}:${ac.task_key}`, ac.approval_count);
  }

  const CANDIDATE_STATUSES = new Set(["in_progress", "ready"]);
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const candidates: SweepCandidateRow[] = [];

  for (const task of tasks) {
    const compositeKey = `${task.run_id}:${task.task_key}`;

    // (1) Status must be in_progress or ready.
    if (!CANDIDATE_STATUSES.has(task.status)) continue;

    // (2) Must not be the active run.
    if (activeRunId !== null && task.run_id === activeRunId) continue;

    // (3) Allow-list filter (intersected with safety predicate).
    if (allowList !== null && !allowList.has(task.run_id)) continue;

    // (4) Zero reviews (any state).
    const reviewCount = reviewMap.get(compositeKey) ?? 0;
    if (reviewCount > 0) continue;

    // (5) Zero approvals (any decision).
    const approvalCount = approvalMap.get(compositeKey) ?? 0;
    if (approvalCount > 0) continue;

    // (6) No active lock.
    if (activeLockKeys.has(compositeKey)) continue;

    // (7) Run must be older than the cutoff.
    const run = runMap.get(task.run_id);
    if (run === undefined) continue; // defensive: missing run row → skip
    const runCreatedAt = new Date(run.created_at);
    if (runCreatedAt >= cutoff) continue;

    const runAgeDays = Math.floor(
      (nowDate.getTime() - runCreatedAt.getTime()) / MS_PER_DAY
    );

    candidates.push({
      id: task.id,
      run_id: task.run_id,
      task_key: task.task_key,
      status: task.status,
      run_created_at: run.created_at,
      run_age_days: runAgeDays
    });
  }

  return { candidates };
}

/**
 * Compute which run_ids would become fully swept after marking candidates done.
 * A run is swept IFF all of its tasks are either in `candidates` or already 'done'.
 *
 * PURE: no IO, no side effects.
 */
export function computeSweptRunIds(
  candidates: readonly SweepCandidateRow[],
  allRunTasks: readonly SweepTaskRow[]
): readonly string[] {
  if (candidates.length === 0) return [];

  const candidateIds = new Set(candidates.map((c) => c.id));
  const candidateRunIds = new Set(candidates.map((c) => c.run_id));

  const tasksByRun = new Map<string, SweepTaskRow[]>();
  for (const task of allRunTasks) {
    const existing = tasksByRun.get(task.run_id);
    if (existing !== undefined) {
      existing.push(task);
    } else {
      tasksByRun.set(task.run_id, [task]);
    }
  }

  const sweptRunIds: string[] = [];
  for (const runId of candidateRunIds) {
    const runTasks = tasksByRun.get(runId) ?? [];
    const allSwept = runTasks.every(
      (t) => candidateIds.has(t.id) || t.status === "done"
    );
    if (allSwept) {
      sweptRunIds.push(runId);
    }
  }

  return sweptRunIds;
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

export interface SweepOrphansDeps {
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
  /** Absolute path to the data root. Used to compute the default backup path. */
  dataRoot: string;
  /** Repo root used for path-traversal guard on --backup. Must be absolute. */
  repoRoot: string;
}

// ---------------------------------------------------------------------------
// DB query helpers (sequential — pg.Client cannot run concurrent queries)
// ---------------------------------------------------------------------------

interface TaskRowDb {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
}

interface RunRowDb {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

interface ReviewCountDb {
  run_id: string;
  task_key: string;
  review_count: string; // Postgres returns bigint as string
}

interface ApprovalCountDb {
  run_id: string;
  task_key: string;
  approval_count: string;
}

interface LockRowDb {
  run_id: string;
  task_key: string;
}

interface RuntimeStateDb {
  project_id: string;
  active_run_id: string | null;
}

async function fetchRuntimeState(
  query: SqlClient["query"]
): Promise<{ projectId: string | null; activeRunId: string | null }> {
  const result = await query(
    `select project_id, active_run_id from project_runtime_state limit 1`
  );
  if (result.rows.length === 0) {
    return { projectId: null, activeRunId: null };
  }
  const row = result.rows[0] as unknown as RuntimeStateDb;
  return { projectId: row.project_id, activeRunId: row.active_run_id };
}

async function fetchCandidateTasks(
  query: SqlClient["query"],
  projectId: string | null,
  allowListIds: readonly string[] | null,
  cap: number
): Promise<SweepTaskRow[]> {
  const conditions: string[] = [`t.status in ('in_progress', 'ready')`];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (projectId !== null) {
    conditions.push(`t.project_id = $${paramIdx}`);
    values.push(projectId);
    paramIdx += 1;
  }
  if (allowListIds !== null && allowListIds.length > 0) {
    conditions.push(`t.run_id = any($${paramIdx})`);
    values.push(allowListIds);
    paramIdx += 1;
  }

  values.push(cap + 1);
  const sql = [
    `select t.id, t.run_id, t.task_key, t.status`,
    `from tasks t`,
    `where ${conditions.join(" and ")}`,
    `order by t.created_at asc`,
    `limit $${paramIdx}`
  ].join(" ");

  const result = await query(sql, values);

  if (result.rows.length > cap) {
    throw new Error(
      `sweep-orphans: candidate scan found more than ${cap} rows. ` +
        `Narrow the scope with --allow-list <run-ids>.`
    );
  }

  return result.rows.map((row) => {
    const r = row as unknown as TaskRowDb;
    return { id: r.id, run_id: r.run_id, task_key: r.task_key, status: r.status };
  });
}

async function fetchRunsForIds(
  query: SqlClient["query"],
  runIds: readonly string[]
): Promise<SweepRunRow[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select id, title, status, created_at from runs where id = any($1)`,
    [runIds]
  );
  return result.rows.map((row) => {
    const r = row as unknown as RunRowDb;
    return { id: r.id, title: r.title, status: r.status, created_at: r.created_at };
  });
}

async function fetchReviewCounts(
  query: SqlClient["query"],
  runIds: readonly string[]
): Promise<ReviewCount[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select r.run_id, r.task_id as task_key, count(*) as review_count
     from reviews r
     where r.run_id = any($1)
     group by r.run_id, r.task_id`,
    [runIds]
  );
  return result.rows.map((row) => {
    const r = row as unknown as ReviewCountDb;
    return {
      run_id: r.run_id,
      task_key: r.task_key,
      review_count: parseInt(r.review_count, 10)
    };
  });
}

async function fetchApprovalCounts(
  query: SqlClient["query"],
  runIds: readonly string[]
): Promise<ApprovalCount[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select a.run_id, a.task_id as task_key, count(*) as approval_count
     from approvals a
     where a.run_id = any($1)
     group by a.run_id, a.task_id`,
    [runIds]
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

async function fetchActiveLockKeys(
  query: SqlClient["query"],
  runIds: readonly string[]
): Promise<ReadonlySet<string>> {
  if (runIds.length === 0) return new Set();
  const result = await query(
    `select run_id, task_id as task_key from locks
     where run_id = any($1) and status = 'active'`,
    [runIds]
  );
  const keys = new Set<string>();
  for (const row of result.rows) {
    const r = row as unknown as LockRowDb;
    keys.add(`${r.run_id}:${r.task_key}`);
  }
  return keys;
}

async function fetchAllTasksForRuns(
  query: SqlClient["query"],
  runIds: readonly string[]
): Promise<SweepTaskRow[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select id, run_id, task_key, status from tasks where run_id = any($1)`,
    [runIds]
  );
  return result.rows.map((row) => {
    const r = row as unknown as TaskRowDb;
    return { id: r.id, run_id: r.run_id, task_key: r.task_key, status: r.status };
  });
}

// ---------------------------------------------------------------------------
// Path guard for --backup (mirrors prune-orphans)
// ---------------------------------------------------------------------------

function resolveBackupPath(
  rawPath: string,
  dataRoot: string,
  repoRoot: string
): string {
  if (!path.isAbsolute(rawPath)) {
    throw new Error(
      `sweep-orphans: --backup path must be absolute, got: "${rawPath}"`
    );
  }
  if (!rawPath.endsWith(".json")) {
    throw new Error(
      `sweep-orphans: --backup path must end with .json, got: "${rawPath}"`
    );
  }
  const resolved = path.resolve(rawPath);
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const sep = path.sep;

  const withinData =
    resolved === resolvedDataRoot ||
    resolved.startsWith(`${resolvedDataRoot}${sep}`);
  const withinRepo =
    resolved === resolvedRepoRoot ||
    resolved.startsWith(`${resolvedRepoRoot}${sep}`);

  if (!withinData && !withinRepo) {
    throw new Error(
      `sweep-orphans: --backup path "${rawPath}" resolves to "${resolved}" which is ` +
        `outside both dataRoot ("${resolvedDataRoot}") and repoRoot ("${resolvedRepoRoot}"). ` +
        `Refusing to write outside these boundaries.`
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Argument parsers
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

function parseOlderThan(args: readonly string[]): number {
  const raw = parseFlag(args, "older-than");
  if (raw === undefined) return DEFAULT_OLDER_THAN_DAYS;
  const days = parseInt(raw, 10);
  if (!Number.isInteger(days) || days <= 0 || String(days) !== raw.trim()) {
    throw new Error(
      `sweep-orphans: --older-than must be a positive integer, got: "${raw}"`
    );
  }
  return days;
}

const ALLOW_LIST_ID_RE = /^[A-Za-z0-9_-]+$/;

function parseAllowList(args: readonly string[]): ReadonlySet<string> | null {
  const raw = parseFlag(args, "allow-list");
  if (raw === undefined || raw.trim() === "") return null;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) return null;
  for (const id of ids) {
    if (!ALLOW_LIST_ID_RE.test(id)) {
      throw new Error(
        `sweep-orphans: invalid --allow-list id "${id}" — must match ^[A-Za-z0-9_-]+$`
      );
    }
  }
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Main entry point for the `sweep-orphans` admin verb.
 *
 * Dry-run by default. Pass `--confirm` to mutate.
 * On `--confirm`: write backup, then mark candidates done in a single transaction.
 */
export async function sweepOrphansCommand(
  args: readonly string[],
  deps: SweepOrphansDeps
): Promise<void> {
  const confirm = args.includes("--confirm");
  const backupFlag = parseFlag(args, "backup");

  // 1. Validate and parse flags (fail fast before any DB queries).
  const olderThanDays = parseOlderThan(args);
  const allowList = parseAllowList(args);

  const nowDate = new Date(deps.now());
  const cutoff = new Date(
    nowDate.getTime() - olderThanDays * 24 * 60 * 60 * 1000
  );

  // 2. Fetch active project and run (sequential — pg.Client constraint).
  const { projectId, activeRunId } = await fetchRuntimeState(deps.query);

  // 3. Fetch status-filtered candidate tasks (bounded).
  const allowListIds = allowList !== null ? [...allowList] : null;
  const preFilterTasks = await fetchCandidateTasks(
    deps.query,
    projectId,
    allowListIds,
    SCAN_ROW_CAP
  );

  if (preFilterTasks.length === 0) {
    deps.writeLine(
      `sweep-orphans: ${confirm ? "CONFIRM" : "DRY-RUN"} (--older-than ${olderThanDays}d)`
    );
    deps.writeLine("  candidate tasks (0):    (none)");
    if (!confirm) {
      deps.writeLine("  (dry-run — pass --confirm to mutate)");
    } else {
      deps.writeLine("  nothing to sweep — exiting.");
    }
    return;
  }

  const preFilterRunIds = [...new Set(preFilterTasks.map((t) => t.run_id))];

  // 4. Fetch supporting data (sequential).
  const runs = await fetchRunsForIds(deps.query, preFilterRunIds);
  const reviewCounts = await fetchReviewCounts(deps.query, preFilterRunIds);
  const approvalCounts = await fetchApprovalCounts(deps.query, preFilterRunIds);
  const activeLockKeys = await fetchActiveLockKeys(deps.query, preFilterRunIds);

  // 5. Apply pure predicate.
  const { candidates } = findSweepCandidates(
    preFilterTasks,
    runs,
    reviewCounts,
    approvalCounts,
    activeLockKeys,
    activeRunId,
    cutoff,
    nowDate,
    allowList
  );

  // 6. Compute which runs become fully swept.
  let sweptRunIds: readonly string[] = [];
  if (candidates.length > 0) {
    const candidateRunIds = [...new Set(candidates.map((c) => c.run_id))];
    const allRunTasks = await fetchAllTasksForRuns(
      deps.query,
      candidateRunIds
    );
    sweptRunIds = computeSweptRunIds(candidates, allRunTasks);
  }

  // 7. Always print the plan.
  deps.writeLine(
    `sweep-orphans: ${confirm ? "CONFIRM" : "DRY-RUN"} ` +
      `(--older-than ${olderThanDays}d, cutoff=${cutoff.toISOString().slice(0, 10)})`
  );
  deps.writeLine(`  active_run_id: ${activeRunId ?? "(none)"}`);
  deps.writeLine(`  candidate tasks (${candidates.length}):`);

  if (candidates.length === 0) {
    deps.writeLine("    (none)");
  } else {
    for (const c of candidates) {
      deps.writeLine(
        `    task_key="${c.task_key}" run_id="${c.run_id}" ` +
          `status="${c.status}" run_age=${c.run_age_days}d`
      );
    }
  }

  deps.writeLine(`  runs that would be marked done (${sweptRunIds.length}):`);
  if (sweptRunIds.length === 0) {
    deps.writeLine("    (none)");
  } else {
    for (const runId of sweptRunIds) {
      deps.writeLine(`    run_id="${runId}"`);
    }
  }

  if (!confirm) {
    deps.writeLine("  (dry-run — pass --confirm to mutate)");
    return;
  }

  if (candidates.length === 0) {
    deps.writeLine("  nothing to sweep — exiting.");
    return;
  }

  // 8. Resolve backup path.
  const backupTimestamp = deps.now().replace(/[:.]/g, "-");
  const defaultBackupPath = path.join(
    deps.dataRoot,
    "sweep-backups",
    `sweep-${backupTimestamp}.json`
  );
  const backupPath = backupFlag
    ? resolveBackupPath(backupFlag, deps.dataRoot, deps.repoRoot)
    : defaultBackupPath;

  // 9. Write pre-sweep backup (MUST succeed before any mutation).
  const candidateRunIds = [...new Set(candidates.map((c) => c.run_id))];
  const backupPayload = JSON.stringify(
    {
      generatedAt: deps.now(),
      command: "sweep-orphans",
      olderThanDays,
      cutoffDate: cutoff.toISOString(),
      activeRunId,
      candidateTasks: candidates,
      affectedRuns: runs.filter((r) => candidateRunIds.includes(r.id)),
      sweptRunIds
    },
    null,
    2
  );

  await deps.writeFile(backupPath, backupPayload);
  deps.writeLine(`  backup written to: ${backupPath}`);

  // 10. Mark closed in a single transaction.
  const candidateTaskIds = candidates.map((c) => c.id);

  await deps.withTransaction(async () => {
    await deps.query(
      `update tasks set status = 'done', updated_at = now() where id = any($1)`,
      [candidateTaskIds]
    );
    if (sweptRunIds.length > 0) {
      await deps.query(
        `update runs set status = 'done', updated_at = now() where id = any($1)`,
        [[...sweptRunIds]]
      );
    }
  });

  deps.writeLine(`  marked ${candidateTaskIds.length} task(s) done.`);
  deps.writeLine(`  marked ${sweptRunIds.length} run(s) done.`);
  deps.writeLine("  done.");
}
