// Daemon split (loop-monolith decomposition, 6j): the continue_analysis directive
// handler, lifted out of executeDaemonCommandFromArgs.
//
// TWO adjacent `if (directive.kind === "continue_analysis")` blocks existed in the
// loop. They are MERGED here into ONE handler. Merge is behavior-preserving because:
//   block 1 exits only via `continue` or `return` when it enters the live-getter /
//   workflow-proof paths; when neither path fires it falls through. Block 2 is
//   guarded by the same `directive.kind === "continue_analysis"` check and is
//   therefore ALWAYS reached only when block 1 fell through. The merged handler
//   reproduces the same if-chain in the same order with identical exit points.
//
// THREE-WAY discriminated union outcome (unlike 6i which was two-way):
//   "return"      — caller must `return outcome.result` (blocked result)
//   "continue"    — caller must `continue` (restart the loop cycle)
//   "fallthrough" — caller does nothing; fall through to the dispatch_owner / codex
//                   turn if-blocks that follow the original second block
//
// latestSessionId is read through `getSessionId` (a live getter, NOT a captured
// value). The handler only READS the session id — it never writes it back.
// This mirrors the pattern established in review-dispatch.ts (6i).
//
// handleOperatorRequiredContinuation is threaded through the deps bag (it is a
// closure that captures per-run state such as cwd, env, now, etc.).
//
// Direct leaf-module imports (NOT through deps bag):
//   classifyContinueAnalysisDirective   — pure classifier, no side effects
//   resolveDaemonWorkflowProofTaskId    — pure resolver, no side effects
//   executeWorkflowProofCommandFromArgs — direct CLI call; un-stubbable in tests
//   closeWorkflowProofCoverageGaps      — direct DB call; un-stubbable in tests
//
// The workflow-proof path (resolveDaemonWorkflowProofTaskId returns a truthy value)
// cannot be cleanly exercised in unit tests because executeWorkflowProofCommandFromArgs
// and closeWorkflowProofCoverageGaps are imported directly. Tests cover all other
// paths by arranging directives without a run_workflow_proof action so the function
// returns undefined. See tests/daemon-continue-analysis.test.ts.
import type { ApprovalRecord, CoverageGapRecord, ReviewRecord, RunExecutionPlan, RunStatusSnapshot } from "../domain/types.ts";
import {
  classifyContinueAnalysisDirective,
  type ContinueAnalysisDirectiveClassification
} from "../admin/autonomous-summary.ts";
import {
  closeWorkflowProofCoverageGaps,
  executeWorkflowProofCommandFromArgs
} from "../review.ts";
import { resolveDaemonWorkflowProofTaskId } from "./loop-executors.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type { DaemonCommandResult, DaemonCycleRecord } from "../daemon.ts";
import type { DaemonBlockedResultBuilder } from "./codex-turn.ts";
import type {
  DirectiveExecutionResult,
  ExecuteDirectiveStepOptions
} from "../core/service.ts";
import type { RecordReviewCommandInput } from "../review.ts";
import type { EnvShape } from "../workflow.ts";

/** Callback type alias matching the optional executeDirectiveStep surface. */
export type ExecuteDirectiveStepFn = (
  runId: string,
  input: Omit<ExecuteDirectiveStepOptions, "executeReviewRecommendation"> & {
    reviewCommands: readonly RecordReviewCommandInput[];
  }
) => Promise<DirectiveExecutionResult>;

/** Three-way discriminated union outcome returned to the daemon loop. */
export type DaemonContinueAnalysisOutcome =
  | { kind: "return"; result: DaemonCommandResult }
  | { kind: "continue" }
  | { kind: "fallthrough" };

/** Per-cycle inputs the handler receives from the loop. */
export interface DaemonContinueAnalysisInput {
  directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
  cycle: number;
  activeRunId: string;
  activeTaskId: string;
}

/** Stable (per-invocation) dependencies the handler needs from the loop. */
export interface DaemonContinueAnalysisDeps {
  /** Optional — when absent the handler skips the executeDirectiveStep branch. */
  executeDirectiveStep: ExecuteDirectiveStepFn | undefined;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getReviews: (runId: string, taskId: string) => Promise<readonly ReviewRecord[]>;
  getApprovals: (runId: string, taskId: string) => Promise<readonly ApprovalRecord[]>;
  upsertCoverageGaps: ((runId: string, gaps: CoverageGapRecord[]) => Promise<unknown>) | undefined;
  staleAfterHours: number;
  env: EnvShape;
  /** The loop's cycle accumulator; mutated by push (ref-safe). */
  cycles: DaemonCycleRecord[];
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
  blockedResult: DaemonBlockedResultBuilder;
  /**
   * The operator-continuation wrapper closure supplied by the loop.
   * It captures per-run state (cwd, env, now, workspaceSlug, projectSlug, etc.)
   * so that the handler does not need to know about those.
   */
  handleOperatorRequiredContinuation: (input: {
    directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
    classification: ContinueAnalysisDirectiveClassification;
  }) => Promise<DaemonCommandResult | undefined>;
}

/**
 * Handles a continue_analysis directive: attempts an executeDirectiveStep
 * continuation (if available), falls back to operator-required classification,
 * runs workflow proof when the directive carries a run_workflow_proof action,
 * and then applies a final operator-required check. Returns a three-way outcome
 * indicating whether the loop should return, continue, or fall through to the
 * dispatch_owner / codex-turn if-blocks.
 */
export async function handleDaemonContinueAnalysis(
  input: DaemonContinueAnalysisInput,
  deps: DaemonContinueAnalysisDeps
): Promise<DaemonContinueAnalysisOutcome> {
  const { directive, cycle, activeRunId, activeTaskId } = input;
  const { cycles } = deps;

  // ---- Block 1: executeDirectiveStep / workflow-proof branch ------------------

  if (deps.executeDirectiveStep) {
    const executionResult = await deps.executeDirectiveStep(activeRunId, {
      staleAfterHours: deps.staleAfterHours,
      reviewCommands: []
    });
    const continueStep = executionResult.steps.find(
      (step) => step.directiveKind === "continue_analysis"
    );

    if (continueStep?.outcome === "executed") {
      cycles.push({
        cycle,
        directiveKind: directive.kind,
        action: "apply_runtime_continuation",
        runId: activeRunId,
        taskId: continueStep.taskId ?? activeTaskId,
        sessionId: deps.getSessionId() ?? null,
        summary: continueStep.evidence.join(" | ") || "runtime continuation executed"
      });
      return { kind: "continue" };
    }

    if (continueStep?.outcome === "unsupported") {
      const snapshot = await deps.getStatusSnapshot(activeRunId);
      const classification = classifyContinueAnalysisDirective({
        directive,
        state: snapshot.autonomousExecution?.state
      });
      if (classification.executionMode === "operator_required") {
        const handled = await deps.handleOperatorRequiredContinuation({
          directive,
          classification
        });
        if (handled) {
          return { kind: "return", result: handled };
        }
        return { kind: "continue" };
      }
    }
  }

  const workflowProofTaskId = resolveDaemonWorkflowProofTaskId(directive);
  if (workflowProofTaskId) {
    try {
      await executeWorkflowProofCommandFromArgs(
        ["--run-id", activeRunId, "--task-id", workflowProofTaskId],
        {
          env: deps.env,
          getStatusSnapshot: deps.getStatusSnapshot,
          getReviews: deps.getReviews,
          getApprovals: deps.getApprovals
        }
      );

      const closedGapCount = await closeWorkflowProofCoverageGaps(
        activeRunId,
        workflowProofTaskId,
        {
          getStatusSnapshot: deps.getStatusSnapshot,
          upsertCoverageGaps: deps.upsertCoverageGaps
        }
      );

      cycles.push({
        cycle,
        directiveKind: directive.kind,
        action: "run_workflow_proof",
        runId: activeRunId,
        taskId: workflowProofTaskId,
        sessionId: deps.getSessionId() ?? null,
        summary:
          closedGapCount > 0
            ? `workflow proof passed for ${workflowProofTaskId}; closed ${closedGapCount} autonomous gap(s)`
            : `workflow proof passed for ${workflowProofTaskId}`
      });
      return { kind: "continue" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cycles.push({
        cycle,
        directiveKind: directive.kind,
        action: "blocked",
        runId: activeRunId,
        taskId: workflowProofTaskId,
        sessionId: deps.getSessionId() ?? null,
        summary: message
      });

      return {
        kind: "return",
        result: await deps.blockedResult({
          blockerKind: "workflow_proof_failure",
          reason: message,
          cycle,
          activeRunId,
          activeTaskId,
          directiveKind: directive.kind,
          nextActions: []
        })
      };
    }
  }

  // ---- Block 2: final operator-required check (replaces the second if-block) --

  const snapshot = await deps.getStatusSnapshot(activeRunId);
  const classification = classifyContinueAnalysisDirective({
    directive,
    state: snapshot.autonomousExecution?.state
  });
  if (classification.executionMode === "operator_required") {
    const handled = await deps.handleOperatorRequiredContinuation({
      directive,
      classification
    });
    if (handled) {
      return { kind: "return", result: handled };
    }
    return { kind: "continue" };
  }

  return { kind: "fallthrough" };
}
