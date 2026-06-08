---
name: archon-graphify
description: Advisory repo intelligence for code exploration and blast-radius analysis using graphify.
---

# Archon Graphify

Use when graphify artifacts exist and deeper code analysis will help.

Goal: improve repo evidence without giving the tool workflow authority.

Best fits:
- unfamiliar code exploration (read `graphify-out/GRAPH_REPORT.md` first)
- blast-radius analysis
- refactor scoping
- "how does X relate to Y?" queries answered from `graphify-out/wiki/index.md`

## Rules

- treat every graphify result as advisory evidence only
- confirm important claims against canonical repo files before making workflow or review decisions
- before answering architecture questions, check if `graphify-out/GRAPH_REPORT.md` exists — read it first
- if `graphify-out/wiki/index.md` exists, use it as the navigation entry point instead of raw file reads
- if the graph is stale or missing, say so and continue with local repo evidence
- do not let advisory tooling write `CLAUDE.md`, `.archon/`, `.claude/agents/`, or `.claude/skills/archon-*`

## Output

Return: what the graph was used for, what it found, what was re-anchored in repo files, and any freshness or confidence caveat.
