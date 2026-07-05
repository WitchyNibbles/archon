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
 * Round-4 redesign (redact-by-default, provenance-tagged evidence): rounds 2
 * and 3 patched the same shape-hunting scrubber twice and both left a bypass.
 * Round 4 inverts the default — every evidence value is tagged by PROVENANCE
 * at construction: `structured()` (this module's own ids/roles/tokens/counts,
 * pass through) or `freeText()` (sidecar-sourced text, redacted unless it
 * matches an explicit safe shape — why-redaction.ts's `sanitizeFreeText`).
 * `buildEvidence` is the ONLY way to construct evidence — its return type is
 * privately branded, so a cause class cannot skip tagging. See
 * why-redaction.ts's header for the full rationale and accepted friction.
 * ---------------------------------------------------------------------------
 */

import { sanitizeForDisplay } from "./why-redaction.ts";

// Re-exported for callers importing these from why-diagnosis.ts before the
// redaction-utilities split (reviewer LOW). Canonical home: why-redaction.ts.
export { sanitizeFreeText, truncateForDisplay, sanitizeForDisplay } from "./why-redaction.ts";

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

function resolveEvidenceValue(tagged: TaggedEvidenceValue): EvidenceScalar {
  if (tagged.provenance === "structured") return tagged.value;
  if (Array.isArray(tagged.value)) return tagged.value.map((v) => sanitizeForDisplay(v));
  return sanitizeForDisplay(String(tagged.value));
}

/**
 * The ONLY constructor for `StallCauseEvidence` (round-4 reviewer/gate LOW:
 * type-enforce the choke point). Every value must arrive tagged via
 * `structured()` or `freeText()` — there is no way to pass a raw string and
 * have it silently skip redaction, because there is no other way to obtain a
 * value typed `StallCauseEvidence` at all (see the `EVIDENCE_BRAND` comment
 * above). `source` is a code-owned literal (a table/file-path constant) and
 * is never itself tagged — there is nothing external in it to redact.
 */
function buildEvidence(source: string, values: Record<string, TaggedEvidenceValue>): StallCauseEvidence {
  const resolved: Record<string, EvidenceScalar> = {};
  for (const [key, tagged] of Object.entries(values)) {
    resolved[key] = resolveEvidenceValue(tagged);
  }
  return { [EVIDENCE_BRAND]: true, source, values: resolved } as StallCauseEvidence;
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

  // 1. Integrity contradictions (rank 10). `contradictions` is tagged
  // freeText: it is a diagnostic diff description that can quote arbitrary
  // internal-state field values (e.g. a task title), not a fixed vocabulary
  // this module controls.
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
      evidence: buildEvidence("project_runtime_state vs .archon/work exports", {
        contradictions: freeText(signals.integrity.contradictions)
      }),
      nextCommand: "npx tsx ./src/admin.ts reconcile-runtime-state --apply"
    });
  }

  // 2. Task explicitly blocked/failed (rank 12) — CRITICAL fix: a task sitting
  // in `status: blocked` is the single most common real stall and MUST be
  // surfaced, not silently passed over as "handled above". `reasons` is
  // freeText — it is a seedFailure.reason, a caught Error.message.
  const blockedInScope = (signals.blockedTasks ?? []).filter((b) => inScope(signals, b.taskId));
  if (blockedInScope.length > 0) {
    causes.push({
      id: "task_blocked",
      rank: STALL_CAUSE_RANKS.task_blocked,
      advisory: false,
      what:
        "A task explicitly failed and is sitting in the `blocked` status — it will not resume on its own without operator recovery.",
      evidence: buildEvidence(
        "tasks.status = blocked (project_runtime_state seed-failure metadata when it matches)",
        {
          tasks: structured(blockedInScope.map((b) => b.taskId)),
          reasons: freeText(blockedInScope.map((b) => b.reason))
        }
      ),
      nextCommand:
        "npx tsx ./src/admin.ts recover --apply-safe (then re-check status; escalate to the task owner if recovery does not resolve it)"
    });
  }

  // 3. Task stuck in review with named blocking reviews (rank 14) — CRITICAL
  // fix: `review_blocked` is the other status the old ranker never reported.
  // `blockers` is structured: evaluateReviewDecision only ever emits fixed
  // template strings built from role names, not external free text.
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
      evidence: buildEvidence("reviews table (evaluateReviewDecision, per review_blocked task)", {
        tasks: structured(reviewBlockedInScope.map((b) => b.taskId)),
        blockers: structured(allBlockers)
      }),
      nextCommand:
        "run the review-orchestrator flow for the listed role(s), then re-check with `npx tsx ./src/admin.ts status`"
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
      evidence: buildEvidence("tasks table (duplicate task_key with sealed twin)", {
        taskKeys: structured(dupInScope.map((g) => g.taskKey)),
        runIds: structured(dupInScope.flatMap((g) => g.runIds))
      }),
      nextCommand: "npx tsx ./src/admin.ts prune-orphans --confirm"
    });
  }

  // 5. Missing review / approval gates (rank 20 / 25). Signals are consumed
  // from `planRunClosure`'s `plan.blocked` in the collector — this ranker only
  // renders the typed detail, it does not re-derive the blocking predicate.
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
      evidence: buildEvidence("reviews table (per approved task)", {
        tasks: structured(reviewBlocks.map((b) => b.taskId)),
        missingRoles: structured(roles)
      }),
      nextCommand:
        "run the review-orchestrator flow for the missing role(s), then `npx tsx ./src/admin.ts close-run --confirm`"
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
      evidence: buildEvidence("approvals table (per approved task)", {
        tasks: structured(approvalBlocks.map((b) => b.taskId))
      }),
      nextCommand:
        "record the orchestrator approval via the review-orchestrator flow, then `npx tsx ./src/admin.ts close-run --confirm`"
    });
  }

  // 6. Council gate (rank 30). `outcomes` is structured: a council outcome is
  // always one of a fixed set of orchestrator-recorded tokens (or "unset"),
  // never free text.
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
      evidence: buildEvidence("tasks.packet.councilOutcome", {
        tasks: structured(councilBlocks.map((g) => g.taskId)),
        outcomes: structured(councilBlocks.map((g) => g.outcome ?? "unset"))
      }),
      nextCommand:
        "npx tsx ./src/admin.ts record-council --task-id <id> --outcome <approved|approved_with_conditions|exception_granted> --source orchestrator"
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
      evidence: buildEvidence("tasks.packet.retroOutcome (none recorded)", {
        runId: structured(signals.run?.id ?? "unknown"),
        tasks: structured(signals.sealReadyTaskIds ?? [])
      }),
      nextCommand:
        "npx tsx ./src/admin.ts record-retro --task-id <id> --outcome <memory_promoted|skill_patched|discarded|postmortem_filed|nothing_to_promote> --source orchestrator"
    });
  }

  // 8. Respawn lease / budget (rank 50 / 55). `owner` is tagged freeText —
  // the lease-owner identity string is written by whatever process/version
  // acquired the lock file, not a value this module controls.
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
        evidence: buildEvidence(".archon/work/daemon/respawn-lease-<runId>.lock", {
          owner: freeText(respawn.leaseOwner ?? "unknown")
        }),
        nextCommand:
          "wait for the lease to expire (5 min stale window) or `npx tsx ./src/admin.ts recover --apply-safe`"
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
        evidence: buildEvidence("project_runtime_state.metadata.archonDaemon", {
          taskId: structured(respawn.taskId),
          count: structured(respawn.count),
          budget: structured(respawn.budget)
        }),
        nextCommand:
          "resolve the underlying blocker then `npx tsx ./src/admin.ts recover --apply-safe`, or raise ARCHON_MAX_RESPAWNS_PER_TASK if the task genuinely needs more"
      });
    }
  }

  // 9. Sidecar blockers (rank 60-75). Each is present only when the sidecar
  // file existed and parsed — an absent file leaves the field undefined
  // (tolerated). hook-blocker command/summary are the canonical freeText
  // case: a recorded failed shell command and its stdout/stderr-derived
  // summary can contain literally anything, including a credential the
  // command itself embedded. `buildEvidence` redacts-then-truncates them via
  // `freeText()` — no local pre-processing needed.
  const hookBlocker = signals.sidecars.hookBlocker;
  if (hookBlocker && inScope(signals, hookBlocker.taskId)) {
    const safeCommand = sanitizeForDisplay(hookBlocker.command);
    causes.push({
      id: "hook_blocker",
      rank: STALL_CAUSE_RANKS.hook_blocker,
      advisory: false,
      what:
        "A command failed and the hook recorded a blocker that stays in force until the same command is re-run and passes.",
      evidence: buildEvidence(".archon/work/daemon/hook-blocker-state.json", {
        blockerKind: structured(hookBlocker.blockerKind),
        command: freeText(hookBlocker.command),
        summary: freeText(hookBlocker.summary),
        ...(hookBlocker.recordedAt ? { recordedAt: structured(hookBlocker.recordedAt) } : {})
      }),
      // nextCommand never embeds the raw recorded command directly — it
      // points at the (redacted, in evidence.values.command above) preview
      // and the sidecar file for the full original, so there is only ever
      // ONE place this text is rendered, not two independently-sanitized
      // copies that could drift.
      nextCommand:
        safeCommand.trim().length > 0
          ? "re-run the failed command shown in this cause's evidence (full record: .archon/work/daemon/hook-blocker-state.json)"
          : "re-run the failed command recorded in .archon/work/daemon/hook-blocker-state.json"
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
      evidence: buildEvidence(".archon/work/context-guard.json", {
        state: structured(contextGuard.state),
        invocationId: structured(contextGuard.invocationId)
      }),
      nextCommand: "npx tsx ./src/admin.ts continue-session"
    });
  }

  // HIGH fix (round 1): join the FULL nextActions array, not just the first
  // entry. `reason` and each `nextActions` entry are freeText — sourced from
  // a sidecar JSON file the daemon writes, which is less trusted than an
  // in-memory computed value (a future daemon bug could append raw error
  // text into either field, and this module has no way to audit that).
  const daemonHandoff = signals.sidecars.daemonHandoff;
  if (daemonHandoff) {
    const safeNextActions = daemonHandoff.nextActions.map((step) => sanitizeForDisplay(step));
    causes.push({
      id: "daemon_handoff_blocked",
      rank: STALL_CAUSE_RANKS.daemon_handoff_blocked,
      advisory: false,
      what:
        "The daemon wrote an operator-handoff record: it hit a point in the loop it cannot pass without operator action.",
      evidence: buildEvidence(".archon/work/daemon/operator-handoff.json", {
        blockerKind: structured(daemonHandoff.blockerKind ?? "unknown"),
        reason: freeText(daemonHandoff.reason)
      }),
      nextCommand: joinNextActions(
        safeNextActions,
        "follow the operator-handoff nextActions in `npx tsx ./src/admin.ts status`"
      )
    });
  }

  // LOW fix (round 1): also cover max_cycles_reached and invalid states, not
  // just "blocked" — both are non-terminal-success states the supervisor
  // stopped in without completing the loop.
  const daemonSupervisor = signals.sidecars.daemonSupervisor;
  if (daemonSupervisor && daemonSupervisor.state !== "completed") {
    const safeNextActions = daemonSupervisor.nextActions.map((step) => sanitizeForDisplay(step));
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
      evidence: buildEvidence(".archon/work/daemon/supervisor-status.json", {
        state: structured(daemonSupervisor.state),
        blockerKind: structured(daemonSupervisor.blockerKind ?? "unknown"),
        reason: freeText(daemonSupervisor.reason)
      }),
      nextCommand: joinNextActions(
        safeNextActions,
        "follow the supervisor nextActions in `npx tsx ./src/admin.ts status`"
      )
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
        evidence: buildEvidence("run execution plan directive", {
          directive: structured(ownerWork.directiveKind),
          tasks: structured(ownerTasks)
        }),
        nextCommand:
          "dispatch the task owner (this is normal in-flight work, not a stall)"
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
