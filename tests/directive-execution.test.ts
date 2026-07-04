/**
 * Direct unit tests for DirectiveExecutionManager (src/core/directive-execution.ts).
 *
 * This module was extracted from ArchonCoreService (audit F5 / service.ts split
 * slice 3). These tests drive the manager DIRECTLY against a MemoryStore double +
 * injected deps (requireRun / claimTask / getStatus / getExecutionPlan), so a
 * drift in the runtime-authority guard, the directive dispatch loop, or the
 * loop-history read/write round trip fails here rather than only through the
 * daemon/service suites.
 *
 * Coverage targets the cold paths the higher-level suites don't isolate:
 *   - ensureDirectiveExecutionAuthority: missing runtime registration and
 *     non-active run both fail closed BEFORE any state mutation.
 *   - executeDirectiveStep: dispatch_owner happy path (claims via injected
 *     claimTask, records an "executed" step), and the blocked directive path.
 *   - persistLoopExecutionHistory → getLoopExecutionHistory round trip.
 *   - getLoopExecutionHistory: the malformed-id guard returns [].
 *
 * getStatus/getExecutionPlan/claimTask are wired to the REAL extracted planner
 * and lifecycle manager on the SAME store, so the loop reads authoritative
 * runtime state end to end rather than mocked plans.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DirectiveExecutionManager } from "../src/core/directive-execution.ts";
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
  director: DirectiveExecutionManager;
  lifecycle: TaskLifecycleManager;
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
  const findTaskBlockers = async (
    _task: TaskRecord,
    _allTasks: readonly TaskRecord[],
    _activeLocks: readonly LockRecord[]
  ): Promise<string[]> => [];

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
    inspectRecovery: async (runId) => emptyRecovery(runId)
  });

  const director = new DirectiveExecutionManager({
    store,
    requireRun,
    claimTask: (runId, taskId, actor) => lifecycle.claimTask(runId, taskId, actor),
    getStatus: (runId) => planner.getStatus(runId),
    getExecutionPlan: (runId, options) => planner.getExecutionPlan(runId, options)
  });

  return { store, director, lifecycle };
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
    // blockers), so a ready task routes to dispatch_owner rather than being held
    // by strict reasoning-quality blockers (covered by its own suite).
    reasoningPolicy: { mode: "legacy" },
    ...overrides
  };
}

async function seedActiveRun(
  store: ArchonStore,
  lifecycle: TaskLifecycleManager,
  slug: string
): Promise<{ runId: string; projectId: string }> {
  const run = await lifecycle.intakeRequest({
    workspaceSlug: `ws-${slug}`,
    projectSlug: `proj-${slug}`,
    actor: "manager",
    title: `directive test run ${slug}`,
    request: "exercise the extracted directive-execution manager directly"
  });
  // intakeRequest already sets activeRunId = run.id; add the runtime registration
  // that ensureDirectiveExecutionAuthority requires.
  const now = new Date().toISOString();
  await store.saveProjectRuntimeRegistration({
    projectId: run.projectId,
    workspaceId: run.workspaceId,
    repoPath: `/tmp/${slug}`,
    runtimeProfile: "default",
    dataRoot: `/tmp/${slug}/.archon`,
    manifest: {},
    provenance: {},
    createdAt: now,
    updatedAt: now
  });
  return { runId: run.id, projectId: run.projectId };
}

// ────────────────────────────────────────────────────────────────────────────
// ensureDirectiveExecutionAuthority — fail-closed guards
// ────────────────────────────────────────────────────────────────────────────

test("executeDirectiveStep: rejects when the project has no runtime registration", async () => {
  const { director, lifecycle } = makeHarness();
  // Seed a run WITHOUT saving a runtime registration.
  const run = await lifecycle.intakeRequest({
    workspaceSlug: "ws-noreg",
    projectSlug: "proj-noreg",
    actor: "manager",
    title: "no registration run",
    request: "no registration"
  });
  await lifecycle.createTaskGraph(run.id, [makePacket({ taskId: "task-a" })]);

  await assert.rejects(
    () => director.executeDirectiveStep(run.id),
    /requires runtime registration/
  );
});

test("executeDirectiveStep: rejects when the target run is not the active runtime run", async () => {
  const { store, director, lifecycle } = makeHarness();
  const { runId, projectId } = await seedActiveRun(store, lifecycle, "notactive");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  // Point the active run pointer at a different run id.
  const runtimeState = await store.getProjectRuntimeState(projectId);
  await store.saveProjectRuntimeState({
    ...runtimeState!,
    activeRunId: "some-other-run",
    updatedAt: new Date().toISOString()
  });

  await assert.rejects(
    () => director.executeDirectiveStep(runId),
    /active authoritative runtime run/
  );
});

// ────────────────────────────────────────────────────────────────────────────
// executeDirectiveStep — dispatch + loop history
// ────────────────────────────────────────────────────────────────────────────

test("executeDirectiveStep: dispatch_owner claims the task and records an executed step", async () => {
  const { store, director, lifecycle } = makeHarness();
  const { runId } = await seedActiveRun(store, lifecycle, "dispatch");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  const result = await director.executeDirectiveStep(runId, { ownerActor: "backend_engineer" });

  assert.equal(result.initialPlan.directive.kind, "dispatch_owner");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.directiveKind, "dispatch_owner");
  assert.equal(result.steps[0]?.outcome, "executed");
  assert.equal(result.steps[0]?.taskId, "task-a");
  assert.equal(result.steps[0]?.actor, "backend_engineer");

  // The task was actually claimed via the injected lifecycle.claimTask.
  const task = await store.getTask(runId, "task-a");
  assert.equal(task?.status, "in_progress");
  assert.equal(task?.claimedBy, "backend_engineer");
});

test("executeDirectiveStep: a run with no task graph records a blocked step", async () => {
  const { store, director, lifecycle } = makeHarness();
  const { runId } = await seedActiveRun(store, lifecycle, "noplan");

  const result = await director.executeDirectiveStep(runId);
  assert.equal(result.initialPlan.directive.kind, "blocked");
  assert.equal(result.steps[0]?.outcome, "blocked");
});

test("executeDirectiveStep → getLoopExecutionHistory: the step is persisted and read back", async () => {
  const { store, director, lifecycle } = makeHarness();
  const { runId } = await seedActiveRun(store, lifecycle, "history");
  await lifecycle.createTaskGraph(runId, [makePacket({ taskId: "task-a" })]);

  await director.executeDirectiveStep(runId, { ownerActor: "backend_engineer" });

  const history = await director.getLoopExecutionHistory(runId);
  assert.ok(history.length >= 1, "at least one loop-history entry was persisted and retrieved");
  assert.ok(
    history.every((entry) => entry.provenance.runId === runId),
    "every retrieved entry is scoped to the run"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// getLoopExecutionHistory — malformed-id guard
// ────────────────────────────────────────────────────────────────────────────

test("getLoopExecutionHistory: returns [] when the run's workspace id is not parseable", async () => {
  const { store, director, lifecycle } = makeHarness();
  // Seed a real run to borrow a valid IntakeSummary, then persist a copy whose
  // workspace/project ids are NOT in the "workspace:"/"project:" form the parser
  // expects — that is the short-circuit branch under test.
  const seed = await lifecycle.intakeRequest({
    workspaceSlug: "ws-parse",
    projectSlug: "proj-parse",
    actor: "manager",
    title: "seed for malformed clone",
    request: "seed"
  });
  const seedRun = await store.getRun(seed.id);
  await store.createRun({
    ...seedRun!,
    id: "run-malformed",
    workspaceId: "bogus-workspace-id",
    projectId: "bogus-project-id"
  });

  const history = await director.getLoopExecutionHistory("run-malformed");
  assert.deepEqual(history, [], "unparseable workspace/project ids short-circuit to []");
});
