import test from "node:test";
import assert from "node:assert/strict";

// Import the leaf module directly (not via the daemon.ts re-export) so the
// extracted module path itself is exercised and locked.
import {
  computeDaemonStagnantTurnCount,
  evaluateDaemonNoProgressOutcome
} from "../src/daemon/turn-analysis.ts";
import type { DaemonStagnationMetadata, ParsedDaemonTurnMessage } from "../src/daemon/turn-prompt.ts";

function stagnation(overrides: Partial<DaemonStagnationMetadata> = {}): DaemonStagnationMetadata {
  return {
    runId: "run-1",
    taskId: "task-1",
    directiveKind: "continue_analysis",
    progressKey: "key-1",
    count: 3,
    updatedAt: "2026-06-23T00:00:00.000Z",
    ...overrides
  };
}

function turnMessage(overrides: Partial<ParsedDaemonTurnMessage> = {}): ParsedDaemonTurnMessage {
  return {
    summary: "did some work",
    status: "needs_followup",
    blockers: [],
    ...overrides
  };
}

const baseStreak = {
  runId: "run-1",
  taskId: "task-1",
  directiveKind: "continue_analysis" as const,
  progressKey: "key-1"
};

test("computeDaemonStagnantTurnCount: a progressing turn resets the streak to 0", () => {
  assert.equal(
    computeDaemonStagnantTurnCount({ noProgress: false, priorStagnation: stagnation(), ...baseStreak }),
    0
  );
});

test("computeDaemonStagnantTurnCount: a no-progress turn with no prior record starts at 1", () => {
  assert.equal(
    computeDaemonStagnantTurnCount({ noProgress: true, priorStagnation: undefined, ...baseStreak }),
    1
  );
});

test("computeDaemonStagnantTurnCount: a matching prior streak carries forward (+1)", () => {
  assert.equal(
    computeDaemonStagnantTurnCount({ noProgress: true, priorStagnation: stagnation({ count: 3 }), ...baseStreak }),
    4
  );
});

test("computeDaemonStagnantTurnCount: a mismatched progress key restarts the streak at 1", () => {
  assert.equal(
    computeDaemonStagnantTurnCount({
      noProgress: true,
      priorStagnation: stagnation({ progressKey: "different-key" }),
      ...baseStreak
    }),
    1
  );
});

test("computeDaemonStagnantTurnCount: a mismatched run/task/directive restarts the streak at 1", () => {
  for (const mismatch of [{ runId: "run-2" }, { taskId: "task-2" }, { directiveKind: "complete" as const }]) {
    assert.equal(
      computeDaemonStagnantTurnCount({
        noProgress: true,
        priorStagnation: stagnation(mismatch),
        ...baseStreak
      }),
      1,
      `mismatch ${JSON.stringify(mismatch)} should restart the streak`
    );
  }
});

test("evaluateDaemonNoProgressOutcome: a progressing turn never blocks", () => {
  const outcome = evaluateDaemonNoProgressOutcome({
    noProgress: false,
    parsedTurnMessage: turnMessage({ status: "blocked" }),
    stagnantTurnCount: 9,
    activeTaskId: "task-1"
  });
  assert.deepEqual(outcome, { shouldBlock: false });
});

test("evaluateDaemonNoProgressOutcome: a no-progress turn under the stagnation budget does not block", () => {
  const outcome = evaluateDaemonNoProgressOutcome({
    noProgress: true,
    parsedTurnMessage: turnMessage({ status: "needs_followup" }),
    stagnantTurnCount: 1,
    activeTaskId: "task-1"
  });
  assert.deepEqual(outcome, { shouldBlock: false });
});

test("evaluateDaemonNoProgressOutcome: a worker-reported blocked turn blocks as runtime_blocked", () => {
  const outcome = evaluateDaemonNoProgressOutcome({
    noProgress: true,
    parsedTurnMessage: turnMessage({ status: "blocked", summary: "cannot proceed", blockers: ["needs creds"] }),
    stagnantTurnCount: 1,
    activeTaskId: "task-1"
  });
  assert.equal(outcome.shouldBlock, true);
  if (!outcome.shouldBlock) return;
  assert.equal(outcome.scopeConflict, false);
  assert.equal(outcome.blockerKind, "runtime_blocked");
  assert.equal(outcome.cycleAction, "blocked");
  assert.match(outcome.reason, /blocked no-progress turn: cannot proceed \| needs creds/);
  assert.equal(outcome.scopeExpansion, undefined);
});

test("evaluateDaemonNoProgressOutcome: reaching the stagnation budget blocks with the consecutive-turns reason", () => {
  const outcome = evaluateDaemonNoProgressOutcome({
    noProgress: true,
    parsedTurnMessage: turnMessage({ status: "needs_followup", summary: "still spinning" }),
    stagnantTurnCount: 2,
    activeTaskId: "task-xyz"
  });
  assert.equal(outcome.shouldBlock, true);
  if (!outcome.shouldBlock) return;
  assert.equal(outcome.blockerKind, "runtime_blocked");
  assert.match(outcome.reason, /detected 2 consecutive no-progress turns for task-xyz: still spinning/);
  assert.ok(outcome.nextActions.some((line) => line.includes("missing runtime proof")));
});

test("evaluateDaemonNoProgressOutcome: a scope conflict routes to a scope-expansion block with payload", () => {
  const outcome = evaluateDaemonNoProgressOutcome({
    noProgress: true,
    parsedTurnMessage: turnMessage({
      status: "blocked",
      summary: "edit was out of scope",
      scopeRequest: {
        blockedPaths: ["src/forbidden.ts"],
        requestedWriteScope: [],
        reason: "need to touch the forbidden file"
      }
    }),
    stagnantTurnCount: 1,
    activeTaskId: "task-1"
  });
  assert.equal(outcome.shouldBlock, true);
  if (!outcome.shouldBlock) return;
  assert.equal(outcome.scopeConflict, true);
  assert.equal(outcome.blockerKind, "scope_expansion_required");
  assert.equal(outcome.cycleAction, "request_scope_expansion");
  assert.match(outcome.reason, /scope-blocked no-progress turn/);
  assert.ok(outcome.nextActions.some((line) => line.includes("widen the task packet allowed write scope")));
  // requestedWriteScope is empty, so it defaults to the blocked paths.
  assert.deepEqual(outcome.scopeExpansion, {
    blockedPaths: ["src/forbidden.ts"],
    requestedWriteScope: ["src/forbidden.ts"],
    reason: "need to touch the forbidden file"
  });
});

test("evaluateDaemonNoProgressOutcome: an explicit requested write scope is preserved, falling back to summary for reason", () => {
  const outcome = evaluateDaemonNoProgressOutcome({
    noProgress: true,
    parsedTurnMessage: turnMessage({
      status: "blocked",
      summary: "blocked: write scope mismatch",
      scopeRequest: {
        blockedPaths: ["src/a.ts"],
        requestedWriteScope: ["src/a.ts", "src/b.ts"]
      }
    }),
    stagnantTurnCount: 1,
    activeTaskId: "task-1"
  });
  assert.equal(outcome.shouldBlock, true);
  if (!outcome.shouldBlock) return;
  assert.deepEqual(outcome.scopeExpansion, {
    blockedPaths: ["src/a.ts"],
    requestedWriteScope: ["src/a.ts", "src/b.ts"],
    reason: "blocked: write scope mismatch"
  });
});
