import type { TaskQueue } from "../archon/task-queue.ts";
import { agentRoleIds } from "../archon/agent-catalog.ts";
import type { TaskClass } from "./task-class.ts";

export const runStatuses = [
  "intake",
  "planned",
  "decomposed",
  "ready",
  "in_progress",
  "review_blocked",
  "approved",
  "memorized",
  "done"
] as const;

export const taskStatuses = [
  "ready",
  "in_progress",
  "review_blocked",
  "approved",
  "done",
  "blocked"
] as const;

export const reviewSeverities = ["low", "medium", "high", "critical"] as const;
export const reviewStates = ["pending", "passed", "blocked", "waived"] as const;
export const approvalDecisions = ["approved", "blocked", "waived"] as const;
// Review/approval provenance: who wrote the record.
// "orchestrator" = orchestrator-written DB record (trusted gate authority)
// "seed" = synthetic local proof seed (never trusted as completion authority)
// "self" = written by the task agent itself (never trusted for gates)
export const reviewSources = ["orchestrator", "seed", "self"] as const;
export const memoryScopes = ["global", "project"] as const;
export const memoryTypes = ["fact", "decision", "pattern", "lesson", "anti_pattern"] as const;
export const memoryStatuses = ["proposed", "approved", "rejected"] as const;
export const artifactKinds = ["plan", "markdown_chunk", "workflow_document"] as const;
export const workflowDocumentKinds = [
  "brief",
  "plan",
  "task_packet",
  "review_summary",
  "product_state",
  "task_queue",
  "coverage_manifest",
  "progress_proof",
  "checkpoint_summary",
  "export_snapshot",
  "policy_bundle"
] as const;
export const stopGoDecisions = ["go", "needs_review", "stop"] as const;
export const completionStandards = ["artifact_complete", "specialist_verified"] as const;
export const reasoningConfidenceLevels = ["low", "medium", "high"] as const;
export const reasoningDecisions = ["continue", "supported", "blocked"] as const;
export const reasoningWorkflowModes = ["legacy", "dual", "strict"] as const;
export const reasoningVerdictStatuses = [
  "supported",
  "insufficient_evidence",
  "contradicted",
  "budget_exhausted",
  "needs_review"
] as const;
export const reasoningAttemptOutcomes = [
  "supported",
  "contradicted",
  "inconclusive",
  "failed"
] as const;
export const reasoningVerificationKinds = [
  "test",
  "docs",
  "schema",
  "runtime",
  "tool_output",
  "critic_review",
  "diff_review",
  "human_review"
] as const;
export const reasoningVerificationStatuses = ["passed", "failed", "pending", "skipped"] as const;
export const retrievalRoles = agentRoleIds;
export const requiredGateReviews = ["reviewer", "security_reviewer", "qa_engineer"] as const;

// Council outcomes that satisfy the Design & Architecture Council gate. Kept
// in lockstep with .claude/hooks/hook-policy.mjs's APPROVED_COUNCIL_OUTCOMES
// (machine-cross-checked, see tests/admin-why-council-parity.test.ts) and
// consumed by admin/why.ts (gate evaluation, re-exported under the same name
// for that test) and admin/why-diagnosis.ts (redaction known-vocabulary) —
// single source, not retyped in either place (round-5 gate finding 1).
export const councilApprovedOutcomes = [
  "approved",
  "approved_with_conditions",
  "exception_granted",
  "inherited"
] as const;

// Round-14: hook-blocker `blockerKind`, lockstep with hook-utils.mjs's
// `hookBlockerKinds` (cross-checked: admin-why-hook-blocker-kind-parity.test.ts).
export const hookBlockerKinds = [
  "command_not_found",
  "environment_missing",
  "runtime_preflight",
  "connection_refused",
  "permission_denied",
  "generic_nonzero_bash"
] as const;
export const uiSurfaces = ["none", "visual_change", "interactive_flow"] as const;
export const qualityGates = [
  "council_review_required",
  "product_acceptance",
  "frontend_acceptance",
  "accessibility_acceptance",
  "responsive_acceptance",
  "tdd_required",
  "e2e_required",
  "regression_safety_required",
  "release_readiness_required",
  "performance_check_required",
  "setup_replay_required",
  "coverage_ledger_required",
  "progress_proof_required",
  "checkpoint_resume_required",
  "memory_compaction_required",
  "reasoning_dual_required",
  "reasoning_strict_required"
] as const;
export const routingRecommendationKinds = ["owner_dispatch", "review_dispatch", "wait"] as const;
export const executionDirectiveKinds = [
  "complete",
  "dispatch_owner",
  "dispatch_reviews",
  "apply_recovery",
  "dispatch_subagents",
  "rebuild_inventory",
  "trace_runtime",
  "checkpoint",
  "replan_migration",
  "continue_analysis",
  "blocked"
] as const;
export const continuationActionKinds = [
  "resolve_blocking_gap",
  "run_workflow_proof",
  "resume_target"
] as const;
export const recoveryIssueKinds = [
  "stalled_task",
  "stale_review_block",
  "stale_approval",
  "orphan_lock"
] as const;
export const recoveryActionKinds = [
  "reset_task_to_ready",
  "release_orphan_lock",
  "reblock_stale_approval",
  "request_missing_reviews"
] as const;
export const coverageItemCategories = [
  "models",
  "services",
  "apis",
  "routes",
  "controllers_views",
  "serializers_forms",
  "database_access",
  "queries",
  "background_jobs",
  "async_tasks",
  "frontend_components",
  "state_management",
  "authentication",
  "authorization",
  "permissions",
  "caching",
  "feature_flags",
  "external_integrations",
  "infrastructure",
  "deployment",
  "ci_cd",
  "tests",
  "migrations",
  "dead_code",
  "duplicated_logic",
  "configuration",
  "environment_coupling",
  "runtime_side_effects"
] as const;
export const coverageItemStates = [
  "undiscovered",
  "discovered",
  "partially_analyzed",
  "fully_analyzed",
  "validated",
  "migrated",
  "deprecated",
  "blocked"
] as const;
export const coverageCriticalities = ["low", "medium", "high", "critical"] as const;
export const gapKinds = [
  "missing_inventory",
  "missing_callsite_coverage",
  "missing_dependency_edge",
  "missing_runtime_trace",
  "missing_validation",
  "contradicting_evidence",
  "hidden_write_side_effect",
  "orphaned_config_coupling",
  "dead_code_suspicion",
  "duplicate_logic_suspicion",
  "architecture_recommendation_before_threshold"
] as const;
export const gapSeverities = ["low", "medium", "high", "critical"] as const;
export const gapStatuses = ["open", "closed"] as const;
export const understandingMapKinds = [
  "repo_map",
  "subsystems",
  "route_map",
  "model_map",
  "integration_map",
  "authz_map",
  "config_coupling",
  "runtime_side_effects",
  "domain_map",
  "symbol_graph",
  "call_graph",
  "dependency_graph",
  "invariant_ledger",
  "duplicate_families",
  "architecture_decisions",
  "migration_ledger",
  "parity_matrix"
] as const;
export const runtimeTraceKinds = ["route", "job", "integration", "auth", "side_effect"] as const;
export const runtimeTraceAuthorityLabels = ["runtime_capture", "operator_import"] as const;
export const duplicateFamilyMemberKinds = [
  "shared_core",
  "intentional_variant",
  "accidental_divergence",
  "unknown"
] as const;
export const architectureDecisionStatuses = ["proposed", "accepted", "superseded"] as const;
export const migrationStrategies = ["expand_contract", "dual_write", "backfill_then_cutover"] as const;
export const migrationConsistencyClasses = ["strong", "eventual", "mixed"] as const;
export const parityRequirementStatuses = ["planned", "verified", "waived"] as const;
export const analysisPhases = [
  "discovery",
  "inventory",
  "dependency_mapping",
  "runtime_tracing",
  "subsystem_classification",
  "risk_analysis",
  "modernization_strategy",
  "migration_sequencing",
  "implementation",
  "validation",
  "regression_detection",
  "final_verification",
  "blocked",
  "done"
] as const;
export const runProfiles = ["standard_delivery", "legacy_rewrite", "modernization_program", "debug_heavy"] as const;
export const phaseReadinessStatuses = ["ready", "blocked"] as const;
export const rewriteReadinessStatuses = ["ready", "blocked", "profile_limited"] as const;
export const comprehensionReadinessScopes = ["broad", "profile_limited"] as const;
export const phaseReadinessTransitions = ["advance", "hold", "fallback", "complete"] as const;
export const phaseReadinessBlockerKinds = [
  "none",
  "missing_evidence",
  "blocking_gap",
  "contradiction_loop",
  "stale_checkpoint",
  "retry_budget_exhausted"
] as const;

// ---------------------------------------------------------------------------
// Agentic Loop Runtime — Phase 1 enums
// ---------------------------------------------------------------------------

export const agentKinds = [
  "root_manager",
  "specialist_owner",
  "subagent",
  "reviewer",
  "debate_participant"
] as const;

export const agentInvocationStatuses = [
  "created",
  "running",
  "handoff_requested",
  "handoff_written",
  "completed",
  "blocked",
  "failed"
] as const;

export const handoffReasons = [
  "context_threshold_70",
  "role_boundary",
  "blocked",
  "review_required",
  "manual",
  "precompact_fallback",
  "crash_recovery"
] as const;

export const contextSampleSources = [
  "sdk",
  "statusline",
  "transcript",
  "auto",
  "precompact"
] as const;

export const debateModes = [
  "independent_vote",
  "structured_debate",
  "council_review",
  "red_team_review"
] as const;

export type RunStatus = (typeof runStatuses)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type ReviewSeverity = (typeof reviewSeverities)[number];
export type ReviewState = (typeof reviewStates)[number];
export type ApprovalDecision = (typeof approvalDecisions)[number];
export type ReviewSource = (typeof reviewSources)[number];
export type UiSurface = (typeof uiSurfaces)[number];
export type MemoryScope = (typeof memoryScopes)[number];
export type MemoryType = (typeof memoryTypes)[number];
export type MemoryStatus = (typeof memoryStatuses)[number];
export type ArtifactKind = (typeof artifactKinds)[number];
export type WorkflowDocumentKind = (typeof workflowDocumentKinds)[number];
export type StopGoDecision = (typeof stopGoDecisions)[number];
export type CompletionStandard = (typeof completionStandards)[number];
export type ReasoningConfidenceLevel = (typeof reasoningConfidenceLevels)[number];
export type ReasoningDecision = (typeof reasoningDecisions)[number];
export type ReasoningWorkflowMode = (typeof reasoningWorkflowModes)[number];
export type ReasoningVerdictStatus = (typeof reasoningVerdictStatuses)[number];
export type ReasoningAttemptOutcome = (typeof reasoningAttemptOutcomes)[number];
export type ReasoningVerificationKind = (typeof reasoningVerificationKinds)[number];
export type ReasoningVerificationStatus = (typeof reasoningVerificationStatuses)[number];
export type RetrievalRole = (typeof retrievalRoles)[number];
export type GateReviewRole = (typeof requiredGateReviews)[number];
export type QualityGate = (typeof qualityGates)[number];
export type RoutingRecommendationKind = (typeof routingRecommendationKinds)[number];
export type ExecutionDirectiveKind = (typeof executionDirectiveKinds)[number];
export type RecoveryIssueKind = (typeof recoveryIssueKinds)[number];
export type RecoveryActionKind = (typeof recoveryActionKinds)[number];
export type CoverageItemCategory = (typeof coverageItemCategories)[number];
export type CoverageItemState = (typeof coverageItemStates)[number];
export type CoverageCriticality = (typeof coverageCriticalities)[number];
export type GapKind = (typeof gapKinds)[number];
export type GapSeverity = (typeof gapSeverities)[number];
export type GapStatus = (typeof gapStatuses)[number];
export type UnderstandingMapKind = (typeof understandingMapKinds)[number];
export type RuntimeTraceKind = (typeof runtimeTraceKinds)[number];
export type RuntimeTraceAuthorityLabel = (typeof runtimeTraceAuthorityLabels)[number];
export type DuplicateFamilyMemberKind = (typeof duplicateFamilyMemberKinds)[number];
export type ArchitectureDecisionStatus = (typeof architectureDecisionStatuses)[number];
export type MigrationStrategy = (typeof migrationStrategies)[number];
export type MigrationConsistencyClass = (typeof migrationConsistencyClasses)[number];
export type ParityRequirementStatus = (typeof parityRequirementStatuses)[number];
export type AnalysisPhase = (typeof analysisPhases)[number];
export type RunProfile = (typeof runProfiles)[number];
export type PhaseReadinessStatus = (typeof phaseReadinessStatuses)[number];
export type RewriteReadinessStatus = (typeof rewriteReadinessStatuses)[number];
export type ComprehensionReadinessScope = (typeof comprehensionReadinessScopes)[number];
export type PhaseReadinessTransition = (typeof phaseReadinessTransitions)[number];
export type PhaseReadinessBlockerKind = (typeof phaseReadinessBlockerKinds)[number];

export interface RetrievalMetadata {
  retrievalRoles?: RetrievalRole[] | undefined;
  tags?: string[] | undefined;
  reviewedAt?: string | undefined;
  staleAfterDays?: number | undefined;
  supersededBy?: string[] | undefined;
  contradicts?: string[] | undefined;
  authorityLevel?: "policy" | "reviewed_memory" | "repo_context" | "operational_context" | undefined;
  /** MPL P2: fingerprint of the distilled mistake pattern that produced this entry. */
  mistakeFingerprint?: string | undefined;
}

export interface MarkdownArtifactMetadata extends RetrievalMetadata {
  chunkIndex?: number | undefined;
}

export interface ProjectRef {
  workspaceSlug: string;
  workspaceName?: string | undefined;
  projectSlug: string;
  projectName?: string | undefined;
  repoPath?: string | undefined;
}

export interface IntakeRequestInput extends ProjectRef {
  actor: string;
  title: string;
  request: string;
  goal?: string | undefined;
  audience?: string[] | undefined;
  constraints?: string[] | undefined;
  risks?: string[] | undefined;
  unknowns?: string[] | undefined;
  clarifyingQuestions?: string[] | undefined;
  assumptions?: string[] | undefined;
  successCriteria?: string[] | undefined;
  outOfScope?: string[] | undefined;
  trustBoundaries?: string[] | undefined;
  destructiveActions?: string[] | undefined;
  externalIntegrations?: string[] | undefined;
}

export interface IntakeSummary {
  goal: string;
  audience: string[];
  constraints: string[];
  risks: string[];
  unknowns: string[];
  clarifyingQuestions?: string[] | undefined;
  assumptions?: string[] | undefined;
  successCriteria: string[];
  outOfScope: string[];
  trustBoundaries: string[];
  destructiveActions: string[];
  externalIntegrations: string[];
  stopGo: StopGoDecision;
}

export interface ReasoningQualityBudget {
  researchSteps?: number | undefined;
  debugSteps?: number | undefined;
  reviewPasses?: number | undefined;
  toolRetries?: number | undefined;
}

export interface ReasoningQualityBlock {
  claim: string;
  facts?: string[] | undefined;
  assumptions: string[];
  hypotheses: string[];
  evidenceRefs: string[];
  counterEvidence?: string[] | undefined;
  openQuestions?: string[] | undefined;
  verificationPlan: string[];
  fallbacks?: string[] | undefined;
  budgets?: ReasoningQualityBudget | undefined;
  confidence: ReasoningConfidenceLevel;
  decision: ReasoningDecision;
}

export interface ReasoningPolicy {
  mode: ReasoningWorkflowMode;
  requireBlock?: boolean | undefined;
  requireEvidenceRefs?: boolean | undefined;
  requireAttempts?: boolean | undefined;
  requireTraceRefs?: boolean | undefined;
  requireVerification?: boolean | undefined;
  requireCriticVerification?: boolean | undefined;
  maxAttempts?: number | undefined;
}

export interface ReasoningVerification {
  id: string;
  kind: ReasoningVerificationKind;
  ref: string;
  status: ReasoningVerificationStatus;
  summary: string;
}

export interface ReasoningAttempt {
  id: string;
  label: string;
  hypothesis: string;
  alternatives?: string[] | undefined;
  evidenceRefs: string[];
  verificationRefs: string[];
  traceRef?: string | undefined;
  outcome: ReasoningAttemptOutcome;
  summary: string;
}

export interface ReasoningVerdict {
  status: ReasoningVerdictStatus;
  summary: string;
  supportingAttemptIds: string[];
  blockingIssues?: string[] | undefined;
}

export interface PlanInput {
  runId: string;
  title: string;
  summary: string;
  milestones: string[];
  decisions: string[];
  residualRisks: string[];
  acceptanceCriteria: string[];
  reasoningPolicy?: ReasoningPolicy | undefined;
  reasoningAttempts?: ReasoningAttempt[] | undefined;
  reasoningVerifications?: ReasoningVerification[] | undefined;
  reasoningVerdict?: ReasoningVerdict | undefined;
  reasoningQuality?: ReasoningQualityBlock | undefined;
}

export interface TaskPacketInput {
  taskId: string;
  title: string;
  ownerRole: string;
  completionStandard: CompletionStandard;
  requiredSpecialistRoles: RetrievalRole[];
  qualityGates: QualityGate[];
  goal: string;
  inputs: string[];
  outputs: string[];
  dependencies: string[];
  allowedWriteScope: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  verificationSteps: string[];
  uiSurface?: UiSurface | undefined;
  playwrightRequired?: boolean | undefined;
  requiredReviews: GateReviewRole[];
  securityChecks: string[];
  antiPatterns: string[];
  rollbackNotes: string;
  handoffFormat: string;
  reasoningPolicy?: ReasoningPolicy | undefined;
  reasoningAttempts?: ReasoningAttempt[] | undefined;
  reasoningVerifications?: ReasoningVerification[] | undefined;
  reasoningVerdict?: ReasoningVerdict | undefined;
  reasoningQuality?: ReasoningQualityBlock | undefined;
  // #14 fix: orchestrator-recorded Design & Architecture Council outcome. When the
  // runtime is connected this is the authoritative council outcome for the Stop-hook
  // gate; the on-disk packet markdown is only the offline fallback.
  councilOutcome?: string | undefined;
  // auditP3RetroLoop fix (HIGH #1): orchestrator-recorded post-task retro decision —
  // mirrors councilOutcome. Recorded via `record-retro`; read by close-run's seal
  // gate to prove at least one task in the run recorded a real retro outcome before
  // the run can be sealed (unless the operator uses the explicit acknowledge escape
  // hatch). Additive/optional — no migration needed since `packet` is a JSON blob.
  retroOutcome?: string | undefined;
  retroDecidedAt?: string | undefined;
}

export interface HandoffInput {
  actor: string;
  ownerRole: RetrievalRole;
  completionStandard: CompletionStandard;
  summary: string;
  changedFiles: string[];
  blockers: string[];
  verificationNotes: string[];
  executionEvidence: string[];
  qualityGateEvidence: string[];
  contextRefs: string[];
}

/**
 * Structured review finding — P1.5 structured findings contract (extended by P2.1
 * finding-acceptance-records).
 *
 * `findingDetails` is OPTIONAL and additive. Existing `findings: string[]` and
 * the waived path in gate logic (`canReviewRecordSatisfyGate`, `evaluateReviewDecision`)
 * are unchanged. When `findingDetails` is supplied, string `findings` is derived
 * from `findingDetails.map(f => f.message)` by `recordReview` so reviewers
 * do not double-author. The `symbolLocus` field in MistakeOccurrenceRecord
 * is populated from `symbol` (preferred) or `file` when structured details
 * are present, giving finer fingerprint cardinality than P1.
 *
 * P2.1 acceptance extension:
 * A `passed` review MAY carry findings when EVERY finding is fully accepted:
 *   - `disposition === "accepted"`
 *   - `acceptedByRole` is a non-empty string
 *   - `acceptanceReason` is a non-empty string
 *   - HARD RULE: severity must be exactly `"low"` or `"medium"`; undefined, null,
 *     and any unrecognised value are rejected by the positive allowlist.
 * Absent / undefined `disposition` means the finding is open.
 */
export interface ReviewFinding {
  /** Human-readable description of the finding. Required. */
  readonly message: string;
  /** Severity of this individual finding. Optional. */
  readonly severity?: ReviewSeverity | undefined;
  /**
   * Mistake category — use MistakeCategory values where applicable.
   * Plain string fallback is allowed for categories not yet in the enum.
   */
  readonly category?: string | undefined;
  /** Repo-relative file path where the finding was observed. Optional. */
  readonly file?: string | undefined;
  /** Line number in the file. Optional. */
  readonly line?: number | undefined;
  /** Symbol (function, class, method) where the finding was observed. Optional. */
  readonly symbol?: string | undefined;
  /**
   * P2.1 acceptance disposition. When `"accepted"`, this finding has been
   * explicitly accepted-by-decision and is not considered open. Absent/undefined
   * means the finding is still open. Only `"accepted"` is a valid value; the gate
   * rejects any other value.
   */
  readonly disposition?: "accepted" | undefined;
  /**
   * P2.1: The role that accepted this finding. Required when `disposition === "accepted"`.
   * Must be a non-empty string.
   */
  readonly acceptedByRole?: string | undefined;
  /**
   * P2.1: The reason this finding was accepted instead of fixed. Required when
   * `disposition === "accepted"`. Must be a non-empty string. This is the
   * auditable record of the acceptance decision.
   */
  readonly acceptanceReason?: string | undefined;
}

export interface ReviewInput {
  reviewerRole: GateReviewRole;
  state: ReviewState;
  severity: ReviewSeverity;
  findings: string[];
  waiverReason?: string | undefined;
  evidenceRefs?: string[] | undefined;
  /**
   * Optional structured finding details — P1.5 additive extension.
   * When supplied, `recordReview` derives `findings` string[] from
   * `findingDetails.map(f => f.message)`. Do not double-author both.
   */
  findingDetails?: readonly ReviewFinding[] | undefined;
}

export interface ReviewActionContext {
  actor: string;
  actorRole: RetrievalRole;
}

declare const trustedReviewActionContextBrand: unique symbol;

export interface TrustedReviewActionContext extends ReviewActionContext {
  readonly [trustedReviewActionContextBrand]: true;
}

export interface MemoryPromotionInput {
  scope: MemoryScope;
  entryType: MemoryType;
  title: string;
  content: string;
  sourceRunId: string;
  sourceTaskId?: string | undefined;
  reviewer: string;
  actor: string;
  metadata?: RetrievalMetadata | undefined;
  /**
   * MPL P2: actorRole is required when entryType is "anti_pattern".
   * Validated in validateMemoryPromotion — must be "reviewer" or "security_reviewer".
   * Ignored for other entry types.
   */
  actorRole?: RetrievalRole | undefined;
}

export interface SearchMemoryInput extends ProjectRef {
  query: string;
  limit?: number | undefined;
  includeGlobal?: boolean | undefined;
  queryEmbedding?: readonly number[] | undefined;
  embeddingModel?: string | undefined;
  requesterRole?: RetrievalRole | undefined;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  repoPath?: string | undefined;
  createdAt: string;
}

export interface RuntimeProjectRegistrationRecord {
  projectId: string;
  workspaceId: string;
  repoPath: string;
  runtimeProfile: string;
  dataRoot: string;
  installManifestPath?: string | undefined;
  manifest: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeMigrationJournalRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  runId?: string | undefined;
  phase: string;
  status: string;
  backupManifestPath: string;
  verificationReportPath: string;
  rollbackState: string;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDocumentRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  runId?: string | undefined;
  taskId?: string | undefined;
  kind: WorkflowDocumentKind;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CoverageManifestThresholds {
  criticalItemCoverage?: number | undefined;
  criticalItemValidation?: number | undefined;
  callsiteCoverage?: number | undefined;
  runtimeTraceCoverage?: number | undefined;
  inventoryCompleteness?: number | undefined;
  businessRuleCoverage?: number | undefined;
  maxContradictionGapCount?: number | undefined;
  maxOpenBlockers?: number | undefined;
}

export interface CoverageManifestRecord {
  runId: string;
  profile: RunProfile;
  requiredCategories: CoverageItemCategory[];
  thresholds: CoverageManifestThresholds;
}

export interface CoverageItemRecord {
  id: string;
  category: CoverageItemCategory;
  state: CoverageItemState;
  criticality: CoverageCriticality;
  ownerAgent?: string | undefined;
  sources: string[];
  entryPoints?: string[] | undefined;
  dependencies?: string[] | undefined;
  dependents?: string[] | undefined;
  callsiteCount?: number | undefined;
  callsitesAnalyzed?: number | undefined;
  runtimeTraced?: boolean | undefined;
  behaviorSummary?: string | undefined;
  invariants?: string[] | undefined;
  businessRules?: string[] | undefined;
  sideEffects?: string[] | undefined;
  openQuestions?: string[] | undefined;
  evidenceRefs: string[];
  verificationRefs?: string[] | undefined;
  confidence?: number | undefined;
  gapScore?: number | undefined;
  lastUpdatedAt: string;
}

export interface CoverageGapRecord {
  id: string;
  targetId: string;
  kind: GapKind;
  severity: GapSeverity;
  description: string;
  blocking: boolean;
  evidenceRefs: string[];
  createdBy: string;
  suggestedNextActions: string[];
  status: GapStatus;
}

export interface ProgressProofRecord {
  cycle: number;
  proofId: string;
  phaseBefore: AnalysisPhase;
  phaseAfter: AnalysisPhase;
  evidenceRefs: string[];
  coverageDelta: Partial<Record<CoverageItemState, number>>;
  blockingGapDelta?: {
    closed?: number | undefined;
    opened?: number | undefined;
  } | undefined;
  nextTarget: string;
  whyNext?: string | undefined;
  createdAt: string;
}

export interface UnderstandingMapRecord {
  kind: string;
  itemCount: number;
  analyzedCount?: number | undefined;
  sourceRefs: string[];
  evidenceRefs: string[];
  updatedAt: string;
}

export interface RuntimeTraceCaptureInput {
  traceId?: string | undefined;
  targetId: string;
  kind: RuntimeTraceKind;
  risky: boolean;
  sideEffects: string[];
  evidenceRefs: string[];
  createdAt?: string | undefined;
}

export interface RuntimeTraceRecord {
  traceId: string;
  targetId: string;
  kind: RuntimeTraceKind;
  risky: boolean;
  sideEffects: string[];
  evidenceRefs: string[];
  createdAt: string;
  authorityLabel?: RuntimeTraceAuthorityLabel | undefined;
}

export interface RuntimeTraceRegistryTargetSummary {
  targetId: string;
  traceIds: string[];
  kinds: RuntimeTraceKind[];
  riskyTraceCount: number;
  latestCreatedAt: string;
  authorityLabels: RuntimeTraceAuthorityLabel[];
  latestAuthorityLabel: RuntimeTraceAuthorityLabel;
  freshness: "fresh" | "stale";
  sideEffects: string[];
  evidenceRefs: string[];
}

export interface RuntimeTraceRegistrySummary {
  totalTraces: number;
  riskyTraceCount: number;
  tracedTargetCount: number;
  freshnessWindowHours: number;
  referenceNow: string;
  staleTargetIds: string[];
  operatorImportTargetIds: string[];
  openMissingTraceGapIds: string[];
  riskyTargetsMissingTrace: string[];
  targets: RuntimeTraceRegistryTargetSummary[];
}

export interface DuplicateFamilyMemberRecord {
  itemId: string;
  kind: DuplicateFamilyMemberKind;
  role?: string | undefined;
  notes?: string | undefined;
}

export interface DuplicateFamilyRecord {
  familyId: string;
  capability: string;
  members: DuplicateFamilyMemberRecord[];
  sharedAbstraction?: string | undefined;
  intentionalVariants: string[];
  accidentalDivergences: string[];
  centralizationCandidate?: string | undefined;
  parityRequirements: string[];
  evidenceRefs: string[];
  verificationRefs?: string[] | undefined;
  lastUpdatedAt: string;
}

export interface ArchitectureDecisionRecord {
  decisionId: string;
  title: string;
  status: ArchitectureDecisionStatus;
  options: string[];
  chosenOption: string;
  boundedContexts: string[];
  consistencyNeeds: string[];
  rationale: string[];
  evidenceRefs: string[];
  verificationRefs?: string[] | undefined;
  lastUpdatedAt: string;
}

export interface MigrationLedgerEntryRecord {
  entryId: string;
  boundedContext: string;
  sourceModels: string[];
  targetModels: string[];
  strategy: MigrationStrategy;
  consistencyClass: MigrationConsistencyClass;
  ownership: string;
  rolloutSteps: string[];
  rollbackPlan: string[];
  evidenceRefs: string[];
  verificationRefs?: string[] | undefined;
  lastUpdatedAt: string;
}

export interface ParityRequirementRecord {
  requirementId: string;
  capability: string;
  status: ParityRequirementStatus;
  legacyRefs: string[];
  targetRefs: string[];
  acceptanceChecks: string[];
  evidenceRefs: string[];
  verificationRefs?: string[] | undefined;
  lastUpdatedAt: string;
}

export interface ExternalEvalRecord {
  evalId: string;
  label: string;
  scope: "repo_local" | "semi_external" | "external";
  harness: string;
  artifactRef: string;
  evidenceRefs: string[];
  createdAt: string;
}

export interface SensitiveActionControlRecord {
  controlId: string;
  actionType:
    | "approval"
    | "security_review"
    | "workflow_proof"
    | "checkpoint_import"
    | "continuation"
    | "waiver";
  enforcement: "authenticated_runtime" | "operator_required" | "waiver_blocked" | "manager_waiver_only";
  summary: string;
  evidenceRefs: string[];
  createdAt: string;
}

export interface CheckpointRecord {
  runId: string;
  checkpointId: string;
  authorityLabel: "runtime_authoritative" | "operator_import";
  phase: AnalysisPhase;
  executionEpoch?: number | undefined;
  activeTargets: string[];
  recentEvidenceRefs: string[];
  openGaps: string[];
  nextActions: string[];
  compressedContextRef?: string | undefined;
  compressedContextSummary?: string | undefined;
  compressedContextSourceRefs?: string[] | undefined;
  compressedContextGeneratedAt?: string | undefined;
  createdAt: string;
}

export interface CoverageSummary {
  totalItems: number;
  discoveredItems: number;
  partiallyAnalyzedItems: number;
  fullyAnalyzedItems: number;
  validatedItems: number;
  migratedItems: number;
  blockedItems: number;
  criticalItemCoverage: number;
  criticalItemValidation: number;
  callsiteCoverage: number;
  runtimeTraceCoverage: number;
  openGapCount: number;
  blockingGapCount: number;
}

export interface ComprehensionSummary {
  inventoryCompleteness: number;
  businessRuleCoverage: number;
  duplicateFamilyCount: number;
  duplicateFamilyMemberCount: number;
  centralizationCandidateCount: number;
  architectureDecisionCount: number;
  migrationLedgerCount: number;
  parityRequirementCount: number;
  contradictionGapCount: number;
  openBlockerCount: number;
  requiredUnderstandingKinds: UnderstandingMapKind[];
  presentUnderstandingKinds: UnderstandingMapKind[];
  missingUnderstandingKinds: UnderstandingMapKind[];
  requiredArtifactKinds: UnderstandingMapKind[];
  presentArtifactKinds: UnderstandingMapKind[];
  missingArtifactKinds: UnderstandingMapKind[];
  runtimeTraceCount: number;
  readinessScope: ComprehensionReadinessScope;
  rewriteReadiness: RewriteReadinessStatus;
  profileLimitations: string[];
  missingEvidence: string[];
}

export interface PhaseReadinessRecord {
  phase: AnalysisPhase;
  status: PhaseReadinessStatus;
  reasons: string[];
  transition?: PhaseReadinessTransition | undefined;
  blockerKind?: PhaseReadinessBlockerKind | undefined;
  nextPhase?: AnalysisPhase | undefined;
  fallbackPhase?: AnalysisPhase | undefined;
  continuationScore?: number | undefined;
  latestCheckpointId?: string | undefined;
  staleCheckpoint?: boolean | undefined;
  executionEpoch?: number | undefined;
  retryBudgetRemaining?: number | undefined;
}

export interface AutonomousExecutionState {
  enabled: boolean;
  profile: RunProfile;
  phase: AnalysisPhase;
  manifest?: CoverageManifestRecord | undefined;
  coverageItems: CoverageItemRecord[];
  gaps: CoverageGapRecord[];
  checkpoints: CheckpointRecord[];
  progressProofs: ProgressProofRecord[];
  understandingMaps?: UnderstandingMapRecord[] | undefined;
  runtimeTraces?: RuntimeTraceRecord[] | undefined;
  duplicateFamilies?: DuplicateFamilyRecord[] | undefined;
  architectureDecisions?: ArchitectureDecisionRecord[] | undefined;
  migrationLedger?: MigrationLedgerEntryRecord[] | undefined;
  parityMatrix?: ParityRequirementRecord[] | undefined;
  externalEvals?: ExternalEvalRecord[] | undefined;
  sensitiveActionControls?: SensitiveActionControlRecord[] | undefined;
  pendingInvestigations: string[];
  executionEpoch: number;
  lastCheckpointId?: string | undefined;
  lastSuccessfulCheckpointId?: string | undefined;
  lastProgressProofId?: string | undefined;
  recoveryReason?: string | undefined;
  retryBudgetRemaining?: number | undefined;
  updatedAt: string;
}

export interface AutonomousExecutionSnapshot {
  state: AutonomousExecutionState;
  coverageSummary: CoverageSummary;
  comprehensionSummary?: ComprehensionSummary | undefined;
  phaseReadiness: PhaseReadinessRecord;
  blockingGaps: CoverageGapRecord[];
}

export interface ProjectRuntimeMetadata extends Record<string, unknown> {
  autonomousExecution?: AutonomousExecutionState | undefined;
  seedFailure?:
    | {
        runId: string;
        taskId: string;
        reason: string;
        failedAt?: string | undefined;
        recoveryState: "requires_reproof" | "stale_metadata";
      }
    | undefined;
  lastIntegrityRepair?:
    | {
        source: "doctor_repair" | "recover_apply" | "reconcile_runtime_state" | "sync_runtime_exports";
        kind:
          | "local_export_resync"
          | "runtime_metadata_cleanup"
          | "runtime_task_reconcile"
          | "recovery_action_apply";
        summary: string;
        repairedAt: string;
      }
    | undefined;
  archonDaemon?: {
    sessionId?: string | undefined;
    /** Phase 2 (ahrP2ResetOnHandoff): true when session was just reset by a
     * handoff. Cleared to false in the first saveProjectRuntimeState write of
     * the fresh continuation turn. ARCH-C3: must be set in the same write as
     * sessionId=undefined. */
    justHandedOff?: boolean | undefined;
    /** Phase 3 (ahrP3RespawnBudget): number of respawns consumed for the task
     * identified by respawnTaskId. Incremented atomically with justHandedOff in
     * the ARCH-C3 reset write. Forwarded (carried through) on every normal-path
     * (non-reset) turn so the counter survives productive turns — i.e. this is a
     * per-task-lifetime counter, not a max-consecutive counter. Reset to undefined
     * (by omitting the field) ONLY when the active task changes
     * (respawnTaskId !== current activeTaskId). */
    respawnCount?: number | undefined;
    /** Phase 3 (ahrP3RespawnBudget): the task ID the respawnCount is scoped to.
     * When this differs from the current activeTaskId the counter is stale and
     * must be treated as 0. */
    respawnTaskId?: string | undefined;
    lastRunId?: string | undefined;
    lastTaskId?: string | undefined;
    lastDirectiveKind?: string | undefined;
    lastPromptTaskId?: string | undefined;
    lastPromptPacketFingerprint?: string | undefined;
    lastPromptMode?: "full" | "delta" | undefined;
    updatedAt: string;
  } | undefined;
}

export interface ProjectRuntimeStateRecord {
  projectId: string;
  workspaceId: string;
  activeRunId?: string | undefined;
  activeTaskId?: string | undefined;
  taskQueue: TaskQueue;
  productState: Record<string, unknown>;
  lastVerifiedRunId?: string | undefined;
  metadata: ProjectRuntimeMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actor: string;
  title: string;
  request: string;
  summary: IntakeSummary;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PlanArtifact {
  id: string;
  runId: string;
  kind: "plan";
  title: string;
  content: PlanInput;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  runId: string;
  workspaceId: string;
  projectId: string;
  /** Immutable task class set once at INSERT. Never changes after creation. */
  class: TaskClass;
  packet: TaskPacketInput;
  status: TaskStatus;
  claimedBy?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface LockRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  taskId: string;
  scopePaths: string[];
  status: "active" | "released";
  createdAt: string;
  releasedAt?: string | undefined;
}

export interface HandoffRecord {
  id: string;
  runId: string;
  taskId: string;
  actor: string;
  ownerRole: RetrievalRole;
  completionStandard: CompletionStandard;
  summary: string;
  changedFiles: string[];
  blockers: string[];
  verificationNotes: string[];
  executionEvidence: string[];
  qualityGateEvidence: string[];
  contextRefs: string[];
  createdAt: string;
}

export interface ReviewRecord {
  id: string;
  runId: string;
  taskId: string;
  reviewerRole: GateReviewRole;
  actor: string;
  actorRole: RetrievalRole;
  source: ReviewSource;
  state: ReviewState;
  severity: ReviewSeverity;
  findings: string[];
  waiverReason?: string | undefined;
  evidenceRefs?: string[] | undefined;
  createdAt: string;
  /**
   * Optional structured finding details — P1.5 additive extension, extended by P2.1.
   * When `state === "passed"` and `findings` is non-empty, the gate reads this
   * field to verify that every finding is fully accepted (disposition=accepted,
   * non-empty gate-review acceptedByRole + acceptanceReason, severity exactly 'low' or 'medium').
   * When `findings` is empty, this field is metadata-only for the mistake ledger.
   */
  findingDetails?: readonly ReviewFinding[] | undefined;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  taskId: string;
  actor: string;
  actorRole: RetrievalRole;
  source: ReviewSource;
  decision: ApprovalDecision;
  rationale: string;
  createdAt: string;
}

/** Immutable audit row written when a review-floor reduction occurs (Option B, slice 3). */
export interface ReviewFloorReductionRecord {
  id: string;
  runId: string;
  taskId: string;
  derivedClass: string;
  droppedRoles: string[];
  effectiveFloor: string[];
  writeScopeSnapshot: string[];
  basis: string;
  source: string;
  decidedAt: string;
}

export interface MemoryEntryRecord {
  id: string;
  workspaceId: string;
  projectId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  scope: MemoryScope;
  entryType: MemoryType;
  title: string;
  content: string;
  reviewer: string;
  actor: string;
  status: MemoryStatus;
  sourcePath?: string | undefined;
  sourceAnchor?: string | undefined;
  metadata: RetrievalMetadata;
  createdAt: string;
}

export interface SearchMemoryAuthority {
  source: "shared_backend_memory" | "repo_artifact" | "runtime_document";
  precedence: "retrieval_hint" | "repo_context" | "runtime_context";
  scope: MemoryScope;
  reviewedBy?: string | undefined;
  authorityLevel?: RetrievalMetadata["authorityLevel"];
  allowedRoles: RetrievalRole[];
}

export interface SearchMemoryFreshness {
  status: "fresh" | "stale" | "invalid_timestamp" | "future_timestamp";
  createdAt: string;
  ageDays?: number | undefined;
  staleAfterDays: number;
}

export interface SearchMemoryCitation {
  kind: "memory_entry" | "artifact" | "workflow_document";
  memoryId?: string | undefined;
  artifactId?: string | undefined;
  documentId?: string | undefined;
  label: string;
  sourcePath?: string | undefined;
  sourceAnchor?: string | undefined;
  canonicalRef: string;
  runId?: string | undefined;
  taskId?: string | undefined;
}

export interface SearchMemoryProvenance {
  entryType?: MemoryType | undefined;
  artifactKind?: ArtifactKind | undefined;
  actor?: string | undefined;
  reviewer?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  createdAt: string;
}

export interface SearchMemoryMetadata {
  allowedRoles: RetrievalRole[];
  tags: string[];
  reviewedAt?: string | undefined;
  staleAfterDays: number;
  supersededBy: string[];
  contradicts: string[];
}

export interface SearchMemoryResult {
  id: string;
  title: string;
  content: string;
  scope: MemoryScope;
  projectSlug?: string | undefined;
  score: number;
  authority: SearchMemoryAuthority;
  freshness: SearchMemoryFreshness;
  citation: SearchMemoryCitation;
  provenance: SearchMemoryProvenance;
  metadata: SearchMemoryMetadata;
  conflict: {
    detected: boolean;
    relatedIds: string[];
  };
}

export interface MarkdownArtifactRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  kind: "markdown_chunk";
  title: string;
  content: string;
  sourcePath: string;
  sourceAnchor?: string | undefined;
  metadata: MarkdownArtifactMetadata;
  createdAt: string;
}

export interface RunStatusSnapshot {
  run: RunRecord;
  plan?: PlanArtifact | undefined;
  tasks: TaskRecord[];
  activeLocks: LockRecord[];
  blockers: string[];
  nextTaskIds: string[];
  autonomousExecution?: AutonomousExecutionSnapshot | undefined;
}

export interface BaseExecutionDirective {
  kind: ExecutionDirectiveKind;
  rationale: string[];
}

export interface CompleteExecutionDirective extends BaseExecutionDirective {
  kind: "complete";
}

export interface DispatchOwnerExecutionDirective extends BaseExecutionDirective {
  kind: "dispatch_owner";
  recommendation: RoutingRecommendation;
}

export interface DispatchReviewsExecutionDirective extends BaseExecutionDirective {
  kind: "dispatch_reviews";
  recommendations: RoutingRecommendation[];
}

export interface ApplyRecoveryExecutionDirective extends BaseExecutionDirective {
  kind: "apply_recovery";
  actions: RecoveryAction[];
}

export interface RebuildInventoryExecutionDirective extends BaseExecutionDirective {
  kind: "rebuild_inventory";
  missingUnderstandingKinds: UnderstandingMapKind[];
  missingEvidence: string[];
  blockers: string[];
  nextActions: string[];
}

export interface TraceRuntimeExecutionDirective extends BaseExecutionDirective {
  kind: "trace_runtime";
  targetIds: string[];
  gapIds: string[];
  blockers: string[];
  nextActions: string[];
}

export interface CheckpointExecutionDirective extends BaseExecutionDirective {
  kind: "checkpoint";
  checkpointId?: string | undefined;
  progressProofId?: string | undefined;
  blockers: string[];
  nextActions: string[];
}

export interface DispatchSubagentsExecutionDirective extends BaseExecutionDirective {
  kind: "dispatch_subagents";
  pendingInvestigations: string[];
  blockers: string[];
  nextActions: string[];
}

export interface ReplanMigrationExecutionDirective extends BaseExecutionDirective {
  kind: "replan_migration";
  phase: AnalysisPhase;
  fallbackPhase?: AnalysisPhase | undefined;
  blockers: string[];
  nextActions: string[];
}

export interface ResolveBlockingGapContinuationAction {
  kind: "resolve_blocking_gap";
  gapId: string;
  targetId: string;
}

export interface RunWorkflowProofContinuationAction {
  kind: "run_workflow_proof";
  taskId: string;
}

export interface ResumeTargetContinuationAction {
  kind: "resume_target";
  targetId: string;
  source: "blocking_gap" | "progress_proof" | "checkpoint";
  sourceId?: string | undefined;
}

export type ContinuationAction =
  | ResolveBlockingGapContinuationAction
  | RunWorkflowProofContinuationAction
  | ResumeTargetContinuationAction;

export interface ContinueAnalysisExecutionDirective extends BaseExecutionDirective {
  kind: "continue_analysis";
  targetId: string;
  source: "blocking_gap" | "progress_proof" | "checkpoint";
  actions: ContinuationAction[];
  nextActions: string[];
  blockers: string[];
}

export interface BlockedExecutionDirective extends BaseExecutionDirective {
  kind: "blocked";
  blockers: string[];
}

export type RunExecutionDirective =
  | CompleteExecutionDirective
  | DispatchOwnerExecutionDirective
  | DispatchReviewsExecutionDirective
  | ApplyRecoveryExecutionDirective
  | DispatchSubagentsExecutionDirective
  | RebuildInventoryExecutionDirective
  | TraceRuntimeExecutionDirective
  | CheckpointExecutionDirective
  | ReplanMigrationExecutionDirective
  | ContinueAnalysisExecutionDirective
  | BlockedExecutionDirective;

export interface RunExecutionPlan {
  mode: "runtime_authoritative";
  runId: string;
  runStatus: RunStatus;
  directive: RunExecutionDirective;
  autonomousExecution?: AutonomousExecutionSnapshot | undefined;
}

export interface RunResumeSnapshot extends RunStatusSnapshot {
  executionPlan: RunExecutionPlan;
}

export interface RoutingRecommendation {
  taskId: string;
  taskStatus: TaskStatus;
  recommendation: RoutingRecommendationKind;
  authorityLabel: "derived_only";
  targetRole?: RetrievalRole | undefined;
  targetReviewRole?: GateReviewRole | undefined;
  rationale: string[];
  blockers: string[];
  allowedWriteScope: string[];
  retrievalGuidance: string[];
  approvalCheckpoints: string[];
}

export interface RoutingRecommendationReport {
  mode: "advisory_only";
  runId: string;
  recommendations: RoutingRecommendation[];
}

export interface RecoveryIssue {
  id: string;
  authorityLabel: "derived_only";
  kind: RecoveryIssueKind;
  taskId?: string | undefined;
  lockTaskId?: string | undefined;
  ageHours?: number | undefined;
  details: string[];
  suggestedActionIds: string[];
}

export interface RecoveryAction {
  id: string;
  authorityLabel: "derived_only";
  kind: RecoveryActionKind;
  taskId?: string | undefined;
  safeToApply: boolean;
  rationale: string[];
}

export interface RecoveryInspectionReport {
  mode: "advisory_only";
  runId: string;
  staleAfterHours: number;
  issues: RecoveryIssue[];
  actions: RecoveryAction[];
  summary: {
    totalIssues: number;
    safeActions: number;
    blockedTasks: string[];
    staleTaskIds: string[];
    orphanLockTaskIds: string[];
  };
}

export interface RecoveryApplyResult {
  mode: "applied";
  runId: string;
  appliedActionIds: string[];
  skippedActionIds: string[];
  snapshot: RunStatusSnapshot;
}

// ---------------------------------------------------------------------------
// Agentic Loop Runtime — Phase 1 type aliases
// ---------------------------------------------------------------------------

export type AgentKind = (typeof agentKinds)[number];
export type AgentInvocationStatus = (typeof agentInvocationStatuses)[number];
export type HandoffReason = (typeof handoffReasons)[number];
export type ContextSampleSource = (typeof contextSampleSources)[number];
export type DebateMode = (typeof debateModes)[number];

// ---------------------------------------------------------------------------
// Agentic Loop Runtime — Phase 1 interfaces
// ---------------------------------------------------------------------------

export interface AgentInvocation {
  id: string;
  runId: string;
  taskId: string;
  parentInvocationId?: string | undefined;
  role: string;
  agentKind: AgentKind;
  model: string;
  effort: string;
  status: AgentInvocationStatus;
  contextPolicyId: string;
  sessionId?: string | undefined;
  transcriptPath?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  metadata: Record<string, unknown>;
}

export interface ContextSample {
  id?: number | undefined;
  invocationId: string;
  runId: string;
  taskId: string;
  source: ContextSampleSource;
  usedPercentage?: number | undefined;
  remainingPercentage?: number | undefined;
  currentUsageTokens?: number | undefined;
  contextWindowSize?: number | undefined;
  sampledAt: string;
  raw: Record<string, unknown>;
}

export interface HandoffScopeBlock {
  allowedWriteScope: string[];
  touchedPaths: string[];
  lockedPaths?: string[] | undefined;
}

export interface HandoffDecision {
  decision: string;
  rationale: string;
}

export interface HandoffRisk {
  severity: "low" | "medium" | "high" | "critical";
  risk: string;
  mitigation: string;
}

export interface HandoffSubagentResult {
  subtaskId: string;
  role: string;
  status: string;
  summary: string;
}

export interface HandoffPacket {
  schemaVersion: 1;
  handoffId: string;
  runId: string;
  taskId: string;
  fromInvocationId: string;
  fromRole: string;
  toRole: string;
  reason: HandoffReason;
  contextUsedPct?: number | undefined;
  status: string;
  summary: string;
  scope: HandoffScopeBlock;
  decisions: HandoffDecision[];
  openQuestions: string[];
  evidenceRefs: string[];
  nextActions: string[];
  risks: HandoffRisk[];
  subagentResults?: HandoffSubagentResult[] | undefined;
  createdAt: string;
}

export interface Subtask {
  id: string;
  runId: string;
  taskId: string;
  parentInvocationId: string;
  childInvocationId?: string | undefined;
  subagentType: string;
  title: string;
  prompt: string;
  allowedTools: string[];
  allowedWriteScope: string[];
  status: string;
  resultPacket?: Record<string, unknown> | undefined;
  createdAt: string;
  completedAt?: string | undefined;
}

export interface DebateSession {
  id: string;
  runId: string;
  taskId?: string | undefined;
  topic: string;
  triggerKind: string;
  status: string;
  decision?: Record<string, unknown> | undefined;
  createdAt: string;
  completedAt?: string | undefined;
}

export interface DebateArgument {
  id: string;
  debateSessionId: string;
  round: number;
  role: string;
  position: string;
  evidenceRefs: string[];
  critiques: string[];
  vote?: string | undefined;
  createdAt: string;
}

export interface ContextPolicy {
  policyId: string;
  handoffPct: number;
  warningPct: number;
  hardStopPct: number;
  maxTurns?: number | undefined;
  maxOutputTokens?: number | undefined;
  appliesTo: "all_archon_agents";
}

export interface AgentSpawnPolicy {
  canSpawnSubagents: boolean;
  allowedSubagentTypes: readonly string[];
  maxChildDepth: number;
  maxConcurrentChildren: number;
  maxTotalChildrenPerTask: number;
  requiresWorktreeIsolation?: boolean | undefined;
}
