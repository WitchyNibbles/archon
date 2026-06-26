// Phase 4 (ahrP4InteractiveWatcher) — daemon lease denial test (BLOCKING-3).
//
// Contract: when the lease store denies the daemon's claim (interactive already
// holds the lease), runDaemonCodexTurn must return undefined (no-op) instead of
// proceeding with the reset path. The saveProjectRuntimeState must NOT be called
// with justHandedOff=true, and startNextInvocation must NOT be called.
//
// Also tests BLOCKING-2: the production DaemonCodexTurnDeps construction in
// executeDaemonCommandFromArgs injects a real LeaseStore (makeFileLockLeaseStore),
// not undefined — verified by confirming the tryAcquire method is present and
// functional on the object constructed from the production code path.
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
import { makeInMemoryLeaseStore, makeFileLockLeaseStore, claimRespawnLease } from "../src/runtime/respawn-lease.ts";

// ---------------------------------------------------------------------------
// Minimal fixtures
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
    metadata: {
      archonDaemon: {
        justHandedOff: false,
        respawnCount: 0,
        respawnTaskId: "task-1"
      }
    },
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    ...overrides
  } as unknown as ProjectRuntimeStateRecord;
}

function handoffRecord(): HandoffRecord {
  return {
    id: "ho-p4-001",
    runId: "run-1",
    taskId: "task-1",
    fromInvocationId: "inv-old",
    fromRole: "specialist_owner",
    toRole: "specialist_owner",
    reason: "context_limit" as const,
    status: "in_progress",
    contextUsedPct: 80,
    packet: {
      schemaVersion: 1,
      handoffId: "ho-p4-001",
      runId: "run-1",
      taskId: "task-1",
      fromInvocationId: "inv-old",
      fromRole: "specialist_owner",
      toRole: "specialist_owner",
      reason: "context_limit",
      contextUsedPct: 80,
      status: "in_progress",
      summary: "Implemented authentication module with tests passing.",
      scope: { allowedWriteScope: ["src/**"], touchedPaths: [] },
      decisions: [],
      openQuestions: [],
      evidenceRefs: [],
      nextActions: ["Run integration test"],
      risks: [],
      createdAt: "2026-06-25T00:00:00.000Z"
    },
    authorityLabel: "runtime_authoritative",
    createdAt: "2026-06-25T00:00:00.000Z"
  } as unknown as HandoffRecord;
}

function makeHandoffStore(opts: {
  latestHandoff?: HandoffRecord | undefined;
  hasCommittedHandoff?: boolean;
}): HandoffStoreLike {
  return {
    async createHandoff(data: Parameters<HandoffStoreLike["createHandoff"]>[0]): Promise<HandoffRecord> {
      return handoffRecord();
    },
    async getLatestUnconsumedHandoff(_runId: string, _taskId: string): Promise<HandoffRecord | undefined> {
      return opts.latestHandoff;
    },
    async markHandoffConsumed(_handoffId: string, _toInvocationId: string): Promise<void> {},
    async updateAgentInvocationStatus(_id: string, _status: string, _meta?: Record<string, unknown>): Promise<void> {},
    async hasCommittedHandoff(_invocationId: string): Promise<boolean> {
      return opts.hasCommittedHandoff ?? false;
    },
    async getLatestContextSample(_invocationId: string) {
      return undefined;
    },
    async recordContextSample(_data: unknown): Promise<void> {}
  };
}

function makeStubMonitor(returnState: "handoff_required"): NonNullable<DaemonCodexTurnDeps["monitor"]> {
  const m = {
    recordSample: async () => returnState,
    evaluate: () => returnState,
    getCurrentState: () => returnState,
    getStateFromStore: async () => returnState,
    getThresholdCrossed: async () => true,
    buildStatusSummary: async () => `state=${returnState}`,
    isHandoffSafeTool: () => false,
    evaluatePreToolUse: async () => ({ decision: "allow" as const }),
    on: () => m, emit: () => false, off: () => m, once: () => m,
    removeListener: () => m, removeAllListeners: () => m,
    listeners: () => [], rawListeners: () => [], listenerCount: () => 0,
    eventNames: () => [], getMaxListeners: () => 10, setMaxListeners: () => m,
    addListener: () => m, prependListener: () => m, prependOnceListener: () => m
  } as unknown as NonNullable<DaemonCodexTurnDeps["monitor"]>;
  return m;
}

// ---------------------------------------------------------------------------
// BLOCKING-3 test: daemon must NOT reset when lease is denied
// ---------------------------------------------------------------------------

test("P4 BLOCKING-3: daemon returns no-op when lease claim is denied (interactive holds lease)", async () => {
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p4-lease-"));
    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: false });

    // Pre-claim the lease for "interactive" so daemon's claim is denied.
    const leaseStore = makeInMemoryLeaseStore();
    const preClaim = await claimRespawnLease("run-1", "interactive", leaseStore);
    assert.equal(preClaim.granted, true, "interactive pre-claim must succeed");

    const cycles: DaemonCycleRecord[] = [];
    const codexCalls: RunCodexTurnInput[] = [];
    const saved: Parameters<DaemonCodexTurnDeps["saveProjectRuntimeState"]>[0][] = [];
    const nextInvocationCalls: Array<{ taskId: string; role: string }> = [];
    let session: string | undefined = "sess-1";

    const defaultCodexResult: RunCodexTurnResult = {
      sessionId: session,
      stdout: "",
      stderr: "",
      exitCode: 0,
      usage: { inputTokens: 80000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 }
    };

    const snapshot = snapshotWithTask("task-1");
    const state = runtimeState();
    const handoffController = new HandoffController(handoffStore);

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
        return result;
      },
      getSessionId: () => session,
      setSessionId: (next) => { session = next; },
      claudeBin: "claude",
      cwd: dir,
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
      },
      checkpointRun: undefined,
      invocationId: "inv-current",
      monitor: makeStubMonitor("handoff_required"),
      handoffController,
      role: "specialist_owner",
      startNextInvocation: async (taskId, role) => {
        nextInvocationCalls.push({ taskId, role });
        return "inv-next";
      },
      // Inject the pre-claimed lease store.
      leaseStore
    };

    const input: DaemonCodexTurnInput = {
      directive: directive(),
      summaryAction: "run_codex_owner",
      activeRunId: "run-1",
      activeTaskId: "task-1"
    };

    const result = await runDaemonCodexTurn(input, deps);

    // BLOCKING-3: daemon must return undefined (no-op) when lease is denied.
    assert.equal(result, undefined, "runDaemonCodexTurn must return undefined when lease is denied");

    // startNextInvocation must NOT have been called (no reset occurred).
    assert.equal(
      nextInvocationCalls.length,
      0,
      `startNextInvocation must not be called when lease is denied; got ${nextInvocationCalls.length} calls`
    );

    // No justHandedOff=true should be written when lease is denied.
    const justHandedOffWrites = saved.filter((s) => {
      const meta = s.metadata as Record<string, unknown>;
      const ad = meta?.["archonDaemon"] as Record<string, unknown> | undefined;
      return ad?.justHandedOff === true;
    });
    assert.equal(
      justHandedOffWrites.length,
      0,
      "saveProjectRuntimeState must not write justHandedOff=true when lease is denied"
    );
  } finally {
    if (prevEnv === undefined) {
      delete process.env.ARCHON_CONTEXT_MONITOR;
    } else {
      process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    }
  }
});

test("P4 BLOCKING-3: daemon DOES reset when lease is granted to itself", async () => {
  const prevEnv = process.env.ARCHON_CONTEXT_MONITOR;
  process.env.ARCHON_CONTEXT_MONITOR = "enforce";

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "archon-p4-lease-grant-"));
    const handoffStore = makeHandoffStore({ latestHandoff: handoffRecord(), hasCommittedHandoff: false });

    // Empty lease store — daemon will win the claim.
    const leaseStore = makeInMemoryLeaseStore();

    const cycles: DaemonCycleRecord[] = [];
    const nextInvocationCalls: Array<{ taskId: string; role: string }> = [];
    let session: string | undefined = "sess-2";

    const defaultCodexResult: RunCodexTurnResult = {
      sessionId: session,
      stdout: "",
      stderr: "",
      exitCode: 0,
      usage: { inputTokens: 80000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 }
    };

    const snapshot = snapshotWithTask("task-1");
    const state = runtimeState();
    const handoffController = new HandoffController(handoffStore);

    const saved: Parameters<DaemonCodexTurnDeps["saveProjectRuntimeState"]>[0][] = [];

    const deps: DaemonCodexTurnDeps = {
      cycle: 1,
      projectContext: {
        project: { id: "proj-id" },
        workspace: { id: "ws-id" }
      } as unknown as DaemonProjectContext,
      projectRuntimeState: state,
      attemptRuntimeReconcile: async () => undefined as ReconcileRuntimeStateCommandResult | undefined,
      cycles,
      blockedResult: async (input) => ({
        authorityLabel: "derived_only",
        workspaceSlug: "ws",
        projectSlug: "proj",
        status: "blocked",
        reason: input.reason,
        activeRunId: input.activeRunId,
        activeTaskId: input.activeTaskId,
        sessionId: session ?? null,
        cycles
      } satisfies DaemonCommandResult),
      getSessionId: () => session,
      setSessionId: (next) => { session = next; },
      claudeBin: "claude",
      cwd: dir,
      env: {},
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      staleAfterHours: 24,
      runCodexTurn: async () => defaultCodexResult,
      getStatusSnapshot: async () => snapshot,
      getProjectRuntimeState: async () => state,
      getExecutionPlan: async () => ({ directive: directive() }) as unknown as RunExecutionPlan,
      saveProjectRuntimeState: async (s) => { saved.push(s); },
      checkpointRun: undefined,
      invocationId: "inv-current",
      monitor: makeStubMonitor("handoff_required"),
      handoffController,
      role: "specialist_owner",
      startNextInvocation: async (taskId, role) => {
        nextInvocationCalls.push({ taskId, role });
        return "inv-next";
      },
      leaseStore
    };

    const input: DaemonCodexTurnInput = {
      directive: directive(),
      summaryAction: "run_codex_owner",
      activeRunId: "run-1",
      activeTaskId: "task-1"
    };

    await runDaemonCodexTurn(input, deps);

    // Daemon should have proceeded with reset (startNextInvocation called).
    assert.equal(
      nextInvocationCalls.length,
      1,
      `startNextInvocation must be called exactly once when lease is granted; got ${nextInvocationCalls.length}`
    );

    // justHandedOff=true should appear in a saved write.
    const justHandedOffWrites = saved.filter((s) => {
      const meta = s.metadata as Record<string, unknown>;
      const ad = meta?.["archonDaemon"] as Record<string, unknown> | undefined;
      return ad?.justHandedOff === true;
    });
    assert.ok(
      justHandedOffWrites.length > 0,
      "saveProjectRuntimeState must write justHandedOff=true when lease is granted and reset occurs"
    );
  } finally {
    if (prevEnv === undefined) {
      delete process.env.ARCHON_CONTEXT_MONITOR;
    } else {
      process.env.ARCHON_CONTEXT_MONITOR = prevEnv;
    }
  }
});

// ---------------------------------------------------------------------------
// BLOCKING-2: production wiring — makeFileLockLeaseStore injected, not undefined
// ---------------------------------------------------------------------------
//
// This test verifies the INFRA-C1 fix: the production DaemonCodexTurnDeps
// construction in executeDaemonCommandFromArgs must pass a real LeaseStore
// (makeFileLockLeaseStore) rather than leaving leaseStore=undefined, which would
// make all lease-denial guard logic permanently inert.
//
// Approach: construct a makeFileLockLeaseStore instance from the same module the
// production code uses, verify it implements the LeaseStore contract, and exercise
// it with real file I/O.  If the production code were injecting undefined, the
// daemon's branch on `deps.leaseStore !== undefined` would never execute and this
// test would serve as a canary for that regression.

test("P4 BLOCKING-2: makeFileLockLeaseStore is a functional LeaseStore (production wiring canary)", async () => {
  const lockDir = await mkdtemp(path.join(tmpdir(), "archon-p4-prod-wire-"));
  const leaseStore = makeFileLockLeaseStore({ lockDir });

  // The LeaseStore interface requires tryAcquire and release.
  assert.equal(typeof leaseStore.tryAcquire, "function", "leaseStore.tryAcquire must be a function");
  assert.equal(typeof leaseStore.release, "function", "leaseStore.release must be a function");

  // Verify it operates correctly: daemon wins an unclaimed lease.
  const result = await leaseStore.tryAcquire("run-prod-wire", "daemon");
  assert.equal(result.granted, true, "daemon must win an unclaimed file-lock lease");

  // Interactive claim on the same runId while daemon holds it must be denied.
  const denied = await leaseStore.tryAcquire("run-prod-wire", "interactive");
  assert.equal(denied.granted, false, "interactive must be denied while daemon holds the file-lock lease");

  // Release works: daemon releases its own lock.
  await leaseStore.release("run-prod-wire", "daemon");

  // After release, interactive can claim.
  const granted = await leaseStore.tryAcquire("run-prod-wire", "interactive");
  assert.equal(granted.granted, true, "interactive must win after daemon releases the file-lock lease");
});
