import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Direct test of the extracted dispatch_reviews handler (daemon loop-monolith split 6i).
// Imports the module path, not the daemon.ts re-export, to lock the module
// boundary. The handler had ZERO direct coverage before extraction — it was only
// reachable transitively through the full daemon loop (which needs a live DB).
import {
  handleDaemonReviewDispatch,
  type DaemonReviewDispatchDeps,
  type DaemonReviewDispatchInput
} from "../src/daemon/review-dispatch.ts";
import type { DaemonBlockedResultInput, DaemonBlockedResultBuilder } from "../src/daemon/codex-turn.ts";
import type { DaemonCommandResult, DaemonCycleRecord } from "../src/daemon.ts";
import type { DirectiveExecutionResult } from "../src/core/service.ts";
import type { RunExecutionPlan } from "../src/domain/types.ts";

type DispatchReviewsDirective = Extract<RunExecutionPlan["directive"], { kind: "dispatch_reviews" }>;

/** Minimal valid review action file content for a given role. */
function reviewActionJson(opts: {
  runId: string;
  taskId: string;
  actor: string;
  reviewerRole: string;
}): string {
  return JSON.stringify({
    runId: opts.runId,
    taskId: opts.taskId,
    actor: opts.actor,
    review: {
      reviewerRole: opts.reviewerRole,
      state: "passed",
      severity: "low",
      findings: []
    }
  });
}

/** Minimal dispatch_reviews directive with one recommendation. */
function dispatchDirective(opts: {
  taskId?: string;
  reviewerRole?: string;
} = {}): DispatchReviewsDirective {
  return {
    kind: "dispatch_reviews",
    rationale: [],
    recommendations: [
      {
        kind: "required_review",
        taskId: opts.taskId ?? "task-1",
        targetReviewRole: (opts.reviewerRole ?? "reviewer") as DispatchReviewsDirective["recommendations"][number]["targetReviewRole"]
      }
    ]
  } as unknown as DispatchReviewsDirective;
}

interface Harness {
  deps: DaemonReviewDispatchDeps;
  input: DaemonReviewDispatchInput;
  cycles: DaemonCycleRecord[];
  blockedCalls: DaemonBlockedResultInput[];
  executeStepCalls: Array<{ runId: string; staleAfterHours: number; reviewCommands: unknown[] }>;
  session: () => string | undefined;
}

function makeHarness(opts: {
  cwd: string;
  reviewInputDir: string;
  executeDirectiveStep?: DaemonReviewDispatchDeps["executeDirectiveStep"];
  initialSession?: string;
  directive?: DispatchReviewsDirective;
}): Harness {
  const cycles: DaemonCycleRecord[] = [];
  const blockedCalls: DaemonBlockedResultInput[] = [];
  const executeStepCalls: Array<{ runId: string; staleAfterHours: number; reviewCommands: unknown[] }> = [];
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

  const directive = opts.directive ?? dispatchDirective();

  const input: DaemonReviewDispatchInput = {
    directive,
    cycle: 2,
    activeRunId: "run-1",
    activeTaskId: "task-1",
    now: () => new Date("2026-06-23T00:00:00.000Z"),
    cwd: opts.cwd,
    reviewInputDir: opts.reviewInputDir
  };

  const deps: DaemonReviewDispatchDeps = {
    executeDirectiveStep: opts.executeDirectiveStep,
    staleAfterHours: 24,
    cycles,
    getSessionId: () => session,
    blockedResult
  };

  return { deps, input, cycles, blockedCalls, executeStepCalls, session: () => session };
}

function executionResult(steps: DirectiveExecutionResult["steps"]): DirectiveExecutionResult {
  return {
    runId: "run-1",
    initialPlan: {} as unknown as RunExecutionPlan,
    finalPlan: {} as unknown as RunExecutionPlan,
    steps
  };
}

test("handleDaemonReviewDispatch: no executeDirectiveStep blocks review_execution_unsupported", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-review-dispatch-"));
  const reviewInputDir = path.join(cwd, "review-actions");
  const harness = makeHarness({
    cwd,
    reviewInputDir,
    executeDirectiveStep: undefined,
    initialSession: "sess-1"
  });

  const result = await handleDaemonReviewDispatch(harness.input, harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "review_execution_unsupported");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  assert.equal(harness.cycles[0]!.sessionId, "sess-1", "blocked cycle reads session via live getter");
});

test("handleDaemonReviewDispatch: empty review queue blocks review_queue", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-review-dispatch-"));
  // reviewInputDir does not exist — readDaemonReviewQueueState returns empty on ENOENT
  const reviewInputDir = path.join(cwd, "review-actions");
  let executeStepCalled = false;
  const harness = makeHarness({
    cwd,
    reviewInputDir,
    executeDirectiveStep: async () => {
      executeStepCalled = true;
      return executionResult([]);
    },
    initialSession: "sess-2"
  });

  const result = await handleDaemonReviewDispatch(harness.input, harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.blockedCalls[0]!.blockerKind, "review_queue");
  assert.equal(executeStepCalled, false, "executeDirectiveStep is not called when queue is empty");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  // Queue status file should be written
  const statusFile = path.join(cwd, ".archon", "work", "daemon", "review-queue-status.json");
  const status = JSON.parse(await readFile(statusFile, "utf8")) as { state: string };
  assert.equal(status.state, "blocked");
  assert.ok(harness.blockedCalls[0]!.detailFiles?.reviewQueueStatus, "detail file ref is set");
});

test("handleDaemonReviewDispatch: successful dispatch returns undefined (continue signal)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-review-dispatch-"));
  const reviewInputDir = path.join(cwd, "review-actions");
  await mkdir(reviewInputDir, { recursive: true });
  // Write a valid review action file
  await writeFile(
    path.join(reviewInputDir, "review-001.json"),
    reviewActionJson({ runId: "run-1", taskId: "task-1", actor: "alice", reviewerRole: "reviewer" }),
    "utf8"
  );

  const harness = makeHarness({
    cwd,
    reviewInputDir,
    executeDirectiveStep: async (_runId, _input) => {
      return executionResult([
        {
          directiveKind: "dispatch_reviews",
          outcome: "executed",
          taskId: "task-1",
          reviewRole: "reviewer",
          actor: "alice",
          evidence: ["review recorded"]
        }
      ]);
    },
    initialSession: "sess-3"
  });

  const result = await handleDaemonReviewDispatch(harness.input, harness.deps);

  assert.equal(result, undefined, "a successful dispatch returns the continue signal");
  assert.equal(harness.blockedCalls.length, 0, "no blocked result when reviews are applied");
  // The record_review cycle is recorded
  const reviewCycles = harness.cycles.filter((c) => c.action === "record_review");
  assert.equal(reviewCycles.length, 1);
  assert.equal(reviewCycles[0]!.taskId, "task-1");
  assert.equal(reviewCycles[0]!.sessionId, "sess-3", "cycle reads session via live getter");
  // Queue status file is written as "processed"
  const statusFile = path.join(cwd, ".archon", "work", "daemon", "review-queue-status.json");
  const status = JSON.parse(await readFile(statusFile, "utf8")) as { state: string };
  assert.equal(status.state, "processed");
});

test("handleDaemonReviewDispatch: stale/mismatched entries block review_queue", async () => {
  // The dispatch step returns no executed steps (outcome is 'unsupported') and
  // the queued entry is moved to stale because it no longer matches the active
  // runtime review directives. The handler must return a blocked result.
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-review-dispatch-"));
  const reviewInputDir = path.join(cwd, "review-actions");
  await mkdir(reviewInputDir, { recursive: true });
  // Queued entry for a different runId than the active one — will be stale
  await writeFile(
    path.join(reviewInputDir, "review-stale-001.json"),
    reviewActionJson({ runId: "run-old", taskId: "task-1", actor: "bob", reviewerRole: "reviewer" }),
    "utf8"
  );

  const harness = makeHarness({
    cwd,
    reviewInputDir,
    executeDirectiveStep: async () => {
      // Returns a step with 'unsupported' outcome — no executed reviews
      return executionResult([
        {
          directiveKind: "dispatch_reviews",
          outcome: "unsupported",
          evidence: ["review action did not match active directives"]
        }
      ]);
    },
    initialSession: "sess-4"
  });

  const result = await handleDaemonReviewDispatch(harness.input, harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "review_queue");
  assert.ok(harness.blockedCalls[0]!.detailFiles?.reviewQueueStatus, "detail file ref is set");
  // The cycle records a blocked entry
  assert.ok(harness.cycles.some((c) => c.action === "blocked"));
  // Queue status file is written as "blocked"
  const statusFile = path.join(cwd, ".archon", "work", "daemon", "review-queue-status.json");
  const status = JSON.parse(await readFile(statusFile, "utf8")) as { state: string; staleFiles?: unknown[] };
  assert.equal(status.state, "blocked");
  // The stale entry is archived (staleFiles shows up in the status when entries were stale)
  assert.ok(Array.isArray(status.staleFiles), "stale entries are reported in the queue status");
});

test("handleDaemonReviewDispatch: queue read error (non-ENOENT) blocks without writing a status file", async () => {
  // readDaemonReviewQueueState only absorbs ENOENT; any other fs error (here
  // ENOTDIR, because reviewInputDir is a regular file, not a directory) propagates
  // and is caught by the handler. This blocked path is distinct: it records a
  // cycle and returns review_queue but writes NO status file.
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-review-dispatch-"));
  const reviewInputDir = path.join(cwd, "not-a-dir.json");
  await writeFile(reviewInputDir, "placeholder", "utf8"); // a FILE where a dir is expected
  let executeStepCalled = false;
  const harness = makeHarness({
    cwd,
    reviewInputDir,
    executeDirectiveStep: async () => {
      executeStepCalled = true;
      return executionResult([]);
    },
    initialSession: "sess-5"
  });

  const result = await handleDaemonReviewDispatch(harness.input, harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "review_queue");
  assert.match(harness.blockedCalls[0]!.reason, /^review input queue error: /);
  assert.equal(executeStepCalled, false, "executeDirectiveStep is never reached on a queue read error");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "blocked");
  assert.equal(harness.cycles[0]!.sessionId, "sess-5", "blocked cycle reads session via live getter");
  // Unlike every other blocked path, the read-error branch writes no status file.
  const statusFile = path.join(cwd, ".archon", "work", "daemon", "review-queue-status.json");
  await assert.rejects(readFile(statusFile, "utf8"), /ENOENT/, "no status file is written on a queue read error");
});

test("handleDaemonReviewDispatch: failed-only queue archives failures and writes status state 'failed'", async () => {
  // Some queued action files are malformed (invalid JSON) and there are zero valid
  // entries. The handler must archive the failed files and write the queue status
  // with state "failed" (not "blocked"), while still returning a review_queue block.
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-review-dispatch-"));
  const reviewInputDir = path.join(cwd, "review-actions");
  await mkdir(reviewInputDir, { recursive: true });
  await writeFile(path.join(reviewInputDir, "review-bad-001.json"), "this-is-not-json", "utf8");
  let executeStepCalled = false;
  const harness = makeHarness({
    cwd,
    reviewInputDir,
    executeDirectiveStep: async () => {
      executeStepCalled = true;
      return executionResult([]);
    },
    initialSession: "sess-6"
  });

  const result = await handleDaemonReviewDispatch(harness.input, harness.deps);

  assert.equal(result?.status, "blocked");
  assert.equal(harness.blockedCalls.length, 1);
  assert.equal(harness.blockedCalls[0]!.blockerKind, "review_queue");
  assert.equal(executeStepCalled, false, "executeDirectiveStep is not called when no valid entries remain");
  // Status file is written as "failed" (failed entries present, no valid entries).
  const statusFile = path.join(cwd, ".archon", "work", "daemon", "review-queue-status.json");
  const status = JSON.parse(await readFile(statusFile, "utf8")) as { state: string; failedFiles?: unknown[] };
  assert.equal(status.state, "failed");
  assert.ok(Array.isArray(status.failedFiles) && status.failedFiles.length === 1, "failed file is reported in status");
  // The malformed file is archived out of the queue into failed-review-actions.
  const archivedFile = path.join(cwd, ".archon", "work", "daemon", "failed-review-actions", "review-bad-001.json");
  assert.ok((await readFile(archivedFile, "utf8")).length > 0, "malformed file is moved to failed-review-actions");
});
