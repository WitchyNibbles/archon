import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Direct test of the extracted state-readers leaf module (daemon split). Imports from
// the module path to lock the boundary; exercises the absent-file (ENOENT) path of all
// four readers.
import {
  readDaemonContinuationStatus,
  readDaemonOperatorHandoff,
  readDaemonSupervisorStatus,
  readDaemonSupervisorHistory
} from "../src/daemon/state-readers.ts";

const historyOptions = { limit: 10, scope: "all" as const };

test("daemon state readers return the empty/absent result when their artifact is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-state-readers-"));
  assert.equal(await readDaemonContinuationStatus(dir), undefined);
  assert.equal(await readDaemonOperatorHandoff(dir), undefined);
  assert.equal(await readDaemonSupervisorStatus(dir, historyOptions), undefined);
  assert.deepEqual(await readDaemonSupervisorHistory(dir, historyOptions), {
    entries: [],
    retainedCount: 0,
    filteredCount: 0
  });
});

// ---------------------------------------------------------------------------
// Round-15 MEDIUM fix: state-readers.ts now validates operator-handoff/
// supervisor-status state+blockerKind against admin/status.ts's canonical
// DAEMON_HANDOFF_*/DAEMON_SUPERVISOR_* arrays (round-14 left those arrays as
// dead code — this wires them up for real) instead of a hand-rolled `===`
// OR-chain duplicate. Both directions, plus a source-level anti-drift check
// (the same cross-module pinning pattern used for daemon/supervisor.ts in
// round 14).
// ---------------------------------------------------------------------------

async function writeJson(dir: string, relativePath: string, value: unknown): Promise<void> {
  const fullPath = path.join(dir, ...relativePath.split("/"));
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(value), "utf8");
}

test("readDaemonOperatorHandoff: a recognized state/blockerKind pass through; an attacker-controlled secret-shaped value falls back to invalid/unknown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-state-readers-"));
  await writeJson(dir, ".archon/work/daemon/operator-handoff.json", {
    state: "blocked",
    blockerKind: "runtime_preflight",
    reason: "r",
    nextActions: [],
    detailFiles: {}
  });
  const good = await readDaemonOperatorHandoff(dir);
  assert.equal(good?.state, "blocked");
  assert.equal(good?.blockerKind, "runtime_preflight");

  await writeJson(dir, ".archon/work/daemon/operator-handoff.json", {
    state: "hunter2Aa1SuperSecret9",
    blockerKind: "hunter2Aa1SuperSecret9",
    reason: "r",
    nextActions: [],
    detailFiles: {}
  });
  const attacked = await readDaemonOperatorHandoff(dir);
  assert.equal(attacked?.state, "invalid");
  assert.equal(attacked?.blockerKind, "unknown");
});

test("readDaemonSupervisorStatus: a recognized state/blockerKind pass through; an attacker-controlled secret-shaped value falls back to invalid/unknown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-state-readers-"));
  await writeJson(dir, ".archon/work/daemon/supervisor-status.json", {
    state: "blocked",
    blockerKind: "runtime_preflight",
    reason: "r",
    nextActions: [],
    missingReviewRoles: [],
    actions: []
  });
  const good = await readDaemonSupervisorStatus(dir, historyOptions);
  assert.equal(good?.state, "blocked");
  assert.equal(good?.blockerKind, "runtime_preflight");

  await writeJson(dir, ".archon/work/daemon/supervisor-status.json", {
    state: "hunter2Aa1SuperSecret9",
    blockerKind: "hunter2Aa1SuperSecret9",
    reason: "r",
    nextActions: [],
    missingReviewRoles: [],
    actions: []
  });
  const attacked = await readDaemonSupervisorStatus(dir, historyOptions);
  assert.equal(attacked?.state, "invalid");
  assert.equal(attacked?.blockerKind, "unknown");
});

test("state-readers.ts imports the canonical DAEMON_HANDOFF_*/DAEMON_SUPERVISOR_* arrays and does not redefine them as local OR-chains", async () => {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = await readFile(resolve(repoRoot, "src/daemon/state-readers.ts"), "utf8");
  assert.match(
    source,
    /import\s*\{\s*\n?\s*DAEMON_HANDOFF_STATES,\s*\n?\s*DAEMON_HANDOFF_BLOCKER_KINDS,\s*\n?\s*DAEMON_SUPERVISOR_STATES,\s*\n?\s*DAEMON_SUPERVISOR_BLOCKER_KINDS\s*\n?\s*\}\s*from\s*["']\.\.\/admin\/status\.ts["']/,
    "state-readers.ts must import the canonical arrays from admin/status.ts"
  );
  assert.doesNotMatch(
    source,
    /parsed\.blockerKind === "bootstrapping"/,
    "state-readers.ts must not redefine the handoff blockerKind list as a local OR-chain — that is exactly the dead-code duplicate round 15 closed"
  );
});
