/**
 * Tests for record-retro command (PR #163 round-2 review finding #1).
 *
 * Mirrors tests/record-council.test.ts — record-retro.ts is structurally
 * identical to record-council.ts (same trust gate, same cross-project
 * run-id guard, same run/task resolution) plus its own RETRO_OUTCOME_TOKENS
 * validation, which record-council does not have.
 *
 * Covers:
 *   - Trust gate: --source orchestrator is required
 *   - Outcome validation: must be one of RETRO_OUTCOME_TOKENS
 *   - --run-id scope validation: cross-project write rejected
 *   - --run-id validation: run not found rejected
 *   - valid --source orchestrator + valid outcome succeeds, writes
 *     packet.retroOutcome / packet.retroDecidedAt
 *   - updatedAt and retroDecidedAt are set on updateTask
 */

import test from "node:test";
import assert from "node:assert/strict";
import { executeRecordRetroCommand, recordRetroCommand } from "../src/admin/record-retro.ts";

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
// Trust gate: --source orchestrator enforcement
// ---------------------------------------------------------------------------

test("recordRetroCommand: throws when --source is missing", async () => {
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
      recordRetroCommand(
        ["--task-id", "myTask", "--outcome", "nothing_to_promote"],
        {
          withClient: (fn) => fn(fakeClient),
          createStore: () => fakeStore,
          env: commonEnv
        }
      ),
    /only accepts --source orchestrator|orchestrator provenance/i
  );
});

test("recordRetroCommand: throws when --source is not orchestrator", async () => {
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
      recordRetroCommand(
        ["--task-id", "myTask", "--outcome", "nothing_to_promote", "--source", "self"],
        {
          withClient: (fn) => fn(fakeClient),
          createStore: () => fakeStore,
          env: commonEnv
        }
      ),
    /only accepts --source orchestrator|orchestrator provenance/i
  );
});

// ---------------------------------------------------------------------------
// Outcome token validation (record-retro-specific — record-council has no
// equivalent closed enum check with this shape of error message)
// ---------------------------------------------------------------------------

test("executeRecordRetroCommand: rejects an outcome that is not in RETRO_OUTCOME_TOKENS", async () => {
  const store = {
    findLatestRunForTask: async () => { throw new Error("should not be called"); },
    getRun: async () => { throw new Error("should not be called"); },
    getTask: async () => { throw new Error("should not be called"); },
    updateTask: async () => { throw new Error("should not be called"); },
    ensureProjectContext: async () => { throw new Error("should not be called"); }
  };

  await assert.rejects(
    () =>
      executeRecordRetroCommand({
        store,
        workspaceSlug: "default",
        projectSlug: "archon",
        taskId: "myTask",
        outcome: "blah"
      }),
    /invalid/i
  );
});

test("recordRetroCommand: rejects a garbage outcome even with a valid --source orchestrator", async () => {
  const fakeStore = {
    findLatestRunForTask: async () => { throw new Error("should not be called"); },
    getRun: async () => { throw new Error("should not be called"); },
    getTask: async () => { throw new Error("should not be called"); },
    updateTask: async () => { throw new Error("should not be called"); },
    ensureProjectContext: async () => { throw new Error("should not be called"); }
  };

  await assert.rejects(
    () =>
      recordRetroCommand(
        ["--task-id", "myTask", "--outcome", "blah", "--source", "orchestrator"],
        {
          withClient: (fn) => fn({}),
          createStore: () => fakeStore,
          env: commonEnv
        }
      ),
    /invalid/i
  );
});

// ---------------------------------------------------------------------------
// Happy path: valid --source orchestrator + valid outcome
// ---------------------------------------------------------------------------

test("recordRetroCommand: succeeds with --source orchestrator and a valid outcome", async () => {
  const task = makeTask();
  let updatedTask: Record<string, unknown> | undefined;

  const fakeStore = {
    findLatestRunForTask: async () => ({ id: "run-a", workspaceId: EXPECTED_WORKSPACE_ID, projectId: EXPECTED_PROJECT_ID }),
    getRun: async () => { throw new Error("getRun should not be called in non-explicit-runId path"); },
    getTask: async () => task,
    updateTask: async (t: Record<string, unknown>) => { updatedTask = t; },
    ensureProjectContext: async () => ({ workspace: {}, project: {} })
  };

  await recordRetroCommand(
    ["--task-id", "myTask", "--outcome", "nothing_to_promote", "--source", "orchestrator"],
    {
      withClient: (fn) => fn({}),
      createStore: () => fakeStore,
      env: commonEnv
    }
  );

  assert.ok(updatedTask, "updateTask must have been called");
  const packet = updatedTask["packet"] as Record<string, unknown>;
  assert.equal(packet["retroOutcome"], "nothing_to_promote");
  assert.ok(typeof packet["retroDecidedAt"] === "string" && packet["retroDecidedAt"].length > 0, "retroDecidedAt must be stamped");
});

// ---------------------------------------------------------------------------
// --run-id scope validation
// ---------------------------------------------------------------------------

test("executeRecordRetroCommand: rejects --run-id from different workspace/project", async () => {
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
      executeRecordRetroCommand({
        store,
        workspaceSlug: "default",
        projectSlug: "archon",
        runId: "foreign-run",
        taskId: "myTask",
        outcome: "nothing_to_promote"
      }),
    /does not belong to|refusing cross-project/i
  );
});

test("executeRecordRetroCommand: rejects --run-id when run is not found", async () => {
  const store = {
    findLatestRunForTask: async () => { throw new Error("should not be called"); },
    getRun: async () => undefined,
    getTask: async () => { throw new Error("should not be called"); },
    updateTask: async () => {},
    ensureProjectContext: async () => ({ workspace: {}, project: {} })
  };

  await assert.rejects(
    () =>
      executeRecordRetroCommand({
        store,
        workspaceSlug: "default",
        projectSlug: "archon",
        runId: "nonexistent-run",
        taskId: "myTask",
        outcome: "nothing_to_promote"
      }),
    /not found/i
  );
});

test("executeRecordRetroCommand: accepts --run-id belonging to correct workspace/project", async () => {
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

  const result = await executeRecordRetroCommand({
    store,
    workspaceSlug: "default",
    projectSlug: "archon",
    runId: "run-a",
    taskId: "myTask",
    outcome: "skill_patched"
  });

  assert.equal(result.runId, "run-a");
  assert.equal(result.outcome, "skill_patched");
  assert.ok(capturedUpdate, "updateTask must have been called");
});

// ---------------------------------------------------------------------------
// updatedAt / retroDecidedAt stamping
// ---------------------------------------------------------------------------

test("executeRecordRetroCommand: sets updatedAt and retroDecidedAt on updateTask call", async () => {
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
  await executeRecordRetroCommand({
    store,
    workspaceSlug: "default",
    projectSlug: "archon",
    taskId: "myTask",
    outcome: "postmortem_filed"
  });
  const after = new Date().toISOString();

  assert.ok(capturedUpdate, "updateTask must have been called");
  const updatedAt = capturedUpdate["updatedAt"] as string;
  assert.ok(updatedAt >= before && updatedAt <= after, `updatedAt "${updatedAt}" must be a current timestamp`);
  const packet = capturedUpdate["packet"] as Record<string, unknown>;
  assert.equal(packet["retroOutcome"], "postmortem_filed");
  const retroDecidedAt = packet["retroDecidedAt"] as string;
  assert.ok(
    retroDecidedAt >= before && retroDecidedAt <= after,
    `retroDecidedAt "${retroDecidedAt}" must be a current timestamp`
  );
});
