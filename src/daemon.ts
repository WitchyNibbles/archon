// Daemon loop, supervisor, CLI session handling, autonomous continuation.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installArchonIntoProject, upgradeArchonInProject, verifyArchonInstall } from "./install/cli.ts";
import { embedQueryText, runEmbeddingJobs, type EmbeddingProvider } from "./runtime/embedding-runner.ts";
import {
  resolveRuntimeEnvironmentConfig,
  runtimeModeFromProfile
} from "./runtime/config.ts";
import { createHashEmbeddingProvider } from "./runtime/hash-embedding-provider.ts";
import { triggerTaskCloseIngestion } from "./runtime/memory-ingestion-pipeline.ts";
import {
  createAnthropicEmbeddingProvider,
  isAnthropicEmbeddingConfigured
} from "./runtime/anthropic-embedding-provider.ts";
import {
  captureRepoMarkdownSnapshot,
  DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS,
  indexRepoMarkdown
} from "./runtime/repo-markdown-indexer.ts";
import {
  inspectRepoContextFreshness,
  probeRepoContextProfile
} from "./runtime/repo-context-profile.ts";
import { loadDotEnv, withClient } from "./admin/db.ts";
import { buildRunEvidenceReport, formatRunEvidenceReportMarkdown } from "./admin/report.ts";
import {
  buildAutonomousOperatorSummary,
  classifyContinueAnalysisDirective,
  resolveContinuationCapabilities,
  selectLocalContinuationProvider,
  type AutonomousContinuationProvider,
  type AutonomousContinuationScheduleKind,
  type AutonomousOperatorSummary,
  type AutonomousWakeOwner,
  type ContinueAnalysisDirectiveClassification
} from "./admin/autonomous-summary.ts";
import {
  buildPlanningContextReport,
  formatPlanningContextReportMarkdown,
  searchLocalWorkflowArtifacts,
  type PlanningContextRepoContextState,
  type PlanningContextRetrievalState
} from "./admin/planning-context.ts";
import { dispatchGithubWorkItem } from "./admin/github-dispatch.ts";
import { buildOperatorDashboardReport, formatOperatorDashboardReport } from "./admin/ops.ts";
import { inspectGraphifyStatus, type GraphifyStatusObservation } from "./admin/graphify.ts";
import {
  buildOperatorStatusReport,
  type DaemonContinuationStatusObservation,
  type DaemonOperatorHandoffObservation,
  type DaemonSupervisorStatusObservation,
  type ReviewIdentityStatusObservation
} from "./admin/status.ts";
import { parseExportDocsRequest } from "./docs-export/parser.ts";
import { resolveObsidianConfig, validateObsidianConfig } from "./docs-export/obsidian-config.ts";
import { exportTaskToObsidian } from "./export/obsidian-exporter.ts";
import { DocsSummarizer } from "./docs-export/summarizer.ts";
import { ObsidianMarkdownRenderer } from "./docs-export/renderer.ts";
import { ObsidianVaultWriter } from "./docs-export/obsidian-writer.ts";
import { buildObsidianTargetPath } from "./docs-export/targets.ts";
import { RuntimeWorklogProvider, type WorklogProvider } from "./docs-export/worklog-provider.ts";
import {
  advanceTaskQueue,
  repairTaskQueueContent,
  deriveTaskQueueEvidence,
  parseTaskQueueContent,
  type TaskQueue
} from "./archon/task-queue.ts";
import {
  effectiveRequiredReviews,
  isGateReviewRole,
  isPlaywrightRequiredForTask,
  isRetrievalRole,
  isReviewSeverity,
  isReviewState
} from "./domain/contracts.ts";
import { analysisPhases } from "./domain/types.ts";
import {
  createReviewActionContextResolver,
  createReviewPrincipalAdapter,
  loadReviewIdentityBindings,
  loadReviewIdentityFixtures,
  verifyReviewIdentityAdapter,
  type AuthenticatedPrincipal,
  type ReviewPrincipalAdapter
} from "./core/review-context.ts";
import {
  ArchonCoreService,
  type DirectiveExecutionResult,
  type ExecuteDirectiveStepOptions
} from "./core/service.ts";
import { evaluateReviewDecision } from "./core/policy.ts";
import { compareMemorySearchResults } from "./core/policy.ts";
import type { ResolveReviewActionContext } from "./core/review-context.ts";
import { annotateConflictSignals } from "./core/search-memory-results.ts";
import type {
  ApprovalRecord,
  AutonomousExecutionState,
  CheckpointRecord,
  ContinuationAction,
  CoverageGapRecord,
  CoverageItemRecord,
  HandoffInput,
  IntakeRequestInput,
  ProjectRuntimeStateRecord,
  ProgressProofRecord,
  RecoveryApplyResult,
  RecoveryInspectionReport,
  ProjectRecord,
  ReviewInput,
  ReviewRecord,
  RuntimeMigrationJournalRecord,
  RuntimeProjectRegistrationRecord,
  RoutingRecommendationReport,
  RunExecutionPlan,
  RunRecord,
  RetrievalRole,
  SearchMemoryResult,
  RunStatusSnapshot,
  TaskPacketInput,
  TaskStatus
} from "./domain/types.ts";
import type { WorkspaceRecord } from "./domain/types.ts";
import type { ExportDocsCommandResult } from "./docs-export/models.ts";
import { PostgresStore, PostgresMistakeLedgerStore } from "./store/postgres-store.ts";
import type { ArchonStore as ArchonStoreContract } from "./store/types.ts";
import { INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN, MAX_DAEMON_STAGNANT_TURNS, buildDefaultProductState, buildDefaultTaskQueue, buildDirectiveProgressFingerprint, collectCommandFlagValues, executeAdvanceActiveTaskCommandFromArgs, isSelfReferentialResumeTarget, resolveCommandFlag, resolveFormatFlag, resolveRunIdForCommand, validateResumeTargetSource } from "./workflow.ts";
import type { EnvShape, ExecuteAdvanceActiveTaskCommandOptions, ExecuteStatusCommandOptions } from "./workflow.ts";
import { buildRuntimeExecutionConnectionFailure, executeReconcileRuntimeStateCommandFromArgs, executeRuntimeExecutionPreflight, formatRuntimeExecutionPreflightFailureResult, isRuntimeExecutionPreflightConnectionError } from "./runtime.ts";
import type { ExecuteDoctorCommandOptions, ExecuteRuntimePreflightCommandOptions, ReconcileRuntimeStateCommandResult } from "./runtime.ts";
import { bindingsUsePlaceholderContent, closeWorkflowProofCoverageGaps, createLiveReviewIdentityAdapter, executeRecordReviewCommand, executeWorkflowProofCommandFromArgs, isRepoTemplateReviewIdentityPath, normalizeRecordReviewCommandInput, parseExpectedReviewTarget, resolveRequiredReviewIdentityFilePath } from "./review.ts";
import type { ExecuteRecordReviewCommandFromArgsOptions, ExecuteRecordReviewCommandOptions, RecordReviewCommandInput, RecordReviewCommandResult } from "./review.ts";
import { AgentRuntimeStore } from "./store/agent-runtime-store.ts";
import { AgenticLoopController } from "./runtime/agentic-loop.ts";
import { ContinuationContextBuilder } from "./runtime/continuation-context.ts";
import { recoverOrphanedInvocations } from "./runtime/crash-recovery.ts";
import { resolveArchonContextPolicy } from "./runtime/context-budget.ts";


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


export interface SupervisorActionRecord {
  cycle: number;
  action:
    | "enqueue_operator_continuation"
    | "enqueue_review_action"
    | "materialize_app_automation"
    | "materialize_cli_scheduler";
  targetId?: string | undefined;
  taskId?: string | undefined;
  reviewRole?: ReviewRecord["reviewerRole"] | undefined;
  filePath: string;
  summary: string;
}


export interface SupervisorCommandResult {
  authorityLabel: "derived_only";
  workspaceSlug: string;
  projectSlug: string;
  status: "completed" | "blocked" | "max_cycles_reached";
  reason: string;
  activeRunId: string | null;
  activeTaskId: string | null;
  sessionId: string | null;
  daemonRuns: DaemonCommandResult[];
  actions: SupervisorActionRecord[];
}


export interface SupervisorHistoryCommandResult {
  authorityLabel: "derived_only";
  historyPath: string;
  scope: "run" | "all";
  runId?: string | undefined;
  retainedCount: number;
  filteredCount: number;
  returnedCount: number;
  truncated: boolean;
  entries: DaemonSupervisorStatusObservation["history"];
  latestStatus?:
    | Pick<
        DaemonSupervisorStatusObservation,
        | "state"
        | "blockerKind"
        | "reason"
        | "activeRunId"
        | "activeTaskId"
        | "sessionId"
        | "supervisorCycles"
        | "updatedAt"
      >
    | undefined;
}


export interface RunCodexTurnInput {
  claudeBin: string;
  cwd: string;
  env: EnvShape;
  prompt: string;
  sessionId?: string | undefined;
}


export interface RunCodexTurnResult {
  sessionId?: string | undefined;
  finalMessage?: string | undefined;
  stdout: string;
  stderr: string;
  exitCode: number;
}


export type DaemonPromptMode = "full" | "delta";


export type DaemonPromptContinuationAction =
  | { kind: "run_workflow_proof"; taskId: string }
  | { kind: "resolve_blocking_gap"; gapId: string; targetId: string }
  | {
      kind: "resume_target";
      targetId: string;
      source?: "blocking_gap" | "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
    };


export type DaemonPromptDirective =
  | RunExecutionPlan["directive"]
  | {
      kind: "continue_analysis";
      targetId: string;
      actions: DaemonPromptContinuationAction[];
    }
  | {
      kind: "dispatch_owner";
      rationale: string[];
    };


export interface ParsedDaemonTurnMessage {
  summary: string;
  status: "completed" | "blocked" | "needs_review" | "needs_followup";
  blockers: string[];
  checkpoint?: {
    evidenceRefs: string[];
    nextActions: string[];
    activeTargets: string[];
    openGaps: string[];
    compressedContextSummary?: string | undefined;
    compressedContextRef?: string | undefined;
    compressedContextSourceRefs: string[];
  } | undefined;
  scopeRequest?: {
    blockedPaths: string[];
    requestedWriteScope: string[];
    reason?: string | undefined;
  } | undefined;
}


export interface DaemonStagnationMetadata {
  runId: string;
  taskId: string;
  directiveKind: RunExecutionPlan["directive"]["kind"];
  progressKey: string;
  count: number;
  updatedAt: string;
  lastStatus?: ParsedDaemonTurnMessage["status"] | undefined;
  lastSummary?: string | undefined;
  lastBlockers?: string[] | undefined;
}


export interface DaemonPromptMetadata {
  taskId?: string | undefined;
  packetFingerprint?: string | undefined;
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


export interface ExecuteSupervisorCommandOptions extends ExecuteDaemonCommandOptions {}


export interface ExecuteSupervisorHistoryCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  findLatestRun?: ((workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>) | undefined;
}


export function resolveDaemonSupervisorHistoryReadOptions(
  args: readonly string[],
  env: EnvShape | undefined,
  defaultRunId: string
): DaemonSupervisorHistoryReadOptions {
  const limitValue =
    resolveCommandFlag(args, "--daemon-supervisor-history-limit") ??
    env?.ARCHON_DAEMON_SUPERVISOR_HISTORY_LIMIT ??
    "5";
  const limit = Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Invalid --daemon-supervisor-history-limit value: ${limitValue}`);
  }

  const scopeValue =
    resolveCommandFlag(args, "--daemon-supervisor-history-scope") ??
    env?.ARCHON_DAEMON_SUPERVISOR_HISTORY_SCOPE ??
    "run";
  if (scopeValue !== "run" && scopeValue !== "all") {
    throw new Error(`Invalid --daemon-supervisor-history-scope value: ${scopeValue}`);
  }

  const runId =
    resolveCommandFlag(args, "--daemon-supervisor-history-run-id") ??
    env?.ARCHON_DAEMON_SUPERVISOR_HISTORY_RUN_ID ??
    defaultRunId;

  return {
    limit,
    scope: scopeValue,
    runId: scopeValue === "run" ? runId : undefined
  };
}


export function resolveSupervisorHistoryRetentionLimit(args: readonly string[], env: EnvShape | undefined): number {
  const retentionValue =
    resolveCommandFlag(args, "--supervisor-history-retention") ??
    env?.ARCHON_SUPERVISOR_HISTORY_RETENTION ??
    "200";
  const retentionLimit = Number.parseInt(retentionValue, 10);
  if (!Number.isInteger(retentionLimit) || retentionLimit <= 0) {
    throw new Error(`Invalid --supervisor-history-retention value: ${retentionValue}`);
  }
  return retentionLimit;
}


export function readDaemonSessionId(metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined): string | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const sessionId = (candidate as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : undefined;
}


export function readDaemonPromptMetadata(
  metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined
): DaemonPromptMetadata | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const taskId =
    typeof record.lastPromptTaskId === "string" && record.lastPromptTaskId.trim().length > 0
      ? record.lastPromptTaskId.trim()
      : undefined;
  const packetFingerprint =
    typeof record.lastPromptPacketFingerprint === "string" && record.lastPromptPacketFingerprint.trim().length > 0
      ? record.lastPromptPacketFingerprint.trim()
      : undefined;

  if (!taskId && !packetFingerprint) {
    return undefined;
  }

  return {
    taskId,
    packetFingerprint
  };
}


export function readDaemonStagnationMetadata(
  metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined
): DaemonStagnationMetadata | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const stagnation = (candidate as Record<string, unknown>).stagnation;
  if (!stagnation || typeof stagnation !== "object" || Array.isArray(stagnation)) {
    return undefined;
  }

  const record = stagnation as Record<string, unknown>;
  const runId = typeof record.runId === "string" && record.runId.trim().length > 0 ? record.runId.trim() : undefined;
  const taskId = typeof record.taskId === "string" && record.taskId.trim().length > 0 ? record.taskId.trim() : undefined;
  const directiveKind =
    record.directiveKind === "complete" ||
    record.directiveKind === "dispatch_owner" ||
    record.directiveKind === "dispatch_reviews" ||
    record.directiveKind === "apply_recovery" ||
    record.directiveKind === "dispatch_subagents" ||
    record.directiveKind === "rebuild_inventory" ||
    record.directiveKind === "trace_runtime" ||
    record.directiveKind === "checkpoint" ||
    record.directiveKind === "replan_migration" ||
    record.directiveKind === "continue_analysis" ||
    record.directiveKind === "blocked"
      ? record.directiveKind
      : undefined;
  const progressKey =
    typeof record.progressKey === "string" && record.progressKey.trim().length > 0 ? record.progressKey.trim() : undefined;
  const count = typeof record.count === "number" && Number.isInteger(record.count) && record.count > 0 ? record.count : undefined;
  if (!runId || !taskId || !directiveKind || !progressKey || !count) {
    return undefined;
  }

  const status =
    record.lastStatus === "completed" ||
    record.lastStatus === "blocked" ||
    record.lastStatus === "needs_review" ||
    record.lastStatus === "needs_followup"
      ? record.lastStatus
      : undefined;

  return {
    runId,
    taskId,
    directiveKind,
    progressKey,
    count,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    lastStatus: status,
    lastSummary: typeof record.lastSummary === "string" ? record.lastSummary : undefined,
    lastBlockers: Array.isArray(record.lastBlockers)
      ? record.lastBlockers.filter((value): value is string => typeof value === "string")
      : undefined
  };
}


export function parseDaemonTurnMessage(message: string | undefined): ParsedDaemonTurnMessage | undefined {
  if (!message) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : undefined;
    const status =
      parsed.status === "completed" ||
      parsed.status === "blocked" ||
      parsed.status === "needs_review" ||
      parsed.status === "needs_followup"
        ? parsed.status
        : undefined;
    const blockers = Array.isArray(parsed.blockers)
      ? parsed.blockers.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const scopeRequestCandidate =
      parsed.scope_request && typeof parsed.scope_request === "object" && !Array.isArray(parsed.scope_request)
        ? (parsed.scope_request as Record<string, unknown>)
        : undefined;
    const blockedPaths = Array.isArray(scopeRequestCandidate?.blocked_paths)
      ? scopeRequestCandidate.blocked_paths.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const requestedWriteScope = Array.isArray(scopeRequestCandidate?.requested_write_scope)
      ? scopeRequestCandidate.requested_write_scope.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointCandidate =
      parsed.checkpoint && typeof parsed.checkpoint === "object" && !Array.isArray(parsed.checkpoint)
        ? (parsed.checkpoint as Record<string, unknown>)
        : undefined;
    const checkpointEvidenceRefs = Array.isArray(checkpointCandidate?.evidence_refs)
      ? checkpointCandidate.evidence_refs.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointNextActions = Array.isArray(checkpointCandidate?.next_actions)
      ? checkpointCandidate.next_actions.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointActiveTargets = Array.isArray(checkpointCandidate?.active_targets)
      ? checkpointCandidate.active_targets.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointOpenGaps = Array.isArray(checkpointCandidate?.open_gaps)
      ? checkpointCandidate.open_gaps.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointCompressedContextSourceRefs = Array.isArray(checkpointCandidate?.compressed_context_source_refs)
      ? checkpointCandidate.compressed_context_source_refs.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpoint =
      checkpointCandidate && checkpointEvidenceRefs.length > 0
        ? {
            evidenceRefs: checkpointEvidenceRefs,
            nextActions: checkpointNextActions,
            activeTargets: checkpointActiveTargets,
            openGaps: checkpointOpenGaps,
            compressedContextSummary:
              typeof checkpointCandidate.compressed_context_summary === "string" &&
                checkpointCandidate.compressed_context_summary.trim().length > 0
                ? checkpointCandidate.compressed_context_summary.trim()
                : undefined,
            compressedContextRef:
              typeof checkpointCandidate.compressed_context_ref === "string" &&
                checkpointCandidate.compressed_context_ref.trim().length > 0
                ? checkpointCandidate.compressed_context_ref.trim()
                : undefined,
            compressedContextSourceRefs: checkpointCompressedContextSourceRefs
          }
        : undefined;
    const scopeRequest =
      blockedPaths.length > 0 || requestedWriteScope.length > 0
        ? {
            blockedPaths,
            requestedWriteScope,
            reason:
              typeof scopeRequestCandidate?.reason === "string" && scopeRequestCandidate.reason.trim().length > 0
                ? scopeRequestCandidate.reason.trim()
                : undefined
          }
        : undefined;

    if (!summary || !status) {
      return undefined;
    }

    return {
      summary,
      status,
      blockers,
      checkpoint,
      scopeRequest
    };
  } catch {
    return undefined;
  }
}


export function buildDaemonProgressKey(input: {
  runtimeState: ProjectRuntimeStateRecord | undefined;
  snapshot: RunStatusSnapshot;
  directive: RunExecutionPlan["directive"];
  activeTaskId: string;
}): string {
  const activeTask = input.snapshot.tasks.find((task) => task.packet.taskId === input.activeTaskId);
  return JSON.stringify({
    runtimeActiveRunId: input.runtimeState?.activeRunId ?? null,
    runtimeActiveTaskId: input.runtimeState?.activeTaskId ?? null,
    runStatus: input.snapshot.run.status,
    activeTaskStatus: activeTask?.status ?? null,
    activeTaskUpdatedAt: activeTask?.updatedAt ?? null,
    autonomousUpdatedAt: input.snapshot.autonomousExecution?.state.updatedAt ?? null,
    lastCheckpointId: input.snapshot.autonomousExecution?.state.lastCheckpointId ?? null,
    lastProgressProofId: input.snapshot.autonomousExecution?.state.lastProgressProofId ?? null,
    directive: buildDirectiveProgressFingerprint(input.directive)
  });
}


export async function persistDaemonTurnCheckpoint(input: {
  runId: string;
  taskId: string;
  snapshot: RunStatusSnapshot;
  message: ParsedDaemonTurnMessage | undefined;
  checkpointRun?: ExecuteDaemonCommandOptions["checkpointRun"];
  now: () => Date;
}): Promise<string | undefined> {
  if (
    !input.message?.checkpoint ||
    !input.checkpointRun ||
    (input.message.status !== "needs_followup" && input.message.status !== "needs_review")
  ) {
    return undefined;
  }

  const createdAt = input.now().toISOString();
  const checkpointId = `cp-daemon-${input.taskId}-${createdAt.replace(/[:.]/g, "-")}`;
  const phase: CheckpointRecord["phase"] = input.snapshot.autonomousExecution?.state.phase ?? "implementation";
  const checkpoint = input.message.checkpoint;

  await input.checkpointRun(
    input.runId,
    {
      checkpointId,
      phase,
      activeTargets: [...checkpoint.activeTargets],
      recentEvidenceRefs: [...checkpoint.evidenceRefs],
      openGaps: [...checkpoint.openGaps],
      nextActions:
        checkpoint.nextActions.length > 0 ? [...checkpoint.nextActions] : [`continue ${input.taskId}`],
      compressedContextRef: checkpoint.compressedContextRef,
      compressedContextSummary: checkpoint.compressedContextSummary ?? input.message.summary,
      compressedContextSourceRefs:
        checkpoint.compressedContextSourceRefs.length > 0
          ? [...checkpoint.compressedContextSourceRefs]
          : [...checkpoint.evidenceRefs],
      createdAt
    },
    {
      authorityLabel: "runtime_authoritative"
    }
  );

  return checkpointId;
}


export function daemonMessageHasScopeConflict(message: ParsedDaemonTurnMessage | undefined): boolean {
  if (!message) {
    return false;
  }

  const combined = [message.summary, ...message.blockers].join("\n");
  return /\bout of scope\b|\bwrite scope\b|\bscope mismatch\b|\boutside the allowed scope\b/i.test(combined);
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


export function parseClaudeStreamJsonOutput(
  stdout: string,
  initialSessionId?: string | undefined
): { sessionId: string | undefined; finalMessage: string | undefined } {
  let sessionId = initialSessionId;
  let finalMessage: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Fail closed: skip unparseable lines rather than throwing
      continue;
    }

    const eventType = event.type;
    if (eventType === "system") {
      if (typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
    } else if (eventType === "assistant") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
              finalMessage = b.text.trim();
            }
          }
        }
      }
    } else if (eventType === "result") {
      if (typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
      if (typeof event.result === "string" && event.result.trim().length > 0) {
        finalMessage = event.result.trim();
      }
    }
    // Unknown event types are intentionally ignored to stay forward-compatible
  }
  return { sessionId, finalMessage };
}


export async function runCodexTurnViaCli(input: RunCodexTurnInput): Promise<RunCodexTurnResult> {
  const args = input.sessionId
    ? ["--resume", input.sessionId, "-p", input.prompt, "--output-format", "stream-json"]
    : ["-p", input.prompt, "--output-format", "stream-json"];

  const child = spawn(input.claudeBin, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const reason = stderr.trim() || stdout.trim() || `claude -p exited with code ${exitCode}`;
    throw new Error(`claude -p failed: ${reason}`);
  }

  const { sessionId, finalMessage } = parseClaudeStreamJsonOutput(stdout, input.sessionId);
  return { sessionId, finalMessage, stdout, stderr, exitCode };
}


export function buildDaemonTaskPacketFingerprint(packet: TaskPacketInput | undefined): string | undefined {
  if (!packet) {
    return undefined;
  }

  const fingerprintSource = {
    taskId: packet.taskId,
    goal: packet.goal ?? null,
    allowedWriteScope: packet.allowedWriteScope ?? [],
    acceptanceCriteria: packet.acceptanceCriteria ?? [],
    verificationSteps: packet.verificationSteps ?? [],
    requiredReviews: packet.requiredReviews ?? []
  };

  return createHash("sha256").update(JSON.stringify(fingerprintSource)).digest("hex");
}


export function determineDaemonPromptMode(input: {
  sessionId?: string | undefined;
  previousTaskId?: string | undefined;
  previousPacketFingerprint?: string | undefined;
  taskId: string;
  packetFingerprint?: string | undefined;
}): DaemonPromptMode {
  if (!input.sessionId || !input.packetFingerprint) {
    return "full";
  }

  if (
    input.previousTaskId === input.taskId &&
    input.previousPacketFingerprint === input.packetFingerprint
  ) {
    return "delta";
  }

  return "full";
}


export function buildDaemonTaskPrompt(input: {
  promptMode: DaemonPromptMode;
  directive: DaemonPromptDirective;
  taskId: string;
  packet?: TaskPacketInput | undefined;
  operatorNotes?: string | undefined;
  compressedContextSummary?: string | undefined;
  compressedContextRef?: string | undefined;
}): string {
  const packet = input.packet;
  const baseLines = [
    input.promptMode === "delta"
      ? "Continue the active archon worker session for the current task."
      : "Operate as the active archon worker for the current task.",
    `Active task: ${input.taskId}`,
    `Directive: ${input.directive.kind}`,
    packet?.goal ? `Goal: ${packet.goal}` : undefined,
    packet?.allowedWriteScope?.length ? `Allowed write scope: ${packet.allowedWriteScope.join(", ")}` : undefined
  ];

  const detailLines =
    input.promptMode === "full"
      ? [
          packet?.acceptanceCriteria?.length
            ? `Acceptance criteria: ${packet.acceptanceCriteria.join(" | ")}`
            : undefined,
          packet?.verificationSteps?.length
            ? `Verification steps: ${packet.verificationSteps.join(" | ")}`
            : undefined,
          packet?.requiredReviews?.length
            ? `Required reviews: ${packet.requiredReviews.join(", ")}`
            : undefined
        ]
      : [
          "Previously bootstrapped task requirements remain in force unless explicitly updated below.",
          input.compressedContextSummary
            ? `Compressed context: ${input.compressedContextSummary}`
            : undefined,
          input.compressedContextRef ? `Compressed context ref: ${input.compressedContextRef}` : undefined
        ];

  const guidanceLines = [
    "Follow the repository CLAUDE.md and the archon workflow.",
    "Use runtime-backed archon commands when they are needed for proof, status, or advancement.",
    "Scale, latency, or item volume are not blockers by themselves when the task can be chunked and resumed.",
    "If you make tractable progress without finishing, return status needs_followup and include checkpoint.evidence_refs plus a compressed checkpoint summary so the daemon can persist progress and continue.",
    input.promptMode === "delta"
      ? "If scope blocks the next required edit, stop immediately and return the minimum safe scope_request delta."
      : "If a required edit falls outside the allowed write scope, stop immediately, name the exact blocked paths, and include a scope_request with blocked_paths, requested_write_scope, and a short reason describing the minimum safe scope expansion.",
    "Do not spend another turn repeating the same blocked attempt when runtime state has not changed.",
    "Complete the task if possible; otherwise stop at the real blocker and state it explicitly.",
    input.operatorNotes ? `Operator notes: ${input.operatorNotes}` : undefined,
    input.directive.kind === "continue_analysis"
      ? `Autonomous target: ${input.directive.targetId}. Typed continuation actions: ${input.directive.actions.map(formatContinuationAction).join(" | ")}`
      : undefined,
    input.directive.kind === "dispatch_owner"
      ? `Owner rationale: ${input.directive.rationale.join(" | ")}`
      : undefined
  ];

  const lines = [...baseLines, ...detailLines, ...guidanceLines].filter(
    (value): value is string => Boolean(value)
  );

  return lines.join("\n");
}


export function formatContinuationAction(action: DaemonPromptContinuationAction): string {
  if (action.kind === "run_workflow_proof") {
    return `run_workflow_proof(${action.taskId})`;
  }
  if (action.kind === "resolve_blocking_gap") {
    return `resolve_blocking_gap(${action.gapId} -> ${action.targetId})`;
  }
  return `resume_target(${action.targetId})`;
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


export async function readLoopReviewCommandInputs(
  args: readonly string[],
  options: {
    cwd?: string | undefined;
  } = {}
): Promise<readonly RecordReviewCommandInput[]> {
  const cwd = options.cwd ?? process.cwd();
  const inputArgs = collectCommandFlagValues(args, "--review-input");

  return Promise.all(
    inputArgs.map(async (inputArg) => {
      const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(cwd, inputArg);
      return normalizeRecordReviewCommandInput(await readFile(inputPath, "utf8"));
    })
  );
}


export interface DaemonReviewQueueEntry {
  filePath: string;
  command: RecordReviewCommandInput;
}


export interface FailedDaemonReviewQueueEntry {
  filePath: string;
  error: string;
}


export interface StaleDaemonReviewQueueEntry {
  filePath: string;
  reason: string;
}


export interface OperatorContinuationActionCommand {
  runId: string;
  taskId: string;
  blockerKind: "operator_required_continuation";
  action: {
    kind: "continue_with_analysis";
    targetId: string;
    source?: "blocking_gap" | "progress_proof" | "checkpoint" | undefined;
    sourceId?: string | undefined;
    operatorNotes: string;
  };
}


export interface DaemonOperatorActionQueueEntry {
  filePath: string;
  command: OperatorContinuationActionCommand;
}


export interface FailedDaemonOperatorActionQueueEntry {
  filePath: string;
  error: string;
}


export function resolveDaemonReviewInputDir(args: readonly string[], options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicit = resolveCommandFlag(args, "--review-input-dir") ?? env.ARCHON_REVIEW_INPUT_DIR;
  const candidate = explicit ?? path.join(".archon", "review-actions");
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}


export function resolveDaemonOperatorActionDir(args: readonly string[], options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicit = resolveCommandFlag(args, "--operator-action-dir") ?? env.ARCHON_OPERATOR_ACTION_DIR;
  const candidate = explicit ?? path.join(".archon", "operator-actions");
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}


export function normalizeOperatorContinuationActionCommand(raw: string): OperatorContinuationActionCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`operator action input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("operator action input must be a JSON object");
  }

  const candidate = parsed as Record<string, unknown>;
  const runId = typeof candidate.runId === "string" && candidate.runId.trim().length > 0 ? candidate.runId.trim() : undefined;
  const taskId = typeof candidate.taskId === "string" && candidate.taskId.trim().length > 0 ? candidate.taskId.trim() : undefined;
  if (!runId) {
    throw new Error("operator action runId is required");
  }
  if (!taskId) {
    throw new Error("operator action taskId is required");
  }
  if (candidate.blockerKind !== "operator_required_continuation") {
    throw new Error("operator action blockerKind must be operator_required_continuation");
  }
  const action = candidate.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("operator action payload is required");
  }
  const actionCandidate = action as Record<string, unknown>;
  if (actionCandidate.kind !== "continue_with_analysis") {
    throw new Error("operator action kind must be continue_with_analysis");
  }
  const targetId =
    typeof actionCandidate.targetId === "string" && actionCandidate.targetId.trim().length > 0
      ? actionCandidate.targetId.trim()
      : undefined;
  const source =
    actionCandidate.source === "blocking_gap" ||
    actionCandidate.source === "progress_proof" ||
    actionCandidate.source === "checkpoint"
      ? actionCandidate.source
      : undefined;
  const sourceId =
    typeof actionCandidate.sourceId === "string" && actionCandidate.sourceId.trim().length > 0
      ? actionCandidate.sourceId.trim()
      : undefined;
  const operatorNotes =
    typeof actionCandidate.operatorNotes === "string" && actionCandidate.operatorNotes.trim().length > 0
      ? actionCandidate.operatorNotes.trim()
      : undefined;
  if (!targetId) {
    throw new Error("operator action action.targetId is required");
  }
  if (!operatorNotes) {
    throw new Error("operator action action.operatorNotes is required");
  }

  return {
    runId,
    taskId,
    blockerKind: "operator_required_continuation",
    action: {
      kind: "continue_with_analysis",
      targetId,
      source,
      sourceId,
      operatorNotes
    }
  };
}


export async function readDaemonReviewQueueState(reviewInputDir: string): Promise<{
  entries: DaemonReviewQueueEntry[];
  failedEntries: FailedDaemonReviewQueueEntry[];
}> {
  let entries: string[] = [];
  try {
    entries = await readdir(reviewInputDir);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { entries: [], failedEntries: [] };
    }
    throw error;
  }

  const queueEntries: DaemonReviewQueueEntry[] = [];
  const failedEntries: FailedDaemonReviewQueueEntry[] = [];

  for (const entry of entries.filter((candidate) => candidate.endsWith(".json")).sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(reviewInputDir, entry);
    try {
      queueEntries.push({
        filePath,
        command: normalizeRecordReviewCommandInput(await readFile(filePath, "utf8"))
      });
    } catch (error) {
      failedEntries.push({
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    entries: queueEntries,
    failedEntries
  };
}


export async function readDaemonOperatorActionQueueState(operatorActionDir: string): Promise<{
  entries: DaemonOperatorActionQueueEntry[];
  failedEntries: FailedDaemonOperatorActionQueueEntry[];
}> {
  let entries: string[] = [];
  try {
    entries = await readdir(operatorActionDir);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { entries: [], failedEntries: [] };
    }
    throw error;
  }

  const queueEntries: DaemonOperatorActionQueueEntry[] = [];
  const failedEntries: FailedDaemonOperatorActionQueueEntry[] = [];

  for (const entry of entries.filter((candidate) => candidate.endsWith(".json")).sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(operatorActionDir, entry);
    try {
      queueEntries.push({
        filePath,
        command: normalizeOperatorContinuationActionCommand(await readFile(filePath, "utf8"))
      });
    } catch (error) {
      failedEntries.push({
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    entries: queueEntries,
    failedEntries
  };
}


export async function archiveConsumedDaemonReviewQueueEntries(
  consumedEntries: readonly DaemonReviewQueueEntry[],
  cwd: string
): Promise<void> {
  if (consumedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "processed-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of consumedEntries) {
    const archivedPath = path.join(archiveDir, path.basename(entry.filePath));
    await rename(entry.filePath, archivedPath);
  }
}


export async function archiveConsumedDaemonOperatorActionQueueEntries(
  consumedEntries: readonly DaemonOperatorActionQueueEntry[],
  cwd: string
): Promise<void> {
  if (consumedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "processed-operator-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of consumedEntries) {
    const archivedPath = path.join(archiveDir, path.basename(entry.filePath));
    await rename(entry.filePath, archivedPath);
  }
}


export async function archiveFailedDaemonReviewQueueEntries(
  failedEntries: readonly FailedDaemonReviewQueueEntry[],
  cwd: string,
  nowValue: string
): Promise<void> {
  if (failedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "failed-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of failedEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.error.json`),
      `${JSON.stringify(
        {
          file: baseName,
          error: entry.error,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}


export async function archiveFailedDaemonOperatorActionQueueEntries(
  failedEntries: readonly FailedDaemonOperatorActionQueueEntry[],
  cwd: string,
  nowValue: string
): Promise<void> {
  if (failedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "failed-operator-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of failedEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.error.json`),
      `${JSON.stringify(
        {
          file: baseName,
          error: entry.error,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}


export function matchesDaemonOperatorContinuationAction(input: {
  entry: DaemonOperatorActionQueueEntry;
  runId: string;
  taskId: string;
  directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
  classification: ContinueAnalysisDirectiveClassification;
}): boolean {
  if (
    input.entry.command.runId !== input.runId ||
    input.entry.command.taskId !== input.taskId ||
    input.entry.command.blockerKind !== "operator_required_continuation"
  ) {
    return false;
  }

  if (input.entry.command.action.targetId !== input.directive.targetId) {
    return false;
  }

  if (input.entry.command.action.source && input.entry.command.action.source !== input.directive.source) {
    return false;
  }

  const expectedSourceId =
    input.classification.action?.kind === "resume_target" ? input.classification.action.sourceId : undefined;
  if ((input.entry.command.action.sourceId ?? undefined) !== (expectedSourceId ?? undefined)) {
    return false;
  }

  return true;
}


export async function archiveStaleDaemonReviewQueueEntries(
  staleEntries: readonly StaleDaemonReviewQueueEntry[],
  cwd: string,
  nowValue: string,
  expectedReviewTargets: readonly string[]
): Promise<void> {
  if (staleEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "stale-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of staleEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.reason.json`),
      `${JSON.stringify(
        {
          file: baseName,
          reason: entry.reason,
          expectedReviewTargets,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}


export async function writeDaemonReviewQueueStatus(
  cwd: string,
  status: {
    state: "processed" | "blocked" | "failed";
    reviewInputDir: string;
    reason: string;
    expectedReviewTargets?: string[] | undefined;
    queuedFiles?: string[] | undefined;
    consumedFiles?: string[] | undefined;
    failedFiles?: { file: string; error: string }[] | undefined;
    staleFiles?: { file: string; reason: string }[] | undefined;
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "review-queue-status.json"),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8"
  );
}


export async function writeDaemonContinuationStatus(
  cwd: string,
  status: {
    state: "blocked";
    directiveKind: "continue_analysis";
    executionMode: "operator_required";
    targetId: string;
    source: "blocking_gap" | "progress_proof" | "checkpoint";
    sourceId?: string | undefined;
    actionKind?: ContinuationAction["kind"] | undefined;
    provider?: AutonomousContinuationProvider | undefined;
    wakeOwner?: AutonomousWakeOwner | undefined;
    scheduleKind?: AutonomousContinuationScheduleKind | undefined;
    schedule?: string | undefined;
    summary: string;
    nextActions: string[];
    blockers: string[];
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "continuation-status.json"),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8"
  );
}


export async function writeDaemonAutomationEnvelope(
  cwd: string,
  envelope: {
    provider: Exclude<AutonomousContinuationProvider, "none" | "manual_operator_handoff">;
    wakeOwner: "operator";
    continuationIntent: "defer_same_thread" | "defer_fresh_run";
    targetMode: "same_thread" | "fresh_run";
    scheduleKind: Exclude<AutonomousContinuationScheduleKind, "none" | "manual">;
    schedule: string;
    targetId: string;
    source: "progress_proof" | "checkpoint";
    sourceId?: string | undefined;
    summary: string;
    nextActions: string[];
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string;
    activeTaskId: string;
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "automation-envelope.json"),
    `${JSON.stringify(envelope, null, 2)}\n`,
    "utf8"
  );
}


export async function clearDaemonContinuationStatus(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "continuation-status.json"), {
    force: true
  });
}


export async function clearDaemonAutomationEnvelope(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "automation-envelope.json"), {
    force: true
  });
}


const DAEMON_CONTINUATION_CONTEXT_RELATIVE_PATH =
  ".archon/work/daemon/continuation-context.txt";


/**
 * Persist the compact continuation bundle so it survives until the next
 * invocation consumes it. The agentic loop builds this bundle when it dispatches
 * a task owner; without persistence the prompt would be discarded and the
 * continuation would lose its runtime-authoritative context (AC5/FR-11).
 */
export async function writeDaemonContinuationContext(
  cwd: string,
  continuationPrompt: string
): Promise<string> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(cwd, DAEMON_CONTINUATION_CONTEXT_RELATIVE_PATH),
    `${continuationPrompt.trim()}\n`,
    "utf8"
  );
  return DAEMON_CONTINUATION_CONTEXT_RELATIVE_PATH;
}


/** Read the persisted continuation bundle, or undefined when none exists. */
export async function readDaemonContinuationContext(
  cwd: string
): Promise<string | undefined> {
  try {
    const raw = await readFile(
      path.join(cwd, DAEMON_CONTINUATION_CONTEXT_RELATIVE_PATH),
      "utf8"
    );
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}


/** Remove the persisted continuation bundle once it has been consumed. */
export async function clearDaemonContinuationContext(cwd: string): Promise<void> {
  await rm(path.join(cwd, DAEMON_CONTINUATION_CONTEXT_RELATIVE_PATH), {
    force: true
  });
}


export async function readDaemonAutomationEnvelope(
  cwd: string
): Promise<
  | {
      provider: Exclude<AutonomousContinuationProvider, "none" | "manual_operator_handoff">;
      wakeOwner: "operator";
      continuationIntent: "defer_same_thread" | "defer_fresh_run";
      targetMode: "same_thread" | "fresh_run";
      scheduleKind: Exclude<AutonomousContinuationScheduleKind, "none" | "manual">;
      schedule: string;
      targetId: string;
      source: "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
      summary: string;
      nextActions: string[];
      workspaceSlug: string;
      projectSlug: string;
      activeRunId: string;
      activeTaskId: string;
      updatedAt?: string | undefined;
    }
  | undefined
> {
  const envelopePath = path.join(cwd, ".archon", "work", "daemon", "automation-envelope.json");
  let raw: string;
  try {
    raw = await readFile(envelopePath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const provider =
    parsed.provider === "claude_cli_exec_scheduler" ||
    parsed.provider === "claude_app_thread_automation" ||
    parsed.provider === "claude_app_standalone_automation"
      ? parsed.provider
      : undefined;
  const wakeOwner = parsed.wakeOwner === "operator" ? "operator" : undefined;
  const continuationIntent =
    parsed.continuationIntent === "defer_same_thread" || parsed.continuationIntent === "defer_fresh_run"
      ? parsed.continuationIntent
      : undefined;
  const targetMode =
    parsed.targetMode === "same_thread" || parsed.targetMode === "fresh_run" ? parsed.targetMode : undefined;
  const scheduleKind =
    parsed.scheduleKind === "cron" || parsed.scheduleKind === "rrule" ? parsed.scheduleKind : undefined;
  const schedule = typeof parsed.schedule === "string" ? parsed.schedule : undefined;
  const targetId = typeof parsed.targetId === "string" ? parsed.targetId : undefined;
  const source = parsed.source === "progress_proof" || parsed.source === "checkpoint" ? parsed.source : undefined;
  const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
  const workspaceSlug = typeof parsed.workspaceSlug === "string" ? parsed.workspaceSlug : undefined;
  const projectSlug = typeof parsed.projectSlug === "string" ? parsed.projectSlug : undefined;
  const activeRunId = typeof parsed.activeRunId === "string" ? parsed.activeRunId : undefined;
  const activeTaskId = typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined;
  if (
    !provider ||
    !wakeOwner ||
    !continuationIntent ||
    !targetMode ||
    !scheduleKind ||
    !schedule ||
    !targetId ||
    !source ||
    !summary ||
    !workspaceSlug ||
    !projectSlug ||
    !activeRunId ||
    !activeTaskId
  ) {
    return undefined;
  }

  return {
    provider,
    wakeOwner,
    continuationIntent,
    targetMode,
    scheduleKind,
    schedule,
    targetId,
    source,
    sourceId: typeof parsed.sourceId === "string" ? parsed.sourceId : undefined,
    summary,
    nextActions: Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === "string")
      : [],
    workspaceSlug,
    projectSlug,
    activeRunId,
    activeTaskId,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined
  };
}


export function convertSupportedCronScheduleToRrule(schedule: string): string {
  switch (schedule.trim()) {
    case "*/30 * * * *":
      return "FREQ=MINUTELY;INTERVAL=30";
    case "0 * * * *":
      return "FREQ=HOURLY;INTERVAL=1";
    default:
      throw new Error(`unsupported cron schedule for Codex app automation handoff: ${schedule}`);
  }
}


export function buildAppAutomationPrompt(input: {
  envelope: {
    continuationIntent: "defer_same_thread" | "defer_fresh_run";
    targetMode: "same_thread" | "fresh_run";
    targetId: string;
    source: "progress_proof" | "checkpoint";
    sourceId?: string | undefined;
    summary: string;
    nextActions: string[];
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string;
    activeTaskId: string;
  };
  cwd: string;
  /**
   * Compact continuation context assembled from the latest handoff packet by
   * ContinuationContextBuilder. When present it is injected verbatim so the
   * resumed invocation starts from durable runtime state rather than re-reading
   * the prior transcript. Omitted when no prior handoff exists.
   */
  continuationContext?: string | undefined;
}): string {
  const lines = [
    `Resume deferred archon work for workspace ${input.envelope.workspaceSlug} project ${input.envelope.projectSlug}.`,
    `Repo root: ${input.cwd}`,
    `Active run: ${input.envelope.activeRunId}`,
    `Active task: ${input.envelope.activeTaskId}`,
    `Continuation target: ${input.envelope.targetId}`,
    `Continuation intent: ${input.envelope.continuationIntent}`,
    `Target mode: ${input.envelope.targetMode}`,
    `Resume source: ${input.envelope.source}${input.envelope.sourceId ? ` (${input.envelope.sourceId})` : ""}`,
    `Summary: ${input.envelope.summary}`,
    "Before making changes, read `.archon/work/daemon/automation-envelope.json` and confirm the active runtime task still matches this request.",
    "Carry out the recorded continuation target, record concrete progress or blockers, and stop if the task becomes blocked by external input or no longer remains active."
  ];
  if (input.envelope.nextActions.length > 0) {
    lines.push(`Next actions: ${input.envelope.nextActions.join("; ")}`);
  }
  const continuationContext = input.continuationContext?.trim();
  if (continuationContext) {
    lines.push(
      "",
      "Compact continuation context from prior handoff (runtime-authoritative — do not relitigate decisions already recorded here):",
      continuationContext
    );
  }
  return `${lines.join("\n")}\n`;
}


export async function detectGitAutomationExecutionEnvironment(cwd: string): Promise<"worktree" | "local"> {
  try {
    await access(path.join(cwd, ".git"));
    return "worktree";
  } catch {
    return "local";
  }
}


export async function writeDaemonAppAutomationRequest(
  cwd: string,
  input: {
    envelope: {
      provider: "claude_app_thread_automation" | "claude_app_standalone_automation";
      continuationIntent: "defer_same_thread" | "defer_fresh_run";
      targetMode: "same_thread" | "fresh_run";
      scheduleKind: "cron" | "rrule";
      schedule: string;
      targetId: string;
      source: "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
      summary: string;
      nextActions: string[];
      workspaceSlug: string;
      projectSlug: string;
      activeRunId: string;
      activeTaskId: string;
    };
    updatedAt: string;
  }
): Promise<string> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  const relativePath = ".archon/work/daemon/app-automation-request.json";
  const appSchedule =
    input.envelope.scheduleKind === "rrule"
      ? input.envelope.schedule
      : convertSupportedCronScheduleToRrule(input.envelope.schedule);
  const continuationContext = await readDaemonContinuationContext(cwd);
  const prompt = buildAppAutomationPrompt({
    envelope: input.envelope,
    cwd,
    ...(continuationContext ? { continuationContext } : {})
  });
  // The bundle is now captured in the prompt; clear the sidecar so it is never
  // re-injected into a later run for a different task.
  if (continuationContext) {
    await clearDaemonContinuationContext(cwd);
  }
  const executionEnvironment =
    input.envelope.provider === "claude_app_standalone_automation"
      ? await detectGitAutomationExecutionEnvironment(cwd)
      : undefined;
  const request =
    input.envelope.provider === "claude_app_thread_automation"
      ? {
          tool: "automation_update",
          request: {
            mode: "suggested_create",
            kind: "heartbeat",
            destination: "thread",
            name: `Archon same-thread follow-up: ${input.envelope.activeTaskId}`,
            prompt,
            rrule: appSchedule,
            status: "ACTIVE"
          },
          context: {
            provider: input.envelope.provider,
            workspaceSlug: input.envelope.workspaceSlug,
            projectSlug: input.envelope.projectSlug,
            activeRunId: input.envelope.activeRunId,
            activeTaskId: input.envelope.activeTaskId,
            targetId: input.envelope.targetId,
            targetMode: input.envelope.targetMode,
            notes: [
              "Apply this request through the Codex app automation surface as a thread heartbeat.",
              "The automation should return to the same conversation rather than starting a fresh background run."
            ],
            generatedAt: input.updatedAt
          }
        }
      : {
          tool: "automation_update",
          request: {
            mode: "suggested_create",
            kind: "cron",
            executionEnvironment,
            cwds: [cwd],
            name: `Archon deferred run: ${input.envelope.activeTaskId}`,
            prompt,
            rrule: appSchedule,
            status: "ACTIVE"
          },
          context: {
            provider: input.envelope.provider,
            workspaceSlug: input.envelope.workspaceSlug,
            projectSlug: input.envelope.projectSlug,
            activeRunId: input.envelope.activeRunId,
            activeTaskId: input.envelope.activeTaskId,
            targetId: input.envelope.targetId,
            targetMode: input.envelope.targetMode,
            executionEnvironment,
            notes: [
              "Apply this request through the Codex app automation surface as a standalone automation.",
              executionEnvironment === "worktree"
                ? "Worktree execution is recommended because the repo exposes Git metadata."
                : "Local-project execution is suggested because no Git metadata was detected in the repo root."
            ],
            generatedAt: input.updatedAt
          }
        };
  await writeFile(path.join(cwd, relativePath), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return relativePath;
}


export async function clearDaemonAppAutomationRequest(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "app-automation-request.json"), {
    force: true
  });
}



export function convertSupportedCronScheduleToSystemdOnCalendar(schedule: string): string | undefined {
  switch (schedule.trim()) {
    case "*/30 * * * *":
      return "*-*-* *:0/30:00";
    case "0 * * * *":
      return "hourly";
    default:
      return undefined;
  }
}


export async function writeDaemonCliSchedulerRequest(
  cwd: string,
  input: {
    envelope: {
      provider: "claude_cli_exec_scheduler";
      continuationIntent: "defer_same_thread" | "defer_fresh_run";
      targetMode: "same_thread" | "fresh_run";
      scheduleKind: "cron" | "rrule";
      schedule: string;
      targetId: string;
      source: "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
      summary: string;
      nextActions: string[];
      workspaceSlug: string;
      projectSlug: string;
      activeRunId: string;
      activeTaskId: string;
    };
    sessionId: string | null;
    updatedAt: string;
  }
): Promise<{
  requestPath: string;
  promptPath: string;
  runnable: boolean;
  manualReviewRequired: boolean;
}> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  const requestPath = ".archon/work/daemon/cli-scheduler-request.json";
  const promptPath = ".archon/work/daemon/cli-scheduler-prompt.txt";
  const continuationContext = await readDaemonContinuationContext(cwd);
  const prompt = buildAppAutomationPrompt({
    envelope: input.envelope,
    cwd,
    ...(continuationContext ? { continuationContext } : {})
  });
  // The bundle is now captured in the prompt; clear the sidecar so it is never
  // re-injected into a later run for a different task.
  if (continuationContext) {
    await clearDaemonContinuationContext(cwd);
  }
  await writeFile(path.join(cwd, promptPath), prompt, "utf8");

  const requiresResumeSession =
    input.envelope.continuationIntent === "defer_same_thread" && input.envelope.targetMode === "same_thread";
  const runnable = !requiresResumeSession || Boolean(input.sessionId);
  const manualReviewRequired = !runnable;
  const commandCore =
    requiresResumeSession && input.sessionId
      ? `claude --resume ${input.sessionId} -p "$(cat ${promptPath})" --output-format stream-json`
      : `claude -p "$(cat ${promptPath})" --output-format stream-json`;
  const shellCommand = runnable ? `cd ${JSON.stringify(cwd)} && ${commandCore}` : undefined;
  const systemdOnCalendar =
    input.envelope.scheduleKind === "cron"
      ? convertSupportedCronScheduleToSystemdOnCalendar(input.envelope.schedule)
      : undefined;
  const request = {
    tool: "claude",
    request: {
      subcommand: "p",
      resumeSessionId: input.sessionId ?? undefined,
      promptPath,
      outputFormat: "stream-json",
      cwd,
      runnable
    },
    scheduler: {
      scheduleKind: input.envelope.scheduleKind,
      schedule: input.envelope.schedule,
      launcherHints: shellCommand
        ? [
            {
              kind: "cron",
              schedule: input.envelope.schedule,
              shellCommand
            },
            ...(systemdOnCalendar
              ? [
                  {
                    kind: "systemd",
                    onCalendar: systemdOnCalendar,
                    shellCommand
                  }
                ]
              : [])
          ]
        : [],
      manualReviewRequired
    },
    context: {
      provider: input.envelope.provider,
      workspaceSlug: input.envelope.workspaceSlug,
      projectSlug: input.envelope.projectSlug,
      activeRunId: input.envelope.activeRunId,
      activeTaskId: input.envelope.activeTaskId,
      targetId: input.envelope.targetId,
      targetMode: input.envelope.targetMode,
      continuationIntent: input.envelope.continuationIntent,
      notes: manualReviewRequired
        ? [
            "No persisted session id was available for a same-thread CLI resume.",
            "Review this handoff manually before converting it into a fresh-run scheduler job or another automation owner."
          ]
        : [
            requiresResumeSession
              ? "This handoff uses claude --resume to preserve the same-thread continuation context."
              : "This handoff uses a fresh claude -p run for deferred continuation.",
            "Install one of the launcher hints under your preferred local scheduler."
          ],
      generatedAt: input.updatedAt
    }
  };
  await writeFile(path.join(cwd, requestPath), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return {
    requestPath,
    promptPath,
    runnable,
    manualReviewRequired
  };
}


export async function clearDaemonCliSchedulerRequest(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "cli-scheduler-request.json"), {
    force: true
  });
  await rm(path.join(cwd, ".archon", "work", "daemon", "cli-scheduler-prompt.txt"), {
    force: true
  });
}


export async function writeDaemonOperatorHandoff(
  cwd: string,
  handoff: {
    state: "blocked";
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
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string | null;
    activeTaskId: string | null;
    sessionId: string | null;
    cycle: number;
    directiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
    nextActions: string[];
    detailFiles: {
      continuationStatus?: string | undefined;
      automationEnvelope?: string | undefined;
      appAutomationRequest?: string | undefined;
      cliSchedulerRequest?: string | undefined;
      reviewQueueStatus?: string | undefined;
      scopeExpansionRequest?: string | undefined;
    };
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "operator-handoff.json"),
    `${JSON.stringify(handoff, null, 2)}\n`,
    "utf8"
  );
}


export async function clearDaemonOperatorHandoff(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json"), {
    force: true
  });
}


export async function writeDaemonScopeExpansionRequest(
  cwd: string,
  request: {
    runId: string;
    taskId: string;
    directiveKind: RunExecutionPlan["directive"]["kind"];
    blockedPaths: string[];
    requestedWriteScope: string[];
    reason: string;
    updatedAt: string;
  }
): Promise<string> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  const relativePath = ".archon/work/daemon/scope-expansion-request.json";
  await writeFile(path.join(cwd, relativePath), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return relativePath;
}


export async function clearDaemonScopeExpansionRequest(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "scope-expansion-request.json"), {
    force: true
  });
}


export async function writeDaemonSupervisorStatus(
  cwd: string,
  status: {
    state: "completed" | "blocked" | "max_cycles_reached";
    blockerKind?:
      | "runtime_preflight"
      | "missing_review_actor_bindings"
      | "handoff_missing"
      | "unsupported_handoff"
      | "continuation_derivation_failed"
      | "review_derivation_failed"
      | undefined;
    reason: string;
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string | null;
    activeTaskId: string | null;
    sessionId: string | null;
    supervisorCycles: number;
    nextActions: string[];
    missingReviewRoles: string[];
    actions: Array<{
      cycle: number;
      action:
        | "enqueue_operator_continuation"
        | "enqueue_review_action"
        | "materialize_app_automation"
        | "materialize_cli_scheduler";
      targetId?: string | undefined;
      taskId?: string | undefined;
      reviewRole?: string | undefined;
      filePath: string;
      summary: string;
    }>;
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "supervisor-status.json"),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8"
  );
}


export interface DaemonSupervisorHistoryReadOptions {
  limit: number;
  scope: "run" | "all";
  runId?: string | undefined;
}


export interface DaemonSupervisorHistoryReadResult {
  entries: DaemonSupervisorStatusObservation["history"];
  retainedCount: number;
  filteredCount: number;
}


export async function appendDaemonSupervisorHistory(
  cwd: string,
  entry: {
    recordedAt: string;
    state: "completed" | "blocked" | "max_cycles_reached";
    blockerKind?:
      | "runtime_preflight"
      | "missing_review_actor_bindings"
      | "handoff_missing"
      | "unsupported_handoff"
      | "continuation_derivation_failed"
      | "review_derivation_failed"
      | undefined;
    reason: string;
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string | null;
    activeTaskId: string | null;
    sessionId: string | null;
    supervisorCycles: number;
    nextActions: string[];
    missingReviewRoles: string[];
    actions: Array<{
      cycle: number;
      action:
        | "enqueue_operator_continuation"
        | "enqueue_review_action"
        | "materialize_app_automation"
        | "materialize_cli_scheduler";
      targetId?: string | undefined;
      taskId?: string | undefined;
      reviewRole?: string | undefined;
      filePath: string;
      summary: string;
    }>;
  },
  retentionLimit: number
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  const historyPath = path.join(daemonDir, "supervisor-history.jsonl");
  await mkdir(daemonDir, { recursive: true });
  let existingLines: string[] = [];
  try {
    existingLines = (await readFile(historyPath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const retainedLines = [...existingLines, JSON.stringify(entry)].slice(-retentionLimit);
  await writeFile(historyPath, retainedLines.length > 0 ? `${retainedLines.join("\n")}\n` : "", "utf8");
}


export async function readDaemonContinuationStatus(
  cwd: string
): Promise<DaemonContinuationStatusObservation | undefined> {
  const statusPath = path.join(cwd, ".archon", "work", "daemon", "continuation-status.json");
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state = parsed.state === "blocked" ? "blocked" : "invalid";
    const directiveKind = parsed.directiveKind === "continue_analysis" ? "continue_analysis" : "continue_analysis";
    const executionMode: DaemonContinuationStatusObservation["executionMode"] =
      parsed.executionMode === "operator_required" ? "operator_required" : "unknown";
    const targetId = typeof parsed.targetId === "string" ? parsed.targetId : undefined;
    const source =
      parsed.source === "blocking_gap" || parsed.source === "progress_proof" || parsed.source === "checkpoint"
        ? parsed.source
        : undefined;
    const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId : undefined;
    const actionKind =
      parsed.actionKind === "resolve_blocking_gap" ||
      parsed.actionKind === "run_workflow_proof" ||
      parsed.actionKind === "resume_target"
        ? parsed.actionKind
        : undefined;
    const provider =
      parsed.provider === "none" ||
      parsed.provider === "manual_operator_handoff" ||
      parsed.provider === "claude_cli_exec_scheduler" ||
      parsed.provider === "claude_cli_exec" ||
      parsed.provider === "claude_app_thread_automation" ||
      parsed.provider === "claude_app_standalone_automation"
        ? parsed.provider
        : undefined;
    const wakeOwner =
      parsed.wakeOwner === "none" || parsed.wakeOwner === "runtime" || parsed.wakeOwner === "operator"
        ? parsed.wakeOwner
        : undefined;
    const scheduleKind =
      parsed.scheduleKind === "none" ||
      parsed.scheduleKind === "manual" ||
      parsed.scheduleKind === "cron" ||
      parsed.scheduleKind === "rrule"
        ? parsed.scheduleKind
        : undefined;
    const schedule = typeof parsed.schedule === "string" ? parsed.schedule : undefined;
    const derivedProviderSelection =
      provider && wakeOwner
        ? undefined
        : executionMode === "operator_required"
          ? selectLocalContinuationProvider({
              executionMode,
              continuationIntent:
                source === "checkpoint"
                  ? "defer_same_thread"
                  : source === "progress_proof"
                    ? "defer_fresh_run"
                    : "blocked_external"
            })
          : undefined;
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary
        : "daemon continuation status file is missing a valid summary";
    const nextActions = Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === "string")
      : [];
    const blockers = Array.isArray(parsed.blockers)
      ? parsed.blockers.filter((value): value is string => typeof value === "string")
      : [];
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      directiveKind,
      executionMode,
      targetId,
      source,
      sourceId,
      actionKind,
      provider:
        provider === "claude_cli_exec"
          ? "claude_cli_exec_scheduler"
          : (provider ?? derivedProviderSelection?.provider),
      wakeOwner: wakeOwner ?? derivedProviderSelection?.wakeOwner,
      scheduleKind: scheduleKind ?? derivedProviderSelection?.scheduleKind,
      schedule: schedule ?? derivedProviderSelection?.schedule,
      summary,
      nextActions,
      blockers,
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      directiveKind: "continue_analysis",
      executionMode: "unknown",
      summary: `failed to parse daemon continuation status: ${error instanceof Error ? error.message : String(error)}`,
      nextActions: [],
      blockers: [],
      updatedAt: undefined
    };
  }
}


export async function readDaemonOperatorHandoff(
  cwd: string
): Promise<DaemonOperatorHandoffObservation | undefined> {
  const handoffPath = path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json");
  let raw: string;
  try {
    raw = await readFile(handoffPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state = parsed.state === "blocked" ? "blocked" : "invalid";
    const blockerKind =
      parsed.blockerKind === "bootstrapping" ||
      parsed.blockerKind === "runtime_preflight" ||
      parsed.blockerKind === "missing_active_runtime" ||
      parsed.blockerKind === "review_queue" ||
      parsed.blockerKind === "review_execution_unsupported" ||
      parsed.blockerKind === "operator_required_continuation" ||
      parsed.blockerKind === "workflow_proof_failure" ||
      parsed.blockerKind === "scope_expansion_required" ||
      parsed.blockerKind === "runtime_blocked" ||
      parsed.blockerKind === "recovery_required" ||
      parsed.blockerKind === "runtime_task_missing" ||
      parsed.blockerKind === "active_task_mismatch" ||
      parsed.blockerKind === "uncommitted_deliverables"
        ? parsed.blockerKind
        : "unknown";
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason
        : "daemon operator handoff is missing a valid reason";
    const workspaceSlug = typeof parsed.workspaceSlug === "string" ? parsed.workspaceSlug : undefined;
    const projectSlug = typeof parsed.projectSlug === "string" ? parsed.projectSlug : undefined;
    const activeRunId =
      parsed.activeRunId === null || typeof parsed.activeRunId === "string" ? parsed.activeRunId : undefined;
    const activeTaskId =
      parsed.activeTaskId === null || typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined;
    const sessionId =
      parsed.sessionId === null || typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    const cycle = typeof parsed.cycle === "number" ? parsed.cycle : undefined;
    const directiveKind =
      parsed.directiveKind === "complete" ||
      parsed.directiveKind === "dispatch_owner" ||
      parsed.directiveKind === "dispatch_reviews" ||
      parsed.directiveKind === "apply_recovery" ||
      parsed.directiveKind === "dispatch_subagents" ||
      parsed.directiveKind === "rebuild_inventory" ||
      parsed.directiveKind === "trace_runtime" ||
      parsed.directiveKind === "checkpoint" ||
      parsed.directiveKind === "replan_migration" ||
      parsed.directiveKind === "continue_analysis" ||
      parsed.directiveKind === "blocked"
        ? parsed.directiveKind
        : undefined;
    const nextActions = Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === "string")
      : [];
    const detailFilesCandidate =
      parsed.detailFiles && typeof parsed.detailFiles === "object" && !Array.isArray(parsed.detailFiles)
        ? (parsed.detailFiles as Record<string, unknown>)
        : {};
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      blockerKind,
      reason,
      workspaceSlug,
      projectSlug,
      activeRunId,
      activeTaskId,
      sessionId,
      cycle,
      directiveKind,
      nextActions,
      detailFiles: {
        continuationStatus:
          typeof detailFilesCandidate.continuationStatus === "string"
            ? detailFilesCandidate.continuationStatus
            : undefined,
        automationEnvelope:
          typeof detailFilesCandidate.automationEnvelope === "string"
            ? detailFilesCandidate.automationEnvelope
            : undefined,
        appAutomationRequest:
          typeof detailFilesCandidate.appAutomationRequest === "string"
            ? detailFilesCandidate.appAutomationRequest
            : undefined,
        cliSchedulerRequest:
          typeof detailFilesCandidate.cliSchedulerRequest === "string"
            ? detailFilesCandidate.cliSchedulerRequest
            : undefined,
        reviewQueueStatus:
          typeof detailFilesCandidate.reviewQueueStatus === "string"
            ? detailFilesCandidate.reviewQueueStatus
            : undefined,
        scopeExpansionRequest:
          typeof detailFilesCandidate.scopeExpansionRequest === "string"
            ? detailFilesCandidate.scopeExpansionRequest
            : undefined
      },
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      blockerKind: "unknown",
      reason: `failed to parse daemon operator handoff: ${error instanceof Error ? error.message : String(error)}`,
      nextActions: [],
      detailFiles: {}
    };
  }
}


export async function readDaemonSupervisorStatus(
  cwd: string,
  historyOptions: DaemonSupervisorHistoryReadOptions
): Promise<DaemonSupervisorStatusObservation | undefined> {
  const statusPath = path.join(cwd, ".archon", "work", "daemon", "supervisor-status.json");
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state =
      parsed.state === "completed" || parsed.state === "blocked" || parsed.state === "max_cycles_reached"
        ? parsed.state
        : "invalid";
    const blockerKind =
      parsed.blockerKind === "runtime_preflight" ||
      parsed.blockerKind === "missing_review_actor_bindings" ||
      parsed.blockerKind === "handoff_missing" ||
      parsed.blockerKind === "unsupported_handoff" ||
      parsed.blockerKind === "continuation_derivation_failed" ||
      parsed.blockerKind === "review_derivation_failed"
        ? parsed.blockerKind
        : typeof parsed.blockerKind === "string"
          ? "unknown"
          : undefined;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason
        : "daemon supervisor status is missing a valid reason";
    const workspaceSlug = typeof parsed.workspaceSlug === "string" ? parsed.workspaceSlug : undefined;
    const projectSlug = typeof parsed.projectSlug === "string" ? parsed.projectSlug : undefined;
    const activeRunId =
      parsed.activeRunId === null || typeof parsed.activeRunId === "string" ? parsed.activeRunId : undefined;
    const activeTaskId =
      parsed.activeTaskId === null || typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined;
    const sessionId =
      parsed.sessionId === null || typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    const supervisorCycles = typeof parsed.supervisorCycles === "number" ? parsed.supervisorCycles : undefined;
    const nextActions = Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === "string")
      : [];
    const missingReviewRoles = Array.isArray(parsed.missingReviewRoles)
      ? parsed.missingReviewRoles.filter((value): value is string => typeof value === "string")
      : [];
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return [];
          }
          const candidate = value as Record<string, unknown>;
          const action =
            candidate.action === "enqueue_operator_continuation" ||
            candidate.action === "enqueue_review_action" ||
            candidate.action === "materialize_app_automation" ||
            candidate.action === "materialize_cli_scheduler"
              ? (candidate.action as
                  | "enqueue_operator_continuation"
                  | "enqueue_review_action"
                  | "materialize_app_automation"
                  | "materialize_cli_scheduler")
              : undefined;
          const cycle = typeof candidate.cycle === "number" ? candidate.cycle : undefined;
          const filePath = typeof candidate.filePath === "string" ? candidate.filePath : undefined;
          const summary = typeof candidate.summary === "string" ? candidate.summary : undefined;
          if (!action || cycle === undefined || !filePath || !summary) {
            return [];
          }
          return [
            {
              cycle,
              action,
              targetId: typeof candidate.targetId === "string" ? candidate.targetId : undefined,
              taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
              reviewRole: typeof candidate.reviewRole === "string" ? candidate.reviewRole : undefined,
              filePath,
              summary
            }
          ];
        })
      : [];
    const historyResult = await readDaemonSupervisorHistory(cwd, historyOptions);
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      blockerKind,
      reason,
      workspaceSlug,
      projectSlug,
      activeRunId,
      activeTaskId,
      sessionId,
      supervisorCycles,
      nextActions,
      missingReviewRoles,
      actions,
      history: historyResult.entries,
      historyView: {
        scope: historyOptions.scope,
        runId: historyOptions.scope === "run" ? historyOptions.runId : undefined,
        limit: historyOptions.limit,
        retainedCount: historyResult.retainedCount,
        filteredCount: historyResult.filteredCount,
        returnedCount: historyResult.entries.length,
        truncated: historyResult.filteredCount > historyResult.entries.length
      },
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      blockerKind: "unknown",
      reason: `failed to parse daemon supervisor status: ${error instanceof Error ? error.message : String(error)}`,
      nextActions: [],
      missingReviewRoles: [],
      actions: [],
      history: [],
      historyView: {
        scope: historyOptions.scope,
        runId: historyOptions.scope === "run" ? historyOptions.runId : undefined,
        limit: historyOptions.limit,
        retainedCount: 0,
        filteredCount: 0,
        returnedCount: 0,
        truncated: false
      },
      updatedAt: undefined
    };
  }
}


export async function readDaemonSupervisorHistory(
  cwd: string,
  options: DaemonSupervisorHistoryReadOptions
): Promise<DaemonSupervisorHistoryReadResult> {
  const historyPath = path.join(cwd, ".archon", "work", "daemon", "supervisor-history.jsonl");
  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return {
        entries: [],
        retainedCount: 0,
        filteredCount: 0
      };
    }
    throw error;
  }

  const retainedEntries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const state =
          parsed.state === "completed" || parsed.state === "blocked" || parsed.state === "max_cycles_reached"
            ? parsed.state
            : undefined;
        const reason =
          typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason.trim() : undefined;
        const recordedAt =
          typeof parsed.recordedAt === "string" && parsed.recordedAt.trim().length > 0
            ? parsed.recordedAt.trim()
            : undefined;
        const activeRunId =
          parsed.activeRunId === null || typeof parsed.activeRunId === "string" ? parsed.activeRunId : undefined;
        const activeTaskId =
          parsed.activeTaskId === null || typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined;
        if (!state || !reason || !recordedAt) {
          return [];
        }
        const blockerKind =
          parsed.blockerKind === "runtime_preflight" ||
          parsed.blockerKind === "missing_review_actor_bindings" ||
          parsed.blockerKind === "handoff_missing" ||
          parsed.blockerKind === "unsupported_handoff" ||
          parsed.blockerKind === "continuation_derivation_failed" ||
          parsed.blockerKind === "review_derivation_failed"
            ? parsed.blockerKind
            : typeof parsed.blockerKind === "string"
              ? "unknown"
              : undefined;
        const supervisorCycles =
          typeof parsed.supervisorCycles === "number" ? parsed.supervisorCycles : undefined;
        const actionCount = Array.isArray(parsed.actions) ? parsed.actions.length : 0;
        return [
          {
            recordedAt,
            state,
            activeRunId,
            activeTaskId,
            blockerKind,
            reason,
            supervisorCycles,
            actionCount
          } satisfies DaemonSupervisorStatusObservation["history"][number]
        ];
      } catch {
        return [];
      }
    });

  const filteredEntries =
    options.scope === "run" && options.runId
      ? retainedEntries.filter((entry) => entry.activeRunId === options.runId)
      : retainedEntries;

  return {
    entries: options.limit === 0 ? [] : filteredEntries.slice(-options.limit),
    retainedCount: retainedEntries.length,
    filteredCount: filteredEntries.length
  };
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


export function formatSupervisorCommandResult(result: SupervisorCommandResult): string {
  const lines = [
    `status: ${result.status}`,
    `reason: ${result.reason}`,
    `workspace: ${result.workspaceSlug}`,
    `project: ${result.projectSlug}`,
    `active-run: ${result.activeRunId ?? "none"}`,
    `active-task: ${result.activeTaskId ?? "none"}`,
    `session-id: ${result.sessionId ?? "none"}`
  ];

  if (result.actions.length > 0) {
    lines.push("actions:");
    for (const action of result.actions) {
      lines.push(
        `- cycle=${action.cycle} action=${action.action} target=${action.targetId ?? action.taskId ?? "none"}${action.reviewRole ? ` role=${action.reviewRole}` : ""} ${action.summary}`
      );
    }
  }

  if (result.daemonRuns.length > 0) {
    lines.push("daemon-runs:");
    for (const daemonRun of result.daemonRuns) {
      lines.push(
        `- status=${daemonRun.status} reason=${daemonRun.reason} task=${daemonRun.activeTaskId ?? "none"} run=${daemonRun.activeRunId ?? "none"}`
      );
    }
  }

  return lines.join("\n");
}


export function formatSupervisorHistoryCommandResult(result: SupervisorHistoryCommandResult): string {
  const lines = [
    "Supervisor history",
    `scope: ${result.scope}`,
    `run-id: ${result.runId ?? "all"}`,
    `history-path: ${result.historyPath}`,
    `retained: ${result.retainedCount}`,
    `filtered: ${result.filteredCount}`,
    `returned: ${result.returnedCount}`,
    `truncated: ${result.truncated ? "yes" : "no"}`
  ];

  if (result.latestStatus) {
    lines.push(
      `latest-status: ${result.latestStatus.state}${result.latestStatus.blockerKind ? ` ${result.latestStatus.blockerKind}` : ""} ${result.latestStatus.reason}`
    );
    if (result.latestStatus.activeRunId || result.latestStatus.activeTaskId) {
      lines.push(
        `latest-target: run=${result.latestStatus.activeRunId ?? "none"} task=${result.latestStatus.activeTaskId ?? "none"}`
      );
    }
  }

  if (result.entries.length === 0) {
    lines.push("entries: none");
    return lines.join("\n");
  }

  lines.push("entries:");
  for (const entry of result.entries) {
    lines.push(
      `- ${entry.recordedAt} run=${entry.activeRunId ?? "unknown"} task=${entry.activeTaskId ?? "unknown"} state=${entry.state}${entry.blockerKind ? ` blocker=${entry.blockerKind}` : ""} actions=${entry.actionCount} reason=${entry.reason}`
    );
  }

  return lines.join("\n");
}


export function buildSupervisorOperatorNotes(input: {
  targetId: string;
  summary: string;
  nextActions: readonly string[];
  override?: string | undefined;
}): string {
  if (input.override?.trim()) {
    return input.override.trim();
  }

  const lines = [`Local supervisor authorized advisory continuation for ${input.targetId}.`];
  if (input.summary.trim()) {
    lines.push(`Reason: ${input.summary.trim()}`);
  }
  if (input.nextActions.length > 0) {
    lines.push(`Context: ${input.nextActions.join(" | ")}`);
  }
  return lines.join(" ");
}


export async function writeSupervisorOperatorContinuationAction(input: {
  cwd: string;
  operatorActionDir: string;
  runId: string;
  taskId: string;
  targetId: string;
  source: "blocking_gap" | "progress_proof" | "checkpoint";
  sourceId?: string | undefined;
  operatorNotes: string;
  cycle: number;
  nowValue: string;
}): Promise<string> {
  await mkdir(input.operatorActionDir, { recursive: true });
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTimestamp = input.nowValue.replace(/[^0-9A-Za-z]/g, "");
  const fileName = `supervisor-${String(input.cycle).padStart(2, "0")}-${safeRunId}-${safeTaskId}-${safeTimestamp}.json`;
  const filePath = path.join(input.operatorActionDir, fileName);
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        runId: input.runId,
        taskId: input.taskId,
        blockerKind: "operator_required_continuation",
        action: {
          kind: "continue_with_analysis",
          targetId: input.targetId,
          source: input.source,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          operatorNotes: input.operatorNotes
        },
        supervisor: {
          kind: "local_supervisor",
          generatedAt: input.nowValue
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path.relative(input.cwd, filePath) || path.basename(filePath);
}


export interface DaemonReviewQueueStatusObservation {
  authorityLabel: "derived_only";
  state: "processed" | "blocked" | "failed" | "invalid";
  reviewInputDir?: string | undefined;
  reason: string;
  expectedReviewTargets: string[];
  queuedFiles: string[];
  consumedFiles: string[];
  failedFiles: { file: string; error: string }[];
  staleFiles: { file: string; reason: string }[];
  updatedAt?: string | undefined;
}


export async function readDaemonReviewQueueStatus(
  cwd: string
): Promise<DaemonReviewQueueStatusObservation | undefined> {
  const statusPath = path.join(cwd, ".archon", "work", "daemon", "review-queue-status.json");
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state =
      parsed.state === "processed" || parsed.state === "blocked" || parsed.state === "failed"
        ? parsed.state
        : "invalid";
    const reviewInputDir = typeof parsed.reviewInputDir === "string" ? parsed.reviewInputDir : undefined;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason
        : "daemon review queue status is missing a valid reason";
    const expectedReviewTargets = Array.isArray(parsed.expectedReviewTargets)
      ? parsed.expectedReviewTargets.filter((value): value is string => typeof value === "string")
      : [];
    const queuedFiles = Array.isArray(parsed.queuedFiles)
      ? parsed.queuedFiles.filter((value): value is string => typeof value === "string")
      : [];
    const consumedFiles = Array.isArray(parsed.consumedFiles)
      ? parsed.consumedFiles.filter((value): value is string => typeof value === "string")
      : [];
    const failedFiles = Array.isArray(parsed.failedFiles)
      ? parsed.failedFiles.flatMap((value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  file: typeof (value as { file?: unknown }).file === "string" ? (value as { file: string }).file : "unknown",
                  error:
                    typeof (value as { error?: unknown }).error === "string"
                      ? (value as { error: string }).error
                      : "unknown"
                }
              ]
            : []
        )
      : [];
    const staleFiles = Array.isArray(parsed.staleFiles)
      ? parsed.staleFiles.flatMap((value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  file: typeof (value as { file?: unknown }).file === "string" ? (value as { file: string }).file : "unknown",
                  reason:
                    typeof (value as { reason?: unknown }).reason === "string"
                      ? (value as { reason: string }).reason
                      : "unknown"
                }
              ]
            : []
        )
      : [];
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      reviewInputDir,
      reason,
      expectedReviewTargets,
      queuedFiles,
      consumedFiles,
      failedFiles,
      staleFiles,
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      reason: `failed to parse daemon review queue status: ${error instanceof Error ? error.message : String(error)}`,
      expectedReviewTargets: [],
      queuedFiles: [],
      consumedFiles: [],
      failedFiles: [],
      staleFiles: [],
      updatedAt: undefined
    };
  }
}


export function parseSupervisorReviewActorBindings(
  args: readonly string[],
  env: EnvShape
): Partial<Record<ReviewRecord["reviewerRole"], string>> {
  const bindings: Partial<Record<ReviewRecord["reviewerRole"], string>> = {};
  const mappingArgs = collectCommandFlagValues(args, "--review-actor");
  for (const mapping of mappingArgs) {
    const separatorIndex = mapping.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === mapping.length - 1) {
      throw new Error(`Invalid --review-actor value: ${mapping}`);
    }
    const role = mapping.slice(0, separatorIndex).trim();
    const actor = mapping.slice(separatorIndex + 1).trim();
    if (!isGateReviewRole(role)) {
      throw new Error(`Invalid review role in --review-actor: ${role}`);
    }
    if (!actor) {
      throw new Error(`Invalid empty actor in --review-actor: ${mapping}`);
    }
    bindings[role] = actor;
  }

  const envBindings: Array<[ReviewRecord["reviewerRole"], string | undefined]> = [
    ["reviewer", env.ARCHON_SUPERVISOR_REVIEWER_ACTOR],
    ["security_reviewer", env.ARCHON_SUPERVISOR_SECURITY_REVIEWER_ACTOR],
    ["qa_engineer", env.ARCHON_SUPERVISOR_QA_ENGINEER_ACTOR]
  ];
  for (const [role, actor] of envBindings) {
    if (!bindings[role] && actor?.trim()) {
      bindings[role] = actor.trim();
    }
  }

  return bindings;
}


export async function resolveSupervisorReviewAuthContext(input: {
  cwd: string;
  env: EnvShape;
  actor: string;
}): Promise<{ provider: string; subject: string; verified: true } | undefined> {
  let bindingsPath: string;
  try {
    bindingsPath = await resolveRequiredReviewIdentityFilePath({
      envVarName: "ARCHON_REVIEW_IDENTITY_BINDINGS",
      envVarValue: input.env.ARCHON_REVIEW_IDENTITY_BINDINGS,
      liveRelativePath: ".archon/review-identity-bindings.json",
      cwd: input.cwd
    });
  } catch {
    return undefined;
  }

  if (isRepoTemplateReviewIdentityPath(bindingsPath)) {
    return undefined;
  }

  if (await bindingsUsePlaceholderContent(bindingsPath)) {
    return undefined;
  }

  const bindings = await loadReviewIdentityBindings(bindingsPath);
  const matches = bindings.bindings
    .filter((binding) => binding.actors.some((actorBinding) => actorBinding.actor === input.actor))
    .map((binding) => ({
      provider: binding.principal.provider,
      subject: binding.principal.subject
    }))
    .filter(
      (binding, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.provider === binding.provider && candidate.subject === binding.subject
        ) === index
    );

  if (matches.length !== 1) {
    return undefined;
  }

  return {
    provider: matches[0]!.provider,
    subject: matches[0]!.subject,
    verified: true
  };
}


export async function writeSupervisorReviewAction(input: {
  cwd: string;
  reviewInputDir: string;
  runId: string;
  taskId: string;
  reviewRole: ReviewRecord["reviewerRole"];
  actor: string;
  authContext?: { provider: string; subject: string; verified: true } | undefined;
  cycle: number;
  nowValue: string;
}): Promise<string> {
  await mkdir(input.reviewInputDir, { recursive: true });
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTimestamp = input.nowValue.replace(/[^0-9A-Za-z]/g, "");
  const fileName = `supervisor-${String(input.cycle).padStart(2, "0")}-${safeRunId}-${safeTaskId}-${input.reviewRole}-${safeTimestamp}.json`;
  const filePath = path.join(input.reviewInputDir, fileName);
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        runId: input.runId,
        taskId: input.taskId,
        actor: input.actor,
        review: {
          reviewerRole: input.reviewRole,
          state: "passed",
          severity: "low",
          findings: []
        },
        ...(input.authContext ? { authContext: input.authContext } : {}),
        supervisor: {
          kind: "local_supervisor",
          generatedAt: input.nowValue
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path.relative(input.cwd, filePath) || path.basename(filePath);
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
  if (/refusing to close task|uncommitted change\(s\)/i.test(message)) {
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


export async function executeSupervisorCommandFromArgs(
  args: readonly string[],
  options: ExecuteSupervisorCommandOptions
): Promise<{ format: "json" | "text"; result: SupervisorCommandResult }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const format = resolveFormatFlag(args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;
  const maxSupervisorCyclesValue = resolveCommandFlag(args, "--max-supervisor-cycles") ?? "4";
  const maxSupervisorCycles = Number.parseInt(maxSupervisorCyclesValue, 10);
  const operatorActionDir = resolveDaemonOperatorActionDir(args, { cwd, env });
  const reviewActorBindings = parseSupervisorReviewActorBindings(args, env);
  const operatorNotesOverride =
    resolveCommandFlag(args, "--operator-notes") ?? env.ARCHON_SUPERVISOR_OPERATOR_NOTES;
  const historyRetentionLimit = resolveSupervisorHistoryRetentionLimit(args, env);
  const now = options.now ?? (() => new Date());

  if (!workspaceSlug || !projectSlug) {
    throw new Error("supervisor requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }
  if (!Number.isInteger(maxSupervisorCycles) || maxSupervisorCycles <= 0) {
    throw new Error(`Invalid --max-supervisor-cycles value: ${maxSupervisorCyclesValue}`);
  }

  const daemonRuns: DaemonCommandResult[] = [];
  const actions: SupervisorActionRecord[] = [];
  const finalize = async (input: {
    status: SupervisorCommandResult["status"];
    reason: string;
    activeRunId: string | null;
    activeTaskId: string | null;
    sessionId: string | null;
    blockerKind?:
      | "missing_review_actor_bindings"
      | "handoff_missing"
      | "unsupported_handoff"
      | "continuation_derivation_failed"
      | "review_derivation_failed"
      | undefined;
    nextActions?: string[] | undefined;
    missingReviewRoles?: string[] | undefined;
  }): Promise<{ format: "json" | "text"; result: SupervisorCommandResult }> => {
    const result: SupervisorCommandResult = {
      authorityLabel: "derived_only",
      workspaceSlug,
      projectSlug,
      status: input.status,
      reason: input.reason,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      sessionId: input.sessionId,
      daemonRuns,
      actions
    };
    await writeDaemonSupervisorStatus(cwd, {
      state: input.status,
      blockerKind: input.blockerKind,
      reason: input.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      sessionId: input.sessionId,
      supervisorCycles: daemonRuns.length,
      nextActions: [...(input.nextActions ?? [])],
      missingReviewRoles: [...(input.missingReviewRoles ?? [])],
      actions,
      updatedAt: now().toISOString()
    });
    await appendDaemonSupervisorHistory(cwd, {
      recordedAt: now().toISOString(),
      state: input.status,
      blockerKind: input.blockerKind,
      reason: input.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      sessionId: input.sessionId,
      supervisorCycles: daemonRuns.length,
      nextActions: [...(input.nextActions ?? [])],
      missingReviewRoles: [...(input.missingReviewRoles ?? [])],
      actions
    }, historyRetentionLimit);
    return {
      format,
      result
    };
  };

  for (let cycle = 1; cycle <= maxSupervisorCycles; cycle += 1) {
    const daemonResult = await executeDaemonCommandFromArgs(args, options);
    daemonRuns.push(daemonResult.result);

    if (daemonResult.result.status !== "blocked") {
      return finalize({
        status: daemonResult.result.status,
        reason: daemonResult.result.reason,
        activeRunId: daemonResult.result.activeRunId,
        activeTaskId: daemonResult.result.activeTaskId,
        sessionId: daemonResult.result.sessionId
      });
    }

    const handoff = await readDaemonOperatorHandoff(cwd);
    if (!handoff || handoff.state !== "blocked") {
      return finalize({
        status: "blocked",
        blockerKind: "handoff_missing",
        reason: daemonResult.result.reason,
        activeRunId: daemonResult.result.activeRunId,
        activeTaskId: daemonResult.result.activeTaskId,
        sessionId: daemonResult.result.sessionId
      });
    }

    if (handoff.blockerKind === "review_queue") {
      const reviewQueueStatus = await readDaemonReviewQueueStatus(cwd);
      if (
        !reviewQueueStatus ||
        reviewQueueStatus.state === "invalid" ||
        !reviewQueueStatus.reviewInputDir ||
        !handoff.activeRunId
      ) {
        return finalize({
          status: "blocked",
          blockerKind: "review_derivation_failed",
          reason: "supervisor could not derive trusted review actions from the daemon review-queue handoff",
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId
        });
      }

      const pendingTargets = reviewQueueStatus.expectedReviewTargets
        .map((target) => ({ raw: target, parsed: parseExpectedReviewTarget(target) }))
        .filter(
          (target): target is { raw: string; parsed: { taskId: string; reviewRole: ReviewRecord["reviewerRole"] } } =>
            target.parsed !== undefined
        );
      if (pendingTargets.length === 0) {
        return finalize({
          status: "blocked",
          blockerKind: "review_derivation_failed",
          reason: reviewQueueStatus.reason,
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId
        });
      }

      const missingRoles = pendingTargets
        .map((target) => target.parsed.reviewRole)
        .filter((role, index, array) => array.indexOf(role) === index)
        .filter((role) => !reviewActorBindings[role]);
      if (missingRoles.length > 0) {
        return finalize({
          status: "blocked",
          blockerKind: "missing_review_actor_bindings",
          reason: `supervisor is missing review actor bindings for: ${missingRoles.join(", ")}`,
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
          nextActions: missingRoles.map((role) => `provide --review-actor ${role}=<actor>`),
          missingReviewRoles: missingRoles
        });
      }

      const nowValue = now().toISOString();
      for (const target of pendingTargets) {
        const actor = reviewActorBindings[target.parsed.reviewRole]!;
        const authContext = await resolveSupervisorReviewAuthContext({
          cwd,
          env,
          actor
        });
        const filePath = await writeSupervisorReviewAction({
          cwd,
          reviewInputDir: reviewQueueStatus.reviewInputDir,
          runId: handoff.activeRunId,
          taskId: target.parsed.taskId,
          reviewRole: target.parsed.reviewRole,
          actor,
          authContext,
          cycle,
          nowValue
        });
        actions.push({
          cycle,
          action: "enqueue_review_action",
          taskId: target.parsed.taskId,
          reviewRole: target.parsed.reviewRole,
          filePath,
          summary: `queued trusted ${target.parsed.reviewRole} review action via ${actor}`
        });
      }
      continue;
    }

    if (handoff.blockerKind !== "operator_required_continuation") {
      return finalize({
        status: "blocked",
        blockerKind: "unsupported_handoff",
        reason: handoff.reason,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        nextActions: [...handoff.nextActions]
      });
    }

    const continuationStatus = await readDaemonContinuationStatus(cwd);
    if (
      !continuationStatus ||
      continuationStatus.state !== "blocked" ||
      continuationStatus.executionMode !== "operator_required" ||
      !continuationStatus.targetId ||
      !continuationStatus.source ||
      !handoff.activeRunId ||
      !handoff.activeTaskId
    ) {
      return finalize({
        status: "blocked",
        blockerKind: "continuation_derivation_failed",
        reason: "supervisor could not derive a trusted operator continuation action from the daemon handoff",
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId
      });
    }

    if (
      continuationStatus.provider === "claude_app_thread_automation" ||
      continuationStatus.provider === "claude_app_standalone_automation"
    ) {
      const envelope = await readDaemonAutomationEnvelope(cwd);
      if (
        !envelope ||
        envelope.provider !== continuationStatus.provider ||
        envelope.targetId !== continuationStatus.targetId
      ) {
        return finalize({
          status: "blocked",
          blockerKind: "continuation_derivation_failed",
          reason: "supervisor could not derive the Codex app automation handoff from the daemon envelope",
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId
        });
      }

      const nowValue = now().toISOString();
      const appAutomationRequestPath = await writeDaemonAppAutomationRequest(cwd, {
        envelope: {
          provider: envelope.provider,
          continuationIntent: envelope.continuationIntent,
          targetMode: envelope.targetMode,
          scheduleKind: envelope.scheduleKind,
          schedule: envelope.schedule,
          targetId: envelope.targetId,
          source: envelope.source,
          sourceId: envelope.sourceId,
          summary: envelope.summary,
          nextActions: envelope.nextActions,
          workspaceSlug: envelope.workspaceSlug,
          projectSlug: envelope.projectSlug,
          activeRunId: envelope.activeRunId,
          activeTaskId: envelope.activeTaskId
        },
        updatedAt: nowValue
      });
      await writeDaemonOperatorHandoff(cwd, {
        state: "blocked",
        blockerKind: handoff.blockerKind,
        reason: handoff.reason,
        workspaceSlug: handoff.workspaceSlug ?? workspaceSlug,
        projectSlug: handoff.projectSlug ?? projectSlug,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        cycle,
        directiveKind: handoff.directiveKind,
        nextActions: [`apply the Codex app automation request in ${appAutomationRequestPath}`, ...handoff.nextActions],
        detailFiles: {
          ...handoff.detailFiles,
          appAutomationRequest: appAutomationRequestPath
        },
        updatedAt: nowValue
      });
      const summary =
        envelope.provider === "claude_app_thread_automation"
          ? `materialized Codex app thread automation request for ${continuationStatus.targetId}`
          : `materialized Codex app standalone automation request for ${continuationStatus.targetId}`;
      actions.push({
        cycle,
        action: "materialize_app_automation",
        targetId: continuationStatus.targetId,
        filePath: appAutomationRequestPath,
        summary
      });
      return finalize({
        status: "completed",
        reason: summary,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        nextActions: [`apply the Codex app automation request in ${appAutomationRequestPath}`]
      });
    }

    if (continuationStatus.provider === "claude_cli_exec_scheduler") {
      const envelope = await readDaemonAutomationEnvelope(cwd);
      if (!envelope || envelope.provider !== "claude_cli_exec_scheduler" || envelope.targetId !== continuationStatus.targetId) {
        return finalize({
          status: "blocked",
          blockerKind: "continuation_derivation_failed",
          reason: "supervisor could not derive the CLI scheduler handoff from the daemon envelope",
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId
        });
      }

      const nowValue = now().toISOString();
      const schedulerRequest = await writeDaemonCliSchedulerRequest(cwd, {
        envelope: {
          provider: envelope.provider,
          continuationIntent: envelope.continuationIntent,
          targetMode: envelope.targetMode,
          scheduleKind: envelope.scheduleKind,
          schedule: envelope.schedule,
          targetId: envelope.targetId,
          source: envelope.source,
          sourceId: envelope.sourceId,
          summary: envelope.summary,
          nextActions: envelope.nextActions,
          workspaceSlug: envelope.workspaceSlug,
          projectSlug: envelope.projectSlug,
          activeRunId: envelope.activeRunId,
          activeTaskId: envelope.activeTaskId
        },
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        updatedAt: nowValue
      });
      await writeDaemonOperatorHandoff(cwd, {
        state: "blocked",
        blockerKind: handoff.blockerKind,
        reason: handoff.reason,
        workspaceSlug: handoff.workspaceSlug ?? workspaceSlug,
        projectSlug: handoff.projectSlug ?? projectSlug,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        cycle,
        directiveKind: handoff.directiveKind,
        nextActions: [`apply the CLI scheduler request in ${schedulerRequest.requestPath}`, ...handoff.nextActions],
        detailFiles: {
          ...handoff.detailFiles,
          cliSchedulerRequest: schedulerRequest.requestPath
        },
        updatedAt: nowValue
      });
      const summary = schedulerRequest.manualReviewRequired
        ? `materialized CLI scheduler handoff for ${continuationStatus.targetId}; manual review is required before same-thread resume can be scheduled`
        : `materialized CLI scheduler handoff for ${continuationStatus.targetId}`;
      actions.push({
        cycle,
        action: "materialize_cli_scheduler",
        targetId: continuationStatus.targetId,
        filePath: schedulerRequest.requestPath,
        summary
      });
      return finalize({
        status: "completed",
        reason: summary,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        nextActions: [`apply the CLI scheduler request in ${schedulerRequest.requestPath}`]
      });
    }

    const summary = buildSupervisorOperatorNotes({
      targetId: continuationStatus.targetId,
      summary: continuationStatus.summary,
      nextActions: continuationStatus.nextActions,
      override: operatorNotesOverride
    });
    const nowValue = now().toISOString();
    const filePath = await writeSupervisorOperatorContinuationAction({
      cwd,
      operatorActionDir,
      runId: handoff.activeRunId,
      taskId: handoff.activeTaskId,
      targetId: continuationStatus.targetId,
      source: continuationStatus.source,
      sourceId: continuationStatus.sourceId,
      operatorNotes: summary,
      cycle,
      nowValue
    });
    actions.push({
      cycle,
      action: "enqueue_operator_continuation",
      targetId: continuationStatus.targetId,
      filePath,
      summary
    });
  }

  const latestRun = daemonRuns.at(-1);
  return finalize({
    status: "max_cycles_reached",
    reason: `supervisor stopped after reaching the configured cycle budget (${maxSupervisorCycles})`,
    activeRunId: latestRun?.activeRunId ?? null,
    activeTaskId: latestRun?.activeTaskId ?? null,
    sessionId: latestRun?.sessionId ?? null
  });
}


export async function executeSupervisorHistoryCommandFromArgs(
  args: readonly string[],
  options: ExecuteSupervisorHistoryCommandOptions
): Promise<{ format: "json" | "text"; result: SupervisorHistoryCommandResult }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const format = resolveFormatFlag(args);
  const scopeValue =
    resolveCommandFlag(args, "--daemon-supervisor-history-scope") ??
    env.ARCHON_DAEMON_SUPERVISOR_HISTORY_SCOPE ??
    "run";

  if (scopeValue !== "run" && scopeValue !== "all") {
    throw new Error(`Invalid --daemon-supervisor-history-scope value: ${scopeValue}`);
  }

  const resolvedRunId =
    scopeValue === "run"
      ? await resolveRunIdForCommand(args, {
          env,
          findLatestRun: options.findLatestRun
        })
      : undefined;
  const historyOptions = resolveDaemonSupervisorHistoryReadOptions(args, env, resolvedRunId ?? "unknown");
  const historyResult = await readDaemonSupervisorHistory(cwd, historyOptions);
  const latestStatus = await readDaemonSupervisorStatus(cwd, {
    scope: "all",
    limit: 0
  });

  return {
    format,
    result: {
      authorityLabel: "derived_only",
      historyPath: ".archon/work/daemon/supervisor-history.jsonl",
      scope: historyOptions.scope,
      runId: historyOptions.scope === "run" ? historyOptions.runId : undefined,
      retainedCount: historyResult.retainedCount,
      filteredCount: historyResult.filteredCount,
      returnedCount: historyResult.entries.length,
      truncated: historyResult.filteredCount > historyResult.entries.length,
      entries: historyResult.entries,
      latestStatus:
        latestStatus &&
        (historyOptions.scope === "all" || !historyOptions.runId || latestStatus.activeRunId === historyOptions.runId)
          ? {
              state: latestStatus.state,
              blockerKind: latestStatus.blockerKind,
              reason: latestStatus.reason,
              activeRunId: latestStatus.activeRunId,
              activeTaskId: latestStatus.activeTaskId,
              sessionId: latestStatus.sessionId,
              supervisorCycles: latestStatus.supervisorCycles,
              updatedAt: latestStatus.updatedAt
            }
          : undefined
    }
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
