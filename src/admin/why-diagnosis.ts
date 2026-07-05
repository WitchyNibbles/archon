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
 * ---------------------------------------------------------------------------
 */

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

export interface StallCauseEvidence {
  /** File path or DB table the signal came from. */
  source: string;
  /** Key values a human can verify against that source. */
  values: Record<string, string | number | boolean | string[]>;
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
// Secret redaction — security control for the hook-blocker sidecar (audit F9
// review, MEDIUM/security). hook-blocker-state.json records the raw failed
// command plus a stdout/stderr-derived summary; an inline credential in either
// would otherwise be reprinted verbatim on every `archon why` call, in BOTH
// the human and --json output. Applied once here (not in the collector) so
// every emission path is scrubbed. Mirrors the redact-don't-guess posture of
// admin/db-error-scrub.ts's scrubPgCredentials.
// ---------------------------------------------------------------------------

const MAX_COMMAND_DISPLAY_LENGTH = 120;

/**
 * Redacts secret-shaped substrings from hook-blocker text: labeled key=value /
 * key: value credential fields, `Authorization:` headers, `Bearer` tokens, and
 * (fallback, coverage over precision) long opaque alnum/base64-ish runs that
 * look like an issued token rather than a word or path segment.
 */
export function redactSecretLikeSubstrings(text: string): string {
  let result = text;
  // Labeled credential fields: token=/secret=/password=/api_key=/access_key=/
  // auth=, with "=" or ":" separators, in any case.
  result = result.replace(
    /\b(token|secret|password|api[_-]?key|access[_-]?key|auth)(\s*[:=]\s*)[^\s"'`]+/gi,
    "$1$2[redacted]"
  );
  // Authorization headers (value may be "Bearer xyz" or a bare token).
  // Token components exclude quote/backtick characters so a shell-quoted
  // header (`"Authorization: Bearer xyz"`) redacts cleanly without swallowing
  // the closing quote into the replacement.
  result = result.replace(
    /\bAuthorization:\s*[^\s"'`]+(?:\s+[^\s"'`]+)?/gi,
    "Authorization: [redacted]"
  );
  // Bearer tokens outside an Authorization header.
  result = result.replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [redacted]");
  // Fallback: long opaque token-shaped runs (>= 24 chars, alnum + common token
  // punctuation). Errs toward over-redaction — a truncated, already-scoped
  // display string is the trade-off accepted here, not exact evidence fidelity.
  result = result.replace(/\b[A-Za-z0-9_\-+/]{24,}={0,2}\b/g, "[redacted]");
  return result;
}

/** Truncates text to a safe display prefix, with an explicit ellipsis marker
 * when truncation occurred (never silently drops characters unmarked). */
export function truncateForDisplay(text: string, maxLength = MAX_COMMAND_DISPLAY_LENGTH): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/** Applies redaction then truncation — the combined safe-display transform
 * used for both the hook-blocker `command` and `summary` fields. */
function sanitizeForDisplay(text: string): string {
  return truncateForDisplay(redactSecretLikeSubstrings(text));
}

// ---------------------------------------------------------------------------
// Ranker — pure. Given signals, emit ranked causes.
// ---------------------------------------------------------------------------

function inScope(signals: StallSignals, taskId: string | undefined): boolean {
  const focus = signals.scope.taskId;
  if (!focus) return true;
  return taskId === focus;
}

export function diagnoseStall(signals: StallSignals): StallDiagnosis {
  const causes: StallCause[] = [];
  const focusTask = signals.scope.taskId;

  // 1. Integrity contradictions (rank 10).
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
      evidence: {
        source: "project_runtime_state vs .archon/work exports",
        values: { contradictions: signals.integrity.contradictions }
      },
      nextCommand: "npx tsx ./src/admin.ts reconcile-runtime-state --apply"
    });
  }

  // 2. Task explicitly blocked/failed (rank 12) — CRITICAL fix: a task sitting
  // in `status: blocked` is the single most common real stall and MUST be
  // surfaced, not silently passed over as "handled above".
  const blockedInScope = (signals.blockedTasks ?? []).filter((b) => inScope(signals, b.taskId));
  if (blockedInScope.length > 0) {
    causes.push({
      id: "task_blocked",
      rank: STALL_CAUSE_RANKS.task_blocked,
      advisory: false,
      what:
        "A task explicitly failed and is sitting in the `blocked` status — it will not resume on its own without operator recovery.",
      evidence: {
        source: "tasks.status = blocked (project_runtime_state seed-failure metadata when it matches)",
        values: {
          tasks: blockedInScope.map((b) => b.taskId),
          reasons: blockedInScope.map((b) => b.reason)
        }
      },
      nextCommand:
        "npx tsx ./src/admin.ts recover --apply-safe (then re-check status; escalate to the task owner if recovery does not resolve it)"
    });
  }

  // 3. Task stuck in review with named blocking reviews (rank 14) — CRITICAL
  // fix: `review_blocked` is the other status the old ranker never reported.
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
      evidence: {
        source: "reviews table (evaluateReviewDecision, per review_blocked task)",
        values: {
          tasks: reviewBlockedInScope.map((b) => b.taskId),
          blockers: allBlockers
        }
      },
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
      evidence: {
        source: "tasks table (duplicate task_key with sealed twin)",
        values: {
          taskKeys: dupInScope.map((g) => g.taskKey),
          runIds: dupInScope.flatMap((g) => g.runIds)
        }
      },
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
      evidence: {
        source: "reviews table (per approved task)",
        values: {
          tasks: reviewBlocks.map((b) => b.taskId),
          missingRoles: roles
        }
      },
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
      evidence: {
        source: "approvals table (per approved task)",
        values: { tasks: approvalBlocks.map((b) => b.taskId) }
      },
      nextCommand:
        "record the orchestrator approval via the review-orchestrator flow, then `npx tsx ./src/admin.ts close-run --confirm`"
    });
  }

  // 6. Council gate (rank 30).
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
      evidence: {
        source: "tasks.packet.councilOutcome",
        values: {
          tasks: councilBlocks.map((g) => g.taskId),
          outcomes: councilBlocks.map((g) => g.outcome ?? "unset")
        }
      },
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
      evidence: {
        source: "tasks.packet.retroOutcome (none recorded)",
        values: {
          runId: signals.run?.id ?? "unknown",
          tasks: signals.sealReadyTaskIds ?? []
        }
      },
      nextCommand:
        "npx tsx ./src/admin.ts record-retro --task-id <id> --outcome <memory_promoted|skill_patched|discarded|postmortem_filed|nothing_to_promote> --source orchestrator"
    });
  }

  // 8. Respawn lease / budget (rank 50 / 55).
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
        evidence: {
          source: ".archon/work/daemon/respawn-lease-<runId>.lock",
          values: { owner: respawn.leaseOwner ?? "unknown" }
        },
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
        evidence: {
          source: "project_runtime_state.metadata.archonDaemon",
          values: {
            taskId: respawn.taskId,
            count: respawn.count,
            budget: respawn.budget
          }
        },
        nextCommand:
          "resolve the underlying blocker then `npx tsx ./src/admin.ts recover --apply-safe`, or raise ARCHON_MAX_RESPAWNS_PER_TASK if the task genuinely needs more"
      });
    }
  }

  // 9. Sidecar blockers (rank 60-75). Each is present only when the sidecar
  // file existed and parsed — an absent file leaves the field undefined
  // (tolerated). hook-blocker command/summary are sanitized before display:
  // secret-shaped substrings redacted, then truncated to a safe prefix with a
  // pointer to the sidecar file for the untruncated (still-scrubbed-at-source)
  // record — never reprint the raw recorded command/summary verbatim.
  const hookBlocker = signals.sidecars.hookBlocker;
  if (hookBlocker && inScope(signals, hookBlocker.taskId)) {
    const safeCommand = sanitizeForDisplay(hookBlocker.command);
    const safeSummary = sanitizeForDisplay(hookBlocker.summary);
    causes.push({
      id: "hook_blocker",
      rank: STALL_CAUSE_RANKS.hook_blocker,
      advisory: false,
      what:
        "A command failed and the hook recorded a blocker that stays in force until the same command is re-run and passes.",
      evidence: {
        source: ".archon/work/daemon/hook-blocker-state.json",
        values: {
          blockerKind: hookBlocker.blockerKind,
          command: safeCommand,
          summary: safeSummary,
          ...(hookBlocker.recordedAt ? { recordedAt: hookBlocker.recordedAt } : {})
        }
      },
      nextCommand:
        safeCommand.trim().length > 0
          ? `re-run the failed command (see .archon/work/daemon/hook-blocker-state.json for the full recorded command): ${safeCommand}`
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
      evidence: {
        source: ".archon/work/context-guard.json",
        values: {
          state: contextGuard.state,
          invocationId: contextGuard.invocationId
        }
      },
      nextCommand: "npx tsx ./src/admin.ts continue-session"
    });
  }

  // HIGH fix: join the FULL nextActions array, not just the first entry —
  // proven against a real 2-step array in runtime.ts's preflight nextActions
  // (`npm run archon:doctor -- --repair` then `npm run archon:reconcile`).
  // Truncating to [0] silently drops later steps.
  const daemonHandoff = signals.sidecars.daemonHandoff;
  if (daemonHandoff) {
    causes.push({
      id: "daemon_handoff_blocked",
      rank: STALL_CAUSE_RANKS.daemon_handoff_blocked,
      advisory: false,
      what:
        "The daemon wrote an operator-handoff record: it hit a point in the loop it cannot pass without operator action.",
      evidence: {
        source: ".archon/work/daemon/operator-handoff.json",
        values: {
          blockerKind: daemonHandoff.blockerKind ?? "unknown",
          reason: daemonHandoff.reason
        }
      },
      nextCommand: joinNextActions(
        daemonHandoff.nextActions,
        "follow the operator-handoff nextActions in `npx tsx ./src/admin.ts status`"
      )
    });
  }

  // LOW fix: also cover max_cycles_reached and invalid states, not just
  // "blocked" — both are non-terminal-success states the supervisor stopped
  // in without completing the loop.
  const daemonSupervisor = signals.sidecars.daemonSupervisor;
  if (daemonSupervisor && daemonSupervisor.state !== "completed") {
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
      evidence: {
        source: ".archon/work/daemon/supervisor-status.json",
        values: {
          state: daemonSupervisor.state,
          blockerKind: daemonSupervisor.blockerKind ?? "unknown",
          reason: daemonSupervisor.reason
        }
      },
      nextCommand: joinNextActions(
        daemonSupervisor.nextActions,
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
        evidence: {
          source: "run execution plan directive",
          values: { directive: ownerWork.directiveKind, tasks: ownerTasks }
        },
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
