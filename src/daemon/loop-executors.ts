// Daemon split (by concern) — leaf module: loop-review and continuation
// executor factories. These build the executor callbacks consumed by the
// autonomous loop (review-recommendation execution and continuation-action
// execution). MOVE ONLY — no logic changes. They reference only the workflow,
// review, core/service, and domain modules — never daemon.ts internals.
import process from "node:process";

import type { ExecuteDirectiveStepOptions } from "../core/service.ts";
import type {
  ApprovalRecord,
  CheckpointRecord,
  ContinuationAction,
  CoverageGapRecord,
  ProgressProofRecord,
  ReviewRecord,
  RunExecutionPlan,
  RunStatusSnapshot
} from "../domain/types.ts";
import {
  isSelfReferentialResumeTarget,
  validateResumeTargetSource
} from "../workflow.ts";
import type { EnvShape } from "../workflow.ts";
import {
  closeWorkflowProofCoverageGaps,
  createLiveReviewIdentityAdapter,
  executeRecordReviewCommand,
  executeWorkflowProofCommandFromArgs,
  resolveRequiredReviewIdentityFilePath
} from "../review.ts";
import type {
  ExecuteRecordReviewCommandFromArgsOptions,
  ExecuteRecordReviewCommandOptions,
  RecordReviewCommandInput,
  RecordReviewCommandResult
} from "../review.ts";


export function resolveDaemonWorkflowProofTaskId(
  directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>
): string | undefined {
  const workflowProofAction = directive.actions.find(
    (action): action is Extract<ContinuationAction, { kind: "run_workflow_proof" }> =>
      action.kind === "run_workflow_proof"
  );
  return workflowProofAction?.taskId;
}


export async function createLiveLoopReviewCommandExecutor(
  options: {
    cwd?: string | undefined;
    env?: EnvShape | undefined;
    createLiveAdapter?: ExecuteRecordReviewCommandFromArgsOptions["createLiveAdapter"];
    recordReview: ExecuteRecordReviewCommandOptions["recordReview"];
  }
): Promise<(command: RecordReviewCommandInput) => Promise<RecordReviewCommandResult>> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const bindingsPath = await resolveRequiredReviewIdentityFilePath({
    envVarName: "ARCHON_REVIEW_IDENTITY_BINDINGS",
    envVarValue: env.ARCHON_REVIEW_IDENTITY_BINDINGS,
    liveRelativePath: ".archon/review-identity-bindings.json",
    cwd
  });
  const liveAdapter = options.createLiveAdapter
    ? await options.createLiveAdapter()
    : await createLiveReviewIdentityAdapter({ cwd, env });

  if (!liveAdapter.modulePath) {
    throw new Error("loop review execution requires a resolved live adapter module path");
  }
  const adapterModulePath = liveAdapter.modulePath;

  return (command) =>
    executeRecordReviewCommand(command, {
      adapter: liveAdapter.adapter,
      adapterModulePath,
      selectedBackend: liveAdapter.selectedBackend,
      availableBackends: liveAdapter.availableBackends,
      bindingsPath,
      recordReview: options.recordReview
    });
}


export function createQueuedLoopReviewExecutor(
  runId: string,
  reviewCommands: readonly RecordReviewCommandInput[],
  executeReviewCommand: (command: RecordReviewCommandInput) => Promise<RecordReviewCommandResult>
): ExecuteDirectiveStepOptions["executeReviewRecommendation"] {
  const remaining = [...reviewCommands];

  return async ({ directive }) => {
    const matchIndex = remaining.findIndex(
      (command) =>
        command.runId === runId &&
        directive.recommendations.some(
          (recommendation) =>
            recommendation.taskId === command.taskId &&
            recommendation.targetReviewRole === command.review.reviewerRole
        )
    );

    if (matchIndex < 0) {
      const nextRecommendation = directive.recommendations[0];
      return {
        executed: false,
        taskId: nextRecommendation?.taskId,
        reviewRole: nextRecommendation?.targetReviewRole,
        evidence: [
          "no matching trusted review input was supplied for the remaining review directives",
          ...directive.recommendations.map(
            (recommendation) =>
              `${recommendation.taskId}:${recommendation.targetReviewRole ?? "unknown"}`
          )
        ]
      };
    }

    const command = remaining.splice(matchIndex, 1)[0]!;
    const result = await executeReviewCommand(command);
    return {
      executed: true,
      taskId: command?.taskId,
      actor: command?.actor,
      reviewRole: command?.review.reviewerRole,
      evidence: [
        `recorded ${command?.review.reviewerRole} for ${command?.taskId} via ${command?.actor}`,
        `authenticated principal ${result.principal.provider}:${result.principal.subject}`
      ]
    };
  };
}


export function resolveWorkflowProofTaskIdForContinuationAction(
  action: ContinuationAction
): string | undefined {
  if (action.kind === "run_workflow_proof") {
    return action.taskId;
  }

  if (
    (action.kind === "resolve_blocking_gap" || action.kind === "resume_target") &&
    action.targetId.startsWith("task:")
  ) {
    const taskId = action.targetId.slice("task:".length).trim();
    return taskId.length > 0 ? taskId : undefined;
  }

  return undefined;
}


export function createSupportedContinuationExecutor(options: {
  env?: EnvShape | undefined;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getReviews: (runId: string, taskId: string) => Promise<readonly ReviewRecord[]>;
  getApprovals: (runId: string, taskId: string) => Promise<readonly ApprovalRecord[]>;
  upsertCoverageGaps?: ((runId: string, gaps: CoverageGapRecord[]) => Promise<unknown>) | undefined;
  recordProgressProof?: ((runId: string, proof: ProgressProofRecord) => Promise<unknown>) | undefined;
  checkpointRun?: ((
    runId: string,
    checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">,
    options?: {
      authorityLabel?: CheckpointRecord["authorityLabel"] | undefined;
    }
  ) => Promise<unknown>) | undefined;
  now?: (() => Date) | undefined;
}): NonNullable<ExecuteDirectiveStepOptions["executeContinuationAction"]> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  return async ({ runId, directive, action }) => {
    const workflowProofTaskId = resolveWorkflowProofTaskIdForContinuationAction(action);
    if (!workflowProofTaskId) {
      if (
        action.kind === "resume_target" &&
        (action.targetId === "review:authenticated" || isSelfReferentialResumeTarget(action))
      ) {
        const snapshot = await options.getStatusSnapshot(runId);
        const autonomousState = snapshot.autonomousExecution?.state;
        const approvedTasks = snapshot.tasks.filter((task) => task.status === "approved");

        if (!autonomousState) {
          return {
            executed: false,
            taskId: directive.targetId,
            evidence: ["autonomous execution state is unavailable for stale resume-target normalization"]
          };
        }
        const sourceValidation = validateResumeTargetSource(action, autonomousState);
        if (!sourceValidation.valid) {
          return {
            executed: false,
            taskId: directive.targetId,
            evidence: [sourceValidation.reason]
          };
        }
        if (action.targetId === "review:authenticated" && approvedTasks.length !== 1) {
          return {
            executed: false,
            taskId: directive.targetId,
            evidence: [
              `review:authenticated resume normalization requires exactly one approved task, found ${approvedTasks.length}`
            ]
          };
        }

        const createdAt = now().toISOString();
        const approvedTask = approvedTasks[0];
        const taskId = approvedTask?.packet.taskId ?? directive.targetId;
        const evidenceRef = approvedTask
          ? `runtime://task/${approvedTask.packet.taskId}`
          : `runtime://autonomous/${action.source}/${action.targetId.replaceAll(":", "/")}`;

        if (action.source === "progress_proof") {
          if (!options.recordProgressProof) {
            return {
              executed: false,
              taskId,
              evidence: ["no supported continuation executor is available to normalize stale progress proofs"]
            };
          }

          const nextCycle =
            autonomousState.progressProofs.reduce((highest, proof) => Math.max(highest, proof.cycle), 0) + 1;
          const whyNext =
            action.targetId === "review:authenticated"
              ? "stale review:authenticated progress target was already satisfied"
              : `stale self-referential progress target ${action.targetId} was already exhausted`;
          await options.recordProgressProof(runId, {
            cycle: nextCycle,
            proofId: `proof-autoresume-${createdAt}`,
            phaseBefore: autonomousState.phase,
            phaseAfter: autonomousState.phase,
            evidenceRefs: [evidenceRef],
            coverageDelta: {},
            blockingGapDelta: { closed: 1, opened: 0 },
            nextTarget: "   ",
            whyNext,
            createdAt
          });

          return {
            executed: true,
            taskId,
            evidence: [
              action.targetId === "review:authenticated"
                ? `cleared stale progress-proof target review:authenticated for approved task ${approvedTask!.packet.taskId}`
                : `cleared stale self-referential progress-proof target ${action.targetId}`
            ]
          };
        }

        if (action.source === "checkpoint") {
          if (!options.checkpointRun) {
            return {
              executed: false,
              taskId,
              evidence: ["no supported continuation executor is available to normalize stale checkpoints"]
            };
          }

          const latestCheckpoint = [...autonomousState.checkpoints].sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt)
          )[0];
          await options.checkpointRun(
            runId,
            {
              checkpointId: `cp-autoresume-${createdAt}`,
              phase: autonomousState.phase,
              activeTargets: [],
              recentEvidenceRefs: [evidenceRef],
              openGaps: autonomousState.gaps
                .filter((gap) => gap.status === "open")
                .map((gap) => gap.id),
              nextActions: [],
              compressedContextRef: latestCheckpoint?.compressedContextRef,
              createdAt
            },
            {
              authorityLabel: "operator_import"
            }
          );

          return {
            executed: true,
            taskId,
            evidence: [
              action.targetId === "review:authenticated"
                ? `cleared stale checkpoint target review:authenticated for approved task ${approvedTask!.packet.taskId}`
                : `cleared stale self-referential checkpoint target ${action.targetId}`
            ]
          };
        }
      }

      return {
        executed: false,
        taskId: directive.targetId,
        evidence: [
          action.kind === "resume_target"
            ? `no supported continuation executor is available for resume_target target=${action.targetId} source=${action.source}${action.sourceId ? ` sourceId=${action.sourceId}` : ""}`
            : `no supported continuation executor is available for ${action.kind}`
        ]
      };
    }

    try {
      await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", workflowProofTaskId], {
        env,
        getStatusSnapshot: options.getStatusSnapshot,
        getReviews: options.getReviews,
        getApprovals: options.getApprovals
      });
    } catch (error) {
      return {
        executed: false,
        taskId: workflowProofTaskId,
        evidence: [error instanceof Error ? error.message : String(error)]
      };
    }

    const closedGapCount = await closeWorkflowProofCoverageGaps(runId, workflowProofTaskId, {
      getStatusSnapshot: options.getStatusSnapshot,
      upsertCoverageGaps: options.upsertCoverageGaps
    });

    return {
      executed: true,
      taskId: workflowProofTaskId,
      evidence: [
        closedGapCount > 0
          ? `workflow proof passed for ${workflowProofTaskId}; closed ${closedGapCount} autonomous gap(s)`
          : `workflow proof passed for ${workflowProofTaskId}`
      ]
    };
  };
}
