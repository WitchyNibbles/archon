/**
 * Tests for src/forge/design-system-validator.ts
 *
 * Covers:
 *   - DS-001: second accent color → hard_fail (measured + cap); schema-first path regression
 *   - DS-002: gradient in surface/accent override → hard_fail (measured + cap)
 *   - DS-003: radius over manifest cap → hard_fail (measured + cap); non-pixel unchecked note
 *   - DS-004: motion duration over manifest cap → hard_fail (measured + cap)
 *   - DS-005: set slot missing justification → hard_fail
 *   - Clean bounded target override (single accent + justified typeface within caps) → passed
 *   - mode "self" with ANY diverging override → hard_fail
 *   - mode "self" with no overrides → passed
 *   - Determinism: same input ⇒ identical output
 *   - Strict Zod parse: invalid proposal is rejected at schema layer
 *   - Validator reads cap values from CONSTRAINTS_MANIFEST (not hardcoded literals)
 *   - accentColors field survives DesignSystemProposalSchema.parse() (DS-001 not a no-op)
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-design-system-validator.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateDesignSystem } from "../src/forge/design-system-validator.ts";
import {
  DesignSystemProposalSchema,
  DesignSystemValidationSchema
} from "../src/forge/design-system-contract.ts";
import type { DesignSystemProposal } from "../src/forge/design-system-contract.ts";
import { CONSTRAINTS_MANIFEST } from "../src/forge/constraints-manifest.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid target proposal with no overrides set.
 * Useful as the "clean" baseline that passes all DS rules.
 */
function cleanTargetProposal(): DesignSystemProposal {
  return {
    mode: "target",
    overrides: {}
  };
}

/**
 * Assert that a validation result has at least one hard_fail violation for the
 * given ruleId. When measuredPattern/capPattern are provided, assert both are
 * present and match — every DS-NNN numeric rule MUST carry measured + cap for
 * machine-readable repair (acceptance criterion).
 */
function assertSingleViolation(
  result: ReturnType<typeof validateDesignSystem>,
  ruleId: string,
  opts?: { measuredPattern?: RegExp; capPattern?: RegExp }
): void {
  const match = result.violations.filter(v => v.ruleId === ruleId);
  assert.equal(
    match.length >= 1,
    true,
    `Expected at least one violation for ${ruleId}, got: ${JSON.stringify(result.violations)}`
  );
  const v = match[0]!;
  assert.equal(v.severity, "hard_fail");
  if (opts?.measuredPattern !== undefined) {
    assert.equal(
      opts.measuredPattern.test(v.measured ?? ""),
      true,
      `Expected measured to match ${String(opts.measuredPattern)}, got: "${v.measured}"`
    );
  }
  if (opts?.capPattern !== undefined) {
    assert.equal(
      opts.capPattern.test(v.cap ?? ""),
      true,
      `Expected cap to match ${String(opts.capPattern)}, got: "${v.cap}"`
    );
  }
}

// ---------------------------------------------------------------------------
// DS-001: second accent color
// ---------------------------------------------------------------------------

describe("DS-001 — second accent color", () => {
  it("hard_fails when accentColors has 2 elements", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        accent: { color: "#6366F1", justification: "brand match" }
      },
      accentColors: ["#6366F1", "#10B981"]
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    assertSingleViolation(result, "DS-001", {
      measuredPattern: /2 accent/i,
      capPattern: /1 accent/i
    });
  });

  it("passes when only one accent is present via accentColors", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        accent: { color: "#6366F1", justification: "brand match" }
      },
      accentColors: ["#6366F1"]
    };

    const result = validateDesignSystem(proposal);
    const ds001 = result.violations.filter(v => v.ruleId === "DS-001");
    assert.equal(ds001.length, 0, "DS-001 should not fire for a single accent");
  });

  it("does NOT fire when accentColors is absent (single-slot schema cannot produce multi-accent)", () => {
    // When accentColors is not set at all, DS-001 must not fire.
    // The single overrides.accent slot structurally bounds callers to one accent value;
    // DS-001 only fires on explicit accentColors declarations of length > 1.
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        accent: { color: "#6366F1", justification: "brand primary" }
      }
      // accentColors deliberately omitted
    };

    const result = validateDesignSystem(proposal);
    const ds001 = result.violations.filter(v => v.ruleId === "DS-001");
    assert.equal(ds001.length, 0, "DS-001 must not fire when accentColors is absent");
  });

  it("measured and cap are machine-readable strings", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      accentColors: ["#6366F1", "#10B981", "#EF4444"]
    };
    const result = validateDesignSystem(proposal);
    const v = result.violations.find(vv => vv.ruleId === "DS-001")!;
    assert.ok(v, "DS-001 violation expected");
    assert.ok(typeof v.measured === "string" && v.measured.length > 0, "measured must be a non-empty string");
    assert.ok(typeof v.cap === "string" && v.cap.length > 0, "cap must be a non-empty string");
  });

  it("schema-first path: accentColors survives DesignSystemProposalSchema.parse() and DS-001 fires", () => {
    // REGRESSION GUARD: This test proves accentColors is NOT stripped by Zod parse.
    // If accentColors were absent from the schema, parse() would strip it and DS-001
    // would silently never fire in the real pipeline — a critical council-#4 defect.
    const raw = {
      mode: "target",
      overrides: {
        accent: { color: "#6366F1", justification: "primary brand" }
      },
      accentColors: ["#6366F1", "#10B981"]
    };

    const parsed = DesignSystemProposalSchema.parse(raw);

    // accentColors must be present on the parsed result
    assert.ok(
      Array.isArray(parsed.accentColors),
      "accentColors must survive DesignSystemProposalSchema.parse() — it is a schema field, not a passthrough extra"
    );
    assert.equal(parsed.accentColors?.length, 2, "Both accent colors must be present after parse");

    // DS-001 must fire when validateDesignSystem is called with the parsed proposal
    const result = validateDesignSystem(parsed);
    assert.equal(result.passed, false, "DS-001 must fire on the schema-parsed proposal");
    const v = result.violations.find(vv => vv.ruleId === "DS-001");
    assert.ok(v, "DS-001 violation must be present after schema parse");
    assert.equal(v!.severity, "hard_fail");
    assert.ok(/2 accent/i.test(v!.measured ?? ""), `Expected measured to mention 2 accents, got: "${v!.measured}"`);
    assert.ok(/1 accent/i.test(v!.cap ?? ""), `Expected cap to mention 1 accent, got: "${v!.cap}"`);
  });
});

// ---------------------------------------------------------------------------
// DS-002: gradient in surface/accent override
// ---------------------------------------------------------------------------

describe("DS-002 — gradient value in surface or accent override", () => {
  it("hard_fails when accent color is a gradient (with measured + cap)", () => {
    const gradientValue = "linear-gradient(135deg, #6366F1, #818CF8)";
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        accent: {
          color: gradientValue,
          justification: "brand gradient"
        }
      }
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    assertSingleViolation(result, "DS-002", {
      measuredPattern: /accent\.color/i,
      capPattern: /solid color/i
    });
  });

  it("hard_fails when a surface slot contains a gradient (with measured + cap)", () => {
    const gradientValue = "linear-gradient(180deg, #0A0A0A 0%, #1A1A1A 100%)";
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        surface: {
          base: gradientValue,
          justification: "dark gradient base"
        }
      }
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    assertSingleViolation(result, "DS-002", {
      measuredPattern: /surface\.base/i,
      capPattern: /solid color/i
    });
  });

  it("passes when surface values are solid colors", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        surface: {
          base: "#0D0D0D",
          raised: "#141414",
          justification: "slightly shifted neutrals"
        }
      }
    };

    const result = validateDesignSystem(proposal);
    const ds002 = result.violations.filter(v => v.ruleId === "DS-002");
    assert.equal(ds002.length, 0, "DS-002 should not fire for solid color overrides");
  });
});

// ---------------------------------------------------------------------------
// DS-003: radius over manifest cap
// ---------------------------------------------------------------------------

describe("DS-003 — radius exceeds manifest cap", () => {
  it("hard_fails when radius exceeds absoluteMaxPx from the manifest (numeric)", () => {
    const cap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
    const overCap = cap + 4;

    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      radius: overCap
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    assertSingleViolation(result, "DS-003", {
      measuredPattern: new RegExp(`${overCap}px`),
      capPattern: new RegExp(`${cap}px`)
    });
  });

  it("hard_fails for CSS string radius over cap (with measured + cap assertions)", () => {
    const cap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
    const overCap = cap + 4;
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      radius: `${overCap}px`
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    assertSingleViolation(result, "DS-003", {
      measuredPattern: new RegExp(`${overCap}px`),
      capPattern: new RegExp(`${cap}px`)
    });
  });

  it("passes when radius equals the cap exactly", () => {
    const cap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      radius: cap
    };

    const result = validateDesignSystem(proposal);
    const ds003 = result.violations.filter(v => v.ruleId === "DS-003");
    assert.equal(ds003.length, 0, "DS-003 should not fire when radius === cap");
  });

  it("passes when radius is below the cap", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      radius: 4
    };

    const result = validateDesignSystem(proposal);
    const ds003 = result.violations.filter(v => v.ruleId === "DS-003");
    assert.equal(ds003.length, 0, "DS-003 should not fire for radius=4px");
  });

  it("cap value in violation equals CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx (not a hardcoded literal)", () => {
    const manifestCap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      radius: manifestCap + 1
    };

    const result = validateDesignSystem(proposal);
    const v = result.violations.find(vv => vv.ruleId === "DS-003")!;
    assert.ok(v, "DS-003 must fire when radius > manifest cap");
    assert.ok(
      v.cap?.includes(String(manifestCap)),
      `Expected violation cap to cite manifest cap ${manifestCap}, got: "${v.cap}"`
    );
  });

  it("emits an uncheckedRules note for non-pixel radius (never silently skips)", () => {
    // Non-pixel values like "1rem", "100%", "clamp(...)" cannot be compared to the cap
    // mechanically. The validator must declare this as an unchecked note rather than
    // silently passing — consistent with the module's never-hide-coverage posture.
    const nonPixelValues: Array<string> = ["1rem", "100%", "clamp(4px, 1vw, 8px)"];

    for (const radius of nonPixelValues) {
      const proposal: DesignSystemProposal = {
        mode: "target",
        overrides: {},
        radius
      };

      const result = validateDesignSystem(proposal);

      // Must not hard_fail (we don't know if it violates the cap)
      const ds003Violations = result.violations.filter(v => v.ruleId === "DS-003");
      assert.equal(
        ds003Violations.length, 0,
        `DS-003 must not hard_fail for non-pixel radius "${radius}" (check is unverifiable)`
      );

      // Must emit an unchecked note mentioning the unparsable value
      const hasNote = result.uncheckedRules.some(note =>
        note.includes("DS-003") && note.includes(radius)
      );
      assert.equal(
        hasNote,
        true,
        `Expected uncheckedRules to contain a DS-003 note mentioning "${radius}", got: ${JSON.stringify(result.uncheckedRules)}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// DS-004: motion duration over manifest cap
// ---------------------------------------------------------------------------

describe("DS-004 — motionMs exceeds manifest cap", () => {
  it("hard_fails when motionMs exceeds maxDurationMs from the manifest", () => {
    const cap = CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs;
    const overCap = cap + 100;

    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      motionMs: overCap
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    assertSingleViolation(result, "DS-004", {
      measuredPattern: new RegExp(`${overCap}`),
      capPattern: new RegExp(`${cap}`)
    });
  });

  it("passes when motionMs equals the cap exactly", () => {
    const cap = CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs;
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      motionMs: cap
    };

    const result = validateDesignSystem(proposal);
    const ds004 = result.violations.filter(v => v.ruleId === "DS-004");
    assert.equal(ds004.length, 0, "DS-004 should not fire when motionMs === cap");
  });

  it("cap value equals CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs", () => {
    const manifestCap = CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs;
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {},
      motionMs: manifestCap + 1
    };

    const result = validateDesignSystem(proposal);
    const v = result.violations.find(vv => vv.ruleId === "DS-004")!;
    assert.ok(v, "DS-004 must fire when motionMs > manifest cap");
    assert.ok(
      v.cap?.includes(String(manifestCap)),
      `Expected violation cap to cite manifest cap ${manifestCap}ms, got: "${v.cap}"`
    );
  });
});

// ---------------------------------------------------------------------------
// DS-005: set slot missing justification
// ---------------------------------------------------------------------------

describe("DS-005 — set slot missing justification", () => {
  it("hard_fails when accent override has empty justification", () => {
    // Bypass Zod schema to inject missing justification (schema enforces min(1),
    // but the validator also checks so callers bypassing schema still get a violation)
    const proposal = {
      mode: "target" as const,
      overrides: {
        accent: { color: "#6366F1", justification: "" }
      }
    } as DesignSystemProposal;

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    assertSingleViolation(result, "DS-005");
    const v = result.violations.find(vv => vv.ruleId === "DS-005")!;
    assert.equal(v.slot, "accent");
  });

  it("hard_fails when typeface override has empty justification", () => {
    const proposal = {
      mode: "target" as const,
      overrides: {
        typeface: { sans: "Neue Haas Grotesk", justification: "" }
      }
    } as DesignSystemProposal;

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    const v = result.violations.find(vv => vv.ruleId === "DS-005")!;
    assert.ok(v, "DS-005 must fire for empty typeface justification");
    assert.equal(v.slot, "typeface");
  });

  it("hard_fails when surface override has empty justification", () => {
    const proposal = {
      mode: "target" as const,
      overrides: {
        surface: { base: "#0D0D0D", justification: "" }
      }
    } as DesignSystemProposal;

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    const v = result.violations.find(vv => vv.ruleId === "DS-005")!;
    assert.ok(v, "DS-005 must fire for empty surface justification");
    assert.equal(v.slot, "surface");
  });

  it("passes when all set slots have non-empty justifications", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        accent: { color: "#6366F1", justification: "brand primary" },
        typeface: { sans: "Geist Sans", justification: "matches brand guidelines" }
      }
    };

    const result = validateDesignSystem(proposal);
    const ds005 = result.violations.filter(v => v.ruleId === "DS-005");
    assert.equal(ds005.length, 0, "DS-005 should not fire when all justifications are set");
  });
});

// ---------------------------------------------------------------------------
// Clean bounded target override → passed
// ---------------------------------------------------------------------------

describe("clean bounded target override", () => {
  it("passes with a single accent + justified typeface within caps", () => {
    const manifestCap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
    const motionCap = CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs;

    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        accent: {
          color: "#6366F1",
          justification: "brand primary color from identity system"
        },
        typeface: {
          sans: "Geist Sans",
          justification: "matches archon design system variable font"
        }
      },
      radius: manifestCap,       // exactly at cap — should pass
      motionMs: motionCap,       // exactly at cap — should pass
      accentColors: ["#6366F1"]  // single accent — should pass DS-001
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, true, `Expected passed=true, got violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.violations.length, 0);
    assert.equal(result.mode, "target");
  });

  it("result conforms to DesignSystemValidationSchema", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {}
    };
    const result = validateDesignSystem(proposal);
    const parsed = DesignSystemValidationSchema.parse(result);
    assert.equal(parsed.passed, true);
  });
});

// ---------------------------------------------------------------------------
// mode "self" — zero-divergence lock
// ---------------------------------------------------------------------------

describe('mode "self" — zero-divergence lock', () => {
  it("hard_fails when any accent override is set", () => {
    const proposal: DesignSystemProposal = {
      mode: "self",
      overrides: {
        accent: { color: "#6366F1", justification: "own identity" }
      }
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    const v = result.violations.find(vv => vv.slot === "accent");
    assert.ok(v, "Expected violation for accent slot in self mode");
    assert.equal(v!.severity, "hard_fail");
  });

  it("hard_fails when typeface override is set", () => {
    const proposal: DesignSystemProposal = {
      mode: "self",
      overrides: {
        typeface: { sans: "Geist Sans", justification: "same font" }
      }
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    const v = result.violations.find(vv => vv.slot === "typeface");
    assert.ok(v);
    assert.equal(v!.severity, "hard_fail");
  });

  it("hard_fails when surface override is set", () => {
    const proposal: DesignSystemProposal = {
      mode: "self",
      overrides: {
        surface: { base: "#0A0A0A", justification: "same as manifest" }
      }
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    const v = result.violations.find(vv => vv.slot === "surface");
    assert.ok(v);
    assert.equal(v!.severity, "hard_fail");
  });

  it("hard_fails when radius override is set", () => {
    const proposal: DesignSystemProposal = {
      mode: "self",
      overrides: {},
      radius: 6
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    const v = result.violations.find(vv => vv.slot === "radius");
    assert.ok(v);
    assert.equal(v!.severity, "hard_fail");
  });

  it("hard_fails when motionMs override is set", () => {
    const proposal: DesignSystemProposal = {
      mode: "self",
      overrides: {},
      motionMs: 150
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, false);
    const v = result.violations.find(vv => vv.slot === "motionMs");
    assert.ok(v);
    assert.equal(v!.severity, "hard_fail");
  });

  it("passes when no overrides are set (identity untouched)", () => {
    const proposal: DesignSystemProposal = {
      mode: "self",
      overrides: {}
    };

    const result = validateDesignSystem(proposal);
    assert.equal(result.passed, true, `Expected passed=true in mode=self with no overrides, got: ${JSON.stringify(result.violations)}`);
    assert.equal(result.violations.length, 0);
    assert.equal(result.mode, "self");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces identical output for the same input, called multiple times", () => {
    const cap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        accent: { color: "#6366F1", justification: "brand" }
      },
      radius: cap + 4,
      motionMs: 300,
      accentColors: ["#6366F1", "#10B981"]
    };

    const r1 = validateDesignSystem(proposal);
    const r2 = validateDesignSystem(proposal);
    const r3 = validateDesignSystem(proposal);

    assert.deepEqual(r1, r2, "run 1 and run 2 must be identical");
    assert.deepEqual(r2, r3, "run 2 and run 3 must be identical");
  });

  it("violation ordering is stable (DS-NNN ascending)", () => {
    const cap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {
        accent: {
          color: "linear-gradient(135deg, #6366F1, #818CF8)",
          justification: "gradient accent"
        },
        surface: {
          base: "radial-gradient(circle, #0A0A0A, #111111)",
          justification: "gradient surface"
        }
      },
      radius: cap + 10,
      motionMs: 500,
      accentColors: ["#6366F1", "#10B981"]
    };

    const r1 = validateDesignSystem(proposal);
    const r2 = validateDesignSystem(proposal);

    const ids1 = r1.violations.map(v => v.ruleId);
    const ids2 = r2.violations.map(v => v.ruleId);
    assert.deepEqual(ids1, ids2, "violation order must be stable");

    // Must be sorted ascending
    for (let i = 1; i < ids1.length; i++) {
      assert.equal(
        ids1[i - 1]! <= ids1[i]!,
        true,
        `Expected violations sorted ascending but got ${ids1.join(", ")}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Zod schema strict parse
// ---------------------------------------------------------------------------

describe("Zod schema validation", () => {
  it("DesignSystemProposalSchema rejects missing mode field", () => {
    const bad = {
      overrides: {}
    };
    const result = DesignSystemProposalSchema.safeParse(bad);
    assert.equal(result.success, false, "Missing mode must be rejected by schema");
  });

  it("DesignSystemProposalSchema rejects invalid mode value", () => {
    const bad = {
      mode: "admin",
      overrides: {}
    };
    const result = DesignSystemProposalSchema.safeParse(bad);
    assert.equal(result.success, false, "Invalid mode must be rejected by schema");
  });

  it("DesignSystemProposalSchema accepts a clean target proposal", () => {
    const good = {
      mode: "target",
      overrides: {}
    };
    const result = DesignSystemProposalSchema.safeParse(good);
    assert.equal(result.success, true, "Clean target proposal must parse successfully");
  });

  it("DesignSystemProposalSchema accepts accentColors as a first-class field", () => {
    const good = {
      mode: "target",
      overrides: {},
      accentColors: ["#6366F1", "#10B981"]
    };
    const result = DesignSystemProposalSchema.safeParse(good);
    assert.equal(result.success, true, "Proposal with accentColors must parse successfully");
    if (result.success) {
      assert.equal(result.data.accentColors?.length, 2, "accentColors must be preserved after parse");
    }
  });

  it("DesignSystemValidationSchema accepts validator output", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {}
    };
    const validationResult = validateDesignSystem(proposal);
    const parsed = DesignSystemValidationSchema.safeParse(validationResult);
    assert.equal(parsed.success, true, "Validator output must conform to DesignSystemValidationSchema");
  });
});

// ---------------------------------------------------------------------------
// uncheckedRules coverage contract (never hidden)
// ---------------------------------------------------------------------------

describe("uncheckedRules coverage", () => {
  it("always declares unchecked rules (never silently hides coverage gaps)", () => {
    const proposal: DesignSystemProposal = {
      mode: "target",
      overrides: {}
    };
    const result = validateDesignSystem(proposal);
    assert.equal(
      result.uncheckedRules.length > 0,
      true,
      "uncheckedRules must be non-empty — advisory coverage must always be declared"
    );
  });

  it("unchecked rules are declared even when proposal passes", () => {
    const result = validateDesignSystem(cleanTargetProposal());
    assert.equal(result.passed, true);
    assert.ok(result.uncheckedRules.length > 0);
  });

  it("unchecked rules are declared in mode=self pass case", () => {
    const result = validateDesignSystem({ mode: "self", overrides: {} });
    assert.equal(result.passed, true);
    assert.ok(result.uncheckedRules.length > 0);
  });
});
