---
name: archon-forge-intent
description: Forge pipeline entry — covers forge_intent_brief and forge_taste_calibration stages; produces a structured intent brief and a taste-calibration artifact with explicit design constraints before any visual direction work begins.
---

# Archon Forge Intent

Covers pipeline stages: `forge_intent_brief` + `forge_taste_calibration`.

Use at the start of every forge run. These two stages are the prerequisite for all downstream stages. Without a closed intent brief and taste-calibration artifact, `archon-forge-direction` cannot start.

---

## Skill Composition

| Stage | Composes |
|---|---|
| `forge_intent_brief` | `archon-product-framing`, `archon-ux-research` |
| `forge_taste_calibration` | `archon-frontend` → `archon-frontend-taste`, `archon-visual-standards` |

Load the composed skills in the order above. Do not load all at once — intent brief closes before taste calibration begins.

---

## Stage 1 — `forge_intent_brief`

**Goal:** produce a structured intent brief that the direction stage can consume without ambiguity.

Required fields in the output brief:

| Field | Content |
|---|---|
| `targetDescription` | What is being built (matches `ForgeBuildRequest.targetDescription`) |
| `surface` | One of `none` / `visual_change` / `interactive_flow` (matches `ForgeBuildRequest.surface`) |
| `outputDir` | Repo-relative path, no `..`, no leading `/` (matches `ForgeBuildRequest.outputDir`) |
| `userGoal` | One sentence: what the user accomplishes with this UI |
| `primaryFriction` | The single highest-friction step from `archon-ux-research` |
| `outOfScope` | Explicit list of what this forge run must NOT touch |

The brief is the contract input to `buildForgePipelinePackets` in `src/forge/forge-pipeline.ts`. If any required field is missing or ambiguous, stop and request clarification before proceeding.

**Do not invent product requirements.** If the target description is vague, surface the ambiguity using `archon-ux-research` protocol and pause for operator input.

---

## Stage 2 — `forge_taste_calibration`

**Goal:** produce a taste-calibration artifact that hard-constrains all downstream visual decisions. Every constraint in this artifact is machine-checkable via `src/forge/anti-generic-checker.ts`.

Required fields in the calibration artifact:

| Constraint | Source |
|---|---|
| Surface type | dark-first dashboard / landing / form / other (from `archon-visual-standards`) |
| Accent color | Exactly one: `#6366F1` (indigo) unless task explicitly overrides with justification |
| Typeface | Geist Sans + Geist Mono; deviation requires written justification |
| Density | compact / standard / spacious — state explicitly |
| Motion ceiling | ≤ 200ms per `archon-visual-standards`; all animation must be purposeful |
| Inspiration refs | Source from `.archon/rules/frontend-inspiration-sources.md`; cite at least one |

Apply the `archon-frontend-taste` anti-generic checklist before closing this stage. All items must pass or be explicitly noted as out of scope.

**Hard rule:** if the calibration artifact allows gradient fills, more than one accent color, `box-shadow` elevation on dark surfaces, or border radius above 8px on data surfaces, the stage FAILS and must be rerun. These are the same constraints enforced deterministically by `anti-generic-checker.ts` at the `forge_visual_critic` stage. Catching them here costs nothing; catching them there costs a full repair cycle.

---

## Output

On stage close, produce:

1. `intent-brief.md` in `outputDir` — structured brief (fields above).
2. `taste-calibration.md` in `outputDir` — explicit constraints (fields above) + `archon-frontend-taste` checklist results.

Both files are inputs to `archon-forge-direction`.

---

## Anti-patterns

- Proceeding to direction with an open question in the intent brief.
- Calibration artifact that states "follow the design system" without specifying the five constraint dimensions.
- Citing inspiration without naming a specific UI from `.archon/rules/frontend-inspiration-sources.md`.
- Allowing any taste-calibration constraint that would auto-fail the C1 anti-generic gate at `forge_visual_critic`.
