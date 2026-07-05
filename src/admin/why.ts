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
 *
 * Reused surfaces (no reimplementation):
 *   - executeStatusCommandFromArgs → integrity contradictions, daemon
 *     operator-handoff + supervisor observations, run/task counts.
 *   - buildTaskEvidence / planRunClosure (closure-reconciler) → per-task missing
 *     review roles + missing approvals + seal-readiness.
 *   - RETRO_OUTCOME_TOKENS (record-retro) → retro seal-gate state.
 *   - resolveRespawnBudget + makeFileLockLeaseStore → respawn budget + lease.
 *   - findOrphanCandidates (prune-orphans) → duplicate/orphan runs per task_key.
 *
 * Human output is the default and reads like a colleague explaining; `--json`
 * emits the structured `StallDiagnosis`.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";

import { withClient } from "./db.ts";
import { PostgresStore } from "../store/postgres-store.ts";
import { ArchonCoreService } from "../core/service.ts";
import { executeStatusCommandFromArgs } from "../workflow.ts";
import { resolveCommandFlag } from "../cli-flags.ts";
import type { OperatorStatusReport } from "./status.ts";
import {
  buildTaskEvidence,
  planRunClosure,
  type ClosureTaskEvidence
} from "../core/closure-reconciler.ts";
import { RETRO_OUTCOME_TOKENS } from "./record-retro.ts";
import { resolveRespawnBudget } from "../runtime/respawn-budget.ts";
import { makeFileLockLeaseStore } from "../runtime/respawn-lease.ts";
import { findOrphanCandidates, type TaskRow, type ReviewCount, type ApprovalCount } from "./prune-orphans.ts";
import type {
  ApprovalRecord,
  ProjectRuntimeStateRecord,
  ReviewFloorReductionRecord,
  ReviewRecord,
  RunStatusSnapshot
} from "../domain/types.ts";
import {
  diagnoseStall,
  formatStallDiagnosis,
  type ClosureBlockSignal,
  type CouncilGateSignal,
  type StallSignals
} from "./why-diagnosis.ts";

export { diagnoseStall, formatStallDiagnosis } from "./why-diagnosis.ts";

// Council outcomes that satisfy the Design & Architecture Council gate. Mirrors
// APPROVED_COUNCIL_OUTCOMES in .claude/hooks/hook-policy.mjs — kept in lockstep
// with the Stop-hook gate so `why` never claims a council block the hook would
// not, and vice-versa.
const APPROVED_COUNCIL_OUTCOMES = new Set([
  "approved",
  "approved_with_conditions",
  "exception_granted",
  "inherited"
]);

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

  // --- Closure blocks (missing review / approval), council + retro gates. ---
  const evidence: ClosureTaskEvidence[] = [];
  const closureBlocks: ClosureBlockSignal[] = [];
  const councilGates: CouncilGateSignal[] = [];

  for (const task of snapshot.tasks) {
    const taskId = task.packet.taskId;
    const [reviews, approvals, reductions] = await Promise.all([
      deps.getReviews(snapshot.run.id, taskId),
      deps.getApprovals(snapshot.run.id, taskId),
      deps.getReviewFloorReductions(snapshot.run.id, taskId)
    ]);
    const taskEvidence = buildTaskEvidence(task, reviews, approvals, reductions);
    evidence.push(taskEvidence);

    // Typed closure blocks — same predicate planRunClosure applies, surfaced
    // with the specific missing roles the operator needs.
    if (task.status === "approved") {
      const missingRoles = taskEvidence.requiredFloor.filter(
        (role) => !taskEvidence.passedOrchestratorRoles.includes(role)
      );
      if (missingRoles.length > 0) {
        closureBlocks.push({ taskId, kind: "missing_review", missingRoles: [...missingRoles] });
      } else if (taskEvidence.orchestratorApprovals < 1) {
        closureBlocks.push({ taskId, kind: "missing_approval", missingRoles: [] });
      }
    }

    // Council gate — required-but-not-approved-class (runtime-authoritative).
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

  const plan = planRunClosure(evidence);
  const hasRetro = snapshot.tasks.some((task) => {
    const outcome = task.packet.retroOutcome;
    return typeof outcome === "string" && RETRO_OUTCOME_TOKENS.has(outcome);
  });
  const retroSealBlocked = plan.sealRun && !hasRetro;

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
  //     stall. approved/blocked/review_blocked are gate states handled above. ---
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
    duplicateRuns: duplicateRuns.length > 0 ? duplicateRuns : undefined,
    closureBlocks: closureBlocks.length > 0 ? closureBlocks : undefined,
    retroSealBlocked,
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

export async function readContextGuardSidecar(
  cwd: string
): Promise<StallSignals["sidecars"]["contextGuard"]> {
  const parsed = await readJsonSidecar(path.join(cwd, ".archon", "work", "context-guard.json"));
  if (!parsed) return undefined;
  const state = str(parsed.state);
  const taskId = str(parsed.taskId);
  const invocationId = str(parsed.invocationId);
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
  const blockerKind = str(parsed.blockerKind);
  const summary = str(parsed.summary);
  if (!taskId || !blockerKind || !summary) return undefined;
  return {
    taskId,
    blockerKind,
    command: str(parsed.command) ?? "",
    summary,
    recordedAt: str(parsed.recordedAt)
  };
}

// ---------------------------------------------------------------------------
// Command entrypoint
// ---------------------------------------------------------------------------

export async function whyCommand(args: readonly string[]): Promise<void> {
  const emitJson = args.includes("--json");
  const scope = {
    runId: resolveCommandFlag(args, "--run-id"),
    taskId: resolveCommandFlag(args, "--task-id")
  };
  const cwd = process.cwd();
  const now = new Date().toISOString();

  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);

    // Reuse the status assembly for integrity + daemon observations + counts,
    // capturing the snapshot it fetches so we don't double-query.
    let snapshot: RunStatusSnapshot | undefined;
    let report: OperatorStatusReport;
    try {
      report = await executeStatusCommandFromArgs(args, {
        cwd,
        env: process.env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        async getStatusSnapshot(runId) {
          snapshot = await service.getStatus(runId);
          return snapshot;
        },
        getProjectRuntimeState(projectId) {
          return store.getProjectRuntimeState(projectId);
        },
        getExecutionPlan(runId, staleAfterHours) {
          return service.getExecutionPlan(runId, { staleAfterHours });
        }
      });
    } catch (error) {
      // No run resolvable → nothing is stuck (there is no loop). Emit the
      // healthy no-run diagnosis rather than an error.
      const message = error instanceof Error ? error.message : String(error);
      if (/No runs found|require --run-id/i.test(message)) {
        const diagnosis = diagnoseStall({ now, scope, run: undefined, sidecars: {} });
        emit(diagnosis, emitJson);
        return;
      }
      throw error;
    }

    if (!snapshot) {
      snapshot = await service.getStatus(report.run.id);
    }
    const runtimeState = await store.getProjectRuntimeState(snapshot.run.projectId);
    const leaseStore = makeFileLockLeaseStore({
      lockDir: path.join(cwd, ".archon", "work", "daemon")
    });

    const signals = await collectStallSignals({
      now,
      scope,
      report,
      snapshot,
      runtimeState,
      getReviews: (runId, taskId) => store.getReviews(runId, taskId),
      getApprovals: (runId, taskId) => store.getApprovals(runId, taskId),
      getReviewFloorReductions: (runId, taskId) => store.getReviewFloorReductions(runId, taskId),
      readLeaseOwner: (runId) => leaseStore.readOwner(runId),
      respawnBudget: resolveRespawnBudget(),
      getOrphanInputs: () => fetchOrphanInputs(client),
      readContextGuard: () => readContextGuardSidecar(cwd),
      readHookBlocker: () => readHookBlockerSidecar(cwd)
    });

    const diagnosis = diagnoseStall(signals);
    emit(diagnosis, emitJson);
  });
}

function emit(diagnosis: ReturnType<typeof diagnoseStall>, emitJson: boolean): void {
  if (emitJson) {
    console.log(JSON.stringify(diagnosis));
  } else {
    process.stdout.write(formatStallDiagnosis(diagnosis));
  }
}

// ---------------------------------------------------------------------------
// Orphan-input queries — same shapes prune-orphans uses, kept minimal here so
// `why` reuses findOrphanCandidates without importing prune's transactional deps.
// ---------------------------------------------------------------------------

interface PgClientLike {
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

async function fetchOrphanInputs(client: unknown): Promise<{
  tasks: TaskRow[];
  reviewCounts: ReviewCount[];
  approvalCounts: ApprovalCount[];
}> {
  const pg = client as PgClientLike;
  const [taskRes, reviewRes, approvalRes] = await Promise.all([
    pg.query(`select id, run_id, task_key, status from tasks`),
    pg.query(
      `select r.run_id, r.task_id as task_key, count(distinct r.reviewer_role) as distinct_passed_roles
       from reviews r where r.state = 'passed' group by r.run_id, r.task_id`
    ),
    pg.query(
      `select a.run_id, a.task_id as task_key, count(*) as approval_count
       from approvals a group by a.run_id, a.task_id`
    )
  ]);
  const tasks = taskRes.rows.map((row) => ({
    id: String(row.id),
    run_id: String(row.run_id),
    task_key: String(row.task_key),
    status: String(row.status)
  }));
  const reviewCounts = reviewRes.rows.map((row) => ({
    run_id: String(row.run_id),
    task_key: String(row.task_key),
    distinct_passed_roles: parseInt(String(row.distinct_passed_roles), 10)
  }));
  const approvalCounts = approvalRes.rows.map((row) => ({
    run_id: String(row.run_id),
    task_key: String(row.task_key),
    approval_count: parseInt(String(row.approval_count), 10)
  }));
  return { tasks, reviewCounts, approvalCounts };
}
