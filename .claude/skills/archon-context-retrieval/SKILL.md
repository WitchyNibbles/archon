---
name: archon-context-retrieval
description: Assemble retrieval context for agents from the correct authority layer within a token budget.
---

# Archon Context Retrieval

Use before handing off to a specialist agent when the task requires project memory, runtime records, or vault knowledge.

Goal: give the agent the right context — not all context.

## Authority hierarchy

1. `.archon/memory/` — reviewed durable facts (highest)
2. Postgres runtime — `npx tsx src/admin.ts status` for task/run/review records
3. Obsidian docs-export vault — exported summaries and decision logs written by
   `npx tsx src/export.ts` (`src/docs-export/`); read-only advisory, if configured
4. Postgres semantic memory search — embeddings-backed advisory retrieval via
   `npx tsx src/admin.ts plan-context` (index/refresh with `index-repo-markdown`
   and `refresh-retrieval`), backed by `src/store/postgres-memory-search.ts` and
   `src/memory.ts`. (Replaces the removed Qdrant index — migration
   `014_drop_qdrant_columns.sql` dropped Qdrant.)
5. Repo grep / filesystem scan (lowest)

## Retrieval steps

1. State the question the agent needs answered.
2. Identify the lowest authority layer that CAN answer it.
3. Start at the highest authority layer that is relevant.
4. Scan in descending order; stop when the question is answered with sufficient confidence.
5. If lower-authority results contradict higher-authority results, surface the conflict — do not silently promote.
6. Trim to the token budget before returning: cut filler, keep decision signal.

## Token budget defaults

- Handoff context: 500–800 tokens
- Review gate context: 300–500 tokens
- Full planning context: 1000–2000 tokens
- Never exceed 3000 tokens without explicit override

## Staleness check

Before passing a memory entry or Obsidian note as context:
- Check if it references a task ID that is no longer active
- Check the date; entries older than 30 days that assert "current state" should be flagged stale
- If stale or ambiguous, include it but mark it: `(stale — verify before acting)`

## Output

Return a ranked context block:
```
[source: .archon/memory/agent-workflow-system.md | auth: canonical | conf: high]
<excerpt>

[source: Obsidian/decision_log/2026-05-12-auth-rewrite.md | auth: vault | conf: med]
<excerpt>
```
