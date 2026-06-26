// handoff-consumer-daemon.test.ts
//
// P2 daemon consumer entrypoint: CI-enforced integration test.
//
// Drives the REAL consumer entrypoint `executeDaemonCommandFromArgs`
// (src/daemon.ts:909) with an injected `runCodexTurn` via the
// `options.runCodexTurn ?? runCodexTurnViaCli` seam (src/daemon.ts:936).
//
// No live database, no real Claude spawn.  Injected doubles provide
// deterministic control over context usage, handoff records, and
// respawn-lease state.
//
// Four scenarios:
//
//   S1 — enforce + high usage → handoff_required → exactly ONE reset
//        Asserts: status=max_cycles_reached, one handoff_reset cycle record,
//        saveProjectRuntimeState called with justHandedOff=true,
//        markHandoffConsumed called exactly once.
//
//   S2 — enforce + budget exhausted (respawnCount=8) → blocked, no reset
//        Asserts: status=blocked, no handoff_reset record,
//        saveProjectRuntimeState never called with justHandedOff=true.
//
//   S3 — file-based lease pre-claimed for "interactive" → no reset, daemon no-ops
//        Asserts: status=max_cycles_reached, no handoff_reset record,
//        saveProjectRuntimeState never called with justHandedOff=true,
//        markHandoffConsumed never called.
//
//   S4 — ARCHON_CONTEXT_MONITOR=observe (kill switch) → no reset, safe continue
//        Asserts: status=max_cycles_reached, no handoff_reset record,
//        saveProjectRuntimeState never called with justHandedOff=true,
//        saveProjectRuntimeState IS called at least once (non-reset write).
//
//   S5 — ARCHON_CONTEXT_MONITOR unset (enforce-default, P3) → reset triggered
//        Asserts: status=max_cycles_reached, one handoff_reset record,
//        saveProjectRuntimeState called with justHandedOff=true,
//        markHandoffConsumed called at least once.
//
// CI gate: this file sits at tests/ (top-level glob) so it is always
// picked up by `npx c8 node --experimental-strip-types --test tests/*.test.ts`.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  executeDaemonCommandFromArgs,
  type ExecuteDaemonCommandOptions
} from "../src/daemon.ts";

import {
  makeFileLockLeaseStore,
  claimRespawnLease
} from "../src/runtime/respawn-lease.ts";

import type { AgenticLoopStoreLike } from "../src/runtime/agentic-loop.ts";
import type { HandoffStoreLike } from "../src/runtime/handoff-controller.ts";
import type { HandoffRecord } from "../src/store/agent-runtime-store.ts";
import type { RecordContextSampleInput } from "../src/store/agent-runtime-store.ts";
import type {
  ProjectRuntimeStateRecord,
  RuntimeProjectRegistrationRecord,
  WorkspaceRecord,
  ProjectRecord,
  RecoveryApplyResult,
  RunStatusSnapshot,
  RunExecutionPlan,
  ContextSample
} from "../src/domain/types.ts";
import type { ReviewIdentityStatusObservation } from "../src/admin/status.ts";
import type { RunCodexTurnResult } from "../src/daemon/turn-prompt.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_ID = "ws-test-id";
const WS_SLUG = "test-ws";
const PROJ_ID = "proj-test-id";
const PROJ_SLUG = "test-proj";
const RUN_ID = "run-1";
const TASK_ID = "task-1";

// 145,000 / 200,000 = 72.5% — above the handoff threshold (70%).
// Below hard_stop (80%) so the codex-turn monitor returns "handoff_required".
const HIGH_USAGE = {
  inputTokens: 145000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal RunStatusSnapshot — the daemon only needs run.{id,projectId,workspaceId,status}
 *  and tasks[].{packet.taskId, packet.allowedWriteScope, status, updatedAt}.
 *  We cast via unknown to avoid importing all sub-types. */
function makeSnapshot(_cwd: string): RunStatusSnapshot {
  return {
    run: {
      id: RUN_ID,
      workspaceId: WS_ID,
      projectId: PROJ_ID,
      actor: "archon",
      title: "test-run",
      request: "test",
      summary: { goal: "test", audience: [], constraints: [], risks: [], unknowns: [], successCriteria: [], outOfScope: [] },
      status: "in_progress",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z"
    },
    tasks: [
      {
        id: "task-uuid-1",
        runId: RUN_ID,
        workspaceId: WS_ID,
        projectId: PROJ_ID,
        class: "feature",
        packet: {
          taskId: TASK_ID,
          title: "Test task",
          ownerRole: "specialist_owner",
          completionStandard: "artifact_complete",
          requiredSpecialistRoles: [],
          qualityGates: [],
          goal: "Implement the test task",
          inputs: [],
          outputs: [],
          dependencies: [],
          allowedWriteScope: ["tests/"],
          outOfScope: [],
          acceptanceCriteria: ["the test passes"],
          verificationSteps: ["run npm test"],
          requiredReviews: [],
          securityChecks: [],
          antiPatterns: [],
          rollbackNotes: "none",
          handoffFormat: "json"
        },
        status: "in_progress",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      }
    ],
    activeLocks: [],
    blockers: [],
    nextTaskIds: []
  } as unknown as RunStatusSnapshot;
}

/** Minimal ProjectRuntimeStateRecord for standard scenarios (no budget exhaustion). */
function makeRuntimeState(overrideMeta?: Record<string, unknown>): ProjectRuntimeStateRecord {
  return {
    projectId: PROJ_ID,
    workspaceId: WS_ID,
    activeRunId: RUN_ID,
    activeTaskId: TASK_ID,
    taskQueue: { project_status: "in_progress", current_task_id: TASK_ID, tasks: [] },
    productState: { status: "in_progress", items: [] },
    metadata: overrideMeta ?? {},
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z"
  } as unknown as ProjectRuntimeStateRecord;
}

/** Minimal runtime registration with repoPath = testDir. */
function makeRegistration(testDir: string): RuntimeProjectRegistrationRecord {
  return {
    projectId: PROJ_ID,
    workspaceId: WS_ID,
    repoPath: testDir,
    runtimeProfile: "local-native",
    dataRoot: testDir,
    manifest: {},
    provenance: {},
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z"
  };
}

/** Review identity that satisfies preflight doctor check. */
function makeReviewIdentity(): ReviewIdentityStatusObservation {
  return {
    authorityLabel: "derived_only",
    adapterConfigured: true,
    adapterExists: true,
    availableBackends: ["postgres"],
    bindingsPresent: true,
    bindingsPath: "/fake/bindings.js",
    bindingsUseShippedTemplate: false,
    liveTrustReady: true,
    notes: []
  };
}

/** dispatch_owner plan targeting TASK_ID. */
function makeDispatchOwnerPlan(): RunExecutionPlan {
  return {
    mode: "advisory_only",
    runId: RUN_ID,
    directive: {
      kind: "dispatch_owner",
      rationale: [],
      recommendation: {
        taskId: TASK_ID,
        taskStatus: "in_progress",
        recommendation: "dispatch_owner",
        authorityLabel: "derived_only",
        targetRole: "specialist_owner",
        rationale: [],
        blockers: [],
        allowedWriteScope: ["tests/"],
        retrievalGuidance: [],
        approvalCheckpoints: []
      }
    }
  } as unknown as RunExecutionPlan;
}

// ---------------------------------------------------------------------------
// InMemoryRuntimeStore — implements AgenticLoopStoreLike + HandoffStoreLike.
//
// The daemon takes agentLoopStore (AgenticLoopStoreLike) and handoffStore
// (HandoffStoreLike) as separate options. In production a single AgentRuntimeStore
// satisfies both. In tests we pass the same double for both.
// ---------------------------------------------------------------------------

class InMemoryRuntimeStore implements AgenticLoopStoreLike, HandoffStoreLike {
  // Invocation tracking
  private invocations: string[] = [];
  private invocationCounter = 0;

  // Handoff tracking
  readonly handoffs: HandoffRecord[] = [];
  readonly markHandoffConsumedCalls: Array<{ handoffId: string; toInvocationId: string }> = [];

  // saveProjectRuntimeState tracking (injected via options, not part of the store interface
  // — but we expose a separate call log for assertions).
  // NOTE: saveProjectRuntimeState is on ExecuteDaemonCommandOptions, not the store.
  // We wire it separately per scenario.

  // --- AgenticLoopStoreLike ---

  async createInvocation(_data: {
    runId: string;
    taskId: string;
    role: string;
    startedAt: string;
  }): Promise<string> {
    this.invocationCounter += 1;
    const id = `inv-${this.invocationCounter.toString().padStart(3, "0")}`;
    this.invocations.push(id);
    return id;
  }

  async updateInvocationStatus(
    invocationId: string,
    status: string,
    _metadata?: Record<string, unknown>
  ): Promise<void> {
    // No-op for test purposes.
    void invocationId;
    void status;
  }

  async getInvocationStatus(_invocationId: string): Promise<string | undefined> {
    return "running";
  }

  async getInvocationTaskId(_invocationId: string): Promise<string | undefined> {
    return TASK_ID;
  }

  async getActiveTask(_runId: string): Promise<null> {
    return null;
  }

  async getActiveInvocation(_runId: string): Promise<null> {
    return null;
  }

  async getNextTask(_runId: string): Promise<null> {
    return null;
  }

  async countPendingHandoffs(_runId: string): Promise<number> {
    return 0;
  }

  // --- ContextBudgetStoreLike (required by AgenticLoopStoreLike) ---

  async recordContextSample(_data: RecordContextSampleInput): Promise<void> {
    // No-op: sample data is not needed for assertions.
  }

  async getLatestContextSample(_invocationId: string): Promise<ContextSample | undefined> {
    return undefined;
  }

  async hasCommittedHandoff(invocationId: string): Promise<boolean> {
    // Used by the daemon's HandoffController. The pre-crash-recovery check uses
    // getLatestUnconsumedHandoff; hasCommittedHandoff is called only when
    // stateRequiresReset=false (committed-handoff signal). In our enforce+high-usage
    // scenarios stateRequiresReset=true so this is skipped. We return false uniformly.
    void invocationId;
    return false;
  }

  // --- HandoffStoreLike ---

  async createHandoff(
    data: Parameters<HandoffStoreLike["createHandoff"]>[0]
  ): Promise<HandoffRecord> {
    const record: HandoffRecord = {
      id: data.id,
      runId: data.runId,
      taskId: data.taskId,
      fromInvocationId: data.fromInvocationId,
      toInvocationId: data.toInvocationId,
      fromRole: data.fromRole,
      toRole: data.toRole,
      reason: data.reason,
      status: data.status,
      contextUsedPct: data.contextUsedPct,
      packet: { ...data.packet },
      authorityLabel: data.authorityLabel ?? "runtime_authoritative",
      createdAt: data.createdAt ?? new Date().toISOString(),
      consumedAt: undefined
    };
    this.handoffs.push(record);
    return { ...record };
  }

  async getLatestUnconsumedHandoff(
    _runId: string,
    _taskId: string
  ): Promise<HandoffRecord | undefined> {
    // Always return undefined so the daemon's crash-recovery path fires,
    // synthesizing a crash_recovery handoff we can assert against.
    return undefined;
  }

  async markHandoffConsumed(handoffId: string, toInvocationId: string): Promise<void> {
    this.markHandoffConsumedCalls.push({ handoffId, toInvocationId });
    const idx = this.handoffs.findIndex((h) => h.id === handoffId);
    if (idx !== -1) {
      this.handoffs[idx] = { ...this.handoffs[idx], consumedAt: new Date().toISOString() };
    }
  }

  async updateAgentInvocationStatus(
    _id: string,
    _status: string,
    _metadata?: Record<string, unknown>
  ): Promise<void> {
    // No-op: HandoffController prepare() + commit() call this; we don't need
    // to enforce invocation-pre-registration in the daemon integration tests
    // (that contract is covered by handoff-consumer-interactive.test.ts).
  }
}

// ---------------------------------------------------------------------------
// makeOptions — build ExecuteDaemonCommandOptions for a test scenario.
//
// Shared across all four scenarios; scenario-specific overrides (metadata,
// runCodexTurn) are passed as parameters.
// ---------------------------------------------------------------------------

function makeOptions(
  testDir: string,
  store: InMemoryRuntimeStore,
  options: {
    runtimeState?: ProjectRuntimeStateRecord;
    runCodexTurn?: ExecuteDaemonCommandOptions["runCodexTurn"];
    savedStates?: ProjectRuntimeStateRecord[];
  } = {}
): Omit<ExecuteDaemonCommandOptions, "cwd" | "env"> {
  const snapshot = makeSnapshot(testDir);
  const runtimeState = options.runtimeState ?? makeRuntimeState();
  const savedStates = options.savedStates ?? [];

  const workspace: WorkspaceRecord = { id: WS_ID, slug: WS_SLUG, name: "Test WS", createdAt: "2024-01-01T00:00:00Z" };
  const project: ProjectRecord = {
    id: PROJ_ID,
    workspaceId: WS_ID,
    slug: PROJ_SLUG,
    name: "Test Project",
    repoPath: testDir,
    createdAt: "2024-01-01T00:00:00Z"
  };

  return {
    // Preflight: findProjectContext resolves workspace+project from slugs.
    findProjectContext: async (_ws: string, _proj: string) => ({ workspace, project }),
    // Preflight: registration repoPath must equal path.resolve(cwd).
    getProjectRuntimeRegistration: async (_projectId: string) => makeRegistration(testDir),
    // Preflight: pathExists confirms dataRoot is accessible.
    pathExists: async (_p: string) => true,
    // Preflight: liveTrustReady must be true to clear doctor.
    inspectReviewIdentity: async () => makeReviewIdentity(),
    // Loop: project context (called once per cycle).
    getProjectContext: async (_params: { workspaceSlug: string; projectSlug: string }) => ({
      workspace,
      project
    }),
    // Loop: runtime state (called at top of each cycle AND on non-reset path).
    getProjectRuntimeState: async (_projectId: string) => runtimeState,
    // Loop: save runtime state (tracks reset vs non-reset writes).
    saveProjectRuntimeState: async (state: ProjectRuntimeStateRecord) => {
      savedStates.push(state);
    },
    // Loop: status snapshot (called inside executeLoopCommandFromArgs and non-reset refresh).
    getStatusSnapshot: async (_runId: string) => snapshot,
    // Loop: execution plan (returns dispatch_owner for task-1).
    getExecutionPlan: async (_runId: string, _staleAfterHours: number) => makeDispatchOwnerPlan(),
    // Loop: recovery apply (not called since initialPlan.directive !== apply_recovery).
    applyRecovery: async (_runId: string, _actionIds: readonly string[], _staleAfterHours: number): Promise<RecoveryApplyResult> => ({
      mode: "applied",
      runId: _runId,
      appliedActionIds: [],
      skippedActionIds: [],
      snapshot
    }),
    // Loop: reviews + approvals (empty — workflow proof not the focus here).
    getReviews: async (_runId: string, _taskId: string) => [],
    getApprovals: async (_runId: string, _taskId: string) => [],
    // Injected runCodexTurn (the key injection seam — no real claude spawn).
    runCodexTurn: options.runCodexTurn ?? (async (_input) => ({
      sessionId: "sess-1",
      stdout: "",
      stderr: "",
      exitCode: 0,
      usage: HIGH_USAGE
    } as RunCodexTurnResult)),
    // Agentic loop store (for ContextBudgetMonitor and AgenticLoopController).
    agentLoopStore: store as AgenticLoopStoreLike,
    // Handoff store (for HandoffController — crash-recovery + consume path).
    handoffStore: store as HandoffStoreLike
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handoffConsumerWiring — daemon consumer entrypoint (P2)", () => {
  const testDirs: string[] = [];

  /** Create a fresh temp directory for each scenario (isolation). */
  async function makeTestDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "archon-daemon-p2-"));
    testDirs.push(dir);
    // Pre-create the daemon work directory so daemon.lock and lease files can
    // be placed there by both the pre-claim (S3) and the daemon itself.
    await mkdir(join(dir, ".archon", "work", "daemon"), { recursive: true });
    return dir;
  }

  after(async () => {
    // Clean up all temp dirs after the suite finishes.
    await Promise.all(testDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  // -------------------------------------------------------------------------
  // S1 — enforce + high usage → handoff_required → exactly ONE reset
  //
  // Setup:
  //   - ARCHON_CONTEXT_MONITOR=enforce
  //   - runCodexTurn returns usage at 72.5% (above handoff threshold 70%)
  //   - No pre-existing handoff → crash-recovery synthesizes one
  //   - Budget not exhausted (default=8, no stored count)
  //   - Lease not pre-claimed → daemon claims it
  //   - --max-cycles 1 → loop exits after reset with max_cycles_reached
  //
  // Expected:
  //   - result.status = "max_cycles_reached"
  //   - One cycle record with action="handoff_reset"
  //   - saveProjectRuntimeState called with metadata.archonDaemon.justHandedOff=true
  //   - markHandoffConsumed called exactly once (links crash_recovery → next inv)
  // -------------------------------------------------------------------------

  it("S1: enforce + high usage → handoff_required → single reset (respawn)", async () => {
    const testDir = await makeTestDir();
    const store = new InMemoryRuntimeStore();
    const savedStates: ProjectRuntimeStateRecord[] = [];
    const opts = makeOptions(testDir, store, { savedStates });

    const savedContextMonitor = process.env.ARCHON_CONTEXT_MONITOR;
    process.env.ARCHON_CONTEXT_MONITOR = "enforce";

    let result;
    try {
      ({ result } = await executeDaemonCommandFromArgs(
        [
          "--workspace-slug", WS_SLUG,
          "--project-slug", PROJ_SLUG,
          "--max-cycles", "1"
        ],
        { ...opts, cwd: testDir }
      ));
    } finally {
      if (savedContextMonitor === undefined) {
        delete process.env.ARCHON_CONTEXT_MONITOR;
      } else {
        process.env.ARCHON_CONTEXT_MONITOR = savedContextMonitor;
      }
    }

    // 1. Loop exits with max_cycles_reached (reset returns undefined, cycle ends).
    assert.equal(
      result.status,
      "max_cycles_reached",
      `S1: expected max_cycles_reached, got ${result.status}`
    );

    // 2. Exactly one handoff_reset cycle record.
    const resetCycles = result.cycles.filter((c) => c.action === "handoff_reset");
    assert.equal(
      resetCycles.length,
      1,
      `S1: expected exactly 1 handoff_reset cycle record, got ${resetCycles.length}`
    );

    // 3. saveProjectRuntimeState was called with justHandedOff=true on the reset path.
    const resetWrite = savedStates.find((s) => {
      const daemonMeta = (s.metadata as Record<string, unknown>)?.archonDaemon as Record<string, unknown> | undefined;
      return daemonMeta?.justHandedOff === true;
    });
    assert.ok(
      resetWrite !== undefined,
      "S1: saveProjectRuntimeState must be called with archonDaemon.justHandedOff=true on the reset path"
    );

    // 4. respawnCount incremented to 1 in the reset write.
    const daemonMeta = (resetWrite.metadata as Record<string, unknown>).archonDaemon as Record<string, unknown>;
    assert.equal(
      daemonMeta.respawnCount,
      1,
      "S1: respawnCount must be 1 after first reset"
    );
    assert.equal(
      daemonMeta.respawnTaskId,
      TASK_ID,
      "S1: respawnTaskId must be task-1"
    );

    // 5. markHandoffConsumed called exactly once (crash_recovery handoff linked to next inv).
    assert.equal(
      store.markHandoffConsumedCalls.length,
      1,
      `S1: markHandoffConsumed must be called exactly once, called ${store.markHandoffConsumedCalls.length} times`
    );

    // 6. The per-run respawn lease is released after the daemon exits — the
    //    finally block in executeDaemonCommandFromArgs (daemon.ts ~1321) calls
    //    releaseRespawnLease. No respawn-lease lock file may linger in the daemon
    //    work dir, otherwise the next daemon run would be denied its own lease.
    const daemonWorkDir = join(testDir, ".archon", "work", "daemon");
    const leftoverEntries = await readdir(daemonWorkDir);
    const leftoverLeaseLocks = leftoverEntries.filter((e) => /^respawn-lease-.*\.lock$/.test(e));
    assert.deepEqual(
      leftoverLeaseLocks,
      [],
      `S1: respawn-lease lock must be released after the daemon exits, found: ${leftoverLeaseLocks.join(", ")}`
    );
  });

  // -------------------------------------------------------------------------
  // S2 — enforce + budget exhausted → blocked, no reset
  //
  // Setup:
  //   - ARCHON_CONTEXT_MONITOR=enforce
  //   - Pre-load state with respawnCount=8 (= default budget) for task-1
  //   - runCodexTurn returns high usage (72.5% → handoff_required)
  //   - The budget gate fires BEFORE the lease claim
  //
  // Expected:
  //   - result.status = "blocked"
  //   - reason contains "recovery_required" or "respawn budget"
  //   - saveProjectRuntimeState never called with justHandedOff=true
  //   - markHandoffConsumed never called
  // -------------------------------------------------------------------------

  it("S2: enforce + budget exhausted → blocked (recovery_required), no reset", async () => {
    const testDir = await makeTestDir();
    const store = new InMemoryRuntimeStore();
    const savedStates: ProjectRuntimeStateRecord[] = [];

    // Pre-load state: respawnCount=8, respawnTaskId="task-1" → budget exhausted.
    const exhaustedState = makeRuntimeState({
      archonDaemon: {
        respawnCount: 8,
        respawnTaskId: TASK_ID
      }
    });
    const opts = makeOptions(testDir, store, {
      runtimeState: exhaustedState,
      savedStates
    });

    const savedContextMonitor = process.env.ARCHON_CONTEXT_MONITOR;
    process.env.ARCHON_CONTEXT_MONITOR = "enforce";
    // Pin the respawn budget to the same value the pre-loaded respawnCount (8)
    // is meant to exhaust. resolveRespawnBudget() reads ARCHON_MAX_RESPAWNS_PER_TASK
    // at call time; if an ambient env left it >8 the budget gate would not fire and
    // this scenario would false-pass (status=max_cycles_reached) or stop being a
    // regression lock for the guard at codex-turn.ts:448. Pinning makes the budget
    // boundary (8 >= 8) deterministic regardless of the host environment.
    const savedRespawnBudget = process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
    process.env.ARCHON_MAX_RESPAWNS_PER_TASK = "8";

    let result;
    try {
      ({ result } = await executeDaemonCommandFromArgs(
        [
          "--workspace-slug", WS_SLUG,
          "--project-slug", PROJ_SLUG,
          "--max-cycles", "1"
        ],
        { ...opts, cwd: testDir }
      ));
    } finally {
      if (savedContextMonitor === undefined) {
        delete process.env.ARCHON_CONTEXT_MONITOR;
      } else {
        process.env.ARCHON_CONTEXT_MONITOR = savedContextMonitor;
      }
      if (savedRespawnBudget === undefined) {
        delete process.env.ARCHON_MAX_RESPAWNS_PER_TASK;
      } else {
        process.env.ARCHON_MAX_RESPAWNS_PER_TASK = savedRespawnBudget;
      }
    }

    // 1. Daemon blocks (budget gate fires inside runDaemonCodexTurn).
    assert.equal(
      result.status,
      "blocked",
      `S2: expected blocked, got ${result.status}`
    );

    // 2. Reason specifically identifies the respawn-budget block (not just any
    //    block) — assert.match pins the exact guard that fired so a different
    //    block reason cannot silently satisfy this scenario.
    assert.match(
      result.reason,
      /respawn budget exhausted/,
      `S2: reason must identify the respawn-budget block, got: ${result.reason}`
    );

    // 3. No handoff_reset cycle record.
    const resetCycles = result.cycles.filter((c) => c.action === "handoff_reset");
    assert.equal(
      resetCycles.length,
      0,
      `S2: expected 0 handoff_reset cycle records, got ${resetCycles.length}`
    );

    // 4. saveProjectRuntimeState never called with justHandedOff=true.
    const resetWrite = savedStates.find((s) => {
      const daemonMeta = (s.metadata as Record<string, unknown>)?.archonDaemon as Record<string, unknown> | undefined;
      return daemonMeta?.justHandedOff === true;
    });
    assert.equal(
      resetWrite,
      undefined,
      "S2: saveProjectRuntimeState must NOT be called with justHandedOff=true when budget is exhausted"
    );

    // 5. markHandoffConsumed never called.
    assert.equal(
      store.markHandoffConsumedCalls.length,
      0,
      `S2: markHandoffConsumed must not be called on budget block, called ${store.markHandoffConsumedCalls.length} times`
    );
  });

  // -------------------------------------------------------------------------
  // S3 — file-based lease pre-claimed for "interactive" → daemon no-ops, no reset
  //
  // Setup:
  //   - ARCHON_CONTEXT_MONITOR=enforce
  //   - runCodexTurn returns high usage (72.5% → handoff_required)
  //   - PRE-CLAIM the lease for "interactive" using the SAME lockDir the daemon
  //     uses ({testDir}/.archon/work/daemon) before calling the daemon.
  //   - The daemon creates its own makeFileLockLeaseStore pointing to the same
  //     lockDir; claimRespawnLease("run-1", "daemon", daemonStore) sees
  //     owner=interactive → granted=false → early return undefined (no reset).
  //
  // Expected:
  //   - result.status = "max_cycles_reached" (daemon loop exits after no-op)
  //   - No handoff_reset cycle record
  //   - saveProjectRuntimeState never called with justHandedOff=true
  //   - markHandoffConsumed never called
  // -------------------------------------------------------------------------

  it("S3: lease pre-claimed for interactive → daemon no-ops, no reset (lease denial)", async () => {
    const testDir = await makeTestDir();
    const store = new InMemoryRuntimeStore();
    const savedStates: ProjectRuntimeStateRecord[] = [];
    const opts = makeOptions(testDir, store, { savedStates });

    // Pre-claim the lease in the SAME lockDir the daemon will use.
    // makeFileLockLeaseStore writes "respawn-lease-{runId}.lock" in lockDir.
    // The daemon creates its own store pointing to the same dir; it sees the
    // existing .lock file and gets granted=false → skips reset.
    const lockDir = join(testDir, ".archon", "work", "daemon");
    const preClaimStore = makeFileLockLeaseStore({ lockDir });
    const preClaim = await claimRespawnLease(RUN_ID, "interactive", preClaimStore);
    assert.equal(
      preClaim.granted,
      true,
      "S3 pre-claim for interactive must succeed (precondition)"
    );

    const savedContextMonitor = process.env.ARCHON_CONTEXT_MONITOR;
    process.env.ARCHON_CONTEXT_MONITOR = "enforce";

    let result;
    try {
      ({ result } = await executeDaemonCommandFromArgs(
        [
          "--workspace-slug", WS_SLUG,
          "--project-slug", PROJ_SLUG,
          "--max-cycles", "1"
        ],
        { ...opts, cwd: testDir }
      ));
    } finally {
      if (savedContextMonitor === undefined) {
        delete process.env.ARCHON_CONTEXT_MONITOR;
      } else {
        process.env.ARCHON_CONTEXT_MONITOR = savedContextMonitor;
      }
    }

    // 1. Daemon loop exits normally (lease-denied path returns undefined → next cycle,
    //    but --max-cycles 1 ends the loop → max_cycles_reached).
    assert.equal(
      result.status,
      "max_cycles_reached",
      `S3: expected max_cycles_reached, got ${result.status}`
    );

    // 2. No handoff_reset cycle record.
    const resetCycles = result.cycles.filter((c) => c.action === "handoff_reset");
    assert.equal(
      resetCycles.length,
      0,
      `S3: expected 0 handoff_reset cycle records, got ${resetCycles.length}`
    );

    // 3. saveProjectRuntimeState never called with justHandedOff=true.
    const resetWrite = savedStates.find((s) => {
      const daemonMeta = (s.metadata as Record<string, unknown>)?.archonDaemon as Record<string, unknown> | undefined;
      return daemonMeta?.justHandedOff === true;
    });
    assert.equal(
      resetWrite,
      undefined,
      "S3: saveProjectRuntimeState must NOT be called with justHandedOff=true when lease is denied"
    );

    // 4. markHandoffConsumed never called (no respawn occurred).
    assert.equal(
      store.markHandoffConsumedCalls.length,
      0,
      `S3: markHandoffConsumed must not be called on lease denial, called ${store.markHandoffConsumedCalls.length} times`
    );
  });

  // -------------------------------------------------------------------------
  // S4 — ARCHON_CONTEXT_MONITOR=observe (kill switch) → no reset, safe continue
  //
  // Setup:
  //   - ARCHON_CONTEXT_MONITOR=observe (explicit kill switch)
  //   - runCodexTurn returns high usage (72.5%)
  //   - The isEnforceMode=false gate skips the entire reset-path block
  //   - Non-reset path: sample is fire-and-forget, saveProjectRuntimeState
  //     is called with justHandedOff=false (normal continue-path write)
  //
  // Expected:
  //   - result.status = "max_cycles_reached"
  //   - No handoff_reset cycle record
  //   - saveProjectRuntimeState IS called at least once (non-reset write)
  //   - saveProjectRuntimeState never called with justHandedOff=true
  //   - markHandoffConsumed never called
  // -------------------------------------------------------------------------

  it("S4: observe kill switch (ARCHON_CONTEXT_MONITOR=observe) → no reset, daemon continues safely", async () => {
    const testDir = await makeTestDir();
    const store = new InMemoryRuntimeStore();
    const savedStates: ProjectRuntimeStateRecord[] = [];
    const opts = makeOptions(testDir, store, { savedStates });

    // Set explicit observe kill switch.
    const savedContextMonitor = process.env.ARCHON_CONTEXT_MONITOR;
    process.env.ARCHON_CONTEXT_MONITOR = "observe";

    let result;
    try {
      ({ result } = await executeDaemonCommandFromArgs(
        [
          "--workspace-slug", WS_SLUG,
          "--project-slug", PROJ_SLUG,
          "--max-cycles", "1"
        ],
        { ...opts, cwd: testDir }
      ));
    } finally {
      if (savedContextMonitor !== undefined) {
        process.env.ARCHON_CONTEXT_MONITOR = savedContextMonitor;
      } else {
        delete process.env.ARCHON_CONTEXT_MONITOR;
      }
    }

    // 1. Daemon exits normally (reset path never entered in observe mode).
    assert.equal(
      result.status,
      "max_cycles_reached",
      `S4: expected max_cycles_reached, got ${result.status}`
    );

    // 2. No handoff_reset cycle record.
    const resetCycles = result.cycles.filter((c) => c.action === "handoff_reset");
    assert.equal(
      resetCycles.length,
      0,
      `S4: expected 0 handoff_reset cycle records, got ${resetCycles.length}`
    );

    // 3. saveProjectRuntimeState IS called at least once on the non-reset path.
    assert.ok(
      savedStates.length >= 1,
      "S4: saveProjectRuntimeState must be called at least once on the observe (non-reset) path"
    );

    // 4. saveProjectRuntimeState never called with justHandedOff=true.
    const resetWrite = savedStates.find((s) => {
      const daemonMeta = (s.metadata as Record<string, unknown>)?.archonDaemon as Record<string, unknown> | undefined;
      return daemonMeta?.justHandedOff === true;
    });
    assert.equal(
      resetWrite,
      undefined,
      "S4: saveProjectRuntimeState must NOT be called with justHandedOff=true in observe mode"
    );

    // 5. markHandoffConsumed never called (observe mode does not reset).
    assert.equal(
      store.markHandoffConsumedCalls.length,
      0,
      `S4: markHandoffConsumed must not be called in observe mode, called ${store.markHandoffConsumedCalls.length} times`
    );
  });

  // -------------------------------------------------------------------------
  // S5 — ARCHON_CONTEXT_MONITOR unset (enforce-default, P3) → reset triggered
  //
  // Setup:
  //   - ARCHON_CONTEXT_MONITOR is UNSET (daemon enforce-default kicks in)
  //   - runCodexTurn returns high usage (72.5%) → handoff_required
  //   - No pre-existing handoff → crash-recovery synthesizes one
  //   - Budget not exhausted (default=8, no stored count)
  //   - Lease not pre-claimed → daemon claims it
  //   - --max-cycles 1 → loop exits after reset with max_cycles_reached
  //
  // Expected:
  //   - result.status = "max_cycles_reached"
  //   - One cycle record with action="handoff_reset"
  //   - saveProjectRuntimeState called with metadata.archonDaemon.justHandedOff=true
  //   - markHandoffConsumed called exactly once
  // -------------------------------------------------------------------------

  it("S5: enforce-default (ARCHON_CONTEXT_MONITOR unset) + handoff_required → exactly one reset", async () => {
    const testDir = await makeTestDir();
    const store = new InMemoryRuntimeStore();
    const savedStates: ProjectRuntimeStateRecord[] = [];
    const opts = makeOptions(testDir, store, { savedStates });

    // Unset ARCHON_CONTEXT_MONITOR — enforce-default (P3) takes over.
    const savedContextMonitor = process.env.ARCHON_CONTEXT_MONITOR;
    delete process.env.ARCHON_CONTEXT_MONITOR;

    let result;
    try {
      ({ result } = await executeDaemonCommandFromArgs(
        [
          "--workspace-slug", WS_SLUG,
          "--project-slug", PROJ_SLUG,
          "--max-cycles", "1"
        ],
        { ...opts, cwd: testDir }
      ));
    } finally {
      if (savedContextMonitor !== undefined) {
        process.env.ARCHON_CONTEXT_MONITOR = savedContextMonitor;
      }
    }

    // 1. Daemon exits after reset (reset + max_cycles_reached).
    assert.equal(
      result.status,
      "max_cycles_reached",
      `S5: expected max_cycles_reached after reset, got ${result.status}`
    );

    // 2. Exactly one handoff_reset cycle record.
    const resetCycles = result.cycles.filter((c) => c.action === "handoff_reset");
    assert.equal(
      resetCycles.length,
      1,
      `S5: expected 1 handoff_reset cycle record (enforce-default), got ${resetCycles.length}`
    );

    // 3. saveProjectRuntimeState called with justHandedOff=true (atomic reset write).
    const resetWrite = savedStates.find((s) => {
      const daemonMeta = (s.metadata as Record<string, unknown>)?.archonDaemon as Record<string, unknown> | undefined;
      return daemonMeta?.justHandedOff === true;
    });
    assert.notEqual(
      resetWrite,
      undefined,
      "S5: saveProjectRuntimeState must be called with justHandedOff=true on enforce-default reset"
    );

    // 4. markHandoffConsumed called at least once (handoff linked to next invocation).
    assert.ok(
      store.markHandoffConsumedCalls.length >= 1,
      `S5: markHandoffConsumed must be called on enforce-default reset, called ${store.markHandoffConsumedCalls.length} times`
    );
  });
});
