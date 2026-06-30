import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findSweepableOrphans,
  sweepOrphansCommand,
  type SweepTaskRow,
  type SweepRunRow,
  type SweepLockRow,
  type SweepReviewCount,
  type SweepApprovalCount,
  type SweepOrphansDeps
} from "../src/admin/sweep-orphans.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_RUN = "11111111-1111-1111-1111-111111111111";
const OLD_RUN = "22222222-2222-2222-2222-222222222222";
const OLD_RUN_2 = "33333333-3333-3333-3333-333333333333";
const RECENT_RUN = "44444444-4444-4444-4444-444444444444";

// cutoff = 2026-06-16; OLD runs predate it, RECENT does not.
const CUTOFF_ISO = "2026-06-16T00:00:00.000Z";
const OLD_CREATED = "2026-06-01T00:00:00.000Z";
const RECENT_CREATED = "2026-06-29T00:00:00.000Z";

function task(overrides: Partial<SweepTaskRow> & { id: string; run_id: string; task_key: string; status: string }): SweepTaskRow {
  return { claimed_by: null, ...overrides };
}

const baseRuns: SweepRunRow[] = [
  { id: ACTIVE_RUN, status: "in_progress", created_at: OLD_CREATED },
  { id: OLD_RUN, status: "in_progress", created_at: OLD_CREATED },
  { id: OLD_RUN_2, status: "in_progress", created_at: OLD_CREATED },
  { id: RECENT_RUN, status: "in_progress", created_at: RECENT_CREATED }
];

function plan(
  tasks: SweepTaskRow[],
  opts: {
    runs?: SweepRunRow[];
    reviews?: SweepReviewCount[];
    approvals?: SweepApprovalCount[];
    locks?: SweepLockRow[];
    activeRunId?: string | undefined;
    cutoffIso?: string;
    allowList?: Iterable<string>;
  } = {}
) {
  return findSweepableOrphans(tasks, baseRuns.concat(opts.runs ?? []), opts.reviews ?? [], opts.approvals ?? [], opts.locks ?? [], {
    activeRunId: "activeRunId" in opts ? opts.activeRunId : ACTIVE_RUN,
    cutoffIso: opts.cutoffIso ?? CUTOFF_ISO,
    allowList: new Set(opts.allowList ?? [])
  });
}

// ---------------------------------------------------------------------------
// Pure predicate
// ---------------------------------------------------------------------------

test("findSweepableOrphans: in_progress task on an old run with no gates is a candidate", () => {
  const t = task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress" });
  const result = plan([t]);
  assert.deepEqual(result.candidates.map((c) => c.id), ["t1"]);
});

test("findSweepableOrphans: ready status is also sweepable", () => {
  const t = task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "ready" });
  assert.deepEqual(plan([t]).candidates.map((c) => c.id), ["t1"]);
});

test("findSweepableOrphans: approved/done/blocked are never candidates (hard exclusion)", () => {
  for (const status of ["approved", "done", "blocked", "review_blocked"]) {
    const t = task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status });
    assert.equal(plan([t]).candidates.length, 0, `status ${status} must be excluded`);
  }
});

test("findSweepableOrphans: a task with an approval is hard-excluded even on the allow-list", () => {
  const t = task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress" });
  const result = plan([t], {
    approvals: [{ run_id: OLD_RUN, task_key: "k1", approval_count: 1 }],
    allowList: ["k1"]
  });
  assert.equal(result.candidates.length, 0);
});

test("findSweepableOrphans: the active run is hard-excluded even on the allow-list", () => {
  const t = task({ id: "t1", run_id: ACTIVE_RUN, task_key: "k1", status: "in_progress" });
  const result = plan([t], { allowList: ["k1"] });
  assert.equal(result.candidates.length, 0);
});

test("findSweepableOrphans: passed reviews exclude under heuristic but allow-list overrides", () => {
  const t = task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress" });
  const reviews = [{ run_id: OLD_RUN, task_key: "k1", distinct_passed_roles: 2 }];
  assert.equal(plan([t], { reviews }).candidates.length, 0, "heuristic excludes reviewed task");
  assert.equal(plan([t], { reviews, allowList: ["k1"] }).candidates.length, 1, "allow-list overrides reviews");
});

test("findSweepableOrphans: a recent run is excluded under heuristic but allow-list overrides", () => {
  const t = task({ id: "t1", run_id: RECENT_RUN, task_key: "k1", status: "in_progress" });
  assert.equal(plan([t]).candidates.length, 0, "recent run excluded by cutoff");
  assert.equal(plan([t], { allowList: ["k1"] }).candidates.length, 1, "allow-list overrides cutoff");
});

test("findSweepableOrphans: an active scope lock excludes under heuristic but allow-list overrides", () => {
  const t = task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress" });
  const locks: SweepLockRow[] = [{ run_id: OLD_RUN, task_id: "k1", status: "active" }];
  assert.equal(plan([t], { locks }).candidates.length, 0, "active lock excludes");
  assert.equal(plan([t], { locks, allowList: ["k1"] }).candidates.length, 1, "allow-list overrides lock");
  // released lock does not exclude
  const released: SweepLockRow[] = [{ run_id: OLD_RUN, task_id: "k1", status: "released" }];
  assert.equal(plan([t], { locks: released }).candidates.length, 1, "released lock is ignored");
});

test("findSweepableOrphans: claimed_by is NOT a rail — manager-claimed orphans are still swept", () => {
  // Manager-created control-write tasks are permanently claimed_by="manager";
  // gating on claimed_by would exclude exactly the orphans the sweep targets.
  // The in-use signal is the active scope lock, not claimed_by.
  const t = task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress", claimed_by: "manager" });
  assert.equal(plan([t]).candidates.length, 1, "claimed_by does not exclude");
  // An active lock DOES exclude regardless of claim.
  const locks: SweepLockRow[] = [{ run_id: OLD_RUN, task_id: "k1", status: "active" }];
  assert.equal(plan([t], { locks }).candidates.length, 0, "active lock still excludes");
});

test("findSweepableOrphans: allow-list matches by task id (UUID) as well as task_key", () => {
  // Recent run is heuristic-excluded; allow-listing by the task's UUID overrides it.
  const t = task({ id: "uuid-1", run_id: RECENT_RUN, task_key: "k1", status: "in_progress" });
  assert.equal(plan([t]).candidates.length, 0, "excluded under heuristic");
  assert.equal(plan([t], { allowList: ["uuid-1"] }).candidates.length, 1, "allow-list by id overrides");
});

test("findSweepableOrphans: a task whose run is missing is excluded under heuristic but allow-list overrides", () => {
  const t = task({ id: "t1", run_id: "99999999-9999-9999-9999-999999999999", task_key: "k1", status: "in_progress" });
  assert.equal(plan([t]).candidates.length, 0, "no run row → cannot verify age → excluded");
  assert.equal(plan([t], { allowList: ["k1"] }).candidates.length, 1, "allow-list overrides missing run");
});

test("findSweepableOrphans: a run becomes sealable when every task is swept or already terminal", () => {
  const tasks = [
    task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress" }),
    task({ id: "t2", run_id: OLD_RUN, task_key: "k2", status: "done" })
  ];
  const result = plan(tasks);
  assert.deepEqual(result.candidates.map((c) => c.id), ["t1"]);
  assert.deepEqual(result.sealableRunIds, [OLD_RUN]);
});

test("findSweepableOrphans: a run with a surviving non-terminal task is NOT sealable", () => {
  const tasks = [
    task({ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress" }),
    // k2 is recent-run-protected? no — same old run but has an approval => hard excluded => survives non-terminal
    task({ id: "t2", run_id: OLD_RUN, task_key: "k2", status: "in_progress" })
  ];
  const result = plan(tasks, { approvals: [{ run_id: OLD_RUN, task_key: "k2", approval_count: 1 }] });
  assert.deepEqual(result.candidates.map((c) => c.id), ["t1"]);
  assert.deepEqual(result.sealableRunIds, [], "k2 survives in_progress so the run is not sealed");
});

test("findSweepableOrphans: the active run is never sealable", () => {
  const tasks = [task({ id: "t1", run_id: ACTIVE_RUN, task_key: "k1", status: "done" })];
  const result = plan(tasks);
  assert.deepEqual(result.sealableRunIds, []);
});

// ---------------------------------------------------------------------------
// Command (injected deps)
// ---------------------------------------------------------------------------

interface FakeDb {
  tasks: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  locks: Record<string, unknown>[];
  runtimeState: Record<string, unknown>[];
  executed: { text: string; values?: readonly unknown[] }[];
}

function makeDeps(db: FakeDb, lines: string[], written: { path: string; content: string }[]): SweepOrphansDeps {
  return {
    query: async (text, values) => {
      db.executed.push({ text, values });
      const t = text.toLowerCase();
      if (t.includes("from project_runtime_state")) return { rows: db.runtimeState, rowCount: db.runtimeState.length };
      if (t.startsWith("select") && t.includes("from tasks") && t.includes("status in")) {
        return { rows: db.tasks, rowCount: db.tasks.length };
      }
      if (t.startsWith("select") && t.includes("from tasks")) return { rows: db.tasks, rowCount: db.tasks.length };
      if (t.includes("from reviews")) return { rows: db.reviews, rowCount: db.reviews.length };
      if (t.includes("from approvals")) return { rows: db.approvals, rowCount: db.approvals.length };
      if (t.includes("from locks")) return { rows: db.locks, rowCount: db.locks.length };
      if (t.includes("from runs")) return { rows: db.runs, rowCount: db.runs.length };
      if (t.startsWith("update")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    withTransaction: async (work) => work(),
    writeFile: async (path, content) => { written.push({ path, content }); },
    now: () => "2026-06-30T00:00:00.000Z",
    writeLine: (line) => { lines.push(line); },
    dataRoot: "/repo/data",
    repoRoot: "/repo"
  };
}

function emptyDb(): FakeDb {
  return {
    tasks: [],
    runs: [],
    reviews: [],
    approvals: [],
    locks: [],
    runtimeState: [{ active_run_id: ACTIVE_RUN }],
    executed: []
  };
}

test("sweepOrphansCommand: dry-run by default performs no mutation", async () => {
  const db = emptyDb();
  db.runs = [{ id: OLD_RUN, status: "in_progress", created_at: OLD_CREATED }];
  db.tasks = [{ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress", claimed_by: null }];
  const lines: string[] = [];
  const written: { path: string; content: string }[] = [];
  await sweepOrphansCommand(["--older-than-days", "1"], makeDeps(db, lines, written));

  assert.ok(lines.some((l) => l.includes("DRY-RUN")), "announces dry-run");
  assert.ok(lines.some((l) => l.includes("k1")), "lists the candidate");
  assert.equal(written.length, 0, "no backup written in dry-run");
  assert.equal(db.executed.filter((e) => e.text.toLowerCase().startsWith("update")).length, 0, "no UPDATE in dry-run");
});

test("sweepOrphansCommand: --confirm writes a backup then marks tasks done and seals the run", async () => {
  const db = emptyDb();
  db.runs = [{ id: OLD_RUN, status: "in_progress", created_at: OLD_CREATED }];
  db.tasks = [{ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress", claimed_by: null }];
  const lines: string[] = [];
  const written: { path: string; content: string }[] = [];
  await sweepOrphansCommand(["--older-than-days", "1", "--confirm"], makeDeps(db, lines, written));

  assert.equal(written.length, 1, "backup written before mutation");
  const backup = JSON.parse(written[0]!.content);
  assert.equal(backup.candidateTasks.length, 1);
  assert.equal(backup.candidateTasks[0].status, "in_progress", "backup captures original status for rollback");

  const updates = db.executed.filter((e) => e.text.toLowerCase().startsWith("update"));
  const taskUpdate = updates.find((u) => u.text.toLowerCase().includes("tasks"));
  const runUpdate = updates.find((u) => u.text.toLowerCase().includes("runs"));
  assert.ok(taskUpdate, "marks tasks");
  assert.ok(runUpdate, "seals the run");
  // The UPDATE must actually carry the candidate ids — an empty values array
  // would mean the mutation targeted nothing (a silent no-op).
  assert.ok((taskUpdate!.values?.length ?? 0) > 0, "tasks UPDATE carries a non-empty values array");
  assert.ok(Array.isArray(taskUpdate!.values?.[0]) && (taskUpdate!.values![0] as unknown[]).length === 1, "tasks UPDATE targets the one candidate id");
  assert.ok((runUpdate!.values?.length ?? 0) > 0, "runs UPDATE carries a non-empty values array");
});

test("sweepOrphansCommand: --backup must be absolute and end with .json", async () => {
  const mk = () => {
    const db = emptyDb();
    db.runs = [{ id: OLD_RUN, status: "in_progress", created_at: OLD_CREATED }];
    db.tasks = [{ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress", claimed_by: null }];
    return db;
  };
  await assert.rejects(
    () => sweepOrphansCommand(["--older-than-days", "1", "--confirm", "--backup", "relative/path.json"], makeDeps(mk(), [], [])),
    /absolute/i,
    "rejects a relative backup path"
  );
  await assert.rejects(
    () => sweepOrphansCommand(["--older-than-days", "1", "--confirm", "--backup", "/repo/data/backup.txt"], makeDeps(mk(), [], [])),
    /\.json/i,
    "rejects a non-.json backup path"
  );
});

test("sweepOrphansCommand: --confirm with no candidates writes nothing", async () => {
  const db = emptyDb();
  const lines: string[] = [];
  const written: { path: string; content: string }[] = [];
  await sweepOrphansCommand(["--confirm"], makeDeps(db, lines, written));
  assert.equal(written.length, 0);
  assert.ok(lines.some((l) => l.toLowerCase().includes("nothing")));
});

test("sweepOrphansCommand: refuses --confirm when the backup path is outside the allowed roots", async () => {
  const db = emptyDb();
  db.runs = [{ id: OLD_RUN, status: "in_progress", created_at: OLD_CREATED }];
  db.tasks = [{ id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress", claimed_by: null }];
  const lines: string[] = [];
  const written: { path: string; content: string }[] = [];
  await assert.rejects(
    () => sweepOrphansCommand(["--older-than-days", "1", "--confirm", "--backup", "/etc/evil.json"], makeDeps(db, lines, written)),
    /outside/i
  );
  assert.equal(db.executed.filter((e) => e.text.toLowerCase().startsWith("update")).length, 0, "no mutation when backup refused");
});

test("sweepOrphansCommand: caps the task scan and refuses to proceed past the cap", async () => {
  const db = emptyDb();
  db.runs = [{ id: OLD_RUN, status: "in_progress", created_at: OLD_CREATED }];
  // 3 tasks, cap 2 → must refuse rather than silently truncate.
  db.tasks = [
    { id: "t1", run_id: OLD_RUN, task_key: "k1", status: "in_progress", claimed_by: null },
    { id: "t2", run_id: OLD_RUN, task_key: "k2", status: "in_progress", claimed_by: null },
    { id: "t3", run_id: OLD_RUN, task_key: "k3", status: "in_progress", claimed_by: null }
  ];
  const lines: string[] = [];
  const written: { path: string; content: string }[] = [];
  await assert.rejects(
    () => sweepOrphansCommand(["--older-than-days", "1", "--max-scan", "2"], makeDeps(db, lines, written)),
    /cap|max-scan|too many/i
  );
});
