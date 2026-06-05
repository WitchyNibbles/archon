import { collectAutonomousExecutionBlockers, isGapBlocking } from "../runtime/autonomous-execution.ts";
import type {
  AutonomousExecutionState,
  AutonomousExecutionSnapshot,
  CheckpointRecord,
  ContinuationAction,
  CoverageGapRecord,
  ProgressProofRecord,
  RunExecutionPlan,
  RunStatusSnapshot
} from "../domain/types.ts";

export type AutonomousResumeStatus = "not_configured" | "ready" | "blocked";
export type AutonomousResumeExecutionMode = "none" | "runtime_executable" | "operator_required";
export type AutonomousContinuationIntent =
  | "unknown"
  | "continue_now"
  | "defer_same_thread"
  | "defer_fresh_run"
  | "blocked_external";
export type AutonomousContinuationProvider =
  | "none"
  | "manual_operator_handoff"
  | "claude_cli_exec_scheduler"
  | "claude_app_thread_automation"
  | "claude_app_standalone_automation";
export type AutonomousWakeOwner = "none" | "runtime" | "operator";
export type AutonomousContinuationScheduleKind = "none" | "manual" | "cron" | "rrule";
export type AutonomousResumeSource =
  | "none"
  | "checkpoint"
  | "progress_proof"
  | "blocking_gap"
  | "execution_plan";

export interface AutonomousContinuationCapabilities {
  claudeAppThreadAutomation: boolean;
  claudeAppStandaloneAutomation: boolean;
  claudeCliScheduler: boolean;
}

export interface AutonomousContinuationProviderSelection {
  provider: AutonomousContinuationProvider;
  wakeOwner: AutonomousWakeOwner;
  scheduleKind: AutonomousContinuationScheduleKind;
  schedule?: string | undefined;
}

export interface AutonomousResumeGuidance {
  authorityLabel: "derived_only";
  status: AutonomousResumeStatus;
  source: AutonomousResumeSource;
  summary: string;
  nextTarget?: string | undefined;
  nextActions: string[];
  blockers: string[];
  executionMode: AutonomousResumeExecutionMode;
  continuationIntent: AutonomousContinuationIntent;
  provider: AutonomousContinuationProvider;
  wakeOwner: AutonomousWakeOwner;
  scheduleKind: AutonomousContinuationScheduleKind;
  schedule?: string | undefined;
  executionSummary: string;
  checkpointId?: string | undefined;
  progressProofId?: string | undefined;
}

export interface ContinueAnalysisDirectiveClassification {
  executionMode: Exclude<AutonomousResumeExecutionMode, "none">;
  continuationIntent: Exclude<AutonomousContinuationIntent, "unknown">;
  summary: string;
  action?: ContinuationAction | undefined;
}

export interface AutonomousOperatorSummary {
  stateAuthorityLabel: "runtime_authoritative";
  resumeAuthorityLabel: "derived_only";
  configured: boolean;
  updatedAt?: string | undefined;
  profile?: AutonomousExecutionSnapshot["state"]["profile"] | undefined;
  phase?: AutonomousExecutionSnapshot["state"]["phase"] | undefined;
  manifest?: AutonomousExecutionSnapshot["state"]["manifest"] | undefined;
  coverageSummary?: AutonomousExecutionSnapshot["coverageSummary"] | undefined;
  comprehensionSummary?: AutonomousExecutionSnapshot["comprehensionSummary"] | undefined;
  phaseReadiness?: AutonomousExecutionSnapshot["phaseReadiness"] | undefined;
  blockers: string[];
  openGaps: CoverageGapRecord[];
  blockingGaps: CoverageGapRecord[];
  latestProgressProof?: ProgressProofRecord | undefined;
  latestCheckpoint?: CheckpointRecord | undefined;
  resume: AutonomousResumeGuidance;
}

export function buildAutonomousOperatorSummary(input: {
  snapshot: RunStatusSnapshot;
  executionPlan?: RunExecutionPlan | undefined;
}): AutonomousOperatorSummary {
  const autonomousExecution = input.snapshot.autonomousExecution;
  if (!autonomousExecution) {
    return {
      stateAuthorityLabel: "runtime_authoritative",
      resumeAuthorityLabel: "derived_only",
      configured: false,
      blockers: [],
      openGaps: [],
      blockingGaps: [],
      resume: {
        authorityLabel: "derived_only",
        status: "not_configured",
        source: "none",
        summary:
          "autonomous execution is not configured for this run; workflow proof for the run can still be valid, but this run does not prove active autonomous continuation",
        nextActions: [],
        blockers: [],
        executionMode: "none",
        continuationIntent: "unknown",
        provider: "none",
        wakeOwner: "none",
        scheduleKind: "none",
        executionSummary:
          "run-level workflow proof may still be valid, but no autonomous continuation target is active"
      }
    };
  }

  const { state } = autonomousExecution;
  const openGaps = state.gaps.filter((gap) => gap.status === "open");
  const blockingGaps = openGaps.filter((gap) => isGapBlocking(gap));
  const blockers = collectAutonomousExecutionBlockers(state, input.snapshot.tasks);
  const latestProgressProof = latestProgressProofRecord(state.progressProofs);
  const latestCheckpoint = latestCheckpointRecord(state.checkpoints);

  return {
    stateAuthorityLabel: "runtime_authoritative",
    resumeAuthorityLabel: "derived_only",
    configured: true,
    updatedAt: state.updatedAt,
    profile: state.profile,
    phase: state.phase,
    manifest: state.manifest,
    coverageSummary: autonomousExecution.coverageSummary,
    comprehensionSummary: autonomousExecution.comprehensionSummary,
    phaseReadiness: autonomousExecution.phaseReadiness,
    blockers,
    openGaps,
    blockingGaps,
    latestProgressProof,
    latestCheckpoint,
    resume: buildResumeGuidance({
      blockers,
      blockingGaps,
      state,
      latestProgressProof,
      latestCheckpoint,
      executionPlan: input.executionPlan
    })
  };
}

function buildResumeGuidance(input: {
  blockers: string[];
  blockingGaps: readonly CoverageGapRecord[];
  state: AutonomousExecutionState;
  latestProgressProof?: ProgressProofRecord | undefined;
  latestCheckpoint?: CheckpointRecord | undefined;
  executionPlan?: RunExecutionPlan | undefined;
}): AutonomousResumeGuidance {
  const checkpointTarget = input.latestCheckpoint?.activeTargets[0];
  const proofTarget = input.latestProgressProof?.nextTarget;
  const gapTarget = input.blockingGaps[0]?.targetId;
  const checkpointActions = input.latestCheckpoint?.nextActions ?? [];
  const gapActions = input.blockingGaps[0]?.suggestedNextActions ?? [];
  const continueAnalysisClassification =
    input.executionPlan?.directive.kind === "continue_analysis"
      ? classifyContinueAnalysisDirective({
          directive: input.executionPlan.directive,
          state: input.state
        })
      : undefined;

  if (input.blockers.length > 0) {
    const executionMode = continueAnalysisClassification?.executionMode ?? "none";
    const continuationIntent = deriveContinuationIntent({
      executionMode,
      source: input.blockingGaps.length > 0 ? "blocking_gap" : sourceForFallback(input)
    });
    const providerSelection = selectLocalContinuationProvider({
      executionMode,
      continuationIntent
    });
    const nextActions =
      gapActions.length > 0
          ? [...gapActions]
          : checkpointActions.length > 0
            ? [...checkpointActions]
          : deriveExecutionPlanActions(input.executionPlan);
    return {
      authorityLabel: "derived_only",
      status: "blocked",
      source: input.blockingGaps.length > 0 ? "blocking_gap" : sourceForFallback(input),
      summary: input.blockers[0] ?? "autonomous continuation is blocked",
      nextTarget: gapTarget ?? proofTarget ?? checkpointTarget,
      nextActions,
      blockers: [...input.blockers],
      executionMode,
      continuationIntent,
      provider: providerSelection.provider,
      wakeOwner: providerSelection.wakeOwner,
      scheduleKind: providerSelection.scheduleKind,
      schedule: providerSelection.schedule,
      executionSummary:
        continueAnalysisClassification?.summary ?? "autonomous blockers remain before continuation can proceed",
      checkpointId: input.latestCheckpoint?.checkpointId,
      progressProofId: input.latestProgressProof?.proofId
    };
  }

  if (input.latestCheckpoint) {
    const executionMode = continueAnalysisClassification?.executionMode ?? "none";
    const continuationIntent = deriveContinuationIntent({
      executionMode,
      source: "checkpoint"
    });
    const providerSelection = selectLocalContinuationProvider({
      executionMode,
      continuationIntent
    });
    return {
      authorityLabel: "derived_only",
      status: "ready",
      source: "checkpoint",
      summary:
        checkpointActions[0] ??
        (checkpointTarget ? `resume at ${checkpointTarget}` : "resume from the latest checkpoint"),
      nextTarget: proofTarget ?? checkpointTarget,
      nextActions: checkpointActions.length > 0 ? [...checkpointActions] : deriveExecutionPlanActions(input.executionPlan),
      blockers: [],
      executionMode,
      continuationIntent,
      provider: providerSelection.provider,
      wakeOwner: providerSelection.wakeOwner,
      scheduleKind: providerSelection.scheduleKind,
      schedule: providerSelection.schedule,
      executionSummary:
        continueAnalysisClassification?.summary ?? "resume guidance was derived from the latest checkpoint",
      checkpointId: input.latestCheckpoint.checkpointId,
      progressProofId: input.latestProgressProof?.proofId
    };
  }

  if (input.latestProgressProof) {
    const executionMode = continueAnalysisClassification?.executionMode ?? "none";
    const continuationIntent = deriveContinuationIntent({
      executionMode,
      source: "progress_proof"
    });
    const providerSelection = selectLocalContinuationProvider({
      executionMode,
      continuationIntent
    });
    return {
      authorityLabel: "derived_only",
      status: "ready",
      source: "progress_proof",
      summary:
        input.latestProgressProof.whyNext?.trim() ||
        (proofTarget ? `continue at ${proofTarget}` : "continue from the latest progress proof"),
      nextTarget: proofTarget,
      nextActions:
        deriveProofActions(input.latestProgressProof).length > 0
          ? deriveProofActions(input.latestProgressProof)
          : deriveExecutionPlanActions(input.executionPlan),
      blockers: [],
      executionMode,
      continuationIntent,
      provider: providerSelection.provider,
      wakeOwner: providerSelection.wakeOwner,
      scheduleKind: providerSelection.scheduleKind,
      schedule: providerSelection.schedule,
      executionSummary:
        continueAnalysisClassification?.summary ?? "resume guidance was derived from the latest progress proof",
      checkpointId: undefined,
      progressProofId: input.latestProgressProof.proofId
    };
  }

  const planActions = deriveExecutionPlanActions(input.executionPlan);
  const executionMode = continueAnalysisClassification?.executionMode ?? "none";
  const continuationIntent = deriveContinuationIntent({
    executionMode,
    source: planActions.length > 0 ? "execution_plan" : "none"
  });
  const providerSelection = selectLocalContinuationProvider({
    executionMode,
    continuationIntent
  });
  return {
    authorityLabel: "derived_only",
    status: planActions.length > 0 ? "ready" : "not_configured",
    source: planActions.length > 0 ? "execution_plan" : "none",
    summary:
      planActions[0] ??
      "autonomous execution has no checkpoint or progress proof to derive resume guidance from",
    nextTarget: checkpointTarget ?? proofTarget ?? gapTarget,
    nextActions: planActions,
    blockers: [],
    executionMode,
    continuationIntent,
    provider: providerSelection.provider,
    wakeOwner: providerSelection.wakeOwner,
    scheduleKind: providerSelection.scheduleKind,
    schedule: providerSelection.schedule,
    executionSummary:
      continueAnalysisClassification?.summary ??
      (planActions.length > 0 ? "autonomous continuation is derived from the current execution plan" : "no autonomous continuation target is active")
  };
}

export function classifyContinueAnalysisDirective(input: {
  directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
  state?: AutonomousExecutionState | undefined;
}): ContinueAnalysisDirectiveClassification {
  const action = input.directive.actions[0];
  if (!action) {
    return {
      executionMode: "operator_required",
      continuationIntent: "blocked_external",
      summary: `operator input is required for autonomous target ${input.directive.targetId}: no typed continuation action was derived`
    };
  }

  if (action.kind === "run_workflow_proof") {
    return {
      executionMode: "runtime_executable",
      continuationIntent: "continue_now",
      summary: `runtime can execute workflow proof for task ${action.taskId}`,
      action
    };
  }

  if (action.kind === "resolve_blocking_gap" && action.targetId.startsWith("task:")) {
    return {
      executionMode: "runtime_executable",
      continuationIntent: "continue_now",
      summary: `runtime can resolve blocking gap ${action.gapId} through task-target workflow proof`,
      action
    };
  }

  if (action.kind === "resolve_blocking_gap") {
    return {
      executionMode: "operator_required",
      continuationIntent: "blocked_external",
      summary: `operator input is required for advisory continuation target ${action.targetId} while resolving blocking gap ${action.gapId}`,
      action
    };
  }

  if (action.kind === "resume_target") {
    if (action.targetId.startsWith("task:")) {
      return {
        executionMode: "runtime_executable",
        continuationIntent: "continue_now",
        summary: `runtime can resume task-target continuation ${action.targetId}`,
        action
      };
    }

    if (action.targetId === "review:authenticated") {
      return {
        executionMode: "runtime_executable",
        continuationIntent: "continue_now",
        summary: "runtime can normalize the authenticated-review continuation target",
        action
      };
    }

    if (action.source === "progress_proof" && action.targetId.startsWith("proof:")) {
      return classifyPersistedResumeTarget({
        sourceLabel: "progress proof",
        targetId: action.targetId,
        sourceId: action.sourceId,
        matchesSource:
          action.sourceId?.trim() && input.state
            ? input.state.progressProofs.some(
                (proof) => proof.proofId === action.sourceId && proof.nextTarget.trim() === action.targetId
              )
            : false
      });
    }

    if (action.source === "checkpoint" && action.targetId.startsWith("checkpoint:")) {
      return classifyPersistedResumeTarget({
        sourceLabel: "checkpoint",
        targetId: action.targetId,
        sourceId: action.sourceId,
        matchesSource:
          action.sourceId?.trim() && input.state
            ? input.state.checkpoints.some(
                (checkpoint) =>
                  checkpoint.checkpointId === action.sourceId &&
                  checkpoint.activeTargets.some((target) => target.trim() === action.targetId)
              )
            : false
      });
    }

    return {
      executionMode: "operator_required",
      continuationIntent:
        action.source === "checkpoint"
          ? "defer_same_thread"
          : action.source === "progress_proof"
            ? "defer_fresh_run"
            : "blocked_external",
      summary: `operator input is required for advisory continuation target ${action.targetId} from ${action.source}${action.sourceId ? ` (${action.sourceId})` : ""}`,
      action
    };
  }

  return {
    executionMode: "operator_required",
    continuationIntent: "blocked_external",
    summary: `operator input is required for autonomous target ${input.directive.targetId}`,
    action
  };
}

export function selectLocalContinuationProvider(input: {
  executionMode: AutonomousResumeExecutionMode;
  continuationIntent: AutonomousContinuationIntent;
  capabilities?: Partial<AutonomousContinuationCapabilities> | undefined;
}): AutonomousContinuationProviderSelection {
  const capabilities = {
    claudeAppThreadAutomation: false,
    claudeAppStandaloneAutomation: false,
    claudeCliScheduler: true,
    ...(input.capabilities ?? {})
  } satisfies AutonomousContinuationCapabilities;

  if (input.executionMode === "runtime_executable") {
    return {
      provider: "none",
      wakeOwner: "runtime",
      scheduleKind: "none"
    };
  }

  if (input.executionMode !== "operator_required" || input.continuationIntent === "continue_now") {
    return {
      provider: "none",
      wakeOwner: "none",
      scheduleKind: "none"
    };
  }

  if (input.continuationIntent === "defer_same_thread") {
    if (capabilities.claudeAppThreadAutomation) {
      return {
        provider: "claude_app_thread_automation",
        wakeOwner: "operator",
        scheduleKind: "rrule",
        schedule: "FREQ=MINUTELY;INTERVAL=30"
      };
    }
    if (capabilities.claudeCliScheduler) {
      return {
        provider: "claude_cli_exec_scheduler",
        wakeOwner: "operator",
        scheduleKind: "cron",
        schedule: "*/30 * * * *"
      };
    }
    return {
      provider: "manual_operator_handoff",
      wakeOwner: "operator",
      scheduleKind: "manual"
    };
  }

  if (input.continuationIntent === "defer_fresh_run") {
    if (capabilities.claudeAppStandaloneAutomation) {
      return {
        provider: "claude_app_standalone_automation",
        wakeOwner: "operator",
        scheduleKind: "cron",
        schedule: "0 * * * *"
      };
    }
    if (capabilities.claudeCliScheduler) {
      return {
        provider: "claude_cli_exec_scheduler",
        wakeOwner: "operator",
        scheduleKind: "cron",
        schedule: "0 * * * *"
      };
    }
    return {
      provider: "manual_operator_handoff",
      wakeOwner: "operator",
      scheduleKind: "manual"
    };
  }

  return {
    provider: "manual_operator_handoff",
    wakeOwner: "operator",
    scheduleKind: "manual"
  };
}

export function resolveContinuationCapabilities(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): AutonomousContinuationCapabilities {
  const parseEnabled = (value: string | undefined, fallback: boolean) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
    return fallback;
  };

  const appAll = parseEnabled(env.ARCHON_CODEX_APP_AUTOMATION, false);
  return {
    claudeAppThreadAutomation: parseEnabled(env.ARCHON_CODEX_APP_THREAD_AUTOMATION, appAll),
    claudeAppStandaloneAutomation: parseEnabled(env.ARCHON_CODEX_APP_STANDALONE_AUTOMATION, appAll),
    claudeCliScheduler: parseEnabled(env.ARCHON_CODEX_CLI_SCHEDULER, true)
  };
}

function deriveContinuationIntent(input: {
  executionMode: AutonomousResumeExecutionMode;
  source: AutonomousResumeSource;
}): AutonomousContinuationIntent {
  if (input.executionMode === "runtime_executable") {
    return "continue_now";
  }

  if (input.executionMode === "operator_required") {
    if (input.source === "checkpoint") {
      return "defer_same_thread";
    }
    if (input.source === "progress_proof") {
      return "defer_fresh_run";
    }
    return "blocked_external";
  }

  if (input.source === "checkpoint") {
    return "defer_same_thread";
  }
  if (input.source === "progress_proof") {
    return "defer_fresh_run";
  }
  if (input.source === "blocking_gap" || input.source === "execution_plan") {
    return "blocked_external";
  }
  return "unknown";
}

function classifyPersistedResumeTarget(input: {
  sourceLabel: string;
  targetId: string;
  sourceId?: string | undefined;
  matchesSource: boolean;
}): ContinueAnalysisDirectiveClassification {
  if (!input.sourceId?.trim()) {
    return {
      executionMode: "operator_required",
      continuationIntent: "blocked_external",
      summary: `operator input is required for ${input.targetId}: the originating ${input.sourceLabel} id is missing`
    };
  }

  if (!input.matchesSource) {
    return {
      executionMode: "operator_required",
      continuationIntent: "blocked_external",
      summary: `operator input is required for ${input.targetId}: the originating ${input.sourceLabel} ${input.sourceId} is stale or no longer matches`
    };
  }

  return {
    executionMode: "runtime_executable",
    continuationIntent: "continue_now",
    summary: `runtime can normalize self-referential ${input.sourceLabel} target ${input.targetId}`
  };
}

function sourceForFallback(input: {
  latestCheckpoint?: CheckpointRecord | undefined;
  latestProgressProof?: ProgressProofRecord | undefined;
  executionPlan?: RunExecutionPlan | undefined;
}): AutonomousResumeSource {
  if (input.latestCheckpoint) {
    return "checkpoint";
  }
  if (input.latestProgressProof) {
    return "progress_proof";
  }
  if (input.executionPlan) {
    return "execution_plan";
  }
  return "none";
}

function deriveExecutionPlanActions(plan?: RunExecutionPlan | undefined): string[] {
  if (!plan) {
    return [];
  }

  switch (plan.directive.kind) {
    case "dispatch_owner":
      return [
        `dispatch ${plan.directive.recommendation.taskId} to ${plan.directive.recommendation.targetRole ?? "owner"}`
      ];
    case "dispatch_reviews":
      return plan.directive.recommendations.map((recommendation) =>
        recommendation.targetReviewRole
          ? `request ${recommendation.targetReviewRole} for ${recommendation.taskId}`
          : `request review for ${recommendation.taskId}`
      );
    case "apply_recovery":
      return plan.directive.actions.map((action) => `apply recovery ${action.id}`);
    case "continue_analysis":
      return plan.directive.nextActions.length > 0
        ? [...plan.directive.nextActions]
        : [`continue ${plan.directive.targetId}`];
    case "blocked":
      return [...plan.directive.blockers];
    case "complete":
      return [];
    default:
      return [];
  }
}

function deriveProofActions(proof: ProgressProofRecord): string[] {
  if (proof.whyNext?.trim()) {
    return [proof.whyNext.trim()];
  }
  if (proof.nextTarget.trim().length > 0) {
    return [`continue at ${proof.nextTarget}`];
  }
  return [];
}

function latestProgressProofRecord(records: readonly ProgressProofRecord[]): ProgressProofRecord | undefined {
  return [...records].sort((left, right) => {
    const cycleOrder = right.cycle - left.cycle;
    if (cycleOrder !== 0) {
      return cycleOrder;
    }
    return right.createdAt.localeCompare(left.createdAt);
  })[0];
}

function latestCheckpointRecord(records: readonly CheckpointRecord[]): CheckpointRecord | undefined {
  return [...records].sort((left, right) => {
    const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
    if (createdAtOrder !== 0) {
      return createdAtOrder;
    }
    return right.checkpointId.localeCompare(left.checkpointId);
  })[0];
}
