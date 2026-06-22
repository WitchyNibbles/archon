// Daemon loop, supervisor, CLI session handling, autonomous continuation.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";








import { withClient } from "./admin/db.ts";
import {
  classifyContinueAnalysisDirective,
  resolveContinuationCapabilities,
  selectLocalContinuationProvider,
  type ContinueAnalysisDirectiveClassification
} from "./admin/autonomous-summary.ts";










import {
  ArchonCoreService,
  type DirectiveExecutionResult,
  type ExecuteDirectiveStepOptions
} from "./core/service.ts";
import type {
  ApprovalRecord,
  CheckpointRecord,
  ContinuationAction,
  CoverageGapRecord,
  ProjectRuntimeStateRecord,
  ProgressProofRecord,
  RecoveryApplyResult,
  ReviewRecord,
  RunExecutionPlan,
  RunStatusSnapshot
} from "./domain/types.ts";
import { PostgresStore, PostgresMistakeLedgerStore } from "./store/postgres-store.ts";
import { INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN, MAX_DAEMON_STAGNANT_TURNS, buildDefaultProductState, buildDefaultTaskQueue, executeAdvanceActiveTaskCommandFromArgs, isSelfReferentialResumeTarget, resolveCommandFlag, resolveFormatFlag, resolveRunIdForCommand, validateResumeTargetSource } from "./workflow.ts";
import type { EnvShape, ExecuteAdvanceActiveTaskCommandOptions, ExecuteStatusCommandOptions } from "./workflow.ts";
import { buildRuntimeExecutionConnectionFailure, executeReconcileRuntimeStateCommandFromArgs, executeRuntimeExecutionPreflight, formatRuntimeExecutionPreflightFailureResult, isRuntimeExecutionPreflightConnectionError } from "./runtime.ts";
import type { ExecuteDoctorCommandOptions, ExecuteRuntimePreflightCommandOptions, ReconcileRuntimeStateCommandResult } from "./runtime.ts";
import { closeWorkflowProofCoverageGaps, createLiveReviewIdentityAdapter, executeRecordReviewCommand, executeWorkflowProofCommandFromArgs, resolveRequiredReviewIdentityFilePath } from "./review.ts";
import type { ExecuteRecordReviewCommandFromArgsOptions, ExecuteRecordReviewCommandOptions, RecordReviewCommandInput, RecordReviewCommandResult } from "./review.ts";
import { AgentRuntimeStore } from "./store/agent-runtime-store.ts";
import { AgenticLoopController } from "./runtime/agentic-loop.ts";
import { ContinuationContextBuilder } from "./runtime/continuation-context.ts";
import { recoverOrphanedInvocations } from "./runtime/crash-recovery.ts";
import { resolveArchonContextPolicy } from "./runtime/context-budget.ts";
// Daemon split (by concern) — leaf module. Import for daemon-internal use, then
// re-export the same bindings to preserve the public surface for existing callers.
import {
  buildAppAutomationPrompt,
  convertSupportedCronScheduleToRrule,
  convertSupportedCronScheduleToSystemdOnCalendar,
  detectGitAutomationExecutionEnvironment
} from "./daemon/automation-schedule.ts";
export {
  buildAppAutomationPrompt,
  convertSupportedCronScheduleToRrule,
  convertSupportedCronScheduleToSystemdOnCalendar,
  detectGitAutomationExecutionEnvironment
};
import {
  readDaemonContinuationStatus,
  readDaemonOperatorHandoff,
  readDaemonSupervisorHistory,
  readDaemonSupervisorStatus
} from "./daemon/state-readers.ts";
export {
  readDaemonContinuationStatus,
  readDaemonOperatorHandoff,
  readDaemonSupervisorHistory,
  readDaemonSupervisorStatus
};
import {
  appendDaemonSupervisorHistory,
  clearDaemonAppAutomationRequest,
  clearDaemonAutomationEnvelope,
  clearDaemonCliSchedulerRequest,
  clearDaemonContinuationContext,
  clearDaemonContinuationStatus,
  clearDaemonOperatorHandoff,
  clearDaemonScopeExpansionRequest,
  readDaemonAutomationEnvelope,
  readDaemonContinuationContext,
  writeDaemonAppAutomationRequest,
  writeDaemonAutomationEnvelope,
  writeDaemonCliSchedulerRequest,
  writeDaemonContinuationContext,
  writeDaemonContinuationStatus,
  writeDaemonOperatorHandoff,
  writeDaemonReviewQueueStatus,
  writeDaemonScopeExpansionRequest,
  writeDaemonSupervisorStatus
} from "./daemon/state-writers.ts";
export {
  appendDaemonSupervisorHistory,
  clearDaemonAppAutomationRequest,
  clearDaemonAutomationEnvelope,
  clearDaemonCliSchedulerRequest,
  clearDaemonContinuationContext,
  clearDaemonContinuationStatus,
  clearDaemonOperatorHandoff,
  clearDaemonScopeExpansionRequest,
  readDaemonAutomationEnvelope,
  readDaemonContinuationContext,
  writeDaemonAppAutomationRequest,
  writeDaemonAutomationEnvelope,
  writeDaemonCliSchedulerRequest,
  writeDaemonContinuationContext,
  writeDaemonContinuationStatus,
  writeDaemonOperatorHandoff,
  writeDaemonReviewQueueStatus,
  writeDaemonScopeExpansionRequest,
  writeDaemonSupervisorStatus
};
import type {
  DaemonSupervisorHistoryReadOptions,
  DaemonSupervisorHistoryReadResult
} from "./daemon/state-writers.ts";
export type {
  DaemonSupervisorHistoryReadOptions,
  DaemonSupervisorHistoryReadResult
};
import {
  archiveConsumedDaemonOperatorActionQueueEntries,
  archiveConsumedDaemonReviewQueueEntries,
  archiveFailedDaemonOperatorActionQueueEntries,
  archiveFailedDaemonReviewQueueEntries,
  archiveStaleDaemonReviewQueueEntries,
  matchesDaemonOperatorContinuationAction,
  normalizeOperatorContinuationActionCommand,
  readDaemonOperatorActionQueueState,
  readDaemonReviewQueueState,
  readLoopReviewCommandInputs,
  resolveDaemonOperatorActionDir,
  resolveDaemonReviewInputDir
} from "./daemon/review-queue.ts";
export {
  archiveConsumedDaemonOperatorActionQueueEntries,
  archiveConsumedDaemonReviewQueueEntries,
  archiveFailedDaemonOperatorActionQueueEntries,
  archiveFailedDaemonReviewQueueEntries,
  archiveStaleDaemonReviewQueueEntries,
  matchesDaemonOperatorContinuationAction,
  normalizeOperatorContinuationActionCommand,
  readDaemonOperatorActionQueueState,
  readDaemonReviewQueueState,
  readLoopReviewCommandInputs,
  resolveDaemonOperatorActionDir,
  resolveDaemonReviewInputDir
};
import type {
  DaemonOperatorActionQueueEntry,
  DaemonReviewQueueEntry,
  FailedDaemonOperatorActionQueueEntry,
  FailedDaemonReviewQueueEntry,
  OperatorContinuationActionCommand,
  StaleDaemonReviewQueueEntry
} from "./daemon/review-queue.ts";
export type {
  DaemonOperatorActionQueueEntry,
  DaemonReviewQueueEntry,
  FailedDaemonOperatorActionQueueEntry,
  FailedDaemonReviewQueueEntry,
  OperatorContinuationActionCommand,
  StaleDaemonReviewQueueEntry
};


import {
  buildSupervisorOperatorNotes,
  executeSupervisorCommandFromArgs,
  executeSupervisorHistoryCommandFromArgs,
  formatSupervisorCommandResult,
  formatSupervisorHistoryCommandResult,
  parseSupervisorReviewActorBindings,
  readDaemonReviewQueueStatus,
  resolveDaemonSupervisorHistoryReadOptions,
  resolveSupervisorHistoryRetentionLimit,
  resolveSupervisorReviewAuthContext,
  writeSupervisorOperatorContinuationAction,
  writeSupervisorReviewAction
} from "./daemon/supervisor.ts";
export {
  buildSupervisorOperatorNotes,
  executeSupervisorCommandFromArgs,
  executeSupervisorHistoryCommandFromArgs,
  formatSupervisorCommandResult,
  formatSupervisorHistoryCommandResult,
  parseSupervisorReviewActorBindings,
  readDaemonReviewQueueStatus,
  resolveDaemonSupervisorHistoryReadOptions,
  resolveSupervisorHistoryRetentionLimit,
  resolveSupervisorReviewAuthContext,
  writeSupervisorOperatorContinuationAction,
  writeSupervisorReviewAction
};
import type {
  DaemonReviewQueueStatusObservation,
  ExecuteSupervisorCommandOptions,
  ExecuteSupervisorHistoryCommandOptions,
  SupervisorActionRecord,
  SupervisorCommandResult,
  SupervisorHistoryCommandResult
} from "./daemon/supervisor.ts";
export type {
  DaemonReviewQueueStatusObservation,
  ExecuteSupervisorCommandOptions,
  ExecuteSupervisorHistoryCommandOptions,
  SupervisorActionRecord,
  SupervisorCommandResult,
  SupervisorHistoryCommandResult
};
import {
  buildDaemonProgressKey,
  buildDaemonTaskPacketFingerprint,
  buildDaemonTaskPrompt,
  daemonMessageHasScopeConflict,
  determineDaemonPromptMode,
  formatContinuationAction,
  parseClaudeStreamJsonOutput,
  parseDaemonTurnMessage,
  persistDaemonTurnCheckpoint,
  readDaemonPromptMetadata,
  readDaemonSessionId,
  readDaemonStagnationMetadata,
  runCodexTurnViaCli
} from "./daemon/turn-prompt.ts";
export {
  buildDaemonProgressKey,
  buildDaemonTaskPacketFingerprint,
  buildDaemonTaskPrompt,
  daemonMessageHasScopeConflict,
  determineDaemonPromptMode,
  formatContinuationAction,
  parseClaudeStreamJsonOutput,
  parseDaemonTurnMessage,
  persistDaemonTurnCheckpoint,
  readDaemonPromptMetadata,
  readDaemonSessionId,
  readDaemonStagnationMetadata,
  runCodexTurnViaCli
};
import type {
  DaemonPromptContinuationAction,
  DaemonPromptDirective,
  DaemonPromptMetadata,
  DaemonPromptMode,
  DaemonStagnationMetadata,
  ParsedDaemonTurnMessage,
  RunCodexTurnInput,
  RunCodexTurnResult
} from "./daemon/turn-prompt.ts";
export type {
  DaemonPromptContinuationAction,
  DaemonPromptDirective,
  DaemonPromptMetadata,
  DaemonPromptMode,
  DaemonStagnationMetadata,
  ParsedDaemonTurnMessage,
  RunCodexTurnInput,
  RunCodexTurnResult
};


export function getRecentCommits(cwd: string, limit = 20): Array<{ hash: string; message: string }> {
  const result = spawnSync("git", ["log", "--oneline", `-${limit}`], {
    cwd,
    encoding: "utf8",
    timeout: 5000
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const spaceIdx = line.indexOf(" ");
    return {
      hash: spaceIdx > 0 ? line.slice(0, spaceIdx) : line,
      message: spaceIdx > 0 ? line.slice(spaceIdx + 1) : ""
    };
  });
}


export interface ExecuteLoopCommandOptions extends ExecuteStatusCommandOptions {
  getExecutionPlan: (runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>;
  applyRecovery: (runId: string, actionIds: readonly string[], staleAfterHours: number) => Promise<RecoveryApplyResult>;
  findProjectContext?: ExecuteDoctorCommandOptions["findProjectContext"];
  getProjectRuntimeRegistration?: ExecuteDoctorCommandOptions["getProjectRuntimeRegistration"];
  pathExists?: ExecuteDoctorCommandOptions["pathExists"];
  skipRuntimePreflight?: boolean | undefined;
  runtimePreflightBypassToken?: symbol | undefined;
  executeDirectiveStep?: ((
    runId: string,
    input: Omit<ExecuteDirectiveStepOptions, "executeReviewRecommendation"> & {
      reviewCommands: readonly RecordReviewCommandInput[];
    }
  ) => Promise<DirectiveExecutionResult>) | undefined;
}


export interface DaemonCycleRecord {
  cycle: number;
  directiveKind: RunExecutionPlan["directive"]["kind"];
  action:
    | "run_codex_owner"
    | "run_codex_analysis"
    | "run_workflow_proof"
    | "apply_runtime_continuation"
    | "record_review"
    | "reconcile_runtime_state"
    | "request_scope_expansion"
    | "advance_active_task"
    | "blocked"
    | "complete";
  runId: string;
  taskId: string | null;
  summary: string;
  sessionId?: string | null | undefined;
}


export interface DaemonCommandResult {
  authorityLabel: "derived_only";
  workspaceSlug: string;
  projectSlug: string;
  status: "completed" | "blocked" | "max_cycles_reached";
  reason: string;
  activeRunId: string | null;
  activeTaskId: string | null;
  sessionId: string | null;
  cycles: DaemonCycleRecord[];
}


export interface ExecuteDaemonCommandOptions extends ExecuteAdvanceActiveTaskCommandOptions, ExecuteLoopCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  runCodexTurn?: ((input: RunCodexTurnInput) => Promise<RunCodexTurnResult>) | undefined;
  upsertCoverageGaps?: ((runId: string, gaps: CoverageGapRecord[]) => Promise<unknown>) | undefined;
  checkpointRun?: ((
    runId: string,
    checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">,
    options?: {
      authorityLabel?: CheckpointRecord["authorityLabel"] | undefined;
    }
  ) => Promise<unknown>) | undefined;
  now?: (() => Date) | undefined;
}


export async function withDaemonLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  const lockPath = path.join(daemonDir, "daemon.lock");
  await mkdir(daemonDir, { recursive: true });

  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`archon daemon lock already exists: ${path.relative(cwd, lockPath)}`);
    }
    throw error;
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}


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


export async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}


export async function runSpawnedCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: EnvShape;
  }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit"
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}


export interface LoopCommandResult {
  mode: "advisory_only" | "applied" | "executed";
  runId: string;
  initialPlan: RunExecutionPlan;
  appliedRecoveryActionIds: string[];
  executedSteps: DirectiveExecutionResult["steps"];
  finalPlan: RunExecutionPlan;
  snapshot: RunStatusSnapshot;
}


export function formatLoopCommandResult(result: LoopCommandResult): string {
  const lines = [
    `Run ${result.runId}`,
    `mode: ${result.mode}`,
    `initial-directive: ${result.initialPlan.directive.kind}`,
    `applied-safe-recovery: ${
      result.appliedRecoveryActionIds.length > 0 ? result.appliedRecoveryActionIds.join(", ") : "none"
    }`
  ];

  if (result.executedSteps.length > 0) {
    for (const step of result.executedSteps) {
      const targetParts = [step.taskId, step.reviewRole, step.actor].filter(Boolean);
      lines.push(
        `executed: ${step.directiveKind} ${step.outcome}${
          targetParts.length > 0 ? ` (${targetParts.join(", ")})` : ""
        }`
      );
    }
  } else {
    lines.push("executed: none");
  }

  lines.push(
    `final-directive: ${result.finalPlan.directive.kind}`
  );

  if (result.finalPlan.directive.kind === "dispatch_owner") {
    lines.push(
      `next: route ${result.finalPlan.directive.recommendation.taskId} to ${result.finalPlan.directive.recommendation.targetRole}`
    );
  } else if (result.finalPlan.directive.kind === "dispatch_reviews") {
    for (const recommendation of result.finalPlan.directive.recommendations) {
      if (recommendation.targetReviewRole) {
        lines.push(`next: request ${recommendation.targetReviewRole} for ${recommendation.taskId}`);
      }
    }
  } else if (result.finalPlan.directive.kind === "apply_recovery") {
    for (const action of result.finalPlan.directive.actions) {
      lines.push(`next: recover ${action.id}`);
    }
  } else if (result.finalPlan.directive.kind === "dispatch_subagents") {
    for (const investigation of result.finalPlan.directive.pendingInvestigations) {
      lines.push(`next: dispatch subagent ${investigation}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "rebuild_inventory") {
    if (result.finalPlan.directive.missingUnderstandingKinds.length > 0) {
      lines.push(`next: rebuild ${result.finalPlan.directive.missingUnderstandingKinds.join(", ")}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "trace_runtime") {
    if (result.finalPlan.directive.targetIds.length > 0) {
      lines.push(`next: trace ${result.finalPlan.directive.targetIds.join(", ")}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "checkpoint") {
    if (result.finalPlan.directive.checkpointId) {
      lines.push(`next: checkpoint ${result.finalPlan.directive.checkpointId}`);
    }
    if (result.finalPlan.directive.progressProofId) {
      lines.push(`next: proof ${result.finalPlan.directive.progressProofId}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "replan_migration") {
    lines.push(`next: replan ${result.finalPlan.directive.phase}`);
    if (result.finalPlan.directive.fallbackPhase) {
      lines.push(`next: fallback ${result.finalPlan.directive.fallbackPhase}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "continue_analysis") {
    lines.push(`next: continue ${result.finalPlan.directive.targetId}`);
    if (result.finalPlan.directive.actions.length > 0) {
      lines.push(`typed-actions: ${result.finalPlan.directive.actions.map(formatContinuationAction).join("; ")}`);
    }
    if (result.finalPlan.directive.nextActions.length > 0) {
      lines.push(`guidance: ${result.finalPlan.directive.nextActions.join("; ")}`);
    }
  } else if (result.finalPlan.directive.kind === "blocked") {
    for (const blocker of result.finalPlan.directive.blockers) {
      lines.push(`blocked: ${blocker}`);
    }
  } else {
    lines.push("next: none");
  }

  return `${lines.join("\n")}\n`;
}


export async function executeLoopCommandFromArgs(
  args: readonly string[],
  options: ExecuteLoopCommandOptions
): Promise<{ format: "json" | "text"; result: LoopCommandResult }> {
  const requiresRuntimeMutationPreflight =
    args.includes("--apply-safe-recovery") || args.includes("--execute-supported-directives");
  const runtimePreflightFailure = await executeRuntimeExecutionPreflight(
    args,
    {
      ...(options as ExecuteRuntimePreflightCommandOptions),
      requireRuntimePreflight: requiresRuntimeMutationPreflight
    }
  );
  if (runtimePreflightFailure) {
    throw new Error(runtimePreflightFailure.reason);
  }

  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);
  if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }

  const format = resolveFormatFlag(args);
  const applySafeRecovery = args.includes("--apply-safe-recovery");
  const executeSupportedDirectives = args.includes("--execute-supported-directives");
  const ownerActor = resolveCommandFlag(args, "--owner-actor")?.trim() || undefined;
  const reviewCommands = await readLoopReviewCommandInputs(args, { cwd: options.cwd });
  const initialPlan = await options.getExecutionPlan(runId, staleAfterHours);
  let appliedRecoveryActionIds: string[] = [];
  let executedSteps: DirectiveExecutionResult["steps"] = [];
  let snapshot: RunStatusSnapshot;
  let finalPlan = initialPlan;

  if (applySafeRecovery && initialPlan.directive.kind === "apply_recovery") {
    const recoveryResult = await options.applyRecovery(
      runId,
      initialPlan.directive.actions.map((action) => action.id),
      staleAfterHours
    );
    appliedRecoveryActionIds = [...recoveryResult.appliedActionIds];
    snapshot = recoveryResult.snapshot;
    finalPlan = await options.getExecutionPlan(runId, staleAfterHours);
  } else {
    snapshot = await options.getStatusSnapshot(runId);
  }

  if (executeSupportedDirectives) {
    if (!options.executeDirectiveStep) {
      throw new Error("loop directive execution is not available for this runtime surface");
    }
    const executionResult = await options.executeDirectiveStep(runId, {
      staleAfterHours,
      ownerActor,
      reviewCommands
    });
    executedSteps = executionResult.steps;
    finalPlan = executionResult.finalPlan;
    snapshot = executionResult.snapshot;
  }

  return {
    format,
    result: {
      mode:
        executedSteps.length > 0
          ? "executed"
          : appliedRecoveryActionIds.length > 0
            ? "applied"
            : "advisory_only",
      runId,
      initialPlan,
      appliedRecoveryActionIds,
      executedSteps,
      finalPlan,
      snapshot
    }
  };
}


export async function loopCommand(args: readonly string[]) {
  try {
    await withClient(async (client) => {
      const store = new PostgresStore(client);
      const agentStore = new AgentRuntimeStore(client);
      const service = new ArchonCoreService(store);
      const continuationBuilder = new ContinuationContextBuilder(agentStore);

      // P3 anti-pattern injector — fail-safe: construction is best-effort.
      // If PostgresMistakeLedgerStore cannot be constructed (store unavailable),
      // mistakeLedgerInjector remains undefined and buildBundle proceeds without injection.
      let mistakeLedgerInjector: PostgresMistakeLedgerStore | undefined;
      try {
        mistakeLedgerInjector = new PostgresMistakeLedgerStore(client);
      } catch (_injectorConstructionError) {
        // Best-effort: injector construction failed, bundle will build without injection.
      }

      async function buildContinuationBundle(runId: string, taskId: string, role: string): Promise<string> {
        const bundle = await continuationBuilder.buildBundle({ runId, taskId, role }, mistakeLedgerInjector);
        // Persist the bundle so the next invocation's resume prompt can consume
        // it. Without this the prompt would be discarded and the continuation
        // would lose its runtime-authoritative context (AC5/FR-11).
        await writeDaemonContinuationContext(process.cwd(), bundle.continuationPrompt);
        return bundle.continuationPrompt;
      }

      const { format, result } = await executeLoopCommandFromArgs(args, {
        cwd: process.cwd(),
        env: process.env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        findProjectContext(workspaceSlug, projectSlug) {
          return store.getProjectContext({ workspaceSlug, projectSlug });
        },
        getProjectRuntimeRegistration(projectId) {
          return store.getProjectRuntimeRegistration(projectId);
        },
        getStatusSnapshot(runId) {
          return service.getStatus(runId);
        },
        getExecutionPlan(runId, staleAfterHours) {
          return service.getExecutionPlan(runId, { staleAfterHours });
        },
        applyRecovery(runId, actionIds, staleAfterHours) {
          return service.applyRecovery(runId, actionIds, { staleAfterHours });
        },
        async executeDirectiveStep(runId, input) {
          // Crash recovery: before doing anything, synthesize crash_recovery
          // handoffs for invocations that crossed the threshold but never handed
          // off (TDD §20). Best-effort — never block the loop on recovery.
          try {
            await recoverOrphanedInvocations(agentStore, runId, {
              handoffPct: resolveArchonContextPolicy().handoffPct
            });
          } catch (recoveryError) {
            process.stderr.write(
              `[archon-loop] crash recovery skipped: ${String(recoveryError)}\n`
            );
          }

          // Agentic loop wiring: on dispatch_owner, record an invocation and build
          // a continuation bundle before the service claims the task.
          const loopController = new AgenticLoopController(agentStore, { runId });
          const currentPlan = await service.getExecutionPlan(runId, {
            staleAfterHours: input.staleAfterHours
          });
          if (currentPlan.directive.kind === "dispatch_owner") {
            const rec = currentPlan.directive.recommendation;
            const role = rec.targetRole ?? input.ownerActor ?? "specialist_owner";
            await loopController.startInvocation(rec.taskId, role);
            await buildContinuationBundle(runId, rec.taskId, role);
          }

          const executeReviewRecommendation =
            input.reviewCommands.length > 0
              ? createQueuedLoopReviewExecutor(
                  runId,
                  input.reviewCommands,
                  await createLiveLoopReviewCommandExecutor({
                    cwd: process.cwd(),
                    env: process.env,
                    recordReview({ command, resolver }) {
                      const reviewService = new ArchonCoreService(store, {
                        resolveReviewActionContext: resolver
                      });
                      return reviewService.recordReview(
                        command.runId,
                        command.taskId,
                        command.actor,
                        command.review
                      );
                    }
                  })
                )
              : undefined;
          const executeContinuationAction = createSupportedContinuationExecutor({
            env: process.env,
            getStatusSnapshot(runId) {
              return service.getStatus(runId);
            },
            getReviews(runId, taskId) {
              return store.getReviews(runId, taskId);
            },
            getApprovals(runId, taskId) {
              return store.getApprovals(runId, taskId);
            },
            upsertCoverageGaps(runId, gaps) {
              return service.upsertCoverageGaps(runId, gaps);
            },
            recordProgressProof(runId, proof) {
              return service.recordProgressProof(runId, proof);
            },
            checkpointRun(runId, checkpoint, checkpointOptions) {
              return service.checkpointRun(runId, checkpoint, checkpointOptions);
            }
          });

          return service.executeDirectiveStep(runId, {
            staleAfterHours: input.staleAfterHours,
            ownerActor: input.ownerActor,
            ...(executeReviewRecommendation ? { executeReviewRecommendation } : {}),
            executeContinuationAction
          });
        }
      });

      if (format === "text") {
        process.stdout.write(formatLoopCommandResult(result));
        return;
      }

      console.log(JSON.stringify(result));
    });
  } catch (error) {
    if (isRuntimeExecutionPreflightConnectionError(error)) {
      throw new Error(buildRuntimeExecutionConnectionFailure(error).reason);
    }
    throw error;
  }
}


export function formatDaemonCommandResult(result: DaemonCommandResult): string {
  const lines = [
    `status: ${result.status}`,
    `reason: ${result.reason}`,
    `workspace: ${result.workspaceSlug}`,
    `project: ${result.projectSlug}`,
    `active-run: ${result.activeRunId ?? "none"}`,
    `active-task: ${result.activeTaskId ?? "none"}`,
    `session-id: ${result.sessionId ?? "none"}`
  ];

  if (result.cycles.length > 0) {
    lines.push("cycles:");
    for (const cycle of result.cycles) {
      lines.push(
        `- cycle=${cycle.cycle} directive=${cycle.directiveKind} action=${cycle.action} task=${cycle.taskId ?? "none"} run=${cycle.runId} ${cycle.summary}`
      );
    }
  }

  return lines.join("\n");
}


// Map an advance-active-task failure to an operator-actionable blocker. The commit
// guard (advanceCommitGuard) throws with a recognizable signature when in-scope
// deliverables are uncommitted; that case gets a dedicated, recoverable blocker
// with commit guidance. Any other advance failure surfaces as runtime_blocked so a
// throw never escapes the daemon loop as an unhandled exception. Pure and
// unit-testable.
export function classifyAdvanceFailure(error: unknown): {
  blockerKind: "uncommitted_deliverables" | "runtime_blocked";
  reason: string;
  nextActions: string[];
} {
  const message = error instanceof Error ? error.message : String(error);
  // Match the commit guard's specific phrasing (src/workflow.ts evaluateCommitGuard).
  // The second arm is anchored to "inside its write scope" so a generic future error
  // that merely mentions "uncommitted change(s)" is not misclassified as a guard hit.
  if (/refusing to close task|uncommitted change\(s\) inside its write scope/i.test(message)) {
    return {
      blockerKind: "uncommitted_deliverables",
      reason: message,
      nextActions: [
        "Commit the active task's uncommitted in-scope deliverables, then re-run the daemon.",
        "Or run advance-active-task --apply --allow-uncommitted if leaving them uncommitted is intentional."
      ]
    };
  }
  return {
    blockerKind: "runtime_blocked",
    reason: `advance-active-task failed: ${message}`,
    nextActions: [
      "Resolve the advance-active-task failure (see reason), then re-run the daemon."
    ]
  };
}

export async function executeDaemonCommandFromArgs(
  args: readonly string[],
  options: ExecuteDaemonCommandOptions
): Promise<{ format: "json" | "text"; result: DaemonCommandResult }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const format = resolveFormatFlag(args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;
  const maxCyclesValue = resolveCommandFlag(args, "--max-cycles") ?? "8";
  const maxCycles = Number.parseInt(maxCyclesValue, 10);
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);
  const claudeBin = resolveCommandFlag(args, "--claude-bin") ?? env.ARCHON_CLAUDE_BIN ?? "claude";
  const reviewInputDir = resolveDaemonReviewInputDir(args, { cwd, env });
  const operatorActionDir = resolveDaemonOperatorActionDir(args, { cwd, env });

  if (!workspaceSlug || !projectSlug) {
    throw new Error("daemon requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }
  if (!Number.isInteger(maxCycles) || maxCycles <= 0) {
    throw new Error(`Invalid --max-cycles value: ${maxCyclesValue}`);
  }
  if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }

  const runCodexTurn = options.runCodexTurn ?? runCodexTurnViaCli;
  const now = options.now ?? (() => new Date());

  const result = await withDaemonLock(cwd, async () => {
    const cycles: DaemonCycleRecord[] = [];
    let latestSessionId: string | undefined;
    const blockedResult = async (input: {
      blockerKind:
        | "bootstrapping"
        | "runtime_preflight"
        | "missing_active_runtime"
        | "review_queue"
        | "review_execution_unsupported"
        | "operator_required_continuation"
        | "workflow_proof_failure"
        | "scope_expansion_required"
        | "runtime_blocked"
        | "recovery_required"
        | "runtime_task_missing"
        | "active_task_mismatch"
        | "uncommitted_deliverables";
      reason: string;
      cycle: number;
      activeRunId: string | null;
      activeTaskId: string | null;
      directiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
      nextActions?: string[] | undefined;
      detailFiles?: {
        continuationStatus?: string | undefined;
        reviewQueueStatus?: string | undefined;
        scopeExpansionRequest?: string | undefined;
      } | undefined;
    }) => {
      await writeDaemonOperatorHandoff(cwd, {
        state: "blocked",
        blockerKind: input.blockerKind,
        reason: input.reason,
        workspaceSlug,
        projectSlug,
        activeRunId: input.activeRunId,
        activeTaskId: input.activeTaskId,
        sessionId: latestSessionId ?? null,
        cycle: input.cycle,
        directiveKind: input.directiveKind,
        nextActions: [...(input.nextActions ?? [])],
        detailFiles: { ...(input.detailFiles ?? {}) },
        updatedAt: now().toISOString()
      });

      return {
        authorityLabel: "derived_only" as const,
        workspaceSlug,
        projectSlug,
        status: "blocked" as const,
        reason: input.reason,
        activeRunId: input.activeRunId,
        activeTaskId: input.activeTaskId,
        sessionId: latestSessionId ?? null,
        cycles
      };
    };

    const attemptRuntimeReconcile = async (cycle: number): Promise<ReconcileRuntimeStateCommandResult | undefined> => {
      const baseArgs = [
        "--workspace-slug",
        workspaceSlug,
        "--project-slug",
        projectSlug,
        "--stale-after-hours",
        String(staleAfterHours),
        "--format",
        "json"
      ] as const;
      const preview = await executeReconcileRuntimeStateCommandFromArgs(
        baseArgs,
        options
      );
      const repairAction = preview.result.repairAction;
      const shouldApply =
        repairAction === "rebuild_missing_runtime_state" ||
        repairAction === "sync_active_task_to_in_progress" ||
        repairAction === "activate_owner_dispatch_target";

      if (!preview.result.runtimeStateChanged || !shouldApply) {
        return undefined;
      }

      const { result } = await executeReconcileRuntimeStateCommandFromArgs(
        [
          ...baseArgs,
          "--apply",
        ],
        options
      );

      cycles.push({
        cycle,
        directiveKind: result.executionPlanDirectiveKind ?? "blocked",
        action: "reconcile_runtime_state",
        runId: result.activeRunId ?? "none",
        taskId: result.activeTaskId,
        sessionId: latestSessionId ?? null,
        summary: `${result.repairAction}: ${result.reason}`
      });
      return result;
    };

    const runtimePreflightFailure = await executeRuntimeExecutionPreflight(
      args,
      {
        ...(options as ExecuteRuntimePreflightCommandOptions),
        requireRuntimePreflight: true
      }
    );
    if (runtimePreflightFailure) {
      return blockedResult({
        blockerKind: "runtime_preflight",
        reason: runtimePreflightFailure.reason,
        cycle: 1,
        activeRunId: runtimePreflightFailure.activeRunId,
        activeTaskId: null,
        nextActions: runtimePreflightFailure.nextActions
      });
    }

    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      const projectContext = await options.getProjectContext({
        workspaceSlug,
        projectSlug
      });
      if (!projectContext) {
        return blockedResult({
          blockerKind: "bootstrapping",
          reason: `Project ${workspaceSlug}/${projectSlug} is not bootstrapped`,
          cycle,
          activeRunId: null,
          activeTaskId: null,
          nextActions: []
        });
      }

      await attemptRuntimeReconcile(cycle);

      const projectRuntimeState = await options.getProjectRuntimeState(projectContext.project.id);
      const activeRunId = projectRuntimeState?.activeRunId ?? null;
      const activeTaskId = projectRuntimeState?.activeTaskId ?? null;
      latestSessionId = latestSessionId ?? readDaemonSessionId(projectRuntimeState?.metadata);
      await clearDaemonContinuationStatus(cwd);
      await clearDaemonAutomationEnvelope(cwd);
      await clearDaemonAppAutomationRequest(cwd);
      await clearDaemonCliSchedulerRequest(cwd);
      await clearDaemonOperatorHandoff(cwd);
      await clearDaemonScopeExpansionRequest(cwd);

      if (!activeRunId || !activeTaskId) {
        if (cycles.length > 0) {
          return {
            authorityLabel: "derived_only" as const,
            workspaceSlug,
            projectSlug,
            status: "completed" as const,
            reason: "daemon reached an idle runtime state with no active task remaining",
            activeRunId,
            activeTaskId,
            sessionId: latestSessionId ?? null,
            cycles
          };
        }

        return blockedResult({
          blockerKind: "missing_active_runtime",
          reason: "daemon requires an active runtime run and task",
          cycle,
          activeRunId,
          activeTaskId,
          nextActions: []
        });
      }

      const loop = await executeLoopCommandFromArgs(
        [
          "--run-id",
          activeRunId,
          "--format",
          "json",
          "--stale-after-hours",
          String(staleAfterHours),
          "--apply-safe-recovery"
        ],
        {
          ...options,
          skipRuntimePreflight: true,
          runtimePreflightBypassToken: INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN
        }
      );
      const directive = loop.result.finalPlan.directive;
      const runDaemonCodexTurn = async (input: {
        directive: RunExecutionPlan["directive"];
        summaryAction: "run_codex_owner" | "run_codex_analysis";
        activeRunId: string;
        activeTaskId: string;
        operatorNotes?: string | undefined;
      }) => {
        const snapshot = await options.getStatusSnapshot(input.activeRunId);
        const taskRecord = snapshot.tasks.find((task) => task.packet.taskId === input.activeTaskId);
        if (!taskRecord) {
          const reconciled = await attemptRuntimeReconcile(cycle);
          if (reconciled?.runtimeStateChanged) {
            return undefined;
          }
          cycles.push({
            cycle,
            directiveKind: input.directive.kind,
            action: "blocked",
            runId: input.activeRunId,
            taskId: input.activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: "active runtime task is missing from the run snapshot"
          });

          return blockedResult({
            blockerKind: "runtime_task_missing",
            reason: "active runtime task is missing from the run snapshot",
            cycle,
            activeRunId: input.activeRunId,
            activeTaskId: input.activeTaskId,
            directiveKind: input.directive.kind,
            nextActions: [
              "inspect `npm run archon:status -- --format json` to confirm the runtime task snapshot",
              "run `npm run archon:reconcile` to repair safe runtime/local task drift before retrying the daemon"
            ]
          });
        }
        const beforeProgressKey = buildDaemonProgressKey({
          runtimeState: projectRuntimeState,
          snapshot,
          directive: input.directive,
          activeTaskId: input.activeTaskId
        });
        const promptMetadata = readDaemonPromptMetadata(projectRuntimeState?.metadata);
        const packetFingerprint = buildDaemonTaskPacketFingerprint(taskRecord.packet);
        const promptMode = determineDaemonPromptMode({
          sessionId: latestSessionId,
          previousTaskId: promptMetadata?.taskId,
          previousPacketFingerprint: promptMetadata?.packetFingerprint,
          taskId: input.activeTaskId,
          packetFingerprint
        });
        const latestCheckpoint = snapshot.autonomousExecution?.state.checkpoints.at(-1);

        const prompt = buildDaemonTaskPrompt({
          promptMode,
          directive: input.directive,
          taskId: input.activeTaskId,
          packet: taskRecord.packet,
          operatorNotes: input.operatorNotes,
          compressedContextSummary:
            promptMode === "delta"
              ? latestCheckpoint?.compressedContextSummary
              : undefined,
          compressedContextRef:
            promptMode === "delta"
              ? latestCheckpoint?.compressedContextRef
              : undefined
        });
        const codexTurn = await runCodexTurn({
          claudeBin,
          cwd,
          env,
          prompt,
          sessionId: latestSessionId
        });

        latestSessionId = codexTurn.sessionId ?? latestSessionId;
        const parsedTurnMessage = parseDaemonTurnMessage(codexTurn.finalMessage);
        await persistDaemonTurnCheckpoint({
          runId: input.activeRunId,
          taskId: input.activeTaskId,
          snapshot,
          message: parsedTurnMessage,
          checkpointRun: options.checkpointRun,
          now
        });
        const refreshedProjectRuntimeState = await options.getProjectRuntimeState(projectContext.project.id);
        const refreshedSnapshot = await options.getStatusSnapshot(input.activeRunId);
        const refreshedPlan = await options.getExecutionPlan(input.activeRunId, staleAfterHours);
        const afterProgressKey = buildDaemonProgressKey({
          runtimeState: refreshedProjectRuntimeState,
          snapshot: refreshedSnapshot,
          directive: refreshedPlan.directive,
          activeTaskId: input.activeTaskId
        });
        const noProgress = beforeProgressKey === afterProgressKey;
        const priorStagnation = readDaemonStagnationMetadata(projectRuntimeState?.metadata);
        const stagnantTurnCount =
          noProgress &&
          priorStagnation &&
          priorStagnation.runId === input.activeRunId &&
          priorStagnation.taskId === input.activeTaskId &&
          priorStagnation.directiveKind === input.directive.kind &&
          priorStagnation.progressKey === beforeProgressKey
            ? priorStagnation.count + 1
            : noProgress
              ? 1
              : 0;
        await options.saveProjectRuntimeState({
          projectId: refreshedProjectRuntimeState?.projectId ?? projectRuntimeState?.projectId ?? projectContext.project.id,
          workspaceId: refreshedProjectRuntimeState?.workspaceId ?? projectRuntimeState?.workspaceId ?? projectContext.workspace.id,
          activeRunId: refreshedProjectRuntimeState?.activeRunId,
          activeTaskId: refreshedProjectRuntimeState?.activeTaskId,
          taskQueue: refreshedProjectRuntimeState?.taskQueue ?? projectRuntimeState?.taskQueue ?? buildDefaultTaskQueue(),
          productState: refreshedProjectRuntimeState?.productState ?? projectRuntimeState?.productState ?? buildDefaultProductState(),
          lastVerifiedRunId: refreshedProjectRuntimeState?.lastVerifiedRunId ?? projectRuntimeState?.lastVerifiedRunId,
          metadata: {
            ...(refreshedProjectRuntimeState?.metadata ?? projectRuntimeState?.metadata ?? {}),
            archonDaemon: {
              sessionId: latestSessionId,
              lastRunId: input.activeRunId,
              lastTaskId: input.activeTaskId,
              lastDirectiveKind: input.directive.kind,
              lastPromptTaskId: input.activeTaskId,
              lastPromptPacketFingerprint: packetFingerprint,
              lastPromptMode: promptMode,
              ...(noProgress
                ? {
                    stagnation: {
                      runId: input.activeRunId,
                      taskId: input.activeTaskId,
                      directiveKind: input.directive.kind,
                      progressKey: beforeProgressKey,
                      count: stagnantTurnCount,
                      updatedAt: now().toISOString(),
                      lastStatus: parsedTurnMessage?.status,
                      lastSummary: parsedTurnMessage?.summary,
                      lastBlockers: parsedTurnMessage?.blockers
                    }
                  }
                : {}),
              updatedAt: now().toISOString()
            }
          },
          createdAt: refreshedProjectRuntimeState?.createdAt ?? projectRuntimeState?.createdAt ?? now().toISOString(),
          updatedAt: now().toISOString()
        });

        cycles.push({
          cycle,
          directiveKind: input.directive.kind,
          action: input.summaryAction,
          runId: input.activeRunId,
          taskId: input.activeTaskId,
          sessionId: latestSessionId ?? null,
          summary: parsedTurnMessage?.summary || codexTurn.finalMessage?.slice(0, 160) || "codex turn executed"
        });

        if (noProgress) {
          const workerSummary =
            parsedTurnMessage
              ? [parsedTurnMessage.summary, ...parsedTurnMessage.blockers].filter(Boolean).join(" | ")
              : "runtime state was unchanged after the Codex turn";
          const scopeConflict = daemonMessageHasScopeConflict(parsedTurnMessage);
          const shouldBlockNow =
            parsedTurnMessage?.status === "blocked" || stagnantTurnCount >= MAX_DAEMON_STAGNANT_TURNS;

          if (shouldBlockNow) {
            let scopeExpansionRequestPath: string | undefined;
            if (scopeConflict && parsedTurnMessage?.scopeRequest) {
              scopeExpansionRequestPath = await writeDaemonScopeExpansionRequest(cwd, {
                runId: input.activeRunId,
                taskId: input.activeTaskId,
                directiveKind: input.directive.kind,
                blockedPaths: [...parsedTurnMessage.scopeRequest.blockedPaths],
                requestedWriteScope:
                  parsedTurnMessage.scopeRequest.requestedWriteScope.length > 0
                    ? [...parsedTurnMessage.scopeRequest.requestedWriteScope]
                    : [...parsedTurnMessage.scopeRequest.blockedPaths],
                reason: parsedTurnMessage.scopeRequest.reason ?? parsedTurnMessage.summary,
                updatedAt: now().toISOString()
              });
            }
            const reason = scopeConflict
              ? `daemon stopped after a scope-blocked no-progress turn: ${workerSummary}`
              : parsedTurnMessage?.status === "blocked"
                ? `daemon stopped after a blocked no-progress turn: ${workerSummary}`
                : `daemon detected ${stagnantTurnCount} consecutive no-progress turns for ${input.activeTaskId}: ${workerSummary}`;
            const nextActions = scopeConflict
              ? [
                  "widen the task packet allowed write scope to include the blocked paths or split them into a follow-on task",
                  "record the exact blocked paths in the blocker handoff before rerouting"
                ]
              : [
                  "inspect the active task packet and daemon session for missing runtime proof, handoff, or verification steps",
                  "reroute only after a concrete runtime state change is possible"
                ];
            cycles.push({
              cycle,
              directiveKind: input.directive.kind,
              action: scopeConflict ? "request_scope_expansion" : "blocked",
              runId: input.activeRunId,
              taskId: input.activeTaskId,
              sessionId: latestSessionId ?? null,
              summary: reason
            });

            return blockedResult({
              blockerKind: scopeConflict ? "scope_expansion_required" : "runtime_blocked",
              reason,
              cycle,
              activeRunId: input.activeRunId,
              activeTaskId: input.activeTaskId,
              directiveKind: input.directive.kind,
              nextActions,
              detailFiles: scopeExpansionRequestPath
                ? {
                    scopeExpansionRequest: scopeExpansionRequestPath
                  }
                : undefined
            });
          }
        }

        return undefined;
      };
      const handleOperatorRequiredContinuation = async (input: {
        directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
        classification: ContinueAnalysisDirectiveClassification;
      }
      ): Promise<DaemonCommandResult | undefined> => {
        let queuedOperatorActions: DaemonOperatorActionQueueEntry[];
        let failedOperatorActions: FailedDaemonOperatorActionQueueEntry[];
        try {
          const queueState = await readDaemonOperatorActionQueueState(operatorActionDir);
          queuedOperatorActions = queueState.entries;
          failedOperatorActions = queueState.failedEntries;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          cycles.push({
            cycle,
            directiveKind: input.directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: `operator action queue error: ${message}`
          });

          return blockedResult({
            blockerKind: "operator_required_continuation",
            reason: `operator action queue error: ${message}`,
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: input.directive.kind,
            nextActions: [...input.directive.nextActions]
          });
        }

        if (failedOperatorActions.length > 0) {
          await archiveFailedDaemonOperatorActionQueueEntries(failedOperatorActions, cwd, now().toISOString());
        }

        const matchingOperatorAction = queuedOperatorActions.find((entry) =>
          matchesDaemonOperatorContinuationAction({
            entry,
            runId: activeRunId,
            taskId: activeTaskId,
            directive: input.directive,
            classification: input.classification
          })
        );

        if (matchingOperatorAction) {
          await archiveConsumedDaemonOperatorActionQueueEntries([matchingOperatorAction], cwd);
          const codexResult = await runDaemonCodexTurn({
            directive: input.directive,
            summaryAction: "run_codex_analysis",
            activeRunId,
            activeTaskId,
            operatorNotes: matchingOperatorAction.command.action.operatorNotes
          });
          return codexResult;
        }

        const providerSelection = selectLocalContinuationProvider({
          executionMode: input.classification.executionMode,
          continuationIntent: input.classification.continuationIntent,
          capabilities: resolveContinuationCapabilities(env)
        });
        const updatedAt = now().toISOString();
        await writeDaemonContinuationStatus(cwd, {
          state: "blocked",
          directiveKind: "continue_analysis",
          executionMode: "operator_required",
          targetId: input.directive.targetId,
          source: input.directive.source,
          sourceId:
            input.classification.action?.kind === "resume_target"
              ? input.classification.action.sourceId
              : undefined,
          actionKind: input.classification.action?.kind,
          provider: providerSelection.provider,
          wakeOwner: providerSelection.wakeOwner,
          scheduleKind: providerSelection.scheduleKind,
          schedule: providerSelection.schedule,
          summary: input.classification.summary,
          nextActions: [...input.directive.nextActions],
          blockers: [...input.directive.blockers],
          updatedAt
        });
        if (
          (providerSelection.provider === "claude_app_thread_automation" ||
            providerSelection.provider === "claude_app_standalone_automation" ||
            providerSelection.provider === "claude_cli_exec_scheduler") &&
          providerSelection.wakeOwner === "operator" &&
          providerSelection.scheduleKind !== "none" &&
          providerSelection.scheduleKind !== "manual" &&
          typeof providerSelection.schedule === "string" &&
          (input.classification.continuationIntent === "defer_same_thread" ||
            input.classification.continuationIntent === "defer_fresh_run") &&
          (input.directive.source === "checkpoint" || input.directive.source === "progress_proof")
        ) {
          await writeDaemonAutomationEnvelope(cwd, {
            provider: providerSelection.provider,
            wakeOwner: "operator",
            continuationIntent: input.classification.continuationIntent,
            targetMode: input.classification.continuationIntent === "defer_same_thread" ? "same_thread" : "fresh_run",
            scheduleKind: providerSelection.scheduleKind,
            schedule: providerSelection.schedule,
            targetId: input.directive.targetId,
            source: input.directive.source,
            sourceId:
              input.classification.action?.kind === "resume_target"
                ? input.classification.action.sourceId
                : undefined,
            summary: input.classification.summary,
            nextActions: [...input.directive.nextActions],
            workspaceSlug,
            projectSlug,
            activeRunId,
            activeTaskId,
            updatedAt
          });
        } else {
          await clearDaemonAutomationEnvelope(cwd);
        }
        cycles.push({
          cycle,
          directiveKind: input.directive.kind,
          action: "blocked",
          runId: activeRunId,
          taskId: activeTaskId,
          sessionId: latestSessionId ?? null,
          summary: input.classification.summary
        });

        return blockedResult({
          blockerKind: "operator_required_continuation",
          reason: input.classification.summary,
          cycle,
          activeRunId,
          activeTaskId,
          directiveKind: input.directive.kind,
          nextActions: [...input.directive.nextActions],
          detailFiles: {
            continuationStatus: ".archon/work/daemon/continuation-status.json",
            ...(providerSelection.provider === "claude_app_thread_automation" ||
            providerSelection.provider === "claude_app_standalone_automation" ||
            providerSelection.provider === "claude_cli_exec_scheduler"
              ? {
                  automationEnvelope: ".archon/work/daemon/automation-envelope.json"
                }
              : {})
          }
        });
      };

      if (directive.kind === "complete") {
        let advanced: Awaited<ReturnType<typeof executeAdvanceActiveTaskCommandFromArgs>>;
        try {
          advanced = await executeAdvanceActiveTaskCommandFromArgs(
            [
              "--workspace-slug",
              workspaceSlug,
              "--project-slug",
              projectSlug,
              "--run-id",
              activeRunId,
              "--apply",
              "--format",
              "json"
            ],
            options
          );
        } catch (error) {
          // advance-active-task can throw — most notably the commit guard when the
          // task's in-scope deliverables are uncommitted. Surface it as a structured
          // blocker so the autonomy loop pauses for the operator instead of crashing.
          const failure = classifyAdvanceFailure(error);
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: failure.reason
          });
          return blockedResult({
            blockerKind: failure.blockerKind,
            reason: failure.reason,
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: failure.nextActions
          });
        }

        cycles.push({
          cycle,
          directiveKind: directive.kind,
          action: advanced.result.nextTaskId ? "advance_active_task" : "complete",
          runId: activeRunId,
          taskId: activeTaskId,
          sessionId: latestSessionId ?? null,
          summary: advanced.result.nextTaskId
            ? `advanced to ${advanced.result.nextTaskId}`
            : "advanced the final active task and closed the queue"
        });

        if (!advanced.result.nextTaskId) {
          const refreshedState = await options.getProjectRuntimeState(projectContext.project.id);
          return {
            authorityLabel: "derived_only" as const,
            workspaceSlug,
            projectSlug,
            status: "completed" as const,
            reason: "daemon advanced the final active task and no next task remains",
            activeRunId: refreshedState?.activeRunId ?? null,
            activeTaskId: refreshedState?.activeTaskId ?? null,
            sessionId: latestSessionId ?? null,
            cycles
          };
        }

        continue;
      }

      if (directive.kind === "dispatch_reviews") {
        if (!options.executeDirectiveStep) {
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: "runtime surface does not support authenticated review execution"
          });

          return blockedResult({
            blockerKind: "review_execution_unsupported",
            reason: "required authenticated reviews block the active run",
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: []
          });
        }

        let queuedReviewEntries: DaemonReviewQueueEntry[];
        let failedReviewEntries: FailedDaemonReviewQueueEntry[];
        try {
          const queueState = await readDaemonReviewQueueState(reviewInputDir);
          queuedReviewEntries = queueState.entries;
          failedReviewEntries = queueState.failedEntries;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: `review input queue error: ${message}`
          });

          return blockedResult({
            blockerKind: "review_queue",
            reason: `review input queue error: ${message}`,
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: []
          });
        }

        const expectedReviewTargets = directive.recommendations.map(
          (recommendation) => `${recommendation.taskId}:${recommendation.targetReviewRole ?? "unknown"}`
        );
        if (failedReviewEntries.length > 0) {
          const timestamp = now().toISOString();
          await archiveFailedDaemonReviewQueueEntries(failedReviewEntries, cwd, timestamp);
          await writeDaemonReviewQueueStatus(cwd, {
            state: "failed",
            reviewInputDir,
            reason: `${failedReviewEntries.length} queued review action file(s) were invalid and moved to failed-review-actions`,
            expectedReviewTargets,
            queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
            failedFiles: failedReviewEntries.map((entry) => ({
              file: path.basename(entry.filePath),
              error: entry.error
            })),
            updatedAt: timestamp
          });
        }

        if (queuedReviewEntries.length === 0) {
          await writeDaemonReviewQueueStatus(cwd, {
            state: failedReviewEntries.length > 0 ? "failed" : "blocked",
            reviewInputDir,
            reason: `required authenticated reviews are pending; no usable review action files were found in ${reviewInputDir}`,
            expectedReviewTargets,
            failedFiles: failedReviewEntries.map((entry) => ({
              file: path.basename(entry.filePath),
              error: entry.error
            })),
            updatedAt: now().toISOString()
          });
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: `required authenticated reviews are pending; no review action files were found in ${reviewInputDir}`
          });

          return blockedResult({
            blockerKind: "review_queue",
            reason: "required authenticated reviews block the active run",
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: [],
            detailFiles: {
              reviewQueueStatus: ".archon/work/daemon/review-queue-status.json"
            }
          });
        }

        const executionResult = await options.executeDirectiveStep(activeRunId, {
          staleAfterHours,
          reviewCommands: queuedReviewEntries.map((entry) => entry.command)
        });

        const consumedEntries: DaemonReviewQueueEntry[] = [];
        const staleEntries: StaleDaemonReviewQueueEntry[] = [];
        for (const step of executionResult.steps) {
          if (
            step.directiveKind !== "dispatch_reviews" ||
            step.outcome !== "executed" ||
            !step.taskId ||
            !step.reviewRole
          ) {
            continue;
          }

          const matchIndex = queuedReviewEntries.findIndex(
            (entry) =>
              entry.command.runId === activeRunId &&
              entry.command.taskId === step.taskId &&
              entry.command.review.reviewerRole === step.reviewRole &&
              (step.actor ? entry.command.actor === step.actor : true)
          );
          if (matchIndex >= 0) {
            const consumed = queuedReviewEntries.splice(matchIndex, 1)[0]!;
            consumedEntries.push(consumed);
          }

          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "record_review",
            runId: activeRunId,
            taskId: step.taskId,
            sessionId: latestSessionId ?? null,
            summary: `recorded ${step.reviewRole}${step.actor ? ` via ${step.actor}` : ""}`
          });
        }

        if (consumedEntries.length > 0) {
          await archiveConsumedDaemonReviewQueueEntries(consumedEntries, cwd);
        }

        if (queuedReviewEntries.length > 0) {
          staleEntries.push(
            ...queuedReviewEntries.map((entry) => ({
              filePath: entry.filePath,
              reason: "queued review action no longer matched the active runtime review directives"
            }))
          );
          await archiveStaleDaemonReviewQueueEntries(
            staleEntries,
            cwd,
            now().toISOString(),
            expectedReviewTargets
          );
          queuedReviewEntries = [];
        }

        if (!executionResult.steps.some((step) => step.directiveKind === "dispatch_reviews" && step.outcome === "executed")) {
          const unsupportedStep = executionResult.steps.find((step) => step.directiveKind === "dispatch_reviews");
          const mismatchReason =
            staleEntries.length > 0
              ? `queued review actions did not match the pending runtime review directives from ${reviewInputDir}`
              : undefined;
          const detailedReason =
            unsupportedStep?.evidence.join(" | ") ||
            `queued review actions did not match the pending runtime review directives from ${reviewInputDir}`;
          await writeDaemonReviewQueueStatus(cwd, {
            state: "blocked",
            reviewInputDir,
            reason: mismatchReason ? `${mismatchReason}: ${detailedReason}` : detailedReason,
            expectedReviewTargets,
            queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
            failedFiles: failedReviewEntries.map((entry) => ({
              file: path.basename(entry.filePath),
              error: entry.error
            })),
            staleFiles: staleEntries.map((entry) => ({
              file: path.basename(entry.filePath),
              reason: entry.reason
            })),
            updatedAt: now().toISOString()
          });
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary:
              mismatchReason ? `${mismatchReason}: ${detailedReason}` : detailedReason
          });

          return blockedResult({
            blockerKind: "review_queue",
            reason: "required authenticated reviews block the active run",
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: [],
            detailFiles: {
              reviewQueueStatus: ".archon/work/daemon/review-queue-status.json"
            }
          });
        }

        await writeDaemonReviewQueueStatus(cwd, {
          state: "processed",
          reviewInputDir,
          reason: "queued authenticated review actions were applied",
          expectedReviewTargets,
          consumedFiles: consumedEntries.map((entry) => path.basename(entry.filePath)),
          queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
          failedFiles: failedReviewEntries.map((entry) => ({
            file: path.basename(entry.filePath),
            error: entry.error
          })),
          staleFiles: staleEntries.map((entry) => ({
            file: path.basename(entry.filePath),
            reason: entry.reason
          })),
          updatedAt: now().toISOString()
        });

        continue;
      }

      if (directive.kind === "blocked" || directive.kind === "apply_recovery") {
        cycles.push({
          cycle,
          directiveKind: directive.kind,
          action: "blocked",
          runId: activeRunId,
          taskId: activeTaskId,
          sessionId: latestSessionId ?? null,
          summary:
            directive.kind === "blocked"
              ? directive.blockers.join(" | ") || "runtime reported no executable next step"
              : "runtime still requires explicit recovery before the daemon can continue"
        });

        return blockedResult({
          blockerKind: directive.kind === "blocked" ? "runtime_blocked" : "recovery_required",
          reason:
            directive.kind === "blocked"
              ? "runtime reported no executable next step"
              : "safe recovery could not clear the active runtime blockers",
          cycle,
          activeRunId,
          activeTaskId,
          directiveKind: directive.kind,
          nextActions: []
        });
      }

      if (directive.kind === "continue_analysis") {
        if (options.executeDirectiveStep) {
          const executionResult = await options.executeDirectiveStep(activeRunId, {
            staleAfterHours,
            reviewCommands: []
          });
          const continueStep = executionResult.steps.find((step) => step.directiveKind === "continue_analysis");

          if (continueStep?.outcome === "executed") {
            cycles.push({
              cycle,
              directiveKind: directive.kind,
              action: "apply_runtime_continuation",
              runId: activeRunId,
              taskId: continueStep.taskId ?? activeTaskId,
              sessionId: latestSessionId ?? null,
              summary: continueStep.evidence.join(" | ") || "runtime continuation executed"
            });
            continue;
          }

          if (continueStep?.outcome === "unsupported") {
            const snapshot = await options.getStatusSnapshot(activeRunId);
            const classification = classifyContinueAnalysisDirective({
              directive,
              state: snapshot.autonomousExecution?.state
            });
            if (classification.executionMode === "operator_required") {
              const handled = await handleOperatorRequiredContinuation({
                directive,
                classification
              });
              if (handled) {
                return handled;
              }
              continue;
            }
          }
        }

        const workflowProofTaskId = resolveDaemonWorkflowProofTaskId(directive);
        if (workflowProofTaskId) {
          try {
            await executeWorkflowProofCommandFromArgs(
              ["--run-id", activeRunId, "--task-id", workflowProofTaskId],
              {
                env,
                getStatusSnapshot: options.getStatusSnapshot,
                getReviews: options.getReviews,
                getApprovals: options.getApprovals
              }
            );

            const closedGapCount = await closeWorkflowProofCoverageGaps(activeRunId, workflowProofTaskId, {
              getStatusSnapshot: options.getStatusSnapshot,
              upsertCoverageGaps: options.upsertCoverageGaps
            });

            cycles.push({
              cycle,
              directiveKind: directive.kind,
              action: "run_workflow_proof",
              runId: activeRunId,
              taskId: workflowProofTaskId,
              sessionId: latestSessionId ?? null,
              summary:
                closedGapCount > 0
                  ? `workflow proof passed for ${workflowProofTaskId}; closed ${closedGapCount} autonomous gap(s)`
                  : `workflow proof passed for ${workflowProofTaskId}`
            });
            continue;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            cycles.push({
              cycle,
              directiveKind: directive.kind,
              action: "blocked",
              runId: activeRunId,
              taskId: workflowProofTaskId,
              sessionId: latestSessionId ?? null,
              summary: message
            });

            return blockedResult({
              blockerKind: "workflow_proof_failure",
              reason: message,
              cycle,
              activeRunId,
              activeTaskId,
              directiveKind: directive.kind,
              nextActions: []
            });
          }
        }
      }

      if (directive.kind === "continue_analysis") {
        const snapshot = await options.getStatusSnapshot(activeRunId);
        const classification = classifyContinueAnalysisDirective({
          directive,
          state: snapshot.autonomousExecution?.state
        });
        if (classification.executionMode === "operator_required") {
          const handled = await handleOperatorRequiredContinuation({
            directive,
            classification
          });
          if (handled) {
            return handled;
          }
          continue;
        }
      }

      if (directive.kind === "dispatch_owner" && directive.recommendation.taskId !== activeTaskId) {
        const reconciled = await attemptRuntimeReconcile(cycle);
        if (reconciled?.runtimeStateChanged) {
          continue;
        }
        cycles.push({
          cycle,
          directiveKind: directive.kind,
          action: "blocked",
          runId: activeRunId,
          taskId: activeTaskId,
          sessionId: latestSessionId ?? null,
          summary: `runtime wants ${directive.recommendation.taskId} but active task is ${activeTaskId}`
        });

        return blockedResult({
          blockerKind: "active_task_mismatch",
          reason: "runtime active-task pointer does not match the owner dispatch target",
          cycle,
          activeRunId,
          activeTaskId,
          directiveKind: directive.kind,
          nextActions: [
            "inspect `npm run archon:status -- --format json` to compare the active runtime task and owner dispatch target",
            "run `npm run archon:reconcile` to align the active runtime task with the authoritative owner-dispatch target"
          ]
        });
      }

      const codexResult = await runDaemonCodexTurn({
        directive,
        summaryAction: directive.kind === "dispatch_owner" ? "run_codex_owner" : "run_codex_analysis",
        activeRunId,
        activeTaskId
      });
      if (codexResult) {
        return codexResult;
      }
    }

    const projectContext = await options.getProjectContext({
      workspaceSlug,
      projectSlug
    });
    const runtimeState = projectContext
      ? await options.getProjectRuntimeState(projectContext.project.id)
      : undefined;

    return {
      authorityLabel: "derived_only" as const,
      workspaceSlug,
      projectSlug,
      status: "max_cycles_reached" as const,
      reason: `daemon stopped after reaching the configured cycle budget (${maxCycles})`,
      activeRunId: runtimeState?.activeRunId ?? null,
      activeTaskId: runtimeState?.activeTaskId ?? null,
      sessionId: latestSessionId ?? null,
      cycles
    };
  });

  return {
    format,
    result
  };
}


export async function daemonCommand(args: readonly string[]) {
  const env = process.env;
  const cwd = process.cwd();
  const format = resolveFormatFlag(args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG ?? "unknown";
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG ?? "unknown";
  try {
    await withClient(async (client) => {
      const store = new PostgresStore(client);
      const service = new ArchonCoreService(store);
      const { format: resolvedFormat, result } = await executeDaemonCommandFromArgs(args, {
        cwd,
        env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        getProjectContext(params) {
          return store.getProjectContext(params);
        },
        getProjectRuntimeRegistration(projectId) {
          return store.getProjectRuntimeRegistration(projectId);
        },
        getProjectRuntimeState(projectId) {
          return store.getProjectRuntimeState(projectId);
        },
        saveProjectRuntimeState(state) {
          return store.saveProjectRuntimeState(state);
        },
        getStatusSnapshot(runId) {
          return service.getStatus(runId);
        },
        getExecutionPlan(runId, staleAfterHours) {
          return service.getExecutionPlan(runId, { staleAfterHours });
        },
        applyRecovery(runId, actionIds, staleAfterHours) {
          return service.applyRecovery(runId, actionIds, { staleAfterHours });
        },
        async executeDirectiveStep(runId, input) {
          const executeReviewRecommendation =
            input.reviewCommands.length > 0
              ? createQueuedLoopReviewExecutor(
                  runId,
                  input.reviewCommands,
                  await createLiveLoopReviewCommandExecutor({
                    cwd,
                    env,
                    recordReview({ command, resolver }) {
                      const reviewService = new ArchonCoreService(store, {
                        resolveReviewActionContext: resolver
                      });
                      return reviewService.recordReview(
                        command.runId,
                        command.taskId,
                        command.actor,
                        command.review
                      );
                    }
                  })
                )
              : undefined;

          return service.executeDirectiveStep(runId, {
            staleAfterHours: input.staleAfterHours,
            ownerActor: input.ownerActor,
            executeContinuationAction: createSupportedContinuationExecutor({
              env,
              getStatusSnapshot(candidateRunId) {
                return service.getStatus(candidateRunId);
              },
              getReviews(candidateRunId, taskId) {
                return store.getReviews(candidateRunId, taskId);
              },
              getApprovals(candidateRunId, taskId) {
                return store.getApprovals(candidateRunId, taskId);
              },
              upsertCoverageGaps(candidateRunId, gaps) {
                return service.upsertCoverageGaps(candidateRunId, gaps);
              },
              recordProgressProof(candidateRunId, proof) {
                return service.recordProgressProof(candidateRunId, proof);
              },
              checkpointRun(candidateRunId, checkpoint, checkpointOptions) {
                return service.checkpointRun(candidateRunId, checkpoint, checkpointOptions);
              }
            }),
            ...(executeReviewRecommendation ? { executeReviewRecommendation } : {})
          });
        },
        upsertCoverageGaps(runId, gaps) {
          return service.upsertCoverageGaps(runId, gaps);
        },
        checkpointRun(runId, checkpoint, checkpointOptions) {
          return service.checkpointRun(runId, checkpoint, checkpointOptions);
        },
        getReviews(runId, taskId) {
          return store.getReviews(runId, taskId);
        },
        getApprovals(runId, taskId) {
          return store.getApprovals(runId, taskId);
        }
      });

      if (resolvedFormat === "text") {
        process.stdout.write(`${formatDaemonCommandResult(result)}\n`);
        return;
      }

      console.log(JSON.stringify(result));
    });
  } catch (error) {
    if (!isRuntimeExecutionPreflightConnectionError(error)) {
      throw error;
    }
    const failure = buildRuntimeExecutionConnectionFailure(error);
    const result: DaemonCommandResult = {
      authorityLabel: "derived_only",
      workspaceSlug,
      projectSlug,
      status: "blocked",
      reason: failure.reason,
      activeRunId: null,
      activeTaskId: null,
      sessionId: null,
      cycles: []
    };
    await writeDaemonOperatorHandoff(cwd, {
      state: "blocked",
      blockerKind: "runtime_preflight",
      reason: failure.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: null,
      activeTaskId: null,
      sessionId: null,
      cycle: 0,
      nextActions: failure.nextActions,
      detailFiles: {},
      updatedAt: new Date().toISOString()
    });
    if (format === "text") {
      process.stdout.write(
        `${formatRuntimeExecutionPreflightFailureResult({
          status: "blocked",
          reason: result.reason,
          workspaceSlug: result.workspaceSlug,
          projectSlug: result.projectSlug,
          activeRunId: result.activeRunId,
          activeTaskId: result.activeTaskId,
          sessionId: result.sessionId
        })}\n`
      );
      return;
    }
    console.log(JSON.stringify(result));
  }
}


export async function supervisorCommand(args: readonly string[]) {
  const env = process.env;
  const cwd = process.cwd();
  const format = resolveFormatFlag(args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG ?? "unknown";
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG ?? "unknown";
  try {
    await withClient(async (client) => {
      const store = new PostgresStore(client);
      const service = new ArchonCoreService(store);
      const { format: resolvedFormat, result } = await executeSupervisorCommandFromArgs(args, {
        cwd,
        env,
        runDaemonCommand: executeDaemonCommandFromArgs,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        getProjectContext(params) {
          return store.getProjectContext(params);
        },
        getProjectRuntimeRegistration(projectId) {
          return store.getProjectRuntimeRegistration(projectId);
        },
        getProjectRuntimeState(projectId) {
          return store.getProjectRuntimeState(projectId);
        },
        saveProjectRuntimeState(state) {
          return store.saveProjectRuntimeState(state);
        },
        getStatusSnapshot(runId) {
          return service.getStatus(runId);
        },
        getExecutionPlan(runId, staleAfterHours) {
          return service.getExecutionPlan(runId, { staleAfterHours });
        },
        applyRecovery(runId, actionIds, staleAfterHours) {
          return service.applyRecovery(runId, actionIds, { staleAfterHours });
        },
        async executeDirectiveStep(runId, input) {
          const executeReviewRecommendation =
            input.reviewCommands.length > 0
              ? createQueuedLoopReviewExecutor(
                  runId,
                  input.reviewCommands,
                  await createLiveLoopReviewCommandExecutor({
                    cwd,
                    env,
                    recordReview({ command, resolver }) {
                      const reviewService = new ArchonCoreService(store, {
                        resolveReviewActionContext: resolver
                      });
                      return reviewService.recordReview(
                        command.runId,
                        command.taskId,
                        command.actor,
                        command.review
                      );
                    }
                  })
                )
              : undefined;

          return service.executeDirectiveStep(runId, {
            staleAfterHours: input.staleAfterHours,
            ownerActor: input.ownerActor,
            executeContinuationAction: createSupportedContinuationExecutor({
              env,
              getStatusSnapshot(candidateRunId) {
                return service.getStatus(candidateRunId);
              },
              getReviews(candidateRunId, taskId) {
                return store.getReviews(candidateRunId, taskId);
              },
              getApprovals(candidateRunId, taskId) {
                return store.getApprovals(candidateRunId, taskId);
              },
              upsertCoverageGaps(candidateRunId, gaps) {
                return service.upsertCoverageGaps(candidateRunId, gaps);
              },
              recordProgressProof(candidateRunId, proof) {
                return service.recordProgressProof(candidateRunId, proof);
              },
              checkpointRun(candidateRunId, checkpoint, checkpointOptions) {
                return service.checkpointRun(candidateRunId, checkpoint, checkpointOptions);
              }
            }),
            ...(executeReviewRecommendation ? { executeReviewRecommendation } : {})
          });
        },
        upsertCoverageGaps(runId, gaps) {
          return service.upsertCoverageGaps(runId, gaps);
        },
        checkpointRun(runId, checkpoint, checkpointOptions) {
          return service.checkpointRun(runId, checkpoint, checkpointOptions);
        },
        getReviews(runId, taskId) {
          return store.getReviews(runId, taskId);
        },
        getApprovals(runId, taskId) {
          return store.getApprovals(runId, taskId);
        }
      });

      if (resolvedFormat === "text") {
        process.stdout.write(`${formatSupervisorCommandResult(result)}\n`);
        return;
      }

      console.log(JSON.stringify(result));
    });
  } catch (error) {
    if (!isRuntimeExecutionPreflightConnectionError(error)) {
      throw error;
    }
    const failure = buildRuntimeExecutionConnectionFailure(error);
    const result: SupervisorCommandResult = {
      authorityLabel: "derived_only",
      workspaceSlug,
      projectSlug,
      status: "blocked",
      reason: failure.reason,
      activeRunId: null,
      activeTaskId: null,
      sessionId: null,
      daemonRuns: [],
      actions: []
    };
    await writeDaemonSupervisorStatus(cwd, {
      state: "blocked",
      blockerKind: "runtime_preflight",
      reason: failure.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: null,
      activeTaskId: null,
      sessionId: null,
      supervisorCycles: 0,
      nextActions: failure.nextActions,
      missingReviewRoles: [],
      actions: [],
      updatedAt: new Date().toISOString()
    });
    if (format === "text") {
      process.stdout.write(`${formatSupervisorCommandResult(result)}\n`);
      return;
    }
    console.log(JSON.stringify(result));
  }
}


export async function supervisorHistoryCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const { format, result } = await executeSupervisorHistoryCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      }
    });

    if (format === "text") {
      process.stdout.write(`${formatSupervisorHistoryCommandResult(result)}\n`);
      return;
    }

    console.log(JSON.stringify(result));
  });
}
