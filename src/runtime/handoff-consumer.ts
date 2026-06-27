// handoff-consumer.ts — consume an interactive handoff at session start.
//
// A1 of the handoffConsumeOnStart task (Phase A of handoffSupervisorRespawn).
//
// At SessionStart, if there is an unconsumed handoff for the active run+task,
// this module reads it, builds a continuation prompt, marks it consumed, and
// returns the continuation text so the SessionStart hook can inject it as
// additionalContext.
//
// Security contracts:
//   C1: the role field in context-guard.json is attacker-writable but is NOT
//       used in the consume path — it is not passed to any DB call or prompt.
//       Role normalization (normalizeRole) is applied in HandoffController
//       where role is actually consumed (recoverCrashedInvocation,
//       buildContinuationPrompt).
//   C3: runId, taskId, and invocationId are all validated against
//       ^[A-Za-z0-9_-]+$ (via isValidLeaseId) before any DB query.
//       invocationId is also attacker-writable and receives the same
//       charset gate.
//
// A3 (lease coherence): if a daemon lease (owner="daemon") is held for the
// run, skip — the daemon owns this consume cycle. We only READ the lease, never
// claim it.
//
// Best-effort: never throws. Invalid IDs, absent guards, or daemon-held leases
// all return a clean skipped result.

import { readFileSync } from "node:fs";
import { HandoffController, type HandoffStoreLike } from "./handoff-controller.ts";
import { isValidLeaseId } from "./respawn-lease.ts";
import type { LeaseStore } from "./respawn-lease.ts";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { HandoffStoreLike };

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ConsumeInteractiveHandoffResult =
  | { readonly consumed: true; readonly handoffId: string; readonly continuationText: string }
  | {
      readonly consumed: false;
      readonly skipped: "no_handoff" | "daemon_lease_held" | "invalid_ids";
    };

// ---------------------------------------------------------------------------
// consumeInteractiveHandoff
// ---------------------------------------------------------------------------

/**
 * Consume the latest unconsumed interactive handoff for the given run+task.
 *
 * This is the read side of the interactive handoff loop. The write side is
 * runPrecompactHandoff (interactive-parachute.ts), which commits a
 * precompact_fallback handoff before native compaction. consumeInteractiveHandoff
 * is called by archon-session-start.mjs to retrieve and inject that handoff
 * as additionalContext for the new session.
 *
 * Security (C1): the role field in context-guard.json is attacker-writable but is
 * not used in this consume path. Role normalization is applied in HandoffController
 * where role is actually consumed.
 *
 * Security (C3): runId, taskId, and the guard's invocationId are all validated
 * against ^[A-Za-z0-9_-]+$ via isValidLeaseId before any DB query.
 *
 * A3 (lease coherence): if leaseStore is provided and owner === "daemon" for
 * the given runId, returns { consumed: false, skipped: "daemon_lease_held" }.
 * Does NOT claim a lease — only reads.
 *
 * Idempotent: if no unconsumed handoff exists (already consumed or never
 * committed), returns { consumed: false, skipped: "no_handoff" }.
 *
 * I/O contract:
 *   Input:  store (HandoffStoreLike), leaseStore?, runId, taskId, contextGuardPath
 *   Output: ConsumeInteractiveHandoffResult (never throws)
 *   Side effects when consumed=true:
 *     - store.markHandoffConsumed (UPDATE agent_handoffs.consumed_at)
 */
export async function consumeInteractiveHandoff(opts: {
  readonly store: HandoffStoreLike;
  readonly leaseStore?: LeaseStore | undefined;
  readonly runId: string;
  readonly taskId: string;
  readonly contextGuardPath: string;
}): Promise<ConsumeInteractiveHandoffResult> {
  // C3: validate IDs against the safe-charset pattern before any DB query.
  // Reject empty strings, path traversal, newlines, or other injection payloads.
  if (!isValidLeaseId(opts.runId) || !isValidLeaseId(opts.taskId)) {
    return { consumed: false, skipped: "invalid_ids" };
  }

  // Read context-guard.json to get the new session's invocationId (toInvocationId)
  // and the role associated with this session.
  //
  // The guard was just written by archon-session-start.mjs registration block,
  // so it should contain the new invocationId. If absent or malformed, there is
  // no registered session to consume for.
  let toInvocationId: string;
  try {
    const raw = readFileSync(opts.contextGuardPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { consumed: false, skipped: "no_handoff" };
    }
    const guard = parsed as Record<string, unknown>;

    const invId =
      typeof guard.invocationId === "string" ? guard.invocationId.trim() : "";
    if (!invId) {
      return { consumed: false, skipped: "no_handoff" };
    }
    // C3: validate invocationId against the safe-charset pattern before any DB
    // call. The guard is attacker-writable; an unsanitized invocationId could
    // carry path-traversal or newline payloads into markHandoffConsumed.
    if (!isValidLeaseId(invId)) {
      return { consumed: false, skipped: "invalid_ids" };
    }
    toInvocationId = invId;
  } catch {
    // Guard absent or unreadable — no registered session to consume for.
    return { consumed: false, skipped: "no_handoff" };
  }

  // A3: if a daemon lease is held for this run, skip — the daemon owns this
  // consume cycle and will handle the handoff on behalf of the session.
  if (opts.leaseStore !== undefined) {
    try {
      const leaseOwner = await opts.leaseStore.readOwner(opts.runId);
      if (leaseOwner === "daemon") {
        return { consumed: false, skipped: "daemon_lease_held" };
      }
    } catch {
      // Best-effort: if the lease store is unavailable, proceed without skipping.
      // The lease is advisory — a failed read does not block the consume path.
    }
  }

  // Query the store for the latest unconsumed handoff.
  let handoff: Awaited<ReturnType<HandoffStoreLike["getLatestUnconsumedHandoff"]>>;
  try {
    handoff = await opts.store.getLatestUnconsumedHandoff(opts.runId, opts.taskId);
  } catch {
    return { consumed: false, skipped: "no_handoff" };
  }

  if (handoff === undefined) {
    return { consumed: false, skipped: "no_handoff" };
  }

  // Build the continuation prompt from the handoff record.
  // HandoffController.buildContinuationPrompt is pure (no store calls).
  const controller = new HandoffController(opts.store);
  const continuationText = controller.buildContinuationPrompt(handoff);

  // Mark the handoff consumed — the new session's invocationId is the consumer.
  try {
    await opts.store.markHandoffConsumed(handoff.id, toInvocationId);
  } catch {
    // Best-effort: if marking fails (e.g. transient DB error), still return the
    // continuation text. The handoff may be consumed again on the next start;
    // idempotency of the prompt is acceptable.
  }

  return { consumed: true, handoffId: handoff.id, continuationText };
}
