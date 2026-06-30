import test from "node:test";
import assert from "node:assert/strict";

import {
  planRunClosure,
  buildTaskEvidence,
  countApprovedNotClosed,
  type ClosureTaskEvidence
} from "../src/core/closure-reconciler.ts";
import { reconcileRunClosure, type CloseRunDeps } from "../src/admin/close-run.ts";
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

function task(taskId: string, status: string, requiredReviews: string[] = ["reviewer", "qa_engineer", "security_reviewer"]): TaskRecord {
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
      handoffFormat: ""
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
