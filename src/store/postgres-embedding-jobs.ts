import type {
  CompleteEmbeddingJobInput,
  EmbeddingJobRecord,
  EmbeddingJobSourceTable,
  EmbeddingSourceRecord,
  LeaseEmbeddingJobsInput,
  QueueEmbeddingJobInput
} from "./types.ts";
import type { ArtifactVectorIndex } from "./qdrant-artifact-index.ts";

interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<SqlQueryResult<Row>>;
}

interface EmbeddingJobRow {
  id: string;
  workspaceId: string;
  projectId: string | null;
  sourceTable: EmbeddingJobSourceTable;
  sourceId: string;
  embeddingModel: string;
  status: EmbeddingJobRecord["status"];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EmbeddingSourceRow {
  sourceTable: EmbeddingJobSourceTable;
  sourceId: string;
  title: string;
  content: string;
}

interface ArtifactVectorSyncRow {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  content: string;
  sourcePath: string | null;
  sourceAnchor: string | null;
  retrievalRoles: string[] | null;
  tags: string[] | null;
  runtimeProfile: string | null;
  qdrantUrl: string | null;
  qdrantCollection: string | null;
}

function mapEmbeddingJobRow(row: EmbeddingJobRow): EmbeddingJobRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? undefined,
    sourceTable: row.sourceTable,
    sourceId: row.sourceId,
    embeddingModel: row.embeddingModel,
    status: row.status,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function withTransaction<T>(client: SqlClient, work: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const value = await work();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export class PostgresEmbeddingJobs {
  private readonly client: SqlClient;
  private readonly artifactVectorIndex?: ArtifactVectorIndex | undefined;

  constructor(client: SqlClient, options: { artifactVectorIndex?: ArtifactVectorIndex | undefined } = {}) {
    this.client = client;
    this.artifactVectorIndex = options.artifactVectorIndex;
  }

  async queueEmbeddingJob(input: QueueEmbeddingJobInput): Promise<EmbeddingJobRecord> {
    await this.clearDerivedEmbedding(input.sourceTable, input.sourceId);

    const queuedJob = await this.client.query<EmbeddingJobRow>(
      `insert into embedding_jobs (
         workspace_id, project_id, source_table, source_id, embedding_model, status
       )
       values ($1, $2, $3, $4, $5, 'pending')
       on conflict (source_table, source_id, embedding_model) do update
       set workspace_id = excluded.workspace_id,
           project_id = excluded.project_id,
           status = 'pending',
           error_message = null,
           updated_at = now()
       returning
         id,
         workspace_id as "workspaceId",
         project_id as "projectId",
         source_table as "sourceTable",
         source_id as "sourceId",
         embedding_model as "embeddingModel",
         status,
         error_message as "errorMessage",
         created_at as "createdAt",
         updated_at as "updatedAt"`,
      [input.workspaceId, input.projectId ?? null, input.sourceTable, input.sourceId, input.embeddingModel]
    );

    const [job] = queuedJob.rows;
    if (!job) {
      throw new Error("failed to enqueue embedding job");
    }

    return mapEmbeddingJobRow(job);
  }

  async leaseEmbeddingJobs(input: LeaseEmbeddingJobsInput): Promise<EmbeddingJobRecord[]> {
    const leasedJobs = await this.client.query<EmbeddingJobRow>(
      `with leased as (
         select id
         from embedding_jobs
         where status = 'pending'
         order by created_at asc, id asc
         limit $1
         for update skip locked
       )
       update embedding_jobs j
       set status = 'processing',
           error_message = null,
           updated_at = now()
       where j.id in (select id from leased)
       returning
         j.id,
         j.workspace_id as "workspaceId",
         j.project_id as "projectId",
         j.source_table as "sourceTable",
         j.source_id as "sourceId",
         j.embedding_model as "embeddingModel",
         j.status,
         j.error_message as "errorMessage",
         j.created_at as "createdAt",
         j.updated_at as "updatedAt"`
      ,
      [input.limit]
    );

    return leasedJobs.rows.map(mapEmbeddingJobRow);
  }

  async getEmbeddingSource(
    sourceTable: EmbeddingJobSourceTable,
    sourceId: string
  ): Promise<EmbeddingSourceRecord | undefined> {
    if (sourceTable === "memory_entries") {
      const result = await this.client.query<EmbeddingSourceRow>(
        `select
           'memory_entries'::text as "sourceTable",
           id as "sourceId",
           title,
           content
         from memory_entries
         where id = $1`,
        [sourceId]
      );
      return result.rows[0];
    }

    const result = await this.client.query<EmbeddingSourceRow>(
      `select
         'artifacts'::text as "sourceTable",
         id as "sourceId",
         title,
         coalesce(content->>'text', content::text) as content
       from artifacts
       where id = $1`,
      [sourceId]
    );
    return result.rows[0];
  }

  async completeEmbeddingJob(input: CompleteEmbeddingJobInput): Promise<void> {
    await withTransaction(this.client, async () => {
      const leasedJob = await this.client.query<EmbeddingJobRow>(
        `select
           id,
           workspace_id as "workspaceId",
           project_id as "projectId",
           source_table as "sourceTable",
           source_id as "sourceId",
           embedding_model as "embeddingModel",
           status,
           error_message as "errorMessage",
           created_at as "createdAt",
           updated_at as "updatedAt"
         from embedding_jobs
         where id = $1
           and source_table = $2
           and source_id = $3
           and embedding_model = $4
           and status = 'processing'`,
        [input.jobId, input.sourceTable, input.sourceId, input.embeddingModel]
      );

      if (!leasedJob.rows[0]) {
        throw new Error(`embedding job is not leased for completion: ${input.jobId}`);
      }

      const updatedRows = await this.writeDerivedEmbedding(
        input.sourceTable,
        input.sourceId,
        input.embedding,
        input.embeddingModel
      );

      if (updatedRows !== 1) {
        throw new Error(`embedding source not found for completion: ${input.sourceTable}:${input.sourceId}`);
      }

      if (input.sourceTable === "artifacts" && this.artifactVectorIndex) {
        await this.syncArtifactVector({
          sourceId: input.sourceId,
          embedding: input.embedding
        });
      }

      await this.client.query(
        `update embedding_jobs
         set status = 'done',
             error_message = null,
             updated_at = now()
         where id = $1
           and source_table = $2
           and source_id = $3
           and embedding_model = $4
           and status = 'processing'`,
        [input.jobId, input.sourceTable, input.sourceId, input.embeddingModel]
      );
    });
  }

  async failEmbeddingJob(jobId: string, errorMessage: string): Promise<void> {
    await withTransaction(this.client, async () => {
      const result = await this.client.query(
        `update embedding_jobs
         set status = 'failed',
             error_message = $2,
             updated_at = now()
         where id = $1
           and status = 'processing'`,
        [jobId, errorMessage]
      );

      if ((result.rowCount ?? 0) !== 1) {
        throw new Error(`embedding job is not leased for failure: ${jobId}`);
      }
    });
  }

  private async clearDerivedEmbedding(sourceTable: EmbeddingJobSourceTable, sourceId: string): Promise<void> {
    if (sourceTable === "memory_entries") {
      await this.client.query(
        `update memory_entries
         set embedding = null,
             embedding_model = null,
             updated_at = now()
         where id = $1`,
        [sourceId]
      );
      return;
    }

    await this.client.query(
      `update artifacts
       set embedding = null,
           embedding_model = null
       where id = $1`,
      [sourceId]
    );
  }

  private async writeDerivedEmbedding(
    sourceTable: EmbeddingJobSourceTable,
    sourceId: string,
    embedding: readonly number[],
    embeddingModel: string
  ): Promise<number> {
    const vectorValue = `[${embedding.join(",")}]`;

    if (sourceTable === "memory_entries") {
      const result = await this.client.query(
        `update memory_entries
         set embedding = $2::vector,
             embedding_model = $3,
             updated_at = now()
         where id = $1`,
        [sourceId, vectorValue, embeddingModel]
      );
      return result.rowCount ?? 0;
    }

    const result = await this.client.query(
      `update artifacts
       set embedding = $2::vector,
           embedding_model = $3
       where id = $1`,
      [sourceId, vectorValue, embeddingModel]
    );
    return result.rowCount ?? 0;
  }

  private async syncArtifactVector(input: {
    sourceId: string;
    embedding: readonly number[];
  }): Promise<void> {
    const artifactResult = await this.client.query<ArtifactVectorSyncRow>(
      `select
         a.id,
         a.workspace_id as "workspaceId",
         a.project_id as "projectId",
         a.title,
         coalesce(a.content->>'text', a.content::text) as content,
         a.metadata->>'sourcePath' as "sourcePath",
         a.metadata->>'sourceAnchor' as "sourceAnchor",
         coalesce(
           array(
             select jsonb_array_elements_text(a.metadata->'retrievalRoles')
           ),
           array[]::text[]
         ) as "retrievalRoles",
         coalesce(
           array(
             select jsonb_array_elements_text(a.metadata->'tags')
           ),
           array[]::text[]
         ) as "tags",
         r.runtime_profile as "runtimeProfile",
         r.qdrant_url as "qdrantUrl",
         r.qdrant_collection as "qdrantCollection"
       from artifacts a
       left join runtime_project_registrations r on r.project_id = a.project_id
       where a.id = $1`,
      [input.sourceId]
    );

    const artifact = artifactResult.rows[0];
    if (!artifact || !artifact.qdrantUrl || !artifact.qdrantCollection || !artifact.runtimeProfile) {
      return;
    }

    await this.artifactVectorIndex?.upsertArtifactPoint({
      baseUrl: artifact.qdrantUrl,
      runtimeProfile: artifact.runtimeProfile,
      collection: artifact.qdrantCollection,
      point: {
        id: artifact.id,
        vector: input.embedding,
        projectId: artifact.projectId,
        sourcePath: artifact.sourcePath ?? undefined,
        sourceAnchor: artifact.sourceAnchor ?? undefined,
        retrievalRoles: artifact.retrievalRoles ?? [],
        tags: artifact.tags ?? []
      }
    });
  }
}
