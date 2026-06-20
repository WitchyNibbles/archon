/**
 * Tests for reviewToolingFix task.
 *
 * Covers:
 * - save-approval: rejects non-orchestrator source (trust gate)
 * - save-approval: refuses when required reviews are missing
 * - save-approval: succeeds (writes approval + updates task status) when reviews exist
 * - init-task --class: validates/sets/defaults the class field in queue and packet markdown
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── save-approval unit tests (command-level, no DB) ─────────────────────────

// Import the function under test. These will FAIL until saveApprovalCommand is exported.
const { saveApprovalCommand } = await import("../src/review.ts");

// ─── 1. Trust gate: non-orchestrator source must be rejected ─────────────────

test("save-approval: rejects --source self (trust gate)", async () => {
  await assert.rejects(
    () =>
      saveApprovalCommand(
        ["--task-id", "someTask", "--source", "self"],
        { withClientFn: () => Promise.reject(new Error("should not reach DB")) }
      ),
    /orchestrator/i
  );
});

test("save-approval: rejects --source seed (trust gate)", async () => {
  await assert.rejects(
    () =>
      saveApprovalCommand(
        ["--task-id", "someTask", "--source", "seed"],
        { withClientFn: () => Promise.reject(new Error("should not reach DB")) }
      ),
    /orchestrator/i
  );
});

test("save-approval: rejects missing --task-id", async () => {
  await assert.rejects(
    () =>
      saveApprovalCommand(
        ["--source", "orchestrator"],
        { withClientFn: () => Promise.reject(new Error("should not reach DB")) }
      ),
    /task-id/i
  );
});

// ─── 2. Missing reviews must block approval ───────────────────────────────────

test("save-approval: refuses when required reviews are missing", async () => {
  // Task packet requires reviewer, qa_engineer, security_reviewer.
  // Provide zero reviews → evaluateReviewDecision returns "blocked".
  const taskWithReviews = {
    id: "task-uuid",
    runId: "run-uuid",
    workspaceId: "ws1",
    projectId: "p1",
    status: "in_progress" as const,
    claimedBy: "manager",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    packet: {
      taskId: "reviewToolingFix",
      title: "Fix",
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
    }
  };

  const fakeStore = {
    getProjectRuntimeState: async () => ({
      projectId: "p1",
      workspaceId: "ws1",
      activeRunId: "run-uuid",
      activeTaskId: "reviewToolingFix",
      taskQueue: { project_status: "in_progress", current_task_id: "reviewToolingFix", tasks: [] },
      productState: {},
      metadata: {},
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z"
    }),
    getTasksByRun: async () => [taskWithReviews],
    getReviews: async () => [],
    saveApproval: async () => { throw new Error("should not reach saveApproval"); },
    updateTask: async () => { throw new Error("should not reach updateTask"); }
  };

  const env = {
    ARCHON_WORKSPACE_SLUG: "default",
    ARCHON_PROJECT_SLUG: "archon"
  };

  await assert.rejects(
    () =>
      saveApprovalCommand(
        ["--task-id", "reviewToolingFix", "--source", "orchestrator"],
        { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env }
      ),
    /missing required review|blocked/i
  );
});

// ─── 3. Approval succeeds when all required reviews are present ───────────────

test("save-approval: writes approval record and sets task status to approved when reviews exist", async () => {
  const taskWithReviews = {
    id: "task-uuid",
    runId: "run-uuid",
    workspaceId: "ws1",
    projectId: "p1",
    status: "in_progress" as const,
    claimedBy: "manager",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    packet: {
      taskId: "reviewToolingFix",
      title: "Fix",
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
    }
  };

  // Three passing orchestrator reviews (all fields required by canReviewRecordSatisfyGate)
  const reviews = [
    {
      id: "r1", runId: "run-uuid", taskId: "reviewToolingFix",
      reviewerRole: "reviewer" as const, actorRole: "reviewer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-06-19T00:00:00.000Z"
    },
    {
      id: "r2", runId: "run-uuid", taskId: "reviewToolingFix",
      reviewerRole: "qa_engineer" as const, actorRole: "qa_engineer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-06-19T00:00:00.000Z"
    },
    {
      id: "r3", runId: "run-uuid", taskId: "reviewToolingFix",
      reviewerRole: "security_reviewer" as const, actorRole: "security_reviewer" as const,
      actor: "orchestrator-actor", source: "orchestrator" as const,
      state: "passed" as const, severity: "low" as const,
      findings: [], waiverReason: undefined, evidenceRefs: [],
      createdAt: "2026-06-19T00:00:00.000Z"
    }
  ];

  let savedApproval: unknown = undefined;
  let updatedTask: unknown = undefined;

  const fakeStore = {
    getProjectRuntimeState: async () => ({
      projectId: "p1",
      workspaceId: "ws1",
      activeRunId: "run-uuid",
      activeTaskId: "reviewToolingFix",
      taskQueue: { project_status: "in_progress", current_task_id: "reviewToolingFix", tasks: [] },
      productState: {},
      metadata: {},
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z"
    }),
    getTasksByRun: async () => [taskWithReviews],
    getReviews: async () => reviews,
    saveApproval: async (approval: unknown) => { savedApproval = approval; },
    updateTask: async (task: unknown) => { updatedTask = task; }
  };

  const env = {
    ARCHON_WORKSPACE_SLUG: "default",
    ARCHON_PROJECT_SLUG: "archon"
  };

  await saveApprovalCommand(
    ["--task-id", "reviewToolingFix", "--source", "orchestrator"],
    { withClientFn: (fn: (s: typeof fakeStore) => Promise<unknown>) => fn(fakeStore), env }
  );

  assert.ok(savedApproval, "approval record should be saved");
  const approval = savedApproval as Record<string, unknown>;
  assert.equal(approval.taskId, "reviewToolingFix");
  assert.equal(approval.decision, "approved");
  assert.equal(approval.source, "orchestrator");

  assert.ok(updatedTask, "task should be updated");
  const updated = updatedTask as Record<string, unknown>;
  assert.equal(updated.status, "approved");
});

// ─── 4. init-task --class flag ────────────────────────────────────────────────

const { buildInitiativeRecords, renderTaskPacketMarkdown } = await import("../src/admin/init-task.ts");

function baseInitInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-task",
    title: "Test task",
    ownerRole: "planner",
    goal: "Do the thing.",
    allowedWriteScope: ["src", "tests"],
    workspaceId: "ws1",
    projectId: "p1",
    runId: "run-uuid",
    taskUuid: "task-uuid",
    now: "2026-06-19T00:00:00.000Z",
    ...overrides
  };
}

test("init-task --class: defaults to prototype_slice when not specified", () => {
  const { queue } = buildInitiativeRecords(baseInitInput());
  assert.equal(queue.tasks[0]!.class, "prototype_slice");
});

test("init-task --class: sets class in queue task when provided", () => {
  const { queue } = buildInitiativeRecords(baseInitInput({ class: "docs_only" }));
  assert.equal(queue.tasks[0]!.class, "docs_only");
});

test("init-task --class: sets class in queue task for each canonical class", () => {
  const classes = ["docs_only", "prototype_slice", "memory_curation", "state_sync", "scaffold_only"] as const;
  for (const cls of classes) {
    const { queue } = buildInitiativeRecords(baseInitInput({ class: cls }));
    assert.equal(queue.tasks[0]!.class, cls, `expected class ${cls}`);
  }
});

test("init-task --class: rejects unknown class value", () => {
  assert.throws(
    () => buildInitiativeRecords(baseInitInput({ class: "not_a_real_class" })),
    /class/i
  );
});

test("init-task --class: class appears in rendered packet markdown", () => {
  const { task, taskClass } = buildInitiativeRecords(baseInitInput({ class: "memory_curation" }));
  const markdown = renderTaskPacketMarkdown(task.packet, taskClass);
  assert.match(markdown, /## Task class[\s\S]*memory_curation/);
});

test("init-task --class: prototype_slice appears in rendered packet markdown by default", () => {
  const { task, taskClass } = buildInitiativeRecords(baseInitInput());
  const markdown = renderTaskPacketMarkdown(task.packet, taskClass);
  assert.match(markdown, /## Task class[\s\S]*prototype_slice/);
});
