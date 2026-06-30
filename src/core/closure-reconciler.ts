/**
 * @module core/closure-reconciler
 *
 * closureLoop W1 — terminal-closure reconciler.
 *
 * archon gates each task hard (reviewer+qa+security → `approved`) but had no
 * forcing function to advance `approved` → `done` and seal the run: "done" lived
 * only in the markdown queue, and the manager/interactive path never reconciled.
 * Tasks therefore passed every gate and then sat `approved` forever, and runs sat
 * `in_progress` though their work merged — the half-done pattern at scale.
 *
 * This module is the WIRING (not a new gate): it advances gate-satisfied
 * `approved` tasks to `done` and seals fully-terminal runs. The runtime stays the
 * SOLE terminal authority; markdown `done` is derived.
 *
 * Security C2 (HIGH, council): the closure path MUST re-verify gate PROVENANCE —
 * distinct orchestrator-recorded passed reviewer roles covering the effective
 * floor, plus an orchestrator-recorded approval — and NEVER trust the `status`
 * field alone. A task that is `approved` without that provenance is surfaced as a
 * blocked closure, never silently advanced.
 */

import type {
  TaskRecord,
  ReviewRecord,
  ApprovalRecord,
  ReviewFloorReductionRecord
} from "../domain/types.ts";
import { effectiveRequiredReviews } from "../domain/contracts.ts";

// ---------------------------------------------------------------------------
// Pure predicate
// ---------------------------------------------------------------------------

export interface ClosureTaskEvidence {
  taskId: string;
  /** Current runtime task status. */
  status: string;
  /** Effective required reviewer roles (floor) for this task. */
  requiredFloor: readonly string[];
  /** Distinct reviewer roles with an orchestrator-recorded `passed` review. */
  passedOrchestratorRoles: readonly string[];
  /** Count of orchestrator-recorded `approved` approvals. */
  orchestratorApprovals: number;
}

export interface ClosureBlock {
  taskId: string;
  reason: string;
}

export interface ClosurePlan {
  /** `approved` tasks whose gate provenance is satisfied → advance to `done`. */
  closeable: string[];
  /** `approved` tasks missing provenance — surfaced, NEVER advanced. */
  blocked: ClosureBlock[];
  /** Tasks already `done`. */
  alreadyDone: string[];
  /** Tasks in a non-terminal, non-approved state (ready/in_progress/…). */
  nonTerminal: string[];
  /** True when every task is `done` or closeable (and there is ≥1 task) → seal the run. */
  sealRun: boolean;
}

/**
 * Compute the closure plan from per-task evidence. PURE: no IO, deterministic.
 *
 * A run is sealable only when EVERY task is already `done` or safely closeable —
 * never when a non-terminal task remains OR an `approved` task lacks provenance.
 */
export function planRunClosure(tasks: readonly ClosureTaskEvidence[]): ClosurePlan {
  const closeable: string[] = [];
  const blocked: ClosureBlock[] = [];
  const alreadyDone: string[] = [];
  const nonTerminal: string[] = [];

  for (const task of tasks) {
    if (task.status === "done") {
      alreadyDone.push(task.taskId);
      continue;
    }
    if (task.status !== "approved") {
      nonTerminal.push(task.taskId);
      continue;
    }

    // Security C2: re-verify provenance, never trust the `approved` status field.
    const missingRoles = task.requiredFloor.filter(
      (role) => !task.passedOrchestratorRoles.includes(role)
    );
    if (missingRoles.length > 0) {
      blocked.push({
        taskId: task.taskId,
        reason: `approved but missing orchestrator-recorded passed review for: ${missingRoles.join(", ")}`
      });
      continue;
    }
    if (task.orchestratorApprovals < 1) {
      blocked.push({
        taskId: task.taskId,
        reason: "approved but no orchestrator-recorded approval found"
      });
      continue;
    }

    closeable.push(task.taskId);
  }

  const sealRun = tasks.length > 0 && nonTerminal.length === 0 && blocked.length === 0;

  return { closeable, blocked, alreadyDone, nonTerminal, sealRun };
}

// ---------------------------------------------------------------------------
// Evidence builder (maps store records → pure inputs)
// ---------------------------------------------------------------------------

/**
 * Build closure evidence for one task from its store records. The effective
 * floor honors an orchestrator-recorded review-floor reduction when present
 * (mirroring the Stop-hook authority); otherwise it is the full required trio.
 */
export function buildTaskEvidence(
  task: TaskRecord,
  reviews: readonly ReviewRecord[],
  approvals: readonly ApprovalRecord[],
  floorReductions: readonly ReviewFloorReductionRecord[]
): ClosureTaskEvidence {
  // Security C2: a review-floor reduction lowers the required gate floor, so it
  // is only trusted when ORCHESTRATOR-recorded — the same source discipline
  // applied to reviews/approvals below. A non-orchestrator reduction is ignored,
  // falling back to the full required trio.
  const reduction = floorReductions.find(
    (entry) =>
      entry.taskId === task.packet.taskId &&
      entry.source === "orchestrator" &&
      entry.effectiveFloor.length > 0
  );
  const requiredFloor = reduction
    ? reduction.effectiveFloor
    : effectiveRequiredReviews(task.packet.requiredReviews);

  const passedOrchestratorRoles = [
    ...new Set(
      reviews
        .filter((review) => review.source === "orchestrator" && review.state === "passed")
        .map((review) => review.reviewerRole)
    )
  ];

  const orchestratorApprovals = approvals.filter(
    (approval) => approval.source === "orchestrator" && approval.decision === "approved"
  ).length;

  return {
    taskId: task.packet.taskId,
    status: task.status,
    requiredFloor,
    passedOrchestratorRoles,
    orchestratorApprovals
  };
}

/** Count of `approved`-but-not-`done` tasks — the visibility signal. */
export function countApprovedNotClosed(tasks: readonly { status: string }[]): number {
  return tasks.filter((task) => task.status === "approved").length;
}

export interface ClosureSignal {
  authorityLabel: "derived_only";
  /** Number of tasks that passed gates (approved) but were never advanced to done. */
  approvedNotClosed: number;
  taskIds: string[];
  note: string;
}

/**
 * Build the operator-visible "approved-but-not-closed" closure signal for the
 * status command (W1 visibility). Pure: derived from task status only.
 */
export function buildClosureSignal(
  tasks: readonly { status: string; taskId: string }[]
): ClosureSignal {
  const approved = tasks.filter((task) => task.status === "approved");
  return {
    authorityLabel: "derived_only",
    approvedNotClosed: approved.length,
    taskIds: approved.map((task) => task.taskId),
    note:
      approved.length > 0
        ? `${approved.length} task(s) passed gates but are not advanced to done — run \`archon close-run\` to seal`
        : "no approved-but-unclosed tasks"
  };
}
