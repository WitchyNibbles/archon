// Directive execution + loop-execution history.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4).
// This is the execution half of slice 3 (plan seam S4). It owns the
// directive-execution loop (executeDirectiveStep), the runtime authority guard
// it runs first (ensureDirectiveExecutionAuthority), the operational-context
// loop-history writer (persistLoopExecutionHistory), and the loop-history reader
// (getLoopExecutionHistory).
//
// The plan-derivation half (getStatus/getExecutionPlan/recommendRouting/
// resumeRun) lives in ./status-execution-planner.ts. This module depends on that
// planner ONLY through the injected `getStatus` / `getExecutionPlan` closures the
// class supplies — no direct import — so the two modules stay decoupled and each
// keeps an independent max-lines ratchet entry under the 800 cap. `claimTask`
// (lifecycle, plan seam S2) is likewise injected: executeDirectiveStep's
// dispatch_owner branch is its only caller here.
//
// The directive-execution interfaces (DirectiveExecutionStep, ...) are DEFINED
// here and re-exported from service.ts so existing consumers that import them
// from "../core/service.ts" (daemon, admin, tests) keep working unchanged — the
// public type surface is preserved.

import { randomUUID } from "node:crypto";
import { normalizeRetrievalMetadata } from "../domain/contracts.ts";
import { canRoleAccessSearchResult } from "./policy.ts";
import { timestamp } from "./project-runtime-state.ts";
import { annotateConflictSignals, isProvenancedSearchResult } from "./search-memory-results.ts";
import type { ArchonStore } from "../store/types.ts";
import type {
  RoutingRecommendation,
  RunExecutionPlan,
  RunRecord,
  RunStatusSnapshot,
  SearchMemoryResult,
  TaskPacketInput,
  TaskRecord
} from "../domain/types.ts";

export interface ExecuteReviewRecommendationResult {
  executed: boolean;
  taskId?: string | undefined;
  actor?: string | undefined;
  reviewRole?: RoutingRecommendation["targetReviewRole"] | undefined;
  evidence: string[];
}

export interface ExecuteContinuationActionResult {
  executed: boolean;
  taskId?: string | undefined;
  evidence: string[];
}

export interface DirectiveExecutionStep {
  directiveKind: RunExecutionPlan["directive"]["kind"];
  outcome: "executed" | "unsupported" | "blocked" | "complete";
  taskId?: string | undefined;
  actor?: string | undefined;
  reviewRole?: RoutingRecommendation["targetReviewRole"] | undefined;
  nextDirectiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
  evidence: string[];
}

export interface ExecuteDirectiveStepOptions {
  staleAfterHours?: number | undefined;
  ownerActor?: string | undefined;
  maxReviewDispatchSteps?: number | undefined;
  executeReviewRecommendation?: (input: {
    runId: string;
    directive: Extract<RunExecutionPlan["directive"], { kind: "dispatch_reviews" }>;
  }) => Promise<ExecuteReviewRecommendationResult>;
  executeContinuationAction?: (input: {
    runId: string;
    directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
    action: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>["actions"][number];
  }) => Promise<ExecuteContinuationActionResult>;
}

export interface DirectiveExecutionResult {
  runId: string;
  initialPlan: RunExecutionPlan;
  steps: DirectiveExecutionStep[];
  finalPlan: RunExecutionPlan;
  snapshot: RunStatusSnapshot;
}

const LOOP_HISTORY_TAG = "runtime_loop_history";
const LOOP_HISTORY_ACTOR = "archon-runtime-loop";
const LOOP_HISTORY_QUERY_PREFIX = "runtime loop history";

function parseWorkspaceSlugFromId(workspaceId: string): string | undefined {
  return workspaceId.startsWith("workspace:") ? workspaceId.slice("workspace:".length) : undefined;
}

function parseProjectSelectorFromId(projectId: string):
  | { workspaceSlug: string; projectSlug: string }
  | undefined {
  const parts = projectId.split(":");
  if (parts.length < 3 || parts[0] !== "project") {
    return undefined;
  }

  return {
    workspaceSlug: parts[1]!,
    projectSlug: parts.slice(2).join(":")
  };
}

export interface DirectiveExecutionManagerDeps {
  store: ArchonStore;
  requireRun: (runId: string) => Promise<RunRecord>;
  claimTask: (runId: string, taskId: string, actor: string) => Promise<TaskRecord>;
  getStatus: (runId: string) => Promise<RunStatusSnapshot>;
  getExecutionPlan: (
    runId: string,
    options?: { staleAfterHours?: number | undefined }
  ) => Promise<RunExecutionPlan>;
}

export class DirectiveExecutionManager {
  private readonly store: ArchonStore;
  private readonly requireRun: (runId: string) => Promise<RunRecord>;
  private readonly claimTask: (runId: string, taskId: string, actor: string) => Promise<TaskRecord>;
  private readonly getStatus: (runId: string) => Promise<RunStatusSnapshot>;
  private readonly getExecutionPlan: (
    runId: string,
    options?: { staleAfterHours?: number | undefined }
  ) => Promise<RunExecutionPlan>;

  constructor(deps: DirectiveExecutionManagerDeps) {
    this.store = deps.store;
    this.requireRun = deps.requireRun;
    this.claimTask = deps.claimTask;
    this.getStatus = deps.getStatus;
    this.getExecutionPlan = deps.getExecutionPlan;
  }

  private async ensureDirectiveExecutionAuthority(
    runId: string,
    _directive: RunExecutionPlan["directive"]
  ): Promise<void> {
    const run = await this.requireRun(runId);
    const registration = await this.store.getProjectRuntimeRegistration(run.projectId);
    if (!registration) {
      throw new Error(
        "directive execution requires runtime registration for the target project; run doctor --repair or bootstrap-project before executing directives"
      );
    }

    const runtimeState = await this.store.getProjectRuntimeState(run.projectId);
    if (!runtimeState || runtimeState.activeRunId !== runId) {
      throw new Error(
        "directive execution requires the target run to be the active authoritative runtime run"
      );
    }

  }

  async executeDirectiveStep(
    runId: string,
    options: ExecuteDirectiveStepOptions = {}
  ): Promise<DirectiveExecutionResult> {
    const staleAfterHours = options.staleAfterHours;
    const initialPlan = await this.getExecutionPlan(runId, { staleAfterHours });
    await this.ensureDirectiveExecutionAuthority(runId, initialPlan.directive);
    const steps: DirectiveExecutionStep[] = [];
    let finalPlan = initialPlan;

    if (initialPlan.directive.kind === "dispatch_owner") {
      const recommendation = initialPlan.directive.recommendation;
      const actor = options.ownerActor?.trim() || recommendation.targetRole;
      if (!actor) {
        steps.push({
          directiveKind: "dispatch_owner",
          outcome: "unsupported",
          taskId: recommendation.taskId,
          nextDirectiveKind: finalPlan.directive.kind,
          evidence: [
            "owner dispatch did not execute because no owner actor was supplied",
            "runtime state was left unchanged"
          ]
        });
      } else {
        await this.claimTask(runId, recommendation.taskId, actor);
        finalPlan = await this.getExecutionPlan(runId, { staleAfterHours });
        steps.push({
          directiveKind: "dispatch_owner",
          outcome: "executed",
          taskId: recommendation.taskId,
          actor,
          nextDirectiveKind: finalPlan.directive.kind,
          evidence: [
            `claimed ${recommendation.taskId} as ${actor}`,
            `re-evaluated runtime plan and reached ${finalPlan.directive.kind}`
          ]
        });
      }
    } else if (initialPlan.directive.kind === "dispatch_reviews") {
      const executeReviewRecommendation = options.executeReviewRecommendation;
      if (!executeReviewRecommendation) {
        steps.push({
          directiveKind: "dispatch_reviews",
          outcome: "unsupported",
          taskId: initialPlan.directive.recommendations[0]?.taskId,
          reviewRole: initialPlan.directive.recommendations[0]?.targetReviewRole,
          nextDirectiveKind: finalPlan.directive.kind,
          evidence: [
            "no supported authenticated review executor was supplied",
            "review dispatch failed closed without fabricating progress"
          ]
        });
      } else {
        const maxReviewDispatchSteps = Math.max(
          1,
          options.maxReviewDispatchSteps ?? initialPlan.directive.recommendations.length
        );

        for (let index = 0; index < maxReviewDispatchSteps; index += 1) {
          if (finalPlan.directive.kind !== "dispatch_reviews") {
            break;
          }

          const result = await executeReviewRecommendation({
            runId,
            directive: finalPlan.directive
          });
          if (!result.executed) {
            steps.push({
              directiveKind: "dispatch_reviews",
              outcome: "unsupported",
              taskId: result.taskId ?? finalPlan.directive.recommendations[0]?.taskId,
              actor: result.actor,
              reviewRole: result.reviewRole ?? finalPlan.directive.recommendations[0]?.targetReviewRole,
              nextDirectiveKind: finalPlan.directive.kind,
              evidence:
                result.evidence.length > 0
                  ? [...result.evidence]
                  : ["review dispatch executor declined to apply the next authenticated review"]
            });
            break;
          }

          finalPlan = await this.getExecutionPlan(runId, { staleAfterHours });
          steps.push({
            directiveKind: "dispatch_reviews",
            outcome: "executed",
            taskId: result.taskId,
            actor: result.actor,
            reviewRole: result.reviewRole,
            nextDirectiveKind: finalPlan.directive.kind,
            evidence: [
              ...result.evidence,
              `re-evaluated runtime plan and reached ${finalPlan.directive.kind}`
            ]
          });
        }
      }
    } else if (initialPlan.directive.kind === "complete") {
      steps.push({
        directiveKind: "complete",
        outcome: "complete",
        nextDirectiveKind: finalPlan.directive.kind,
        evidence: ["all tasks are already terminal; no further directive execution was needed"]
      });
    } else if (initialPlan.directive.kind === "blocked") {
      steps.push({
        directiveKind: "blocked",
        outcome: "blocked",
        nextDirectiveKind: finalPlan.directive.kind,
        evidence:
          initialPlan.directive.blockers.length > 0
            ? [...initialPlan.directive.blockers]
            : ["run has no executable next step"]
      });
    } else if (initialPlan.directive.kind === "continue_analysis") {
      const executeContinuationAction = options.executeContinuationAction;
      const nextAction = initialPlan.directive.actions[0];
      if (!executeContinuationAction || !nextAction) {
        steps.push({
          directiveKind: "continue_analysis",
          outcome: "unsupported",
          nextDirectiveKind: finalPlan.directive.kind,
          evidence: [
            `next target remains ${initialPlan.directive.targetId}`,
            ...initialPlan.directive.actions.map((action) => `action:${action.kind}`),
            ...initialPlan.directive.nextActions
          ]
        });
      } else {
        const result = await executeContinuationAction({
          runId,
          directive: initialPlan.directive,
          action: nextAction
        });
        if (!result.executed) {
          steps.push({
            directiveKind: "continue_analysis",
            outcome: "unsupported",
            taskId: result.taskId ?? initialPlan.directive.targetId,
            nextDirectiveKind: finalPlan.directive.kind,
            evidence:
              result.evidence.length > 0
                ? [...result.evidence]
                : ["continuation executor declined to apply the next typed autonomous action"]
          });
        } else {
          finalPlan = await this.getExecutionPlan(runId, { staleAfterHours });
          steps.push({
            directiveKind: "continue_analysis",
            outcome: "executed",
            taskId: result.taskId ?? initialPlan.directive.targetId,
            nextDirectiveKind: finalPlan.directive.kind,
            evidence: [
              ...result.evidence,
              `re-evaluated runtime plan and reached ${finalPlan.directive.kind}`
            ]
          });
        }
      }
    } else if (initialPlan.directive.kind === "apply_recovery") {
      steps.push({
        directiveKind: "apply_recovery",
        outcome: "blocked",
        nextDirectiveKind: finalPlan.directive.kind,
        evidence: [
          "safe recovery must be applied explicitly before directive execution can continue"
        ]
      });
    } else if (
      initialPlan.directive.kind === "dispatch_subagents" ||
      initialPlan.directive.kind === "rebuild_inventory" ||
      initialPlan.directive.kind === "trace_runtime" ||
      initialPlan.directive.kind === "checkpoint" ||
      initialPlan.directive.kind === "replan_migration"
    ) {
      steps.push({
        directiveKind: initialPlan.directive.kind,
        outcome: "blocked",
        nextDirectiveKind: finalPlan.directive.kind,
        evidence: [
          ...initialPlan.directive.blockers,
          ...(initialPlan.directive.nextActions.length > 0
            ? initialPlan.directive.nextActions.map((action) => `next:${action}`)
            : ["native autonomous remediation requires explicit operator or worker execution"])
        ]
      });
    }

    if (steps.length > 0) {
      await this.persistLoopExecutionHistory(runId, steps);
    }

    const snapshot = await this.getStatus(runId);
    return {
      runId,
      initialPlan,
      steps,
      finalPlan,
      snapshot
    };
  }

  async getLoopExecutionHistory(
    runId: string,
    options: {
      limit?: number | undefined;
      requesterRole?: TaskPacketInput["requiredSpecialistRoles"][number] | undefined;
    } = {}
  ): Promise<SearchMemoryResult[]> {
    const run = await this.requireRun(runId);
    const workspaceSlug = parseWorkspaceSlugFromId(run.workspaceId);
    const projectSelector = parseProjectSelectorFromId(run.projectId);

    if (!workspaceSlug || !projectSelector || projectSelector.workspaceSlug !== workspaceSlug) {
      return [];
    }

    const results = await this.store.searchMemory({
      workspaceSlug,
      projectSlug: projectSelector.projectSlug,
      query: `${LOOP_HISTORY_QUERY_PREFIX} ${runId}`,
      limit: Math.max(1, options.limit ?? 10),
      includeGlobal: false,
      requesterRole: options.requesterRole ?? "planner"
    });

    return annotateConflictSignals(
      results
        .filter((result) => canRoleAccessSearchResult(result, options.requesterRole ?? "planner"))
        .filter(isProvenancedSearchResult)
        .filter(
          (result) =>
            result.provenance.runId === runId && result.metadata.tags.includes(LOOP_HISTORY_TAG)
        )
        .sort((left, right) => right.provenance.createdAt.localeCompare(left.provenance.createdAt))
    );
  }

  // NON-BLOCKING (intentional exempt): direct saveMemoryEntry call here bypasses
  // the promoteMemory trust gate — this is an intentional exempt internal
  // telemetry path writing operational_context-tier loop history that is not
  // caller-controllable. Reviewed and accepted by security gate 2026-06-21.
  private async persistLoopExecutionHistory(
    runId: string,
    steps: readonly DirectiveExecutionStep[]
  ): Promise<void> {
    if (steps.length === 0) {
      return;
    }

    const run = await this.requireRun(runId);
    const recordedAt = timestamp();

    for (const [index, step] of steps.entries()) {
      await this.store.saveMemoryEntry({
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        runId,
        taskId: step.taskId,
        scope: "project",
        entryType: "fact",
        title: `${LOOP_HISTORY_QUERY_PREFIX} ${runId} ${step.directiveKind} ${step.outcome}`,
        content: [
          `runId=${runId}`,
          `step=${index + 1}`,
          `directive=${step.directiveKind}`,
          `outcome=${step.outcome}`,
          step.taskId ? `taskId=${step.taskId}` : undefined,
          step.actor ? `actor=${step.actor}` : undefined,
          step.reviewRole ? `reviewRole=${step.reviewRole}` : undefined,
          step.nextDirectiveKind ? `nextDirective=${step.nextDirectiveKind}` : undefined,
          ...step.evidence.map((evidence) => `evidence=${evidence}`)
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        reviewer: LOOP_HISTORY_ACTOR,
        actor: LOOP_HISTORY_ACTOR,
        status: "approved",
        metadata: normalizeRetrievalMetadata({
          tags: [
            LOOP_HISTORY_TAG,
            `run:${runId}`,
            `directive:${step.directiveKind}`,
            `outcome:${step.outcome}`,
            `step:${index + 1}`,
            ...(step.taskId ? [`task:${step.taskId}`] : []),
            ...(step.actor ? [`actor:${step.actor}`] : []),
            ...(step.reviewRole ? [`reviewRole:${step.reviewRole}`] : []),
            ...(step.nextDirectiveKind ? [`next:${step.nextDirectiveKind}`] : [])
          ],
          reviewedAt: recordedAt,
          staleAfterDays: 3650,
          authorityLevel: "operational_context"
        }),
        createdAt: recordedAt
      });
    }

    await this.store.updateRun({
      ...run,
      updatedAt: recordedAt
    });
  }
}
