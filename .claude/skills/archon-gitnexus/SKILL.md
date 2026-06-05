---
name: archon-gitnexus
description: Advisory repo intelligence for code exploration and blast-radius analysis.
---

# Archon GitNexus

Use only when a repo intelligence tool is available and deeper code analysis will help.

Goal: improve repo evidence without giving the tool workflow authority.

Best fits:
- unfamiliar code exploration
- blast-radius analysis
- refactor scoping
- process tracing for debugging or review

## Rules

- treat every repo intelligence result as advisory evidence only
- confirm important claims against canonical repo files before making workflow or review decisions
- if the tool reports stale or missing index state, say so and continue with local repo evidence
- do not let advisory tooling write `CLAUDE.md`, `.archon/`, `.claude/agents/`, or `.claude/skills/archon-*`

## Output

Return: what the tool was used for, what it found, what was re-anchored in repo files, and any freshness or confidence caveat.
