import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readTaskQueue, summarizeTaskQueue, type TaskQueueTask } from "./task-queue.ts";

function formatTask(task: TaskQueueTask | null): string {
  if (!task) {
    return "(none)";
  }

  return `${task.id} - ${task.title} [${task.status}]`;
}

export async function renderAutopilotStatus(
  queuePath = path.join(process.cwd(), ".archon", "work", "task-queue.json")
): Promise<string> {
  const queue = await readTaskQueue(queuePath);
  const summary = summarizeTaskQueue(queue);
  const blockedTasks =
    summary.blockedTasks.length === 0
      ? "(none)"
      : summary.blockedTasks.map((task) => formatTask(task)).join("\n");

  return [
    `Project status: ${summary.projectStatus}`,
    `Current task: ${formatTask(summary.currentTask)}`,
    `Next unblocked task: ${formatTask(summary.nextTask)}`,
    `Blocked tasks:\n${blockedTasks}`,
    `Done count: ${summary.doneCount}`,
    `Pending count: ${summary.pendingCount}`,
    `In-progress count: ${summary.inProgressCount}`,
    `Total tasks: ${summary.totalCount}`
  ].join("\n");
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${await renderAutopilotStatus()}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`autopilot status failed: ${message}\n`);
    process.exitCode = 1;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntrypoint) {
  await main();
}
