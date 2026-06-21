// ---------------------------------------------------------------------------
// PostgresMistakeLedgerStore — occurrence persistence via productState JSONB
// ---------------------------------------------------------------------------
// Raw occurrences are appended to project_runtime_state.product_state under
// the key "mistake_occurrences" (array of MistakeOccurrenceRecord).
// No schema migration required for P1. Upsert is by record id (later wins).

import type { MemoryEntryRecord, RetrievalMetadata } from "../domain/types.ts";
import type { MistakeLedgerStoreLike } from "./types.ts";
import type { MistakeOccurrenceRecord } from "../runtime/mistake-ledger.ts";
import type { SqlClient, JsonRow } from "./postgres/shared.ts";
import { locusMatchesGlob } from "./locus-glob.ts";

const PRODUCT_STATE_KEY = "mistake_occurrences";

type ProductStateRow = {
  product_state: Record<string, unknown>;
};

function parseMistakeOccurrences(productState: Record<string, unknown>): MistakeOccurrenceRecord[] {
  const raw = productState[PRODUCT_STATE_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  // Narrow: accept only objects that look like MistakeOccurrenceRecord
  return raw.filter(
    (item): item is MistakeOccurrenceRecord =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>)["id"] === "string" &&
      typeof (item as Record<string, unknown>)["fingerprint"] === "string"
  );
}

export class PostgresMistakeLedgerStore implements MistakeLedgerStoreLike {
  private readonly client: SqlClient;
  constructor(client: SqlClient) {
    this.client = client;
  }

  async appendMistakeOccurrences(
    projectId: string,
    incoming: readonly MistakeOccurrenceRecord[]
  ): Promise<void> {
    if (incoming.length === 0) {
      return;
    }

    // Load existing productState; create a minimal stub if missing.
    const result = await this.client.query<ProductStateRow>(
      `select product_state from project_runtime_state where project_id = $1`,
      [projectId]
    );

    if (result.rows[0] === undefined) {
      console.warn(
        `[postgres-mistake-ledger] appendMistakeOccurrences: no project_runtime_state row ` +
          `found for project_id="${projectId}". Occurrences will be lost (row must exist before capture). ` +
          `Ensure the project runtime is initialised before recording reviews.`
      );
      return;
    }

    const existing = result.rows[0].product_state;
    const prior = parseMistakeOccurrences(existing);

    // Idempotent merge by id (later wins)
    const byId = new Map<string, MistakeOccurrenceRecord>(prior.map((r) => [r.id, r]));
    for (const occ of incoming) {
      byId.set(occ.id, occ);
    }

    const updated = { ...existing, [PRODUCT_STATE_KEY]: [...byId.values()] };

    await this.client.query(
      `update project_runtime_state
         set product_state = $2::jsonb,
             updated_at = now()
       where project_id = $1`,
      [projectId, JSON.stringify(updated)]
    );
  }

  async listMistakeOccurrences(projectId: string): Promise<readonly MistakeOccurrenceRecord[]> {
    const result = await this.client.query<ProductStateRow>(
      `select product_state from project_runtime_state where project_id = $1`,
      [projectId]
    );

    const productState = result.rows[0]?.product_state ?? {};
    return parseMistakeOccurrences(productState);
  }

  /**
   * Append (or upsert by id) an anti_pattern MemoryEntryRecord to memory_entries.
   *
   * Uses INSERT ... ON CONFLICT DO UPDATE to ensure idempotency by entry id.
   * This is the P3 path for storing promoted anti-pattern entries with locus
   * metadata (tags containing "locus:<symbolLocus>") for subsequent injection.
   */
  async appendAntiPatternEntry(
    projectId: string,
    entry: MemoryEntryRecord
  ): Promise<void> {
    await this.client.query(
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
        projectId,
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

  /**
   * Return anti_pattern memory entries for the given project.
   *
   * Uses the indexed path: WHERE project_id = $1 AND entry_type = 'anti_pattern'
   * (index created in migration 026 on (project_id, entry_type)).
   *
   * Locus matching (symbolLocus vs locusGlobs) is applied in-memory after
   * the indexed lookup, since the anti-pattern count per project is small
   * (distilled from occurrences, not raw data).
   *
   * When locusGlobs is empty, all anti-patterns for the project are returned.
   */
  async listAntiPatternsForLocus(
    projectId: string,
    locusGlobs: readonly string[]
  ): Promise<readonly MemoryEntryRecord[]> {
    const result = await this.client.query<JsonRow<MemoryEntryRecord>>(
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
       where project_id = $1
         and entry_type = 'anti_pattern'
         and status = 'approved'
       order by created_at asc`,
      [projectId]
    );

    const allEntries = result.rows.map((row) => row.payload);

    if (locusGlobs.length === 0) {
      return allEntries;
    }

    // In-memory locus filtering (O(anti-patterns), acceptable: count is small)
    return allEntries.filter((entry) => {
      const tags = (entry.metadata as RetrievalMetadata).tags ?? [];
      const locusTag = tags.find((t: string) => t.startsWith("locus:"));
      const symbolLocus = locusTag ? (locusTag as string).slice("locus:".length) : undefined;
      return locusMatchesGlob(symbolLocus, locusGlobs);
    });
  }
}
