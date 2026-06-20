# Design: Option B review-floor relaxation (council-vetted)

> Status: **approved design, not yet implemented.** Council outcome: `rework_required` on the
> original scope-guard (Option A), **converged on Option B** with the conditions below.
> Implement under task `reviewFloorOptB` (security_sensitive); record the council outcome on it,
> build via `agent-runtime-engineer` under TDD, close via review-orchestrator.

## Problem

`effectiveRequiredReviews` (`src/domain/contracts.ts:369`) always seeds the full trio
(`reviewer, security_reviewer, qa_engineer`) as a hard floor; a packet's `requiredReviews`
can only *add*, never remove. So every task — even a one-line docs/memory change — needs three
orchestrator reviews to reach `approved`. Goal: let genuinely trivial, non-code, non-control-layer
tasks close with a single reviewer, **without** opening a hole for code/control-layer changes to
skip review. This touches the `seal-backdoors` review-integrity invariant, so it is
security-significant.

## Why Option B (and not Option A)

- **Option A (rejected):** derive the gate-relevant task class from `qualityGates` at gate-eval.
  Both council seats independently found this **unsound**: `qualityGates` lives in the packet
  `payload` jsonb, which `updateTask` (`src/store/postgres-store.ts:743`) rewrites wholesale —
  any authorized `updateTask` caller can rewrite `qualityGates` post-creation (`record-council.ts` already uses the
  `updateTask({...task, packet:{...task.packet, councilOutcome}})` spread — it writes
  `councilOutcome`, but the pattern overwrites the full packet jsonb, so any field including
  `qualityGates` is mutable this way); the "non-spoofable derivation" claim is false. The
  `else → docs_only` derivation default is also "deny-by-absence" (most permissive class as default),
  a fragile footing for a security invariant.
- **Option B (chosen):** an **immutable, insert-once `class` column** on `tasks`, set at creation,
  with `updateTask` rejecting any change to it. Classification is explicit (allowlist), auditable
  from the schema, and not derived from a mutable field.

## Design

1. **Immutable class (Condition 3).** Add a `class` column to `tasks` set once at INSERT (from the
   value `init-task` already validates against `VALID_TASK_CLASSES`), with a CHECK constraint and a
   server-side guard in `updateTask` that **rejects any change to `class`** after creation
   (phase-1 cheap guard: reject `qualityGates`/`class` mutation; phase-2: dedicated column). No
   gate-trusted class is ever read from a worker-writable field.

2. **Additive-at-gate-eval (Condition 1).** Keep the **full trio stored** in
   `packet.requiredReviews` so `validateTaskPacket` (`contracts.ts:694-711`) and packet storage are
   **unchanged**. Add a pure `effectiveRequiredReviewsForTask(task)` that returns `[reviewer]` only
   when `class ∈ OPT_OUT_TASK_CLASSES` AND `scopeIsReviewSafe(allowedWriteScope)`; otherwise the
   existing trio-or-more behavior. Migrate all three gate sites to it:
   `src/core/policy.ts:74` (`evaluateReviewDecision`), `policy.ts:123`
   (`collectUnsatisfiedReviewRoles`), `src/review.ts:953` (workflow-proof). Single chokepoint —
   no third path can drift.

3. **Unified TaskClass (Condition 2).** Replace the two divergent enums
   (`src/archon/task-queue.ts:5` `ALLOWED_TASK_CLASSES` vs `src/admin/init-task.ts:15`
   `VALID_TASK_CLASSES`) with one canonical source (`src/domain/task-class.ts`). The canonical
   enum is the 7-value union of the two existing constants —
   `prototype_slice, security_sensitive, release_candidate, docs_only, memory_curation, state_sync,
   scaffold_only` (preserve the legacy alias `implementation_slice → prototype_slice` from
   `task-queue.ts:12`). Plus `OPT_OUT_TASK_CLASSES = [docs_only, state_sync, memory_curation, scaffold_only]`,
   a compile-time guarantee `OptOutClass extends TaskClass`, and an exhaustive `switch` with a
   `never` default. No `class` column exists on `tasks` today, so adding it is additive.

4. **Deny-by-default scope-guard (Conditions 4 + 7).** `scopeIsReviewSafe(scope)`: false if scope
   is empty / `.` / `*` / a wildcard root, or if **any** entry matches `REVIEW_FLOOR_DENY_PREFIXES`.
   That shared list forces the full trio for control-layer roots (`.archon/rules`, `.archon/memory`,
   `.archon/ACTIVE`, `CLAUDE.md`, `AGENTS.md`, `.claude`, `.codex`) AND every path the
   repo-markdown indexer ingests — **import** `DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS` from
   `src/runtime/repo-markdown-indexer.ts` (README.md, AGENTS.md, docs, .agents/skills) so future
   include paths auto-deny; a parity test asserts indexer paths ⊆ deny-list. One bad entry poisons
   the whole task → trio. Normalization is hardened: NFKC + reject non-ASCII separators,
   backslash→slash, URL-decode-once with re-check, reject `..`/null bytes, **segment-aware** match
   (`srcdocs/` must not match `src/`). Reuse the existing `isDangerousManagedScopeEntry`
   (`init-task.ts:56`) matcher shape; do not duplicate logic.

5. **Mandatory provenance (Condition 5).** New migration `review_floor_reductions` with first-class
   columns (`derived_class`, `dropped_roles`, `effective_floor`, `write_scope_snapshot`, `basis`,
   `source`, `decided_at`) — queryable without parsing JSON. A row is written at gate-decision time
   (idempotent on `(run_id, task_id, decided_at)`). **Offline-can't-reduce invariant:** when the
   runtime is unreachable the hook refuses to reduce (full trio), so a reduction can never happen
   without a durable provenance row.

6. **Hook/runtime parity (Condition 6).** The Stop hook's `parseRequiredReviews`
   (`.claude/hooks/hook-utils.mjs`) must not diverge from the runtime floor. When connected, the
   hook reads `review_floor_reductions.effective_floor` as authority (no row → full trio); the ported
   `.mjs` predicate is used only offline. A `tests/review-floor-parity.test.ts` runs the identical
   class×scope matrix through the `.ts` and `.mjs` predicates and asserts identical results, with
   the one-directional safety property `offlineFloor ⊇ runtimeFloor` (offline is never weaker).
   (The pre-existing `## Required reviews: - none` template bug was already fixed separately in
   `renderTaskPacketMarkdown`.)

7. **Fold in the `--scope` newline-injection MEDIUM.** Apply `sanitizeMarkdownField`-style newline
   stripping to scope entries in `buildInitiativeRecords` so a crafted scope entry can't inject a
   fake `## Required reviews` section into the rendered packet.

## Threat model

| Attack | Closed by | Residual |
|--------|-----------|----------|
| Class spoof at creation | `init-task` validates against the canonical enum; `validateTaskPacket` rejects unknown | none |
| Class mutation post-creation | immutable column + `updateTask` rejects class change | none |
| Scope smuggling (mixed code+doc) | one non-safe entry → whole task forced to trio | none |
| Wildcard / empty scope | deny-by-default → trio | none |
| Markdown packet forgery | gate reads runtime DB, not markdown fallback | pre-existing offline assumption only |
| Content-blind doc (policy-weight `.md`) | control-layer + indexer paths are deny-listed → trio; provenance row recorded; packet can re-add `security_reviewer` | shrinks to informal work-area markdown not under a deny-listed root — **council accepts explicitly** |

## Test matrix (required to merge)

Class axis: all 4 opt-out classes (reduce-eligible) × the non-opt-out classes (always trio).
Scope axis: safe (`.archon/work/scratch`, `sandbox/`, `tmp/`); each deny-listed root individually
(`.archon/rules`, `.archon/memory`, `CLAUDE.md`, `AGENTS.md`, `.claude/...`, `.codex`, `README.md`,
`docs`, `.agents/skills`); adversarial normalization (`.\\claude`, `./.claude`, `CLAUDE.md/`,
URL-encoded `.claude%2Fhooks`, Unicode `∕`/`／`, `../CLAUDE.md`, `docs/../.claude`, null byte);
lookalikes that must stay safe (`srcdocs/x`, `readme-notes/x`); empty/`.`/`*` → trio; mixed
safe+deny → trio; additive packet `requiredReviews` still unions. Plus the anti-drift parity test
asserting all three gate chokepoints agree, and the `.ts`/`.mjs` parity property.

## Slice sequencing (each independently revertible; flag-gated)

1. `src/domain/task-class.ts` (unified enum, opt-out set, compile-time guard, shared deny-list +
   `scopeIsReviewSafe`); repoint `task-queue.ts` + `init-task.ts`. No floor change yet.
2. Immutable `class` column migration + `updateTask` guard.
3. `review_floor_reductions` migration + provenance write (flag default OFF).
4. `effectiveRequiredReviewsForTask` wired into the 3 gate sites (flag-gated).
5. Hook alignment (read `review_floor_reductions.effective_floor`; offline predicate port; parity
   test). **Never ship slice 4 before slice 5** — that window is the dual-authority divergence.
6. Flip the flag on.

## Rollback / reversibility

Predicate + wrapper + gate-site swaps are flag-gated and instantly revertible to full-trio. The
`class` column and `review_floor_reductions` table are additive migrations (droppable while empty;
the table holds audit history once live). Tasks closed under a reduced floor can be re-opened and
re-reviewed — nothing destructive.

## Key files

- `src/domain/contracts.ts` (`:369` `effectiveRequiredReviews`, `:694-711` `validateTaskPacket`,
  `:354` `canActorWaiveReview`)
- `src/domain/types.ts` (`:80` `requiredGateReviews`, `:477` `TaskPacketInput`)
- `src/core/policy.ts` (`:74`, `:123` gate sites), `src/review.ts` (`:953`)
- `src/archon/task-queue.ts` (`:5`), `src/admin/init-task.ts` (`:15`, `:48`, `:56`)
- `src/core/service.ts` (`:525` `mapTaskPacketToQueueClass`), `src/store/postgres-store.ts`
  (`:743` `updateTask`), `src/runtime/repo-markdown-indexer.ts` (include paths)
- `.claude/hooks/hook-utils.mjs` (`parseRequiredReviews`, runtime-authority read)
- New: `src/domain/task-class.ts`, a `review_floor_reductions` migration,
  `tests/review-floor-scope.test.ts`, `tests/review-floor-parity.test.ts`
