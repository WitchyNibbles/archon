// Daemon split (loop-monolith decomposition, 6l): the blocked / apply_recovery
// directive handler, lifted out of executeDaemonCommandFromArgs.
//
// SINGLE exit: both directive kinds always terminate the loop with a blocked
// result — there is no `continue`/fallthrough — so the handler returns a plain
// Promise<DaemonCommandResult> (NOT the `| undefined` continue-signal of 6i/6k).
//
// The two kinds differ only in their cycle summary, blockerKind, and reason:
//   "blocked"        — runtime reported no executable next step (runtime_blocked)
//   "apply_recovery" — safe recovery could not clear the blockers (recovery_required)
//
// latestSessionId is read through `getSessionId` (a live getter, NOT a captured
// value). The handler only READS the session id — it never writes it back.
import type { DaemonCommandResult, DaemonCycleRecord } from "../daemon.ts";
import type { DaemonBlockedResultBuilder } from "./codex-turn.ts";
import type { RunExecutionPlan } from "../domain/types.ts";

/** Per-cycle inputs the handler receives from the loop. */
export interface DaemonBlockedRecoveryInput {
  directive: Extract<RunExecutionPlan["directive"], { kind: "blocked" | "apply_recovery" }>;
  cycle: number;
  activeRunId: string;
  activeTaskId: string;
}

/** Stable (per-invocation) dependencies the handler needs from the loop. */
export interface DaemonBlockedRecoveryDeps {
  /** The loop's cycle accumulator; mutated by push (ref-safe). */
  cycles: DaemonCycleRecord[];
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
  blockedResult: DaemonBlockedResultBuilder;
}

/**
 * Handles a `blocked` or `apply_recovery` directive: pushes a blocked cycle
 * record and returns a structured blocked result. Always terminates the loop
 * (no continue signal), so the return type is a plain DaemonCommandResult.
 */
export async function handleDaemonBlockedOrRecovery(
  input: DaemonBlockedRecoveryInput,
  deps: DaemonBlockedRecoveryDeps
): Promise<DaemonCommandResult> {
  const { directive, cycle, activeRunId, activeTaskId } = input;
  const { cycles } = deps;

  cycles.push({
    cycle,
    directiveKind: directive.kind,
    action: "blocked",
    runId: activeRunId,
    taskId: activeTaskId,
    sessionId: deps.getSessionId() ?? null,
    summary:
      directive.kind === "blocked"
        ? directive.blockers.join(" | ") || "runtime reported no executable next step"
        : "runtime still requires explicit recovery before the daemon can continue"
  });

  return deps.blockedResult({
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
