# Product State

> Maintained by archon planner after each completed task.

## Current phase

Complete — all four audit-completion phases shipped.

## Active run

None.

## Last completed task

`qdrant-full-removal` — dropped qdrant_url and qdrant_collection schema columns
(migration 014), removed qdrant fields from domain types, postgres-store, admin.ts
verifySetup, and mcp/tools.ts description. Migration 013 hotfix preceded this to
unblock bootstrap. Also removed dead serve-ui command and archon:ui script (phase 2),
and fixed CLAUDE.md routing gaps (phase 4).

## Acceptance criteria status

- [x] Managed-path write gate (p1, p2)
- [x] Design and Architecture Council gate (p2-dac)
- [x] Bypass audit log (p5)
- [x] Review gate at Stop (p3)
- [x] Task-packet validation (p4)
- [x] Stop hook hardening (p6)
- [x] Hooks cleanup / heredoc false-positive (p7)
- [x] Runtime health wired into session-start and stop (p8)
- [x] CLAUDE.md workflow-contract comment tags (p9)
- [x] Graphify replaces gitnexus as advisory repo-intelligence layer (p10)
- [x] Hook false-positive on complete-task queue entries (p11)
- [x] Working tree clean: gitignore, product-state, env (cleanup-1)
- [x] Runtime workflow proofs seeded for cleanup-1 and qdrant-cleanup
- [x] Qdrant fully removed from setup scripts, CI, and tests (qdrant-cleanup)
- [x] Residual Qdrant dead code removed from src/ (audit-fixes)

## Open risks

None.
