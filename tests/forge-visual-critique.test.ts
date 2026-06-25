/**
 * Tests for src/forge/visual-critique.ts
 *
 * Covers:
 *   1. buildVisualCritique → "rework" for blocking anti-generic report
 *      (3-card AG-012 soup — council #1 falsifiable proof)
 *   2. buildVisualCritique → "rework" for failing asset-QA
 *   3. buildVisualCritique → "pass" when all inputs clean
 *   4. uncheckedRules from anti-generic report surface in uncheckedCoverage
 *   5. repairPlan embedded in critique with correct items
 *   6. scores are deterministic integer counts (NOT model opinion)
 *   7. genericAiSmell populated from hard_fail violations
 *   8. blockingIssues / nonBlockingIssues separation
 *   9. askUser = true when uncheckedCoverage is non-empty
 *  10. Determinism: same input => identical output
 *  11. Strict Zod parse on output
 *
 * The council-required falsifiability tests (council #1) are explicitly marked.
 * The council #3 concrete-diff test defers to forge-repair-plan.test.ts for
 * exhaustive instruction-level assertions; here we verify the repair plan is
 * embedded and has the right ruleId.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-visual-critique.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVisualCritique,
  VisualCritiqueSchema
} from "../src/forge/visual-critique.ts";
import {
  runAntiGenericChecker,
  RenderedSnapshotSchema
} from "../src/forge/anti-generic-checker.ts";
import type { RenderedElement, RenderedSnapshot } from "../src/forge/anti-generic-types.ts";
import type { AntiGenericReport } from "../src/forge/anti-generic-types.ts";
import type { AssetQAReport } from "../src/forge/asset-qa.ts";

// ---------------------------------------------------------------------------
// Shared fixture helpers (mirrors forge-anti-generic-checker.test.ts style)
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

/**
 * Canonical three-equal-card grid — triggers AG-012 hard_fail.
 * This is the council #1 falsifiability proof fixture.
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
      el({
        selector: cardSel,
        tag: "div",
        childCount: 3,
        textLength: 100,
        computed: { display: "block", widthPx: 300 },
        parentSelector: containerSel
      }),
      el({
        selector: `${cardSel} > svg`,
        tag: "svg",
        role: "img",
        childCount: 1,
        textLength: 0,
        computed: {},
        parentSelector: cardSel
      }),
      el({
        selector: `${cardSel} > h3`,
        tag: "h3",
        childCount: 0,
        textLength: 24,
        computed: {},
        parentSelector: cardSel
      }),
      el({
        selector: `${cardSel} > p`,
        tag: "p",
        childCount: 0,
        textLength: 90,
        computed: {},
        parentSelector: cardSel
      })
    ];
  }

  return snapshot([
    el({
      selector: "main",
      tag: "main",
      childCount: 1,
      textLength: 300,
      computed: {},
      parentSelector: null
    }),
    container,
    ...card(1),
    ...card(2),
    ...card(3)
  ]);
}

/**
 * A clean snapshot with no AG violations.
 */
function buildCleanSnapshot(): RenderedSnapshot {
  return snapshot([
    el({
      selector: "main",
      tag: "main",
      childCount: 1,
      textLength: 50,
      computed: {},
      parentSelector: null
    }),
    el({
      selector: "main > div",
      tag: "div",
      childCount: 0,
      textLength: 50,
      computed: {},
      parentSelector: "main"
    })
  ]);
}

function makeCleanAntiGenericReport(): AntiGenericReport {
  const snap = RenderedSnapshotSchema.parse(buildCleanSnapshot());
  return runAntiGenericChecker(snap);
}

function makeBlockingAntiGenericReport(): AntiGenericReport {
  const snap = RenderedSnapshotSchema.parse(buildThreeCardGrid());
  return runAntiGenericChecker(snap);
}

function makeFailingQaReport(): AssetQAReport {
  return {
    assetPath: "/repo/web/public/fallbacks/hero.svg",
    pass: false,
    findings: [
      {
        id: "QA-001",
        severity: "fail",
        message: "QA-001 [fail]: File does not exist.",
        measured: "file absent",
        expected: "file present"
      }
    ]
  };
}

function makePassingQaReport(): AssetQAReport {
  return {
    assetPath: "/repo/web/public/fallbacks/icon.svg",
    pass: true,
    findings: [
      {
        id: "QA-001",
        severity: "pass",
        message: "QA-001 [pass]: File exists."
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// COUNCIL #1 — Falsifiable rework on generic-but-otherwise-valid input
// ---------------------------------------------------------------------------

describe("buildVisualCritique — council #1: falsifiable rework (AG-012 soup)", () => {
  it("returns decision='rework' for a blocking AG-012 three-card-grid report", () => {
    // This is the falsifiable proof: a generic-but-otherwise-valid 3-card layout
    // must return rework, not pass. The anti-generic checker produces a hard_fail
    // from the DOM structure alone — no accessibility or layout defect required.
    const antiGeneric = makeBlockingAntiGenericReport();
    assert.equal(antiGeneric.blocking, true, "fixture must produce blocking report");

    const critique = buildVisualCritique({ antiGeneric });

    assert.equal(
      critique.decision,
      "rework",
      "generic 3-card soup must return rework (council #1)"
    );
    assert.ok(
      critique.blockingIssues.length > 0,
      "blocking issues must be populated"
    );
    // genericAiSmell must surface the AG-012 violation.
    const hasAg012Smell = critique.genericAiSmell.some(
      (msg) => msg.includes("AG-012")
    );
    assert.ok(hasAg012Smell, "genericAiSmell must contain AG-012 message");
    // Repair plan must include an AG-012 item.
    const hasAg012Repair = critique.repairPlan.items.some(
      (item) => item.ruleId === "AG-012"
    );
    assert.ok(hasAg012Repair, "repairPlan must include an AG-012 item");
    // Repair plan must be blocking.
    assert.equal(critique.repairPlan.blocking, true);
  });

  it("returns decision='pass' when all inputs are clean (no violations, no QA fails)", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    const critique = buildVisualCritique({ antiGeneric, assetQa: [makePassingQaReport()] });

    assert.equal(critique.decision, "pass");
    assert.equal(critique.blockingIssues.length, 0);
    assert.equal(critique.repairPlan.blocking, false);
    assert.equal(critique.repairPlan.count, 0);
  });
});

// ---------------------------------------------------------------------------
// COUNCIL #1 — rework on failing asset-QA
// ---------------------------------------------------------------------------

describe("buildVisualCritique — rework for failing asset-QA", () => {
  it("returns decision='rework' when any assetQa report fails", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    const critique = buildVisualCritique({
      antiGeneric,
      assetQa: [makeFailingQaReport()]
    });

    assert.equal(
      critique.decision,
      "rework",
      "failing QA must return rework"
    );
    // repairPlan must include QA-001 item.
    const hasQaItem = critique.repairPlan.items.some(
      (item) => item.ruleId === "QA-001"
    );
    assert.ok(hasQaItem, "repairPlan must include a QA fail item");
    assert.equal(critique.repairPlan.blocking, true);
  });

  it("returns decision='pass' when assetQa all pass (no AG violations)", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    const critique = buildVisualCritique({
      antiGeneric,
      assetQa: [makePassingQaReport()]
    });
    assert.equal(critique.decision, "pass");
  });
});

// ---------------------------------------------------------------------------
// uncheckedCoverage — advisory gaps never hidden
// ---------------------------------------------------------------------------

describe("buildVisualCritique — uncheckedCoverage", () => {
  it("surfaces uncheckedRules from the anti-generic report in uncheckedCoverage", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    // The clean report will still have unchecked rules (AG-002, AG-008, AG-015).
    const critique = buildVisualCritique({ antiGeneric });

    assert.ok(
      critique.uncheckedCoverage.length > 0,
      "uncheckedCoverage must be non-empty when rules are unchecked"
    );
    // Must include known unchecked rule ids.
    assert.ok(
      critique.uncheckedCoverage.includes("AG-002") ||
      critique.uncheckedCoverage.includes("AG-008") ||
      critique.uncheckedCoverage.includes("AG-015"),
      `uncheckedCoverage must carry unchecked AG ids; got: ${JSON.stringify(critique.uncheckedCoverage)}`
    );
  });

  it("askUser = true when uncheckedCoverage is non-empty", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    const critique = buildVisualCritique({ antiGeneric });
    // Since the anti-generic checker always has at least one unchecked rule,
    // askUser must be true for all non-trivial reports.
    if (critique.uncheckedCoverage.length > 0) {
      assert.equal(critique.askUser, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Scores — deterministic from violation counts
// ---------------------------------------------------------------------------

describe("buildVisualCritique — deterministic scores", () => {
  it("originality score decreases with hard_fail count (floored at 1)", () => {
    // Clean: originality should be 5 (0 hard_fails).
    const cleanReport = makeCleanAntiGenericReport();
    const cleanCritique = buildVisualCritique({ antiGeneric: cleanReport });
    assert.equal(cleanCritique.scores.originality, 5);

    // Blocking AG-012 report: has 1 hard_fail => originality = 4.
    const blockingReport = makeBlockingAntiGenericReport();
    const blockingCritique = buildVisualCritique({ antiGeneric: blockingReport });
    assert.ok(
      blockingCritique.scores.originality < 5,
      "originality must decrease with hard_fail violations"
    );
    assert.ok(
      blockingCritique.scores.originality >= 1,
      "originality must be floored at 1"
    );
  });

  it("asset_quality = 5 when all QA reports pass", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    const critique = buildVisualCritique({
      antiGeneric,
      assetQa: [makePassingQaReport(), makePassingQaReport()]
    });
    assert.equal(critique.scores.asset_quality, 5);
  });

  it("asset_quality decreases for each failing QA report", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    const critique = buildVisualCritique({
      antiGeneric,
      assetQa: [makeFailingQaReport(), makePassingQaReport()]
    });
    assert.ok(
      critique.scores.asset_quality < 5,
      "asset_quality must decrease for failing QA"
    );
  });

  it("scores are integers in range", () => {
    const antiGeneric = makeBlockingAntiGenericReport();
    const critique = buildVisualCritique({ antiGeneric });
    assert.ok(Number.isInteger(critique.scores.originality));
    assert.ok(Number.isInteger(critique.scores.accessibility));
    assert.ok(Number.isInteger(critique.scores.asset_quality));
    assert.ok(critique.scores.originality >= 1 && critique.scores.originality <= 5);
    assert.ok(critique.scores.accessibility >= 1 && critique.scores.accessibility <= 5);
    assert.ok(critique.scores.asset_quality >= 0 && critique.scores.asset_quality <= 5);
  });
});

// ---------------------------------------------------------------------------
// blockingIssues / nonBlockingIssues separation
// ---------------------------------------------------------------------------

describe("buildVisualCritique — issue separation", () => {
  it("hard_fail violations appear in blockingIssues and genericAiSmell", () => {
    const antiGeneric = makeBlockingAntiGenericReport();
    const critique = buildVisualCritique({ antiGeneric });

    assert.ok(critique.blockingIssues.length > 0);
    assert.ok(critique.genericAiSmell.length > 0);
    // Every blocking issue must cite an AG id.
    for (const msg of critique.blockingIssues) {
      assert.ok(
        /AG-\d{3}/.test(msg),
        `blockingIssues entry must cite an AG id: "${msg}"`
      );
    }
  });

  it("warning violations appear in nonBlockingIssues (not blockingIssues)", () => {
    // Build a report with only a warning violation (AG-012 warning = missing widthPx).
    const warningOnly: AntiGenericReport = {
      violations: [
        {
          agId: "AG-012",
          severity: "warning",
          selector: "main > div.grid",
          measured: "3 feature-card children; widthPx unavailable",
          cap: "0",
          message: "AG-012: warning message"
        }
      ],
      uncheckedRules: ["AG-002"],
      blocking: false
    };
    const critique = buildVisualCritique({ antiGeneric: warningOnly });

    assert.equal(critique.decision, "pass", "warning-only report should pass");
    assert.equal(critique.blockingIssues.length, 0, "no blocking issues for warnings");
    assert.ok(
      critique.nonBlockingIssues.length > 0,
      "warning goes to nonBlockingIssues"
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("buildVisualCritique — determinism", () => {
  it("produces identical output for the same input", () => {
    const antiGeneric = makeBlockingAntiGenericReport();
    const qa = [makeFailingQaReport()];

    const critique1 = buildVisualCritique({ antiGeneric, assetQa: qa });
    const critique2 = buildVisualCritique({ antiGeneric, assetQa: qa });

    assert.deepEqual(
      critique1,
      critique2,
      "determinism: same input => identical output"
    );
  });
});

// ---------------------------------------------------------------------------
// Strict Zod parse
// ---------------------------------------------------------------------------

describe("buildVisualCritique — strict schema parse", () => {
  it("output passes VisualCritiqueSchema.parse", () => {
    const antiGeneric = makeBlockingAntiGenericReport();
    const critique = buildVisualCritique({ antiGeneric });
    // Must not throw.
    const parsed = VisualCritiqueSchema.parse(critique);
    assert.equal(parsed.decision, "rework");
  });

  it("clean input output also passes VisualCritiqueSchema.parse", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    const critique = buildVisualCritique({ antiGeneric });
    const parsed = VisualCritiqueSchema.parse(critique);
    assert.equal(parsed.decision, "pass");
  });
});

// ---------------------------------------------------------------------------
// Council #3 — repair plan embedded with concrete items
// ---------------------------------------------------------------------------

describe("buildVisualCritique — council #3: repairPlan embedded", () => {
  it("repairPlan is embedded with concrete items (not empty) for blocking input", () => {
    const antiGeneric = makeBlockingAntiGenericReport();
    const critique = buildVisualCritique({ antiGeneric });

    assert.ok(critique.repairPlan.count > 0, "repairPlan must have items for blocking input");
    for (const item of critique.repairPlan.items) {
      // Each item must have a concrete instruction (not just "fix it" or similar).
      assert.ok(item.instruction.length > 20, `instruction too short: "${item.instruction}"`);
      assert.ok(item.ruleId.length > 0, "ruleId must be set");
    }
  });
});

// ---------------------------------------------------------------------------
// No-assetQa case
// ---------------------------------------------------------------------------

describe("buildVisualCritique — optional assetQa", () => {
  it("works correctly when assetQa is omitted", () => {
    const antiGeneric = makeCleanAntiGenericReport();
    const critique = buildVisualCritique({ antiGeneric });
    // Should not throw; decision based on anti-generic alone.
    assert.equal(critique.decision, "pass");
    assert.equal(critique.scores.asset_quality, 5);
  });
});
