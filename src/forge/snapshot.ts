/**
 * @module forge/snapshot
 *
 * Read-only snapshot generator for the Forge dashboard.
 *
 * Approach (P1-S2a): live read via the store/service when runtime is available,
 * falling back to a committed synthetic sample on fresh-clone / no-DB setups.
 *
 * Two public build paths:
 *   1. buildSampleSnapshot()        — returns the committed synthetic sample.
 *   2. projectLiveSnapshot(...)     — projects RunStatusSnapshot +
 *                                    RoutingRecommendationReport + ReviewRecord[]
 *                                    to DashboardViewModel with EXPLICIT field mapping,
 *                                    labelled `derived_only`.
 *   3. buildSnapshotFromLive(...)   — calls an injected live-reader and falls back
 *                                    to buildSampleSnapshot() on any error.
 *
 * Field-leak guard (C6):
 *   Every live projection is STRIP-PARSED through DashboardViewModelSchema.parse()
 *   (default strip mode — never .passthrough()). Unknown fields from the runtime
 *   surface are dropped before the snapshot is serialised. The explicit field
 *   mapping in projectLiveSnapshot() is the primary defence; the strip parse is
 *   the belt-and-suspenders guard.
 *
 * The React app fetches /snapshot.json (static file, no server needed).
 * web/public/snapshot.json is committed as the tracked representative sample.
 *
 * NO write capability: this module is read-only. It never mutates runtime state.
 *
 * Import wall: this module MUST NOT import from web/**. The boundary is
 * enforced by the root eslint config (no-restricted-imports rule R2-C).
 * Shared types flow FROM src/forge/ TO web/, never the other direction.
 */

import { writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardViewModelSchema } from "./dashboard-contract.ts";
import type { DashboardViewModel } from "./dashboard-contract.ts";
import { resolveWithinRepo } from "./repo-path.ts";
import type {
  RunStatusSnapshot,
  RoutingRecommendationReport,
  ReviewRecord,
  GateReviewRole,
} from "../domain/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

/** Sentinel for "write to stdout" rather than a file path. */
export const STDOUT_TARGET = "-";

/**
 * Resolve + bounds-check the snapshot output target from a CLI argument.
 *
 * - `undefined` + mode "live"   → `web/public/snapshot.live.json` (gitignored).
 * - `undefined` + mode "sample" → `web/public/snapshot.json` (committed fixture).
 * - "-"                         → stdout (STDOUT_TARGET).
 * - any explicit path           → resolved relative to the repo root and REQUIRED
 *                                 to stay inside it with a `.json` extension.
 *
 * Snapshot mode:
 *   "live"   (default) — real runtime data; output is gitignored. Real run/task ids
 *                        must never land in a committed file.
 *   "sample"           — synthetic fixture only; safe to commit as snapshot.json.
 */
export type SnapshotMode = "live" | "sample";

export function resolveSnapshotOutputPath(
  arg: string | undefined,
  repoRoot: string = REPO_ROOT,
  mode: SnapshotMode = "live"
): string {
  if (arg === undefined) {
    if (mode === "sample") {
      return resolve(repoRoot, "web", "public", "snapshot.json");
    }
    // Default: live mode → gitignored path so real run/task ids never commit.
    return resolve(repoRoot, "web", "public", "snapshot.live.json");
  }
  if (arg === STDOUT_TARGET) {
    return STDOUT_TARGET;
  }
  // Delegate to the shared helper: enforces repo-bounds + symlink resolution.
  // Wraps the error message in the legacy "must stay within the repository"
  // phrasing so existing tests that match on that string remain green.
  let resolved: string;
  try {
    resolved = resolveWithinRepo(arg, { repoRoot, allowedExt: [".json"] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Rephrase extension error to match legacy wording.
    if (msg.includes("disallowed extension")) {
      throw new Error(`snapshot output path must end in .json; got ${resolve(repoRoot, arg)}`);
    }
    // Rephrase bounds error to match legacy wording.
    throw new Error(
      `snapshot output path must stay within the repository (${repoRoot}); refusing to write to ${resolve(repoRoot, arg)}`
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Blocker kind classifier
// ---------------------------------------------------------------------------

const REVIEW_MISSING_PATTERN = /security_reviewer|reviewer|qa_engineer|review.*gate|gate.*review/i;
const APPROVAL_MISSING_PATTERN = /approval.*absent|approval.*missing|approval.*record/i;
const LOCK_CONFLICT_PATTERN = /lock.*conflict|orphan.*lock|scope.*conflict/i;
const DEPENDENCY_PATTERN = /dependency|predecessor|unresolved/i;
const STALE_RECOVERY_PATTERN = /stale|recovery/i;

/**
 * Defense-in-depth hard-gate guard.
 *
 * A reason that matches this pattern MUST NEVER be classified as advisory,
 * even if it appears in the reasoning-quality origin set (rqSet). This prevents
 * adversarial blocker messages that happen to share reasoning vocabulary from
 * being hidden in the advisory strip.
 *
 * Patterns covered:
 *   - severity qualifiers (critical, high) — real security findings
 *   - security_reviewer mentions
 *   - "security finding" / "security gate" / CVE
 *   - "waived" — approval/waiver gate decisions are real, never advisory
 *   - "approval record absent" / "review record absent" — gate record status
 */
const HARD_GATE_PATTERN =
  /\b(critical|high)\b|security[_ ]reviewer|security finding|security gate|\bCVE\b|waived|approval record absent|review record absent/i;

/**
 * Returns true when a reason string contains hard-gate markers that must never
 * be classified as advisory, regardless of any other classification.
 *
 * Exported for testing: the hard-gate guard is the last line of defence.
 */
export function isHardGateReason(reason: string): boolean {
  return HARD_GATE_PATTERN.test(reason);
}

/**
 * Build the reasoning-quality origin set for a single RoutingRecommendation.
 *
 * The runtime (service.ts ~line 2338) always prefixes reasoning-quality blocker
 * messages with `"reasoning-quality: "` when they are added to `rationale[]`.
 * The SAME raw message appears verbatim in `blockers[]` (no prefix). So exact
 * set-membership against the stripped rationale entries is the reliable origin
 * classifier — it is immune to false positives from reasoning vocabulary that
 * happens to appear in real security or gate blocker messages.
 *
 * A blocker `reason` is reasoning-quality (potentially advisory) IFF:
 *   rqSet.has(reason) && !isHardGateReason(reason)
 *
 * Run-level blockers (`snapshot.blockers`) are ALWAYS advisory:false —
 * they never originate from per-task reasoning assessments and have no
 * associated rationale[] to inspect.
 */
function buildReasoningQualitySet(rationale: readonly string[]): Set<string> {
  const PREFIX = "reasoning-quality: ";
  const rqSet = new Set<string>();
  for (const entry of rationale) {
    if (entry.startsWith(PREFIX)) {
      rqSet.add(entry.slice(PREFIX.length));
    }
  }
  return rqSet;
}

function classifyBlockerKind(
  reason: string,
  isAdvisory: boolean
): "review_missing" | "approval_missing" | "lock_conflict" | "dependency_unresolved" | "stale_recovery" | "reasoning_quality" | "generic" {
  if (isAdvisory) return "reasoning_quality";
  if (REVIEW_MISSING_PATTERN.test(reason)) return "review_missing";
  if (APPROVAL_MISSING_PATTERN.test(reason)) return "approval_missing";
  if (LOCK_CONFLICT_PATTERN.test(reason)) return "lock_conflict";
  if (DEPENDENCY_PATTERN.test(reason)) return "dependency_unresolved";
  if (STALE_RECOVERY_PATTERN.test(reason)) return "stale_recovery";
  return "generic";
}

/** Task status values that mark a task as sealed (no further work expected). */
const SEALED_TASK_STATUSES = new Set(["approved", "done"]);

/**
 * Status values used in the SEALED derivation for header.sealed.
 * Includes "memorized" because it is a valid RunStatus that indicates
 * a run's knowledge has been committed to memory (fully complete).
 * For task-level filtering we only use approved/done since "memorized"
 * is a RunStatus, not a TaskStatus.
 */
const SEALED_RUN_STATUSES = new Set(["approved", "done", "memorized"]);

// Derive a stable slug-id from a blocker reason string for React key stability.
function slugifyBlockerId(prefix: string, reason: string): string {
  const slug = reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${prefix}-${slug}`;
}

// ---------------------------------------------------------------------------
// Pulse state derivation
// ---------------------------------------------------------------------------

function derivePulseState(
  runStatus: RunStatusSnapshot["run"]["status"],
  activeLockCount: number,
  allSealed: boolean
): "idle" | "running" | "blocked" | "complete" {
  // When every task is sealed, the run is effectively complete regardless of
  // the raw run.status (which may still read "in_progress" in the DB).
  if (allSealed) return "complete";
  if (runStatus === "in_progress" && activeLockCount > 0) return "running";
  if (runStatus === "review_blocked") return "blocked";
  if (runStatus === "done" || runStatus === "approved" || runStatus === "memorized") return "complete";
  return "idle";
}

// ---------------------------------------------------------------------------
// Task status priority for queue ordering
// ---------------------------------------------------------------------------

const STATUS_PRIORITY: Record<string, number> = {
  review_blocked: 0,
  in_progress: 1,
  ready: 2,
  blocked: 3,
  approved: 4,
  done: 5,
};

function taskPriority(status: string): number {
  return STATUS_PRIORITY[status] ?? 99;
}

// ---------------------------------------------------------------------------
// Gate review roles required by the workflow
// ---------------------------------------------------------------------------

const REQUIRED_GATE_ROLES: readonly GateReviewRole[] = [
  "reviewer",
  "security_reviewer",
  "qa_engineer",
];

// ---------------------------------------------------------------------------
// Live projection (C6 field-leak guard)
// ---------------------------------------------------------------------------

/**
 * Project a live RunStatusSnapshot + RoutingRecommendationReport + ReviewRecord[]
 * to a DashboardViewModel.
 *
 * EXPLICIT FIELD MAPPING: every field on the output is mapped explicitly from the
 * input types. No spread of raw runtime objects into the output shape.
 *
 * STRIP PARSE: the result is validated through DashboardViewModelSchema.parse()
 * (default strip mode). This drops any fields that slip through the explicit
 * mapping. NEVER use .passthrough().
 *
 * The output is labelled `derived_only` because routing data comes from
 * RoutingRecommendationReport.mode === "advisory_only", not from a trusted
 * runtime execution plan.
 */
export function projectLiveSnapshot(
  snapshot: RunStatusSnapshot,
  routing: RoutingRecommendationReport,
  reviews: readonly ReviewRecord[]
): DashboardViewModel {
  const { run, tasks, activeLocks, blockers: runBlockers } = snapshot;
  const generatedAt = new Date().toISOString();

  // Build a map of taskId → RoutingRecommendation for fast lookup.
  const routingByTaskId = new Map(
    routing.recommendations.map((r) => [r.taskId, r])
  );

  // ---------------------------------------------------------------------------
  // Sealed derivation — a run is sealed when EVERY task is approved/done.
  // "memorized" is a RunStatus, not a TaskStatus, so SEALED_RUN_STATUSES
  // and SEALED_TASK_STATUSES are equivalent in practice for task.status checks.
  // Sealed tasks emit no blockers (routing-readiness is irrelevant for sealed work).
  // The same sealed flag drives header.sealed and derivePulseState.
  // ---------------------------------------------------------------------------
  const headerSealed =
    tasks.length > 0 && tasks.every((t) => SEALED_RUN_STATUSES.has(t.status));

  // ---------------------------------------------------------------------------
  // Header — explicit field mapping from RunRecord fields only.
  // header.status stays honest/raw (the DB value); sealed is derived separately.
  // ---------------------------------------------------------------------------
  const header = {
    runId: run.id,
    title: run.title,
    status: run.status,
    // Always derived_only: this snapshot comes from the advisory routing path,
    // not from a verified RunExecutionPlan with mode==="runtime_authoritative".
    authorityLabel: "derived_only" as const,
    updatedAt: run.updatedAt,
    sealed: headerSealed,
  };

  // ---------------------------------------------------------------------------
  // Blockers — run-level blockers first, then per-task routing blockers.
  //
  // Sealed tasks (approved/done) are SKIPPED: routing-readiness is irrelevant.
  //
  // Advisory classification — ORIGIN-BASED, not free-text heuristic:
  //   For each RoutingRecommendation r, build rqSet from rationale entries that
  //   start with "reasoning-quality: ". A blocker reason is advisory:true iff
  //   rqSet.has(reason) AND !isHardGateReason(reason) (defense-in-depth).
  //
  // Run-level blockers (snapshot.blockers) are ALWAYS advisory:false — they
  // come from the runtime, never from per-task reasoning assessments.
  // ---------------------------------------------------------------------------
  const blockers = [
    ...runBlockers.map((reason, idx) => ({
      id: slugifyBlockerId(`run-${idx}`, reason),
      kind: classifyBlockerKind(reason, false),
      reason,
      nextActions: [] as string[],
      // Run-level blockers are always real — never advisory.
      advisory: false as const,
    })),
    ...routing.recommendations
      .filter((r) => {
        // Skip sealed tasks entirely — no blockers should emanate from them.
        const task = tasks.find((t) => t.packet.taskId === r.taskId);
        if (task !== undefined && SEALED_TASK_STATUSES.has(task.status)) {
          return false;
        }
        return r.blockers.length > 0;
      })
      .flatMap((r) => {
        // Build the exact origin set for this recommendation's reasoning-quality
        // messages. Only messages in this set CAN be advisory (and only if they
        // also pass the hard-gate guard).
        const rqSet = buildReasoningQualitySet(r.rationale);
        return r.blockers.map((reason, idx) => {
          const isAdvisory = rqSet.has(reason) && !isHardGateReason(reason);
          return {
            id: slugifyBlockerId(`task-${r.taskId}-${idx}`, reason),
            kind: classifyBlockerKind(reason, isAdvisory),
            reason,
            nextActions: r.rationale,
            taskId: r.taskId,
            advisory: isAdvisory,
          };
        });
      }),
  ];

  // ---------------------------------------------------------------------------
  // Task queue — ordered by status priority then updatedAt desc.
  // ---------------------------------------------------------------------------
  const taskQueue = tasks
    .map((t) => {
      const rec = routingByTaskId.get(t.packet.taskId);
      return {
        taskId: t.packet.taskId,
        title: t.packet.title,
        status: t.status,
        ownerRole: t.packet.ownerRole,
        ...(rec?.recommendation !== undefined
          ? { routingRecommendation: rec.recommendation }
          : {}),
        blockers: rec?.blockers ?? [],
        updatedAt: t.updatedAt,
      };
    })
    .sort((a, b) => {
      const pd = taskPriority(a.status) - taskPriority(b.status);
      if (pd !== 0) return pd;
      return b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0;
    });

  // ---------------------------------------------------------------------------
  // Review gates — one entry per (role, taskId) for tasks that need gates.
  // Tasks needing gates: status is review_blocked or in_progress.
  // ---------------------------------------------------------------------------
  const gatedTaskIds = tasks
    .filter((t) => t.status === "review_blocked" || t.status === "in_progress")
    .map((t) => t.packet.taskId);

  // Build review lookup: (taskId, reviewerRole) → most recent ReviewRecord.
  // A task may have multiple reviews per role; we take the most recent.
  const reviewMap = new Map<string, ReviewRecord>();
  for (const review of reviews) {
    const key = `${review.taskId}:${review.reviewerRole}`;
    const existing = reviewMap.get(key);
    if (!existing || review.createdAt > existing.createdAt) {
      reviewMap.set(key, review);
    }
  }

  const reviewGates = gatedTaskIds.flatMap((taskId) =>
    REQUIRED_GATE_ROLES.map((role) => {
      const review = reviewMap.get(`${taskId}:${role}`);
      if (!review) {
        return { role, state: "pending" as const, taskId };
      }
      return {
        role,
        state: review.state,
        ...(review.severity !== undefined && review.severity !== "low"
          ? { severity: review.severity }
          : {}),
        ...(review.state !== "pending" ? { actor: review.actor } : {}),
        ...(review.state !== "pending" ? { reviewedAt: review.createdAt } : {}),
        taskId,
      };
    })
  );

  // ---------------------------------------------------------------------------
  // Pulse
  // ---------------------------------------------------------------------------
  const activeLockCount = activeLocks.length;
  const lockedTaskIds = activeLocks.map((l) => l.taskId);
  const pulseState = derivePulseState(run.status, activeLockCount, headerSealed);

  // ---------------------------------------------------------------------------
  // Strip parse — C6 field-leak guard.
  // The explicit mapping above is the primary defence; parse() is the guard.
  // NEVER use .passthrough() here.
  // ---------------------------------------------------------------------------
  return DashboardViewModelSchema.parse({
    header,
    blockers,
    taskQueue,
    reviewGates,
    pulse: { pulseState, activeLockCount, lockedTaskIds },
    generatedAt,
  });
}

// ---------------------------------------------------------------------------
// Fallback-aware live reader (C6)
// ---------------------------------------------------------------------------

export interface LiveReadDeps {
  /** Called when falling back to the synthetic sample. Defaults to process.stderr.write. */
  writeStderr?: ((msg: string) => void) | undefined;
}

/**
 * Attempt to build a live snapshot from the injected async reader.
 * On ANY error (DB unavailable, no active run, parse failure), logs the reason
 * to stderr and returns the synthetic sample snapshot instead.
 *
 * This preserves fresh-clone behaviour: the app always has a valid snapshot.
 *
 * @param liveReader - Async function that returns a DashboardViewModel. The
 *   caller is responsible for loading the store/service and calling
 *   projectLiveSnapshot(). This keeps snapshot.ts free of direct DB deps.
 */
export async function buildSnapshotFromLive(
  liveReader: () => Promise<DashboardViewModel>,
  deps: LiveReadDeps = {}
): Promise<DashboardViewModel> {
  const writeStderr = deps.writeStderr ?? ((msg: string) => process.stderr.write(msg));
  try {
    return await liveReader();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeStderr(
      `forge snapshot: live read unavailable (${reason}); falling back to synthetic sample\n`
    );
    return buildSampleSnapshot();
  }
}

// ---------------------------------------------------------------------------
// Synthetic sample (committed representative snapshot)
// ---------------------------------------------------------------------------

/**
 * Builds a synthetic representative DashboardViewModel.
 *
 * All run/task ids are clearly synthetic (prefixed `sample-`) so the committed
 * snapshot.json leaks no real run history.
 *
 * The scenario represents a realistic review_blocked run with at least one
 * blocked gate, so the dashboard's purpose (blocked-run operator view) is
 * demonstrable on a fresh clone.
 */
export function buildSampleSnapshot(): DashboardViewModel {
  return DashboardViewModelSchema.parse({
    generatedAt: "2026-06-24T00:00:00Z",

    header: {
      runId: "sample-run-001",
      title: "forge-web-dashboard",
      status: "review_blocked",
      authorityLabel: "runtime_authoritative",
      updatedAt: "2026-06-23T14:32:11Z",
      sealed: false,
    },

    blockers: [
      {
        id: "blocker-review-missing-alpha",
        kind: "review_missing",
        reason:
          "Task sample-task-alpha: security_reviewer gate not passed. No ReviewRecord found for role security_reviewer.",
        nextActions: [
          "Invoke security_reviewer agent on sample-task-alpha",
          "Run: npx tsx ./src/admin.ts workflow-proof --run-id latest --task-id sample-task-alpha",
        ],
        taskId: "sample-task-alpha",
        advisory: false,
      },
      {
        id: "blocker-approval-missing-beta",
        kind: "approval_missing",
        reason:
          "Task sample-task-beta: approved but final approval record absent from runtime store.",
        nextActions: [
          "Run workflow-proof then write approval record via admin CLI",
        ],
        taskId: "sample-task-beta",
        advisory: false,
      },
    ],

    taskQueue: [
      {
        taskId: "sample-task-alpha",
        title: "Forge Phase-0 Swimlane Monitor Dashboard",
        status: "review_blocked",
        ownerRole: "frontend_designer",
        routingRecommendation: "review_dispatch",
        blockers: [
          "security_reviewer gate not passed",
          "reviewer gate pending",
        ],
        updatedAt: "2026-06-23T14:32:11Z",
      },
      {
        taskId: "sample-task-beta",
        title: "Dashboard view-model contract (Zod schema)",
        status: "review_blocked",
        ownerRole: "backend_engineer",
        routingRecommendation: "review_dispatch",
        blockers: ["approval record absent from runtime"],
        updatedAt: "2026-06-23T11:14:07Z",
      },
      {
        taskId: "sample-task-gamma",
        title: "Constraints manifest (identity tokens + AG rules)",
        status: "approved",
        ownerRole: "frontend_designer",
        routingRecommendation: undefined,
        blockers: [],
        updatedAt: "2026-06-23T09:05:22Z",
      },
      {
        taskId: "sample-task-delta",
        title: "Harden outside-repo detection via path canonicalization",
        status: "done",
        ownerRole: "backend_engineer",
        routingRecommendation: undefined,
        blockers: [],
        updatedAt: "2026-06-22T18:44:31Z",
      },
    ],

    reviewGates: [
      // sample-task-alpha: reviewer pending, security blocked, qa passed
      {
        role: "reviewer",
        state: "pending",
        taskId: "sample-task-alpha",
      },
      {
        role: "security_reviewer",
        state: "blocked",
        severity: "high",
        taskId: "sample-task-alpha",
      },
      {
        role: "qa_engineer",
        state: "passed",
        actor: "qa_engineer",
        reviewedAt: "2026-06-23T13:45:00Z",
        taskId: "sample-task-alpha",
      },
      // sample-task-beta: all gates pending
      {
        role: "reviewer",
        state: "pending",
        taskId: "sample-task-beta",
      },
      {
        role: "security_reviewer",
        state: "pending",
        taskId: "sample-task-beta",
      },
      {
        role: "qa_engineer",
        state: "pending",
        taskId: "sample-task-beta",
      },
    ],

    pulse: {
      pulseState: "blocked",
      activeLockCount: 0,
      lockedTaskIds: [],
    },
  });
}

/**
 * Main: validate + emit the SYNTHETIC SAMPLE snapshot to the committed path.
 * Called when run as a script: `node --experimental-strip-types src/forge/snapshot.ts`
 * Uses "sample" mode so the default output is the committed web/public/snapshot.json.
 */
async function main() {
  const snapshot = buildSampleSnapshot();
  // Always use "sample" mode here: this CLI writes the committed fixture.
  const outputPath = resolveSnapshotOutputPath(process.argv[2], REPO_ROOT, "sample");
  const json = JSON.stringify(snapshot, null, 2);

  if (outputPath === STDOUT_TARGET) {
    process.stdout.write(json + "\n");
    process.stderr.write("forge snapshot: validated against DashboardViewModelSchema\n");
  } else {
    await writeFile(outputPath, json + "\n", "utf8");
    process.stderr.write(`forge snapshot: validated and written to ${outputPath}\n`);
  }
}

// Run only as a CLI entry point — guard so importing the module (e.g. from
// tests) does not execute main(). Symlinks are resolved on both sides so the
// guard holds when invoked through a symlinked path.
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
const invokedPath = typeof process.argv[1] === "string" ? canonicalPath(process.argv[1]) : "";
if (invokedPath !== "" && canonicalPath(fileURLToPath(import.meta.url)) === invokedPath) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Snapshot generation failed: ${message}\n`);
    process.exit(1);
  });
}
