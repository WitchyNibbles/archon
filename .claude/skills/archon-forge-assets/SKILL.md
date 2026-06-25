---
name: archon-forge-assets
description: Forge pipeline asset layer — covers forge_asset_plan, forge_asset_generation, forge_asset_manifest_reconcile, and forge_asset_qa stages; produces a reconciled asset manifest with deterministic QA before implementation starts.
---

# Archon Forge Assets

Covers pipeline stages: `forge_asset_plan` + `forge_asset_generation` + `forge_asset_manifest_reconcile` + `forge_asset_qa`.

Prerequisite: `archon-forge-direction` closed with `direction-approval.md` and `token-overrides.json` in `outputDir`.

---

## Skill Composition

| Stage | Composes |
|---|---|
| `forge_asset_plan` | `archon-visual-standards` (asset type vocabulary, placement constraints) |
| `forge_asset_generation` | `archon-accessibility-gate` (alt text requirement), `archon-visual-standards` |
| `forge_asset_manifest_reconcile` | none (mechanical reconciliation) |
| `forge_asset_qa` | `archon-accessibility-gate` (QA-003 alt text gate) |

---

## Stage 1 — `forge_asset_plan`

Produce one `AssetRequest` (schema: `src/forge/asset-contract.ts`, `AssetRequestSchema`) per required visual slot.

Allowed providers (MVP): `codex_builtin_imagegen`, `manual_upload`, `placeholder_svg`. The `openai_api_later_optional` provider is excluded from the MVP; do not reference it.

Each `AssetRequest` must specify:
- `id` — stable slug, unique within the plan
- `assetType` — one of the canonical types in `assetTypeValues` from `src/forge/asset-contract.ts`
- `provider` — required; one of `assetProviderValues` (`codex_builtin_imagegen` | `manual_upload` | `placeholder_svg`) from `src/forge/asset-contract.ts`
- `prompt` — generation text or provenance note (non-empty)
- `negativeConstraints` — explicit list of things to avoid (minimum: `["no gradient fill", "no generic SaaS aesthetic"]`)
- `altText` — non-empty, meaningful; empty string is a QA-003 failure
- `outputPath` — repo-relative, no `..`, no leading `/`
- `needsUserApproval` — default `true`; placeholder SVGs may use `false`

Save each request as a JSON file in `outputDir/asset-requests/`.

**C1 gate reminder:** asset visual choices made here (colors, shapes) must not introduce gradient fills, off-palette colors, or patterns that would produce `AG-001`, `AG-013`, or `AG-014` violations at `forge_visual_critic`. See `archon-forge-direction` for the full C1 gate definition. The gate is NON-WAIVABLE.

---

## Stage 2 — `forge_asset_generation`

For each approved `AssetRequest`:

| Provider | Action |
|---|---|
| `codex_builtin_imagegen` | Submit prompt to Codex `$imagegen`; save output to `outputPath` |
| `manual_upload` | Prompt operator to supply the file; block until received |
| `placeholder_svg` | Generate a minimal structurally-valid SVG placeholder; no raster content |

**CI / codex unavailable:** if `codex_builtin_imagegen` is unavailable (CI environment, no Codex session), fall back to `placeholder_svg` automatically. Record the fallback in the asset request status (`needs_regeneration`) so the operator can trigger real generation post-CI.

Update each `AssetRequest.status` to `generated` (or `needs_regeneration` on fallback) after the run.

---

## Stage 3 — `forge_asset_manifest_reconcile`

Build `AssetManifestEntry` records (schema: `src/forge/asset-contract.ts`, `AssetManifestEntrySchema`) from the generated asset files.

Stale detection: compare `sha256[:16]` of the current generation prompt against the `promptHash` stored in the manifest from a prior run. If they differ, set `qaStatus: "regenerate"` and flag the entry for operator review.

Track `usedIn` — list the component names or page routes where each asset is referenced.

Write `outputDir/asset-manifest.json`. The manifest is the single source of truth for downstream stages.

---

## Stage 4 — `forge_asset_qa`

Run `runAssetQA(assetPath, request, repoRoot)` from `src/forge/asset-qa.ts` on every manifest entry.

Mechanically-checkable rules (deterministic):

| Rule | Check |
|---|---|
| QA-001 | File exists at path |
| QA-002 | File extension matches `preferredFormat` |
| QA-003 | `altText` present and non-empty |
| QA-004 | SVG: no `<script>` tags |
| QA-005 | SVG: no `<image>` elements (no raster embedding) |
| QA-006 | SVG: no `on*` event attributes |
| QA-007 | Byte size ≤ 512 KB |
| QA-008 | SVG: structurally well-formed |
| QA-009 | SVG: no `xlink:href` attributes |

Non-mechanical checks are declared as `unchecked` findings in every report. They are NEVER silently skipped:

| Rule | Why unchecked |
|---|---|
| QA-U01 | Prompt match requires visual inspection or model review |
| QA-U02 | Brand fit requires design-system context |
| QA-U03 | Composition and crop safety require visual inspection at viewport sizes |

**If any finding has `severity === "fail"` (and `unchecked` is not `true`), the asset `qaStatus` is set to `"fail"` and the stage does NOT close.** The failing assets must be regenerated or replaced before `archon-forge-assets` hands off.

### C1 gate and repair contract (inherited from `archon-forge-direction`)

The full C1 NON-WAIVABLE two-tier anti-generic gate and the repair-consumes-typed-diff contract (#3) are defined in `archon-forge-direction`. The same rules apply here: no `hard_fail` Tier-1 violation can be waived; repair must consume the typed `AntiGenericReport.violations: Violation[]` diff (via `buildRepairPlan` from `src/forge/repair-plan.ts`), keyed by `AG-NNN` with optional `measured`/`cap`, never free-text prose alone.

---

## Output

On stage close:

1. `outputDir/asset-requests/` — one JSON file per `AssetRequest`.
2. `outputDir/asset-manifest.json` — reconciled `AssetManifestEntry[]`.
3. `outputDir/asset-qa-report.json` — `AssetQAReport[]`, one per manifest entry.

All three are inputs to `forge_frontend_spec`.

---

## Anti-patterns

- Silently omitting `unchecked` QA findings from the QA report.
- Proceeding past `forge_asset_qa` with any `severity === "fail"` finding that is not `unchecked`.
- Assigning `altText: ""` to any asset (immediate QA-003 failure).
- Using the `openai_api_later_optional` provider (excluded from MVP).
- Generating assets with gradient fills, off-palette colors, or raster `<image>` embeds in SVGs.
- Skipping the CI placeholder fallback — every codex-unavailable run must produce a valid placeholder so the pipeline does not stall.
- Acting on asset repair prose without a typed `Violation[]` diff (violates repair contract #3 from `archon-forge-direction`).
