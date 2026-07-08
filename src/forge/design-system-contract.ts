/**
 * @module forge/design-system-contract
 *
 * Zod schemas and inferred TypeScript types for the design-system token-override
 * validator (Phase 1, council condition #4 / D1).
 *
 * Two-layer identity model:
 *   mode "self"   — archon's own surfaces. Zero divergence from CONSTRAINTS_MANIFEST
 *                   identity is permitted. ANY override is a hard_fail.
 *   mode "target" — bounded re-skin for a target project. The accent, typeface, and
 *                   surface ramp slots may be overridden, but each set slot requires a
 *                   non-empty justification, and hard limits (no second accent, no
 *                   gradient, radius ≤ cap, motion ≤ cap) are enforced.
 *
 * Style mirrors: asset-contract.ts (Zod strict schemas),
 *                anti-generic-types.ts (ruleId + measured + cap on violations).
 *
 * Zero archon-service dependencies — safe to import from any tooling layer.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// String length caps (prevent unbounded data in violation payloads)
// ---------------------------------------------------------------------------

/** Max length for any CSS color value string. */
const MAX_COLOR_LEN = 128;

/** Max length for a typeface name. */
const MAX_TYPEFACE_LEN = 128;

/** Max length for a slot justification. */
const MAX_JUSTIFICATION_LEN = 1024;

/** Max length for a rule id (DS-NNN). */
const MAX_RULE_ID_LEN = 16;

/** Max length for a violation message. */
const MAX_MESSAGE_LEN = 1024;

/** Max length for a measured/cap string. */
const MAX_MEASURED_LEN = 256;

/** Max number of violations in a single result. */
const MAX_VIOLATIONS = 64;

/** Max number of unchecked-rule note strings. */
const MAX_UNCHECKED_NOTES = 32;

/** Max number of accent color entries in accentColors. */
const MAX_ACCENT_COLORS = 32;

// ---------------------------------------------------------------------------
// TokenOverrideSchema
//
// Bounded override slots a target project MAY set.
// Each slot, when present, carries a non-empty justification.
// ---------------------------------------------------------------------------

/**
 * Surface ramp override — replaces the base/raised/overlay subset.
 * Only the slots the target needs to change are required.
 * Each set slot must carry a justification.
 */
export const SurfaceOverrideSchema = z.object({
  base:         z.string().min(1).max(MAX_COLOR_LEN).optional(),
  raised:       z.string().min(1).max(MAX_COLOR_LEN).optional(),
  elevated:     z.string().min(1).max(MAX_COLOR_LEN).optional(),
  overlay:      z.string().min(1).max(MAX_COLOR_LEN).optional(),
  justification: z.string().min(1).max(MAX_JUSTIFICATION_LEN)
});

export type SurfaceOverride = z.infer<typeof SurfaceOverrideSchema>;

/**
 * Typeface override — replaces the sans and/or mono faces.
 * At least one of sans/mono must be present; justification required.
 */
export const TypefaceOverrideSchema = z.object({
  sans:          z.string().min(1).max(MAX_TYPEFACE_LEN).optional(),
  mono:          z.string().min(1).max(MAX_TYPEFACE_LEN).optional(),
  justification: z.string().min(1).max(MAX_JUSTIFICATION_LEN)
});

export type TypefaceOverride = z.infer<typeof TypefaceOverrideSchema>;

/**
 * The bounded set of override slots a target project MAY supply.
 *
 * - accent:    A single accent COLOR string (one value; second accent is forbidden).
 * - typeface:  Replacement typeface names.
 * - surface:   Replacement surface ramp values.
 *
 * All slots are optional. When a slot is set, its sibling `justification`
 * sub-field is required and must be non-empty.
 */
export const TokenOverrideSchema = z.object({
  /** Single accent color string (e.g. "#6366F1"). Second accent = DS-001. */
  accent:   z.object({
    color:         z.string().min(1).max(MAX_COLOR_LEN),
    justification: z.string().min(1).max(MAX_JUSTIFICATION_LEN)
  }).optional(),

  /** Typeface replacement (sans and/or mono). */
  typeface: TypefaceOverrideSchema.optional(),

  /** Surface ramp replacement (base/raised/elevated/overlay subset). */
  surface:  SurfaceOverrideSchema.optional()
});

export type TokenOverride = z.infer<typeof TokenOverrideSchema>;

// ---------------------------------------------------------------------------
// DesignSystemProposalSchema
//
// The full input to the validator. Captures the mode and everything the
// validator mechanically checks: overrides, radius, motion.
// ---------------------------------------------------------------------------

export const DesignSystemProposalSchema = z.object({
  /**
   * Identity mode.
   * "self"   → archon's own surfaces; zero-divergence lock applies.
   * "target" → bounded re-skin for an external project; slots + caps apply.
   */
  mode: z.enum(["self", "target"]),

  /**
   * Token override slots. Present when the proposal intends to diverge from
   * the manifest identity (mode "target") or — in mode "self" — would be a
   * violation if set.
   */
  overrides: TokenOverrideSchema,

  /**
   * Border radius in pixels or CSS value string (e.g. 8 or "8px").
   * Checked against CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx.
   */
  radius: z.union([z.number().nonnegative(), z.string().max(MAX_MEASURED_LEN)]).optional(),

  /**
   * Animation/transition duration in milliseconds.
   * Checked against CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs.
   */
  motionMs: z.number().nonnegative().optional(),

  /**
   * The full set of accent colors this proposal introduces.
   * DS-001 hard-fails when length > 1 (second accent forbidden, council #4 / NNP-003).
   *
   * Why this field exists here (not inferred from overrides.accent):
   * A caller may introduce accent-class colors via multiple channels — the single
   * `overrides.accent` slot, surface values, or additional brand tokens — and the
   * validator cannot heuristically distinguish "accent" from "neutral" without a
   * full token registry. Requiring callers to declare all accent colors explicitly
   * keeps the check deterministic and free of false positives/negatives. The field
   * MUST survive DesignSystemProposalSchema.parse() so that DS-001 fires on the
   * real pipeline path (the regression guard for this is the schema-first test).
   *
   * Bounded to MAX_ACCENT_COLORS to prevent unbounded payload growth.
   */
  accentColors: z.array(z.string().min(1).max(MAX_COLOR_LEN)).max(MAX_ACCENT_COLORS).optional()
});

export type DesignSystemProposal = z.infer<typeof DesignSystemProposalSchema>;

// ---------------------------------------------------------------------------
// DesignSystemValidationSchema
//
// Structured result returned by validateDesignSystem.
// ---------------------------------------------------------------------------

/**
 * A single validation violation. Every violation cites a stable DS-NNN rule id
 * and, for numeric rules, `measured` + `cap` for machine-readable repair.
 *
 * Only severity "hard_fail" is produced — this validator has no warnings.
 */
export const DesignSystemViolationSchema = z.object({
  /** Stable rule id (DS-NNN). */
  ruleId: z.string().min(1).max(MAX_RULE_ID_LEN),

  /**
   * The token slot involved (e.g. "accent", "typeface", "surface", "radius",
   * "motionMs"). Omitted for page-level violations.
   */
  slot: z.string().max(MAX_MEASURED_LEN).optional(),

  /**
   * What was measured (e.g. "2 accent colors", "radius=12px", "motionMs=300").
   * Required for numeric rules so the repair loop gets a machine-readable diff.
   */
  measured: z.string().max(MAX_MEASURED_LEN).optional(),

  /**
   * The cap or identity expectation that was violated
   * (e.g. "1 accent color", "≤8px", "≤200ms").
   */
  cap: z.string().max(MAX_MEASURED_LEN).optional(),

  /** Human-readable violation description. */
  message: z.string().min(1).max(MAX_MESSAGE_LEN),

  /** Always "hard_fail" — this validator has no advisory warnings. */
  severity: z.literal("hard_fail")
});

export type DesignSystemViolation = z.infer<typeof DesignSystemViolationSchema>;

/**
 * The full result returned by validateDesignSystem.
 */
export const DesignSystemValidationSchema = z.object({
  /** All hard_fail violations found. Empty when passed === true. */
  violations: z.array(DesignSystemViolationSchema).max(MAX_VIOLATIONS),

  /**
   * True iff violations is empty (no hard_fail). The S5 pipeline uses this
   * as the gate: false → abort codegen, emit repair instructions.
   */
  passed: z.boolean(),

  /** The mode of the proposal that was validated. */
  mode: z.enum(["self", "target"]),

  /**
   * Rules that cannot be checked mechanically by this validator.
   * Declared explicitly so advisory coverage is never silently hidden
   * (mirrors anti-generic-types.ts uncheckedRules pattern).
   */
  uncheckedRules: z.array(z.string().max(MAX_MEASURED_LEN)).max(MAX_UNCHECKED_NOTES)
});

export type DesignSystemValidation = z.infer<typeof DesignSystemValidationSchema>;
