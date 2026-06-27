/**
 * Task filtering — dashQuality S3a in-run Blocked filter.
 *
 * Pure, dependency-free (type imports erase at runtime) so it is unit-tested with
 * the root node:test runner (tests/dash-task-filter.test.ts); the one-directional
 * R2-C web→src wall is unaffected.
 *
 * "Blocked" = a task whose status is `blocked` (dependency/lock/etc.) or
 * `review_blocked` (a required review gate has not passed). These are exactly the
 * statuses the BLOCKED bucket groups (utils/taskBuckets.ts), kept in sync here.
 */

import type { TaskQueueEntryViewModel, TaskStatus } from "../types/dashboard.ts";

export type TaskFilter = "all" | "blocked";

/** Statuses considered "blocked" for the in-run filter. */
export const BLOCKED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "blocked",
  "review_blocked",
]);

/** True when a task is in a blocked status. */
export function isBlockedTask(task: TaskQueueEntryViewModel): boolean {
  return BLOCKED_STATUSES.has(task.status);
}

/** Count of blocked tasks in the queue (drives the sidebar filter badge). */
export function countBlocked(taskQueue: readonly TaskQueueEntryViewModel[]): number {
  return taskQueue.reduce((n, task) => (isBlockedTask(task) ? n + 1 : n), 0);
}

/**
 * Apply the active filter to the task queue. `"all"` returns the queue unchanged
 * (same reference — no needless copy); `"blocked"` returns only blocked tasks,
 * preserving order. Never mutates the input.
 */
export function filterTasks(
  taskQueue: readonly TaskQueueEntryViewModel[],
  filter: TaskFilter
): readonly TaskQueueEntryViewModel[] {
  if (filter === "all") {
    return taskQueue;
  }
  return taskQueue.filter(isBlockedTask);
}
