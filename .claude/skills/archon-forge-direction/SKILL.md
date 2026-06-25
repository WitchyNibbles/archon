---
name: archon-forge-direction
description: Forge pipeline direction layer — covers forge_design_directions, forge_direction_approval, and forge_design_system_tokens stages; enforces condition #2 (≥2 divergent DirectionSet with contrast rationale) and the C1 NON-WAIVABLE two-tier anti-generic gate.
---

# Archon Forge Direction

Covers pipeline stages: `forge_design_directions` + `forge_direction_approval` + `forge_design_system_tokens`.

Prerequisite: both `archon-forge-intent` stages closed with `intent-brief.md` and `taste-calibration.md` in `outputDir`.

---

## Skill Composition

| Stage | Composes |
|---|---|
| `forge_design_directions` | `archon-visual-standards`, `archon-design-system` |
| `forge_direction_approval` | `archon-visual-standards` (contrast verification via `wcag-contrast.ts`) |
| `forge_design_system_tokens` | `archon-design-system` |

---

## Stage 1 — `forge_design_directions`

### Condition #2 (BINDING, non-waivable)

Emit a Zod-validated `DirectionSet` (array of `DesignDirection`) as defined in `src/forge/design-direction-contract.ts`. The schema enforces all field requirements; do not restate the schema here.

**Hard rules:**

1. The `DirectionSet` MUST contain ≥ 2 directions. Fewer than 2 is an immediate `DD-001 hard_fail` from `checkDirectionDivergence` in `src/forge/direction-divergence.ts`. This blocks the stage.
2. Every pair of directions MUST diverge on ≥ 2 of 5 strategy axes (layout, typography, color, asset, interaction). Divergence is measured by Jaccard similarity < 0.5 on tokenized strategy text. Near-identical strategies are a `DD-002 hard_fail`. "1 real + 1 cosmetic decoy" is explicitly forbidden.
3. Every direction MUST include a non-empty `whyItIsNotGeneric` array. Empty or whitespace-only entries are a `DD-003 hard_fail`.

Run `checkDirectionDivergence(directionSet)` from `src/forge/direction-divergence.ts`. If `DirectionDivergenceResult.passed === false`, the direction set MUST be regenerated. The gate cannot be bypassed, deferred, or waived.

### Per-direction contrast rationale

For each direction, the contrast rationale MUST be carried as `whyItIsNotGeneric` entries. **Do NOT place it in a separate sibling field on the direction object — `DesignDirectionSchema` strips unknown keys on Zod parse, so any rationale outside `whyItIsNotGeneric` is silently dropped after validation.** The rationale cites the measured WCAG contrast ratio between the primary text token and the primary surface token for that direction, computed with `contrastRatio(fg, bg)` from `src/forge/wcag-contrast.ts`. Cite the numeric result (e.g. "12.4:1 vs AA minimum 4.5:1"). Rationale stating only "meets WCAG" without a measured value is rejected.

---

## C1 — NON-WAIVABLE Two-Tier Anti-Generic Gate

This gate applies to all output from `forge_design_directions` onward and is re-evaluated at `forge_visual_critic`. It is encoded here because direction is where generic patterns enter; catching them here avoids a repair cycle later.

### Tier 1 — Deterministic (auto-blocking)

`runAntiGenericChecker(snapshot)` from `src/forge/anti-generic-checker.ts` evaluates the rendered DOM's computed styles against the `CONSTRAINTS_MANIFEST` constraint set. Output is `AntiGenericReport.violations: Violation[]` (type `Violation` in `src/forge/anti-generic-types.ts`) where each violation carries:
- `agId` — stable `AG-NNN` identifier (required)
- `severity` — `"hard_fail"` or `"warning"` (required)
- `message` — full human-readable description (required)
- `measured` — what was actually found (OPTIONAL — present for numeric rules, may be absent)
- `cap` — the constraint limit (OPTIONAL — present for numeric rules, may be absent)

**If `AntiGenericReport.blocking === true` (any `hard_fail` present), the pipeline state is `rework`. This is automatic and CANNOT be waived, deferred, or overridden by operator approval or any prose justification.** The only resolution is repair that eliminates the `hard_fail` violations.

`checkGenericCopy(input)` from `src/forge/generic-copy-checker.ts` evaluates copy blocks against `CG-NNN` rules (forbidden SaaS phrases, feature-card-soup heuristic, placeholder text). If `CopyReport.blocking === true` (≥ 3 findings), the copy must be regenerated before implementation.

### Tier 2 — Advisory (LLM)

`buildVisualCritique(inputs)` from `src/forge/visual-critique.ts` provides an advisory verdict comparing output against benchmark references for the residual taste judgment not captured by numeric rules. Tier-2 alone can recommend `rework` but its verdict is labeled `advisory`; it does not auto-block. Only Tier-1 `hard_fail` violations are auto-blocking.

Tier-2 advisory findings MUST be surfaced to the operator. They cannot be silently suppressed.

**Unchecked rules** (`AntiGenericReport.uncheckedRules`) must always be visible to the caller. They are never hidden.

### Repair contract (Condition #3, NON-WAIVABLE)

When the gate returns `rework`, the repair stage (`forge_repair`) consumes the typed `AntiGenericReport.violations: Violation[]` diff from Tier-1 (plus optional `AssetQAReport[]`), turned into a `RepairPlan` by `buildRepairPlan(antiGeneric, assetQa?)` from `src/forge/repair-plan.ts`. Each `Violation` is addressed by its `agId` (`AG-NNN`); when `measured`/`cap` are present (numeric rules) the fix is confirmed with a measured-vs-cap value. The repair role MUST close each violation by its `AG-NNN` id.

**HARD RULE: the repair stage is FORBIDDEN from acting on free-text "improve" or prose critique alone.** If the only input is prose from Tier-2 advisory, there is nothing to repair deterministically. The typed `Violation[]` (via `buildRepairPlan`) is the repair input. If it is empty (no `hard_fail`), the pipeline is not in `rework` from Tier-1.

---

## Stage 2 — `forge_direction_approval`

Operator-approval stop is MANDATORY before tokens are generated. No token stage may start while direction approval is pending.

Present the operator with:
1. The full `DirectionSet` JSON (Zod-validated).
2. The `DirectionDivergenceResult` (passed/violations).
3. Per-direction contrast rationale extracted from each direction's `whyItIsNotGeneric` entries, with measured WCAG ratios.
4. The Tier-2 advisory verdict from `buildVisualCritique` if available.

Operator selects exactly one direction. Record the selection before proceeding.

---

## Stage 3 — `forge_design_system_tokens`

Produce a token override proposal for the selected direction. Validate the proposal using `validateDesignSystem(proposal)` from `src/forge/design-system-validator.ts` — that module is the single source of truth for the `DS-NNN` rule set (one-accent, no-gradient, radius/motion caps, per-slot justification, etc.); do not restate the rules here (they drift). If `DesignSystemValidation.passed === false`, fix every violation by its `DS-NNN` id before closing the stage. The token set must be clean before `archon-forge-assets` starts.

Tokens reference `archon-design-system` for the token-naming rules and `archon-visual-standards` for the base values.

---

## Output

On stage close:

1. `direction-set.json` — Zod-validated `DirectionSet`.
2. `divergence-result.json` — `DirectionDivergenceResult` (must show `passed: true`).
3. `direction-approval.md` — operator selection record + per-direction contrast rationale.
4. `token-overrides.json` — validated token proposal (`DesignSystemValidation.passed: true`).

All four files are inputs to `archon-forge-assets`.

---

## Anti-patterns

- Direction set with only one real direction and a cosmetic variant (DD-002 hard_fail).
- Contrast rationale without a measured numeric ratio.
- Proceeding to tokens before operator direction approval.
- Token proposal not run through `design-system-validator.ts`.
- Suppressing `uncheckedRules` from the operator view.
- Repairing on prose alone instead of the typed `Violation[]` diff (via `buildRepairPlan`).
- Any claim that a Tier-1 `hard_fail` has been waived or excepted.
