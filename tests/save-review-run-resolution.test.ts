/**
 * RED tests for save-review and save-approval wrong-run resolution.
 *
 * Bug: both commands resolve the run from project_runtime_state.activeRunId rather
 * than from the task's own run. When two runs exist for a project and activeRunId
 * has advanced to run-B, a review/approval for a task still in run-A is silently
 * written to run-B (or fails "task not found" against run-B).
 *
 * Fix contract:
 *   - Resolve run via findLatestRunForTask(workspaceSlug, projectSlug, taskId)
 *   - Accept --run-id as explicit override
 *   - Throw descriptive error when task is not in any run
 *   - Trust gate (--source orchestrator) is not changed
 */

import test from "node:test";
import assert from "node:assert/strict";
import { saveReviewCommand, saveApprovalCommand } from "../src/review.ts";

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
    }
  };

  await saveReviewCommand(
    ["--task-id", "myTask", "--role", "reviewer", "--outcome", "passed", "--source", "orchestrator"],
    { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env: commonEnv }
  );

  assert.equal(capturedRunId, "run-a", "review must be written to run-A (task's own run), not run-B");
});

test("save-review: uses --run-id override when provided", async () => {
  let capturedRunId: string | undefined = undefined;

  const fakeStore = {
    findLatestRunForTask: async () => {
      throw new Error("findLatestRunForTask should not be called when --run-id is provided");
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

test("save-review: throws when task not found in any run", async () => {
  const fakeStore = {
    findLatestRunForTask: async () => undefined,
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

test("save-approval: uses --run-id override when provided", async () => {
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

test("save-approval: throws when task not found in any run", async () => {
  const fakeStore = {
    findLatestRunForTask: async () => undefined,
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
