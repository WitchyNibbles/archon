---
name: graphify
description: Build a persistent knowledge graph from the archon vault or codebase using graphify. Enables Claude and users to query project structure, decisions, and relationships without re-reading files every session.
origin: https://github.com/safishamsi/graphify
---

# Graphify

Use to turn the archon project or Obsidian vault into a queryable knowledge graph. Graphify outputs: interactive HTML, GraphRAG-ready JSON, GRAPH_REPORT.md, and an agent-crawlable wiki.

## When to invoke

- First session on a new or cloned repo (build the graph once, query forever)
- After a major refactor that adds or removes modules
- When answering "how does X relate to Y?" questions on the codebase
- When preparing a context package for a planning or architecture pass

## Install

```bash
# requires Python 3.10+
pip install graphifyy
# or with uv (preferred)
uv tool install graphifyy
```

## Core commands

```bash
# Build full graph on current project
graphify .

# Build and write to Obsidian vault (combines with archon export)
graphify . --obsidian --obsidian-dir "$ARCHON_OBSIDIAN_VAULT_PATH/graph"

# Incremental update after code changes (no LLM cost)
graphify . --update

# Build agent-crawlable wiki (best for Claude context)
graphify . --wiki

# Query the graph (no rebuild)
graphify query "How does the workflow proof system work?"
graphify path "ObsidianWriter" "ArchonStore"
graphify explain "agent-catalog"
```

## Rules

- Before answering architecture or codebase questions, check if `graphify-out/GRAPH_REPORT.md` exists — read it first
- If `graphify-out/wiki/index.md` exists, use it as the navigation entry point instead of raw file reads
- After modifying TypeScript files, run `graphify . --update` to keep the graph current (AST-only, no API cost)
- Write the graph output to `graphify-out/` at project root — never to `.archon/`
- The Obsidian vault output path is `$ARCHON_OBSIDIAN_VAULT_PATH/graph/` when vault is configured

## Obsidian integration

When the Obsidian vault is configured (`ARCHON_OBSIDIAN_VAULT_PATH`), graphify writes a self-contained knowledge graph section to the vault that Obsidian's Graph View can render. This is separate from the archon worklog export — graphify handles the CODE brain, archon export handles the WORK brain.

## Output

Return: graph location, node count, community count, top god nodes, and the query to verify it works.
