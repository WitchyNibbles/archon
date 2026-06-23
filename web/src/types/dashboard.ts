/**
 * Public type surface for the Forge dashboard — re-exports from the
 * build-time-generated file so all web consumers keep the same import path.
 *
 * The generated file (dashboard.generated.ts) is produced by:
 *   src/forge/gen-dashboard-types.ts
 *
 * It is GITIGNORED and NEVER committed.  Run `npm run gen:types` (or let the
 * `prebuild` / `predev` hooks do it) to regenerate it.
 *
 * Do NOT add hand-maintained type bodies here.  All types live in the
 * dashboard contract (src/forge/dashboard-contract.ts) and flow through
 * the emitter.
 */

export type {
  RunStatus,
  TaskStatus,
  ReviewState,
  ReviewSeverity,
  GateReviewRole,
  RoutingRecommendationKind,
  AuthorityLabel,
  BlockerKind,
  PulseState,
  RunHeaderViewModel,
  BlockerViewModel,
  TaskQueueEntryViewModel,
  ReviewGateViewModel,
  RunPulseViewModel,
  DashboardViewModel,
} from "./dashboard.generated.ts";
