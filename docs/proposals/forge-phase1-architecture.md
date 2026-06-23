# Frontend Forge — Phase 1 Architecture Proposal

**Status:** DRAFT — INPUT to Design and Architecture Council pre-implementation gate
**Task:** `forgePhase1Council` (run `2a90543b-295e-4ace-ac44-6ab118c072d9`)
**Author role:** `solution_architect`
**Parent decision:** Forge initiative council `APPROVED_WITH_CONDITIONS` (12 conditions). This packet seeks a Phase-1-specific approval for the run-profile, skill-cluster, codegen, and live-data design.
**Reasoning mode:** strict

---

## 0. Overview

Phase 0 shipped a read-only Swimlane Monitor in an isolated `web/` workspace behind a hard R2-C
package boundary (separate `package.json` and lockfile; root runtime deps unchanged at 3 — `@modelcontextprotocol/sdk`, `pg`, `zod`; an eslint import wall in BOTH directions, verified at depths 1 through 6). The dashboard reads a committed
static `web/public/snapshot.json` produced by `src/forge/snapshot.ts`, which derives from the real
`report` surface but falls back to a hand-faithful sample.

Phase 1 turns the Forge from "a dashboard skeleton" into "a frontend-generation capability that runs
on archon's own engine." Six decisions gate that:

1. A `frontend_forge` **run profile** that threads a 15-stage pipeline through the EXISTING
   `ArchonCoreService` run and task graph and the EXISTING reviewer, qa, and security gates — no second gate path,
   no second source of truth.
2. Three **stage skills** (`archon-forge-intent`, `archon-forge-direction`, `archon-forge-assets`) that COMPOSE existing
   frontend skills, and satisfy council conditions number 1 (falsifiable anti-generic critic), number 2 (two-or-more divergent
   directions), number 3 (machine-readable repair diffs).
3. A `forge` **admin subcommand** following the existing admin module-split pattern.
4. **Live pg data** for the dashboard — with an explicit authority decision (`runtime_authoritative` versus
   `derived_only`) and a read-only-preserving transport choice.
5. **Contract codegen** that kills the `web/src/types/dashboard.ts` duplication without breaching R2-C.
6. **Playwright pin plus a non-required `web-e2e.yml` CI**, and a **CSP** decision sequenced with number 4.

### Source-of-truth map (the spine every decision must respect)

| Layer | Authority | Phase-1 rule |
| --- | --- | --- |
| Postgres (`project_runtime_state`, `workflow_documents`, review and approval records) | canonical and runtime-authoritative | only writer is the single core writer; Forge stages write via the SAME path as every other task |
| `src/forge` Zod contracts plus constraints manifest | canonical (derived from repo markdown skills) | one direction only: from `src/forge` into `web` |
| `web/public/snapshot.json` and any future read endpoint | derived_only | a projection of canonical; never a write target; never trusted as authority |
| graphify and retrieval | advisory | discovery only; re-anchor in canonical before handoff |

**The load-bearing invariant for the whole phase:** the Forge adds NO new authority. Every stage is an
ordinary task in an ordinary run, gated by the ordinary `reviewer`, `qa_engineer`, and `security_reviewer`
gates plus `workflow-proof`. The dashboard READS a projection of that authority and never becomes a
second copy of it.

---

## Decision 1 — `frontend_forge` run profile (15-stage pipeline on the core graph)

The 15 stages, in order: intent, taste, directions, tokens, asset-plan, codex-imagegen-coord,
manifest-reconcile, asset-QA, frontend-spec, implement, browser-QA, a11y-perf, visual-critic,
repair, handoff.

### Option A — Profile is a task-graph TEMPLATE expanded at decompose time (RECOMMENDED)

A `frontend_forge` profile is a declarative template (owner role per stage, dependency edges, per-stage
allowed-write-scope globs, required gates). When a Forge run is created, the planner and decompose step
materializes it as ordinary tasks in `project_runtime_state.task_queue` with dependency edges. Stages
become tasks; gates are the existing gates; the visual-critic `rework` outcome is modeled as an ordinary
review-blocked edge into a repair task. The daemon dispatches them like any other run.

- **Trust boundary:** none new. Stages inherit the existing review and identity policy and write-scope
  enforcement. The 15 stages are data, not a new control path.
- **Reversible:** YES (cheap). A profile is a config artifact; deleting it leaves the core graph intact.
- **Satisfies:** the "no second gate path, no second source of truth" constraint directly.

### Option B — A dedicated `ForgePipelineRunner` orchestrator alongside the daemon

A separate runner owns Forge stage sequencing, calling into the core service for persistence.

- **Risk (HIGH):** a second orchestrator is a second source of truth for "what stage are we on." It
  re-introduces exactly the multi-writer and dual-authority anti-pattern archon spent the daemon split and
  remediation initiative removing. Two schedulers will drift.
- **Reversible:** NO (expensive) — once a parallel runner owns state, unwinding it is a migration.

### Option C — Encode all 15 stages as ONE task with internal sub-steps

One `frontend_forge` task; stages run inside a single agent invocation loop.

- **Risk:** collapses gate granularity. The visual-critic `rework` and repair loop cannot be a real
  review-blocked gate if it lives inside one task; conditions number 1 and number 3 become self-attestation, not
  runtime-enforced. Also violates the 15-minute agent-unit decomposition norm.
- **Reversible:** medium, but it buys nothing over A.

### Recommendation: Option A.

Map the 15 stages onto the EXISTING graph primitives:

- **intent, taste, directions, tokens, asset-plan, frontend-spec** become ordinary tasks owned by
  `product_strategist`, `frontend_designer`, or `solution_architect` as fits, gated normally.
- **codex-imagegen-coord, manifest-reconcile, asset-QA** are asset stages. F1 (codex image generation) is a
  Phase-2 entry gate, so in Phase 1 these stages run against the pre-committed fallback asset path
  (see note below) and asset-QA validates the fallback. The stage exists; the live generator does not yet.
- **implement, browser-QA, a11y-perf** become delivery plus `qa_engineer` plus `accessibility-engineer` and
  `performance-engineer` specialist gates (already in the role chain).
- **visual-critic** is a review-style gate that emits a structured verdict (Decision 2). `rework` equals
  review_blocked with a machine-readable diff payload.
- **repair** is a task created from the critic's diff; it consumes the diff, not free-text.
- **handoff** uses the existing handoff record path.

**Phase-1 pre-commit-the-fallback item:** because F1 is gated to Phase 2, Phase 1 MUST commit a static
fallback for every asset the pipeline expects, so the pipeline is runnable end-to-end without a live
image generator (mirrors how `snapshot.ts` commits a fallback today). This keeps Phase 1 demoable and
makes the Phase-2 swap a localized change.

### Risks (Option A)

- **Profile drift versus core graph schema:** if the profile template references stage and gate shapes that the
  core graph later changes, the template silently rots. Mitigation: validate the profile against a Zod
  schema at decompose time; fail loud.
- **Stage explosion:** 15 tasks per run inflates the queue and the dashboard. Mitigation: the swimlane
  view already groups by task; add a stage-phase grouping in the view model (cheap, additive).

**Council condition satisfied:** the parent "no parallel module and compose-on-core" condition, and the
brief's "no second gate path, no second source of truth."

---

## Decision 2 — Stage skills (`archon-forge-intent`, `archon-forge-direction`, `archon-forge-assets`)

These are repo-local `archon-*` workflow skills that COMPOSE existing skills
(`archon-frontend`, `archon-visual-standards`, `archon-design-system`, `archon-ui-patterns`,
`archon-frontend-taste`, `archon-accessibility-gate`). They are prompt and skill assets, not code —
authoring them is out of THIS task's write scope (the control-layer skills dir is forbidden here), so Phase 1 IMPLEMENTATION
of the skills is a separate task packet. This proposal fixes their CONTRACT.

### The falsifiable anti-generic gate (Condition number 1) — the hard architectural call

The brief requires the visual critic to return `rework` on "technically correct but GENERIC," and it must
be FALSIFIABLE — a machine can decide it, not vibes.

**Option A — Pure-skill critic (LLM reads the constraints-manifest, self-reports).** Cheapest, but NOT
falsifiable: a prompt judging itself is not a machine-checkable gate. Fails the spirit of condition number 1.

**Option B — Deterministic constraint-checker over the rendered DOM and computed styles plus an LLM for the
residual taste judgment (RECOMMENDED).** Two-tier:
  - **Tier 1 (deterministic, falsifiable):** a checker reads the rendered page's computed styles
    (Playwright already gives us the DOM plus computed CSS) and evaluates each `AG-NNN` constraint in
    the constraints manifest module (for example, a measured radius exceeding the cap is an `AG-0xx hard_fail`). Output is a
    structured `ConstraintViolation[]` with stable ids. This is the falsifiable core: a hard_fail violation
    deterministically forces `rework`. The manifest already carries a `hard_fail` or `warning` severity and
    stable `AG-NNN` ids for exactly this.
  - **Tier 2 (LLM, advisory):** the critic compares against benchmark refs for the residual is-this-generic
    judgment that no rule fully captures. Tier-2 alone can recommend `rework` but its verdict is
    labeled advisory; only Tier-1 hard_fails are auto-blocking. This keeps the gate honest: the
    machine-checkable part is the authority, the taste part is evidence.

**Option C — LLM critic but REQUIRE it to cite a specific `AG-NNN` id plus a measured value for every
`rework`.** Forces structure without building the deterministic checker. Lighter than B; weaker because
the measurement is still LLM-reported, not tool-measured — falsifiable in FORMAT but not in MEASUREMENT.

### Recommendation: Option B, with Option C as the explicit fallback if the deterministic computed-style extraction proves flaky in Phase 1.

Rationale: the constraints manifest was BUILT for machine citation (`AG-NNN`, `hard_fail`, `warning`).
The deterministic tier is what makes condition number 1 real rather than aspirational. We already have Playwright
in `web/` for computed-style extraction — the marginal cost is a checker module, not new infra.

### Conditions number 2 and number 3

- **number 2 (two-or-more divergent directions plus contrast rationale):** `archon-forge-direction` must emit a structured
  `DirectionSet` with a length of two or more and a `divergenceRationale` plus a per-direction `contrastRationale`
  (re-using the wcag-contrast module). Model this as a Zod-validated artifact (Decision 5 makes it a contract),
  so "two-or-more divergent" is schema-enforced, not prose-enforced. The validation lives in `src/forge` (canonical),
  not the skill.
- **number 3 (repair consumes machine-readable diffs):** the repair task's input is the
  `ConstraintViolation[]` (with `AG-NNN` plus measured-vs-cap values) produced by Decision-2 Tier-1. The
  repair skill is FORBIDDEN from acting on free-text "improve"; its task packet's input artifact is the
  diff. This is enforceable because the diff is a typed contract artifact, not a chat message.

### Risks

- **Deterministic checker false-negatives:** computed-style extraction may miss semantic genericness
  (for example a "generic SaaS layout" that violates no numeric token). Mitigation: the Tier-2 advisory catch plus growing
  the manifest's AG rules over time. Accept that Phase 1 catches numeric and token genericness deterministically
  and layout-genericness advisorily.
- **Skill authoring is a separate scope:** if the council approves but the skill task packet is not cut,
  Phase 1 stalls. Mitigation: the task breakdown (section 8) cuts the skill-authoring task explicitly with
  the control-layer skills write scope.

**Council conditions satisfied:** number 1 (B is falsifiable), number 2 (schema-enforced divergence), number 3 (typed diff).

---

## Decision 3 — `forge` admin subcommand

Follow the established `src/admin.ts` thin-dispatch plus the per-domain admin module pattern (the same
shape as the existing init-task, record-council, and report admin modules).

### Option A — Single `src/admin/forge` module exporting `forgeCommand(args, deps)` with sub-verbs (RECOMMENDED)

Use `npx tsx src/admin.ts forge <subverb>` where subverbs are for example
`snapshot` (regenerate the dashboard projection), `run` (create a `frontend_forge` run via the profile),
and `critic` (run the deterministic Tier-1 checker against a rendered target and print `ConstraintViolation[]`).
Heavy dependencies (store, withClient) are injected via a `deps` object exactly like the init-task and record-council
modules do today, for testability.

- **Reversible:** YES (cheap) — additive command, isolated module.
- **Fits repo reality:** mirrors the daemon-split lesson (module fn returning a result, inject heavy deps).

### Option B — Multiple top-level commands (`forge-snapshot`, `forge-run`, and so on)

This pollutes the flat command switch in `admin.ts`. The repo is actively CONSOLIDATING toward sub-verb modules.
Not recommended.

### Risks

- **Scope creep into a write path:** a `forge run` subverb DOES create runs (a write), but it writes through
  the SAME core writer as any run creation — no new authority. Keep `forge snapshot` strictly read-only.
- Keep the `src/admin/forge` module under the 800-line cap; split sub-verbs into a `src/admin/forge` subdir if it grows.

---

## Decision 4 — Wire dashboard to LIVE pg data (authority plus transport)

This is the decision with the most security and reversibility weight.

### Authority model — DECIDED: derived_only

The dashboard read is a PROJECTION of canonical runtime state. It is NOT itself authoritative; the
`authorityLabel` in the view model already encodes this and the dashboard MUST surface `derived_only`
when it reads a projection rather than a live runtime-proof. Runtime (postgres plus workflow-proof) remains
the completion authority. This matches the source-of-truth map and the repo's rule that derived retrieval is never
durable authority. The existing `report` surface already distinguishes
`runtime_authoritative` versus `derived_only` per timeline entry — Phase 1 reuses that labeling rather than
inventing a new one.

### Transport — the real choice

**Option A — Keep the generated static `snapshot.json`, refresh on demand (RECOMMENDED for Phase 1).**
The `forge snapshot` sub-verb queries the read-only report and status surface through the existing `ArchonStore`
interface (Condition number 11: no raw SQL in the forge module), validates through the dashboard view-model schema, and
writes `web/public/snapshot.json` (or a gitignored live variant). No HTTP server, no new listening port,
no new attack surface, no auth surface. The dashboard stays read-only BY CONSTRUCTION — there is literally
no endpoint that can mutate.

- **Reversible:** YES (cheap). It is the Phase-0 mechanism, just with the live query body filled in.
- **Live-ness tradeoff:** stale until refreshed. Acceptable for a single-operator monitor; a
  `forge snapshot --watch` poller can refresh on an interval if needed (still no inbound server).

**Option B — A thin read-only HTTP endpoint (GET-only) in the forge module.**
A tiny server exposing a GET dashboard route returning the validated view model.

- **Pros:** real-time, no manual refresh.
- **Risks (the reason to defer):** introduces a listening socket, which is a new attack surface that pulls in the
  CSP and connect-src decision, CORS, rate-limiting, and a transport dependency. The root has 3 runtime deps
  and adding an HTTP framework risks R2-C and dep-count pressure. A GET-only server is still a server that
  must be hardened pre-auth and pre-live-data (the same MEDIUM the CSP item flags). Per the brief, weigh it
  — the weight says defer to Phase 2 unless the council finds the manual-refresh UX unacceptable.

### Recommendation: Option A for Phase 1 (live query into the static-snapshot generator), with Option B explicitly scoped as a Phase-2 candidate gated on a real-time requirement plus a security review of the listener.

### Risks

- **Real run IDs in a committed snapshot:** committing `snapshot.json` from a live run leaks run identifiers
  into git. Mitigation: live output goes to a gitignored live variant; only the sanitized sample is
  committed (the generator already documents this split).
- **Read surface accidentally exposing secrets:** the report and status projection must be field-allowlisted
  to the view-model contract — never spread raw rows. The schema parse call already acts
  as the allowlist (it strips unknown fields). Keep it strict or use explicit field mapping so a future column
  addition cannot leak.

**Council conditions satisfied:** number 1 read-only surface, number 11 ArchonStore-only with no raw SQL, number 7 and number 9 (no secrets, no stack traces).

---

## Decision 5 — Contract codegen (kill the dashboard type duplication)

The drift risk: the web-side dashboard type file is hand-kept in sync with the forge-side dashboard contract.
R2-C forbids `web` importing the core (verified, depths 1 through 6), and importing the Zod module would pull the
zod runtime into the web bundle. So we cannot just import.

### Option A — Codegen TS types from the Zod contract into `web` at build time
A generator (run from the root toolchain) emits a generated web type file from
the dashboard view-model schema (for example via a zod-to-ts style extraction or a small bespoke emitter). Web imports
the generated file.

- **Risk:** adds a codegen dependency or step; generated-file freshness must be CI-checked or it drifts
  exactly like the hand-written file. Tooling for zod-to-ts is third-party and version-sensitive.

### Option B — Publish the forge contract as a tiny shared package web imports
A real `@archon/forge-contract` package (types-only, no zod runtime export) consumed via web's
`package.json`.

- **Risk:** a published package is a versioning and release surface; for an in-repo single consumer it is
  heavyweight, and it complicates the npm-pack exclusion story. Expensive and premature.

### Option C — Generate-and-commit a generated file with a CI drift check (RECOMMENDED)
A root-side script derives the TS types from the canonical Zod contract and writes a COMMITTED
generated web type file. A CI check (in the existing root lint and test, NOT web-e2e) re-runs
the generator and fails if the committed output differs. The generator is the
single source of the projection; the committed file is convenience plus reviewability; the drift check makes
the sync MACHINE-ENFORCED instead of human-promised.

- **Reversible:** YES (cheap). The generated file is a derived artifact.
- **R2-C-safe:** the generator runs in the ROOT toolchain (which may read the core) and EMITS a file under
  the web source tree; `web` still never imports the core. The one-direction flow (from the forge module into the web tree) is
  preserved exactly as the eslint wall messages already prescribe.

### Recommendation: Option C.

It directly converts the current "must stay in sync" comment into a CI gate, which is the whole point of the
Phase-1 mandate to kill the drift risk. It avoids a new published package (Option B's cost) and avoids
trusting a hand-edited file (the status quo). The generator can be as simple as a bespoke emitter for this one
contract — no heavyweight zod-to-ts dependency required, keeping the root's 3-dep posture intact.

### Risks

- **Bespoke emitter completeness:** a hand-rolled zod-to-ts emitter may not cover every zod construct. The
  current contract is simple (enums, objects, optionals, arrays). Mitigation: scope the emitter to the
  constructs the contract actually uses; the drift check catches regressions. If the contract grows
  complex, revisit a vetted zod-to-ts library (still root-side).
- **Two-checkout confusion:** the generated file lives under the web tree but is owned by a root script. Document
  ownership in the file header (as the current file already does for the hand-written version).

**Council condition satisfied:** the brief's Phase-1 mandate to eliminate the duplication WITHOUT breaching
R2-C.

---

## Decision 6 — Playwright pin plus a non-required web-e2e CI job

### State of the world (corrected from the brief)
- The web workspace package manifest ALREADY pins the Playwright test runner at caret `1.61.0`, not at the latest tag.
- The latest tag lives in the installer's Playwright setup module (the `playwright install` and `--package` invocations). That is the installer-side floating version, and it is in the FORBIDDEN write scope for THIS task (the core). So the actual pin CHANGE is a separate task packet.

### Recommendation
- **Pin exact, not caret, for reproducible E2E:** change the web manifest from caret to an exact version (the
  current resolved version) AND pin the installer's exact Playwright version in a follow-up task with installer
  scope. The browser binary version and the test-runner version must match, so pin them together.
- **The web-e2e workflow is a NON-REQUIRED job (Condition number 9).** A separate GitHub Actions workflow that:
  - runs only on web-tree plus contract-generator changes (path filter),
  - runs the headless Chromium install with system deps (the F3 spike confirmed headless Chromium on WSL2 and CI),
  - runs the web build plus the web e2e suite,
  - is NOT a required status check. Promote it to required ONLY after it demonstrates stability over N runs
    (the council should set N; suggested at ten or more consecutive green on master).
- Keep the runtime-contract-and-export-regressions CI scope (per the root operating rules) intact: the root CI stays the authority
  for runtime and export regressions; web-e2e is additive and non-blocking.

### Risks
- **Flaky E2E becomes required too early**, which blocks unrelated merges. The non-required-first staging is
  exactly the mitigation; do not skip it.
- **Browser binary drift** if only the npm package is pinned but the system-dep install floats.
  Mitigation: pin via the test-runner version (it resolves the matching browser build); cache the
  browser path in CI.

**Council condition satisfied:** number 9 (separate non-required job, promote later).

---

## Decision 7 — CSP scope (sequenced WITH Decision 4)

Today the dashboard loads Geist via the Google Fonts CDN `@import` with NO CSP — flagged a pre-auth and pre-live-data
security MEDIUM. The right CSP depends on whether there is a live-data connection (Decision 4): with Option A
(static snapshot) there is NO connect-src to a backend at all, which makes the CSP much tighter.

### Option A — Scoped CSP meta tag, keep the CDN
A scoped policy roughly: `default-src 'self'`; `style-src 'self' 'unsafe-inline'` plus the fonts CSS host;
`font-src` the fonts static host; `img-src 'self' data:`; `connect-src 'self'`; `script-src 'self'`;
plus `frame-ancestors 'none'` and `base-uri 'self'`.

- **Pro:** smallest change. Con: keeps a third-party network dependency and a CDN trust assumption;
  `style-src 'unsafe-inline'` is required for Tailwind-style injected styles, weakening the policy.

### Option B — Self-host the Geist fonts (RECOMMENDED)
Vendor the Geist woff2 files under the web public fonts dir, drop the CDN `@import`, and serve `font-src 'self'`.

- **Pro:** removes the third-party origin entirely, so the CSP collapses to a `default-src 'self'` family with no
  external font or style host. No CDN availability or tracking dependency. Best fit for a single-operator
  internal tool and for D1's FIXED identity (Geist is mandated; self-hosting GUARANTEES it loads offline).
- **Con:** adds committed font binaries to the web tree (acceptable; excluded from npm pack by the R2-C boundary).

### Recommendation: Option B, with the CSP delivered as a meta http-equiv tag for the static-snapshot deployment (Option A transport). If Decision 4 ever becomes Option B (HTTP server), MOVE the CSP into a real response header and add connect-src for the read endpoint — which is why this MUST be sequenced WITH Decision 4, not before it.

### Risk
- **`'unsafe-inline'` in `style-src`** may still be required by Tailwind 4 and Vite's injected styles. Mitigation:
  verify the built output uses external stylesheets (Vite extracts CSS in build mode); if so, drop
  `'unsafe-inline'`. Confirm during implementation; do not assume.

**Council condition satisfied:** addresses the pre-live-data security MEDIUM; sequenced with number 4.

---

## 8. Proposed Phase-1 task breakdown (ordered, gated slices)

Each slice is an independently verifiable unit with a single dominant risk and a clear done-bar. Slices are
ordered so the LIVE-DATA spine lands before the generative pipeline depends on it.

**Slice P1-S1 — Contract codegen plus drift gate (Decision 5).** Write scope: the forge module, the web type tree,
and root CI config. Done: the generated web type file is emitted from the Zod contract; the hand-written
type file is replaced; the CI drift check fails on divergence. Dominant risk: emitter completeness.
Why first: it removes the standing drift risk and unblocks every later view-model change. Reversible.

**Slice P1-S2 — Live read into the snapshot generator (Decision 4 Option A plus Decision 7).** Write scope:
the forge module, the web public dir, the web entry HTML (CSP meta plus self-hosted fonts), and the web public fonts dir. Done:
the forge snapshot sub-verb queries the report and status surface via the store interface, validates through the schema,
and labels the output derived_only; CSP plus self-hosted Geist landed. Dominant risk: field-leak via the projection;
gated by the security reviewer. Reversible.

**Slice P1-S3 — forge admin subcommand (Decision 3).** Write scope: the admin entry dispatch line plus the new forge admin module.
Done: the forge snapshot and forge critic sub-verbs with injected deps plus tests.
Dominant risk: keeping snapshot read-only. Reversible.

**Slice P1-S4 — Deterministic anti-generic checker (Decision 2 Tier-1).** Write scope: the forge module. Done:
a checker that takes computed styles plus the constraints manifest and returns the violation list with
AG-NNN ids and measured-vs-cap values; unit tests prove an over-cap radius case hard_fails.
Dominant risk: computed-style extraction fidelity. This is the FALSIFIABLE core of Condition number 1.

**Slice P1-S5 — frontend_forge run profile template plus decompose mapping (Decision 1).** Write scope:
the forge module (profile data plus Zod validation), and wherever profiles register (inspect the decompose path
first — it may reach into engine graph code, which would need its OWN task scope; if so, split). Done: a Forge run
materializes the 15 stages as ordinary gated tasks; a visual-critic rework creates a repair edge consuming the S4
diff. Dominant risk: modifying engine graph code, so keep it additive and gate hard. Partially expensive (graph
wiring) — flag for the council.

**Slice P1-S6 — Pre-committed fallback assets plus asset-QA stage (the Decision 1 note).** Write scope:
the web public dir or a forge asset dir plus the forge module. Done: every pipeline-expected asset has a committed
fallback; asset-QA validates the fallback so the pipeline runs end-to-end WITHOUT F1. Dominant risk: none
high. Reversible. Sets up the Phase-2 codex swap as a localized change.

**Slice P1-S7 — web-e2e non-required CI plus Playwright exact pin (Decision 6).** Write scope:
the GitHub workflows dir plus the web manifest; the installer pin is a SEPARATE
follow-up packet (forbidden scope here). Done: a non-required job green on the critical flow. Reversible.

**Slice P1-S8 (separate packet, control-layer skills scope) — author the three stage skills (Decision 2).** Compose
the existing skills; encode the critic and repair contracts from S4. NOT in this task's scope; cut as its own packet
with explicit control-layer skills write scope.

Note: every code slice carries the standard reviewer plus qa_engineer plus security_reviewer gates plus the workflow proof. S2, S4, and S5 additionally warrant accessibility-engineer and performance-engineer evidence per the role chain.

---

## 9. Open questions — USER decisions versus COUNCIL decisions

### Genuinely USER decisions (product, cost, policy — not architecture)
- **U1 (carried D2):** the API provider plus secrets model for the Phase-2 codex image-generation integration —
  deferred to P5, but the user should confirm the deferral still holds and name the intended provider so
  Phase-1 fallback assets resemble the eventual output.
- **U2 (carried D4):** confirm the dogfood target stays the read-only Run-Status dashboard (versus pivoting the
  first real generative target to something else). It changes what the implement and browser-QA stages render.
- **U3:** is manual or poll refresh (Decision 4 Option A) acceptable for the operator UX, or is real-time
  (Option B HTTP server, Phase 2) a hard requirement? This is a UX and risk-appetite call the user owns.

### COUNCIL decisions (architecture, quality — owned by this gate)
- **C1:** approve Decision 1 Option A (profile-as-template) versus demand evidence against Option B.
- **C2:** accept Decision 2 Option B (two-tier critic) as falsifiable enough for Condition number 1, or require
  the deterministic tier to cover layout-genericness too before approval.
- **C3:** accept Decision 4 deferring the HTTP server to Phase 2, or rule the static-snapshot UX insufficient.
- **C4:** set the promote-web-e2e-to-required stability threshold N (Decision 6).
- **C5:** confirm Slice P1-S5's engine-graph reach is acceptable as additive, or require a deeper read of the
  decompose path before approving the profile mechanism.

---

## 10. Dissent seeds (material for the council dissent owner)

- **Against Decision 1 (profile-as-template):** a declarative 15-stage template materialized at decompose
  time is a hidden DSL. The moment a stage needs conditional branching (skip asset-QA when no assets changed),
  the template grows logic and becomes a worse, untyped orchestrator than Option B would have been —
  re-litigate before the template ossifies.
- **Against Decision 2 (two-tier critic):** the deterministic tier only catches what is already a numeric
  token in the manifest. Generic is overwhelmingly a LAYOUT and composition property, which Tier-1 cannot
  measure. We will SHIP a gate that is falsifiable on the trivial cases and advisory on the cases that
  actually matter, then claim Condition number 1 is satisfied. That is condition-theater.
- **Against Decision 4 (static snapshot, derived_only):** a monitor that is stale until someone runs a CLI is
  not a monitor; operators will distrust it and revert to SQL — defeating the whole done-bar. The HTTP read
  endpoint is small; deferring it trades a one-time security review for a permanently degraded product.
- **Against Decision 5 (generate-and-commit plus drift check):** a committed generated file plus a CI check is
  the SAME human-promise failure mode dressed up — people will commit the stale generated file to make
  CI pass under deadline. A true build-time codegen (Option A, never committed) removes the temptation
  entirely; we chose convenience over correctness.
- **Against Decision 6 (non-required E2E):** non-required E2E is E2E that rots. It will go red, everyone learns
  to ignore it, and it never gets promoted. Either commit to making it required on a date or do not build it.
- **Against Decision 7 (self-host fonts):** self-hosting Geist commits binary blobs and a manual update
  burden into the web tree for a tool three people use; the CDN with a scoped CSP is the pragmatic 95% answer and
  we are gold-plating the threat model for an internal dashboard.

---

## 11. Reversible versus expensive — summary for staging

| Decision | Reversible? | Note |
| --- | --- | --- |
| D1 profile-as-template | Reversible | a config artifact; the P1-S5 graph wiring is the partly-expensive edge |
| D2 two-tier critic | Reversible | additive checker module |
| D3 forge subcommand | Reversible | additive admin module |
| D4 static-snapshot live read | Reversible | reuses the Phase-0 mechanism; the HTTP server (Phase-2) would be the expensive step |
| D5 generate-and-commit plus drift gate | Reversible | derived artifact |
| D6 non-required CI plus exact pin | Reversible | additive workflow |
| D7 self-hosted fonts plus CSP | Reversible | vendored asset |

**Single most expensive and least-reversible item:** any code that reaches into the engine run and task graph in P1-S5.
Keep it strictly additive, give it its own task scope, and gate it hardest. Everything else is cheap to unwind.

---

## 12. Remaining uncertainty plus the evidence needed to retire it

- **Computed-style extraction fidelity (D2):** it is unproven that Playwright computed-style readout maps cleanly
  onto every AG-NNN constraint. Evidence: a spike in P1-S4 against the existing dashboard. Retire this before promoting the
  critic to auto-blocking.
- **Decompose-path shape (D1 and P1-S5):** this proposal has NOT inspected the engine decompose internals (out of
  scope). Evidence: a bounded read of the decompose path before P1-S5 implementation; it may reveal that the
  profile needs a different attach point.
- **Tailwind and Vite inline-style requirement (D7):** whether the unsafe-inline style allowance is droppable. Evidence: inspect
  the Vite production build output.
- **Bespoke zod-to-ts emitter completeness (D5):** evidence: enumerate the zod constructs the contract uses;
  confirm the emitter covers them.

---

## 13. Design & Architecture Council outcome

**Outcome: `approved_with_conditions`** (recorded in runtime, task `forgePhase1Council`, run `2a90543b`).
Panel (unanimous approved-with-conditions): `product_strategist`, `frontend_designer`,
`infra_engineer` (**dissent owner**). Reasoning mode: strict.

### Recorded dissent (infra_engineer, adopted)
The dissent owner forced one genuine design change and two framing corrections, all adopted:
- **D5 → build-time codegen, NOT generate-and-commit.** A committed generated file invites the
  classic "hand-edit + force CI green" drift failure (GraphQL/protobuf/OpenAPI precedent). A
  never-committed build-time emitter (web `prebuild` script, gitignored output) removes the failure
  class entirely and matches the "best long-term over low-cost" directive. **This overrides Decision 5
  Option C → Option A.**
- **D4 → "snapshot viewer", not "monitor".** Phase-1 delivers a snapshot viewer refreshed on operator
  command; the real-time monitor (HTTP read server) is the Phase-2 promotion, gated on U3 + a listener
  security review.
- **D1 → the template must not grow conditional/branching logic;** the rework-loop decompose mechanism
  is verified before P1-S5 starts.

### Binding conditions (each maps to a slice / owner)
1. **C1 — Falsifiable anti-generic gate (non-waivable; frontend_designer).** P1-S4 Tier-1 deterministic
   critic MUST implement `AG-012` (3-card soup) and `AG-014` (marketing-page patterns) as DOM-structure
   assertions, with a test proving a three-equal-card layout `hard_fail`s before merge. Any rule that
   cannot be mechanically checked MUST emit an explicit `layout-genericness-unchecked` flag in gate
   output — advisory coverage is declared, never hidden behind a green deterministic pass. (Parent council #1.)
2. **C2 — D5 build-time codegen (infra dissent).** Bespoke zod→ts emitter runs as a web `prebuild`
   script; generated types file is gitignored in the web tree; source of truth stays the Zod contract
   in the forge contract module. The generator MUST NOT import from the web tree. Return to council with
   evidence before falling back to generate-and-commit.
3. **C3 — Run-profile mechanism verified before P1-S5 (infra; blocker).** A bounded read of the
   decompose path must confirm conditional task presence / single-writer mid-run injection before P1-S5
   starts; expand S5 scope if injection is required. The profile template must acquire NO conditional
   branching logic in Phase 1 without re-gating (product PS-5 tripwire).
4. **C4 — Two-part done-bar, stated explicitly (product_strategist).** The Phase-1 brief states BOTH
   falsifiable gates separately: (a) VIEWER — operator identifies a blocked/stuck run from the dashboard
   faster than from SQL, *with honest staleness*; (b) CAPABILITY — a `frontend_forge` run materializes
   the 15 gated tasks end-to-end on fallback assets. Phase-1 is NOT done on (b) alone.
5. **C5 — Honest staleness + poll refresh in P1-S2 (product PS-3/PS-4; infra D4).** The dashboard MUST
   render a `generated-at` / snapshot-age signal distinct from the `derived_only` authority label; a
   bounded operator-set poll refresh (`forge snapshot --watch`, no listening socket) is in P1-S2 scope,
   not deferred. A viewer that cannot show it is stale fails the done-bar.
6. **C6 — Field-leak prevention in P1-S2 (infra; blocker for S2).** The snapshot generator uses strict
   Zod parse (`.strip()`, never `.passthrough()`); the live snapshot output is gitignored; the committed
   sample contains no real run/task IDs.
7. **C7 — CSP / self-host Geist (frontend + infra), sequenced WITH D4.** Self-host Geist (CSP collapses
   to `default-src 'self'`); confirm against the Vite production build whether `'unsafe-inline'` in
   `style-src` is droppable and drop it if so. Do not ship a weaker CSP without evidence it is required.
8. **C8 — CI isolation + promotion tracking (infra; frontend).** The non-required `web-e2e` workflow runs
   `cd web && npm ci` (explicit workspace scoping, never a root `npm ci`), with an R2-C rationale comment.
   The promote-to-required criterion names an owner role + a concrete check mechanism in the workflow
   file; threshold = **15** consecutive green runs on master (frontend_designer, over the proposal's
   floor of 10).
9. **C9 — Stage skills reference, never copy (frontend).** Every numeric/color constraint in
   `archon-forge-intent/direction/assets` cites `CONSTRAINTS_MANIFEST` by import; no inline token tables
   (no third source of truth). Enforced at the skill-authoring slice's review gate.
10. **C10 — U2 dogfood-target user-confirm before the profile/skill slices (product PS-6; manager).**
    S1–S4 may proceed now; S5 (profile) and S8 (stage skills) require user confirmation that the dogfood
    target remains the read-only Run-Status dashboard (parent non-goal #7).

### Genuine USER decisions (deferred, not council-owned)
- **U1** codex provider/secrets (Phase 2). **U2** dogfood-target confirm (gates S5/S8 — see C10).
- **U3** refresh UX: poll/manual (Phase-1 Option A) vs real-time HTTP server (Phase-2). The council
  approves the static-snapshot transport *contingent on U3 = stale-with-honest-age acceptable*; if the
  operator requires real-time, Decision 4 reopens and the HTTP server is pulled forward (with its
  security review).

**Implementation sequencing:** C3 and C6 are blockers before their slices start (P1-S5, P1-S2
respectively). C1, C2, C5, C7, C8, C9 are slice done-bar items. C4 and C10 are brief/manager items
before the dependent slices cut.
