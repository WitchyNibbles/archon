import type { ApprovalRecord, HandoffRecord, ReviewRecord } from "../domain/types.ts";
import type { ArchonStore } from "../store/types.ts";
import type { ExportDocsRequest, WorklogEntry } from "./models.ts";

export interface WorklogProvider {
  getEntries(request: ExportDocsRequest): Promise<WorklogEntry[]>;
}

async function collectTaskScopedRecords<RecordShape extends { taskId: string }>(
  taskIds: readonly string[],
  loader: (taskId: string) => Promise<readonly RecordShape[]>
): Promise<Record<string, RecordShape[]>> {
  const grouped: Record<string, RecordShape[]> = {};
  for (const taskId of taskIds) {
    grouped[taskId] = [...(await loader(taskId))];
  }
  return grouped;
}

export class RuntimeWorklogProvider implements WorklogProvider {
  private readonly store: ArchonStore;
  private readonly context: {
    workspaceSlug: string;
    projectSlug: string;
  };

  constructor(
    store: ArchonStore,
    context: {
      workspaceSlug: string;
      projectSlug: string;
    }
  ) {
    this.store = store;
    this.context = context;
  }

  async getEntries(request: ExportDocsRequest): Promise<WorklogEntry[]> {
    const runs = await this.store.findRunsByProjectActivity({
      workspaceSlug: this.context.workspaceSlug,
      projectSlug: this.context.projectSlug,
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      timezone: request.timezone
    });

    return Promise.all(
      runs.map(async (run) => {
        const plan = await this.store.getPlan(run.id);
        const tasks = await this.store.getTasksByRun(run.id);
        const taskIds = tasks.map((task) => task.packet.taskId);
        const [handoffsByTask, reviewsByTask, approvalsByTask, decisionMemoryEntries] = await Promise.all([
          collectTaskScopedRecords(taskIds, (taskId) => this.store.getHandoffs(run.id, taskId) as Promise<HandoffRecord[]>),
          collectTaskScopedRecords(taskIds, (taskId) => this.store.getReviews(run.id, taskId) as Promise<ReviewRecord[]>),
          collectTaskScopedRecords(taskIds, (taskId) => this.store.getApprovals(run.id, taskId) as Promise<ApprovalRecord[]>),
          this.store.listMemoryEntries({
            runId: run.id,
            entryType: "decision",
            status: "approved"
          })
        ]);

        return {
          run,
          plan,
          tasks,
          handoffsByTask,
          reviewsByTask,
          approvalsByTask,
          decisionMemoryEntries
        };
      })
    );
  }
}
