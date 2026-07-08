/**
 * @module forge/anti-generic-types
 *
 * Zod schemas and inferred TypeScript types for the anti-generic checker
 * (Phase 1, S4). Extracted from anti-generic-checker.ts to keep the logic
 * file focused (schemas-vs-logic cohesion mirrors asset-contract.ts vs
 * asset-qa.ts).
 *
 * Import this module from tests, the Playwright extractor layer, or any
 * tooling that needs to validate or construct snapshots/reports without
 * pulling in checker logic.
 *
 * Zero archon-service dependencies — safe to import from web/ or any tooling.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// String length caps used in the schema.
//
// These are input bounds that prevent an adversarial snapshot from carrying
// unbounded data into violation messages. The caps are generous enough for
// all real-world selectors and CSS values.
// ---------------------------------------------------------------------------

/** Maximum length for a CSS selector string (e.g. "main > section.foo > div"). */
const MAX_SELECTOR_LEN = 512;
/** Maximum length for an HTML tag name (longest HTML tag is "blockquote" = 10). */
const MAX_TAG_LEN = 32;
/** Maximum length for a CSS value string (e.g. a font-family or background-image). */
const MAX_CSS_VALUE_LEN = 512;
/** Maximum number of elements in a single snapshot (prevents memory exhaustion). */
const MAX_ELEMENTS = 10_000;

/** Maximum length for an AG-018 allow-marker asset id (slug-style; generous). */
const MAX_ASSET_ID_LEN = 64;

// ---------------------------------------------------------------------------
// RenderedSnapshot — input contract
//
// Represents what a (future) Playwright extraction produces over a rendered
// page. Sufficient for checking all mechanically-checkable AG rules WITHOUT
// requiring a browser at test time. Each field documents the AG rule(s) it
// serves.
// ---------------------------------------------------------------------------

/**
 * A subset of computed CSS properties relevant to the manifest constraints.
 * Extracted by the Playwright layer for each element. All values are optional
 * because not every CSS property applies to every element type.
 */
export const ComputedStyleSubsetSchema = z.object({
  /**
   * Border radius of the element in pixels (uniform or max corner).
   * Used by: AG-003 (radius cap).
   */
  borderRadiusPx: z.number().nonnegative().optional(),

  /**
   * Raw value of the CSS `box-shadow` property (empty string = none).
   * Used by: AG-004 (no shadows for elevation on dark surfaces).
   */
  boxShadow: z.string().max(MAX_CSS_VALUE_LEN).optional(),

  /**
   * Raw value of the CSS `background-image` property (empty string = none).
   * Used by: AG-001 (no gradient fills on UI surfaces).
   */
  backgroundImage: z.string().max(MAX_CSS_VALUE_LEN).optional(),

  /**
   * Raw value of the CSS `background` shorthand or `background-color`.
   * Used by: AG-006 (no pure #000000 canvas).
   */
  backgroundColor: z.string().max(MAX_CSS_VALUE_LEN).optional(),

  /**
   * Raw value of the CSS `color` property.
   * Used by: AG-005 (no pure #FFFFFF body text).
   */
  color: z.string().max(MAX_CSS_VALUE_LEN).optional(),

  /**
   * Maximum animation duration in milliseconds among all animations on this element.
   * 0 means no animation. Used by: AG-010 (no motion > 200ms).
   */
  animationDurationMs: z.number().nonnegative().optional(),

  /**
   * Gap in pixels between direct children (CSS `gap` / `grid-gap`).
   * Used by: AG-009 (8px grid spacing).
   */
  gapPx: z.number().nonnegative().optional(),

  /**
   * Padding values [top, right, bottom, left] in pixels.
   * Used by: AG-009 (8px grid spacing).
   */
  paddingPx: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),

  /**
   * Width of the element in pixels.
   * Used by: AG-012/AG-014 (structural equality checks for card grids).
   */
  widthPx: z.number().nonnegative().optional(),

  /**
   * CSS `display` value (e.g. "flex", "grid", "block").
   * Used by: AG-012 (flex/grid container detection).
   */
  display: z.string().max(MAX_CSS_VALUE_LEN).optional(),

  /**
   * Raw value of `backdrop-filter` CSS property (empty string = none).
   * Used by: AG-011 (no glassmorphism without purpose).
   */
  backdropFilter: z.string().max(MAX_CSS_VALUE_LEN).optional(),

  /**
   * Raw value of `font-family` CSS property.
   * Used by: AG-007 (no default system font stack).
   */
  fontFamily: z.string().max(MAX_CSS_VALUE_LEN).optional(),

  /**
   * Height of the element in pixels.
   * Used by: AG-017 (task-row height-density assertion).
   */
  heightPx: z.number().nonnegative().optional()
});

export type ComputedStyleSubset = z.infer<typeof ComputedStyleSubsetSchema>;

/**
 * A single element node in the rendered snapshot.
 *
 * The tree structure is represented as a flat list with parent references
 * so it is serialisable to/from JSON without circular references.
 *
 * NOTE on childCount: this field is provided by the Playwright extractor
 * for informational reference only. The anti-generic checker does NOT use
 * childCount for structural decisions — it uses directChildren() traversal
 * over the flat element list, which is the authoritative source of truth
 * for child cardinality. This ensures correctness even when childCount
 * disagrees with the actual flat list (e.g. due to partial snapshots).
 */
export const RenderedElementSchema = z.object({
  /**
   * A stable CSS-selector-style path for this element
   * (e.g. "main > section:nth-child(1) > div"). The anti-generic checker
   * cites this in violation messages so the repair loop can locate the
   * element without a browser (council condition C3/§13).
   */
  selector: z.string().min(1).max(MAX_SELECTOR_LEN),

  /** HTML tag name in lowercase (e.g. "div", "section", "main"). */
  tag: z.string().min(1).max(MAX_TAG_LEN),

  /**
   * ARIA role — explicit `role` attribute or the implicit role for the tag.
   * Optional because not every element has a meaningful role.
   */
  role: z.string().max(MAX_TAG_LEN).optional(),

  /**
   * Number of direct DOM children of this element.
   * Informational only — the checker uses directChildren() traversal
   * over the flat list for all structural decisions (see NOTE above).
   */
  childCount: z.number().int().nonnegative(),

  /**
   * Total text content length (trimmed) of this element and its descendants.
   * Used by: AG-012/AG-014 (rough body-text detection in card structures).
   */
  textLength: z.number().int().nonnegative(),

  /** Computed style subset relevant to manifest constraints. */
  computed: ComputedStyleSubsetSchema,

  /**
   * Parent pointer — the `selector` value of the direct parent element,
   * or null for the root element.
   *
   * CONTRACT: this is a parent-pointer forming a tree, NOT a CSS combinator
   * path. Its string value equals exactly some other element's `selector`
   * field (or null for roots). The checker resolves parent relationships by
   * looking up `elements.find(e => e.selector === el.parentSelector)` — it
   * never interprets this field as a CSS combinator expression or uses
   * substring/startsWith matching against it.
   *
   * The Playwright extractor may produce any selector naming convention
   * (e.g. "body > main", "#root > main", "section.hero") — this is fine
   * because the checker only tests string identity equality to match
   * parent ↔ child pairs.
   *
   * Length-bounded to prevent memory exhaustion from adversarial inputs.
   */
  parentSelector: z.string().max(MAX_SELECTOR_LEN).nullable(),

  /**
   * Semantic classification hint from the Playwright extractor.
   * "overlay" = modal, dropdown, popover (exempt from some shadow/blur rules).
   * "body"    = the root body element (AG-006 canvas check).
   * undefined = generic element.
   */
  semanticHint: z.enum(["overlay", "body"]).optional(),

  /**
   * AG-018 single-illustration allow-marker — the `data-ag018-allow` attribute
   * value, which MUST be an asset id (council `forgeEmptyStateIllustration`, C1).
   *
   * An empty-state container carrying this marker (or whose icon child does) is
   * exempt from the AG-018 icon-above-text hard_fail ONLY when (a) the asset id
   * resolves to a QA-passed manifest asset supplied to the checker, and (b) it is
   * the SOLE such marker in the snapshot (C2 singleton — two or more hard_fail).
   * Absent / unverifiable marker → AG-018 fires as normal (fail closed). The
   * Playwright extractor reads this from the element's `data-ag018-allow` attr.
   */
  ag018Allow: z.string().max(MAX_ASSET_ID_LEN).optional()
});

export type RenderedElement = z.infer<typeof RenderedElementSchema>;

/**
 * The full snapshot of a rendered page, as produced by the Playwright extractor.
 */
export const RenderedSnapshotSchema = z.object({
  /**
   * Source URL of the rendered page (for traceability).
   * Must be a valid URL string — validated at schema parse time.
   * Note: runAntiGenericChecker does NOT re-validate the snapshot internally;
   * callers must validate against this schema before invoking the checker.
   */
  url: z.string().url(),
  /**
   * Flat list of all elements in document order.
   * Bounded to MAX_ELEMENTS to prevent memory exhaustion from adversarial inputs.
   */
  elements: z.array(RenderedElementSchema).max(MAX_ELEMENTS)
});

export type RenderedSnapshot = z.infer<typeof RenderedSnapshotSchema>;

// ---------------------------------------------------------------------------
// AntiGenericReport — output contract
// ---------------------------------------------------------------------------

export const ViolationSchema = z.object({
  /**
   * The AG-NNN rule id from the constraints manifest.
   * Every violation MUST cite its agId (council condition C3/§13).
   */
  agId: z.string().regex(/^AG-\d{3}$/),

  /** Severity level — mirrors the manifest rule's severity. */
  severity: z.enum(["hard_fail", "warning"]),

  /**
   * CSS selector of the violating element (from RenderedElement.selector).
   * May be omitted for page-level violations with no single element anchor.
   */
  selector: z.string().optional(),

  /**
   * Human-readable description of what was measured (e.g. "borderRadius=12px").
   * Required for numeric rules so the repair loop gets a machine-readable diff.
   */
  measured: z.string().optional(),

  /**
   * The cap or threshold that was violated (e.g. "≤8px").
   * Required for numeric rules alongside `measured`.
   */
  cap: z.string().optional(),

  /** Full human-readable violation message. */
  message: z.string()
});

export type Violation = z.infer<typeof ViolationSchema>;

export const AntiGenericReportSchema = z.object({
  /** All detected violations, each citing its AG-NNN id. */
  violations: z.array(ViolationSchema),

  /**
   * AG-NNN ids that are NOT mechanically checkable by this tier.
   * Declared explicitly so advisory coverage is visible, never hidden
   * (council requirement: unchecked rules must be declared).
   */
  uncheckedRules: z.array(z.string()),

  /**
   * True iff any violation has severity === "hard_fail".
   * This is the signal the repair loop uses to return `rework`.
   */
  blocking: z.boolean()
});

export type AntiGenericReport = z.infer<typeof AntiGenericReportSchema>;
