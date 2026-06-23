import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Direct test of the extracted operator-continuation module (daemon loop-monolith
// split 6g). Imports the module path, not the daemon.ts re-export, to lock the
// module boundary. This handler had ZERO direct coverage before extraction — it
// was only reachable transitively through the full daemon loop.
import {
  handleDaemonOperatorRequiredContinuation,
  type DaemonBlockedResultInput,
  type DaemonOperatorContinuationDeps,
  type DaemonOperatorContinuationInput
} from "../src/daemon/operator-continuation.ts";
import type { DaemonCommandResult, DaemonCycleRecord } from "../src/daemon.ts";
import type { ContinueAnalysisDirectiveClassification } from "../src/admin/autonomous-summary.ts";
import type { ContinueAnalysisExecutionDirective } from "../src/domain/types.ts";

function continueAnalysisDirective(
  overrides: Partial<ContinueAnalysisExecutionDirective> = {}
): ContinueAnalysisExecutionDirective {
  return {
    kind: "continue_analysis",
    rationale: [],
    targetId: "task:demo",
    source: "checkpoint",
    actions: [],
    nextActions: ["operator next action"],
    blockers: ["operator blocker"],
    ...overrides
  };
}

function classification(
  overrides: Partial<ContinueAnalysisDirectiveClassification> = {}
): ContinueAnalysisDirectiveClassification {
  return {
    executionMode: "operator_required",
    continuationIntent: "manual_resume",
    summary: "operator must resume this continuation",
    ...overrides
  };
}

function input(
  overrides: Partial<DaemonOperatorContinuationInput> = {}
): DaemonOperatorContinuationInput {
  return {
    directive: continueAnalysisDirective(),
    classification: classification(),
    cycle: 3,
    activeRunId: "run-1",
    activeTaskId: "task-1",
    ...overrides
  };
}

interface DepsHarness {
  deps: DaemonOperatorContinuationDeps;
  cycles: DaemonCycleRecord[];
  blockedCalls: DaemonBlockedResultInput[];
  codexCalls: Array<{ operatorNotes?: string | undefined; activeRunId: string; activeTaskId: string }>;
}

function makeDeps(opts: {
  operatorActionDir: string;
  cwd: string;
  sessionId?: () => string | undefined;
  codexResult?: DaemonCommandResult | undefined;
}): DepsHarness {
  const cycles: DaemonCycleRecord[] = [];
  const blockedCalls: DaemonBlockedResultInput[] = [];
  const codexCalls: DepsHarness["codexCalls"] = [];

  const deps: DaemonOperatorContinuationDeps = {
    operatorActionDir: opts.operatorActionDir,
    cwd: opts.cwd,
    env: {},
    now: () => new Date("2026-06-23T00:00:00.000Z"),
    workspaceSlug: "ws",
    projectSlug: "proj",
    cycles,
    getSessionId: opts.sessionId ?? (() => "sess-default"),
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
        sessionId: null,
        cycles
      };
    },
    runDaemonCodexTurn: async (codexInput) => {
      codexCalls.push({
        operatorNotes: codexInput.operatorNotes,
        activeRunId: codexInput.activeRunId,
        activeTaskId: codexInput.activeTaskId
      });
      return opts.codexResult;
    }
  };

  return { deps, cycles, blockedCalls, codexCalls };
}

test("handleDaemonOperatorRequiredContinuation: queue read error returns a blocked result without a codex turn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-opcont-"));
  // Point the operator-action dir at a file so readdir throws a non-ENOENT error.
  const notADir = path.join(dir, "queue-as-file");
  await writeFile(notADir, "not a directory", "utf8");
  const cwd = path.join(dir, "cwd");
  await mkdir(cwd, { recursive: true });

  const harness = makeDeps({ operatorActionDir: notADir, cwd, sessionId: () => "sess-err" });
  const result = await handleDaemonOperatorRequiredContinuation(input(), harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.codexCalls.length, 0, "must not run a codex turn on a queue error");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "operator_required_continuation");
  assert.match(harness.blockedCalls[0]!.reason, /operator action queue error/);
  assert.deepEqual(harness.blockedCalls[0]!.nextActions, ["operator next action"]);
  // The pushed cycle reads the session id through the live getter.
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.sessionId, "sess-err");
  assert.equal(harness.cycles[0]!.action, "blocked");
});

test("handleDaemonOperatorRequiredContinuation: no matching action writes continuation status and blocks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-opcont-"));
  const operatorActionDir = path.join(dir, "operator-actions");
  await mkdir(operatorActionDir, { recursive: true }); // empty queue
  const cwd = path.join(dir, "cwd");
  await mkdir(cwd, { recursive: true });

  // Prove the session id is read live (holder/ref), not snapshotted at call time.
  let sessionHolder: string | undefined = "sess-initial";
  const harness = makeDeps({ operatorActionDir, cwd, sessionId: () => sessionHolder });
  sessionHolder = "sess-updated";

  const result = await handleDaemonOperatorRequiredContinuation(input(), harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.codexCalls.length, 0);
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "operator_required_continuation");
  assert.equal(harness.blockedCalls[0]!.reason, "operator must resume this continuation");
  assert.equal(
    harness.blockedCalls[0]!.detailFiles?.continuationStatus,
    ".archon/work/daemon/continuation-status.json"
  );
  // Live getter observed the mutated value.
  assert.equal(harness.cycles[0]!.sessionId, "sess-updated");

  // The continuation status file was actually written under cwd.
  const statusPath = path.join(cwd, ".archon", "work", "daemon", "continuation-status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(status.state, "blocked");
  assert.equal(status.executionMode, "operator_required");
  assert.equal(status.summary, "operator must resume this continuation");
});

test("handleDaemonOperatorRequiredContinuation: matching queued action runs a codex turn with operator notes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-opcont-"));
  const operatorActionDir = path.join(dir, "operator-actions");
  await mkdir(operatorActionDir, { recursive: true });
  const cwd = path.join(dir, "cwd");
  await mkdir(cwd, { recursive: true });

  const actionFile = path.join(operatorActionDir, "action.json");
  await writeFile(
    actionFile,
    JSON.stringify({
      runId: "run-1",
      taskId: "task-1",
      blockerKind: "operator_required_continuation",
      action: {
        kind: "continue_with_analysis",
        targetId: "task:demo",
        source: "checkpoint",
        operatorNotes: "operator says proceed"
      }
    }),
    "utf8"
  );

  const codexResult: DaemonCommandResult = {
    authorityLabel: "derived_only",
    workspaceSlug: "ws",
    projectSlug: "proj",
    status: "completed",
    reason: "codex turn ran",
    activeRunId: "run-1",
    activeTaskId: "task-1",
    sessionId: "sess-x",
    cycles: []
  };

  const harness = makeDeps({ operatorActionDir, cwd, codexResult });
  const result = await handleDaemonOperatorRequiredContinuation(input(), harness.deps);

  assert.equal(result, codexResult, "returns the codex turn result directly");
  assert.equal(harness.blockedCalls.length, 0, "must not block when an action matches");
  assert.equal(harness.codexCalls.length, 1);
  assert.equal(harness.codexCalls[0]!.operatorNotes, "operator says proceed");
  assert.equal(harness.codexCalls[0]!.activeRunId, "run-1");

  // The consumed action file was archived out of the live queue.
  const remaining = await readdir(operatorActionDir);
  assert.deepEqual(remaining, [], "the matched action is consumed from the queue");
});

test("handleDaemonOperatorRequiredContinuation: matching action returning undefined propagates the continue signal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-opcont-"));
  const operatorActionDir = path.join(dir, "operator-actions");
  await mkdir(operatorActionDir, { recursive: true });
  const cwd = path.join(dir, "cwd");
  await mkdir(cwd, { recursive: true });

  await writeFile(
    path.join(operatorActionDir, "action.json"),
    JSON.stringify({
      runId: "run-1",
      taskId: "task-1",
      blockerKind: "operator_required_continuation",
      action: {
        kind: "continue_with_analysis",
        targetId: "task:demo",
        operatorNotes: "go"
      }
    }),
    "utf8"
  );

  const harness = makeDeps({ operatorActionDir, cwd, codexResult: undefined });
  const result = await handleDaemonOperatorRequiredContinuation(input(), harness.deps);

  assert.equal(result, undefined, "undefined codex result means the loop should continue");
  assert.equal(harness.codexCalls.length, 1);
  assert.equal(harness.blockedCalls.length, 0);
});
