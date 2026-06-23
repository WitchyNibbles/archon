// Daemon split (loop-monolith decomposition, 6m): the blockedResult loop
// closure, lifted out of executeDaemonCommandFromArgs.
//
// createDaemonBlockedResult is a factory that takes stable (per-invocation)
// deps once and returns the DaemonBlockedResultBuilder closure that every
// downstream handler already receives as a callback. The loop replaces its
// inline `const blockedResult = async (input) => { ... }` with:
//
//   const blockedResult = createDaemonBlockedResult({ cwd, workspaceSlug, ... });
//
// All downstream call sites — review-dispatch, continue-analysis, complete,
// blocked-recovery, operator-continuation, codex-turn — stay byte-identical.
//
// latestSessionId is read through `getSessionId` (a live getter, NOT a
// captured snapshot). The closure reads the session id at call time so it
// always reflects the most-recent codex turn.
import { writeDaemonOperatorHandoff } from "./state-writers.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type { DaemonCommandResult, DaemonCycleRecord } from "../daemon.ts";
import type { DaemonBlockedResultBuilder, DaemonBlockedResultInput } from "./codex-turn.ts";

export type { DaemonBlockedResultInput, DaemonBlockedResultBuilder };

/** Stable (per-invocation) dependencies the factory needs from the loop. */
export interface DaemonBlockedResultFactoryDeps {
  cwd: string;
  workspaceSlug: string;
  projectSlug: string;
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
  now: () => Date;
  /** The loop's cycle accumulator; carried by reference into the returned object. */
  cycles: DaemonCycleRecord[];
}

/**
 * Returns the loop's blockedResult callback. The returned function writes the
 * operator handoff file and builds the structured DaemonCommandResult — exactly
 * as the inline closure did before extraction.
 */
export function createDaemonBlockedResult(
  deps: DaemonBlockedResultFactoryDeps
): DaemonBlockedResultBuilder {
  const { cwd, workspaceSlug, projectSlug, getSessionId, now, cycles } = deps;

  return async (input: DaemonBlockedResultInput): Promise<DaemonCommandResult> => {
    await writeDaemonOperatorHandoff(cwd, {
      state: "blocked",
      blockerKind: input.blockerKind,
      reason: input.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      sessionId: getSessionId() ?? null,
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
      sessionId: getSessionId() ?? null,
      cycles
    };
  };
}
