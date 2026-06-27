/**
 * Task drill-down detail — dashQuality S3a.
 *
 * Pure selectors that answer the operator's "why is this task stuck?" question by
 * matching the run-level blockers to a task. Dependency-free (type imports erase at
 * runtime) so they are unit-tested with the root node:test runner
 * (tests/dash-task-detail.test.ts); the R2-C web→src wall is unaffected.
 *
 * The richest blocker detail (reason + nextActions) lives in the run-level
 * `blockers: BlockerViewModel[]`, keyed back to a task via the optional `taskId`.
 * A blocker with no `taskId` is run-level (not attributable to a single task) and
 * is therefore never returned for a specific task.
 */

import type { BlockerViewModel } from "../types/dashboard.ts";

/**
 * Blockers attributable to a given task, in original order. A blocker matches only
 * when its `taskId` is present and equal — run-level blockers (no taskId) are excluded.
 * Never mutates the input.
 */
export function blockersForTask(
  taskId: string,
  blockers: readonly BlockerViewModel[]
): readonly BlockerViewModel[] {
  return blockers.filter((b) => b.taskId !== undefined && b.taskId === taskId);
}

/** True when a task has at least one attributable blocker to drill into. */
export function hasBlockerDetail(
  taskId: string,
  blockers: readonly BlockerViewModel[]
): boolean {
  return blockers.some((b) => b.taskId !== undefined && b.taskId === taskId);
}
