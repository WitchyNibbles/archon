/**
 * @module forge/dashboard-contract
 *
 * Read-only view-model contract for the Forge dashboard.
 *
 * Every shape here is a faithful projection of real runtime types:
 *   - RunRecord          → src/domain/types.ts RunRecord
 *   - RunStatus          → src/domain/types.ts runStatuses
 *   - BlockerViewModel   → derived from RunStatusSnapshot.blockers + RoutingRecommendation.blockers
 *   - TaskQueueEntryVM   → TaskRecord + RoutingRecommendation
 *   - ReviewGateViewModel→ ReviewRecord shapes + requiredGateReviews + reviewStates
 *   - RunPulseViewModel  → live indicator derived from RunStatusSnapshot.run.status + activeLocks
 *
 * The web/ layer MUST consume this contract only — never raw MCP/tool JSON.
 * All imports from src/ are type-only to prevent value cycles into runtime entry points.
 */

import { z } from "zod";
import type {
  RunStatus,
  TaskStatus,
  ReviewState,
  ReviewSeverity,
  GateReviewRole,
  RoutingRecommendationKind
} from "../domain/types.ts";

// ---------------------------------------------------------------------------
// Re-export discriminant values that Zod schemas need at runtime.
// Sourced from src/domain/types.ts to stay in sync — never duplicated.
// ---------------------------------------------------------------------------

export const runStatusValues = [
  "intake",
  "planned",
  "decomposed",
  "ready",
  "in_progress",
  "review_blocked",
  "approved",
  "memorized",
  "done"
] as const satisfies readonly RunStatus[];

export const taskStatusValues = [
  "ready",
  "in_progress",
  "review_blocked",
  "approved",
  "done",
  "blocked"
] as const satisfies readonly TaskStatus[];

export const reviewStateValues = [
  "pending",
  "passed",
  "blocked",
  "waived"
] as const satisfies readonly ReviewState[];

export const reviewSeverityValues = [
  "low",
  "medium",
  "high",
  "critical"
] as const satisfies readonly ReviewSeverity[];

export const gateReviewRoleValues = [
  "reviewer",
  "security_reviewer",
  "qa_engineer"
] as const satisfies readonly GateReviewRole[];

export const routingRecommendationKindValues = [
  "owner_dispatch",
  "review_dispatch",
  "wait"
] as const satisfies readonly RoutingRecommendationKind[];

/**
 * Authority label on the run header.
 * - "runtime_authoritative": the datum came from the Postgres runtime record
 *   (RoutingRecommendation.authorityLabel = "derived_only" is advisory).
 *   The run-level authority badge tracks the MODE of the execution plan.
 * - "derived_only": routing/blocker data is advisory, not from trusted runtime.
 *
 * Source: RunExecutionPlan.mode === "runtime_authoritative" (src/domain/types.ts)
 *         vs RoutingRecommendationReport.mode === "advisory_only"
 */
export const authorityLabelValues = ["runtime_authoritative", "derived_only"] as const;

// ---------------------------------------------------------------------------
// Run header
// Source: RunRecord (src/domain/types.ts)
// ---------------------------------------------------------------------------

export const RunHeaderViewModelSchema = z.object({
  /** Stable run UUID — display in Geist Mono. Source: RunRecord.id */
  runId: z.string(),
  /** Human title. Source: RunRecord.title */
  title: z.string(),
  /** Current lifecycle status. Source: RunRecord.status */
  status: z.enum(runStatusValues),
  /**
   * Authority badge.
   * "runtime_authoritative" = RunExecutionPlan.mode matches; trusted Postgres record.
   * "derived_only"          = only advisory routing available; no trusted runtime plan.
   */
  authorityLabel: z.enum(authorityLabelValues),
  /** ISO-8601 timestamp. Source: RunRecord.updatedAt */
  updatedAt: z.string()
});

export type RunHeaderViewModel = z.infer<typeof RunHeaderViewModelSchema>;

// ---------------------------------------------------------------------------
// Blocker — HERO data
// Source: RunStatusSnapshot.blockers (string[]) for run-level blockers;
//         RoutingRecommendation.blockers for task-scoped recovery guidance.
// ---------------------------------------------------------------------------

export const blockerKindValues = [
  "review_missing",
  "approval_missing",
  "lock_conflict",
  "dependency_unresolved",
  "stale_recovery",
  "generic"
] as const;

export const BlockerViewModelSchema = z.object({
  /**
   * Stable synthetic id for this blocker entry (slug derived from message).
   * The dashboard uses it for React key and diff tracking — not a DB id.
   */
  id: z.string(),
  /**
   * Semantic kind for icon and colour selection.
   * "review_missing"       → needs reviewer/security_reviewer/qa_engineer
   * "approval_missing"     → task awaiting final approval record
   * "lock_conflict"        → orphan lock or scope conflict
   * "dependency_unresolved"→ predecessor task not done
   * "stale_recovery"       → recovery issue (stale_task, stale_approval etc.)
   * "generic"              → any other blocker message
   */
  kind: z.enum(blockerKindValues),
  /** Full blocker message as emitted by the runtime. */
  reason: z.string(),
  /**
   * Operator next actions from RoutingRecommendation.rationale or
   * RecoveryAction.rationale — may be empty for run-level blockers.
   */
  nextActions: z.array(z.string()),
  /**
   * The task this blocker belongs to, if it is task-scoped.
   * Undefined for run-level blockers (RunStatusSnapshot.blockers).
   */
  taskId: z.string().optional()
});

export type BlockerViewModel = z.infer<typeof BlockerViewModelSchema>;

// ---------------------------------------------------------------------------
// Task-queue entry
// Source: TaskRecord (src/domain/types.ts) + RoutingRecommendation
// ---------------------------------------------------------------------------

export const TaskQueueEntryViewModelSchema = z.object({
  /** Source: TaskRecord.packet.taskId */
  taskId: z.string(),
  /** Source: TaskRecord.packet.title */
  title: z.string(),
  /** Source: TaskRecord.status */
  status: z.enum(taskStatusValues),
  /** Source: TaskRecord.packet.ownerRole */
  ownerRole: z.string(),
  /**
   * Routing hint for the operator — derived from RoutingRecommendation.recommendation.
   * undefined means no recommendation available.
   */
  routingRecommendation: z.enum(routingRecommendationKindValues).optional(),
  /**
   * Ordered blocker messages for this task.
   * Source: RoutingRecommendation.blockers merged with findBlockingReasonsForTask output.
   */
  blockers: z.array(z.string()),
  /** Source: TaskRecord.updatedAt */
  updatedAt: z.string()
});

export type TaskQueueEntryViewModel = z.infer<typeof TaskQueueEntryViewModelSchema>;

// ---------------------------------------------------------------------------
// Review gate state
// Source: ReviewRecord (src/domain/types.ts) + requiredGateReviews
// ---------------------------------------------------------------------------

export const ReviewGateViewModelSchema = z.object({
  /** Source: GateReviewRole — one of reviewer | security_reviewer | qa_engineer */
  role: z.enum(gateReviewRoleValues),
  /**
   * Current gate state.
   * Source: ReviewRecord.state (pending | passed | blocked | waived)
   * "pending" means no ReviewRecord exists yet for this role on this task.
   */
  state: z.enum(reviewStateValues),
  /**
   * Highest severity finding for this gate.
   * undefined when state is "pending" or "passed" with no findings.
   * Source: ReviewRecord.severity
   */
  severity: z.enum(reviewSeverityValues).optional(),
  /**
   * Human actor who wrote the review record.
   * undefined when state is "pending".
   * Source: ReviewRecord.actor
   */
  actor: z.string().optional(),
  /** Source: ReviewRecord.createdAt or undefined when pending */
  reviewedAt: z.string().optional(),
  /**
   * The task this gate belongs to.
   * Source: ReviewRecord.taskId
   */
  taskId: z.string()
});

export type ReviewGateViewModel = z.infer<typeof ReviewGateViewModelSchema>;

// ---------------------------------------------------------------------------
// Live pulse
// Source: RunRecord.status + RunStatusSnapshot.activeLocks
// ---------------------------------------------------------------------------

export const PulseStateValues = ["idle", "running", "blocked", "complete"] as const;

export const RunPulseViewModelSchema = z.object({
  /**
   * Synthesised liveness indicator.
   * "running"  → run.status === "in_progress" and activeLocks.length > 0
   * "blocked"  → run.status === "review_blocked"
   * "complete" → run.status === "done" | "approved" | "memorized"
   * "idle"     → run.status === "ready" | "planned" | "decomposed" | "intake"
   */
  pulseState: z.enum(PulseStateValues),
  /** Count of active scope locks. Source: RunStatusSnapshot.activeLocks.length */
  activeLockCount: z.number().int().nonnegative(),
  /**
   * Task IDs that currently hold a lock.
   * Source: LockRecord.taskId for each active lock.
   */
  lockedTaskIds: z.array(z.string())
});

export type RunPulseViewModel = z.infer<typeof RunPulseViewModelSchema>;

// ---------------------------------------------------------------------------
// Top-level dashboard view model
// ---------------------------------------------------------------------------

export const DashboardViewModelSchema = z.object({
  /** Run identity + authority label — drives the page header badge. */
  header: RunHeaderViewModelSchema,
  /**
   * HERO: blocker list — operator primary action surface.
   * Empty array means no active blockers (show idle/done state).
   * Source: RunStatusSnapshot.blockers + per-task RoutingRecommendation.blockers
   */
  blockers: z.array(BlockerViewModelSchema),
  /**
   * Task queue rows — ordered by status priority then updatedAt desc.
   * Source: RunStatusSnapshot.tasks mapped through RoutingRecommendation
   */
  taskQueue: z.array(TaskQueueEntryViewModelSchema),
  /**
   * Review gate states across all in-progress/review-blocked tasks.
   * One entry per (role, taskId) pair where a gate is required.
   */
  reviewGates: z.array(ReviewGateViewModelSchema),
  /** Live pulse indicator for the run. */
  pulse: RunPulseViewModelSchema
});

export type DashboardViewModel = z.infer<typeof DashboardViewModelSchema>;
