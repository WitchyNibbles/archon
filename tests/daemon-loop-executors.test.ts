import test from "node:test";
import assert from "node:assert/strict";

// Import the leaf module directly (not via the daemon.ts re-export) so the
// extracted module path itself is exercised and locked.
import {
  createQueuedLoopReviewExecutor,
  createSupportedContinuationExecutor,
  resolveDaemonWorkflowProofTaskId,
  resolveWorkflowProofTaskIdForContinuationAction
} from "../src/daemon/loop-executors.ts";
import type {
  ContinuationAction,
  ContinueAnalysisExecutionDirective,
  DispatchReviewsExecutionDirective,
  RoutingRecommendation
} from "../src/domain/types.ts";
import type { RecordReviewCommandInput, RecordReviewCommandResult } from "../src/review.ts";

function continueAnalysisDirective(
  actions: ContinuationAction[]
): ContinueAnalysisExecutionDirective {
  return {
    kind: "continue_analysis",
    rationale: [],
    targetId: "task:demo",
    source: "blocking_gap",
    actions,
    nextActions: [],
    blockers: []
  };
}

function reviewRecommendation(
  taskId: string,
  targetReviewRole: RoutingRecommendation["targetReviewRole"]
): RoutingRecommendation {
  return {
    taskId,
    taskStatus: "review_blocked",
    recommendation: "dispatch_reviews",
    authorityLabel: "derived_only",
    targetReviewRole,
    rationale: [],
    blockers: [],
    allowedWriteScope: [],
    retrievalGuidance: [],
    approvalCheckpoints: []
  };
}

function dispatchReviewsDirective(
  recommendations: RoutingRecommendation[]
): DispatchReviewsExecutionDirective {
  return { kind: "dispatch_reviews", rationale: [], recommendations };
}

function reviewCommand(taskId: string, reviewerRole: "reviewer" | "qa_engineer"): RecordReviewCommandInput {
  return {
    runId: "run-1",
    taskId,
    actor: `${reviewerRole}-actor`,
    review: {
      reviewerRole,
      state: "approved",
      severity: "info",
      findings: []
    }
  };
}

test("resolveDaemonWorkflowProofTaskId returns the run_workflow_proof action's taskId", () => {
  const directive = continueAnalysisDirective([
    { kind: "resolve_blocking_gap", gapId: "g1", targetId: "task:other" },
    { kind: "run_workflow_proof", taskId: "task-proof" }
  ]);
  assert.equal(resolveDaemonWorkflowProofTaskId(directive), "task-proof");
});

test("resolveDaemonWorkflowProofTaskId returns undefined when no workflow-proof action is present", () => {
  const directive = continueAnalysisDirective([
    { kind: "resolve_blocking_gap", gapId: "g1", targetId: "task:other" }
  ]);
  assert.equal(resolveDaemonWorkflowProofTaskId(directive), undefined);
});

test("resolveWorkflowProofTaskIdForContinuationAction covers each action shape", () => {
  assert.equal(
    resolveWorkflowProofTaskIdForContinuationAction({ kind: "run_workflow_proof", taskId: "task-a" }),
    "task-a"
  );
  assert.equal(
    resolveWorkflowProofTaskIdForContinuationAction({
      kind: "resolve_blocking_gap",
      gapId: "g1",
      targetId: "task:task-b"
    }),
    "task-b"
  );
  assert.equal(
    resolveWorkflowProofTaskIdForContinuationAction({
      kind: "resume_target",
      targetId: "task:task-c",
      source: "blocking_gap"
    }),
    "task-c"
  );
  // Non task-prefixed target yields no proof task id.
  assert.equal(
    resolveWorkflowProofTaskIdForContinuationAction({
      kind: "resume_target",
      targetId: "review:authenticated",
      source: "progress_proof"
    }),
    undefined
  );
  // Empty task id after the prefix is treated as absent.
  assert.equal(
    resolveWorkflowProofTaskIdForContinuationAction({
      kind: "resolve_blocking_gap",
      gapId: "g1",
      targetId: "task:   "
    }),
    undefined
  );
});

test("createQueuedLoopReviewExecutor executes a matching review command and drains the queue", async () => {
  const calls: RecordReviewCommandInput[] = [];
  const fakeResult: RecordReviewCommandResult = {
    mode: "live",
    bindingsPath: "/bindings.json",
    adapterModulePath: "/adapter.js",
    availableBackends: [],
    principal: { provider: "test-provider", subject: "test-subject" },
    review: {} as RecordReviewCommandResult["review"],
    blockers: [],
    taskStatus: "review_blocked"
  };

  const executor = createQueuedLoopReviewExecutor(
    "run-1",
    [reviewCommand("task-x", "reviewer"), reviewCommand("task-x", "qa_engineer")],
    async (command) => {
      calls.push(command);
      return fakeResult;
    }
  );

  assert.ok(executor);
  const first = await executor!({
    runId: "run-1",
    directive: dispatchReviewsDirective([reviewRecommendation("task-x", "reviewer")])
  });

  assert.equal(first.executed, true);
  assert.equal(first.taskId, "task-x");
  assert.equal(first.reviewRole, "reviewer");
  assert.ok(first.evidence.some((line) => line.includes("authenticated principal test-provider:test-subject")));
  assert.equal(calls.length, 1);

  // The matched command was consumed; the same role no longer matches.
  const second = await executor!({
    runId: "run-1",
    directive: dispatchReviewsDirective([reviewRecommendation("task-x", "reviewer")])
  });
  assert.equal(second.executed, false);
  assert.equal(calls.length, 1);
});

test("createQueuedLoopReviewExecutor reports no match when no queued command applies", async () => {
  const executor = createQueuedLoopReviewExecutor("run-1", [reviewCommand("task-x", "reviewer")], async () => {
    throw new Error("should not be called");
  });

  assert.ok(executor);
  const result = await executor!({
    runId: "run-1",
    directive: dispatchReviewsDirective([reviewRecommendation("task-other", "qa_engineer")])
  });

  assert.equal(result.executed, false);
  assert.equal(result.taskId, "task-other");
  assert.equal(result.reviewRole, "qa_engineer");
  assert.ok(
    result.evidence[0]?.includes("no matching trusted review input was supplied")
  );
});

test("createSupportedContinuationExecutor declines unsupported continuation actions without touching the store", async () => {
  let snapshotCalls = 0;
  const executor = createSupportedContinuationExecutor({
    getStatusSnapshot: async () => {
      snapshotCalls += 1;
      throw new Error("getStatusSnapshot should not run for unsupported actions");
    },
    getReviews: async () => [],
    getApprovals: async () => []
  });

  // resolve_blocking_gap with a non-task target resolves to no proof task id and
  // is not a resume_target, so the executor declines without any store access.
  const result = await executor({
    runId: "run-1",
    directive: continueAnalysisDirective([]),
    action: { kind: "resolve_blocking_gap", gapId: "g1", targetId: "gap:misc" }
  });

  assert.equal(result.executed, false);
  assert.equal(snapshotCalls, 0);
  assert.ok(
    result.evidence[0]?.includes("no supported continuation executor is available for resolve_blocking_gap")
  );
});
