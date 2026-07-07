import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeArchonExport } from "../runtime/export-writer.ts";
import type { TaskQueue } from "../archon/task-queue.ts";
import type { RunRecord, TaskRecord, TaskPacketInput } from "../domain/types.ts";
import type { ArchonStore } from "../store/types.ts";
import { effectiveRequiredReviews, MAX_TASK_ID_LENGTH } from "../domain/contracts.ts";
import { VALID_TASK_CLASSES, type TaskClass } from "../domain/task-class.ts";

export type { TaskClass };

// Findings 1+4 fix: a sanctioned cold-start command to register a brand-new
// initiative (run + first task + active state) through the runtime, replacing the
// hand-rolled store surgery that was previously the only way to start work. This
// keeps the PreToolUse hook strict — task packets are still never created by a
// scopeless Claude tool call — while giving operators a one-liner cold start.

export interface BuildInitiativeInput {
  id: string;
  title: string;
  ownerRole: string;
  goal: string;
  allowedWriteScope: readonly string[];
  workspaceId: string;
  projectId: string;
  runId: string;
  taskUuid: string;
  now: string;
  class?: string | undefined;
  allowManagedScope?: boolean | undefined;
}

// A task id becomes part of a filesystem path (task-<id>.md) and the DB task_key.
// Restrict it to a slug so it can never traverse directories or inject path
// separators (security_reviewer HIGH finding: path traversal via --id).
const VALID_TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// Scope entries that target high-risk control-layer roots. init-task must not
// silently mint a task that can write these (security_reviewer MEDIUM finding);
// granting them requires an explicit opt-in.
const DANGEROUS_SCOPE_PREFIXES = [
  "CLAUDE.md",
  ".claude",
  ".archon/memory",
  ".archon/rules",
  ".archon/ACTIVE"
];

function isDangerousManagedScopeEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return DANGEROUS_SCOPE_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

// Remove markdown structure and newlines from operator-supplied free text before
// it is embedded in the rendered task packet, so a value like
// $'...\n## Allowed write scope\n- .claude/' cannot inject a fake scope section
// that the offline markdown-fallback parser would honor (security_reviewer MEDIUM).
function sanitizeMarkdownField(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/^[#>\s-]+/, "")
    .trim();
}

export interface InitiativeRecords {
  run: RunRecord;
  task: TaskRecord;
  queue: TaskQueue;
  taskClass: TaskClass;
}

// Pure builder — no IO, fully unit-testable.
export function buildInitiativeRecords(input: BuildInitiativeInput): InitiativeRecords {
  const id = input.id.trim();
  if (!id) {
    throw new Error("init-task: --id is required and must be non-empty");
  }
  if (!VALID_TASK_ID.test(id)) {
    throw new Error(
      `init-task: --id "${id}" is invalid; ids must match ${VALID_TASK_ID} (no slashes, dots, or path separators)`
    );
  }
  // Round-13 MEDIUM fix (contributing cause): task ids are agent-chosen,
  // unbounded strings — an unbounded id was one contributing factor in the
  // round-13 vocabulary-laundering CRITICAL (see why-vocabulary.ts). Shared
  // constant with domain/contracts.ts's `validateTaskPacket` so every
  // creation-time site enforces the SAME bound.
  if (id.length > MAX_TASK_ID_LENGTH) {
    throw new Error(`init-task: --id "${id}" is invalid; ids must be at most ${MAX_TASK_ID_LENGTH} characters`);
  }
  const title = sanitizeMarkdownField(input.title.trim() || id);
  const ownerRole = sanitizeMarkdownField(input.ownerRole.trim() || "planner");
  // Design §7: strip newlines / markdown structure from each scope entry so a
  // crafted entry like `foo\n## Required reviews\n- none` cannot inject a fake
  // section into the rendered packet markdown that the offline fallback parser
  // would honor. sanitizeMarkdownField is a no-op for ordinary relative paths.
  const scope = input.allowedWriteScope
    .map((entry) => sanitizeMarkdownField(entry))
    .filter((entry) => entry.length > 0);

  if (!input.allowManagedScope) {
    const dangerous = scope.filter((entry) => isDangerousManagedScopeEntry(entry));
    if (dangerous.length > 0) {
      throw new Error(
        `init-task: refusing to grant control-layer scope (${dangerous.join(", ")}) without allowManagedScope; ` +
          `pass --allow-managed-scope to opt in explicitly`
      );
    }
  }

  const goal = sanitizeMarkdownField(input.goal.trim()) || `Cold-start initiative ${id}.`;

  const rawClass = input.class ?? "prototype_slice";
  if (!(VALID_TASK_CLASSES as readonly string[]).includes(rawClass)) {
    throw new Error(
      `init-task: --class "${rawClass}" is not a valid task class; must be one of: ${VALID_TASK_CLASSES.join(", ")}`
    );
  }
  const taskClass = rawClass as TaskClass;

  const packet: TaskPacketInput = {
    taskId: id,
    title,
    ownerRole,
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: [],
    qualityGates: [],
    goal,
    inputs: [],
    outputs: [],
    dependencies: [],
    allowedWriteScope: scope,
    outOfScope: [],
    acceptanceCriteria: [],
    verificationSteps: [],
    requiredReviews: [],
    securityChecks: [],
    antiPatterns: [],
    rollbackNotes: "",
    handoffFormat: ""
  };

  const run: RunRecord = {
    id: input.runId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actor: "manager",
    title,
    request: goal,
    summary: {
      goal: packet.goal,
      audience: [],
      constraints: [],
      risks: [],
      unknowns: [],
      successCriteria: [],
      outOfScope: [],
      trustBoundaries: [],
      destructiveActions: [],
      externalIntegrations: [],
      stopGo: "go"
    },
    status: "in_progress",
    createdAt: input.now,
    updatedAt: input.now
  };

  const task: TaskRecord = {
    id: input.taskUuid,
    runId: input.runId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    class: taskClass,
    packet,
    status: "in_progress",
    claimedBy: "manager",
    createdAt: input.now,
    updatedAt: input.now
  };

  const queue: TaskQueue = {
    project_status: "in_progress",
    current_task_id: id,
    tasks: [
      {
        id,
        title,
        status: "in_progress",
        class: taskClass,
        depends_on: [],
        acceptance_criteria: [],
        verification: [],
        evidence: [],
        blocker: null
      }
    ]
  };

  return { run, task, queue, taskClass };
}

function parseFlag(args: readonly string[], flag: string): string | undefined {
  const prefixed = `--${flag}`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === prefixed) {
      return args[i + 1];
    }
    if (args[i]?.startsWith(`${prefixed}=`)) {
      return args[i]!.slice(prefixed.length + 1);
    }
  }
  return undefined;
}

export interface InitTaskCommandOptions {
  store: Pick<
    ArchonStore,
    | "ensureProjectContext"
    | "createRun"
    | "replaceTasks"
    | "getProjectRuntimeState"
    | "saveProjectRuntimeState"
    | "getTask"
    | "updateTask"
    | "findLatestRunForTask"
  >;
  workspaceSlug: string;
  workspaceName: string;
  projectSlug: string;
  projectName: string;
  repoPath: string;
  id: string;
  title: string;
  ownerRole: string;
  goal: string;
  allowedWriteScope: readonly string[];
  class?: string | undefined;
  now?: string | undefined;
  writePacketMarkdown?: boolean | undefined;
  allowManagedScope?: boolean | undefined;
  // Reuse path only: when a task with this --id is already in_progress, overwrite
  // its allowedWriteScope with the supplied scope. Defaults to false so a repeated
  // init-task call can never silently widen (or narrow) a live task's write scope
  // — an explicit opt-in is required to change control-layer reach (#118 advisory).
  updateScope?: boolean | undefined;
}

export interface InitTaskCommandResult {
  runId: string;
  taskId: string;
  allowedWriteScope: string[];
  packetPath?: string | undefined;
  // True only when the reuse path kept the existing scope and ignored a DIFFERING
  // requested scope because --update-scope was not passed. Operators/CLI use this
  // to surface "scope preserved; pass --update-scope to change it".
  scopePreserved: boolean;
}

// Order-insensitive, duplicate-insensitive equality for write-scope lists (scope
// is a set, not a sequence — display order and repeats are incidental). Compare
// Set sizes on BOTH sides: a raw length check would falsely match e.g.
// ["x","x"] vs ["x","y"] (both length 2), masking a real scope change.
function sameScopeSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) {
    return false;
  }
  for (const entry of setA) {
    if (!setB.has(entry)) {
      return false;
    }
  }
  return true;
}

// Write the on-disk fallback packet markdown, guarded against path traversal.
// Returns the absolute path of the written file, or undefined when
// writePacketMarkdown is false.
async function maybeWritePacketMarkdown(
  repoPath: string,
  packet: TaskPacketInput,
  taskClass: TaskClass,
  enabled: boolean | undefined
): Promise<string | undefined> {
  if (enabled === false) {
    return undefined;
  }
  const tasksDir = path.resolve(repoPath, ".archon", "work", "tasks");
  const packetPath = path.resolve(tasksDir, `task-${packet.taskId}.md`);
  // Defence in depth: the id is already slug-validated in buildInitiativeRecords,
  // but never write outside the tasks directory even if that invariant changes.
  if (
    packetPath !== path.join(tasksDir, `task-${packet.taskId}.md`) ||
    !packetPath.startsWith(`${tasksDir}${path.sep}`)
  ) {
    throw new Error(
      `init-task: refusing to write packet outside the tasks directory (${packetPath})`
    );
  }
  await writeArchonExport(repoPath, packetPath, renderTaskPacketMarkdown(packet, taskClass));
  return packetPath;
}

// Impure command — performs the runtime writes. The markdown packet is written
// from Node (outside the PreToolUse boundary) so the on-disk fallback agrees with
// the authoritative runtime record.
//
// Idempotency contract: if a task with the same task_key (--id) already exists
// for this project with status = in_progress, the call REUSES the existing run
// and task instead of creating a new run. This prevents run fragmentation when
// the manager invokes init-task repeatedly for the same logical task.
// Idempotency key: (project, task_key, in_progress).
// Concurrent worktrees with DIFFERENT task ids are completely unaffected.
export async function executeInitTaskCommand(options: InitTaskCommandOptions): Promise<InitTaskCommandResult> {
  const now = options.now ?? new Date().toISOString();
  const { workspace, project } = await options.store.ensureProjectContext({
    workspaceSlug: options.workspaceSlug,
    workspaceName: options.workspaceName,
    projectSlug: options.projectSlug,
    projectName: options.projectName,
    repoPath: options.repoPath
  });

  const existing = await options.store.getProjectRuntimeState(project.id);

  // --- Locate an existing task with this task_key (project-wide) ---
  // Prefer the active run (the common idempotency case), but fall back to the
  // latest run that actually CONTAINS the task_key. Without the fallback, a task
  // sitting in a gating run that the active pointer has since moved off of is
  // invisible here — and --update-scope would then fork a duplicate run + task
  // and repoint the pointer at the duplicate, leaving the original gated work
  // behind (closureLoop bug 1; live 2026-07-04: dup run 8f3417ab shadowed the
  // gated original eca0047f). Locating by task_key regardless of pointer/status
  // is what makes --update-scope a true in-place edit.
  let located: { runId: string; task: TaskRecord } | undefined;
  if (existing?.activeRunId !== undefined) {
    const activeRunTask = await options.store.getTask(existing.activeRunId, options.id);
    if (activeRunTask) {
      located = { runId: existing.activeRunId, task: activeRunTask };
    }
  }
  if (!located) {
    const taskRun = await options.store.findLatestRunForTask({
      workspaceSlug: options.workspaceSlug,
      projectSlug: options.projectSlug,
      taskId: options.id
    });
    if (taskRun) {
      const taskInRun = await options.store.getTask(taskRun.id, options.id);
      if (taskInRun) {
        located = { runId: taskRun.id, task: taskInRun };
      }
    }
  }

  // --update-scope is an in-place UPDATE, never a create. If there is no task to
  // update, fail loudly instead of silently forking a fresh run/task (the exact
  // failure mode closureLoop bug 1 produced).
  if (!located && options.updateScope === true) {
    throw new Error(
      `init-task --update-scope: no existing task with id "${options.id}" to update; ` +
        `omit --update-scope to create a new task`
    );
  }

  // --- Reuse path: (project, task_key) already exists ---
  // Reuse in place when the task is still the live in-progress task (plain
  // idempotency) OR the caller explicitly asked to update its scope. Under
  // --update-scope we reuse REGARDLESS of status so a gated (review_blocked,
  // approved, blocked, …) task's scope is edited in the SAME run + row — never
  // duplicated. Without --update-scope a non-in_progress task falls through to a
  // fresh cycle (re-opening the task_key for a new run), preserving prior behavior.
  if (located && (located.task.status === "in_progress" || options.updateScope === true)) {
    const existingTask = located.task;
    {
      // Validate the incoming options (scope security checks, id format, etc.)
      // by running buildInitiativeRecords with the existing run/task ids to
      // obtain a sanitized scope. Discard the synthetic run/task — we only
      // carry the sanitized scope back to the existing record.
      const { task: template, taskClass } = buildInitiativeRecords({
        id: options.id,
        title: options.title,
        ownerRole: options.ownerRole,
        goal: options.goal,
        allowedWriteScope: options.allowedWriteScope,
        workspaceId: workspace.id,
        projectId: project.id,
        runId: existingTask.runId,
        taskUuid: existingTask.id,
        now,
        class: options.class,
        allowManagedScope: options.allowManagedScope
      });

      // #118 advisory: preserve the existing scope by default. The sanitized
      // requested scope (template) is only persisted when the caller explicitly
      // opts in with --update-scope — otherwise a repeated init-task call could
      // silently widen a live task's control-layer write reach.
      const requestedScope = template.packet.allowedWriteScope;
      const existingScope = existingTask.packet.allowedWriteScope;
      const scopeDiffers = !sameScopeSet(requestedScope, existingScope);
      const applyNewScope = options.updateScope === true && scopeDiffers;
      const scopePreserved = scopeDiffers && options.updateScope !== true;
      const nextScope = applyNewScope ? requestedScope : existingScope;

      // Re-apply scope (or preserve it) on the existing task record immutably.
      // updateTask is still called on every reuse to bump updatedAt (liveness).
      const reusedTask: TaskRecord = {
        ...existingTask,
        packet: {
          ...existingTask.packet,
          allowedWriteScope: nextScope
        },
        updatedAt: now
      };
      await options.store.updateTask(reusedTask);

      // Do NOT call saveProjectRuntimeState here — the reuse path only edits the
      // existing task row and must never move the active pointer. In the common
      // case the pointer already reflects this run/task; when the task was located
      // outside the active run (a gated run the pointer moved off of), a scope
      // edit is still not a reason to repoint — pointer reconciliation is
      // reconcile-runtime-state / close-run's job, not init-task's.
      const packetPath = await maybeWritePacketMarkdown(
        options.repoPath,
        reusedTask.packet,
        taskClass,
        options.writePacketMarkdown
      );

      return {
        runId: reusedTask.runId,
        taskId: reusedTask.packet.taskId,
        allowedWriteScope: [...reusedTask.packet.allowedWriteScope],
        packetPath,
        scopePreserved
      };
    }
  }

  // --- Fresh cycle: task_key absent (or present-but-terminal without
  // --update-scope); create a new run ---
  const { run, task, queue, taskClass } = buildInitiativeRecords({
    id: options.id,
    title: options.title,
    ownerRole: options.ownerRole,
    goal: options.goal,
    allowedWriteScope: options.allowedWriteScope,
    workspaceId: workspace.id,
    projectId: project.id,
    runId: randomUUID(),
    taskUuid: randomUUID(),
    now,
    class: options.class,
    allowManagedScope: options.allowManagedScope
  });

  await options.store.createRun(run);
  await options.store.replaceTasks([task]);
  await options.store.saveProjectRuntimeState({
    projectId: project.id,
    workspaceId: workspace.id,
    activeRunId: run.id,
    activeTaskId: task.packet.taskId,
    taskQueue: queue,
    productState: existing?.productState ?? {},
    lastVerifiedRunId: existing?.lastVerifiedRunId,
    metadata: existing?.metadata ?? {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });

  const packetPath = await maybeWritePacketMarkdown(
    options.repoPath,
    task.packet,
    taskClass,
    options.writePacketMarkdown
  );

  return {
    runId: run.id,
    taskId: task.packet.taskId,
    allowedWriteScope: [...task.packet.allowedWriteScope],
    packetPath,
    scopePreserved: false
  };
}

export function renderTaskPacketMarkdown(packet: TaskPacketInput, taskClass: TaskClass = "prototype_slice"): string {
  const scope = packet.allowedWriteScope.map((entry) => `- ${entry}`).join("\n");
  const effectiveReviews = effectiveRequiredReviews(packet.requiredReviews);
  const reviewsSection = effectiveReviews.map((role) => `- ${role}`).join("\n");
  return `# Task Packet — ${packet.taskId}

## Task ID

\`${packet.taskId}\`

## Owner role

\`${packet.ownerRole}\`

## Completion standard

\`${packet.completionStandard}\`

## Task class

${taskClass}

## Goal

${packet.goal}

## Allowed write scope

${scope || "- ."}

## Continuation intent

continue_now

## Verification required

false

## Required reviews

${reviewsSection}
`;
}

export async function initTaskCommand(
  args: readonly string[],
  deps: {
    withClient: <T>(fn: (client: unknown) => Promise<T>) => Promise<T>;
    createStore: (client: unknown) => InitTaskCommandOptions["store"];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  }
): Promise<void> {
  const env = deps.env ?? process.env;
  const id = parseFlag(args, "id");
  if (!id) {
    throw new Error('init-task requires --id (e.g. --id my-initiative)');
  }
  const title = parseFlag(args, "title") ?? id;
  const ownerRole = parseFlag(args, "owner") ?? "planner";
  const goal = parseFlag(args, "goal") ?? "";
  const scopeRaw = parseFlag(args, "scope") ?? ".archon/work";
  const allowedWriteScope = scopeRaw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const allowManagedScope = args.includes("--allow-managed-scope");
  const updateScope = args.includes("--update-scope");
  const taskClassFlag = parseFlag(args, "class");

  const projectSlug = env.ARCHON_PROJECT_SLUG;
  if (!projectSlug) {
    throw new Error("ARCHON_PROJECT_SLUG is required");
  }

  const result = await deps.withClient(async (client) => {
    const store = deps.createStore(client);
    return executeInitTaskCommand({
      store,
      workspaceSlug: env.ARCHON_WORKSPACE_SLUG ?? "default",
      workspaceName: env.ARCHON_WORKSPACE_NAME ?? "Default Workspace",
      projectSlug,
      projectName: env.ARCHON_PROJECT_NAME ?? projectSlug,
      repoPath: path.resolve(deps.cwd ?? process.cwd()),
      id,
      title,
      ownerRole,
      goal,
      allowedWriteScope,
      class: taskClassFlag,
      allowManagedScope,
      updateScope
    });
  });

  if (result.scopePreserved) {
    console.warn(
      "init-task: existing task is in_progress and its write scope was PRESERVED; " +
        "the requested scope differs but was ignored. Re-run with --update-scope to change it."
    );
  }

  console.log(JSON.stringify(result, null, 2));
}
