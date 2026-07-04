// Gate + closure manager — completion authority of the runtime.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4).
// This is the FINAL slice (S3) of the ArchonCoreService decomposition and owns
// the highest-coupling cluster: the review/handoff gates and the
// dependency-staleness helper that guards task readiness.
//
//   - submitHandoff   — records a worker handoff, moves the task to
//                       review_blocked, and fires the (non-blocking) onHandoff
//                       ingestion hook.
//   - recordReview    — the completion-authority gate: resolves a trusted review
//                       action context, validates it, writes the review +
//                       approval, and on approval writes the review-floor
//                       reduction provenance row before releasing locks.
//   - findTaskBlockers — blocking-reason derivation including stale-dependency
//                       reblock; injected back into TaskLifecycleManager and
//                       StatusExecutionPlanner (both consume it read-only).
//
// TRUST BOUNDARY (unchanged by the extraction — every check preserved verbatim,
// in the same order):
//   - recordReview requires a trusted `resolveReviewActionContext` resolver;
//     absent one it throws before touching any state.
//   - The resolved context is validated by validateReviewAction; the stored
//     actor/actorRole always come from the CONTEXT, never from the caller.
//   - `source` on every review + approval is the injected reviewSource
//     ("orchestrator" default; "seed" for never-trusted synthetic proof seeds).
//   - Floor-reduction provenance: on approval under a reduced review floor the
//     SAME isReviewFloorReduced / effectiveRequiredReviewsForTask predicates that
//     drove the gate decision compute the durable ReviewFloorReductionRecord, so
//     the floor decision and its audit row can never drift.
//   - The mistake-ledger capture hook (fireMistakeCapture) runs BEFORE the
//     distillation hook (fireDistillation), both after the review is saved and
//     both strictly non-blocking. Distillation promotes through the injected
//     `promoteMemory` delegate so the P0 promotion trust gate still runs on the
//     autonomous path.
//
// CLOSURE WIRING: bumpRunState and promoteMemory are injected lazy delegates
// (`(…) => this.taskLifecycle.bumpRunState(…)` / `(…) => this.memorySearch
// .promoteMemory(…)`), and findTaskBlockers is injected FROM this manager INTO
// the lifecycle/planner. These form runtime closures bound by ArchonCoreService;
// no import cycle forms because this module imports only leaf helpers (contracts,
// types, policy, task-queue-projection, project-runtime-state, mistake-capture)
// and never service.ts or the sibling managers.

import { randomUUID } from "node:crypto";
import {
  validateReviewAction,
  validateHandoff,
  effectiveRequiredReviewsForTask,
  isReviewFloorReduced
} from "../domain/contracts.ts";
import { requiredGateReviews } from "../domain/types.ts";
import {
  evaluateReviewDecision,
  findBlockingReasonsForTask,
  findTaskDependencies
} from "./policy.ts";
import { buildRuntimeTaskQueue, deriveRunStatus } from "./task-queue-projection.ts";
import { buildDefaultProductState, timestamp } from "./project-runtime-state.ts";
import { fireMistakeCapture, fireDistillation } from "../runtime/mistake-capture.ts";
import type { ResolveReviewActionContext } from "./review-context.ts";
import type { AntiPatternDraftStoreLike, MistakeLedgerStoreLike } from "../store/types.ts";
import type { ArchonStore } from "../store/types.ts";
import type {
  HandoffInput,
  LockRecord,
  MemoryPromotionInput,
  ReviewFloorReductionRecord,
  ReviewInput,
  ReviewRecord,
  RunRecord,
  TaskRecord
} from "../domain/types.ts";

// Handoff-ingestion lifecycle event. DEFINED here (the gate cluster that fires it)
// and re-exported from ./service.ts so existing consumers keep importing it from
// "../core/service.ts" unchanged — the public type surface is preserved.
export interface HandoffLifecycleEvent {
  runId: string;
  taskId: string;
  actor: string;
}

export interface GateClosureManagerDeps {
  store: ArchonStore;
  requireTask: (runId: string, taskId: string) => Promise<TaskRecord>;
  bumpRunState: (runId: string, status: RunRecord["status"]) => Promise<unknown>;
  reviewSource: "orchestrator" | "seed";
  onHandoff?: ((event: HandoffLifecycleEvent) => Promise<void>) | undefined;
  resolveReviewActionContext?: ResolveReviewActionContext | undefined;
  mistakeLedgerStore?: MistakeLedgerStoreLike | undefined;
  antiPatternDraftStore?: AntiPatternDraftStoreLike | undefined;
  // Bound to the memory/search manager's promoteMemory so the P0 promotion trust
  // gate runs on the distillation path; never mints trusted contexts here.
  promoteMemory: (runId: string, input: MemoryPromotionInput) => Promise<unknown>;
}

export class GateClosureManager {
  private readonly store: ArchonStore;
  private readonly requireTask: (runId: string, taskId: string) => Promise<TaskRecord>;
  private readonly bumpRunState: (runId: string, status: RunRecord["status"]) => Promise<unknown>;
  private readonly reviewSource: "orchestrator" | "seed";
  private readonly onHandoff?: ((event: HandoffLifecycleEvent) => Promise<void>) | undefined;
  private readonly resolveReviewActionContext?: ResolveReviewActionContext | undefined;
  private readonly mistakeLedgerStore?: MistakeLedgerStoreLike | undefined;
  private readonly antiPatternDraftStore?: AntiPatternDraftStoreLike | undefined;
  private readonly promoteMemory: (runId: string, input: MemoryPromotionInput) => Promise<unknown>;

  constructor(deps: GateClosureManagerDeps) {
    this.store = deps.store;
    this.requireTask = deps.requireTask;
    this.bumpRunState = deps.bumpRunState;
    this.reviewSource = deps.reviewSource;
    this.onHandoff = deps.onHandoff;
    this.resolveReviewActionContext = deps.resolveReviewActionContext;
    this.mistakeLedgerStore = deps.mistakeLedgerStore;
    this.antiPatternDraftStore = deps.antiPatternDraftStore;
    this.promoteMemory = deps.promoteMemory;
  }

  async submitHandoff(runId: string, taskId: string, handoff: HandoffInput) {
    const task = await this.requireTask(runId, taskId);
    if (task.status !== "in_progress") {
      throw new Error(`Task ${taskId} must be in progress before handoff`);
    }

    const validationErrors = validateHandoff(handoff);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid handoff: ${validationErrors.join("; ")}`);
    }

    if (handoff.ownerRole !== task.packet.ownerRole) {
      throw new Error(`Invalid handoff: ownerRole must match task ownerRole ${task.packet.ownerRole}`);
    }

    if (handoff.completionStandard !== task.packet.completionStandard) {
      throw new Error(
        `Invalid handoff: completionStandard must match task completionStandard ${task.packet.completionStandard}`
      );
    }

    const record = {
      id: randomUUID(),
      runId,
      taskId,
      actor: handoff.actor,
      ownerRole: handoff.ownerRole,
      completionStandard: handoff.completionStandard,
      summary: handoff.summary,
      changedFiles: [...handoff.changedFiles],
      blockers: [...handoff.blockers],
      verificationNotes: [...handoff.verificationNotes],
      executionEvidence: [...handoff.executionEvidence],
      qualityGateEvidence: [...handoff.qualityGateEvidence],
      contextRefs: [...handoff.contextRefs],
      createdAt: timestamp()
    };

    await this.store.saveHandoff(record);
    await this.store.updateTask({
      ...task,
      status: "review_blocked",
      updatedAt: timestamp()
    });
    await this.bumpRunState(runId, "review_blocked");
    const allTasks = await this.store.getTasksByRun(runId);
    const reviewBlockedTasks = allTasks.map((candidate) =>
      candidate.packet.taskId === taskId
        ? {
            ...candidate,
            status: "review_blocked" as const,
            updatedAt: record.createdAt
          }
        : candidate
    );
    const existingState = await this.store.getProjectRuntimeState(task.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      activeRunId: runId,
      activeTaskId: taskId,
      taskQueue: buildRuntimeTaskQueue("review_blocked", reviewBlockedTasks, taskId),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? record.createdAt,
      updatedAt: record.createdAt
    });

    if (this.onHandoff) {
      await this.onHandoff({ runId, taskId, actor: handoff.actor }).catch(() => {
        // ingestion errors must never block handoff completion
      });
    }

    return record;
  }

  async recordReview(runId: string, taskId: string, actor: string, review: ReviewInput) {
    if (!this.resolveReviewActionContext) {
      throw new Error("recordReview requires a trusted review action context resolver");
    }

    const task = await this.requireTask(runId, taskId);
    if (task.status !== "review_blocked") {
      throw new Error(`Task ${taskId} must be review_blocked before reviews can be recorded`);
    }

    let context;
    try {
      context = await this.resolveReviewActionContext({
        runId,
        taskId,
        actor,
        reviewerRole: review.reviewerRole,
        reviewState: review.state
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid review action: ${message}`);
    }

    const validationErrors = validateReviewAction(context, review);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid review action: ${validationErrors.join("; ")}`);
    }

    // P2.1 / P1.5: when findingDetails is supplied, derive findings[] from the message
    // fields so the free-text view always matches the structured records and callers
    // cannot record divergent text.  Three sub-cases:
    //   • Accepted pass (all findingDetails have disposition="accepted"): derive from
    //     findingDetails — makes findings[] canonical for the P2.1 accepted path.
    //   • Non-passing review (blocked/failed) with findingDetails: derive from
    //     findingDetails so reviewers don't double-author (P1.5 behaviour).
    //   • Clean pass with provenance-only findingDetails (no acceptance disposition):
    //     keep findings[] from the caller (normally []) so the gate is not broken by
    //     deriving non-empty findings that lack acceptance records.
    const allFindingDetailsAccepted =
      review.findingDetails !== undefined &&
      review.findingDetails.length > 0 &&
      review.findingDetails.every((f) => f.disposition === "accepted");
    const shouldDeriveFromDetails =
      allFindingDetailsAccepted ||
      (review.state !== "passed" &&
       review.findingDetails !== undefined &&
       review.findingDetails.length > 0);
    const derivedFindings: string[] = shouldDeriveFromDetails
      ? review.findingDetails!.map((f) => f.message)
      : [...review.findings];

    const reviewRecord: ReviewRecord = {
      id: randomUUID(),
      runId,
      taskId,
      reviewerRole: review.reviewerRole,
      actor: context.actor,
      actorRole: context.actorRole,
      source: this.reviewSource,
      state: review.state,
      severity: review.severity,
      findings: derivedFindings,
      waiverReason: review.waiverReason,
      evidenceRefs: [...(review.evidenceRefs ?? [])],
      createdAt: timestamp(),
      findingDetails: review.findingDetails !== undefined ? [...review.findingDetails] : undefined
    };

    await this.store.saveReview(reviewRecord);

    // P1 MPL capture hook — non-fatal; must never block the review path.
    // Delegated to fireMistakeCapture (FIX 3: extracted glue function, see module scope above).
    if (this.mistakeLedgerStore) {
      fireMistakeCapture(reviewRecord, task.projectId, this.mistakeLedgerStore);
    }

    // P2 MPL distillation hook — non-fatal; runs after capture, never blocks review path.
    // Requires both mistakeLedgerStore (to read occurrences) and resolveReviewActionContext
    // (to create a sealed trusted context for autonomous promotion through promoteMemory).
    // SECURITY: the injected promoteMemory delegate enforces the P0 trust gate
    // (isTrustedReviewActionContext) inside the memory/search manager — it is not
    // bypassed. actorRole: "reviewer" in the MemoryPromotionInput satisfies the
    // anti_pattern role-gate (council condition 2). The resolver provides the sealed
    // WeakSet-registered context (council condition 1). If antiPatternDraftStore is
    // absent, review_required candidates persist to a no-op store.
    // resolveReviewActionContext is guaranteed non-null here (checked above).
    if (this.mistakeLedgerStore && this.antiPatternDraftStore) {
      fireDistillation(
        runId,
        task.projectId,
        this.mistakeLedgerStore,
        this.antiPatternDraftStore,
        this.promoteMemory
      );
    }

    const reviews = await this.store.getReviews(runId, taskId);
    const decision = evaluateReviewDecision(task, reviews);

    await this.store.saveApproval({
      id: randomUUID(),
      runId,
      taskId,
      actor: context.actor,
      actorRole: context.actorRole,
      source: this.reviewSource,
      decision: decision.decision,
      rationale:
        decision.blockers.length > 0 ? decision.blockers.join("; ") : "All required reviews passed",
      createdAt: timestamp()
    });

    const nextStatus = decision.decision === "approved" ? "approved" : "review_blocked";
    const updatedTask: TaskRecord = {
      ...task,
      status: nextStatus,
      updatedAt: timestamp()
    };

    if (nextStatus === "approved") {
      // Condition 5: a task may never be approved under a reduced review floor
      // without a durable provenance row. Use the same shared predicate the gate
      // decision used so the floor decision and its audit record cannot drift.
      if (isReviewFloorReduced(task)) {
        const effectiveFloor = effectiveRequiredReviewsForTask(task);
        const droppedRoles = requiredGateReviews.filter((role) => !effectiveFloor.includes(role));
        await this.store.saveReviewFloorReduction({
          id: randomUUID(),
          runId,
          taskId,
          derivedClass: task.class,
          droppedRoles: [...droppedRoles],
          effectiveFloor: [...effectiveFloor],
          writeScopeSnapshot: [...task.packet.allowedWriteScope],
          basis: "opt_out_class+scope_review_safe",
          source: "runtime",
          decidedAt: updatedTask.updatedAt
        } satisfies ReviewFloorReductionRecord);
      }
      await this.store.releaseLocksForTask(runId, taskId, timestamp());
    }

    await this.store.updateTask(updatedTask);
    await this.bumpRunState(runId, nextStatus);
    const allTasks = await this.store.getTasksByRun(runId);
    const syncedTasks = allTasks.map((candidate) =>
      candidate.packet.taskId === taskId ? updatedTask : candidate
    );
    const existingState = await this.store.getProjectRuntimeState(task.projectId);
    const activeTaskId = syncedTasks.find((candidate) => candidate.status === "in_progress")?.packet.taskId;
    await this.store.saveProjectRuntimeState({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      activeRunId: runId,
      activeTaskId,
      taskQueue: buildRuntimeTaskQueue(deriveRunStatus(syncedTasks), syncedTasks, activeTaskId),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: nextStatus === "approved" ? runId : existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? timestamp(),
      updatedAt: timestamp()
    });
    await this.store.saveWorkflowDocument({
      id: randomUUID(),
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      runId,
      taskId,
      kind: "review_summary",
      title: `Review summary: ${taskId}`,
      body: JSON.stringify(
        {
          review: reviewRecord,
          blockers: decision.blockers,
          status: nextStatus
        },
        null,
        2
      ),
      metadata: {
        source: "runtime_review",
        evidenceRefs: reviewRecord.evidenceRefs ?? []
      },
      createdAt: reviewRecord.createdAt,
      updatedAt: reviewRecord.createdAt
    });
    return {
      review: reviewRecord,
      blockers: decision.blockers,
      task: updatedTask
    };
  }

  async findTaskBlockers(
    task: TaskRecord,
    allTasks: readonly TaskRecord[],
    activeLocks: readonly LockRecord[]
  ): Promise<string[]> {
    const blockers = findBlockingReasonsForTask(task, allTasks, activeLocks);

    for (const dependency of findTaskDependencies(task.packet, allTasks)) {
      if (dependency.status !== "approved") {
        continue;
      }

      const reviews = await this.store.getReviews(dependency.runId, dependency.packet.taskId);
      const decision = evaluateReviewDecision(dependency, reviews);
      if (decision.decision === "approved") {
        continue;
      }

      blockers.push(
        `dependency ${dependency.packet.taskId} has stale approval: ${decision.blockers.join("; ")}`
      );
    }

    return blockers;
  }
}
