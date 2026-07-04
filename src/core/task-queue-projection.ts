// Run-status + runtime task-queue projections.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4,
// service.ts split slice 2). Pure, store-free functions that project the
// authoritative TaskRecord list into the runtime run status and the
// project_runtime_state.task_queue export.
//
// These live in their own module (rather than in the moving task-lifecycle
// manager) because BOTH the extracted TaskLifecycleManager and the gate/closure
// methods still on ArchonCoreService (submitHandoff, recordReview) derive run
// status and rebuild the runtime task queue. A shared, store-free module lets
// both import ONE copy without forming a service.ts <-> task-lifecycle.ts import
// cycle — the same cycle-break rationale as project-runtime-state.ts, kept
// separate so each file's max-lines ratchet entry stays independent.

import {
  deriveTaskQueueEvidence,
  type TaskStatus as QueueTaskStatus,
  type TaskQueue
} from "../archon/task-queue.ts";
import type { RunRecord, TaskRecord } from "../domain/types.ts";

export function mapTaskStatusToQueueStatus(status: TaskRecord["status"]): QueueTaskStatus {
  switch (status) {
    case "ready":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "approved":
    case "done":
      return "done";
    case "blocked":
    case "review_blocked":
      return "blocked";
  }
}

export function buildRuntimeTaskQueue(runStatus: RunRecord["status"], tasks: readonly TaskRecord[], activeTaskId?: string | undefined): TaskQueue {
  return {
    project_status: runStatus,
    current_task_id: activeTaskId ?? tasks.find((task) => task.status === "in_progress")?.packet.taskId ?? null,
    tasks: tasks.map((task) => ({
      id: task.packet.taskId,
      title: task.packet.title,
      status: mapTaskStatusToQueueStatus(task.status),
      // Read the authoritative immutable TaskRecord.class — never re-derive from
      // the mutable qualityGates here (that was the Option A pattern the council
      // rejected; re-deriving in the queue export would resurrect a spoofable
      // shadow even though gate sites use task.class).
      class: task.class,
      depends_on: [...task.packet.dependencies],
      acceptance_criteria: [...task.packet.acceptanceCriteria],
      verification: [...task.packet.verificationSteps],
      evidence: deriveTaskQueueEvidence({
        taskId: task.packet.taskId,
        verification: task.packet.verificationSteps,
        qualityGates: task.packet.qualityGates
      }),
      blocker:
        task.status === "blocked"
          ? "runtime task blocked"
          : task.status === "review_blocked"
            ? "awaiting required reviews"
            : null
    }))
  };
}

export function deriveRunStatus(tasks: readonly TaskRecord[]): RunRecord["status"] {
  if (tasks.length === 0) {
    return "decomposed";
  }

  if (tasks.every((task) => task.status === "done")) {
    return "done";
  }

  if (tasks.some((task) => task.status === "in_progress")) {
    return "in_progress";
  }

  if (tasks.some((task) => task.status === "review_blocked")) {
    return "review_blocked";
  }

  if (tasks.every((task) => task.status === "approved" || task.status === "done")) {
    return "approved";
  }

  return "ready";
}
