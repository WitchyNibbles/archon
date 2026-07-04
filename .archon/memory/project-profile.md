# Project Profile

Stable, high-signal facts about what `archon` is. Update only when a purpose- or
stack-level fact changes; mark superseded lines rather than deleting history silently.

## What archon is

```
role: solution-architect
domain: workflow
scope: repo-root
status: active
decision: archon is the shared-package source of truth for a reusable autonomous engineering runtime — installer, rules, templates, skills, agent profiles
constraint: this repo owns reusable package assets only; consuming repos own live .archon/work/ state, env files, and repo overlays
pattern: ship as an opt-in overlay a consuming repo installs, not a standalone app
```

## Users

```
role: product-strategist
domain: workflow
scope: consuming-repos
status: active
decision: primary users are consuming repos that install archon to run a Claude-Code-native autonomous engineering team
constraint: package assets stay generic and reusable; never absorb project-specific live state into the package
```

## Stack

```
role: solution-architect
domain: runtime
scope: package.json, src/
status: active
decision: TypeScript + Node 22 ESM; workflow-runtime is postgres; retrieval is pgvector; tool surface is MCP servers (@modelcontextprotocol/sdk); orchestration is Claude-Code-native (hooks, agents, skills)
constraint: Claude-Code-native architecture — no external orchestrator wrapper (validated by 2026-04-04 Anthropic third-party-framework policy)
pattern: distributed as dist-only scoped npm package @witchynibbles/archon with a bin entrypoint
```

## Non-negotiable constraints

```
role: reviewer
domain: review
scope: CLAUDE.md, .archon/rules/review-gate-policy.md
status: active
constraint: review_authority=runtime_orchestrated_only and review_artifact_trust=runtime_records_only — a connected runtime trusts only orchestrator-written DB review rows; self-written markdown never satisfies the gate
constraint: runtime workflow-proof is the completion authority; exported markdown is evidence only
constraint: never store secrets, tokens, or artifact payloads in durable-memory
```
