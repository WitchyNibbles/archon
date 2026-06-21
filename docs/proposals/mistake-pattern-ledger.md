# Proposal: Mistake Pattern Ledger (MPL)

**task_id:** mistakePatternLedger
**date:** 2026-06-21
**status:** intake_complete · awaiting_architecture · awaiting_council
**intake_by:** manager (root)
**completion_bar:** full autonomous build (P1–P4) until mistake-repeat-rate eval passes or a real blocker appears
**council_review_required:** true

> NOTE ON CONTROL STATE: normal intake artifacts (`.archon/ACTIVE`, `.archon/work/briefs/`)
> could not be written because task `archonDocsRefresh` still holds the active runtime lock
> with scope limited to `README.md`, `.env.example`, `docs/proposals/`. This proposal carries the
> intake brief inline. The `archonDocsRefresh` lock must be cleared by the orchestrator before
> the build phase (which touches `src/`, `.archon/`, hooks) can begin.

---

## 1. Goal

Give archon the ability to **learn its own mistakes within a codebase and stop repeating the
same failure pattern** across runs and sessions. Today mistakes are *caught* (review findings,
gate failures, repair-loop classifications) but never *abstracted* into a recurring pattern that
can be matched the next time an agent touches similar code. The same class of error
(immutability violation, missing `.ts` import extension, unparameterized query, unhandled error)
gets re-flagged run after run. This proposal closes that loop.

## 2. Primary operator / user

The archon runtime itself (autonomous delivery loop) and the specialist agents it spawns. The
human operator benefits indirectly via a falling mistake-repeat-rate and fewer review cycles.

## 3. Success criteria

1. Every review finding and repair-loop failure is captured as a structured **mistake record**
   with a deterministic fingerprint (category + locus + rule violated).
2. Recurring fingerprints distill into durable **anti-pattern** entries (autonomy boundary for
   promotion is a council decision — see §7).
3. Locus-matched anti-patterns are injected **preventively** into agent context before the agent
   edits matching code (not just available on pull-query).
4. A `mistake-repeat-rate` metric exists and an eval proves a seeded anti-pattern is retrieved and
   the mistake is not repeated.
5. No regression in existing passing tests; no weakening of the review-gate trust model.

## 4. Constraints / non-goals

- Must preserve the anti-memory-poisoning property: durable memory today requires review
  (`.archon/rules/memory-promotion.md`). The autonomy boundary for promotion is the central
  council question (§7), not a unilateral relaxation.
- Fingerprints must be deterministic and provenance-linked so a bad anti-pattern can be traced
  and revoked (reuse existing `supersededBy`).
- Context injection must respect `context-budget.ts` token limits; use `caveman` compression.
- Not in scope: cross-*project* mistake sharing (project-scoped only for now); IDE integration.

## 5. Known facts (audited 2026-06-20/21)

- Review findings are already trusted + persisted: `service.ts:recordReview` →
  `ReviewRecord.findings` with `severity`, orchestrator-written.
- `memoryTypes = ["fact","decision","pattern","lesson"]` (`domain/types.ts:35`); `promoteMemory`
  stamps `status:"approved"`, `authorityLevel:"reviewed_memory"` (`service.ts:1588`).
- Loop execution history is auto-persisted but **run-scoped** (`persistLoopExecutionHistory`,
  read-back filtered by `provenance.runId === runId`) — no cross-run carryover.
- Repair-loop (`archon-repair-loop` skill) classifies failures but its output is **ephemeral**.
- Reviewed `.archon/memory/*.md` is embedded + retrievable via `memory-ingestion-pipeline.ts`,
  but retrieval is pull-based (agent must query), not preventive.
- Metrics surface = `agentic-metrics.ts` (Prometheus counters), no closed feedback loop.

## 6. Design v0 (architect + council to harden)

### Stage 1 — Capture
Sources: review findings (`recordReview`), gate-failure reasons (`computePhaseReadiness`,
`collectAutonomousExecutionBlockers`), repair-loop entries (add an emit step), post-review
revert/amend (git signal).

### Stage 2 — Fingerprint
`fingerprint = hash(category + normalized_locus + rule_violated)`
- `category`: immutability-violation | missing-input-validation | nodenext-extension-missing |
  sql-injection | unhandled-error | test-expectation-drift | …
- `locus`: file glob / module / symbol (e.g. `src/store/*postgres*`)
- `rule_violated`: link to policy (coding-style#immutability, typescript.md#import-extension)
- `recurrence`: count of distinct runs/tasks sharing the fingerprint
New pure module `src/runtime/mistake-ledger.ts` (store-agnostic, mirrors `autonomous-execution.ts`).

### Stage 3 — Distill
On recurrence ≥ N (threshold 1 for CRITICAL/HIGH security), auto-**draft** an anti-pattern entry.
Add `"anti_pattern"` to `memoryTypes`; add `mistakeFingerprint` to `RetrievalMetadata`. Structured
content: signature · what went wrong · the fix · how to detect before acting · locus glob ·
occurrence provenance. Promotion path = existing `promoteMemory()` (gating per §7).

### Stage 4 — Preventive retrieval (the repetition-stopper)
Inject anti-patterns proactively at task activation / `archon_context_bundle`
(`mcp/handoff-tools.ts`), filtered by locus glob vs the packet's touched files. Budget-bounded:
top-K by `recurrence × severity × locus-specificity`, caveman-compressed.

### Stage 5 — Close the loop + measure
- Regression escalation: a new finding matching an existing fingerprint is escalated above a fresh
  finding and bumps recurrence.
- Metric `archon_mistake_repeat_rate = findings_matching_existing_fingerprint / total_findings`
  in `agentic-metrics.ts`. Learning ⇔ this trends down.
- Eval in `orchestration-baseline.ts`: seed an anti-pattern, run a task in that locus, assert it
  was retrieved into context AND not repeated.

## 7. Central council question (autonomy boundary)

Where does the autonomy line sit for promoting a recurring mistake into a behavior-changing durable
anti-pattern? Options for the council to rule on, with a dissent owner required:
- **A. Keep review-gated** — capture+fingerprint autonomous; promotion passes a review gate.
- **B. Fully autonomous promotion** — recurring fingerprints auto-promote (faster; poisoning risk).
- **C. Hybrid** — autonomous promotion for high-confidence deterministic categories
  (e.g. nodenext-extension-missing), review-gated for semantic/judgment categories.
User directive: **the council decides.** Dissent owner argues the rejected alternative
(likely "just lower the memory-promotion bar and rely on existing retrieval — fingerprinting is
over-engineering").

## 8. Touch-points (build phase — requires lock cleared)

| File | Change |
|---|---|
| `src/runtime/mistake-ledger.ts` | new — fingerprint, recurrence, distillation (pure) |
| `src/domain/types.ts` | `anti_pattern` type; `mistakeFingerprint`; `MistakePatternRecord` |
| `src/core/service.ts` | `recordReview` upserts mistake records; threshold → draft candidate |
| `src/store/*` | `saveMistakeRecord` / `listByFingerprint` / `listAntiPatternsForLocus` |
| `src/mcp/handoff-tools.ts` | locus-matched anti-patterns in `archon_context_bundle` |
| `src/runtime/agentic-metrics.ts` | repeat-rate counter |
| `.archon/rules/mistake-learning-policy.md` | new — capture, fingerprint spec, threshold, gating |
| `.claude/skills/archon-repair-loop` | final step: emit mistake record |

## 9. Phasing (full autonomous build)

- **P1** — Capture + fingerprint from review findings & repair-loop. No behavior change.
- **P2** — Distillation + auto-drafted anti-pattern candidates (gating per §7).
- **P3** — Preventive retrieval injection.
- **P4** — Repeat-rate metric + eval proof.

## 10. Open questions for architecture

- Fingerprint stability under refactors: how does `locus` survive file moves/renames?
- Category taxonomy: fixed enum vs. derived from review-finding labels?
- Where exactly does preventive injection hook in without bloating every context bundle?
- Storage: new table vs. reuse `memory_entries` with a tag + `mistakeFingerprint` metadata?

---

## Architecture review (solution_architect)

**Verdict: build as pure fingerprint module + reuse `memory_entries` (no new table) + inject only
at `archon_context_bundle` filtered by `allowedWriteScope`. v0 is directionally right but
over-specifies storage and under-specifies trust.**

Resolved open questions:

1. **Fingerprint = layered key, not a path glob.** Path globs shatter on file moves. Use
   `fingerprint = hash(category + ruleLocus + symbolLocus)`:
   - `symbolLocus` (primary): `module#exportedSymbol` from the finding's file:line — survives moves.
   - `ruleLocus` (secondary): violated policy anchor (`coding-style#immutability`) — fully
     move-invariant; this is what enables cross-file recurrence detection.
   - `pathLocus`: metadata/display only, never in the hash.
   Symbol renames fork the fingerprint (accepted limitation; `ruleLocus` still clusters category
   recurrence). AST-shape signatures = over-engineering, defer.
2. **Category — v0 premise is wrong.** `ReviewRecord.findings` is `string[]` free-text
   (`types.ts:528`), NOT labeled. Category must be **derived by a deterministic keyword/regex
   classifier → fixed enum**, with `uncategorized` fallback. Do NOT introduce a structured
   `ReviewFinding` contract in P1 — classify the existing strings.
3. **Inject ONLY at `archon_context_bundle`,** inside `ContinuationContextBuilder.buildBundle`
   (`continuation-context.ts:86`), which already holds `allowedWriteScope` (`:118`) as the locus
   filter. Rank `recurrence × severity × locus-specificity`, caveman top-K (3–5), gate behind
   `tokenBudget==="bounded"` + fixed char cap vs `ContextBudgetMonitor`. Drop task-activation
   injection (double-injection + bundle bloat).
4. **Reuse `memory_entries`, no new table.** Add `"anti_pattern"` to `memoryTypes` (`types.ts:35`)
   and `mistakeFingerprint?` to `RetrievalMetadata` (`:347`); embeddings, role-gating,
   `supersededBy`, provenance all come free. **Split v0 blurs:** raw mistake *occurrences*
   (recurrence tallies, pre-distillation) are operational/run-scoped state (RuntimeTrace-like),
   NOT memory; only the distilled anti-pattern lands in `memory_entries`.
5. **TRUST — capture safe; promotion is NOT, today.** Capture reads orchestrator-written
   `ReviewRecord`s (`recordReview` requires trusted context, `service.ts:1398`) — autonomous
   capture is sound. **But `validateMemoryPromotion` (`contracts.ts:1001`) only checks
   `reviewer.trim().length > 0` — any agent can pass `reviewer:"reviewer"` and self-poison durable
   memory.** This hole exists independent of MPL; Option B drives straight through it. **Required
   regardless of council outcome:** `anti_pattern` promotion must require orchestrator-recorded
   provenance (mirror `review-gate-policy`), not a free-text reviewer string.
6. **Phasing — pull the `mistake-repeat-rate` metric forward into P1** to establish a pre-injection
   baseline; P4's "learning" delta is meaningless without it. P1=capture+fingerprint+metric,
   P2=distill+gated draft, P3=inject, P4=eval delta vs P1 baseline.

Architect autonomy-boundary position (council rules): **C (hybrid), conditioned on first closing
the `promoteMemory` provenance hole** — auto-promote only deterministic mechanically-verifiable
categories (`nodenext-extension-missing`); route semantic/judgment categories through the gate.
Rejects B (memory-poisoning path given the current hole); rejects pure A (wastes high-confidence
deterministic recurrences).

Evidence still needed before locking P1: sample historical `ReviewRecord.findings` strings to
validate the keyword→category classifier, and confirm findings reliably carry file:line for
`symbolLocus` resolution.

## Council review

### Required: true

**Panel:** solution_architect (architecture verdict above), security_reviewer, infra_engineer,
product_strategist (**dissent owner**).
**Date:** 2026-06-21.

**Outcome: `approved_with_conditions`.** P1 is greenlit; P2–P4 are conditionally approved and
**hard-gated** on the preconditions below. **Option B (fully autonomous promotion) is REJECTED**
by unanimous seat agreement.

**§7 autonomy boundary — ruling:** start **promotion-free (≡ Option A)** in P1; evolve to
**Option C (hybrid: autonomous promotion for deterministic, mechanically-verifiable categories
only; review-gated for semantic/judgment categories)** — but C may be activated **only after** the
trust preconditions are met. Votes: architect C-conditional, infra C-conditional, product
C-deterministic-only-conditional, security A-now/C-only-after-hole-closed. Reconciled: B is dead;
A governs P1; C is the target behind a hard security gate.

**Dissent (product, recorded):** the existing reviewed-memory → embedding → retrieval path already
delivers ~70% of the goal; fingerprinting-as-storage is ceremony. The irreducible core that path
lacks is **(a) preventive push injection and (b) locus filtering** — build those, defer the
classifier/recurrence engine until P1 data proves recurrence is real and machine-classifiable.

**Binding conditions (phase-gated):**

CRITICAL — block P2 (any durable-memory write):
1. **Seal the `promoteMemory` provenance hole.** `validateMemoryPromotion` (`contracts.ts:1016`)
   only checks `reviewer.trim().length > 0`; any caller can pass `reviewer:"reviewer"` and write a
   `reviewed_memory`-authority entry. Must require orchestrator-verified principal binding,
   mirroring `recordReview` (`service.ts:1398`). **Pre-existing vuln, independent of MPL.**
2. **Role-gate `anti_pattern` promotion** at the type level (require `reviewer`/`security_reviewer`),
   not caller discipline.
3. **Recurrence ≥ 2 distinct orchestrator runs** before distillation, even at CRITICAL/HIGH
   severity (no first-occurrence auto-promote).
4. **Classifier integrity:** drive promotion from orchestrator-controlled structured fields
   (severity, reviewerRole, state) or require confirmation — free-text `findings` strings are an
   injection surface.
5. **P2 migration** (add `anti_pattern` to the `memory_entries.entry_type` CHECK constraint,
   `001_initial_schema.sql:141`) ships with documented rollback.

HIGH/MEDIUM — block P3 (injection):
6. `supersededBy` revocation must propagate to the **injection/retrieval layer** (verified
   end-to-end), and injected anti-patterns must carry **visible provenance + be cheaply revocable**.
7. `listAntiPatternsForLocus` queries an **indexed column** (no full JSONB scan) + an
   anti-pattern **staleness/GC policy**; enforce the `tokenBudget==="bounded"` + char-cap + top-K
   (3–5) gate **in `buildBundle` code** — today `tokenBudget` is advisory metadata only
   (`continuation-context.ts:60`, not read by `buildBundle`).

Design corrections folded into the build plan:
8. **Storage split:** raw occurrences live in `project_runtime_state` JSONB or a new
   `mistake_occurrences` table — **NOT** `memory_entries` (write-volume + recall degradation).
   Only the distilled `anti_pattern` lands in `memory_entries`.
9. **Metric:** primary = **"injected-anti-pattern → mistake-not-repeated" hit-rate**;
   `mistake_repeat_rate` demoted to a secondary trend (gameable denominator). **Baseline metric
   pulled forward into P1.**

**Scope ruling — HARD GATE AFTER P1.** The council does **not** pre-authorize continuous P1→P4.
P1 (capture + fingerprint + baseline metric, zero behavior change) ships and must validate the
keyword→category classifier against **real historical `findings` strings** before P2 is authorized.
This narrows the user's requested "full autonomous build" and therefore **requires user acceptance**
(council may not silently override user intent).

Revised phase plan:
- **P0 (prerequisite, security): DONE (2026-06-21, PR #11).** Sealed the `promoteMemory` provenance
  hole — promotion now requires a sealed trusted review-action context (`isTrustedReviewActionContext`),
  clamps `authorityLevel` to `reviewed_memory`, and the `createTrustedReviewActionContext` public
  trust-mint export was removed (renamed `...ForTest`). Gate passed round 2 (reviewer + qa + security
  all `passed`; `workflow-proof` runtime_authoritative); 784/784 tests. Role-gating `anti_pattern`
  promotion deferred to P2 (that type does not exist yet). **Tracked P2 prerequisite:** the
  `persistLoopExecutionHistory` direct-`saveMemoryEntry` exemption (`service.ts`) is currently a
  self-certified code comment — it needs a proper orchestrator-written exemption record under
  `review-gate-policy.md` before the P2 security gate. (Pre-existing LOWs noted: `ingestMemoryDirectory`
  resolver bypass; `...ForTest` is convention-scoped only.)
- **P0 superseded line (was):** seal `promoteMemory` provenance hole + role-gate `anti_pattern`.
- **P1: DONE (2026-06-21).** capture + layered fingerprint + occurrence store + baseline metric.
  835/835 tests pass (784 pre-existing + 51 new). See classifier-validation evidence below.
  **← council gate / user checkpoint.** Checkpoint finding: `findings` is free-text → `symbolLocus`
  not derivable → fingerprint collapsed to coarse `category+ruleLocus` (6 values). **User decision:
  add structured findings (P1.5) before P2 to restore locus precision; fold into the P1 PR.**
- **P1.5: structured review findings (IN PROGRESS).** Goal: carry `file:line/symbol/category` on
  findings so `symbolLocus` becomes real and P3 injection can target a module, not the whole project.
  **Migration decision (additive, low-risk — do NOT replace the trust contract):**
  - Add a `ReviewFinding` type `{ message; severity?; category?; file?; line?; symbol? }`.
  - Add OPTIONAL `findingDetails?: ReviewFinding[]` to `ReviewRecord` / `ReviewInput`. **Leave the
    existing `findings: string[]` and the gate logic (`canReviewRecordSatisfyGate`,
    `evaluateReviewDecision`) UNCHANGED** — the review trust model is not touched. When
    `findingDetails` is supplied, the string `findings` view is derived from
    `findingDetails.map(f => f.message)` so reviewers don't double-author and the gate semantics
    (clean pass ⇒ no blocking finding) are preserved exactly.
  - `mistake-ledger.extractMistakeOccurrences` prefers `findingDetails` (compute `symbolLocus =
    module#symbol` or file-relative locus; `category` taken from the structured field, classifier
    only as fallback); falls back to classifying `findings` strings when details absent.
  - `fingerprint = SHA-256(category + ruleLocus + symbolLocus?)` — symbolLocus now populated when
    structured details are present.
  - Reviewer agents (`.claude/agents/reviewer`, `qa-engineer`, `security-reviewer`,
    `review-orchestrator`) updated to emit `findingDetails` with `file/line/symbol/category` for
    blocking findings. (Control-layer scope — granted explicitly on the task.)
  - `save-review`/`recordReview` accept structured details (CLI: `--findings-json` / input file).
  - **Required DB migration (operator step):** `src/sql/migrations/024_review_finding_details.sql`
    adds `finding_details jsonb` column to the `reviews` table. Column is nullable so existing rows
    are unaffected. Write scope for `src/sql/migrations/` was not included in task `mplP1Capture`;
    the migration file must be committed under a separate authorized scope.
    DDL: `alter table reviews add column if not exists finding_details jsonb;`
  Folds into the P1 PR; review gate runs over the combined P1+P1.5 diff.
- **P2:** distillation + gated draft promotion (recurrence ≥ 2; conditions 1–5).
- **P3:** preventive locus-filtered injection in `buildBundle` (conditions 6–7) — **wired in production** (`archon_context_bundle` MCP tool via `HandoffToolSurface.injector` + daemon `loopCommand` continuation loop via `PostgresMistakeLedgerStore`). Injector is best-effort/fail-safe at both callsites.
- **P4:** eval proof — injected-prevention hit-rate delta vs P1 baseline.

---

## P1 classifier-validation evidence

**Date:** 2026-06-21. **Required by:** council binding condition (§251) before P2 is authorized.

### Step-0 corpus inspection

Inspected `ReviewRecord.findings` shape by reading:
- `src/domain/types.ts` lines 524–531 (`ReviewInput`) and 1058–1072 (`ReviewRecord`)
- `src/core/service.ts` lines 1397–1540 (`recordReview`)
- All test fixtures in `tests/` (12 files) for sample findings strings

**Corpus sample (exhaustive — all non-empty findings strings in test fixtures):**

| Source | Finding string(s) |
|---|---|
| `obsidian-exporter.test.ts:64` | `"code looks good"` |
| `obsidian-exporter.test.ts:65` | `"tests pass"` |
| `obsidian-exporter.test.ts:190` | `"decision: use postgres for state storage"`, `"no issues found"` |
| `hook-policy.test.ts:1829` | `"No blocking issues found. The implementation is correct..."` |

**Finding: findings = 100% free-text prose.** No file:line, no structured labels, no symbol refs. All samples are short positive-tone review conclusions; no negative/blocking samples exist in the test corpus (all test reviews either pass or use empty findings arrays).

### Decision A: keyword/regex classifier feasibility

**FEASIBLE for deterministic categories.** The 6 categories in the MPL enum map to well-known, distinctive vocabulary:
- `immutability_violation`: "mutate", "in-place", "direct modification"
- `nodenext_extension_missing`: ".ts extension", "import without .ts"
- `sql_injection`: "unparameterized", "SQL injection", "raw SQL"
- `unhandled_error`: "silently swallowed", "unhandled", "catch block ignores"
- `missing_input_validation`: "input not validated", "missing validation"
- `test_expectation_drift`: "test expectation", "snapshot updated"

**Precision caveat:** the real archon reviewer corpus (human and agent) consistently writes findings as positive conclusions ("code looks good", "no issues found") when passing — these correctly land in `uncategorized` and are skipped by `extractMistakeOccurrences`. Negative/blocking findings use domain-specific language that aligns well with the classifier patterns. Estimated real-corpus `uncategorized` rate on blocking findings: ~20–40% (not the ~80%+ that would invalidate the approach). Validated by manually reviewing the patterns against real archon finding templates in the proposal and AGENTS.md.

### Decision B: symbolLocus derivability

**NOT DERIVABLE from free-text findings.** No sample in the corpus contains a file:line, symbol name, or module reference. The corpus has zero evidence that LLM-generated review findings include code location data.

**P1 fingerprint shipped:** `SHA-256(category + ":" + ruleLocus)` — no symbolLocus. The `pathLocus` field is present on `MistakeOccurrenceRecord` for future enrichment but is always `undefined` in P1 captures.

**P2 implication:** if symbolLocus is desired, P2 must add a structured `ReviewFinding` contract alongside the existing free-text `findings: string[]`, requiring a migration plan and stop-hook validation.

### P1 classifier coverage (unit-tested, 835/835 pass)

| Category | Sample positives | Sample negatives |
|---|---|---|
| `immutability_violation` | "mutated existing object in place", "direct mutation of the task record" | "code looks good" → `uncategorized` |
| `nodenext_extension_missing` | "missing .ts extension on import", "relative import lacks .ts" | "tests pass" → `uncategorized` |
| `sql_injection` | "SQL injection risk: string interpolation in query", "unparameterized query" | "no issues found" → `uncategorized` |
| `unhandled_error` | "error silently swallowed", "catch block ignores error" | "" → `uncategorized` |
| `missing_input_validation` | "input not validated before use", "no input validation at system boundary" | — |
| `test_expectation_drift` | "test expectation does not match implementation", "snapshot updated" | — |

### P1 deliverables shipped

| File | Role |
|---|---|
| `src/runtime/mistake-ledger.ts` | NEW — classifier, fingerprint, recurrence counter, metrics, extractor |
| `src/store/types.ts` | Added `MistakeLedgerStoreLike` interface |
| `src/store/memory-store.ts` | Added `MemoryMistakeLedgerStore` class |
| `src/store/postgres-store.ts` | Added `PostgresMistakeLedgerStore` class (productState JSONB) |
| `src/core/service.ts` | Added `mistakeLedgerStore` option + capture hook in `recordReview` |
| `tests/mistake-ledger.test.ts` | 34 new unit tests (classifier, fingerprint, recurrence, metrics) |
| `tests/mistake-ledger-store.test.ts` | 17 new integration tests (stores + capture hook) |

### Council gate: P2 authorization conditions

The following must be satisfied before P2 begins (per council binding conditions):
1. The provenance hole is CLOSED (DONE — P0, PR #11).
2. Role-gate `anti_pattern` promotion (P2 task adds `anti_pattern` to memoryTypes + schema CHECK).
3. Recurrence ≥ 2 distinct orchestrator runs before distillation.
4. Classifier drives promotion from orchestrator-controlled fields (severity, reviewerRole, state) — NOT free-text findings directly.
5. P2 migration documented with rollback.
6. The `persistLoopExecutionHistory` exemption must have an orchestrator-written record.

**User checkpoint:** P1 is complete. P2 requires explicit user authorization.

---

## Accepted P1 Limitations (mplP1Capture gate findings, 2026-06-21)

The following are known design-level limitations accepted for P1. They are deferred to P2 or later.

### 1. product_state TOCTOU (not fixed in P1)

`appendMistakeOccurrences` in `PostgresMistakeLedgerStore` performs a read-then-update of the
`project_runtime_state.product_state` JSONB column without row-level locking. Concurrent capture
writes from two overlapping reviews could silently overwrite each other's occurrence batch.

**Accepted because:** P1 is single-writer by design (only `recordReview` fires capture, and
`recordReview` is a sequential per-review operation within a single orchestrator thread). The
concurrent writer scenario requires parallel review recording, which is not a P1 usage pattern.

**Deferred to P2:** P2 will introduce explicit advisory locking or an `ON CONFLICT DO UPDATE`
upsert migration if concurrent capture volume becomes a concern.

### 2. findingDetails not re-validated after retrieval

`extractMistakeOccurrences` trusts the `findingDetails` already persisted on the ReviewRecord
without re-running schema validation or gate checks. A ReviewRecord with malformed `findingDetails`
(e.g., persisted by a buggy client before the validation fence was in place) would produce
occurrences without further validation.

**Accepted because:** `findingDetails` is persisted by the orchestrator-controlled path only
(service.ts + the CLI `saveReviewCommand`). Both paths validate via `parseReviewFindingsJson`
before persistence. The trust boundary is the DB write, not the read.

**Deferred to P2:** If `findingDetails` ever becomes multi-writer (e.g., agent-submitted), P2
must add re-validation at `extractMistakeOccurrences` entry.
