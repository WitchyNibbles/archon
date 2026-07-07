/**
 * @module daemon-guidance-text
 *
 * Fixed, code-authored operator-guidance strings that daemon/runtime blocker
 * paths emit as `nextActions` — pulled out into their own tiny, dependency-
 * free module (round-13 MEDIUM fix) so BOTH the producers
 * (`runtime.ts`'s `executeRuntimeExecutionPreflight`, `daemon/supervisor.ts`'s
 * missing-review-actor hint) and the consumer
 * (`admin/why-vocabulary.ts`, which tokenizes these literals into the
 * static redaction vocabulary the same way it already threads
 * `RECOMMENDED_COMMANDS`) can import the SAME single source without
 * `why-vocabulary.ts` — a small, hot-path diagnostic module — pulling in
 * `runtime.ts`/`daemon/supervisor.ts`'s much heavier dependency graphs
 * (db-preflight, doctor, supervisor orchestration) just for two strings.
 *
 * Without this vocabulary entry, `daemon_handoff_blocked`/
 * `daemon_supervisor_blocked`'s recommended-fix message rendered as
 * all-`[redacted]` noise — the text is entirely code-authored and never
 * externally influenced, so it belongs in the STATIC vocabulary class (see
 * `why-vocabulary.ts`'s module header for the full source classification).
 */

/** `executeRuntimeExecutionPreflight`'s (runtime.ts) fixed nextActions text,
 * emitted when the preflight blocks daemon execution. */
export const RUNTIME_EXECUTION_PREFLIGHT_NEXT_ACTIONS: readonly string[] = [
  "run `npm run archon:doctor -- --repair` to replay safe runtime setup healing",
  "if task-state drift remains after services are healthy, run `npm run archon:reconcile` before retrying execution"
];

/** The fixed, code-authored words of the "missing review actor binding" hint
 * (daemon/supervisor.ts) — only the role name (a bounded `requiredGateReviews`
 * member) varies; `formatMissingReviewActorHint` is the only real producer,
 * this constant exists purely for vocabulary derivation and must stay
 * word-for-word in sync with it. */
export const MISSING_REVIEW_ACTOR_HINT_WORDS = "provide --review-actor <role>=<actor>";

export function formatMissingReviewActorHint(role: string): string {
  return `provide --review-actor ${role}=<actor>`;
}
