/**
 * @module admin/why-vocabulary
 *
 * Known-vocabulary construction for `archon why`'s round-5 redaction model
 * (audit F9, gate finding 1: "anchor the allowlist to KNOWN VOCABULARY").
 * Split out of why-diagnosis.ts for the same reason round 3 split
 * why-redaction.ts out.
 *
 * A generic identifier SHAPE can never prove a free-text token is safe (a
 * real secret often looks exactly like a task id or role name). This module
 * builds the `knownSafeTokens` vocabulary that why-redaction.ts's
 * `sanitizeFreeText`/`sanitizeForDisplay` anchor to instead, from STRUCTURED
 * context `diagnoseStall` already holds. Round 12's fail-closed inversion
 * made this vocabulary the load-bearing security boundary, so every source
 * folded in must be provably non-attacker-choosable — see
 * `buildKnownVocabulary`'s doc comment and `why-redaction-design-history.md`'s
 * round-13/14/15 entries for the full classification/enforcement narrative.
 */

import { tokenizeToVocabulary } from "./why-redaction.ts";
import {
  councilApprovedOutcomes,
  requiredGateReviews,
  runStatuses,
  taskStatuses
} from "../domain/types.ts";
import { RETRO_OUTCOME_TOKENS } from "./record-retro.ts";
import { RUNTIME_EXECUTION_PREFLIGHT_NEXT_ACTIONS, MISSING_REVIEW_ACTOR_HINT_WORDS } from "../daemon-guidance-text.ts";
import { COUNCIL_OUTCOME_TOKENS } from "./record-council.ts";
import { validateEnumMember } from "./why-sidecar-validation.ts";
import type { StallSignals } from "./why-diagnosis.ts";

/** record-council.ts's full write-side outcome set (7 tokens) — a SUPERSET of
 * `councilApprovedOutcomes` (the 4 approved-class tokens). `councilOutcome`
 * is a plain `string | undefined` at the domain level, so a legitimately
 * recorded "rejected"/"rework_required"/"pending" must still validate. */
const COUNCIL_OUTCOME_LIST = [...COUNCIL_OUTCOME_TOKENS];

/** The exact `nextCommand` templates why-diagnosis.ts recommends, named once
 * so both cause construction AND vocabulary derivation read from the same
 * literal — "the command words this module itself recommends" (round-5 gate
 * finding 1) can never drift from what a cause class actually emits. */
export const RECOMMENDED_COMMANDS = {
  reconcileRuntimeState: "npx tsx ./src/admin.ts reconcile-runtime-state --apply",
  recoverTaskBlocked:
    "npx tsx ./src/admin.ts recover --apply-safe (then re-check status; escalate to the task owner if recovery does not resolve it)",
  reviewOrchestratorTaskReviewBlocked:
    "run the review-orchestrator flow for the listed role(s), then re-check with `npx tsx ./src/admin.ts status`",
  pruneOrphans: "npx tsx ./src/admin.ts prune-orphans --confirm",
  reviewOrchestratorGateMissing:
    "run the review-orchestrator flow for the missing role(s), then `npx tsx ./src/admin.ts close-run --confirm`",
  approvalMissing:
    "record the orchestrator approval via the review-orchestrator flow, then `npx tsx ./src/admin.ts close-run --confirm`",
  recordCouncil:
    "npx tsx ./src/admin.ts record-council --task-id <id> --outcome <approved|approved_with_conditions|exception_granted> --source orchestrator",
  recordRetro:
    "npx tsx ./src/admin.ts record-retro --task-id <id> --outcome <memory_promoted|skill_patched|discarded|postmortem_filed|nothing_to_promote> --source orchestrator",
  waitForLease:
    "wait for the lease to expire (5 min stale window) or `npx tsx ./src/admin.ts recover --apply-safe`",
  respawnBudgetExhausted:
    "resolve the underlying blocker then `npx tsx ./src/admin.ts recover --apply-safe`, or raise ARCHON_MAX_RESPAWNS_PER_TASK if the task genuinely needs more",
  continueSession: "npx tsx ./src/admin.ts continue-session",
  hookBlockerRerunKnown:
    "re-run the failed command shown in this cause's evidence (full record: .archon/work/daemon/hook-blocker-state.json)",
  hookBlockerRerunUnknown: "re-run the failed command recorded in .archon/work/daemon/hook-blocker-state.json",
  daemonHandoffFallback: "follow the operator-handoff nextActions in `npx tsx ./src/admin.ts status`",
  daemonSupervisorFallback: "follow the supervisor nextActions in `npx tsx ./src/admin.ts status`",
  ownerWorkDispatch: "dispatch the task owner (this is normal in-flight work, not a stall)"
} as const;

/** The exact sidecar/table source strings why-diagnosis.ts cites as evidence
 * provenance — "sidecar paths the collector itself constructed" (round-5
 * gate finding 1), single-sourced the same way as `RECOMMENDED_COMMANDS`. */
export const EVIDENCE_SOURCES = {
  integrityExports: "project_runtime_state vs .archon/work exports",
  taskBlocked: "tasks.status = blocked (project_runtime_state seed-failure metadata when it matches)",
  taskReviewBlocked: "reviews table (evaluateReviewDecision, per review_blocked task)",
  orphanDuplicateRuns: "tasks table (duplicate task_key with sealed twin)",
  reviewGateMissing: "reviews table (per approved task)",
  approvalMissing: "approvals table (per approved task)",
  councilGate: "tasks.packet.councilOutcome",
  retroSealGate: "tasks.packet.retroOutcome (none recorded)",
  respawnLease: ".archon/work/daemon/respawn-lease-<runId>.lock",
  respawnBudget: "project_runtime_state.metadata.archonDaemon",
  hookBlocker: ".archon/work/daemon/hook-blocker-state.json",
  contextGuard: ".archon/work/context-guard.json",
  daemonHandoff: ".archon/work/daemon/operator-handoff.json",
  daemonSupervisor: ".archon/work/daemon/supervisor-status.json",
  ownerWork: "run execution plan directive"
} as const;

const STATIC_VOCABULARY_TOKENS: readonly string[] = [
  ...taskStatuses,
  ...runStatuses,
  ...requiredGateReviews,
  ...councilApprovedOutcomes,
  ...RETRO_OUTCOME_TOKENS,
  "unknown",
  "unset",
  ...Object.values(RECOMMENDED_COMMANDS).flatMap(tokenizeToVocabulary),
  ...Object.values(EVIDENCE_SOURCES).flatMap(tokenizeToVocabulary),
  ...tokenizeToVocabulary(RUNTIME_EXECUTION_PREFLIGHT_NEXT_ACTIONS.join(" ")),
  ...tokenizeToVocabulary(MISSING_REVIEW_ACTOR_HINT_WORDS)
];

/** Tokenizes every defined string argument and adds each core token to
 * `target` — the uniform way every dynamic (per-diagnosis) vocabulary
 * contribution is folded in below. */
function addTokenized(target: Set<string>, ...values: ReadonlyArray<string | undefined>): void {
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const token of tokenizeToVocabulary(value)) target.add(token);
  }
}

/**
 * Builds the `knownSafeTokens` vocabulary for one `diagnoseStall` call. Every
 * source folded in below is classified (STATIC / MACHINE-GENERATED (DB
 * column type or schema CHECK constraint) / BOUNDED EXCEPTION / FREE-FORM,
 * never added) and traced to its ENFORCEMENT POINT — the full per-row table,
 * re-audited round 15 with fresh eyes after the gate falsified it twice
 * (round-13 task ids, round-15 councilOutcome), lives in
 * `why-redaction-design-history.md`'s round-15 entry; do not trust a stale
 * copy here if the two ever disagree.
 *
 * Dropped/invalid values still APPEAR in rendered output where applicable —
 * why-diagnosis.ts interpolates task ids etc. via `structured()`, resolved
 * AFTER free-text sanitization, never touching `knownSafeTokens`. Excluding
 * a value here only stops it from ALSO rescuing an unrelated free-text token
 * elsewhere in the SAME diagnosis — it does not remove it from the
 * diagnosis itself.
 */
export function buildKnownVocabulary(signals: StallSignals): ReadonlySet<string> {
  const vocabulary = new Set(STATIC_VOCABULARY_TOKENS);

  // BOUNDED EXCEPTION: only the CURRENT diagnosis's own explicit scope — the
  // one task/run id the operator actually asked about — is trusted. No other
  // task id anywhere below gets this treatment (round-13 CRITICAL fix).
  addTokenized(vocabulary, signals.scope.taskId, signals.scope.runId);
  addTokenized(vocabulary, signals.run?.id, signals.run?.status);
  for (const key of Object.keys(signals.taskCounts ?? {})) vocabulary.add(key);

  for (const task of signals.reviewBlockedTasks ?? []) {
    for (const blocker of task.blockers) addTokenized(vocabulary, blocker);
  }
  for (const group of signals.duplicateRuns ?? []) {
    for (const runId of group.runIds) addTokenized(vocabulary, runId);
  }
  for (const block of signals.closureBlocks ?? []) {
    for (const role of block.missingRoles) addTokenized(vocabulary, role);
  }
  // Round-15: councilOutcome is `string | undefined`, NOT a typed union — it
  // must validate against COUNCIL_OUTCOME_LIST at THIS fold site (same class
  // as round-14 sidecar fields). Invalid drops from vocabulary only, not
  // from the diagnosis (still renders via structured()).
  for (const gate of signals.councilGates ?? []) {
    addTokenized(vocabulary, validateEnumMember(gate.outcome, COUNCIL_OUTCOME_LIST));
  }
  if (signals.ownerWork) addTokenized(vocabulary, signals.ownerWork.directiveKind);

  const { hookBlocker, contextGuard, daemonHandoff, daemonSupervisor } = signals.sidecars;
  if (hookBlocker) addTokenized(vocabulary, hookBlocker.blockerKind, hookBlocker.recordedAt);
  if (contextGuard) addTokenized(vocabulary, contextGuard.invocationId, contextGuard.state);
  if (daemonHandoff) addTokenized(vocabulary, daemonHandoff.blockerKind, daemonHandoff.state);
  if (daemonSupervisor) addTokenized(vocabulary, daemonSupervisor.blockerKind, daemonSupervisor.state);

  return vocabulary;
}
