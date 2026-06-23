import test from "node:test";
import assert from "node:assert/strict";

// Direct test of the extracted continue_analysis handler (daemon loop-monolith split 6j).
// Imports the module path, not the daemon.ts re-export, to lock the module
// boundary. The handler had ZERO direct coverage before extraction — it was only
// reachable transitively through the full daemon loop (which needs a live DB).
//
// The workflow-proof path (resolveDaemonWorkflowProofTaskId returning a truthy value)
// is NOT tested here because executeWorkflowProofCommandFromArgs and
// closeWorkflowProofCoverageGaps are imported directly into the module with no
// injection point. All directive fixtures in these tests omit run_workflow_proof
// actions so resolveDaemonWorkflowProofTaskId returns undefined and the proof
// branch is never entered.
import {
  handleDaemonContinueAnalysis,
  type DaemonContinueAnalysisDeps,
  type DaemonContinueAnalysisInput
} from "../src/daemon/continue-analysis.ts";
import type { DaemonBlockedResultInput, DaemonBlockedResultBuilder } from "../src/daemon/codex-turn.ts";
import type { DaemonCommandResult, DaemonCycleRecord } from "../src/daemon.ts";
import type { DirectiveExecutionResult } from "../src/core/service.ts";
import type { RunExecutionPlan, RunStatusSnapshot } from "../src/domain/types.ts";
import type { ContinueAnalysisDirectiveClassification } from "../src/admin/autonomous-summary.ts";

type ContinueAnalysisDirective = Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;

/**
 * Minimal continue_analysis directive with no actions (operator_required path)
 * or with resolve_blocking_gap action (also operator_required, non-task target).
 */
function continueDirective(opts: {
  actions?: ContinueAnalysisDirective["actions"];
} = {}): ContinueAnalysisDirective {
  return {
    kind: "continue_analysis",
    targetId: "target-1",
    source: "blocking_gap",
    actions: opts.actions ?? [],
    nextActions: [],
    blockers: []
  } as unknown as ContinueAnalysisDirective;
}

/** Minimal RunStatusSnapshot that classifyContinueAnalysisDirective can consume. */
function statusSnapshot(opts: {
  state?: RunStatusSnapshot["autonomousExecution"] extends undefined ? never : NonNullable<RunStatusSnapshot["autonomousExecution"]>["state"];
} = {}): RunStatusSnapshot {
  return {
    tasks: [],
    autonomousExecution: opts.state ? { state: opts.state } : undefined
  } as unknown as RunStatusSnapshot;
}

function executionResult(steps: DirectiveExecutionResult["steps"]): DirectiveExecutionResult {
  return {
    runId: "run-1",
    initialPlan: {} as unknown as RunExecutionPlan,
    finalPlan: {} as unknown as RunExecutionPlan,
    steps
  };
}

interface Harness {
  deps: DaemonContinueAnalysisDeps;
  input: DaemonContinueAnalysisInput;
  cycles: DaemonCycleRecord[];
  blockedCalls: DaemonBlockedResultInput[];
  operatorCalls: Array<{
    directive: ContinueAnalysisDirective;
    classification: ContinueAnalysisDirectiveClassification;
  }>;
  session: () => string | undefined;
}

function makeHarness(opts: {
  executeDirectiveStep?: DaemonContinueAnalysisDeps["executeDirectiveStep"];
  operatorHandled?: DaemonCommandResult | undefined;
  initialSession?: string;
  directive?: ContinueAnalysisDirective;
  snapshotState?: Parameters<typeof statusSnapshot>[0]["state"];
}): Harness {
  const cycles: DaemonCycleRecord[] = [];
  const blockedCalls: DaemonBlockedResultInput[] = [];
  const operatorCalls: Array<{
    directive: ContinueAnalysisDirective;
    classification: ContinueAnalysisDirectiveClassification;
  }> = [];
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

  const directive = opts.directive ?? continueDirective();

  const input: DaemonContinueAnalysisInput = {
    directive,
    cycle: 1,
    activeRunId: "run-1",
    activeTaskId: "task-1"
  };

  const deps: DaemonContinueAnalysisDeps = {
    executeDirectiveStep: opts.executeDirectiveStep,
    getStatusSnapshot: async (_runId) => statusSnapshot({ state: opts.snapshotState }),
    getReviews: async () => [],
    getApprovals: async () => [],
    upsertCoverageGaps: undefined,
    staleAfterHours: 24,
    env: {},
    cycles,
    getSessionId: () => session,
    blockedResult,
    handleOperatorRequiredContinuation: async (callInput) => {
      operatorCalls.push({
        directive: callInput.directive as ContinueAnalysisDirective,
        classification: callInput.classification
      });
      return opts.operatorHandled;
    }
  };

  return { deps, input, cycles, blockedCalls, operatorCalls, session: () => session };
}

test("handleDaemonContinueAnalysis: executed step returns continue outcome", async () => {
  // When executeDirectiveStep returns a step with outcome=executed, the handler
  // should push a cycle record and return { kind: "continue" }.
  const harness = makeHarness({
    executeDirectiveStep: async () =>
      executionResult([
        {
          directiveKind: "continue_analysis",
          outcome: "executed",
          taskId: "task-1",
          evidence: ["runtime continuation applied"],
          actor: undefined,
          reviewRole: undefined
        }
      ]),
    initialSession: "sess-1"
  });

  const outcome = await handleDaemonContinueAnalysis(harness.input, harness.deps);

  assert.equal(outcome.kind, "continue");
  assert.equal(harness.cycles.length, 1);
  assert.equal(harness.cycles[0]!.action, "apply_runtime_continuation");
  assert.equal(harness.cycles[0]!.summary, "runtime continuation applied");
  assert.equal(harness.cycles[0]!.sessionId, "sess-1", "cycle reads session via live getter");
  assert.equal(harness.blockedCalls.length, 0);
  assert.equal(harness.operatorCalls.length, 0);
});

test("handleDaemonContinueAnalysis: unsupported step operator_required + handled returns return outcome", async () => {
  // When executeDirectiveStep returns unsupported AND classification is operator_required
  // AND handleOperatorRequiredContinuation returns a result, the outcome should be "return".
  const blockedCommandResult: DaemonCommandResult = {
    authorityLabel: "derived_only",
    workspaceSlug: "ws",
    projectSlug: "proj",
    status: "blocked",
    reason: "operator required",
    activeRunId: "run-1",
    activeTaskId: "task-1",
    sessionId: null,
    cycles: []
  };
  const harness = makeHarness({
    executeDirectiveStep: async () =>
      executionResult([
        {
          directiveKind: "continue_analysis",
          outcome: "unsupported",
          evidence: ["continuation is operator-gated"],
          taskId: undefined,
          actor: undefined,
          reviewRole: undefined
        }
      ]),
    // no actions → operator_required classification
    directive: continueDirective({ actions: [] }),
    operatorHandled: blockedCommandResult,
    initialSession: "sess-2"
  });

  const outcome = await handleDaemonContinueAnalysis(harness.input, harness.deps);

  assert.equal(outcome.kind, "return");
  if (outcome.kind === "return") {
    assert.equal(outcome.result.status, "blocked");
    assert.equal(outcome.result.reason, "operator required");
  }
  assert.equal(harness.operatorCalls.length, 1);
  assert.equal(harness.operatorCalls[0]!.classification.executionMode, "operator_required");
});

test("handleDaemonContinueAnalysis: unsupported step operator_required + not handled returns continue outcome", async () => {
  // When executeDirectiveStep returns unsupported AND classification is operator_required
  // AND handleOperatorRequiredContinuation returns undefined, the outcome should be "continue".
  const harness = makeHarness({
    executeDirectiveStep: async () =>
      executionResult([
        {
          directiveKind: "continue_analysis",
          outcome: "unsupported",
          evidence: ["continuation is operator-gated"],
          taskId: undefined,
          actor: undefined,
          reviewRole: undefined
        }
      ]),
    directive: continueDirective({ actions: [] }),
    operatorHandled: undefined,
    initialSession: "sess-3"
  });

  const outcome = await handleDaemonContinueAnalysis(harness.input, harness.deps);

  assert.equal(outcome.kind, "continue");
  assert.equal(harness.operatorCalls.length, 1);
  assert.equal(harness.blockedCalls.length, 0);
});

test("handleDaemonContinueAnalysis: no executeDirectiveStep + operator_required (block 2 path) + handled returns return outcome", async () => {
  // When there is no executeDirectiveStep and the directive has no actions
  // (operator_required), the second block is entered. If handleOperatorRequired
  // returns a result, the outcome is "return".
  const blockedResult: DaemonCommandResult = {
    authorityLabel: "derived_only",
    workspaceSlug: "ws",
    projectSlug: "proj",
    status: "blocked",
    reason: "operator required for continuation",
    activeRunId: "run-1",
    activeTaskId: "task-1",
    sessionId: null,
    cycles: []
  };
  const harness = makeHarness({
    executeDirectiveStep: undefined,
    directive: continueDirective({ actions: [] }),
    operatorHandled: blockedResult,
    initialSession: "sess-4"
  });

  const outcome = await handleDaemonContinueAnalysis(harness.input, harness.deps);

  assert.equal(outcome.kind, "return");
  if (outcome.kind === "return") {
    assert.equal(outcome.result.reason, "operator required for continuation");
  }
  assert.equal(harness.operatorCalls.length, 1, "block 2 operator check was reached");
  assert.equal(harness.cycles.length, 0, "no cycle record for this path");
});

test("handleDaemonContinueAnalysis: no executeDirectiveStep + operator_required (block 2 path) + not handled returns continue outcome", async () => {
  // No executeDirectiveStep, operator_required, but handleOperatorRequired returns
  // undefined → outcome is "continue".
  const harness = makeHarness({
    executeDirectiveStep: undefined,
    directive: continueDirective({ actions: [] }),
    operatorHandled: undefined,
    initialSession: "sess-5"
  });

  const outcome = await handleDaemonContinueAnalysis(harness.input, harness.deps);

  assert.equal(outcome.kind, "continue");
  assert.equal(harness.operatorCalls.length, 1);
  assert.equal(harness.blockedCalls.length, 0);
});

test("handleDaemonContinueAnalysis: no executeDirectiveStep + runtime_executable classification returns fallthrough outcome", async () => {
  // When there is no executeDirectiveStep AND the directive's classification is
  // NOT operator_required (e.g. runtime_executable via resolve_blocking_gap with
  // a task: target), the handler should return { kind: "fallthrough" }.
  // We use a resolve_blocking_gap action with a task: targetId to force
  // executionMode === "runtime_executable".
  const harness = makeHarness({
    executeDirectiveStep: undefined,
    directive: continueDirective({
      actions: [
        {
          kind: "resolve_blocking_gap",
          gapId: "gap-1",
          targetId: "task:task-1"
        }
      ]
    }),
    initialSession: "sess-6"
  });

  const outcome = await handleDaemonContinueAnalysis(harness.input, harness.deps);

  assert.equal(outcome.kind, "fallthrough", "runtime_executable classification results in fallthrough");
  assert.equal(harness.operatorCalls.length, 0, "operator handler is not called for runtime_executable");
  assert.equal(harness.cycles.length, 0, "no cycle record for fallthrough path");
  assert.equal(harness.blockedCalls.length, 0);
});

test("handleDaemonContinueAnalysis: executeDirectiveStep present but no continue_analysis step falls through (block 1 → block 2)", async () => {
  // executeDirectiveStep returns steps with NO continue_analysis step, so continueStep
  // is undefined (neither executed nor unsupported). Block 1's executeDirectiveStep
  // branch runs but takes no exit; with no workflowProofTaskId and a runtime_executable
  // directive, the handler must fall through block 1 then block 2 to "fallthrough".
  let executeStepCalled = false;
  const harness = makeHarness({
    executeDirectiveStep: async () => {
      executeStepCalled = true;
      return executionResult([]); // empty steps → continueStep undefined
    },
    directive: continueDirective({
      actions: [{ kind: "resolve_blocking_gap", gapId: "gap-1", targetId: "task:task-1" }]
    }),
    initialSession: "sess-7"
  });

  const outcome = await handleDaemonContinueAnalysis(harness.input, harness.deps);

  assert.equal(executeStepCalled, true, "block 1 executeDirectiveStep branch ran");
  assert.equal(outcome.kind, "fallthrough", "no matching step → falls through block 1 and block 2");
  assert.equal(harness.operatorCalls.length, 0);
  assert.equal(harness.cycles.length, 0);
});

test("handleDaemonContinueAnalysis: unsupported step but NOT operator_required preserves the double snapshot/classify and falls through", async () => {
  // executeDirectiveStep returns unsupported, but classification is runtime_executable
  // (not operator_required). Block 1's unsupported branch calls getStatusSnapshot+classify
  // and does NOT return; it falls through to block 2, which calls getStatusSnapshot+classify
  // AGAIN. The original monolith made this double call — the merge must preserve it.
  const harness = makeHarness({
    executeDirectiveStep: async () =>
      executionResult([
        {
          directiveKind: "continue_analysis",
          outcome: "unsupported",
          evidence: ["continuation is operator-gated"],
          taskId: undefined,
          actor: undefined,
          reviewRole: undefined
        }
      ]),
    directive: continueDirective({
      actions: [{ kind: "resolve_blocking_gap", gapId: "gap-1", targetId: "task:task-1" }]
    }),
    initialSession: "sess-8"
  });
  // Wrap getStatusSnapshot to count calls — locks the block-1+block-2 double-call.
  let snapshotCalls = 0;
  const baseSnapshot = harness.deps.getStatusSnapshot;
  harness.deps.getStatusSnapshot = async (runId) => {
    snapshotCalls += 1;
    return baseSnapshot(runId);
  };

  const outcome = await handleDaemonContinueAnalysis(harness.input, harness.deps);

  assert.equal(outcome.kind, "fallthrough");
  assert.equal(harness.operatorCalls.length, 0, "not operator_required → operator handler not called");
  assert.equal(snapshotCalls, 2, "block 1 unsupported branch and block 2 each snapshot+classify (double-call preserved)");
  assert.equal(harness.cycles.length, 0);
});
