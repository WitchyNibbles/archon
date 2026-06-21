// fireMistakeCapture — Mistake Pattern Ledger P1 capture glue.
//
// Extracted from ArchonCoreService.recordReview so the capture concern lives in
// its own module instead of growing the (pre-existing oversized) service.ts.
//
// Non-fatal, fire-and-forget. Must never throw or reject to the caller.
// Failures are surfaced via console.warn for observability.

import { extractMistakeOccurrences } from "./mistake-ledger.ts";
import type { MistakeLedgerStoreLike } from "../store/types.ts";
import type { ReviewRecord } from "../domain/types.ts";

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
