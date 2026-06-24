/**
 * Tests for src/evals/forge-baseline.ts — forge gate regression baseline.
 *
 * Verifies:
 *   1. runForgeBaseline() passRate === 1.0 (all deterministic cases must hold)
 *   2. AG-012 generic-soup case: blocking=true captured, score=1
 *   3. AG-012 distinctive-dashboard case: blocking=false captured, score=1
 *   4. Asset QA good-asset case: pass=true captured, score=1
 *   5. Asset QA bad-asset case: pass=false captured, score=1
 *   6. Report shape: authorityLabel, threshold, meetsThreshold
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-baseline.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runForgeBaseline
} from "../src/evals/forge-baseline.ts";
import type { ForgeEvalReport } from "../src/evals/forge-baseline.ts";

describe("forge-baseline", () => {
  // Run once and cache — all sub-tests reuse the same report so we pay the
  // I/O cost (temp-file write + read) only once.
  const report: ForgeEvalReport = runForgeBaseline();

  it("passRate === 1.0 — all deterministic invariants hold", () => {
    assert.strictEqual(
      report.summary.passRate,
      1.0,
      `Expected passRate=1.0 but got ${report.summary.passRate}. ` +
      `Failed cases: ${report.cases.filter((c) => !c.passed).map((c) => `${c.id}(${c.details})`).join(", ")}`
    );
  });

  it("summary.authorityLabel is 'derived_only'", () => {
    assert.strictEqual(report.summary.authorityLabel, "derived_only");
  });

  it("summary.threshold is 1.0", () => {
    assert.strictEqual(report.summary.threshold, 1.0);
  });

  it("summary.meetsThreshold is true", () => {
    assert.strictEqual(report.summary.meetsThreshold, true);
  });

  it("report contains exactly 6 cases", () => {
    assert.strictEqual(report.cases.length, 6);
  });

  it("every case has authorityLabel 'derived_only'", () => {
    for (const c of report.cases) {
      assert.strictEqual(
        c.authorityLabel,
        "derived_only",
        `case ${c.id} has authorityLabel=${c.authorityLabel}`
      );
    }
  });

  it("every case has score === 1 (threshold=1.0, all must hold)", () => {
    for (const c of report.cases) {
      assert.strictEqual(
        c.score,
        1,
        `case ${c.id} has score=${c.score} (details: ${c.details})`
      );
    }
  });

  it("every case has non-empty evidenceRefs", () => {
    for (const c of report.cases) {
      assert.ok(
        c.evidenceRefs.length > 0,
        `case ${c.id} has no evidenceRefs`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Anti-generic cases
  // ---------------------------------------------------------------------------

  describe("anti_generic area", () => {
    it("three-card-soup case: blocking captured as true (details check)", () => {
      const c = report.cases.find((x) => x.id === "anti_generic_three_card_soup_blocks");
      assert.ok(c !== undefined, "case anti_generic_three_card_soup_blocks not found");
      assert.ok(
        c.details.includes("blocking=true"),
        `Expected details to contain 'blocking=true', got: ${c.details}`
      );
      assert.ok(
        c.details.includes("ag012=present"),
        `Expected details to contain 'ag012=present', got: ${c.details}`
      );
    });

    it("three-card-soup case: passed === true (verdict matched expected)", () => {
      const c = report.cases.find((x) => x.id === "anti_generic_three_card_soup_blocks");
      assert.ok(c !== undefined);
      assert.strictEqual(c.passed, true);
    });

    it("distinctive-dashboard case: blocking captured as false (details check)", () => {
      const c = report.cases.find((x) => x.id === "anti_generic_distinctive_dashboard_passes");
      assert.ok(c !== undefined, "case anti_generic_distinctive_dashboard_passes not found");
      assert.ok(
        c.details.includes("blocking=false"),
        `Expected details to contain 'blocking=false', got: ${c.details}`
      );
    });

    it("distinctive-dashboard case: passed === true (no false-positive)", () => {
      const c = report.cases.find((x) => x.id === "anti_generic_distinctive_dashboard_passes");
      assert.ok(c !== undefined);
      assert.strictEqual(c.passed, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Asset QA cases
  // ---------------------------------------------------------------------------

  describe("asset_qa area", () => {
    it("committed SVG case: pass captured as true (details check)", () => {
      const c = report.cases.find((x) => x.id === "asset_qa_committed_svg_passes");
      assert.ok(c !== undefined, "case asset_qa_committed_svg_passes not found");
      assert.ok(
        c.details.includes("pass=true"),
        `Expected details to contain 'pass=true', got: ${c.details}`
      );
    });

    it("committed SVG case: passed === true (good asset accepted)", () => {
      const c = report.cases.find((x) => x.id === "asset_qa_committed_svg_passes");
      assert.ok(c !== undefined);
      assert.strictEqual(c.passed, true);
    });

    it("XSS SVG case: pass captured as false (details check)", () => {
      const c = report.cases.find((x) => x.id === "asset_qa_xss_svg_fails");
      assert.ok(c !== undefined, "case asset_qa_xss_svg_fails not found");
      assert.ok(
        c.details.includes("pass=false"),
        `Expected details to contain 'pass=false', got: ${c.details}`
      );
      // QA-004 (<script>) must be among the fail IDs
      assert.ok(
        c.details.includes("QA-004"),
        `Expected QA-004 in failIds, got: ${c.details}`
      );
    });

    it("XSS SVG case: passed === true (bad asset rejected, verdict matched)", () => {
      const c = report.cases.find((x) => x.id === "asset_qa_xss_svg_fails");
      assert.ok(c !== undefined);
      assert.strictEqual(c.passed, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Contrast cases
  // ---------------------------------------------------------------------------

  describe("contrast area", () => {
    it("AA-pass case: passed === true (#EDEDED on #0A0A0A meets AA)", () => {
      const c = report.cases.find((x) => x.id === "contrast_aa_pass_text_on_surface");
      assert.ok(c !== undefined, "case contrast_aa_pass_text_on_surface not found");
      assert.strictEqual(c.passed, true);
      assert.ok(
        c.details.includes("meetsAA(#EDEDED, #0A0A0A)=true"),
        `Expected details to indicate meetsAA=true, got: ${c.details}`
      );
    });

    it("AA-fail case: passed === true (near-identical grays correctly rejected)", () => {
      const c = report.cases.find((x) => x.id === "contrast_aa_fail_near_identical_grays");
      assert.ok(c !== undefined, "case contrast_aa_fail_near_identical_grays not found");
      assert.strictEqual(c.passed, true);
      assert.ok(
        c.details.includes("meetsAA(#888888, #777777)=false"),
        `Expected details to indicate meetsAA=false, got: ${c.details}`
      );
    });
  });
});
