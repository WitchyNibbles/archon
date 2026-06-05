import type {
  MarkdownArtifactRecord,
  MemoryEntryRecord,
  RetrievalMetadata,
  RetrievalRole,
  SearchMemoryResult,
  WorkflowDocumentRecord
} from "../domain/types.ts";
import { DEFAULT_RETRIEVAL_ROLE } from "../domain/contracts.ts";
import {
  buildArtifactSearchResult,
  buildMemorySearchResult,
  buildWorkflowDocumentSearchResult,
  canRoleAccessRetrievalMetadata,
  compareMemorySearchResults
} from "../core/policy.ts";
import type { SqlClient } from "./postgres-store.ts";

interface SearchMemoryRow {
  id: string;
  sourceKind: "memory_entry" | "artifact" | "workflow_document";
  title: string;
  content: string;
  scope: SearchMemoryResult["scope"];
  metadata?: RetrievalMetadata | null;
  entryType?: MemoryEntryRecord["entryType"] | null;
  artifactKind?: MarkdownArtifactRecord["kind"] | null;
  workflowDocumentKind?: WorkflowDocumentRecord["kind"] | null;
  actor?: string | null;
  reviewer?: string | null;
  runId: string;
  taskId: string | null;
  sourcePath?: string | null;
  sourceAnchor?: string | null;
  projectId: string | null;
  createdAt: string;
  vectorScore?: number | null;
}

function formatVector(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

function vectorScoreBoost(vectorScore?: number | null): number {
  if (vectorScore === null || vectorScore === undefined || !Number.isFinite(vectorScore)) {
    return 0;
  }

  return Math.max(0, vectorScore) * 6;
}

function buildLexicalBackfillClauses(
  query: string,
  startParam: number,
  alias: string,
  contentExpression: string
): {
  sql: string;
  values: string[];
  nextParam: number;
} {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].slice(0, 5);
  const values = terms.map((term) => `%${term}%`);
  const clauses = values.map(
    (_value, index) => `(${alias}.title ilike $${startParam + index} or ${contentExpression} ilike $${startParam + index})`
  );

  return {
    sql: clauses.length > 0 ? clauses.join(" and ") : "true",
    values,
    nextParam: startParam + values.length
  };
}

function dedupeMemoryRows(rows: readonly SearchMemoryRow[]): SearchMemoryRow[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

export async function searchMemory(
  client: SqlClient,
  params: {
    workspaceSlug: string;
    projectSlug: string;
    query: string;
    limit: number;
    includeGlobal: boolean;
    queryEmbedding?: readonly number[] | undefined;
    embeddingModel?: string | undefined;
    requesterRole?: RetrievalRole | undefined;
  }
): Promise<SearchMemoryResult[]> {
  const requesterRole = params.requesterRole ?? DEFAULT_RETRIEVAL_ROLE;
  const projectId = `project:${params.workspaceSlug}:${params.projectSlug}`;
  const recentLimit = Math.min(Math.max(params.limit * 5, 25), 200);
  const backfillLimit = Math.min(Math.max(params.limit * 3, 15), 100);
  const vectorLimit = Math.min(Math.max(params.limit * 3, 15), 100);
  const lexicalClauses = buildLexicalBackfillClauses(params.query, 5, "m", "m.content");

  const recentMemoryResult = await client.query<SearchMemoryRow>(
    `with project_context as (
       select p.id as project_id
       from projects p
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1 and p.slug = $2
     )
     select
       m.id,
       'memory_entry'::text as "sourceKind",
       m.title,
       m.content,
       m.scope,
       m.metadata as metadata,
       m.entry_type as "entryType",
       m.actor,
       m.reviewer,
       m.run_id as "runId",
       m.task_id as "taskId",
       m.source_path as "sourcePath",
       m.source_anchor as "sourceAnchor",
       m.project_id as "projectId",
       m.created_at as "createdAt"
     from memory_entries m
     join project_context pc on true
     join workspaces w on w.id = m.workspace_id
     where w.slug = $1
       and m.status = 'approved'
       and (
         m.project_id = pc.project_id
         or ($3::boolean and m.scope = 'global')
       )
     order by
       case when m.project_id = pc.project_id then 0 else 1 end,
       m.created_at desc
     limit $4`,
    [params.workspaceSlug, params.projectSlug, params.includeGlobal, recentLimit]
  );

  const backfillMemoryResult = await client.query<SearchMemoryRow>(
    `with project_context as (
       select p.id as project_id
       from projects p
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1 and p.slug = $2
     )
     select
       m.id,
       'memory_entry'::text as "sourceKind",
       m.title,
       m.content,
       m.scope,
       m.metadata as metadata,
       m.entry_type as "entryType",
       m.actor,
       m.reviewer,
       m.run_id as "runId",
       m.task_id as "taskId",
       m.source_path as "sourcePath",
       m.source_anchor as "sourceAnchor",
       m.project_id as "projectId",
       m.created_at as "createdAt"
     from memory_entries m
     join project_context pc on true
     join workspaces w on w.id = m.workspace_id
     where w.slug = $1
       and m.status = 'approved'
       and (
         m.project_id = pc.project_id
         or ($3::boolean and m.scope = 'global')
       )
       and ${lexicalClauses.sql}
     order by
       case when m.project_id = pc.project_id then 0 else 1 end,
       case when m.title ilike $4 then 0 else 1 end,
       m.created_at desc
     limit $${lexicalClauses.nextParam}`,
    [params.workspaceSlug, params.projectSlug, params.includeGlobal, `%${params.query}%`, ...lexicalClauses.values, backfillLimit]
  );

  const vectorMemoryResult =
    params.queryEmbedding && params.embeddingModel
      ? await client.query<SearchMemoryRow>(
          `with project_context as (
             select p.id as project_id
             from projects p
             join workspaces w on w.id = p.workspace_id
             where w.slug = $1 and p.slug = $2
           )
           select
             m.id,
             'memory_entry'::text as "sourceKind",
             m.title,
             m.content,
             m.scope,
             m.metadata as metadata,
             m.entry_type as "entryType",
             m.actor,
             m.reviewer,
             m.run_id as "runId",
             m.task_id as "taskId",
             m.source_path as "sourcePath",
             m.source_anchor as "sourceAnchor",
             m.project_id as "projectId",
             m.created_at as "createdAt",
             greatest(0, 1 - (m.embedding <=> $4::vector)) as "vectorScore"
           from memory_entries m
           join project_context pc on true
           join workspaces w on w.id = m.workspace_id
           where w.slug = $1
             and m.status = 'approved'
             and m.embedding is not null
             and m.embedding_model = $5
             and (
               m.project_id = pc.project_id
               or ($3::boolean and m.scope = 'global')
             )
           order by
             case when m.project_id = pc.project_id then 0 else 1 end,
             m.embedding <=> $4::vector asc,
             m.created_at desc
           limit $6`,
          [
            params.workspaceSlug,
            params.projectSlug,
            params.includeGlobal,
            formatVector(params.queryEmbedding),
            params.embeddingModel,
            vectorLimit
          ]
        )
      : { rows: [], rowCount: 0 };

  const recentArtifactResult = await client.query<SearchMemoryRow>(
    `with project_context as (
       select p.id as project_id
       from projects p
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1 and p.slug = $2
     )
     select
       a.id,
       'artifact'::text as "sourceKind",
       a.title,
       coalesce(a.content->>'text', a.content::text) as content,
       'project'::text as scope,
       a.metadata as metadata,
       null::text as "entryType",
       a.kind as "artifactKind",
       null::text as actor,
       null::text as reviewer,
       a.run_id as "runId",
       null::text as "taskId",
       a.metadata->>'sourcePath' as "sourcePath",
       a.metadata->>'sourceAnchor' as "sourceAnchor",
       a.project_id as "projectId",
       a.created_at as "createdAt"
     from artifacts a
     join project_context pc on a.project_id = pc.project_id
     where a.kind = 'markdown_chunk'
     order by a.created_at desc
     limit $3`,
    [params.workspaceSlug, params.projectSlug, recentLimit]
  );

  const artifactLexicalClauses = buildLexicalBackfillClauses(
    params.query,
    4,
    "a",
    "coalesce(a.content->>'text', a.content::text)"
  );
  const backfillArtifactResult = await client.query<SearchMemoryRow>(
    `with project_context as (
       select p.id as project_id
       from projects p
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1 and p.slug = $2
     )
     select
       a.id,
       'artifact'::text as "sourceKind",
       a.title,
       coalesce(a.content->>'text', a.content::text) as content,
       'project'::text as scope,
       a.metadata as metadata,
       null::text as "entryType",
       a.kind as "artifactKind",
       null::text as actor,
       null::text as reviewer,
       a.run_id as "runId",
       null::text as "taskId",
       a.metadata->>'sourcePath' as "sourcePath",
       a.metadata->>'sourceAnchor' as "sourceAnchor",
       a.project_id as "projectId",
       a.created_at as "createdAt"
     from artifacts a
     join project_context pc on a.project_id = pc.project_id
     where a.kind = 'markdown_chunk'
       and ${artifactLexicalClauses.sql}
     order by
       case when a.title ilike $3 then 0 else 1 end,
       a.created_at desc
     limit $${artifactLexicalClauses.nextParam}`,
    [`${params.workspaceSlug}`, `${params.projectSlug}`, `%${params.query}%`, ...artifactLexicalClauses.values, backfillLimit]
  );

  const vectorArtifactResult =
    params.queryEmbedding && params.embeddingModel
      ? await client.query<SearchMemoryRow>(
          `with project_context as (
             select p.id as project_id
             from projects p
             join workspaces w on w.id = p.workspace_id
             where w.slug = $1 and p.slug = $2
           )
           select
             a.id,
             'artifact'::text as "sourceKind",
             a.title,
             coalesce(a.content->>'text', a.content::text) as content,
             'project'::text as scope,
             a.metadata as metadata,
             null::text as "entryType",
             a.kind as "artifactKind",
             null::text as actor,
             null::text as reviewer,
             a.run_id as "runId",
             null::text as "taskId",
             a.metadata->>'sourcePath' as "sourcePath",
             a.metadata->>'sourceAnchor' as "sourceAnchor",
             a.project_id as "projectId",
             a.created_at as "createdAt",
             greatest(0, 1 - (a.embedding <=> $3::vector)) as "vectorScore"
           from artifacts a
           join project_context pc on a.project_id = pc.project_id
           where a.kind = 'markdown_chunk'
             and a.embedding is not null
             and a.embedding_model = $4
           order by a.embedding <=> $3::vector asc, a.created_at desc
           limit $5`,
          [params.workspaceSlug, params.projectSlug, formatVector(params.queryEmbedding), params.embeddingModel, vectorLimit]
        )
      : { rows: [], rowCount: 0 };

  const workflowLexicalClauses = buildLexicalBackfillClauses(params.query, 4, "d", "d.body");
  const backfillWorkflowDocumentResult = await client.query<SearchMemoryRow>(
    `with project_context as (
       select p.id as project_id
       from projects p
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1 and p.slug = $2
     )
     select
       d.id::text as id,
       'workflow_document'::text as "sourceKind",
       d.title,
       d.body as content,
       'project'::text as scope,
       d.metadata as metadata,
       null::text as "entryType",
       null::text as "artifactKind",
       d.kind as "workflowDocumentKind",
       null::text as actor,
       null::text as reviewer,
       d.run_id::text as "runId",
       d.task_id as "taskId",
       null::text as "sourcePath",
       null::text as "sourceAnchor",
       d.project_id as "projectId",
       d.created_at as "createdAt"
     from workflow_documents d
     join project_context pc on d.project_id = pc.project_id
     where ${workflowLexicalClauses.sql}
     order by
       case when d.title ilike $3 then 0 else 1 end,
       d.created_at desc
     limit $${workflowLexicalClauses.nextParam}`,
    [`${params.workspaceSlug}`, `${params.projectSlug}`, `%${params.query}%`, ...workflowLexicalClauses.values, backfillLimit]
  );

  return dedupeMemoryRows([
    ...recentMemoryResult.rows,
    ...backfillMemoryResult.rows,
    ...vectorMemoryResult.rows,
    ...recentArtifactResult.rows,
    ...backfillArtifactResult.rows,
    ...vectorArtifactResult.rows,
    ...backfillWorkflowDocumentResult.rows
  ])
    .filter((entry) => canRoleAccessRetrievalMetadata(entry.metadata ?? undefined, requesterRole))
    .map((entry) => {
      if (entry.sourceKind === "artifact") {
        const baseResult = buildArtifactSearchResult(
          {
            id: entry.id,
            kind: "markdown_chunk",
            title: entry.title,
            content: entry.content,
            sourcePath: entry.sourcePath ?? `artifact://${entry.id}`,
            sourceAnchor: entry.sourceAnchor ?? undefined,
            metadata: (entry.metadata ?? {}) as MarkdownArtifactRecord["metadata"],
            createdAt: entry.createdAt,
            runId: entry.runId
          },
          params.query,
          params.projectSlug
        );
        return {
          ...baseResult,
          score: baseResult.score + vectorScoreBoost(entry.vectorScore)
        };
      }

      if (entry.sourceKind === "workflow_document") {
        const baseResult = buildWorkflowDocumentSearchResult(
          {
            id: entry.id,
            title: entry.title,
            body: entry.content,
            kind: entry.workflowDocumentKind ?? "brief",
            metadata: (entry.metadata ?? {}) as WorkflowDocumentRecord["metadata"],
            createdAt: entry.createdAt,
            runId: entry.runId,
            taskId: entry.taskId ?? undefined
          },
          params.query,
          params.projectSlug
        );
        return {
          ...baseResult,
          score: baseResult.score + vectorScoreBoost(entry.vectorScore)
        };
      }

      const sameProject = entry.projectId === projectId;
      const baseResult = buildMemorySearchResult(
        {
          id: entry.id,
          title: entry.title,
          content: entry.content,
          scope: entry.scope,
          entryType: entry.entryType ?? "fact",
          actor: entry.actor ?? "",
          reviewer: entry.reviewer ?? "",
          runId: entry.runId,
          taskId: entry.taskId ?? undefined,
          sourcePath: entry.sourcePath ?? undefined,
          sourceAnchor: entry.sourceAnchor ?? undefined,
          metadata: entry.metadata ?? {},
          createdAt: entry.createdAt
        },
        params.query,
        sameProject,
        sameProject ? params.projectSlug : undefined
      );
      return {
        ...baseResult,
        score: baseResult.score + vectorScoreBoost(entry.vectorScore)
      };
    })
    .sort(compareMemorySearchResults)
    .slice(0, params.limit);
}
