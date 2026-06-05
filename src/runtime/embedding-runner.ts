import type { CompleteEmbeddingJobInput, ArchonStore, EmbeddingJobRecord, EmbeddingSourceRecord } from "../store/types.ts";

export interface EmbeddingProvider {
  embed(input: {
    job: EmbeddingJobRecord;
    model: string;
    source: EmbeddingSourceRecord;
    text: string;
  }): Promise<readonly number[]>;
  embedQuery?(input: {
    model: string;
    text: string;
  }): Promise<readonly number[]>;
}

export interface RunEmbeddingJobsInput {
  store: Pick<
    ArchonStore,
    "leaseEmbeddingJobs" | "getEmbeddingSource" | "completeEmbeddingJob" | "failEmbeddingJob"
  >;
  provider: EmbeddingProvider;
  limit: number;
}

export interface RunEmbeddingJobsResult {
  leased: number;
  completed: number;
  failed: number;
}

export function buildEmbeddingText(source: EmbeddingSourceRecord): string {
  return [source.title.trim(), source.content.trim()].filter((value) => value.length > 0).join("\n\n");
}

export async function embedQueryText(input: {
  provider: EmbeddingProvider;
  model: string;
  text: string;
}): Promise<readonly number[]> {
  if (typeof input.provider.embedQuery === "function") {
    return input.provider.embedQuery({
      model: input.model,
      text: input.text
    });
  }

  return input.provider.embed({
    job: {
      id: `query:${input.model}`,
      workspaceId: "workspace:query",
      projectId: undefined,
      sourceTable: "memory_entries",
      sourceId: "query",
      embeddingModel: input.model,
      status: "processing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    model: input.model,
    source: {
      sourceTable: "memory_entries",
      sourceId: "query",
      title: "query",
      content: input.text
    },
    text: input.text
  });
}

export async function runEmbeddingJobs(input: RunEmbeddingJobsInput): Promise<RunEmbeddingJobsResult> {
  const jobs = await input.store.leaseEmbeddingJobs({ limit: input.limit });
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    const source = await input.store.getEmbeddingSource(job.sourceTable, job.sourceId);
    if (!source) {
      await input.store.failEmbeddingJob(job.id, `embedding source missing: ${job.sourceTable}:${job.sourceId}`);
      failed += 1;
      continue;
    }

    try {
      const text = buildEmbeddingText(source);
      const embedding = await input.provider.embed({
        job,
        model: job.embeddingModel,
        source,
        text
      });

      assertFiniteEmbedding(embedding);

      const completionInput: CompleteEmbeddingJobInput = {
        jobId: job.id,
        sourceTable: job.sourceTable,
        sourceId: job.sourceId,
        embeddingModel: job.embeddingModel,
        embedding
      };
      await input.store.completeEmbeddingJob(completionInput);
      completed += 1;
    } catch (error) {
      await input.store.failEmbeddingJob(job.id, sanitizeEmbeddingError(error));
      failed += 1;
    }
  }

  return {
    leased: jobs.length,
    completed,
    failed
  };
}

function assertFiniteEmbedding(embedding: readonly number[]): void {
  if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("embedding provider returned an invalid vector");
  }
}

function sanitizeEmbeddingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s"'`]+/gi, "Bearer [REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_[REDACTED]")
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g, "$1-[REDACTED]")
    .replace(/\bpostgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/gi, "postgres://[REDACTED]@")
    .replace(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED_SECRET]")
    .slice(0, 240);
}
