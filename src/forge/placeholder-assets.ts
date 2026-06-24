/**
 * @module forge/placeholder-assets
 *
 * Deterministic placeholder SVG generator for the Archon Frontend Forge
 * pipeline (P1-S6).
 *
 * Given an AssetRequest (or assetType + size), emits a clean, intentional
 * placeholder SVG that:
 *   1. Respects CONSTRAINTS_MANIFEST tokens (dark surface, identity palette,
 *      Geist type) — imported by reference, no inline token tables.
 *   2. Legibly encodes the asset's type and purpose so an operator immediately
 *      understands which slot this placeholder fills.
 *   3. Is DETERMINISTIC: same input => byte-identical output.
 *   4. Contains NO <script>, NO <foreignObject>, NO external href/xlink:href,
 *      NO on* event attributes, NO <image> elements.
 *
 * Security guarantee: the generator is structurally incapable of emitting any
 * of the forbidden patterns because:
 *   - It uses a hand-built string template with only known-safe SVG elements
 *     (<svg>, <rect>, <text>, <line>, <circle>, <g>).
 *   - The only variable interpolated into the template is the assetType label
 *     and color tokens. Both are derived from the fixed vocabulary in this
 *     module — never from user-supplied free text.
 *   - altText (which is user-controlled) is NOT interpolated into the SVG body;
 *     it lives only in the AssetRequest record outside the SVG.
 *
 * Zero archon-service dependencies — safe to import from web/ or any tooling.
 */

import { CONSTRAINTS_MANIFEST } from "./constraints-manifest.ts";
import type { AssetRequest, AssetType } from "./asset-contract.ts";
import { assetTypeValues } from "./asset-contract.ts";

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/**
 * All supported asset types (re-exported from asset-contract for convenience).
 * Tests use this to assert coverage without duplicating the type list.
 */
export const ASSET_TYPES: ReadonlyArray<AssetType> = assetTypeValues;

// ---------------------------------------------------------------------------
// Token references (from CONSTRAINTS_MANIFEST — no inline table)
// ---------------------------------------------------------------------------

/** Dark surface base (#0A0A0A). Source: CONSTRAINTS_MANIFEST.identity.surfaceRamp.base */
const SURFACE_BASE = CONSTRAINTS_MANIFEST.identity.surfaceRamp.base;

/** Raised surface for inner panels (#111111). Source: CONSTRAINTS_MANIFEST.identity.surfaceRamp.raised */
const SURFACE_RAISED = CONSTRAINTS_MANIFEST.identity.surfaceRamp.raised;

/** Primary text (#EDEDED). Source: CONSTRAINTS_MANIFEST.identity.textHierarchy.primary */
const TEXT_PRIMARY = CONSTRAINTS_MANIFEST.identity.textHierarchy.primary;

/** Secondary/muted text (#A0A0A0). Source: CONSTRAINTS_MANIFEST.identity.textHierarchy.secondary */
const TEXT_SECONDARY = CONSTRAINTS_MANIFEST.identity.textHierarchy.secondary;

/** Accent base (#6366F1). Source: CONSTRAINTS_MANIFEST.identity.accent.base */
const ACCENT_BASE = CONSTRAINTS_MANIFEST.identity.accent.base;

/** Accent bright (#818CF8). Source: CONSTRAINTS_MANIFEST.identity.accent.bright */
const ACCENT_BRIGHT = CONSTRAINTS_MANIFEST.identity.accent.bright;

/** Geist Sans typeface. Source: CONSTRAINTS_MANIFEST.identity.typefaces.sans */
const FONT_SANS = CONSTRAINTS_MANIFEST.identity.typefaces.sans;

/** Geist Mono typeface. Source: CONSTRAINTS_MANIFEST.identity.typefaces.mono */
const FONT_MONO = CONSTRAINTS_MANIFEST.identity.typefaces.mono;

/**
 * Status colors for the browser-mockup traffic-light dots — sourced from the
 * manifest (C9: no inline token table). These are decorative fill dots, not
 * text, so the fill-base statusColors set is correct here (not statusTextColors).
 */
const STATUS_ERROR = CONSTRAINTS_MANIFEST.identity.statusColors.error;
const STATUS_WARNING = CONSTRAINTS_MANIFEST.identity.statusColors.warning;
const STATUS_SUCCESS = CONSTRAINTS_MANIFEST.identity.statusColors.success;

// ---------------------------------------------------------------------------
// Per-assetType dimensions (width x height in SVG user units)
//
// These dimensions encode the intended use of each slot:
//   - hero: wide landscape (1200×630) — full-bleed header background
//   - spot_illustration: square (400×400) — inline illustration
//   - background_texture: wide (1200×800) — repeating/stretching bg
//   - empty_state: portrait (400×320) — empty-state panel
//   - icon: square (96×96) — icon slot
//   - social_preview: wide OG (1200×630) — OG meta image
//   - product_mockup_frame: landscape (800×600) — product screenshot frame
//   - decorative_shape: square (200×200) — decorative element
// ---------------------------------------------------------------------------

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

const DIMENSIONS: Readonly<Record<AssetType, Dimensions>> = {
  hero:                   { width: 1200, height: 630  },
  spot_illustration:      { width: 400,  height: 400  },
  background_texture:     { width: 1200, height: 800  },
  empty_state:            { width: 400,  height: 320  },
  icon:                   { width: 96,   height: 96   },
  social_preview:         { width: 1200, height: 630  },
  product_mockup_frame:   { width: 800,  height: 600  },
  decorative_shape:       { width: 200,  height: 200  }
};

// ---------------------------------------------------------------------------
// Per-assetType label (human-readable slot name for the legibility requirement)
// ---------------------------------------------------------------------------

const LABELS: Readonly<Record<AssetType, string>> = {
  hero:                   "hero",
  spot_illustration:      "spot illustration",
  background_texture:     "background texture",
  empty_state:            "empty state",
  icon:                   "icon",
  social_preview:         "social preview",
  product_mockup_frame:   "product mockup frame",
  decorative_shape:       "decorative shape"
};

// ---------------------------------------------------------------------------
// Per-assetType decorative motif generator
//
// Each motif is a pure string of SVG elements (no <script>, no <image>,
// no external refs). The motif makes each placeholder visually distinct so
// operators can immediately identify the slot type.
// ---------------------------------------------------------------------------

function heroMotif(w: number, h: number): string {
  const cx = Math.round(w * 0.75);
  const cy = Math.round(h * 0.5);
  const r = Math.round(Math.min(w, h) * 0.28);
  return [
    // Subtle arc cluster — editorial, architectural
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ACCENT_BASE}" stroke-width="1" opacity="0.35"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${Math.round(r * 0.65)}" fill="none" stroke="${ACCENT_BRIGHT}" stroke-width="0.75" opacity="0.25"/>`,
    // Vertical rule — separates text zone from image zone
    `<line x1="${Math.round(w * 0.55)}" y1="${Math.round(h * 0.1)}" x2="${Math.round(w * 0.55)}" y2="${Math.round(h * 0.9)}" stroke="${ACCENT_BASE}" stroke-width="0.5" opacity="0.3"/>`,
    // Horizontal grid lines — reference grid feel
    `<line x1="${Math.round(w * 0.55)}" y1="${Math.round(h * 0.3)}" x2="${w}" y2="${Math.round(h * 0.3)}" stroke="${TEXT_SECONDARY}" stroke-width="0.5" opacity="0.15"/>`,
    `<line x1="${Math.round(w * 0.55)}" y1="${Math.round(h * 0.7)}" x2="${w}" y2="${Math.round(h * 0.7)}" stroke="${TEXT_SECONDARY}" stroke-width="0.5" opacity="0.15"/>`
  ].join("\n  ");
}

function spotIllustrationMotif(w: number, h: number): string {
  const cx = Math.round(w * 0.5);
  const cy = Math.round(h * 0.45);
  const r = Math.round(Math.min(w, h) * 0.3);
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SURFACE_RAISED}" stroke="${ACCENT_BASE}" stroke-width="1.5" opacity="0.6"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${Math.round(r * 0.5)}" fill="none" stroke="${ACCENT_BRIGHT}" stroke-width="1" opacity="0.4"/>`,
    `<line x1="${Math.round(w * 0.2)}" y1="${Math.round(h * 0.5)}" x2="${Math.round(w * 0.8)}" y2="${Math.round(h * 0.5)}" stroke="${ACCENT_BASE}" stroke-width="0.75" opacity="0.25"/>`
  ].join("\n  ");
}

function backgroundTextureMotif(w: number, h: number): string {
  const lines: string[] = [];
  const step = 80;
  const count = Math.ceil(w / step) + 1;
  for (let i = 0; i <= count; i++) {
    const x = i * step;
    lines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${ACCENT_BASE}" stroke-width="0.5" opacity="0.07"/>`
    );
  }
  const rowCount = Math.ceil(h / step) + 1;
  for (let j = 0; j <= rowCount; j++) {
    const y = j * step;
    lines.push(
      `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${ACCENT_BASE}" stroke-width="0.5" opacity="0.07"/>`
    );
  }
  // Accent dot at crossings (sparse)
  for (let i = 1; i < count; i += 3) {
    for (let j = 1; j < rowCount; j += 3) {
      lines.push(
        `<circle cx="${i * step}" cy="${j * step}" r="1.5" fill="${ACCENT_BASE}" opacity="0.2"/>`
      );
    }
  }
  return lines.join("\n  ");
}

function emptyStateMotif(w: number, h: number): string {
  const cx = Math.round(w * 0.5);
  const cy = Math.round(h * 0.42);
  const size = Math.round(Math.min(w, h) * 0.22);
  return [
    // Simple inbox/empty-tray icon abstraction
    `<rect x="${cx - size}" y="${cy - size * 0.7}" width="${size * 2}" height="${size * 1.4}" rx="4" ry="4" fill="none" stroke="${ACCENT_BASE}" stroke-width="1.5" opacity="0.5"/>`,
    `<line x1="${cx - size * 0.5}" y1="${cy + size * 0.1}" x2="${cx + size * 0.5}" y2="${cy + size * 0.1}" stroke="${ACCENT_BRIGHT}" stroke-width="1.5" opacity="0.4"/>`,
    `<line x1="${cx}" y1="${cy - size * 0.35}" x2="${cx}" y2="${cy + size * 0.35}" stroke="${ACCENT_BASE}" stroke-width="1" opacity="0.35"/>`
  ].join("\n  ");
}

function iconMotif(w: number, h: number): string {
  const cx = Math.round(w * 0.5);
  const cy = Math.round(h * 0.5);
  const r = Math.round(Math.min(w, h) * 0.3);
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ACCENT_BASE}" stroke-width="2" opacity="0.7"/>`,
    `<line x1="${cx - Math.round(r * 0.5)}" y1="${cy}" x2="${cx + Math.round(r * 0.5)}" y2="${cy}" stroke="${ACCENT_BRIGHT}" stroke-width="1.5" opacity="0.6"/>`,
    `<line x1="${cx}" y1="${cy - Math.round(r * 0.5)}" x2="${cx}" y2="${cy + Math.round(r * 0.5)}" stroke="${ACCENT_BRIGHT}" stroke-width="1.5" opacity="0.6"/>`
  ].join("\n  ");
}

function socialPreviewMotif(w: number, h: number): string {
  // OG image layout: logo zone left, brand mark right
  const brandX = Math.round(w * 0.7);
  const brandY = Math.round(h * 0.5);
  const r = Math.round(Math.min(w, h) * 0.18);
  return [
    `<circle cx="${brandX}" cy="${brandY}" r="${r}" fill="${SURFACE_RAISED}" stroke="${ACCENT_BASE}" stroke-width="1.5" opacity="0.5"/>`,
    `<circle cx="${brandX}" cy="${brandY}" r="${Math.round(r * 0.55)}" fill="${ACCENT_BASE}" opacity="0.18"/>`,
    `<line x1="${Math.round(w * 0.08)}" y1="${Math.round(h * 0.75)}" x2="${Math.round(w * 0.55)}" y2="${Math.round(h * 0.75)}" stroke="${TEXT_SECONDARY}" stroke-width="0.75" opacity="0.3"/>`
  ].join("\n  ");
}

function productMockupFrameMotif(w: number, h: number): string {
  const pad = Math.round(Math.min(w, h) * 0.06);
  const innerW = w - pad * 2;
  const innerH = h - pad * 2 - Math.round(h * 0.08);
  const barH = Math.round(h * 0.08);
  return [
    // Browser chrome
    `<rect x="${pad}" y="${pad}" width="${innerW}" height="${barH}" fill="${SURFACE_RAISED}" stroke="${ACCENT_BASE}" stroke-width="0.75" opacity="0.5" rx="3" ry="3"/>`,
    // Traffic light dots
    `<circle cx="${pad + 16}" cy="${pad + Math.round(barH * 0.5)}" r="4" fill="${STATUS_ERROR}" opacity="0.5"/>`,
    `<circle cx="${pad + 30}" cy="${pad + Math.round(barH * 0.5)}" r="4" fill="${STATUS_WARNING}" opacity="0.5"/>`,
    `<circle cx="${pad + 44}" cy="${pad + Math.round(barH * 0.5)}" r="4" fill="${STATUS_SUCCESS}" opacity="0.5"/>`,
    // URL bar
    `<rect x="${pad + 60}" y="${pad + 6}" width="${Math.round(innerW * 0.45)}" height="${Math.round(barH * 0.55)}" fill="${SURFACE_BASE}" rx="2" ry="2" opacity="0.7"/>`,
    // Content area
    `<rect x="${pad}" y="${pad + barH}" width="${innerW}" height="${innerH}" fill="${SURFACE_BASE}" stroke="${ACCENT_BASE}" stroke-width="0.75" opacity="0.35"/>`,
    // Content line placeholders
    `<rect x="${pad + 16}" y="${pad + barH + 24}" width="${Math.round(innerW * 0.6)}" height="8" fill="${ACCENT_BASE}" rx="2" ry="2" opacity="0.2"/>`,
    `<rect x="${pad + 16}" y="${pad + barH + 42}" width="${Math.round(innerW * 0.4)}" height="6" fill="${TEXT_SECONDARY}" rx="2" ry="2" opacity="0.15"/>`,
    `<rect x="${pad + 16}" y="${pad + barH + 58}" width="${Math.round(innerW * 0.55)}" height="6" fill="${TEXT_SECONDARY}" rx="2" ry="2" opacity="0.15"/>`
  ].join("\n  ");
}

function decorativeShapeMotif(w: number, h: number): string {
  const cx = Math.round(w * 0.5);
  const cy = Math.round(h * 0.5);
  const s = Math.round(Math.min(w, h) * 0.35);
  return [
    // Diamond / rotated square
    `<polygon points="${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}" fill="none" stroke="${ACCENT_BASE}" stroke-width="1.5" opacity="0.55"/>`,
    `<polygon points="${cx},${cy - Math.round(s * 0.5)} ${cx + Math.round(s * 0.5)},${cy} ${cx},${cy + Math.round(s * 0.5)} ${cx - Math.round(s * 0.5)},${cy}" fill="${ACCENT_BASE}" opacity="0.12"/>`
  ].join("\n  ");
}

// ---------------------------------------------------------------------------
// Motif dispatch
// ---------------------------------------------------------------------------

function buildMotif(assetType: AssetType, width: number, height: number): string {
  switch (assetType) {
    case "hero":                  return heroMotif(width, height);
    case "spot_illustration":     return spotIllustrationMotif(width, height);
    case "background_texture":    return backgroundTextureMotif(width, height);
    case "empty_state":           return emptyStateMotif(width, height);
    case "icon":                  return iconMotif(width, height);
    case "social_preview":        return socialPreviewMotif(width, height);
    case "product_mockup_frame":  return productMockupFrameMotif(width, height);
    case "decorative_shape":      return decorativeShapeMotif(width, height);
    // TypeScript exhaustiveness — the compiler enforces this is unreachable
    // if assetTypeValues is extended without updating this switch.
    default: {
      const _exhaustive: never = assetType;
      throw new Error(`Unhandled assetType: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// SVG builder
//
// All elements are hard-coded SVG primitives. The only interpolated values are:
//   - width / height: numbers (not user text)
//   - assetType label: from LABELS (a fixed vocabulary, not user input)
//   - color tokens: from CONSTRAINTS_MANIFEST (fixed at module load)
//   - motif: from buildMotif (pure geometric primitives)
//
// This is structurally incapable of emitting <script>, on* events,
// external href, xlink:href, or <image>.
// ---------------------------------------------------------------------------

function buildSvg(assetType: AssetType, width: number, height: number): string {
  const label = LABELS[assetType];
  const motif = buildMotif(assetType, width, height);

  // Label positioning: centered in the lower third for most types.
  // For icon (small 96x96), keep the label compact.
  const isSmall = width < 200;
  const labelFontSize = isSmall ? 10 : 13;
  const labelY = isSmall
    ? Math.round(height * 0.88)
    : Math.round(height * 0.86);
  const labelX = Math.round(width * 0.5);

  // "PLACEHOLDER" marker — monospaced, top-left, very subtle
  const markerFontSize = isSmall ? 7 : 10;
  const markerX = isSmall ? 4 : 16;
  const markerY = isSmall ? 10 : 20;

  // Divider line above label
  const lineY = isSmall
    ? Math.round(height * 0.78)
    : Math.round(height * 0.78);
  const lineX1 = isSmall ? 8 : Math.round(width * 0.15);
  const lineX2 = width - lineX1;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <!-- Archon Frontend Forge — committed placeholder SVG -->`,
    `  <!-- assetType: ${label} -->`,
    `  <!-- Generated by src/forge/placeholder-assets.ts — DO NOT hand-edit -->`,
    ``,
    `  <!-- Base surface -->`,
    `  <rect width="${width}" height="${height}" fill="${SURFACE_BASE}"/>`,
    ``,
    `  <!-- Per-type decorative motif -->`,
    `  ${motif}`,
    ``,
    `  <!-- Divider -->`,
    `  <line x1="${lineX1}" y1="${lineY}" x2="${lineX2}" y2="${lineY}" stroke="${TEXT_SECONDARY}" stroke-width="0.5" opacity="0.4"/>`,
    ``,
    `  <!-- Asset type label -->`,
    `  <text`,
    `    x="${labelX}"`,
    `    y="${labelY}"`,
    `    fill="${TEXT_PRIMARY}"`,
    `    font-family="${FONT_SANS}, sans-serif"`,
    `    font-size="${labelFontSize}"`,
    `    font-weight="500"`,
    `    letter-spacing="-0.01em"`,
    `    text-anchor="middle"`,
    `    opacity="0.85"`,
    `  >${label}</text>`,
    ``,
    `  <!-- PLACEHOLDER marker -->`,
    `  <text`,
    `    x="${markerX}"`,
    `    y="${markerY}"`,
    `    fill="${ACCENT_BRIGHT}"`,
    `    font-family="${FONT_MONO}, monospace"`,
    `    font-size="${markerFontSize}"`,
    `    font-weight="500"`,
    `    letter-spacing="0.05em"`,
    `    opacity="0.45"`,
    `  >PLACEHOLDER</text>`,
    `</svg>`
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic placeholder SVG for the given AssetRequest.
 *
 * The output is byte-identical for the same assetType input. Determinism is
 * guaranteed because:
 *   1. All color tokens are sourced from CONSTRAINTS_MANIFEST (immutable at
 *      module load time).
 *   2. The label is sourced from LABELS (fixed vocabulary).
 *   3. Dimensions are sourced from DIMENSIONS (fixed vocabulary).
 *   4. The motif is built from pure arithmetic on the fixed dimensions.
 *   5. No random, date, or environment values are ever interpolated.
 *
 * Security:
 *   - No <script> elements.
 *   - No external href or xlink:href.
 *   - No on* event attributes.
 *   - No <image> elements (no raster embedding).
 *   - No <foreignObject> elements.
 *   - The only user-controlled value (altText) is NOT interpolated into the SVG.
 *
 * @param request - The AssetRequest for which to generate the placeholder.
 * @returns A valid SVG string (UTF-8, no BOM).
 */
export function generatePlaceholderSvg(request: AssetRequest): string {
  const { assetType } = request;
  const { width, height } = DIMENSIONS[assetType];
  return buildSvg(assetType, width, height);
}
