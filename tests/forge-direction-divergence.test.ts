/**
 * Tests for src/forge/direction-divergence.ts
 *
 * Covers (TDD — written before implementation):
 *   - DD-001: fewer than 2 directions → hard_fail
 *   - DD-002: 2 near-identical directions (1 safe + 1 decoy) → hard_fail
 *             This is the council #2 falsifiable proof test.
 *   - DD-003: direction with empty whyItIsNotGeneric → hard_fail
 *   - DD-004: duplicate id or name across directions → warning
 *   - Genuinely divergent directions with non-empty whyItIsNotGeneric → passed
 *   - Determinism: same input ⇒ identical output
 *   - Strict Zod parse: invalid input rejected at schema layer
 *   - uncheckedRules surfaced
 *   - Capped string length enforcement
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-direction-divergence.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkDirectionDivergence } from "../src/forge/direction-divergence.ts";
import {
  DesignDirectionSchema,
  DirectionSetSchema,
  DirectionDivergenceResultSchema
} from "../src/forge/design-direction-contract.ts";
import type { DesignDirection } from "../src/forge/design-direction-contract.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid DesignDirection with genuinely divergent strategies.
 * Used as the "clean" divergent baseline.
 */
function makeMinimal(overrides: Partial<DesignDirection>): DesignDirection {
  return {
    id: "dir-a",
    name: "Monolithic Grid",
    oneSentenceConcept: "A dense data-centric grid layout that surfaces all metrics simultaneously.",
    emotionalEffect: "Analytical clarity through information density and visual weight.",
    layoutStrategy: "Fixed full-width grid with pinned sidebar navigation and collapsible rows.",
    typographyStrategy: "Monospace typeface at small sizes with numeric tabular lining.",
    colorStrategy: "Muted blue-grey palette with high-contrast amber accent for critical values.",
    assetStrategy: "Inline SVG sparklines and status icons, no raster images.",
    interactionStrategy: "Keyboard-first navigation with inline editing and hover tooltips.",
    risks: ["High information density may overwhelm new users."],
    whyItIsNotGeneric: [
      "Uses a fixed-width monospace typeface which is unusual for dashboard UIs.",
      "Amber on blue-grey is a deliberately non-default color pairing."
    ],
    ...overrides
  };
}

/**
 * A second genuinely divergent direction (different layout/color/typography).
 */
function makeSecondDivergent(): DesignDirection {
  return {
    id: "dir-b",
    name: "Editorial Flow",
    oneSentenceConcept: "A typographically-driven vertical flow layout inspired by long-form editorial design.",
    emotionalEffect: "Calm focused reading rhythm with intentional white space.",
    layoutStrategy: "Narrow centered column with generous vertical rhythm and progressive disclosure.",
    typographyStrategy: "Variable-weight serif headings paired with sans-serif body copy at readable sizes.",
    colorStrategy: "Warm cream background with deep forest green accents and terracotta highlights.",
    assetStrategy: "Large hero images and pull-quote illustrations, photograph-led.",
    interactionStrategy: "Scroll-driven reveal animations with smooth section transitions.",
    risks: ["Narrow column limits data density.", "Serif fonts may feel unexpected for a developer tool."],
    whyItIsNotGeneric: [
      "Serif headings in a developer dashboard are deliberately unexpected and create typographic tension.",
      "Terracotta+forest-green is an unusual palette for tech products."
    ]
  };
}

/**
 * A near-identical decoy direction (copies most strategies from dir-a, changes only names).
 * This is the "1 safe + 1 decoy" anti-pattern council #2 targets.
 */
function makeDecoy(): DesignDirection {
  return {
    id: "dir-decoy",
    name: "Monolithic Grid Variant",
    oneSentenceConcept: "A dense data-centric grid layout that surfaces all metrics simultaneously.",
    emotionalEffect: "Analytical clarity through information density and visual weight.",
    layoutStrategy: "Fixed full-width grid with pinned sidebar navigation and collapsible rows.",
    typographyStrategy: "Monospace typeface at small sizes with numeric tabular lining.",
    colorStrategy: "Muted blue-grey palette with high-contrast amber accent for critical values.",
    assetStrategy: "Inline SVG sparklines and status icons, no raster images.",
    interactionStrategy: "Keyboard-first navigation with inline editing and hover tooltips.",
    risks: ["High information density may overwhelm new users."],
    whyItIsNotGeneric: [
      "Uses a fixed-width monospace typeface which is unusual for dashboard UIs."
    ]
  };
}

// ---------------------------------------------------------------------------
// Helper assertion
// ---------------------------------------------------------------------------

function assertHasViolation(
  result: ReturnType<typeof checkDirectionDivergence>,
  ruleId: string,
  expectedSeverity: "hard_fail" | "warning"
): void {
  const matches = result.violations.filter(v => v.ruleId === ruleId);
  assert.equal(
    matches.length >= 1,
    true,
    `Expected at least one violation for ${ruleId}, got: ${JSON.stringify(result.violations)}`
  );
  const v = matches[0]!;
  assert.equal(
    v.severity,
    expectedSeverity,
    `Expected severity=${expectedSeverity} for ${ruleId}, got: ${v.severity}`
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DesignDirectionSchema", () => {
  it("parses a valid direction", () => {
    const result = DesignDirectionSchema.safeParse(makeMinimal({}));
    assert.equal(result.success, true);
  });

  it("rejects missing required field", () => {
    const { id: _id, ...noId } = makeMinimal({});
    const result = DesignDirectionSchema.safeParse(noId);
    assert.equal(result.success, false);
  });

  it("rejects string exceeding max length cap", () => {
    const result = DesignDirectionSchema.safeParse(
      makeMinimal({ oneSentenceConcept: "x".repeat(1025) })
    );
    assert.equal(result.success, false);
  });

  it("rejects empty string for required text fields", () => {
    const result = DesignDirectionSchema.safeParse(
      makeMinimal({ layoutStrategy: "" })
    );
    assert.equal(result.success, false);
  });
});

describe("DirectionSetSchema", () => {
  it("parses an array of valid directions", () => {
    const result = DirectionSetSchema.safeParse([makeMinimal({}), makeSecondDivergent()]);
    assert.equal(result.success, true);
  });
});

describe("DirectionDivergenceResultSchema", () => {
  it("validates a passing result shape", () => {
    const result = DirectionDivergenceResultSchema.safeParse({
      violations: [],
      passed: true,
      divergentAxisCount: 3,
      uncheckedRules: ["DD-U01: semantic quality of rationale text requires model/human review."]
    });
    assert.equal(result.success, true);
  });
});

describe("checkDirectionDivergence — DD-001: fewer than 2 directions", () => {
  it("hard_fails when given 0 directions", () => {
    const result = checkDirectionDivergence([]);
    assert.equal(result.passed, false);
    assertHasViolation(result, "DD-001", "hard_fail");
  });

  it("hard_fails when given exactly 1 direction", () => {
    const result = checkDirectionDivergence([makeMinimal({})]);
    assert.equal(result.passed, false);
    assertHasViolation(result, "DD-001", "hard_fail");
  });

  it("does NOT fire DD-001 when 2 directions provided", () => {
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent()]);
    const dd001 = result.violations.filter(v => v.ruleId === "DD-001");
    assert.equal(dd001.length, 0, "DD-001 must not fire with 2 directions");
  });
});

describe("checkDirectionDivergence — DD-002: near-identical directions (council #2 proof)", () => {
  it("hard_fails when 2 directions are near-identical across strategy axes — the 1-safe+1-decoy case", () => {
    // This is the council #2 falsifiable proof test.
    // dir-a and dir-decoy have identical strategies on all 5 axes.
    // The checker must detect this and hard_fail — not accept the decoy as a real alternative.
    const result = checkDirectionDivergence([makeMinimal({}), makeDecoy()]);
    assert.equal(result.passed, false, "Near-identical directions must not pass");
    assertHasViolation(result, "DD-002", "hard_fail");
  });

  it("does NOT fire DD-002 for genuinely divergent directions", () => {
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent()]);
    const dd002 = result.violations.filter(v => v.ruleId === "DD-002");
    assert.equal(
      dd002.length,
      0,
      `DD-002 must not fire for genuinely divergent directions. Got: ${JSON.stringify(result.violations)}`
    );
  });

  it("exposes divergentAxisCount in the result", () => {
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent()]);
    assert.equal(typeof result.divergentAxisCount, "number");
    assert.equal(result.divergentAxisCount >= 2, true, "Genuinely divergent pair must show ≥2 divergent axes");
  });
});

describe("checkDirectionDivergence — DD-003: empty whyItIsNotGeneric", () => {
  it("hard_fails when a direction has empty whyItIsNotGeneric array", () => {
    const dirA = makeMinimal({ whyItIsNotGeneric: [] });
    const dirB = makeSecondDivergent();
    const result = checkDirectionDivergence([dirA, dirB]);
    assert.equal(result.passed, false);
    assertHasViolation(result, "DD-003", "hard_fail");
  });

  it("hard_fails when a direction has whyItIsNotGeneric with only whitespace-only strings", () => {
    const dirA = makeMinimal({ whyItIsNotGeneric: ["   ", "  "] });
    const dirB = makeSecondDivergent();
    const result = checkDirectionDivergence([dirA, dirB]);
    assert.equal(result.passed, false);
    assertHasViolation(result, "DD-003", "hard_fail");
  });

  it("does NOT fire DD-003 when whyItIsNotGeneric has non-empty content", () => {
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent()]);
    const dd003 = result.violations.filter(v => v.ruleId === "DD-003");
    assert.equal(dd003.length, 0, "DD-003 must not fire when rationale is present");
  });

  it("reports which direction ID has the missing rationale", () => {
    const dirA = makeMinimal({ id: "missing-rationale", whyItIsNotGeneric: [] });
    const dirB = makeSecondDivergent();
    const result = checkDirectionDivergence([dirA, dirB]);
    const dd003 = result.violations.filter(v => v.ruleId === "DD-003");
    assert.equal(dd003.length >= 1, true);
    const v = dd003[0]!;
    assert.equal(
      v.message.includes("missing-rationale"),
      true,
      `Expected message to cite direction id "missing-rationale", got: "${v.message}"`
    );
  });
});

describe("checkDirectionDivergence — DD-004: duplicate id or name", () => {
  it("emits warning when two directions share the same id", () => {
    const dirA = makeMinimal({ id: "dup-id" });
    const dirB = makeSecondDivergent();
    const dirBdup = { ...dirB, id: "dup-id" };
    const result = checkDirectionDivergence([dirA, dirBdup]);
    assertHasViolation(result, "DD-004", "warning");
  });

  it("emits warning when two directions share the same name", () => {
    const dirA = makeMinimal({ name: "Same Name" });
    const dirB = makeSecondDivergent();
    const dirBdup = { ...dirB, name: "Same Name" };
    const result = checkDirectionDivergence([dirA, dirBdup]);
    assertHasViolation(result, "DD-004", "warning");
  });

  it("does NOT fire DD-004 when ids and names are all unique", () => {
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent()]);
    const dd004 = result.violations.filter(v => v.ruleId === "DD-004");
    assert.equal(dd004.length, 0, "DD-004 must not fire when all ids and names are unique");
  });

  it("DD-004 is a warning, not hard_fail", () => {
    const dirA = makeMinimal({ id: "dup" });
    const dirB = makeSecondDivergent();
    const dirBdup = { ...dirB, id: "dup" };
    const result = checkDirectionDivergence([dirA, dirBdup]);
    const dd004 = result.violations.filter(v => v.ruleId === "DD-004");
    assert.equal(dd004.length >= 1, true);
    for (const v of dd004) {
      assert.equal(v.severity, "warning");
    }
  });
});

describe("checkDirectionDivergence — passed result", () => {
  it("passes when 2 genuinely divergent directions with non-empty whyItIsNotGeneric are provided", () => {
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent()]);
    assert.equal(result.passed, true, `Expected passed=true, got violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.violations.filter(v => v.severity === "hard_fail").length, 0);
  });
});

describe("checkDirectionDivergence — uncheckedRules", () => {
  it("always surfaces uncheckedRules in the result", () => {
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent()]);
    assert.equal(Array.isArray(result.uncheckedRules), true);
    assert.equal(result.uncheckedRules.length >= 1, true, "At least one unchecked rule must be declared");
  });

  it("uncheckedRules appears even on failing results", () => {
    const result = checkDirectionDivergence([]);
    assert.equal(Array.isArray(result.uncheckedRules), true);
    assert.equal(result.uncheckedRules.length >= 1, true);
  });
});

describe("checkDirectionDivergence — determinism", () => {
  it("produces identical output for same input (called twice)", () => {
    const dirs = [makeMinimal({}), makeSecondDivergent()];
    const r1 = checkDirectionDivergence(dirs);
    const r2 = checkDirectionDivergence(dirs);
    assert.deepEqual(r1, r2, "Same input must always produce identical output");
  });

  it("produces identical output for near-identical pair (called twice)", () => {
    const dirs = [makeMinimal({}), makeDecoy()];
    const r1 = checkDirectionDivergence(dirs);
    const r2 = checkDirectionDivergence(dirs);
    assert.deepEqual(r1, r2);
  });
});

describe("checkDirectionDivergence — result validates against schema", () => {
  it("result for passing case validates against DirectionDivergenceResultSchema", () => {
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent()]);
    const parsed = DirectionDivergenceResultSchema.safeParse(result);
    assert.equal(parsed.success, true, `Schema validation failed: ${JSON.stringify((parsed as {error?: unknown}).error)}`);
  });

  it("result for failing case validates against DirectionDivergenceResultSchema", () => {
    const result = checkDirectionDivergence([]);
    const parsed = DirectionDivergenceResultSchema.safeParse(result);
    assert.equal(parsed.success, true, `Schema validation failed: ${JSON.stringify((parsed as {error?: unknown}).error)}`);
  });
});

describe("checkDirectionDivergence — 3+ directions", () => {
  it("passes when 3 genuinely divergent directions are provided", () => {
    const dirC: DesignDirection = {
      id: "dir-c",
      name: "Brutalist Terminal",
      oneSentenceConcept: "A raw command-line aesthetic stripped of visual decoration.",
      emotionalEffect: "Power-user directness and unmediated control over the system.",
      layoutStrategy: "Full-width single-column terminal output with no sidebars or panels.",
      typographyStrategy: "Fixed-pitch courier-style font, uppercase labels, ASCII dividers.",
      colorStrategy: "Black background with bright green phosphor text and red error states.",
      assetStrategy: "Text-only ASCII art diagrams, zero raster or vector graphics.",
      interactionStrategy: "Command-entry prompts with autocomplete, no click targets.",
      risks: ["Unfamiliar aesthetic may alienate users expecting a modern UI."],
      whyItIsNotGeneric: [
        "Terminal green-on-black is almost never used in contemporary SaaS products.",
        "ASCII-art diagrams are deliberately retro and unexpected."
      ]
    };
    const result = checkDirectionDivergence([makeMinimal({}), makeSecondDivergent(), dirC]);
    assert.equal(result.passed, true, `Expected passed=true, got: ${JSON.stringify(result.violations)}`);
  });

  it("hard_fails when 2 of 3 directions are near-identical decoys", () => {
    // dirA + decoy = near-identical pair → DD-002 should fire
    const result = checkDirectionDivergence([makeMinimal({}), makeDecoy(), makeSecondDivergent()]);
    // The pair (dirA, decoy) is near-identical → DD-002 fires
    assertHasViolation(result, "DD-002", "hard_fail");
  });
});
