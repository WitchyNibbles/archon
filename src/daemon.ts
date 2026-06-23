// Daemon loop, supervisor, CLI session handling, autonomous continuation.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";








import { withClient } from "./admin/db.ts";
import { type ContinueAnalysisDirectiveClassification } from "./admin/autonomous-summary.ts";










import {
  ArchonCoreService,
  type DirectiveExecutionResult,
  type ExecuteDirectiveStepOptions
} from "./core/service.ts";
import type {
  CheckpointRecord,
  CoverageGapRecord,
  ProjectRuntimeStateRecord,
  RecoveryApplyResult,
  RunExecutionPlan,
  RunStatusSnapshot
} from "./domain/types.ts";
import { PostgresStore, PostgresMistakeLedgerStore } from "./store/postgres-store.ts";
import { INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN, executeAdvanceActiveTaskCommandFromArgs, resolveCommandFlag, resolveFormatFlag, resolveRunIdForCommand } from "./workflow.ts";
import type { EnvShape, ExecuteAdvanceActiveTaskCommandOptions, ExecuteStatusCommandOptions } from "./workflow.ts";
import { buildRuntimeExecutionConnectionFailure, executeReconcileRuntimeStateCommandFromArgs, executeRuntimeExecutionPreflight, formatRuntimeExecutionPreflightFailureResult, isRuntimeExecutionPreflightConnectionError } from "./runtime.ts";
import type { ExecuteDoctorCommandOptions, ExecuteRuntimePreflightCommandOptions } from "./runtime.ts";
import type { RecordReviewCommandInput } from "./review.ts";
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
import {
  createLiveLoopReviewCommandExecutor,
  createQueuedLoopReviewExecutor,
  createSupportedContinuationExecutor,
  resolveDaemonWorkflowProofTaskId,
  resolveWorkflowProofTaskIdForContinuationAction
} from "./daemon/loop-executors.ts";
export {
  createLiveLoopReviewCommandExecutor,
  createQueuedLoopReviewExecutor,
  createSupportedContinuationExecutor,
  resolveDaemonWorkflowProofTaskId,
  resolveWorkflowProofTaskIdForContinuationAction
};
import {
  computeDaemonStagnantTurnCount,
  evaluateDaemonNoProgressOutcome
} from "./daemon/turn-analysis.ts";
export {
  computeDaemonStagnantTurnCount,
  evaluateDaemonNoProgressOutcome
};
import type {
  DaemonNoProgressOutcome,
  DaemonScopeExpansionPayload
} from "./daemon/turn-analysis.ts";
export type {
  DaemonNoProgressOutcome,
  DaemonScopeExpansionPayload
};
import { handleDaemonOperatorRequiredContinuation } from "./daemon/operator-continuation.ts";
export { handleDaemonOperatorRequiredContinuation };
// Internal-only: the codex-turn runner is wired solely by the loop wrapper
// below. It is intentionally NOT re-exported from daemon.ts — direct invocation
// would bypass the loop's cycle accounting, preflight, and blocked-result
// context. Tests import it from ./daemon/codex-turn.ts directly.
import { runDaemonCodexTurn as runDaemonCodexTurnStep } from "./daemon/codex-turn.ts";
import type { DaemonCodexTurnInput } from "./daemon/codex-turn.ts";
import type {
  DaemonBlockedResultBuilder,
  DaemonBlockedResultInput,
  DaemonCodexTurnRunner,
  DaemonOperatorContinuationDeps,
  DaemonOperatorContinuationInput
} from "./daemon/operator-continuation.ts";
export type {
  DaemonBlockedResultBuilder,
  DaemonBlockedResultInput,
  DaemonCodexTurnRunner,
  DaemonOperatorContinuationDeps,
  DaemonOperatorContinuationInput
};
// Internal-only: the review-dispatch handler is wired solely by the loop
// wrapper below. Tests import it from ./daemon/review-dispatch.ts directly.
import { handleDaemonReviewDispatch as handleDaemonReviewDispatchStep } from "./daemon/review-dispatch.ts";
import type {
  DaemonReviewDispatchDeps,
  DaemonReviewDispatchInput
} from "./daemon/review-dispatch.ts";
export type { DaemonReviewDispatchDeps, DaemonReviewDispatchInput };
// Internal-only: the continue-analysis handler is wired solely by the loop
// wrapper below. Tests import it from ./daemon/continue-analysis.ts directly.
import { handleDaemonContinueAnalysis as handleDaemonContinueAnalysisStep } from "./daemon/continue-analysis.ts";
import type {
  DaemonContinueAnalysisDeps,
  DaemonContinueAnalysisInput,
  DaemonContinueAnalysisOutcome
} from "./daemon/continue-analysis.ts";
export type { DaemonContinueAnalysisDeps, DaemonContinueAnalysisInput, DaemonContinueAnalysisOutcome };
// Loop-monolith decomposition (6k): the complete directive handler is now in
// ./daemon/complete.ts. classifyAdvanceFailure is MOVED there (to avoid a value
// cycle) and re-exported here so existing callers at "../src/daemon.ts" keep
// working without any import-path changes. Tests import the handler directly from
// ./daemon/complete.ts — not from daemon.ts — to lock the module boundary.
import { handleDaemonComplete as handleDaemonCompleteStep } from "./daemon/complete.ts";
import type {
  DaemonCompleteInput,
  DaemonCompleteDeps
} from "./daemon/complete.ts";
export type { DaemonCompleteInput, DaemonCompleteDeps };
export { classifyAdvanceFailure } from "./daemon/complete.ts";
// Loop-monolith decomposition (6l): the blocked / apply_recovery directive
// handler is now in ./daemon/blocked-recovery.ts. Single-exit (always blocks);
// tests import it directly from the module path.
import { handleDaemonBlockedOrRecovery as handleDaemonBlockedOrRecoveryStep } from "./daemon/blocked-recovery.ts";
import type {
  DaemonBlockedRecoveryInput,
  DaemonBlockedRecoveryDeps
} from "./daemon/blocked-recovery.ts";
export type { DaemonBlockedRecoveryInput, DaemonBlockedRecoveryDeps };
// Loop-monolith decomposition (6m): the blockedResult and attemptRuntimeReconcile
// loop closures are now factories in ./daemon/blocked-result.ts and
// ./daemon/runtime-reconcile.ts. The loop wires them once at startup so all
// downstream handlers receive the same callback references they always did.
import { createDaemonBlockedResult } from "./daemon/blocked-result.ts";
import type { DaemonBlockedResultFactoryDeps } from "./daemon/blocked-result.ts";
export type { DaemonBlockedResultFactoryDeps };
import { createDaemonRuntimeReconcile } from "./daemon/runtime-reconcile.ts";
import type { DaemonRuntimeReconcileFactoryDeps, ReconcileRuntimeStateFn } from "./daemon/runtime-reconcile.ts";
export type { DaemonRuntimeReconcileFactoryDeps, ReconcileRuntimeStateFn };
// Loop-monolith decomposition (6n — THE FINAL CUT): the loop tail (dispatch_owner
// mismatch guard + codex fallthrough turn) is now in ./daemon/dispatch-owner-turn.ts.
// Internal-only: tests import it directly from the module path.
import { handleDaemonDispatchOwnerTurnStep } from "./daemon/dispatch-owner-turn.ts";
import type {
  DaemonDispatchOwnerTurnInput,
  DaemonDispatchOwnerTurnDeps
} from "./daemon/dispatch-owner-turn.ts";
export type { DaemonDispatchOwnerTurnInput, DaemonDispatchOwnerTurnDeps };


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
    const blockedResult = createDaemonBlockedResult({
      cwd,
      workspaceSlug,
      projectSlug,
      getSessionId: () => latestSessionId,
      now,
      cycles
    });
    const attemptRuntimeReconcile = createDaemonRuntimeReconcile({
      workspaceSlug,
      projectSlug,
      staleAfterHours,
      options,
      cycles,
      getSessionId: () => latestSessionId,
      reconcileRuntimeState: executeReconcileRuntimeStateCommandFromArgs
    });

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
      // Loop-monolith decomposition (6h): the codex-turn runner now lives in
      // ./daemon/codex-turn.ts. This thin wrapper threads the per-cycle inputs
      // plus the loop's mutable state. latestSessionId is exposed as a holder
      // (getSessionId/setSessionId) — NOT a captured value — because the runner
      // both reads and writes it, and pass-by-value would silently break the
      // session continuity that the next turn depends on.
      const runDaemonCodexTurn = (input: DaemonCodexTurnInput): Promise<DaemonCommandResult | undefined> =>
        runDaemonCodexTurnStep(input, {
          cycle,
          projectContext,
          projectRuntimeState,
          attemptRuntimeReconcile,
          cycles,
          blockedResult,
          getSessionId: () => latestSessionId,
          setSessionId: (sessionId) => {
            latestSessionId = sessionId;
          },
          claudeBin,
          cwd,
          env,
          now,
          staleAfterHours,
          runCodexTurn,
          getStatusSnapshot: options.getStatusSnapshot,
          getProjectRuntimeState: options.getProjectRuntimeState,
          getExecutionPlan: options.getExecutionPlan,
          saveProjectRuntimeState: options.saveProjectRuntimeState,
          checkpointRun: options.checkpointRun
        });
      // Loop-monolith decomposition (6g): the operator-required continuation
      // handler now lives in ./daemon/operator-continuation.ts. This thin
      // wrapper threads the per-cycle inputs plus the loop's mutable state —
      // crucially latestSessionId via a live getter (holder/ref, not a
      // snapshot) so runDaemonCodexTurn's session mutation stays observable.
      const handleOperatorRequiredContinuation = (input: {
        directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
        classification: ContinueAnalysisDirectiveClassification;
      }): Promise<DaemonCommandResult | undefined> =>
        handleDaemonOperatorRequiredContinuation(
          {
            directive: input.directive,
            classification: input.classification,
            cycle,
            activeRunId,
            activeTaskId
          },
          {
            operatorActionDir,
            cwd,
            env,
            now,
            workspaceSlug,
            projectSlug,
            cycles,
            getSessionId: () => latestSessionId,
            blockedResult,
            runDaemonCodexTurn
          }
        );
      // Loop-monolith decomposition (6i): the dispatch_reviews handler now lives
      // in ./daemon/review-dispatch.ts. latestSessionId is exposed as a live
      // getter (holder/ref, not a snapshot) so any session write from an earlier
      // codex turn in the same cycle is observable here. The handler only reads
      // the session id — it never writes it back.
      const handleReviewDispatch = (
        directive: Extract<RunExecutionPlan["directive"], { kind: "dispatch_reviews" }>
      ): Promise<DaemonCommandResult | undefined> =>
        handleDaemonReviewDispatchStep(
          {
            directive,
            cycle,
            activeRunId,
            activeTaskId,
            now,
            cwd,
            reviewInputDir
          },
          {
            executeDirectiveStep: options.executeDirectiveStep,
            staleAfterHours,
            cycles,
            getSessionId: () => latestSessionId,
            blockedResult
          }
        );
      // Loop-monolith decomposition (6j): the continue_analysis handler now lives
      // in ./daemon/continue-analysis.ts. Two adjacent if-blocks were merged into
      // one handler returning a THREE-WAY outcome. latestSessionId is exposed as
      // a live getter so any session write from a codex turn is observable.
      const handleContinueAnalysis = (
        directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>
      ): Promise<DaemonContinueAnalysisOutcome> =>
        handleDaemonContinueAnalysisStep(
          {
            directive,
            cycle,
            activeRunId,
            activeTaskId
          },
          {
            executeDirectiveStep: options.executeDirectiveStep,
            getStatusSnapshot: options.getStatusSnapshot,
            getReviews: options.getReviews,
            getApprovals: options.getApprovals,
            upsertCoverageGaps: options.upsertCoverageGaps,
            staleAfterHours,
            env,
            cycles,
            getSessionId: () => latestSessionId,
            blockedResult,
            handleOperatorRequiredContinuation
          }
        );
      // Loop-monolith decomposition (6k): the complete directive handler now lives
      // in ./daemon/complete.ts. classifyAdvanceFailure was MOVED there (to avoid a
      // value cycle) and is re-exported from daemon.ts. latestSessionId is exposed
      // as a live getter (holder/ref) — the handler only reads it, never writes back.

      if (directive.kind === "complete") {
        const completeResult = await handleDaemonCompleteStep(
          { directive, cycle, activeRunId, activeTaskId },
          {
            options,
            workspaceSlug,
            projectSlug,
            projectId: projectContext.project.id,
            cycles,
            getSessionId: () => latestSessionId,
            blockedResult,
            advanceActiveTask: executeAdvanceActiveTaskCommandFromArgs
          }
        );
        if (completeResult !== undefined) return completeResult;
        continue;
      }

      if (directive.kind === "dispatch_reviews") {
        // Loop-monolith decomposition (6i): inline block extracted to
        // ./daemon/review-dispatch.ts — thin wrapper call only.
        const dispatchResult = await handleReviewDispatch(directive);
        if (dispatchResult !== undefined) {
          return dispatchResult;
        }
        continue;
      }

      if (directive.kind === "blocked" || directive.kind === "apply_recovery") {
        return handleDaemonBlockedOrRecoveryStep(
          { directive, cycle, activeRunId, activeTaskId },
          { cycles, getSessionId: () => latestSessionId, blockedResult }
        );
      }

      if (directive.kind === "continue_analysis") {
        const outcome = await handleContinueAnalysis(directive);
        if (outcome.kind === "return") return outcome.result;
        if (outcome.kind === "continue") continue;
        // outcome.kind === "fallthrough": do nothing, proceed to the next if-blocks
      }

      const tailResult = await handleDaemonDispatchOwnerTurnStep(
        { directive, cycle, activeRunId, activeTaskId },
        { attemptRuntimeReconcile, runDaemonCodexTurn, blockedResult, cycles, getSessionId: () => latestSessionId }
      );
      if (tailResult !== undefined) {
        return tailResult;
      }
      // undefined → fall through to the next loop cycle (was: `continue` / natural loop-around)
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
