# Archon — Token Usage, Store Redundancy & Improvement Analysis

*Based on a shallow clone of `WitchyNibbles/archon@master`. Caveats: this reflects the
committed package, not a live deployment. I could not see the contents of the external
`everything-claude-code` plugin, your actual `.env.archon` overrides, or runtime behaviour.*

---

## 1. Headline findings

1. **Qdrant duplicates pgvector.** Artifact embeddings are written to *both* Postgres
   (`artifacts.embedding`, a `pgvector` column) and Qdrant, and `searchMemory` queries
   *both* and merges the results. Qdrant is a strict subset of what pgvector already does.
2. **The default embeddings are not semantic.** The default model is
   `archon-local-hash-1536` — an FNV-1a token hash. Cosine over those vectors ≈ keyword
   overlap. So the whole vector stack (pgvector *and* Qdrant) is, by default, an expensive
   approximation of lexical search.
3. **Obsidian is a view layer, not a store** — so it isn't redundant in the storage sense,
   but it is a *third representation* of the same content (Postgres → `.archon/memory/*.md`
   → Obsidian vault), which is a drift/sync surface.
4. **The skill library has overlapping families** (archon-* vs superpowers-* vs
   verification-loop) and a heavy frontend cluster, inflating both context size and routing
   ambiguity.
5. **30+ `everything-claude-code:*` skills are referenced but not vendored** in the repo — a
   hidden external dependency or dangling references.

---

## 2. Store redundancy (Postgres / Qdrant / Obsidian)

### 2.1 The core duplication: pgvector ⟷ Qdrant

Evidence:

- `src/store/postgres-memory-search.ts` runs pgvector cosine search over **both**
  `memory_entries` and `artifacts` (`m.embedding <=> $4::vector`, `a.embedding <=> $3::vector`).
- `src/store/postgres-embedding-jobs.ts:363` *also* upserts every artifact vector into
  Qdrant (`upsertArtifactPoint`) when an embedding job completes.
- `src/store/postgres-store.ts:1109-1175` (`searchMemory`) runs the pgvector search to get
  `baseResults`, **then separately** calls `queryArtifactMatches` against Qdrant, hydrates
  those rows, and merges them back into the same result set.

Net effect for artifacts: **same vectors stored twice, searched twice, merged once.** Qdrant
adds no retrieval capability that pgvector isn't already providing — it adds a second Docker
service to run, secure, back up, and keep in sync, plus a second network round-trip on every
memory query.

| Concern | Postgres (pgvector) | Qdrant |
|---|---|---|
| memory_entries vectors | ✅ stored + searched | ❌ not used |
| artifact vectors | ✅ stored + searched | ✅ stored + searched (duplicate) |
| workflow_documents | ✅ (text scoring) | ❌ |
| operational cost | already required for state | **extra service, only for a subset** |

### 2.2 Why this matters even more at your scale

Archon's vector corpus is *curated, reviewed project memory* — thousands of entries at most,
not millions. Qdrant's strengths (sharding, billions of vectors, HNSW at scale) are
irrelevant here, while pgvector comfortably covers this range and is already a hard
dependency for workflow state. (This is also why the earlier **turbovec** idea would be a
mistake — it would be a *fourth* vector path; the right direction is to collapse to one.)

### 2.3 Obsidian

`src/docs-export/*` shows Obsidian is an **export target**: daily summaries, decision logs,
and worklogs rendered to markdown in a vault (`buildObsidianTargetPath`, `ObsidianVaultWriter`,
wikilink injection), plus an Obsidian MCP (`mcpvault`) to read the vault back. It is *derived
output*, not a primary store, so it is not storage-redundant.

The soft redundancy is **content representation**: the same facts can exist as
(a) Postgres `workflow_documents` / `memory_entries`, (b) git-reviewed `.archon/memory/*.md`,
and (c) Obsidian notes. Each has a legitimate distinct consumer (queryable runtime / canonical
reviewed source / human browsing), but three surfaces for overlapping content invites drift.

---

## 3. Token usage

Rough footprint of context-loaded markdown (chars ÷ 4):

| Asset | Approx tokens | Load pattern |
|---|---|---|
| `CLAUDE.md` | ~2,350 | **always in context** |
| `.claude/agents/` (30) | ~14,600 total | one AGENT.md per delegated subagent |
| `.claude/skills/` (46) | ~26,600 total | descriptions surfaced for routing; full body on invoke |
| `.archon/rules/` (14) | ~9,600 | pulled in when referenced from CLAUDE.md |

Per delegated task you can easily load CLAUDE.md + 1–2 rules + 1 agent + 1–3 skills =
**~5–10K tokens of framework overhead before any real work context.**

### Token hot-spots

- **Frontend skill cluster is huge and overlapping:** `archon-ui-patterns` (~2,260 words),
  `archon-visual-standards` (~1,180), `archon-frontend-taste` (~950), `archon-design-system`
  (~820) — ~5,200 words / ~7K tokens covering closely related ground (UI patterns, tokens,
  taste, design system). On a non-UI project these load for no benefit.
- **Overlapping skill families** create a routing tax (two skills for one job → both sit in
  discovery context, the model burns reasoning choosing, guidance can conflict):
  - `archon-tdd` ⟷ `superpowers-test-driven-development`
  - `archon-debugging` ⟷ `superpowers-systematic-debugging`
  - `archon-qa-verification` ⟷ `verification-loop` ⟷ `superpowers-verification-before-completion`
  - `archon-planning` ⟷ `superpowers-writing-plans`
  - `archon-git-operator` ⟷ `superpowers-using-git-worktrees` / `superpowers-finishing-development-branch`
- **CLAUDE.md restates routing** that also lives in skill descriptions. The ~25-line
  "Recurring control-layer routing" trigger table duplicates what skill frontmatter triggers
  should encode.
- **`caveman` is a good lever already present** (compress internal handoffs/gate notes to
  4–6 lines). Minor: its description still references **"Codex"** — a leftover from the
  devgod→archon port that was never re-worded for Claude Code.

---

## 4. Recommendations

### Storage (highest impact)

1. **Drop Qdrant; standardise on pgvector.** Remove `upsertArtifactPoint` from the embedding
   job, delete the Qdrant branch in `searchMemory`, and drop the Qdrant Docker service + env
   block. This removes a service, a sync path, and a per-query round-trip with zero loss of
   retrieval quality at your scale. Revisit Qdrant only if you later adopt real embeddings
   *and* the corpus grows past pgvector's comfort zone (~hundreds of thousands+).
2. **Make embeddings earn their keep or drop them.** `archon-local-hash-1536` is lexical in
   disguise. Either (a) swap in a real local embedding model (e.g. `bge-m3` / a small
   sentence-transformer via Ollama) so semantic search is actually semantic, or (b) replace
   the vector path entirely with Postgres full-text search (`tsvector`), which is honest
   about being lexical, needs no embedding jobs, and is far cheaper. Pick based on whether
   you need semantic recall.
3. **Treat Obsidian as strictly derived.** One canonical source per content type
   (`.archon/memory/` for durable reviewed facts; Postgres for runtime state); regenerate the
   Obsidian vault read-only from it. Avoid edit-in-Obsidian-then-sync-back loops.

### Token

4. **Consolidate the frontend skills** into one `archon-frontend` skill with a thin SKILL.md
   that points to detail files the agent reads on demand, and gate the cluster behind a
   "this project has a UI" check so backend/infra projects don't pay ~7K tokens.
5. **De-duplicate skill families:** keep either the `archon-*` or the `superpowers-*` variant
   per concern and delete/alias the other. One skill per job.
6. **Slim CLAUDE.md:** keep the workflow contract + manager kernel + gate rules; move the
   routing trigger table into skill frontmatter so it isn't restated in always-on context.
7. **Resolve the `everything-claude-code:*` references** (20+ across agents, none in-repo):
   either vendor the plugin, declare it as an explicit install dependency, or remove the
   refs. Right now they're an invisible context surface / potential dangling lookups.
8. **Keep `caveman`, fix the wording** ("Codex" → Claude Code), and use your existing
   `archon-skill-evals` / eval harness to confirm it nets savings without degrading reasoning
   on hard tasks.

### Quick wins vs larger bets

- **Quick (low risk):** fix caveman wording; resolve plugin refs; merge duplicate skill
  families; trim CLAUDE.md routing block.
- **Medium:** consolidate + gate the frontend skill cluster.
- **Larger bet (biggest payoff):** remove Qdrant and decide embeddings vs full-text — this
  simplifies the hot path, the Docker stack, the env surface, and the install/verify code all
  at once.

---

## 5. One-line summary

The single most valuable change is **collapsing three vector representations
(pgvector + Qdrant, fed by hash "embeddings") down to one honest retrieval path**, and the
second is **trimming the skill library's overlap and frontend weight** — together they cut
operational complexity and per-task token overhead without losing any real capability.
