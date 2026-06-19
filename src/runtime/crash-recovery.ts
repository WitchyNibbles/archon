// Crash Recovery — Phase 6 resilience for the Archon Agentic Loop Runtime.
//
// When an invocation crosses the context threshold but ends without committing a
// handoff (a crash, a killed session, a dropped connection), the task is left in
// a half-running state that no continuation can pick up. This module detects
// those orphaned invocations and synthesizes a `crash_recovery` handoff so the
// loop can resume from runtime state (TDD §20, SDD reason enum crash_recovery).
//
// All functions are store-agnostic: callers inject the store adapter so unit
// tests run without a database.

import { HandoffController } from "./handoff-controller.ts";
import type { HandoffStoreLike } from "./handoff-controller.ts";

// ---------------------------------------------------------------------------
// RecoverableInvocation — an orphaned invocation eligible for recovery
// ---------------------------------------------------------------------------

export interface RecoverableInvocation {
  invocationId: string;
  runId: string;
  taskId: string;
  role: string;
  contextUsedPct?: number | undefined;
}

// ---------------------------------------------------------------------------
// Store adapter — HandoffStoreLike plus the detection query
// ---------------------------------------------------------------------------

export interface CrashRecoveryStoreLike extends HandoffStoreLike {
  /**
   * Return invocations for the run that have crossed the handoff threshold,
   * have no end state, and have no committed handoff — i.e. presumed crashed.
   */
  listRecoverableInvocations(
    runId: string,
    handoffPct: number
  ): Promise<RecoverableInvocation[]>;
}

// ---------------------------------------------------------------------------
// CrashRecoveryResult
// ---------------------------------------------------------------------------

export interface CrashRecoveryResult {
  invocationId: string;
  taskId: string;
  handoffId: string;
}

// ---------------------------------------------------------------------------
// recoverOrphanedInvocations
// ---------------------------------------------------------------------------

/**
 * Detect and recover orphaned invocations for a run.
 *
 * I/O contract:
 *   Input:  store, runId, optional handoffPct (default 70)
 *   Output: one CrashRecoveryResult per recovered invocation
 *   Side effects: commits a crash_recovery handoff per orphan (status + INSERT)
 *
 * Recovery of one orphan never aborts recovery of the others; per-invocation
 * failures are collected and rethrown only after every orphan is attempted.
 */
export async function recoverOrphanedInvocations(
  store: CrashRecoveryStoreLike,
  runId: string,
  options?: { handoffPct?: number | undefined }
): Promise<CrashRecoveryResult[]> {
  const handoffPct = options?.handoffPct ?? 70;
  const orphans = await store.listRecoverableInvocations(runId, handoffPct);
  const controller = new HandoffController(store);

  const results: CrashRecoveryResult[] = [];
  const failures: string[] = [];

  for (const orphan of orphans) {
    try {
      const commit = await controller.recoverCrashedInvocation({
        invocationId: orphan.invocationId,
        runId: orphan.runId,
        taskId: orphan.taskId,
        role: orphan.role,
        contextUsedPct: orphan.contextUsedPct
      });
      results.push({
        invocationId: orphan.invocationId,
        taskId: orphan.taskId,
        handoffId: commit.record.id
      });
    } catch (error) {
      failures.push(`${orphan.invocationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`crash recovery failed for ${failures.length} invocation(s): ${failures.join("; ")}`);
  }

  return results;
}
