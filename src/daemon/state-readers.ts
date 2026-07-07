// Daemon split (by concern): daemon state-file READERS — parse and validate the
// continuation-status, operator-handoff, supervisor-status, and supervisor-history
// JSON artifacts under .archon/work/daemon/. Self-contained leaf. Behavior-preserving
// move from daemon.ts. (Supervisor-history result types live in the state-writers
// sibling and are re-exported by daemon.ts; imported type-only here — erased at
// runtime, no cycle.)
import { readFile } from "node:fs/promises";
import path from "node:path";
import { selectLocalContinuationProvider } from "../admin/autonomous-summary.ts";
import type {
  DaemonContinuationStatusObservation,
  DaemonOperatorHandoffObservation,
  DaemonSupervisorStatusObservation
} from "../admin/status.ts";
import {
  DAEMON_HANDOFF_STATES,
  DAEMON_HANDOFF_BLOCKER_KINDS,
  DAEMON_SUPERVISOR_STATES,
  DAEMON_SUPERVISOR_BLOCKER_KINDS
} from "../admin/status.ts";
import { validateEnumMember } from "../admin/why-sidecar-validation.ts";
import type {
  DaemonSupervisorHistoryReadOptions,
  DaemonSupervisorHistoryReadResult
} from "../daemon.ts";

/** Round-15: validates a daemon-sidecar enum field against `admin/status.ts`'s
 * canonical arrays (round-14 left those arrays as dead code; this wires them
 * up for real) — replaces hand-rolled `===` OR-chains. `fallback` preserves
 * each field's existing "always return a value" contract. */
function matchOrFallback<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return validateEnumMember(typeof value === "string" ? value : undefined, allowed) ?? fallback;
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
    const state = matchOrFallback(parsed.state, DAEMON_HANDOFF_STATES, "invalid");
    const blockerKind = matchOrFallback(parsed.blockerKind, DAEMON_HANDOFF_BLOCKER_KINDS, "unknown");
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
    const state = matchOrFallback(parsed.state, DAEMON_SUPERVISOR_STATES, "invalid");
    // blockerKind stays genuinely OPTIONAL here (unlike the handoff reader
    // above) — a present-but-unrecognized string still becomes "unknown",
    // but a non-string value stays undefined, matching this field's existing
    // `?: ... | undefined` contract exactly.
    const blockerKind =
      validateEnumMember(typeof parsed.blockerKind === "string" ? parsed.blockerKind : undefined, DAEMON_SUPERVISOR_BLOCKER_KINDS) ??
      (typeof parsed.blockerKind === "string" ? "unknown" : undefined);
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
        // Round-15: a 3rd hand-rolled duplicate (no "invalid" member here —
        // unrecognized DROPS the whole line via `!state` below, unlike the
        // top-level reader's fallback). Deliberately deferred: unconsumed by
        // the why-redaction vocabulary pipeline, so no redaction exposure;
        // needs its own narrower "terminal-only" array, a separate cleanup.
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
