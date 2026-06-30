import test from "node:test";
import assert from "node:assert/strict";

// Direct test of the extracted complete directive handler (daemon loop-monolith split 6k).
// Imports the module path, not the daemon.ts re-export, to lock the module boundary.
// The handler had ZERO direct coverage before extraction — it was only reachable
// transitively through the full daemon loop (which needs a live DB).
//
// advanceActiveTask is INJECTABLE via the deps bag (not a direct module import),
// so both success paths can be exercised with a fake in unit tests. Throw paths
// are exercised via getProjectContext to confirm the catch-and-classify branch still
// works when the injected function is replaced by options-level stubs.
//
// What IS covered here:
//   (a) advance throws commit-guard message          → blocked via classifyAdvanceFailure
//   (b) advance throws generic error                 → runtime_blocked result
//   (c) classifyAdvanceFailure mapping               → regression-locks the moved function
//   (d) cycle record content for throw paths         → verifies sessionId plumbing
//   (e) advance fake succeeds WITH nextTaskId        → returns undefined (loop continues)
//   (f) advance fake succeeds WITHOUT nextTaskId     → "completed" DaemonCommandResult
//
// Tests (e) and (f) inject a fake advanceActiveTask function so no real DB is needed.
import {
  handleDaemonComplete,
  classifyAdvanceFailure,
  type AdvanceActiveTaskFn,
  type DaemonCompleteInput,
  type DaemonCompleteDeps
} from "../src/daemon/complete.ts";
import type { DaemonBlockedResultInput, DaemonBlockedResultBuilder } from "../src/daemon/codex-turn.ts";
import type { DaemonCommandResult, DaemonCycleRecord, ExecuteDaemonCommandOptions } from "../src/daemon.ts";
import type { RunExecutionPlan } from "../src/domain/types.ts";

type CompleteDirective = Extract<RunExecutionPlan["directive"], { kind: "complete" }>;

function completeDirective(): CompleteDirective {
  return { kind: "complete" } as unknown as CompleteDirective;
}

interface Harness {
  input: DaemonCompleteInput;
  deps: DaemonCompleteDeps;
  cycles: DaemonCycleRecord[];
  blockedCalls: DaemonBlockedResultInput[];
  session: () => string | undefined;
}

/**
 * Build a minimal harness for handleDaemonComplete.
 *
 * advanceActiveTask is injected via deps, so callers control both throw and
 * success paths without any DB infrastructure:
 *
 *   Throw path:  pass `advanceThrow` — the default advanceActiveTask fake throws it.
 *                Also accepts `getProjectContext`/`getProjectContextThrow` for
 *                legacy compatibility (mapped to an equivalent throwing fake).
 *   Success path: pass `advanceActiveTask` directly — a fake that returns a result.
 *
 * `getProjectRuntimeState` on options is used only by the no-nextTaskId success path
 * to refresh state after the advance; pass `getProjectRuntimeState` to control it.
 */
function makeHarness(opts: {
  /**
   * Inject a custom advanceActiveTask fake (success-path tests).
   * If omitted, defaults to a fake that throws `advanceThrow` or
   * the legacy `getProjectContextThrow` error.
   */
  advanceActiveTask?: AdvanceActiveTaskFn;
  /** Legacy: error to throw from the default advanceActiveTask fake. */
  getProjectContextThrow?: Error;
  /** Legacy: if provided and no throw, fake throws "Project not bootstrapped". */
  getProjectContext?: () => Promise<undefined | null>;
  /** Controls options.getProjectRuntimeState (used by the completed path). */
  getProjectRuntimeState?: () => Promise<{ activeRunId: string | null; activeTaskId: string | null } | undefined>;
  initialSession?: string;
  /** W1: injectable closure reconciler invoked on the exhausted-queue path. */
  reconcileClosure?: (runId: string) => Promise<void>;
  /** Observer for a reconcileClosure failure (must fire instead of silent swallow). */
  onClosureError?: (error: unknown, runId: string) => void;
}): Harness {
  const cycles: DaemonCycleRecord[] = [];
  const blockedCalls: DaemonBlockedResultInput[] = [];
  const session: string | undefined = opts.initialSession;

  const blockedResult: DaemonBlockedResultBuilder = async (blockedInput) => {
    blockedCalls.push(blockedInput);
    return {
      authorityLabel: "derived_only",
      workspaceSlug: "ws",
      projectSlug: "proj",
      status: "blocked",
      reason: blockedInput.reason,
      activeRunId: blockedInput.activeRunId,
      activeTaskId: blockedInput.activeTaskId,
      sessionId: session ?? null,
      cycles
    } satisfies DaemonCommandResult;
  };

  // Default advanceActiveTask: throw path based on legacy options, or "not configured".
  const defaultAdvanceActiveTask: AdvanceActiveTaskFn = async () => {
    if (opts.getProjectContextThrow) {
      throw opts.getProjectContextThrow;
    }
    // Legacy: getProjectContext returning undefined → mimic "Project not bootstrapped" throw.
    if (opts.getProjectContext) {
      const ctx = await opts.getProjectContext();
      if (!ctx) throw new Error("Project not bootstrapped");
    }
    throw new Error("no advanceActiveTask stub configured");
  };

  const options = {
    getProjectRuntimeState: opts.getProjectRuntimeState ?? (async () => undefined)
  } as unknown as ExecuteDaemonCommandOptions;

  const input: DaemonCompleteInput = {
    directive: completeDirective(),
    cycle: 1,
    activeRunId: "run-1",
    activeTaskId: "task-1"
  };

  const deps: DaemonCompleteDeps = {
    options,
    workspaceSlug: "ws",
    projectSlug: "proj",
    projectId: "project-id-1",
    cycles,
    getSessionId: () => session,
    blockedResult,
    advanceActiveTask: opts.advanceActiveTask ?? defaultAdvanceActiveTask,
    reconcileClosure: opts.reconcileClosure,
    onClosureError: opts.onClosureError
  };

  return { input, deps, cycles, blockedCalls, session: () => session };
}

// ---------------------------------------------------------------------------
// classifyAdvanceFailure mapping (regression-locks the moved function)
// ---------------------------------------------------------------------------

test("classifyAdvanceFailure: commit-guard throw → uncommitted_deliverables with commit guidance", () => {
  const err = new Error(
    'advance-active-task refusing to close task "t1": 2 uncommitted change(s) inside its write scope are not committed: src/a.ts, tests/b.ts.'
  );
  const r = classifyAdvanceFailure(err);
  assert.equal(r.blockerKind, "uncommitted_deliverables");
  assert.match(r.reason, /refusing to close task "t1"/);
  assert.ok(r.nextActions.length > 0);
  assert.ok(r.nextActions.some((a) => /commit/i.test(a)));
  assert.ok(r.nextActions.some((a) => /--allow-uncommitted/.test(a)));
});

test("classifyAdvanceFailure: generic error → runtime_blocked, reason preserved", () => {
  const r = classifyAdvanceFailure(new Error("runtime queue current_task_id mismatch"));
  assert.equal(r.blockerKind, "runtime_blocked");
  assert.match(r.reason, /runtime queue current_task_id mismatch/);
  assert.ok(r.nextActions.length > 0);
});

test("classifyAdvanceFailure: non-Error throw is stringified into the reason", () => {
  const r = classifyAdvanceFailure("boom");
  assert.equal(r.blockerKind, "runtime_blocked");
  assert.match(r.reason, /boom/);
});

test("classifyAdvanceFailure: bare 'uncommitted change(s)' without guard phrase → runtime_blocked", () => {
  // Guards against loose-arm misclassification: only the full guard phrase
  // ("... inside its write scope") should map to uncommitted_deliverables.
  const r = classifyAdvanceFailure(new Error("2 uncommitted change(s) in submodule"));
  assert.equal(r.blockerKind, "runtime_blocked");
});

// ---------------------------------------------------------------------------
// handleDaemonComplete: advance throws commit-guard → uncommitted_deliverables blocker
// ---------------------------------------------------------------------------

test("handleDaemonComplete: advance throws commit-guard error → uncommitted_deliverables blocked result", async () => {
  // Simulate the commit guard throwing from inside executeAdvanceActiveTaskCommandFromArgs.
  // We inject this throw via getProjectContext so no real DB is needed.
  const harness = makeHarness({
    getProjectContextThrow: new Error(
      'refusing to close task "task-1": 1 uncommitted change(s) inside its write scope: src/foo.ts'
    ),
    initialSession: "sess-1"
  });

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.ok(result !== undefined, "must return a result (not loop-continue undefined)");
  assert.equal(result.status, "blocked");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  assert.equal(harness.cycles[0]!.directiveKind, "complete");
  assert.equal(harness.cycles[0]!.runId, "run-1");
  assert.equal(harness.cycles[0]!.taskId, "task-1");
  assert.equal(harness.cycles[0]!.sessionId, "sess-1", "cycle reads session via live getter");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "uncommitted_deliverables");
  assert.match(harness.blockedCalls[0]!.reason, /refusing to close task/);
  assert.equal(harness.blockedCalls[0]!.activeRunId, "run-1");
  assert.equal(harness.blockedCalls[0]!.activeTaskId, "task-1");
  assert.equal(harness.blockedCalls[0]!.directiveKind, "complete");
  assert.ok(
    Array.isArray(harness.blockedCalls[0]!.nextActions) &&
      harness.blockedCalls[0]!.nextActions.length > 0
  );
});

// ---------------------------------------------------------------------------
// handleDaemonComplete: advance throws generic error → runtime_blocked
// ---------------------------------------------------------------------------

test("handleDaemonComplete: advance throws generic error → runtime_blocked result", async () => {
  const harness = makeHarness({
    getProjectContextThrow: new Error("runtime queue current_task_id mismatch"),
    initialSession: "sess-2"
  });

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.ok(result !== undefined);
  assert.equal(result.status, "blocked");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  assert.equal(harness.cycles[0]!.sessionId, "sess-2");
  assert.equal(harness.blockedCalls[0]!.blockerKind, "runtime_blocked");
  assert.match(harness.blockedCalls[0]!.reason, /runtime queue current_task_id mismatch/);
});

// ---------------------------------------------------------------------------
// handleDaemonComplete: advance fails without an Error object → stringified reason
// ---------------------------------------------------------------------------

test("handleDaemonComplete: advance throws a non-Error value → reason is stringified", async () => {
  const harness = makeHarness({
    getProjectContextThrow: "string-throw" as unknown as Error,
    initialSession: "sess-3"
  });

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.ok(result !== undefined);
  assert.equal(result.status, "blocked");
  assert.equal(harness.blockedCalls[0]!.blockerKind, "runtime_blocked");
  assert.match(harness.blockedCalls[0]!.reason, /string-throw/);
});

// ---------------------------------------------------------------------------
// handleDaemonComplete: advance getProjectContext returns undefined → throws early
// ---------------------------------------------------------------------------

test("handleDaemonComplete: advance getProjectContext returns undefined → blocked (project not bootstrapped)", async () => {
  // executeAdvanceActiveTaskCommandFromArgs throws "Project not bootstrapped"
  // when getProjectContext returns undefined. This exercises the catch branch.
  const harness = makeHarness({
    getProjectContext: async () => undefined,
    initialSession: "sess-4"
  });

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.ok(result !== undefined);
  assert.equal(result.status, "blocked");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  assert.match(harness.blockedCalls[0]!.reason, /advance-active-task failed/);
});

// ---------------------------------------------------------------------------
// handleDaemonComplete: session id read via live getter at cycle-push time
// ---------------------------------------------------------------------------

test("handleDaemonComplete: session id is read via live getter, not captured snapshot", async () => {
  // This test verifies getSessionId() is called at cycle-push time inside the
  // catch block, not captured at handler-construction time.
  const harness = makeHarness({
    getProjectContextThrow: new Error("boom"),
    initialSession: "live-session"
  });

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.ok(result !== undefined);
  assert.equal(
    harness.cycles[0]!.sessionId,
    "live-session",
    "cycle record uses live getter value at push time"
  );
});

// ---------------------------------------------------------------------------
// handleDaemonComplete success paths (injectable advanceActiveTask fake)
// ---------------------------------------------------------------------------

test("handleDaemonComplete: advance succeeds WITH nextTaskId → returns undefined (loop continues), cycle record pushed", async () => {
  // Success path (e): nextTaskId is set, so the handler signals the loop to continue
  // by returning undefined. A cycle record with action "advance_active_task" is pushed.
  const fakeAdvance: AdvanceActiveTaskFn = async () => ({
    format: "json",
    result: {
      mode: "applied",
      taskId: "task-1",
      nextTaskId: "task-2",
      proof: {} as never,
      queue: {} as never,
      uncommittedInScope: []
    }
  });

  const harness = makeHarness({
    advanceActiveTask: fakeAdvance,
    initialSession: "sess-next"
  });

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.equal(result, undefined, "must return undefined to signal loop continue");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "advance_active_task");
  assert.equal(harness.cycles[0]!.directiveKind, "complete");
  assert.equal(harness.cycles[0]!.runId, "run-1");
  assert.equal(harness.cycles[0]!.taskId, "task-1");
  assert.equal(harness.cycles[0]!.sessionId, "sess-next");
  assert.match(harness.cycles[0]!.summary, /advanced to task-2/);
  assert.equal(harness.blockedCalls.length, 0, "no blocked result on success");
});

test("handleDaemonComplete: advance succeeds WITHOUT nextTaskId → returns completed DaemonCommandResult with refreshed state", async () => {
  // Success path (f): no nextTaskId means the run is finished. The handler reads
  // refreshed runtime state from options.getProjectRuntimeState(projectId) and
  // returns a DaemonCommandResult with status "completed" and the refreshed ids.
  const fakeAdvance: AdvanceActiveTaskFn = async () => ({
    format: "json",
    result: {
      mode: "applied",
      taskId: "task-final",
      nextTaskId: null,
      proof: {} as never,
      queue: {} as never,
      uncommittedInScope: []
    }
  });

  const harness = makeHarness({
    advanceActiveTask: fakeAdvance,
    getProjectRuntimeState: async () => ({
      activeRunId: "run-refreshed",
      activeTaskId: null
    }),
    initialSession: "sess-done"
  });
  // Override input to match the task-final id so cycle record is correct.
  harness.input.activeTaskId = "task-final";

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.ok(result !== undefined, "must return a result (completed, not loop-continue)");
  assert.equal(result.status, "completed");
  assert.equal(result.authorityLabel, "derived_only");
  assert.equal(result.activeRunId, "run-refreshed", "refreshed runId from getProjectRuntimeState");
  assert.equal(result.activeTaskId, null, "refreshed taskId from getProjectRuntimeState");
  assert.equal(result.sessionId, "sess-done");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "complete");
  assert.equal(harness.cycles[0]!.directiveKind, "complete");
  assert.equal(harness.cycles[0]!.taskId, "task-final");
  assert.match(harness.cycles[0]!.summary, /advanced the final active task/);
  assert.equal(harness.blockedCalls.length, 0, "no blocked result on success");
});

test("handleDaemonComplete: completed path with getProjectRuntimeState undefined → activeRunId/activeTaskId null", async () => {
  // Edge of the completed path: advance closes the final task but the refreshed
  // runtime state read returns undefined. The `refreshedState?.x ?? null` fallbacks
  // must both coerce to null (not undefined) in the returned DaemonCommandResult.
  const fakeAdvance: AdvanceActiveTaskFn = async () => ({
    format: "json",
    result: {
      mode: "applied",
      taskId: "task-final",
      nextTaskId: null,
      proof: {} as never,
      queue: {} as never,
      uncommittedInScope: []
    }
  });

  const harness = makeHarness({
    advanceActiveTask: fakeAdvance,
    getProjectRuntimeState: async () => undefined,
    initialSession: "sess-none"
  });
  harness.input.activeTaskId = "task-final";

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.ok(result !== undefined, "must return a completed result");
  assert.equal(result.status, "completed");
  assert.equal(result.activeRunId, null, "undefined refreshed state → activeRunId null");
  assert.equal(result.activeTaskId, null, "undefined refreshed state → activeTaskId null");
  assert.equal(harness.cycles[0]!.action, "complete");
  assert.equal(harness.blockedCalls.length, 0);
});

// ---------------------------------------------------------------------------
// W1 both-surfaces: reconcileClosure on the exhausted-queue path (daemonCloseOnComplete)
// ---------------------------------------------------------------------------

const exhaustingAdvance: AdvanceActiveTaskFn = async () => ({
  format: "json",
  result: { mode: "applied", taskId: "task-final", nextTaskId: null, proof: {} as never, queue: {} as never, uncommittedInScope: [] }
});

const advanceWithNext: AdvanceActiveTaskFn = async () => ({
  format: "json",
  result: { mode: "applied", taskId: "task-1", nextTaskId: "task-2", proof: {} as never, queue: {} as never, uncommittedInScope: [] }
});

test("handleDaemonComplete: reconcileClosure IS invoked (with the run id) when the queue is exhausted", async () => {
  const sealed: string[] = [];
  const harness = makeHarness({
    advanceActiveTask: exhaustingAdvance,
    getProjectRuntimeState: async () => ({ activeRunId: "run-1", activeTaskId: null }),
    reconcileClosure: async (runId) => { sealed.push(runId); }
  });
  const result = await handleDaemonComplete(harness.input, harness.deps);
  assert.equal(result?.status, "completed");
  assert.deepEqual(sealed, ["run-1"], "closure runs for the exhausted run");
});

test("handleDaemonComplete: reconcileClosure is NOT invoked when a next task exists", async () => {
  const sealed: string[] = [];
  const harness = makeHarness({
    advanceActiveTask: advanceWithNext,
    reconcileClosure: async (runId) => { sealed.push(runId); }
  });
  const result = await handleDaemonComplete(harness.input, harness.deps);
  assert.equal(result, undefined, "loop continues");
  assert.deepEqual(sealed, [], "closure does not run while tasks remain");
});

test("handleDaemonComplete: a throwing reconcileClosure does NOT crash the loop (best-effort)", async () => {
  const harness = makeHarness({
    advanceActiveTask: exhaustingAdvance,
    getProjectRuntimeState: async () => ({ activeRunId: "run-1", activeTaskId: null }),
    reconcileClosure: async () => { throw new Error("seal failed"); }
  });
  const result = await handleDaemonComplete(harness.input, harness.deps);
  assert.equal(result?.status, "completed", "completion is still reported despite a closure failure");
});

test("handleDaemonComplete: a throwing reconcileClosure is SURFACED via onClosureError (not silently swallowed)", async () => {
  const observed: { error: unknown; runId: string }[] = [];
  const failure = new Error("seal failed");
  const harness = makeHarness({
    advanceActiveTask: exhaustingAdvance,
    getProjectRuntimeState: async () => ({ activeRunId: "run-1", activeTaskId: null }),
    reconcileClosure: async () => { throw failure; },
    onClosureError: (error, runId) => observed.push({ error, runId })
  });

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.equal(result?.status, "completed", "completion is still reported");
  assert.equal(observed.length, 1, "onClosureError must fire exactly once on a closure failure");
  assert.equal(observed[0]!.error, failure, "the original error is handed to the observer");
  assert.equal(observed[0]!.runId, "run-1", "the failing run id is handed to the observer");
});

test("handleDaemonComplete: onClosureError is NOT called when closure succeeds", async () => {
  const observed: unknown[] = [];
  const harness = makeHarness({
    advanceActiveTask: exhaustingAdvance,
    getProjectRuntimeState: async () => ({ activeRunId: "run-1", activeTaskId: null }),
    reconcileClosure: async () => { /* succeeds */ },
    onClosureError: (error) => observed.push(error)
  });

  const result = await handleDaemonComplete(harness.input, harness.deps);

  assert.equal(result?.status, "completed");
  assert.equal(observed.length, 0, "onClosureError must not fire when closure succeeds");
});
