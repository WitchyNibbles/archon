import type { MemoryEntryRecord, MarkdownArtifactRecord } from "../../domain/types.ts";
import type { SqlClient, JsonRow, ArtifactHydrationRow } from "./shared.ts";
import { withTransaction } from "./shared.ts";

export async function saveMemoryEntry(client: SqlClient, entry: MemoryEntryRecord): Promise<void> {
  // FIX 3 (HIGH dedup): plain INSERT → ON CONFLICT DO UPDATE to ensure idempotency by id.
  // A fresh id is generated per call, so if the tombstone write fails mid-promotion, a
  // re-promotion window exists without this guard. ON CONFLICT closes the window.
  await client.query(
    `insert into memory_entries (
       id, workspace_id, project_id, run_id, task_id, scope, entry_type, title,
       content, reviewer, actor, status, source_path, source_anchor, metadata
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
     on conflict (id) do update
       set content = excluded.content,
           metadata = excluded.metadata,
           title = excluded.title,
           updated_at = now()`,
    [
      entry.id,
      entry.workspaceId,
      entry.projectId ?? null,
      entry.runId ?? null,
      entry.taskId ?? null,
      entry.scope,
      entry.entryType,
      entry.title,
      entry.content,
      entry.reviewer,
      entry.actor,
      entry.status,
      entry.sourcePath ?? null,
      entry.sourceAnchor ?? null,
      JSON.stringify(entry.metadata ?? {})
    ]
  );
}

export async function listMemoryEntries(
  client: SqlClient,
  params: {
    runId: string;
    taskId?: string | undefined;
    entryType?: MemoryEntryRecord["entryType"] | undefined;
    status?: MemoryEntryRecord["status"] | undefined;
  }
): Promise<MemoryEntryRecord[]> {
  const result = await client.query<JsonRow<MemoryEntryRecord>>(
    `select jsonb_build_object(
        'id', id,
        'workspaceId', workspace_id,
        'projectId', project_id,
        'runId', run_id,
        'taskId', task_id,
        'scope', scope,
        'entryType', entry_type,
        'title', title,
        'content', content,
        'reviewer', reviewer,
        'actor', actor,
        'status', status,
        'sourcePath', source_path,
        'sourceAnchor', source_anchor,
        'metadata', metadata,
        'createdAt', created_at
     ) as payload
     from memory_entries
     where run_id = $1
       and ($2::text is null or task_id = $2)
       and ($3::text is null or entry_type = $3)
       and ($4::text is null or status = $4)
     order by created_at asc`,
    [params.runId, params.taskId ?? null, params.entryType ?? null, params.status ?? null]
  );
  return result.rows.map((row) => row.payload);
}

export async function replaceMarkdownArtifacts(
  client: SqlClient,
  input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    artifacts: readonly MarkdownArtifactRecord[];
  }
): Promise<void> {
  await withTransaction(client, async () => {
    await client.query(
      `delete from embedding_jobs
       where source_table = 'artifacts'
         and project_id = $1`,
      [input.projectId]
    );

    await client.query(
      `delete from artifacts
       where project_id = $1
         and kind = 'markdown_chunk'`,
     [input.projectId]
    );

    for (const artifact of input.artifacts) {
      await client.query(
        `insert into artifacts (
           id, workspace_id, project_id, run_id, task_id, kind, title, content, metadata
         )
         values ($1, $2, $3, $4, null, 'markdown_chunk', $5, $6::jsonb, $7::jsonb)`,
        [
          artifact.id,
          artifact.workspaceId,
          artifact.projectId,
          input.runId,
          artifact.title,
          JSON.stringify({ text: artifact.content }),
          JSON.stringify({
            ...artifact.metadata,
            sourcePath: artifact.sourcePath,
            sourceAnchor: artifact.sourceAnchor ?? null
          })
        ]
      );
    }
  });
}

export async function loadArtifactsByIds(
  client: SqlClient,
  projectSlug: string,
  artifactIds: readonly string[]
): Promise<
  Array<
    Pick<
      MarkdownArtifactRecord,
      "id" | "title" | "content" | "sourcePath" | "sourceAnchor" | "createdAt" | "kind" | "metadata" | "runId"
    >
  >
> {
  if (artifactIds.length === 0) {
    return [];
  }

  const result = await client.query<ArtifactHydrationRow>(
    `select
       a.id,
       a.run_id as "runId",
       a.kind,
       a.title,
       coalesce(a.content->>'text', a.content::text) as content,
       a.metadata->>'sourcePath' as "sourcePath",
       a.metadata->>'sourceAnchor' as "sourceAnchor",
       a.metadata as metadata,
       a.created_at as "createdAt"
     from artifacts a
     join projects p on p.id = a.project_id
     where p.slug = $1
       and a.id::text = any($2::text[])`,
    [projectSlug, artifactIds]
  );

  const byId = new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        runId: row.runId,
        kind: row.kind as MarkdownArtifactRecord["kind"],
        title: row.title,
        content: row.content,
        sourcePath: row.sourcePath ?? undefined,
        sourceAnchor: row.sourceAnchor ?? undefined,
        metadata: row.metadata ?? {},
        createdAt: row.createdAt
      }
    ])
  );

  return artifactIds.map((artifactId) => byId.get(artifactId)).filter(Boolean) as Array<
    Pick<
      MarkdownArtifactRecord,
      "id" | "title" | "content" | "sourcePath" | "sourceAnchor" | "createdAt" | "kind" | "metadata" | "runId"
    >
  >;
}
