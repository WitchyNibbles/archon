import {
  type HandoffInput,
  type GateReviewRole,
  type IntakeRequestInput,
  type IntakeSummary,
  type MemoryPromotionInput,
  type PlanInput,
  type ReviewInput,
  type ReviewRecord,
  type TrustedReviewActionContext,
  type RetrievalMetadata,
  type RetrievalRole,
  type SearchMemoryInput,
  type StopGoDecision,
  type CompletionStandard,
  type ReasoningConfidenceLevel,
  type ReasoningDecision,
  type ReasoningPolicy,
  type ReasoningQualityBlock,
  type ReasoningAttempt,
  type ReasoningVerification,
  type ReasoningVerdict,
  type QualityGate,
  type UiSurface,
  completionStandards,
  qualityGates,
  reasoningAttemptOutcomes,
  reasoningConfidenceLevels,
  reasoningDecisions,
  reasoningVerificationKinds,
  reasoningVerificationStatuses,
  reasoningVerdictStatuses,
  reasoningWorkflowModes,
  reviewSeverities,
  reviewStates,
  requiredGateReviews,
  uiSurfaces,
  retrievalRoles,
  stopGoDecisions,
  type TaskPacketInput,
  type TaskRecord
} from "./types.ts";
import { isTrustedReviewActionContext } from "../core/review-context.ts";
import { isOptOutClass, scopeIsReviewSafe } from "./task-class.ts";

const maxQueryEmbeddingDimensions = 1536;
const retrievalRoleSet = new Set<string>(retrievalRoles);
const requiredGateReviewSet = new Set<string>(requiredGateReviews);
const reviewSeveritySet = new Set<string>(reviewSeverities);
const reviewStateSet = new Set<string>(reviewStates);
const completionStandardSet = new Set<string>(completionStandards);
const uiSurfaceSet = new Set<string>(uiSurfaces);
const qualityGateSet = new Set<string>(qualityGates);
const reasoningConfidenceSet = new Set<string>(reasoningConfidenceLevels);
const reasoningDecisionSet = new Set<string>(reasoningDecisions);
const reasoningWorkflowModeSet = new Set<string>(reasoningWorkflowModes);
const reasoningVerdictStatusSet = new Set<string>(reasoningVerdictStatuses);
const reasoningAttemptOutcomeSet = new Set<string>(reasoningAttemptOutcomes);
const reasoningVerificationKindSet = new Set<string>(reasoningVerificationKinds);
const reasoningVerificationStatusSet = new Set<string>(reasoningVerificationStatuses);
const managerWaiverRoles = new Set<RetrievalRole>(["planner", "solution_architect"]);

export const DEFAULT_RETRIEVAL_ROLE: RetrievalRole = "planner";

export interface NormalizedRetrievalMetadata extends RetrievalMetadata {
  retrievalRoles: RetrievalRole[];
  tags: string[];
  supersededBy: string[];
  contradicts: string[];
}

function nonEmptyItems(values: readonly string[] | undefined, fallback: string[] = []): string[] {
  if (!values) {
    return [...fallback];
  }

  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function deriveGoal(input: IntakeRequestInput): string {
  if (input.goal && input.goal.trim().length > 0) {
    return input.goal.trim();
  }

  if (input.title.trim().length > 0) {
    return input.title.trim();
  }

  return input.request.trim().slice(0, 160);
}

function deriveStopGo(summary: Omit<IntakeSummary, "stopGo">): StopGoDecision {
  const hardStopRisk = summary.risks.some((risk) =>
    /(payment|production data|delete|credential|authz|deploy|security-sensitive)/i.test(risk)
  );
  const pendingClarifications = (summary.clarifyingQuestions?.length ?? 0) > 0;

  if (hardStopRisk) {
    return "needs_review";
  }

  if (summary.unknowns.length > 0 || pendingClarifications) {
    return "needs_review";
  }

  return "go";
}

function uniqueTrimmedItems(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const items: string[] = [];

  for (const value of values ?? []) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    items.push(normalized);
  }

  return items;
}

function duplicateTrimmedItems(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values ?? []) {
    const normalized = value.trim();
    if (normalized.length === 0) {
      continue;
    }

    if (seen.has(normalized)) {
      duplicates.add(normalized);
      continue;
    }

    seen.add(normalized);
  }

  return [...duplicates];
}

function isBroadDirectionRequest(input: IntakeRequestInput): boolean {
  const text = [input.title, input.goal, input.request].filter((value): value is string => Boolean(value)).join(" ");
  return /\b(build|create|implement|design|redesign|improve|refactor|rewrite|migrate|workflow|platform|system|onboarding)\b/i.test(
    text
  );
}

function deriveClarifyingQuestions(
  input: IntakeRequestInput,
  summaryBase: Omit<IntakeSummary, "stopGo" | "clarifyingQuestions" | "assumptions">
): string[] {
  if (input.clarifyingQuestions) {
    return uniqueTrimmedItems(input.clarifyingQuestions);
  }

  if (summaryBase.unknowns.length === 0) {
    return [];
  }

  const questions: string[] = [];
  const broadDirection = isBroadDirectionRequest(input);
  const missingOutcome = !input.goal?.trim() || (input.successCriteria?.length ?? 0) === 0;
  const missingAudience = (input.audience?.length ?? 0) === 0;
  const missingGuardrails = (input.constraints?.length ?? 0) === 0 && (input.outOfScope?.length ?? 0) === 0;

  if (missingOutcome) {
    questions.push("What concrete outcome should count as done for this request?");
  }
  if (broadDirection && missingAudience) {
    questions.push("Who is the primary user or operator this work should optimize for?");
  }
  if (missingGuardrails) {
    questions.push("What constraints or non-goals must remain fixed while Archon implements this?");
  }
  if (broadDirection) {
    questions.push("Which slice should Archon deliver first if the request needs to stay narrowly scoped?");
  }

  return questions.slice(0, 4);
}

function deriveAssumptions(input: IntakeRequestInput, clarifyingQuestions: readonly string[]): string[] {
  if (input.assumptions) {
    return uniqueTrimmedItems(input.assumptions);
  }

  if (clarifyingQuestions.length > 0) {
    return [];
  }

  return ["No additional operating assumptions were recorded during intake."];
}

export function isRetrievalRole(value: string): value is RetrievalRole {
  return retrievalRoleSet.has(value);
}

export function isGateReviewRole(value: string): value is GateReviewRole {
  return requiredGateReviewSet.has(value);
}

export function isReviewSeverity(value: string): value is ReviewInput["severity"] {
  return reviewSeveritySet.has(value);
}

export function isReviewState(value: string): value is ReviewInput["state"] {
  return reviewStateSet.has(value);
}

export function isCompletionStandard(value: string): value is CompletionStandard {
  return completionStandardSet.has(value);
}

export function isUiSurface(value: string): value is UiSurface {
  return uiSurfaceSet.has(value);
}

export function isReasoningConfidenceLevel(value: string): value is ReasoningConfidenceLevel {
  return reasoningConfidenceSet.has(value);
}

export function isReasoningDecision(value: string): value is ReasoningDecision {
  return reasoningDecisionSet.has(value);
}

export function isReasoningWorkflowMode(value: string): value is ReasoningPolicy["mode"] {
  return reasoningWorkflowModeSet.has(value);
}

export function isQualityGate(value: string): value is QualityGate {
  return qualityGateSet.has(value);
}

export function deriveTaskPacketUiSurface(packet: Pick<TaskPacketInput, "uiSurface">): UiSurface {
  return packet.uiSurface ?? "none";
}

export function isPlaywrightRequiredForTask(
  packet: Pick<TaskPacketInput, "uiSurface" | "playwrightRequired">
): boolean {
  if (packet.playwrightRequired !== undefined) {
    return packet.playwrightRequired;
  }

  return deriveTaskPacketUiSurface(packet) !== "none";
}

function validateReasoningPolicy(policy: ReasoningPolicy | undefined, label: string): string[] {
  if (!policy) {
    return [];
  }

  const errors: string[] = [];
  if (!isReasoningWorkflowMode(policy.mode)) {
    errors.push(`${label}.mode must be one of: ${reasoningWorkflowModes.join(", ")}`);
  }

  if (policy.maxAttempts !== undefined) {
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 0) {
      errors.push(`${label}.maxAttempts must be a non-negative integer`);
    }
  }

  return errors;
}

function validateReasoningAttempt(attempt: ReasoningAttempt, label: string): string[] {
  const errors: string[] = [];
  if (attempt.id.trim().length === 0) {
    errors.push(`${label}.id is required`);
  }
  if (attempt.label.trim().length === 0) {
    errors.push(`${label}.label is required`);
  }
  if (attempt.hypothesis.trim().length === 0) {
    errors.push(`${label}.hypothesis is required`);
  }
  if (uniqueTrimmedItems(attempt.evidenceRefs).length !== attempt.evidenceRefs.length) {
    errors.push(`${label}.evidenceRefs must not contain empty or duplicate values`);
  }
  if (uniqueTrimmedItems(attempt.verificationRefs).length !== attempt.verificationRefs.length) {
    errors.push(`${label}.verificationRefs must not contain empty or duplicate values`);
  }
  if (
    attempt.alternatives &&
    uniqueTrimmedItems(attempt.alternatives).length !== attempt.alternatives.length
  ) {
    errors.push(`${label}.alternatives must not contain empty or duplicate values`);
  }
  if (attempt.summary.trim().length === 0) {
    errors.push(`${label}.summary is required`);
  }
  if (!reasoningAttemptOutcomeSet.has(attempt.outcome)) {
    errors.push(`${label}.outcome must be one of: ${reasoningAttemptOutcomes.join(", ")}`);
  }
  return errors;
}

function validateReasoningVerification(verification: ReasoningVerification, label: string): string[] {
  const errors: string[] = [];
  if (verification.id.trim().length === 0) {
    errors.push(`${label}.id is required`);
  }
  if (!reasoningVerificationKindSet.has(verification.kind)) {
    errors.push(`${label}.kind must be one of: ${reasoningVerificationKinds.join(", ")}`);
  }
  if (verification.ref.trim().length === 0) {
    errors.push(`${label}.ref is required`);
  }
  if (!reasoningVerificationStatusSet.has(verification.status)) {
    errors.push(`${label}.status must be one of: ${reasoningVerificationStatuses.join(", ")}`);
  }
  if (verification.summary.trim().length === 0) {
    errors.push(`${label}.summary is required`);
  }
  return errors;
}

function validateReasoningVerdict(verdict: ReasoningVerdict | undefined, label: string): string[] {
  if (!verdict) {
    return [];
  }

  const errors: string[] = [];
  if (!reasoningVerdictStatusSet.has(verdict.status)) {
    errors.push(`${label}.status must be one of: ${reasoningVerdictStatuses.join(", ")}`);
  }
  if (verdict.summary.trim().length === 0) {
    errors.push(`${label}.summary is required`);
  }
  if (
    uniqueTrimmedItems(verdict.supportingAttemptIds).length !== verdict.supportingAttemptIds.length
  ) {
    errors.push(`${label}.supportingAttemptIds must not contain empty or duplicate values`);
  }
  if (
    verdict.blockingIssues &&
    uniqueTrimmedItems(verdict.blockingIssues).length !== verdict.blockingIssues.length
  ) {
    errors.push(`${label}.blockingIssues must not contain empty or duplicate values`);
  }
  return errors;
}

// Waiver capability is derived from the actor role recorded by the orchestrator:
// manager-track roles (planner, solution_architect) may waive reviewer and qa gates;
// only the security_reviewer role may waive the security gate.
export function canActorWaiveReview(input: {
  actorRole: RetrievalRole;
  reviewerRole: GateReviewRole;
}): boolean {
  if (input.reviewerRole === "security_reviewer") {
    return input.actorRole === "security_reviewer";
  }

  return managerWaiverRoles.has(input.actorRole);
}

export function defaultRetrievalRoles(): RetrievalRole[] {
  return [...retrievalRoles];
}

export function effectiveRequiredReviews(requiredReviews: readonly GateReviewRole[] | undefined): GateReviewRole[] {
  const effective = new Set<GateReviewRole>(requiredGateReviews);
  for (const role of requiredReviews ?? []) {
    if (isGateReviewRole(role)) {
      effective.add(role);
    }
  }
  return [...effective];
}

// Option B review-floor relaxation (slice 4). Pure functions — no side effects.

export interface ReviewFloorReductionOptions {
  reductionEnabled?: boolean | undefined;
  env?: Record<string, string | undefined> | undefined;
}

// Single source of truth for "is this task's review floor reduced?". A reduction
// applies ONLY when ALL of:
//   1. reductionEnabled (options.reductionEnabled, else env.ARCHON_REVIEW_FLOOR_REDUCTION in {"1","true"})
//   2. task.class is in OPT_OUT_TASK_CLASSES
//   3. scopeIsReviewSafe(task.packet.allowedWriteScope)
// Both the gate predicate (effectiveRequiredReviewsForTask) and the provenance
// write call this, so the floor decision and its audit row can never drift
// (condition 5: a reduction must always be accompanied by a durable row).
export function isReviewFloorReduced(task: TaskRecord, options?: ReviewFloorReductionOptions): boolean {
  const env = options?.env ?? process.env;
  const flagValue = env.ARCHON_REVIEW_FLOOR_REDUCTION?.trim();
  const reductionEnabled = options?.reductionEnabled ?? (flagValue === "1" || flagValue === "true");
  return reductionEnabled && isOptOutClass(task.class) && scopeIsReviewSafe(task.packet.allowedWriteScope);
}

// Returns the effective review-floor for a task at gate-evaluation time. This is
// the single chokepoint for all three gate sites — callers MUST NOT call
// effectiveRequiredReviews(task.packet.requiredReviews) at gate sites.
export function effectiveRequiredReviewsForTask(
  task: TaskRecord,
  options?: ReviewFloorReductionOptions
): GateReviewRole[] {
  // Reduced floor is flat [reviewer]. We deliberately do NOT union
  // task.packet.requiredReviews here: the only gate roles ARE the trio
  // (requiredGateReviews), and validateTaskPacket forces every validated packet
  // to store all three — so unioning would re-add security_reviewer + qa_engineer
  // and silently nullify the reduction. There are no "extra" roles to preserve.
  if (isReviewFloorReduced(task, options)) {
    return ["reviewer"];
  }

  // Non-reduced path: the existing trio-or-more additive behavior.
  const effective = new Set<GateReviewRole>(requiredGateReviews);
  for (const role of task.packet.requiredReviews ?? []) {
    if (isGateReviewRole(role)) {
      effective.add(role);
    }
  }
  return [...effective];
}

export function normalizeRetrievalMetadata(metadata?: RetrievalMetadata): NormalizedRetrievalMetadata {
  const retrievalRoleValues = uniqueTrimmedItems(metadata?.retrievalRoles)
    .filter(isRetrievalRole);

  return {
    ...metadata,
    retrievalRoles: retrievalRoleValues.length > 0 ? retrievalRoleValues : defaultRetrievalRoles(),
    tags: uniqueTrimmedItems(metadata?.tags),
    supersededBy: uniqueTrimmedItems(metadata?.supersededBy),
    contradicts: uniqueTrimmedItems(metadata?.contradicts)
  };
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function normalizeIntakeRequest(input: IntakeRequestInput): IntakeSummary {
  const summaryBase = {
    goal: deriveGoal(input),
    audience: nonEmptyItems(input.audience, ["repo owner", "specialist agents"]),
    constraints: nonEmptyItems(input.constraints, ["Preserve repo-local reviewed policy in git"]),
    risks: nonEmptyItems(input.risks, ["Trust boundaries require explicit review"]),
    unknowns: nonEmptyItems(input.unknowns, ["Final implementation details need planner review"]),
    successCriteria: nonEmptyItems(input.successCriteria, [
      "A planner-approved task graph exists",
      "Security and QA gates are explicit"
    ]),
    outOfScope: nonEmptyItems(input.outOfScope, ["Unreviewed production changes"]),
    trustBoundaries: nonEmptyItems(input.trustBoundaries, [
      "Repo markdown is reviewed policy",
      "Shared backend owns orchestration state"
    ]),
    destructiveActions: nonEmptyItems(input.destructiveActions),
    externalIntegrations: nonEmptyItems(input.externalIntegrations)
  };
  const clarifyingQuestions = deriveClarifyingQuestions(input, summaryBase);
  const assumptions = deriveAssumptions(input, clarifyingQuestions);

  return {
    ...summaryBase,
    clarifyingQuestions,
    assumptions,
    stopGo: deriveStopGo({
      ...summaryBase,
      clarifyingQuestions,
      assumptions
    })
  };
}

function uniqueTrimmedOptionalItems(values: readonly string[] | undefined): string[] {
  return uniqueTrimmedItems(values);
}

export function validateReasoningQualityBlock(
  block: ReasoningQualityBlock | undefined,
  input: { label: string; requireEvidenceRefs?: boolean | undefined } = { label: "reasoningQuality" }
): string[] {
  if (!block) {
    return [];
  }

  const errors: string[] = [];
  const label = input.label;
  const facts = uniqueTrimmedOptionalItems(block.facts);
  const assumptions = uniqueTrimmedItems(block.assumptions);
  const hypotheses = uniqueTrimmedItems(block.hypotheses);
  const evidenceRefs = uniqueTrimmedItems(block.evidenceRefs);
  const counterEvidence = uniqueTrimmedOptionalItems(block.counterEvidence);
  const openQuestions = uniqueTrimmedOptionalItems(block.openQuestions);
  const verificationPlan = uniqueTrimmedItems(block.verificationPlan);
  const fallbacks = uniqueTrimmedOptionalItems(block.fallbacks);

  if (block.claim.trim().length === 0) {
    errors.push(`${label}.claim is required`);
  }

  if (facts.length !== (block.facts?.length ?? 0)) {
    errors.push(`${label}.facts must not contain empty or duplicate values`);
  }

  if (assumptions.length !== block.assumptions.length) {
    errors.push(`${label}.assumptions must not contain empty or duplicate values`);
  }

  if (hypotheses.length !== block.hypotheses.length) {
    errors.push(`${label}.hypotheses must not contain empty or duplicate values`);
  }

  if (evidenceRefs.length !== block.evidenceRefs.length) {
    errors.push(`${label}.evidenceRefs must not contain empty or duplicate values`);
  }

  if (counterEvidence.length !== (block.counterEvidence?.length ?? 0)) {
    errors.push(`${label}.counterEvidence must not contain empty or duplicate values`);
  }

  if (openQuestions.length !== (block.openQuestions?.length ?? 0)) {
    errors.push(`${label}.openQuestions must not contain empty or duplicate values`);
  }

  if (verificationPlan.length !== block.verificationPlan.length) {
    errors.push(`${label}.verificationPlan must not contain empty or duplicate values`);
  }

  if (fallbacks.length !== (block.fallbacks?.length ?? 0)) {
    errors.push(`${label}.fallbacks must not contain empty or duplicate values`);
  }

  if (!isReasoningConfidenceLevel(block.confidence)) {
    errors.push(
      `${label}.confidence must be one of: ${reasoningConfidenceLevels.join(", ")}`
    );
  }

  if (!isReasoningDecision(block.decision)) {
    errors.push(`${label}.decision must be one of: ${reasoningDecisions.join(", ")}`);
  }

  if (block.hypotheses.length === 0) {
    errors.push(`${label}.hypotheses is required`);
  }

  if (block.verificationPlan.length === 0) {
    errors.push(`${label}.verificationPlan is required`);
  }

  if (input.requireEvidenceRefs && block.evidenceRefs.length === 0) {
    errors.push(`${label}.evidenceRefs is required`);
  }

  if (block.budgets) {
    for (const [budgetKey, budgetValue] of Object.entries(block.budgets)) {
      if (budgetValue === undefined) {
        continue;
      }

      if (!Number.isInteger(budgetValue) || budgetValue < 0) {
        errors.push(`${label}.budgets.${budgetKey} must be a non-negative integer`);
      }
    }
  }

  return errors;
}

export function validatePlanInput(plan: PlanInput): string[] {
  const errors = [
    ...validateReasoningQualityBlock(plan.reasoningQuality, {
      label: "plan.reasoningQuality"
    }),
    ...validateReasoningPolicy(plan.reasoningPolicy, "plan.reasoningPolicy"),
    ...(plan.reasoningAttempts ?? []).flatMap((attempt, index) =>
      validateReasoningAttempt(attempt, `plan.reasoningAttempts[${index}]`)
    ),
    ...(plan.reasoningVerifications ?? []).flatMap((verification, index) =>
      validateReasoningVerification(verification, `plan.reasoningVerifications[${index}]`)
    ),
    ...validateReasoningVerdict(plan.reasoningVerdict, "plan.reasoningVerdict")
  ];

  if (plan.title.trim().length === 0) {
    errors.push("plan.title is required");
  }

  if (plan.summary.trim().length === 0) {
    errors.push("plan.summary is required");
  }

  if (plan.milestones.length === 0) {
    errors.push("plan.milestones is required");
  }

  if (plan.acceptanceCriteria.length === 0) {
    errors.push("plan.acceptanceCriteria is required");
  }

  return errors;
}

export function validateTaskPacket(packet: TaskPacketInput): string[] {
  const errors: string[] = [];
  const normalizedOwnerRole = packet.ownerRole.trim();
  const normalizedRequiredReviews = uniqueTrimmedItems(packet.requiredReviews);
  const normalizedSpecialistRoles = uniqueTrimmedItems(packet.requiredSpecialistRoles);
  const normalizedQualityGates = uniqueTrimmedItems(packet.qualityGates);
  const normalizedUiSurface = packet.uiSurface?.trim();

  if (packet.taskId.trim().length === 0) {
    errors.push("taskId is required");
  }

  if (normalizedOwnerRole.length === 0) {
    errors.push("ownerRole is required");
  } else if (!isRetrievalRole(normalizedOwnerRole)) {
    errors.push(`ownerRole must be one of: ${retrievalRoles.join(", ")}`);
  }

  if (!isCompletionStandard(packet.completionStandard)) {
    errors.push(`completionStandard must be one of: ${completionStandards.join(", ")}`);
  }

  if (packet.requiredSpecialistRoles.length === 0) {
    errors.push("requiredSpecialistRoles is required");
  } else {
    if (normalizedSpecialistRoles.length !== packet.requiredSpecialistRoles.length) {
      errors.push("requiredSpecialistRoles must not contain empty or duplicate values");
    }

    const invalidSpecialistRoles = normalizedSpecialistRoles.filter((role) => !retrievalRoleSet.has(role));
    if (invalidSpecialistRoles.length > 0) {
      errors.push(`requiredSpecialistRoles must be limited to: ${retrievalRoles.join(", ")}`);
    }

    if (normalizedOwnerRole.length > 0 && isRetrievalRole(normalizedOwnerRole)) {
      if (!normalizedSpecialistRoles.includes(normalizedOwnerRole)) {
        errors.push("requiredSpecialistRoles must include ownerRole");
      }
    }
  }

  if (packet.qualityGates.length === 0) {
    errors.push("qualityGates is required");
  } else {
    if (normalizedQualityGates.length !== packet.qualityGates.length) {
      errors.push("qualityGates must not contain empty or duplicate values");
    }

    const invalidQualityGates = normalizedQualityGates.filter((gate) => !qualityGateSet.has(gate));
    if (invalidQualityGates.length > 0) {
      errors.push(`qualityGates must be limited to: ${qualityGates.join(", ")}`);
    }
  }

  if (packet.completionStandard === "specialist_verified") {
    if (normalizedSpecialistRoles.length === 0) {
      errors.push("specialist_verified tasks require at least one specialist role");
    }

    if (normalizedQualityGates.length === 0) {
      errors.push("specialist_verified tasks require at least one quality gate");
    }
  }

  if (packet.goal.trim().length === 0) {
    errors.push("goal is required");
  }

  if (packet.allowedWriteScope.length === 0) {
    errors.push("allowedWriteScope is required");
  }

  if (packet.acceptanceCriteria.length === 0) {
    errors.push("acceptanceCriteria is required");
  }

  if (packet.verificationSteps.length === 0) {
    errors.push("verificationSteps is required");
  }

  if (normalizedUiSurface !== undefined && !isUiSurface(normalizedUiSurface)) {
    errors.push(`uiSurface must be one of: ${uiSurfaces.join(", ")}`);
  }

  if (packet.playwrightRequired === true && normalizedUiSurface === undefined) {
    errors.push("playwrightRequired tasks must declare uiSurface");
  }

  if (normalizedUiSurface !== undefined && isUiSurface(normalizedUiSurface)) {
    if (normalizedUiSurface === "none" && packet.playwrightRequired === true) {
      errors.push("uiSurface none cannot require Playwright");
    }

    if (
      (normalizedUiSurface === "visual_change" || normalizedUiSurface === "interactive_flow") &&
      packet.playwrightRequired === false
    ) {
      errors.push(`uiSurface ${normalizedUiSurface} must not disable Playwright`);
    }
  }

  errors.push(
    ...validateReasoningQualityBlock(packet.reasoningQuality, {
      label: "taskPacket.reasoningQuality"
    })
  );
  errors.push(...validateReasoningPolicy(packet.reasoningPolicy, "taskPacket.reasoningPolicy"));
  errors.push(
    ...(packet.reasoningAttempts ?? []).flatMap((attempt, index) =>
      validateReasoningAttempt(attempt, `taskPacket.reasoningAttempts[${index}]`)
    )
  );
  errors.push(
    ...(packet.reasoningVerifications ?? []).flatMap((verification, index) =>
      validateReasoningVerification(verification, `taskPacket.reasoningVerifications[${index}]`)
    )
  );
  errors.push(...validateReasoningVerdict(packet.reasoningVerdict, "taskPacket.reasoningVerdict"));

  if (packet.reasoningPolicy?.mode === "strict") {
    if (!packet.reasoningQuality && packet.reasoningPolicy.requireBlock !== false) {
      errors.push("strict reasoning mode requires reasoningQuality");
    }
    if ((packet.reasoningPolicy.requireAttempts ?? true) && (packet.reasoningAttempts?.length ?? 0) === 0) {
      errors.push("strict reasoning mode requires reasoningAttempts");
    }
    if ((packet.reasoningPolicy.requireVerification ?? true) && (packet.reasoningVerifications?.length ?? 0) === 0) {
      errors.push("strict reasoning mode requires reasoningVerifications");
    }
    if (!packet.reasoningVerdict) {
      errors.push("strict reasoning mode requires reasoningVerdict");
    }
  }

  if (packet.requiredReviews.length === 0) {
    errors.push("requiredReviews is required");
  } else {
    if (normalizedRequiredReviews.length !== packet.requiredReviews.length) {
      errors.push("requiredReviews must not contain empty or duplicate values");
    }

    const invalidRequiredReviews = normalizedRequiredReviews.filter((role) => !requiredGateReviewSet.has(role));
    if (invalidRequiredReviews.length > 0) {
      errors.push(`requiredReviews must be limited to: ${requiredGateReviews.join(", ")}`);
    }

    for (const requiredReview of requiredGateReviews) {
      if (!normalizedRequiredReviews.includes(requiredReview)) {
        errors.push(`missing required review gate: ${requiredReview}`);
      }
    }
  }

  if (packet.securityChecks.length === 0) {
    errors.push("securityChecks is required");
  }

  if (packet.antiPatterns.length === 0) {
    errors.push("antiPatterns is required");
  }

  if (packet.rollbackNotes.trim().length === 0) {
    errors.push("rollbackNotes is required");
  }

  if (packet.handoffFormat.trim().length === 0) {
    errors.push("handoffFormat is required");
  }

  const duplicateWriteScope = duplicateTrimmedItems(packet.allowedWriteScope);
  for (const path of duplicateWriteScope) {
    errors.push(`duplicate write scope: ${path}`);
  }

  return errors;
}

export function validateHandoff(input: HandoffInput): string[] {
  const errors: string[] = [];

  if (input.actor.trim().length === 0) {
    errors.push("handoff actor is required");
  }

  if (!isRetrievalRole(input.ownerRole)) {
    errors.push(`handoff ownerRole must be one of: ${retrievalRoles.join(", ")}`);
  }

  if (!isCompletionStandard(input.completionStandard)) {
    errors.push(`handoff completionStandard must be one of: ${completionStandards.join(", ")}`);
  }

  if (input.summary.trim().length === 0) {
    errors.push("handoff summary is required");
  }

  if (uniqueTrimmedItems(input.changedFiles).length !== input.changedFiles.length || input.changedFiles.length === 0) {
    errors.push("handoff changedFiles must contain at least one non-empty path");
  }

  if (
    uniqueTrimmedItems(input.verificationNotes).length !== input.verificationNotes.length ||
    input.verificationNotes.length === 0
  ) {
    errors.push("handoff verificationNotes must contain at least one non-empty item");
  }

  if (
    uniqueTrimmedItems(input.executionEvidence).length !== input.executionEvidence.length ||
    input.executionEvidence.length === 0
  ) {
    errors.push("handoff executionEvidence must contain at least one non-empty item");
  }

  if (
    uniqueTrimmedItems(input.qualityGateEvidence).length !== input.qualityGateEvidence.length ||
    input.qualityGateEvidence.length === 0
  ) {
    errors.push("handoff qualityGateEvidence must contain at least one non-empty item");
  }

  if (uniqueTrimmedItems(input.contextRefs).length !== input.contextRefs.length || input.contextRefs.length === 0) {
    errors.push("handoff contextRefs must contain at least one non-empty item");
  }

  return errors;
}

/**
 * True when a string is empty once Unicode whitespace AND format/zero-width
 * characters (category Cf, e.g. U+200B) are removed. `String.trim()` alone does
 * NOT strip Cf chars, so a value consisting only of U+200B (zero-width space)
 * would otherwise read as blank in the audit trail while passing a
 * `.trim().length` check. Used for acceptance
 * fields (message, acceptedByRole, acceptanceReason) where a phantom-but-present
 * value must be rejected.
 */
export function isBlankText(value: string): boolean {
  return value.replace(/[\s\p{Cf}]/gu, "").length === 0;
}

export function validateReviewAction(context: TrustedReviewActionContext, review: ReviewInput): string[] {
  const errors: string[] = [];

  if (!isTrustedReviewActionContext(context)) {
    return ["review context must come from the trusted runtime review identity resolver"];
  }

  const normalizedActor = context.actor.trim();

  if (normalizedActor.length === 0) {
    errors.push("review actor is required");
  }

  if (!isRetrievalRole(context.actorRole)) {
    errors.push(`review actorRole must be one of: ${retrievalRoles.join(", ")}`);
  }

  if (!isGateReviewRole(review.reviewerRole)) {
    errors.push(`reviewerRole must be one of: ${requiredGateReviews.join(", ")}`);
  }

  if (!isReviewState(review.state)) {
    errors.push(`review state must be one of: ${reviewStates.join(", ")}`);
  }

  if (!isReviewSeverity(review.severity)) {
    errors.push(`review severity must be one of: ${reviewSeverities.join(", ")}`);
  }

  if (!Array.isArray(review.findings)) {
    errors.push("review findings must be an array");
  }

  if (review.findings.some((finding) => finding.trim().length === 0)) {
    errors.push("review findings must not contain empty items");
  }

  if (review.evidenceRefs !== undefined) {
    if (!Array.isArray(review.evidenceRefs)) {
      errors.push("review evidenceRefs must be an array");
    } else {
      const normalizedEvidenceRefs = uniqueTrimmedItems(review.evidenceRefs);
      if (normalizedEvidenceRefs.length !== review.evidenceRefs.length) {
        errors.push("review evidenceRefs must not contain empty or duplicate items");
      }
    }
  }

  // P2.1 defense-in-depth: validate acceptance fields on any findingDetail that
  // has disposition=accepted. These checks mirror the gate predicate and catch
  // invalid input before it reaches the DB.
  if (Array.isArray(review.findingDetails)) {
    for (let i = 0; i < review.findingDetails.length; i++) {
      const f = review.findingDetails[i]!;
      if (f.disposition === "accepted") {
        if (!f.message || isBlankText(f.message)) {
          errors.push(`findingDetails[${i}]: accepted finding requires a non-empty message`);
        }
        if (!f.acceptedByRole || isBlankText(f.acceptedByRole)) {
          errors.push(`findingDetails[${i}]: accepted finding requires non-empty acceptedByRole`);
        } else if (!isGateReviewRole(f.acceptedByRole.trim())) {
          // Gate-3 Fix #2: acceptedByRole must be a gate review role, not just any catalog role.
          errors.push(`findingDetails[${i}]: acceptedByRole "${f.acceptedByRole}" is not a gate review role (reviewer, qa_engineer, or security_reviewer)`);
        }
        if (!f.acceptanceReason || isBlankText(f.acceptanceReason)) {
          errors.push(`findingDetails[${i}]: accepted finding requires non-empty acceptanceReason`);
        }
        // Positive allowlist: only low or medium may be accepted.
        // Using an exclusion list (high|critical) is a bypass risk when severity is undefined.
        if (f.severity !== "low" && f.severity !== "medium") {
          errors.push(`findingDetails[${i}]: only low or medium severity findings may be accepted, got ${f.severity ?? "undefined"} (hard security rule)`);
        }
      }
    }
  }

  // Fix #2: also run the acceptance check when accepted findingDetails are present
  // even when findings[] is empty.  Without this, a review with findings:[] but
  // accepted findingDetails would slip past validateReviewAction — the gate would
  // then pass because findings.length===0 skips its own check, making accepted
  // findingDetails invisible to both layers.
  const hasAcceptedDetailsInValidate = Array.isArray(review.findingDetails) &&
    review.findingDetails.some((f) => f.disposition === "accepted");
  if (review.state === "passed" && (review.findings.length > 0 || hasAcceptedDetailsInValidate)) {
    // P2.1: passed + non-empty findings (or any accepted detail) is allowed only
    // when every findingDetail is a fully accepted low/medium finding AND
    // findingDetails.length === findings.length.
    if (!checkFindingsAreFullyAccepted(review.findings, review.findingDetails)) {
      errors.push(
        "passed reviews with findings require all findingDetails to be accepted " +
        "(disposition=accepted, non-empty acceptedByRole and acceptanceReason, severity low or medium)"
      );
    }
  }

  if (review.reviewerRole === "security_reviewer" && review.state === "passed") {
    if (review.severity === "high" || review.severity === "critical") {
      errors.push(`security_reviewer passed reviews must use low or medium severity, not ${review.severity}`);
    }
  }

  if (review.state === "waived") {
    if (!review.waiverReason || review.waiverReason.trim().length === 0) {
      errors.push("waived reviews require waiverReason");
    }

    if (
      isRetrievalRole(context.actorRole) &&
      isGateReviewRole(review.reviewerRole) &&
      !canActorWaiveReview({
        actorRole: context.actorRole,
        reviewerRole: review.reviewerRole
      })
    ) {
      errors.push(`actorRole ${context.actorRole} is not allowed to waive ${review.reviewerRole}`);
    }
  } else {
    if (isRetrievalRole(context.actorRole) && context.actorRole !== review.reviewerRole) {
      errors.push(`actorRole ${context.actorRole} cannot record ${review.reviewerRole} review state ${review.state}`);
    }
  }

  return errors;
}

/**
 * P2.1 helper: returns true when every finding in `findingDetails` is a valid
 * accepted-by-decision finding:
 *   - `disposition === "accepted"`
 *   - `acceptedByRole` is a non-empty string
 *   - `acceptanceReason` is a non-empty string
 *   - HARD RULE: severity must be exactly "low" or "medium"; undefined, null,
 *     and any unrecognised value are rejected (positive allowlist)
 *
 * Also requires `findingDetails` to have the same length as `findings` so every
 * free-text finding has a corresponding structured acceptance record.
 * Returns false when `findingDetails` is absent or empty.
 *
 * Named `checkFindingsAreFullyAccepted` to be usable from both
 * `canReviewRecordSatisfyGate` (ReviewRecord) and `validateReviewAction` (ReviewInput).
 */
function checkFindingsAreFullyAccepted(
  findings: readonly string[],
  findingDetails: readonly import("./types.ts").ReviewFinding[] | undefined
): boolean {
  if (!Array.isArray(findingDetails) || findingDetails.length === 0) {
    return false;
  }
  if (findingDetails.length !== findings.length) {
    return false;
  }
  return findingDetails.every((f) => {
    // Gate-3 Fix #3: a finding with an empty/whitespace/zero-width message cannot be accepted.
    if (!f.message || isBlankText(f.message)) {
      return false;
    }
    if (f.disposition !== "accepted") {
      return false;
    }
    if (!f.acceptedByRole || isBlankText(f.acceptedByRole)) {
      return false;
    }
    // Gate-3 Fix #2: acceptedByRole must be a gate review role (reviewer, qa_engineer,
    // or security_reviewer). Any other string — including valid retrieval roles like
    // memory_curator — is rejected here.
    if (!isGateReviewRole(f.acceptedByRole.trim())) {
      return false;
    }
    if (!f.acceptanceReason || isBlankText(f.acceptanceReason)) {
      return false;
    }
    // HARD SECURITY RULE: only "low" or "medium" severity findings may be accepted.
    // Rejection list (high|critical) is a bypass risk when severity is undefined —
    // use a positive allowlist so any absent or unrecognised severity also fails.
    if (f.severity !== "low" && f.severity !== "medium") {
      return false;
    }
    return true;
  });
}

export function canReviewRecordSatisfyGate(review: ReviewRecord): boolean {
  if (review.source !== "orchestrator") {
    return false;
  }

  if (review.actor.trim().length === 0) {
    return false;
  }

  if (!isRetrievalRole(review.actorRole)) {
    return false;
  }

  if (!isGateReviewRole(review.reviewerRole)) {
    return false;
  }

  if (!isReviewState(review.state) || !isReviewSeverity(review.severity)) {
    return false;
  }

  if (review.state === "passed") {
    // Fix #2 (gate mirror): also run acceptance check when accepted findingDetails
    // are present but findings:[] — same as the validateReviewAction fix.
    const hasAcceptedDetailsInGate = Array.isArray(review.findingDetails) &&
      review.findingDetails.some((f) => f.disposition === "accepted");
    if (review.findings.length > 0 || hasAcceptedDetailsInGate) {
      // P2.1: Findings present (or accepted details) on a passed review are allowed
      // only when every findingDetail is a fully accepted-by-decision low/medium
      // finding and findingDetails.length === findings.length.
      if (!checkFindingsAreFullyAccepted(review.findings, review.findingDetails)) {
        return false;
      }
    }

    if (
      review.reviewerRole === "security_reviewer" &&
      (review.severity === "high" || review.severity === "critical")
    ) {
      return false;
    }

    return review.actorRole === review.reviewerRole;
  }

  if (review.state !== "waived") {
    return false;
  }

  if (!review.waiverReason || review.waiverReason.trim().length === 0) {
    return false;
  }

  return canActorWaiveReview({
    actorRole: review.actorRole,
    reviewerRole: review.reviewerRole
  });
}

const secretPatterns = [
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bpostgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i
];

export function findSecretSignals(content: string): string[] {
  return secretPatterns
    .filter((pattern) => pattern.test(content))
    .map((pattern) => pattern.source);
}

export function hasFutureTenseClaim(content: string): boolean {
  return /\b(will always|automatically learns|guarantees future|self-modifies)\b/i.test(content);
}

const visualArtifactPatterns = [
  /!\[[^\]]*\]\([^)]+\)/,
  /\bdata:image\/[a-z0-9.+-]+;base64,/i,
  /\b(?:artifact:\/\/|\.?\/)?(?:\.archon\/)?work\/artifacts\/playwright\/[^\s)]+\.(?:png|jpe?g|webp|gif|mp4|webm|zip|trace)\b/i,
  /\bplaywright:\/\/[^\s)]+\b/i
];

export function findVisualArtifactSignals(content: string): string[] {
  return visualArtifactPatterns
    .filter((pattern) => pattern.test(content))
    .map((pattern) => pattern.source);
}

export function validateMemoryPromotion(input: MemoryPromotionInput): string[] {
  const errors: string[] = [];

  if (findSecretSignals(input.content).length > 0) {
    errors.push("memory content appears to contain a secret");
  }

  if (hasFutureTenseClaim(input.content)) {
    errors.push("memory content contains speculative future claims");
  }

  if (findVisualArtifactSignals(input.content).length > 0) {
    errors.push("memory content must not embed screenshots, traces, or Playwright visual artifacts");
  }

  if (input.reviewer.trim().length === 0) {
    errors.push("reviewer is required");
  }

  if (input.sourceRunId.trim().length === 0) {
    errors.push("sourceRunId is required");
  }

  // MPL P2 council condition 2: anti_pattern entryType requires a review-class actorRole.
  // This gate is enforced here (contract layer) in addition to the promoteMemory trust gate.
  // Only "reviewer" and "security_reviewer" may promote anti_pattern entries.
  if (input.entryType === "anti_pattern") {
    const antiPatternAllowedRoles: ReadonlySet<string> = new Set(["reviewer", "security_reviewer"]);
    if (input.actorRole === undefined || !antiPatternAllowedRoles.has(input.actorRole)) {
      errors.push(
        `anti_pattern promotion requires actorRole to be "reviewer" or "security_reviewer"; got: ${input.actorRole ?? "(none)"}`
      );
    }
  }

  if (input.metadata) {
    const invalidRoles = uniqueTrimmedItems(input.metadata.retrievalRoles).filter((role) => !isRetrievalRole(role));
    if (invalidRoles.length > 0) {
      errors.push(`invalid retrieval roles: ${invalidRoles.join(", ")}`);
    }

    if (
      input.metadata.staleAfterDays !== undefined &&
      (!Number.isInteger(input.metadata.staleAfterDays) || input.metadata.staleAfterDays <= 0)
    ) {
      errors.push("metadata.staleAfterDays must be a positive integer");
    }

    if (input.metadata.reviewedAt && !isIsoTimestamp(input.metadata.reviewedAt)) {
      errors.push("metadata.reviewedAt must be a valid ISO timestamp");
    }
  }

  return errors;
}

export function normalizeSearchInput(
  input: SearchMemoryInput
): SearchMemoryInput & { limit: number; includeGlobal: boolean; requesterRole: RetrievalRole } {
  const query = input.query.trim();
  if (query.length === 0) {
    throw new Error("search query is required");
  }

  if (input.queryEmbedding) {
    if (input.queryEmbedding.length === 0 || input.queryEmbedding.some((value) => !Number.isFinite(value))) {
      throw new Error("query embedding must contain only finite numbers");
    }

    if (input.queryEmbedding.length > maxQueryEmbeddingDimensions) {
      throw new Error(`query embedding must not exceed ${maxQueryEmbeddingDimensions} dimensions`);
    }
  }

  const requesterRole = input.requesterRole ?? DEFAULT_RETRIEVAL_ROLE;
  if (!isRetrievalRole(requesterRole)) {
    throw new Error(`requesterRole must be one of: ${retrievalRoles.join(", ")}`);
  }

  return {
    ...input,
    query,
    limit: input.limit ?? 10,
    includeGlobal: input.includeGlobal ?? true,
    requesterRole
  };
}

export function isValidStopGoDecision(value: string): value is StopGoDecision {
  return (stopGoDecisions as readonly string[]).includes(value);
}
