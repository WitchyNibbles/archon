/**
 * @module admin/sweep-orphans
 *
 * Sweep-orphans admin verb (closureLoop W4) — a one-time, reversible pass that
 * MARKS-CLOSED the historical `in_progress`/`ready` runtime tasks (and their
 * runs) whose work merged long ago but were never advanced to a terminal state.
 *
 * This is distinct from `prune-orphans`:
 *   - `prune-orphans` DELETES duplicate task rows that have a SEALED TWIN
 *     (clause c). The historical orphans are *twinless*, so prune-orphans
 *     excludes them by design.
 *   - `sweep-orphans` targets exactly those twinless orphans and MARKS them
 *     closed (status → `done` + a `sweptOrphan` payload stamp) rather than
 *     deleting them, so the action is fully reversible from the backup.
 *
 * Security contract (class: security_sensitive), per the closureLoop council:
 *   - DRY-RUN BY DEFAULT. Zero mutation unless `--confirm` is passed.
 *   - BACKUP-FIRST. `--confirm` writes a pre-mutation JSON backup (original
 *     statuses captured for rollback) and REFUSES if the backup path is not
 *     writable inside dataRoot/repoRoot.
 *   - MANDATORY OPERATOR REVIEW. The dry-run candidate list must be reviewed by
 *     an operator before `--confirm`; the predicate is a heuristic, not a
 *     safety guarantee.
 *   - DB-INTERNAL PREDICATE ONLY. Candidacy is decided from runtime DB signals
 *     (status, reviews, approvals, run age, active run, scope locks, claims) —
 *     NEVER from agent-written "merged" metadata.
 *   - HARD SAFETY RAILS that even `--allow-list` cannot override: never the
 *     active run, never an `approved`/`done`/`blocked` task, never a task with a
 *     recorded approval.
 *   - BOUNDED SCAN. The initial task scan is capped (`--max-scan`, default 1000)
 *     and refuses to proceed past the cap rather than silently truncating.
 *   - Parameterized queries only. Mutations run in a single transaction.
 *
 * Rollback: restore each backed-up task/run `status` from the JSON backup. See
 * docs/handoff-operator-runbook.md §"Historical orphan sweep (W4)".
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweepTaskRow {
  /** UUID primary key of the tasks table row. */
  id: string;
  run_id: string;
  task_key: string;
  status: string;
  /** Agent currently holding the task, or null. */
  claimed_by: string | null;
}

export interface SweepRunRow {
  id: string;
  status: string;
  /** ISO-8601 timestamp string (normalized at fetch time). */
  created_at: string;
}

export interface SweepLockRow {
  run_id: string;
  /** locks.task_id stores the task_key (text). */
  task_id: string;
  status: string;
}

export interface SweepReviewCount {
  run_id: string;
  task_key: string;
  /** Count of DISTINCT passed-review roles. */
  distinct_passed_roles: number;
}

export interface SweepApprovalCount {
  run_id: string;
  task_key: string;
  approval_count: number;
}

export interface SweepOptions {
  /** The current active run — NEVER swept (hard rail). */
  activeRunId: string | undefined;
  /** A run is sweepable under the heuristic only when created_at < this ISO. */
  cutoffIso: string;
  /** task_keys (or task ids) the operator explicitly allows past the heuristic. */
  allowList: ReadonlySet<string>;
}

export interface SweepPlan {
  /** Tasks to mark closed (status → done). */
  candidates: readonly SweepTaskRow[];
  /** Runs whose every task is swept or already terminal — sealed to done. */
  sealableRunIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Pure predicate — no IO, fully unit-testable
// ---------------------------------------------------------------------------

const CANDIDATE_STATUSES = new Set(["in_progress", "ready"]);
const TERMINAL_STATUSES = new Set(["done", "approved"]);

/**
 * Compute the sweep plan from raw DB rows. PURE: no IO, deterministic.
 *
 * Hard exclusions (NEVER overridable, even by allowList):
 *   - status not in {in_progress, ready}
 *   - run_id === activeRunId
 *   - the task has ≥1 recorded approval
 *
 * Heuristic exclusions (overridable by allowList):
 *   - the task has ≥1 distinct passed-review role
 *   - the run is missing or newer than the cutoff
 *   - an active scope lock exists for (run_id, task_key)
 *   - the task is currently claimed
 */
export function findSweepableOrphans(
  tasks: readonly SweepTaskRow[],
  runs: readonly SweepRunRow[],
  reviewCounts: readonly SweepReviewCount[],
  approvalCounts: readonly SweepApprovalCount[],
  locks: readonly SweepLockRow[],
  opts: SweepOptions
): SweepPlan {
  const reviewMap = new Map<string, number>();
  for (const rc of reviewCounts) {
    reviewMap.set(`${rc.run_id}:${rc.task_key}`, rc.distinct_passed_roles);
  }
  const approvalMap = new Map<string, number>();
  for (const ac of approvalCounts) {
    approvalMap.set(`${ac.run_id}:${ac.task_key}`, ac.approval_count);
  }
  const runMap = new Map<string, SweepRunRow>();
  for (const run of runs) {
    runMap.set(run.id, run);
  }
  const activeLockKeys = new Set<string>();
  for (const lock of locks) {
    if (lock.status === "active") {
      activeLockKeys.add(`${lock.run_id}:${lock.task_id}`);
    }
  }

  const candidates: SweepTaskRow[] = [];
  for (const task of tasks) {
    const key = `${task.run_id}:${task.task_key}`;

    // Hard rails.
    if (!CANDIDATE_STATUSES.has(task.status)) continue;
    if (opts.activeRunId !== undefined && task.run_id === opts.activeRunId) continue;
    if ((approvalMap.get(key) ?? 0) > 0) continue;

    const onAllowList = opts.allowList.has(task.task_key) || opts.allowList.has(task.id);
    if (!onAllowList) {
      if ((reviewMap.get(key) ?? 0) > 0) continue;
      const run = runMap.get(task.run_id);
      if (!run) continue;
      if (!(run.created_at < opts.cutoffIso)) continue;
      // The in-use signal is an ACTIVE scope lock (locks table), per the council
      // predicate. `claimed_by` is NOT a rail: manager-created control-write tasks
      // are permanently `claimed_by = "manager"`, so gating on it would exclude
      // exactly the historical orphans this sweep targets. It is surfaced in the
      // candidate output for operator review instead.
      if (activeLockKeys.has(key)) continue;
    }

    candidates.push(task);
  }

  // A run with ≥1 candidate is sealable when every surviving task is terminal.
  const candidateIds = new Set(candidates.map((c) => c.id));
  const tasksByRun = new Map<string, SweepTaskRow[]>();
  for (const task of tasks) {
    const existing = tasksByRun.get(task.run_id);
    if (existing) existing.push(task);
    else tasksByRun.set(task.run_id, [task]);
  }

  const sealableRunIds: string[] = [];
  const seenRuns = new Set<string>();
  for (const candidate of candidates) {
    const runId = candidate.run_id;
    if (seenRuns.has(runId)) continue;
    seenRuns.add(runId);
    if (opts.activeRunId !== undefined && runId === opts.activeRunId) continue;
    const runTasks = tasksByRun.get(runId) ?? [];
    const survivors = runTasks.filter((t) => !candidateIds.has(t.id));
    if (survivors.every((t) => TERMINAL_STATUSES.has(t.status))) {
      sealableRunIds.push(runId);
    }
  }

  return { candidates, sealableRunIds };
}

// ---------------------------------------------------------------------------
// SqlClient / deps
// ---------------------------------------------------------------------------

export interface SqlQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface SweepOrphansDeps {
  query: (text: string, values?: readonly unknown[]) => Promise<SqlQueryResult>;
  withTransaction: <T>(work: () => Promise<T>) => Promise<T>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  now: () => string;
  writeLine: (line: string) => void;
  dataRoot: string;
  repoRoot: string;
  /** Project id used to resolve the active run. Optional for unit tests. */
  projectId?: string;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}

async function fetchActiveRunId(
  query: SweepOrphansDeps["query"],
  projectId: string | undefined
): Promise<string | undefined> {
  const result = await query(
    `select active_run_id from project_runtime_state where project_id = $1 limit 1`,
    [projectId ?? null]
  );
  const raw = result.rows[0]?.active_run_id;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Fetch candidate-status tasks, capped. Returns up to maxScan+1 rows so the
 * caller can detect (and refuse) an over-cap scan.
 */
async function fetchCandidateStatusTasks(
  query: SweepOrphansDeps["query"],
  maxScan: number
): Promise<SweepTaskRow[]> {
  const result = await query(
    `select id, run_id, task_key, status, claimed_by
       from tasks
      where status in ('in_progress', 'ready')
      order by created_at asc
      limit $1`,
    [maxScan + 1]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    run_id: String(row.run_id),
    task_key: String(row.task_key),
    status: String(row.status),
    claimed_by: row.claimed_by == null ? null : String(row.claimed_by)
  }));
}

async function fetchAllTasksForRuns(
  query: SweepOrphansDeps["query"],
  runIds: readonly string[]
): Promise<SweepTaskRow[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select id, run_id, task_key, status, claimed_by from tasks where run_id = any($1)`,
    [runIds]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    run_id: String(row.run_id),
    task_key: String(row.task_key),
    status: String(row.status),
    claimed_by: row.claimed_by == null ? null : String(row.claimed_by)
  }));
}

async function fetchReviewCounts(
  query: SweepOrphansDeps["query"],
  runIds: readonly string[]
): Promise<SweepReviewCount[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select r.run_id, r.task_id as task_key, count(distinct r.reviewer_role) as distinct_passed_roles
       from reviews r
      where r.state = 'passed' and r.run_id = any($1)
      group by r.run_id, r.task_id`,
    [runIds]
  );
  return result.rows.map((row) => ({
    run_id: String(row.run_id),
    task_key: String(row.task_key),
    distinct_passed_roles: toCount(row.distinct_passed_roles)
  }));
}

async function fetchApprovalCounts(
  query: SweepOrphansDeps["query"],
  runIds: readonly string[]
): Promise<SweepApprovalCount[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select a.run_id, a.task_id as task_key, count(*) as approval_count
       from approvals a
      where a.run_id = any($1)
      group by a.run_id, a.task_id`,
    [runIds]
  );
  return result.rows.map((row) => ({
    run_id: String(row.run_id),
    task_key: String(row.task_key),
    approval_count: toCount(row.approval_count)
  }));
}

async function fetchActiveLocks(
  query: SweepOrphansDeps["query"],
  runIds: readonly string[]
): Promise<SweepLockRow[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select run_id, task_id, status from locks where status = 'active' and run_id = any($1)`,
    [runIds]
  );
  return result.rows.map((row) => ({
    run_id: String(row.run_id),
    task_id: String(row.task_id),
    status: String(row.status)
  }));
}

async function fetchRunsByIds(
  query: SweepOrphansDeps["query"],
  runIds: readonly string[]
): Promise<SweepRunRow[]> {
  if (runIds.length === 0) return [];
  const result = await query(
    `select id, status, created_at from runs where id = any($1)`,
    [runIds]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    status: String(row.status),
    created_at: toIso(row.created_at)
  }));
}

// ---------------------------------------------------------------------------
// Arg parsing + backup path guard
// ---------------------------------------------------------------------------

function parseFlag(args: readonly string[], flag: string): string | undefined {
  const prefixed = `--${flag}`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === prefixed) return args[i + 1];
    if (args[i]?.startsWith(`${prefixed}=`)) return args[i]!.slice(prefixed.length + 1);
  }
  return undefined;
}

function parseAllowList(args: readonly string[]): Set<string> {
  const raw = parseFlag(args, "allow-list");
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/** Validate/resolve a --backup override path (absolute, .json, inside dataRoot/repoRoot). */
function resolveBackupPath(rawPath: string, dataRoot: string, repoRoot: string): string {
  if (!path.isAbsolute(rawPath)) {
    throw new Error(`sweep-orphans: --backup path must be absolute, got: "${rawPath}"`);
  }
  if (!rawPath.endsWith(".json")) {
    throw new Error(`sweep-orphans: --backup path must end with .json, got: "${rawPath}"`);
  }
  const resolved = path.resolve(rawPath);
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const sep = path.sep;
  const withinData = resolved === resolvedDataRoot || resolved.startsWith(`${resolvedDataRoot}${sep}`);
  const withinRepo = resolved === resolvedRepoRoot || resolved.startsWith(`${resolvedRepoRoot}${sep}`);
  if (!withinData && !withinRepo) {
    throw new Error(
      `sweep-orphans: --backup path "${rawPath}" resolves to "${resolved}" which is outside both ` +
        `dataRoot ("${resolvedDataRoot}") and repoRoot ("${resolvedRepoRoot}"). Refusing to write outside these boundaries.`
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SCAN = 1000;
const DEFAULT_OLDER_THAN_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Main entry point for the `sweep-orphans` admin verb.
 *
 * Dry-run by default. `--confirm` writes a backup then marks candidate tasks
 * closed and seals fully-terminal runs, all in a single transaction.
 *
 * Flags:
 *   --confirm                mutate (default: dry-run)
 *   --older-than-days <N>    run-age cutoff for the heuristic (default 14)
 *   --allow-list <a,b,c>     task_keys/ids to allow past the heuristic
 *   --max-scan <N>           cap on the initial task scan (default 1000)
 *   --backup <abs-path>      override the backup path (guarded, must be .json)
 */
export async function sweepOrphansCommand(args: readonly string[], deps: SweepOrphansDeps): Promise<void> {
  const confirm = args.includes("--confirm");
  const backupFlag = parseFlag(args, "backup");
  const allowList = parseAllowList(args);

  const maxScanRaw = parseFlag(args, "max-scan");
  const maxScan = maxScanRaw !== undefined ? parseInt(maxScanRaw, 10) : DEFAULT_MAX_SCAN;
  if (!Number.isFinite(maxScan) || maxScan <= 0) {
    throw new Error(`sweep-orphans: --max-scan must be a positive integer, got: "${maxScanRaw}"`);
  }

  const olderRaw = parseFlag(args, "older-than-days");
  const olderThanDays = olderRaw !== undefined ? parseInt(olderRaw, 10) : DEFAULT_OLDER_THAN_DAYS;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error(`sweep-orphans: --older-than-days must be a non-negative integer, got: "${olderRaw}"`);
  }
  const cutoffIso = new Date(new Date(deps.now()).getTime() - olderThanDays * MS_PER_DAY).toISOString();

  // 1. Resolve the active run (hard rail) and the capped candidate scan.
  const activeRunId = await fetchActiveRunId(deps.query, deps.projectId);
  const scanned = await fetchCandidateStatusTasks(deps.query, maxScan);
  if (scanned.length > maxScan) {
    throw new Error(
      `sweep-orphans: candidate scan exceeded --max-scan cap (${maxScan}). ` +
        `Narrow the field (run prune-orphans first) or raise --max-scan deliberately. Refusing to proceed.`
    );
  }

  const affectedRunIds = [...new Set(scanned.map((t) => t.run_id))];

  // 2. Fetch the full context for the affected runs.
  const allTasks = await fetchAllTasksForRuns(deps.query, affectedRunIds);
  const reviewCounts = await fetchReviewCounts(deps.query, affectedRunIds);
  const approvalCounts = await fetchApprovalCounts(deps.query, affectedRunIds);
  const locks = await fetchActiveLocks(deps.query, affectedRunIds);
  const runs = await fetchRunsByIds(deps.query, affectedRunIds);

  // 3. Pure predicate. `allTasks` is the full task set of every affected run
  //    (a superset of the candidate-status `scanned` rows), so run-sealing sees
  //    every surviving task. We pass it directly — never fall back to `scanned`,
  //    which would omit terminal survivors and vacuously over-seal runs.
  const { candidates, sealableRunIds } = findSweepableOrphans(
    allTasks,
    runs,
    reviewCounts,
    approvalCounts,
    locks,
    { activeRunId, cutoffIso, allowList }
  );

  // 4. Print the plan.
  deps.writeLine(`sweep-orphans: ${confirm ? "CONFIRM" : "DRY-RUN"}`);
  deps.writeLine(`  cutoff: runs created before ${cutoffIso} (--older-than-days ${olderThanDays})`);
  deps.writeLine(`  active run (never swept): ${activeRunId ?? "(none resolved)"}`);
  if (allowList.size > 0) {
    deps.writeLine(`  allow-list (override heuristic): ${[...allowList].join(", ")}`);
  }
  deps.writeLine(`  candidate tasks to mark closed (${candidates.length}):`);
  if (candidates.length === 0) {
    deps.writeLine("    (none)");
  } else {
    for (const t of candidates) {
      deps.writeLine(
        `    task_key="${t.task_key}" run_id="${t.run_id}" status="${t.status}" claimed_by="${t.claimed_by ?? "(none)"}" id="${t.id}"`
      );
    }
  }
  deps.writeLine(`  runs to seal (${sealableRunIds.length}):`);
  for (const runId of sealableRunIds) {
    deps.writeLine(`    run_id="${runId}"`);
  }

  if (!confirm) {
    deps.writeLine("  (dry-run — review the candidate list, then re-run with --confirm to mutate)");
    return;
  }

  if (candidates.length === 0) {
    deps.writeLine("  nothing to sweep — exiting.");
    return;
  }

  // 5. Resolve + guard the backup path BEFORE any mutation.
  const backupTimestamp = deps.now().replace(/[:.]/g, "-");
  const defaultBackupPath = path.join(deps.dataRoot, "sweep-backups", `orphans-${backupTimestamp}.json`);
  const backupPath = backupFlag ? resolveBackupPath(backupFlag, deps.dataRoot, deps.repoRoot) : defaultBackupPath;

  const backupPayload = JSON.stringify(
    {
      generatedAt: deps.now(),
      cutoffIso,
      activeRunId: activeRunId ?? null,
      olderThanDays,
      allowList: [...allowList],
      candidateTasks: candidates,
      sealableRunIds,
      affectedRuns: runs.filter((r) => sealableRunIds.includes(r.id))
    },
    null,
    2
  );
  await deps.writeFile(backupPath, backupPayload);
  deps.writeLine(`  backup written to: ${backupPath}`);

  // 6. Mark closed + seal in a single transaction.
  const candidateTaskIds = candidates.map((t) => t.id);
  const provenance = JSON.stringify({ sweptOrphan: true, sweptAt: deps.now() });

  await deps.withTransaction(async () => {
    await deps.query(
      `update tasks set status = 'done', payload = payload || $2::jsonb, updated_at = now() where id = any($1)`,
      [candidateTaskIds, provenance]
    );
    if (sealableRunIds.length > 0) {
      await deps.query(
        `update runs set status = 'done', updated_at = now() where id = any($1)`,
        [sealableRunIds]
      );
    }
  });

  deps.writeLine(`  marked ${candidateTaskIds.length} task(s) closed (status → done, sweptOrphan stamp).`);
  deps.writeLine(`  sealed ${sealableRunIds.length} run(s).`);
  deps.writeLine("  done. (rollback: restore status from the backup — see handoff-operator-runbook.md)");
}
