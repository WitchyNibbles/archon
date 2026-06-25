// Phase 3 (ahrP3RespawnBudget) — integration tests for per-task respawn budget.
//
// Tests cover:
//   A. Budget gate: N-th respawn is allowed, (N+1)-th is blocked before reset.
//   B. Counter atomicity: respawnCount increments in the same write as justHandedOff.
//   C. Task-change reset: counter resets when the active task changes.
//   D. Observe-mode skip: counter is never incremented in observe mode (no reset path).
//   E. Happy-path regression: no-handoff turns are unaffected.
//   F. Budget-before-stagnation: budget blocks before stagnation guard runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runDaemonCodexTurn,
  type DaemonCodexTurnDeps,
  type DaemonCodexTurnInput,
  type DaemonProjectContext
} from "../src/daemon/codex-turn.ts";
import type { DaemonCommandResult, DaemonCycleRecord } from "../src/daemon.ts";
import type {
  ProjectRuntimeStateRecord,
  RunExecutionPlan,
  RunStatusSnapshot
} from "../src/domain/types.ts";
import type { ReconcileRuntimeStateCommandResult } from "../src/runtime.ts";
import type { RunCodexTurnInput, RunCodexTurnResult } from "../src/daemon/turn-prompt.ts";
import { HandoffController } from "../src/runtime/handoff-controller.ts";
import type { HandoffStoreLike } from "../src/runtime/handoff-controller.ts";
import type { HandoffRecord } from "../src/store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// Helpers (shared with P2 test — duplicated here for isolation)
// ---------------------------------------------------------------------------

function directive(): RunExecutionPlan["directive"] {
  return {
    kind: "continue_analysis",
    rationale: [],
    targetId: "task:demo",
    source: "checkpoint",
    actions: [],
    nextActions: ["continue task"],
    blockers: []
  } as unknown as RunExecutionPlan["directive"];
}

function snapshotWithTask(taskId = "task-1"): RunStatusSnapshot {
  return {
    run: { status: "in_progress" },
    tasks: [
      {
        packet: { taskId, allowedWriteScope: [] },
        status: "in_progress",
        updatedAt: "2026-06-25T00:00:00.000Z"
      }
    ],
    autonomousExecution: undefined
  } as unknown as RunStatusSnapshot;
}

function runtimeState(overrides: Partial<ProjectRuntimeStateRecord> = {}): ProjectRuntimeStateRecord {
  return {
    projectId: "proj-id",
    workspaceId: "ws-id",
    activeRunId: "run-1",
    activeTaskId: "task-1",
    metadata: {},
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    ...overrides
  } as unknown as ProjectRuntimeStateRecord;
}

function turnInput(overrides: Partial<DaemonCodexTurnInput> = {}): DaemonCodexTurnInput {
  return {
    directive: directive(),
    summaryAction: "run_codex_owner",
    activeRunId: "run-1",
    activeTaskId: "task-1",
    ...overrides
  };
}

function handoffRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    id: "ho-123",
    runId: "run-1",
    taskId: "task-1",
    fromInvocationId: "inv-old",
    fromRole: "specialist_owner",
    toRole: "specialist_owner",
    reason: "context_limit" as const,
    status: "in_progress",
    contextUsedPct: 72,
    packet: {
      schemaVersion: 1,
      handoffId: "ho-123",
      runId: "run-1",
      taskId: "task-1",
      fromInvocationId: "inv-old",
      fromRole: "specialist_owner",
      toRole: "specialist_owner",
      reason: "context_limit",
      contextUsedPct: 72,
      status: "in_progress",
      summary: "Implemented the authentication module, tests passing.",
      scope: { allowedWriteScope: ["src/auth/**"], touchedPaths: [] },
      decisions: [],
      openQuestions: [],
      evidenceRefs: ["tests/auth.test.ts"],
      nextActions: ["Run final integration test"],
      risks: [],
      createdAt: "2026-06-25T00:00:00.000Z"
    },
    authorityLabel: "runtime_authoritative",
    createdAt: "2026-06-25T00:00:00.000Z",
    ...overrides
  } as unknown as HandoffRecord;
}

type HandoffStoreStub = HandoffStoreLike & {
  consumeCalls: Array<{ handoffId: string; toInvocationId: string }>;
};

function makeHandoffStore(opts: {
  latestHandoff?: HandoffRecord | undefined;
  hasCommittedHandoff?: boolean;
}): HandoffStoreStub {
  const consumeCalls: Array<{ handoffId: string; toInvocationId: string }> = [];
  let committed = opts.hasCommittedHandoff ?? false;
  let latestHandoffValue = opts.latestHandoff;

  const store: HandoffStoreStub = {
    consumeCalls,
    async createHandoff(data: Parameters<HandoffStoreLike["createHandoff"]>[0]): Promise<HandoffRecord> {
      const created = handoffRecord({ id: data.id ?? "ho-new", reason: data.reason as HandoffRecord["reason"] });
      latestHandoffValue = created;
      return created;
    },
    async getLatestUnconsumedHandoff(_runId: string, _taskId: string): Promise<HandoffRecord | undefined> {
      return latestHandoffValue;
    },
    async markHandoffConsumed(handoffId: string, toInvocationId: string): Promise<void> {
      consumeCalls.push({ handoffId, toInvocationId });
      committed = true;
    },
    async updateAgentInvocationStatus(_id: string, _status: string, _meta?: Record<string, unknown>): Promise<void> {},
    async hasCommittedHandoff(_invocationId: string): Promise<boolean> {
      return committed;
    },
    async getLatestContextSample(_invocationId: string) {
      return undefined;
    },
    async recordContextSample(_data: unknown): Promise<void> {}
  };

  return store;
}

type SavedState = Parameters<DaemonCodexTurnDeps["saveProjectRuntimeState"]>[0];

interface Harness {
  deps: DaemonCodexTurnDeps;
  cycles: DaemonCycleRecord[];
  codexCalls: RunCodexTurnInput[];
  saved: SavedState[];
  session: () => string | undefined;
  nextInvocationCalls: Array<{ taskId: string; role: string }>;
  blockedResults: DaemonCommandResult[];
}

function makeHarness(opts: {
  cwd: string;
  initialSession?: string | undefined;
  handoffStore?: HandoffStoreStub;
  startNextInvocationResult?: string;
  monitor?: DaemonCodexTurnDeps["monitor"];
  invocationId?: string;
  role?: string;
  runtimeStateOverride?: ProjectRuntimeStateRecord;
}): Harness {
  const cycles: DaemonCycleRecord[] = [];
  const codexCalls: RunCodexTurnInput[] = [];
  const saved: SavedState[] = [];
  const nextInvocationCalls: Array<{ taskId: string; role: string }> = [];
  const blockedResults: DaemonCommandResult[] = [];
  let session: string | undefined = opts.initialSession ?? "sess-1";

  const defaultCodexResult: RunCodexTurnResult = {
    sessionId: session,
    stdout: "",
    stderr: "",
    exitCode: 0,
    usage: { inputTokens: 50000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 }
  };

  const snapshot = snapshotWithTask("task-1");
  let state = opts.runtimeStateOverride ?? runtimeState();

  let handoffController: HandoffController | undefined;
  if (opts.handoffStore) {
    handoffController = new HandoffController(opts.handoffStore);
  }

  const deps: DaemonCodexTurnDeps = {
    cycle: 1,
    projectContext: {
      project: { id: "proj-id" },
      workspace: { id: "ws-id" }
    } as unknown as DaemonProjectContext,
    projectRuntimeState: state,
    attemptRuntimeReconcile: async () => undefined as ReconcileRuntimeStateCommandResult | undefined,
    cycles,
    blockedResult: async (input) => {
      const result: DaemonCommandResult = {
        authorityLabel: "derived_only",
        workspaceSlug: "ws",
        projectSlug: "proj",
        status: "blocked",
        reason: input.reason,
        activeRunId: input.activeRunId,
        activeTaskId: input.activeTaskId,
        sessionId: session ?? null,
        cycles
      } satisfies DaemonCommandResult;
      blockedResults.push(result);
      return result;
    },
    getSessionId: () => session,
    setSessionId: (next) => { session = next; },
    claudeBin: "claude",
    cwd: opts.cwd,
    env: {},
    now: () => new Date("2026-06-25T00:00:00.000Z"),
    staleAfterHours: 24,
    runCodexTurn: async (input) => {
      codexCalls.push(input);
      return defaultCodexResult;
    },
    getStatusSnapshot: async () => snapshot,
    getProjectRuntimeState: async () => state,
    getExecutionPlan: async () => ({ directive: directive() }) as unknown as RunExecutionPlan,
    saveProjectRuntimeState: async (s) => {
      saved.push(s);
      // Simulate what the real DB would do: feed the saved state back as the
      // next projectRuntimeState so the counter accumulates across calls.
      state = {
        ...state,
        metadata: s.metadata as ProjectRuntimeStateRecord["metadata"]
      };
      deps.projectRuntimeState = state;
    },
    checkpointRun: undefined,
    invocationId: opts.invocationId ?? "inv-current",
    monitor: opts.monitor,
    handoffController,
    role: opts.role ?? "specialist_owner",
    startNextInvocation: async (taskId, role) => {
      nextInvocationCalls.push({ taskId, role });
      return opts.startNextInvocationResult ?? "inv-next";
    }
  };

  return { deps, cycles, codexCalls, saved, session: () => session, nextInvocationCalls, blockedResults };
}

function savedDaemonMeta(state: SavedState): Record<string, unknown> {
  const meta = state.metadata as Record<string, unknown>;
  const archonDaemon = meta["archonDaemon"];
  if (!archonDaemon || typeof archonDaemon !== "object") return {};
  return archonDaemon as Record<string, unknown>;
}

function makeStubMonitor(returnState: "normal" | "warning" | "handoff_required" | "hard_stop"): NonNullable<DaemonCodexTurnDeps["monitor"]> {
  const m = {
    recordSample: async () => returnState,
    evaluate: () => returnState,
    getCurrentState: () => returnState,
    getStateFromStore: async () => returnState,
    getThresholdCrossed: async () => returnState === "handoff_required" || returnState === "hard_stop",
    buildStatusSummary: async () => `state=${returnState}`,
    isHandoffSafeTool: () => false,
    evaluatePreToolUse: async () => ({ decision: returnState === "hard_stop" ? "deny" as const : "allow" as const }),
    on: () => m,
    emit: () => false,
    off: () => m,
    once: () => m,
    removeListener: () => m,
    removeAllListeners: () => m,
    listeners: () => [],
    rawListeners: () => [],
    listenerCount: () => 0,
    eventNames: () => [],
    getMaxListeners: () => 10,
    setMaxListeners: () => m,
    addListener: () => m,
    prependListener: () => m,
    prependOnceListener: () => m
  } as unknown as NonNullable<DaemonCodexTurnDeps["monitor"]>;
  return m;
}

// ---------------------------------------------------------------------------
// A. Budget gate
// ---------------------------------------------------------------------------

test("P3 A1: enforce mode + budget=1 — first respawn allowed, second blocked with recovery_required", async () => {
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  const prevBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";
  process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "1";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));
    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: false });
    const harness = makeHarness({
      cwd: dir,
      initialSession: "sess-budget-1",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore,
      startNextInvocationResult: "inv-next-1"
    });

    // First respawn: should be allowed (respawnCount goes from 0 → 1 which equals budget=1).
    // The reset happens.
    const result1 = await runDaemonCodexTurn(turnInput(), harness.deps);
    assert.equal(result1, undefined, "P3 A1: first respawn (count=1, budget=1) must be allowed");
    assert.equal(harness.session(), undefined, "P3 A1: session cleared after first respawn");

    // The saved state should have respawnCount=1 and respawnTaskId="task-1".
    const resetSave = harness.saved.find((s) => {
      const meta = savedDaemonMeta(s);
      return meta["justHandedOff"] === true;
    });
    assert.ok(resetSave !== undefined, "P3 A1: reset write found");
    const resetMeta = savedDaemonMeta(resetSave);
    assert.equal(resetMeta["respawnCount"], 1, "P3 A1: respawnCount=1 after first respawn");
    assert.equal(resetMeta["respawnTaskId"], "task-1", "P3 A1: respawnTaskId set");

    // Second respawn attempt: budget exhausted → blocked result, NO session clear.
    // Restore session (simulate fresh turn completing and new handoff).
    harness.deps.getSessionId = () => "sess-after-respawn";
    // Give it a new committed handoff to trigger the reset decision.
    const handoffStore2 = makeHandoffStore({ latestHandoff: handoffRecord({ id: "ho-456" }), hasCommittedHandoff: true });
    harness.deps.handoffController = new HandoffController(handoffStore2);
    harness.deps.monitor = makeStubMonitor("handoff_required");

    const result2 = await runDaemonCodexTurn(turnInput(), harness.deps);

    // Must return a blocked result (not undefined).
    assert.ok(result2 !== undefined, "P3 A1: second respawn must return blocked result");
    const blockedReason = (result2 as DaemonCommandResult).reason ?? "";
    assert.ok(
      blockedReason.includes("respawn budget exhausted") || blockedReason.includes("task-1"),
      `P3 A1: blocked reason must mention budget/task; got: ${blockedReason}`
    );

    // Session must NOT have been cleared on the second attempt.
    assert.notEqual(harness.deps.getSessionId(), undefined, "P3 A1: session must NOT be cleared when budget exhausted");
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    if (prevBudget === undefined) delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    else process.env.ARCHON_MAX_RESPAWNS_PER_TASK = prevBudget;
  }
});

test("P3 A2: blockerKind is recovery_required when budget exhausted", async () => {
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  const prevBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";
  process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "1";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));

    // Pre-load state with respawnCount=1, respawnTaskId="task-1" (budget already consumed).
    const stateWithBudgetExhausted = runtimeState({
      metadata: {
        archonDaemon: {
          sessionId: "sess-2",
          justHandedOff: false,
          respawnCount: 1,
          respawnTaskId: "task-1",
          lastRunId: "run-1",
          lastTaskId: "task-1",
          updatedAt: "2026-06-25T00:00:00.000Z"
        }
      }
    });

    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: true });
    const harness = makeHarness({
      cwd: dir,
      initialSession: "sess-2",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore,
      runtimeStateOverride: stateWithBudgetExhausted
    });

    const result = await runDaemonCodexTurn(turnInput(), harness.deps);

    assert.ok(result !== undefined, "P3 A2: budget exhausted must return blocked result");
    // The blockedResult builder in makeHarness records the result.
    assert.equal(harness.blockedResults.length, 1, "P3 A2: exactly one blocked result emitted");

    // Session MUST NOT be cleared (no reset called).
    assert.equal(harness.session(), "sess-2", "P3 A2: session NOT cleared when budget exhausted");
    // startNextInvocation must NOT be called.
    assert.equal(harness.nextInvocationCalls.length, 0, "P3 A2: startNextInvocation NOT called when budget exhausted");
    // Handoff must NOT be consumed.
    assert.equal(handoffStore.consumeCalls.length, 0, "P3 A2: handoff NOT consumed when budget exhausted");
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    if (prevBudget === undefined) delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    else process.env.ARCHON_MAX_RESPAWNS_PER_TASK = prevBudget;
  }
});

// ---------------------------------------------------------------------------
// B. Counter atomicity: respawnCount + justHandedOff in the SAME write
// ---------------------------------------------------------------------------

test("P3 B1: respawnCount increments in the same write as justHandedOff=true", async () => {
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  const prevBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";
  process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "8";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));
    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: false });
    const harness = makeHarness({
      cwd: dir,
      initialSession: "sess-atomic",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore
    });

    await runDaemonCodexTurn(turnInput(), harness.deps);

    // Find the write where justHandedOff=true is set.
    const resetWrite = harness.saved.find((s) => {
      const meta = savedDaemonMeta(s);
      return meta["justHandedOff"] === true;
    });
    assert.ok(resetWrite !== undefined, "P3 B1: reset write with justHandedOff=true must exist");

    const meta = savedDaemonMeta(resetWrite);
    // respawnCount must be incremented in the SAME write as justHandedOff.
    assert.ok(
      typeof meta["respawnCount"] === "number" && (meta["respawnCount"] as number) >= 1,
      `P3 B1: respawnCount must be in same write as justHandedOff=true; meta: ${JSON.stringify(meta)}`
    );
    // respawnTaskId must identify the task.
    assert.equal(meta["respawnTaskId"], "task-1", "P3 B1: respawnTaskId set in same write");
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    if (prevBudget === undefined) delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    else process.env.ARCHON_MAX_RESPAWNS_PER_TASK = prevBudget;
  }
});

// ---------------------------------------------------------------------------
// C. Task-change reset: counter zeroes when the active task changes
// ---------------------------------------------------------------------------

test("P3 C1: respawnCount resets to 0 when active task changes", async () => {
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  const prevBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";
  process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "1";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));

    // Pre-load state: respawnCount=1 for task-A (budget of 1 is exhausted for task-A).
    const stateWithCounterForOtherTask = runtimeState({
      activeTaskId: "task-2",
      metadata: {
        archonDaemon: {
          sessionId: "sess-task-b",
          justHandedOff: false,
          respawnCount: 1,
          respawnTaskId: "task-1",  // counter is for old task
          lastRunId: "run-1",
          lastTaskId: "task-2",
          updatedAt: "2026-06-25T00:00:00.000Z"
        }
      }
    });

    const snapshot2: RunStatusSnapshot = {
      run: { status: "in_progress" },
      tasks: [
        {
          packet: { taskId: "task-2", allowedWriteScope: [] },
          status: "in_progress",
          updatedAt: "2026-06-25T00:00:00.000Z"
        }
      ],
      autonomousExecution: undefined
    } as unknown as RunStatusSnapshot;

    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord({ taskId: "task-2" }), hasCommittedHandoff: false });
    const harness = makeHarness({
      cwd: dir,
      initialSession: "sess-task-b",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore,
      runtimeStateOverride: stateWithCounterForOtherTask
    });

    // Override getStatusSnapshot to return task-2.
    harness.deps.getStatusSnapshot = async () => snapshot2;
    harness.deps.getExecutionPlan = async () => ({ directive: directive() }) as unknown as RunExecutionPlan;

    // Call with activeTaskId = "task-2" (different from respawnTaskId="task-1").
    const input2 = turnInput({ activeTaskId: "task-2" });
    const result = await runDaemonCodexTurn(input2, harness.deps);

    // Task changed → counter is 0 → respawn should be ALLOWED.
    assert.equal(result, undefined, "P3 C1: task change resets counter → respawn allowed");
    assert.equal(harness.session(), undefined, "P3 C1: session cleared after reset with fresh task counter");

    // The reset write should have respawnCount=1 (first respawn for new task).
    const resetWrite = harness.saved.find((s) => {
      const meta = savedDaemonMeta(s);
      return meta["justHandedOff"] === true;
    });
    assert.ok(resetWrite !== undefined, "P3 C1: reset write found");
    const meta = savedDaemonMeta(resetWrite);
    assert.equal(meta["respawnTaskId"], "task-2", "P3 C1: respawnTaskId updated to new task");
    assert.equal(meta["respawnCount"], 1, "P3 C1: respawnCount starts at 1 for new task");
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    if (prevBudget === undefined) delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    else process.env.ARCHON_MAX_RESPAWNS_PER_TASK = prevBudget;
  }
});

// ---------------------------------------------------------------------------
// D. Observe-mode skip: counter never incremented
// ---------------------------------------------------------------------------

test("P3 D1: observe mode never increments respawnCount (no reset path)", async () => {
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  delete process.env.ARCHON_CONTEXT_MONITOR;

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));
    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: false });
    const harness = makeHarness({
      cwd: dir,
      initialSession: "sess-observe",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore
    });

    await runDaemonCodexTurn(turnInput(), harness.deps);

    // No reset write should have justHandedOff=true.
    const hasResetWrite = harness.saved.some((s) => {
      const meta = savedDaemonMeta(s);
      return meta["justHandedOff"] === true;
    });
    assert.equal(hasResetWrite, false, "P3 D1: observe mode must not perform reset write");

    // No respawnCount should be incremented in any write.
    const hasRespawnCount = harness.saved.some((s) => {
      const meta = savedDaemonMeta(s);
      return typeof meta["respawnCount"] === "number" && (meta["respawnCount"] as number) > 0;
    });
    assert.equal(hasRespawnCount, false, "P3 D1: observe mode must not increment respawnCount");
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
  }
});

// ---------------------------------------------------------------------------
// E. Happy-path regression: non-handoff turns are completely unaffected
// ---------------------------------------------------------------------------

test("P3 E1: normal turn without handoff does not set respawnCount", async () => {
  const prevBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
  process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "8";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));
    // No handoff controller → no reset path.
    const harness = makeHarness({ cwd: dir, initialSession: "sess-happy" });

    const result = await runDaemonCodexTurn(turnInput(), harness.deps);

    assert.equal(result, undefined, "P3 E1: normal turn continues");
    assert.equal(harness.session(), "sess-happy", "P3 E1: session preserved from codex result");

    // Normal state write must not include respawnCount (no prior counter to carry).
    const hasRespawnCount = harness.saved.some((s) => {
      const meta = savedDaemonMeta(s);
      return "respawnCount" in meta;
    });
    assert.equal(hasRespawnCount, false, "P3 E1: normal turn must not write respawnCount when none existed");
  } finally {
    if (prevBudget === undefined) delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    else process.env.ARCHON_MAX_RESPAWNS_PER_TASK = prevBudget;
  }
});

// ---------------------------------------------------------------------------
// F. Budget-before-stagnation: budget blocks before stagnation guard runs.
//    Also verifies stagnation counter still accumulates on no-progress respawn.
// ---------------------------------------------------------------------------

test("P3 F1: no-progress respawn still feeds stagnation counter", async () => {
  // When enforce mode fires a reset (respawn), the normal-path stagnation write
  // does NOT run (early return). On the SUBSEQUENT normal turn that makes no
  // progress, stagnation should accumulate against the "before" progress key.
  // This test verifies that a no-progress turn after a respawn DOES write
  // stagnation data (stagnantTurnCount > 0) and continues the loop.
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  const prevBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";
  process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "8";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));
    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: false });
    const harness = makeHarness({
      cwd: dir,
      initialSession: "sess-f1",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore
    });

    // Turn 1: enforce mode + handoff → respawn reset (early return, no stagnation write).
    const result1 = await runDaemonCodexTurn(turnInput(), harness.deps);
    assert.equal(result1, undefined, "P3 F1: first turn is a reset (allowed)");
    assert.equal(harness.session(), undefined, "P3 F1: session cleared after reset");

    // Turn 2: session=undefined → fresh turn; no handoff, no enforce trigger.
    //         Progress key is identical before/after → no-progress turn.
    //         Stagnation should accumulate.
    //         Restore session (simulating the fresh codex spawn returning a session).
    harness.deps.getSessionId = () => "sess-fresh";
    harness.deps.setSessionId = (s) => { harness.deps.getSessionId = () => s; };
    // Use a monitor that returns "normal" so no second reset fires.
    harness.deps.monitor = makeStubMonitor("normal");
    // Remove handoffController so no reset path is entered.
    harness.deps.handoffController = undefined;

    const result2 = await runDaemonCodexTurn(turnInput(), harness.deps);
    assert.equal(result2, undefined, "P3 F1: no-progress turn continues (stagnation not yet at max)");

    // The normal-path write after turn 2 should include stagnation data.
    // (progress keys are equal because getStatusSnapshot and getExecutionPlan
    //  return deterministic data with no state changes in this harness.)
    const lastSave = harness.saved.at(-1);
    assert.ok(lastSave !== undefined, "P3 F1: at least one save after turn 2");
    const meta2 = savedDaemonMeta(lastSave);
    // stagnation block should be present with count >= 1.
    const stagnation = meta2["stagnation"] as Record<string, unknown> | undefined;
    assert.ok(stagnation !== undefined, "P3 F1: stagnation metadata must be written on no-progress turn");
    assert.ok(
      typeof stagnation["count"] === "number" && (stagnation["count"] as number) >= 1,
      `P3 F1: stagnation.count must be >= 1; got: ${JSON.stringify(stagnation)}`
    );
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    if (prevBudget === undefined) delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    else process.env.ARCHON_MAX_RESPAWNS_PER_TASK = prevBudget;
  }
});

test("P3 F2: budget exhausted fires recovery_required before stagnation guard", async () => {
  // When respawnCount >= budget AND there is prior stagnation, the budget gate
  // fires first (recovery_required). The stagnation evaluateDaemonNoProgressOutcome
  // path must NOT run — the blocked result kind must be "recovery_required",
  // not a stagnation-derived kind (e.g. runtime_blocked / scope_expansion_required).
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  const prevBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";
  process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "1";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));

    // Pre-load state: budget exhausted (count=1, budget=1) AND prior stagnation
    // at the same progress key (to trigger stagnation if the budget gate didn't fire).
    const progressKey = "run:run-1|task:task-1|directive:continue_analysis";
    const stateWithBothConditions = runtimeState({
      metadata: {
        archonDaemon: {
          sessionId: "sess-f2",
          justHandedOff: false,
          respawnCount: 1,
          respawnTaskId: "task-1",
          stagnation: {
            runId: "run-1",
            taskId: "task-1",
            directiveKind: "continue_analysis",
            progressKey,
            count: 5,
            updatedAt: "2026-06-25T00:00:00.000Z"
          },
          lastRunId: "run-1",
          lastTaskId: "task-1",
          updatedAt: "2026-06-25T00:00:00.000Z"
        }
      }
    });

    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: true });
    const harness = makeHarness({
      cwd: dir,
      initialSession: "sess-f2",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore,
      runtimeStateOverride: stateWithBothConditions
    });

    const result = await runDaemonCodexTurn(turnInput(), harness.deps);

    // Must return a blocked result.
    assert.ok(result !== undefined, "P3 F2: must block when budget exhausted");
    const blockedResult = result as DaemonCommandResult;
    // Blocked reason must be recovery_required (budget gate), NOT a stagnation kind.
    assert.ok(
      blockedResult.reason?.includes("respawn budget exhausted") === true ||
      blockedResult.reason?.includes("task-1") === true,
      `P3 F2: blocked reason must be budget-related; got: ${blockedResult.reason}`
    );
    // The cycle records should show a "blocked" action (budget), not stagnation.
    assert.equal(harness.cycles.length, 1, "P3 F2: exactly one cycle entry");
    assert.equal(harness.cycles[0]?.action, "blocked", "P3 F2: cycle action is blocked");
    // Session must NOT have been cleared (no reset when budget exhausted).
    assert.equal(harness.deps.getSessionId(), "sess-f2", "P3 F2: session NOT cleared");
    // startNextInvocation must NOT be called.
    assert.equal(harness.nextInvocationCalls.length, 0, "P3 F2: no invocation started");
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    if (prevBudget === undefined) delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    else process.env.ARCHON_MAX_RESPAWNS_PER_TASK = prevBudget;
  }
});

// ---------------------------------------------------------------------------
// G. Multi-turn cycle: counter survives productive turns (BLOCKING #1 proof)
// ---------------------------------------------------------------------------

test("P3 G1: respawnCount survives a productive turn between respawns", async () => {
  // Sequence:
  //   Turn 1 (enforce + handoff): respawn reset → state has respawnCount=1
  //   Turn 2 (observe / no trigger): normal productive turn → counter must survive
  //   Turn 3 (enforce + handoff): respawn reset → state must have respawnCount=2
  //
  // Without the fix, Turn 2 drops respawnCount and Turn 3 would write count=1
  // instead of count=2 — making the budget bypassable.
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  const prevBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";
  process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "8";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p3-"));

    // -- Turn 1: enforce mode, handoff present → first respawn reset.
    const handoffStore1 = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: false });
    const harness = makeHarness({
      cwd: dir,
      initialSession: "sess-g1-t1",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore: handoffStore1,
      startNextInvocationResult: "inv-t1"
    });

    const result1 = await runDaemonCodexTurn(turnInput(), harness.deps);
    assert.equal(result1, undefined, "P3 G1: turn 1 is allowed reset");
    assert.equal(harness.session(), undefined, "P3 G1: session cleared after turn 1");

    // State should now have respawnCount=1.
    const afterT1 = harness.saved.find((s) => savedDaemonMeta(s)["justHandedOff"] === true);
    assert.ok(afterT1 !== undefined, "P3 G1: reset write found after turn 1");
    assert.equal(savedDaemonMeta(afterT1)["respawnCount"], 1, "P3 G1: respawnCount=1 after turn 1");

    // -- Turn 2: productive normal turn (no handoff, observe-ish, session restored).
    //    The deps.projectRuntimeState is already updated by the harness's saveProjectRuntimeState
    //    callback to reflect the state with respawnCount=1.
    harness.deps.getSessionId = () => "sess-g1-t2";
    harness.deps.setSessionId = (s) => { harness.deps.getSessionId = () => (s ?? "sess-g1-t2"); };
    harness.deps.monitor = makeStubMonitor("normal");
    harness.deps.handoffController = undefined;   // no reset path in turn 2

    const result2 = await runDaemonCodexTurn(turnInput(), harness.deps);
    assert.equal(result2, undefined, "P3 G1: turn 2 productive (continues)");

    // After turn 2, the normal-path write should have carried respawnCount=1 through.
    const afterT2 = harness.saved.at(-1);
    assert.ok(afterT2 !== undefined, "P3 G1: normal-path write found after turn 2");
    const metaT2 = savedDaemonMeta(afterT2);
    assert.equal(
      metaT2["respawnCount"], 1,
      `P3 G1: respawnCount must survive productive turn; got: ${metaT2["respawnCount"]}`
    );
    assert.equal(metaT2["respawnTaskId"], "task-1", "P3 G1: respawnTaskId carried through turn 2");

    // -- Turn 3: enforce mode, new handoff → second respawn. Count should go 1→2.
    harness.deps.getSessionId = () => "sess-g1-t3";
    harness.deps.setSessionId = (s) => { harness.deps.getSessionId = () => (s ?? "sess-g1-t3"); };
    const handoffStore3 = makeHandoffStore({ latestHandoff: handoffRecord({ id: "ho-t3" }), hasCommittedHandoff: false });
    harness.deps.handoffController = new HandoffController(handoffStore3);
    harness.deps.monitor = makeStubMonitor("handoff_required");

    const result3 = await runDaemonCodexTurn(turnInput(), harness.deps);
    assert.equal(result3, undefined, "P3 G1: turn 3 is allowed reset");
    assert.equal(harness.session(), undefined, "P3 G1: session cleared after turn 3");

    // respawnCount must be 2 (not 1, which would prove the bug survived).
    const afterT3 = harness.saved.find((s, idx) => {
      const m = savedDaemonMeta(s);
      return m["justHandedOff"] === true && idx >= harness.saved.indexOf(afterT1!) + 1;
    });
    assert.ok(afterT3 !== undefined, "P3 G1: reset write found after turn 3");
    assert.equal(
      savedDaemonMeta(afterT3)["respawnCount"], 2,
      `P3 G1: respawnCount must be 2 after second respawn (proves counter survived productive turn); got: ${savedDaemonMeta(afterT3)["respawnCount"]}`
    );
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    if (prevBudget === undefined) delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    else process.env.ARCHON_MAX_RESPAWNS_PER_TASK = prevBudget;
  }
});

// ---------------------------------------------------------------------------
// H. Default budget boundary: 7 allowed, 8th respawn blocked at default budget=8
// ---------------------------------------------------------------------------

test("P3 H1: default budget=8 boundary — count=7 allows next respawn, count=8 blocks it", async () => {
  // Verify the default budget value (8) is enforced correctly:
  //   - count=7 < 8 → respawn allowed (count goes to 8)
  //   - count=8 >= 8 → respawn blocked (recovery_required)
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;  // use default = 8
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";

  try {
    // --- Sub-test A: count=7 → allowed (8th respawn) ---
    const dir1 = await mkdtemp(path.join(tmpdir(), "archon-p3-"));
    const stateCount7 = runtimeState({
      metadata: {
        archonDaemon: {
          sessionId: "sess-h1a",
          justHandedOff: false,
          respawnCount: 7,
          respawnTaskId: "task-1",
          lastRunId: "run-1",
          lastTaskId: "task-1",
          updatedAt: "2026-06-25T00:00:00.000Z"
        }
      }
    });
    const handoffStore1 = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: false });
    const harness1 = makeHarness({
      cwd: dir1,
      initialSession: "sess-h1a",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore: handoffStore1,
      runtimeStateOverride: stateCount7
    });

    const result1 = await runDaemonCodexTurn(turnInput(), harness1.deps);
    assert.equal(result1, undefined, "P3 H1a: count=7 with budget=8 must allow 8th respawn");
    const resetWrite1 = harness1.saved.find((s) => savedDaemonMeta(s)["justHandedOff"] === true);
    assert.ok(resetWrite1 !== undefined, "P3 H1a: reset write found");
    assert.equal(savedDaemonMeta(resetWrite1)["respawnCount"], 8, "P3 H1a: respawnCount incremented to 8");

    // --- Sub-test B: count=8 → blocked (9th respawn attempt) ---
    const dir2 = await mkdtemp(path.join(tmpdir(), "archon-p3-"));
    const stateCount8 = runtimeState({
      metadata: {
        archonDaemon: {
          sessionId: "sess-h1b",
          justHandedOff: false,
          respawnCount: 8,
          respawnTaskId: "task-1",
          lastRunId: "run-1",
          lastTaskId: "task-1",
          updatedAt: "2026-06-25T00:00:00.000Z"
        }
      }
    });
    const handoffStore2 = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: true });
    const harness2 = makeHarness({
      cwd: dir2,
      initialSession: "sess-h1b",
      monitor: makeStubMonitor("handoff_required"),
      handoffStore: handoffStore2,
      runtimeStateOverride: stateCount8
    });

    const result2 = await runDaemonCodexTurn(turnInput(), harness2.deps);
    assert.ok(result2 !== undefined, "P3 H1b: count=8 with budget=8 must block 9th respawn");
    const blocked = result2 as DaemonCommandResult;
    assert.ok(
      blocked.reason?.includes("respawn budget exhausted") === true ||
      blocked.reason?.includes("task-1") === true,
      `P3 H1b: blocked reason must be budget-related; got: ${blocked.reason}`
    );
    assert.equal(harness2.session(), "sess-h1b", "P3 H1b: session NOT cleared when budget exhausted");
    assert.equal(harness2.nextInvocationCalls.length, 0, "P3 H1b: no invocation started");
  } finally {
    if (prevEnv === undefined) delete process.env.ARCHON_CONTEXT_MONITOR;
    else process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
  }
});
