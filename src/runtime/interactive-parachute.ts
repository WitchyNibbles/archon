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
import type { CreateAgentInvocationInput } from "../store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// Re-exports for callers that need the store interface
// ---------------------------------------------------------------------------

export type { HandoffStoreLike };

// ---------------------------------------------------------------------------
// upsertInteractiveInvocationRow — shared, idempotent invocation-row creation
//
// The interactive (plain `claude`) surface mints a synthetic invocationId
// (inv_interactive_<uuid>) in archon-session-start.mjs. That id has NO backing
// agent_invocations row until it is explicitly created. Every handoff-commit
// surface — the MCP archon_handoff_commit tool, PreCompact parachute, and
// context sampling — resolves `from_invocation_id`/`invocation_id` against
// agent_invocations (NOT NULL FK). Without a row those writes FK-violate, so the
// context guard can demand a handoff that can never be committed.
//
// This helper is the single authoritative creation point, reused by BOTH hooks:
//   - archon-session-start.mjs calls it EAGERLY when it registers the session,
//     so the row exists for the whole session lifetime.
//   - archon-pre-compact.mjs calls it as an idempotent backstop before the
//     precompact_fallback handoff commits (covers a DB-unavailable session start).
// ---------------------------------------------------------------------------

/** Minimal store surface required to create the backing invocation row. */
export interface InteractiveInvocationCreator {
  createAgentInvocation(data: CreateAgentInvocationInput): Promise<unknown>;
}

/** Identity fields for the interactive invocation row. */
export interface InteractiveInvocationRowInput {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly role: string;
  readonly startedAt?: string | undefined;
}

export interface UpsertInteractiveInvocationResult {
  /** A new row was inserted. */
  readonly created: boolean;
  /** The row already existed (Postgres 23505) — idempotent success. */
  readonly alreadyExisted: boolean;
  /**
   * A non-idempotent (structural: FK/schema) failure occurred. The row does NOT
   * exist, so downstream handoff commits will fail — callers must log this loudly.
   */
  readonly structuralError?: string | undefined;
}

/**
 * Fixed identity defaults for an interactive root session's invocation row.
 * `agentKind: "root_manager"` because the interactive `claude` REPL is the
 * archon manager/root. The values are descriptive metadata, not load-bearing
 * for handoff correctness — the load-bearing property is that the row EXISTS.
 */
const INTERACTIVE_INVOCATION_DEFAULTS = {
  agentKind: "root_manager",
  model: "claude-sonnet-4-6",
  effort: "high",
  status: "running",
  contextPolicyId: "default"
} as const;

/**
 * Idempotently create the backing agent_invocations row for an interactive
 * session.
 *
 * I/O contract:
 *   Input:  store (InteractiveInvocationCreator), row identity fields
 *   Output: UpsertInteractiveInvocationResult
 *   Side effects: INSERT into agent_invocations (idempotent on 23505)
 *
 * Best-effort + idempotent: a Postgres unique_violation (23505) means the row
 * already exists (session-start created it, or repeated compaction) and is
 * treated as success. Any OTHER error is structural (FK/schema) and returned in
 * `structuralError` so the caller can surface it — a silent miss strands the
 * session with no committable handoff. This function never throws.
 */
export async function upsertInteractiveInvocationRow(
  store: InteractiveInvocationCreator,
  input: InteractiveInvocationRowInput
): Promise<UpsertInteractiveInvocationResult> {
  // SECURITY: `role` originates from attacker-writable sources (ARCHON_ROLE env,
  // context-guard.json). Both current callers pre-sanitize, but the helper is
  // the authoritative write boundary into agent_invocations.role — which feeds
  // the review-independence check (review.ts) — so normalize here unconditionally
  // rather than trusting every future caller to do it.
  const safeRole = normalizeRole(input.role);
  try {
    await store.createAgentInvocation({
      id: input.id,
      runId: input.runId,
      taskId: input.taskId,
      role: safeRole,
      agentKind: INTERACTIVE_INVOCATION_DEFAULTS.agentKind,
      model: INTERACTIVE_INVOCATION_DEFAULTS.model,
      effort: INTERACTIVE_INVOCATION_DEFAULTS.effort,
      status: INTERACTIVE_INVOCATION_DEFAULTS.status,
      contextPolicyId: INTERACTIVE_INVOCATION_DEFAULTS.contextPolicyId,
      startedAt: input.startedAt
    });
    return { created: true, alreadyExisted: false };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "23505") {
      // Row already exists — expected and idempotent.
      return { created: false, alreadyExisted: true };
    }
    // Structural failure (FK/schema): the row does NOT exist. Surface it with a
    // diagnosable message. pg errors carry `.code` + `.message`; a bare object's
    // default String() ("[object Object]") would hide the cause, so extract the
    // message explicitly and prefix the SQLSTATE code when present.
    const message =
      err && typeof err === "object" && "message" in err && typeof err.message === "string"
        ? err.message
        : String(err);
    const codeStr = typeof code === "string" && code.length > 0 ? `${code}: ` : "";
    return {
      created: false,
      alreadyExisted: false,
      structuralError: `${codeStr}${message}`
    };
  }
}

// ---------------------------------------------------------------------------
// runInteractiveSessionStart — testable session-start orchestration
//
// archon-session-start.mjs must (1) eagerly create the interactive invocation
// row, then (2) consume any pending handoff from the prior session. The ORDER is
// load-bearing: the consume path's markHandoffConsumed writes
// `to_invocation_id = <this session's invocationId>` (agent_handoffs.to_invocation_id
// is a FK to agent_invocations, migration 020 line 93). If the row was not
// created, consume FK-violates.
//
// So: when the eager upsert returns a structuralError (row does NOT exist),
// consume is SKIPPED — the prior handoff stays unconsumed and is recovered on the
// next session start once the DB is healthy again. This function is injectable
// (upsert + consume are thunks) so the ordering contract is unit-testable without
// a DB or the untestable .mjs hook body.
// ---------------------------------------------------------------------------

/** Outcome of consuming a prior session's handoff (subset of consumeInteractiveHandoff). */
export interface InteractiveConsumeOutcome {
  readonly consumed: boolean;
  readonly continuationText?: string | undefined;
  readonly handoffId?: string | undefined;
  readonly skipped?: string | undefined;
}

export interface RunInteractiveSessionStartDeps {
  /** Eagerly create the backing invocation row (idempotent). */
  upsertRow(): Promise<UpsertInteractiveInvocationResult>;
  /** Consume any pending handoff. Called ONLY when the row is guaranteed to exist. */
  consume(): Promise<InteractiveConsumeOutcome>;
}

export interface RunInteractiveSessionStartResult {
  readonly upsert: UpsertInteractiveInvocationResult;
  readonly consume?: InteractiveConsumeOutcome | undefined;
  /** Set when consume was deliberately not attempted (row creation failed). */
  readonly consumeSkippedReason?: string | undefined;
}

/**
 * Orchestrate the interactive session-start DB work with FK-safe ordering.
 *
 * I/O contract:
 *   Input:  deps { upsertRow, consume }
 *   Output: RunInteractiveSessionStartResult
 *   Side effects: whatever the injected thunks do (never throws on its own)
 */
export async function runInteractiveSessionStart(
  deps: RunInteractiveSessionStartDeps
): Promise<RunInteractiveSessionStartResult> {
  const upsert = await deps.upsertRow();
  if (upsert.structuralError !== undefined) {
    // Row does NOT exist → consume's to_invocation_id FK would violate. Skip it.
    return { upsert, consumeSkippedReason: "invocation_row_not_created" };
  }
  const consume = await deps.consume();
  return { upsert, consume };
}

// ---------------------------------------------------------------------------
// normalizeRole — imported from the shared module and re-exported.
//
// Moved to src/runtime/normalize-role.ts so that handoff-controller.ts can
// import it without creating a circular dependency (this module imports from
// handoff-controller.ts). Imported here for LOCAL use (runPrecompactHandoff
// calls normalizeRole at line ~218) and re-exported for backward compatibility
// with callers that import normalizeRole from interactive-parachute.ts.
// ---------------------------------------------------------------------------

import { normalizeRole } from "./normalize-role.ts";
import { isValidLeaseId } from "./respawn-lease.ts";
export { normalizeRole };

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

  // SECURITY (C3): context-guard.json is attacker-writable (within many
  // subagents' default write scope). The consume (read) path gates invocationId
  // through isValidLeaseId (^[A-Za-z0-9_-]+$) before any DB call; the write path
  // must too. Without this, an injected existing PK makes createAgentInvocation
  // report alreadyExisted and HandoffController commit a phantom handoff
  // attributed to an unrelated invocation.
  if (!isValidLeaseId(invocationId)) {
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
  // SECURITY (handoffConsumerWiring P1 security gate, HIGH-2): the guard file is
  // attacker-writable (within many subagents' default write scope) and `role`
  // flows into HandoffController as both fromRole and toRole. buildContinuationPrompt
  // treats toRole as a TRUSTED identity field and embeds it unsanitized. Constrain
  // it to a strict, injection-proof token (no newlines/markers/spaces) or fall back
  // to "interactive". This restores the runtime-set-identity invariant.
  const fromRole = normalizeRole(guard.role);

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
