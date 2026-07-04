/**
 * Regression tests for closureLoop bug 3 + the --confirm/--apply alias paper cut
 * (audit auditDebt202607).
 *
 * Bug 3: close-run's onRunSealed cleared the dangling active-task pointer only
 * when the pointer's run == the sealed run. When a duplicate had moved the pointer
 * to another run, sealing the ORIGINAL run (holding the same task key) left the
 * stale active_task_id in place. Fix: also clear when the pointer's active_task_id
 * matches a task key that just went terminal in the sealed run.
 *
 * Paper cut: close-run (--confirm) and reconcile-runtime-state (--apply) now
 * accept BOTH mutate flags (alias, no break).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileRunClosure,
  shouldClearDanglingActiveTaskPointer,
  isMutateConfirmed,
  type CloseRunDeps
} from "../src/admin/close-run.ts";
import type {
  ApprovalRecord,
  ReviewRecord,
  RunRecord,
  RunStatusSnapshot,
  TaskRecord
} from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// shouldClearDanglingActiveTaskPointer (pure decision)
// ---------------------------------------------------------------------------

test("pointer clear: fires when the pointer's run is the sealed run (original behavior)", () => {
  assert.equal(
    shouldClearDanglingActiveTaskPointer({
      activeRunId: "run-A",
      activeTaskId: "t1",
      sealedRunId: "run-A",
      sealedTaskKeys: ["t1"]
    }),
    true
  );
});

test("pointer clear: fires cross-run when active_task_id matches a terminal key in the sealed run (bug 3)", () => {
  // The pointer moved to a duplicate run-B, but the ORIGINAL run-A holding t1 is
  // being sealed. The stale pointer must still clear.
  assert.equal(
    shouldClearDanglingActiveTaskPointer({
      activeRunId: "run-B-duplicate",
      activeTaskId: "t1",
      sealedRunId: "run-A",
      sealedTaskKeys: ["t1", "t2"]
    }),
    true
  );
});

test("pointer clear: does NOT fire when the pointer's task key is unrelated to the sealed run", () => {
  assert.equal(
    shouldClearDanglingActiveTaskPointer({
      activeRunId: "run-B",
      activeTaskId: "other-task",
      sealedRunId: "run-A",
      sealedTaskKeys: ["t1", "t2"]
    }),
    false
  );
});

test("pointer clear: does NOT fire when there is no active task pointer", () => {
  assert.equal(
    shouldClearDanglingActiveTaskPointer({
      activeRunId: "run-A",
      activeTaskId: undefined,
      sealedRunId: "run-A",
      sealedTaskKeys: ["t1"]
    }),
    false
  );
});

// ---------------------------------------------------------------------------
// reconcileRunClosure passes the sealed run's terminal task keys to onRunSealed
// ---------------------------------------------------------------------------

function task(id: string, status: TaskRecord["status"]): TaskRecord {
  return {
    id: `uuid-${id}`,
    runId: "run-1",
    workspaceId: "ws",
    projectId: "proj",
    class: "prototype_slice",
    status,
    claimedBy: "manager",
    createdAt: "t",
    updatedAt: "t",
    packet: {
      taskId: id,
      title: id,
      ownerRole: "backend_engineer",
      completionStandard: "artifact_complete",
      requiredSpecialistRoles: [],
      qualityGates: [],
      goal: "g",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope: ["src"],
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews: [],
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: ""
    }
  };
}

function snapshotOf(tasks: TaskRecord[]): RunStatusSnapshot {
  const run: RunRecord = {
    id: "run-1",
    workspaceId: "ws",
    projectId: "proj",
    actor: "manager",
    title: "r",
    request: "r",
    summary: {
      goal: "g", audience: [], constraints: [], risks: [], unknowns: [], successCriteria: [],
      outOfScope: [], trustBoundaries: [], destructiveActions: [], externalIntegrations: [], stopGo: "go"
    },
    status: "in_progress",
    createdAt: "t",
    updatedAt: "t"
  };
  return { run, tasks, activeLocks: [], blockers: [], nextTaskIds: [] };
}

test("reconcileRunClosure: onRunSealed receives the sealed run's terminal task keys", async () => {
  const snap = snapshotOf([task("t1", "done"), task("t2", "done")]);
  const sealedCalls: { runId: string; keys: readonly string[] }[] = [];
  const deps: CloseRunDeps = {
    getStatusSnapshot: async () => snap,
    getReviews: async (): Promise<ReviewRecord[]> => [],
    getApprovals: async (): Promise<ApprovalRecord[]> => [],
    getReviewFloorReductions: async () => [],
    updateTask: async () => {},
    updateRun: async () => {},
    onRunSealed: async (runId, keys) => { sealedCalls.push({ runId, keys }); },
    now: () => "2026-07-04T00:00:00.000Z",
    writeLine: () => {}
  };

  const result = await reconcileRunClosure("run-1", true, deps);
  assert.equal(result.sealedRun, true);
  assert.equal(sealedCalls.length, 1);
  assert.equal(sealedCalls[0]!.runId, "run-1");
  assert.deepEqual([...sealedCalls[0]!.keys].sort(), ["t1", "t2"], "all terminal task keys are forwarded");
});

// ---------------------------------------------------------------------------
// Retro nudge (audit F5 learning loop) — printed ONLY on an actual seal
// ---------------------------------------------------------------------------

const RETRO_NUDGE = "/archon-retro";

function collectingDeps(snap: RunStatusSnapshot, lines: string[]): CloseRunDeps {
  return {
    getStatusSnapshot: async () => snap,
    getReviews: async (): Promise<ReviewRecord[]> => [],
    getApprovals: async (): Promise<ApprovalRecord[]> => [],
    getReviewFloorReductions: async () => [],
    updateTask: async () => {},
    updateRun: async () => {},
    now: () => "2026-07-04T00:00:00.000Z",
    writeLine: (line) => lines.push(line)
  };
}

test("retro nudge: emitted when a run is actually sealed (--confirm, all tasks terminal)", async () => {
  const snap = snapshotOf([task("t1", "done"), task("t2", "done")]);
  const lines: string[] = [];
  const result = await reconcileRunClosure("run-1", true, collectingDeps(snap, lines));
  assert.equal(result.sealedRun, true);
  assert.ok(
    lines.some((l) => l.includes(RETRO_NUDGE)),
    "a sealed run must nudge the operator to run the retro"
  );
});

test("retro nudge: NOT emitted on dry-run even when the run is seal-ready", async () => {
  const snap = snapshotOf([task("t1", "done"), task("t2", "done")]);
  const lines: string[] = [];
  const result = await reconcileRunClosure("run-1", false, collectingDeps(snap, lines));
  assert.equal(result.sealedRun, false);
  assert.ok(
    lines.some((l) => l.includes("seal run: yes")),
    "dry-run still reports the run is seal-ready"
  );
  assert.ok(
    !lines.some((l) => l.includes(RETRO_NUDGE)),
    "dry-run must not fire the retro nudge — only an actual seal does"
  );
});

test("retro nudge: NOT emitted when the run is not sealable (non-terminal task remains)", async () => {
  const snap = snapshotOf([task("t1", "done"), task("t2", "in_progress")]);
  const lines: string[] = [];
  const result = await reconcileRunClosure("run-1", true, collectingDeps(snap, lines));
  assert.equal(result.sealedRun, false);
  assert.ok(
    !lines.some((l) => l.includes(RETRO_NUDGE)),
    "an unsealed run must not fire the retro nudge"
  );
});

// ---------------------------------------------------------------------------
// isMutateConfirmed — --confirm AND --apply both mean "mutate"
// ---------------------------------------------------------------------------

test("isMutateConfirmed: accepts --confirm and --apply, rejects neither", () => {
  assert.equal(isMutateConfirmed(["--confirm"]), true);
  assert.equal(isMutateConfirmed(["--apply"]), true);
  assert.equal(isMutateConfirmed(["--run-id", "x"]), false);
  assert.equal(isMutateConfirmed([]), false);
});
