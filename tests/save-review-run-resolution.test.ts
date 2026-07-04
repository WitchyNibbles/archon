/**
 * Tests for save-review, save-approval wrong-run resolution and scope guards.
 *
 * Covers:
 *   - Run resolved from task (not project activeRunId)
 *   - --run-id override scope validation (cross-project write rejected)
 *   - findLatestRunForTask status-priority: in_progress preferred over sealed
 */

import test from "node:test";
import assert from "node:assert/strict";
import { saveReviewCommand, saveApprovalCommand } from "../src/review.ts";
import { MemoryStore } from "../src/store/memory-store.ts";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-uuid",
    runId: "run-a",
    workspaceId: "ws1",
    projectId: "p1",
    status: "in_progress" as const,
    claimedBy: "manager",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    packet: {
      taskId: "myTask",
      title: "My task",
      ownerRole: "backend_engineer" as const,
      completionStandard: "artifact_complete" as const,
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
      requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"] as const,
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: ""
    },
    ...overrides
  };
}

const commonEnv = {
  ARCHON_WORKSPACE_SLUG: "default",
  ARCHON_PROJECT_SLUG: "archon"
};

// Expected IDs derived from commonEnv
const EXPECTED_WORKSPACE_ID = "workspace:default";
const EXPECTED_PROJECT_ID = "project:default:archon";

// ---------------------------------------------------------------------------
// save-review: wrong-run write with two runs
// ---------------------------------------------------------------------------

test("save-review: writes to task-run (run-A) not active-run (run-B) when they differ", async () => {
  let capturedRunId: string | undefined = undefined;

  const fakeStore = {
    // Task lives in run-A; active run is run-B (already advanced)
    findLatestRunForTask: async (params: { workspaceSlug: string; projectSlug: string; taskId: string }) => {
      assert.equal(params.taskId, "myTask");
      // Return run-A (the task's run)
      return { id: "run-a" };
    },
    saveOrchestratorReview: async (input: Record<string, unknown>) => {
      capturedRunId = input["runId"] as string | undefined;
    },
    getRun: async () => { throw new Error("getRun should not be called when using findLatestRunForTask path"); }
  };

  await saveReviewCommand(
    ["--task-id", "myTask", "--role", "reviewer", "--outcome", "passed", "--source", "orchestrator"],
    { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
  );

  assert.equal(capturedRunId, "run-a", "review must be written to run-A (task's own run), not run-B");
});

test("save-review: uses --run-id override when provided and run belongs to correct workspace/project", async () => {
  let capturedRunId: string | undefined = undefined;

  const fakeStore = {
    findLatestRunForTask: async () => {
      throw new Error("findLatestRunForTask should not be called when --run-id is provided");
    },
    getRun: async (runId: string) => {
      assert.equal(runId, "explicit-run-x");
      return { id: runId, workspaceId: EXPECTED_WORKSPACE_ID, projectId: EXPECTED_PROJECT_ID };
    },
    saveOrchestratorReview: async (input: Record<string, unknown>) => {
      capturedRunId = input["runId"] as string | undefined;
    }
  };

  await saveReviewCommand(
    [
      "--task-id", "myTask",
      "--role", "reviewer",
      "--outcome", "passed",
      "--source", "orchestrator",
      "--run-id", "explicit-run-x"
    ],
    { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
  );

  assert.equal(capturedRunId, "explicit-run-x", "review must use the --run-id override");
});

test("save-review: rejects --run-id from a different workspace/project", async () => {
  const fakeStore = {
    findLatestRunForTask: async () => {
      throw new Error("findLatestRunForTask should not be called when --run-id is provided");
    },
    getRun: async (runId: string) => ({
      id: runId,
      workspaceId: "workspace:other-workspace",
      projectId: "project:other-workspace:other-project"
    }),
    saveOrchestratorReview: async () => {
      throw new Error("saveOrchestratorReview must not be called for cross-project run");
    }
  };

  await assert.rejects(
    () =>
      saveReviewCommand(
        [
          "--task-id", "myTask",
          "--role", "reviewer",
          "--outcome", "passed",
          "--source", "orchestrator",
          "--run-id", "foreign-run"
        ],
        { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
      ),
    /does not belong to|refusing cross-project/i
  );
});

test("save-review: rejects --run-id when run is not found", async () => {
  const fakeStore = {
    findLatestRunForTask: async () => {
      throw new Error("findLatestRunForTask should not be called");
    },
    getRun: async () => undefined,
    saveOrchestratorReview: async () => {
      throw new Error("saveOrchestratorReview must not be called");
    }
  };

  await assert.rejects(
    () =>
      saveReviewCommand(
        [
          "--task-id", "myTask",
          "--role", "reviewer",
          "--outcome", "passed",
          "--source", "orchestrator",
          "--run-id", "nonexistent-run"
        ],
        { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
      ),
    /not found/i
  );
});

test("save-review: throws when task not found in any run", async () => {
  const fakeStore = {
    findLatestRunForTask: async () => undefined,
    getRun: async () => { throw new Error("getRun should not be called in findLatestRunForTask path"); },
    saveOrchestratorReview: async () => { throw new Error("should not reach saveOrchestratorReview"); }
  };

  await assert.rejects(
    () =>
      saveReviewCommand(
        ["--task-id", "unknownTask", "--role", "reviewer", "--outcome", "passed", "--source", "orchestrator"],
        { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
      ),
    /not found in any run/i
  );
});

// ---------------------------------------------------------------------------
// save-approval: wrong-run resolution with two runs
// ---------------------------------------------------------------------------

test("save-approval: resolves run from task (run-A) not from activeRunId (run-B)", async () => {
  const task = makeTask();
  const reviews = [
    {
      id: "r1", runId: "run-a", taskId: "myTask",
      reviewerRole: "reviewer" as const, actorRole: "reviewer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-07-04T00:00:00.000Z"
    },
    {
      id: "r2", runId: "run-a", taskId: "myTask",
      reviewerRole: "qa_engineer" as const, actorRole: "qa_engineer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-07-04T00:00:00.000Z"
    },
    {
      id: "r3", runId: "run-a", taskId: "myTask",
      reviewerRole: "security_reviewer" as const, actorRole: "security_reviewer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-07-04T00:00:00.000Z"
    }
  ];

  let savedApprovalRunId: string | undefined = undefined;

  const fakeStore = {
    // Task lives in run-A; active run would have been run-B (already advanced)
    findLatestRunForTask: async (params: { workspaceSlug: string; projectSlug: string; taskId: string }) => {
      assert.equal(params.taskId, "myTask");
      return { id: "run-a" };
    },
    getRun: async () => { throw new Error("getRun should not be called when using findLatestRunForTask path"); },
    getTasksByRun: async (runId: string) => {
      assert.equal(runId, "run-a", "getTasksByRun must be called with run-A, not run-B");
      return [task];
    },
    getReviews: async () => reviews,
    saveApproval: async (approval: Record<string, unknown>) => {
      savedApprovalRunId = approval["runId"] as string | undefined;
    },
    updateTask: async () => {}
  };

  await saveApprovalCommand(
    ["--task-id", "myTask", "--source", "orchestrator"],
    { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
  );

  assert.equal(savedApprovalRunId, "run-a", "approval must be written to run-A (task's own run)");
});

test("save-approval: uses --run-id override when provided and run belongs to correct workspace/project", async () => {
  const task = makeTask({ runId: "run-x" });
  const reviews = [
    {
      id: "r1", runId: "run-x", taskId: "myTask",
      reviewerRole: "reviewer" as const, actorRole: "reviewer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-07-04T00:00:00.000Z"
    },
    {
      id: "r2", runId: "run-x", taskId: "myTask",
      reviewerRole: "qa_engineer" as const, actorRole: "qa_engineer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-07-04T00:00:00.000Z"
    },
    {
      id: "r3", runId: "run-x", taskId: "myTask",
      reviewerRole: "security_reviewer" as const, actorRole: "security_reviewer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-07-04T00:00:00.000Z"
    }
  ];

  let calledFindLatestRun = false;

  const fakeStore = {
    findLatestRunForTask: async () => {
      calledFindLatestRun = true;
      throw new Error("findLatestRunForTask should not be called when --run-id is provided");
    },
    getRun: async (runId: string) => ({
      id: runId,
      workspaceId: EXPECTED_WORKSPACE_ID,
      projectId: EXPECTED_PROJECT_ID
    }),
    getTasksByRun: async () => [task],
    getReviews: async () => reviews,
    saveApproval: async () => {},
    updateTask: async () => {}
  };

  await saveApprovalCommand(
    ["--task-id", "myTask", "--source", "orchestrator", "--run-id", "run-x"],
    { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
  );

  assert.equal(calledFindLatestRun, false, "findLatestRunForTask must not be called when --run-id override is given");
});

test("save-approval: rejects --run-id from a different workspace/project", async () => {
  const fakeStore = {
    findLatestRunForTask: async () => {
      throw new Error("findLatestRunForTask should not be called when --run-id is provided");
    },
    getRun: async (runId: string) => ({
      id: runId,
      workspaceId: "workspace:other-workspace",
      projectId: "project:other-workspace:other-project"
    }),
    getTasksByRun: async () => { throw new Error("must not reach getTasksByRun"); },
    getReviews: async () => { throw new Error("must not reach getReviews"); },
    saveApproval: async () => { throw new Error("must not reach saveApproval"); },
    updateTask: async () => { throw new Error("must not reach updateTask"); }
  };

  await assert.rejects(
    () =>
      saveApprovalCommand(
        ["--task-id", "myTask", "--source", "orchestrator", "--run-id", "foreign-run"],
        { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
      ),
    /does not belong to|refusing cross-project/i
  );
});

test("save-approval: throws when task not found in any run", async () => {
  const fakeStore = {
    findLatestRunForTask: async () => undefined,
    getRun: async () => { throw new Error("getRun should not be called in findLatestRunForTask path"); },
    getTasksByRun: async () => { throw new Error("should not be called"); },
    getReviews: async () => { throw new Error("should not be called"); },
    saveApproval: async () => { throw new Error("should not be called"); },
    updateTask: async () => { throw new Error("should not be called"); }
  };

  await assert.rejects(
    () =>
      saveApprovalCommand(
        ["--task-id", "unknownTask", "--source", "orchestrator"],
        { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
      ),
    /not found in any run/i
  );
});

// ---------------------------------------------------------------------------
// MemoryStore: findLatestRunForTask status-priority
//
// When run-A is in_progress and run-B is sealed (done/approved) but has a
// fresher updatedAt (e.g., close-run bumped it), findLatestRunForTask must
// return run-A (the in_progress run), not run-B.
// ---------------------------------------------------------------------------

test("MemoryStore.findLatestRunForTask: prefers in_progress run over sealed run with fresher updatedAt", async () => {
  const store = new MemoryStore();
  const { project } = await store.ensureProjectContext({
    workspaceSlug: "default",
    projectSlug: "archon"
  });

  const baseRun = {
    actor: "orchestrator",
    title: "test run",
    request: "do something",
    summary: { title: "t", description: "d", requestType: "feature" as const, estimatedComplexity: "low" as const, keyRequirements: [], successCriteria: [], riskFactors: [] },
    createdAt: "2026-07-04T00:00:00.000Z"
  };

  // run-A: in_progress, older updatedAt
  await store.createRun({
    ...baseRun,
    id: "run-a",
    workspaceId: "workspace:default",
    projectId: project.id,
    status: "in_progress",
    updatedAt: "2026-07-04T00:00:00.000Z"
  });

  // run-B: done (sealed), fresher updatedAt (simulates close-run bumping updated_at)
  await store.createRun({
    ...baseRun,
    id: "run-b",
    workspaceId: "workspace:default",
    projectId: project.id,
    status: "done",
    updatedAt: "2026-07-04T01:00:00.000Z"
  });

  // A task exists in both runs with the same taskId (simulates the bug scenario)
  const baseTaskPacket = {
    taskId: "sharedTask",
    title: "Shared task",
    ownerRole: "backend_engineer" as const,
    completionStandard: "artifact_complete" as const,
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
    requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"] as const,
    securityChecks: [],
    antiPatterns: [],
    rollbackNotes: "",
    handoffFormat: ""
  };

  await store.replaceTasks([{
    id: "task-in-run-a",
    runId: "run-a",
    workspaceId: "workspace:default",
    projectId: project.id,
    class: "prototype_slice",
    packet: baseTaskPacket,
    status: "in_progress",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z"
  }]);

  await store.replaceTasks([{
    id: "task-in-run-b",
    runId: "run-b",
    workspaceId: "workspace:default",
    projectId: project.id,
    class: "prototype_slice",
    packet: baseTaskPacket,
    status: "done",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T01:00:00.000Z"
  }]);

  const resolved = await store.findLatestRunForTask({
    workspaceSlug: "default",
    projectSlug: "archon",
    taskId: "sharedTask"
  });

  assert.equal(
    resolved?.id,
    "run-a",
    "findLatestRunForTask must return the in_progress run (run-A), not the fresher sealed run (run-B)"
  );
});
