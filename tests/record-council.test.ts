/**
 * Tests for record-council command.
 *
 * Covers:
 *   - Trust gate: --source orchestrator is required
 *   - --run-id scope validation: cross-project write rejected
 *   - --run-id validation: run not found rejected
 *   - updatedAt is set on updateTask
 */

import test from "node:test";
import assert from "node:assert/strict";
import { executeRecordCouncilCommand, recordCouncilCommand } from "../src/admin/record-council.ts";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-uuid",
    runId: "run-a",
    workspaceId: "workspace:default",
    projectId: "project:default:archon",
    class: "prototype_slice" as const,
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

const EXPECTED_WORKSPACE_ID = "workspace:default";
const EXPECTED_PROJECT_ID = "project:default:archon";

// ---------------------------------------------------------------------------
// Trust gate: --source orchestrator enforcement (Fix 4)
// ---------------------------------------------------------------------------

test("recordCouncilCommand: throws when --source is missing", async () => {
  const fakeClient = {};
  const fakeStore = {
    findLatestRunForTask: async () => { throw new Error("should not be called"); },
    getRun: async () => { throw new Error("should not be called"); },
    getTask: async () => { throw new Error("should not be called"); },
    updateTask: async () => { throw new Error("should not be called"); },
    ensureProjectContext: async () => { throw new Error("should not be called"); }
  };

  await assert.rejects(
    () =>
      recordCouncilCommand(
        ["--task-id", "myTask", "--outcome", "approved"],
        {
          withClient: (fn) => fn(fakeClient),
          createStore: () => fakeStore,
          env: commonEnv
        }
      ),
    /only accepts --source orchestrator|orchestrator provenance/i
  );
});

test("recordCouncilCommand: throws when --source is not orchestrator", async () => {
  const fakeClient = {};
  const fakeStore = {
    findLatestRunForTask: async () => { throw new Error("should not be called"); },
    getRun: async () => { throw new Error("should not be called"); },
    getTask: async () => { throw new Error("should not be called"); },
    updateTask: async () => { throw new Error("should not be called"); },
    ensureProjectContext: async () => { throw new Error("should not be called"); }
  };

  await assert.rejects(
    () =>
      recordCouncilCommand(
        ["--task-id", "myTask", "--outcome", "approved", "--source", "self"],
        {
          withClient: (fn) => fn(fakeClient),
          createStore: () => fakeStore,
          env: commonEnv
        }
      ),
    /only accepts --source orchestrator|orchestrator provenance/i
  );
});

test("recordCouncilCommand: succeeds with --source orchestrator", async () => {
  const task = makeTask();
  let updatedTask: Record<string, unknown> | undefined;

  const fakeStore = {
    findLatestRunForTask: async () => ({ id: "run-a", workspaceId: EXPECTED_WORKSPACE_ID, projectId: EXPECTED_PROJECT_ID }),
    getRun: async () => { throw new Error("getRun should not be called in non-explicit-runId path"); },
    getTask: async () => task,
    updateTask: async (t: Record<string, unknown>) => { updatedTask = t; },
    ensureProjectContext: async () => ({ workspace: {}, project: {} })
  };

  await recordCouncilCommand(
    ["--task-id", "myTask", "--outcome", "approved", "--source", "orchestrator"],
    {
      withClient: (fn) => fn({}),
      createStore: () => fakeStore,
      env: commonEnv
    }
  );

  assert.ok(updatedTask, "updateTask must have been called");
  assert.equal((updatedTask["packet"] as Record<string, unknown>)["councilOutcome"], "approved");
});

// ---------------------------------------------------------------------------
// --run-id scope validation (Fix 3)
// ---------------------------------------------------------------------------

test("executeRecordCouncilCommand: rejects --run-id from different workspace/project", async () => {
  const task = makeTask();

  const store = {
    findLatestRunForTask: async () => { throw new Error("should not be called"); },
    getRun: async (runId: string) => ({
      id: runId,
      workspaceId: "workspace:other",
      projectId: "project:other:other-project"
    }),
    getTask: async () => task,
    updateTask: async () => {},
    ensureProjectContext: async () => ({ workspace: {}, project: {} })
  };

  await assert.rejects(
    () =>
      executeRecordCouncilCommand({
        store,
        workspaceSlug: "default",
        projectSlug: "archon",
        runId: "foreign-run",
        taskId: "myTask",
        outcome: "approved"
      }),
    /does not belong to|refusing cross-project/i
  );
});

test("executeRecordCouncilCommand: rejects --run-id when run is not found", async () => {
  const store = {
    findLatestRunForTask: async () => { throw new Error("should not be called"); },
    getRun: async () => undefined,
    getTask: async () => { throw new Error("should not be called"); },
    updateTask: async () => {},
    ensureProjectContext: async () => ({ workspace: {}, project: {} })
  };

  await assert.rejects(
    () =>
      executeRecordCouncilCommand({
        store,
        workspaceSlug: "default",
        projectSlug: "archon",
        runId: "nonexistent-run",
        taskId: "myTask",
        outcome: "approved"
      }),
    /not found/i
  );
});

test("executeRecordCouncilCommand: accepts --run-id belonging to correct workspace/project", async () => {
  const task = makeTask();
  let capturedUpdate: Record<string, unknown> | undefined;

  const store = {
    findLatestRunForTask: async () => { throw new Error("should not be called with explicit runId"); },
    getRun: async (runId: string) => ({
      id: runId,
      workspaceId: EXPECTED_WORKSPACE_ID,
      projectId: EXPECTED_PROJECT_ID
    }),
    getTask: async () => task,
    updateTask: async (t: Record<string, unknown>) => { capturedUpdate = t; },
    ensureProjectContext: async () => ({ workspace: {}, project: {} })
  };

  const result = await executeRecordCouncilCommand({
    store,
    workspaceSlug: "default",
    projectSlug: "archon",
    runId: "run-a",
    taskId: "myTask",
    outcome: "approved"
  });

  assert.equal(result.runId, "run-a");
  assert.equal(result.outcome, "approved");
  assert.ok(capturedUpdate, "updateTask must have been called");
});

// ---------------------------------------------------------------------------
// updatedAt is set on updateTask (Fix 5)
// ---------------------------------------------------------------------------

test("executeRecordCouncilCommand: sets updatedAt on updateTask call", async () => {
  const task = makeTask();
  let capturedUpdate: Record<string, unknown> | undefined;

  const store = {
    findLatestRunForTask: async () => ({ id: "run-a", workspaceId: EXPECTED_WORKSPACE_ID, projectId: EXPECTED_PROJECT_ID }),
    getRun: async () => { throw new Error("should not be called"); },
    getTask: async () => task,
    updateTask: async (t: Record<string, unknown>) => { capturedUpdate = t; },
    ensureProjectContext: async () => ({ workspace: {}, project: {} })
  };

  const before = new Date().toISOString();
  await executeRecordCouncilCommand({
    store,
    workspaceSlug: "default",
    projectSlug: "archon",
    taskId: "myTask",
    outcome: "approved"
  });
  const after = new Date().toISOString();

  assert.ok(capturedUpdate, "updateTask must have been called");
  const updatedAt = capturedUpdate["updatedAt"] as string;
  assert.ok(updatedAt >= before && updatedAt <= after, `updatedAt "${updatedAt}" must be a current timestamp`);
  assert.equal((capturedUpdate["packet"] as Record<string, unknown>)["councilOutcome"], "approved");
});
