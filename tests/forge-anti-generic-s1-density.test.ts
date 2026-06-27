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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runAntiGenericChecker } from "../src/forge/anti-generic-checker.ts";
import type { RenderedElement, RenderedSnapshot } from "../src/forge/anti-generic-checker.ts";

function el(
  overrides: Partial<RenderedElement> & { selector: string; tag: string }
): RenderedElement {
  return { childCount: 0, textLength: 0, computed: {}, parentSelector: null, ...overrides };
}

function run(elements: RenderedElement[]) {
  const snapshot: RenderedSnapshot = { url: "http://localhost:5173/", elements };
  // runAntiGenericChecker loads CONSTRAINTS_MANIFEST from module scope — single arg.
  return runAntiGenericChecker(snapshot);
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

// ---------------------------------------------------------------------------
// AG-018 single-illustration allow-marker (council forgeEmptyStateIllustration)
// ---------------------------------------------------------------------------

describe("AG-018 — data-ag018-allow marker exemption (council C1/C2)", () => {
  /** Run with a set of QA-passed asset ids supplied to the checker. */
  function runWith(elements: RenderedElement[], qaPassedAssetIds: string[]) {
    const snapshot: RenderedSnapshot = { url: "http://localhost:5173/", elements };
    return runAntiGenericChecker(snapshot, { qaPassedAssetIds: new Set(qaPassedAssetIds) });
  }

  const ASSET = "dashboard-empty-state";

  function emptyStateWithMarker(markerOn: "container" | "icon"): RenderedElement[] {
    return [
      el({
        selector: "div.empty",
        tag: "div",
        childCount: 2,
        ...(markerOn === "container" ? { ag018Allow: ASSET } : {}),
      }),
      el({
        selector: "div.empty > img",
        tag: "img",
        role: "presentation",
        parentSelector: "div.empty",
        ...(markerOn === "icon" ? { ag018Allow: ASSET } : {}),
      }),
      el({ selector: "div.empty > p", tag: "p", textLength: 18, parentSelector: "div.empty" }),
    ];
  }

  it("marker on the container + QA-passed asset + singleton → EXEMPT (no AG-018)", () => {
    const report = runWith(emptyStateWithMarker("container"), [ASSET]);
    assert.equal(report.violations.filter((v) => v.agId === "AG-018").length, 0,
      "a QA-passed, singleton, council-marked illustration must be exempt");
  });

  it("marker on the icon child also exempts", () => {
    const report = runWith(emptyStateWithMarker("icon"), [ASSET]);
    assert.equal(report.violations.filter((v) => v.agId === "AG-018").length, 0);
  });

  it("marker present but asset id NOT QA-passed → still hard_fails (fail closed)", () => {
    const report = runWith(emptyStateWithMarker("container"), [/* empty: asset not passed */]);
    const ag018 = report.violations.filter((v) => v.agId === "AG-018");
    assert.equal(ag018.length, 1, "an unverifiable marker must not exempt");
    assert.equal(ag018[0]?.severity, "hard_fail");
  });

  it("no qaPassedAssetIds supplied (default) → marker is not honored", () => {
    const snapshot: RenderedSnapshot = { url: "http://localhost:5173/", elements: emptyStateWithMarker("container") };
    const report = runAntiGenericChecker(snapshot); // no opts → fail closed
    const ag018 = report.violations.filter((v) => v.agId === "AG-018");
    assert.equal(ag018.length, 1);
    assert.equal(ag018[0]?.severity, "hard_fail", "fail-closed must remain a hard_fail, not be demoted");
    assert.ok(report.blocking);
  });

  it("two markers anywhere → hard_fail singleton violation (cannot self-replicate)", () => {
    const elements: RenderedElement[] = [
      ...emptyStateWithMarker("container"),
      el({ selector: "div.empty2", tag: "div", childCount: 2, ag018Allow: ASSET }),
      el({ selector: "div.empty2 > img", tag: "img", role: "presentation", parentSelector: "div.empty2" }),
      el({ selector: "div.empty2 > p", tag: "p", textLength: 18, parentSelector: "div.empty2" }),
    ];
    const report = runWith(elements, [ASSET]);
    const ag018 = report.violations.filter((v) => v.agId === "AG-018");
    assert.ok(ag018.some((v) => v.measured?.includes("markers")),
      "two markers must produce a singleton AG-018 hard_fail");
    assert.ok(report.blocking, "the singleton violation must block");
  });

  it("an UNMARKED icon+text empty state still hard_fails even when a QA-passed set exists", () => {
    const report = runWith(
      [
        el({ selector: "div.empty", tag: "div", childCount: 2 }),
        el({ selector: "div.empty > img", tag: "img", role: "presentation", parentSelector: "div.empty" }),
        el({ selector: "div.empty > p", tag: "p", textLength: 18, parentSelector: "div.empty" }),
      ],
      [ASSET],
    );
    const ag018 = report.violations.filter((v) => v.agId === "AG-018");
    assert.equal(ag018.length, 1,
      "the exemption requires the explicit marker — a bare illustration still fails");
    assert.equal(ag018[0]?.severity, "hard_fail",
      "the base regression twin must falsify a severity demotion, not just count");
    assert.ok(report.blocking, "an unmarked illustration must still block");
  });

  it("end-to-end: the committed manifest marks dashboard-empty-state QA-passed, which exempts the marked snapshot", () => {
    // Read the REAL committed asset manifest (the C1 manifest→checker contract).
    const manifestUrl = new URL("../web/src/assets/asset-manifest.json", import.meta.url);
    const manifest = JSON.parse(readFileSync(fileURLToPath(manifestUrl), "utf8")) as {
      assets: Array<{ id: string; qaStatus: string }>;
    };
    const entry = manifest.assets.find((a) => a.id === ASSET);
    assert.ok(entry, `manifest must contain the ${ASSET} asset`);
    assert.equal(entry?.qaStatus, "pass", "the dashboard empty-state asset must be QA-passed");

    // Feed the manifest's QA-passed ids to the checker exactly as the runtime does.
    const qaPassedAssetIds = new Set(
      manifest.assets.filter((a) => a.qaStatus === "pass").map((a) => a.id)
    );
    const snapshot: RenderedSnapshot = { url: "http://localhost:5173/", elements: emptyStateWithMarker("container") };
    const report = runAntiGenericChecker(snapshot, { qaPassedAssetIds });
    assert.equal(report.violations.filter((v) => v.agId === "AG-018").length, 0,
      "the manifest-passed, marked illustration must be exempt end-to-end");
  });
});
