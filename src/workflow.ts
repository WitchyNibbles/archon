// Workflow, run, task-queue, status, checkpoint/resume, and shared CLI helpers.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import { access, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
// CLI-flag helpers moved to a dependency-free leaf; import for internal use and
// re-export to preserve workflow.ts's public surface for existing importers.
import { collectCommandFlagValues, resolveCommandFlag, resolveFormatFlag } from "./cli-flags.ts";
export { collectCommandFlagValues, resolveCommandFlag, resolveFormatFlag };


import { triggerTaskCloseIngestion } from "./runtime/memory-ingestion-pipeline.ts";
import { writeArchonExport } from "./runtime/export-writer.ts";






import { withClient } from "./admin/db.ts";
import { buildRunEvidenceReport, formatRunEvidenceReportMarkdown } from "./admin/report.ts";
import {
  buildAutonomousOperatorSummary,
  type AutonomousOperatorSummary
} from "./admin/autonomous-summary.ts";


import { dispatchGithubWorkItem } from "./admin/github-dispatch.ts";
import { buildOperatorDashboardReport, formatOperatorDashboardReport } from "./admin/ops.ts";
import { buildClosureSignal } from "./core/closure-reconciler.ts";
import { inspectGraphifyStatus, type GraphifyStatusObservation } from "./admin/graphify.ts";
import {
  buildOperatorStatusReport,
  type AgenticStateForTask,
  type ReviewIdentityStatusObservation
} from "./admin/status.ts";
import { exportTaskToObsidian } from "./export/obsidian-exporter.ts";
import {
  advanceTaskQueue,
  repairTaskQueueContent,
  deriveTaskQueueEvidence,
  parseTaskQueueContent,
  type TaskQueue
} from "./archon/task-queue.ts";


import { analysisPhases } from "./domain/types.ts";


import {
  ArchonCoreService
} from "./core/service.ts";
import type {
  AutonomousExecutionState,
  CheckpointRecord,
  ContinuationAction,
  CoverageGapRecord,
  CoverageItemRecord,
  ProjectRuntimeStateRecord,
  ProgressProofRecord,
  RecoveryInspectionReport,
  ProjectRecord,
  ReviewRecord,
  RoutingRecommendationReport,
  RunExecutionPlan,
  RetrievalRole,
  SearchMemoryResult,
  RunStatusSnapshot,
  TaskPacketInput,
  TaskStatus
} from "./domain/types.ts";
import type { WorkspaceRecord } from "./domain/types.ts";
import { PostgresStore } from "./store/postgres-store.ts";
import { clearSeedFailureMetadata, createRuntimeStore, persistProjectIntegrityRepairMetadata, readLastIntegrityRepairMetadata, readSeedFailureMetadata } from "./runtime.ts";
import { executeWorkflowProofCommandFromArgs, inspectReviewIdentityStatus } from "./review.ts";
import type { ExecuteWorkflowProofCommandOptions, WorkflowProofResult } from "./review.ts";
import { getRecentCommits, readDaemonContinuationStatus, readDaemonOperatorHandoff, readDaemonSupervisorStatus, resolveDaemonSupervisorHistoryReadOptions } from "./daemon.ts";


export const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..");

export type EnvShape = NodeJS.ProcessEnv;

export const MAX_CHECKPOINT_STRING_LENGTH = 512;

export const MAX_CHECKPOINT_ARRAY_ITEMS = 32;

export const MAX_CHECKPOINT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const MAX_CHECKPOINT_INPUT_BYTES = 64 * 1024;

export const MAX_DAEMON_STAGNANT_TURNS = 2;


export interface ExecuteStatusCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  inspectReviewIdentity?: (() => Promise<ReviewIdentityStatusObservation>) | undefined;
  inspectGraphify?: (() => Promise<GraphifyStatusObservation>) | undefined;
  findLatestRun?: ((workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>) | undefined;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getExecutionPlan?: ((runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>) | undefined;
  getProjectRuntimeState?: ((projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>) | undefined;
  getAgenticStateForTask?: ((taskId: string) => Promise<{
    contextPct: number | undefined;
    contextBudgetState: string | undefined;
    handoffState: "committed" | "pending" | "none";
    handoffCommittedAt: string | undefined;
    subagentsActive: number;
  } | undefined>) | undefined;
}


export const INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN = Symbol("archon.runtime_preflight_bypass");


export interface ExecuteOpsCommandOptions extends ExecuteStatusCommandOptions {
  getExecutionPlan: (runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>;
  getRoutingReport: (runId: string) => Promise<RoutingRecommendationReport>;
  inspectRecovery: (runId: string, staleAfterHours: number) => Promise<RecoveryInspectionReport>;
}


export interface ExecuteReportCommandOptions extends ExecuteStatusCommandOptions {
  getExecutionPlan: (runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>;
  getRoutingReport: (runId: string) => Promise<RoutingRecommendationReport>;
  inspectRecovery: (runId: string, staleAfterHours: number) => Promise<RecoveryInspectionReport>;
  getHandoffs: (runId: string, taskId: string) => Promise<readonly {
    createdAt: string;
    actor: string;
    ownerRole: RetrievalRole;
    completionStandard: string;
  }[]>;
  getReviews: (runId: string, taskId: string) => Promise<readonly ReviewRecord[]>;
  getApprovals: (runId: string, taskId: string) => Promise<readonly {
    createdAt: string;
    actor: string;
    actorRole: RetrievalRole;
    source: "orchestrator" | "seed" | "self";
    decision: string;
  }[]>;
  getLoopHistory?: ((runId: string, limit: number) => Promise<readonly SearchMemoryResult[]>) | undefined;
}


export interface ExecuteAdvanceActiveTaskCommandOptions extends ExecuteWorkflowProofCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  getProjectContext: (params: {
    workspaceSlug: string;
    projectSlug: string;
  }) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  saveProjectRuntimeState: (state: ProjectRuntimeStateRecord) => Promise<void>;
  /**
   * advanceCommitGuard: returns the repo-relative paths with uncommitted changes
   * (staged, unstaged, or untracked). Injectable for testing; defaults to a real
   * `git status --porcelain` reader in the CLI wrapper.
   */
  getUncommittedPaths?: ((cwd: string) => readonly string[]) | undefined;
}


export interface ExecuteSyncRuntimeExportsCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  getProjectContext: (params: {
    workspaceSlug: string;
    projectSlug: string;
  }) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  saveProjectRuntimeState?: ((state: ProjectRuntimeStateRecord) => Promise<void>) | undefined;
  /**
   * Authoritative run+task snapshot for the resolved run. When present, exports
   * are derived from LIVE run/task rows rather than the stored task-queue
   * snapshot in project_runtime_state — closing the stale-export bug where a
   * sealed run still exported project_status: in_progress with a dangling
   * current_task_id (closureLoop bug 2). Optional so tests without a run/service
   * fall back to the stored snapshot.
   */
  getStatusSnapshot?: ((runId: string) => Promise<RunStatusSnapshot>) | undefined;
}


export interface AdvanceActiveTaskCommandResult {
  mode: "dry_run" | "applied";
  taskId: string;
  nextTaskId: string | null;
  proof: WorkflowProofResult;
  queue: TaskQueue;
  /**
   * advanceCommitGuard: repo-relative paths with uncommitted changes that fall
   * inside the active task's write scope (excluding .archon/** live state). On
   * `--apply` a non-empty list blocks the advance unless `--allow-uncommitted` is
   * passed; in dry-run it is advisory only.
   */
  uncommittedInScope: string[];
}


export interface SyncRuntimeExportsCommandResult {
  mode: "runtime_export_sync";
  workspaceSlug: string;
  projectSlug: string;
  activeTaskId: string | null;
  queue: TaskQueue;
}


export function resolveCommandPositionals(
  args: readonly string[],
  flagsWithValues: ReadonlySet<string> = new Set()
): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (value.startsWith("-")) {
      if (flagsWithValues.has(value)) {
        index += 1;
      }
      continue;
    }

    positionals.push(value);
  }

  return positionals;
}


export function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}


export interface ExecuteRepairTaskQueueCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
}


export interface RepairTaskQueueResult {
  authorityLabel: "derived_only";
  queuePath: string;
  changed: boolean;
  repairedTasks: number;
}


export function appendAutomaticRefreshDeferredSummary(summary: string, kind: "repo context" | "retrieval"): string {
  return `${summary}; automatic ${kind} refresh deferred for interactive planning`;
}


export function hasCommandFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}


export function stripCommandFlag(args: readonly string[], flag: string): string[] {
  return args.filter((value) => value !== flag);
}


export async function resolveActiveTaskIdFromFile(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const activeContent = await readFile(path.join(cwd, ".archon", "ACTIVE"), "utf8");
    const taskIdLine = activeContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("task_id="));

    if (!taskIdLine) {
      return undefined;
    }

    const taskId = taskIdLine.slice("task_id=".length).trim();
    return taskId.length > 0 ? taskId : undefined;
  } catch {
    return undefined;
  }
}


export async function readActiveWorkflowExport(cwd = process.cwd()): Promise<{
  activeState: "active" | "idle" | "complete" | "unknown";
  activeTaskId: string | null;
}> {
  try {
    const activeContent = await readFile(path.join(cwd, ".archon", "ACTIVE"), "utf8");
    const lines = activeContent.split(/\r?\n/).map((line) => line.trim());
    const taskIdLine = lines.find((line) => line.startsWith("task_id="));
    const stateLine = lines.find((line) => line.startsWith("state="));
    const activeTaskId = taskIdLine ? taskIdLine.slice("task_id=".length).trim() || null : null;
    const rawState = stateLine ? stateLine.slice("state=".length).trim().toLowerCase() : "";
    const activeState =
      rawState === "active" || rawState === "idle" || rawState === "complete" ? rawState : "unknown";
    return {
      activeState,
      activeTaskId
    };
  } catch {
    return {
      activeState: "unknown",
      activeTaskId: null
    };
  }
}


export async function readTaskQueueExport(cwd = process.cwd()): Promise<TaskQueue> {
  try {
    const queueContent = await readFile(path.join(cwd, ".archon", "work", "task-queue.json"), "utf8");
    return parseTaskQueueContent(queueContent);
  } catch {
    return buildDefaultTaskQueue();
  }
}


export function hasLocalWorkflowExportDrift(input: {
  runtimeState: {
    activeTaskId: string | null;
    projectStatus: string;
  };
  localExports:
    | {
        activeState: "active" | "idle" | "complete" | "unknown";
        activeTaskId: string | null;
        queueProjectStatus: string;
        queueCurrentTaskId: string | null;
      }
    | undefined;
}): boolean {
  const expectedActiveState =
    input.runtimeState.activeTaskId !== null
      ? "active"
      : isCompleteProjectStatus(input.runtimeState.projectStatus)
        ? "complete"
        : "idle";

  if (!input.localExports) {
    return true;
  }

  return (
    input.localExports.activeState !== expectedActiveState ||
    (input.localExports.activeTaskId ?? null) !== input.runtimeState.activeTaskId ||
    (input.localExports.queueCurrentTaskId ?? null) !== input.runtimeState.activeTaskId ||
    input.localExports.queueProjectStatus !== input.runtimeState.projectStatus
  );
}


export function buildDefaultTaskQueue(): TaskQueue {
  return {
    project_status: "idle",
    current_task_id: null,
    tasks: []
  };
}


export function buildDefaultProductState(): Record<string, unknown> {
  return {
    status: "idle",
    items: []
  };
}


export function parseTaskQueueRecord(candidate: TaskQueue | Record<string, unknown> | undefined): TaskQueue {
  return parseTaskQueueContent(JSON.stringify(candidate ?? buildDefaultTaskQueue()));
}


export function parseTaskQueueRecordOrDefault(candidate: TaskQueue | Record<string, unknown> | undefined): TaskQueue {
  try {
    return parseTaskQueueRecord(candidate);
  } catch {
    return buildDefaultTaskQueue();
  }
}


export function mapSnapshotTaskStatusToQueueStatus(status: TaskStatus): TaskQueue["tasks"][number]["status"] {
  switch (status) {
    case "ready":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "approved":
    case "done":
      return "done";
    case "blocked":
    case "review_blocked":
      return "blocked";
  }
}


export function mapSnapshotTaskPacketToQueueClass(packet: TaskPacketInput): TaskQueue["tasks"][number]["class"] {
  if (packet.qualityGates.includes("release_readiness_required")) {
    return "release_candidate";
  }

  if (packet.qualityGates.includes("product_acceptance")) {
    return "prototype_slice";
  }

  return "docs_only";
}


export function buildAuthoritativeTaskQueueFromSnapshot(
  snapshot: RunStatusSnapshot,
  activeTaskId: string | null
): TaskQueue {
  return {
    project_status: snapshot.run.status,
    current_task_id: activeTaskId,
    tasks: snapshot.tasks.map((task) => ({
      id: task.packet.taskId,
      title: task.packet.title,
      status: mapSnapshotTaskStatusToQueueStatus(task.status),
      class: mapSnapshotTaskPacketToQueueClass(task.packet),
      depends_on: [...task.packet.dependencies],
      acceptance_criteria: [...task.packet.acceptanceCriteria],
      verification: [...task.packet.verificationSteps],
      evidence: deriveTaskQueueEvidence({
        taskId: task.packet.taskId,
        verification: task.packet.verificationSteps,
        qualityGates: task.packet.qualityGates
      }),
      blocker:
        task.status === "blocked"
          ? "runtime task blocked"
          : task.status === "review_blocked"
            ? "awaiting required reviews"
            : null
    }))
  };
}


// Which stored active-task pointer should the EXPORT reflect, given the live
// run+task snapshot? An export must never claim a terminal task is still the
// current in-progress task: a sealed/terminal run, or a stored active task whose
// live row is terminal (approved/done) or absent, yields a null current_task_id.
// This is a faithful reflection of authoritative state, not a re-derivation of
// ownership — that repair is reconcile-runtime-state's job, not the export path.
export function deriveExportActiveTaskId(
  snapshot: RunStatusSnapshot,
  storedActiveTaskId: string | null
): string | null {
  if (!storedActiveTaskId) {
    return null;
  }
  if (isCompleteProjectStatus(snapshot.run.status)) {
    return null;
  }
  const task = snapshot.tasks.find((candidate) => candidate.packet.taskId === storedActiveTaskId);
  if (!task) {
    return null;
  }
  // approved and done both map to a terminal queue status — the pointer is stale.
  if (task.status === "approved" || task.status === "done") {
    return null;
  }
  return storedActiveTaskId;
}


export function alignQueueToActiveTask(
  candidate: TaskQueue | Record<string, unknown> | undefined,
  taskId: string
): TaskQueue {
  const queue = parseTaskQueueRecord(candidate);
  const existingTask = queue.tasks.find((task) => task.id === taskId);

  const tasks = existingTask
    ? queue.tasks.map((task) =>
        task.id === taskId
      ? {
          ...task,
          status: "in_progress" as const,
          blocker: null
        }
          : task
      )
    : [
        ...queue.tasks,
        {
          id: taskId,
          title: taskId,
          status: "in_progress" as const,
          class: "release_candidate" as const,
          depends_on: [],
          acceptance_criteria: ["runtime active task must align with the task packet before completion"],
          verification: ["runtime reconciliation required before queue advancement"],
          evidence: ["runtime synthesized active-task export"],
          blocker: null
        }
      ];

  return {
    project_status: "in_progress",
    current_task_id: taskId,
    tasks
  };
}


export function buildDirectiveProgressFingerprint(directive: RunExecutionPlan["directive"]): string {
  if (directive.kind === "dispatch_owner") {
    return JSON.stringify({
      kind: directive.kind,
      taskId: directive.recommendation.taskId,
      targetRole: directive.recommendation.targetRole
    });
  }

  if (directive.kind === "dispatch_reviews") {
    return JSON.stringify({
      kind: directive.kind,
      targets: directive.recommendations.map((recommendation) => ({
        taskId: recommendation.taskId,
        reviewRole: recommendation.targetReviewRole
      }))
    });
  }

  if (directive.kind === "continue_analysis") {
    return JSON.stringify({
      kind: directive.kind,
      targetId: directive.targetId,
      source: directive.source,
      actions: directive.actions.map((action) => action.kind),
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "blocked") {
    return JSON.stringify({
      kind: directive.kind,
      blockers: directive.blockers
    });
  }

  if (directive.kind === "apply_recovery") {
    return JSON.stringify({
      kind: directive.kind,
      actions: directive.actions.map((action) => action.id)
    });
  }

  if (directive.kind === "dispatch_subagents") {
    return JSON.stringify({
      kind: directive.kind,
      pendingInvestigations: directive.pendingInvestigations,
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "rebuild_inventory") {
    return JSON.stringify({
      kind: directive.kind,
      missingUnderstandingKinds: directive.missingUnderstandingKinds,
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "trace_runtime") {
    return JSON.stringify({
      kind: directive.kind,
      targetIds: directive.targetIds,
      gapIds: directive.gapIds,
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "checkpoint") {
    return JSON.stringify({
      kind: directive.kind,
      checkpointId: directive.checkpointId ?? null,
      progressProofId: directive.progressProofId ?? null,
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "replan_migration") {
    return JSON.stringify({
      kind: directive.kind,
      phase: directive.phase,
      fallbackPhase: directive.fallbackPhase ?? null,
      nextActions: directive.nextActions
    });
  }

  return JSON.stringify({ kind: directive.kind });
}


export function collectCommandFreeText(
  args: readonly string[],
  options: {
    valueFlags?: readonly string[] | undefined;
    booleanFlags?: readonly string[] | undefined;
  } = {}
): string {
  const valueFlags = new Set(options.valueFlags ?? []);
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const tokens: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (booleanFlags.has(value)) {
      continue;
    }
    tokens.push(value);
  }

  return tokens.join(" ").trim();
}


export async function resolveRunIdForCommand(
  args: readonly string[],
  options: {
    env?: EnvShape | undefined;
    findLatestRun?: ((workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>) | undefined;
  }
): Promise<string> {
  const env = options.env ?? process.env;
  const runId = resolveCommandFlag(args, "--run-id");
  if (runId && runId !== "latest") {
    return runId;
  }

  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug || !options.findLatestRun) {
    throw new Error("status-like commands require --run-id <run-id> or --run-id latest with workspace/project");
  }

  const latestRun = await options.findLatestRun(workspaceSlug, projectSlug);
  if (!latestRun) {
    throw new Error(`No runs found for ${workspaceSlug}/${projectSlug}`);
  }

  return latestRun.id;
}


export function resolveMarkdownFormatFlag(args: readonly string[]): "json" | "markdown" {
  const format = resolveCommandFlag(args, "--format") ?? "json";
  if (format !== "json" && format !== "markdown") {
    throw new Error(`Invalid --format value: ${format}`);
  }
  return format;
}


export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}


export function isSelfReferentialResumeTarget(action: ContinuationAction): boolean {
  if (action.kind !== "resume_target") {
    return false;
  }

  return (
    (action.source === "progress_proof" && action.targetId.startsWith("proof:")) ||
    (action.source === "checkpoint" && action.targetId.startsWith("checkpoint:"))
  );
}


export function validateResumeTargetSource(
  action: Extract<ContinuationAction, { kind: "resume_target" }>,
  autonomousState: AutonomousExecutionState
): { valid: true } | { valid: false; reason: string } {
  if (action.source === "progress_proof") {
    if (!action.sourceId?.trim()) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} is missing the originating progress proof id`
      };
    }

    const sourceProof = autonomousState.progressProofs.find((proof) => proof.proofId === action.sourceId);
    if (!sourceProof) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} references missing progress proof ${action.sourceId}`
      };
    }

    if (sourceProof.nextTarget.trim() !== action.targetId) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} no longer matches progress proof ${action.sourceId}`
      };
    }

    return { valid: true };
  }

  if (action.source === "checkpoint") {
    if (!action.sourceId?.trim()) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} is missing the originating checkpoint id`
      };
    }

    const sourceCheckpoint = autonomousState.checkpoints.find(
      (checkpoint) => checkpoint.checkpointId === action.sourceId
    );
    if (!sourceCheckpoint) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} references missing checkpoint ${action.sourceId}`
      };
    }

    if (!sourceCheckpoint.activeTargets.some((target) => target.trim() === action.targetId)) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} no longer matches checkpoint ${action.sourceId}`
      };
    }

    return { valid: true };
  }

  return {
    valid: false,
    reason: `resume target ${action.targetId} uses unsupported source ${action.source}`
  };
}


export async function executeStatusCommandFromArgs(
  args: readonly string[],
  options: ExecuteStatusCommandOptions
) {
  const env = options.env;
  const runId = await resolveRunIdForCommand(args, {
    env,
    findLatestRun: options.findLatestRun
  });
  const daemonSupervisorHistoryOptions = resolveDaemonSupervisorHistoryReadOptions(args, env, runId);

  const staleAfterDaysValue = resolveCommandFlag(args, "--stale-after-days") ?? "1";
  const staleAfterDays = Number.parseInt(staleAfterDaysValue, 10);
  if (!Number.isInteger(staleAfterDays) || staleAfterDays < 0) {
    throw new Error(`Invalid --stale-after-days value: ${staleAfterDaysValue}`);
  }

  const reviewIdentity = options.inspectReviewIdentity
    ? await options.inspectReviewIdentity()
    : await inspectReviewIdentityStatus({
        cwd: options.cwd,
        env
      });
  const graphify = options.inspectGraphify
    ? await options.inspectGraphify()
    : await inspectGraphifyStatus({
        cwd: options.cwd
      });
  const [snapshot, executionPlan] = await Promise.all([
    options.getStatusSnapshot(runId),
    options.getExecutionPlan ? options.getExecutionPlan(runId, staleAfterDays * 24) : Promise.resolve(undefined)
  ]);
  const [runtimeState, localActiveExport, localQueueExport] = await Promise.all([
    options.getProjectRuntimeState ? options.getProjectRuntimeState(snapshot.run.projectId) : Promise.resolve(undefined),
    readActiveWorkflowExport(options.cwd ?? process.cwd()),
    readTaskQueueExport(options.cwd ?? process.cwd())
  ]);
  const daemonContinuation = await readDaemonContinuationStatus(options.cwd ?? process.cwd());
  const daemonHandoff = await readDaemonOperatorHandoff(options.cwd ?? process.cwd());
  const daemonSupervisor = await readDaemonSupervisorStatus(
    options.cwd ?? process.cwd(),
    daemonSupervisorHistoryOptions
  );
  const contradictions: string[] = [];
  const seedFailure = readSeedFailureMetadata(runtimeState);
  const lastIntegrityRepair = readLastIntegrityRepairMetadata(runtimeState);
  if (runtimeState) {
    const runtimeQueue = parseTaskQueueRecordOrDefault(runtimeState.taskQueue);
    const runtimeActiveTaskId = runtimeState.activeTaskId ?? null;
    const localClaimsComplete =
      localActiveExport.activeState === "complete" || isCompleteProjectStatus(localQueueExport.project_status);

    if (seedFailure?.recoveryState === "stale_metadata") {
      contradictions.push(
        "runtime state still carries persisted seed failure metadata after authoritative workflow proof"
      );
    }

    if (localClaimsComplete && !runtimeState.lastVerifiedRunId) {
      contradictions.push("local exports claim complete but runtime state has no authoritative workflow proof");
    }
    if (localClaimsComplete && snapshot.run.status !== "approved" && snapshot.run.status !== "done") {
      contradictions.push(`local exports claim complete while runtime run status is ${snapshot.run.status}`);
    }
    if ((localActiveExport.activeTaskId ?? localQueueExport.current_task_id ?? null) !== runtimeActiveTaskId) {
      const localTaskId = localActiveExport.activeTaskId ?? localQueueExport.current_task_id ?? null;
      if (localTaskId || runtimeActiveTaskId) {
        contradictions.push(
          `local active task ${localTaskId ?? "none"} disagrees with runtime active task ${runtimeActiveTaskId ?? "none"}`
        );
      }
    }
    if ((localQueueExport.current_task_id ?? null) !== (runtimeQueue.current_task_id ?? null)) {
      contradictions.push(
        `local queue current task ${localQueueExport.current_task_id ?? "none"} disagrees with runtime queue current task ${runtimeQueue.current_task_id ?? "none"}`
      );
    }
  }

  const activeTaskId = runtimeState?.activeTaskId ?? null;
  let agenticState: AgenticStateForTask | undefined;
  if (activeTaskId && options.getAgenticStateForTask) {
    const raw = await options.getAgenticStateForTask(activeTaskId);
    if (raw) {
      agenticState = {
        authorityLabel: "runtime_authoritative",
        taskId: activeTaskId,
        ...raw
      };
    }
  }

  // W1 visibility: surface tasks that passed gates (approved) but were never
  // advanced to done — the operator-visible half of the closure wiring. Derived
  // from the authoritative snapshot; advisory only (run `archon close-run`).
  const closure = buildClosureSignal(
    snapshot.tasks.map((task) => ({ status: task.status, taskId: task.packet.taskId }))
  );

  const baseReport = buildOperatorStatusReport({
    snapshot,
    executionPlan,
    daemonContinuation,
    daemonHandoff,
    daemonSupervisor,
    reviewIdentity,
    graphify,
    integrity: runtimeState
      ? {
          authorityLabel: "derived_only",
          status: contradictions.length > 0 ? "contradicted" : "consistent",
          contradictions,
          runtimeState: {
            authorityLabel: "runtime_authoritative",
            activeTaskId: runtimeState.activeTaskId ?? null,
            projectStatus: parseTaskQueueRecordOrDefault(runtimeState.taskQueue).project_status,
            lastVerifiedRunId: runtimeState.lastVerifiedRunId ?? null,
            seedFailure,
            lastIntegrityRepair
          },
          localExports: {
            authorityLabel: "derived_only",
            activeState: localActiveExport.activeState,
            activeTaskId: localActiveExport.activeTaskId,
            queueProjectStatus: localQueueExport.project_status,
            queueCurrentTaskId: localQueueExport.current_task_id
          }
        }
      : {
          authorityLabel: "derived_only",
          status: "unavailable",
          contradictions: []
        },
    agenticState,
    staleAfterDays
  });

  return { ...baseReport, closure };
}


export interface AutonomousCoverageCommandReport {
  authorityLabel: "runtime_authoritative";
  runId: string;
  autonomous: AutonomousOperatorSummary;
  items: CoverageItemRecord[];
}


export interface AutonomousGapsCommandReport {
  authorityLabel: "runtime_authoritative";
  runId: string;
  autonomous: AutonomousOperatorSummary;
  gaps: CoverageGapRecord[];
}


export interface AutonomousCheckpointCommandReport {
  authorityLabel: "runtime_authoritative";
  runId: string;
  autonomous: AutonomousOperatorSummary;
  checkpoints: CheckpointRecord[];
  latestCheckpoint?: CheckpointRecord | undefined;
  latestProgressProof?: ProgressProofRecord | undefined;
  updatedCheckpointId?: string | undefined;
}


export interface AutonomousResumeCommandReport {
  authorityLabel: "runtime_authoritative";
  runId: string;
  autonomous: AutonomousOperatorSummary;
  executionPlan: RunExecutionPlan;
}


export interface ExecuteCoverageCommandOptions {
  env?: EnvShape | undefined;
  findLatestRun?: (workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
}


export interface ExecuteGapsCommandOptions extends ExecuteCoverageCommandOptions {}


export interface ExecuteCheckpointCommandOptions extends ExecuteCoverageCommandOptions {
  cwd?: string | undefined;
  checkpointRun?: (
    runId: string,
    checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">,
    options?: {
      authorityLabel?: CheckpointRecord["authorityLabel"] | undefined;
    }
  ) => Promise<unknown>;
}


export interface ExecuteResumeCommandOptions {
  env?: EnvShape | undefined;
  findLatestRun?: (workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>;
  getResumeSnapshot: (runId: string) => Promise<import("./domain/types.ts").RunResumeSnapshot>;
}


export function buildCoverageCommandReport(snapshot: RunStatusSnapshot): AutonomousCoverageCommandReport {
  return {
    authorityLabel: "runtime_authoritative",
    runId: snapshot.run.id,
    autonomous: buildAutonomousOperatorSummary({ snapshot }),
    items: snapshot.autonomousExecution ? [...snapshot.autonomousExecution.state.coverageItems] : []
  };
}


export function buildGapsCommandReport(snapshot: RunStatusSnapshot, gaps: CoverageGapRecord[]): AutonomousGapsCommandReport {
  return {
    authorityLabel: "runtime_authoritative",
    runId: snapshot.run.id,
    autonomous: buildAutonomousOperatorSummary({ snapshot }),
    gaps
  };
}


export function buildCheckpointCommandReport(input: {
  snapshot: RunStatusSnapshot;
  updatedCheckpointId?: string | undefined;
}): AutonomousCheckpointCommandReport {
  const autonomous = buildAutonomousOperatorSummary({ snapshot: input.snapshot });
  return {
    authorityLabel: "runtime_authoritative",
    runId: input.snapshot.run.id,
    autonomous,
    checkpoints: input.snapshot.autonomousExecution ? [...input.snapshot.autonomousExecution.state.checkpoints] : [],
    latestCheckpoint: autonomous.latestCheckpoint,
    latestProgressProof: autonomous.latestProgressProof,
    updatedCheckpointId: input.updatedCheckpointId
  };
}


export function buildResumeCommandReport(
  snapshot: import("./domain/types.ts").RunResumeSnapshot
): AutonomousResumeCommandReport {
  return {
    authorityLabel: "runtime_authoritative",
    runId: snapshot.run.id,
    autonomous: buildAutonomousOperatorSummary({
      snapshot,
      executionPlan: snapshot.executionPlan
    }),
    executionPlan: snapshot.executionPlan
  };
}


export function formatCoverageCommandReport(report: AutonomousCoverageCommandReport): string {
  const lines = [
    `Run ${report.runId}`,
    `configured: ${report.autonomous.configured ? "yes" : "no"}`,
    `resume: ${report.autonomous.resume.summary}`
  ];

  if (!report.autonomous.configured) {
    lines.push(
      `autonomy-note: run-level workflow proof can still be valid; no active autonomous continuation target is recorded for this run`
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(`profile: ${report.autonomous.profile}`);
  lines.push(`phase: ${report.autonomous.phase}`);
  lines.push(`items: ${report.items.length}`);
  if (report.autonomous.coverageSummary) {
    lines.push(
      `coverage: critical=${report.autonomous.coverageSummary.criticalItemCoverage} validation=${report.autonomous.coverageSummary.criticalItemValidation} callsites=${report.autonomous.coverageSummary.callsiteCoverage} runtime-traces=${report.autonomous.coverageSummary.runtimeTraceCoverage}`
    );
    lines.push(
      `gaps: open=${report.autonomous.coverageSummary.openGapCount} blocking=${report.autonomous.coverageSummary.blockingGapCount}`
    );
  }
  if (report.autonomous.blockers.length > 0) {
    for (const blocker of report.autonomous.blockers) {
      lines.push(`blocked: ${blocker}`);
    }
  }
  return `${lines.join("\n")}\n`;
}


export function formatGapsCommandReport(report: AutonomousGapsCommandReport): string {
  const lines = [
    `Run ${report.runId}`,
    `configured: ${report.autonomous.configured ? "yes" : "no"}`,
    `gaps: ${report.gaps.length}`
  ];
  if (report.gaps.length === 0) {
    lines.push(`resume: ${report.autonomous.resume.summary}`);
    if (!report.autonomous.configured) {
      lines.push(
        `autonomy-note: run-level workflow proof can still be valid; no active autonomous continuation target is recorded for this run`
      );
    }
    return `${lines.join("\n")}\n`;
  }
  for (const gap of report.gaps) {
    lines.push(
      `${gap.id} severity=${gap.severity} blocking=${gap.blocking ? "yes" : "no"} target=${gap.targetId}: ${gap.description}`
    );
  }
  return `${lines.join("\n")}\n`;
}


export function formatCheckpointCommandReport(report: AutonomousCheckpointCommandReport): string {
  const lines = [
    `Run ${report.runId}`,
    `configured: ${report.autonomous.configured ? "yes" : "no"}`,
    `checkpoints: ${report.checkpoints.length}`
  ];
  if (report.updatedCheckpointId) {
    lines.push(`updated-checkpoint: ${report.updatedCheckpointId}`);
  }
  if (report.latestCheckpoint) {
    lines.push(
      `latest-checkpoint: ${report.latestCheckpoint.checkpointId} authority=${report.latestCheckpoint.authorityLabel}`
    );
    if (report.latestCheckpoint.activeTargets.length > 0) {
      lines.push(`active-targets: ${report.latestCheckpoint.activeTargets.join(", ")}`);
    }
    if (report.latestCheckpoint.nextActions.length > 0) {
      lines.push(`next-actions: ${report.latestCheckpoint.nextActions.join("; ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}


export function formatResumeCommandReport(report: AutonomousResumeCommandReport): string {
  const lines = [
    `Run ${report.runId}`,
    `directive: ${report.executionPlan.directive.kind}`,
    `resume: ${report.autonomous.resume.status}/${report.autonomous.resume.source} ${report.autonomous.resume.summary}`
  ];
  if (report.autonomous.resume.nextTarget) {
    lines.push(`next-target: ${report.autonomous.resume.nextTarget}`);
  }
  if (report.autonomous.resume.nextActions.length > 0) {
    lines.push(`next-actions: ${report.autonomous.resume.nextActions.join("; ")}`);
  }
  if (report.autonomous.resume.blockers.length > 0) {
    for (const blocker of report.autonomous.resume.blockers) {
      lines.push(`blocked: ${blocker}`);
    }
  }
  return `${lines.join("\n")}\n`;
}


export async function readCheckpointInput(
  inputArg: string,
  cwd: string
): Promise<Omit<CheckpointRecord, "runId" | "authorityLabel">> {
  const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(cwd, inputArg);
  await validateCheckpointInputPath(inputPath, cwd);
  const fileStats = await stat(inputPath);
  if (fileStats.size > MAX_CHECKPOINT_INPUT_BYTES) {
    throw new Error(
      `checkpoint input from ${inputPath} exceeds the maximum size of ${MAX_CHECKPOINT_INPUT_BYTES} bytes`
    );
  }
  const content = await readFile(inputPath, "utf8");
  const parsed = JSON.parse(content) as unknown;
  return parseCheckpointInput(parsed, inputPath);
}


export function parseCheckpointInput(
  input: unknown,
  sourceLabel: string
): Omit<CheckpointRecord, "runId" | "authorityLabel"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`checkpoint input from ${sourceLabel} must be a JSON object`);
  }

  const record = input as Record<string, unknown>;
  const checkpointId = readRequiredStringField(record, "checkpointId", sourceLabel);
  const phase = readRequiredStringField(record, "phase", sourceLabel);
  validateCheckpointString(checkpointId, "checkpointId");
  if (!analysisPhases.includes(phase as (typeof analysisPhases)[number])) {
    throw new Error(`checkpoint input from ${sourceLabel} has invalid phase: ${phase}`);
  }

  const activeTargets = readRequiredStringArrayField(record, "activeTargets", sourceLabel);
  const recentEvidenceRefs = readRequiredStringArrayField(record, "recentEvidenceRefs", sourceLabel);
  const openGaps = readRequiredStringArrayField(record, "openGaps", sourceLabel);
  const nextActions = readRequiredStringArrayField(record, "nextActions", sourceLabel);
  const compressedContextRef = readOptionalStringField(record, "compressedContextRef");
  const createdAt = readRequiredStringField(record, "createdAt", sourceLabel);

  validateCheckpointStringArray(activeTargets, "activeTargets");
  validateCheckpointStringArray(recentEvidenceRefs, "recentEvidenceRefs");
  validateCheckpointStringArray(openGaps, "openGaps");
  validateCheckpointStringArray(nextActions, "nextActions");
  validateCheckpointTimestamp(createdAt, sourceLabel);
  if (compressedContextRef) {
    validateCompressedContextRef(compressedContextRef);
  }

  return {
    checkpointId,
    phase: phase as CheckpointRecord["phase"],
    activeTargets,
    recentEvidenceRefs,
    openGaps,
    nextActions,
    compressedContextRef,
    createdAt
  };
}


export async function validateCheckpointInputPath(inputPath: string, cwd: string): Promise<void> {
  const [resolvedInputPath, resolvedCwd] = await Promise.all([realpath(inputPath), realpath(cwd)]);
  const relativePath = path.relative(resolvedCwd, resolvedInputPath);
  if (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  ) {
    return;
  }
  throw new Error(`checkpoint input path must stay within ${resolvedCwd}`);
}


export function readRequiredStringField(
  record: Record<string, unknown>,
  field: string,
  sourceLabel: string
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`checkpoint input from ${sourceLabel} is missing required string field ${field}`);
  }
  return value.trim();
}


export function readOptionalStringField(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`checkpoint input has invalid optional string field ${field}`);
  }
  return value.trim();
}


export function readRequiredStringArrayField(
  record: Record<string, unknown>,
  field: string,
  sourceLabel: string
): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`checkpoint input from ${sourceLabel} is missing required string[] field ${field}`);
  }
  return value.map((entry) => entry.trim());
}


export function validateCheckpointString(value: string, field: string): void {
  if (value.length > MAX_CHECKPOINT_STRING_LENGTH) {
    throw new Error(`checkpoint input has ${field} longer than ${MAX_CHECKPOINT_STRING_LENGTH} characters`);
  }
  if (/[\r\n\t]/.test(value)) {
    throw new Error(`checkpoint input has invalid control characters in ${field}`);
  }
}


export function validateCheckpointStringArray(values: readonly string[], field: string): void {
  if (values.length > MAX_CHECKPOINT_ARRAY_ITEMS) {
    throw new Error(`checkpoint input has too many ${field} entries`);
  }
  for (const value of values) {
    validateCheckpointString(value, `${field}[]`);
  }
}


export function validateCheckpointTimestamp(value: string, sourceLabel: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`checkpoint input from ${sourceLabel} has invalid createdAt timestamp`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`checkpoint input from ${sourceLabel} has invalid createdAt timestamp`);
  }
  if (parsed > Date.now() + MAX_CHECKPOINT_FUTURE_SKEW_MS) {
    throw new Error(`checkpoint input from ${sourceLabel} has createdAt too far in the future`);
  }
}


export function validateCompressedContextRef(value: string): void {
  validateCheckpointString(value, "compressedContextRef");
  if (!value.startsWith("memory://")) {
    throw new Error("checkpoint input has invalid compressedContextRef scheme");
  }
}


export async function executeCoverageCommandFromArgs(
  args: readonly string[],
  options: ExecuteCoverageCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveFormatFlag(args);
  const snapshot = await options.getStatusSnapshot(runId);
  return {
    format,
    report: buildCoverageCommandReport(snapshot)
  };
}


export async function executeGapsCommandFromArgs(
  args: readonly string[],
  options: ExecuteGapsCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveFormatFlag(args);
  const snapshot = await options.getStatusSnapshot(runId);
  const allGaps = snapshot.autonomousExecution?.state.gaps ?? [];
  const includeClosed = args.includes("--all");
  const blockingOnly = args.includes("--blocking-only");
  const gaps = allGaps.filter((gap) => (includeClosed ? true : gap.status === "open")).filter((gap) =>
    blockingOnly ? gap.blocking && (includeClosed ? true : gap.status === "open") : true
  );
  return {
    format,
    report: buildGapsCommandReport(snapshot, gaps)
  };
}


export async function executeCheckpointCommandFromArgs(
  args: readonly string[],
  options: ExecuteCheckpointCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveFormatFlag(args);
  const inputArg = resolveCommandFlag(args, "--input");
  let updatedCheckpointId: string | undefined;
  if (inputArg) {
    if (!options.checkpointRun) {
      throw new Error("checkpoint mutation is not available for this command surface");
    }
    const checkpoint = await readCheckpointInput(inputArg, options.cwd ?? process.cwd());
    await options.checkpointRun(runId, checkpoint, {
      authorityLabel: "operator_import"
    });
    updatedCheckpointId = checkpoint.checkpointId;
  }
  const snapshot = await options.getStatusSnapshot(runId);
  return {
    format,
    report: buildCheckpointCommandReport({
      snapshot,
      updatedCheckpointId
    })
  };
}


export async function executeResumeCommandFromArgs(
  args: readonly string[],
  options: ExecuteResumeCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveFormatFlag(args);
  const snapshot = await options.getResumeSnapshot(runId);
  return {
    format,
    report: buildResumeCommandReport(snapshot)
  };
}


export function resolveProjectSelector(
  args: readonly string[],
  env: EnvShape
): { workspaceSlug: string; projectSlug: string } {
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("doctor requires workspace/project context when no explicit run id is provided");
  }

  return { workspaceSlug, projectSlug };
}


export async function readJsonFileIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}


export async function statusCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const report = await executeStatusCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      }
    });
    console.log(JSON.stringify(report));
  });
}


export async function coverageCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, report } = await executeCoverageCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      }
    });

    if (format === "text") {
      process.stdout.write(formatCoverageCommandReport(report));
      return;
    }

    console.log(JSON.stringify(report));
  });
}


export async function gapsCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, report } = await executeGapsCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      }
    });

    if (format === "text") {
      process.stdout.write(formatGapsCommandReport(report));
      return;
    }

    console.log(JSON.stringify(report));
  });
}


export async function checkpointCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, report } = await executeCheckpointCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      checkpointRun(runId, checkpoint, checkpointOptions) {
        return service.checkpointRun(runId, checkpoint, checkpointOptions);
      }
    });

    if (format === "text") {
      process.stdout.write(formatCheckpointCommandReport(report));
      return;
    }

    console.log(JSON.stringify(report));
  });
}


export async function resumeCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, report } = await executeResumeCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getResumeSnapshot(runId) {
        return service.resumeRun(runId);
      }
    });

    if (format === "text") {
      process.stdout.write(formatResumeCommandReport(report));
      return;
    }

    console.log(JSON.stringify(report));
  });
}


export async function executeOpsCommandFromArgs(
  args: readonly string[],
  options: ExecuteOpsCommandOptions
) {
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
  const [status, executionPlan, routing, recovery] = await Promise.all([
    executeStatusCommandFromArgs(args, options),
    options.getExecutionPlan(runId, staleAfterHours),
    options.getRoutingReport(runId),
    options.inspectRecovery(runId, staleAfterHours)
  ]);
  const report = buildOperatorDashboardReport({
    status,
    executionPlan,
    routing,
    recovery
  });

  return {
    format,
    report
  };
}


export async function opsCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const result = await executeOpsCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      getRoutingReport(runId) {
        return service.recommendRouting(runId);
      },
      inspectRecovery(runId, staleAfterHours) {
        return service.inspectRecovery(runId, { staleAfterHours });
      }
    });

    if (result.format === "text") {
      process.stdout.write(formatOperatorDashboardReport(result.report));
      return;
    }

    console.log(JSON.stringify(result.report));
  });
}


export async function executeReportCommandFromArgs(
  args: readonly string[],
  options: ExecuteReportCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveMarkdownFormatFlag(args);
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);
  if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }

  const [status, executionPlan, routing, recovery] = await Promise.all([
    executeStatusCommandFromArgs(args, options),
    options.getExecutionPlan(runId, staleAfterHours),
    options.getRoutingReport(runId),
    options.inspectRecovery(runId, staleAfterHours)
  ]);
  const snapshot = await options.getStatusSnapshot(runId);

  const handoffsByTask = Object.fromEntries(
    await Promise.all(
      snapshot.tasks.map(async (task) => [task.packet.taskId, await options.getHandoffs(runId, task.packet.taskId)])
    )
  );
  const reviewsByTask = Object.fromEntries(
    await Promise.all(
      snapshot.tasks.map(async (task) => [task.packet.taskId, await options.getReviews(runId, task.packet.taskId)])
    )
  );
  const approvalsByTask = Object.fromEntries(
    await Promise.all(
      snapshot.tasks.map(async (task) => [task.packet.taskId, await options.getApprovals(runId, task.packet.taskId)])
    )
  );

  return {
    format,
    report: buildRunEvidenceReport({
      snapshot,
      executionPlan,
      status,
      routing,
      recovery,
      handoffsByTask,
      reviewsByTask,
      approvalsByTask,
      loopHistoryResults: options.getLoopHistory ? await options.getLoopHistory(runId, 20) : []
    })
  };
}


export async function maybeContinueWorkflowAfterProof(
  proof: {
    runId: string;
    taskId: string;
  },
  args: readonly string[],
  options: ExecuteWorkflowProofCommandOptions
): Promise<{
  applied: boolean;
  nextTaskId: string | null;
}> {
  if (
    options.allowQueueContinuation === false ||
    !options.getProjectContext ||
    !options.getProjectRuntimeState ||
    !options.saveProjectRuntimeState
  ) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const env = options.env ?? process.env;
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const runtimeState = await options.getProjectRuntimeState(projectContext.project.id);
  if (!runtimeState?.activeTaskId || runtimeState.activeTaskId !== proof.taskId) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  if (runtimeState.activeRunId && runtimeState.activeRunId !== proof.runId) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const queue = parseTaskQueueRecordOrDefault(runtimeState.taskQueue);
  if (queue.current_task_id !== proof.taskId) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const advanced = advanceTaskQueue(queue, proof.taskId);
  const nextRuntimeState: ProjectRuntimeStateRecord = {
    projectId: projectContext.project.id,
    workspaceId: projectContext.workspace.id,
    activeRunId: proof.runId,
    activeTaskId: advanced.nextTask?.id ?? undefined,
    taskQueue: advanced.queue,
    productState: runtimeState.productState ?? buildDefaultProductState(),
    lastVerifiedRunId: proof.runId,
    metadata: clearSeedFailureMetadata(runtimeState.metadata),
    createdAt: runtimeState.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await options.saveProjectRuntimeState(nextRuntimeState);
  await syncRuntimeWorkflowExports(options.cwd, nextRuntimeState);

  return {
    applied: true,
    nextTaskId: advanced.nextTask?.id ?? null
  };
}


export function normalizeWorkflowExportState(queue: TaskQueue, taskId: string | null): "active" | "idle" | "complete" {
  if (taskId) {
    return "active";
  }

  const projectStatus = queue.project_status.trim().toLowerCase();
  if (projectStatus === "complete" || projectStatus === "completed" || projectStatus === "done") {
    return "complete";
  }

  return "idle";
}


export function formatActiveWorkflowContent(taskId: string | null, queue: TaskQueue): string {
  const lines = [];
  if (taskId) {
    lines.push(`task_id=${taskId}`);
  }
  lines.push("workflow=archon");
  lines.push(`state=${normalizeWorkflowExportState(queue, taskId)}`);
  return `${lines.join("\n")}\n`;
}


export function isCompleteProjectStatus(projectStatus: string | undefined): boolean {
  const normalized = projectStatus?.trim().toLowerCase();
  return normalized === "complete" || normalized === "completed" || normalized === "done";
}


// Export-surface writer: routes through the single Archon export writer so the
// task-queue.json / ACTIVE writes are atomic (temp+rename) and skip-on-unchanged.
// `filePath` must be within `.archon/work/**` or the `.archon/ACTIVE` pointer —
// its only callers are the workflow export writes below.
export async function writeFileIfChanged(filePath: string, content: string): Promise<boolean> {
  return writeArchonExport(filePath, content, { ifChanged: true });
}


export async function syncRuntimeWorkflowExports(
  cwd: string | undefined,
  runtimeState: {
    activeTaskId?: string | null | undefined;
    taskQueue: ProjectRuntimeStateRecord["taskQueue"];
    lastVerifiedRunId?: string | null | undefined;
  }
): Promise<boolean> {
  if (!cwd) {
    return false;
  }

  const queue = parseTaskQueueRecord(runtimeState.taskQueue);
  if (isCompleteProjectStatus(queue.project_status) && !runtimeState.lastVerifiedRunId) {
    throw new Error("Cannot sync complete workflow exports without authoritative runtime proof (missing last verified run)");
  }
  const activeTaskId =
    runtimeState.activeTaskId && runtimeState.activeTaskId.trim().length > 0
      ? runtimeState.activeTaskId.trim()
      : queue.current_task_id;
  const archonRoot = path.join(path.resolve(cwd), ".archon");
  const workRoot = path.join(archonRoot, "work");

  // Parent-directory creation is handled atomically inside the export writer.
  const queueChanged = await writeFileIfChanged(
    path.join(workRoot, "task-queue.json"),
    `${JSON.stringify(queue, null, 2)}\n`
  );
  const activeChanged = await writeFileIfChanged(
    path.join(archonRoot, "ACTIVE"),
    formatActiveWorkflowContent(activeTaskId ?? null, queue)
  );
  return queueChanged || activeChanged;
}


export function formatAdvanceActiveTaskCommandResult(result: AdvanceActiveTaskCommandResult): string {
  return [
    `mode: ${result.mode}`,
    `completed-task: ${result.taskId}`,
    `proof-run: ${result.proof.runId}`,
    `next-task: ${result.nextTaskId ?? "none"}`,
    `queue-current-task: ${result.queue.current_task_id ?? "none"}`,
    `uncommitted-in-scope: ${
      result.uncommittedInScope.length > 0 ? result.uncommittedInScope.join(", ") : "none"
    }`
  ].join("\n");
}


export function formatSyncRuntimeExportsCommandResult(result: SyncRuntimeExportsCommandResult): string {
  return [
    `mode: ${result.mode}`,
    `workspace: ${result.workspaceSlug}`,
    `project: ${result.projectSlug}`,
    `active-task: ${result.activeTaskId ?? "none"}`,
    `queue-current-task: ${result.queue.current_task_id ?? "none"}`,
    `project-status: ${result.queue.project_status}`
  ].join("\n");
}


export async function executeSyncRuntimeExportsCommandFromArgs(
  args: readonly string[],
  options: ExecuteSyncRuntimeExportsCommandOptions
): Promise<{ format: "json" | "text"; result: SyncRuntimeExportsCommandResult }> {
  const env = options.env ?? process.env;
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("sync-runtime-exports requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
  }

  const runtimeState = await options.getProjectRuntimeState(projectContext.project.id);
  const storedActiveTaskId = runtimeState?.activeTaskId ?? null;
  const resolvedRunId = runtimeState?.activeRunId ?? null;

  // Prefer the LIVE run+task rows over the stored task-queue snapshot: after a run
  // is sealed (run done, tasks done) the stored snapshot can still say in_progress
  // with a dangling current_task_id (closureLoop bug 2). Derive project_status,
  // per-task status, and current_task_id from the authoritative snapshot when it
  // is available; fall back to the stored snapshot only when no run/service exists.
  let queue: TaskQueue;
  let activeTaskId: string | null;
  if (resolvedRunId && options.getStatusSnapshot) {
    const snapshot = await options.getStatusSnapshot(resolvedRunId);
    activeTaskId = deriveExportActiveTaskId(snapshot, storedActiveTaskId);
    queue = buildAuthoritativeTaskQueueFromSnapshot(snapshot, activeTaskId);
  } else {
    queue = parseTaskQueueRecord(runtimeState?.taskQueue);
    activeTaskId = storedActiveTaskId;
  }

  const synced = await syncRuntimeWorkflowExports(options.cwd, {
    activeTaskId,
    taskQueue: queue,
    lastVerifiedRunId: runtimeState?.lastVerifiedRunId
  });
  if (synced && runtimeState && options.saveProjectRuntimeState) {
    await persistProjectIntegrityRepairMetadata({
      projectId: projectContext.project.id,
      getProjectRuntimeState: options.getProjectRuntimeState,
      saveProjectRuntimeState: options.saveProjectRuntimeState,
      source: "sync_runtime_exports",
      kind: "local_export_resync",
      summary: "sync-runtime-exports resynced local workflow exports from authoritative runtime state"
    });
  }

  return {
    format: resolveFormatFlag(args),
    result: {
      mode: "runtime_export_sync",
      workspaceSlug,
      projectSlug,
      activeTaskId,
      queue
    }
  };
}


// ─── advanceCommitGuard helpers ──────────────────────────────────────────────

function normalizeGuardPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

// Decode a git-quoted path body (the content between the surrounding double
// quotes). git C-escapes special bytes: standard escapes (\n \t \r \" \\) and
// octal \NNN for non-ASCII bytes. We reassemble the raw byte stream and decode it
// as UTF-8 so non-ASCII filenames survive intact (otherwise they would be
// misclassified and silently excluded from the guard).
function decodeGitQuotedPath(body: string): string {
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    n: 0x0a,
    t: 0x09,
    r: 0x0d,
    '"': 0x22,
    "\\": 0x5c
  };
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? "";
    if (ch === "\\" && i + 1 < body.length) {
      const octal = body.slice(i + 1).match(/^[0-7]{1,3}/);
      if (octal) {
        bytes.push(parseInt(octal[0], 8) & 0xff);
        i += 1 + octal[0].length;
        continue;
      }
      const escChar = body[i + 1] ?? "";
      bytes.push(simple[escChar] ?? escChar.charCodeAt(0));
      i += 2;
      continue;
    }
    for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

// Parse `git status --porcelain` (v1) into the set of repo-relative paths that
// have uncommitted changes (staged, unstaged, or untracked). Renames/copies yield
// the new (post-rename) path — the live deliverable. Pure and unit-testable.
export function parseGitPorcelain(output: string): string[] {
  if (typeof output !== "string" || output.trim().length === 0) {
    return [];
  }
  const paths = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) continue;
    // Porcelain v1 lines are "XY PATH" — two status columns, a space, then the
    // path starting at index 3.
    const status = rawLine.slice(0, 2);
    let entry = rawLine.slice(3).trim();
    if (entry.length === 0) continue;
    // Rename/copy: "old -> new" — keep the new path. Only treat " -> " as a
    // rename separator when the status code is actually R(ename) or C(opy), so a
    // literal " -> " inside an ordinary filename is not misparsed.
    if (status.includes("R") || status.includes("C")) {
      // Use lastIndexOf so an original filename that itself contains " -> "
      // still resolves to the true new path (the final segment).
      const arrow = entry.lastIndexOf(" -> ");
      if (arrow !== -1) {
        entry = entry.slice(arrow + 4).trim();
      }
    }
    // git quotes paths containing special characters; drop the surrounding quotes
    // and decode the C-escapes within.
    if (entry.length >= 2 && entry.startsWith("\"") && entry.endsWith("\"")) {
      entry = decodeGitQuotedPath(entry.slice(1, -1));
    }
    if (entry.length > 0) paths.add(entry);
  }
  return [...paths];
}

// From a set of uncommitted paths, select those that are real deliverables for the
// active task: inside its write scope AND not under .archon/** (live workflow state
// that advance-active-task itself rewrites and must never block on). Pure.
export function selectUncommittedDeliverables(
  uncommittedPaths: readonly string[],
  allowedWriteScope: readonly string[]
): string[] {
  const scope = allowedWriteScope
    .map((entry) => normalizeGuardPath(entry))
    .filter((entry) => entry.length > 0);
  if (scope.length === 0) {
    return [];
  }
  const result = new Set<string>();
  for (const raw of uncommittedPaths) {
    const p = normalizeGuardPath(raw);
    if (p.length === 0) continue;
    if (p === ".archon" || p.startsWith(".archon/")) continue;
    const inScope = scope.some((entry) => p === entry || p.startsWith(`${entry}/`));
    if (inScope) result.add(p);
  }
  return [...result].sort();
}

// Decide whether the commit guard blocks the advance. Pure and unit-testable: only
// an `--apply` mutation with in-scope uncommitted deliverables and no override is
// blocked; dry-run and overridden invocations always pass.
export function evaluateCommitGuard(input: {
  mode: "dry_run" | "applied";
  uncommittedInScope: readonly string[];
  allowOverride: boolean;
  taskId: string;
}): { block: boolean; reason?: string } {
  if (input.mode !== "applied" || input.allowOverride || input.uncommittedInScope.length === 0) {
    return { block: false };
  }
  const shown = input.uncommittedInScope.slice(0, 10).join(", ");
  const more =
    input.uncommittedInScope.length > 10
      ? ` (and ${input.uncommittedInScope.length - 10} more)`
      : "";
  return {
    block: true,
    reason:
      `advance-active-task refusing to close task "${input.taskId}": ${input.uncommittedInScope.length} ` +
      `uncommitted change(s) inside its write scope are not committed: ${shown}${more}. ` +
      `Commit the task's deliverables first, or pass --allow-uncommitted to override.`
  };
}

// Resolve the commit-guard decision for an advance: read the active task's write
// scope from the status snapshot, intersect it with the working tree's uncommitted
// paths, and decide whether to block. Extracted as an injectable seam so the full
// wiring (snapshot lookup by task id → scope → uncommitted intersection → decision)
// is unit-testable without standing up the workflow-proof path. Fail-open when the
// active task is absent from the snapshot (indeterminate scope → empty → no block).
export async function computeAdvanceCommitGuard(input: {
  runId: string;
  activeTaskId: string;
  mode: "dry_run" | "applied";
  allowOverride: boolean;
  cwd: string;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getUncommittedPaths: (cwd: string) => readonly string[];
}): Promise<{ uncommittedInScope: string[]; guard: { block: boolean; reason?: string } }> {
  const snapshot = await input.getStatusSnapshot(input.runId);
  const activeTask = snapshot.tasks.find((task) => task.packet.taskId === input.activeTaskId);
  const activeScope = activeTask ? activeTask.packet.allowedWriteScope : [];
  const uncommittedInScope = selectUncommittedDeliverables(
    input.getUncommittedPaths(input.cwd),
    activeScope
  );
  const guard = evaluateCommitGuard({
    mode: input.mode,
    uncommittedInScope,
    allowOverride: input.allowOverride,
    taskId: input.activeTaskId
  });
  return { uncommittedInScope, guard };
}

// Real git reader — fail-open (returns []) when git is unavailable or the command
// fails, so the guard never blocks a legitimate advance in a non-git context.
function readUncommittedPaths(cwd: string): string[] {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000
    });
    if (res.status !== 0 || typeof res.stdout !== "string") {
      return [];
    }
    return parseGitPorcelain(res.stdout);
  } catch {
    return [];
  }
}

export async function executeAdvanceActiveTaskCommandFromArgs(
  args: readonly string[],
  options: ExecuteAdvanceActiveTaskCommandOptions
): Promise<{ format: "json" | "text"; result: AdvanceActiveTaskCommandResult }> {
  const env = options.env ?? process.env;
  const explicitTaskId = resolveCommandFlag(args, "--task-id");
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("advance-active-task requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
  }

  const projectRuntimeState = await options.getProjectRuntimeState(projectContext.project.id);
  const activeTaskId = projectRuntimeState?.activeTaskId;

  if (!activeTaskId) {
    throw new Error("advance-active-task requires an active runtime task");
  }
  if (explicitTaskId && explicitTaskId !== activeTaskId) {
    throw new Error(
      `advance-active-task task mismatch: active runtime task is "${activeTaskId}", not "${explicitTaskId}"`
    );
  }

  const format = resolveFormatFlag(args);
  const proof = await executeWorkflowProofCommandFromArgs([...args, "--task-id", activeTaskId], {
    ...options,
    allowQueueContinuation: false
  });
  const queue = parseTaskQueueRecord(projectRuntimeState?.taskQueue);

  if (queue.current_task_id !== activeTaskId) {
    throw new Error(
      `advance-active-task requires runtime queue current_task_id "${queue.current_task_id ?? "none"}" to match active task "${activeTaskId}"`
    );
  }

  const advanced = advanceTaskQueue(queue, activeTaskId);

  // advanceCommitGuard: do not close a task while its real deliverables are still
  // uncommitted. Read the active task's write scope from the authoritative status
  // snapshot, intersect it with the working tree's uncommitted paths (excluding
  // .archon/** live state), and refuse the `--apply` mutation when any remain. This
  // closes the commit-before-advance ordering footgun that can otherwise let the
  // autonomy loop advance past a task whose source/test/control-layer changes never
  // landed. `--allow-uncommitted` overrides for deliberate exceptions.
  const { uncommittedInScope, guard } = await computeAdvanceCommitGuard({
    runId: proof.runId,
    activeTaskId,
    mode: args.includes("--apply") ? "applied" : "dry_run",
    allowOverride: args.includes("--allow-uncommitted"),
    cwd: options.cwd ?? process.cwd(),
    getStatusSnapshot: options.getStatusSnapshot,
    getUncommittedPaths: options.getUncommittedPaths ?? readUncommittedPaths
  });

  const result: AdvanceActiveTaskCommandResult = {
    mode: args.includes("--apply") ? "applied" : "dry_run",
    taskId: activeTaskId,
    nextTaskId: advanced.nextTask?.id ?? null,
    proof,
    queue: advanced.queue,
    uncommittedInScope
  };

  if (guard.block) {
    throw new Error(guard.reason);
  }

  if (result.mode === "dry_run") {
    return {
      format,
      result
    };
  }

  const nextRuntimeState: ProjectRuntimeStateRecord = {
    projectId: projectContext.project.id,
    workspaceId: projectContext.workspace.id,
    activeRunId: proof.runId,
    activeTaskId: result.nextTaskId ?? undefined,
    taskQueue: advanced.queue,
    productState: projectRuntimeState?.productState ?? buildDefaultProductState(),
    lastVerifiedRunId: proof.runId,
    metadata: clearSeedFailureMetadata(projectRuntimeState?.metadata),
    createdAt: projectRuntimeState?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await options.saveProjectRuntimeState(nextRuntimeState);
  await syncRuntimeWorkflowExports(options.cwd, nextRuntimeState);

  // export task closure notes to Obsidian vault (best-effort — never throws)
  const taskPacketPath = path.join(
    options.cwd ?? process.cwd(),
    ".archon",
    "work",
    "tasks",
    `task-${activeTaskId}.md`
  );
  const reviewFindings = proof.latestReviews.map((r) => ({
    role: r.reviewerRole,
    outcome: r.state,
    findings: r.findings
  }));
  const commitList = getRecentCommits(options.cwd ?? process.cwd());
  exportTaskToObsidian(
    { taskId: activeTaskId, taskPacketPath, reviewRecords: reviewFindings, commitList },
    { env, repoRoot: options.cwd }
  ).catch((err: unknown) => {
    process.stderr.write(
      `[obsidian-exporter] unexpected error during export: ${err instanceof Error ? err.message : String(err)}\n`
    );
  });

  return {
    format,
    result
  };
}


export async function reportCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const result = await executeReportCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      getRoutingReport(runId) {
        return service.recommendRouting(runId);
      },
      inspectRecovery(runId, staleAfterHours) {
        return service.inspectRecovery(runId, { staleAfterHours });
      },
      getHandoffs(runId, taskId) {
        return store.getHandoffs(runId, taskId);
      },
      getReviews(runId, taskId) {
        return store.getReviews(runId, taskId);
      },
      getApprovals(runId, taskId) {
        return store.getApprovals(runId, taskId);
      },
      getLoopHistory(runId, limit) {
        return service.getLoopExecutionHistory(runId, { limit });
      }
    });

    if (result.format === "markdown") {
      process.stdout.write(formatRunEvidenceReportMarkdown(result.report));
      return;
    }

    console.log(JSON.stringify(result.report));
  });
}


export async function advanceActiveTaskCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, result } = await executeAdvanceActiveTaskCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      getUncommittedPaths(cwd) {
        return readUncommittedPaths(cwd);
      },
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      findLatestRunForTask(workspaceSlug, projectSlug, taskId) {
        return store.findLatestRunForTask({ workspaceSlug, projectSlug, taskId });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getReviews(runId, taskId) {
        return store.getReviews(runId, taskId);
      },
      getApprovals(runId, taskId) {
        return store.getApprovals(runId, taskId);
      }
    });

    if (result.mode === "applied") {
      triggerTaskCloseIngestion({ taskId: result.taskId, cwd: process.cwd(), store }).catch(() => {});
    }

    if (format === "text") {
      process.stdout.write(`${formatAdvanceActiveTaskCommandResult(result)}\n`);
      return;
    }

    console.log(JSON.stringify(result));
  });
}


export async function syncRuntimeExportsCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, result } = await executeSyncRuntimeExportsCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      }
    });

    if (format === "text") {
      process.stdout.write(`${formatSyncRuntimeExportsCommandResult(result)}\n`);
      return;
    }

    console.log(JSON.stringify(result));
  });
}


export async function executeGithubDispatchCommandFromArgs(args: readonly string[]) {
  const inputArg = resolveCommandFlag(args, "--input");
  if (!inputArg) {
    throw new Error("github-dispatch requires --input <github-event.json>");
  }
  const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(process.cwd(), inputArg);
  const taskId = resolveCommandFlag(args, "--task-id");
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? process.env.ARCHON_WORKSPACE_SLUG ?? "default";
  const workspaceName = resolveCommandFlag(args, "--workspace-name") ?? process.env.ARCHON_WORKSPACE_NAME;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? process.env.ARCHON_PROJECT_SLUG;
  const projectName = resolveCommandFlag(args, "--project-name") ?? process.env.ARCHON_PROJECT_NAME;

  if (!projectSlug) {
    throw new Error("github-dispatch requires ARCHON_PROJECT_SLUG or --project-slug");
  }

  return withClient(async (client) =>
    dispatchGithubWorkItem({
      store: createRuntimeStore(client),
      workspaceSlug,
      workspaceName,
      projectSlug,
      projectName,
      inputPath,
      taskId,
      dryRun: args.includes("--dry-run")
    })
  );
}


export async function githubDispatchCommand(args: readonly string[]) {
  console.log(JSON.stringify(await executeGithubDispatchCommandFromArgs(args)));
}


export async function executeRepairTaskQueueCommandFromArgs(
  args: readonly string[],
  options: ExecuteRepairTaskQueueCommandOptions = {}
): Promise<RepairTaskQueueResult> {
  const cwd = options.cwd ?? process.cwd();
  const queuePathArg = resolveCommandFlag(args, "--queue-path");
  const queuePath = queuePathArg ? path.resolve(cwd, queuePathArg) : path.join(cwd, ".archon", "work", "task-queue.json");
  const existing = await readFile(queuePath, "utf8");
  const repaired = repairTaskQueueContent(existing);

  if (repaired.changed) {
    // Route the default `.archon/work/task-queue.json` through the atomic export
    // writer; an operator `--queue-path` override to a non-export location keeps
    // the plain write so repair can still target an arbitrary queue file.
    const defaultQueuePath = path.join(cwd, ".archon", "work", "task-queue.json");
    if (path.resolve(queuePath) === path.resolve(defaultQueuePath)) {
      await writeArchonExport(queuePath, repaired.content);
    } else {
      await writeFile(queuePath, repaired.content, "utf8");
    }
  }

  return {
    authorityLabel: "derived_only",
    queuePath,
    changed: repaired.changed,
    repairedTasks: repaired.repairedTasks
  };
}


export async function repairTaskQueueCommand(args: readonly string[]) {
  console.log(JSON.stringify(await executeRepairTaskQueueCommandFromArgs(args)));
}
