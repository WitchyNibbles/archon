/**
 * Run-level rollup stats — dashQuality S4 (void-fix: run-level signal layer).
 *
 * Pure aggregation over the task queue + review gates so the dashboard can show
 * "how far along is this run" at a glance (progress meter + counts) and a gate
 * pass tally — the signal that was missing while ~60% of the viewport read as a
 * dead void. No React/DOM dependency, so it is unit-testable from the root
 * node:test runner (tests/dash-run-stats.test.ts).
 *
 * Bucket definitions MUST stay in lockstep with ../utils/taskBuckets.ts BUCKETS
 * (same status→bucket mapping). Kept as a separate flat tally here rather than
 * reusing bucketTasks() so the order-of-counts and the progress segments are
 * explicit and independently testable.
 *
 * R2-C boundary: imports only web-local types; no import from src/.
 */

import type {
  ReviewGateViewModel,
  TaskQueueEntryViewModel,
} from "../types/dashboard.ts";

/** One segment of the run progress meter (status group → count + color token). */
export interface RunStatSegment {
  id: "blocked" | "in_progress" | "ready" | "done";
  label: string;
  count: number;
  /** Fill color token for the meter segment (saturated base — UI fill, 3:1 OK). */
  fill: string;
  /** AA-safe text token for the count label beside the meter. */
  text: string;
}

export interface RunStats {
  total: number;
  blocked: number;
  inProgress: number;
  ready: number;
  done: number;
  /** Ordered meter segments, BLOCKED → IN PROGRESS → READY → DONE. */
  segments: RunStatSegment[];
  /** Fraction of tasks in a terminal (done/approved) state, 0..1. */
  doneFraction: number;
  gatesPassed: number;
  gatesBlocked: number;
  gatesTotal: number;
}

const BLOCKED_STATUSES = new Set(["blocked", "review_blocked"]);
const DONE_STATUSES = new Set(["approved", "done"]);

/**
 * Aggregate a task queue + its review gates into run-level rollup stats.
 *
 * Counts are exhaustive over the recognised buckets; a task with an unrecognised
 * status contributes to `total` only (mirrors bucketTasks' defensive drop — such
 * a status cannot pass contract validation, this is belt-and-suspenders).
 */
export function computeRunStats(
  taskQueue: readonly TaskQueueEntryViewModel[],
  reviewGates: readonly ReviewGateViewModel[]
): RunStats {
  let blocked = 0;
  let inProgress = 0;
  let ready = 0;
  let done = 0;

  for (const t of taskQueue) {
    if (BLOCKED_STATUSES.has(t.status)) blocked += 1;
    else if (t.status === "in_progress") inProgress += 1;
    else if (t.status === "ready") ready += 1;
    else if (DONE_STATUSES.has(t.status)) done += 1;
  }

  const total = taskQueue.length;

  let gatesPassed = 0;
  let gatesBlocked = 0;
  for (const g of reviewGates) {
    if (g.state === "passed" || g.state === "waived") gatesPassed += 1;
    else if (g.state === "blocked") gatesBlocked += 1;
  }

  const segments: RunStatSegment[] = [
    { id: "blocked", label: "Blocked", count: blocked, fill: "var(--status-error)", text: "var(--status-error-text)" },
    { id: "in_progress", label: "In flight", count: inProgress, fill: "var(--status-running)", text: "var(--status-running-text)" },
    { id: "ready", label: "Ready", count: ready, fill: "var(--status-pending)", text: "var(--status-pending-text)" },
    { id: "done", label: "Done", count: done, fill: "var(--status-success)", text: "var(--status-success-text)" },
  ];

  return {
    total,
    blocked,
    inProgress,
    ready,
    done,
    segments,
    doneFraction: total === 0 ? 0 : done / total,
    gatesPassed,
    gatesBlocked,
    gatesTotal: reviewGates.length,
  };
}
