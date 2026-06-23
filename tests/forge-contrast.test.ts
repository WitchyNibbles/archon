/**
 * Contrast regression suite for the Archon visual identity.
 *
 * Locks the WCAG AA guarantee for text tokens in the constraints-manifest so a
 * future token edit that re-introduces an illegible color fails CI rather than
 * shipping to every archon UI. The negative twins document WHY the readable
 * `statusTextColors` variants exist — the saturated bases fail AA as text.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AA_NORMAL_TEXT,
  contrastRatio,
  meetsAA,
  parseHex
} from "../src/forge/wcag-contrast.ts";
import { CONSTRAINTS_MANIFEST } from "../src/forge/constraints-manifest.ts";

const { surfaceRamp, textHierarchy, statusColors, statusTextColors } =
  CONSTRAINTS_MANIFEST.identity;

// Every surface text can sit on. Overlay (#222222) is the lightest and therefore
// the worst case for light-on-dark text — a token must clear AA on ALL of them.
const SURFACES: ReadonlyArray<readonly [string, string]> = Object.entries(surfaceRamp);

describe("wcag-contrast math", () => {
  it("computes the canonical white-on-black ratio as 21:1", () => {
    assert.equal(Math.round(contrastRatio("#FFFFFF", "#000000")), 21);
  });

  it("treats identical colors as 1:1", () => {
    assert.equal(contrastRatio("#6366F1", "#6366F1"), 1);
  });

  it("is order-independent", () => {
    assert.equal(contrastRatio("#EDEDED", "#0A0A0A"), contrastRatio("#0A0A0A", "#EDEDED"));
  });

  it("expands 3-digit hex", () => {
    assert.deepEqual(parseHex("#fff"), [255, 255, 255]);
  });

  it("accepts hash-less input and surrounding whitespace (documented contract)", () => {
    // The forge critic/codegen may pass tokens with or without a leading '#';
    // lock the lenient contract so a future trim()/replace() removal is caught.
    assert.deepEqual(parseHex("EDEDED"), [0xed, 0xed, 0xed]);
    assert.deepEqual(parseHex("  #6366F1  "), [0x63, 0x66, 0xf1]);
    assert.deepEqual(parseHex("abc"), [0xaa, 0xbb, 0xcc]);
  });

  it("rejects malformed hex loudly", () => {
    assert.throws(() => parseHex("#12345"), /not a valid/);
    assert.throws(() => parseHex("nope"), /not a valid/);
    assert.throws(() => parseHex(""), /not a valid/);
  });
});

describe("readable text tokens pass WCAG AA on every surface", () => {
  it("text-primary and text-secondary pass AA everywhere", () => {
    for (const [name, surface] of SURFACES) {
      assert.ok(
        meetsAA(textHierarchy.primary, surface),
        `text-primary on ${name} = ${contrastRatio(textHierarchy.primary, surface).toFixed(2)} < ${AA_NORMAL_TEXT}`
      );
      assert.ok(
        meetsAA(textHierarchy.secondary, surface),
        `text-secondary on ${name} = ${contrastRatio(textHierarchy.secondary, surface).toFixed(2)} < ${AA_NORMAL_TEXT}`
      );
    }
  });

  it("every statusTextColors variant passes AA on every surface (incl. overlay)", () => {
    for (const [status, color] of Object.entries(statusTextColors)) {
      for (const [name, surface] of SURFACES) {
        const ratio = contrastRatio(color, surface);
        assert.ok(
          ratio >= AA_NORMAL_TEXT,
          `status-${status}-text (${color}) on ${name} = ${ratio.toFixed(2)} < ${AA_NORMAL_TEXT}`
        );
      }
    }
  });
});

describe("negative twins — saturated bases are NOT safe as small text", () => {
  it("text-muted fails AA on EVERY surface (decorative-only)", () => {
    // #6B6B6B fails on all four surfaces (3.72 → 2.99); guarding every surface
    // means the assertion can never silently invert if a surface is refactored.
    for (const [name, surface] of SURFACES) {
      assert.ok(
        !meetsAA(textHierarchy.muted, surface),
        `text-muted unexpectedly passes AA on ${name} (${contrastRatio(textHierarchy.muted, surface).toFixed(2)}); if intentional, this color is no longer decorative-only — update the guard and the SKILL`
      );
    }
  });

  it("status-pending and status-muted bases fail AA as text on EVERY surface", () => {
    // Both fail on all four surfaces, so assert across the whole ramp rather than
    // relying on one implicitly-chosen surface.
    for (const base of [statusColors.pending, statusColors.muted]) {
      for (const [name, surface] of SURFACES) {
        assert.ok(
          !meetsAA(base, surface),
          `${base} unexpectedly passes AA as text on ${name} (${contrastRatio(base, surface).toFixed(2)})`
        );
      }
    }
  });

  it("status-error base is AA-safe on base/raised/elevated but FAILS on overlay (precise boundary)", () => {
    // #EF4444 is the borderline case: it passes as text on the three darker
    // surfaces and fails ONLY on overlay (4.23). Asserting BOTH halves documents
    // the exact boundary and prevents the guard from silently inverting if the
    // tested surface is ever changed.
    for (const darker of [surfaceRamp.base, surfaceRamp.raised, surfaceRamp.elevated]) {
      assert.ok(
        meetsAA(statusColors.error, darker),
        `status-error base should pass AA on ${darker} (${contrastRatio(statusColors.error, darker).toFixed(2)})`
      );
    }
    assert.ok(
      !meetsAA(statusColors.error, surfaceRamp.overlay),
      `status-error base should FAIL AA on overlay (${contrastRatio(statusColors.error, surfaceRamp.overlay).toFixed(2)}); the -text variant exists to guard this`
    );
  });

  it("documents which bases ARE AA-safe as text (success/warning/running), so their omission from the negative twins is intentional", () => {
    // success #22C55E, warning #F59E0B, running #06B6D4 all pass AA as text on
    // every surface today. This positive guard makes the classification explicit:
    // if any of them is ever lightened below AA, this fails loudly rather than
    // leaving a silent gap in the negative-twin coverage.
    for (const safeBase of [statusColors.success, statusColors.warning, statusColors.running]) {
      for (const [name, surface] of SURFACES) {
        assert.ok(
          meetsAA(safeBase, surface),
          `${safeBase} should be AA-safe as text on ${name} (${contrastRatio(safeBase, surface).toFixed(2)}); if it dropped below AA it now needs a negative twin + a -text variant`
        );
      }
    }
  });

  it("status-muted-text aliases text-secondary (documented routing, now guarded)", () => {
    assert.equal(
      statusTextColors.muted,
      textHierarchy.secondary,
      "status-muted-text must alias text-secondary (#A0A0A0) per the SKILL routing"
    );
  });
});
