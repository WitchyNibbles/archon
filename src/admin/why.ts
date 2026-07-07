/**
 * @module admin/why
 *
 * `archon why [--task-id <id>] [--run-id <id>]` — the stall-cause aggregator
 * (audit F9). Answers "why is this stuck?" in one ranked, plain-language
 * explanation instead of forcing the operator (or the runtime-medic agent) to
 * correlate five sidecar files and two DB tables by hand.
 *
 * Split of responsibility:
 *   - why-diagnosis.ts owns the PURE ranking/explanation layer (`diagnoseStall`).
 *   - THIS module owns only IO: it resolves the run, REUSES existing surfaces
 *     for every raw signal (status report, closure reconciler, respawn budget,
 *     orphan finder, sidecar files), normalizes them into `StallSignals`, and
 *     renders. No new stall-detection logic lives here — only collection.
 *   - `runWhyDiagnosis` is the fully-injected, `withClient`-independent
 *     orchestration function (testable without a real DB); `whyCommand` is the
 *     thin `withClient` wrapper that wires real store/service/sidecar deps and
 *     calls it.
 *
 * Reused surfaces (no reimplementation):
 *   - executeStatusCommandFromArgs → integrity contradictions, daemon
 *     operator-handoff + supervisor observations, run/task counts.
 *   - buildTaskEvidence / planRunClosure (closure-reconciler) → the SINGLE
 *     source of truth for which approved tasks are closure-blocked
 *     (`plan.blocked`); this module only attaches the typed missing-role /
 *     missing-approval detail per blocked task, it does not re-derive the
 *     blocking predicate.
 *   - evaluateReviewDecision (core/policy.ts) → which reviews block a
 *     review_blocked task.
 *   - RETRO_OUTCOME_TOKENS (record-retro) → retro seal-gate state.
 *   - resolveRespawnBudget + makeFileLockLeaseStore → respawn budget + lease.
 *   - findOrphanCandidates + fetchAllTasks/fetchReviewCounts/fetchApprovalCounts
 *     (prune-orphans) → duplicate/orphan runs per task_key, using prune-orphans'
 *     own query helpers rather than a second copy of the same SQL.
 *
 * Human output is the default and reads like a colleague explaining; `--json`
 * emits the structured `StallDiagnosis`.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Client as PgClient } from "pg";

import { withClient } from "./db.ts";
import { PostgresStore } from "../store/postgres-store.ts";
import { ArchonCoreService } from "../core/service.ts";
import { executeStatusCommandFromArgs } from "../workflow.ts";
import { resolveCommandFlag } from "../cli-flags.ts";
import type { OperatorStatusReport } from "./status.ts";
import { evaluateReviewDecision } from "../core/policy.ts";
import {
  buildTaskEvidence,
  planRunClosure,
  type ClosureTaskEvidence
} from "../core/closure-reconciler.ts";
import { RETRO_OUTCOME_TOKENS } from "./record-retro.ts";
import { resolveRespawnBudget } from "../runtime/respawn-budget.ts";
import { makeFileLockLeaseStore } from "../runtime/respawn-lease.ts";
import {
  findOrphanCandidates,
  fetchAllTasks,
  fetchReviewCounts,
  fetchApprovalCounts,
  type SqlClient,
  type TaskRow,
  type ReviewCount,
  type ApprovalCount
} from "./prune-orphans.ts";
import type {
  ApprovalRecord,
  ProjectRuntimeStateRecord,
  ReviewFloorReductionRecord,
  ReviewRecord,
  RunExecutionPlan,
  RunStatusSnapshot
} from "../domain/types.ts";
import { councilApprovedOutcomes, hookBlockerKinds } from "../domain/types.ts";
import { CONTEXT_GUARD_STATES } from "../runtime/interactive-parachute.ts";
import { validateEnumMember, validateIsoTimestamp, validateUuid } from "./why-sidecar-validation.ts";
import {
  diagnoseStall,
  formatStallDiagnosis,
  serializeStallDiagnosis,
  type BlockedTaskSignal,
  type ClosureBlockSignal,
  type CouncilGateSignal,
  type ReviewBlockedTaskSignal,
  type StallDiagnosis,
  type StallSignals
} from "./why-diagnosis.ts";

export { diagnoseStall, formatStallDiagnosis } from "./why-diagnosis.ts";

// Council outcomes that satisfy the Design & Architecture Council gate. Mirrors
// APPROVED_COUNCIL_OUTCOMES in .claude/hooks/hook-policy.mjs — kept in lockstep
// with the Stop-hook gate so `why` never claims a council block the hook would
// not, and vice-versa. Exported so a parity test can cross-check the two sets
// directly (audit F9 review, MEDIUM x2: this table needs a machine cross-check,
// not just a comment promising lockstep — see tests/admin-why-council-parity.test.ts).
// The underlying token list is domain/types.ts's `councilApprovedOutcomes` —
// SINGLE source shared with why-diagnosis.ts's redaction vocabulary (round-5
// gate finding 1: "import them, don't retype").
export const APPROVED_COUNCIL_OUTCOMES = new Set<string>(councilApprovedOutcomes);

// ---------------------------------------------------------------------------
// Collector deps — all IO injected so collectStallSignals is testable against
// store doubles + fixture sidecar readers.
// ---------------------------------------------------------------------------

export interface WhyCollectDeps {
  now: string;
  scope: { runId?: string | undefined; taskId?: string | undefined };
  /** Already-assembled operator status report (reused, not recomputed). */
  report: OperatorStatusReport;
  snapshot: RunStatusSnapshot;
  runtimeState?: ProjectRuntimeStateRecord | undefined;
  getReviews: (runId: string, taskId: string) => Promise<ReviewRecord[]>;
  getApprovals: (runId: string, taskId: string) => Promise<ApprovalRecord[]>;
  getReviewFloorReductions: (runId: string, taskId: string) => Promise<ReviewFloorReductionRecord[]>;
  /** Current respawn-lease owner for the run, or undefined when none/expired. */
  readLeaseOwner: (runId: string) => Promise<string | undefined>;
  /** Per-task respawn budget (ARCHON_MAX_RESPAWNS_PER_TASK). */
  respawnBudget: number;
  /** Raw rows for the orphan/duplicate-run detector (reuses findOrphanCandidates). */
  getOrphanInputs: () => Promise<{
    tasks: TaskRow[];
    reviewCounts: ReviewCount[];
    approvalCounts: ApprovalCount[];
  }>;
  /** Read the interactive context-guard sidecar, or undefined if absent. */
  readContextGuard: () => Promise<StallSignals["sidecars"]["contextGuard"]>;
  /** Read the hook-blocker sidecar, or undefined if absent. */
  readHookBlocker: () => Promise<StallSignals["sidecars"]["hookBlocker"]>;
}

// ---------------------------------------------------------------------------
// Collector — normalize every raw signal into StallSignals. PURE ranking is
// deferred to diagnoseStall; this only gathers + shapes.
// ---------------------------------------------------------------------------

export async function collectStallSignals(deps: WhyCollectDeps): Promise<StallSignals> {
  const { snapshot, report } = deps;

  // --- Per-task evidence, council gate, and the two CRITICAL fixes: tasks
  // sitting in `blocked` (failed) or `review_blocked` (waiting on review) must
  // be surfaced — they are the most common REAL stall, not "handled above". ---
  const evidence: ClosureTaskEvidence[] = [];
  const councilGates: CouncilGateSignal[] = [];
  const blockedTasks: BlockedTaskSignal[] = [];
  const reviewBlockedTasks: ReviewBlockedTaskSignal[] = [];
  const seedFailure = report.integrity.runtimeState?.seedFailure;

  for (const task of snapshot.tasks) {
    const taskId = task.packet.taskId;
    const [reviews, approvals, reductions] = await Promise.all([
      deps.getReviews(snapshot.run.id, taskId),
      deps.getApprovals(snapshot.run.id, taskId),
      deps.getReviewFloorReductions(snapshot.run.id, taskId)
    ]);
    evidence.push(buildTaskEvidence(task, reviews, approvals, reductions));

    if (task.status === "blocked") {
      const reason =
        seedFailure && seedFailure.taskId === taskId
          ? seedFailure.reason
          : "task failed and was marked blocked (no seed-failure metadata recorded for this task — check the task's last handoff or run history for detail)";
      blockedTasks.push({ taskId, reason });
    }

    if (task.status === "review_blocked") {
      // Reuse the SAME predicate the review gate itself uses — no re-derivation.
      const { blockers } = evaluateReviewDecision(task, reviews);
      if (blockers.length > 0) {
        reviewBlockedTasks.push({ taskId, blockers: [...blockers] });
      }
    }

    const councilRequired = task.packet.qualityGates.some(
      (gate) => gate === "council_review_required"
    );
    if (councilRequired) {
      const outcome = task.packet.councilOutcome;
      if (!outcome || !APPROVED_COUNCIL_OUTCOMES.has(outcome)) {
        councilGates.push({ taskId, outcome });
      }
    }
  }

  // MEDIUM fix: consume `plan.blocked` — planRunClosure's single source of
  // truth for "is this approved task closure-blocked" — instead of
  // re-deriving the same missing-role/missing-approval predicate a second
  // time in this loop. Only the typed detail (which roles, which kind) is
  // attached here, keyed off the evidence already computed above.
  const plan = planRunClosure(evidence);
  const evidenceByTaskId = new Map(evidence.map((e) => [e.taskId, e]));
  const closureBlocks: ClosureBlockSignal[] = plan.blocked.map((block) => {
    const taskEvidence = evidenceByTaskId.get(block.taskId);
    const missingRoles = taskEvidence
      ? taskEvidence.requiredFloor.filter(
          (role) => !taskEvidence.passedOrchestratorRoles.includes(role)
        )
      : [];
    return missingRoles.length > 0
      ? { taskId: block.taskId, kind: "missing_review", missingRoles: [...missingRoles] }
      : { taskId: block.taskId, kind: "missing_approval", missingRoles: [] };
  });

  const hasRetro = snapshot.tasks.some((task) => {
    const outcome = task.packet.retroOutcome;
    return typeof outcome === "string" && RETRO_OUTCOME_TOKENS.has(outcome);
  });
  const retroSealBlocked = plan.sealRun && !hasRetro;
  // LOW fix: give the retro-gate cause concrete task-id evidence, not just the
  // run id — plan.sealRun means every task in the snapshot is terminal.
  const sealReadyTaskIds = retroSealBlocked ? snapshot.tasks.map((t) => t.packet.taskId) : undefined;

  // --- Respawn lease + budget. ---
  const daemonMeta = deps.runtimeState?.metadata.archonDaemon;
  const respawnTaskId = daemonMeta?.respawnTaskId;
  const activeTaskId = deps.runtimeState?.activeTaskId;
  const storedCount = typeof daemonMeta?.respawnCount === "number" ? daemonMeta.respawnCount : 0;
  // Counter is only meaningful when scoped to the current active task (matches
  // the daemon's effectiveRespawnCount logic in codex-turn.ts).
  const effectiveCount = respawnTaskId !== undefined && respawnTaskId === activeTaskId ? storedCount : 0;
  const leaseOwner = await deps.readLeaseOwner(snapshot.run.id);
  const respawn: StallSignals["respawn"] = {
    taskId: respawnTaskId ?? activeTaskId,
    count: effectiveCount,
    budget: deps.respawnBudget,
    leaseHeld: leaseOwner !== undefined,
    leaseOwner
  };

  // --- Orphan / duplicate runs for the active task_key (reuse the vetted
  //     findOrphanCandidates safety logic; group survivors by task_key). ---
  const orphanInputs = await deps.getOrphanInputs();
  const orphanPlan = findOrphanCandidates(
    orphanInputs.tasks,
    orphanInputs.reviewCounts,
    orphanInputs.approvalCounts
  );
  const duplicateByKey = new Map<string, Set<string>>();
  for (const candidate of orphanPlan.candidates) {
    const set = duplicateByKey.get(candidate.task_key) ?? new Set<string>();
    set.add(candidate.run_id);
    duplicateByKey.set(candidate.task_key, set);
  }
  const duplicateRuns = [...duplicateByKey.entries()].map(([taskKey, runIds]) => ({
    taskKey,
    runIds: [...runIds]
  }));

  // --- Owner work in flight (advisory). ready/in_progress = normal work, not a
  //     stall. review_blocked/blocked/approved are handled above. ---
  const ownerTaskIds = snapshot.tasks
    .filter((task) => task.status === "ready" || task.status === "in_progress")
    .map((task) => task.packet.taskId);
  const ownerWork = ownerTaskIds.length > 0
    ? { directiveKind: "dispatch_owner", taskIds: ownerTaskIds }
    : undefined;

  // --- Sidecars: daemon handoff + supervisor come from the reused status
  //     report; hook-blocker + context-guard are read directly (tolerate absence). ---
  const handoff = report.daemon.handoff;
  const supervisor = report.daemon.supervisor;
  const [contextGuard, hookBlocker] = await Promise.all([
    deps.readContextGuard(),
    deps.readHookBlocker()
  ]);

  return {
    now: deps.now,
    scope: deps.scope,
    run: { id: snapshot.run.id, status: snapshot.run.status },
    taskCounts: report.run.taskCounts,
    integrity: {
      status: report.integrity.status,
      contradictions: [...report.integrity.contradictions]
    },
    blockedTasks: blockedTasks.length > 0 ? blockedTasks : undefined,
    reviewBlockedTasks: reviewBlockedTasks.length > 0 ? reviewBlockedTasks : undefined,
    duplicateRuns: duplicateRuns.length > 0 ? duplicateRuns : undefined,
    closureBlocks: closureBlocks.length > 0 ? closureBlocks : undefined,
    retroSealBlocked,
    sealReadyTaskIds,
    councilGates: councilGates.length > 0 ? councilGates : undefined,
    respawn,
    ownerWork,
    sidecars: {
      hookBlocker,
      contextGuard,
      daemonHandoff: handoff
        ? {
            state: handoff.state,
            blockerKind: handoff.blockerKind,
            reason: handoff.reason,
            nextActions: [...handoff.nextActions]
          }
        : undefined,
      daemonSupervisor: supervisor
        ? {
            state: supervisor.state,
            blockerKind: supervisor.blockerKind,
            reason: supervisor.reason,
            nextActions: [...supervisor.nextActions]
          }
        : undefined
    }
  };
}

// ---------------------------------------------------------------------------
// Sidecar readers — direct fs, tolerate absence (audit F9: "read-only, tolerate
// absence; cite only real files").
// ---------------------------------------------------------------------------

async function readJsonSidecar(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Round-14 CRITICAL fix: state/blockerKind/recordedAt/invocationId are now
// validated at READ time (enum membership / ISO-timestamp round-trip / UUID
// shape — why-sidecar-validation.ts), not trusted from a bare non-empty-
// string check. A sidecar is an attacker-shapeable file on disk; these
// fields feed why-vocabulary.ts's buildKnownVocabulary unconditionally, so
// an unvalidated value could become globally trusted vocabulary. Required
// fields (state, invocationId, blockerKind) drop the WHOLE sidecar entry on
// failure, same as a missing field always has; the optional `recordedAt`
// simply omits itself.

export async function readContextGuardSidecar(
  cwd: string
): Promise<StallSignals["sidecars"]["contextGuard"]> {
  const parsed = await readJsonSidecar(path.join(cwd, ".archon", "work", "context-guard.json"));
  if (!parsed) return undefined;
  const state = validateEnumMember(str(parsed.state), CONTEXT_GUARD_STATES);
  const taskId = str(parsed.taskId);
  const invocationId = validateUuid(str(parsed.invocationId));
  if (!state || !taskId || !invocationId) return undefined;
  return { state, taskId, invocationId };
}

export async function readHookBlockerSidecar(
  cwd: string
): Promise<StallSignals["sidecars"]["hookBlocker"]> {
  const parsed = await readJsonSidecar(
    path.join(cwd, ".archon", "work", "daemon", "hook-blocker-state.json")
  );
  if (!parsed) return undefined;
  const taskId = str(parsed.activeTaskId);
  const blockerKind = validateEnumMember(str(parsed.blockerKind), hookBlockerKinds);
  const summary = str(parsed.summary);
  if (!taskId || !blockerKind || !summary) return undefined;
  return {
    taskId,
    blockerKind,
    command: str(parsed.command) ?? "",
    summary,
    recordedAt: validateIsoTimestamp(str(parsed.recordedAt))
  };
}

// ---------------------------------------------------------------------------
// runWhyDiagnosis — fully-injected orchestration, no `withClient` dependency.
// This is what makes the entrypoint testable (QA finding: whyCommand
// entrypoint coverage) — every DB/fs call is a parameter, so tests exercise
// the --json passthrough, the no-run healthy fallback, and the full signal
// wiring without a real database.
// ---------------------------------------------------------------------------

export interface RunWhyDiagnosisDeps {
  cwd: string;
  now: string;
  env?: NodeJS.ProcessEnv | undefined;
  findLatestRun: (workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  getExecutionPlan: (runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>;
  getReviews: WhyCollectDeps["getReviews"];
  getApprovals: WhyCollectDeps["getApprovals"];
  getReviewFloorReductions: WhyCollectDeps["getReviewFloorReductions"];
  readLeaseOwner: WhyCollectDeps["readLeaseOwner"];
  respawnBudget: number;
  getOrphanInputs: WhyCollectDeps["getOrphanInputs"];
  readContextGuard: WhyCollectDeps["readContextGuard"];
  readHookBlocker: WhyCollectDeps["readHookBlocker"];
}

export async function runWhyDiagnosis(
  args: readonly string[],
  deps: RunWhyDiagnosisDeps
): Promise<StallDiagnosis> {
  const scope = {
    runId: resolveCommandFlag(args, "--run-id"),
    taskId: resolveCommandFlag(args, "--task-id")
  };

  // Reuse the status assembly for integrity + daemon observations + counts,
  // capturing the snapshot it fetches so we don't double-query.
  let snapshot: RunStatusSnapshot | undefined;
  let report: OperatorStatusReport;
  try {
    report = await executeStatusCommandFromArgs(args, {
      cwd: deps.cwd,
      env: deps.env,
      findLatestRun: deps.findLatestRun,
      async getStatusSnapshot(runId) {
        snapshot = await deps.getStatusSnapshot(runId);
        return snapshot;
      },
      getProjectRuntimeState: deps.getProjectRuntimeState,
      getExecutionPlan: deps.getExecutionPlan
    });
  } catch (error) {
    // No run resolvable → nothing is stuck (there is no loop). Emit the
    // healthy no-run diagnosis rather than an error.
    const message = error instanceof Error ? error.message : String(error);
    if (/No runs found|require --run-id/i.test(message)) {
      return diagnoseStall({ now: deps.now, scope, run: undefined, sidecars: {} });
    }
    throw error;
  }

  if (!snapshot) {
    snapshot = await deps.getStatusSnapshot(report.run.id);
  }
  const runtimeState = await deps.getProjectRuntimeState(snapshot.run.projectId);

  const signals = await collectStallSignals({
    now: deps.now,
    scope,
    report,
    snapshot,
    runtimeState,
    getReviews: deps.getReviews,
    getApprovals: deps.getApprovals,
    getReviewFloorReductions: deps.getReviewFloorReductions,
    readLeaseOwner: deps.readLeaseOwner,
    respawnBudget: deps.respawnBudget,
    getOrphanInputs: deps.getOrphanInputs,
    readContextGuard: deps.readContextGuard,
    readHookBlocker: deps.readHookBlocker
  });

  return diagnoseStall(signals);
}

// ---------------------------------------------------------------------------
// Safe SQL-client adapter (round-2 reviewer LOW). Wraps only the ONE PgClient
// method `why` actually needs (`query`) into the `SqlClient` shape
// prune-orphans' fetch helpers expect — the same adapter shape admin.ts
// already uses inline for the `prune-orphans` / `sweep-orphans` verbs. This
// replaces an unsafe whole-object cast (`client as unknown as SqlClient`),
// which asserted structural compatibility between `pg.Client` and `SqlClient`
// without the compiler ever checking it — a silent break if either type
// diverges. Exported so it is directly unit-testable against a minimal fake
// object satisfying only `{ query }`, not the full `pg.Client` surface.
// ---------------------------------------------------------------------------

export function makeSqlClientAdapter(client: Pick<PgClient, "query">): SqlClient {
  return {
    query: async (text, values) => {
      const result = await client.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    }
  };
}

// ---------------------------------------------------------------------------
// Command entrypoint — thin `withClient` wrapper around runWhyDiagnosis.
// ---------------------------------------------------------------------------

export async function whyCommand(args: readonly string[]): Promise<void> {
  const emitJson = args.includes("--json");
  const cwd = process.cwd();
  const now = new Date().toISOString();

  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const leaseStore = makeFileLockLeaseStore({
      lockDir: path.join(cwd, ".archon", "work", "daemon")
    });
    const sqlAdapter = makeSqlClientAdapter(client);

    const diagnosis = await runWhyDiagnosis(args, {
      cwd,
      now,
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      getReviews: (runId, taskId) => store.getReviews(runId, taskId),
      getApprovals: (runId, taskId) => store.getApprovals(runId, taskId),
      getReviewFloorReductions: (runId, taskId) => store.getReviewFloorReductions(runId, taskId),
      readLeaseOwner: (runId) => leaseStore.readOwner(runId),
      respawnBudget: resolveRespawnBudget(),
      async getOrphanInputs() {
        // .bind() extracts a plain function reference (not an unbound method
        // access) — same discipline the prune-orphans SqlClient["query"]
        // interface already requires elsewhere in this codebase.
        const [tasks, reviewCounts, approvalCounts] = await Promise.all([
          fetchAllTasks(sqlAdapter.query.bind(sqlAdapter)),
          fetchReviewCounts(sqlAdapter.query.bind(sqlAdapter)),
          fetchApprovalCounts(sqlAdapter.query.bind(sqlAdapter))
        ]);
        return { tasks, reviewCounts, approvalCounts };
      },
      readContextGuard: () => readContextGuardSidecar(cwd),
      readHookBlocker: () => readHookBlockerSidecar(cwd)
    });

    emit(diagnosis, emitJson);
  });
}

/** Exported so entrypoint tests can verify the --json vs human output
 * selection directly, without going through `withClient`/a real DB. */
export function emit(diagnosis: StallDiagnosis, emitJson: boolean): void {
  if (emitJson) {
    // serializeStallDiagnosis validates every cause's evidence was actually
    // constructed via buildEvidence() before stringifying (round-5 gate
    // finding 2: runtime-enforce the brand, not just at compile time).
    console.log(serializeStallDiagnosis(diagnosis));
  } else {
    process.stdout.write(formatStallDiagnosis(diagnosis));
  }
}
