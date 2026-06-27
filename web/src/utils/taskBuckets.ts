/**
 * Task bucketing — the S1 void-fix grouping logic (dashQuality).
 *
 * Extracted from TaskListView.tsx so the core grouping that makes every task
 * visible (the void fix) is unit-testable in isolation — it has no React/DOM
 * dependency. TaskListView imports BUCKETS + bucketTasks from here.
 *
 * R2-C boundary: imports only web-local types; no import from src/.
 */

import type { TaskQueueEntryViewModel, TaskStatus } from "../types/dashboard.ts";

export type BucketId = "blocked" | "in_progress" | "ready" | "done";

export interface BucketConfig {
  id: BucketId;
  label: string;
  /** Color token for the section header text (status-text variant for AA on dark). */
  headerColor: string;
  statuses: ReadonlyArray<TaskStatus>;
}

/** Bucket order: BLOCKED → IN PROGRESS → READY/QUEUED → DONE. */
export const BUCKETS: readonly BucketConfig[] = [
  {
    id: "blocked",
    label: "Blocked",
    headerColor: "var(--status-error-text)",
    statuses: ["blocked", "review_blocked"],
  },
  {
    id: "in_progress",
    label: "In Progress",
    headerColor: "var(--status-running-text)",
    statuses: ["in_progress"],
  },
  {
    id: "ready",
    label: "Ready / Queued",
    headerColor: "var(--status-pending-text)",
    statuses: ["ready"],
  },
  {
    id: "done",
    label: "Done",
    headerColor: "var(--status-muted-text)",
    statuses: ["approved", "done"],
  },
] as const;

/**
 * Group tasks into buckets in BLOCKED → IN PROGRESS → READY/QUEUED → DONE order.
 *
 * Each task lands in exactly the first bucket whose `statuses` includes it.
 * A task whose status is not recognised by any bucket is silently omitted
 * (upstream schema validation guarantees only valid statuses reach here; this is
 * a defensive drop, not a routing path the contract can normally produce).
 */
export function bucketTasks(
  taskQueue: readonly TaskQueueEntryViewModel[]
): Map<BucketId, TaskQueueEntryViewModel[]> {
  const result = new Map<BucketId, TaskQueueEntryViewModel[]>(
    BUCKETS.map((b) => [b.id, []])
  );

  for (const task of taskQueue) {
    for (const bucket of BUCKETS) {
      if ((bucket.statuses as ReadonlyArray<string>).includes(task.status)) {
        result.get(bucket.id)!.push(task);
        break; // each task goes into exactly one bucket
      }
    }
    // Tasks with an unrecognised status are silently omitted.
  }

  return result;
}
