import type { ArchonStore } from "../store/types.ts";

// #14: record a Design & Architecture Council outcome into the authoritative runtime
// task record. Orchestrator-only — the tasks table is not writable via Claude tools.

export const COUNCIL_OUTCOME_TOKENS = new Set([
  "pending",
  "approved",
  "approved_with_conditions",
  "rework_required",
  "exception_granted",
  "rejected",
  "inherited"
]);

function parseFlag(args: readonly string[], flag: string): string | undefined {
  const prefixed = `--${flag}`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === prefixed) return args[i + 1];
    if (args[i]?.startsWith(`${prefixed}=`)) return args[i]!.slice(prefixed.length + 1);
  }
  return undefined;
}

export interface RecordCouncilOptions {
  store: Pick<ArchonStore, "findLatestRunForTask" | "getTask" | "updateTask" | "ensureProjectContext">;
  workspaceSlug: string;
  projectSlug: string;
  /** Explicit run id — when provided, bypasses findLatestRunForTask. */
  runId?: string | undefined;
  taskId: string;
  outcome: string;
}

export interface RecordCouncilResult {
  taskId: string;
  runId: string;
  outcome: string;
}

export async function executeRecordCouncilCommand(options: RecordCouncilOptions): Promise<RecordCouncilResult> {
  if (!COUNCIL_OUTCOME_TOKENS.has(options.outcome)) {
    throw new Error(
      `record-council: --outcome "${options.outcome}" is invalid; must be one of ${[...COUNCIL_OUTCOME_TOKENS].join(", ")}`
    );
  }
  // Resolve the run that contains the task — not the project's active run, which may have
  // advanced past the run where the task lives. An explicit runId bypasses the lookup.
  let runId: string;
  if (options.runId) {
    runId = options.runId;
  } else {
    const taskRun = await options.store.findLatestRunForTask({
      workspaceSlug: options.workspaceSlug,
      projectSlug: options.projectSlug,
      taskId: options.taskId
    });
    if (!taskRun) {
      throw new Error(
        `record-council: task "${options.taskId}" not found in any run for ${options.workspaceSlug}/${options.projectSlug}`
      );
    }
    runId = taskRun.id;
  }
  const task = await options.store.getTask(runId, options.taskId);
  if (!task) {
    throw new Error(`record-council: task ${options.taskId} not found in run ${runId}`);
  }
  await options.store.updateTask({
    ...task,
    packet: { ...task.packet, councilOutcome: options.outcome }
  });
  return { taskId: options.taskId, runId, outcome: options.outcome };
}

export async function recordCouncilCommand(
  args: readonly string[],
  deps: {
    withClient: <T>(fn: (client: unknown) => Promise<T>) => Promise<T>;
    createStore: (client: unknown) => RecordCouncilOptions["store"];
    env?: NodeJS.ProcessEnv;
  }
): Promise<void> {
  const env = deps.env ?? process.env;
  const taskId = parseFlag(args, "task-id");
  const outcome = parseFlag(args, "outcome");
  const explicitRunId = parseFlag(args, "run-id");
  if (!taskId) throw new Error("record-council requires --task-id");
  if (!outcome) throw new Error("record-council requires --outcome");

  const workspaceSlug = env.ARCHON_WORKSPACE_SLUG ?? "default";
  const projectSlug = env.ARCHON_PROJECT_SLUG;
  if (!projectSlug) throw new Error("ARCHON_PROJECT_SLUG is required");

  const result = await deps.withClient(async (client) => {
    const store = deps.createStore(client);
    return executeRecordCouncilCommand({ store, workspaceSlug, projectSlug, runId: explicitRunId, taskId, outcome });
  });
  console.log(JSON.stringify({ recorded: true, ...result }));
}
