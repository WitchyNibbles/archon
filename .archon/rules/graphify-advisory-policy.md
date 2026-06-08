# Graphify Advisory Policy

Graphify is the default repo-intelligence tool for `archon`. It is not workflow authority.

## Required rules

- treat graphify output as advisory evidence only
- keep task state, review trust, approvals, waivers, and completion authority inside `archon`
- re-anchor important graphify findings in canonical repo files before using them for planning, implementation, or review
- surface graphify freshness and readiness in operator status when available
- degrade gracefully when graphify is missing, stale, or the binary is absent
- prefer `npm run archon:graphify:update` so graphify refreshes repo intelligence incrementally without LLM cost

## Prohibited patterns

- satisfying review, QA, or security gates from graphify output alone
- allowing graphify to overwrite `.archon/`, `.claude/`, `CLAUDE.md`, or `.claude/skills/archon-*` by default
- treating graphify graph freshness as workflow freshness authority
- blocking core `archon` workflow just because graphify is absent or stale

## Recommended uses

- unfamiliar code exploration via `graphify-out/GRAPH_REPORT.md`
- blast-radius checks before refactors
- "how does X relate to Y?" questions answered from the wiki at `graphify-out/wiki/index.md`
- context packages for planning or architecture passes
- multi-module dependency investigation
