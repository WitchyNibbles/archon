// Daemon split (by concern) — leaf module: pure post-turn analysis. After a
// Codex turn the loop must decide (a) how many consecutive no-progress turns
// have accumulated and (b) whether the run should block (and how) on a
// no-progress / scope-blocked turn. Both are pure decisions over the parsed
// turn message and prior stagnation metadata — extracted out of
// executeDaemonCommandFromArgs so the loop performs only the side effects
// (state writes, cycle bookkeeping, blocked-handoff) on top of these results.
import type { RunExecutionPlan } from "../domain/types.ts";
import { MAX_DAEMON_STAGNANT_TURNS } from "../workflow.ts";
import { daemonMessageHasScopeConflict } from "./turn-prompt.ts";
import type { DaemonStagnationMetadata, ParsedDaemonTurnMessage } from "./turn-prompt.ts";

type DaemonDirectiveKind = RunExecutionPlan["directive"]["kind"];

/**
 * Compute the consecutive no-progress turn count. When the turn made progress
 * the streak resets to 0. When it did not, the count carries forward (+1) only
 * if the prior stagnation record matches the same run/task/directive/progress
 * key; otherwise a fresh no-progress turn starts the streak at 1.
 */
export function computeDaemonStagnantTurnCount(input: {
  noProgress: boolean;
  priorStagnation: DaemonStagnationMetadata | undefined;
  runId: string;
  taskId: string;
  directiveKind: DaemonDirectiveKind;
  progressKey: string;
}): number {
  const { noProgress, priorStagnation } = input;
  const continuesPriorStreak =
    noProgress &&
    !!priorStagnation &&
    priorStagnation.runId === input.runId &&
    priorStagnation.taskId === input.taskId &&
    priorStagnation.directiveKind === input.directiveKind &&
    priorStagnation.progressKey === input.progressKey;

  if (continuesPriorStreak) {
    return priorStagnation!.count + 1;
  }
  return noProgress ? 1 : 0;
}


export interface DaemonScopeExpansionPayload {
  blockedPaths: string[];
  requestedWriteScope: string[];
  reason: string;
}

export type DaemonNoProgressOutcome =
  | { shouldBlock: false }
  | {
      shouldBlock: true;
      scopeConflict: boolean;
      blockerKind: "scope_expansion_required" | "runtime_blocked";
      cycleAction: "request_scope_expansion" | "blocked";
      reason: string;
      nextActions: string[];
      scopeExpansion?: DaemonScopeExpansionPayload | undefined;
    };

/**
 * Decide whether a no-progress turn should block the run. A turn blocks when the
 * worker reported `blocked` or the no-progress streak reached
 * MAX_DAEMON_STAGNANT_TURNS. A scope conflict routes to a scope-expansion block
 * (carrying the requested-scope payload to persist) instead of a plain runtime
 * block. Returns `{ shouldBlock: false }` when the turn made progress or has not
 * yet exhausted the stagnation budget.
 */
export function evaluateDaemonNoProgressOutcome(input: {
  noProgress: boolean;
  parsedTurnMessage: ParsedDaemonTurnMessage | undefined;
  stagnantTurnCount: number;
  activeTaskId: string;
}): DaemonNoProgressOutcome {
  if (!input.noProgress) {
    return { shouldBlock: false };
  }

  const { parsedTurnMessage, stagnantTurnCount, activeTaskId } = input;
  const workerSummary = parsedTurnMessage
    ? [parsedTurnMessage.summary, ...parsedTurnMessage.blockers].filter(Boolean).join(" | ")
    : "runtime state was unchanged after the Codex turn";
  const scopeConflict = daemonMessageHasScopeConflict(parsedTurnMessage);
  const shouldBlockNow =
    parsedTurnMessage?.status === "blocked" || stagnantTurnCount >= MAX_DAEMON_STAGNANT_TURNS;

  if (!shouldBlockNow) {
    return { shouldBlock: false };
  }

  const scopeExpansion: DaemonScopeExpansionPayload | undefined =
    scopeConflict && parsedTurnMessage?.scopeRequest
      ? {
          blockedPaths: [...parsedTurnMessage.scopeRequest.blockedPaths],
          requestedWriteScope:
            parsedTurnMessage.scopeRequest.requestedWriteScope.length > 0
              ? [...parsedTurnMessage.scopeRequest.requestedWriteScope]
              : [...parsedTurnMessage.scopeRequest.blockedPaths],
          reason: parsedTurnMessage.scopeRequest.reason ?? parsedTurnMessage.summary
        }
      : undefined;

  const reason = scopeConflict
    ? `daemon stopped after a scope-blocked no-progress turn: ${workerSummary}`
    : parsedTurnMessage?.status === "blocked"
      ? `daemon stopped after a blocked no-progress turn: ${workerSummary}`
      : `daemon detected ${stagnantTurnCount} consecutive no-progress turns for ${activeTaskId}: ${workerSummary}`;
  const nextActions = scopeConflict
    ? [
        "widen the task packet allowed write scope to include the blocked paths or split them into a follow-on task",
        "record the exact blocked paths in the blocker handoff before rerouting"
      ]
    : [
        "inspect the active task packet and daemon session for missing runtime proof, handoff, or verification steps",
        "reroute only after a concrete runtime state change is possible"
      ];

  return {
    shouldBlock: true,
    scopeConflict,
    blockerKind: scopeConflict ? "scope_expansion_required" : "runtime_blocked",
    cycleAction: scopeConflict ? "request_scope_expansion" : "blocked",
    reason,
    nextActions,
    scopeExpansion
  };
}
