# Product State

> Maintained by archon planner after each completed task.

## Current phase

**Trust-hardening initiative** (trust-first, from the 2026-06-12 owner intent).
Goal: make the completion authority provably trustworthy against careless agents.
Brief: `.archon/work/briefs/brief-archon-trust-hardening.md`.

- Intake found 5 enforcement findings by red-teaming archon's own gates.
- **Careless-class fixes (findings 1, 2, 4, 5) shipped** under task
  `trust-fix-enforcement-gaps` (run `fc5e4ae7`): sanctioned `init-task` cold-start,
  heredoc-stripped managed-path scan, runtime-sourced write scope. Security review
  caught + fixed a HIGH path-traversal. `workflow-proof` runtime_authoritative;
  reviewer/qa/security gates passed. Committed on branch `fix/trust-enforcement-gaps`
  (`059f588`); 413 tests pass, tsc clean.
- **Design & Architecture Council: `approved_with_conditions`**
  (`.archon/work/council/dac-archon-trust-hardening.md`). Sequence = eval-first
  (Path C). Council confirmed two new HIGH gaps to fix next: **#10** forged
  verification-cert via shell chaining, **#14** forged council outcome from
  worker-editable markdown. Plus MEDIUM two-authorities divergence.

## Completed task: trust-redteam-fixes

Run `f1aedfac` — **approved**, `workflow-proof` runtime_authoritative, committed
`23962b0` on branch `fix/trust-enforcement-gaps`. Closed council-confirmed HIGH
gaps **#10** (forged verification-cert via shell chaining — guard covers `|| && ; |`
and newlines, redirect-strip stops at metacharacters) and **#14** (forged council
outcome — now runtime-authoritative via `record-council`, proven live), plus the
MEDIUM **two-authorities** divergence (strictly run-scoped Stop-hook review query,
`saveOrchestratorReview` persists run id). Added the gate-integrity eval suite
(`tests/gate-integrity.test.ts`: RED fixtures, negative twins, mutation canary,
scope label). reviewer + security_reviewer PASSED (security re-review closed 3
follow-on HIGHs in the fix); qa GAP-A resolved. 428 tests pass, tsc clean.

## Next task

`T-trust-boundary-doc` (+ remaining council conditions): ≥1 executed live finding-3
bypass against a disposable run (demonstrated boundary); the scope-from-DB rollback
note; and securing the `councilRequired` flag from the runtime (security follow-on —
#14 secured the outcome but not the gate-trigger flag). Then the comprehensive
red-team wave is the deferred follow-on phase. Not yet started.

## Prior phase (complete)

Archon remediation initiative (9 phases, Fable 5 audit) — complete; run
`d216a303-74d8-4a4d-8bd4-c1f23ff57b17` runtime_authoritative, all nine approved.
Brief: `.archon/work/briefs/brief-archon-remediation.md`.

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
