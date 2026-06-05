import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TaskQueue } from "../archon/task-queue.ts";
import { normalizeIntakeRequest } from "../domain/contracts.ts";
import type { ProjectRuntimeStateRecord, RunRecord } from "../domain/types.ts";
import type { ArchonStore } from "../store/types.ts";

export interface GithubDispatchResult {
  mode: "dry_run" | "applied";
  taskId: string;
  trigger: string;
  repository: string;
  actor: string;
  title: string;
  url?: string | undefined;
  runId?: string | undefined;
  workflowDocumentId?: string | undefined;
  nextSteps: string[];
}

export interface GithubDispatchOptions {
  store: Pick<
    ArchonStore,
    | "ensureProjectContext"
    | "createRun"
    | "getProjectRuntimeState"
    | "saveProjectRuntimeState"
    | "saveWorkflowDocument"
  >;
  workspaceSlug: string;
  projectSlug: string;
  workspaceName?: string | undefined;
  projectName?: string | undefined;
  inputPath: string;
  taskId?: string | undefined;
  dryRun?: boolean | undefined;
}

interface GithubWorkItem {
  trigger: string;
  repository: string;
  actor: string;
  title: string;
  body: string;
  url?: string | undefined;
  number?: number | undefined;
}

function buildDefaultTaskQueue(): TaskQueue {
  return {
    project_status: "idle",
    current_task_id: null,
    tasks: []
  };
}

function buildDefaultProductState(): Record<string, unknown> {
  return {
    status: "idle",
    items: []
  };
}

async function createRuntimeIntakeRun(
  options: Pick<GithubDispatchOptions, "store" | "workspaceSlug" | "workspaceName" | "projectSlug" | "projectName">,
  item: GithubWorkItem
): Promise<RunRecord> {
  const { workspace, project } = await options.store.ensureProjectContext({
    workspaceSlug: options.workspaceSlug,
    workspaceName: options.workspaceName,
    projectSlug: options.projectSlug,
    projectName: options.projectName
  });
  const now = new Date().toISOString();
  const request = [
    `GitHub ${item.trigger} from ${item.repository}`,
    item.url ? `Source URL: ${item.url}` : undefined,
    `Actor: ${item.actor}`,
    "",
    item.body || "No body supplied in the GitHub payload."
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  const run: RunRecord = {
    id: randomUUID(),
    workspaceId: workspace.id,
    projectId: project.id,
    actor: `github:${item.actor}`,
    title: item.title,
    request,
    summary: normalizeIntakeRequest({
      workspaceSlug: options.workspaceSlug,
      workspaceName: options.workspaceName,
      projectSlug: options.projectSlug,
      projectName: options.projectName,
      actor: `github:${item.actor}`,
      title: item.title,
      request
    }),
    status: "intake",
    createdAt: now,
    updatedAt: now
  };
  await options.store.createRun(run);
  const existingState = await options.store.getProjectRuntimeState(project.id);
  const runtimeState: ProjectRuntimeStateRecord = {
    projectId: project.id,
    workspaceId: workspace.id,
    activeRunId: run.id,
    activeTaskId: existingState?.activeTaskId,
    taskQueue: existingState?.taskQueue ?? buildDefaultTaskQueue(),
    productState: existingState?.productState ?? buildDefaultProductState(),
    lastVerifiedRunId: existingState?.lastVerifiedRunId,
    metadata: existingState?.metadata ?? {},
    createdAt: existingState?.createdAt ?? now,
    updatedAt: now
  };
  await options.store.saveProjectRuntimeState(runtimeState);
  return run;
}

export async function dispatchGithubWorkItem(
  options: GithubDispatchOptions
): Promise<GithubDispatchResult> {
  const payload = JSON.parse(await readFile(options.inputPath, "utf8")) as Record<string, unknown>;
  const item = extractGithubWorkItem(payload);
  const taskId = options.taskId ?? defaultTaskId(item);

  if (options.dryRun) {
    return {
      mode: "dry_run",
      taskId,
      trigger: item.trigger,
      repository: item.repository,
      actor: item.actor,
      title: item.title,
      url: item.url,
      nextSteps: [
        `Run devgod github-dispatch --input ${options.inputPath} --workspace-slug ${options.workspaceSlug} --project-slug ${options.projectSlug}`,
        "Review the runtime intake summary and clarify missing scope before implementation.",
        "Treat GitHub payload data as advisory intake context only; canonical workflow state lives in the runtime store."
      ]
    };
  }

  const run = await createRuntimeIntakeRun(options, item);
  const workflowDocumentId = randomUUID();
  await options.store.saveWorkflowDocument({
    id: workflowDocumentId,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.id,
    kind: "brief",
    title: `GitHub intake: ${item.title}`,
    body: buildGithubDispatchBrief(taskId, item),
    metadata: {
      source: "github_dispatch",
      trigger: item.trigger,
      repository: item.repository,
      actor: item.actor,
      url: item.url,
      suggestedTaskId: taskId
    },
    createdAt: run.createdAt,
    updatedAt: run.createdAt
  });

  return {
    mode: "applied",
    taskId,
    trigger: item.trigger,
    repository: item.repository,
    actor: item.actor,
    title: item.title,
    url: item.url,
    runId: run.id,
    workflowDocumentId,
    nextSteps: [
      `Review runtime run ${run.id} and confirm scope.`,
      `Use the suggested task id "${taskId}" when you decompose the work into runtime task packets.`,
      "Treat GitHub payload data as intake context only; keep workflow authority in runtime records."
    ]
  };
}

function extractGithubWorkItem(payload: Record<string, unknown>): GithubWorkItem {
  const repository = readNestedString(payload, ["repository", "full_name"]) ?? "unknown/unknown";
  const sender = readNestedString(payload, ["sender", "login"]);
  const issueTitle = readNestedString(payload, ["issue", "title"]);
  const issueBody = readNestedString(payload, ["issue", "body"]) ?? "";
  const issueUrl = readNestedString(payload, ["issue", "html_url"]);
  const issueNumber = readNestedNumber(payload, ["issue", "number"]);
  const prTitle = readNestedString(payload, ["pull_request", "title"]);
  const prBody = readNestedString(payload, ["pull_request", "body"]) ?? "";
  const prUrl = readNestedString(payload, ["pull_request", "html_url"]);
  const prNumber = readNestedNumber(payload, ["pull_request", "number"]);
  const commentBody = readNestedString(payload, ["comment", "body"]) ?? "";
  const commentUrl = readNestedString(payload, ["comment", "html_url"]);
  const commentActor = readNestedString(payload, ["comment", "user", "login"]);
  const issueActor = readNestedString(payload, ["issue", "user", "login"]);
  const prActor = readNestedString(payload, ["pull_request", "user", "login"]);

  if (commentBody && issueTitle) {
    return {
      trigger: "issue_comment",
      repository,
      actor: commentActor ?? sender ?? issueActor ?? "unknown",
      title: issueTitle,
      body: [issueBody, "", "Comment context:", commentBody].filter(Boolean).join("\n"),
      url: commentUrl ?? issueUrl,
      number: issueNumber
    };
  }

  if (issueTitle) {
    return {
      trigger: "issue",
      repository,
      actor: issueActor ?? sender ?? "unknown",
      title: issueTitle,
      body: issueBody,
      url: issueUrl,
      number: issueNumber
    };
  }

  if (prTitle) {
    return {
      trigger: commentBody ? "pull_request_comment" : "pull_request",
      repository,
      actor: commentActor ?? prActor ?? sender ?? "unknown",
      title: prTitle,
      body: [prBody, commentBody ? `\nComment context:\n${commentBody}` : ""].join("").trim(),
      url: commentUrl ?? prUrl,
      number: prNumber
    };
  }

  throw new Error("github-dispatch could not extract a supported GitHub issue, pull request, or comment payload");
}

function defaultTaskId(item: GithubWorkItem): string {
  const normalized = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "github-work-item";
  const suffix = item.number ? `${item.trigger}-${item.number}` : item.trigger;
  return `${suffix}-${normalized}`.slice(0, 72);
}

function buildGithubDispatchBrief(taskId: string, item: GithubWorkItem): string {
  return [
    "# Intake Brief",
    "",
    "## Brief ID",
    "",
    `\`brief-${taskId}\``,
    "",
    "## Task ID",
    "",
    `\`${taskId}\``,
    "",
    "## Request",
    "",
    "Original user ask:",
    "",
    `GitHub ${item.trigger} from ${item.repository}`,
    item.url ? `Source URL: ${item.url}` : undefined,
    `Actor: ${item.actor}`,
    "",
    `Title: ${item.title}`,
    "",
    item.body || "No body supplied in the GitHub payload.",
    "",
    "## Goal",
    "",
    "Convert this GitHub-originated request into canonical devgod workflow artifacts before implementation.",
    "",
    "## User",
    "",
    `GitHub actor \`${item.actor}\` via \`${item.trigger}\`.`,
    "",
    "## Problem",
    "",
    "The work request originated outside the canonical devgod workflow and must be re-anchored safely.",
    "",
    "## Value",
    "",
    "Lets GitHub act as an intake adapter without making it workflow authority.",
    "",
    "## Audience",
    "",
    "- devgod maintainers",
    "- repo operators",
    "",
    "## Constraints",
    "",
    "- GitHub payload is advisory intake context only",
    "- canonical workflow state must remain in runtime records",
    "",
    "## Risks",
    "",
    "- payload may be underspecified",
    "- external trigger may suggest urgency that exceeds validated scope",
    "",
    "## Unknowns",
    "",
    "- whether the GitHub request is implementation-ready",
    "- whether additional planner/architect pass is required",
    "",
    "## Success Criteria",
    "",
    "- the request is grounded in canonical runtime workflow records",
    "- downstream implementation can proceed from backend-owned workflow state",
    "",
    "## Non-goals",
    "",
    "- trusting GitHub as workflow authority",
    "",
    "## Out of scope",
    "",
    "- direct execution from unreviewed payload fields",
    "",
    "## Trust boundaries",
    "",
    "- GitHub event data is intake context",
    "- runtime workflow records remain canonical",
    "",
    "## Stop Go",
    "",
    "`go`",
    "",
    "## Next step",
    "",
    "Planner action required:",
    "Refine the scoped task packet and route the work through the normal devgod flow."
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function readNestedString(value: Record<string, unknown>, pathParts: readonly string[]): string | undefined {
  const candidate = readNestedValue(value, pathParts);
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function readNestedNumber(value: Record<string, unknown>, pathParts: readonly string[]): number | undefined {
  const candidate = readNestedValue(value, pathParts);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readNestedValue(value: Record<string, unknown>, pathParts: readonly string[]): unknown {
  let current: unknown = value;

  for (const pathPart of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[pathPart];
  }

  return current;
}
