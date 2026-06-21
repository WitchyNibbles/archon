// fireMistakeCapture + fireDistillation — Mistake Pattern Ledger P1/P2 capture glue.
//
// fireMistakeCapture: extracted from ArchonCoreService.recordReview (P1).
//   Non-fatal, fire-and-forget. Failures logged via console.warn.
//
// fireDistillation: P2 distillation hook.
//   Runs after capture to identify recurrent (≥ 2 distinct runs) fingerprints.
//   Autonomous path (allowlisted categories): calls promoteMemoryFn to promote
//     through the service's promoteMemory gate (sealed trust context, not reopened).
//   Review-required path: persists pending draft for human review.
//   Non-fatal, fire-and-forget. Failures logged via console.warn.
//
// SECURITY: The promoteMemoryFn MUST be bound to service.promoteMemory so that:
//   - isTrustedReviewActionContext gate in promoteMemory is invoked.
//   - The resolver creates a sealed WeakSet-registered context (P0 gate intact).
//   - actorRole in the promotion input is "reviewer" — satisfying the anti_pattern
//     role-gate in validateMemoryPromotion (council condition 2).
//   This module does NOT mint trusted contexts directly; it delegates to service.

import { randomUUID } from "node:crypto";
import {
  extractMistakeOccurrences,
  selectDistillationCandidates,
  buildAntiPatternContent,
  type AntiPatternDraft
} from "./mistake-ledger.ts";
import type { AntiPatternDraftStoreLike, MistakeLedgerStoreLike } from "../store/types.ts";
import type { MemoryPromotionInput, ReviewRecord } from "../domain/types.ts";

export function fireMistakeCapture(
  reviewRecord: ReviewRecord,
  projectId: string,
  ledgerStore: MistakeLedgerStoreLike
): void {
  const occurrences = extractMistakeOccurrences(reviewRecord);
  if (occurrences.length === 0) {
    return;
  }
  ledgerStore.appendMistakeOccurrences(projectId, occurrences).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[mistake-capture] appendMistakeOccurrences failed for project=${projectId} ` +
        `review=${reviewRecord.id} occurrences=${occurrences.length}: ${msg}`
    );
  });
}

/**
 * P2 distillation hook — called after P1 capture completes.
 *
 * Reads ALL occurrences for the project, selects candidates with ≥ 2 distinct
 * run IDs, then:
 * - autonomous candidates: promotes immediately via promoteMemoryFn (goes
 *   through the service promoteMemory trust gate — no P0 regression).
 * - review_required candidates: persists as pending AntiPatternDraft in
 *   draftStore for human review.
 *
 * Non-fatal, fire-and-forget. The outer async chain is not awaited by callers.
 */
export function fireDistillation(
  runId: string,
  projectId: string,
  ledgerStore: MistakeLedgerStoreLike,
  draftStore: AntiPatternDraftStoreLike,
  promoteMemoryFn: (runId: string, input: MemoryPromotionInput) => Promise<unknown>
): void {
  void runDistillation(runId, projectId, ledgerStore, draftStore, promoteMemoryFn).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mistake-capture] fireDistillation failed for project=${projectId}: ${msg}`);
    }
  );
}

async function runDistillation(
  runId: string,
  projectId: string,
  ledgerStore: MistakeLedgerStoreLike,
  draftStore: AntiPatternDraftStoreLike,
  promoteMemoryFn: (runId: string, input: MemoryPromotionInput) => Promise<unknown>
): Promise<void> {
  const allOccurrences = await ledgerStore.listMistakeOccurrences(projectId);
  const candidates = selectDistillationCandidates(allOccurrences);

  if (candidates.length === 0) {
    return;
  }

  const now = new Date().toISOString();

  for (const candidate of candidates) {
    const content = buildAntiPatternContent(candidate);

    if (candidate.promotionPath === "autonomous") {
      // AUTONOMOUS PATH: promote immediately through service promoteMemory.
      // promoteMemory resolves a sealed TrustedReviewActionContext via the
      // service's configured resolver — P0 gate not bypassed.
      // actorRole: "reviewer" satisfies the anti_pattern role-gate (condition 2).
      const promotionInput: MemoryPromotionInput = {
        scope: "project",
        entryType: "anti_pattern",
        title: `Anti-pattern: ${candidate.category} (${candidate.distinctRunCount} runs)`,
        content,
        sourceRunId: runId,
        reviewer: "archon-orchestrator",
        actor: "archon-orchestrator",
        // Council condition 2 role-gate: must be "reviewer" for anti_pattern.
        // This value is validated by validateMemoryPromotion before the trust
        // gate resolves the context; the resolver then produces actorRole="reviewer"
        // matching this input, completing the role-gate chain.
        actorRole: "reviewer",
        metadata: {
          tags: [
            "anti_pattern",
            `category:${candidate.category}`,
            `fingerprint:${candidate.fingerprint}`,
            `recurrence:${candidate.distinctRunCount}`
          ],
          mistakeFingerprint: candidate.fingerprint,
          authorityLevel: "reviewed_memory",
          reviewedAt: now
        }
      };

      await promoteMemoryFn(runId, promotionInput).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[mistake-capture] autonomous promotion failed for fingerprint=${candidate.fingerprint}: ${msg}`
        );
      });
    } else {
      // REVIEW-REQUIRED PATH: persist as pending draft, do NOT promote.
      const draft: AntiPatternDraft = {
        id: `draft-${randomUUID()}`,
        projectId,
        fingerprint: candidate.fingerprint,
        category: candidate.category,
        ruleLocus: candidate.ruleLocus,
        distinctRunCount: candidate.distinctRunCount,
        promotionPath: candidate.promotionPath,
        content,
        status: "pending",
        createdAt: now
      };

      await draftStore.appendAntiPatternDraft(projectId, draft).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[mistake-capture] draft persistence failed for fingerprint=${candidate.fingerprint}: ${msg}`
        );
      });
    }
  }
}
