/**
 * Tests for the S1 density anti-generic assertions added by the dashQuality
 * initiative (council condition C13):
 *   AG-016 — pill-tab detection (hard_fail)
 *   AG-017 — task-row height-density (warning)
 *   AG-018 — empty-state icon pattern (hard_fail)
 *
 * Each rule gets a negative twin (the forbidden pattern MUST fire) and positive
 * guards (the correct developer-tool pattern must NOT fire), so the gate is a
 * real, falsifiable check rather than a no-op.
 *
 * Run:
 *   node --experimental-strip-types --test tests/forge-anti-generic-s1-density.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runAntiGenericChecker } from "../src/forge/anti-generic-checker.ts";
import type { RenderedElement, RenderedSnapshot } from "../src/forge/anti-generic-checker.ts";
import { CONSTRAINTS_MANIFEST } from "../src/forge/constraints-manifest.ts";

function el(
  overrides: Partial<RenderedElement> & { selector: string; tag: string }
): RenderedElement {
  return { childCount: 0, textLength: 0, computed: {}, parentSelector: null, ...overrides };
}

function run(elements: RenderedElement[]) {
  const snapshot: RenderedSnapshot = { url: "http://localhost:5173/", elements };
  return runAntiGenericChecker(snapshot, CONSTRAINTS_MANIFEST);
}

// ---------------------------------------------------------------------------
// AG-016 — pill-tab detection (hard_fail)
// ---------------------------------------------------------------------------

describe("AG-016 — pill-tab detection (hard_fail)", () => {
  it("role=tab with border-radius > 2px hard_fails (the pill pattern)", () => {
    const report = run([
      el({ selector: "div.tab-bar", tag: "div", role: "tablist" }),
      el({
        selector: "button.tab-pill",
        tag: "button",
        role: "tab",
        computed: { borderRadiusPx: 9999 },
        parentSelector: "div.tab-bar"
      })
    ]);
    const ag016 = report.violations.filter((v) => v.agId === "AG-016");
    assert.equal(ag016.length, 1, "a pill-shaped tab must produce exactly one AG-016 violation");
    assert.equal(ag016[0]?.severity, "hard_fail", "AG-016 must be hard_fail");
    assert.ok(report.blocking, "an AG-016 hard_fail must set report.blocking");
  });

  it("role=tab at the 2px cap (underline-only) does NOT fire", () => {
    const report = run([
      el({ selector: "button.tab-a", tag: "button", role: "tab", computed: { borderRadiusPx: 2 } }),
      el({ selector: "button.tab-b", tag: "button", role: "tab", computed: { borderRadiusPx: 0 } })
    ]);
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-016").length,
      0,
      "underline-only tabs (radius <= 2px) must not trip AG-016"
    );
  });

  it("a non-tab element with a large radius does NOT trip AG-016 (scoped to role=tab)", () => {
    const report = run([
      el({ selector: "div.avatar", tag: "div", role: "img", computed: { borderRadiusPx: 50 } })
    ]);
    assert.equal(report.violations.filter((v) => v.agId === "AG-016").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-017 — task-row height density (warning)
// ---------------------------------------------------------------------------

describe("AG-017 — task-row height density (warning)", () => {
  it("a role=listitem taller than 48px warns (consumer-card padding)", () => {
    const report = run([
      el({ selector: "div.row-fat", tag: "div", role: "listitem", computed: { heightPx: 64 } })
    ]);
    const ag017 = report.violations.filter((v) => v.agId === "AG-017");
    assert.equal(ag017.length, 1, "a 64px list row must produce one AG-017 violation");
    assert.equal(ag017[0]?.severity, "warning", "AG-017 is a warning, not a hard_fail");
  });

  it("dense rows at/under the 48px cap do NOT warn (boundary)", () => {
    const report = run([
      el({ selector: "div.row-cap", tag: "div", role: "row", computed: { heightPx: 48 } }),
      el({ selector: "div.row-dense", tag: "div", role: "listitem", computed: { heightPx: 36 } })
    ]);
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-017").length,
      0,
      "rows <= 48px are within the standard-density cap"
    );
  });

  it("a row with no measured heightPx is silently skipped (cannot assert what we cannot measure)", () => {
    const report = run([
      el({ selector: "div.row-unmeasured", tag: "div", role: "listitem", computed: {} })
    ]);
    assert.equal(report.violations.filter((v) => v.agId === "AG-017").length, 0);
  });
});

// ---------------------------------------------------------------------------
// AG-018 — empty-state icon pattern (hard_fail)
// ---------------------------------------------------------------------------

describe("AG-018 — empty-state icon pattern (hard_fail)", () => {
  it("a container with exactly an icon + short paragraph hard_fails (illustration-above-label)", () => {
    const report = run([
      el({ selector: "div.empty", tag: "div", childCount: 2 }),
      el({ selector: "div.empty > svg", tag: "svg", role: "img", parentSelector: "div.empty" }),
      el({ selector: "div.empty > p", tag: "p", textLength: 18, parentSelector: "div.empty" })
    ]);
    const ag018 = report.violations.filter((v) => v.agId === "AG-018");
    assert.equal(ag018.length, 1, "icon-above-short-paragraph must produce one AG-018 violation");
    assert.equal(ag018[0]?.severity, "hard_fail", "AG-018 must be hard_fail");
    assert.ok(report.blocking, "an AG-018 hard_fail must set report.blocking");
  });

  it("a plain mono-text empty state (single short paragraph, no icon) does NOT fire", () => {
    const report = run([
      el({ selector: "div.empty-ok", tag: "div", childCount: 1 }),
      el({ selector: "div.empty-ok > p", tag: "p", textLength: 22, parentSelector: "div.empty-ok" })
    ]);
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-018").length,
      0,
      "the required pattern (plain mono text, no illustration) must pass"
    );
  });

  it("an icon + label among 3+ children (e.g. a header row) does NOT false-positive", () => {
    const report = run([
      el({ selector: "div.header", tag: "div", childCount: 3 }),
      el({ selector: "div.header > svg", tag: "svg", role: "img", parentSelector: "div.header" }),
      el({ selector: "div.header > span", tag: "span", textLength: 20, parentSelector: "div.header" }),
      el({ selector: "div.header > button", tag: "button", role: "button", textLength: 10, parentSelector: "div.header" })
    ]);
    assert.equal(
      report.violations.filter((v) => v.agId === "AG-018").length,
      0,
      "the 2-child constraint must not false-positive on a real icon+label+action header"
    );
  });
});
