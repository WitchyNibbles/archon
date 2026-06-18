// Debate Controller — Phase 5 of the Archon Agentic Loop Runtime.
//
// Evaluates whether a structured debate is needed, creates sessions,
// records arguments, finalises decisions, and emits markdown reports.
//
// All public methods return new objects; no in-place mutation.

import { randomUUID } from "node:crypto";
import type { DebateSession, DebateArgument } from "../domain/types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DebateTriggerKind =
  | "architecture_significant"
  | "security_trust_boundary"
  | "migration_data_loss"
  | "high_uncertainty"
  | "product_behavior_ambiguous"
  | "release_blocking_disagreement"
  | "trivial_edit"
  | "obvious_test_fix"
  | "formatting_only"
  | "already_approved";

export interface DebateTrigger {
  kind: DebateTriggerKind;
  context?: string | undefined;
}

export interface DebateSessionSpec {
  runId: string;
  taskId?: string | undefined;
  topic: string;
  triggerKind: DebateTriggerKind;
}

export interface DebateArgumentSpec {
  role: string;
  round: number;
  position: string;
  evidenceRefs?: string[] | undefined;
  critiques?: string[] | undefined;
  vote?: "approve" | "approve_with_conditions" | "rework" | "reject" | undefined;
}

export interface DebateDecisionSpec {
  outcome: "approved" | "approved_with_conditions" | "rework_required" | "rejected";
  vote: { approve: number; rework: number; reject: number };
  dissent: { owner: string; summary: string };
  conditions?: string[] | undefined;
  evidenceRefs: string[];
}

// Return type alias that matches what the DB returns
export type DebateSessionRecord = DebateSession;

// ---------------------------------------------------------------------------
// Store adapter interface (injected; no direct DB dependency)
// ---------------------------------------------------------------------------

export interface DebateStoreLike {
  createDebateSession(data: {
    id: string;
    runId: string;
    taskId?: string | undefined;
    topic: string;
    triggerKind: string;
    status: string;
    createdAt?: string | undefined;
  }): Promise<DebateSession>;

  addDebateArgument(data: {
    id: string;
    debateSessionId: string;
    round: number;
    role: string;
    position: string;
    evidenceRefs?: string[] | undefined;
    critiques?: string[] | undefined;
    vote?: string | undefined;
    createdAt?: string | undefined;
  }): Promise<DebateArgument>;

  updateDebateDecision(
    sessionId: string,
    decision: Record<string, unknown>
  ): Promise<void>;

  getDebateSession?(sessionId: string): Promise<DebateSession | null>;
}

// ---------------------------------------------------------------------------
// Trigger classification
// ---------------------------------------------------------------------------

const DEBATE_REQUIRED_KINDS = new Set<DebateTriggerKind>([
  "architecture_significant",
  "security_trust_boundary",
  "migration_data_loss",
  "high_uncertainty",
  "product_behavior_ambiguous",
  "release_blocking_disagreement"
]);

const DEBATE_SKIPPED_KINDS = new Set<DebateTriggerKind>([
  "trivial_edit",
  "obvious_test_fix",
  "formatting_only",
  "already_approved"
]);

// ---------------------------------------------------------------------------
// DebateController
// ---------------------------------------------------------------------------

export class DebateController {
  private readonly store: DebateStoreLike;

  constructor(store: DebateStoreLike) {
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // shouldDebate — evaluate trigger without side effects
  // -------------------------------------------------------------------------

  shouldDebate(trigger: DebateTrigger): boolean {
    // ARCHON_DEBATE_GATE=disabled → treat every trigger as a skip-list match (rollout stage 5)
    if (process.env.ARCHON_DEBATE_GATE === "disabled") return false;

    if (DEBATE_REQUIRED_KINDS.has(trigger.kind)) return true;
    if (DEBATE_SKIPPED_KINDS.has(trigger.kind)) return false;
    // Exhaustive fallback: unknown kinds default to no debate
    return false;
  }

  // -------------------------------------------------------------------------
  // start — create session in DB, return record
  // -------------------------------------------------------------------------

  async start(spec: DebateSessionSpec): Promise<DebateSessionRecord> {
    const id = randomUUID();
    const session = await this.store.createDebateSession({
      id,
      runId: spec.runId,
      taskId: spec.taskId,
      topic: spec.topic,
      triggerKind: spec.triggerKind,
      status: "open"
    });
    return session;
  }

  // -------------------------------------------------------------------------
  // addArgument — validate and persist one argument
  // -------------------------------------------------------------------------

  async addArgument(sessionId: string, arg: DebateArgumentSpec): Promise<void> {
    const role = arg.role.trim();
    if (role.length === 0) {
      throw new Error("debate_controller: argument 'role' must be non-empty");
    }

    const position = arg.position.trim();
    if (position.length === 0) {
      throw new Error("debate_controller: argument 'position' must be non-empty");
    }

    await this.store.addDebateArgument({
      id: randomUUID(),
      debateSessionId: sessionId,
      round: arg.round,
      role,
      position,
      evidenceRefs: arg.evidenceRefs,
      critiques: arg.critiques,
      vote: arg.vote
    });
  }

  // -------------------------------------------------------------------------
  // finalizeDecision — validate and persist decision
  // -------------------------------------------------------------------------

  async finalizeDecision(sessionId: string, decision: DebateDecisionSpec): Promise<void> {
    const allowedOutcomes = new Set([
      "approved",
      "approved_with_conditions",
      "rework_required",
      "rejected"
    ]);

    if (!allowedOutcomes.has(decision.outcome)) {
      throw new Error(
        `debate_controller: invalid outcome '${decision.outcome}'; ` +
          `must be one of ${[...allowedOutcomes].join(", ")}`
      );
    }

    if (decision.dissent.owner.trim().length === 0) {
      throw new Error("debate_controller: decision 'dissent.owner' must be non-empty");
    }

    if (decision.evidenceRefs.length === 0) {
      throw new Error(
        "debate_controller: decision must include at least one evidenceRef"
      );
    }

    const decisionRecord: Record<string, unknown> = {
      outcome: decision.outcome,
      vote: { ...decision.vote },
      dissent: { ...decision.dissent },
      evidenceRefs: [...decision.evidenceRefs]
    };

    if (decision.conditions !== undefined && decision.conditions.length > 0) {
      decisionRecord["conditions"] = [...decision.conditions];
    }

    await this.store.updateDebateDecision(sessionId, decisionRecord);
  }

  // -------------------------------------------------------------------------
  // getSession — retrieve a session record (delegates to store if available)
  // -------------------------------------------------------------------------

  async getSession(sessionId: string): Promise<DebateSessionRecord | null> {
    if (this.store.getDebateSession !== undefined) {
      return this.store.getDebateSession(sessionId);
    }
    // Store does not implement getDebateSession; return null as documented.
    return null;
  }

  // -------------------------------------------------------------------------
  // buildDebateReport — markdown summary string
  // -------------------------------------------------------------------------

  buildDebateReport(session: DebateSessionRecord): string {
    const lines: string[] = [];
    lines.push(`# Debate Report`);
    lines.push(``);
    lines.push(`**Session ID:** ${session.id}`);
    lines.push(`**Topic:** ${session.topic}`);
    lines.push(`**Trigger Kind:** ${session.triggerKind}`);
    lines.push(`**Status:** ${session.status}`);
    lines.push(`**Created At:** ${session.createdAt}`);

    if (session.completedAt !== undefined) {
      lines.push(`**Completed At:** ${session.completedAt}`);
    }

    if (session.decision !== undefined) {
      lines.push(``);
      lines.push(`## Decision`);
      lines.push(``);

      const d = session.decision;
      if (typeof d["outcome"] === "string") {
        lines.push(`**Outcome:** ${d["outcome"]}`);
      }

      const dissent = d["dissent"];
      if (typeof dissent === "object" && dissent !== null) {
        const dissentObj = dissent as Record<string, unknown>;
        if (typeof dissentObj["owner"] === "string") {
          lines.push(`**Dissent Owner:** ${dissentObj["owner"]}`);
        }
        if (typeof dissentObj["summary"] === "string") {
          lines.push(`**Dissent Summary:** ${dissentObj["summary"]}`);
        }
      }

      const vote = d["vote"];
      if (typeof vote === "object" && vote !== null) {
        const voteObj = vote as Record<string, unknown>;
        lines.push(``);
        lines.push(`### Vote Counts`);
        lines.push(``);
        lines.push(`- Approve: ${voteObj["approve"] ?? 0}`);
        lines.push(`- Rework: ${voteObj["rework"] ?? 0}`);
        lines.push(`- Reject: ${voteObj["reject"] ?? 0}`);
      }

      const conditions = d["conditions"];
      if (Array.isArray(conditions) && conditions.length > 0) {
        lines.push(``);
        lines.push(`### Conditions`);
        lines.push(``);
        for (const c of conditions) {
          lines.push(`- ${String(c)}`);
        }
      }

      const evidenceRefs = d["evidenceRefs"];
      if (Array.isArray(evidenceRefs) && evidenceRefs.length > 0) {
        lines.push(``);
        lines.push(`### Evidence References`);
        lines.push(``);
        for (const ref of evidenceRefs) {
          lines.push(`- ${String(ref)}`);
        }
      }
    }

    return lines.join("\n");
  }
}
