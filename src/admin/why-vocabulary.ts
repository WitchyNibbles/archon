/**
 * @module admin/why-vocabulary
 *
 * Known-vocabulary construction for `archon why`'s round-5 redaction model
 * (audit F9, gate finding 1: "anchor the allowlist to KNOWN VOCABULARY, per
 * the gate's option (a)"). Split out of why-diagnosis.ts for the same reason
 * round 3 split why-redaction.ts out — this module's growth is real new
 * functionality, not something that belongs bundled into the ranking core.
 *
 * A generic identifier SHAPE can never prove a free-text token is safe (a
 * real secret often looks exactly like a task id or role name). This module
 * builds the `knownSafeTokens` vocabulary that why-redaction.ts's
 * `sanitizeFreeText`/`sanitizeForDisplay` anchor to instead, from STRUCTURED
 * context `diagnoseStall` already holds:
 *
 *   - Static: domain enums (task/run statuses, gate-review role names,
 *     council-approved outcomes, retro-outcome tokens) imported from their
 *     single owning module — never retyped here — plus this module's own
 *     recommended command words and sidecar/table evidence-source paths,
 *     tokenized from the SAME literal strings `why-diagnosis.ts` uses to
 *     build `nextCommand`/`source` values (`RECOMMENDED_COMMANDS` /
 *     `EVIDENCE_SOURCES` below), so the vocabulary can never drift from what
 *     a cause class actually emits.
 *   - Dynamic: every task id, run id, role name, and status/enum/outcome
 *     token actually present in one `StallSignals` snapshot.
 *
 * `StallSignals` is imported as a type only (no runtime import) — this keeps
 * why-diagnosis.ts → why-vocabulary.ts a one-directional VALUE dependency
 * (buildKnownVocabulary, RECOMMENDED_COMMANDS, EVIDENCE_SOURCES) with only a
 * type flowing the other way, so there is no runtime circular-import risk.
 */

import { tokenizeToVocabulary } from "./why-redaction.ts";
import {
  councilApprovedOutcomes,
  requiredGateReviews,
  runStatuses,
  taskStatuses
} from "../domain/types.ts";
import { RETRO_OUTCOME_TOKENS } from "./record-retro.ts";
import type { StallSignals } from "./why-diagnosis.ts";

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
  ...Object.values(EVIDENCE_SOURCES).flatMap(tokenizeToVocabulary)
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
 * Builds the `knownSafeTokens` vocabulary for one `diagnoseStall` call —
 * STRUCTURED context this module already holds: every task id, run id, role
 * name, and status/enum/outcome token present in `signals`, plus the static
 * command-word and sidecar-path vocabulary above. This is deliberately NOT a
 * generic "does it look like an identifier" check (round-5 CRITICAL fix) —
 * only vocabulary actually present in this diagnosis's own structured data
 * can make a freeText token survive.
 */
export function buildKnownVocabulary(signals: StallSignals): ReadonlySet<string> {
  const vocabulary = new Set(STATIC_VOCABULARY_TOKENS);

  addTokenized(vocabulary, signals.scope.taskId, signals.scope.runId);
  addTokenized(vocabulary, signals.run?.id, signals.run?.status);
  for (const key of Object.keys(signals.taskCounts ?? {})) vocabulary.add(key);

  for (const task of signals.blockedTasks ?? []) addTokenized(vocabulary, task.taskId);
  for (const task of signals.reviewBlockedTasks ?? []) {
    addTokenized(vocabulary, task.taskId);
    for (const blocker of task.blockers) addTokenized(vocabulary, blocker);
  }
  for (const group of signals.duplicateRuns ?? []) {
    addTokenized(vocabulary, group.taskKey);
    for (const runId of group.runIds) addTokenized(vocabulary, runId);
  }
  for (const block of signals.closureBlocks ?? []) {
    addTokenized(vocabulary, block.taskId);
    for (const role of block.missingRoles) addTokenized(vocabulary, role);
  }
  for (const taskId of signals.sealReadyTaskIds ?? []) addTokenized(vocabulary, taskId);
  for (const gate of signals.councilGates ?? []) addTokenized(vocabulary, gate.taskId, gate.outcome);
  if (signals.respawn) addTokenized(vocabulary, signals.respawn.taskId);
  if (signals.ownerWork) {
    addTokenized(vocabulary, signals.ownerWork.directiveKind);
    for (const taskId of signals.ownerWork.taskIds) addTokenized(vocabulary, taskId);
  }

  const { hookBlocker, contextGuard, daemonHandoff, daemonSupervisor } = signals.sidecars;
  if (hookBlocker) addTokenized(vocabulary, hookBlocker.taskId, hookBlocker.blockerKind, hookBlocker.recordedAt);
  if (contextGuard) addTokenized(vocabulary, contextGuard.taskId, contextGuard.invocationId, contextGuard.state);
  if (daemonHandoff) addTokenized(vocabulary, daemonHandoff.blockerKind, daemonHandoff.state);
  if (daemonSupervisor) addTokenized(vocabulary, daemonSupervisor.blockerKind, daemonSupervisor.state);

  return vocabulary;
}
