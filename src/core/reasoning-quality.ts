import type {
  PlanInput,
  ReasoningAttempt,
  ReasoningPolicy,
  ReasoningQualityBlock,
  ReasoningConfidenceLevel,
  ReasoningVerification,
  ReasoningVerdict,
  ReasoningWorkflowMode,
  SearchMemoryResult,
  TaskPacketInput
} from "../domain/types.ts";

export interface ReasoningQualityWarning {
  code:
    | "missing_block"
    | "missing_assumptions"
    | "missing_hypotheses"
    | "missing_evidence_refs"
    | "missing_verification_plan"
    | "missing_budgets"
    | "blocked_decision"
    | "counter_evidence_present"
    | "open_questions_present"
    | "low_confidence"
    | "retrieval_hint_only"
    | "stale_evidence"
    | "conflicting_evidence"
    | "missing_policy"
    | "missing_attempts"
    | "missing_trace_ref"
    | "missing_verifications"
    | "missing_critic_verification"
    | "missing_verdict"
    | "unsupported_verdict"
    | "insufficient_verdict"
    | "contradicted_verdict"
    | "budget_exhausted_verdict"
    | "legacy_mode"
    | "dual_mode";
  message: string;
}

export interface ReasoningQualityAssessment {
  authorityLabel: "derived_only";
  mode: ReasoningWorkflowMode;
  status: "pass" | "warn";
  confidence?: ReasoningConfidenceLevel | undefined;
  warningCount: number;
  blockingCount: number;
  warnings: ReasoningQualityWarning[];
  blockers: ReasoningQualityWarning[];
  verdictStatus?: ReasoningVerdict["status"] | undefined;
}

function warn(code: ReasoningQualityWarning["code"], message: string): ReasoningQualityWarning {
  return { code, message };
}

function inferMode(input: {
  policy: ReasoningPolicy | undefined;
  qualityGates?: readonly string[] | undefined;
}): ReasoningWorkflowMode {
  if (input.policy?.mode) {
    return input.policy.mode;
  }
  if (input.qualityGates?.includes("reasoning_strict_required")) {
    return "strict";
  }
  if (input.qualityGates?.includes("reasoning_dual_required")) {
    return "dual";
  }
  return "strict";
}

function addModeWarnings(mode: ReasoningWorkflowMode, label: string, warnings: ReasoningQualityWarning[]) {
  if (mode === "legacy") {
    warnings.push(warn("legacy_mode", `${label} is still using legacy reasoning semantics`));
  } else if (mode === "dual") {
    warnings.push(warn("dual_mode", `${label} is using dual-mode reasoning semantics`));
  }
}

function assessReasoningExecutionLayer(
  input: {
    label: string;
    mode: ReasoningWorkflowMode;
    policy: ReasoningPolicy | undefined;
    attempts: readonly ReasoningAttempt[] | undefined;
    verifications: readonly ReasoningVerification[] | undefined;
    verdict: ReasoningVerdict | undefined;
  },
  warnings: ReasoningQualityWarning[],
  blockers: ReasoningQualityWarning[]
): void {
  const strict = input.mode === "strict";
  if (!input.policy && strict) {
    blockers.push(warn("missing_policy", `${input.label} is missing a strict reasoning policy`));
  }

  const attempts = input.attempts ?? [];
  const verifications = input.verifications ?? [];
  const verdict = input.verdict;

  if (attempts.length === 0) {
    const issue = warn("missing_attempts", `${input.label} records no reasoning attempts`);
    (strict ? blockers : warnings).push(issue);
  }

  if ((input.policy?.requireTraceRefs ?? strict) && attempts.some((attempt) => !attempt.traceRef?.trim())) {
    const issue = warn("missing_trace_ref", `${input.label} has reasoning attempts without trace references`);
    (strict ? blockers : warnings).push(issue);
  }

  if (verifications.length === 0) {
    const issue = warn("missing_verifications", `${input.label} records no reasoning verifications`);
    (strict ? blockers : warnings).push(issue);
  }

  if ((input.policy?.requireCriticVerification ?? strict) && !verifications.some(
    (verification) => verification.kind === "critic_review" && verification.status === "passed"
  )) {
    const issue = warn(
      "missing_critic_verification",
      `${input.label} has no passed critic or reviewer verification`
    );
    (strict ? blockers : warnings).push(issue);
  }

  if (!verdict) {
    const issue = warn("missing_verdict", `${input.label} records no reasoning verdict`);
    (strict ? blockers : warnings).push(issue);
    return;
  }

  switch (verdict.status) {
    case "supported":
      break;
    case "insufficient_evidence": {
      const issue = warn("insufficient_verdict", `${input.label} verdict remains insufficient_evidence`);
      (strict ? blockers : warnings).push(issue);
      break;
    }
    case "contradicted": {
      const issue = warn("contradicted_verdict", `${input.label} verdict is contradicted`);
      (strict ? blockers : warnings).push(issue);
      break;
    }
    case "budget_exhausted": {
      const issue = warn("budget_exhausted_verdict", `${input.label} exhausted its reasoning budget`);
      (strict ? blockers : warnings).push(issue);
      break;
    }
    case "needs_review": {
      const issue = warn("unsupported_verdict", `${input.label} still needs trusted review before conclusion`);
      (strict ? blockers : warnings).push(issue);
      break;
    }
  }
}

export function assessReasoningQualityBlock(
  block: ReasoningQualityBlock | undefined,
  input: {
    label: string;
    requireBlock?: boolean | undefined;
    mode?: ReasoningWorkflowMode | undefined;
    policy?: ReasoningPolicy | undefined;
    attempts?: readonly ReasoningAttempt[] | undefined;
    verifications?: readonly ReasoningVerification[] | undefined;
    verdict?: ReasoningVerdict | undefined;
  }
): ReasoningQualityAssessment {
  const warnings: ReasoningQualityWarning[] = [];
  const blockers: ReasoningQualityWarning[] = [];
  const mode = input.mode ?? inferMode({ policy: input.policy });

  addModeWarnings(mode, input.label, warnings);

  if (!block) {
    if (input.requireBlock !== false) {
      const issue = warn("missing_block", `${input.label} is missing a reasoning-quality block`);
      if (mode === "strict") {
        blockers.push(issue);
      } else {
        warnings.push(issue);
      }
    }

    assessReasoningExecutionLayer(
      {
        label: input.label,
        mode,
        policy: input.policy,
        attempts: input.attempts,
        verifications: input.verifications,
        verdict: input.verdict
      },
      warnings,
      blockers
    );

    return {
      authorityLabel: "derived_only",
      mode,
      status: warnings.length > 0 || blockers.length > 0 ? "warn" : "pass",
      warningCount: warnings.length,
      blockingCount: blockers.length,
      warnings,
      blockers,
      verdictStatus: input.verdict?.status
    };
  }

  if (block.assumptions.length === 0) {
    warnings.push(warn("missing_assumptions", `${input.label} records no explicit assumptions`));
  }

  if (block.hypotheses.length === 0) {
    warnings.push(warn("missing_hypotheses", `${input.label} records no alternative hypotheses`));
  }

  if (block.evidenceRefs.length === 0) {
    warnings.push(warn("missing_evidence_refs", `${input.label} records no evidence references`));
  }

  if (block.verificationPlan.length === 0) {
    warnings.push(
      warn("missing_verification_plan", `${input.label} records no verification plan`)
    );
  }

  if (
    !block.budgets ||
    Object.values(block.budgets).every((value) => value === undefined)
  ) {
    warnings.push(warn("missing_budgets", `${input.label} records no bounded research/debug budget`));
  }

  if ((block.counterEvidence?.length ?? 0) > 0) {
    warnings.push(
      warn("counter_evidence_present", `${input.label} still has unresolved counter-evidence`)
    );
  }

  if ((block.openQuestions?.length ?? 0) > 0) {
    warnings.push(
      warn("open_questions_present", `${input.label} still has unresolved open questions`)
    );
  }

  if (block.confidence === "low") {
    warnings.push(warn("low_confidence", `${input.label} is operating at low confidence`));
  }

  if (block.decision === "blocked") {
    const issue = warn("blocked_decision", `${input.label} is explicitly blocked by its reasoning decision`);
    blockers.push(issue);
  }

  assessReasoningExecutionLayer(
    {
      label: input.label,
      mode,
      policy: input.policy,
      attempts: input.attempts,
      verifications: input.verifications,
      verdict: input.verdict
    },
    warnings,
    blockers
  );

  return {
    authorityLabel: "derived_only",
    mode,
    status: warnings.length > 0 || blockers.length > 0 ? "warn" : "pass",
    confidence: block.confidence,
    warningCount: warnings.length,
    blockingCount: blockers.length,
    warnings,
    blockers,
    verdictStatus: input.verdict?.status
  };
}

export function assessTaskPacketReasoning(packet: TaskPacketInput): ReasoningQualityAssessment {
  return assessReasoningQualityBlock(packet.reasoningQuality, {
    label: `task ${packet.taskId}`,
    mode: inferMode({ policy: packet.reasoningPolicy, qualityGates: packet.qualityGates }),
    policy: packet.reasoningPolicy,
    attempts: packet.reasoningAttempts,
    verifications: packet.reasoningVerifications,
    verdict: packet.reasoningVerdict
  });
}

export function assessPlanReasoning(plan: PlanInput | undefined): ReasoningQualityAssessment {
  return assessReasoningQualityBlock(plan?.reasoningQuality, {
    label: plan ? `plan ${plan.title}` : "plan",
    requireBlock: Boolean(plan),
    mode: plan ? inferMode({ policy: plan.reasoningPolicy }) : "legacy",
    policy: plan?.reasoningPolicy,
    attempts: plan?.reasoningAttempts,
    verifications: plan?.reasoningVerifications,
    verdict: plan?.reasoningVerdict
  });
}

export function buildPlanningContextReasoningWarnings(
  result: Pick<SearchMemoryResult, "authority" | "freshness" | "conflict">
): string[] {
  const warnings: string[] = [];

  if (result.authority.precedence !== "repo_context") {
    warnings.push("retrieval hint only; re-anchor in canonical files");
  }

  if (result.freshness.status !== "fresh") {
    warnings.push(`evidence freshness is ${result.freshness.status}`);
  }

  if (result.conflict.detected) {
    warnings.push("related contradictory evidence detected");
  }

  return warnings;
}
