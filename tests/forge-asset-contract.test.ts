/**
 * Tests for src/forge/asset-contract.ts
 *
 * TDD: failing tests written before implementation.
 *
 * Verifies:
 *   1. AssetRequestSchema parses valid fixtures
 *   2. AssetRequestSchema rejects missing required fields (loud fail)
 *   3. AssetManifestEntrySchema parses valid fixtures
 *   4. AssetManifestEntrySchema rejects missing required fields
 *   5. No .passthrough() — extra fields are stripped
 *
 * Run with: node --experimental-strip-types --test tests/forge-asset-contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AssetRequestSchema,
  AssetManifestEntrySchema
} from "../src/forge/asset-contract.ts";
import type { AssetRequest, AssetManifestEntry } from "../src/forge/asset-contract.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function validRequest(): AssetRequest {
  return {
    id: "hero-archon-forge",
    provider: "codex_builtin_imagegen",
    assetType: "hero",
    purpose: "Landing-page hero visual for Frontend Forge",
    placement: "HomeHero background",
    prompt: "Dark editorial illustration of an AI frontend forge",
    negativeConstraints: ["no readable text", "no logo"],
    preferredSize: "landscape",
    preferredFormat: "webp",
    background: "opaque",
    outputPath: "web/public/generated/hero.webp",
    altText: "Abstract dark illustration of an AI-powered frontend forge",
    needsUserApproval: true,
    status: "planned"
  };
}

function validManifestEntry(): AssetManifestEntry {
  return {
    id: "hero-archon-forge",
    provider: "codex_builtin_imagegen",
    type: "hero",
    path: "web/public/generated/hero.webp",
    promptHash: "abc123def456ab12",
    originalRequestPath: "src/forge/generated/asset_requests/hero-archon-forge.json",
    alt: "Abstract dark illustration of an AI-powered frontend forge",
    usedIn: ["HomeHero"],
    approved: false,
    generatedBy: "codex:$imagegen",
    qaStatus: "pending",
    notes: []
  };
}

// ---------------------------------------------------------------------------
// AssetRequestSchema
// ---------------------------------------------------------------------------

describe("AssetRequestSchema", () => {
  it("parses a valid hero request", () => {
    const result = AssetRequestSchema.safeParse(validRequest());
    assert.equal(result.success, true, "Valid request must parse successfully");
  });

  it("parses every valid assetType", () => {
    const types = [
      "hero",
      "spot_illustration",
      "background_texture",
      "empty_state",
      "icon",
      "social_preview",
      "product_mockup_frame",
      "decorative_shape"
    ] as const;
    for (const assetType of types) {
      const req = { ...validRequest(), assetType };
      const result = AssetRequestSchema.safeParse(req);
      assert.equal(result.success, true, `assetType="${assetType}" must be valid`);
    }
  });

  it("parses every valid provider", () => {
    const providers = [
      "codex_builtin_imagegen",
      "manual_upload",
      "placeholder_svg"
    ] as const;
    for (const provider of providers) {
      const req = { ...validRequest(), provider };
      const result = AssetRequestSchema.safeParse(req);
      assert.equal(result.success, true, `provider="${provider}" must be valid`);
    }
  });

  it("parses svg as a valid preferredFormat", () => {
    const req = { ...validRequest(), preferredFormat: "svg" };
    const result = AssetRequestSchema.safeParse(req);
    assert.equal(result.success, true, "preferredFormat=svg must be valid");
  });

  it("parses every valid status", () => {
    const statuses = [
      "planned",
      "approved",
      "sent_to_codex",
      "generated",
      "needs_regeneration",
      "rejected"
    ] as const;
    for (const status of statuses) {
      const req = { ...validRequest(), status };
      const result = AssetRequestSchema.safeParse(req);
      assert.equal(result.success, true, `status="${status}" must be valid`);
    }
  });

  it("fails loudly when id is missing", () => {
    const { id: _id, ...rest } = validRequest();
    const result = AssetRequestSchema.safeParse(rest);
    assert.equal(result.success, false, "Missing id must fail");
  });

  it("fails loudly when provider is missing", () => {
    const { provider: _p, ...rest } = validRequest();
    const result = AssetRequestSchema.safeParse(rest);
    assert.equal(result.success, false, "Missing provider must fail");
  });

  it("fails loudly when assetType is invalid", () => {
    const req = { ...validRequest(), assetType: "banner" };
    const result = AssetRequestSchema.safeParse(req);
    assert.equal(result.success, false, "Unknown assetType must fail");
  });

  it("fails loudly when preferredFormat is invalid", () => {
    const req = { ...validRequest(), preferredFormat: "gif" };
    const result = AssetRequestSchema.safeParse(req);
    assert.equal(result.success, false, "preferredFormat=gif must fail");
  });

  it("fails loudly when provider is an api-key provider", () => {
    const req = { ...validRequest(), provider: "openai_api_later_optional" };
    const result = AssetRequestSchema.safeParse(req);
    assert.equal(result.success, false, "Non-MVP provider must fail");
  });

  it("rejects extra unknown fields (strict — no passthrough)", () => {
    const req = { ...validRequest(), unexpectedField: "sneaky" };
    const result = AssetRequestSchema.safeParse(req);
    // Zod .strict() makes unknown fields a parse error
    assert.equal(result.success, false, "Extra fields must be rejected");
  });

  it("negativeConstraints defaults to empty array when omitted", () => {
    const { negativeConstraints: _nc, ...rest } = validRequest();
    const result = AssetRequestSchema.safeParse(rest);
    assert.equal(result.success, true, "negativeConstraints is optional");
    if (result.success) {
      assert.deepEqual(result.data.negativeConstraints, []);
    }
  });
});

// ---------------------------------------------------------------------------
// AssetManifestEntrySchema
// ---------------------------------------------------------------------------

describe("AssetManifestEntrySchema", () => {
  it("parses a valid manifest entry", () => {
    const result = AssetManifestEntrySchema.safeParse(validManifestEntry());
    assert.equal(result.success, true, "Valid manifest entry must parse");
  });

  it("parses every valid qaStatus", () => {
    const statuses = ["pending", "pass", "fail", "regenerate"] as const;
    for (const qaStatus of statuses) {
      const entry = { ...validManifestEntry(), qaStatus };
      const result = AssetManifestEntrySchema.safeParse(entry);
      assert.equal(result.success, true, `qaStatus="${qaStatus}" must be valid`);
    }
  });

  it("fails loudly when id is missing", () => {
    const { id: _id, ...rest } = validManifestEntry();
    const result = AssetManifestEntrySchema.safeParse(rest);
    assert.equal(result.success, false, "Missing id must fail");
  });

  it("fails loudly when path is missing", () => {
    const { path: _p, ...rest } = validManifestEntry();
    const result = AssetManifestEntrySchema.safeParse(rest);
    assert.equal(result.success, false, "Missing path must fail");
  });

  it("fails loudly when alt is missing", () => {
    const { alt: _a, ...rest } = validManifestEntry();
    const result = AssetManifestEntrySchema.safeParse(rest);
    assert.equal(result.success, false, "Missing alt must fail");
  });

  it("fails loudly when qaStatus is invalid", () => {
    const entry = { ...validManifestEntry(), qaStatus: "ok" };
    const result = AssetManifestEntrySchema.safeParse(entry);
    assert.equal(result.success, false, "Unknown qaStatus must fail");
  });

  it("rejects extra unknown fields (strict — no passthrough)", () => {
    const entry = { ...validManifestEntry(), unexpectedField: "sneaky" };
    const result = AssetManifestEntrySchema.safeParse(entry);
    assert.equal(result.success, false, "Extra fields must be rejected");
  });

  it("notes defaults to empty array when omitted", () => {
    const { notes: _n, ...rest } = validManifestEntry();
    const result = AssetManifestEntrySchema.safeParse(rest);
    assert.equal(result.success, true, "notes is optional");
    if (result.success) {
      assert.deepEqual(result.data.notes, []);
    }
  });
});
