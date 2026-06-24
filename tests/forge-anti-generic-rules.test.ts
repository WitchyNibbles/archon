/**
 * Tests for src/forge/anti-generic-checker.ts — numeric and token-rule assertions.
 *
 * Scope: AG-001 (gradients), AG-003 (radius cap), AG-004 (box-shadow),
 * AG-005 (pure white text), AG-006 (pure black canvas), AG-007 (system font),
 * AG-009 (4px-sub-grid spacing), AG-010 (motion cap), AG-011 (glassmorphism),
 * AG-013 (off-palette color check), plus the blocking-flag derivation.
 *
 * DOM-structure assertions (AG-012, AG-014) and schema/coverage tests live
 * in forge-anti-generic-checker.test.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-anti-generic-rules.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runAntiGenericChecker
} from "../src/forge/anti-generic-checker.ts";
import type { RenderedElement, RenderedSnapshot } from "../src/forge/anti-generic-checker.ts";
import { CONSTRAINTS_MANIFEST } from "../src/forge/constraints-manifest.ts";

// ---------------------------------------------------------------------------
// Fixture helpers (local — no shared state with the DOM-structure test file)
// ---------------------------------------------------------------------------

function el(
  overrides: Partial<RenderedElement> & { selector: string; tag: string }
): RenderedElement {
  return {
    childCount: 0,
    textLength: 0,
    computed: {},
    parentSelector: null,
    ...overrides
  };
}

function snapshot(elements: RenderedElement[]): RenderedSnapshot {
  return { url: "http://localhost:5173/", elements };
}

// Cap constants read directly from the manifest so tests stay in sync with it.
const { absoluteMaxPx: radiusCap } = CONSTRAINTS_MANIFEST.identity.radiusCap;
const { maxDurationMs: motionCap } = CONSTRAINTS_MANIFEST.identity.motion;

// ---------------------------------------------------------------------------
// AG-001 — no gradient fills on UI surfaces
// ---------------------------------------------------------------------------

describe("AG-001 — no gradient fills", () => {
  it("hard_fails when a non-overlay element has a gradient backgroundImage", () => {
    const snap = snapshot([
      el({
        selector: "div.panel",
        tag: "div",
        computed: { backgroundImage: "linear-gradient(135deg, #1a1a2e, #16213e)" }
      })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag001 = report.violations.filter((v) => v.agId === "AG-001");
    assert.ok(ag001.length > 0, "Expected AG-001 violation on gradient fill");
    assert.equal(ag001[0]?.severity, "hard_fail");
    assert.ok(report.blocking);
  });

  it("does NOT trigger when backgroundImage is empty or absent", () => {
    const snap = snapshot([
      el({ selector: "div.panel", tag: "div", computed: { backgroundImage: "" } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-001").length, 0);
  });

  it("does NOT trigger on overlay elements (ambient glow exemption)", () => {
    const snap = snapshot([
      el({
        selector: "div.modal",
        tag: "div",
        semanticHint: "overlay",
        computed: { backgroundImage: "radial-gradient(circle, #6366F1, transparent)" }
      })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-001").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-003 — border radius cap
// ---------------------------------------------------------------------------

describe("AG-003 — border radius cap", () => {
  it(`hard_fails when borderRadius exceeds ${radiusCap}px cap`, () => {
    const overCapPx = radiusCap + 4;
    const snap = snapshot([
      el({ selector: "div.card", tag: "div", computed: { borderRadiusPx: overCapPx } })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag003 = report.violations.filter((v) => v.agId === "AG-003");
    assert.ok(ag003.length > 0, `Expected AG-003 violation for ${overCapPx}px radius`);
    assert.equal(ag003[0]?.severity, "hard_fail");
    assert.equal(ag003[0]?.measured, `borderRadius=${overCapPx}px`);
    assert.equal(ag003[0]?.cap, `≤${radiusCap}px`);
    assert.ok(report.blocking);
  });

  it(`passes when borderRadius is exactly at the ${radiusCap}px cap`, () => {
    const snap = snapshot([
      el({ selector: "div.card", tag: "div", computed: { borderRadiusPx: radiusCap } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-003").length, 0);
  });

  it("passes when borderRadius is 0 (no radius)", () => {
    const snap = snapshot([
      el({ selector: "div", tag: "div", computed: { borderRadiusPx: 0 } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-003").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-004 — no box-shadow elevation on dark surfaces
// ---------------------------------------------------------------------------

describe("AG-004 — no box-shadow elevation on dark surfaces", () => {
  it("hard_fails when a non-overlay element has a box-shadow", () => {
    const snap = snapshot([
      el({ selector: "div.card", tag: "div", computed: { boxShadow: "0 4px 6px rgba(0,0,0,0.3)" } })
    ]);
    const report = runAntiGenericChecker(snap);
    assert.ok(report.violations.some((v) => v.agId === "AG-004"));
    assert.ok(report.blocking);
  });

  it("does NOT trigger when boxShadow is none or absent", () => {
    const snap = snapshot([
      el({ selector: "div", tag: "div", computed: { boxShadow: "none" } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-004").length, 0);
  });

  it("does NOT trigger on overlay elements (modals may use drop-shadow)", () => {
    const snap = snapshot([
      el({
        selector: "div.modal",
        tag: "div",
        semanticHint: "overlay",
        computed: { boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }
      })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-004").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-005 — no pure #FFFFFF body text
// ---------------------------------------------------------------------------

describe("AG-005 — no pure #FFFFFF body text", () => {
  it("hard_fails on pure white color", () => {
    const snap = snapshot([
      el({ selector: "p.text", tag: "p", textLength: 40, computed: { color: "#ffffff" } })
    ]);
    const report = runAntiGenericChecker(snap);
    assert.ok(report.violations.some((v) => v.agId === "AG-005"));
    assert.ok(report.blocking);
  });

  it("passes on --text-primary (#EDEDED)", () => {
    const snap = snapshot([
      el({ selector: "p", tag: "p", textLength: 40, computed: { color: "#EDEDED" } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-005").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-006 — no pure #000000 canvas
// ---------------------------------------------------------------------------

describe("AG-006 — no pure #000000 canvas", () => {
  it("hard_fails when body element has pure black background", () => {
    const snap = snapshot([
      el({ selector: "body", tag: "body", semanticHint: "body", computed: { backgroundColor: "#000000" } })
    ]);
    const report = runAntiGenericChecker(snap);
    assert.ok(report.violations.some((v) => v.agId === "AG-006"));
    assert.ok(report.blocking);
  });

  it("passes when body uses --surface-base (#0A0A0A)", () => {
    const snap = snapshot([
      el({ selector: "body", tag: "body", semanticHint: "body", computed: { backgroundColor: "#0A0A0A" } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-006").length, 0);
  });

  it("does NOT trigger AG-006 on a non-body element with pure black background", () => {
    const snap = snapshot([
      el({ selector: "div.accent", tag: "div", computed: { backgroundColor: "#000000" } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-006").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-007 — no default system font stack
// ---------------------------------------------------------------------------

describe("AG-007 — no default system font stack", () => {
  it("hard_fails when system-ui font is used without Geist or Inter", () => {
    const snap = snapshot([
      el({
        selector: "body",
        tag: "body",
        computed: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }
      })
    ]);
    const report = runAntiGenericChecker(snap);
    assert.ok(report.violations.some((v) => v.agId === "AG-007"));
    assert.ok(report.blocking);
  });

  it("passes when Geist is present alongside system fallbacks", () => {
    const snap = snapshot([
      el({ selector: "body", tag: "body", computed: { fontFamily: "'Geist Sans', system-ui, sans-serif" } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-007").length, 0);
  });

  it("passes when Inter is present (permitted fallback)", () => {
    const snap = snapshot([
      el({
        selector: "body",
        tag: "body",
        computed: { fontFamily: "'Inter Variable', -apple-system, sans-serif" }
      })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-007").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-009 — 4px-sub-grid spacing
//
// The checker uses a 4px sub-grid (any multiple of 4px is permitted).
// This matches the manifest's stated 4px base and the 8px primary grid.
// Values 96px (12×8) and 128px (16×8) are valid as unlisted on-grid multiples.
// ---------------------------------------------------------------------------

describe("AG-009 — 4px-sub-grid spacing", () => {
  it("hard_fails on gap value off the grid (e.g. 7px)", () => {
    const snap = snapshot([
      el({ selector: "div.grid", tag: "div", computed: { gapPx: 7 } })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag009 = report.violations.filter((v) => v.agId === "AG-009");
    assert.ok(ag009.length > 0, "Expected AG-009 violation for gap=7px");
    assert.ok(ag009.some((v) => v.measured?.includes("7")));
    assert.ok(report.blocking);
  });

  it("hard_fails on exactly 3px spacing (above ≤2px exemption, off the 4px grid)", () => {
    // 3px is above the ≤2px visual-correction exemption AND is not a multiple of 4.
    const snap = snapshot([
      el({ selector: "div.card", tag: "div", computed: { gapPx: 3 } })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag009 = report.violations.filter((v) => v.agId === "AG-009");
    assert.ok(ag009.length > 0, "Expected AG-009 violation for gap=3px (above correction threshold, off grid)");
    assert.ok(report.blocking);
  });

  it("hard_fails on padding value off the grid (e.g. 15px top)", () => {
    const snap = snapshot([
      el({ selector: "div.card", tag: "div", computed: { paddingPx: [15, 16, 16, 16] } })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag009 = report.violations.filter((v) => v.agId === "AG-009");
    assert.ok(ag009.length > 0, "Expected AG-009 violation for padding-top=15px");
    assert.ok(ag009.some((v) => v.measured?.includes("15")));
  });

  it("passes on grid-aligned spacing (4px, 8px, 16px, 24px, 32px)", () => {
    for (const px of [4, 8, 16, 24, 32]) {
      const snap = snapshot([
        el({ selector: "div", tag: "div", computed: { gapPx: px, paddingPx: [px, px, px, px] } })
      ]);
      assert.equal(
        runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-009").length,
        0,
        `Expected no AG-009 violation for ${px}px spacing`
      );
    }
  });

  it("passes on 96px and 128px (valid on-grid multiples: 12×8 and 16×8)", () => {
    // These are not listed in the manifest's spacingTokens but are valid as
    // multiples of the 4px sub-grid (96 % 4 === 0, 128 % 4 === 0).
    for (const px of [96, 128]) {
      const snap = snapshot([
        el({ selector: "div", tag: "div", computed: { gapPx: px } })
      ]);
      assert.equal(
        runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-009").length,
        0,
        `Expected no AG-009 violation for ${px}px (valid on-grid multiple)`
      );
    }
  });

  it("passes on small correction values ≤ 2px (visual alignment exemption)", () => {
    const snap = snapshot([
      el({ selector: "div", tag: "div", computed: { gapPx: 1, paddingPx: [2, 2, 2, 2] } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-009").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-010 — motion duration cap
// ---------------------------------------------------------------------------

describe("AG-010 — motion duration cap", () => {
  it(`hard_fails when animation duration exceeds ${motionCap}ms`, () => {
    const overCap = motionCap + 100;
    const snap = snapshot([
      el({ selector: "div.animated", tag: "div", computed: { animationDurationMs: overCap } })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag010 = report.violations.filter((v) => v.agId === "AG-010");
    assert.ok(ag010.length > 0, `Expected AG-010 violation for ${overCap}ms animation`);
    assert.equal(ag010[0]?.measured, `animationDuration=${overCap}ms`);
    assert.equal(ag010[0]?.cap, `≤${motionCap}ms`);
    assert.ok(report.blocking);
  });

  it(`passes when animation duration is exactly ${motionCap}ms`, () => {
    const snap = snapshot([
      el({ selector: "div.animated", tag: "div", computed: { animationDurationMs: motionCap } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-010").length, 0);
  });

  it("passes when animationDurationMs is 0 (no animation)", () => {
    const snap = snapshot([
      el({ selector: "div", tag: "div", computed: { animationDurationMs: 0 } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-010").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-011 — no glassmorphism without purpose
// ---------------------------------------------------------------------------

describe("AG-011 — no glassmorphism without purpose", () => {
  it("hard_fails when a non-overlay has backdrop-filter:blur", () => {
    const snap = snapshot([
      el({ selector: "div.card", tag: "div", computed: { backdropFilter: "blur(12px)" } })
    ]);
    const report = runAntiGenericChecker(snap);
    assert.ok(report.violations.some((v) => v.agId === "AG-011"));
    assert.ok(report.blocking);
  });

  it("does NOT trigger on overlay elements (modals/tooltips exemption)", () => {
    const snap = snapshot([
      el({ selector: "div.tooltip", tag: "div", semanticHint: "overlay", computed: { backdropFilter: "blur(8px)" } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-011").length, 0);
  });

  it("does NOT trigger when backdropFilter is none or absent", () => {
    const snap = snapshot([
      el({ selector: "div", tag: "div", computed: { backdropFilter: "none" } })
    ]);
    assert.equal(runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-011").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-013 — off-palette color check (deterministic partial check)
//
// Checks that computed.color and computed.backgroundColor are hex values
// that belong to the canonical manifest palette. Non-hex values (rgba, named)
// are passed through without error (not checkable at this tier).
// ---------------------------------------------------------------------------

describe("AG-013 — off-palette color check (partial deterministic check)", () => {
  it("emits a WARNING for a computed.color value not in the canonical palette", () => {
    // #3B82F6 is a generic blue not in the Archon palette
    const snap = snapshot([
      el({ selector: "div.badge", tag: "div", computed: { color: "#3B82F6" } })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag013 = report.violations.filter((v) => v.agId === "AG-013");
    assert.ok(ag013.length > 0, "Expected AG-013 warning for off-palette color");
    assert.equal(ag013[0]?.severity, "warning", "AG-013 must be a warning, not hard_fail");
    assert.ok(ag013[0]?.measured?.includes("color") ?? false);
    // AG-013 warning alone must not set blocking
    const onlyAg013 = report.violations.every((v) => v.agId === "AG-013");
    if (onlyAg013) {
      assert.equal(report.blocking, false, "AG-013 warning alone must not set blocking=true");
    }
  });

  it("emits a WARNING for a computed.backgroundColor value not in the canonical palette", () => {
    const snap = snapshot([
      el({ selector: "div.card", tag: "div", computed: { backgroundColor: "#10B981" } })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag013 = report.violations.filter((v) => v.agId === "AG-013");
    assert.ok(ag013.length > 0, "Expected AG-013 warning for off-palette backgroundColor");
    assert.equal(ag013[0]?.severity, "warning");
  });

  it("does NOT trigger for a canonical palette color (e.g. --surface-raised #111111)", () => {
    const snap = snapshot([
      el({ selector: "div.panel", tag: "div", computed: { backgroundColor: "#111111" } })
    ]);
    const ag013 = runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-013");
    assert.equal(ag013.length, 0, "Canonical palette color must not trigger AG-013");
  });

  it("does NOT trigger for a canonical accent color (--accent #6366F1)", () => {
    const snap = snapshot([
      el({ selector: "button.primary", tag: "button", computed: { backgroundColor: "#6366F1" } })
    ]);
    const ag013 = runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-013");
    assert.equal(ag013.length, 0, "Canonical accent color must not trigger AG-013");
  });

  it("does NOT trigger for non-hex values (rgba, transparent, inherit — not checkable at this tier)", () => {
    for (const value of ["rgba(99,102,241,0.12)", "transparent", "inherit"]) {
      const snap = snapshot([
        el({ selector: "div", tag: "div", computed: { backgroundColor: value } })
      ]);
      assert.equal(
        runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-013").length,
        0,
        `Non-hex value "${value}" must not trigger AG-013`
      );
    }
  });

  it("does NOT trigger for #0A0A0A (canonical --surface-base, even if double-listed)", () => {
    // #0A0A0A is CONSTRAINTS_MANIFEST.identity.surfaceRamp.base AND the explicit
    // darkBase constant in buildCanonicalPaletteHex. It must always be canonical.
    const snap = snapshot([
      el({ selector: "body", tag: "body", semanticHint: "body",
        computed: { backgroundColor: "#0A0A0A" } })
    ]);
    assert.equal(
      runAntiGenericChecker(snap).violations.filter((v) => v.agId === "AG-013").length,
      0,
      "#0A0A0A is a canonical palette member and must not trigger AG-013"
    );
  });

  it("intentional severity override: emits warning, never hard_fail (manifest policy is hard_fail but only hex-membership is mechanizable at this tier)", () => {
    // The manifest's AG-013 policy is hard_fail at the full-token-map tier.
    // This checker tier can only verify hex palette membership, NOT token identity.
    // It intentionally emits "warning" to avoid false hard_fails.
    // This test pins the intentional override to prevent accidental escalation.
    const snap = snapshot([
      el({ selector: "div.badge", tag: "div", computed: { color: "#3B82F6" } })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag013 = report.violations.filter((v) => v.agId === "AG-013");
    assert.ok(ag013.length > 0, "Expected AG-013 violation for off-palette color");
    assert.equal(ag013[0]?.severity, "warning",
      "AG-013 severity must be 'warning' (intentional override: hard_fail reserved for full token-map tier)");
    const onlyAg013 = report.violations.every((v) => v.agId === "AG-013");
    if (onlyAg013) {
      assert.equal(report.blocking, false,
        "AG-013 warning must not set blocking (only hard_fail violations are blocking)");
    }
  });
});

// ---------------------------------------------------------------------------
// Blocking flag derivation
// ---------------------------------------------------------------------------

describe("blocking flag semantics", () => {
  it("blocking is false when there are no violations", () => {
    const report = runAntiGenericChecker(snapshot([]));
    assert.equal(report.blocking, false);
    assert.equal(report.violations.length, 0);
  });

  it("blocking is true iff a hard_fail violation exists", () => {
    const snap = snapshot([
      el({ selector: "div", tag: "div", computed: { borderRadiusPx: 100 } })
    ]);
    const report = runAntiGenericChecker(snap);
    assert.ok(report.violations.some((v) => v.severity === "hard_fail"));
    assert.equal(report.blocking, true);
  });

  it("blocking is false when only warning violations exist (e.g. AG-013 only)", () => {
    const snap = snapshot([
      // Off-palette color → AG-013 warning only
      el({ selector: "div", tag: "div", computed: { color: "#3B82F6" } })
    ]);
    const report = runAntiGenericChecker(snap);
    const hardFails = report.violations.filter((v) => v.severity === "hard_fail");
    assert.equal(hardFails.length, 0, "No hard_fail expected for AG-013-only violation");
    assert.equal(report.blocking, false, "blocking must be false when only warnings exist");
  });
});
