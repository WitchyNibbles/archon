// Status + execution-plan planner.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4).
// This is slice 3 of the ArchonCoreService decomposition and owns the
// read-heavy derivation cluster (plan seam S4, status half): getStatus,
// recommendRouting, getExecutionPlan, and resumeRun, plus the pure
// collectExecutionBlockers reducer and the deriveNativeAutonomousDirective
// free function that getExecutionPlan uses.
//
// Every method here depends only on the injected surface below — `store`,
// `requireRun`, `findTaskBlockers`, and `inspectRecovery` — never on gate/
// review or lifecycle private state. `inspectRecovery` is injected rather than
// moved because it belongs to the recovery cluster (plan seam S5, which moves in
// a later slice); getExecutionPlan is its only caller here. The reverse edge —
// the recovery methods still on ArchonCoreService call getStatus — is closed the
// same way: the class injects `(runId, opts) => this.inspectRecovery(...)` into
// this planner and its own inspectRecovery/applyRecovery call `this.getStatus`,
// which delegates back here. Both directions are runtime closures, so no
// service.ts <-> status-execution-planner.ts import cycle forms.
//
// ENABLED-GATING NOTE (task interplay): getStatus computes `autonomousExecution`
// ONLY when the persisted state exists AND `state.enabled` is true, otherwise
// undefined. Callers that key off that guard keep their distinct error semantics
// unchanged because the guard lives here in one place. In particular
// ArchonCoreService.getRuntimeTraceRegistry (still on the class, plan seam S6)
// reads `snapshot.autonomousExecution?.state` and throws when it is undefined —
// that throw is driven entirely by this guard. getRuntimeTraceRegistry stays on
// the class (it is memory/registry cluster, not S4) and calls this.getStatus,
// so moving getStatus here preserves its behavior exactly.
//
// The directive-execution half of S4 (executeDirectiveStep, loop history) lives
// in ./directive-execution.ts; it depends on this planner's getStatus/
// getExecutionPlan via injected closures, kept in a separate file so each
// module's max-lines ratchet entry stays independent and under the 800 cap.

import {
  collectAutonomousExecutionBlockers,
  selectAutonomousNextTarget,
  buildAutonomousExecutionSnapshot
} from "../runtime/autonomous-execution.ts";
import {
  collectUnsatisfiedReviewRoles,
  getRoleRetrievalGuidance
} from "./policy.ts";
import { readAutonomousExecutionState, uniqueStrings } from "./project-runtime-state.ts";
import { assessTaskPacketReasoning } from "./reasoning-quality.ts";
import type { ArchonStore } from "../store/types.ts";
import type {
  AutonomousExecutionSnapshot,
  AutonomousExecutionState,
  LockRecord,
  RecoveryInspectionReport,
  RoutingRecommendation,
  RoutingRecommendationReport,
  RunExecutionPlan,
  RunRecord,
  RunResumeSnapshot,
  RunStatusSnapshot,
  TaskPacketInput,
  TaskRecord
} from "../domain/types.ts";

function profileHasBroadRewriteScope(profile: AutonomousExecutionState["profile"]): boolean {
  return profile === "legacy_rewrite" || profile === "modernization_program";
}

function deriveNativeAutonomousDirective(input: {
  autonomousExecution: AutonomousExecutionSnapshot;
  blockers: readonly string[];
  terminalTasks: boolean;
}): RunExecutionPlan["directive"] | undefined {
  const { autonomousExecution, blockers, terminalTasks } = input;
  const { state, comprehensionSummary, coverageSummary, phaseReadiness, blockingGaps } = autonomousExecution;
  const manifestThresholds = state.manifest?.thresholds;
  const leadingRationale = terminalTasks
    ? "all tasks are terminal, but autonomous execution still requires native runtime remediation"
    : "no owner-dispatch task is available, and autonomous execution still requires native runtime remediation";

  const inventoryThreshold = manifestThresholds?.inventoryCompleteness;
  const rewriteClaimPhase =
    profileHasBroadRewriteScope(state.profile) &&
    (state.phase === "modernization_strategy" || state.phase === "migration_sequencing");
  const openInventoryGaps = rewriteClaimPhase
    ? state.gaps.filter((gap) => gap.status === "open" && gap.kind === "missing_inventory")
    : [];
  const inventoryBlockers = uniqueStrings([
    ...blockers.filter(
      (blocker) =>
        /inventory completeness|understanding map missing|modernization artifact missing|inventory gap open|dynamic discovery/i.test(blocker)
    ),
    ...openInventoryGaps.map((gap) => gap.description)
  ]);
  const needsInventoryRebuild =
    ((typeof inventoryThreshold === "number" &&
      (comprehensionSummary?.inventoryCompleteness ?? 0) < inventoryThreshold) ||
      inventoryBlockers.length > 0);
  if (needsInventoryRebuild) {
    const missingUnderstandingKinds = comprehensionSummary?.missingUnderstandingKinds ?? [];
    const missingEvidence = uniqueStrings([
      ...(comprehensionSummary?.missingEvidence ?? []),
      ...missingUnderstandingKinds.map((kind) => `understanding map missing: ${kind}`)
    ]);
    return {
      kind: "rebuild_inventory",
      missingUnderstandingKinds,
      missingEvidence,
      blockers:
        inventoryBlockers.length > 0
          ? inventoryBlockers
          : missingEvidence.length > 0
            ? missingEvidence
            : ["repo inventory remains incomplete for autonomous execution"],
      nextActions: uniqueStrings([
        ...missingUnderstandingKinds.map((kind) => `rebuild understanding map: ${kind}`),
        ...openInventoryGaps.flatMap((gap) => gap.suggestedNextActions),
        ...missingEvidence,
        ...state.pendingInvestigations
      ]),
      rationale: [
        leadingRationale,
        "comprehension evidence is still below the inventory threshold required for native continuation"
      ]
    };
  }

  const traceGapBlockers = blockingGaps.filter(
    (gap) => gap.status === "open" && gap.blocking && gap.kind === "missing_runtime_trace"
  );
  const traceBlockers = uniqueStrings([
    ...blockers.filter((blocker) => /runtime trace|risky trace/i.test(blocker)),
    ...phaseReadiness.reasons.filter((reason) => /runtime trace|risky trace/i.test(reason)),
    ...traceGapBlockers.map((gap) => gap.description)
  ]);
  const traceThreshold = manifestThresholds?.runtimeTraceCoverage;
  const tracePhaseActive =
    state.phase === "runtime_tracing" || phaseReadiness.phase === "runtime_tracing";
  const needsRuntimeTrace =
    traceGapBlockers.length > 0 ||
    ((tracePhaseActive || traceBlockers.length > 0) &&
      typeof traceThreshold === "number" &&
      coverageSummary.runtimeTraceCoverage < traceThreshold) ||
    traceBlockers.length > 0;
  if (needsRuntimeTrace) {
    return {
      kind: "trace_runtime",
      targetIds: uniqueStrings(traceGapBlockers.map((gap) => gap.targetId)),
      gapIds: uniqueStrings(traceGapBlockers.map((gap) => gap.id)),
      blockers:
        traceBlockers.length > 0
          ? traceBlockers
          : ["runtime trace coverage remains below the autonomous threshold"],
      nextActions: uniqueStrings(traceGapBlockers.flatMap((gap) => gap.suggestedNextActions)),
      rationale: [
        leadingRationale,
        "risky runtime paths still require trace-backed evidence before autonomous completion"
      ]
    };
  }

  const checkpointBlockers = uniqueStrings([
    ...blockers.filter((blocker) =>
      /progress proof|checkpoint|compressed context|compaction/i.test(blocker)
    ),
    ...phaseReadiness.reasons.filter((reason) =>
      /progress proof|checkpoint|compressed context|compaction/i.test(reason)
    )
  ]);
  if (checkpointBlockers.length > 0) {
    const latestCheckpoint = state.checkpoints.at(-1);
    const latestProof = state.progressProofs.at(-1);
    return {
      kind: "checkpoint",
      checkpointId: latestCheckpoint?.checkpointId,
      progressProofId: latestProof?.proofId,
      blockers: checkpointBlockers,
      nextActions: uniqueStrings([
        ...(latestCheckpoint?.nextActions ?? []),
        ...(latestProof?.whyNext ? [latestProof.whyNext] : [])
      ]),
      rationale: [
        leadingRationale,
        "checkpoint, progress-proof, or compaction evidence is still missing for native continuation"
      ]
    };
  }

  const pendingInvestigations = uniqueStrings(state.pendingInvestigations);
  if (pendingInvestigations.length > 0) {
    return {
      kind: "dispatch_subagents",
      pendingInvestigations,
      blockers: pendingInvestigations.map((investigation) => `pending investigation: ${investigation}`),
      nextActions: uniqueStrings(
        pendingInvestigations.flatMap((investigation) => [
          investigation,
          `dispatch subagent investigation: ${investigation}`
        ])
      ),
      rationale: [
        leadingRationale,
        "bounded autonomous investigations are still queued and need native subagent dispatch planning"
      ]
    };
  }

  const migrationPhaseActive =
    state.phase === "modernization_strategy" || state.phase === "migration_sequencing";
  if (migrationPhaseActive && (phaseReadiness.status === "blocked" || blockers.length > 0)) {
    const migrationBlockers = uniqueStrings(
      blockers.length > 0 ? [...blockers] : [...phaseReadiness.reasons]
    );
    return {
      kind: "replan_migration",
      phase: state.phase,
      fallbackPhase: phaseReadiness.fallbackPhase,
      blockers:
        migrationBlockers.length > 0
          ? migrationBlockers
          : ["migration sequencing still requires a runtime-backed replanning pass"],
      nextActions: uniqueStrings([
        phaseReadiness.fallbackPhase
          ? `replan toward ${phaseReadiness.fallbackPhase}`
          : `replan ${state.phase}`,
        ...phaseReadiness.reasons
      ]),
      rationale: [
        leadingRationale,
        "migration-phase readiness has fallen back and now requires an explicit runtime-backed replanning step"
      ]
    };
  }

  return undefined;
}

export interface StatusExecutionPlannerDeps {
  store: ArchonStore;
  requireRun: (runId: string) => Promise<RunRecord>;
  findTaskBlockers: (
    task: TaskRecord,
    allTasks: readonly TaskRecord[],
    activeLocks: readonly LockRecord[]
  ) => Promise<string[]>;
  inspectRecovery: (
    runId: string,
    options: { staleAfterHours?: number | undefined; now?: string | undefined }
  ) => Promise<RecoveryInspectionReport>;
}

export class StatusExecutionPlanner {
  private readonly store: ArchonStore;
  private readonly requireRun: (runId: string) => Promise<RunRecord>;
  private readonly findTaskBlockers: (
    task: TaskRecord,
    allTasks: readonly TaskRecord[],
    activeLocks: readonly LockRecord[]
  ) => Promise<string[]>;
  private readonly inspectRecovery: (
    runId: string,
    options: { staleAfterHours?: number | undefined; now?: string | undefined }
  ) => Promise<RecoveryInspectionReport>;

  constructor(deps: StatusExecutionPlannerDeps) {
    this.store = deps.store;
    this.requireRun = deps.requireRun;
    this.findTaskBlockers = deps.findTaskBlockers;
    this.inspectRecovery = deps.inspectRecovery;
  }

  async getStatus(runId: string): Promise<RunStatusSnapshot> {
    const run = await this.requireRun(runId);
    const plan = await this.store.getPlan(runId);
    const tasks = await this.store.getTasksByRun(runId);
    const activeLocks = await this.store.getActiveLocks(run.projectId);
    const runtimeState = await this.store.getProjectRuntimeState(run.projectId);
    const autonomousExecutionState = readAutonomousExecutionState(runtimeState?.metadata);
    const blockerEntries = await Promise.all(
      tasks.map(async (task) => ({
        taskId: task.packet.taskId,
        blockers: await this.findTaskBlockers(task, tasks, activeLocks)
      }))
    );
    const blockers = blockerEntries.flatMap((entry) => entry.blockers);
    const blockerMap = new Map(blockerEntries.map((entry) => [entry.taskId, entry.blockers]));
    const nextTaskIds = tasks
      .filter((task) => (blockerMap.get(task.packet.taskId) ?? []).length === 0)
      .filter((task) => task.status === "ready")
      .map((task) => task.packet.taskId);

    return {
      run,
      plan,
      tasks,
      activeLocks,
      blockers,
      nextTaskIds,
      autonomousExecution:
        autonomousExecutionState && autonomousExecutionState.enabled
          ? buildAutonomousExecutionSnapshot(autonomousExecutionState)
          : undefined
    };
  }

  async getExecutionPlan(
    runId: string,
    options: {
      staleAfterHours?: number | undefined;
    } = {}
  ): Promise<RunExecutionPlan> {
    const snapshot = await this.getStatus(runId);
    const routing = await this.recommendRouting(runId);
    const recovery = await this.inspectRecovery(runId, {
      staleAfterHours: options.staleAfterHours
    });
    const autonomousExecution = snapshot.autonomousExecution;
    const autonomousExecutionBlockers = autonomousExecution
      ? collectAutonomousExecutionBlockers(autonomousExecution.state, snapshot.tasks)
      : [];
    const autonomousNextTarget = autonomousExecution
      ? selectAutonomousNextTarget(autonomousExecution.state)
      : undefined;
    const allTasksTerminal =
      snapshot.tasks.length > 0 && snapshot.tasks.every((task) => task.status === "approved" || task.status === "done");
    const nativeAutonomousDirective =
      autonomousExecution &&
      !autonomousNextTarget &&
      (autonomousExecutionBlockers.length > 0 ||
        autonomousExecution.state.pendingInvestigations.length > 0 ||
        autonomousExecution.state.phase === "modernization_strategy" ||
        autonomousExecution.state.phase === "migration_sequencing")
        ? deriveNativeAutonomousDirective({
            autonomousExecution,
            blockers: autonomousExecutionBlockers,
            terminalTasks: allTasksTerminal
          })
        : undefined;

    const safeRecoveryActions = recovery.actions.filter((action) => action.safeToApply);
    if (safeRecoveryActions.length > 0) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "apply_recovery",
          actions: safeRecoveryActions,
          rationale: [
            "runtime recovery surfaced safe corrective actions before further routing",
            ...safeRecoveryActions.map((action) => `${action.kind}: ${action.rationale.join("; ")}`)
          ]
        }
      };
    }

    const reviewRecommendations = routing.recommendations.filter(
      (recommendation) => recommendation.recommendation === "review_dispatch"
    );
    if (reviewRecommendations.length > 0) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "dispatch_reviews",
          recommendations: reviewRecommendations,
          rationale: [
            "one or more tasks are blocked on required authenticated reviews",
            ...reviewRecommendations.map(
              (recommendation) =>
                `${recommendation.taskId}: ${recommendation.rationale.join("; ")}`
            )
          ]
        }
      };
    }

    const ownerRecommendation = routing.recommendations.find(
      (recommendation) => recommendation.recommendation === "owner_dispatch"
    );
    if (ownerRecommendation) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "dispatch_owner",
          recommendation: ownerRecommendation,
          rationale: [
            "a ready task with satisfied dependencies is available for execution",
            ...ownerRecommendation.rationale
          ]
        }
      };
    }

    if (allTasksTerminal) {
      const reasoningAssessments = snapshot.tasks.map((task) => ({
        taskId: task.packet.taskId,
        assessment: assessTaskPacketReasoning(task.packet)
      }));
      const reasoningBlockers = reasoningAssessments.flatMap(({ taskId, assessment }) =>
        assessment.blockers.map((warning) => `${taskId}: ${warning.message}`)
      );
      if (reasoningBlockers.length > 0) {
        return {
          mode: "runtime_authoritative",
          runId,
          runStatus: snapshot.run.status,
          autonomousExecution,
          directive: {
            kind: "blocked",
            blockers: reasoningBlockers,
            rationale: [
              "all tasks are terminal, but strict reasoning blockers still prevent final completion",
              ...reasoningBlockers.map((warning) => `reasoning-quality: ${warning}`)
            ]
          }
        };
      }

      const reasoningWarnings = reasoningAssessments.flatMap(({ taskId, assessment }) =>
        assessment.warnings.map((warning) => `${taskId}: ${warning.message}`)
      );
      if (nativeAutonomousDirective) {
        return {
          mode: "runtime_authoritative",
          runId,
          runStatus: snapshot.run.status,
          autonomousExecution,
          directive: nativeAutonomousDirective
        };
      }
      if (autonomousExecutionBlockers.length > 0 && autonomousNextTarget) {
        return {
          mode: "runtime_authoritative",
          runId,
          runStatus: snapshot.run.status,
          autonomousExecution,
          directive: {
            kind: "continue_analysis",
            targetId: autonomousNextTarget.targetId,
            source: autonomousNextTarget.source,
            actions: autonomousNextTarget.actions,
            nextActions: autonomousNextTarget.nextActions,
            blockers: autonomousExecutionBlockers,
            rationale: [
              "all tasks are terminal, but autonomous continuation still has an actionable next target",
              ...autonomousExecutionBlockers.map((blocker) => `autonomous-execution: ${blocker}`),
              ...autonomousNextTarget.rationale
            ]
          }
        };
      }

      if (autonomousExecutionBlockers.length > 0) {
        return {
          mode: "runtime_authoritative",
          runId,
          runStatus: snapshot.run.status,
          autonomousExecution,
          directive: {
            kind: "blocked",
            blockers: autonomousExecutionBlockers,
            rationale: [
              "all tasks are terminal, but autonomous execution requirements still block completion",
              ...autonomousExecutionBlockers.map((blocker) => `autonomous-execution: ${blocker}`)
            ]
          }
        };
      }

      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "complete",
          rationale: [
            "all tasks have reached terminal approved or done states",
            ...(reasoningWarnings.length > 0
              ? [
                  "reasoning-quality: derived warnings remain advisory-only",
                  ...reasoningWarnings.map(
                    (warning) => `reasoning-quality: ${warning}`
                  )
                ]
              : [])
          ]
        }
      };
    }

    if (
      nativeAutonomousDirective &&
      snapshot.tasks.every((task) => task.status !== "in_progress")
    ) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: nativeAutonomousDirective
      };
    }

    if (
      autonomousNextTarget &&
      snapshot.tasks.every((task) => task.status !== "in_progress")
    ) {
      return {
        mode: "runtime_authoritative",
        runId,
        runStatus: snapshot.run.status,
        autonomousExecution,
        directive: {
          kind: "continue_analysis",
          targetId: autonomousNextTarget.targetId,
          source: autonomousNextTarget.source,
          actions: autonomousNextTarget.actions,
          nextActions: autonomousNextTarget.nextActions,
          blockers: autonomousExecutionBlockers,
          rationale: [
            "no ready task is available, but autonomous continuation can still advance from persisted runtime evidence",
            ...autonomousNextTarget.rationale
          ]
        }
      };
    }

    const blockers = this.collectExecutionBlockers(snapshot, routing, recovery);
    return {
      mode: "runtime_authoritative",
      runId,
      runStatus: snapshot.run.status,
      autonomousExecution,
      directive: {
        kind: "blocked",
        blockers,
        rationale: [
          blockers.length > 0
            ? "runtime state has no executable next step"
            : "run has no executable next step and no task graph progress can be derived"
        ]
      }
    };
  }

  async resumeRun(runId: string): Promise<RunResumeSnapshot> {
    const snapshot = await this.getStatus(runId);
    const executionPlan = await this.getExecutionPlan(runId);
    return {
      ...snapshot,
      executionPlan
    };
  }

  async recommendRouting(runId: string): Promise<RoutingRecommendationReport> {
    const snapshot = await this.getStatus(runId);
    const blockerMap = new Map<string, string[]>();
    const recommendations: RoutingRecommendation[] = [];

    for (const task of snapshot.tasks) {
      const blockers = await this.findTaskBlockers(task, snapshot.tasks, snapshot.activeLocks);
      const reasoningAssessment = assessTaskPacketReasoning(task.packet);
      const reasoningBlockers = reasoningAssessment.blockers.map((warning) => warning.message);
      const effectiveBlockers = [...blockers, ...reasoningBlockers];
      blockerMap.set(task.packet.taskId, effectiveBlockers);
      const ownerRole = task.packet.ownerRole as TaskPacketInput["requiredSpecialistRoles"][number];
      const reasoningRationale = reasoningAssessment.warnings.map(
        (warning) => `reasoning-quality: ${warning.message}`
      );
      const reasoningBlockingRationale = reasoningAssessment.blockers.map(
        (warning) => `reasoning-quality: ${warning.message}`
      );
      const reasoningCheckpoint =
        reasoningAssessment.status === "warn"
          ? "resolve or explicitly record reasoning-quality warnings before finalizing the task"
          : "reasoning-quality block includes evidence, alternatives, and a verification plan";

      if (task.status === "ready" && effectiveBlockers.length === 0) {
        recommendations.push({
          taskId: task.packet.taskId,
          taskStatus: task.status,
          recommendation: "owner_dispatch",
          authorityLabel: "derived_only",
          targetRole: ownerRole,
          rationale: [
            "task is ready with dependencies satisfied",
            `owner role is ${ownerRole}`,
            ...reasoningRationale,
            ...reasoningBlockingRationale
          ],
          blockers: [],
          allowedWriteScope: [...task.packet.allowedWriteScope],
          retrievalGuidance: getRoleRetrievalGuidance(ownerRole),
          approvalCheckpoints: [
            "manager must explicitly choose to route this task",
            `writer must claim ${task.packet.taskId} before edits`,
            `required reviews before completion: ${task.packet.requiredReviews.join(", ")}`,
            reasoningCheckpoint
          ]
        });
        continue;
      }

      if (task.status === "review_blocked") {
        const reviews = await this.store.getReviews(runId, task.packet.taskId);
        const missingReviewRoles = collectUnsatisfiedReviewRoles(task, reviews);

        for (const reviewRole of missingReviewRoles) {
          recommendations.push({
            taskId: task.packet.taskId,
            taskStatus: task.status,
            recommendation: "review_dispatch",
            authorityLabel: "derived_only",
            targetRole: reviewRole,
            targetReviewRole: reviewRole,
            rationale: [`review gate ${reviewRole} is still unsatisfied`],
            blockers:
              effectiveBlockers.length > 0
                ? [...effectiveBlockers]
                : [`missing required review: ${reviewRole}`],
            allowedWriteScope: [],
            retrievalGuidance: getRoleRetrievalGuidance(reviewRole),
            approvalCheckpoints: [
              "review actor must authenticate through the trusted review identity resolver",
              "manager must persist or attach authenticated reviewer evidence before completion",
              reasoningCheckpoint
            ]
          });
          if (reasoningRationale.length > 0) {
            recommendations[recommendations.length - 1]!.rationale.push(...reasoningRationale);
          }
          if (reasoningBlockingRationale.length > 0) {
            recommendations[recommendations.length - 1]!.rationale.push(...reasoningBlockingRationale);
          }
        }
        continue;
      }

      if (task.status === "in_progress" || effectiveBlockers.length > 0) {
        recommendations.push({
          taskId: task.packet.taskId,
          taskStatus: task.status,
          recommendation: "wait",
          authorityLabel: "derived_only",
          targetRole: ownerRole,
          rationale:
            task.status === "in_progress" && task.claimedBy
              ? [`task is already claimed by ${task.claimedBy}`]
              : ["task is not yet ready for routing"],
          blockers: [...effectiveBlockers],
          allowedWriteScope: [...task.packet.allowedWriteScope],
          retrievalGuidance: getRoleRetrievalGuidance(ownerRole),
          approvalCheckpoints: [
            "do not route an overlapping writer while the task remains claimed or blocked",
            "clear blockers before assigning the next specialist",
            reasoningCheckpoint
          ]
        });
        if (reasoningRationale.length > 0) {
          recommendations[recommendations.length - 1]!.rationale.push(...reasoningRationale);
        }
        if (reasoningBlockingRationale.length > 0) {
          recommendations[recommendations.length - 1]!.rationale.push(...reasoningBlockingRationale);
        }
      }
    }

    return {
      mode: "advisory_only",
      runId: snapshot.run.id,
      recommendations
    };
  }

  private collectExecutionBlockers(
    snapshot: RunStatusSnapshot,
    routing: RoutingRecommendationReport,
    recovery: RecoveryInspectionReport
  ): string[] {
    const blockers = new Set<string>();

    for (const blocker of snapshot.blockers) {
      blockers.add(blocker);
    }

    for (const recommendation of routing.recommendations) {
      if (recommendation.recommendation !== "wait") {
        continue;
      }

      if (recommendation.blockers.length > 0) {
        for (const blocker of recommendation.blockers) {
          blockers.add(blocker);
        }
        continue;
      }

      for (const rationale of recommendation.rationale) {
        blockers.add(rationale);
      }
    }

    for (const issue of recovery.issues) {
      for (const detail of issue.details) {
        blockers.add(detail);
      }
    }

    if (blockers.size === 0 && snapshot.tasks.length === 0) {
      blockers.add("run has no task graph");
    }

    return [...blockers];
  }
}
