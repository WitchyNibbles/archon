/**
 * @module forge/direction-divergence
 *
 * Deterministic direction-divergence gate for Archon Forge (Phase 1).
 *
 * Council condition #2 (non-waivable): The design-direction stage must produce
 * ≥2 DIVERGENT directions with declared contrast rationale. NOT 1 real + 1
 * cosmetic decoy.
 *
 * Entry point: checkDirectionDivergence(directions) → DirectionDivergenceResult
 *
 * Rules (DD-NNN):
 *   DD-001 [hard_fail]: fewer than 2 directions provided.
 *   DD-002 [hard_fail]: directions are not sufficiently divergent across strategy
 *                       axes. The MOST-SIMILAR pair in the set must diverge on
 *                       ≥ DIVERGENCE_AXIS_MIN (2) of 5 strategy axes.
 *   DD-003 [hard_fail]: a direction has empty or whitespace-only whyItIsNotGeneric
 *                       (the council #2 contrast rationale is mandatory).
 *   DD-004 [warning]:   duplicate id or name across directions.
 *
 * Divergence metric (DD-002):
 *   Two directions "diverge on an axis" when the Jaccard similarity of their
 *   strategy texts for that axis is < JACCARD_DIVERGENCE_THRESHOLD (0.5).
 *
 *   Jaccard similarity = |A ∩ B| / |A ∪ B|  where A, B are WORD TOKEN SETS
 *   derived by: lowercase → collapse whitespace → split on whitespace → Set.
 *
 *   Threshold 0.5 means the strategies must share fewer than half their unique
 *   word tokens. Strategies with ≥50% token overlap are treated as near-identical
 *   (a cosmetic decoy). This is intentionally strict and explainable.
 *
 *   Threshold for axis count: ≥2 of 5 axes must diverge. This is the minimum bar
 *   that catches "1 real + 1 decoy" while permitting genuinely similar strategies
 *   on individual axes (e.g. both directions using SVG icons is fine as long as
 *   layout, color, and typography differ).
 *
 * Non-mechanical aspects declared in UNCHECKED_RULES (never hidden):
 *   - Semantic quality of whyItIsNotGeneric text (requires model/human review).
 *   - Whether declared rationale actually corresponds to the strategy content.
 *
 * Pure + deterministic:
 *   - No I/O, no network, no DB, no randomness.
 *   - Same input ⇒ same output, every call.
 *
 * Zero archon-service dependencies — safe to import from web/ or any tooling.
 */

import type {
  DesignDirection,
  DirectionDivergenceResult,
  DirectionDivergenceViolation
} from "./design-direction-contract.ts";

// Re-export schemas and types so callers can import from one module.
export type {
  DesignDirection,
  DirectionSet,
  DirectionDivergenceViolation,
  DirectionDivergenceResult
} from "./design-direction-contract.ts";

export {
  DesignDirectionSchema,
  DirectionSetSchema,
  DirectionDivergenceViolationSchema,
  DirectionDivergenceResultSchema
} from "./design-direction-contract.ts";

// ---------------------------------------------------------------------------
// Constants — divergence metric parameters
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity threshold BELOW which two strategy texts are considered
 * "materially different" (divergent on that axis).
 *
 * Jaccard < 0.5 means the word-token sets share fewer than half their unique
 * words. Above this threshold, the strategies are treated as near-identical.
 *
 * Choice rationale:
 *   - 0.5 is the natural midpoint of Jaccard (0=disjoint, 1=identical).
 *   - A cosmetic decoy that merely rewords the same strategy will share most
 *     content words (nouns, adjectives) and land at Jaccard ≈ 0.7–0.95.
 *   - Genuinely different strategies (e.g. "monospace numeric grid" vs
 *     "serif editorial vertical flow") will share only stop words and land
 *     at Jaccard ≈ 0.05–0.25.
 *   - This threshold has no false-positive risk for genuinely different
 *     strategies and correctly catches cosmetic rewording.
 */
const JACCARD_DIVERGENCE_THRESHOLD = 0.5;

/**
 * Minimum number of strategy axes on which the MOST-SIMILAR direction pair
 * must diverge (Jaccard < threshold) to pass DD-002.
 *
 * 2 of 5 axes is the minimum bar:
 *   - Allows directions that happen to share one or two strategy choices
 *     (e.g. both use SVG icons, both use scroll interactions) as long as
 *     the primary differentiating axes (layout, color, typography) differ.
 *   - A cosmetic decoy that only changes one axis (e.g. only renames the
 *     color palette) will fail this check because 4 of 5 axes remain identical.
 */
const DIVERGENCE_AXIS_MIN = 2;

/**
 * The 5 strategy axes used for divergence measurement.
 * These are the axes defined in §6.3 DesignDirection and checked by DD-002.
 */
const STRATEGY_AXES = [
  "layoutStrategy",
  "typographyStrategy",
  "colorStrategy",
  "assetStrategy",
  "interactionStrategy"
] as const;

// StrategyAxis is used implicitly via STRATEGY_AXES iteration; no named use needed.

// ---------------------------------------------------------------------------
// Unchecked rules (declared explicitly — never hidden)
// ---------------------------------------------------------------------------

const UNCHECKED_RULES: readonly string[] = [
  "DD-U01: Semantic quality of whyItIsNotGeneric rationale text — whether the declared reasons are genuinely insightful (not just plausible-sounding filler) requires model or human review. The checker only verifies non-emptiness.",
  "DD-U02: Correspondence between rationale and strategy — whether the whyItIsNotGeneric entries actually match the stated strategies (not borrowed from a different direction) requires semantic analysis beyond token comparison.",
  "DD-U03: Audience fit and brand coherence of each direction — whether a direction is appropriate for the target audience and brand cannot be determined from the schema fields alone."
];

// ---------------------------------------------------------------------------
// Token normalization and Jaccard similarity
// ---------------------------------------------------------------------------

/**
 * Normalize a strategy text into a set of word tokens.
 *
 * Steps:
 *   1. Lowercase the entire string.
 *   2. Collapse all whitespace runs to a single space and trim.
 *   3. Split on whitespace.
 *   4. Return as a Set<string> (deduplicates repeated words).
 *
 * This is intentionally simple and explainable. More sophisticated NLP
 * (stemming, stop-word removal) would reduce explainability and introduce
 * ambiguity without meaningfully improving accuracy for this use case.
 */
function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return new Set<string>();
  return new Set<string>(normalized.split(" "));
}

/**
 * Compute the Jaccard similarity of two token sets.
 *
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Returns 1.0 when both sets are empty (two empty strategies are identical).
 * Returns 0.0 when one set is empty and the other is not (maximally divergent
 * from a token perspective, but this should not arise given min(1) schema cap).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize++;
  }

  const unionSize = a.size + b.size - intersectionSize;
  // unionSize is always ≥ 1 here because both sets are non-empty
  return intersectionSize / unionSize;
}

/**
 * Count the number of strategy axes on which directions `a` and `b` diverge.
 *
 * Two directions diverge on an axis when
 *   jaccardSimilarity(tokenize(a[axis]), tokenize(b[axis])) < JACCARD_DIVERGENCE_THRESHOLD
 */
function countDivergentAxes(a: DesignDirection, b: DesignDirection): number {
  let count = 0;
  for (const axis of STRATEGY_AXES) {
    const sim = jaccardSimilarity(tokenize(a[axis]), tokenize(b[axis]));
    if (sim < JACCARD_DIVERGENCE_THRESHOLD) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Per-rule check functions (pure, deterministic)
// ---------------------------------------------------------------------------

/** DD-001: fewer than 2 directions provided. */
function checkDD001(directions: readonly DesignDirection[]): DirectionDivergenceViolation | undefined {
  if (directions.length < 2) {
    return {
      ruleId: "DD-001",
      message: `DD-001 [hard_fail]: At least 2 design directions are required; only ${directions.length} provided. Council condition #2 requires ≥2 divergent directions.`,
      severity: "hard_fail"
    };
  }
  return undefined;
}

/**
 * DD-002: directions are not sufficiently divergent across strategy axes.
 *
 * Algorithm:
 *   For every pair (i, j) with i < j in the direction set, compute the number
 *   of strategy axes on which they diverge. The pair with the MINIMUM divergent
 *   axis count is the "most similar pair" (worst case). If this minimum is less
 *   than DIVERGENCE_AXIS_MIN, DD-002 fires.
 *
 *   This is O(n² × k) where n = directions, k = 5 strategy axes. For the
 *   typical n ≤ 5, this is negligible.
 *
 * Returns the violation (if any) and the divergentAxisCount for the most-similar pair.
 */
function checkDD002(directions: readonly DesignDirection[]): {
  violation: DirectionDivergenceViolation | undefined;
  divergentAxisCount: number;
} {
  if (directions.length < 2) {
    return { violation: undefined, divergentAxisCount: 0 };
  }

  // Find the most-similar pair (minimum divergent axis count across all pairs).
  // Initialize to the maximum possible (all axes diverge) so any real pair beats it.
  let minDivergentAxes: number = STRATEGY_AXES.length;
  let minPairA = 0;
  let minPairB = 1;

  for (let i = 0; i < directions.length; i++) {
    for (let j = i + 1; j < directions.length; j++) {
      const dirA = directions[i];
      const dirB = directions[j];
      // Both are defined — i and j are valid indices within the array.
      if (dirA === undefined || dirB === undefined) continue;

      const divergentAxes = countDivergentAxes(dirA, dirB);
      if (divergentAxes < minDivergentAxes) {
        minDivergentAxes = divergentAxes;
        minPairA = i;
        minPairB = j;
      }
    }
  }

  if (minDivergentAxes < DIVERGENCE_AXIS_MIN) {
    const a = directions[minPairA];
    const b = directions[minPairB];
    const idA = a?.id ?? `index-${minPairA}`;
    const idB = b?.id ?? `index-${minPairB}`;

    return {
      violation: {
        ruleId: "DD-002",
        message: [
          `DD-002 [hard_fail]: Direction pair (${idA}, ${idB}) is not sufficiently divergent.`,
          `They diverge on only ${minDivergentAxes} of ${STRATEGY_AXES.length} strategy axes`,
          `(threshold: ≥${DIVERGENCE_AXIS_MIN}).`,
          `Metric: Jaccard word-token similarity < ${JACCARD_DIVERGENCE_THRESHOLD} per axis.`,
          `Council condition #2: directions must differ across strategy axes — not be cosmetic decoys.`
        ].join(" "),
        severity: "hard_fail"
      },
      divergentAxisCount: minDivergentAxes
    };
  }

  return { violation: undefined, divergentAxisCount: minDivergentAxes };
}

/**
 * DD-003: a direction has empty or whitespace-only whyItIsNotGeneric.
 *
 * Council condition #2: each direction must declare non-empty contrast rationale.
 * An empty array OR an array where every entry is whitespace-only fails.
 *
 * Severity: hard_fail.
 *
 * Returns one violation per offending direction.
 */
function checkDD003(directions: readonly DesignDirection[]): readonly DirectionDivergenceViolation[] {
  const violations: DirectionDivergenceViolation[] = [];

  for (const dir of directions) {
    const hasNonEmptyEntry = dir.whyItIsNotGeneric.some(
      (entry) => entry.trim().length > 0
    );

    if (!hasNonEmptyEntry) {
      violations.push({
        ruleId: "DD-003",
        message: `DD-003 [hard_fail]: Direction "${dir.id}" has an empty or whitespace-only whyItIsNotGeneric. Council condition #2 requires each direction to declare explicit contrast rationale (why it is NOT a generic choice).`,
        severity: "hard_fail"
      });
    }
  }

  return violations;
}

/**
 * DD-004: duplicate id or name across directions.
 *
 * Duplicate ids or names indicate a copy-paste decoy was not differentiated.
 * Advisory warning — does not block the gate alone.
 *
 * Returns one violation per duplicate id and one per duplicate name.
 */
function checkDD004(directions: readonly DesignDirection[]): readonly DirectionDivergenceViolation[] {
  const violations: DirectionDivergenceViolation[] = [];

  // Check ids
  const idsSeen = new Map<string, number>(); // id → first occurrence index
  for (let i = 0; i < directions.length; i++) {
    const dir = directions[i];
    if (dir === undefined) continue;
    const firstIdx = idsSeen.get(dir.id);
    if (firstIdx !== undefined) {
      violations.push({
        ruleId: "DD-004",
        message: `DD-004 [warning]: Duplicate direction id "${dir.id}" at index ${i} (first seen at index ${firstIdx}). Each direction must have a unique id.`,
        severity: "warning"
      });
    } else {
      idsSeen.set(dir.id, i);
    }
  }

  // Check names
  const namesSeen = new Map<string, number>(); // name → first occurrence index
  for (let i = 0; i < directions.length; i++) {
    const dir = directions[i];
    if (dir === undefined) continue;
    const firstIdx = namesSeen.get(dir.name);
    if (firstIdx !== undefined) {
      violations.push({
        ruleId: "DD-004",
        message: `DD-004 [warning]: Duplicate direction name "${dir.name}" at index ${i} (first seen at index ${firstIdx}). Each direction must have a unique name.`,
        severity: "warning"
      });
    } else {
      namesSeen.set(dir.name, i);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a set of design directions for council condition #2 compliance.
 *
 * PURE and DETERMINISTIC:
 *   - No I/O, no network, no DB, no randomness.
 *   - Same input ⇒ same output, every call.
 *
 * This function does NOT validate the input against DesignDirectionSchema.
 * Callers must validate input against DirectionSetSchema before passing it here.
 * Passing schema-invalid directions produces undefined behavior.
 *
 * @param directions - Array of already-schema-validated DesignDirection objects.
 *
 * @returns DirectionDivergenceResult with:
 *   - violations: all violations in deterministic order (DD-NNN ascending)
 *   - passed: true iff no hard_fail violations
 *   - divergentAxisCount: axis divergence count for the most-similar pair
 *   - uncheckedRules: non-mechanical aspects explicitly declared
 */
export function checkDirectionDivergence(
  directions: readonly DesignDirection[]
): DirectionDivergenceResult {
  const violations: DirectionDivergenceViolation[] = [];

  // DD-001: count check (must run first; DD-002 requires ≥2 directions)
  const v001 = checkDD001(directions);
  if (v001 !== undefined) {
    // With fewer than 2 directions, DD-002 cannot meaningfully run.
    // Return early with DD-001 and zero divergentAxisCount.
    return {
      violations: [v001],
      passed: false,
      divergentAxisCount: 0,
      uncheckedRules: [...UNCHECKED_RULES]
    };
  }

  // DD-002: strategy axis divergence (most-similar pair)
  const dd002 = checkDD002(directions);
  if (dd002.violation !== undefined) {
    violations.push(dd002.violation);
  }

  // DD-003: missing/empty whyItIsNotGeneric rationale
  violations.push(...checkDD003(directions));

  // DD-004: duplicate ids/names (warning only)
  violations.push(...checkDD004(directions));

  // Sort violations: hard_fail before warning, then by ruleId ascending.
  // Within same severity+ruleId, preserve detection order.
  const sorted = [...violations].sort((a, b) => {
    // hard_fail before warning
    if (a.severity !== b.severity) {
      return a.severity === "hard_fail" ? -1 : 1;
    }
    // Then by ruleId (DD-NNN numeric sort)
    return a.ruleId.localeCompare(b.ruleId, "en", { numeric: true });
  });

  const passed = sorted.every(v => v.severity !== "hard_fail");

  return {
    violations: sorted,
    passed,
    divergentAxisCount: dd002.divergentAxisCount,
    uncheckedRules: [...UNCHECKED_RULES]
  };
}
