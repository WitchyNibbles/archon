// Archon task queue — full port in Phase 9
export const ALLOWED_TASK_STATUSES = ["pending", "in_progress", "blocked", "done"] as const;
export const ALLOWED_TASK_CLASSES = [
  "prototype_slice",
  "security_sensitive",
  "release_candidate",
  "docs_only"
] as const;

export type TaskStatus = (typeof ALLOWED_TASK_STATUSES)[number];
export type TaskClass = (typeof ALLOWED_TASK_CLASSES)[number];

export interface TaskQueueTask {
  id: string;
  title: string;
  status: TaskStatus;
  class: TaskClass;
  depends_on: string[];
  acceptance_criteria: string[];
  verification: string[];
  evidence: string[];
  blocker: string | null;
}

export interface TaskQueue {
  project_status: string;
  current_task_id: string | null;
  tasks: TaskQueueTask[];
}
