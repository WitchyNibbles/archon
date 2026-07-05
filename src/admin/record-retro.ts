import type { ArchonStore } from "../store/types.ts";

// auditP3RetroLoop fix (HIGH #1): record a post-task retro decision into the
// authoritative runtime task record — mirrors record-council.ts almost exactly.
// This is the real, auditable recording primitive for the "mandatory retro"
// requirement: close-run's seal gate reads packet.retroOutcome to prove a retro
// decision was actually recorded before a run can be sealed. Orchestrator-only —
// the tasks table is not writable via Claude tools.

export const RETRO_OUTCOME_TOKENS = new Set([
  "memory_promoted",
  "skill_patched",
  "discarded",
  "postmortem_filed",
  "nothing_to_promote"
]);

function parseFlag(args: readonly string[], flag: string): string | undefined {
  const prefixed = `--${flag}`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === prefixed) return args[i + 1];
    if (args[i]?.startsWith(`${prefixed}=`)) return args[i]!.slice(prefixed.length + 1);
  }
  return undefined;
}

export interface RecordRetroOptions {
  store: Pick<ArchonStore, "findLatestRunForTask" | "getRun" | "getTask" | "updateTask" | "ensureProjectContext">;
  workspaceSlug: string;
  projectSlug: string;
  /** Explicit run id — when provided, bypasses findLatestRunForTask. */
  runId?: string | undefined;
  taskId: string;
  outcome: string;
}

export interface RecordRetroResult {
  taskId: string;
  runId: string;
  outcome: string;
}

export async function executeRecordRetroCommand(options: RecordRetroOptions): Promise<RecordRetroResult> {
  if (!RETRO_OUTCOME_TOKENS.has(options.outcome)) {
    throw new Error(
      `record-retro: --outcome "${options.outcome}" is invalid; must be one of ${[...RETRO_OUTCOME_TOKENS].join(", ")}`
    );
  }
  // Resolve the run that contains the task — not the project's active run, which may have
  // advanced past the run where the task lives. An explicit runId bypasses the lookup,
  // but must be validated to belong to this workspace/project (cross-project write guard).
  let runId: string;
  if (options.runId) {
    const run = await options.store.getRun(options.runId);
    if (!run) {
      throw new Error(`record-retro: run "${options.runId}" not found`);
    }
    const expectedWorkspaceId = `workspace:${options.workspaceSlug}`;
    const expectedProjectId = `project:${options.workspaceSlug}:${options.projectSlug}`;
    if (run.workspaceId !== expectedWorkspaceId || run.projectId !== expectedProjectId) {
      throw new Error(
        `record-retro: run "${options.runId}" does not belong to ${options.workspaceSlug}/${options.projectSlug}; refusing cross-project write`
      );
    }
    runId = options.runId;
  } else {
    const taskRun = await options.store.findLatestRunForTask({
      workspaceSlug: options.workspaceSlug,
      projectSlug: options.projectSlug,
      taskId: options.taskId
    });
    if (!taskRun) {
      throw new Error(
        `record-retro: task "${options.taskId}" not found in any run for ${options.workspaceSlug}/${options.projectSlug}`
      );
    }
    runId = taskRun.id;
  }
  const task = await options.store.getTask(runId, options.taskId);
  if (!task) {
    throw new Error(`record-retro: task ${options.taskId} not found in run ${runId}`);
  }
  const now = new Date().toISOString();
  await options.store.updateTask({
    ...task,
    packet: { ...task.packet, retroOutcome: options.outcome, retroDecidedAt: now },
    updatedAt: now
  });
  return { taskId: options.taskId, runId, outcome: options.outcome };
}

export async function recordRetroCommand(
  args: readonly string[],
  deps: {
    withClient: <T>(fn: (client: unknown) => Promise<T>) => Promise<T>;
    createStore: (client: unknown) => RecordRetroOptions["store"];
    env?: NodeJS.ProcessEnv;
  }
): Promise<void> {
  const env = deps.env ?? process.env;
  const taskId = parseFlag(args, "task-id");
  const outcome = parseFlag(args, "outcome");
  const explicitRunId = parseFlag(args, "run-id");
  const source = parseFlag(args, "source") ?? "";
  if (!taskId) throw new Error("record-retro requires --task-id");
  if (!outcome) throw new Error("record-retro requires --outcome");
  // TRUST GATE: only orchestrator-sourced invocations are permitted.
  // Matches the record-council / save-review / save-approval invariant.
  if (source !== "orchestrator") {
    throw new Error(
      "record-retro only accepts --source orchestrator; direct invocation without orchestrator provenance is not permitted"
    );
  }

  const workspaceSlug = env.ARCHON_WORKSPACE_SLUG ?? "default";
  const projectSlug = env.ARCHON_PROJECT_SLUG;
  if (!projectSlug) throw new Error("ARCHON_PROJECT_SLUG is required");

  const result = await deps.withClient(async (client) => {
    const store = deps.createStore(client);
    return executeRecordRetroCommand({ store, workspaceSlug, projectSlug, runId: explicitRunId, taskId, outcome });
  });
  console.log(JSON.stringify({ recorded: true, ...result }));
}
