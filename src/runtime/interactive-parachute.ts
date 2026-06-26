// Interactive parachute — in-session context-handoff guarantee for plain `claude` REPLs.
//
// Design: handoffConsumerWiring rev 2, P1 (interactive parachute).
//
// SessionStart writes context-guard.json so PreCompact has an invocation anchor.
// No external supervisor, no process exit, no lease — works for plain `claude`.
//
// HandoffController is used directly (not a mock) so the real validation +
// commit logic runs (council C7: not a pure injected-dep mock-expectation).
//
// Allowed writes: src/runtime/ (runtime/store as needed).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HandoffController, type HandoffStoreLike } from "./handoff-controller.ts";

// ---------------------------------------------------------------------------
// Re-exports for callers that need the store interface
// ---------------------------------------------------------------------------

export type { HandoffStoreLike };

// ---------------------------------------------------------------------------
// InteractiveHandoffStoreLike — extends HandoffStoreLike with on-demand
// invocation creation for the interactive (plain `claude`) surface.
// ---------------------------------------------------------------------------

/**
 * Store interface required by runPrecompactHandoff.
 *
 * Extends HandoffStoreLike with upsertInteractiveInvocation, which creates
 * the backing invocation row on demand. For the interactive surface the
 * invocation ID is synthetic (written by archon-session-start.mjs) and has
 * no DB row until PreCompact calls this method.
 *
 * I/O contract:
 *   Input:  identity fields read from context-guard.json
 *   Output: Promise<void>
 *   Side effect: INSERT OR IGNORE into agent_invocations (production);
 *                registers id in in-memory Set (test double)
 *
 * Production: wrap AgentRuntimeStore.createAgentInvocation, swallow
 *             duplicate-key errors.
 * Test double: register id in an in-memory Set so status-transition methods
 *             can enforce "invocation must exist before it can be updated"
 *             (council C7 contract enforcement).
 */
export interface InteractiveHandoffStoreLike extends HandoffStoreLike {
  upsertInteractiveInvocation(data: {
    readonly id: string;
    readonly runId: string;
    readonly taskId: string;
    readonly role: string;
    readonly surface: string;
    readonly startedAt: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PrecompactResult {
  readonly committed: boolean;
  readonly invocationId?: string | undefined;
}

// ---------------------------------------------------------------------------
// registerInteractiveSession
// ---------------------------------------------------------------------------

/**
 * Write context-guard.json for the current interactive session.
 *
 * Called by archon-session-start.mjs when an archon task is active.
 * The guard file gives archon-pre-compact.mjs the invocationId + task context
 * it needs to commit a precompact_fallback handoff before native compaction.
 *
 * I/O contract:
 *   Input:  invocationId, runId, taskId, role, contextGuardPath
 *   Output: void
 *   Side effect: writes context-guard.json (creates parent dirs as needed)
 *
 * NOTE: In RED this is intentionally a no-op stub — context-guard.json is NOT
 * written — so runPrecompactHandoff returns { committed: false } and the
 * integration test fails.  The GREEN implementation (below the stub body)
 * replaces it when the file scope is un-stubbed.
 */
export function registerInteractiveSession(opts: {
  readonly invocationId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly role: string;
  readonly contextGuardPath: string;
}): void {
  // Write context-guard.json so PreCompact can find this invocation.
  const guardDir = path.dirname(opts.contextGuardPath);
  mkdirSync(guardDir, { recursive: true });
  writeFileSync(
    opts.contextGuardPath,
    JSON.stringify({
      invocationId: opts.invocationId,
      runId: opts.runId,
      taskId: opts.taskId,
      role: opts.role,
      surface: "interactive",
      state: "registered",
      registeredAt: new Date().toISOString()
    }),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// runPrecompactHandoff
// ---------------------------------------------------------------------------

/**
 * Simulate the PreCompact hook path using an injected store.
 *
 * Reads context-guard.json to get the active interactive invocationId + task
 * context, then drives the real HandoffController to prepare and commit a
 * precompact_fallback handoff.
 *
 * Best-effort: if the guard is absent, malformed, or already committed,
 * returns { committed: false } without throwing.
 *
 * I/O contract:
 *   Input:  store (HandoffStoreLike), contextGuardPath
 *   Output: PrecompactResult { committed, invocationId? }
 *   Side effects when committed=true:
 *     - store.updateAgentInvocationStatus → "handoff_requested" then "handoff_written"
 *     - store.createHandoff (INSERT precompact_fallback record)
 *     - updates context-guard.json (state: "handoff_written")
 */
export async function runPrecompactHandoff(opts: {
  readonly store: InteractiveHandoffStoreLike;
  readonly contextGuardPath: string;
}): Promise<PrecompactResult> {
  // Read context-guard.json — written by registerInteractiveSession.
  let guard: Record<string, unknown>;
  try {
    const raw = readFileSync(opts.contextGuardPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { committed: false };
    }
    guard = parsed as Record<string, unknown>;
  } catch {
    // Guard absent or unreadable — no registered session.
    return { committed: false };
  }

  const invocationId =
    typeof guard.invocationId === "string" && guard.invocationId.trim().length > 0
      ? guard.invocationId.trim()
      : undefined;

  if (invocationId === undefined) {
    return { committed: false };
  }

  // If the guard already reflects a committed handoff, be idempotent.
  const existingState = typeof guard.state === "string" ? guard.state : "normal";
  if (existingState === "handoff_written") {
    return { committed: false, invocationId };
  }

  // Also check the store (handles the case where a previous process committed
  // the handoff but the guard file was not updated).
  const alreadyCommitted = await opts.store.hasCommittedHandoff(invocationId);
  if (alreadyCommitted) {
    writeGuardState(opts.contextGuardPath, guard, invocationId, "handoff_written");
    return { committed: false, invocationId };
  }

  // Read task context written by registerInteractiveSession into the guard file.
  const runId =
    typeof guard.runId === "string" && guard.runId.trim().length > 0
      ? guard.runId.trim()
      : undefined;
  const taskId =
    typeof guard.taskId === "string" && guard.taskId.trim().length > 0
      ? guard.taskId.trim()
      : undefined;
  const fromRole =
    typeof guard.role === "string" && guard.role.trim().length > 0
      ? guard.role.trim()
      : "interactive";

  if (runId === undefined || taskId === undefined) {
    return { committed: false, invocationId };
  }

  // Ensure the invocation exists in the store before driving HandoffController.
  //
  // For the interactive surface, archon-session-start.mjs creates a synthetic
  // invocationId (inv_interactive_<uuid>) that has no backing DB row. We
  // upsert it here so HandoffController's status transitions have a real row.
  //
  // In the test double, upsertInteractiveInvocation registers the id in an
  // in-memory Set. The enforcing double then rejects updateAgentInvocationStatus
  // and createHandoff calls for any id that was never registered — proving that
  // the invocation MUST exist before the handoff can commit (council C7).
  await opts.store.upsertInteractiveInvocation({
    id: invocationId,
    runId,
    taskId,
    role: fromRole,
    surface: "interactive",
    startedAt:
      typeof guard.registeredAt === "string" && guard.registeredAt.length > 0
        ? guard.registeredAt
        : new Date().toISOString()
  });

  // Build a valid precompact_fallback handoff via the real HandoffController.
  const controller = new HandoffController(opts.store);

  const prepared = await controller.prepare({
    invocationId,
    runId,
    taskId,
    fromRole,
    toRole: fromRole,
    reason: "precompact_fallback",
    contextUsedPct: undefined
  });

  const syntheticPacket: Record<string, unknown> = {
    schemaVersion: 1,
    handoffId: prepared.template.handoffId,
    runId,
    taskId,
    fromInvocationId: invocationId,
    fromRole,
    toRole: fromRole,
    reason: "precompact_fallback",
    // "needs_followup" is recognized by hasCommittedHandoff for idempotency.
    status: "needs_followup",
    summary:
      "Precompact fallback: native compaction triggered before agent committed a handoff. " +
      "Successor must re-read task context from .archon/ACTIVE and task packet.",
    scope: { allowedWriteScope: [], touchedPaths: [] },
    decisions: [],
    openQuestions: ["What was the agent working on when compaction triggered?"],
    evidenceRefs: [`runtime://invocation/${invocationId}`],
    nextActions: [
      "Re-read .archon/ACTIVE and the task packet.",
      "Resume from the last known good state."
    ],
    risks: [],
    createdAt: prepared.template.createdAt
  };

  await controller.commit({ invocationId, rawPacket: syntheticPacket });

  // Update the guard file to reflect the committed state.
  writeGuardState(opts.contextGuardPath, guard, invocationId, "handoff_written");

  return { committed: true, invocationId };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function writeGuardState(
  guardPath: string,
  existing: Record<string, unknown>,
  invocationId: string,
  state: string
): void {
  try {
    const dir = path.dirname(guardPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      guardPath,
      JSON.stringify({
        ...existing,
        invocationId,
        state,
        updatedAt: new Date().toISOString()
      }),
      "utf-8"
    );
  } catch {
    // best-effort
  }
}
