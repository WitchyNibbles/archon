# Project Profile

Stable, high-signal facts about what `archon` is. Update only when a purpose- or
stack-level fact changes; mark superseded lines rather than deleting history silently.

## What archon is

```
role: solution-architect
domain: workflow
scope: repo-root, CLAUDE.md ("Archon Operating Rules")
status: active
decision: archon is the shared-package source of truth for a reusable autonomous engineering runtime — installer, rules, templates, skills, agent profiles
constraint: this repo owns reusable package assets only; consuming repos own live .archon/work/ state, env files, and repo overlays
pattern: ship as an opt-in overlay a consuming repo installs, not a standalone app
source: CLAUDE.md § "Archon Operating Rules" (repo root) — the identity statement this entry restates
```

## Users

```
role: product-strategist
domain: workflow
scope: consuming-repos, CLAUDE.md ("Default mode" / manager kernel)
status: active
decision: primary users are consuming repos that install archon to run a Claude-Code-native autonomous engineering team
constraint: package assets stay generic and reusable; never absorb project-specific live state into the package
source: CLAUDE.md §§ "Default mode" and "Manager kernel" — repo-root operating rules defining who archon serves and how it is consumed
```

## Stack

```
role: solution-architect
domain: runtime
scope: package.json, src/, .archon/work/audit-2026-07-debt/ecosystem-recommendations.md
status: active
decision: TypeScript + Node 22 ESM; workflow-runtime is postgres; retrieval is pgvector; tool surface is MCP servers (@modelcontextprotocol/sdk); orchestration is Claude-Code-native (hooks, agents, skills)
constraint: Claude-Code-native architecture — no external orchestrator wrapper (validated by 2026-04-04 Anthropic third-party-framework policy)
pattern: distributed as dist-only scoped npm package @witchynibbles/archon with a bin entrypoint
source: .archon/work/audit-2026-07-debt/ecosystem-recommendations.md (cites the 2026-04-04 Anthropic third-party-framework policy validating the Claude-Code-native architecture, no external orchestrator wrapper); install-overhaul PRs #141-#151 (merged as v0.2.0) for the dist-only scoped-npm-package + bin-entrypoint facts
```

## Non-negotiable constraints

```
role: reviewer
domain: review
scope: CLAUDE.md ("Operating character", "Gate rules"), .archon/rules/review-gate-policy.md
status: active
constraint: review_authority=runtime_orchestrated_only and review_artifact_trust=runtime_records_only — a connected runtime trusts only orchestrator-written DB review rows; self-written markdown never satisfies the gate
constraint: runtime workflow-proof is the completion authority; exported markdown is evidence only
constraint: never store secrets, tokens, or artifact payloads in durable-memory
source: CLAUDE.md §§ "Operating character" and "Gate rules" (repo root) — these sections are the source of these constraints, not a downstream restatement
```
