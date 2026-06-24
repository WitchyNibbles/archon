/**
 * Tests for src/forge/anti-generic-checker.ts — DOM-structure assertions.
 *
 * Scope: Zod input/output schema validation, AG-012 (three-card hard_fail proof,
 * missing-widthPx warning, boundary tests), AG-014 (marketing detection, real-
 * dashboard false-positive proof), and the uncheckedRules coverage contract.
 *
 * Numeric/token rule tests (AG-001/003-011/013) and blocking-flag semantics live
 * in forge-anti-generic-rules.test.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-anti-generic-checker.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runAntiGenericChecker,
  RenderedSnapshotSchema,
  AntiGenericReportSchema,
  UNCHECKED_RULE_IDS,
  CHECKED_RULE_IDS
} from "../src/forge/anti-generic-checker.ts";
import type { RenderedElement, RenderedSnapshot } from "../src/forge/anti-generic-checker.ts";
import { CONSTRAINTS_MANIFEST } from "../src/forge/constraints-manifest.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
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

// ---------------------------------------------------------------------------
// AG-012 fixtures
// ---------------------------------------------------------------------------

/**
 * Builds the canonical three-equal-card layout that MUST hard_fail AG-012.
 *
 * Structure: a flex container with 3 equal-width children, each having:
 *   - an icon-ish child (svg, textLength=0)
 *   - a short title child (textLength=24, ≤60)
 *   - a body text child (textLength=90, >60)
 *
 * This is the council-required falsifiability proof fixture (C1, non-waivable).
 */
function buildThreeCardGrid(): RenderedSnapshot {
  const containerSel = "main > div.cards";
  const container = el({
    selector: containerSel,
    tag: "div",
    childCount: 3,
    textLength: 300,
    computed: { display: "flex", widthPx: 900 },
    parentSelector: "main"
  });

  function card(index: number): RenderedElement[] {
    const cardSel = `main > div.cards > div.card:nth-child(${index})`;
    return [
      el({ selector: cardSel, tag: "div", childCount: 3, textLength: 100, computed: { display: "block", widthPx: 300 }, parentSelector: containerSel }),
      el({ selector: `${cardSel} > svg`, tag: "svg", role: "img", childCount: 1, textLength: 0, computed: {}, parentSelector: cardSel }),
      el({ selector: `${cardSel} > h3`, tag: "h3", childCount: 0, textLength: 24, computed: {}, parentSelector: cardSel }),
      el({ selector: `${cardSel} > p`, tag: "p", childCount: 0, textLength: 90, computed: {}, parentSelector: cardSel })
    ];
  }

  return snapshot([
    el({ selector: "main", tag: "main", childCount: 1, textLength: 300, computed: {}, parentSelector: null }),
    container,
    ...card(1),
    ...card(2),
    ...card(3)
  ]);
}

/**
 * A clean dashboard layout — sidebar nav + main content. NOT a card grid.
 * The two flex children have very different widths (ratio ~3.6), so
 * widthUniformity returns "unequal" and AG-012 must NOT trigger.
 */
function buildCleanDashboardLayout(): RenderedSnapshot {
  return snapshot([
    el({ selector: "body", tag: "body", semanticHint: "body", childCount: 1, textLength: 500, computed: { backgroundColor: "#0A0A0A" }, parentSelector: null }),
    el({ selector: "div.layout", tag: "div", childCount: 2, textLength: 500, computed: { display: "flex" }, parentSelector: "body" }),
    el({ selector: "nav.sidebar", tag: "nav", childCount: 5, textLength: 120, computed: { widthPx: 240 }, parentSelector: "div.layout" }),
    el({ selector: "main.content", tag: "main", childCount: 3, textLength: 380, computed: { widthPx: 860 }, parentSelector: "div.layout" }),
    el({ selector: "main.content > section.header-row", tag: "section", childCount: 2, textLength: 80, computed: { widthPx: 860 }, parentSelector: "main.content" }),
    el({ selector: "main.content > table.task-list", tag: "table", childCount: 8, textLength: 300, computed: { widthPx: 860 }, parentSelector: "main.content" }),
    el({ selector: "main.content > div.metrics", tag: "div", childCount: 2, textLength: 0, computed: { widthPx: 860 }, parentSelector: "main.content" })
  ]);
}

// ---------------------------------------------------------------------------
// AG-014 fixtures
// ---------------------------------------------------------------------------

/** Marketing-page skeleton: hero + equal-card-row + CTA. Must hard_fail AG-014. */
function buildMarketingPageLayout(): RenderedSnapshot {
  return snapshot([
    el({ selector: "body", tag: "body", semanticHint: "body", childCount: 3, textLength: 600, computed: { backgroundColor: "#0A0A0A" }, parentSelector: null }),
    // Hero section with h1 child
    el({ selector: "section.hero", tag: "section", childCount: 3, textLength: 120, computed: {}, parentSelector: "body" }),
    el({ selector: "section.hero > h1", tag: "h1", childCount: 0, textLength: 40, computed: {}, parentSelector: "section.hero" }),
    el({ selector: "section.hero > p", tag: "p", childCount: 0, textLength: 80, computed: {}, parentSelector: "section.hero" }),
    // Equal feature-card row (3 equal-width children)
    el({ selector: "div.features", tag: "div", childCount: 3, textLength: 300, computed: { display: "flex" }, parentSelector: "body" }),
    el({ selector: "div.features > div.feature:nth-child(1)", tag: "div", childCount: 2, textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
    el({ selector: "div.features > div.feature:nth-child(2)", tag: "div", childCount: 2, textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
    el({ selector: "div.features > div.feature:nth-child(3)", tag: "div", childCount: 2, textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
    // CTA section: has h2 heading + button — genuine CTA, not just a nav link
    el({ selector: "section.cta", tag: "section", childCount: 3, textLength: 100, computed: {}, parentSelector: "body" }),
    el({ selector: "section.cta > h2", tag: "h2", childCount: 0, textLength: 30, computed: {}, parentSelector: "section.cta" }),
    el({ selector: "section.cta > p", tag: "p", childCount: 0, textLength: 50, computed: {}, parentSelector: "section.cta" }),
    el({ selector: "section.cta > button", tag: "button", role: "button", childCount: 0, textLength: 20, computed: {}, parentSelector: "section.cta" })
  ]);
}

/**
 * A genuine run-status operator dashboard that must NOT trigger AG-014.
 *
 * Structure mirrors the Archon run-status dashboard:
 *   - A <header> (nav chrome) with a settings <a> link
 *   - A <div> flex row with 3 equal-width metric panels (run/task/gate counts)
 *   - A <section> content area with a run-detail heading + task table
 *
 * This proves the tightened hasCtaSection logic correctly excludes:
 *   - header/nav elements (nav chrome exclusion)
 *   - a bare link in a header (no heading/substantial-text sibling)
 *   - the equal-metric-panels row cannot be confused for the CTA's button
 */
function buildRunStatusDashboard(): RenderedSnapshot {
  return snapshot([
    el({ selector: "body", tag: "body", semanticHint: "body", childCount: 3, textLength: 800, computed: { backgroundColor: "#0A0A0A" }, parentSelector: null }),

    // Header with a settings nav link — NAV CHROME, not a CTA
    el({ selector: "header.appbar", tag: "header", childCount: 2, textLength: 40, computed: {}, parentSelector: "body" }),
    el({ selector: "header.appbar > span.title", tag: "span", childCount: 0, textLength: 20, computed: {}, parentSelector: "header.appbar" }),
    el({ selector: "header.appbar > a.settings", tag: "a", role: "link", childCount: 0, textLength: 10, computed: {}, parentSelector: "header.appbar" }),

    // Three equal-width metric panels (runs/tasks/gates counts)
    // These are a flex row of equal cards — the potential "equal-card-row" for AG-014.
    // But there is no hero section with h1/h2 AND no genuine CTA section,
    // so AG-014 must NOT fire.
    el({ selector: "div.metrics", tag: "div", childCount: 3, textLength: 60, computed: { display: "flex" }, parentSelector: "body" }),
    el({ selector: "div.metrics > div.metric:nth-child(1)", tag: "div", childCount: 2, textLength: 20, computed: { widthPx: 300 }, parentSelector: "div.metrics" }),
    el({ selector: "div.metrics > div.metric:nth-child(2)", tag: "div", childCount: 2, textLength: 20, computed: { widthPx: 300 }, parentSelector: "div.metrics" }),
    el({ selector: "div.metrics > div.metric:nth-child(3)", tag: "div", childCount: 2, textLength: 20, computed: { widthPx: 300 }, parentSelector: "div.metrics" }),
    // Metric panel children (number + label, not icon+title+body feature-card structure)
    el({ selector: "div.metrics > div.metric:nth-child(1) > span.count", tag: "span", childCount: 0, textLength: 2, computed: {}, parentSelector: "div.metrics > div.metric:nth-child(1)" }),
    el({ selector: "div.metrics > div.metric:nth-child(1) > span.label", tag: "span", childCount: 0, textLength: 10, computed: {}, parentSelector: "div.metrics > div.metric:nth-child(1)" }),
    el({ selector: "div.metrics > div.metric:nth-child(2) > span.count", tag: "span", childCount: 0, textLength: 2, computed: {}, parentSelector: "div.metrics > div.metric:nth-child(2)" }),
    el({ selector: "div.metrics > div.metric:nth-child(2) > span.label", tag: "span", childCount: 0, textLength: 10, computed: {}, parentSelector: "div.metrics > div.metric:nth-child(2)" }),
    el({ selector: "div.metrics > div.metric:nth-child(3) > span.count", tag: "span", childCount: 0, textLength: 2, computed: {}, parentSelector: "div.metrics > div.metric:nth-child(3)" }),
    el({ selector: "div.metrics > div.metric:nth-child(3) > span.label", tag: "span", childCount: 0, textLength: 10, computed: {}, parentSelector: "div.metrics > div.metric:nth-child(3)" }),

    // Content section: run detail with heading and task table
    el({ selector: "section.run-detail", tag: "section", childCount: 3, textLength: 700, computed: {}, parentSelector: "body" }),
    el({ selector: "section.run-detail > h2.run-title", tag: "h2", childCount: 0, textLength: 30, computed: {}, parentSelector: "section.run-detail" }),
    el({ selector: "section.run-detail > div.blockers", tag: "div", childCount: 2, textLength: 200, computed: {}, parentSelector: "section.run-detail" }),
    el({ selector: "section.run-detail > table.tasks", tag: "table", childCount: 5, textLength: 400, computed: {}, parentSelector: "section.run-detail" })
  ]);
}

/**
 * Negative twin for AG-014 with explicit NON-heading children.
 * The "hero-shaped" element has only p/span children (no h1/h2) — proof
 * that the hero exclusion is structural, not an artifact of element omission.
 */
function buildNonMarketingDashboard(): RenderedSnapshot {
  return snapshot([
    el({ selector: "body", tag: "body", semanticHint: "body", childCount: 2, textLength: 400, computed: { backgroundColor: "#0A0A0A" }, parentSelector: null }),
    // Section with only p/span children — NOT a hero (no h1/h2)
    el({ selector: "div.run-header", tag: "div", childCount: 3, textLength: 80, computed: {}, parentSelector: "body" }),
    el({ selector: "div.run-header > p.run-id", tag: "p", childCount: 0, textLength: 20, computed: {}, parentSelector: "div.run-header" }),
    el({ selector: "div.run-header > span.status", tag: "span", childCount: 0, textLength: 15, computed: {}, parentSelector: "div.run-header" }),
    el({ selector: "div.run-header > span.authority", tag: "span", childCount: 0, textLength: 18, computed: {}, parentSelector: "div.run-header" }),
    // Content — a run-detail section with heading and task table
    el({ selector: "section.content", tag: "section", childCount: 2, textLength: 320, computed: {}, parentSelector: "body" }),
    el({ selector: "section.content > div.blockers", tag: "div", childCount: 2, textLength: 140, computed: {}, parentSelector: "section.content" }),
    el({ selector: "section.content > table.tasks", tag: "table", childCount: 5, textLength: 200, computed: {}, parentSelector: "section.content" })
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RenderedSnapshot Zod schema", () => {
  it("parses a valid minimal snapshot", () => {
    const input = {
      url: "http://localhost:5173/",
      elements: [
        { selector: "body", tag: "body", childCount: 0, textLength: 0, computed: {}, parentSelector: null }
      ]
    };
    const parsed = RenderedSnapshotSchema.safeParse(input);
    assert.ok(parsed.success, `Schema parse failed: ${JSON.stringify(parsed.error)}`);
  });

  it("rejects a snapshot with a non-URL string in the url field", () => {
    const input = {
      url: "not-a-url",
      elements: []
    };
    assert.ok(!RenderedSnapshotSchema.safeParse(input).success, "Schema should reject non-URL string");
  });

  it("rejects a snapshot with a negative childCount", () => {
    const input = {
      url: "http://localhost:5173/",
      elements: [
        { selector: "body", tag: "body", childCount: -1, textLength: 0, computed: {}, parentSelector: null }
      ]
    };
    assert.ok(!RenderedSnapshotSchema.safeParse(input).success, "Schema should reject negative childCount");
  });
});

describe("AntiGenericReport Zod schema", () => {
  it("validates a clean report with no violations", () => {
    const report = runAntiGenericChecker(snapshot([]));
    const parsed = AntiGenericReportSchema.safeParse(report);
    assert.ok(parsed.success, `Report schema parse failed: ${JSON.stringify(parsed.error)}`);
  });
});

describe("AG-012 — three-card feature soup (non-waivable hard_fail proof)", () => {
  it("HARD_FAILS when a flex container has 3 equal-width children each with icon+title+body", () => {
    // Council-required falsifiability proof: this MUST hard_fail.
    const report = runAntiGenericChecker(buildThreeCardGrid());
    const ag012 = report.violations.filter((v) => v.agId === "AG-012");
    assert.ok(ag012.length > 0, "Expected at least one AG-012 violation on the three-card grid fixture");
    assert.equal(ag012[0]?.severity, "hard_fail", "AG-012 violation must be hard_fail");
    assert.ok(report.blocking, "blocking must be true when AG-012 hard_fail exists");
  });

  it("measured field cites the card count (machine-readable diff for repair loop)", () => {
    const report = runAntiGenericChecker(buildThreeCardGrid());
    const ag012 = report.violations.find((v) => v.agId === "AG-012");
    assert.ok(ag012?.measured !== undefined, "AG-012 violation must include a measured field");
    assert.ok(ag012?.measured?.includes("3") ?? false,
      `Expected measured to cite card count but got: ${ag012?.measured}`);
  });

  it("does NOT trigger on a clean dashboard layout (negative twin — no false positives)", () => {
    const report = runAntiGenericChecker(buildCleanDashboardLayout());
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-012" && v.severity === "hard_fail").length,
      0,
      "Clean dashboard layout must not hard_fail AG-012"
    );
  });

  it("emits a WARNING (not silence) when 3+ feature-card children have missing widthPx", () => {
    // A flex container with 3 feature-card-structured children but NO widthPx data.
    // Must emit a warning — the C1 rule must never be silently skipped.
    const containerSel = "div.cards";
    function cardNoWidth(index: number): RenderedElement[] {
      const cardSel = `div.cards > div.card:nth-child(${index})`;
      return [
        // No widthPx on the card
        el({ selector: cardSel, tag: "div", childCount: 3, textLength: 100, computed: { display: "block" }, parentSelector: containerSel }),
        el({ selector: `${cardSel} > svg`, tag: "svg", role: "img", childCount: 1, textLength: 0, computed: {}, parentSelector: cardSel }),
        el({ selector: `${cardSel} > h3`, tag: "h3", childCount: 0, textLength: 24, computed: {}, parentSelector: cardSel }),
        el({ selector: `${cardSel} > p`, tag: "p", childCount: 0, textLength: 90, computed: {}, parentSelector: cardSel })
      ];
    }
    const snap = snapshot([
      el({ selector: containerSel, tag: "div", childCount: 3, textLength: 300, computed: { display: "flex" }, parentSelector: null }),
      ...cardNoWidth(1),
      ...cardNoWidth(2),
      ...cardNoWidth(3)
    ]);
    const report = runAntiGenericChecker(snap);
    const ag012 = report.violations.filter((v) => v.agId === "AG-012");
    assert.ok(ag012.length > 0, "Expected AG-012 warning when widthPx is unavailable");
    assert.equal(ag012[0]?.severity, "warning", "Must be a warning, not hard_fail, when widthPx is absent");
    assert.ok(ag012[0]?.measured?.includes("widthPx unavailable") ?? false,
      `Expected measured to mention widthPx unavailable but got: ${ag012[0]?.measured}`);
    // A warning alone does not block
    assert.equal(report.blocking, false, "Warning alone must not set blocking=true");
  });

  it("does NOT trigger with only 2 feature-card children (guards ≥3 threshold)", () => {
    // Two cards: below the threshold, must not fire.
    const containerSel = "div.two-cards";
    function card2(index: number): RenderedElement[] {
      const cardSel = `div.two-cards > div.card:nth-child(${index})`;
      return [
        el({ selector: cardSel, tag: "div", childCount: 3, textLength: 100, computed: { display: "block", widthPx: 300 }, parentSelector: containerSel }),
        el({ selector: `${cardSel} > svg`, tag: "svg", role: "img", childCount: 1, textLength: 0, computed: {}, parentSelector: cardSel }),
        el({ selector: `${cardSel} > h3`, tag: "h3", childCount: 0, textLength: 24, computed: {}, parentSelector: cardSel }),
        el({ selector: `${cardSel} > p`, tag: "p", childCount: 0, textLength: 90, computed: {}, parentSelector: cardSel })
      ];
    }
    const snap = snapshot([
      el({ selector: containerSel, tag: "div", childCount: 2, textLength: 200, computed: { display: "flex", widthPx: 600 }, parentSelector: null }),
      ...card2(1),
      ...card2(2)
    ]);
    const report = runAntiGenericChecker(snap);
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-012").length,
      0,
      "2 feature-card children must NOT trigger AG-012 (threshold is ≥3)"
    );
  });

  it("does NOT trigger when 3 equal-width children lack feature-card structure (plain text divs)", () => {
    // Three equal-width divs with only plain text — no icon child, no title/body split.
    // Guards the hasFeatureCardStructure filter: equal width alone is not enough.
    const containerSel = "div.plain-row";
    const snap = snapshot([
      el({ selector: containerSel, tag: "div", childCount: 3, textLength: 150, computed: { display: "flex" }, parentSelector: null }),
      el({ selector: "div.plain-row > div:nth-child(1)", tag: "div", childCount: 0, textLength: 50, computed: { widthPx: 300 }, parentSelector: containerSel }),
      el({ selector: "div.plain-row > div:nth-child(2)", tag: "div", childCount: 0, textLength: 50, computed: { widthPx: 300 }, parentSelector: containerSel }),
      el({ selector: "div.plain-row > div:nth-child(3)", tag: "div", childCount: 0, textLength: 50, computed: { widthPx: 300 }, parentSelector: containerSel })
    ]);
    const report = runAntiGenericChecker(snap);
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-012").length,
      0,
      "3 equal-width plain-text divs (no icon+title+body structure) must NOT trigger AG-012"
    );
  });
});

describe("AG-012 — unequal widths (different-width feature cards must NOT fire)", () => {
  it("does NOT trigger when 3 feature-card-structured children have clearly different widths (ratio > 1.25)", () => {
    // Tests the "unequal" path in widthUniformity: cards are structurally feature-card-shaped
    // but have clearly different widths (1:2 ratio = 2.0 >> 1.25 cap).
    // AG-012 must NOT fire — this is a non-uniform layout, not 3-card feature soup.
    const containerSel = "div.unequal-cards";
    function unequalCard(index: number, widthPx: number): RenderedElement[] {
      const cardSel = `div.unequal-cards > div.card:nth-child(${index})`;
      return [
        el({ selector: cardSel, tag: "div", childCount: 3, textLength: 100,
          computed: { display: "block", widthPx }, parentSelector: containerSel }),
        el({ selector: `${cardSel} > svg`, tag: "svg", role: "img", childCount: 1, textLength: 0,
          computed: {}, parentSelector: cardSel }),
        el({ selector: `${cardSel} > h3`, tag: "h3", childCount: 0, textLength: 24,
          computed: {}, parentSelector: cardSel }),
        el({ selector: `${cardSel} > p`, tag: "p", childCount: 0, textLength: 90,
          computed: {}, parentSelector: cardSel })
      ];
    }
    const snap = snapshot([
      el({ selector: containerSel, tag: "div", childCount: 3, textLength: 300,
        computed: { display: "flex" }, parentSelector: null }),
      ...unequalCard(1, 200),  // narrow
      ...unequalCard(2, 200),  // narrow
      ...unequalCard(3, 400)   // wide — ratio 400/200 = 2.0 >> 1.25 cap
    ]);
    const report = runAntiGenericChecker(snap);
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-012").length,
      0,
      "3 feature-card children with unequal widths (ratio > 1.25) must NOT trigger AG-012"
    );
  });
});

describe("AG-012 — mixed widthPx (partial width data)", () => {
  it("emits a WARNING when 2 of 3 feature-card children have widthPx but 1 does not", () => {
    // Mixed case: some cards have widthPx, one does not.
    // widthUniformity must return "unknown" because ANY missing widthPx is indeterminate.
    // Must emit warning, NOT hard_fail.
    const containerSel = "div.mixed-cards";
    function cardWith(index: number, widthPx: number | undefined): RenderedElement[] {
      const cardSel = `div.mixed-cards > div.card:nth-child(${index})`;
      return [
        el({ selector: cardSel, tag: "div", childCount: 3, textLength: 100,
          computed: { display: "block", ...(widthPx !== undefined ? { widthPx } : {}) },
          parentSelector: containerSel }),
        el({ selector: `${cardSel} > svg`, tag: "svg", role: "img", childCount: 1, textLength: 0,
          computed: {}, parentSelector: cardSel }),
        el({ selector: `${cardSel} > h3`, tag: "h3", childCount: 0, textLength: 24,
          computed: {}, parentSelector: cardSel }),
        el({ selector: `${cardSel} > p`, tag: "p", childCount: 0, textLength: 90,
          computed: {}, parentSelector: cardSel })
      ];
    }
    const snap = snapshot([
      el({ selector: containerSel, tag: "div", childCount: 3, textLength: 300,
        computed: { display: "flex" }, parentSelector: null }),
      ...cardWith(1, 300),   // has widthPx
      ...cardWith(2, 300),   // has widthPx
      ...cardWith(3, undefined) // MISSING widthPx — should flip to "unknown"
    ]);
    const report = runAntiGenericChecker(snap);
    const ag012 = report.violations.filter((v) => v.agId === "AG-012");
    assert.ok(ag012.length > 0, "Expected AG-012 warning on mixed-widthPx fixture");
    assert.equal(ag012[0]?.severity, "warning",
      "Mixed widthPx (any undefined) must be a warning, not hard_fail");
    assert.ok(ag012[0]?.measured?.includes("widthPx unavailable") ?? false,
      `Expected measured to mention widthPx unavailable but got: ${ag012[0]?.measured}`);
    assert.equal(report.blocking, false, "Warning alone must not set blocking=true");
  });
});

describe("AG-014 — marketing-page patterns (hard_fail)", () => {
  it("HARD_FAILS on hero + equal-card-row + CTA marketing skeleton", () => {
    const report = runAntiGenericChecker(buildMarketingPageLayout());
    const ag014 = report.violations.filter((v) => v.agId === "AG-014");
    assert.ok(ag014.length > 0, "Expected AG-014 violation on marketing-page fixture");
    assert.equal(ag014[0]?.severity, "hard_fail", "AG-014 violation must be hard_fail");
    assert.ok(report.blocking, "blocking must be true when AG-014 hard_fail exists");
  });

  it("does NOT trigger on a non-marketing dashboard with explicit non-heading div.run-header children", () => {
    // Structural proof: the 'hero-shaped' div has only p/span children, not h1/h2.
    // AG-014 must NOT fire because hasHero requires a heading child.
    const report = runAntiGenericChecker(buildNonMarketingDashboard());
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-014").length,
      0,
      "Dashboard with p/span-only header section must not trigger AG-014"
    );
  });

  it("does NOT trigger on a real run-status dashboard (header+nav-link, 3 metric panels, content section)", () => {
    // This is the critical false-positive proof: a real operator dashboard with
    // a settings link in the header + 3 equal-width metric panels + a content
    // section with a heading must NOT hard_fail AG-014.
    const report = runAntiGenericChecker(buildRunStatusDashboard());
    const ag014 = report.violations.filter((v) => v.agId === "AG-014");
    assert.equal(
      ag014.length,
      0,
      `Run-status dashboard must NOT trigger AG-014. Got violations: ${JSON.stringify(ag014)}`
    );
    assert.equal(
      report.blocking,
      false,
      "Run-status dashboard must not be blocking"
    );
  });

  it("HARD_FAILS when CTA section's parent element has a compound selector but tag=main (isTopLevel resolves by tag, not string)", () => {
    // This is the false-negative proof required by the coordinator.
    // The parent element has selector "body > main" (compound — would have failed the
    // old TOP_LEVEL_PARENT_SELECTORS string-set check) but its tag is "main".
    // isTopLevelSection() must resolve the parent element by pointer and check tag,
    // NOT string-match parentSelector — so this must fire AG-014.
    const snap = snapshot([
      el({ selector: "body", tag: "body", semanticHint: "body", childCount: 1, textLength: 500,
        computed: { backgroundColor: "#0A0A0A" }, parentSelector: null }),
      // Parent with compound selector name — would fail old string-set check
      el({ selector: "body > main", tag: "main", childCount: 3, textLength: 450,
        computed: {}, parentSelector: "body" }),
      // Hero under body > main
      el({ selector: "body > main > section.hero", tag: "section", childCount: 2, textLength: 80,
        computed: {}, parentSelector: "body > main" }),
      el({ selector: "body > main > section.hero > h1", tag: "h1", childCount: 0, textLength: 50,
        computed: {}, parentSelector: "body > main > section.hero" }),
      // Equal-card row under body > main
      el({ selector: "body > main > div.features", tag: "div", childCount: 3, textLength: 300,
        computed: { display: "flex" }, parentSelector: "body > main" }),
      el({ selector: "body > main > div.features > div:nth-child(1)", tag: "div", childCount: 2,
        textLength: 100, computed: { widthPx: 300 }, parentSelector: "body > main > div.features" }),
      el({ selector: "body > main > div.features > div:nth-child(2)", tag: "div", childCount: 2,
        textLength: 100, computed: { widthPx: 300 }, parentSelector: "body > main > div.features" }),
      el({ selector: "body > main > div.features > div:nth-child(3)", tag: "div", childCount: 2,
        textLength: 100, computed: { widthPx: 300 }, parentSelector: "body > main > div.features" }),
      // CTA section with parentSelector = "body > main" (compound) — must be treated as top-level
      // because its parent element tag is "main"
      el({ selector: "body > main > section.cta", tag: "section", childCount: 2, textLength: 90,
        computed: {}, parentSelector: "body > main" }),
      el({ selector: "body > main > section.cta > h2", tag: "h2", childCount: 0, textLength: 40,
        computed: {}, parentSelector: "body > main > section.cta" }),
      el({ selector: "body > main > section.cta > button", tag: "button", role: "button",
        childCount: 0, textLength: 20, computed: {}, parentSelector: "body > main > section.cta" })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag014 = report.violations.filter((v) => v.agId === "AG-014");
    assert.ok(ag014.length > 0,
      "CTA section under a compound-named-selector main element must trigger AG-014 (parent resolved by tag, not string)");
    assert.equal(ag014[0]?.severity, "hard_fail");
  });

  it("does NOT trigger when a CTA-shaped div is nested under a non-top-level div (deep in content)", () => {
    // A div.cta inside div.content (parent tag "div") must NOT be treated as a
    // top-level CTA section — isTopLevelSection returns false when parent tag is "div".
    const snap = snapshot([
      el({ selector: "body", tag: "body", semanticHint: "body", childCount: 2, textLength: 500,
        computed: { backgroundColor: "#0A0A0A" }, parentSelector: null }),
      // Hero (needed for AG-014 triple) — at top level
      el({ selector: "section.hero", tag: "section", childCount: 2, textLength: 80,
        computed: {}, parentSelector: "body" }),
      el({ selector: "section.hero > h1", tag: "h1", childCount: 0, textLength: 50,
        computed: {}, parentSelector: "section.hero" }),
      // Equal-card row
      el({ selector: "div.features", tag: "div", childCount: 3, textLength: 300,
        computed: { display: "flex" }, parentSelector: "body" }),
      el({ selector: "div.features > div:nth-child(1)", tag: "div", childCount: 2,
        textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
      el({ selector: "div.features > div:nth-child(2)", tag: "div", childCount: 2,
        textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
      el({ selector: "div.features > div:nth-child(3)", tag: "div", childCount: 2,
        textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
      // A wrapper div — NOT body/main — contains the CTA-shaped div
      el({ selector: "div.content", tag: "div", childCount: 1, textLength: 120,
        computed: {}, parentSelector: "body" }),
      // CTA-shaped div nested inside div.content — parent tag is "div", not "body"/"main"
      // isTopLevelSection() must return false → AG-014 must NOT fire
      el({ selector: "div.content > div.cta", tag: "div", childCount: 2, textLength: 90,
        computed: {}, parentSelector: "div.content" }),
      el({ selector: "div.content > div.cta > h2", tag: "h2", childCount: 0, textLength: 40,
        computed: {}, parentSelector: "div.content > div.cta" }),
      el({ selector: "div.content > div.cta > button", tag: "button", role: "button",
        childCount: 0, textLength: 20, computed: {}, parentSelector: "div.content > div.cta" })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag014 = report.violations.filter((v) => v.agId === "AG-014");
    assert.equal(
      ag014.length,
      0,
      "A CTA-shaped div nested inside a non-top-level div must NOT trigger AG-014 (not a section-level CTA)"
    );
  });

  it("HARD_FAILS when a plain div (not section.cta) satisfies the CTA criteria", () => {
    // Prove the CTA check is tag-agnostic (section or div both trigger).
    // A div with parentSelector="body", a heading child, and a button must trigger.
    const snap = snapshot([
      el({ selector: "body", tag: "body", semanticHint: "body", childCount: 3, textLength: 400, computed: { backgroundColor: "#0A0A0A" }, parentSelector: null }),
      // Hero section
      el({ selector: "section.hero", tag: "section", childCount: 2, textLength: 80, computed: {}, parentSelector: "body" }),
      el({ selector: "section.hero > h1", tag: "h1", childCount: 0, textLength: 50, computed: {}, parentSelector: "section.hero" }),
      // Equal-card row
      el({ selector: "div.features", tag: "div", childCount: 3, textLength: 300, computed: { display: "flex" }, parentSelector: "body" }),
      el({ selector: "div.features > div:nth-child(1)", tag: "div", childCount: 2, textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
      el({ selector: "div.features > div:nth-child(2)", tag: "div", childCount: 2, textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
      el({ selector: "div.features > div:nth-child(3)", tag: "div", childCount: 2, textLength: 100, computed: { widthPx: 300 }, parentSelector: "div.features" }),
      // CTA as a plain div (not section) — heading + button must still trigger
      el({ selector: "div.cta-block", tag: "div", childCount: 2, textLength: 90, computed: {}, parentSelector: "body" }),
      el({ selector: "div.cta-block > h2", tag: "h2", childCount: 0, textLength: 40, computed: {}, parentSelector: "div.cta-block" }),
      el({ selector: "div.cta-block > button", tag: "button", role: "button", childCount: 0, textLength: 20, computed: {}, parentSelector: "div.cta-block" })
    ]);
    const report = runAntiGenericChecker(snap);
    const ag014 = report.violations.filter((v) => v.agId === "AG-014");
    assert.ok(ag014.length > 0, "A div CTA block with heading + button + hero + equal-card-row must trigger AG-014");
    assert.equal(ag014[0]?.severity, "hard_fail");
  });
});

describe("ancestors() cycle guard", () => {
  it("does NOT infinite-loop when parentSelector forms a cycle", () => {
    // An adversarial snapshot with A -> B -> A parentSelector cycle.
    // The cycle guard (visited Set) must break the walk and return partial results.
    const snap = snapshot([
      el({ selector: "div.a", tag: "div", childCount: 1, textLength: 100,
        computed: {}, parentSelector: "div.b" }),
      el({ selector: "div.b", tag: "div", childCount: 1, textLength: 100,
        computed: {}, parentSelector: "div.a" })
    ]);
    // runAntiGenericChecker calls checkAG014 which calls ancestors() internally.
    // If ancestors() has no cycle guard this test hangs. The assertion is just
    // that we get a result at all (no hang/crash) within a finite time.
    const report = runAntiGenericChecker(snap);
    // Should not throw, should return a valid report.
    assert.ok(typeof report.blocking === "boolean", "Cycle must not crash the checker");
  });
});

describe("uncheckedRules — declared advisory coverage (must not silently grow or shrink)", () => {
  it("contains exactly the expected set of non-checkable AG rule ids", () => {
    // AG-013 is NOT in uncheckedRules: checkAG013() runs a deterministic hex-palette
    // check. The token-NAME layer that can't be mechanized is documented in a comment
    // in the checker, not in the unchecked set.
    const expectedUnchecked = new Set(["AG-002", "AG-008", "AG-015"]);
    const report = runAntiGenericChecker(snapshot([]));
    const actualUnchecked = new Set(report.uncheckedRules);
    assert.deepEqual(actualUnchecked, expectedUnchecked,
      `uncheckedRules set changed. Expected ${JSON.stringify([...expectedUnchecked])} got ${JSON.stringify([...actualUnchecked])}`);
  });

  it("UNCHECKED_RULE_IDS export matches the report's uncheckedRules", () => {
    const report = runAntiGenericChecker(snapshot([]));
    assert.deepEqual(
      new Set(report.uncheckedRules),
      new Set(UNCHECKED_RULE_IDS),
      "Exported UNCHECKED_RULE_IDS must match the report's uncheckedRules"
    );
  });

  it("CHECKED_RULE_IDS covers ≥ 12 deterministic rules (AG-013 hex-palette check is now implemented)", () => {
    assert.ok(
      CHECKED_RULE_IDS.length >= 12,
      `Expected at least 12 checked rules, got ${CHECKED_RULE_IDS.length}: ${CHECKED_RULE_IDS.join(", ")}`
    );
  });

  it("checked + unchecked covers all 15 manifest AG rules without overlap", () => {
    const allManifestIds = new Set(CONSTRAINTS_MANIFEST.antiGenericRules.map((r) => r.id));
    const checked = new Set(CHECKED_RULE_IDS);
    const unchecked = new Set(UNCHECKED_RULE_IDS);
    for (const id of checked) {
      assert.ok(!unchecked.has(id), `AG rule ${id} is in both checked and unchecked sets`);
    }
    for (const id of allManifestIds) {
      assert.ok(
        checked.has(id) || unchecked.has(id),
        `AG rule ${id} from the manifest is neither in checked nor unchecked — missing coverage declaration`
      );
    }
  });
});
