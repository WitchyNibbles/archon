// Daemon split (by concern): the local advisory supervisor. It drives the daemon
// loop (injected via runDaemonCommand), derives trusted review/continuation actions
// from daemon operator handoffs, materializes app-automation / CLI-scheduler requests,
// and records supervisor status + history. Behavior-preserving move from daemon.ts (6b).
//
// Runtime leaf: the daemon loop is injected, so this module never imports daemon.ts at
// runtime. The only back-references to daemon.ts are type-only (DaemonCommandResult,
// ExecuteDaemonCommandOptions) and are erased at compile time — no runtime cycle.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { collectCommandFlagValues, resolveCommandFlag, resolveFormatFlag } from "../cli-flags.ts";
import { resolveRunIdForCommand } from "../workflow.ts";
import type { EnvShape } from "../workflow.ts";
import { isGateReviewRole } from "../domain/contracts.ts";
import type { ReviewRecord } from "../domain/types.ts";
import {
  bindingsUsePlaceholderContent,
  isRepoTemplateReviewIdentityPath,
  parseExpectedReviewTarget,
  resolveRequiredReviewIdentityFilePath
} from "../review.ts";
import { loadReviewIdentityBindings } from "../core/review-context.ts";
import type { DaemonSupervisorStatusObservation } from "../admin/status.ts";
import {
  readDaemonContinuationStatus,
  readDaemonOperatorHandoff,
  readDaemonSupervisorHistory,
  readDaemonSupervisorStatus
} from "./state-readers.ts";
import {
  appendDaemonSupervisorHistory,
  readDaemonAutomationEnvelope,
  writeDaemonAppAutomationRequest,
  writeDaemonCliSchedulerRequest,
  writeDaemonOperatorHandoff,
  writeDaemonSupervisorStatus
} from "./state-writers.ts";
import type { DaemonSupervisorHistoryReadOptions } from "./state-writers.ts";
import { resolveDaemonOperatorActionDir } from "./review-queue.ts";
import type { DaemonCommandResult, ExecuteDaemonCommandOptions } from "../daemon.ts";


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


export interface ExecuteSupervisorCommandOptions extends ExecuteDaemonCommandOptions {
  // Injected daemon-loop runner. Decouples the supervisor from the loop (the loop is
  // passed in by the CLI wrapper) so the supervisor command can live in its own module
  // without importing executeDaemonCommandFromArgs (which would form a cycle).
  runDaemonCommand: (
    args: readonly string[],
    options: ExecuteDaemonCommandOptions
  ) => Promise<{ format: "json" | "text"; result: DaemonCommandResult }>;
}


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
    const daemonResult = await options.runDaemonCommand(args, options);
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
