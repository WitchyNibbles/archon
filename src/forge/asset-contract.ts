/**
 * @module forge/asset-contract
 *
 * Asset-layer contract for the Archon Frontend Forge pipeline (P1-S6).
 *
 * Strict Zod schemas for AssetRequest (§6.5) and AssetManifestEntry (§6.6)
 * of docs/archon_frontend_forge_codex_imagegen_roadmap.md.
 *
 * MVP providers per §12: codex_builtin_imagegen, manual_upload, placeholder_svg.
 * No api-key provider in MVP.
 *
 * Style mirrors src/forge/dashboard-contract.ts:
 *   - Zod schemas with .strict() (no .passthrough())
 *   - Exported inferred TypeScript types
 *   - JSDoc on every field
 *
 * Zero runtime dependencies on archon services — safe to import from web/ or
 * any tooling layer.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// AssetRequest discriminant values (exported for tests and runtime)
// ---------------------------------------------------------------------------

/**
 * MVP asset providers. Per §12 of the roadmap:
 *   - codex_builtin_imagegen: Codex CLI $imagegen, no API key required
 *   - manual_upload: user-owned brand assets, logos, screenshots
 *   - placeholder_svg: cheap drafts, test fixtures, CI runs
 *
 * openai_api_later_optional is explicitly NOT included in the MVP.
 */
export const assetProviderValues = [
  "codex_builtin_imagegen",
  "manual_upload",
  "placeholder_svg"
] as const;

export type AssetProvider = typeof assetProviderValues[number];

/**
 * Canonical asset type vocabulary. Each type represents a distinct visual slot
 * in the page layout, with a different purpose, crop requirement, and generation
 * strategy.
 */
export const assetTypeValues = [
  "hero",
  "spot_illustration",
  "background_texture",
  "empty_state",
  "icon",
  "social_preview",
  "product_mockup_frame",
  "decorative_shape"
] as const;

export type AssetType = typeof assetTypeValues[number];

/**
 * Preferred output size (aspect ratio hint for the codex generator).
 */
export const preferredSizeValues = [
  "square",
  "portrait",
  "landscape",
  "wide",
  "auto"
] as const;

export type PreferredSize = typeof preferredSizeValues[number];

/**
 * Preferred output format. svg added beyond the roadmap's webp|png|jpeg
 * because placeholder_svg produces SVG natively and QA needs to match format.
 */
export const preferredFormatValues = [
  "webp",
  "png",
  "jpeg",
  "svg"
] as const;

export type PreferredFormat = typeof preferredFormatValues[number];

/**
 * Background treatment hint for the generator.
 */
export const backgroundValues = [
  "transparent",
  "opaque",
  "auto"
] as const;

export type Background = typeof backgroundValues[number];

/**
 * Lifecycle status for an asset request through the pipeline.
 */
export const assetStatusValues = [
  "planned",
  "approved",
  "sent_to_codex",
  "generated",
  "needs_regeneration",
  "needs_action",
  "rejected"
] as const;

export type AssetStatus = typeof assetStatusValues[number];

/**
 * QA lifecycle status for a manifest entry.
 */
export const qaStatusValues = [
  "pending",
  "pass",
  "fail",
  "regenerate"
] as const;

export type QAStatus = typeof qaStatusValues[number];

// ---------------------------------------------------------------------------
// AssetRequestSchema (§6.5)
//
// Faithful port of the roadmap's Pydantic AssetRequest to Zod/TS.
// Field names converted to camelCase. .strict() enforced (no passthrough).
// ---------------------------------------------------------------------------

/**
 * A structured request for a single visual asset in the Frontend Forge pipeline.
 *
 * Each AssetRequest describes exactly one asset slot: what it is, who generates
 * it, where it goes, and what the generator should produce. This is the single
 * source of truth that flows from the asset planner through generation, QA,
 * and manifest reconciliation.
 *
 * Source: §6.5 of docs/archon_frontend_forge_codex_imagegen_roadmap.md
 */
export const AssetRequestSchema = z.object({
  /**
   * Stable unique identifier for this asset slot (slug-style).
   * Used as the key in the manifest and in asset request JSON files.
   */
  id: z.string().min(1),

  /**
   * The generation provider.
   * MVP providers: codex_builtin_imagegen | manual_upload | placeholder_svg.
   * openai_api_later_optional is explicitly excluded from the MVP.
   */
  provider: z.enum(assetProviderValues),

  /**
   * Semantic category of this asset slot.
   * Drives generation strategy, crop requirements, and QA rules.
   */
  assetType: z.enum(assetTypeValues),

  /**
   * Human-readable explanation of what this asset is for.
   * Guides the generator and the visual critic.
   */
  purpose: z.string().min(1),

  /**
   * Where on the page / in which component this asset is used.
   * Example: "HomeHero background/right-side visual"
   */
  placement: z.string().min(1),

  /**
   * Generation prompt text (for codex_builtin_imagegen) or provenance note
   * (for manual_upload / placeholder_svg).
   */
  prompt: z.string().min(1),

  /**
   * List of things the generator must avoid.
   * Example: ["no readable text", "no logo", "no generic gradient"]
   */
  negativeConstraints: z.array(z.string()).default([]),

  /**
   * Preferred aspect-ratio / size hint for the generator.
   * Default: "wide" (1200×630-ish, good for hero and social preview slots).
   */
  preferredSize: z.enum(preferredSizeValues).default("wide"),

  /**
   * Preferred output format.
   * svg added to support the placeholder_svg provider natively.
   * Default: "webp" (best compression for web delivery).
   */
  preferredFormat: z.enum(preferredFormatValues).default("webp"),

  /**
   * Background treatment.
   * transparent: for icons, decorative_shape, spot_illustration with overlay use.
   * opaque: for hero, background_texture, social_preview.
   * auto: let the generator decide.
   */
  background: z.enum(backgroundValues).default("auto"),

  /**
   * Repo-relative path where the generated asset should be saved.
   * Example: "web/public/generated/hero.webp"
   */
  outputPath: z.string().min(1),

  /**
   * Alt text for this asset (accessibility-required, non-optional).
   * Must be meaningful — empty string is a QA failure.
   */
  altText: z.string().min(1),

  /**
   * Whether this asset requires operator approval before being integrated.
   * Default: true (conservative). Placeholder SVGs may set false.
   */
  needsUserApproval: z.boolean().default(true),

  /**
   * Lifecycle status of this asset request.
   * Default: "planned" (not yet approved or sent to generator).
   */
  status: z.enum(assetStatusValues).default("planned")
}).strict();

export type AssetRequest = z.infer<typeof AssetRequestSchema>;

// ---------------------------------------------------------------------------
// AssetManifestEntrySchema (§6.6)
//
// Faithful port of the roadmap's Pydantic AssetManifestEntry to Zod/TS.
// Field names converted to camelCase. .strict() enforced.
// provider field extended to include all MVP providers (not just codex).
// ---------------------------------------------------------------------------

/**
 * A single entry in the asset manifest. Represents the state of one generated
 * (or committed fallback) asset as tracked by the manifest reconciler.
 *
 * Source: §6.6 of docs/archon_frontend_forge_codex_imagegen_roadmap.md
 */
export const AssetManifestEntrySchema = z.object({
  /**
   * Stable unique identifier. Matches the AssetRequest.id that created this entry.
   */
  id: z.string().min(1),

  /**
   * The provider that generated or sourced this asset.
   */
  provider: z.enum(assetProviderValues),

  /**
   * Asset type (matches AssetRequest.assetType).
   */
  type: z.string().min(1),

  /**
   * Repo-relative or absolute path to the asset file on disk.
   */
  path: z.string().min(1),

  /**
   * sha256[:16] of the generation prompt. Used to detect when a prompt has
   * changed since last generation (stale detection by the reconciler).
   */
  promptHash: z.string().min(1),

  /**
   * Path to the original AssetRequest JSON file that created this entry.
   */
  originalRequestPath: z.string().min(1),

  /**
   * Alt text for this asset (mirrors AssetRequest.altText at generation time).
   */
  alt: z.string().min(1),

  /**
   * List of component names / page routes where this asset is referenced.
   */
  usedIn: z.array(z.string()),

  /**
   * Whether an operator has explicitly approved this asset for integration.
   * Default: false (conservative — requires explicit approval gate).
   */
  approved: z.boolean().default(false),

  /**
   * Attribution for who/what generated this asset.
   * Examples: "codex:$imagegen", "placeholder_svg", "manual_upload"
   */
  generatedBy: z.string().min(1),

  /**
   * QA pipeline status for this asset.
   * Default: "pending" (not yet evaluated).
   */
  qaStatus: z.enum(qaStatusValues).default("pending"),

  /**
   * Free-form notes from the QA validator or visual critic.
   */
  notes: z.array(z.string()).default([])
}).strict();

export type AssetManifestEntry = z.infer<typeof AssetManifestEntrySchema>;
