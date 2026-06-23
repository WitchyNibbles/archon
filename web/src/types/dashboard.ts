/**
 * Re-export the dashboard contract types for use within web/.
 *
 * The dashboard-contract is defined in src/forge/dashboard-contract.ts.
 * Because web/ is a separate Vite workspace (bundler mode, no NodeNext resolution),
 * we re-declare the types here as identical shapes rather than cross-importing
 * across the package boundary (which would pull the zod runtime into the bundle
 * and violate the import wall in the root eslint config).
 *
 * These types MUST stay in sync with src/forge/dashboard-contract.ts.
 * The snapshot generator validates real data against the Zod schema before
 * writing to web/public/snapshot.json — so any drift is caught at generation time.
 */

export type RunStatus =
  | "intake"
  | "planned"
  | "decomposed"
  | "ready"
  | "in_progress"
  | "review_blocked"
  | "approved"
  | "memorized"
  | "done";

export type TaskStatus =
  | "ready"
  | "in_progress"
  | "review_blocked"
  | "approved"
  | "done"
  | "blocked";

export type ReviewState = "pending" | "passed" | "blocked" | "waived";

export type ReviewSeverity = "low" | "medium" | "high" | "critical";

export type GateReviewRole = "reviewer" | "security_reviewer" | "qa_engineer";

export type RoutingRecommendationKind =
  | "owner_dispatch"
  | "review_dispatch"
  | "wait";

export type AuthorityLabel = "runtime_authoritative" | "derived_only";

export type BlockerKind =
  | "review_missing"
  | "approval_missing"
  | "lock_conflict"
  | "dependency_unresolved"
  | "stale_recovery"
  | "generic";

export type PulseState = "idle" | "running" | "blocked" | "complete";

export interface RunHeaderViewModel {
  runId: string;
  title: string;
  status: RunStatus;
  authorityLabel: AuthorityLabel;
  updatedAt: string;
}

export interface BlockerViewModel {
  id: string;
  kind: BlockerKind;
  reason: string;
  nextActions: string[];
  taskId?: string;
}

export interface TaskQueueEntryViewModel {
  taskId: string;
  title: string;
  status: TaskStatus;
  ownerRole: string;
  routingRecommendation?: RoutingRecommendationKind;
  blockers: string[];
  updatedAt: string;
}

export interface ReviewGateViewModel {
  role: GateReviewRole;
  state: ReviewState;
  severity?: ReviewSeverity;
  actor?: string;
  reviewedAt?: string;
  taskId: string;
}

export interface RunPulseViewModel {
  pulseState: PulseState;
  activeLockCount: number;
  lockedTaskIds: string[];
}

export interface DashboardViewModel {
  header: RunHeaderViewModel;
  blockers: BlockerViewModel[];
  taskQueue: TaskQueueEntryViewModel[];
  reviewGates: ReviewGateViewModel[];
  pulse: RunPulseViewModel;
}
