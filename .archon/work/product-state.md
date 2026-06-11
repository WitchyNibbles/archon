# Product State

> Maintained by archon planner after each completed task.

## Current phase

Archon remediation initiative (9 phases, from the Fable 5 audit) — **complete**.
All nine phases are approved in the runtime with orchestrator-written reviews
and pass `workflow-proof` with `runtime_authoritative` authority. Brief:
`.archon/work/briefs/brief-archon-remediation.md`.

## Active run

`d216a303-74d8-4a4d-8bd4-c1f23ff57b17` (runtime authoritative). All nine
remediation tasks are approved; no task is currently claimed. The earlier
seeded run `1443ac90` is superseded history — `workflow-proof --run-id latest`
resolves every phase to `d216a303`.

## Phase status

- [x] p1 — Seal backdoors (done; commits c4a81d4, 5aef0c6; orchestrator
      reviews recorded in run d216a303, replacing the rejected seeded proof)
- [x] p2 — Real review gate pipeline (done; commits 4858a01, 2e1710d, e28ce8d)
- [x] p3 — Fix the daemon (done; commit 312d3c2)
- [x] p4 — Fix model routing (done; commit a201656)
- [x] p5 — Real embeddings: Anthropic/Voyage API + ingestion pipeline (done; commit 581fc9d)
- [x] p6 — Grafana MCP tool (done; commit eb8e4da)
- [x] p7 — Obsidian export (done; commits 23e6cdd, 65b025e; heading-regex
      guard fixed in b7a8881)
- [x] p8 — Cut the bloat (done)
  - `buildDaemonCliOutputSchema`/`buildCliSchedulerPrompt` deleted (e965751)
  - `seed-modernization-proof` command, `coverage-ledger.ts` parity matrix,
    and Codex naming debt removed (c51f507)
  - `check-archon-workflow.sh` replaced with TypeScript wrapper (525adf6)
  - `src/admin.ts` split into six domain modules — 11,616 → 338 lines, public
    import surface unchanged via re-exports (0f5260c)
- [x] p9 — Trust model honesty (done)
  - `runtime_orchestrated_only` rename and trust-language cleanup (312d3c2)
  - P9-T2: identity theater deleted — `identity_assurance`/`waiver_authority`
    columns, waiver types, and migrations 005/006/007/015 removed; forward
    migration 019 backfills `source` and drops the legacy columns (cbf232c)

## Verification

- `npm test`: 395/395 pass
- `npx tsc --noEmit`: clean
- `workflow-proof --run-id latest` for p1–p9: all `runtime_authoritative`,
  task status `approved`, reviews and approvals orchestrator-written
- runtime/local state integrity: `consistent` (`admin.ts status`)

## Open risks

- None blocking. Remediation initiative is closed.
- Follow-up (non-blocking): `src/daemon.ts` (5,500 lines), `src/workflow.ts`
  (2,222), and `src/runtime.ts` (2,189) exceed the repo 800-line file guidance
  and are candidates for further decomposition in a future hygiene pass.
- Follow-up (non-blocking): `npm run check:workflow` local advisory check
  expects an `AGENTS.md` file that does not exist in this repo; the runtime
  `workflow-proof` completion authority is unaffected.
