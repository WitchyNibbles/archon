import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isAnthropicEmbeddingConfigured } from "./anthropic-embedding-provider.ts";
import type { QueueEmbeddingJobInput } from "../store/types.ts";

const MEMORY_DIR_PATTERN = /\.md$/i;
const EXCLUDED_FILES = new Set([".env", ".env.local", ".env.example"]);
const MEMORY_INGESTION_SOURCE_TABLE = "artifacts" as const;

export interface IngestionStore {
  queueEmbeddingJob(input: QueueEmbeddingJobInput): Promise<unknown>;
  getProjectContext(params: {
    workspaceSlug: string;
    projectSlug: string;
  }): Promise<{ workspace: { id: string }; project: { id: string } } | undefined>;
}

export interface MemoryIngestionOptions {
  workspaceSlug: string;
  projectSlug: string;
  embeddingModel: string;
  store: IngestionStore;
}

export interface IngestionResult {
  skipped: number;
  queued: number;
  errors: string[];
}

function buildDocumentId(sourceKind: string, filePath: string): string {
  const hash = createHash("sha256").update(`${sourceKind}:${filePath}`).digest("hex");
  return `ingestion-${hash.slice(0, 12)}`;
}

function isExcludedFile(fileName: string): boolean {
  const base = path.basename(fileName);
  return EXCLUDED_FILES.has(base) || base.startsWith(".");
}

async function safeReadDir(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && MEMORY_DIR_PATTERN.test(entry.name) && !isExcludedFile(entry.name))
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

async function safeFileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ingest all .md files in a memory directory as embedding jobs.
 * No-op when ANTHROPIC_API_KEY is not configured or the directory does not exist.
 */
export async function ingestMemoryDirectory(
  dir: string,
  options: MemoryIngestionOptions
): Promise<IngestionResult> {
  if (!isAnthropicEmbeddingConfigured()) {
    return { skipped: 0, queued: 0, errors: [] };
  }

  const context = await options.store.getProjectContext({
    workspaceSlug: options.workspaceSlug,
    projectSlug: options.projectSlug
  });

  if (!context) {
    return { skipped: 0, queued: 0, errors: [`project ${options.workspaceSlug}/${options.projectSlug} not bootstrapped`] };
  }

  const filePaths = await safeReadDir(dir);
  let skipped = 0;
  let queued = 0;
  const errors: string[] = [];

  for (const filePath of filePaths) {
    if (isExcludedFile(filePath)) {
      skipped += 1;
      continue;
    }

    const docId = buildDocumentId("memory_dir", filePath);

    try {
      await options.store.queueEmbeddingJob({
        workspaceId: context.workspace.id,
        projectId: context.project.id,
        sourceTable: MEMORY_INGESTION_SOURCE_TABLE,
        sourceId: docId,
        embeddingModel: options.embeddingModel
      });
      queued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`failed to queue ${filePath}: ${message.slice(0, 120)}`);
    }
  }

  return { skipped, queued, errors };
}

/**
 * Ingest a task packet document as an embedding job.
 * No-op when ANTHROPIC_API_KEY is not configured or the packet file does not exist.
 */
export async function ingestTaskDocument(
  taskId: string,
  taskPacketPath: string,
  options: MemoryIngestionOptions
): Promise<IngestionResult> {
  if (!isAnthropicEmbeddingConfigured()) {
    return { skipped: 0, queued: 0, errors: [] };
  }

  const exists = await safeFileExists(taskPacketPath);
  if (!exists) {
    return { skipped: 1, queued: 0, errors: [] };
  }

  const context = await options.store.getProjectContext({
    workspaceSlug: options.workspaceSlug,
    projectSlug: options.projectSlug
  });

  if (!context) {
    return { skipped: 0, queued: 0, errors: [`project ${options.workspaceSlug}/${options.projectSlug} not bootstrapped`] };
  }

  const docId = buildDocumentId("task_packet", taskId);

  try {
    await options.store.queueEmbeddingJob({
      workspaceId: context.workspace.id,
      projectId: context.project.id,
      sourceTable: MEMORY_INGESTION_SOURCE_TABLE,
      sourceId: docId,
      embeddingModel: options.embeddingModel
    });
    return { skipped: 0, queued: 1, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipped: 0, queued: 0, errors: [`failed to queue task ${taskId}: ${message.slice(0, 120)}`] };
  }
}

/**
 * Trigger ingestion for both memory directory and a closing task packet.
 * Called from the handoff submission path. All errors are non-fatal.
 */
export async function triggerTaskCloseIngestion(input: {
  taskId: string;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  store: IngestionStore;
}): Promise<void> {
  const env = input.env ?? process.env;
  const embeddingModel = env["ARCHON_EMBEDDING_MODEL"]?.trim();
  const workspaceSlug = env["ARCHON_WORKSPACE_SLUG"]?.trim();
  const projectSlug = env["ARCHON_PROJECT_SLUG"]?.trim();

  if (!embeddingModel || !workspaceSlug || !projectSlug) {
    return;
  }

  if (!isAnthropicEmbeddingConfigured(env)) {
    return;
  }

  const cwd = input.cwd ?? process.cwd();
  const memoryDir = path.join(cwd, ".archon", "memory");
  const taskPacketPath = path.join(cwd, ".archon", "work", "tasks", `task-${input.taskId}.md`);

  const options: MemoryIngestionOptions = {
    workspaceSlug,
    projectSlug,
    embeddingModel,
    store: input.store
  };

  await Promise.allSettled([
    ingestMemoryDirectory(memoryDir, options),
    ingestTaskDocument(input.taskId, taskPacketPath, options)
  ]);
}

