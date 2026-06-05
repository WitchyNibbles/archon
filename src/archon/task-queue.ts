import { readFile } from "node:fs/promises";
import path from "node:path";

export const ALLOWED_TASK_STATUSES = ["pending", "in_progress", "blocked", "done"] as const;
export const ALLOWED_TASK_CLASSES = [
  "prototype_slice",
  "security_sensitive",
  "release_candidate",
  "docs_only"
] as const;

const LEGACY_TASK_CLASS_ALIASES = {
  implementation_slice: "prototype_slice"
} as const;

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

export interface TaskQueueSummary {
  projectStatus: string;
  currentTask: TaskQueueTask | null;
  nextTask: TaskQueueTask | null;
  blockedTasks: TaskQueueTask[];
  doneCount: number;
  pendingCount: number;
  inProgressCount: number;
  totalCount: number;
}

export interface AdvanceTaskQueueResult {
  queue: TaskQueue;
  completedTask: TaskQueueTask;
  nextTask: TaskQueueTask | null;
}

function uniqueNonEmptyItems(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const normalized = item.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function requiresDetailedWorkflowEvidence(task: TaskQueueTask): boolean {
  return task.class !== "docs_only";
}

export function deriveTaskQueueEvidence(input: {
  taskId: string;
  verification: readonly string[];
  qualityGates?: readonly string[] | undefined;
}): string[] {
  const evidence = [`task packet: ${input.taskId}`];

  for (const step of input.verification) {
    evidence.push(`verification: ${step}`);
  }

  if (input.qualityGates?.includes("release_readiness_required")) {
    evidence.push("quality gate: release_readiness_required");
  }

  return uniqueNonEmptyItems(evidence);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }

  return value;
}

function asNullableString(value: unknown, context: string): string | null {
  if (value === null) {
    return null;
  }

  return asString(value, context);
}

function asStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${context} must be an array of strings`);
  }

  return value;
}

function asTaskStatus(value: unknown, context: string): TaskStatus {
  const status = asString(value, context);
  if (!ALLOWED_TASK_STATUSES.includes(status as TaskStatus)) {
    throw new Error(`${context} has invalid status "${status}"`);
  }

  return status as TaskStatus;
}

function asTaskClass(value: unknown, context: string): TaskClass {
  const taskClass = asString(value, context);
  const canonical = canonicalizeTaskClass(taskClass);
  if (!canonical) {
    throw new Error(`${context} has invalid class "${taskClass}"`);
  }

  return canonical;
}

export function canonicalizeTaskClass(taskClass: string): TaskClass | undefined {
  if (ALLOWED_TASK_CLASSES.includes(taskClass as TaskClass)) {
    return taskClass as TaskClass;
  }

  return LEGACY_TASK_CLASS_ALIASES[taskClass as keyof typeof LEGACY_TASK_CLASS_ALIASES];
}

function parseTask(value: unknown, index: number): TaskQueueTask {
  const record = asRecord(value, `tasks[${index}]`);

  return {
    id: asString(record.id, `tasks[${index}].id`),
    title: asString(record.title, `tasks[${index}].title`),
    status: asTaskStatus(record.status, `tasks[${index}].status`),
    class: asTaskClass(record.class, `tasks[${index}].class`),
    depends_on: asStringArray(record.depends_on, `tasks[${index}].depends_on`),
    acceptance_criteria: asStringArray(
      record.acceptance_criteria,
      `tasks[${index}].acceptance_criteria`
    ),
    verification: asStringArray(record.verification, `tasks[${index}].verification`),
    evidence: asStringArray(record.evidence, `tasks[${index}].evidence`),
    blocker: asNullableString(record.blocker, `tasks[${index}].blocker`)
  };
}

export function isTaskBlocked(task: TaskQueueTask): boolean {
  return task.status === "blocked" || task.blocker !== null;
}

function isRecoverableScopeBlocker(task: TaskQueueTask, activeTaskId: string | null): boolean {
  if (task.id !== activeTaskId || task.status !== "blocked" || task.blocker === null) {
    return false;
  }

  return /\bscope expansion\b|\bout of scope\b|outside the allowed write scope|minimum safe scope expansion/i.test(
    task.blocker
  );
}

function validateTaskQueue(queue: TaskQueue): TaskQueue {
  const taskIds = new Set<string>();

  for (const task of queue.tasks) {
    if (taskIds.has(task.id)) {
      throw new Error(`task queue has duplicate task id "${task.id}"`);
    }

    taskIds.add(task.id);
  }

  if (queue.current_task_id !== null && !taskIds.has(queue.current_task_id)) {
    throw new Error(`current_task_id "${queue.current_task_id}" does not exist in tasks`);
  }

  for (const task of queue.tasks) {
    for (const dependencyId of task.depends_on) {
      if (!taskIds.has(dependencyId)) {
        throw new Error(`task "${task.id}" has missing dependency "${dependencyId}"`);
      }
    }
  }

  return queue;
}

export function validateWorkflowTaskQueue(queue: TaskQueue): TaskQueue {
  for (const task of queue.tasks) {
    if (!requiresDetailedWorkflowEvidence(task)) {
      continue;
    }

    if (uniqueNonEmptyItems(task.acceptance_criteria).length === 0) {
      throw new Error(`task "${task.id}" must include at least one acceptance criterion`);
    }

    if (uniqueNonEmptyItems(task.verification).length === 0) {
      throw new Error(`task "${task.id}" must include at least one verification step`);
    }

    if (uniqueNonEmptyItems(task.evidence).length === 0) {
      throw new Error(`task "${task.id}" must include at least one evidence reference`);
    }
  }

  return queue;
}

function tasksById(queue: TaskQueue): Map<string, TaskQueueTask> {
  return new Map(queue.tasks.map((task) => [task.id, task]));
}

function dependenciesSatisfied(task: TaskQueueTask, index: Map<string, TaskQueueTask>): boolean {
  return task.depends_on.every((dependencyId) => index.get(dependencyId)?.status === "done");
}

export function parseTaskQueueContent(content: string): TaskQueue {
  const parsed = JSON.parse(content) as unknown;
  const record = asRecord(parsed, "task queue");

  const queue: TaskQueue = {
    project_status: asString(record.project_status, "project_status"),
    current_task_id:
      record.current_task_id === null ? null : asString(record.current_task_id, "current_task_id"),
    tasks: Array.isArray(record.tasks)
      ? record.tasks.map((task, index) => parseTask(task, index))
      : (() => {
          throw new Error("tasks must be an array");
        })()
  };

  return validateTaskQueue(queue);
}

export async function readTaskQueue(
  queuePath = path.join(process.cwd(), ".archon", "work", "task-queue.json")
): Promise<TaskQueue> {
  const content = await readFile(queuePath, "utf8");
  return parseTaskQueueContent(content);
}

export function repairTaskQueueContent(content: string): {
  changed: boolean;
  repairedTasks: number;
  queue: TaskQueue;
  content: string;
} {
  const parsed = JSON.parse(content) as {
    tasks?: Array<{ class?: unknown }> | undefined;
  };
  const queue = parseTaskQueueContent(content);

  let repairedTasks = 0;
  for (const [index, task] of queue.tasks.entries()) {
    const originalClass = parsed.tasks?.[index]?.class;
    if (typeof originalClass !== "string") {
      continue;
    }

    if (originalClass !== task.class && canonicalizeTaskClass(originalClass) === task.class) {
      repairedTasks += 1;
    }
  }

  const repairedContent = `${JSON.stringify(queue, null, 2)}\n`;
  return {
    changed: repairedContent !== content,
    repairedTasks,
    queue,
    content: repairedContent
  };
}

export function selectNextUnblockedTask(queue: TaskQueue): TaskQueueTask | null {
  const index = tasksById(queue);
  const activeTask = queue.current_task_id === null ? null : index.get(queue.current_task_id) ?? null;

  if (activeTask && isRecoverableScopeBlocker(activeTask, queue.current_task_id)) {
    return activeTask;
  }

  for (const task of queue.tasks) {
    if (task.status === "done") {
      continue;
    }

    if (isTaskBlocked(task)) {
      continue;
    }

    if (!dependenciesSatisfied(task, index)) {
      continue;
    }

    return task;
  }

  return null;
}

export function advanceTaskQueue(queue: TaskQueue, taskId: string): AdvanceTaskQueueResult {
  const currentTask = queue.tasks.find((task) => task.id === taskId);
  if (!currentTask) {
    throw new Error(`task "${taskId}" does not exist in the queue`);
  }

  if (queue.current_task_id !== taskId) {
    throw new Error(`task "${taskId}" is not the current active queue task`);
  }

  if (isTaskBlocked(currentTask)) {
    throw new Error(`task "${taskId}" is blocked and cannot advance`);
  }

  if (currentTask.status === "done") {
    throw new Error(`task "${taskId}" is already done`);
  }

  const updatedTasks = queue.tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status: "done" as const,
          blocker: null
        }
      : { ...task }
  );
  const baseQueue: TaskQueue = {
    ...queue,
    current_task_id: null,
    tasks: updatedTasks
  };

  const selectedNextTask = selectNextUnblockedTask(baseQueue);
  const activatedTasks = updatedTasks.map((task) =>
    selectedNextTask && task.id === selectedNextTask.id && task.status === "pending"
      ? {
          ...task,
          status: "in_progress" as const
        }
      : task
  );
  const nextTask =
    selectedNextTask === null
      ? null
      : activatedTasks.find((task) => task.id === selectedNextTask.id) ?? null;
  const projectStatus =
    nextTask === null && activatedTasks.every((task) => task.status === "done")
      ? "done"
      : baseQueue.project_status;

  return {
    queue: {
      ...baseQueue,
      project_status: projectStatus,
      current_task_id: nextTask?.id ?? null,
      tasks: activatedTasks
    },
    completedTask: updatedTasks.find((task) => task.id === taskId)!,
    nextTask
  };
}

export function summarizeTaskQueue(queue: TaskQueue): TaskQueueSummary {
  const index = tasksById(queue);
  const currentTask = queue.current_task_id === null ? null : index.get(queue.current_task_id) ?? null;

  return {
    projectStatus: queue.project_status,
    currentTask,
    nextTask: selectNextUnblockedTask(queue),
    blockedTasks: queue.tasks.filter((task) => isTaskBlocked(task)),
    doneCount: queue.tasks.filter((task) => task.status === "done").length,
    pendingCount: queue.tasks.filter((task) => task.status === "pending").length,
    inProgressCount: queue.tasks.filter((task) => task.status === "in_progress").length,
    totalCount: queue.tasks.length
  };
}
