// Continuation Context Builder — Phase 3 of the Archon Agentic Loop Runtime.
//
// Builds a compact, bounded context bundle that the agentic loop injects into
// the next invocation's prompt.  The bundle is intentionally terse: it
// references evidence rather than transcribing it.
//
// All public methods return new objects; no in-place mutation.

import type { HandoffRecord } from "../store/agent-runtime-store.ts";
import type { HandoffPacketV1 } from "../domain/handoff-schemas.ts";
import { HandoffController } from "./handoff-controller.ts";
import type { HandoffStoreLike } from "./handoff-controller.ts";

// ---------------------------------------------------------------------------
// ContinuationBundle — returned by buildBundle()
// ---------------------------------------------------------------------------

export interface ContinuationBundle {
  /** Role the next invocation operates as. */
  role: string;
  /** Active run identifier. */
  runId: string;
  /** Active task identifier. */
  taskId: string;
  /** Latest unconsumed handoff record, or undefined if none exists. */
  latestHandoff: HandoffRecord | undefined;
  /** Compact continuation prompt string ready for injection. */
  continuationPrompt: string;
  /** Evidence refs extracted from the latest handoff packet. */
  evidenceRefs: readonly string[];
  /** Next actions extracted from the latest handoff packet. */
  nextActions: readonly string[];
  /** Allowed write scope from the handoff scope block. */
  allowedWriteScope: readonly string[];
  /** ISO timestamp when this bundle was assembled. */
  assembledAt: string;
}

// ---------------------------------------------------------------------------
// BuildBundleParams
// ---------------------------------------------------------------------------

export interface BuildBundleParams {
  runId: string;
  taskId: string;
  role: string;
  /**
   * When true (default), the latest unconsumed handoff is included.
   * Set to false to build an initial-invocation bundle with no handoff.
   */
  includeLatestHandoff?: boolean | undefined;
  /**
   * When true (default), evidence refs from the handoff are surfaced in the bundle.
   */
  includeEvidenceRefs?: boolean | undefined;
  /**
   * Informational only — used in bundle metadata.
   * "bounded" = conservative truncation; "full" = no truncation (default bounded).
   */
  tokenBudget?: "bounded" | "full" | undefined;
}

// ---------------------------------------------------------------------------
// ContinuationContextBuilder
// ---------------------------------------------------------------------------

export class ContinuationContextBuilder {
  private readonly controller: HandoffController;

  constructor(store: HandoffStoreLike) {
    this.controller = new HandoffController(store);
  }

  // -------------------------------------------------------------------------
  // buildBundle — assemble a compact ContinuationBundle
  // -------------------------------------------------------------------------

  /**
   * Build a ContinuationBundle for a given run, task, and role.
   *
   * I/O contract:
   *   Input:  BuildBundleParams
   *   Output: ContinuationBundle (immutable, no side effects)
   *   Side effects: none (read-only store queries)
   */
  async buildBundle(params: BuildBundleParams): Promise<ContinuationBundle> {
    const includeLatestHandoff = params.includeLatestHandoff ?? true;
    const includeEvidenceRefs = params.includeEvidenceRefs ?? true;

    let latestHandoff: HandoffRecord | undefined;

    if (includeLatestHandoff) {
      latestHandoff = await this.controller.getLatestForTask(
        params.runId,
        params.taskId
      );
    }

    let continuationPrompt: string;
    let evidenceRefs: readonly string[] = [];
    let nextActions: readonly string[] = [];
    let allowedWriteScope: readonly string[] = [];

    if (latestHandoff !== undefined) {
      continuationPrompt = this.controller.buildContinuationPrompt(latestHandoff);

      const packet = latestHandoff.packet as Partial<HandoffPacketV1>;

      if (includeEvidenceRefs && Array.isArray(packet.evidenceRefs)) {
        evidenceRefs = Object.freeze([...packet.evidenceRefs]);
      }

      if (Array.isArray(packet.nextActions)) {
        nextActions = Object.freeze([...packet.nextActions]);
      }

      const scope = packet.scope;
      if (scope !== undefined && Array.isArray(scope.allowedWriteScope)) {
        allowedWriteScope = Object.freeze([...scope.allowedWriteScope]);
      }
    } else {
      continuationPrompt = buildInitialPrompt(params.role, params.taskId, params.runId);
    }

    return Object.freeze({
      role: params.role,
      runId: params.runId,
      taskId: params.taskId,
      latestHandoff,
      continuationPrompt,
      evidenceRefs,
      nextActions,
      allowedWriteScope,
      assembledAt: new Date().toISOString()
    });
  }
}

// ---------------------------------------------------------------------------
// buildInitialPrompt — first-invocation prompt (no handoff)
// ---------------------------------------------------------------------------

function buildInitialPrompt(role: string, taskId: string, runId: string): string {
  return `Operate as \`${role}\` for Archon task \`${taskId}\`.

Runtime authority:
- Active run: \`${runId}\`
- Active task: \`${taskId}\`
- No prior handoff — this is the first invocation.

Rules:
- If context reaches 70%, commit a handoff packet before continuing.
- If you spawn subagents, each must return \`subagent_result_packet_v1\`.
`;
}
