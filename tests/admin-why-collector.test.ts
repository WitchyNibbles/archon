import test from "node:test";
import assert from "node:assert/strict";

import { collectStallSignals, type WhyCollectDeps } from "../src/admin/why.ts";
import type { OperatorStatusReport } from "../src/admin/status.ts";
import type {
  ApprovalRecord,
  ProjectRuntimeStateRecord,
  ReviewRecord,
  RunStatusSnapshot,
  TaskRecord
} from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Fixtures — the collector's job is to map store records → normalized signals.
// These doubles exercise that mapping (closure/council/retro/respawn/sidecar)
// so the ranking layer receives correct inputs.
// ---------------------------------------------------------------------------

function taskRecord(overrides: {
  taskId: string;
  status: TaskRecord["status"];
  requiredReviews?: TaskRecord["packet"]["requiredReviews"];
  qualityGates?: TaskRecord["packet"]["qualityGates"];
  councilOutcome?: string | undefined;
  retroOutcome?: string | undefined;
}): TaskRecord {
  return {
    id: `id-${overrides.taskId}`,
    runId: "run-1",
    workspaceId: "workspace:w",
    projectId: "project:w:p",
    class: "delivery",
    status: overrides.status,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    packet: {
      taskId: overrides.taskId,
      title: overrides.taskId,
      ownerRole: "backend_engineer",
      completionStandard: "production_ready",
      requiredSpecialistRoles: [],
      qualityGates: overrides.qualityGates ?? [],
      goal: "g",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope: [],
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews: overrides.requiredReviews ?? ["reviewer", "security_reviewer", "qa_engineer"],
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: "",
      councilOutcome: overrides.councilOutcome,
      retroOutcome: overrides.retroOutcome
    } as TaskRecord["packet"]
  };
}

function snapshot(tasks: TaskRecord[]): RunStatusSnapshot {
  return {
    run: {
      id: "run-1",
      workspaceId: "workspace:w",
      projectId: "project:w:p",
      actor: "orchestrator",
      title: "t",
      request: "r",
      summary: { goal: "g", constraints: [], risks: [], successCriteria: [] } as RunStatusSnapshot["run"]["summary"],
      status: "in_progress",
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z"
    },
    tasks,
    activeLocks: [],
    blockers: [],
    nextTaskIds: []
  };
}

function report(): OperatorStatusReport {
  return {
    run: {
      authorityLabel: "runtime_authoritative",
      id: "run-1",
      status: "in_progress",
      actor: "orchestrator",
      updatedAt: "2026-07-05T00:00:00.000Z",
      taskCounts: { ready: 0, in_progress: 0, review_blocked: 0, approved: 1, done: 0, blocked: 0 }
    },
    tasks: { authorityLabel: "runtime_authoritative", byStatus: {} as never, activeLocks: [] },
    orchestration: { authorityLabel: "derived_only", blockers: [], nextTaskIds: [], freshness: {} as never },
    autonomous: {} as never,
    traceRegistry: { authorityLabel: "derived_only", summary: undefined },
    compaction: { authorityLabel: "runtime_authoritative", status: "missing", sourceRefs: [] },
    evalPosture: {
      authorityLabel: "runtime_authoritative",
      status: "missing",
      labels: [],
      repoLocalLabels: [],
      broaderEvidenceLabels: [],
      artifactRefs: [],
      boundarySummary: ""
    },
    reviewControls: { authorityLabel: "runtime_authoritative", status: "missing", controls: [] },
    daemon: { authorityLabel: "derived_only" },
    reviewIdentity: {} as never,
    graphify: {} as never,
    integrity: { authorityLabel: "derived_only", status: "consistent", contradictions: [] }
  } as OperatorStatusReport;
}

function deps(overrides: Partial<WhyCollectDeps> & { snapshot: RunStatusSnapshot }): WhyCollectDeps {
  return {
    now: "2026-07-05T00:00:00.000Z",
    scope: {},
    report: report(),
    runtimeState: undefined,
    getReviews: async () => [],
    getApprovals: async () => [],
    getReviewFloorReductions: async () => [],
    readLeaseOwner: async () => undefined,
    respawnBudget: 8,
    getOrphanInputs: async () => ({ tasks: [], reviewCounts: [], approvalCounts: [] }),
    readContextGuard: async () => undefined,
    readHookBlocker: async () => undefined,
    ...overrides
  };
}

// ---------------------------------------------------------------------------

test("collector: approved task with no passed reviews → missing_review block w/ all roles", async () => {
  const task = taskRecord({ taskId: "t1", status: "approved" });
  const signals = await collectStallSignals(deps({ snapshot: snapshot([task]) }));
  assert.deepEqual(signals.closureBlocks, [
    { taskId: "t1", kind: "missing_review", missingRoles: ["reviewer", "security_reviewer", "qa_engineer"] }
  ]);
});

test("collector: approved task with all reviews but no approval → missing_approval block", async () => {
  const task = taskRecord({ taskId: "t1", status: "approved" });
  const reviews: ReviewRecord[] = (["reviewer", "security_reviewer", "qa_engineer"] as const).map((role) => ({
    id: `rv-${role}`,
    runId: "run-1",
    taskId: "t1",
    reviewerRole: role,
    actor: "o",
    actorRole: "reviewer",
    source: "orchestrator",
    state: "passed",
    severity: "low",
    findings: [],
    createdAt: "2026-07-05T00:00:00.000Z"
  }));
  const signals = await collectStallSignals(
    deps({ snapshot: snapshot([task]), getReviews: async () => reviews })
  );
  assert.deepEqual(signals.closureBlocks, [{ taskId: "t1", kind: "missing_approval", missingRoles: [] }]);
});

test("collector: fully-provenanced approved task → no closure block, seal-ready w/o retro → retroSealBlocked", async () => {
  const task = taskRecord({ taskId: "t1", status: "approved" });
  const reviews: ReviewRecord[] = (["reviewer", "security_reviewer", "qa_engineer"] as const).map((role) => ({
    id: `rv-${role}`,
    runId: "run-1",
    taskId: "t1",
    reviewerRole: role,
    actor: "o",
    actorRole: "reviewer",
    source: "orchestrator",
    state: "passed",
    severity: "low",
    findings: [],
    createdAt: "2026-07-05T00:00:00.000Z"
  }));
  const approvals: ApprovalRecord[] = [
    {
      id: "ap-1",
      runId: "run-1",
      taskId: "t1",
      actor: "o",
      actorRole: "reviewer",
      source: "orchestrator",
      decision: "approved",
      rationale: "ok",
      createdAt: "2026-07-05T00:00:00.000Z"
    }
  ];
  const signals = await collectStallSignals(
    deps({ snapshot: snapshot([task]), getReviews: async () => reviews, getApprovals: async () => approvals })
  );
  assert.equal(signals.closureBlocks, undefined);
  assert.equal(signals.retroSealBlocked, true, "seal-ready but no retro recorded");
});

test("collector: recorded retro on a sealable run → retroSealBlocked false", async () => {
  const task = taskRecord({ taskId: "t1", status: "done", retroOutcome: "memory_promoted" });
  const signals = await collectStallSignals(deps({ snapshot: snapshot([task]) }));
  assert.equal(signals.retroSealBlocked, false);
});

test("collector: council gate required + unset outcome → council signal", async () => {
  const task = taskRecord({
    taskId: "t1",
    status: "in_progress",
    qualityGates: ["council_review_required"]
  });
  const signals = await collectStallSignals(deps({ snapshot: snapshot([task]) }));
  assert.deepEqual(signals.councilGates, [{ taskId: "t1", outcome: undefined }]);
});

test("collector: council gate required + approved outcome → NOT reported", async () => {
  const task = taskRecord({
    taskId: "t1",
    status: "in_progress",
    qualityGates: ["council_review_required"],
    councilOutcome: "approved_with_conditions"
  });
  const signals = await collectStallSignals(deps({ snapshot: snapshot([task]) }));
  assert.equal(signals.councilGates, undefined);
});

test("collector: respawn count/budget derived from archonDaemon meta scoped to active task", async () => {
  const runtimeState = {
    projectId: "project:w:p",
    workspaceId: "workspace:w",
    activeTaskId: "t1",
    taskQueue: { project_status: "in_progress", current_task_id: "t1", tasks: [] },
    productState: {},
    metadata: { archonDaemon: { respawnCount: 8, respawnTaskId: "t1", updatedAt: "x" } },
    createdAt: "x",
    updatedAt: "x"
  } as unknown as ProjectRuntimeStateRecord;
  const signals = await collectStallSignals(
    deps({ snapshot: snapshot([taskRecord({ taskId: "t1", status: "in_progress" })]), runtimeState })
  );
  assert.equal(signals.respawn?.count, 8);
  assert.equal(signals.respawn?.budget, 8);
});

test("collector: stale respawn counter (respawnTaskId != active) → effective count 0", async () => {
  const runtimeState = {
    projectId: "project:w:p",
    workspaceId: "workspace:w",
    activeTaskId: "t2",
    taskQueue: { project_status: "in_progress", current_task_id: "t2", tasks: [] },
    productState: {},
    metadata: { archonDaemon: { respawnCount: 8, respawnTaskId: "t1", updatedAt: "x" } },
    createdAt: "x",
    updatedAt: "x"
  } as unknown as ProjectRuntimeStateRecord;
  const signals = await collectStallSignals(
    deps({ snapshot: snapshot([taskRecord({ taskId: "t2", status: "in_progress" })]), runtimeState })
  );
  assert.equal(signals.respawn?.count, 0, "counter for a different task must not count");
});

test("collector: lease held → leaseHeld true with owner", async () => {
  const signals = await collectStallSignals(
    deps({
      snapshot: snapshot([taskRecord({ taskId: "t1", status: "in_progress" })]),
      readLeaseOwner: async () => "daemon-A"
    })
  );
  assert.equal(signals.respawn?.leaseHeld, true);
  assert.equal(signals.respawn?.leaseOwner, "daemon-A");
});

test("collector: orphan candidates grouped by task_key → duplicateRuns", async () => {
  const signals = await collectStallSignals(
    deps({
      snapshot: snapshot([taskRecord({ taskId: "t1", status: "in_progress" })]),
      getOrphanInputs: async () => ({
        // Two rows for task_key "t1": one sealed twin (3 roles + 1 approval),
        // one bare orphan (0/0) → the orphan is a prune candidate.
        tasks: [
          { id: "a", run_id: "run-sealed", task_key: "t1", status: "done" },
          { id: "b", run_id: "run-orphan", task_key: "t1", status: "ready" }
        ],
        reviewCounts: [{ run_id: "run-sealed", task_key: "t1", distinct_passed_roles: 3 }],
        approvalCounts: [{ run_id: "run-sealed", task_key: "t1", approval_count: 1 }]
      })
    })
  );
  assert.deepEqual(signals.duplicateRuns, [{ taskKey: "t1", runIds: ["run-orphan"] }]);
});

test("collector: no orphan twins → duplicateRuns undefined", async () => {
  const signals = await collectStallSignals(
    deps({ snapshot: snapshot([taskRecord({ taskId: "t1", status: "in_progress" })]) })
  );
  assert.equal(signals.duplicateRuns, undefined);
});

test("collector: sidecar readers wired through (hook blocker + context guard)", async () => {
  const signals = await collectStallSignals(
    deps({
      snapshot: snapshot([taskRecord({ taskId: "t1", status: "in_progress" })]),
      readHookBlocker: async () => ({
        taskId: "t1",
        blockerKind: "runtime_preflight",
        command: "npm test",
        summary: "failed"
      }),
      readContextGuard: async () => ({ state: "handoff_written", taskId: "t1", invocationId: "inv-1" })
    })
  );
  assert.equal(signals.sidecars.hookBlocker?.blockerKind, "runtime_preflight");
  assert.equal(signals.sidecars.contextGuard?.state, "handoff_written");
});

test("collector: owner work = ready/in_progress tasks (advisory)", async () => {
  const signals = await collectStallSignals(
    deps({
      snapshot: snapshot([
        taskRecord({ taskId: "t1", status: "in_progress" }),
        taskRecord({ taskId: "t2", status: "done" })
      ])
    })
  );
  assert.deepEqual(signals.ownerWork, { directiveKind: "dispatch_owner", taskIds: ["t1"] });
});
