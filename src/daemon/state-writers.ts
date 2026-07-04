// Daemon split (by concern): daemon state-file WRITERS/clears — serialize the
// continuation-status, automation-envelope, continuation-context, app/cli scheduler
// requests, operator-handoff, scope-expansion, supervisor-status, and supervisor-
// history artifacts under .archon/work/daemon/. Imports one-way from the
// automation-schedule sibling leaf (no cycle back into daemon.ts).
// Behavior-preserving move from daemon.ts.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { removeArchonExport, writeArchonExport } from "../runtime/export-writer.ts";
import {
  buildAppAutomationPrompt,
  convertSupportedCronScheduleToRrule,
  convertSupportedCronScheduleToSystemdOnCalendar,
  detectGitAutomationExecutionEnvironment
} from "./automation-schedule.ts";
import type {
  AutonomousContinuationProvider,
  AutonomousContinuationScheduleKind,
  AutonomousWakeOwner
} from "../admin/autonomous-summary.ts";
import type { DaemonSupervisorStatusObservation } from "../admin/status.ts";
import type { ContinuationAction, RunExecutionPlan } from "../domain/types.ts";

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
  await writeArchonExport(
    path.join(daemonDir, "review-queue-status.json"),
    `${JSON.stringify(status, null, 2)}\n`
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
  await writeArchonExport(
    path.join(daemonDir, "continuation-status.json"),
    `${JSON.stringify(status, null, 2)}\n`
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
  await writeArchonExport(
    path.join(daemonDir, "automation-envelope.json"),
    `${JSON.stringify(envelope, null, 2)}\n`
  );
}


export async function clearDaemonContinuationStatus(cwd: string): Promise<void> {
  await removeArchonExport(path.join(cwd, ".archon", "work", "daemon", "continuation-status.json"));
}


export async function clearDaemonAutomationEnvelope(cwd: string): Promise<void> {
  await removeArchonExport(path.join(cwd, ".archon", "work", "daemon", "automation-envelope.json"));
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
  await writeArchonExport(
    path.join(cwd, DAEMON_CONTINUATION_CONTEXT_RELATIVE_PATH),
    `${continuationPrompt.trim()}\n`
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
  await removeArchonExport(path.join(cwd, DAEMON_CONTINUATION_CONTEXT_RELATIVE_PATH));
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
  await writeArchonExport(path.join(cwd, relativePath), `${JSON.stringify(request, null, 2)}\n`);
  return relativePath;
}


export async function clearDaemonAppAutomationRequest(cwd: string): Promise<void> {
  await removeArchonExport(path.join(cwd, ".archon", "work", "daemon", "app-automation-request.json"));
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
  await writeArchonExport(path.join(cwd, promptPath), prompt);

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
  await writeArchonExport(path.join(cwd, requestPath), `${JSON.stringify(request, null, 2)}\n`);
  return {
    requestPath,
    promptPath,
    runnable,
    manualReviewRequired
  };
}


export async function clearDaemonCliSchedulerRequest(cwd: string): Promise<void> {
  await removeArchonExport(path.join(cwd, ".archon", "work", "daemon", "cli-scheduler-request.json"));
  await removeArchonExport(path.join(cwd, ".archon", "work", "daemon", "cli-scheduler-prompt.txt"));
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
  await writeArchonExport(
    path.join(daemonDir, "operator-handoff.json"),
    `${JSON.stringify(handoff, null, 2)}\n`
  );
}


export async function clearDaemonOperatorHandoff(cwd: string): Promise<void> {
  await removeArchonExport(path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json"));
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
  const relativePath = ".archon/work/daemon/scope-expansion-request.json";
  await writeArchonExport(path.join(cwd, relativePath), `${JSON.stringify(request, null, 2)}\n`);
  return relativePath;
}


export async function clearDaemonScopeExpansionRequest(cwd: string): Promise<void> {
  await removeArchonExport(path.join(cwd, ".archon", "work", "daemon", "scope-expansion-request.json"));
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
  await writeArchonExport(
    path.join(daemonDir, "supervisor-status.json"),
    `${JSON.stringify(status, null, 2)}\n`
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
  await writeArchonExport(historyPath, retainedLines.length > 0 ? `${retainedLines.join("\n")}\n` : "");
}
