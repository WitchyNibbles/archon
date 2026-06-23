import test from "node:test";
import assert from "node:assert/strict";

// Direct test of the extracted loop-tail handler (daemon loop-monolith split 6n).
// Imports the module path, not the daemon.ts re-export, to lock the module boundary.
//
// The handler has THREE exits:
//   (1) undefined  — reconcile fixed the pointer (was: `continue`)
//   (2) undefined  — codex turn returned undefined (was: natural loop-around)
//   (3) DaemonCommandResult (blocked) — mismatch not reconciled
//   (4) DaemonCommandResult (any)     — codex turn returned a result (blocked / completed)
//
// All deps (attemptRuntimeReconcile, runDaemonCodexTurn, blockedResult, cycles,
// getSessionId) are injected via the deps bag so all paths are exercisable without
// a live DB or filesystem.
import {
  handleDaemonDispatchOwnerTurnStep,
  type DaemonDispatchOwnerTurnInput,
  type DaemonDispatchOwnerTurnDeps
} from "../src/daemon/dispatch-owner-turn.ts";
import type { DaemonBlockedResultInput, DaemonBlockedResultBuilder } from "../src/daemon/codex-turn.ts";
import type { DaemonCommandResult, DaemonCycleRecord } from "../src/daemon.ts";
import type { RunExecutionPlan } from "../src/domain/types.ts";

type AnyDirective = RunExecutionPlan["directive"];
type DispatchOwnerDirective = Extract<AnyDirective, { kind: "dispatch_owner" }>;
type ContinueAnalysisDirective = Extract<AnyDirective, { kind: "continue_analysis" }>;

function dispatchOwnerDirective(taskId = "task-wanted"): DispatchOwnerDirective {
  return {
    kind: "dispatch_owner",
    recommendation: { taskId }
  } as unknown as DispatchOwnerDirective;
}

function continueAnalysisDirective(): ContinueAnalysisDirective {
  return {
    kind: "continue_analysis",
    targetId: "target-1",
    source: "blocking_gap",
    actions: [],
    nextActions: [],
    blockers: []
  } as unknown as ContinueAnalysisDirective;
}

interface Harness {
  input: DaemonDispatchOwnerTurnInput;
  deps: DaemonDispatchOwnerTurnDeps;
  cycles: DaemonCycleRecord[];
  blockedCalls: DaemonBlockedResultInput[];
  reconcileCalls: number[];
  codexCalls: Array<{ summaryAction: string }>;
}

function makeHarness(opts: {
  directive?: AnyDirective;
  activeTaskId?: string;
  /** What attemptRuntimeReconcile returns. undefined = no repair applied. */
  reconcileResult?: { runtimeStateChanged: boolean } | undefined;
  /** What runDaemonCodexTurn returns. undefined = loop continues. */
  codexResult?: DaemonCommandResult | undefined;
  initialSession?: string;
}): Harness {
  const cycles: DaemonCycleRecord[] = [];
  const blockedCalls: DaemonBlockedResultInput[] = [];
  const reconcileCalls: number[] = [];
  const codexCalls: Array<{ summaryAction: string }> = [];

  const blockedResult: DaemonBlockedResultBuilder = async (bi) => {
    blockedCalls.push(bi);
    return {
      authorityLabel: "derived_only",
      workspaceSlug: "ws",
      projectSlug: "proj",
      status: "blocked",
      reason: bi.reason,
      activeRunId: bi.activeRunId,
      activeTaskId: bi.activeTaskId,
      sessionId: opts.initialSession ?? null,
      cycles
    } satisfies DaemonCommandResult;
  };

  const input: DaemonDispatchOwnerTurnInput = {
    directive: opts.directive ?? dispatchOwnerDirective(),
    cycle: 1,
    activeRunId: "run-1",
    activeTaskId: opts.activeTaskId ?? "task-active"
  };

  const deps: DaemonDispatchOwnerTurnDeps = {
    attemptRuntimeReconcile: async (cycle) => {
      reconcileCalls.push(cycle);
      return opts.reconcileResult;
    },
    runDaemonCodexTurn: async (turnInput) => {
      codexCalls.push({ summaryAction: turnInput.summaryAction });
      return opts.codexResult;
    },
    blockedResult,
    cycles,
    getSessionId: () => opts.initialSession
  };

  return { input, deps, cycles, blockedCalls, reconcileCalls, codexCalls };
}

// ---------------------------------------------------------------------------
// Test 1: dispatch_owner mismatch + reconcile fixes pointer → undefined (continue)
// ---------------------------------------------------------------------------

await test("dispatch_owner mismatch: reconcile runtimeStateChanged → returns undefined (loop continues)", async () => {
  const h = makeHarness({
    directive: dispatchOwnerDirective("task-wanted"),
    activeTaskId: "task-active",        // mismatch: wanted ≠ active
    reconcileResult: { runtimeStateChanged: true },
    initialSession: "sess-abc"
  });

  const result = await handleDaemonDispatchOwnerTurnStep(h.input, h.deps);

  assert.equal(result, undefined, "should return undefined so the loop advances to next cycle");
  assert.equal(h.reconcileCalls.length, 1, "reconcile should have been called once");
  assert.equal(h.reconcileCalls[0], 1, "reconcile should receive the cycle number");
  assert.equal(h.codexCalls.length, 0, "codex should NOT be called when reconcile fires");
  assert.equal(h.blockedCalls.length, 0, "blockedResult should NOT be called");
  assert.equal(h.cycles.length, 0, "no cycle record pushed when reconcile succeeds");
});

// ---------------------------------------------------------------------------
// Test 2: dispatch_owner mismatch + reconcile does NOT fix → blocked result
// ---------------------------------------------------------------------------

await test("dispatch_owner mismatch: reconcile no runtimeStateChanged → blocked active_task_mismatch", async () => {
  const h = makeHarness({
    directive: dispatchOwnerDirective("task-wanted"),
    activeTaskId: "task-active",
    reconcileResult: { runtimeStateChanged: false },
    initialSession: "sess-xyz"
  });

  const result = await handleDaemonDispatchOwnerTurnStep(h.input, h.deps);

  assert.ok(result !== undefined, "should return a DaemonCommandResult");
  assert.equal(result.status, "blocked");
  assert.equal(h.blockedCalls.length, 1);
  assert.equal(h.blockedCalls[0]!.blockerKind, "active_task_mismatch");
  assert.match(h.blockedCalls[0]!.reason, /owner dispatch target/);
  assert.ok(Array.isArray(h.blockedCalls[0]!.nextActions) && (h.blockedCalls[0]!.nextActions?.length ?? 0) > 0,
    "nextActions should be populated");
  assert.equal(h.cycles.length, 1, "one cycle record pushed for the mismatch");
  assert.match(h.cycles[0]!.summary, /runtime wants task-wanted but active task is task-active/);
  assert.equal(h.cycles[0]!.sessionId, "sess-xyz");
  assert.equal(h.codexCalls.length, 0, "codex should NOT be called on mismatch");
});

// ---------------------------------------------------------------------------
// Test 3: dispatch_owner mismatch + reconcile returns undefined → blocked result
// ---------------------------------------------------------------------------

await test("dispatch_owner mismatch: reconcile returns undefined (no repair applied) → blocked", async () => {
  const h = makeHarness({
    directive: dispatchOwnerDirective("task-other"),
    activeTaskId: "task-active",
    reconcileResult: undefined,   // no repair was applied
    initialSession: "sess-unrec"
  });

  const result = await handleDaemonDispatchOwnerTurnStep(h.input, h.deps);

  assert.ok(result !== undefined);
  assert.equal(result.status, "blocked");
  assert.equal(h.blockedCalls[0]!.blockerKind, "active_task_mismatch");
  assert.equal(h.codexCalls.length, 0);
  assert.equal(h.cycles[0]!.sessionId, "sess-unrec");
});

// ---------------------------------------------------------------------------
// Test 4: dispatch_owner with MATCHING taskId → codex runs with run_codex_owner
// ---------------------------------------------------------------------------

await test("dispatch_owner with matching activeTaskId → codex runs with run_codex_owner summaryAction", async () => {
  const h = makeHarness({
    directive: dispatchOwnerDirective("task-active"),  // matches activeTaskId
    activeTaskId: "task-active",
    codexResult: undefined   // codex made progress, loop continues
  });

  const result = await handleDaemonDispatchOwnerTurnStep(h.input, h.deps);

  assert.equal(result, undefined, "codex returned undefined → handler returns undefined");
  assert.equal(h.reconcileCalls.length, 0, "reconcile should NOT run when tasks match");
  assert.equal(h.codexCalls.length, 1, "codex should be called");
  assert.equal(h.codexCalls[0]!.summaryAction, "run_codex_owner");
  assert.equal(h.blockedCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Test 5: non-dispatch_owner directive (continue_analysis) → codex runs with
// run_codex_analysis, returns undefined when no stall
// ---------------------------------------------------------------------------

await test("non-dispatch_owner directive (continue_analysis) → run_codex_analysis", async () => {
  const h = makeHarness({
    directive: continueAnalysisDirective(),
    activeTaskId: "task-active",
    codexResult: undefined
  });

  const result = await handleDaemonDispatchOwnerTurnStep(h.input, h.deps);

  assert.equal(result, undefined);
  assert.equal(h.reconcileCalls.length, 0, "mismatch guard skipped for non-dispatch_owner");
  assert.equal(h.codexCalls.length, 1);
  assert.equal(h.codexCalls[0]!.summaryAction, "run_codex_analysis");
});

// ---------------------------------------------------------------------------
// Test 6: codex turn returns a blocked result → handler surfaces it
// ---------------------------------------------------------------------------

await test("codex turn returns a DaemonCommandResult → handler returns it (blocked surfaced)", async () => {
  const blockedCommandResult: DaemonCommandResult = {
    authorityLabel: "derived_only",
    workspaceSlug: "ws",
    projectSlug: "proj",
    status: "blocked",
    reason: "codex stalled",
    activeRunId: "run-1",
    activeTaskId: "task-active",
    sessionId: null,
    cycles: []
  };

  const h = makeHarness({
    directive: dispatchOwnerDirective("task-active"),
    activeTaskId: "task-active",
    codexResult: blockedCommandResult
  });

  const result = await handleDaemonDispatchOwnerTurnStep(h.input, h.deps);

  assert.ok(result !== undefined);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "codex stalled");
  assert.equal(h.blockedCalls.length, 0, "blockedResult builder NOT called — codex returned its own result");
  assert.equal(h.cycles.length, 0, "no extra cycle pushed by the handler itself");
});
