/**
 * @module forge/design-direction-contract
 *
 * Zod schemas and inferred TypeScript types for the DesignDirection stage
 * (Phase 1, council condition #2).
 *
 * Council condition #2 (non-waivable): the design-direction stage must produce
 * ≥2 DIVERGENT directions with declared contrast rationale — NOT 1 real + 1 cosmetic
 * decoy. The `DirectionDivergenceResult` schema captures the gate output that
 * enforces this requirement deterministically.
 *
 * Schema shape mirrors the §6.3 DesignDirection Python model (camelCase).
 *
 * Style mirrors: anti-generic-types.ts and design-system-contract.ts
 *   - Stable rule ids (DD-NNN)
 *   - measured + cap on numeric violations
 *   - uncheckedRules declared explicitly (never hidden)
 *   - String length caps on all text fields
 *
 * Zero archon-service dependencies — safe to import from web/ or any tooling layer.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// String length caps (prevent unbounded data in violation payloads and inputs)
// ---------------------------------------------------------------------------

/** Max length for a direction id. */
const MAX_ID_LEN = 128;

/** Max length for a direction name. */
const MAX_NAME_LEN = 256;

/**
 * Max length for single-sentence concept, emotional effect, and strategy fields.
 * Generous but bounded — a real strategy should not need more than 1 KB.
 */
const MAX_STRATEGY_LEN = 1024;

/** Max length for a single risk entry. */
const MAX_RISK_LEN = 512;

/** Max length for a single whyItIsNotGeneric entry. */
const MAX_RATIONALE_LEN = 1024;

/** Max number of risk entries per direction. */
const MAX_RISKS = 32;

/** Max number of whyItIsNotGeneric entries per direction. */
const MAX_RATIONALE_ENTRIES = 32;

/** Max number of directions in a direction set. */
const MAX_DIRECTIONS = 32;

/** Max length for a violation message. */
const MAX_MESSAGE_LEN = 1024;

/** Max length for a violation ruleId. */
const MAX_RULE_ID_LEN = 16;

/** Max length for a violation axis field. */
const MAX_AXIS_LEN = 64;

/** Max number of violations in a result. */
const MAX_VIOLATIONS = 64;

/** Max number of unchecked-rule note strings. */
const MAX_UNCHECKED_NOTES = 32;

// ---------------------------------------------------------------------------
// DesignDirectionSchema
//
// One design direction produced by the direction-generation stage (§6.3).
// All strategy fields are required and must be non-empty (a blank strategy
// is not a real direction choice — the divergence checker will reject it).
// ---------------------------------------------------------------------------

/**
 * One design direction.
 *
 * Fields map to §6.3 DesignDirection (Python model), converted to camelCase.
 * All strategy fields are required, non-empty, and length-capped.
 *
 * The `whyItIsNotGeneric` field is the council #2 contrast rationale.
 * An empty array or array of whitespace-only strings fails DD-003.
 */
export const DesignDirectionSchema = z.object({
  /**
   * Stable unique identifier for this direction within the direction set.
   * The direction-divergence checker cites this in violation messages.
   */
  id: z.string().min(1).max(MAX_ID_LEN),

  /** Human-readable name for this direction (e.g. "Monolithic Grid"). */
  name: z.string().min(1).max(MAX_NAME_LEN),

  /**
   * One-sentence concept summary.
   * §6.3: one_sentence_concept
   */
  oneSentenceConcept: z.string().min(1).max(MAX_STRATEGY_LEN),

  /**
   * The emotional effect this direction should evoke in the user.
   * §6.3: emotional_effect
   */
  emotionalEffect: z.string().min(1).max(MAX_STRATEGY_LEN),

  /**
   * How this direction organizes the page spatially.
   * §6.3: layout_strategy
   * Divergence axis 1 of 5.
   */
  layoutStrategy: z.string().min(1).max(MAX_STRATEGY_LEN),

  /**
   * Typeface, scale, weight, and rhythm choices.
   * §6.3: typography_strategy
   * Divergence axis 2 of 5.
   */
  typographyStrategy: z.string().min(1).max(MAX_STRATEGY_LEN),

  /**
   * Palette, contrast approach, and color role assignments.
   * §6.3: color_strategy
   * Divergence axis 3 of 5.
   */
  colorStrategy: z.string().min(1).max(MAX_STRATEGY_LEN),

  /**
   * Image, illustration, icon, and raster vs vector approach.
   * §6.3: asset_strategy
   * Divergence axis 4 of 5.
   */
  assetStrategy: z.string().min(1).max(MAX_STRATEGY_LEN),

  /**
   * Animation, hover, transition, and micro-interaction approach.
   * §6.3: interaction_strategy
   * Divergence axis 5 of 5.
   */
  interactionStrategy: z.string().min(1).max(MAX_STRATEGY_LEN),

  /**
   * Known risks of this direction (e.g. accessibility, audience fit).
   * §6.3: risks
   */
  risks: z.array(z.string().min(1).max(MAX_RISK_LEN)).max(MAX_RISKS),

  /**
   * Explicit rationale for why this direction is NOT generic.
   * §6.3: why_it_is_not_generic
   *
   * Council condition #2: each direction MUST declare non-empty contrast
   * rationale. An empty array or array of whitespace-only strings fails DD-003.
   */
  whyItIsNotGeneric: z.array(z.string().min(1).max(MAX_RATIONALE_LEN)).max(MAX_RATIONALE_ENTRIES)
});

export type DesignDirection = z.infer<typeof DesignDirectionSchema>;

/**
 * A set of design directions (input to the divergence checker).
 * Bounded to MAX_DIRECTIONS to prevent unbounded payload growth.
 */
export const DirectionSetSchema = z.array(DesignDirectionSchema).max(MAX_DIRECTIONS);

export type DirectionSet = z.infer<typeof DirectionSetSchema>;

// ---------------------------------------------------------------------------
// DirectionDivergenceResult — output contract
//
// Returned by checkDirectionDivergence(). Mirrors the validation result shape
// in design-system-contract.ts: violations[], passed, uncheckedRules.
// ---------------------------------------------------------------------------

/**
 * A single divergence-gate violation. Cites a DD-NNN rule id.
 *
 * For DD-002 (axis divergence), `axis` names the strategy axis that failed.
 */
export const DirectionDivergenceViolationSchema = z.object({
  /**
   * Stable rule id (DD-NNN).
   * DD-001: fewer than 2 directions
   * DD-002: directions not sufficiently divergent across strategy axes
   * DD-003: missing or empty whyItIsNotGeneric rationale
   * DD-004: duplicate id or name across directions
   */
  ruleId: z.string().min(1).max(MAX_RULE_ID_LEN),

  /**
   * Strategy axis involved in the violation (only for DD-002 axis-level detail).
   * e.g. "layoutStrategy", "colorStrategy"
   */
  axis: z.string().max(MAX_AXIS_LEN).optional(),

  /** Human-readable violation message. */
  message: z.string().min(1).max(MAX_MESSAGE_LEN),

  /**
   * Severity.
   * "hard_fail": the gate blocks — directions must be regenerated.
   * "warning":   advisory — the gate logs but does not block.
   */
  severity: z.enum(["hard_fail", "warning"])
});

export type DirectionDivergenceViolation = z.infer<typeof DirectionDivergenceViolationSchema>;

/**
 * The full result returned by checkDirectionDivergence.
 */
export const DirectionDivergenceResultSchema = z.object({
  /** All violations found, in deterministic order (DD-NNN ascending, then direction index). */
  violations: z.array(DirectionDivergenceViolationSchema).max(MAX_VIOLATIONS),

  /**
   * True iff no hard_fail violations were found.
   * The S5 pipeline uses this as the divergence gate:
   *   false → block direction set, emit repair instructions.
   */
  passed: z.boolean(),

  /**
   * Number of strategy axes on which the MOST-SIMILAR direction pair diverges.
   *
   * "Diverge on an axis" means the Jaccard similarity of the axis strategy
   * texts (lowercased, whitespace-collapsed word tokens) is < DIVERGENCE_THRESHOLD
   * (0.5). Two directions must diverge on ≥ DIVERGENCE_AXIS_MIN (2) of 5 axes
   * to pass DD-002.
   *
   * 0 when fewer than 2 directions are provided or when the pair is identical.
   * Useful for repair messages and debugging.
   */
  divergentAxisCount: z.number().int().min(0),

  /**
   * Rules that cannot be checked mechanically by this checker.
   * Declared explicitly so advisory coverage is never silently hidden.
   */
  uncheckedRules: z.array(z.string()).max(MAX_UNCHECKED_NOTES)
});

export type DirectionDivergenceResult = z.infer<typeof DirectionDivergenceResultSchema>;
