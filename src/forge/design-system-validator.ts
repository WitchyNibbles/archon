/**
 * @module forge/design-system-validator
 *
 * Deterministic, pure validator for design-system token-override proposals
 * (Phase 1, council condition #4 / D1).
 *
 * Entry point: validateDesignSystem(proposal) → DesignSystemValidation
 *
 * Two-layer identity model
 * ────────────────────────
 * mode "self"  (archon's own surfaces — D1 zero-divergence lock):
 *   ANY override diverging from CONSTRAINTS_MANIFEST.identity → hard_fail.
 *   Specifically: any set slot in the overrides object is a violation, because
 *   archon's own identity is fixed and no runtime override is permitted.
 *
 * mode "target" (bounded re-skin for a target project):
 *   Accent, typeface, and surface slots are allowed, but five rules are enforced:
 *     DS-001  >1 accent color provided              (mirrors AG-002)
 *     DS-002  gradient value in surface/accent slot (mirrors AG-001)
 *     DS-003  radius > CONSTRAINTS_MANIFEST radiusCap.absoluteMaxPx (mirrors AG-003)
 *     DS-004  motionMs > CONSTRAINTS_MANIFEST motion.maxDurationMs  (mirrors AG-010)
 *     DS-005  a set override slot has empty/missing justification
 *
 * Non-mechanical rules are declared in uncheckedRules — never hidden.
 *
 * Composes on CONSTRAINTS_MANIFEST (no inline copy of identity/caps values).
 *
 * Pure + deterministic:
 *   - no I/O, no randomness, no mutable external state
 *   - same input ⇒ same output, every call
 *
 * Zero archon-service dependencies — safe to import from web/ or any tooling.
 */

import { CONSTRAINTS_MANIFEST } from "./constraints-manifest.ts";
import type {
  DesignSystemProposal,
  DesignSystemValidation,
  DesignSystemViolation
} from "./design-system-contract.ts";

// ---------------------------------------------------------------------------
// Stable rule ids (DS-NNN)
// ---------------------------------------------------------------------------

/** DS-001: More than one accent color in the proposal. */
const RULE_DS_001 = "DS-001";
/** DS-002: Gradient value detected in a surface or accent override slot. */
const RULE_DS_002 = "DS-002";
/** DS-003: Radius exceeds the manifest's absoluteMaxPx cap. */
const RULE_DS_003 = "DS-003";
/** DS-004: Motion duration exceeds the manifest's maxDurationMs cap. */
const RULE_DS_004 = "DS-004";
/** DS-005: A set override slot is missing a non-empty justification. */
const RULE_DS_005 = "DS-005";
/** DS-100–DS-104: mode "self" divergence rules (one per override slot type). */
const RULE_DS_100 = "DS-100";

// ---------------------------------------------------------------------------
// Rules declared as unchecked (mechanically unverifiable by this validator)
// ---------------------------------------------------------------------------

const UNCHECKED_RULES: readonly string[] = [
  "DS-U01: Token reference integrity — whether the supplied color strings correspond to defined design tokens cannot be verified without a token registry. This validator only checks structure, gradient presence, and cap values.",
  "DS-U02: WCAG contrast — whether overridden surface/accent colors maintain ≥4.5:1 contrast against text tokens requires a dedicated contrast checker (see wcag-contrast.ts).",
  "DS-U03: Visual consistency — whether the override produces a coherent visual identity requires human or model review; not mechanically checkable here."
];

// ---------------------------------------------------------------------------
// Gradient detection helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the given CSS value string appears to contain a gradient.
 *
 * Checks for the CSS gradient functions:
 *   linear-gradient, radial-gradient, conic-gradient, repeating-*-gradient
 *
 * Case-insensitive. Does not false-positive on plain hex/rgb color values.
 */
function looksLikeGradient(value: string): boolean {
  return /gradient\s*\(/i.test(value);
}

// ---------------------------------------------------------------------------
// Radius parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse a radius value (number or CSS string like "8px" or "8") into a number.
 * Returns NaN when the value is not a plain pixel/unitless number — specifically
 * when it contains a non-px unit or a CSS function like "rem", "%", "clamp(...)".
 *
 * Accepted forms: plain integers/floats ("8", "8.5"), px values ("8px", "8.5px").
 * Rejected forms: any other unit ("1rem", "100%"), CSS functions ("clamp(4px, 1vw, 8px)").
 *
 * WHY strict matching: JavaScript's parseFloat("1rem") returns 1 (silently discards
 * the unit suffix), which would cause the validator to silently treat "1rem" as 1px
 * and pass a cap check that should be declared unchecked. We must reject non-px forms
 * explicitly so the unparsableNote path is triggered.
 */
function parseRadiusPx(radius: number | string): number {
  if (typeof radius === "number") return radius;
  const trimmed = radius.trim();
  // Accept only: optional digits/dot, optional "px" suffix, nothing else.
  // This rejects rem, em, %, vw, calc(), clamp(), etc.
  if (!/^\d+(\.\d+)?(px)?$/i.test(trimmed)) return NaN;
  return parseFloat(trimmed);
}

// ---------------------------------------------------------------------------
// mode "self" checker
// ---------------------------------------------------------------------------

/**
 * In mode "self", ANY set override slot diverges from the fixed archon identity
 * and is a hard_fail. We check each allowed slot presence independently so the
 * caller gets one violation per diverging slot rather than a single catch-all.
 */
function checkSelfMode(
  proposal: DesignSystemProposal
): readonly DesignSystemViolation[] {
  const { overrides, radius, motionMs } = proposal;
  const violations: DesignSystemViolation[] = [];

  if (overrides.accent !== undefined) {
    violations.push({
      ruleId: RULE_DS_100,
      slot: "accent",
      message: "DS-100 [hard_fail]: mode=self — accent override is forbidden; archon identity is locked. Remove the accent override.",
      severity: "hard_fail"
    });
  }

  if (overrides.typeface !== undefined) {
    violations.push({
      ruleId: RULE_DS_100,
      slot: "typeface",
      message: "DS-100 [hard_fail]: mode=self — typeface override is forbidden; archon identity is locked. Remove the typeface override.",
      severity: "hard_fail"
    });
  }

  if (overrides.surface !== undefined) {
    violations.push({
      ruleId: RULE_DS_100,
      slot: "surface",
      message: "DS-100 [hard_fail]: mode=self — surface override is forbidden; archon identity is locked. Remove the surface override.",
      severity: "hard_fail"
    });
  }

  if (radius !== undefined) {
    violations.push({
      ruleId: RULE_DS_100,
      slot: "radius",
      measured: `radius=${String(radius)}`,
      cap: "identity-locked (no override permitted in mode=self)",
      message: "DS-100 [hard_fail]: mode=self — radius override is forbidden; archon identity is locked.",
      severity: "hard_fail"
    });
  }

  if (motionMs !== undefined) {
    violations.push({
      ruleId: RULE_DS_100,
      slot: "motionMs",
      measured: `motionMs=${motionMs}`,
      cap: "identity-locked (no override permitted in mode=self)",
      message: "DS-100 [hard_fail]: mode=self — motionMs override is forbidden; archon identity is locked.",
      severity: "hard_fail"
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// mode "target" checkers (one pure function per DS-NNN rule)
// ---------------------------------------------------------------------------

/**
 * DS-001: More than one accent color in the proposal.
 *
 * The manifest specifies a single accent (indigo). Callers declare ALL accent-class
 * colors in `proposal.accentColors` — a field that is part of DesignSystemProposalSchema
 * and therefore survives parse(). DS-001 fires when accentColors.length > 1.
 *
 * Why explicit declaration rather than heuristic detection:
 * The validator cannot reliably distinguish "accent" from "neutral" color strings
 * without a full token registry. Explicit declaration keeps the check deterministic
 * and free of false positives. Callers are responsible for populating accentColors
 * with every color in their proposal that plays an accent role.
 */
function checkDS001(proposal: DesignSystemProposal): DesignSystemViolation | undefined {
  const colors = proposal.accentColors;
  if (colors !== undefined && colors.length > 1) {
    return {
      ruleId: RULE_DS_001,
      slot: "accent",
      measured: `${colors.length} accent colors`,
      cap: "1 accent color",
      message: `DS-001 [hard_fail]: More than one accent color is forbidden. Found ${colors.length} accent colors; only a single accent is permitted (council #4 / NNP-003).`,
      severity: "hard_fail"
    };
  }
  return undefined;
}

/**
 * DS-002: Gradient value in a surface or accent override slot.
 *
 * Mirrors AG-001. Checks all set color values in overrides for gradient syntax.
 */
function checkDS002(overrides: DesignSystemProposal["overrides"]): readonly DesignSystemViolation[] {
  const violations: DesignSystemViolation[] = [];

  // Check accent color
  if (overrides.accent !== undefined && looksLikeGradient(overrides.accent.color)) {
    violations.push({
      ruleId: RULE_DS_002,
      slot: "accent",
      measured: `accent.color="${overrides.accent.color}"`,
      cap: "solid color value (no gradient)",
      message: "DS-002 [hard_fail]: Gradient value detected in accent override. Gradient fills are forbidden (mirrors AG-001).",
      severity: "hard_fail"
    });
  }

  // Check surface slots
  if (overrides.surface !== undefined) {
    const { surface } = overrides;
    const surfaceSlots: ReadonlyArray<[keyof typeof surface, string | undefined]> = [
      ["base",     surface.base],
      ["raised",   surface.raised],
      ["elevated", surface.elevated],
      ["overlay",  surface.overlay]
    ];

    for (const [slot, value] of surfaceSlots) {
      if (value !== undefined && looksLikeGradient(value)) {
        violations.push({
          ruleId: RULE_DS_002,
          slot: `surface.${slot}`,
          measured: `surface.${slot}="${value}"`,
          cap: "solid color value (no gradient)",
          message: `DS-002 [hard_fail]: Gradient value detected in surface.${slot} override. Gradient fills are forbidden (mirrors AG-001).`,
          severity: "hard_fail"
        });
      }
    }
  }

  return violations;
}

/** Result type for checkDS003 — carries both an optional violation and an optional unchecked note. */
interface DS003Result {
  violation: DesignSystemViolation | undefined;
  /**
   * Non-empty when the radius value could not be parsed as a pixel count
   * (e.g. "1rem", "100%", "clamp(4px, 1vw, 8px)"). The cap check is
   * declared as mechanically unchecked for such values — never silently skipped.
   */
  unparsableNote: string | undefined;
}

/**
 * DS-003: Radius exceeds the manifest cap.
 *
 * Reads `CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx` as the cap
 * (hard ceiling, 8px). Mirrors AG-003.
 *
 * When the radius value is a non-pixel CSS expression (e.g. "1rem", "100%",
 * "clamp(...)"), the check cannot be performed mechanically. An `unparsableNote`
 * is returned so it can be added to `uncheckedRules` — coverage is never hidden.
 */
function checkDS003(radius: DesignSystemProposal["radius"]): DS003Result {
  if (radius === undefined) return { violation: undefined, unparsableNote: undefined };

  const cap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
  const parsed = parseRadiusPx(radius);

  if (isNaN(parsed)) {
    return {
      violation: undefined,
      unparsableNote: `DS-003 [unchecked]: radius="${String(radius)}" is not a parseable pixel value (e.g. "rem", "%", "clamp()"). The cap check (≤${cap}px) cannot be performed mechanically — requires manual or model review.`
    };
  }

  if (parsed > cap) {
    return {
      violation: {
        ruleId: RULE_DS_003,
        slot: "radius",
        measured: `radius=${parsed}px`,
        cap: `≤${cap}px`,
        message: `DS-003 [hard_fail]: Radius ${parsed}px exceeds the manifest cap of ${cap}px. Data/infrastructure surfaces must not use radius > ${cap}px (mirrors AG-003).`,
        severity: "hard_fail"
      },
      unparsableNote: undefined
    };
  }

  return { violation: undefined, unparsableNote: undefined };
}

/**
 * DS-004: Motion duration exceeds the manifest cap.
 *
 * Reads `CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs` as the cap
 * (200ms). Mirrors AG-010.
 */
function checkDS004(motionMs: DesignSystemProposal["motionMs"]): DesignSystemViolation | undefined {
  if (motionMs === undefined) return undefined;

  const cap = CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs;

  if (motionMs > cap) {
    return {
      ruleId: RULE_DS_004,
      slot: "motionMs",
      measured: `motionMs=${motionMs}`,
      cap: `≤${cap}ms`,
      message: `DS-004 [hard_fail]: Motion duration ${motionMs}ms exceeds the manifest cap of ${cap}ms. All animations must be ≤${cap}ms (mirrors AG-010).`,
      severity: "hard_fail"
    };
  }

  return undefined;
}

/**
 * DS-005: A set override slot is missing a non-empty justification.
 *
 * D1 requires per-slot justification for every override that is set.
 * The schema enforces this at the type level (justification: string min 1),
 * but we also enforce it here to produce a machine-readable violation when
 * a caller bypasses schema validation.
 */
function checkDS005(overrides: DesignSystemProposal["overrides"]): readonly DesignSystemViolation[] {
  const violations: DesignSystemViolation[] = [];

  if (overrides.accent !== undefined) {
    const j = overrides.accent.justification?.trim() ?? "";
    if (j.length === 0) {
      violations.push({
        ruleId: RULE_DS_005,
        slot: "accent",
        message: "DS-005 [hard_fail]: accent override is set but justification is missing or empty. D1 requires a non-empty per-slot justification for every override.",
        severity: "hard_fail"
      });
    }
  }

  if (overrides.typeface !== undefined) {
    const j = overrides.typeface.justification?.trim() ?? "";
    if (j.length === 0) {
      violations.push({
        ruleId: RULE_DS_005,
        slot: "typeface",
        message: "DS-005 [hard_fail]: typeface override is set but justification is missing or empty. D1 requires a non-empty per-slot justification for every override.",
        severity: "hard_fail"
      });
    }
  }

  if (overrides.surface !== undefined) {
    const j = overrides.surface.justification?.trim() ?? "";
    if (j.length === 0) {
      violations.push({
        ruleId: RULE_DS_005,
        slot: "surface",
        message: "DS-005 [hard_fail]: surface override is set but justification is missing or empty. D1 requires a non-empty per-slot justification for every override.",
        severity: "hard_fail"
      });
    }
  }

  return violations;
}

/** Result of checkTargetMode — carries violations plus any unchecked advisory notes. */
interface TargetModeResult {
  violations: readonly DesignSystemViolation[];
  extraUncheckedNotes: readonly string[];
}

// ---------------------------------------------------------------------------
// mode "target" checker — composes all DS-00N rules
// ---------------------------------------------------------------------------

function checkTargetMode(proposal: DesignSystemProposal): TargetModeResult {
  const violations: DesignSystemViolation[] = [];
  const extraUncheckedNotes: string[] = [];

  // DS-001: second accent
  const v001 = checkDS001(proposal);
  if (v001 !== undefined) violations.push(v001);

  // DS-002: gradient in surface/accent slots
  violations.push(...checkDS002(proposal.overrides));

  // DS-003: radius cap (also surfaces unparsable-radius note when applicable)
  const ds003 = checkDS003(proposal.radius);
  if (ds003.violation !== undefined) violations.push(ds003.violation);
  if (ds003.unparsableNote !== undefined) extraUncheckedNotes.push(ds003.unparsableNote);

  // DS-004: motion cap
  const v004 = checkDS004(proposal.motionMs);
  if (v004 !== undefined) violations.push(v004);

  // DS-005: missing justification
  violations.push(...checkDS005(proposal.overrides));

  return { violations, extraUncheckedNotes };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a design-system token-override proposal.
 *
 * PURE and DETERMINISTIC:
 *   - No I/O, no network, no DB, no randomness.
 *   - Same input ⇒ same output, every call.
 *   - Reads cap values from CONSTRAINTS_MANIFEST (never hardcoded).
 *
 * @param proposal - The proposal to validate. The caller MUST validate the
 *   proposal against DesignSystemProposalSchema before calling this function.
 *   This function does NOT re-validate the schema; it operates on the already-
 *   parsed TypeScript type.
 *
 * @returns A DesignSystemValidation with:
 *   - violations: all hard_fail violations in deterministic order (DS-NNN ascending)
 *   - passed: true iff violations is empty
 *   - mode: echoes the proposal mode
 *   - uncheckedRules: rules that cannot be checked mechanically
 */
export function validateDesignSystem(proposal: DesignSystemProposal): DesignSystemValidation {
  let rawViolations: readonly DesignSystemViolation[];
  let extraUncheckedNotes: readonly string[] = [];

  if (proposal.mode === "self") {
    rawViolations = checkSelfMode(proposal);
  } else {
    const targetResult = checkTargetMode(proposal);
    rawViolations = targetResult.violations;
    extraUncheckedNotes = targetResult.extraUncheckedNotes;
  }

  // Sort violations by ruleId for deterministic ordering (DS-NNN ascending)
  const violations = [...rawViolations].sort((a, b) =>
    a.ruleId.localeCompare(b.ruleId, "en", { numeric: true })
  );

  return {
    violations,
    passed: violations.length === 0,
    mode: proposal.mode,
    uncheckedRules: [...UNCHECKED_RULES, ...extraUncheckedNotes]
  };
}
