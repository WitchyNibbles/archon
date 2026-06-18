// Phase 4: Specialist Subagent Scheduler — unit tests.
//
// Tests cover:
//   1. Valid spawn — creates subtask when all gates pass
//   2. Type not allowed — rejects when subagentType not in allowedSubagentTypes
//   3. Depth exceeded — rejects when child depth > maxChildDepth
//   4. Concurrency exceeded — rejects when pending/running children >= maxConcurrentChildren
//   5. Total children exceeded — rejects when total >= maxTotalChildrenPerTask
//   6. Write scope exceeded — rejects when child scope is not a subset of parent scope
//   7. Valid result — accepts a well-formed SubagentResultPacketV1 packet
//   8. Invalid result — rejects a packet missing required evidence for "completed" status
//   9. getPendingSubtasks — returns only "pending" subtasks for the task
//
// Uses node:test + node:assert/strict (no vitest).

import test from "node:test";
import assert from "node:assert/strict";
import { SubtaskScheduler } from "../src/runtime/subtask-scheduler.ts";
import type {
  SubtaskStoreLike,
  ParentInvocationStoreLike,
  ParentInvocationRef
} from "../src/runtime/subtask-scheduler.ts";
import type { Subtask } from "../src/domain/types.ts";
import type { AgentSpawnPolicy } from "../src/archon/agent-catalog.ts";

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

function makeDefaultPolicy(overrides: Partial<AgentSpawnPolicy> = {}): AgentSpawnPolicy {
  return {
    canSpawnSubagents: true,
    allowedSubagentTypes: ["codebase_scout", "test_writer", "patch_writer"],
    maxChildDepth: 2,
    maxConcurrentChildren: 3,
    maxTotalChildrenPerTask: 8,
    ...overrides
  };
}

function makeParentRef(overrides: Partial<ParentInvocationRef> = {}): ParentInvocationRef {
  return {
    status: "running",
    taskId: "task_001",
    runId: "run_001",
    allowedWriteScope: ["src/**", "tests/**"],
    depth: 0,
    spawnPolicy: makeDefaultPolicy(),
    ...overrides
  };
}

function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  const now = new Date().toISOString();
  return {
    id: `subtask_${Math.random().toString(36).slice(2)}`,
    runId: "run_001",
    taskId: "task_001",
    parentInvocationId: "inv_001",
    subagentType: "codebase_scout",
    title: "Scan codebase",
    prompt: "Map all call sites for the SubtaskScheduler.",
    allowedTools: ["Read", "Bash"],
    allowedWriteScope: [],
    status: "pending",
    createdAt: now,
    ...overrides
  };
}

class MockSubtaskStore implements SubtaskStoreLike {
  private readonly records: Subtask[] = [];

  async createSubtask(data: {
    id: string;
    runId: string;
    taskId: string;
    parentInvocationId: string;
    subagentType: string;
    title: string;
    prompt: string;
    allowedTools: string[];
    allowedWriteScope: string[];
    status: string;
  }): Promise<Subtask> {
    const record: Subtask = {
      id: data.id,
      runId: data.runId,
      taskId: data.taskId,
      parentInvocationId: data.parentInvocationId,
      subagentType: data.subagentType,
      title: data.title,
      prompt: data.prompt,
      allowedTools: data.allowedTools,
      allowedWriteScope: data.allowedWriteScope,
      status: data.status,
      createdAt: new Date().toISOString()
    };
    this.records.push(record);
    return record;
  }

  async updateSubtaskResult(id: string, resultPacket: Record<string, unknown>, status: string): Promise<void> {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx !== -1) {
      const existing = this.records[idx];
      if (existing !== undefined) {
        this.records[idx] = { ...existing, status, resultPacket };
      }
    }
  }

  async listSubtasksForTask(taskId: string): Promise<Subtask[]> {
    return this.records.filter((r) => r.taskId === taskId);
  }

  // Seed pre-existing subtasks for limit tests
  seed(subtasks: Subtask[]): void {
    this.records.push(...subtasks);
  }
}

class MockInvocationStore implements ParentInvocationStoreLike {
  private readonly invocations: Map<string, ParentInvocationRef> = new Map();

  register(id: string, ref: ParentInvocationRef): void {
    this.invocations.set(id, ref);
  }

  async getInvocation(invocationId: string): Promise<ParentInvocationRef | undefined> {
    return this.invocations.get(invocationId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validResultPacket(subtaskId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    subtaskId,
    parentInvocationId: "inv_001",
    subagentType: "codebase_scout",
    status: "completed",
    summary: "Mapped all call sites successfully across the codebase.",
    evidenceRefs: ["tests/phase4-subtask-scheduler.test.ts"],
    changedPaths: [],
    openQuestions: [],
    risks: [],
    nextActions: ["Parent should proceed with patch_writer."],
    confidence: "high"
  };
}

function defaultSpec() {
  return {
    subagentType: "codebase_scout",
    title: "Codebase scan",
    prompt: "Map all SubtaskScheduler call sites.",
    allowedTools: ["Read", "Bash"],
    allowedWriteScope: [] as string[],
    maxTurns: 20,
    stopCondition: "Return result packet after scanning."
  };
}

// ---------------------------------------------------------------------------
// Test 0a: getSubtaskDepth — invocation found
// ---------------------------------------------------------------------------

test("SubtaskScheduler: getSubtaskDepth returns parent.depth + 1 when invocation is found", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register("inv_depth", makeParentRef({ depth: 2 }));

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const depth = await scheduler.getSubtaskDepth("inv_depth");

  assert.strictEqual(depth, 3, `Expected depth 3 (parent.depth 2 + 1), got ${depth}`);
});

// ---------------------------------------------------------------------------
// Test 0b: getSubtaskDepth — invocation not found
// ---------------------------------------------------------------------------

test("SubtaskScheduler: getSubtaskDepth returns undefined when invocation is not found", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  // No registration — invocation does not exist.

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const depth = await scheduler.getSubtaskDepth("inv_missing");

  assert.strictEqual(depth, undefined, `Expected undefined for missing invocation, got ${depth}`);
});

// ---------------------------------------------------------------------------
// Test 0c: requestSubtask — parent not found
// ---------------------------------------------------------------------------

test("SubtaskScheduler: requestSubtask rejects when parent invocation is not found", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  // No invocation registered.

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const outcome = await scheduler.requestSubtask("inv_nonexistent", defaultSpec());

  assert.ok(!outcome.ok, "Expected ok=false for missing parent");
  assert.ok(
    !outcome.ok && (outcome.reason.toLowerCase().includes("not found") || outcome.reason.toLowerCase().includes("parent")),
    `Expected reason to mention 'not found' or 'parent', got: ${!outcome.ok ? outcome.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 0d: requestSubtask — parent not running
// ---------------------------------------------------------------------------

test("SubtaskScheduler: requestSubtask rejects when parent status is 'completed' (not running)", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register("inv_completed", makeParentRef({ status: "completed" }));

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const outcome = await scheduler.requestSubtask("inv_completed", defaultSpec());

  assert.ok(!outcome.ok, "Expected ok=false for non-running parent");
  assert.ok(
    !outcome.ok && (outcome.reason.toLowerCase().includes("not running") || outcome.reason.toLowerCase().includes("status")),
    `Expected reason to mention 'not running' or 'status', got: ${!outcome.ok ? outcome.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 1: Valid spawn
// ---------------------------------------------------------------------------

test("SubtaskScheduler: valid spawn creates subtask when all gates pass", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register("inv_001", makeParentRef());

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const outcome = await scheduler.requestSubtask("inv_001", defaultSpec());

  assert.ok(outcome.ok, `Expected ok=true, got: ${!outcome.ok ? (outcome as { reason: string }).reason : ""}`);
  assert.ok(outcome.ok && outcome.subtask.id.startsWith("subtask_"));
  assert.ok(outcome.ok && outcome.subtask.status === "pending");
  assert.ok(outcome.ok && outcome.subtask.subagentType === "codebase_scout");
});

// ---------------------------------------------------------------------------
// Test 2: Type not allowed
// ---------------------------------------------------------------------------

test("SubtaskScheduler: rejects spawn when subagentType not in allowedSubagentTypes", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register(
    "inv_001",
    makeParentRef({
      spawnPolicy: makeDefaultPolicy({ allowedSubagentTypes: ["codebase_scout"] })
    })
  );

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const outcome = await scheduler.requestSubtask("inv_001", {
    ...defaultSpec(),
    subagentType: "trust_boundary_mapper"
  });

  assert.ok(!outcome.ok, "Expected ok=false for disallowed subagent type");
  assert.ok(
    !outcome.ok && outcome.reason.includes("trust_boundary_mapper"),
    `Expected reason to mention the type, got: ${!outcome.ok ? outcome.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 3: Depth exceeded
// ---------------------------------------------------------------------------

test("SubtaskScheduler: rejects spawn when child depth exceeds maxChildDepth", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  // depth=2 → child would be depth=3 which exceeds maxChildDepth=2
  invStore.register(
    "inv_001",
    makeParentRef({
      depth: 2,
      spawnPolicy: makeDefaultPolicy({ maxChildDepth: 2 })
    })
  );

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const outcome = await scheduler.requestSubtask("inv_001", defaultSpec());

  assert.ok(!outcome.ok, "Expected ok=false when depth exceeded");
  assert.ok(
    !outcome.ok && outcome.reason.includes("depth"),
    `Expected reason to mention depth, got: ${!outcome.ok ? outcome.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 4: Concurrency exceeded
// ---------------------------------------------------------------------------

test("SubtaskScheduler: rejects spawn when concurrent children >= maxConcurrentChildren", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register(
    "inv_001",
    makeParentRef({ spawnPolicy: makeDefaultPolicy({ maxConcurrentChildren: 2 }) })
  );

  // Seed 2 already-pending subtasks for this task
  subtaskStore.seed([
    makeSubtask({ taskId: "task_001", status: "pending" }),
    makeSubtask({ taskId: "task_001", status: "running" })
  ]);

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const outcome = await scheduler.requestSubtask("inv_001", defaultSpec());

  assert.ok(!outcome.ok, "Expected ok=false when concurrency limit reached");
  assert.ok(
    !outcome.ok && (outcome.reason.includes("Concurrent") || outcome.reason.includes("concurrent")),
    `Expected reason to mention concurrency, got: ${!outcome.ok ? outcome.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 5: Total children exceeded
// ---------------------------------------------------------------------------

test("SubtaskScheduler: rejects spawn when total children for task >= maxTotalChildrenPerTask", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register(
    "inv_001",
    makeParentRef({ spawnPolicy: makeDefaultPolicy({ maxTotalChildrenPerTask: 3 }) })
  );

  // Seed 3 completed subtasks (not counted as concurrent) to hit total limit
  subtaskStore.seed([
    makeSubtask({ taskId: "task_001", status: "completed" }),
    makeSubtask({ taskId: "task_001", status: "completed" }),
    makeSubtask({ taskId: "task_001", status: "completed" })
  ]);

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  const outcome = await scheduler.requestSubtask("inv_001", defaultSpec());

  assert.ok(!outcome.ok, "Expected ok=false when total child limit reached");
  assert.ok(
    !outcome.ok && (outcome.reason.includes("Total") || outcome.reason.includes("total")),
    `Expected reason to mention total limit, got: ${!outcome.ok ? outcome.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 6: Write scope exceeded
// ---------------------------------------------------------------------------

test("SubtaskScheduler: rejects spawn when child write scope is not a subset of parent scope", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  // Parent only allows src/** writes
  invStore.register(
    "inv_001",
    makeParentRef({ allowedWriteScope: ["src/**"] })
  );

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  // Child requests write to .claude/ which is outside parent scope
  const outcome = await scheduler.requestSubtask("inv_001", {
    ...defaultSpec(),
    subagentType: "patch_writer",
    allowedWriteScope: [".claude/hooks/hook-policy.mjs"]
  });

  assert.ok(!outcome.ok, "Expected ok=false when child scope exceeds parent scope");
  assert.ok(
    !outcome.ok && (outcome.reason.includes("scope") || outcome.reason.includes("write")),
    `Expected reason to mention scope, got: ${!outcome.ok ? outcome.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 7: Valid result
// ---------------------------------------------------------------------------

test("SubtaskScheduler: recordResult accepts a well-formed completed packet", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register("inv_001", makeParentRef());

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  // First spawn a subtask to get an ID
  const spawnOutcome = await scheduler.requestSubtask("inv_001", defaultSpec());
  assert.ok(spawnOutcome.ok);

  const subtaskId = spawnOutcome.ok ? spawnOutcome.subtask.id : "";
  const result = await scheduler.recordResult(subtaskId, validResultPacket(subtaskId));

  assert.ok(result.ok, `Expected ok=true for valid packet, got: ${!result.ok ? (result as { reason: string }).reason : ""}`);
});

// ---------------------------------------------------------------------------
// Test 8: Invalid result — missing evidence for completed packet
// ---------------------------------------------------------------------------

test("SubtaskScheduler: recordResult rejects completed packet with empty evidenceRefs", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  const scheduler = new SubtaskScheduler(subtaskStore, invStore);

  const badPacket: Record<string, unknown> = {
    schemaVersion: 1,
    subtaskId: "subtask_bad",
    parentInvocationId: "inv_001",
    subagentType: "codebase_scout",
    status: "completed",
    summary: "Mapped all call sites across the entire codebase successfully.",
    evidenceRefs: [], // INVALID: completed must have non-empty evidenceRefs
    changedPaths: [],
    openQuestions: [],
    risks: [],
    nextActions: ["Done."],
    confidence: "high"
  };

  const result = await scheduler.recordResult("subtask_bad", badPacket);

  assert.ok(!result.ok, "Expected ok=false for completed packet with empty evidenceRefs");
  assert.ok(
    !result.ok && result.reason.includes("evidenceRefs"),
    `Expected reason to mention evidenceRefs, got: ${!result.ok ? result.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 9: Path traversal rejection
// ---------------------------------------------------------------------------

test("SubtaskScheduler: rejects child write scope containing path traversal segments", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  // Parent allows src/auth/** writes
  invStore.register(
    "inv_001",
    makeParentRef({ allowedWriteScope: ["src/auth/**"] })
  );

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);
  // Child requests a path that uses ".." to escape the allowed scope
  const outcome = await scheduler.requestSubtask("inv_001", {
    ...defaultSpec(),
    subagentType: "patch_writer",
    allowedWriteScope: ["src/auth/../../secrets/key"]
  });

  // After normalization "src/auth/../../secrets/key" → "secrets/key" which still
  // contains ".." in intermediate form; the traversal guard must reject it.
  assert.ok(!outcome.ok, "Expected ok=false for path traversal in write scope");
  assert.ok(
    !outcome.ok && (outcome.reason.includes("scope") || outcome.reason.includes("write")),
    `Expected scope error, got: ${!outcome.ok ? outcome.reason : ""}`
  );
});

// ---------------------------------------------------------------------------
// Test 10: getPendingSubtasks
// ---------------------------------------------------------------------------

test("SubtaskScheduler: getPendingSubtasks returns only pending subtasks for the task", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register("inv_001", makeParentRef());

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);

  // Seed mixed-status subtasks
  subtaskStore.seed([
    makeSubtask({ taskId: "task_001", status: "pending" }),
    makeSubtask({ taskId: "task_001", status: "pending" }),
    makeSubtask({ taskId: "task_001", status: "completed" }),
    makeSubtask({ taskId: "task_001", status: "running" }),
    makeSubtask({ taskId: "other_task", status: "pending" }) // different task
  ]);

  const pending = await scheduler.getPendingSubtasks("task_001");

  assert.equal(pending.length, 2, `Expected 2 pending subtasks, got ${pending.length}`);
  for (const s of pending) {
    assert.equal(s.status, "pending");
    assert.equal(s.taskId, "task_001");
  }
});

// ---------------------------------------------------------------------------
// Test 11: ARCHON_SUBAGENTS=disabled feature flag
// ---------------------------------------------------------------------------

test("SubtaskScheduler: returns SpawnError immediately when ARCHON_SUBAGENTS=disabled", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register("inv_001", makeParentRef());

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);

  const prev = process.env.ARCHON_SUBAGENTS;
  try {
    process.env.ARCHON_SUBAGENTS = "disabled";
    const outcome = await scheduler.requestSubtask("inv_001", defaultSpec());
    assert.ok(!outcome.ok, "Expected ok=false when ARCHON_SUBAGENTS=disabled");
    assert.ok(
      !outcome.ok && outcome.reason.includes("disabled"),
      `Expected reason to mention disabled, got: ${!outcome.ok ? outcome.reason : ""}`
    );
  } finally {
    if (prev === undefined) {
      delete process.env.ARCHON_SUBAGENTS;
    } else {
      process.env.ARCHON_SUBAGENTS = prev;
    }
  }
});

test("SubtaskScheduler: allows spawn when ARCHON_SUBAGENTS is unset", async () => {
  const subtaskStore = new MockSubtaskStore();
  const invStore = new MockInvocationStore();
  invStore.register("inv_001", makeParentRef());

  const scheduler = new SubtaskScheduler(subtaskStore, invStore);

  const prev = process.env.ARCHON_SUBAGENTS;
  try {
    delete process.env.ARCHON_SUBAGENTS;
    const outcome = await scheduler.requestSubtask("inv_001", defaultSpec());
    assert.ok(outcome.ok, `Expected ok=true when ARCHON_SUBAGENTS is unset, got: ${!outcome.ok ? outcome.reason : ""}`);
  } finally {
    if (prev === undefined) {
      delete process.env.ARCHON_SUBAGENTS;
    } else {
      process.env.ARCHON_SUBAGENTS = prev;
    }
  }
});
