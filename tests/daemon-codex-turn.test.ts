import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Direct test of the extracted codex-turn runner (daemon loop-monolith split 6h).
// Imports the module path, not the daemon.ts re-export, to lock the module
// boundary. The runner had ZERO direct coverage before extraction — it was only
// reachable transitively through the full daemon loop (which needs a live DB).
//
// The headline behavior under test is the session write-back trap: the runner
// both READS and WRITES the loop's latestSessionId, threaded as a getter/setter
// holder pair. A pass-by-value capture would silently break session continuity.
import {
  runDaemonCodexTurn,
  type DaemonBlockedResultInput,
  type DaemonCodexTurnDeps,
  type DaemonCodexTurnInput,
  type DaemonProjectContext
} from "../src/daemon/codex-turn.ts";
import type { DaemonCommandResult, DaemonCycleRecord } from "../src/daemon.ts";
import type {
  ContinueAnalysisExecutionDirective,
  ProjectRuntimeStateRecord,
  RunExecutionPlan,
  RunStatusSnapshot
} from "../src/domain/types.ts";
import { buildDaemonProgressKey, buildDaemonTaskPacketFingerprint } from "../src/daemon/turn-prompt.ts";
import type { RunCodexTurnInput, RunCodexTurnResult } from "../src/daemon/turn-prompt.ts";
import type { ReconcileRuntimeStateCommandResult } from "../src/runtime.ts";

function directive(
  overrides: Partial<ContinueAnalysisExecutionDirective> = {}
): RunExecutionPlan["directive"] {
  return {
    kind: "continue_analysis",
    rationale: [],
    targetId: "task:demo",
    source: "checkpoint",
    actions: [],
    nextActions: ["next action"],
    blockers: [],
    ...overrides
  };
}

function snapshotWithTask(opts: { taskId: string; runStatus?: string } = { taskId: "task-1" }): RunStatusSnapshot {
  return {
    run: { status: opts.runStatus ?? "in_progress" },
    tasks: [
      {
        packet: { taskId: opts.taskId, allowedWriteScope: [] },
        status: "in_progress",
        updatedAt: "2026-06-23T00:00:00.000Z"
      }
    ],
    autonomousExecution: undefined
  } as unknown as RunStatusSnapshot;
}

function emptySnapshot(): RunStatusSnapshot {
  return {
    run: { status: "in_progress" },
    tasks: [],
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
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    ...overrides
  } as unknown as ProjectRuntimeStateRecord;
}

function turnInput(overrides: Partial<DaemonCodexTurnInput> = {}): DaemonCodexTurnInput {
  return {
    directive: directive(),
    summaryAction: "run_codex_analysis",
    activeRunId: "run-1",
    activeTaskId: "task-1",
    ...overrides
  };
}

type SavedState = Parameters<DaemonCodexTurnDeps["saveProjectRuntimeState"]>[0];

interface Harness {
  deps: DaemonCodexTurnDeps;
  cycles: DaemonCycleRecord[];
  blockedCalls: DaemonBlockedResultInput[];
  codexCalls: RunCodexTurnInput[];
  saved: SavedState[];
  reconcileCycles: number[];
  session: () => string | undefined;
}

function makeDeps(opts: {
  cwd: string;
  directive: RunExecutionPlan["directive"];
  initialSnapshot: RunStatusSnapshot;
  refreshedSnapshot?: RunStatusSnapshot;
  refreshedPlanDirective?: RunExecutionPlan["directive"];
  projectRuntimeState?: ProjectRuntimeStateRecord | undefined;
  refreshedProjectRuntimeState?: ProjectRuntimeStateRecord | undefined;
  codexResult: RunCodexTurnResult;
  reconcileResult?: ReconcileRuntimeStateCommandResult | undefined;
  initialSession?: string | undefined;
}): Harness {
  const cycles: DaemonCycleRecord[] = [];
  const blockedCalls: DaemonBlockedResultInput[] = [];
  const codexCalls: RunCodexTurnInput[] = [];
  const saved: SavedState[] = [];
  const reconcileCycles: number[] = [];
  let session: string | undefined = opts.initialSession;
  let snapshotCalls = 0;

  const deps: DaemonCodexTurnDeps = {
    cycle: 3,
    projectContext: {
      project: { id: "proj-id" },
      workspace: { id: "ws-id" }
    } as unknown as DaemonProjectContext,
    projectRuntimeState: opts.projectRuntimeState,
    attemptRuntimeReconcile: async (cycle) => {
      reconcileCycles.push(cycle);
      return opts.reconcileResult;
    },
    cycles,
    blockedResult: async (blockedInput) => {
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
    },
    getSessionId: () => session,
    setSessionId: (next) => {
      session = next;
    },
    claudeBin: "claude",
    cwd: opts.cwd,
    env: {},
    now: () => new Date("2026-06-23T00:00:00.000Z"),
    staleAfterHours: 24,
    runCodexTurn: async (codexInput) => {
      codexCalls.push(codexInput);
      return opts.codexResult;
    },
    getStatusSnapshot: async () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? opts.initialSnapshot : opts.refreshedSnapshot ?? opts.initialSnapshot;
    },
    getProjectRuntimeState: async () => opts.refreshedProjectRuntimeState ?? opts.projectRuntimeState,
    getExecutionPlan: async () =>
      ({ directive: opts.refreshedPlanDirective ?? opts.directive }) as unknown as RunExecutionPlan,
    saveProjectRuntimeState: async (state) => {
      saved.push(state);
    },
    checkpointRun: undefined
  };

  return { deps, cycles, blockedCalls, codexCalls, saved, reconcileCycles, session: () => session };
}

function archonDaemonMeta(state: SavedState): { sessionId?: string | undefined; stagnation?: unknown } {
  return (state.metadata as { archonDaemon?: { sessionId?: string | undefined; stagnation?: unknown } })
    .archonDaemon ?? {};
}

test("runDaemonCodexTurn: missing task + reconcile change returns the continue signal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const harness = makeDeps({
    cwd: dir,
    directive: directive(),
    initialSnapshot: emptySnapshot(),
    codexResult: { sessionId: "sess", stdout: "", stderr: "", exitCode: 0 },
    reconcileResult: { runtimeStateChanged: true } as unknown as ReconcileRuntimeStateCommandResult
  });

  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  assert.equal(result, undefined, "reconcile changing state means the loop should re-evaluate");
  assert.deepEqual(harness.reconcileCycles, [3], "reconcile is attempted with the loop cycle");
  assert.equal(harness.codexCalls.length, 0, "no codex turn runs when the task is missing");
  assert.equal(harness.blockedCalls.length, 0);
});

test("runDaemonCodexTurn: missing task + no reconcile change blocks runtime_task_missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const harness = makeDeps({
    cwd: dir,
    directive: directive(),
    initialSnapshot: emptySnapshot(),
    codexResult: { stdout: "", stderr: "", exitCode: 0 },
    reconcileResult: undefined,
    initialSession: "sess-live"
  });

  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "runtime_task_missing");
  assert.equal(harness.codexCalls.length, 0);
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  assert.equal(harness.cycles[0]!.sessionId, "sess-live", "blocked cycle reads the session via the live getter");
});

test("runDaemonCodexTurn: progress turn writes the new session id through the holder and continues", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const dir0 = directive();
  // refreshed snapshot differs (run.status) -> beforeProgressKey !== afterProgressKey
  // -> noProgress=false -> the turn made progress and the loop should continue.
  const harness = makeDeps({
    cwd: dir,
    directive: dir0,
    initialSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" }),
    refreshedSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_review" }),
    projectRuntimeState: runtimeState(),
    refreshedProjectRuntimeState: runtimeState(),
    codexResult: {
      sessionId: "sess-new",
      finalMessage: JSON.stringify({ status: "completed", summary: "did the work" }),
      stdout: "",
      stderr: "",
      exitCode: 0
    },
    initialSession: "sess-old"
  });

  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  assert.equal(result, undefined, "a progress turn returns the continue signal");
  // The codex turn was invoked with the PRE-write session id (live read).
  assert.equal(harness.codexCalls.length, 1);
  assert.equal(harness.codexCalls[0]!.sessionId, "sess-old");
  // The holder now observes the codex turn's new session id (the write trap).
  assert.equal(harness.session(), "sess-new", "setSessionId wrote the holder");
  // The persisted runtime state and the cycle record both reflect the new id.
  assert.equal(harness.saved.length, 1);
  assert.equal(archonDaemonMeta(harness.saved[0]!).sessionId, "sess-new");
  const turnCycle = harness.cycles.find((c) => c.action === "run_codex_analysis");
  assert.ok(turnCycle, "the successful turn pushes its summary cycle");
  assert.equal(turnCycle!.sessionId, "sess-new");
});

test("runDaemonCodexTurn: an undefined turn session id leaves the prior session id intact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const harness = makeDeps({
    cwd: dir,
    directive: directive(),
    initialSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" }),
    refreshedSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_review" }),
    projectRuntimeState: runtimeState(),
    refreshedProjectRuntimeState: runtimeState(),
    codexResult: {
      // no sessionId on the result
      finalMessage: JSON.stringify({ status: "completed", summary: "ok" }),
      stdout: "",
      stderr: "",
      exitCode: 0
    },
    initialSession: "sess-kept"
  });

  await runDaemonCodexTurn(turnInput(), harness.deps);

  // setSessionId(codexTurn.sessionId ?? getSessionId()) preserves the old id.
  assert.equal(harness.session(), "sess-kept");
  assert.equal(archonDaemonMeta(harness.saved[0]!).sessionId, "sess-kept");
});

test("runDaemonCodexTurn: a blocked no-progress turn blocks runtime_blocked", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const snapshot = snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" });
  const state = runtimeState();
  const dir0 = directive();
  // Same snapshot/state/directive on both reads -> noProgress=true; the worker
  // reported "blocked" -> the turn blocks.
  const harness = makeDeps({
    cwd: dir,
    directive: dir0,
    initialSnapshot: snapshot,
    refreshedSnapshot: snapshot,
    refreshedPlanDirective: dir0,
    projectRuntimeState: state,
    refreshedProjectRuntimeState: state,
    codexResult: {
      sessionId: "sess-x",
      finalMessage: JSON.stringify({ status: "blocked", summary: "worker hit a wall" }),
      stdout: "",
      stderr: "",
      exitCode: 0
    },
    initialSession: "sess-x0"
  });

  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "runtime_blocked");
  // The turn cycle plus the no-progress block cycle are both recorded.
  assert.ok(harness.cycles.some((c) => c.action === "run_codex_analysis"));
  assert.ok(harness.cycles.some((c) => c.action === "blocked"));
  // Stagnation metadata is persisted on the no-progress save.
  assert.ok(archonDaemonMeta(harness.saved[0]!).stagnation, "no-progress turn records stagnation metadata");
});

test("runDaemonCodexTurn: a scope-conflict no-progress turn requests scope expansion", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const snapshot = snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" });
  const state = runtimeState();
  const dir0 = directive();
  const harness = makeDeps({
    cwd: dir,
    directive: dir0,
    initialSnapshot: snapshot,
    refreshedSnapshot: snapshot,
    refreshedPlanDirective: dir0,
    projectRuntimeState: state,
    refreshedProjectRuntimeState: state,
    codexResult: {
      sessionId: "sess-y",
      finalMessage: JSON.stringify({
        status: "blocked",
        summary: "the required edit is out of scope",
        scope_request: {
          blocked_paths: ["src/forbidden.ts"],
          requested_write_scope: ["src/forbidden.ts"],
          reason: "need to edit the forbidden module"
        }
      }),
      stdout: "",
      stderr: "",
      exitCode: 0
    },
    initialSession: "sess-y0"
  });

  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.blockedCalls[0]!.blockerKind, "scope_expansion_required");
  assert.ok(harness.cycles.some((c) => c.action === "request_scope_expansion"));
  // The scope-expansion request file was written under cwd and referenced.
  const requestRef = harness.blockedCalls[0]!.detailFiles?.scopeExpansionRequest;
  assert.equal(requestRef, ".archon/work/daemon/scope-expansion-request.json");
  const written = JSON.parse(await readFile(path.join(dir, requestRef!), "utf8"));
  assert.deepEqual(written.blockedPaths, ["src/forbidden.ts"]);
  assert.deepEqual(written.requestedWriteScope, ["src/forbidden.ts"]);
});

test("runDaemonCodexTurn: a continuing no-progress streak carries the stagnation count forward", async () => {
  // End-to-end pin for the stagnation carry-forward wiring inside the runner:
  // the prior stagnation record is read from projectRuntimeState.metadata via
  // readDaemonStagnationMetadata, fed into computeDaemonStagnantTurnCount, and
  // the incremented count is persisted. A broken metadata read would silently
  // peg the count at 1; this test would catch that.
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const snapshot = snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" });
  const dir0 = directive();
  // The progress key the runner will compute for this turn (same snapshot/state/
  // directive on both reads -> noProgress=true). Compute it via the real
  // buildDaemonProgressKey so the prior record's key matches exactly and the
  // streak continues (the key ignores metadata, so the base state is fine here).
  const progressKey = buildDaemonProgressKey({
    runtimeState: runtimeState(),
    snapshot,
    directive: dir0,
    activeTaskId: "task-1"
  });
  const priorState = runtimeState({
    metadata: {
      archonDaemon: {
        stagnation: {
          runId: "run-1",
          taskId: "task-1",
          directiveKind: "continue_analysis",
          progressKey,
          count: 1,
          updatedAt: "2026-06-22T12:00:00.000Z"
        }
      }
    }
  } as Partial<ProjectRuntimeStateRecord>);
  const harness = makeDeps({
    cwd: dir,
    directive: dir0,
    initialSnapshot: snapshot,
    refreshedSnapshot: snapshot,
    refreshedPlanDirective: dir0,
    projectRuntimeState: priorState,
    refreshedProjectRuntimeState: priorState,
    codexResult: {
      sessionId: "sess-z",
      // needs_followup keeps the worker un-blocked, so the streak advances via
      // the stagnation budget rather than a worker-reported "blocked".
      finalMessage: JSON.stringify({ status: "needs_followup", summary: "still grinding" }),
      stdout: "",
      stderr: "",
      exitCode: 0
    },
    initialSession: "sess-z0"
  });

  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  // The carried-forward count reaches MAX_DAEMON_STAGNANT_TURNS (2), so the
  // stagnation budget is exhausted and the turn blocks — even though the worker
  // reported needs_followup (not "blocked"). This is a distinct block trigger
  // from a worker-reported block (covered separately above).
  assert.equal(result?.status, "blocked", "exhausting the stagnation budget blocks the turn");
  assert.equal(harness.blockedCalls[0]!.blockerKind, "runtime_blocked");
  const stagnation = archonDaemonMeta(harness.saved[0]!).stagnation as { count?: number; progressKey?: string };
  assert.equal(stagnation.count, 2, "the prior no-progress streak (count=1) carries forward to 2");
  assert.equal(stagnation.progressKey, progressKey, "the persisted record reuses the matched progress key");
});

test("runDaemonCodexTurn: a needs_followup checkpoint turn invokes checkpointRun", async () => {
  // Pins the persistDaemonTurnCheckpoint pass-through call site with a live
  // callback (every other test leaves checkpointRun undefined → no-op).
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const checkpointCalls: Array<{ runId: string; checkpointId: string }> = [];
  const base = makeDeps({
    cwd: dir,
    directive: directive(),
    initialSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" }),
    refreshedSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_review" }),
    projectRuntimeState: runtimeState(),
    refreshedProjectRuntimeState: runtimeState(),
    codexResult: {
      sessionId: "sess-cp",
      finalMessage: JSON.stringify({
        status: "needs_followup",
        summary: "made partial progress",
        checkpoint: {
          evidence_refs: ["src/a.ts"],
          next_actions: ["finish b"],
          compressed_context_summary: "did a, need b"
        }
      }),
      stdout: "",
      stderr: "",
      exitCode: 0
    },
    initialSession: "sess-cp0"
  });
  base.deps.checkpointRun = async (runId, checkpoint) => {
    checkpointCalls.push({ runId, checkpointId: checkpoint.checkpointId });
    return undefined;
  };

  await runDaemonCodexTurn(turnInput(), base.deps);

  assert.equal(checkpointCalls.length, 1, "a needs_followup turn with a checkpoint persists it");
  assert.equal(checkpointCalls[0]!.runId, "run-1");
  assert.match(checkpointCalls[0]!.checkpointId, /^cp-daemon-task-1-/);
});

test("runDaemonCodexTurn: a resumed session with a matching packet builds a delta-mode prompt", async () => {
  // Pins the promptMode='delta' wiring: when a session id is present and the
  // prior prompt metadata (taskId + packet fingerprint) matches, the runner
  // injects the compressed checkpoint context instead of the full packet.
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-"));
  const snapshot = {
    run: { status: "in_progress" },
    tasks: [
      {
        packet: { taskId: "task-1", allowedWriteScope: [] },
        status: "in_progress",
        updatedAt: "2026-06-23T00:00:00.000Z"
      }
    ],
    autonomousExecution: {
      state: {
        checkpoints: [{ compressedContextSummary: "prior compressed summary", compressedContextRef: "cp-ref-1" }]
      }
    }
  } as unknown as RunStatusSnapshot;
  // The prior prompt metadata must match the current task + packet fingerprint
  // for determineDaemonPromptMode to return "delta". Use the same packet so the
  // fingerprint matches what the runner computes this turn.
  const priorState = runtimeState({
    metadata: {
      archonDaemon: {
        lastPromptTaskId: "task-1",
        lastPromptPacketFingerprint: buildDaemonTaskPacketFingerprint({ taskId: "task-1", allowedWriteScope: [] })
      }
    }
  } as Partial<ProjectRuntimeStateRecord>);
  const harness = makeDeps({
    cwd: dir,
    directive: directive(),
    initialSnapshot: snapshot,
    refreshedSnapshot: { ...JSON.parse(JSON.stringify(snapshot)), run: { status: "in_review" } } as unknown as RunStatusSnapshot,
    projectRuntimeState: priorState,
    refreshedProjectRuntimeState: priorState,
    codexResult: {
      sessionId: "sess-delta",
      finalMessage: JSON.stringify({ status: "completed", summary: "done" }),
      stdout: "",
      stderr: "",
      exitCode: 0
    },
    initialSession: "sess-delta-prior"
  });

  await runDaemonCodexTurn(turnInput(), harness.deps);

  const prompt = harness.codexCalls[0]!.prompt;
  assert.match(prompt, /Continue the active archon worker session/, "delta mode uses the continuation preamble");
  assert.match(prompt, /Compressed context: prior compressed summary/, "delta mode injects the checkpoint summary");
  // The saved metadata records the delta mode for the next turn.
  const meta = harness.saved[0]!.metadata as { archonDaemon?: { lastPromptMode?: string } };
  assert.equal(meta.archonDaemon?.lastPromptMode, "delta");
});

// ---------------------------------------------------------------------------
// Phase 1 (ahrP1Sampling) — monitor.recordSample integration tests
//
// RED phase: these tests import the ContextBudgetMonitor type and add
// invocationId + monitor to DaemonCodexTurnDeps, which does not yet exist.
// They FAIL until codex-turn.ts is modified.
// ---------------------------------------------------------------------------

import {
  ContextBudgetMonitor,
  type ContextBudgetStoreLike
} from "../src/runtime/context-budget.ts";
import type { RecordContextSampleInput } from "../src/store/agent-runtime-store.ts";
import type { ContextSample } from "../src/domain/types.ts";

class StubContextBudgetStore implements ContextBudgetStoreLike {
  readonly samples: RecordContextSampleInput[] = [];

  async recordContextSample(data: RecordContextSampleInput): Promise<void> {
    this.samples.push({ ...data });
  }

  async getLatestContextSample(invocationId: string): Promise<ContextSample | undefined> {
    const matching = this.samples.filter((s) => s.invocationId === invocationId);
    if (matching.length === 0) return undefined;
    const last = matching[matching.length - 1]!;
    return {
      invocationId: last.invocationId,
      runId: last.runId,
      taskId: last.taskId,
      source: last.source,
      usedPercentage: last.usedPercentage,
      sampledAt: last.sampledAt ?? new Date().toISOString(),
      raw: last.raw ?? {}
    };
  }

  async hasCommittedHandoff(_invocationId: string): Promise<boolean> {
    return false;
  }
}

test("runDaemonCodexTurn: when invocationId and monitor are provided and codex turn returns usage, monitor.recordSample is called", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-ahr-p1-"));
  const stubStore = new StubContextBudgetStore();
  const monitor = new ContextBudgetMonitor(stubStore);

  const harness = makeDeps({
    cwd: dir,
    directive: directive(),
    initialSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" }),
    refreshedSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_review" }),
    projectRuntimeState: runtimeState(),
    refreshedProjectRuntimeState: runtimeState(),
    codexResult: {
      sessionId: "sess-monitor",
      finalMessage: JSON.stringify({ status: "completed", summary: "done" }),
      stdout: "",
      stderr: "",
      exitCode: 0,
      // HIGH usage that should trigger handoff_required (>= 70%)
      usage: {
        inputTokens: 150_000,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      }
    },
    initialSession: "sess-monitor-0"
  });

  // Inject invocationId and monitor into deps (RED: fields don't exist yet on DaemonCodexTurnDeps)
  (harness.deps as DaemonCodexTurnDeps & { invocationId?: string; monitor?: ContextBudgetMonitor }).invocationId = "inv-test-001";
  (harness.deps as DaemonCodexTurnDeps & { invocationId?: string; monitor?: ContextBudgetMonitor }).monitor = monitor;

  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  // Turn should still succeed (observe-only)
  assert.equal(result, undefined, "high usage does not block the turn in observe-only mode");
  // Session id is unchanged by sampling
  assert.equal(harness.session(), "sess-monitor", "setSessionId still writes the holder normally");
  // monitor.recordSample was called
  assert.equal(stubStore.samples.length, 1, "one context sample was recorded");
  assert.equal(stubStore.samples[0]!.invocationId, "inv-test-001");
  assert.equal(stubStore.samples[0]!.runId, "run-1");
  assert.equal(stubStore.samples[0]!.taskId, "task-1");
  assert.equal(stubStore.samples[0]!.source, "sdk");
  // usedPct = (150000+10000) / 200000 * 100 = 80 (exactly hardStopPct)
  // or with default 200000 window: (150000+10000+0+0)/200000*100 = 80
  assert.ok(
    typeof stubStore.samples[0]!.usedPercentage === "number" && stubStore.samples[0]!.usedPercentage > 0,
    `usedPercentage should be a positive number, got ${stubStore.samples[0]!.usedPercentage}`
  );
});

test("runDaemonCodexTurn: when invocationId and monitor are absent, no error is thrown and turn runs normally", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-ahr-p1-nomon-"));

  const harness = makeDeps({
    cwd: dir,
    directive: directive(),
    initialSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" }),
    refreshedSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_review" }),
    projectRuntimeState: runtimeState(),
    refreshedProjectRuntimeState: runtimeState(),
    codexResult: {
      sessionId: "sess-nomon",
      finalMessage: JSON.stringify({ status: "completed", summary: "done" }),
      stdout: "",
      stderr: "",
      exitCode: 0,
      usage: {
        inputTokens: 50_000,
        outputTokens: 5_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      }
    },
    initialSession: "sess-nomon-0"
  });

  // No invocationId or monitor on deps — turn should still work
  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  assert.equal(result, undefined, "no error when monitor is absent");
  assert.equal(harness.session(), "sess-nomon");
});

test("runDaemonCodexTurn: when codex turn returns no usage, monitor.recordSample is NOT called", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-codexturn-ahr-p1-nousage-"));
  const stubStore = new StubContextBudgetStore();
  const monitor = new ContextBudgetMonitor(stubStore);

  const harness = makeDeps({
    cwd: dir,
    directive: directive(),
    initialSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_progress" }),
    refreshedSnapshot: snapshotWithTask({ taskId: "task-1", runStatus: "in_review" }),
    projectRuntimeState: runtimeState(),
    refreshedProjectRuntimeState: runtimeState(),
    codexResult: {
      sessionId: "sess-nousage",
      finalMessage: JSON.stringify({ status: "completed", summary: "done" }),
      stdout: "",
      stderr: "",
      exitCode: 0
      // no usage field
    },
    initialSession: "sess-nousage-0"
  });

  (harness.deps as DaemonCodexTurnDeps & { invocationId?: string; monitor?: ContextBudgetMonitor }).invocationId = "inv-test-002";
  (harness.deps as DaemonCodexTurnDeps & { invocationId?: string; monitor?: ContextBudgetMonitor }).monitor = monitor;

  const result = await runDaemonCodexTurn(turnInput(), harness.deps);

  assert.equal(result, undefined, "no error when usage is absent");
  assert.equal(stubStore.samples.length, 0, "no sample recorded when usage is absent");
});
