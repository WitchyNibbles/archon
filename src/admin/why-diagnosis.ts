/**
 * @module admin/why-diagnosis
 *
 * Pure aggregation, ranking, and explanation core for `archon why` (audit F9).
 *
 * The problem this solves: when the autonomy loop stalls, the cause lives across
 * five sidecar files plus two DB tables, and only the Stop-hook message (if the
 * operator saw it) says which. This module takes an already-collected,
 * normalized snapshot of every stall signal (`StallSignals`) and ranks the
 * causes into ONE plain-language explanation. IT DOES NO IO — every signal is
 * injected, so the ranking and phrasing are deterministic and unit-testable
 * against store doubles at the collector boundary (see admin/why.ts).
 *
 * ---------------------------------------------------------------------------
 * Ranking rationale (most-blocking first). The order below is deliberate, not
 * incidental — a lower `rank` number means "fix this first, it invalidates or
 * gates everything below it". Every one of the six task statuses
 * (ready/in_progress/review_blocked/approved/done/blocked) is accounted for:
 * ready+in_progress surface as advisory owner-work, done needs no cause,
 * review_blocked/blocked/approved each have a dedicated cause class below.
 *
 *   1. INTEGRITY CONTRADICTIONS (rank 10) — runtime truth disagrees with the
 *      local exports. Nothing downstream (gate accounting, closure, status) can
 *      be trusted until this is reconciled, so it ranks above every other cause.
 *   2. TASK EXPLICITLY BLOCKED (rank 12) — a task sitting in `status: blocked`
 *      is a hard, already-failed stop: the single most common REAL stall, and
 *      more concrete than any governance gate below it.
 *   3. TASK STUCK IN REVIEW (rank 14) — `status: review_blocked` with named
 *      missing/failing reviewer roles. Equally common in practice; ranked just
 *      below an outright failure because it is still progressing (waiting on a
 *      reviewer), not dead.
 *   4. STRUCTURAL CORRUPTION — orphan/duplicate runs for one task_key (rank 16).
 *      Duplicate task rows corrupt review/approval accounting; ranked below the
 *      two task-level stalls above (which name a concrete task) but still ahead
 *      of the closure/governance gates it can corrupt the accounting for.
 *   5. MISSING REVIEW/APPROVAL GATES (rank 20/25) — an `approved` task cannot
 *      close because a required review role never recorded a passed review, or
 *      no orchestrator approval exists (consumed from `planRunClosure`, the
 *      single source of truth for this predicate — see why.ts).
 *   6. COUNCIL GATE (rank 30) — a required Design & Architecture Council review
 *      with no approved-class outcome. A governance gate on the closure path.
 *   7. RETRO SEAL GATE (rank 40) — the run is seal-ready but no task recorded a
 *      retro decision. The final governance gate before a run can be sealed.
 *   8. RESPAWN LEASE / BUDGET (rank 50/55) — execution-loop stalls: a held
 *      respawn lease or an exhausted per-task respawn budget. Recoverable.
 *   9. SIDECAR BLOCKERS (rank 60-75) — hook-blocker state, a pending
 *      context-guard handoff, and daemon operator-handoff / supervisor blocks.
 *      These are per-turn hook records; they may be stale, so they rank below
 *      authoritative runtime gates.
 *  10. ADVISORY (rank 90) — owner work simply in flight (ready/in_progress
 *      tasks). Not a stall; surfaced last, and only when nothing more blocking
 *      is present, so `why` never cries wolf.
 *
 * Summary form (matches audit §3.7): integrity contradictions > task
 * blocked/review-blocked > structural corruption > missing gates > retro gate
 * > lease/budget > sidecar blockers > advisory.
 *
 * Round-4 (redact-by-default, provenance-tagged evidence): every evidence
 * value is tagged by PROVENANCE at construction — `structured()` (this
 * module's own ids/roles/tokens/counts, pass through) or `freeText()`
 * (sidecar-sourced text, redacted — why-redaction.ts's `sanitizeFreeText`).
 * `buildEvidence` is the ONLY way to construct evidence — privately branded,
 * so a cause class cannot skip tagging.
 *
 * Round-5 (vocabulary-anchored, runtime-enforced brand): a generic identifier
 * SHAPE can never prove safety, so `freeText()` now anchors to a
 * `knownSafeTokens` vocabulary built per-diagnosis from this module's own
 * structured context (`buildKnownVocabulary`, why-vocabulary.ts), not shape
 * alone. The brand is also runtime-enforced: `buildEvidence` registers every
 * object it builds in a private `WeakSet`; both render paths
 * (`formatStallDiagnosis`, `serializeStallDiagnosis`) throw if a cause's
 * evidence was never registered. See why-redaction.ts's header for the full
 * rationale and honestly-disclosed friction.
 * ---------------------------------------------------------------------------
 */

import { sanitizeForDisplay } from "./why-redaction.ts";
import { RECOMMENDED_COMMANDS, EVIDENCE_SOURCES, buildKnownVocabulary } from "./why-vocabulary.ts";

// ---------------------------------------------------------------------------
// Rank constants — single source of truth for ordering.
// ---------------------------------------------------------------------------

export const STALL_CAUSE_RANKS = {
  integrity_contradiction: 10,
  task_blocked: 12,
  task_review_blocked: 14,
  orphan_duplicate_runs: 16,
  review_gate_missing: 20,
  approval_missing: 25,
  council_gate: 30,
  retro_seal_gate: 40,
  respawn_lease_held: 50,
  respawn_budget_exhausted: 55,
  hook_blocker: 60,
  context_guard_pending: 65,
  daemon_handoff_blocked: 70,
  daemon_supervisor_blocked: 75,
  owner_work_pending: 90
} as const;

export type StallCauseId = keyof typeof STALL_CAUSE_RANKS;

// ---------------------------------------------------------------------------
// Normalized input — every signal a collector must gather. All optional except
// scope + sidecars: an absent field means "that signal source was empty or
// unavailable", which the ranker treats as "this cause is not present". This is
// the tolerate-absence contract the collector relies on for sidecar files.
// ---------------------------------------------------------------------------

/** A task sitting in `status: blocked` — an explicit, already-failed stop. */
export interface BlockedTaskSignal {
  taskId: string;
  /** Human-readable failure reason — from matching seed-failure metadata when
   * available, otherwise a generic "no metadata recorded" note. Never blank. */
  reason: string;
}

/** A task sitting in `status: review_blocked` with named blocking reviews. */
export interface ReviewBlockedTaskSignal {
  taskId: string;
  /** Blocker strings from `evaluateReviewDecision` (core/policy.ts) — e.g.
   * "missing required review: security_reviewer" or
   * "required review not passed: qa_engineer is blocked". */
  blockers: string[];
}

export interface ClosureBlockSignal {
  taskId: string;
  /** "missing_review" → a required role has no passed review; "missing_approval"
   * → no orchestrator approval recorded. */
  kind: "missing_review" | "missing_approval";
  /** Missing reviewer roles (only for kind === "missing_review"). */
  missingRoles: string[];
}

export interface CouncilGateSignal {
  taskId: string;
  /** The recorded council outcome, or undefined when never recorded. */
  outcome: string | undefined;
}

export interface RespawnSignal {
  /** The task the respawn counter is scoped to (undefined when no daemon meta). */
  taskId: string | undefined;
  /** Effective respawn count for the active task (0 when counter is stale). */
  count: number;
  /** Per-task respawn budget (ARCHON_MAX_RESPAWNS_PER_TASK). */
  budget: number;
  /** True when a respawn lease is currently held (and not expired) for the run. */
  leaseHeld: boolean;
  /** Lease owner identity, when held. */
  leaseOwner?: string | undefined;
}

export interface HookBlockerSignal {
  taskId: string;
  blockerKind: string;
  command: string;
  summary: string;
  recordedAt?: string | undefined;
}

export interface ContextGuardSignal {
  state: string;
  taskId: string;
  invocationId: string;
}

export interface DaemonBlockerSignal {
  state: string;
  blockerKind?: string | undefined;
  reason: string;
  nextActions: string[];
}

export interface OwnerWorkSignal {
  directiveKind: string;
  taskIds: string[];
}

export interface StallSignals {
  now: string;
  scope: { runId?: string | undefined; taskId?: string | undefined };
  /** Undefined when no run could be resolved at all. */
  run?: { id: string; status: string } | undefined;
  /** Task status counts for the healthy-state summary. */
  taskCounts?: Record<string, number> | undefined;

  integrity?:
    | {
        status: "consistent" | "contradicted" | "unavailable";
        contradictions: string[];
      }
    | undefined;
  /** Tasks explicitly in `status: blocked` (an already-failed stop). */
  blockedTasks?: BlockedTaskSignal[] | undefined;
  /** Tasks in `status: review_blocked` with named blocking reviews. */
  reviewBlockedTasks?: ReviewBlockedTaskSignal[] | undefined;
  /** Orphan/duplicate task_key groups (already vetted: each has a sealed twin). */
  duplicateRuns?: Array<{ taskKey: string; runIds: string[] }> | undefined;
  /** `approved` tasks that cannot close, with the typed reason. */
  closureBlocks?: ClosureBlockSignal[] | undefined;
  /** True when the run is otherwise seal-ready but no retro was recorded. */
  retroSealBlocked?: boolean | undefined;
  /** Task ids that are terminal/seal-ready when `retroSealBlocked` is true —
   * gives the retro-gate cause concrete evidence instead of just the run id. */
  sealReadyTaskIds?: string[] | undefined;
  /** Council gates that are required but lack an approved-class outcome. */
  councilGates?: CouncilGateSignal[] | undefined;
  respawn?: RespawnSignal | undefined;
  ownerWork?: OwnerWorkSignal | undefined;

  sidecars: {
    hookBlocker?: HookBlockerSignal | undefined;
    contextGuard?: ContextGuardSignal | undefined;
    daemonHandoff?: DaemonBlockerSignal | undefined;
    daemonSupervisor?: DaemonBlockerSignal | undefined;
  };
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** The resolved, display-ready evidence value shape — what a cause's
 * `values` map actually holds after `buildEvidence` resolves every tagged
 * input below. */
type EvidenceScalar = string | number | boolean | string[];

// Private brand (a real runtime symbol, not just a type-level `declare
// const`) — deliberately NOT exported. The only way to produce a value typed
// `StallCauseEvidence` is `buildEvidence()`; writing `evidence: { source,
// values }` directly is missing the brand and TypeScript rejects it.
const EVIDENCE_BRAND: unique symbol = Symbol("StallCauseEvidence");

export interface StallCauseEvidence {
  readonly [EVIDENCE_BRAND]: true;
  /** File path or DB table the signal came from. */
  source: string;
  /** Key values a human can verify against that source. */
  values: Record<string, EvidenceScalar>;
}

/** Tags a value this module generated itself — a task/run id, a role name, a
 * status/enum token, a count, a path it constructed, a command it
 * recommends. Passes through `buildEvidence` completely unchanged: nothing
 * external could have written into it, so there is nothing to redact. */
export function structured(value: EvidenceScalar): TaggedEvidenceValue {
  return { provenance: "structured", value };
}

/** Tags a value SOURCED FROM OUTSIDE this module — a hook-blocker's recorded
 * command/summary, a seed-failure reason, a daemon's recorded reason or
 * nextActions text, or any other caught-error message. `buildEvidence` runs
 * this through why-redaction.ts's `sanitizeForDisplay` (redact by default,
 * allowlist the safe shapes, then truncate) before it becomes visible. */
export function freeText(value: string | string[]): TaggedEvidenceValue {
  return { provenance: "freeText", value };
}

interface TaggedEvidenceValue {
  readonly provenance: "structured" | "freeText";
  readonly value: EvidenceScalar;
}

function resolveEvidenceValue(
  tagged: TaggedEvidenceValue,
  knownSafeTokens: ReadonlySet<string>
): EvidenceScalar {
  if (tagged.provenance === "structured") return tagged.value;
  if (Array.isArray(tagged.value)) {
    return tagged.value.map((v) => sanitizeForDisplay(v, knownSafeTokens));
  }
  return sanitizeForDisplay(String(tagged.value), knownSafeTokens);
}

// Round-5 runtime brand enforcement (gate finding 2): the compile-time brand
// alone is convention — `as StallCauseEvidence` bypasses it. This
// module-private WeakSet records every object `buildEvidence()` actually
// built; both render paths below check membership and THROW on a miss, so a
// cast that skips the constructor fails loudly at render time.
const REGISTERED_EVIDENCE = new WeakSet<object>();

function assertEvidenceRegistered(cause: Pick<StallCause, "id" | "evidence">): void {
  if (!REGISTERED_EVIDENCE.has(cause.evidence)) {
    throw new Error(
      `stall cause "${cause.id}" carries evidence that was not constructed via buildEvidence() — ` +
        "a raw or cast evidence object bypasses redaction and must never be rendered. " +
        "This is a bug in the cause-construction code, not an operator-facing condition."
    );
  }
}

/** Validates every cause's evidence was constructed via `buildEvidence()`
 * before rendering (round-5 gate finding 2). Exported for tests. */
export function assertDiagnosisEvidenceRegistered(diagnosis: StallDiagnosis): void {
  for (const cause of diagnosis.causes) assertEvidenceRegistered(cause);
}

/** JSON serializer for a `StallDiagnosis` — validates evidence registration
 * (see `assertDiagnosisEvidenceRegistered`) before stringifying, so `--json`
 * gets the same runtime enforcement as the human-readable path. */
export function serializeStallDiagnosis(diagnosis: StallDiagnosis): string {
  assertDiagnosisEvidenceRegistered(diagnosis);
  return JSON.stringify(diagnosis);
}

/** The ONLY constructor for `StallCauseEvidence` (type-enforced choke point).
 * Every value must arrive tagged via `structured()`/`freeText()` — there is
 * no other way to obtain a value typed `StallCauseEvidence` (see
 * `EVIDENCE_BRAND` above). `knownSafeTokens` is the per-diagnosis vocabulary
 * (`buildKnownVocabulary`, why-vocabulary.ts) freeText resolution anchors to.
 * Registers the built object in `REGISTERED_EVIDENCE` before returning it. */
function buildEvidence(
  knownSafeTokens: ReadonlySet<string>,
  source: string,
  values: Record<string, TaggedEvidenceValue>
): StallCauseEvidence {
  const resolved: Record<string, EvidenceScalar> = {};
  for (const [key, tagged] of Object.entries(values)) {
    resolved[key] = resolveEvidenceValue(tagged, knownSafeTokens);
  }
  const evidence = { [EVIDENCE_BRAND]: true, source, values: resolved } as StallCauseEvidence;
  REGISTERED_EVIDENCE.add(evidence);
  return evidence;
}

export interface StallCause {
  id: StallCauseId;
  rank: number;
  /** True when this cause does not itself block completion (informational). */
  advisory: boolean;
  /** One sentence, no jargon — "what it is". */
  what: string;
  evidence: StallCauseEvidence;
  /** The exact next command that resolves it. */
  nextCommand: string;
}

export interface StallDiagnosis {
  authorityLabel: "derived_only";
  now: string;
  scope: { runId?: string | undefined; taskId?: string | undefined };
  /** True when at least one non-advisory cause is present. */
  stuck: boolean;
  causes: StallCause[];
  /** Present when nothing is stuck — a 3-line healthy summary. */
  healthy?: { summaryLines: string[] } | undefined;
}

// ---------------------------------------------------------------------------
// Ranker — pure. Given signals, emit ranked causes. Every cause is built via
// `buildEvidence` (above), which resolves `structured()`/`freeText()`-tagged
// values as it constructs the evidence object — there is no later pass that
// redacts causes after the fact, and no way to add a new cause class below
// that skips tagging (see the `EVIDENCE_BRAND` comment on `StallCauseEvidence`).
// ---------------------------------------------------------------------------

function inScope(signals: StallSignals, taskId: string | undefined): boolean {
  const focus = signals.scope.taskId;
  if (!focus) return true;
  return taskId === focus;
}

export function diagnoseStall(signals: StallSignals): StallDiagnosis {
  const causes: StallCause[] = [];
  const focusTask = signals.scope.taskId;
  // One vocabulary per diagnosis, anchored to THIS call's structured context
  // (`buildKnownVocabulary`, why-vocabulary.ts). `build` is a thin wrapper so
  // every cause below threads it without repeating it at each call site.
  const knownSafeTokens = buildKnownVocabulary(signals);
  const build = (source: string, values: Record<string, TaggedEvidenceValue>): StallCauseEvidence =>
    buildEvidence(knownSafeTokens, source, values);

  // 1. Integrity contradictions (rank 10) — `contradictions` is freeText: a
  // diagnostic diff that can quote arbitrary internal-state field values.
  if (
    signals.integrity?.status === "contradicted" &&
    signals.integrity.contradictions.length > 0
  ) {
    causes.push({
      id: "integrity_contradiction",
      rank: STALL_CAUSE_RANKS.integrity_contradiction,
      advisory: false,
      what:
        "The runtime's authoritative state disagrees with the local export files, so nothing downstream can be trusted until they are reconciled.",
      evidence: build(EVIDENCE_SOURCES.integrityExports, {
        contradictions: freeText(signals.integrity.contradictions)
      }),
      nextCommand: RECOMMENDED_COMMANDS.reconcileRuntimeState
    });
  }

  // 2. Task explicitly blocked/failed (rank 12) — the single most common real
  // stall. `reasons` is freeText: a seedFailure.reason or caught Error.message.
  const blockedInScope = (signals.blockedTasks ?? []).filter((b) => inScope(signals, b.taskId));
  if (blockedInScope.length > 0) {
    causes.push({
      id: "task_blocked",
      rank: STALL_CAUSE_RANKS.task_blocked,
      advisory: false,
      what:
        "A task explicitly failed and is sitting in the `blocked` status — it will not resume on its own without operator recovery.",
      evidence: build(EVIDENCE_SOURCES.taskBlocked, {
        tasks: structured(blockedInScope.map((b) => b.taskId)),
        reasons: freeText(blockedInScope.map((b) => b.reason))
      }),
      nextCommand: RECOMMENDED_COMMANDS.recoverTaskBlocked
    });
  }

  // 3. Task stuck in review (rank 14). `blockers` is structured:
  // evaluateReviewDecision only emits fixed template strings from role
  // names, never external free text.
  const reviewBlockedInScope = (signals.reviewBlockedTasks ?? []).filter((b) =>
    inScope(signals, b.taskId)
  );
  if (reviewBlockedInScope.length > 0) {
    const allBlockers = [...new Set(reviewBlockedInScope.flatMap((b) => b.blockers))];
    causes.push({
      id: "task_review_blocked",
      rank: STALL_CAUSE_RANKS.task_review_blocked,
      advisory: false,
      what:
        "A task is waiting on review: at least one required reviewer role has not recorded a passing review.",
      evidence: build(EVIDENCE_SOURCES.taskReviewBlocked, {
        tasks: structured(reviewBlockedInScope.map((b) => b.taskId)),
        blockers: structured(allBlockers)
      }),
      nextCommand: RECOMMENDED_COMMANDS.reviewOrchestratorTaskReviewBlocked
    });
  }

  // 4. Orphan / duplicate runs for one task_key (rank 16).
  const dupInScope = (signals.duplicateRuns ?? []).filter((group) => {
    if (!focusTask) return true;
    // task_key equals the packet task id in this codebase.
    return group.taskKey === focusTask;
  });
  if (dupInScope.length > 0) {
    causes.push({
      id: "orphan_duplicate_runs",
      rank: STALL_CAUSE_RANKS.orphan_duplicate_runs,
      advisory: false,
      what:
        "The same task exists in more than one run with a sealed twin, so duplicate rows are corrupting gate and closure accounting.",
      evidence: build(EVIDENCE_SOURCES.orphanDuplicateRuns, {
        taskKeys: structured(dupInScope.map((g) => g.taskKey)),
        runIds: structured(dupInScope.flatMap((g) => g.runIds))
      }),
      nextCommand: RECOMMENDED_COMMANDS.pruneOrphans
    });
  }

  // 5. Missing review / approval gates (rank 20 / 25) — consumed from
  // planRunClosure's plan.blocked; this ranker renders the typed detail only.
  const reviewBlocks = (signals.closureBlocks ?? []).filter(
    (b) => b.kind === "missing_review" && inScope(signals, b.taskId)
  );
  if (reviewBlocks.length > 0) {
    const roles = [...new Set(reviewBlocks.flatMap((b) => b.missingRoles))];
    causes.push({
      id: "review_gate_missing",
      rank: STALL_CAUSE_RANKS.review_gate_missing,
      advisory: false,
      what:
        "A task passed into `approved` but a required review role never recorded a passed review, so it cannot close.",
      evidence: build(EVIDENCE_SOURCES.reviewGateMissing, {
        tasks: structured(reviewBlocks.map((b) => b.taskId)),
        missingRoles: structured(roles)
      }),
      nextCommand: RECOMMENDED_COMMANDS.reviewOrchestratorGateMissing
    });
  }

  const approvalBlocks = (signals.closureBlocks ?? []).filter(
    (b) => b.kind === "missing_approval" && inScope(signals, b.taskId)
  );
  if (approvalBlocks.length > 0) {
    causes.push({
      id: "approval_missing",
      rank: STALL_CAUSE_RANKS.approval_missing,
      advisory: false,
      what:
        "A task is `approved` but has no orchestrator-recorded approval, so its closure provenance is incomplete.",
      evidence: build(EVIDENCE_SOURCES.approvalMissing, {
        tasks: structured(approvalBlocks.map((b) => b.taskId))
      }),
      nextCommand: RECOMMENDED_COMMANDS.approvalMissing
    });
  }

  // 6. Council gate (rank 30) — `outcomes` is structured, always a fixed
  // orchestrator-recorded token (or "unset"), never free text.
  const councilBlocks = (signals.councilGates ?? []).filter((g) =>
    inScope(signals, g.taskId)
  );
  if (councilBlocks.length > 0) {
    causes.push({
      id: "council_gate",
      rank: STALL_CAUSE_RANKS.council_gate,
      advisory: false,
      what:
        "A task requires Design & Architecture Council review but has no approved-class outcome recorded.",
      evidence: build(EVIDENCE_SOURCES.councilGate, {
        tasks: structured(councilBlocks.map((g) => g.taskId)),
        outcomes: structured(councilBlocks.map((g) => g.outcome ?? "unset"))
      }),
      nextCommand: RECOMMENDED_COMMANDS.recordCouncil
    });
  }

  // 7. Retro seal gate (rank 40).
  if (signals.retroSealBlocked === true) {
    causes.push({
      id: "retro_seal_gate",
      rank: STALL_CAUSE_RANKS.retro_seal_gate,
      advisory: false,
      what:
        "Every task is terminal so the run is ready to seal, but no task recorded a post-task retro decision, which the seal gate requires.",
      evidence: build(EVIDENCE_SOURCES.retroSealGate, {
        runId: structured(signals.run?.id ?? "unknown"),
        tasks: structured(signals.sealReadyTaskIds ?? [])
      }),
      nextCommand: RECOMMENDED_COMMANDS.recordRetro
    });
  }

  // 8. Respawn lease / budget (rank 50 / 55). `owner` is freeText — written by
  // whatever process acquired the lock file, not a value this module controls.
  const respawn = signals.respawn;
  if (respawn) {
    const respawnTaskInScope = inScope(signals, respawn.taskId);
    if (respawn.leaseHeld && respawnTaskInScope) {
      causes.push({
        id: "respawn_lease_held",
        rank: STALL_CAUSE_RANKS.respawn_lease_held,
        advisory: false,
        what:
          "A respawn lease is currently held for this run, so a fresh continuation turn cannot be spawned until it is released or expires.",
        evidence: build(EVIDENCE_SOURCES.respawnLease, {
          owner: freeText(respawn.leaseOwner ?? "unknown")
        }),
        nextCommand: RECOMMENDED_COMMANDS.waitForLease
      });
    }
    if (
      respawnTaskInScope &&
      respawn.taskId !== undefined &&
      respawn.count >= respawn.budget
    ) {
      causes.push({
        id: "respawn_budget_exhausted",
        rank: STALL_CAUSE_RANKS.respawn_budget_exhausted,
        advisory: false,
        what:
          "This task has consumed its full respawn budget, so the daemon will not respawn it again without operator intervention.",
        evidence: build(EVIDENCE_SOURCES.respawnBudget, {
          taskId: structured(respawn.taskId),
          count: structured(respawn.count),
          budget: structured(respawn.budget)
        }),
        nextCommand: RECOMMENDED_COMMANDS.respawnBudgetExhausted
      });
    }
  }

  // 9. Sidecar blockers (rank 60-75). Present only when the sidecar file
  // existed and parsed (absence tolerated). hook-blocker command/summary are
  // the canonical freeText case: a recorded shell command/output can contain
  // literally anything, including a credential the command itself embedded.
  const hookBlocker = signals.sidecars.hookBlocker;
  if (hookBlocker && inScope(signals, hookBlocker.taskId)) {
    const safeCommand = sanitizeForDisplay(hookBlocker.command, knownSafeTokens);
    causes.push({
      id: "hook_blocker",
      rank: STALL_CAUSE_RANKS.hook_blocker,
      advisory: false,
      what:
        "A command failed and the hook recorded a blocker that stays in force until the same command is re-run and passes.",
      evidence: build(EVIDENCE_SOURCES.hookBlocker, {
        blockerKind: structured(hookBlocker.blockerKind),
        command: freeText(hookBlocker.command),
        summary: freeText(hookBlocker.summary),
        ...(hookBlocker.recordedAt ? { recordedAt: structured(hookBlocker.recordedAt) } : {})
      }),
      // nextCommand never re-embeds the raw command — it points at the
      // already-redacted evidence.values.command and the sidecar file.
      nextCommand:
        safeCommand.trim().length > 0
          ? RECOMMENDED_COMMANDS.hookBlockerRerunKnown
          : RECOMMENDED_COMMANDS.hookBlockerRerunUnknown
    });
  }

  const contextGuard = signals.sidecars.contextGuard;
  if (
    contextGuard &&
    contextGuard.state !== "registered" &&
    inScope(signals, contextGuard.taskId)
  ) {
    causes.push({
      id: "context_guard_pending",
      rank: STALL_CAUSE_RANKS.context_guard_pending,
      advisory: false,
      what:
        "The context guard shows a context handoff was written but the session has not yet resumed on a fresh turn.",
      evidence: build(EVIDENCE_SOURCES.contextGuard, {
        state: structured(contextGuard.state),
        invocationId: structured(contextGuard.invocationId)
      }),
      nextCommand: RECOMMENDED_COMMANDS.continueSession
    });
  }

  // `joinNextActions` joins the FULL nextActions array, never just the first
  // entry. `reason`/each `nextActions` entry is freeText — sourced from a
  // sidecar JSON file the daemon writes.
  const daemonHandoff = signals.sidecars.daemonHandoff;
  if (daemonHandoff) {
    const safeNextActions = daemonHandoff.nextActions.map((step) => sanitizeForDisplay(step, knownSafeTokens));
    causes.push({
      id: "daemon_handoff_blocked",
      rank: STALL_CAUSE_RANKS.daemon_handoff_blocked,
      advisory: false,
      what:
        "The daemon wrote an operator-handoff record: it hit a point in the loop it cannot pass without operator action.",
      evidence: build(EVIDENCE_SOURCES.daemonHandoff, {
        blockerKind: structured(daemonHandoff.blockerKind ?? "unknown"),
        reason: freeText(daemonHandoff.reason)
      }),
      nextCommand: joinNextActions(safeNextActions, RECOMMENDED_COMMANDS.daemonHandoffFallback)
    });
  }

  // Covers max_cycles_reached and invalid states too, not just "blocked".
  const daemonSupervisor = signals.sidecars.daemonSupervisor;
  if (daemonSupervisor && daemonSupervisor.state !== "completed") {
    const safeNextActions = daemonSupervisor.nextActions.map((step) => sanitizeForDisplay(step, knownSafeTokens));
    causes.push({
      id: "daemon_supervisor_blocked",
      rank: STALL_CAUSE_RANKS.daemon_supervisor_blocked,
      advisory: false,
      what:
        daemonSupervisor.state === "max_cycles_reached"
          ? "The daemon supervisor hit its max-cycles limit before the loop completed."
          : daemonSupervisor.state === "invalid"
            ? "The daemon supervisor recorded an invalid state and could not advance the loop."
            : "The daemon supervisor stopped in a blocked state and could not advance the loop on its own.",
      evidence: build(EVIDENCE_SOURCES.daemonSupervisor, {
        state: structured(daemonSupervisor.state),
        blockerKind: structured(daemonSupervisor.blockerKind ?? "unknown"),
        reason: freeText(daemonSupervisor.reason)
      }),
      nextCommand: joinNextActions(safeNextActions, RECOMMENDED_COMMANDS.daemonSupervisorFallback)
    });
  }

  // 10. Advisory: owner work in flight (rank 90). Only meaningful information —
  // never a stall by itself. Covers ready + in_progress tasks.
  const ownerWork = signals.ownerWork;
  if (ownerWork && ownerWork.taskIds.length > 0) {
    const ownerTasks = focusTask
      ? ownerWork.taskIds.filter((id) => id === focusTask)
      : ownerWork.taskIds;
    if (ownerTasks.length > 0) {
      causes.push({
        id: "owner_work_pending",
        rank: STALL_CAUSE_RANKS.owner_work_pending,
        advisory: true,
        what:
          "Owner work is simply still in flight — the runtime is waiting on the task owner, not blocked on a gate.",
        evidence: build(EVIDENCE_SOURCES.ownerWork, {
          directive: structured(ownerWork.directiveKind),
          tasks: structured(ownerTasks)
        }),
        nextCommand: RECOMMENDED_COMMANDS.ownerWorkDispatch
      });
    }
  }

  causes.sort((a, b) => a.rank - b.rank);

  const stuck = causes.some((c) => !c.advisory);
  const healthy = stuck ? undefined : buildHealthySummary(signals, causes);

  return {
    authorityLabel: "derived_only",
    now: signals.now,
    scope: signals.scope,
    stuck,
    causes,
    healthy
  };
}

/** Joins every step in a daemon nextActions array (never just the first) so a
 * multi-step recovery sequence is never silently truncated to one step. */
function joinNextActions(nextActions: readonly string[], fallback: string): string {
  const steps = nextActions.filter((step) => step.trim().length > 0);
  if (steps.length === 0) return fallback;
  return steps.map((step, index) => `${index + 1}) ${step}`).join(" then ");
}

// ---------------------------------------------------------------------------
// Healthy-state summary — 3 lines, explicit.
// ---------------------------------------------------------------------------

function buildHealthySummary(
  signals: StallSignals,
  causes: StallCause[]
): { summaryLines: string[] } {
  if (!signals.run) {
    return {
      summaryLines: [
        "No active run was found for this workspace/project.",
        "Nothing is stuck because there is no run in flight.",
        "Start work with /archon-intake, or pass --run-id to inspect a specific run."
      ]
    };
  }

  const counts = signals.taskCounts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const done = counts.done ?? 0;
  const advisoryNote =
    causes.length > 0
      ? "Owner work is in flight (in-progress, not blocked)."
      : "No blockers, gates, or sidecar records are outstanding.";

  return {
    summaryLines: [
      `Run ${signals.run.id} is ${signals.run.status}; nothing is stuck.`,
      `${done}/${total} tasks done. ${advisoryNote}`,
      "Next: let the loop continue, or run `npx tsx ./src/admin.ts status` for the full picture."
    ]
  };
}

// ---------------------------------------------------------------------------
// Human-readable rendering — reads like a colleague explaining, not a dump.
// ---------------------------------------------------------------------------

export function formatStallDiagnosis(diagnosis: StallDiagnosis): string {
  // Round-5 gate finding 2: runtime-enforce the evidence brand on the
  // human-readable render path too, not just the JSON serializer.
  assertDiagnosisEvidenceRegistered(diagnosis);
  const lines: string[] = [];
  const scopeLabel = diagnosis.scope.taskId
    ? `task ${diagnosis.scope.taskId}`
    : diagnosis.scope.runId
      ? `run ${diagnosis.scope.runId}`
      : "the active run";

  if (!diagnosis.stuck) {
    lines.push(`Nothing is stuck in ${scopeLabel}.`);
    lines.push("");
    for (const line of diagnosis.healthy?.summaryLines ?? []) {
      lines.push(`  ${line}`);
    }
    // Advisory causes (in-flight work) are still worth a mention.
    const advisoryOnly = diagnosis.causes.filter((c) => c.advisory);
    if (advisoryOnly.length > 0) {
      lines.push("");
      for (const cause of advisoryOnly) {
        lines.push(`  - ${cause.what}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  // MEDIUM fix: the headline count and the numbered list must agree. Number
  // only the blocking (non-advisory) causes — advisory causes are listed
  // separately afterward, unnumbered, exactly as the healthy path does.
  const blocking = diagnosis.causes.filter((c) => !c.advisory);
  const advisory = diagnosis.causes.filter((c) => c.advisory);
  const headline =
    blocking.length === 1
      ? `Here's why ${scopeLabel} is stuck:`
      : `${scopeLabel} is stuck. ${blocking.length} things are blocking it, most-blocking first:`;
  lines.push(headline);

  let index = 1;
  for (const cause of blocking) {
    lines.push("");
    lines.push(`${index}. ${cause.what}`);
    lines.push(`   evidence: ${formatEvidence(cause.evidence)}`);
    lines.push(`   fix:      ${cause.nextCommand}`);
    index += 1;
  }

  if (advisory.length > 0) {
    lines.push("");
    lines.push("Also (advisory — in-flight, not a stall):");
    for (const cause of advisory) {
      lines.push(`  - ${cause.what}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatEvidence(evidence: StallCauseEvidence): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(evidence.values)) {
    const rendered = Array.isArray(value) ? value.join(", ") : String(value);
    if (rendered.trim().length === 0) continue;
    parts.push(`${key}=${rendered}`);
  }
  const detail = parts.length > 0 ? ` (${parts.join("; ")})` : "";
  return `${evidence.source}${detail}`;
}
