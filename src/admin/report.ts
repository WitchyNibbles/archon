import type {
  ApprovalRecord,
  HandoffRecord,
  RuntimeTraceRegistrySummary,
  ReasoningWorkflowMode,
  RunExecutionPlan,
  ReviewRecord,
  RoutingRecommendationReport,
  SearchMemoryResult,
  RunStatusSnapshot,
  RecoveryInspectionReport
} from "../domain/types.ts";
import type { OperatorStatusReport } from "./status.ts";
import { assessPlanReasoning, assessTaskPacketReasoning } from "../core/reasoning-quality.ts";
import type { ReasoningQualityAssessment } from "../core/reasoning-quality.ts";
import { buildAutonomousOperatorSummary, type AutonomousOperatorSummary } from "./autonomous-summary.ts";

type TimelineAuthority = "runtime_authoritative" | "derived_only";

export interface RunEvidenceTaskReport {
  taskId: string;
  title: string;
  status: string;
  ownerRole: string;
  claimedBy?: string | undefined;
  updatedAt: string;
  dependencies: string[];
  allowedWriteScope: string[];
  handoffCount: number;
  reviewCount: number;
  approvalCount: number;
  latestHandoffAt?: string | undefined;
  latestReviewAt?: string | undefined;
  latestApprovalAt?: string | undefined;
  reasoningMode: ReasoningWorkflowMode;
  reasoningVerdictStatus?: string | undefined;
  reasoningQuality: ReasoningQualityAssessment;
}

export interface RunEvidenceTimelineEntry {
  authorityLabel: TimelineAuthority;
  at: string;
  kind:
    | "run_created"
    | "plan_created"
    | "task_created"
    | "task_updated"
    | "handoff_recorded"
    | "review_recorded"
    | "approval_recorded"
    | "loop_execution_recorded"
    | "recovery_issue_observed";
  taskId?: string | undefined;
  title: string;
  detail: string[];
}

export interface RunEvidenceLoopHistoryEntry {
  authorityLabel: "runtime_authoritative";
  at: string;
  taskId?: string | undefined;
  directiveKind: string;
  outcome: string;
  nextDirectiveKind?: string | undefined;
  actor?: string | undefined;
  reviewRole?: string | undefined;
  title: string;
  detail: string[];
  citation: string;
}

export interface RunEvidenceReport {
  authorityLabel: "derived_only";
  generatedAt: string;
  runId: string;
  status: OperatorStatusReport;
  routing: RoutingRecommendationReport;
  recovery: RecoveryInspectionReport;
  plan?: {
    title: string;
    createdAt: string;
    milestones: string[];
    decisions: string[];
    acceptanceCriteria: string[];
  } | undefined;
  tasks: RunEvidenceTaskReport[];
  autonomous: AutonomousOperatorSummary;
  traceRegistry?: RuntimeTraceRegistrySummary | undefined;
  reasoningQuality: {
    authorityLabel: "derived_only";
    status: "pass" | "warn";
    warningCount: number;
    plan: ReasoningQualityAssessment;
    legacyTaskIds: string[];
    dualTaskIds: string[];
    strictTaskIds: string[];
    taskIdsWithWarnings: string[];
    warnings: string[];
  };
  loopHistory: RunEvidenceLoopHistoryEntry[];
  timeline: RunEvidenceTimelineEntry[];
  summary: {
    totalTasks: number;
    totalHandoffs: number;
    totalReviews: number;
    totalApprovals: number;
    totalLoopExecutions: number;
    reviewBlockedTaskIds: string[];
    inProgressTaskIds: string[];
  };
}

export function buildRunEvidenceReport(input: {
  snapshot: RunStatusSnapshot;
  executionPlan?: RunExecutionPlan | undefined;
  status: OperatorStatusReport;
  routing: RoutingRecommendationReport;
  recovery: RecoveryInspectionReport;
  handoffsByTask: Record<string, HandoffRecord[]>;
  reviewsByTask: Record<string, ReviewRecord[]>;
  approvalsByTask: Record<string, ApprovalRecord[]>;
  loopHistoryResults?: readonly SearchMemoryResult[] | undefined;
  now?: string | undefined;
}): RunEvidenceReport {
  const tasks = input.snapshot.tasks.map((task) => {
    const handoffs = input.handoffsByTask[task.packet.taskId] ?? [];
    const reviews = input.reviewsByTask[task.packet.taskId] ?? [];
    const approvals = input.approvalsByTask[task.packet.taskId] ?? [];
    const reasoningQuality = assessTaskPacketReasoning(task.packet);

    return {
      taskId: task.packet.taskId,
      title: task.packet.title,
      status: task.status,
      ownerRole: task.packet.ownerRole,
      claimedBy: task.claimedBy,
      updatedAt: task.updatedAt,
      dependencies: [...task.packet.dependencies],
      allowedWriteScope: [...task.packet.allowedWriteScope],
      handoffCount: handoffs.length,
      reviewCount: reviews.length,
      approvalCount: approvals.length,
      latestHandoffAt: latestCreatedAt(handoffs),
      latestReviewAt: latestCreatedAt(reviews),
      latestApprovalAt: latestCreatedAt(approvals),
      reasoningMode: reasoningQuality.mode,
      reasoningVerdictStatus: reasoningQuality.verdictStatus,
      reasoningQuality
    };
  });

  const planReasoning = assessPlanReasoning(input.snapshot.plan?.content);
  const reasoningWarnings = [
    ...planReasoning.warnings.map((warning) => `plan: ${warning.message}`),
    ...tasks.flatMap((task) =>
      task.reasoningQuality.warnings.map((warning) => `${task.taskId}: ${warning.message}`)
    )
  ];

  const loopHistory = buildLoopHistory(input.loopHistoryResults ?? []);
  const timeline = buildTimeline({
    snapshot: input.snapshot,
    recovery: input.recovery,
    handoffsByTask: input.handoffsByTask,
    reviewsByTask: input.reviewsByTask,
    approvalsByTask: input.approvalsByTask,
    loopHistory
  });

  const totalHandoffs = sumCounts(tasks.map((task) => task.handoffCount));
  const totalReviews = sumCounts(tasks.map((task) => task.reviewCount));
  const totalApprovals = sumCounts(tasks.map((task) => task.approvalCount));

  return {
    authorityLabel: "derived_only",
    generatedAt: input.now ?? new Date().toISOString(),
    runId: input.snapshot.run.id,
    status: input.status,
    routing: input.routing,
    recovery: input.recovery,
    plan: input.snapshot.plan
      ? {
          title: input.snapshot.plan.title,
          createdAt: input.snapshot.plan.createdAt,
          milestones: [...input.snapshot.plan.content.milestones],
          decisions: [...input.snapshot.plan.content.decisions],
          acceptanceCriteria: [...input.snapshot.plan.content.acceptanceCriteria]
        }
      : undefined,
    tasks,
    autonomous: buildAutonomousOperatorSummary({
      snapshot: input.snapshot,
      executionPlan: input.executionPlan
    }),
    traceRegistry: input.status.traceRegistry.summary,
    reasoningQuality: {
      authorityLabel: "derived_only",
      status: reasoningWarnings.length > 0 ? "warn" : "pass",
      warningCount: reasoningWarnings.length,
      plan: planReasoning,
      legacyTaskIds: tasks.filter((task) => task.reasoningMode === "legacy").map((task) => task.taskId),
      dualTaskIds: tasks.filter((task) => task.reasoningMode === "dual").map((task) => task.taskId),
      strictTaskIds: tasks.filter((task) => task.reasoningMode === "strict").map((task) => task.taskId),
      taskIdsWithWarnings: tasks
        .filter((task) => task.reasoningQuality.status === "warn")
        .map((task) => task.taskId),
      warnings: reasoningWarnings
    },
    loopHistory,
    timeline,
    summary: {
      totalTasks: tasks.length,
      totalHandoffs,
      totalReviews,
      totalApprovals,
      totalLoopExecutions: loopHistory.length,
      reviewBlockedTaskIds: tasks
        .filter((task) => task.status === "review_blocked")
        .map((task) => task.taskId),
      inProgressTaskIds: tasks
        .filter((task) => task.status === "in_progress")
        .map((task) => task.taskId)
    }
  };
}

export function formatRunEvidenceReportMarkdown(report: RunEvidenceReport): string {
  const lines: string[] = [];
  lines.push(`# archon run report`);
  lines.push("");
  lines.push(`- run: \`${report.runId}\``);
  lines.push(`- generated: \`${report.generatedAt}\``);
  lines.push(`- status: \`${report.status.run.status}\``);
  lines.push(`- tasks: ${report.summary.totalTasks}`);
  lines.push(`- handoffs: ${report.summary.totalHandoffs}`);
  lines.push(`- reviews: ${report.summary.totalReviews}`);
  lines.push(`- approvals: ${report.summary.totalApprovals}`);
  lines.push(`- loop executions: ${report.summary.totalLoopExecutions}`);
  lines.push(`- recovery issues: ${report.recovery.summary.totalIssues}`);
  lines.push(`- reasoning-quality: ${report.reasoningQuality.status} (${report.reasoningQuality.warningCount} warnings)`);
  lines.push(`- integrity: ${report.status.integrity.status}`);
  lines.push("");

  if (report.status.integrity.contradictions.length > 0) {
    lines.push(`## Integrity`);
    lines.push("");
    for (const contradiction of report.status.integrity.contradictions) {
      lines.push(`- ${contradiction}`);
    }
    lines.push("");
  }

  if (report.status.integrity.runtimeState?.seedFailure) {
    const seedFailure = report.status.integrity.runtimeState.seedFailure;
    if (report.status.integrity.contradictions.length === 0) {
      lines.push(`## Integrity`);
      lines.push("");
    }
    lines.push(
      `- persisted seed failure: task=${seedFailure.taskId} run=${seedFailure.runId} reason=${seedFailure.reason}`
    );
    lines.push(`- seed failure recovery state: ${seedFailure.recoveryState}`);
    if (seedFailure.failedAt) {
      lines.push(`- persisted seed failure at: \`${seedFailure.failedAt}\``);
    }
    if (seedFailure.recoveryState === "requires_reproof") {
      lines.push(
        `- rerun authoritative workflow proof after repair: \`node --experimental-strip-types ./src/admin/archon.ts workflow-proof --run-id ${seedFailure.runId} --task-id ${seedFailure.taskId}\``
      );
    } else {
      lines.push(`- authoritative workflow proof exists, so this residue should be investigated as stale metadata`);
    }
    lines.push("");
  }

  if (report.status.integrity.runtimeState?.lastIntegrityRepair) {
    const lastIntegrityRepair = report.status.integrity.runtimeState.lastIntegrityRepair;
    if (
      report.status.integrity.contradictions.length === 0 &&
      !report.status.integrity.runtimeState?.seedFailure
    ) {
      lines.push(`## Integrity`);
      lines.push("");
    }
    lines.push(
      `- last integrity repair: source=${lastIntegrityRepair.source} kind=${lastIntegrityRepair.kind} summary=${lastIntegrityRepair.summary}`
    );
    lines.push(
      `- integrity repair interpretation: ${lastIntegrityRepair.source === "sync_runtime_exports"
        ? "local workflow export cleanup only; runtime authority was not changed by this repair"
        : lastIntegrityRepair.source === "reconcile_runtime_state"
          ? "runtime reconcile updated authoritative task-state alignment before syncing exports"
          : lastIntegrityRepair.source === "recover_apply"
            ? "runtime recovery applied a safe authoritative state transition"
            : "doctor-guided repair applied a verified integrity-healing step"}`
    );
    lines.push(`- last integrity repair at: \`${lastIntegrityRepair.repairedAt}\``);
    lines.push("");
  }

  if (report.plan) {
    lines.push(`## Plan`);
    lines.push("");
    lines.push(`- title: ${report.plan.title}`);
    lines.push(`- created: \`${report.plan.createdAt}\``);
    if (report.plan.milestones.length > 0) {
      lines.push(`- milestones: ${report.plan.milestones.join("; ")}`);
    }
    if (report.plan.decisions.length > 0) {
      lines.push(`- decisions: ${report.plan.decisions.join("; ")}`);
    }
    lines.push("");
  }

  lines.push(`## Tasks`);
  lines.push("");
  for (const task of report.tasks) {
    lines.push(
      `- \`${task.taskId}\` ${task.status} owner=${task.ownerRole} handoffs=${task.handoffCount} reviews=${task.reviewCount} approvals=${task.approvalCount} reasoning=${task.reasoningQuality.status}/${task.reasoningMode}${task.reasoningVerdictStatus ? ` verdict=${task.reasoningVerdictStatus}` : ""}`
    );
  }
  lines.push("");

  lines.push(`## Autonomous Execution`);
  lines.push("");
  if (!report.autonomous.configured) {
    lines.push(`- configured: no`);
    lines.push(`- resume: ${report.autonomous.resume.summary}`);
    lines.push(
      `- autonomy note: run-level workflow proof can still be valid; this report has no active autonomous continuation evidence for the run`
    );
  } else {
    lines.push(`- configured: yes`);
    lines.push(`- profile: ${report.autonomous.profile}`);
    lines.push(`- phase: ${report.autonomous.phase}`);
    lines.push(
      `- readiness: ${report.autonomous.phaseReadiness?.status ?? "unknown"}`
    );
    if ((report.autonomous.phaseReadiness?.reasons.length ?? 0) > 0) {
      lines.push(`- readiness reasons: ${report.autonomous.phaseReadiness?.reasons.join("; ")}`);
    }
    if (report.autonomous.phaseReadiness?.blockerKind) {
      lines.push(`- readiness blocker kind: ${report.autonomous.phaseReadiness.blockerKind}`);
    }
    const readinessGuidance: string[] = [];
    if (report.autonomous.phaseReadiness?.transition) {
      readinessGuidance.push(`transition=${report.autonomous.phaseReadiness.transition}`);
    }
    if (report.autonomous.phaseReadiness?.nextPhase) {
      readinessGuidance.push(`next=${report.autonomous.phaseReadiness.nextPhase}`);
    }
    if (report.autonomous.phaseReadiness?.fallbackPhase) {
      readinessGuidance.push(`fallback=${report.autonomous.phaseReadiness.fallbackPhase}`);
    }
    if (typeof report.autonomous.phaseReadiness?.continuationScore === "number") {
      readinessGuidance.push(`continuation-score=${report.autonomous.phaseReadiness.continuationScore}`);
    }
    if (report.autonomous.phaseReadiness?.latestCheckpointId) {
      readinessGuidance.push(`checkpoint=${report.autonomous.phaseReadiness.latestCheckpointId}`);
    }
    if (report.autonomous.phaseReadiness?.staleCheckpoint) {
      readinessGuidance.push("stale-checkpoint=yes");
    }
    if (readinessGuidance.length > 0) {
      lines.push(`- readiness guidance: ${readinessGuidance.join(" ")}`);
    }
    if (report.autonomous.coverageSummary) {
      lines.push(
        `- coverage: critical=${report.autonomous.coverageSummary.criticalItemCoverage} validation=${report.autonomous.coverageSummary.criticalItemValidation} callsites=${report.autonomous.coverageSummary.callsiteCoverage} runtime-traces=${report.autonomous.coverageSummary.runtimeTraceCoverage}`
      );
      lines.push(
        `- gaps: open=${report.autonomous.coverageSummary.openGapCount} blocking=${report.autonomous.coverageSummary.blockingGapCount}`
      );
    }
    if (report.autonomous.comprehensionSummary) {
      lines.push(
        `- comprehension: inventory=${report.autonomous.comprehensionSummary.inventoryCompleteness} business-rules=${report.autonomous.comprehensionSummary.businessRuleCoverage} contradictions=${report.autonomous.comprehensionSummary.contradictionGapCount} trace-records=${report.autonomous.comprehensionSummary.runtimeTraceCount} rewrite=${report.autonomous.comprehensionSummary.rewriteReadiness}`
      );
      if (report.autonomous.comprehensionSummary.missingEvidence.length > 0) {
        lines.push(
          `- comprehension missing: ${report.autonomous.comprehensionSummary.missingEvidence.join("; ")}`
        );
      }
    }
    if (report.autonomous.latestProgressProof) {
      lines.push(
        `- latest proof: ${report.autonomous.latestProgressProof.proofId} next=${report.autonomous.latestProgressProof.nextTarget}`
      );
    }
    if (report.autonomous.latestCheckpoint) {
      lines.push(
        `- latest checkpoint: ${report.autonomous.latestCheckpoint.checkpointId} authority=${report.autonomous.latestCheckpoint.authorityLabel} targets=${report.autonomous.latestCheckpoint.activeTargets.join(", ") || "none"}`
      );
    }
    if (report.autonomous.blockers.length > 0) {
      lines.push(`- blockers: ${report.autonomous.blockers.join("; ")}`);
    }
    lines.push(
      `- resume: ${report.autonomous.resume.status}/${report.autonomous.resume.source} ${report.autonomous.resume.summary}`
    );
    lines.push(
      `- resume execution: ${report.autonomous.resume.executionMode} ${report.autonomous.resume.executionSummary}`
    );
  }
  if (report.status.daemon.continuation) {
    lines.push(
      `- daemon continuation: ${report.status.daemon.continuation.state} ${report.status.daemon.continuation.executionMode} ${report.status.daemon.continuation.targetId ?? "unknown-target"}`
    );
    lines.push(`- daemon continuation summary: ${report.status.daemon.continuation.summary}`);
    if (report.status.daemon.continuation.nextActions.length > 0) {
      lines.push(`- daemon continuation next actions: ${report.status.daemon.continuation.nextActions.join("; ")}`);
    }
  }
  if (report.status.daemon.handoff) {
    lines.push(
      `- daemon handoff: ${report.status.daemon.handoff.state} ${report.status.daemon.handoff.blockerKind} ${report.status.daemon.handoff.reason}`
    );
    if (report.status.daemon.handoff.nextActions.length > 0) {
      lines.push(`- daemon handoff next actions: ${report.status.daemon.handoff.nextActions.join("; ")}`);
    }
    const handoffFiles = [
      report.status.daemon.handoff.detailFiles.continuationStatus,
      report.status.daemon.handoff.detailFiles.automationEnvelope,
      report.status.daemon.handoff.detailFiles.appAutomationRequest,
      report.status.daemon.handoff.detailFiles.cliSchedulerRequest,
      report.status.daemon.handoff.detailFiles.reviewQueueStatus,
      report.status.daemon.handoff.detailFiles.scopeExpansionRequest
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (handoffFiles.length > 0) {
      lines.push(`- daemon handoff files: ${handoffFiles.join("; ")}`);
    }
  }
  if (report.status.daemon.supervisor) {
    lines.push(
      `- daemon supervisor: ${report.status.daemon.supervisor.state}${report.status.daemon.supervisor.blockerKind ? ` ${report.status.daemon.supervisor.blockerKind}` : ""} ${report.status.daemon.supervisor.reason}`
    );
    if (report.status.daemon.supervisor.actions.length > 0) {
      lines.push(
        `- daemon supervisor actions: ${report.status.daemon.supervisor.actions
          .map((action) =>
            action.action === "enqueue_review_action"
              ? `${action.action}:${action.taskId ?? "unknown"}:${action.reviewRole ?? "unknown"}`
              : `${action.action}:${action.targetId ?? "unknown"}`
          )
          .join("; ")}`
      );
    }
    if (report.status.daemon.supervisor.missingReviewRoles.length > 0) {
      lines.push(`- daemon supervisor missing review roles: ${report.status.daemon.supervisor.missingReviewRoles.join("; ")}`);
    }
    if (report.status.daemon.supervisor.nextActions.length > 0) {
      lines.push(`- daemon supervisor next actions: ${report.status.daemon.supervisor.nextActions.join("; ")}`);
    }
    if (report.status.daemon.supervisor.history.length > 0) {
      lines.push(
        `- daemon supervisor history view: scope=${report.status.daemon.supervisor.historyView.scope}${report.status.daemon.supervisor.historyView.runId ? ` run=${report.status.daemon.supervisor.historyView.runId}` : ""} returned=${report.status.daemon.supervisor.historyView.returnedCount} filtered=${report.status.daemon.supervisor.historyView.filteredCount} retained=${report.status.daemon.supervisor.historyView.retainedCount} truncated=${report.status.daemon.supervisor.historyView.truncated ? "yes" : "no"}`
      );
      lines.push(
        `- daemon supervisor history: ${report.status.daemon.supervisor.history
          .map(
            (entry) =>
              `${entry.recordedAt}:${entry.activeRunId ?? "unknown-run"}:${entry.state}:${entry.actionCount}`
          )
          .join("; ")}`
      );
    }
  }
  lines.push("");

  lines.push(`## Checkpoint Compaction`);
  lines.push("");
  lines.push(`- status: ${report.status.compaction.status}`);
  if (report.status.compaction.checkpointId) {
    lines.push(`- checkpoint: ${report.status.compaction.checkpointId}`);
  }
  if (report.status.compaction.ref) {
    lines.push(`- ref: ${report.status.compaction.ref}`);
  }
  if (report.status.compaction.summary) {
    lines.push(`- summary: ${report.status.compaction.summary}`);
  }
  if (report.status.compaction.sourceRefs.length > 0) {
    lines.push(`- source refs: ${report.status.compaction.sourceRefs.join("; ")}`);
  }
  lines.push("");

  lines.push(`## Eval Posture`);
  lines.push("");
  lines.push(`- status: ${report.status.evalPosture.status}`);
  lines.push(`- boundary: ${report.status.evalPosture.boundarySummary}`);
  if (report.status.evalPosture.repoLocalLabels.length > 0) {
    lines.push(`- repo-local labels: ${report.status.evalPosture.repoLocalLabels.join("; ")}`);
  }
  if (report.status.evalPosture.broaderEvidenceLabels.length > 0) {
    lines.push(`- broader evidence labels: ${report.status.evalPosture.broaderEvidenceLabels.join("; ")}`);
  }
  if (report.status.evalPosture.labels.length > 0) {
    lines.push(`- all labels: ${report.status.evalPosture.labels.join("; ")}`);
  }
  if (report.status.evalPosture.artifactRefs.length > 0) {
    lines.push(`- artifact refs: ${report.status.evalPosture.artifactRefs.join("; ")}`);
  }
  lines.push("");

  lines.push(`## Review Controls`);
  lines.push("");
  lines.push(`- status: ${report.status.reviewControls.status}`);
  if (report.status.reviewControls.controls.length === 0) {
    lines.push("- none");
  } else {
    for (const control of report.status.reviewControls.controls) {
      lines.push(
        `- ${control.controlId}: action=${control.actionType} enforcement=${control.enforcement} ${control.summary}`
      );
    }
  }
  lines.push("");

  if (report.traceRegistry) {
    lines.push(`## Runtime Trace Registry`);
    lines.push("");
    lines.push(
      `- traces: total=${report.traceRegistry.totalTraces} risky=${report.traceRegistry.riskyTraceCount} traced-targets=${report.traceRegistry.tracedTargetCount}`
    );
    lines.push(
      `- freshness window: ${report.traceRegistry.freshnessWindowHours}h reference=${report.traceRegistry.referenceNow}`
    );
    if (report.traceRegistry.riskyTargetsMissingTrace.length > 0) {
      lines.push(
        `- missing risky targets: ${report.traceRegistry.riskyTargetsMissingTrace.join("; ")}`
      );
    }
    if (report.traceRegistry.staleTargetIds.length > 0) {
      lines.push(`- stale trace targets: ${report.traceRegistry.staleTargetIds.join("; ")}`);
    }
    if (report.traceRegistry.operatorImportTargetIds.length > 0) {
      lines.push(
        `- operator-import trace targets: ${report.traceRegistry.operatorImportTargetIds.join("; ")}`
      );
    }
    if (report.traceRegistry.openMissingTraceGapIds.length > 0) {
      lines.push(
        `- open missing-trace gaps: ${report.traceRegistry.openMissingTraceGapIds.join("; ")}`
      );
    }
    if (report.traceRegistry.targets.length > 0) {
      lines.push(
        `- traced targets: ${report.traceRegistry.targets
          .map(
            (target) =>
              `${target.targetId}[${target.traceIds.join(",")}]{freshness=${target.freshness} provenance=${target.authorityLabels.join("|")}}`
          )
          .join("; ")}`
      );
    }
    lines.push("");
  }

  lines.push(`## Reasoning Quality`);
  lines.push("");
  lines.push(`- legacy tasks: ${report.reasoningQuality.legacyTaskIds.join(", ") || "none"}`);
  lines.push(`- dual tasks: ${report.reasoningQuality.dualTaskIds.join(", ") || "none"}`);
  lines.push(`- strict tasks: ${report.reasoningQuality.strictTaskIds.join(", ") || "none"}`);
  if (report.reasoningQuality.warnings.length === 0) {
    lines.push("- none");
  } else {
    for (const warning of report.reasoningQuality.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("");

  lines.push(`## Alerts`);
  lines.push("");
  if (report.recovery.issues.length === 0 && report.status.orchestration.blockers.length === 0) {
    lines.push("- none");
  } else {
    for (const blocker of report.status.orchestration.blockers) {
      lines.push(`- blocker: ${blocker}`);
    }
    for (const issue of report.recovery.issues) {
      lines.push(`- recovery:${issue.kind}: ${(issue.taskId ?? issue.lockTaskId ?? issue.id)}`);
    }
  }
  lines.push("");

  lines.push(`## Loop History`);
  lines.push("");
  if (report.loopHistory.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of report.loopHistory) {
      const taskLabel = entry.taskId ? ` task=\`${entry.taskId}\`` : "";
      lines.push(
        `- \`${entry.at}\`${taskLabel} ${entry.directiveKind}/${entry.outcome} next=${entry.nextDirectiveKind ?? "unknown"}`
      );
    }
  }
  lines.push("");

  lines.push(`## Timeline`);
  lines.push("");
  for (const entry of report.timeline) {
    const taskLabel = entry.taskId ? ` task=\`${entry.taskId}\`` : "";
    lines.push(`- \`${entry.at}\` ${entry.kind}${taskLabel}: ${entry.title}`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function buildTimeline(input: {
  snapshot: RunStatusSnapshot;
  recovery: RecoveryInspectionReport;
  handoffsByTask: Record<string, HandoffRecord[]>;
  reviewsByTask: Record<string, ReviewRecord[]>;
  approvalsByTask: Record<string, ApprovalRecord[]>;
  loopHistory: readonly RunEvidenceLoopHistoryEntry[];
}): RunEvidenceTimelineEntry[] {
  const events: RunEvidenceTimelineEntry[] = [
    {
      authorityLabel: "runtime_authoritative",
      at: input.snapshot.run.createdAt,
      kind: "run_created",
      title: input.snapshot.run.title,
      detail: [input.snapshot.run.status, input.snapshot.run.actor]
    }
  ];

  if (input.snapshot.plan) {
    events.push({
      authorityLabel: "runtime_authoritative",
      at: input.snapshot.plan.createdAt,
      kind: "plan_created",
      title: input.snapshot.plan.title,
      detail: [...input.snapshot.plan.content.milestones]
    });
  }

  for (const task of input.snapshot.tasks) {
    events.push({
      authorityLabel: "runtime_authoritative",
      at: task.createdAt,
      kind: "task_created",
      taskId: task.packet.taskId,
      title: task.packet.title,
      detail: [`owner=${task.packet.ownerRole}`, `status=${task.status}`]
    });

    if (task.updatedAt !== task.createdAt) {
      events.push({
        authorityLabel: "runtime_authoritative",
        at: task.updatedAt,
        kind: "task_updated",
        taskId: task.packet.taskId,
        title: `${task.packet.taskId} updated`,
        detail: [`status=${task.status}`, task.claimedBy ? `claimedBy=${task.claimedBy}` : "claimedBy=none"]
      });
    }

    for (const handoff of input.handoffsByTask[task.packet.taskId] ?? []) {
      events.push({
        authorityLabel: "runtime_authoritative",
        at: handoff.createdAt,
        kind: "handoff_recorded",
        taskId: task.packet.taskId,
        title: `handoff by ${handoff.actor}`,
        detail: [handoff.ownerRole, handoff.completionStandard]
      });
    }

    for (const review of input.reviewsByTask[task.packet.taskId] ?? []) {
      events.push({
        authorityLabel: "runtime_authoritative",
        at: review.createdAt,
        kind: "review_recorded",
        taskId: task.packet.taskId,
        title: `${review.reviewerRole} ${review.state}`,
        detail: [review.actor, review.identityAssurance]
      });
    }

    for (const approval of input.approvalsByTask[task.packet.taskId] ?? []) {
      events.push({
        authorityLabel: "runtime_authoritative",
        at: approval.createdAt,
        kind: "approval_recorded",
        taskId: task.packet.taskId,
        title: `${approval.decision} by ${approval.actor}`,
        detail: [approval.actorRole, approval.identityAssurance]
      });
    }
  }

  for (const entry of input.loopHistory) {
    events.push({
      authorityLabel: entry.authorityLabel,
      at: entry.at,
      kind: "loop_execution_recorded",
      taskId: entry.taskId,
      title: entry.title,
      detail: [
        `directive=${entry.directiveKind}`,
        `outcome=${entry.outcome}`,
        ...(entry.nextDirectiveKind ? [`next=${entry.nextDirectiveKind}`] : []),
        ...entry.detail
      ]
    });
  }

  for (const issue of input.recovery.issues) {
    events.push({
      authorityLabel: "derived_only",
      at: input.snapshot.run.updatedAt,
      kind: "recovery_issue_observed",
      taskId: issue.taskId,
      title: issue.kind,
      detail: [...issue.details]
    });
  }

  return events.sort((left, right) => left.at.localeCompare(right.at));
}

function buildLoopHistory(results: readonly SearchMemoryResult[]): RunEvidenceLoopHistoryEntry[] {
  const entries: RunEvidenceLoopHistoryEntry[] = [];

  for (const result of results) {
    const directiveKind = readTaggedValue(result, "directive:");
    const outcome = readTaggedValue(result, "outcome:");
    if (!directiveKind || !outcome) {
      continue;
    }

    entries.push({
      authorityLabel: "runtime_authoritative",
      at: result.provenance.createdAt,
      taskId: readTaggedValue(result, "task:") ?? result.provenance.taskId,
      directiveKind,
      outcome,
      nextDirectiveKind: readTaggedValue(result, "next:"),
      actor: readTaggedValue(result, "actor:"),
      reviewRole: readTaggedValue(result, "reviewRole:"),
      title: result.title,
      detail: result.content
        .split("\n")
        .filter((line) => line.startsWith("evidence="))
        .map((line) => line.slice("evidence=".length)),
      citation: result.citation.canonicalRef
    });
  }

  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

function readTaggedValue(result: SearchMemoryResult, prefix: string): string | undefined {
  const tag = result.metadata.tags.find((candidate) => candidate.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : undefined;
}

function latestCreatedAt(records: ReadonlyArray<{ createdAt: string }>): string | undefined {
  return records
    .map((record) => record.createdAt)
    .sort((left, right) => right.localeCompare(left))[0];
}

function sumCounts(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
