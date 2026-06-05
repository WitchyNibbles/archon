import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildArtifactSearchResult, compareMemorySearchResults } from "../core/policy.ts";
import type { RetrievalRole, SearchMemoryResult } from "../domain/types.ts";
import { buildPlanningContextReasoningWarnings } from "../core/reasoning-quality.ts";

export interface PlanningContextRetrievalState {
  authorityLabel: "derived_only";
  state: "fresh" | "stale" | "missing" | "degraded";
  summary: string;
}

export interface PlanningContextRepoContextItem {
  slotKey: string;
  title: string;
  value: string;
  sourceKind: "derived_file" | "derived_manifest";
  freshness: "fresh" | "stale";
}

export interface PlanningContextRepoContextState {
  authorityLabel: "derived_only";
  state: "fresh" | "stale" | "missing" | "degraded";
  summary: string;
  items: PlanningContextRepoContextItem[];
}

export interface PlanningContextItem {
  id: string;
  title: string;
  score: number;
  scope: string;
  authority: string;
  citation: string;
  freshness: string;
  preview: string;
  tags: string[];
  conflictDetected: boolean;
  reasoningWarnings: string[];
}

export interface PlanningContextReport {
  authorityLabel: "derived_only";
  query: string;
  requesterRole: RetrievalRole;
  totalResults: number;
  repoContext?: PlanningContextRepoContextState | undefined;
  retrieval?: PlanningContextRetrievalState | undefined;
  summary: string[];
  items: PlanningContextItem[];
}

export interface LocalWorkflowArtifactSearchInput {
  cwd: string;
  query: string;
  projectSlug: string;
  requesterRole: RetrievalRole;
  limit: number;
}

export function buildPlanningContextReport(input: {
  query: string;
  requesterRole: RetrievalRole;
  repoContext?: PlanningContextRepoContextState | undefined;
  retrieval?: PlanningContextRetrievalState | undefined;
  results: readonly SearchMemoryResult[];
}): PlanningContextReport {
  const items = input.results.map((result) => ({
    id: result.id,
    title: result.title,
    score: Number(result.score.toFixed(2)),
    scope: result.scope,
    authority: `${result.authority.source}:${result.authority.precedence}`,
    citation: result.citation.canonicalRef,
    freshness: result.freshness.status,
    preview: summarize(result.content),
    tags: [...result.metadata.tags],
    conflictDetected: result.conflict.detected,
    reasoningWarnings: buildPlanningContextReasoningWarnings(result)
  }));

  const summary = items.slice(0, 5).map((item) => {
    const conflict = item.conflictDetected ? " conflict" : "";
    const warning = item.reasoningWarnings.length > 0 ? " warn" : "";
    return `${item.title} (${item.authority}, ${item.freshness}${conflict}${warning})`;
  });

  return {
    authorityLabel: "derived_only",
    query: input.query,
    requesterRole: input.requesterRole,
    totalResults: items.length,
    repoContext: input.repoContext,
    retrieval: input.retrieval,
    summary,
    items
  };
}

export function formatPlanningContextReportMarkdown(report: PlanningContextReport): string {
  const lines: string[] = [];
  lines.push(`# archon planning context`);
  lines.push("");
  lines.push(`- query: ${report.query}`);
  lines.push(`- role: \`${report.requesterRole}\``);
  lines.push(`- results: ${report.totalResults}`);
  if (report.repoContext) {
    lines.push(`- repo-context: ${report.repoContext.state}`);
    lines.push(`- repo-context-summary: ${report.repoContext.summary}`);
  }
  if (report.retrieval) {
    lines.push(`- retrieval: ${report.retrieval.state}`);
    lines.push(`- retrieval-summary: ${report.retrieval.summary}`);
  }
  lines.push("");
  if (report.repoContext?.items.length) {
    lines.push(`## Repo Context`);
    lines.push("");
    for (const item of report.repoContext.items) {
      lines.push(`- ${item.title}`);
      lines.push(`  slot: ${item.slotKey}`);
      lines.push(`  value: ${item.value}`);
      lines.push(`  source-kind: ${item.sourceKind}`);
      lines.push(`  freshness: ${item.freshness}`);
    }
    lines.push("");
  }
  if (report.summary.length > 0) {
    lines.push(`## Summary`);
    lines.push("");
    for (const item of report.summary) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  lines.push(`## Items`);
  lines.push("");
  for (const item of report.items) {
    lines.push(`- ${item.title}`);
    lines.push(`  citation: ${item.citation}`);
    lines.push(`  authority: ${item.authority}`);
    lines.push(`  freshness: ${item.freshness}`);
    lines.push(`  preview: ${item.preview}`);
    if (item.reasoningWarnings.length > 0) {
      lines.push(`  reasoning-warnings: ${item.reasoningWarnings.join("; ")}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function searchLocalWorkflowArtifacts(
  input: LocalWorkflowArtifactSearchInput
): Promise<SearchMemoryResult[]> {
  const repoRoot = path.resolve(input.cwd);
  const candidatePaths = await collectLocalWorkflowArtifactPaths(repoRoot);
  const results: SearchMemoryResult[] = [];
  const discoveredAt = new Date().toISOString();

  for (const relativePath of candidatePaths) {
    const absolutePath = path.join(repoRoot, relativePath);
    const content = await readWorkflowArtifactContent(absolutePath);
    if (!content) {
      continue;
    }

    const title = deriveWorkflowArtifactTitle(relativePath, content);
    const result = buildArtifactSearchResult(
      {
        id: createHash("sha1").update(relativePath).digest("hex"),
        kind: "markdown_chunk",
        title,
        content,
        sourcePath: relativePath,
        metadata: {
          authorityLevel: "operational_context",
          retrievalRoles: [input.requesterRole],
          tags: deriveWorkflowArtifactTags(relativePath)
        },
        createdAt: discoveredAt,
        runId: "local-workflow-artifacts"
      },
      input.query,
      input.projectSlug
    );
    results.push(result);
  }

  return results.sort(compareMemorySearchResults).slice(0, input.limit);
}

function summarize(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

async function collectLocalWorkflowArtifactPaths(repoRoot: string): Promise<string[]> {
  const candidateFiles = [
    ".archon/ACTIVE",
    ".archon/work/product-state.md",
    ".archon/work/task-queue.json"
  ];
  const candidateDirs = [
    ".archon/work/briefs",
    ".archon/work/plans",
    ".archon/work/tasks",
    ".archon/work/reviews",
    ".archon/work/checkpoints"
  ];

  const results = new Set<string>();
  for (const relativePath of candidateFiles) {
    if (await canReadFile(path.join(repoRoot, relativePath))) {
      results.add(relativePath);
    }
  }

  for (const relativeDir of candidateDirs) {
    const absoluteDir = path.join(repoRoot, relativeDir);
    const entries = await safeReadDir(absoluteDir);
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name === "README.md") {
        continue;
      }
      results.add(path.posix.join(relativeDir, entry.name));
    }
  }

  return [...results].sort();
}

async function canReadFile(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(directoryPath: string) {
  try {
    return await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readWorkflowArtifactContent(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    const normalized = content.trim();
    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function deriveWorkflowArtifactTitle(relativePath: string, content: string): string {
  if (relativePath === ".archon/ACTIVE") {
    return "Workflow active marker";
  }
  if (relativePath.endsWith("product-state.md")) {
    return "Workflow product state";
  }
  if (relativePath.endsWith("task-queue.json")) {
    return "Workflow task queue";
  }

  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));
  if (heading) {
    return heading.slice(2).trim();
  }

  return path.basename(relativePath);
}

function deriveWorkflowArtifactTags(relativePath: string): string[] {
  const tags = ["workflow-artifact", "local-export"];
  if (relativePath.includes("/briefs/")) {
    tags.push("brief");
  } else if (relativePath.includes("/plans/")) {
    tags.push("plan");
  } else if (relativePath.includes("/tasks/")) {
    tags.push("task");
  } else if (relativePath.includes("/reviews/")) {
    tags.push("review");
  } else if (relativePath.includes("/checkpoints/")) {
    tags.push("checkpoint");
  } else if (relativePath.endsWith("product-state.md")) {
    tags.push("product-state");
  } else if (relativePath.endsWith("task-queue.json")) {
    tags.push("task-queue");
  } else if (relativePath === ".archon/ACTIVE") {
    tags.push("active-marker");
  }

  return tags;
}
