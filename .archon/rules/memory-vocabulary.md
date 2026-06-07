# Memory Vocabulary Standards

Archon uses lexical (keyword-based) search over memory entries. Because there is no semantic embedding, retrieval quality depends entirely on consistent, specific vocabulary. These rules make keyword matching effective without requiring semantic recall.

## Required field labels

Every memory entry must include at least these labels where applicable:

| Label | Use for |
|---|---|
| `role:` | The agent role that owns this fact |
| `domain:` | The functional area: `workflow`, `frontend`, `infra`, `retrieval`, `review`, `security`, `testing`, `planning`, `runtime`, `install` |
| `scope:` | File, module, or component the fact applies to |
| `status:` | `active`, `deprecated`, `experimental`, `blocked` |
| `decision:` | A recorded architectural or policy decision |
| `constraint:` | A hard rule that must not be violated |
| `pattern:` | A preferred implementation pattern |

## Canonical terms — always use these exact words

Avoid synonyms. Pick the canonical term and use it everywhere:

| Concept | Canonical term | Do NOT use |
|---|---|---|
| Workflow state machine | `workflow` | process, pipeline, flow |
| Runtime database | `postgres` | db, database, pg, psql |
| Vector search | `pgvector` | vector-search, embedding-search |
| Task queue | `task-queue` | job-queue, work-queue |
| Review gate | `review-gate` | approval, gate, sign-off |
| Skill file | `skill` | command, plugin, slash-command |
| Agent role | `agent` | bot, worker, assistant |
| Durable memory | `durable-memory` | long-term memory, persistent memory |
| Runtime state | `runtime` | live state, current state |
| Embedding job | `embedding-job` | vector job, indexing job |
| Audit trail | `audit-trail` | logs, history, trace |
| Workspace identifier | `workspace-slug` | workspace-id, tenant |
| Project identifier | `project-slug` | project-id, repo-id |

## Anti-patterns

- Vague language: "handles stuff", "manages things", "deals with X"
- Synonyms without standards: using "gate" in one entry and "approval" in another for the same concept
- Missing domain label: entries without a `domain:` field are unsearchable by area
- Prose-only entries: every entry must have at least one structured label line

## Example — correct entry

```
role: memory-curator
domain: retrieval
scope: postgres-store.ts
status: active
decision: pgvector is the sole vector search path; Qdrant removed
constraint: all artifact embedding results come from pgvector cosine search only
pattern: use keyword-rich titles with domain: and scope: for reliable recall
```

## Example — wrong entry

```
The database has been updated to not use Qdrant anymore. We decided this
because it was redundant with what Postgres already does.
```
