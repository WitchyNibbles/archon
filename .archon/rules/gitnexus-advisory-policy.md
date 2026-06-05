# GitNexus Advisory Policy

GitNexus is an optional repo-intelligence tool for `archon`. It is not workflow authority.

## Required rules

- treat GitNexus output as advisory evidence only
- keep task state, review trust, approvals, waivers, and completion authority inside `archon`
- re-anchor important GitNexus findings in canonical repo files before using them for planning, implementation, or review
- surface GitNexus freshness and readiness in operator status when available
- degrade gracefully when GitNexus is missing, stale, or invalid
- prefer `npx gitnexus analyze --skip-claude-md` so GitNexus refreshes repo intelligence without rewriting managed context files

## Prohibited patterns

- satisfying review, QA, or security gates from GitNexus output alone
- auto-installing or auto-running GitNexus as part of `archon` install or runtime
- allowing GitNexus to overwrite `.archon/`, `.claude/`, `CLAUDE.md`, or `.claude/skills/archon-*` by default
- treating GitNexus freshness as workflow freshness authority
- blocking core `archon` workflow just because GitNexus is absent

## Recommended uses

- unfamiliar code exploration
- blast-radius checks before refactors
- process or call-flow tracing
- multi-repo dependency investigation when groups are intentionally configured
- targeted regression and review evidence
