/**
 * Tests for the retro-nudge print (audit F5 learning loop) and the real,
 * auditable retro-required seal gate built to enforce it (auditP3RetroLoop
 * fix #1 — PR #163 review remediation).
 *
 * Split from tests/close-run-pointer-clear.test.ts (that file previously
 * bundled these with the unrelated PR #154 pointer-clear tests, now in
 * tests/close-run-dangling-pointer.test.ts).
 *
 * Covers:
 *   - the retro nudge print itself (emitted only on an actual seal)
 *   - seal BLOCKED when no task in the run has a recorded retro decision
 *   - seal succeeds when a task's packet.retroOutcome is recorded
 *   - seal succeeds via the --acknowledge-no-retro escape hatch (non-empty reason)
 *   - idempotent re-run: an already-sealed run does not re-fire the nudge or onRunSealed
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileRunClosure,
  type CloseRunDeps
} from "../src/admin/close-run.ts";
import type {
  ApprovalRecord,
  ReviewRecord,
  RunRecord,
  RunStatusSnapshot,
  TaskRecord
} from "../src/domain/types.ts";

const RETRO_COMMAND = "record-retro";

function task(id: string, status: TaskRecord["status"], retroOutcome?: string): TaskRecord {
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
      handoffFormat: "",
      ...(retroOutcome !== undefined ? { retroOutcome } : {})
    }
  };
}

function snapshotOf(tasks: TaskRecord[], runStatus: RunRecord["status"] = "in_progress"): RunStatusSnapshot {
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
    status: runStatus,
    createdAt: "t",
    updatedAt: "t"
  };
  return { run, tasks, activeLocks: [], blockers: [], nextTaskIds: [] };
}

function collectingDeps(
  snap: RunStatusSnapshot,
  lines: string[],
  calls?: { updatedRuns: RunRecord[]; sealed: string[] }
): CloseRunDeps {
  return {
    getStatusSnapshot: async () => snap,
    getReviews: async (): Promise<ReviewRecord[]> => [],
    getApprovals: async (): Promise<ApprovalRecord[]> => [],
    getReviewFloorReductions: async () => [],
    updateTask: async () => {},
    updateRun: async (r) => { calls?.updatedRuns.push(r); },
    onRunSealed: async (runId) => { calls?.sealed.push(runId); },
    now: () => "2026-07-04T00:00:00.000Z",
    writeLine: (line) => lines.push(line)
  };
}

// ---------------------------------------------------------------------------
// Retro nudge — printed ONLY on an actual seal, and names the real command
// ---------------------------------------------------------------------------

test("retro nudge: emitted when a run is actually sealed (--confirm, all tasks terminal, retro recorded)", async () => {
  const snap = snapshotOf([task("t1", "done", "memory_promoted"), task("t2", "done")]);
  const lines: string[] = [];
  const result = await reconcileRunClosure("run-1", true, collectingDeps(snap, lines));
  assert.equal(result.sealedRun, true);
  assert.ok(
    lines.some((l) => l.includes(RETRO_COMMAND)),
    "a sealed run must nudge the operator with the concrete record-retro command"
  );
});

test("retro nudge: NOT emitted on dry-run even when the run is seal-ready", async () => {
  const snap = snapshotOf([task("t1", "done", "memory_promoted"), task("t2", "done")]);
  const lines: string[] = [];
  const result = await reconcileRunClosure("run-1", false, collectingDeps(snap, lines));
  assert.equal(result.sealedRun, false);
  assert.ok(
    lines.some((l) => l.includes("seal run: yes")),
    "dry-run still reports the run is seal-ready"
  );
  assert.ok(
    !lines.some((l) => l.includes(RETRO_COMMAND)),
    "dry-run must not fire the retro nudge — only an actual seal does"
  );
});

test("retro nudge: NOT emitted when the run is not sealable (non-terminal task remains)", async () => {
  const snap = snapshotOf([task("t1", "done", "memory_promoted"), task("t2", "in_progress")]);
  const lines: string[] = [];
  const result = await reconcileRunClosure("run-1", true, collectingDeps(snap, lines));
  assert.equal(result.sealedRun, false);
  assert.ok(
    !lines.some((l) => l.includes(RETRO_COMMAND)),
    "an unsealed run must not fire the retro nudge"
  );
});

// ---------------------------------------------------------------------------
// Retro-required seal gate (auditP3RetroLoop fix #1)
// ---------------------------------------------------------------------------

test("retro gate: seal is BLOCKED when no task in the run has a recorded retro decision", async () => {
  const snap = snapshotOf([task("t1", "done"), task("t2", "done")]); // no retroOutcome on either
  const lines: string[] = [];
  const calls = { updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure("run-1", true, collectingDeps(snap, lines, calls));

  assert.equal(result.sealedRun, false, "must not seal without a recorded retro decision");
  assert.equal(calls.updatedRuns.length, 0, "the run record must not be mutated");
  assert.equal(calls.sealed.length, 0, "onRunSealed must not fire");
  assert.ok(lines.some((l) => l.includes("BLOCKED") && l.includes("retro")), "must explain the block");
  assert.ok(
    lines.some((l) => l.includes(RETRO_COMMAND) && l.includes("--task-id") && l.includes("--outcome")),
    "must name the exact record-retro command"
  );
  assert.ok(
    lines.some((l) => l.includes("--acknowledge-no-retro")),
    "must name the escape-hatch flag"
  );
});

test("retro gate: seal is BLOCKED when retroOutcome is a garbage/non-token string (PR #163 round-2 finding #2)", async () => {
  // "blah" is a non-empty string but not a member of RETRO_OUTCOME_TOKENS — the
  // gate must validate against the actual token set, not truthy-only, so a
  // stray value from a future refactor or manual DB fix cannot silently
  // satisfy the governance gate the same way a real record-retro call would.
  const snap = snapshotOf([task("t1", "done", "blah"), task("t2", "done")]);
  const lines: string[] = [];
  const calls = { updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure("run-1", true, collectingDeps(snap, lines, calls));

  assert.equal(result.sealedRun, false, "a garbage retroOutcome must not satisfy the seal gate");
  assert.equal(calls.updatedRuns.length, 0, "the run record must not be mutated");
  assert.equal(calls.sealed.length, 0, "onRunSealed must not fire");
  assert.ok(lines.some((l) => l.includes("BLOCKED") && l.includes("retro")), "must explain the block");
});

test("retro gate: seal SUCCEEDS when a task's retroOutcome is recorded", async () => {
  const snap = snapshotOf([task("t1", "done", "skill_patched"), task("t2", "done")]);
  const lines: string[] = [];
  const calls = { updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure("run-1", true, collectingDeps(snap, lines, calls));

  assert.equal(result.sealedRun, true);
  assert.equal(calls.updatedRuns.length, 1);
  assert.equal(calls.updatedRuns[0]!.status, "done");
  assert.deepEqual(calls.sealed, ["run-1"]);
});

test("retro gate: seal SUCCEEDS via --acknowledge-no-retro escape hatch with no recorded retro decision", async () => {
  const snap = snapshotOf([task("t1", "done"), task("t2", "done")]); // no retroOutcome
  const lines: string[] = [];
  const calls = { updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure(
    "run-1",
    true,
    collectingDeps(snap, lines, calls),
    { acknowledgeNoRetro: { reason: "spike task, no durable lesson" } }
  );

  assert.equal(result.sealedRun, true, "the escape hatch must permit sealing");
  assert.equal(calls.updatedRuns.length, 1);
  assert.deepEqual(calls.sealed, ["run-1"]);
  assert.ok(
    lines.some((l) => l.includes("acknowledged") && l.includes("spike task, no durable lesson")),
    "the acknowledgement reason must be printed — no silent bypass"
  );
});

test("retro gate: --acknowledge-no-retro with an empty/whitespace reason does NOT bypass the gate", async () => {
  const snap = snapshotOf([task("t1", "done"), task("t2", "done")]);
  const lines: string[] = [];
  const calls = { updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure(
    "run-1",
    true,
    collectingDeps(snap, lines, calls),
    { acknowledgeNoRetro: { reason: "   " } }
  );

  assert.equal(result.sealedRun, false, "a blank reason must not count as an acknowledgement");
  assert.equal(calls.updatedRuns.length, 0);
});

// ---------------------------------------------------------------------------
// Idempotency: re-running close-run on an already-sealed run does nothing new
// ---------------------------------------------------------------------------

test("idempotency: re-running close-run on an already-sealed run does not re-fire the nudge or onRunSealed", async () => {
  // snapshot.run.status is ALREADY "done" — the pre-existing idempotency guard
  // (`snapshot.run.status !== "done"`) must still short-circuit the whole seal
  // branch, regardless of whether a retro decision is present.
  const snap = snapshotOf([task("t1", "done"), task("t2", "done")], "done");
  const lines: string[] = [];
  const calls = { updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure("run-1", true, collectingDeps(snap, lines, calls));

  assert.equal(result.sealedRun, false, "an already-sealed run is not re-sealed");
  assert.equal(calls.updatedRuns.length, 0, "updateRun must not be called again");
  assert.equal(calls.sealed.length, 0, "onRunSealed must not re-fire");
  assert.ok(
    !lines.some((l) => l.includes(RETRO_COMMAND)),
    "the retro nudge must not re-fire on an idempotent re-run"
  );
  assert.ok(lines.some((l) => l.includes("run already sealed")));
});
