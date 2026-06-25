/**
 * Tests for src/forge/repair-plan.ts
 *
 * Covers:
 *   1. AG-003 over-cap-radius violation → concrete "reduce … to within {cap}" instruction
 *      citing measured + cap (council #3 concrete-diff proof)
 *   2. 1:1 mapping: one item per violation
 *   3. Stable deterministic ordering (by ruleId then selector)
 *   4. Blocking flag mirrors antiGeneric.blocking
 *   5. Asset-QA fail findings produce repair items
 *   6. Determinism: same input => identical output
 *   7. Strict Zod parse: schema rejects out-of-range values
 *   8. Message caps enforced
 *   9. Empty reports produce empty plan
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-repair-plan.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRepairPlan,
  RepairPlanSchema,
  RepairPlanItemSchema
} from "../src/forge/repair-plan.ts";
import type { AntiGenericReport, Violation } from "../src/forge/anti-generic-types.ts";
import type { AssetQAReport } from "../src/forge/asset-qa.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeViolation(overrides: Partial<Violation> & { agId: string }): Violation {
  return {
    severity: "hard_fail",
    message: `${overrides.agId}: Test violation`,
    ...overrides
  };
}

function makeReport(violations: Violation[]): AntiGenericReport {
  return {
    violations,
    uncheckedRules: ["AG-002", "AG-008", "AG-015"],
    blocking: violations.some((v) => v.severity === "hard_fail")
  };
}

function makeQaReport(pass: boolean, failIds: string[] = []): AssetQAReport {
  const findings = failIds.map((id) => ({
    id,
    severity: "fail" as const,
    message: `${id} [fail]: test finding`,
    measured: "test measured",
    expected: "test expected"
  }));
  if (pass && failIds.length === 0) {
    findings.push({
      id: "QA-001",
      severity: "pass" as const,
      message: "QA-001 [pass]: all good",
      measured: undefined,
      expected: undefined
    });
  }
  return {
    assetPath: "/repo/web/public/fallbacks/hero.svg",
    pass,
    findings
  };
}

// ---------------------------------------------------------------------------
// Council #3 test: AG-003 concrete instruction
// ---------------------------------------------------------------------------

describe("buildRepairPlan — AG-003 concrete instruction (council #3)", () => {
  it("emits a concrete 'reduce borderRadius from {measured} to within {cap}' instruction", () => {
    const violation = makeViolation({
      agId: "AG-003",
      severity: "hard_fail",
      selector: "main > div.card",
      measured: "borderRadius=12px",
      cap: "≤8px",
      message: "AG-003: Border radius 12px exceeds cap on <div> \"main > div.card\"."
    });
    const report = makeReport([violation]);
    const plan = buildRepairPlan(report);

    assert.equal(plan.items.length, 1, "exactly 1 item");
    const item = plan.items[0];
    assert.ok(item !== undefined, "item must exist");

    // MUST cite measured value in instruction.
    assert.ok(
      item.instruction.includes("12px"),
      `instruction must cite measured "12px"; got: ${item.instruction}`
    );

    // MUST cite cap value in instruction.
    assert.ok(
      item.instruction.includes("≤8px") || item.instruction.includes("8px"),
      `instruction must cite cap "≤8px"; got: ${item.instruction}`
    );

    // MUST express the "reduce borderRadius" action (not vague).
    assert.ok(
      item.instruction.toLowerCase().includes("reduce") ||
      item.instruction.toLowerCase().includes("borderradius") ||
      item.instruction.toLowerCase().includes("border"),
      `instruction must be concrete (contain 'reduce' or 'border*'); got: ${item.instruction}`
    );

    // Must NOT be vague ("improve", "fix it", "update", etc.).
    assert.ok(
      !item.instruction.toLowerCase().startsWith("improve"),
      `instruction must not start with vague 'improve'; got: ${item.instruction}`
    );

    // Measured and cap fields must be carried through.
    assert.equal(item.measured, "borderRadius=12px");
    assert.equal(item.cap, "≤8px");
    assert.equal(item.ruleId, "AG-003");
    assert.equal(item.severity, "hard_fail");
    assert.equal(item.selector, "main > div.card");
  });
});

// ---------------------------------------------------------------------------
// 1:1 mapping
// ---------------------------------------------------------------------------

describe("buildRepairPlan — 1:1 violation to item mapping", () => {
  it("produces exactly one item per violation", () => {
    const violations = [
      makeViolation({ agId: "AG-001", selector: "div.bg", measured: "backgroundImage=linear-gradient(…)", cap: "no gradient fills" }),
      makeViolation({ agId: "AG-004", selector: "div.card", measured: "boxShadow=0 4px 6px rgba(0,0,0,0.3)", cap: "no box-shadow on dark surfaces" }),
      makeViolation({ agId: "AG-012", selector: "div.grid", measured: "3 equal-width cards", cap: "0" })
    ];
    const report = makeReport(violations);
    const plan = buildRepairPlan(report);

    assert.equal(plan.items.length, 3, "3 violations => 3 items");
    assert.equal(plan.count, 3, "count convenience field");
  });

  it("returns empty plan for zero violations", () => {
    const report = makeReport([]);
    const plan = buildRepairPlan(report);
    assert.equal(plan.items.length, 0);
    assert.equal(plan.count, 0);
    assert.equal(plan.blocking, false);
  });
});

// ---------------------------------------------------------------------------
// Stable ordering
// ---------------------------------------------------------------------------

describe("buildRepairPlan — stable ordering", () => {
  it("orders items by ruleId then selector (lexicographic)", () => {
    const violations = [
      makeViolation({ agId: "AG-012", selector: "div.z" }),
      makeViolation({ agId: "AG-003", selector: "div.b" }),
      makeViolation({ agId: "AG-003", selector: "div.a" }),
      makeViolation({ agId: "AG-001", selector: "div.x" })
    ];
    const report = makeReport(violations);
    const plan = buildRepairPlan(report);

    const ruleIds = plan.items.map((i) => i.ruleId);
    assert.deepEqual(ruleIds, ["AG-001", "AG-003", "AG-003", "AG-012"]);

    // Within AG-003, selector "div.a" < "div.b"
    const ag003Items = plan.items.filter((i) => i.ruleId === "AG-003");
    assert.equal(ag003Items[0]?.selector, "div.a");
    assert.equal(ag003Items[1]?.selector, "div.b");
  });

  it("produces identical output for the same input (determinism)", () => {
    const violations = [
      makeViolation({ agId: "AG-009", selector: "div.c", measured: "gap=7px", cap: "multiples of 4px" }),
      makeViolation({ agId: "AG-001", selector: "div.a", measured: "backgroundImage=linear-gradient(…)", cap: "no gradients" })
    ];
    const report = makeReport(violations);
    const plan1 = buildRepairPlan(report);
    const plan2 = buildRepairPlan(report);

    assert.deepEqual(plan1, plan2, "determinism: same input => same output");
  });
});

// ---------------------------------------------------------------------------
// Blocking flag
// ---------------------------------------------------------------------------

describe("buildRepairPlan — blocking flag", () => {
  it("blocking = true when antiGeneric.blocking is true", () => {
    const v = makeViolation({ agId: "AG-012", severity: "hard_fail" });
    const plan = buildRepairPlan(makeReport([v]));
    assert.equal(plan.blocking, true);
  });

  it("blocking = true when a QA report fails", () => {
    const cleanReport = makeReport([]);
    const failingQa = makeQaReport(false, ["QA-001"]);
    const plan = buildRepairPlan(cleanReport, [failingQa]);
    assert.equal(plan.blocking, true);
  });

  it("blocking = false when all clean", () => {
    const v = makeViolation({ agId: "AG-013", severity: "warning" });
    const report: AntiGenericReport = {
      violations: [v],
      uncheckedRules: [],
      blocking: false
    };
    const passingQa = makeQaReport(true);
    const plan = buildRepairPlan(report, [passingQa]);
    assert.equal(plan.blocking, false);
  });
});

// ---------------------------------------------------------------------------
// Asset-QA fail findings → repair items
// ---------------------------------------------------------------------------

describe("buildRepairPlan — asset-QA fail findings", () => {
  it("includes repair items for QA fail findings (not for pass/warn)", () => {
    const qaReport: AssetQAReport = {
      assetPath: "/repo/web/public/fallbacks/hero.svg",
      pass: false,
      findings: [
        { id: "QA-001", severity: "fail", message: "QA-001 [fail]: File missing", measured: "file absent", expected: "file present" },
        { id: "QA-002", severity: "pass", message: "QA-002 [pass]: format ok" },
        { id: "QA-U01", severity: "warn", message: "QA-U01 [unchecked]: prompt match", unchecked: true }
      ]
    };
    const plan = buildRepairPlan(makeReport([]), [qaReport]);
    // Only the "fail" finding becomes a repair item.
    assert.equal(plan.items.length, 1, "1 fail finding => 1 item");
    assert.equal(plan.items[0]?.ruleId, "QA-001");
    assert.equal(plan.items[0]?.severity, "hard_fail");
  });

  it("QA item instruction cites the expected value", () => {
    const qaReport: AssetQAReport = {
      assetPath: "/repo/web/public/assets/icon.svg",
      pass: false,
      findings: [
        { id: "QA-007", severity: "fail", message: "QA-007 [fail]: too large", measured: "600000 bytes", expected: "≤ 512000 bytes" }
      ]
    };
    const plan = buildRepairPlan(makeReport([]), [qaReport]);
    const item = plan.items[0];
    assert.ok(item !== undefined);
    // Instruction must cite the expected cap.
    assert.ok(
      item.instruction.includes("512000") || item.instruction.includes("≤"),
      `instruction should cite the cap value; got: ${item.instruction}`
    );
  });
});

// ---------------------------------------------------------------------------
// Zod strict parse / schema validation
// ---------------------------------------------------------------------------

describe("buildRepairPlan — schema validation", () => {
  it("output passes RepairPlanSchema.parse", () => {
    const v = makeViolation({ agId: "AG-003", measured: "borderRadius=12px", cap: "≤8px" });
    const plan = buildRepairPlan(makeReport([v]));
    // Must not throw.
    const parsed = RepairPlanSchema.parse(plan);
    assert.equal(parsed.count, 1);
  });

  it("RepairPlanItemSchema rejects empty ruleId", () => {
    assert.throws(() => {
      RepairPlanItemSchema.parse({ ruleId: "", severity: "hard_fail", instruction: "fix it" });
    });
  });

  it("RepairPlanItemSchema rejects invalid severity", () => {
    assert.throws(() => {
      RepairPlanItemSchema.parse({ ruleId: "AG-003", severity: "critical", instruction: "fix it" });
    });
  });
});

// ---------------------------------------------------------------------------
// Instruction cap enforcement
// ---------------------------------------------------------------------------

describe("buildRepairPlan — instruction length cap", () => {
  it("truncates extremely long measured/cap values gracefully", () => {
    const longMeasured = "x".repeat(600);
    const v = makeViolation({
      agId: "AG-003",
      severity: "hard_fail",
      measured: longMeasured,
      cap: "≤8px"
    });
    const plan = buildRepairPlan(makeReport([v]));
    const item = plan.items[0];
    assert.ok(item !== undefined);
    assert.ok(
      item.instruction.length <= 512,
      `instruction must be capped at 512 chars; got ${item.instruction.length}`
    );
    if (item.measured !== undefined) {
      assert.ok(item.measured.length <= 128, "measured capped at 128");
    }
  });
});

// ---------------------------------------------------------------------------
// Warning violations
// ---------------------------------------------------------------------------

describe("buildRepairPlan — warning violations", () => {
  it("includes warning-severity items in the plan with severity=warning", () => {
    const v: Violation = {
      agId: "AG-012",
      severity: "warning",
      selector: "main > div.grid",
      measured: "3 feature-card children; widthPx unavailable",
      cap: "0",
      message: "AG-012 [warning]: …"
    };
    const report: AntiGenericReport = {
      violations: [v],
      uncheckedRules: [],
      blocking: false
    };
    const plan = buildRepairPlan(report);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0]?.severity, "warning");
    assert.equal(plan.blocking, false);
  });
});
