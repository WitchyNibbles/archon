// Daemon loop, supervisor, CLI session handling, autonomous continuation.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";








import { withClient } from "./admin/db.ts";
import {
  classifyContinueAnalysisDirective,
  type ContinueAnalysisDirectiveClassification
} from "./admin/autonomous-summary.ts";










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
import type { ExecuteDoctorCommandOptions, ExecuteRuntimePreflightCommandOptions, ReconcileRuntimeStateCommandResult } from "./runtime.ts";
import { closeWorkflowProofCoverageGaps, executeWorkflowProofCommandFromArgs } from "./review.ts";
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
        automationEnvelope?: string | undefined;
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
        // Loop-monolith decomposition (6i): inline block extracted to
        // ./daemon/review-dispatch.ts — thin wrapper call only.
        const dispatchResult = await handleReviewDispatch(directive);
        if (dispatchResult !== undefined) {
          return dispatchResult;
        }
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
