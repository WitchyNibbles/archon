/**
 * Tests for src/forge/placeholder-assets.ts
 *
 * TDD: failing tests written before implementation.
 *
 * Verifies:
 *   1. Generator is deterministic (same input => identical bytes)
 *   2. Emits one valid SVG per assetType
 *   3. SVG contains NO <script>, no external href/xlink:href, no on* event attrs
 *   4. SVG encodes the asset type label legibly
 *   5. SVG uses CONSTRAINTS_MANIFEST tokens (dark surface colour present)
 *
 * Run with: node --experimental-strip-types --test tests/forge-asset-placeholder.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePlaceholderSvg, ASSET_TYPES } from "../src/forge/placeholder-assets.ts";
import type { AssetRequest } from "../src/forge/asset-contract.ts";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function makeRequest(assetType: AssetRequest["assetType"]): AssetRequest {
  return {
    id: `test-${assetType}`,
    provider: "placeholder_svg",
    assetType,
    purpose: `Test placeholder for ${assetType}`,
    placement: "test-slot",
    prompt: "placeholder",
    negativeConstraints: [],
    preferredSize: "auto",
    preferredFormat: "svg",
    background: "auto",
    outputPath: `web/public/fallbacks/${assetType}.svg`,
    altText: `Placeholder for ${assetType}`,
    needsUserApproval: false,
    status: "planned"
  };
}

// ---------------------------------------------------------------------------
// All asset types
// ---------------------------------------------------------------------------

const ALL_TYPES: ReadonlyArray<AssetRequest["assetType"]> = [
  "hero",
  "spot_illustration",
  "background_texture",
  "empty_state",
  "icon",
  "social_preview",
  "product_mockup_frame",
  "decorative_shape"
];

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("generatePlaceholderSvg determinism", () => {
  it("produces identical output for identical input (multiple calls)", () => {
    for (const assetType of ALL_TYPES) {
      const req = makeRequest(assetType);
      const first = generatePlaceholderSvg(req);
      const second = generatePlaceholderSvg(req);
      assert.equal(
        first,
        second,
        `assetType="${assetType}" must produce identical output on repeated calls`
      );
    }
  });

  it("produces different output for different assetType", () => {
    const hero = generatePlaceholderSvg(makeRequest("hero"));
    const icon = generatePlaceholderSvg(makeRequest("icon"));
    assert.notEqual(hero, icon, "Different assetType must produce different SVG");
  });
});

// ---------------------------------------------------------------------------
// SVG validity
// ---------------------------------------------------------------------------

describe("generatePlaceholderSvg SVG structure", () => {
  it("produces valid SVG opening tag for every assetType", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      assert.ok(
        svg.startsWith("<svg ") || svg.startsWith("<svg\n") || svg.startsWith("<svg\r"),
        `assetType="${assetType}" must start with <svg`
      );
      assert.ok(
        svg.includes("</svg>"),
        `assetType="${assetType}" must close with </svg>`
      );
    }
  });

  it("includes xmlns attribute", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      assert.ok(
        svg.includes('xmlns="http://www.w3.org/2000/svg"'),
        `assetType="${assetType}" must include xmlns`
      );
    }
  });

  it("encodes the assetType as a readable label in the SVG", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      // Label may use underscores or spaces — check the words are present
      const label = assetType.replace(/_/g, " ");
      const hasLabel =
        svg.toLowerCase().includes(assetType.toLowerCase()) ||
        svg.toLowerCase().includes(label.toLowerCase());
      assert.ok(
        hasLabel,
        `assetType="${assetType}" must encode the type as a label in the SVG`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CONSTRAINTS_MANIFEST token usage
// ---------------------------------------------------------------------------

describe("generatePlaceholderSvg constraint token usage", () => {
  it("uses the dark surface color from CONSTRAINTS_MANIFEST (not pure black)", () => {
    // CONSTRAINTS_MANIFEST.identity.surfaceRamp.base = "#0A0A0A"
    // CONSTRAINTS_MANIFEST.identity.darkBase = "#0A0A0A"
    // Neither pure #000000 nor pure #FFFFFF should be the background
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      // Must reference the manifest dark surface (#0A0A0A) somewhere
      assert.ok(
        svg.toLowerCase().includes("#0a0a0a") || svg.toLowerCase().includes("0a0a0a"),
        `assetType="${assetType}" must use CONSTRAINTS_MANIFEST dark surface (#0A0A0A)`
      );
    }
  });

  it("uses the manifest accent color (#6366F1 or derived)", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      // Must reference the manifest accent or text color
      const hasAccentOrText =
        svg.toLowerCase().includes("#6366f1") ||
        svg.toLowerCase().includes("#ededed") ||
        svg.toLowerCase().includes("#818cf8");
      assert.ok(
        hasAccentOrText,
        `assetType="${assetType}" must use manifest palette colors`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Security: no script injection, no external references
// ---------------------------------------------------------------------------

describe("generatePlaceholderSvg security — no script/external refs", () => {
  it("contains no <script> tags", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      assert.ok(
        !svg.toLowerCase().includes("<script"),
        `assetType="${assetType}" must NOT contain <script>`
      );
    }
  });

  it("contains no external href references", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      // No http:// or https:// in any href, xlink:href, or src attr
      const hasExternalRef = /href\s*=\s*["']https?:/.test(svg) ||
        /xlink:href\s*=\s*["']https?:/.test(svg);
      assert.ok(
        !hasExternalRef,
        `assetType="${assetType}" must NOT contain external href/xlink:href`
      );
    }
  });

  it("contains no xlink:href at all", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      assert.ok(
        !svg.includes("xlink:href"),
        `assetType="${assetType}" must NOT contain xlink:href (deprecated + attack surface)`
      );
    }
  });

  it("contains no on* event attributes", () => {
    // Matches onload, onclick, onerror, onmouseover, etc.
    const onEventPattern = /\bon\w+\s*=/i;
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      assert.ok(
        !onEventPattern.test(svg),
        `assetType="${assetType}" must NOT contain on* event attributes`
      );
    }
  });

  it("contains no <image> elements (no raster embedding)", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      assert.ok(
        !/<image[\s>]/i.test(svg),
        `assetType="${assetType}" must NOT contain <image> (no raster embedding)`
      );
    }
  });

  it("contains no <foreignObject> elements", () => {
    for (const assetType of ALL_TYPES) {
      const svg = generatePlaceholderSvg(makeRequest(assetType));
      assert.ok(
        !/<foreignObject[\s>]/i.test(svg),
        `assetType="${assetType}" must NOT contain <foreignObject>`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ASSET_TYPES export
// ---------------------------------------------------------------------------

describe("ASSET_TYPES exported constant", () => {
  it("contains all 8 asset types", () => {
    assert.equal(ASSET_TYPES.length, 8);
    for (const t of ALL_TYPES) {
      assert.ok(
        (ASSET_TYPES as ReadonlyArray<string>).includes(t),
        `ASSET_TYPES must include "${t}"`
      );
    }
  });
});
