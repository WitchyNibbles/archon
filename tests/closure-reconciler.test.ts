import test from "node:test";
import assert from "node:assert/strict";

import {
  planRunClosure,
  buildTaskEvidence,
  countApprovedNotClosed,
  type ClosureTaskEvidence
} from "../src/core/closure-reconciler.ts";
import { reconcileRunClosure, reconcileAllRuns, type CloseRunDeps } from "../src/admin/close-run.ts";
import type {
  TaskRecord,
  RunRecord,
  ReviewRecord,
  ApprovalRecord,
  ReviewFloorReductionRecord,
  RunStatusSnapshot
} from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Pure predicate
// ---------------------------------------------------------------------------

function ev(overrides: Partial<ClosureTaskEvidence> & { taskId: string; status: string }): ClosureTaskEvidence {
  return {
    requiredFloor: ["reviewer", "qa_engineer", "security_reviewer"],
    passedOrchestratorRoles: ["reviewer", "qa_engineer", "security_reviewer"],
    orchestratorApprovals: 1,
    ...overrides
  };
}

test("planRunClosure: approved + full orchestrator provenance is closeable", () => {
  const plan = planRunClosure([ev({ taskId: "t1", status: "approved" })]);
  assert.deepEqual(plan.closeable, ["t1"]);
  assert.equal(plan.sealRun, true);
});

test("planRunClosure: approved missing a passed role is BLOCKED, never advanced (C2)", () => {
  const plan = planRunClosure([
    ev({ taskId: "t1", status: "approved", passedOrchestratorRoles: ["reviewer", "qa_engineer"] })
  ]);
  assert.equal(plan.closeable.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0]!.reason, /security_reviewer/);
  assert.equal(plan.sealRun, false, "a provenance-gap task must not seal the run");
});

test("planRunClosure: approved with no orchestrator approval is BLOCKED", () => {
  const plan = planRunClosure([ev({ taskId: "t1", status: "approved", orchestratorApprovals: 0 })]);
  assert.equal(plan.closeable.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0]!.reason, /approval/);
});

test("planRunClosure: done tasks are alreadyDone; a run of done+closeable seals", () => {
  const plan = planRunClosure([
    ev({ taskId: "t1", status: "done" }),
    ev({ taskId: "t2", status: "approved" })
  ]);
  assert.deepEqual(plan.alreadyDone, ["t1"]);
  assert.deepEqual(plan.closeable, ["t2"]);
  assert.equal(plan.sealRun, true);
});

test("planRunClosure: a non-terminal task prevents sealing", () => {
  const plan = planRunClosure([
    ev({ taskId: "t1", status: "approved" }),
    ev({ taskId: "t2", status: "in_progress" })
  ]);
  assert.deepEqual(plan.closeable, ["t1"]);
  assert.deepEqual(plan.nonTerminal, ["t2"]);
  assert.equal(plan.sealRun, false);
});

test("planRunClosure: an empty run is not sealable", () => {
  assert.equal(planRunClosure([]).sealRun, false);
});

test("planRunClosure: a reduced floor (e.g. reviewer-only) is honored", () => {
  const plan = planRunClosure([
    ev({ taskId: "t1", status: "approved", requiredFloor: ["reviewer"], passedOrchestratorRoles: ["reviewer"] })
  ]);
  assert.deepEqual(plan.closeable, ["t1"]);
});

// ---------------------------------------------------------------------------
// Evidence builder
// ---------------------------------------------------------------------------

// retroOutcome defaults to a recorded decision so pre-existing provenance/sealing
// tests in this file (predating the retro-required seal gate, auditP3RetroLoop
// fix #1) keep testing provenance logic in isolation. Tests that specifically
// exercise the retro gate itself live in tests/close-run-retro-gate.test.ts and
// construct tasks without a retroOutcome explicitly.
function task(
  taskId: string,
  status: string,
  requiredReviews: string[] = ["reviewer", "qa_engineer", "security_reviewer"],
  retroOutcome: string | undefined = "nothing_to_promote"
): TaskRecord {
  return {
    id: `uuid-${taskId}`,
    runId: "run-1",
    workspaceId: "ws",
    projectId: "proj",
    class: "prototype_slice",
    status: status as TaskRecord["status"],
    claimedBy: "manager",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    packet: {
      taskId,
      title: taskId,
      ownerRole: "planner",
      completionStandard: "artifact_complete",
      requiredSpecialistRoles: [],
      qualityGates: [],
      goal: "g",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope: [],
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews: requiredReviews as TaskRecord["packet"]["requiredReviews"],
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: "",
      ...(retroOutcome !== undefined ? { retroOutcome } : {})
    }
  };
}

function review(role: string, source: string, state: string): ReviewRecord {
  return {
    id: `r-${role}-${source}`,
    runId: "run-1",
    taskId: "t1",
    reviewerRole: role as ReviewRecord["reviewerRole"],
    actor: "a",
    actorRole: "reviewer" as ReviewRecord["actorRole"],
    source: source as ReviewRecord["source"],
    state: state as ReviewRecord["state"],
    severity: "info" as ReviewRecord["severity"],
    findings: [],
    createdAt: "2026-06-30T00:00:00.000Z"
  };
}

function approval(source: string, decision: string): ApprovalRecord {
  return {
    id: `a-${source}`,
    runId: "run-1",
    taskId: "t1",
    actor: "a",
    actorRole: "reviewer" as ApprovalRecord["actorRole"],
    source: source as ApprovalRecord["source"],
    decision: decision as ApprovalRecord["decision"],
    rationale: "",
    createdAt: "2026-06-30T00:00:00.000Z"
  };
}

test("buildTaskEvidence: counts only orchestrator passed reviews and orchestrator approvals", () => {
  const e = buildTaskEvidence(
    task("t1", "approved"),
    [
      review("reviewer", "orchestrator", "passed"),
      review("qa_engineer", "orchestrator", "passed"),
      review("security_reviewer", "self", "passed"), // self → ignored
      review("reviewer", "orchestrator", "blocked") // not passed → ignored
    ],
    [approval("orchestrator", "approved"), approval("self", "approved")],
    []
  );
  assert.deepEqual(e.passedOrchestratorRoles.sort(), ["qa_engineer", "reviewer"]);
  assert.equal(e.orchestratorApprovals, 1, "only the orchestrator approval counts");
});

test("buildTaskEvidence: falls back to the full required trio when no reduction exists", () => {
  const e = buildTaskEvidence(task("t1", "approved"), [], [], []);
  assert.deepEqual(e.requiredFloor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("buildTaskEvidence: IGNORES a non-orchestrator floor reduction (C2 — trust source)", () => {
  const selfReduction: ReviewFloorReductionRecord = {
    id: "fr-evil",
    runId: "run-1",
    taskId: "t1",
    derivedClass: "docs_only",
    droppedRoles: ["qa_engineer", "security_reviewer"],
    effectiveFloor: ["reviewer"],
    writeScopeSnapshot: [],
    basis: "docs_only",
    source: "self", // NOT orchestrator → must be ignored
    decidedAt: "2026-06-30T00:00:00.000Z"
  };
  const e = buildTaskEvidence(task("t1", "approved"), [], [], [selfReduction]);
  assert.deepEqual(e.requiredFloor.sort(), ["qa_engineer", "reviewer", "security_reviewer"], "a self-sourced reduction must not lower the floor");
});

test("buildTaskEvidence: skips an empty-effectiveFloor reduction (guard) and falls back to the trio", () => {
  const emptyReduction: ReviewFloorReductionRecord = {
    id: "fr-empty",
    runId: "run-1",
    taskId: "t1",
    derivedClass: "docs_only",
    droppedRoles: [],
    effectiveFloor: [], // empty → must be skipped, not used as a zero-review floor
    writeScopeSnapshot: [],
    basis: "docs_only",
    source: "orchestrator",
    decidedAt: "2026-06-30T00:00:00.000Z"
  };
  const e = buildTaskEvidence(task("t1", "approved"), [], [], [emptyReduction]);
  assert.deepEqual(e.requiredFloor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("buildTaskEvidence: honors an orchestrator review-floor reduction", () => {
  const reduction: ReviewFloorReductionRecord = {
    id: "fr-1",
    runId: "run-1",
    taskId: "t1",
    derivedClass: "docs_only",
    droppedRoles: ["qa_engineer", "security_reviewer"],
    effectiveFloor: ["reviewer"],
    writeScopeSnapshot: [],
    basis: "docs_only",
    source: "orchestrator",
    decidedAt: "2026-06-30T00:00:00.000Z"
  };
  const e = buildTaskEvidence(task("t1", "approved"), [review("reviewer", "orchestrator", "passed")], [], [reduction]);
  assert.deepEqual(e.requiredFloor, ["reviewer"]);
});

test("countApprovedNotClosed counts approved tasks", () => {
  assert.equal(countApprovedNotClosed([{ status: "approved" }, { status: "done" }, { status: "approved" }]), 2);
});

// ---------------------------------------------------------------------------
// reconcileRunClosure orchestrator
// ---------------------------------------------------------------------------

function makeSnapshot(tasks: TaskRecord[]): RunStatusSnapshot {
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
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z"
  };
  return { run, tasks, activeLocks: [], blockers: [], nextTaskIds: [] };
}

function makeDeps(
  snapshot: RunStatusSnapshot,
  records: {
    reviews?: Record<string, ReviewRecord[]>;
    approvals?: Record<string, ApprovalRecord[]>;
  },
  log: string[],
  calls: { updatedTasks: TaskRecord[]; updatedRuns: RunRecord[]; sealed: string[] }
): CloseRunDeps {
  return {
    getStatusSnapshot: async () => snapshot,
    getReviews: async (_r, taskId) => records.reviews?.[taskId] ?? [],
    getApprovals: async (_r, taskId) => records.approvals?.[taskId] ?? [],
    getReviewFloorReductions: async () => [],
    updateTask: async (t) => { calls.updatedTasks.push(t); },
    updateRun: async (r) => { calls.updatedRuns.push(r); },
    onRunSealed: async (runId) => { calls.sealed.push(runId); },
    now: () => "2026-06-30T12:00:00.000Z",
    writeLine: (l) => log.push(l)
  };
}

function fullProvenance(taskId: string) {
  return {
    reviews: {
      [taskId]: [
        review("reviewer", "orchestrator", "passed"),
        review("qa_engineer", "orchestrator", "passed"),
        review("security_reviewer", "orchestrator", "passed")
      ]
    },
    approvals: { [taskId]: [approval("orchestrator", "approved")] }
  };
}

test("reconcileRunClosure: dry-run performs no mutation and reports approved-but-not-closed", async () => {
  const snap = makeSnapshot([task("t1", "approved")]);
  const log: string[] = [];
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure("run-1", false, makeDeps(snap, fullProvenance("t1"), log, calls));

  assert.equal(result.applied, false);
  assert.equal(calls.updatedTasks.length, 0);
  assert.equal(calls.updatedRuns.length, 0);
  assert.ok(log.some((l) => l.includes("approved-but-not-closed: 1")));
});

test("reconcileRunClosure: --confirm advances closeable tasks and seals a fully-terminal run", async () => {
  const snap = makeSnapshot([task("t1", "approved")]);
  const log: string[] = [];
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure("run-1", true, makeDeps(snap, fullProvenance("t1"), log, calls));

  assert.equal(result.applied, true);
  assert.equal(result.sealedRun, true);
  assert.equal(calls.updatedTasks.length, 1);
  assert.equal(calls.updatedTasks[0]!.status, "done");
  assert.equal(calls.updatedRuns.length, 1);
  assert.equal(calls.updatedRuns[0]!.status, "done");
  assert.deepEqual(calls.sealed, ["run-1"]);
});

test("reconcileRunClosure: --confirm advances closeable tasks but does NOT seal when a non-terminal task remains", async () => {
  const snap = makeSnapshot([task("t1", "approved"), task("t2", "in_progress")]);
  const log: string[] = [];
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  // t1 has full provenance; t2 is in_progress.
  const records = {
    reviews: {
      t1: [
        review("reviewer", "orchestrator", "passed"),
        review("qa_engineer", "orchestrator", "passed"),
        review("security_reviewer", "orchestrator", "passed")
      ]
    },
    approvals: { t1: [approval("orchestrator", "approved")] }
  };
  const result = await reconcileRunClosure("run-1", true, makeDeps(snap, records, log, calls));

  assert.equal(result.applied, true);
  assert.equal(result.sealedRun, false, "a remaining non-terminal task must keep the run open");
  assert.deepEqual(calls.updatedTasks.map((t) => t.packet.taskId), ["t1"], "the closeable task is still advanced");
  assert.equal(calls.updatedRuns.length, 0);
});

test("reconcileRunClosure: --confirm seals a run whose tasks are ALL already done", async () => {
  const snap = makeSnapshot([task("t1", "done"), task("t2", "done")]);
  const log: string[] = [];
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const result = await reconcileRunClosure("run-1", true, makeDeps(snap, {}, log, calls));

  assert.equal(calls.updatedTasks.length, 0, "no task advance needed");
  assert.equal(result.sealedRun, true, "an all-done run (still in_progress) must be sealed");
  assert.equal(calls.updatedRuns[0]!.status, "done");
});

test("reconcileRunClosure: --confirm does NOT advance or seal a provenance-blocked approved task", async () => {
  const snap = makeSnapshot([task("t1", "approved")]);
  const log: string[] = [];
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  // Only reviewer passed → missing qa + security provenance.
  const records = {
    reviews: { t1: [review("reviewer", "orchestrator", "passed")] },
    approvals: { t1: [approval("orchestrator", "approved")] }
  };
  const result = await reconcileRunClosure("run-1", true, makeDeps(snap, records, log, calls));

  assert.equal(result.sealedRun, false);
  assert.equal(calls.updatedTasks.length, 0, "blocked task must not be advanced");
  assert.equal(calls.updatedRuns.length, 0, "run must not be sealed");
  assert.ok(log.some((l) => l.includes("BLOCKED")));
});

// ---------------------------------------------------------------------------
// reconcileAllRuns (batch, closeRunBatch)
// ---------------------------------------------------------------------------

test("reconcileAllRuns: --confirm seals every all-terminal run and skips runs with non-terminal tasks", async () => {
  // runA: all done → seals. runB: an in_progress task → not sealed.
  const snapshots: Record<string, RunStatusSnapshot> = {
    runA: makeSnapshot([task("a1", "done")]),
    runB: makeSnapshot([task("b1", "in_progress")])
  };
  snapshots.runA!.run.id = "runA";
  snapshots.runB!.run.id = "runB";
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const log: string[] = [];
  const deps: CloseRunDeps = {
    getStatusSnapshot: async (id) => snapshots[id]!,
    getReviews: async () => [],
    getApprovals: async () => [],
    getReviewFloorReductions: async () => [],
    updateTask: async (t) => { calls.updatedTasks.push(t); },
    updateRun: async (r) => { calls.updatedRuns.push(r); },
    onRunSealed: async (id) => { calls.sealed.push(id); },
    now: () => "2026-06-30T12:00:00.000Z",
    writeLine: (l) => log.push(l)
  };

  const result = await reconcileAllRuns(["runA", "runB"], true, deps);
  assert.equal(result.sealedCount, 1, "only the all-terminal run seals");
  assert.deepEqual(calls.updatedRuns.map((r) => r.id), ["runA"]);
  assert.deepEqual(calls.sealed, ["runA"]);
});

test("reconcileAllRuns: dry-run mutates nothing and reports seal-ready count", async () => {
  const snapshots: Record<string, RunStatusSnapshot> = { runA: makeSnapshot([task("a1", "done")]) };
  snapshots.runA!.run.id = "runA";
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const log: string[] = [];
  const deps: CloseRunDeps = {
    getStatusSnapshot: async (id) => snapshots[id]!,
    getReviews: async () => [], getApprovals: async () => [], getReviewFloorReductions: async () => [],
    updateTask: async (t) => { calls.updatedTasks.push(t); },
    updateRun: async (r) => { calls.updatedRuns.push(r); },
    onRunSealed: async (id) => { calls.sealed.push(id); },
    now: () => "2026-06-30T12:00:00.000Z",
    writeLine: (l) => log.push(l)
  };
  const result = await reconcileAllRuns(["runA"], false, deps);
  assert.equal(result.sealedCount, 0);
  assert.equal(calls.updatedRuns.length, 0);
  assert.ok(log.some((l) => l.includes("seal-ready")));
});

test("reconcileAllRuns: --confirm advances a provenance-verified approved task and counts it (advancedCount)", async () => {
  // A run with one approved task carrying full orchestrator provenance → closeable.
  const snap = makeSnapshot([task("a1", "approved")]);
  snap.run.id = "runP";
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const log: string[] = [];
  const fullProv = {
    reviews: {
      a1: [
        review("reviewer", "orchestrator", "passed"),
        review("qa_engineer", "orchestrator", "passed"),
        review("security_reviewer", "orchestrator", "passed")
      ]
    },
    approvals: { a1: [approval("orchestrator", "approved")] }
  };
  const deps: CloseRunDeps = {
    getStatusSnapshot: async () => snap,
    getReviews: async (_r, taskId) => (fullProv.reviews as Record<string, ReviewRecord[]>)[taskId] ?? [],
    getApprovals: async (_r, taskId) => (fullProv.approvals as Record<string, ApprovalRecord[]>)[taskId] ?? [],
    getReviewFloorReductions: async () => [],
    updateTask: async (t) => { calls.updatedTasks.push(t); },
    updateRun: async (r) => { calls.updatedRuns.push(r); },
    onRunSealed: async (id) => { calls.sealed.push(id); },
    now: () => "2026-06-30T12:00:00.000Z",
    writeLine: (l) => log.push(l)
  };

  const confirmed = await reconcileAllRuns(["runP"], true, deps);
  assert.equal(confirmed.advancedCount, 1, "the approved task is advanced and counted");
  assert.equal(confirmed.sealedCount, 1, "the run seals once its only task is done");
  assert.equal(calls.updatedTasks[0]!.status, "done");

  // Dry-run over the same run: advancedCount counts the closeable candidate, nothing mutates.
  const calls2 = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const dryDeps: CloseRunDeps = { ...deps, updateTask: async (t) => { calls2.updatedTasks.push(t); }, updateRun: async (r) => { calls2.updatedRuns.push(r); } };
  const dry = await reconcileAllRuns(["runP"], false, dryDeps);
  assert.equal(dry.advancedCount, 1, "dry-run counts the closeable candidate");
  assert.equal(dry.sealedCount, 0, "dry-run seals nothing");
  assert.equal(calls2.updatedTasks.length, 0, "dry-run mutates nothing");
});

test("reconcileAllRuns: an empty run list is a no-op", async () => {
  const calls = { updatedTasks: [] as TaskRecord[], updatedRuns: [] as RunRecord[], sealed: [] as string[] };
  const deps: CloseRunDeps = {
    getStatusSnapshot: async () => makeSnapshot([]),
    getReviews: async () => [], getApprovals: async () => [], getReviewFloorReductions: async () => [],
    updateTask: async (t) => { calls.updatedTasks.push(t); }, updateRun: async (r) => { calls.updatedRuns.push(r); },
    onRunSealed: async () => {}, now: () => "2026-06-30T12:00:00.000Z", writeLine: () => {}
  };
  const result = await reconcileAllRuns([], true, deps);
  assert.equal(result.advancedCount, 0);
  assert.equal(result.sealedCount, 0);
});

// ---------------------------------------------------------------------------
// buildClosureSignal — status command visibility (statusApprovedNotClosed)
// ---------------------------------------------------------------------------

test("buildClosureSignal: counts approved-but-not-closed tasks and lists their ids", async () => {
  const { buildClosureSignal } = await import("../src/core/closure-reconciler.ts");
  const signal = buildClosureSignal([
    { status: "approved", taskId: "a" },
    { status: "done", taskId: "b" },
    { status: "in_progress", taskId: "c" },
    { status: "approved", taskId: "d" }
  ]);
  assert.equal(signal.approvedNotClosed, 2);
  assert.deepEqual(signal.taskIds, ["a", "d"]);
  assert.equal(signal.authorityLabel, "derived_only");
  assert.match(signal.note, /close-run/);
});

test("buildClosureSignal: clean note when nothing is approved-but-unclosed", async () => {
  const { buildClosureSignal } = await import("../src/core/closure-reconciler.ts");
  const signal = buildClosureSignal([{ status: "done", taskId: "a" }, { status: "in_progress", taskId: "b" }]);
  assert.equal(signal.approvedNotClosed, 0);
  assert.deepEqual(signal.taskIds, []);
  assert.match(signal.note, /no approved-but-unclosed/);
});
