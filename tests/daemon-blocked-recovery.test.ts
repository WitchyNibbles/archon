import test from "node:test";
import assert from "node:assert/strict";

// Direct test of the extracted blocked / apply_recovery directive handler
// (daemon loop-monolith split 6l). Imports the module path, not the daemon.ts
// re-export, to lock the module boundary.
//
// Both directive kinds share a single-exit path (always return a blocked
// DaemonCommandResult; there is no continue signal). The only variation is in
// the cycle summary, blockerKind, and reason strings.
//
// What IS covered here:
//   (a) "blocked" directive with non-empty blockers → summary = blockers joined
//       by " | ", blockerKind "runtime_blocked", sessionId read via live getter
//   (b) "blocked" directive with EMPTY blockers → summary falls back to the
//       canonical "runtime reported no executable next step" string
//   (c) "apply_recovery" directive → canonical summary, blockerKind
//       "recovery_required", reason for recovery path
//   (d) live getter test — sessionId is read through getSessionId at push time,
//       not captured as a snapshot at handler construction time
import {
  handleDaemonBlockedOrRecovery,
  type DaemonBlockedRecoveryInput,
  type DaemonBlockedRecoveryDeps
} from "../src/daemon/blocked-recovery.ts";
import type { DaemonBlockedResultInput, DaemonBlockedResultBuilder } from "../src/daemon/codex-turn.ts";
import type { DaemonCommandResult, DaemonCycleRecord } from "../src/daemon.ts";
import type { RunExecutionPlan } from "../src/domain/types.ts";

type BlockedDirective = Extract<RunExecutionPlan["directive"], { kind: "blocked" }>;
type ApplyRecoveryDirective = Extract<RunExecutionPlan["directive"], { kind: "apply_recovery" }>;

function blockedDirective(blockers: string[]): BlockedDirective {
  return { kind: "blocked", blockers } as unknown as BlockedDirective;
}

function applyRecoveryDirective(): ApplyRecoveryDirective {
  return { kind: "apply_recovery" } as unknown as ApplyRecoveryDirective;
}

interface Harness {
  input: DaemonBlockedRecoveryInput;
  deps: DaemonBlockedRecoveryDeps;
  cycles: DaemonCycleRecord[];
  blockedCalls: DaemonBlockedResultInput[];
  sessionHolder: { value: string | undefined };
}

function makeHarness(opts: {
  directive: DaemonBlockedRecoveryInput["directive"];
  initialSession?: string;
}): Harness {
  const cycles: DaemonCycleRecord[] = [];
  const blockedCalls: DaemonBlockedResultInput[] = [];
  const sessionHolder: { value: string | undefined } = { value: opts.initialSession };

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
      sessionId: sessionHolder.value ?? null,
      cycles
    } satisfies DaemonCommandResult;
  };

  const input: DaemonBlockedRecoveryInput = {
    directive: opts.directive,
    cycle: 1,
    activeRunId: "run-1",
    activeTaskId: "task-1"
  };

  const deps: DaemonBlockedRecoveryDeps = {
    cycles,
    getSessionId: () => sessionHolder.value,
    blockedResult
  };

  return { input, deps, cycles, blockedCalls, sessionHolder };
}

// ---------------------------------------------------------------------------
// Test (a): "blocked" directive with non-empty blockers
// ---------------------------------------------------------------------------

test("handleDaemonBlockedOrRecovery: blocked directive with non-empty blockers → runtime_blocked result", async () => {
  const harness = makeHarness({
    directive: blockedDirective(["blocker-a", "blocker-b"]),
    initialSession: "sess-1"
  });

  const result = await handleDaemonBlockedOrRecovery(harness.input, harness.deps);

  assert.ok(result !== undefined, "must return a DaemonCommandResult (never undefined)");
  assert.equal(result.status, "blocked");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  assert.equal(harness.cycles[0]!.directiveKind, "blocked");
  assert.equal(harness.cycles[0]!.runId, "run-1");
  assert.equal(harness.cycles[0]!.taskId, "task-1");
  assert.equal(harness.cycles[0]!.sessionId, "sess-1", "sessionId read via live getter");
  assert.equal(harness.cycles[0]!.summary, "blocker-a | blocker-b");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "runtime_blocked");
  assert.equal(harness.blockedCalls[0]!.reason, "runtime reported no executable next step");
  assert.equal(harness.blockedCalls[0]!.activeRunId, "run-1");
  assert.equal(harness.blockedCalls[0]!.activeTaskId, "task-1");
  assert.equal(harness.blockedCalls[0]!.directiveKind, "blocked");
  assert.deepEqual(harness.blockedCalls[0]!.nextActions, []);
});

// ---------------------------------------------------------------------------
// Test (b): "blocked" directive with EMPTY blockers → fallback summary
// ---------------------------------------------------------------------------

test("handleDaemonBlockedOrRecovery: blocked directive with empty blockers → fallback summary", async () => {
  const harness = makeHarness({
    directive: blockedDirective([]),
    initialSession: "sess-2"
  });

  const result = await handleDaemonBlockedOrRecovery(harness.input, harness.deps);

  assert.ok(result !== undefined);
  assert.equal(result.status, "blocked");
  assert.equal(harness.cycles.length, 1);
  assert.equal(
    harness.cycles[0]!.summary,
    "runtime reported no executable next step",
    "empty blockers array falls back to canonical string"
  );
  assert.equal(harness.blockedCalls[0]!.blockerKind, "runtime_blocked");
});

// ---------------------------------------------------------------------------
// Test (c): "apply_recovery" directive → recovery_required result
// ---------------------------------------------------------------------------

test("handleDaemonBlockedOrRecovery: apply_recovery directive → recovery_required result", async () => {
  const harness = makeHarness({
    directive: applyRecoveryDirective(),
    initialSession: "sess-3"
  });

  const result = await handleDaemonBlockedOrRecovery(harness.input, harness.deps);

  assert.ok(result !== undefined);
  assert.equal(result.status, "blocked");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  assert.equal(harness.cycles[0]!.directiveKind, "apply_recovery");
  assert.equal(
    harness.cycles[0]!.summary,
    "runtime still requires explicit recovery before the daemon can continue"
  );
  assert.equal(harness.cycles[0]!.sessionId, "sess-3");
  assert.equal(harness.blockedCalls[0]!.blockerKind, "recovery_required");
  assert.equal(
    harness.blockedCalls[0]!.reason,
    "safe recovery could not clear the active runtime blockers"
  );
  assert.equal(harness.blockedCalls[0]!.directiveKind, "apply_recovery");
  assert.deepEqual(harness.blockedCalls[0]!.nextActions, []);
});

// ---------------------------------------------------------------------------
// Test (d): sessionId is read via live getter, not captured snapshot
// ---------------------------------------------------------------------------

test("handleDaemonBlockedOrRecovery: sessionId is read via live getter at push time", async () => {
  // Build harness without an initial session, then set the value before calling the
  // handler. This verifies the getter is called at cycle-push time inside the handler,
  // not captured as a snapshot during deps construction.
  const harness = makeHarness({
    directive: blockedDirective(["some-blocker"]),
    initialSession: undefined
  });

  // Set the session AFTER harness construction — the live getter must pick it up.
  harness.sessionHolder.value = "live-session";

  const result = await handleDaemonBlockedOrRecovery(harness.input, harness.deps);

  assert.ok(result !== undefined);
  assert.equal(
    harness.cycles[0]!.sessionId,
    "live-session",
    "cycle record reflects value set after harness construction (live getter)"
  );
});
