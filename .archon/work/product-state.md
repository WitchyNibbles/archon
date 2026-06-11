# Product State

> Maintained by archon planner after each completed task.

## Current phase

Archon remediation initiative (9 phases, from the Fable 5 audit). Phases p1–p7
landed and verified; p8 and p9 are in progress. Brief:
`.archon/work/briefs/brief-archon-remediation.md`.

## Active run

`1443ac90-05f3-411e-ac44-cb7a04a719ac` (runtime authoritative). No task is
currently claimed; next work is the p8/p9 remainders and the review
orchestrator pass for p2–p9.

## Phase status

- [x] p1 — Seal backdoors (done; runtime workflow proof seeded)
- [x] p2 — Real review gate pipeline (done; commit e28ce8d)
- [x] p3 — Fix the daemon (done; commit 312d3c2)
- [x] p4 — Fix model routing (done)
- [x] p5 — Real embeddings: Anthropic/Voyage API + ingestion pipeline (done; commit 581fc9d)
- [x] p6 — Grafana MCP tool (done)
- [x] p7 — Obsidian export (done; commits 23e6cdd, 65b025e; heading-regex
      guard fixed in b7a8881)
- [ ] p8 — Cut the bloat (in progress)
  - done: `buildDaemonCliOutputSchema`/`buildCliSchedulerPrompt` deleted (e965751)
  - done: `seed-modernization-proof` command, `coverage-ledger.ts` parity
    matrix (863 lines, zero callers), and Codex naming debt
    (`playwrightCodexConfigFragment`/`mergeCodexConfig` aliases,
    `ARCHON_CODEX_*` env names) removed (c51f507)
  - deferred/descoped: splitting `src/admin.ts` into smaller modules
- [ ] p9 — Trust model honesty (in progress)
  - done: `runtime_orchestrated_only` rename and trust-language cleanup (312d3c2)
  - deferred: P9-T2 — waiver/assurance types and migrations 003/006/007/015
    are still present; removal is intentionally deferred until P9-T2 scope is
    clarified (do not delete without explicit scoping)

## Verification

- `npm test`: 394/394 pass (modernization-seed test removed with its feature)
- `npx tsc --noEmit`: clean
- runtime/local state integrity: `consistent` (`admin.ts status`)

## Open risks

- p2–p9 have no runtime review approvals recorded; `workflow-proof` fails for
  them until the review orchestrator runs. p1's seeded reviews are rejected by
  the P9 trust model, so p1's proof also needs re-recording through the
  orchestrator path.
- P9-T2 cleanup (waiver/assurance machinery and related migrations) remains
  open and explicitly deferred.
