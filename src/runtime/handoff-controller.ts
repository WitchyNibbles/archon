// Handoff Controller — Phase 3 of the Archon Agentic Loop Runtime.
//
// Validates, persists, and retrieves handoff packets; marks invocation
// status transitions; and builds continuation prompts for the next
// invocation.
//
// All public methods return new objects; no in-place mutation.

import { randomUUID } from "node:crypto";
import { HandoffPacketV1Schema } from "../domain/handoff-schemas.ts";
import type { HandoffPacketV1 } from "../domain/handoff-schemas.ts";
import type { HandoffRecord } from "../store/agent-runtime-store.ts";
import type { AgentInvocation } from "../domain/types.ts";
import { normalizeRole } from "./normalize-role.ts";

// ---------------------------------------------------------------------------
// Content field sanitization (SEC-HIGH-1)
// ---------------------------------------------------------------------------

/**
 * Sanitize a single untrusted content string before embedding it in a
 * continuation prompt:
 *   1. Collapse ALL embedded newlines/carriage-returns to a single space
 *      (prevents multiline injection via a single "string" field).
 *   2. Strip case-insensitive structural marker strings that could be used to
 *      spoof the trusted identity section boundary:
 *      `---`, `[CONTENT FIELDS`, `Runtime authority`, `Allowed write scope`.
 *   3. Strip Markdown headings (lines starting with `#`).
 *   4. Strip fenced code blocks (lines starting with ` ``` `).
 *   5. Truncate to `maxLength` characters.
 *
 * Used for packet content fields (summary, nextActions, evidenceRefs,
 * decisions) that originate from agent output and must not be trusted.
 */
function sanitizeContentField(raw: string, maxLength: number): string {
  // Step 0: Unicode-normalize to NFKC so that homoglyphs (e.g. Cyrillic
  // lookalikes of ASCII letters) are mapped to their canonical equivalents
  // before any regex matching.  This prevents "Runtіme authority" (with a
  // Cyrillic і) from surviving the marker-strip regex.
  const normalized = raw.normalize("NFKC");

  // Step 1: collapse ALL newlines/CRs to space BEFORE line-based stripping.
  // This prevents injecting heading/fence lines via embedded `\n` characters
  // in a single "string" field value.
  const collapsed = normalized.replace(/[\r\n]+/g, " ");

  // Step 2: strip case-insensitive structural boundary markers that could
  // spoof the trusted identity section inside the continuation prompt.
  const MARKER_RE = /(-{3,}|\[CONTENT FIELDS[^\]]*\]|Runtime authority|Allowed write scope)/gi;
  const stripped = collapsed.replace(MARKER_RE, "");

  // Step 3: strip inline heading injection (#…) that may appear anywhere in
  // the collapsed string (not just at line starts). After \n-collapse, a
  // heading from an injected line like "text\n## SYSTEM" becomes
  // "text ## SYSTEM" — still dangerous if re-split later, so strip globally.
  // Also strip fenced code block opening/closing patterns.
  const noHeadings = stripped.replace(/#{1,6}[^\S\n]*/g, "");
  const noFences = noHeadings.replace(/```[^`]*/g, "");

  // Step 4: split on any remaining newlines (guard), filter residual headings/fences.
  const lines = noFences.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) return false;
    if (trimmed.startsWith("```")) return false;
    return true;
  });

  // Step 5: rejoin and truncate.
  const joined = filtered.join(" ").trimEnd();
  return joined.length > maxLength ? `${joined.slice(0, maxLength)}…` : joined;
}

// ---------------------------------------------------------------------------
// Store adapter interface (injected; no direct DB dependency)
// ---------------------------------------------------------------------------

export interface HandoffStoreLike {
  createHandoff(data: {
    id: string;
    runId: string;
    taskId: string;
    fromInvocationId: string;
    toInvocationId?: string | undefined;
    fromRole: string;
    toRole: string;
    reason: string;
    status: string;
    contextUsedPct?: number | undefined;
    packet: Record<string, unknown>;
    authorityLabel?: string | undefined;
    createdAt?: string | undefined;
  }): Promise<HandoffRecord>;

  getLatestUnconsumedHandoff(
    runId: string,
    taskId: string
  ): Promise<HandoffRecord | undefined>;

  markHandoffConsumed(handoffId: string, toInvocationId: string): Promise<void>;

  /**
   * Return true if the given invocation has already committed a handoff record
   * (status = handoff_written or needs_followup). Used by the reset path to
   * detect agent-driven handoffs before the context monitor fires.
   */
  hasCommittedHandoff(invocationId: string): Promise<boolean>;

  updateAgentInvocationStatus(
    id: string,
    status: AgentInvocation["status"],
    metadata?: Record<string, unknown> | undefined
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// HandoffTemplate — returned by prepare()
// ---------------------------------------------------------------------------

export interface HandoffTemplate {
  /** Pre-filled handoffId — caller must include this exact value in the packet. */
  handoffId: string;
  /** ISO timestamp to use for createdAt. */
  createdAt: string;
  /** Markdown template the agent fills in. */
  markdownTemplate: string;
  /** JSON template with field prompts (ready to fill in). */
  jsonTemplate: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PrepareResult
// ---------------------------------------------------------------------------

export interface PrepareResult {
  template: HandoffTemplate;
  /** The invocation was transitioned to handoff_requested. */
  newStatus: "handoff_requested";
}

// ---------------------------------------------------------------------------
// CommitResult
// ---------------------------------------------------------------------------

export interface CommitResult {
  record: HandoffRecord;
  /** The invocation was transitioned to handoff_written. */
  newStatus: "handoff_written";
}

// ---------------------------------------------------------------------------
// ConsumeResult
// ---------------------------------------------------------------------------

export interface ConsumeResult {
  record: HandoffRecord;
  /** toInvocationId that consumed the handoff. */
  toInvocationId: string;
}

// ---------------------------------------------------------------------------
// HandoffController
// ---------------------------------------------------------------------------

export class HandoffController {
  private readonly store: HandoffStoreLike;

  constructor(store: HandoffStoreLike) {
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // prepare — mark invocation handoff_requested; return template
  // -------------------------------------------------------------------------

  /**
   * Transition the given invocation to `handoff_requested` and return a
   * HandoffTemplate the agent uses to compose its handoff packet.
   *
   * I/O contract:
   *   Input:  invocationId, runId, taskId, fromRole, toRole, reason,
   *           contextUsedPct?
   *   Output: PrepareResult { template, newStatus: "handoff_requested" }
   *   Side effects: updates agent_invocations.status → "handoff_requested"
   */
  async prepare(params: {
    invocationId: string;
    runId: string;
    taskId: string;
    fromRole: string;
    toRole: string;
    reason: HandoffPacketV1["reason"];
    contextUsedPct?: number | undefined;
  }): Promise<PrepareResult> {
    await this.store.updateAgentInvocationStatus(
      params.invocationId,
      "handoff_requested",
      { handoff_reason: params.reason }
    );

    const handoffId = `ho_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();

    const contextNote =
      params.contextUsedPct !== undefined
        ? `\nContext used: ${params.contextUsedPct.toFixed(1)}%`
        : "";

    const markdownTemplate = `## Archon Handoff Required
${contextNote}
Reason: \`${params.reason}\`
Handoff ID: \`${handoffId}\`
Allowed actions: handoff only

Complete this packet:

### Summary
What changed or was learned? (minimum 10 characters)

### Evidence refs
What files, tests, logs, review records, or runtime records prove the current state?

### Decisions made
What should the next invocation not relitigate?

### Open questions
What remains unknown?

### Touched paths
What files were changed or inspected?

### Next actions
What should the continuation do first?

### Risks
What could break if the next invocation proceeds blindly?
`;

    const jsonTemplate: Record<string, unknown> = {
      schemaVersion: 1,
      handoffId,
      runId: params.runId,
      taskId: params.taskId,
      fromInvocationId: params.invocationId,
      fromRole: params.fromRole,
      toRole: params.toRole,
      reason: params.reason,
      contextUsedPct: params.contextUsedPct ?? null,
      status: "in_progress",
      summary: "<minimum 10 characters describing what was accomplished>",
      scope: {
        allowedWriteScope: [],
        touchedPaths: []
      },
      decisions: [
        {
          decision: "<what was decided>",
          rationale: "<why>"
        }
      ],
      openQuestions: [],
      evidenceRefs: ["<file or test that proves current state>"],
      nextActions: ["<first thing continuation should do>"],
      risks: [],
      createdAt
    };

    const template: HandoffTemplate = {
      handoffId,
      createdAt,
      markdownTemplate,
      jsonTemplate
    };

    return { template, newStatus: "handoff_requested" };
  }

  // -------------------------------------------------------------------------
  // commit — validate + persist handoff packet; mark invocation handoff_written
  // -------------------------------------------------------------------------

  /**
   * Validate a handoff packet using HandoffPacketV1Schema, persist it to
   * agent_handoffs, and transition the invocation to `handoff_written`.
   *
   * Throws a descriptive Error if Zod validation fails.
   *
   * I/O contract:
   *   Input:  invocationId, rawPacket (unknown)
   *   Output: CommitResult { record, newStatus: "handoff_written" }
   *   Side effects:
   *     - INSERT into agent_handoffs
   *     - UPDATE agent_invocations.status → "handoff_written"
   */
  async commit(params: {
    invocationId: string;
    rawPacket: unknown;
  }): Promise<CommitResult> {
    const parseResult = HandoffPacketV1Schema.safeParse(params.rawPacket);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        .map((issue) => `[${issue.path.join(".")}] ${issue.message}`)
        .join("; ");
      throw new Error(`Handoff packet validation failed: ${messages}`);
    }

    const packet = parseResult.data;

    const record = await this.store.createHandoff({
      id: packet.handoffId,
      runId: packet.runId,
      taskId: packet.taskId,
      fromInvocationId: packet.fromInvocationId,
      fromRole: packet.fromRole,
      toRole: packet.toRole,
      reason: packet.reason,
      status: packet.status,
      contextUsedPct: packet.contextUsedPct,
      packet: packet as unknown as Record<string, unknown>,
      authorityLabel: "runtime_authoritative",
      createdAt: packet.createdAt
    });

    await this.store.updateAgentInvocationStatus(
      params.invocationId,
      "handoff_written",
      { handoff_id: packet.handoffId }
    );

    return { record, newStatus: "handoff_written" };
  }

  // -------------------------------------------------------------------------
  // recoverCrashedInvocation — synthesize a crash_recovery handoff
  // -------------------------------------------------------------------------

  /**
   * Synthesize and commit a `crash_recovery` handoff for an invocation that
   * crossed the context threshold but ended without committing a handoff (TDD
   * §20). The committed packet lets a continuation resume from runtime state
   * instead of stranding the task in a half-running invocation.
   *
   * I/O contract:
   *   Input:  invocation identity + optional evidence refs
   *   Output: CommitResult { record, newStatus: "handoff_written" }
   *   Side effects: prepare() + commit() side effects (status transitions + INSERT)
   */
  async recoverCrashedInvocation(input: {
    invocationId: string;
    runId: string;
    taskId: string;
    role: string;
    contextUsedPct?: number | undefined;
    evidenceRefs?: readonly string[] | undefined;
  }): Promise<CommitResult> {
    // SECURITY (C2 — handoffConsumeOnStart): normalize role before it enters
    // any DB call or prompt construction. input.role may come from an
    // attacker-writable source (context-guard.json, ARCHON_ROLE env, or
    // subagent output); normalizeRole constrains it to a safe token.
    const safeRole = normalizeRole(input.role);

    const prepared = await this.prepare({
      invocationId: input.invocationId,
      runId: input.runId,
      taskId: input.taskId,
      fromRole: safeRole,
      toRole: safeRole,
      reason: "crash_recovery",
      contextUsedPct: input.contextUsedPct
    });

    const evidenceRefs =
      input.evidenceRefs && input.evidenceRefs.length > 0
        ? [...input.evidenceRefs]
        : [`runtime://invocation/${input.invocationId}`];

    const packet: Record<string, unknown> = {
      schemaVersion: 1,
      handoffId: prepared.template.handoffId,
      runId: input.runId,
      taskId: input.taskId,
      fromInvocationId: input.invocationId,
      fromRole: safeRole,
      toRole: safeRole,
      reason: "crash_recovery",
      ...(input.contextUsedPct !== undefined ? { contextUsedPct: input.contextUsedPct } : {}),
      status: "needs_followup",
      summary:
        "Crash recovery: the prior invocation crossed the context threshold but ended " +
        "without committing a handoff. Resume from the latest runtime state.",
      scope: { allowedWriteScope: [], touchedPaths: [] },
      decisions: [],
      openQuestions: ["What did the crashed invocation complete before terminating?"],
      evidenceRefs,
      nextActions: [
        "Re-read .archon/ACTIVE and the task packet.",
        "Reconcile partial progress against runtime records before continuing."
      ],
      risks: [],
      createdAt: prepared.template.createdAt
    };

    return this.commit({ invocationId: input.invocationId, rawPacket: packet });
  }

  // -------------------------------------------------------------------------
  // hasCommittedHandoff — check if an invocation has a committed handoff
  // -------------------------------------------------------------------------

  /**
   * Return true if the given invocation has already committed a handoff record
   * (e.g. status = handoff_written or needs_followup in the store).
   *
   * I/O contract:
   *   Input:  invocationId
   *   Output: boolean
   *   Side effects: none
   */
  async hasCommittedHandoff(invocationId: string): Promise<boolean> {
    return this.store.hasCommittedHandoff(invocationId);
  }

  // -------------------------------------------------------------------------
  // getLatestForTask — retrieve latest unconsumed handoff for a task
  // -------------------------------------------------------------------------

  /**
   * Return the latest unconsumed HandoffRecord for the given run+task,
   * or undefined if none exists.
   *
   * I/O contract:
   *   Input:  runId, taskId
   *   Output: HandoffRecord | undefined
   *   Side effects: none
   */
  async getLatestForTask(
    runId: string,
    taskId: string
  ): Promise<HandoffRecord | undefined> {
    return this.store.getLatestUnconsumedHandoff(runId, taskId);
  }

  // -------------------------------------------------------------------------
  // buildContinuationPrompt — build compact prompt for continuation invocation
  // -------------------------------------------------------------------------

  /**
   * Build a compact, role-specific continuation prompt from a HandoffRecord.
   *
   * The prompt is intentionally terse — it references evidence rather than
   * transcribing it.
   *
   * Security (SEC-HIGH-1): packet content fields (summary, nextActions,
   * evidenceRefs, decisions) are UNTRUSTED — they originate from agent output
   * and may contain heading/code injection. Identity fields (toRole, taskId,
   * runId, handoffId) are trusted (set by the runtime).
   *
   * IMPORTANT: `allowedWriteScope` in the trusted section MUST come from the
   * authoritative task record (passed as `taskAllowedWriteScope`), NOT from
   * `packet.scope.allowedWriteScope` which is agent-written content. The packet
   * scope is untrusted and may be used to widen access.
   *
   * Sanitization applied to content fields:
   *   - Embedded newlines/CRs collapsed to space (prevents multiline injection).
   *   - Structural boundary markers stripped (prevents identity-section spoofing).
   *   - Markdown headings (`#` lines) stripped.
   *   - Fenced code blocks (``` lines) stripped.
   *   - summary capped at 2000 chars.
   *   - List items (nextActions, evidenceRefs) capped at 500 chars each.
   *   - Lists capped at 20 items.
   *
   * I/O contract:
   *   Input:  record (HandoffRecord), taskAllowedWriteScope (from authoritative task record)
   *   Output: string (markdown prompt ready for the next invocation)
   *   Side effects: none
   */
  buildContinuationPrompt(record: HandoffRecord, taskAllowedWriteScope?: readonly string[] | undefined): string {
    const packet = record.packet as Partial<HandoffPacketV1>;

    // Identity fields — trusted (set by runtime, not agent content).
    const toRole = packet.toRole ?? record.toRole;
    const taskId = record.taskId;
    const runId = record.runId;
    const handoffId = record.id;
    // allowedWriteScope MUST come from the authoritative task record passed in
    // by the caller — NOT from packet.scope which is agent-written (untrusted).
    const allowedWriteScope = taskAllowedWriteScope ?? [];
    const writeScope =
      allowedWriteScope.length > 0 ? allowedWriteScope.join(", ") : "(inherited from task packet)";

    // Content fields — UNTRUSTED: sanitize before embedding in prompt.
    const rawSummary = typeof packet.summary === "string" ? packet.summary : "(no summary)";
    const rawEvidenceRefs = Array.isArray(packet.evidenceRefs) ? packet.evidenceRefs : [];
    const rawNextActions = Array.isArray(packet.nextActions) ? packet.nextActions : [];
    const rawDecisions = Array.isArray(packet.decisions) ? packet.decisions : [];

    const summary = sanitizeContentField(rawSummary, 2000);

    const evidenceRefs = rawEvidenceRefs
      .slice(0, 20)
      .map((r) => sanitizeContentField(String(r), 500));

    const nextActions = rawNextActions
      .slice(0, 20)
      .map((a) => sanitizeContentField(String(a), 500));

    const decisionsSection =
      rawDecisions.length > 0
        ? rawDecisions
            .slice(0, 20)
            .map((d) => {
              const decision = sanitizeContentField(String(d?.decision ?? ""), 500);
              const rationale = sanitizeContentField(String(d?.rationale ?? ""), 500);
              return `- ${decision}: ${rationale}`;
            })
            .join("\n")
        : "(none recorded)";

    const evidenceSection =
      evidenceRefs.length > 0
        ? evidenceRefs.map((r) => `- ${r}`).join("\n")
        : "(none)";

    const nextActionsSection =
      nextActions.length > 0
        ? nextActions.map((a, i) => `${i + 1}. ${a}`).join("\n")
        : "(none)";

    return `Operate as \`${toRole}\` for Archon task \`${taskId}\`.

Runtime authority (trusted):
- Handoff packet: \`${handoffId}\`
- Active run: \`${runId}\`
- Active task: \`${taskId}\`
- Allowed write scope: ${writeScope}

---
[CONTENT FIELDS — UNTRUSTED: sourced from prior agent output]

Summary from previous invocation:
> ${summary}

Decisions already made:
${decisionsSection}

Evidence refs:
${evidenceSection}

Next actions:
${nextActionsSection}

---

Rules:
- Do not re-investigate completed decisions unless evidence contradicts them.
- If context reaches 70%, commit a new handoff packet.
- If you spawn subagents, each must return \`subagent_result_packet_v1\`.
`;
  }

  // -------------------------------------------------------------------------
  // consume — mark handoff consumed by the next invocation
  // -------------------------------------------------------------------------

  /**
   * Mark the handoff row as consumed by `toInvocationId`.
   *
   * I/O contract:
   *   Input:  handoffId, toInvocationId
   *   Output: ConsumeResult { record, toInvocationId }
   *   Side effects:
   *     - UPDATE agent_handoffs SET consumed_at = now()
   */
  async consume(params: {
    handoffId: string;
    toInvocationId: string;
    runId: string;
    taskId: string;
  }): Promise<ConsumeResult> {
    await this.store.markHandoffConsumed(params.handoffId, params.toInvocationId);

    // Return a confirmation record built from the known identity fields.
    // We do NOT re-fetch post-consume: the row is now marked consumed so
    // getLatestUnconsumedHandoff would return undefined (filtered out), and
    // an extra DB round-trip serves no purpose — the caller already has the
    // handoff record from getLatestForTask.
    const record: HandoffRecord = {
      id: params.handoffId,
      runId: params.runId,
      taskId: params.taskId,
      fromInvocationId: "",
      fromRole: "",
      toRole: "",
      reason: "manual",
      status: "consumed",
      packet: {},
      authorityLabel: "runtime_authoritative",
      createdAt: new Date().toISOString(),
      toInvocationId: params.toInvocationId,
      consumedAt: new Date().toISOString()
    };

    return {
      record,
      toInvocationId: params.toInvocationId
    };
  }
}
