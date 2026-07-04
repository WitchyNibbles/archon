/**
 * Direct unit tests for StatusExecutionPlanner (src/core/status-execution-planner.ts).
 *
 * This module was extracted from ArchonCoreService (audit F5 / service.ts split
 * slice 3). These tests exercise the planner class DIRECTLY against a MemoryStore
 * double + injected deps (requireRun / findTaskBlockers / inspectRecovery), so a
 * logic drift in status derivation, routing, or execution-plan directive
 * selection fails here rather than only through the service-level suites.
 *
 * Coverage targets the cold paths the service-level suites don't isolate:
 *   - getStatus: the enabled-gating guard (autonomousExecution present only when
 *     persisted state is enabled) that ArchonCoreService.getRuntimeTraceRegistry
 *     depends on, plus nextTaskIds = ready ∧ unblocked.
 *   - recommendRouting: owner_dispatch / wait / injected-blocker branches.
 *   - getExecutionPlan: apply_recovery precedence, dispatch_owner, and the
 *     terminal blocked ("run has no task graph") fallthrough.
 *   - resumeRun: snapshot ∪ executionPlan.
 *
 * Seeding uses the already-tested TaskLifecycleManager on the SAME store so the
 * planner reads real persisted runtime state rather than hand-built fixtures.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { StatusExecutionPlanner } from "../src/core/status-execution-planner.ts";
import { TaskLifecycleManager } from "../src/core/task-lifecycle.ts";
import { AutonomousExecutionStore } from "../src/core/autonomous-execution-store.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import type { ArchonStore } from "../src/store/types.ts";
import type {
  LockRecord,
  RecoveryInspectionReport,
  RunRecord,
  TaskPacketInput,
  TaskRecord
} from "../src/domain/types.ts";

interface Harness {
  store: ArchonStore;
  planner: StatusExecutionPlanner;
  lifecycle: TaskLifecycleManager;
  autonomous: AutonomousExecutionStore;
  blockersRef: { value: string[] };
  recoveryRef: { value: RecoveryInspectionReport | undefined };
}

function emptyRecovery(runId: string): RecoveryInspectionReport {
  return {
    mode: "advisory_only",
    runId,
    staleAfterHours: 24,
    issues: [],
    actions: [],
    summary: {
      totalIssues: 0,
      safeActions: 0,
      blockedTasks: [],
      staleTaskIds: [],
      orphanLockTaskIds: []
    }
  };
}

function makeHarness(): Harness {
  const store = new MemoryStore();
  const requireRun = async (runId: string): Promise<RunRecord> => {
    const found = await store.getRun(runId);
    if (!found) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return found;
  };
  const requireTask = async (runId: string, taskId: string): Promise<TaskRecord> => {
    const found = await store.getTask(runId, taskId);
    if (!found) {
      throw new Error(`Unknown task ${taskId} for run ${runId}`);
    }
    return found;
  };
  const autonomous = new AutonomousExecutionStore({ store, requireRun });
  const blockersRef: { value: string[] } = { value: [] };
  const recoveryRef: { value: RecoveryInspectionReport | undefined } = { value: undefined };
  const findTaskBlockers = async (
    _task: TaskRecord,
    _allTasks: readonly TaskRecord[],
    _activeLocks: readonly LockRecord[]
  ): Promise<string[]> => blockersRef.value;

  const lifecycle = new TaskLifecycleManager({
    store,
    requireRun,
    requireTask,
    findTaskBlockers,
    saveAutonomousExecutionState: (run, update) => autonomous.saveState(run, update)
  });

  const planner = new StatusExecutionPlanner({
    store,
    requireRun,
    findTaskBlockers,
    inspectRecovery: async (runId) => recoveryRef.value ?? emptyRecovery(runId)
  });

  return { store, planner, lifecycle, autonomous, blockersRef, recoveryRef };
}

function makePacket(overrides: Partial<TaskPacketInput> & { taskId: string }): TaskPacketInput {
  return {
    title: `Task ${overrides.taskId}`,
    ownerRole: "backend_engineer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["backend_engineer"],
    qualityGates: ["product_acceptance"],
    goal: "test goal",
    inputs: [],
    outputs: [],
    dependencies: [],
    allowedWriteScope: ["src/"],
    outOfScope: [],
    acceptanceCriteria: ["passes tests"],
    verificationSteps: ["npm test"],
    securityChecks: ["validate inputs"],
    antiPatterns: ["no hardcoded secrets"],
    rollbackNotes: "revert to previous state",
    handoffFormat: "summary only",
    requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"],
    // Legacy reasoning mode keeps assessTaskPacketReasoning warning-only (no
    // blockers), so these tests exercise the planner's routing/directive logic
    // rather than the reasoning-quality gate (covered by its own suite).
    reasoningPolicy: { mode: "legacy" },
    ...overrides
  };
}

async function seedRun(lifecycle: TaskLifecycleManager, slug: string): Promise<string> {
  const run = await lifecycle.intakeRequest({
    workspaceSlug: `ws-${slug}`,
    projectSlug: `proj-${slug}`,
    actor: "manager",
    title: `planner test run ${slug}`,
    request: "exercise the extracted status/execution planner directly"
  });
  return run.id;
}

// ────────────────────────────────────────────────────────────────────────────
// getStatus — enabled-gating + nextTaskIds
// ────────────────────────────────────────────────────────────────────────────

test("getStatus: no autonomous state → autonomousExecution is undefined", async () => {
  const { planner, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "nostate");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  const snapshot = await planner.getStatus(runId);
  assert.equal(snapshot.autonomousExecution, undefined, "no snapshot when state is absent");
  assert.deepEqual(snapshot.nextTaskIds, ["task-a"], "ready + unblocked task is next");
});

test("getStatus: an enabled autonomous gate → autonomousExecution snapshot is present", async () => {
  // This is the enabled-gating guard getRuntimeTraceRegistry depends on: the
  // snapshot exists ONLY because state.enabled is true.
  const { planner, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "autogate");
  await lifecycle.createTaskGraph(runId, [
    makePacket({ taskId: "task-auto", qualityGates: ["coverage_ledger_required"] })
  ]);

  const snapshot = await planner.getStatus(runId);
  assert.ok(snapshot.autonomousExecution, "enabled autonomous state yields a snapshot");
  assert.equal(snapshot.autonomousExecution?.state.enabled, true);
});

test("getStatus: an injected blocker removes a ready task from nextTaskIds", async () => {
  const { planner, lifecycle, blockersRef } = makeHarness();
  const runId = await seedRun(lifecycle, "blocked");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  blockersRef.value = ["dependency task-x not approved"];
  const snapshot = await planner.getStatus(runId);
  assert.deepEqual(snapshot.nextTaskIds, [], "blocked ready task is not a next task");
  assert.ok(snapshot.blockers.includes("dependency task-x not approved"));
});

// ────────────────────────────────────────────────────────────────────────────
// recommendRouting
// ────────────────────────────────────────────────────────────────────────────

test("recommendRouting: a ready unblocked task yields an owner_dispatch recommendation", async () => {
  const { planner, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "route-owner");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  const report = await planner.recommendRouting(runId);
  assert.equal(report.mode, "advisory_only");
  assert.equal(report.recommendations.length, 1);
  assert.equal(report.recommendations[0]?.recommendation, "owner_dispatch");
  assert.equal(report.recommendations[0]?.targetRole, "backend_engineer");
});

test("recommendRouting: an in_progress task yields a wait recommendation", async () => {
  const { planner, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "route-wait");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);
  await lifecycle.claimTask(runId, "task-a", "backend_engineer");

  const report = await planner.recommendRouting(runId);
  assert.equal(report.recommendations[0]?.recommendation, "wait");
  assert.match(report.recommendations[0]?.rationale.join(" ") ?? "", /already claimed by backend_engineer/);
});

test("recommendRouting: an injected blocker on a ready task yields wait with the blocker", async () => {
  const { planner, lifecycle, blockersRef } = makeHarness();
  const runId = await seedRun(lifecycle, "route-block");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  blockersRef.value = ["dependency task-x not approved"];
  const report = await planner.recommendRouting(runId);
  assert.equal(report.recommendations[0]?.recommendation, "wait");
  assert.ok(report.recommendations[0]?.blockers.includes("dependency task-x not approved"));
});

// ────────────────────────────────────────────────────────────────────────────
// getExecutionPlan — directive selection
// ────────────────────────────────────────────────────────────────────────────

test("getExecutionPlan: a ready task yields a dispatch_owner directive", async () => {
  const { planner, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "plan-owner");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  const plan = await planner.getExecutionPlan(runId);
  assert.equal(plan.mode, "runtime_authoritative");
  assert.equal(plan.directive.kind, "dispatch_owner");
});

test("getExecutionPlan: a run with no task graph is blocked with 'run has no task graph'", async () => {
  const { planner, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "plan-empty");

  const plan = await planner.getExecutionPlan(runId);
  assert.equal(plan.directive.kind, "blocked");
  assert.ok(
    plan.directive.kind === "blocked" && plan.directive.blockers.includes("run has no task graph"),
    "empty task graph surfaces the no-task-graph blocker"
  );
});

test("getExecutionPlan: a safe recovery action takes precedence over routing", async () => {
  const { planner, lifecycle, recoveryRef } = makeHarness();
  const runId = await seedRun(lifecycle, "plan-recovery");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  recoveryRef.value = {
    ...emptyRecovery(runId),
    actions: [
      {
        id: "action-1",
        authorityLabel: "derived_only",
        kind: "release_orphan_lock",
        safeToApply: true,
        rationale: ["orphaned lock detected"]
      }
    ]
  };

  const plan = await planner.getExecutionPlan(runId);
  assert.equal(plan.directive.kind, "apply_recovery", "safe recovery outranks dispatch_owner");
});

// ────────────────────────────────────────────────────────────────────────────
// resumeRun
// ────────────────────────────────────────────────────────────────────────────

test("resumeRun: returns the status snapshot plus a derived execution plan", async () => {
  const { planner, lifecycle } = makeHarness();
  const runId = await seedRun(lifecycle, "resume");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  const resume = await planner.resumeRun(runId);
  assert.equal(resume.run.id, runId, "snapshot fields present");
  assert.equal(resume.executionPlan.directive.kind, "dispatch_owner", "execution plan attached");
});
