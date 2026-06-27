/**
 * @module forge/anti-generic-checker
 *
 * Deterministic anti-generic checker for Archon Forge (Phase 1, S4).
 *
 * Council condition C1 (non-waivable): This module provides FALSIFIABLE,
 * deterministic assertions over a RenderedSnapshot so the pipeline can return
 * `rework` on output that is "technically correct but GENERIC" — not just on
 * a11y/layout defects.
 *
 * AG-012 and AG-014 are DOM-structure assertions that constitute the
 * non-waivable bar set by the council.
 *
 * Design constraints:
 *   - Zero archon-service dependencies (pure module; importable from tooling)
 *   - Only `zod` + the constraints manifest
 *   - No `any`; all unknowns narrowed explicitly
 *
 * Schemas and TypeScript types live in anti-generic-types.ts (schema/logic
 * cohesion mirrors dashboard-contract.ts vs constraints-manifest.ts).
 */

import { CONSTRAINTS_MANIFEST } from "./constraints-manifest.ts";
import type { RenderedElement, RenderedSnapshot, Violation, AntiGenericReport } from "./anti-generic-types.ts";

// Re-export schemas and types so callers can import everything from this one
// module without knowing the types sub-module (stable public API surface).
export type {
  ComputedStyleSubset,
  RenderedElement,
  RenderedSnapshot,
  Violation,
  AntiGenericReport
} from "./anti-generic-types.ts";

export {
  ComputedStyleSubsetSchema,
  RenderedElementSchema,
  RenderedSnapshotSchema,
  ViolationSchema,
  AntiGenericReportSchema
} from "./anti-generic-types.ts";

// ---------------------------------------------------------------------------
// Spacing grid
//
// AG-009: spacing must be a multiple of the manifest's 4px sub-grid (half the
// 8px base). Values 96px (12×8) and 128px (16×8) are valid on-grid values not
// listed in the manifest's spacingTokens but still permitted as unlisted
// multiples. The derivation is: isOnGrid(px) = (px % 4 === 0).
// ---------------------------------------------------------------------------

const SPACING_GRID_PX = 4; // manifest 4px sub-grid base
// Allow values ≤ 2px as visual-alignment corrections per AG-009.
const SPACING_CORRECTION_THRESHOLD_PX = 2;

// ---------------------------------------------------------------------------
// Canonical palette hex set (for AG-013 off-palette color check)
//
// Derived from CONSTRAINTS_MANIFEST.identity at module load. Includes all
// named surface, text, accent, status, and border tokens. The CHECK is:
// if computed.color or computed.backgroundColor is a parseable hex value AND
// it is not in this set, emit a warning citing AG-013.
//
// NOTE: the unmechanizable part of AG-013 (verifying a token NAME, not just
// the hex value) is left as unchecked. What we CAN verify deterministically
// is that the hex value is a member of the canonical palette.
// ---------------------------------------------------------------------------

function buildCanonicalPaletteHex(): Set<string> {
  const { surfaceRamp, textHierarchy, accent, statusColors, statusTextColors } =
    CONSTRAINTS_MANIFEST.identity;

  const hexValues: string[] = [
    ...Object.values(surfaceRamp),
    ...Object.values(textHierarchy),
    accent.base, accent.bright,
    ...Object.values(statusColors),
    ...Object.values(statusTextColors),
    // pure black and pure white are not in the palette but we track them via
    // AG-005/AG-006 — don't double-count them here.
    "#0A0A0A" // darkBase (same as surfaceRamp.base, listed explicitly)
  ];

  const result = new Set<string>();
  for (const raw of hexValues) {
    const hex = normalizeHex(raw);
    if (hex !== null) result.add(hex);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers (defined before use; buildCanonicalPaletteHex uses normalizeHex)
// ---------------------------------------------------------------------------

/** Returns true if the CSS value string contains any gradient function. */
function containsGradient(value: string): boolean {
  return /gradient\s*\(/.test(value);
}

/**
 * Normalize a hex color to 6-digit lowercase without the # prefix.
 * Returns null if the value is not a parseable hex color (e.g. rgba, named).
 */
function normalizeHex(value: string): string | null {
  const cleaned = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(cleaned)) return cleaned;
  if (/^[0-9a-f]{3}$/.test(cleaned)) {
    return cleaned.split("").map((c) => c + c).join("");
  }
  return null;
}

/** Returns true if a spacing value (px) is a multiple of the 4px sub-grid. */
function isOnGrid(px: number): boolean {
  if (px <= SPACING_CORRECTION_THRESHOLD_PX) return true;
  return Math.round(px) % SPACING_GRID_PX === 0;
}

/**
 * Cap a snapshot-derived string to 80 characters before embedding in a
 * violation message. Prevents adversarial snapshots from bloating log output.
 */
function cap(s: string): string {
  return s.slice(0, 80);
}

/** Direct children of `parentSelector` in the snapshot's flat element list. */
function directChildren(
  elements: readonly RenderedElement[],
  parentSelector: string
): RenderedElement[] {
  return elements.filter((el) => el.parentSelector === parentSelector);
}

/**
 * Walk the parent chain of `el` upward.
 * Returns all ancestor elements (nearest-first) up to the root.
 *
 * Cycle guard: if any selector is visited twice, the walk stops immediately.
 * This prevents infinite loops when an adversarial snapshot contains a
 * circular parentSelector chain (which is Zod-valid — the schema does not
 * enforce DAG structure).
 */
function ancestors(
  elements: readonly RenderedElement[],
  el: RenderedElement
): RenderedElement[] {
  const result: RenderedElement[] = [];
  const visited = new Set<string>();
  let current: RenderedElement | undefined = el;
  while (current?.parentSelector !== null && current?.parentSelector !== undefined) {
    // Cycle guard: if we've already visited this node, stop.
    if (visited.has(current.selector)) break;
    visited.add(current.selector);
    const parent = elements.find((e) => e.selector === current!.parentSelector);
    if (parent === undefined) break;
    result.push(parent);
    current = parent;
  }
  return result;
}

/**
 * Classifies a sibling set's width uniformity.
 * - "equal"   — max/min ratio ≤ 1.25 (25% variance); all provided elements
 *               have a defined widthPx AND at least 2 are present
 * - "unequal" — ratio > 1.25; all elements have defined widthPx
 * - "unknown" — ANY element in the set has widthPx === undefined (undefined
 *               means we cannot confirm equal-width, so we must say unknown)
 *
 * IMPORTANT: undefined widthPx is NEVER coerced to 0. A missing measurement
 * makes the result "unknown" so the caller can emit a warning instead of
 * silently passing or falsely hard-failing.
 */
function widthUniformity(
  siblings: readonly RenderedElement[]
): "equal" | "unequal" | "unknown" {
  if (siblings.length < 2) return "unknown";
  // If ANY element is missing widthPx, we cannot determine uniformity.
  if (siblings.some((el) => el.computed.widthPx === undefined)) return "unknown";
  const widths = siblings.map((el) => el.computed.widthPx as number);
  const min = Math.min(...widths);
  const max = Math.max(...widths);
  // A minimum of 0 means some widths are zero-sized — treat as unknown.
  if (min === 0) return "unknown";
  return max / min <= 1.25 ? "equal" : "unequal";
}

/**
 * True when `parentSelector` has a child that looks like an icon:
 * an svg/img tag, a role="img"/"presentation", or textLength ≤ 4.
 */
function hasIconishChild(
  elements: readonly RenderedElement[],
  parentSelector: string
): boolean {
  return directChildren(elements, parentSelector).some(
    (c) =>
      c.textLength <= 4 ||
      c.tag === "svg" ||
      c.tag === "img" ||
      c.role === "img" ||
      c.role === "presentation"
  );
}

/**
 * True when `el` has the internal structure of a generic feature card:
 * icon-ish child + short title child (≤60 chars) + body text.
 *
 * NOTE: childCount (the schema field) is an informational field provided
 * by the Playwright extractor for reference. The checker does NOT trust it
 * for structural decisions — directChildren() traversal over the flat element
 * list is the authoritative source of truth for all child-cardinality checks.
 * This ensures correctness even when childCount disagrees with the flat list.
 */
function hasFeatureCardStructure(
  elements: readonly RenderedElement[],
  el: RenderedElement
): boolean {
  const children = directChildren(elements, el.selector);
  if (children.length < 2) return false;
  const hasIcon = hasIconishChild(elements, el.selector);
  const hasTitleNode = children.some((c) => c.textLength > 0 && c.textLength <= 60);
  const hasBodyNode = children.some((c) => c.textLength > 60) || el.textLength > 80;
  return hasIcon && hasTitleNode && hasBodyNode;
}

// Build the palette once at module load (pure data, no side effects).
const CANONICAL_PALETTE_HEX: Set<string> = buildCanonicalPaletteHex();

// ---------------------------------------------------------------------------
// Per-rule check functions
// ---------------------------------------------------------------------------

function checkAG001(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    if (el.semanticHint === "overlay") continue;
    const bg = el.computed.backgroundImage ?? "";
    if (bg !== "" && containsGradient(bg)) {
      violations.push({
        agId: "AG-001",
        severity: "hard_fail",
        selector: el.selector,
        measured: `backgroundImage="${cap(bg)}"`,
        cap: "no gradient fills on UI surfaces",
        message: `AG-001: Gradient fill detected on <${el.tag}> "${cap(el.selector)}". Gradient fills on cards, panels, or section backgrounds are forbidden.`
      });
    }
  }
  return violations;
}

function checkAG003(elements: readonly RenderedElement[]): Violation[] {
  const radiusCap = CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx;
  const violations: Violation[] = [];
  for (const el of elements) {
    const r = el.computed.borderRadiusPx;
    if (r !== undefined && r > radiusCap) {
      violations.push({
        agId: "AG-003",
        severity: "hard_fail",
        selector: el.selector,
        measured: `borderRadius=${r}px`,
        cap: `≤${radiusCap}px`,
        message: `AG-003: Border radius ${r}px exceeds absolute cap of ${radiusCap}px on <${el.tag}> "${cap(el.selector)}".`
      });
    }
  }
  return violations;
}

function checkAG004(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    if (el.semanticHint === "overlay") continue;
    const shadow = el.computed.boxShadow ?? "";
    if (shadow !== "" && shadow !== "none") {
      violations.push({
        agId: "AG-004",
        severity: "hard_fail",
        selector: el.selector,
        measured: `boxShadow="${cap(shadow)}"`,
        cap: "no box-shadow for elevation on dark surfaces",
        message: `AG-004: box-shadow elevation detected on <${el.tag}> "${cap(el.selector)}". Use luminance steps instead.`
      });
    }
  }
  return violations;
}

function checkAG005(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    const colorVal = el.computed.color ?? "";
    if (normalizeHex(colorVal) === "ffffff") {
      violations.push({
        agId: "AG-005",
        severity: "hard_fail",
        selector: el.selector,
        measured: `color=${cap(colorVal)}`,
        cap: "use --text-primary (#EDEDED), not pure #FFFFFF",
        message: `AG-005: Pure #FFFFFF body text detected on <${el.tag}> "${cap(el.selector)}". Use --text-primary (#EDEDED).`
      });
    }
  }
  return violations;
}

function checkAG006(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    if (el.semanticHint !== "body" && el.tag !== "body") continue;
    const bg = el.computed.backgroundColor ?? "";
    if (normalizeHex(bg) === "000000") {
      violations.push({
        agId: "AG-006",
        severity: "hard_fail",
        selector: el.selector,
        measured: `backgroundColor=${cap(bg)}`,
        cap: "use --surface-base (#0A0A0A), not pure #000000",
        message: `AG-006: Pure #000000 canvas detected on body element "${cap(el.selector)}". Use --surface-base (#0A0A0A).`
      });
    }
  }
  return violations;
}

function checkAG007(elements: readonly RenderedElement[]): Violation[] {
  const systemKeywords = ["system-ui", "-apple-system", "blinkmacsystemfont", "segoe ui"];
  const violations: Violation[] = [];
  for (const el of elements) {
    const ff = (el.computed.fontFamily ?? "").toLowerCase();
    if (ff === "") continue;
    const hasSystem = systemKeywords.some((kw) => ff.includes(kw));
    const hasGeist = ff.includes("geist") || ff.includes("inter");
    if (hasSystem && !hasGeist) {
      violations.push({
        agId: "AG-007",
        severity: "hard_fail",
        selector: el.selector,
        measured: `fontFamily="${cap(el.computed.fontFamily ?? "")}"`,
        cap: "use Geist Sans + Geist Mono; Inter is the only permitted fallback",
        message: `AG-007: Default system font stack detected on <${el.tag}> "${cap(el.selector)}" without Geist or Inter.`
      });
    }
  }
  return violations;
}

function checkAG009(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    const gap = el.computed.gapPx;
    if (gap !== undefined && !isOnGrid(gap)) {
      violations.push({
        agId: "AG-009",
        severity: "hard_fail",
        selector: el.selector,
        measured: `gap=${gap}px`,
        cap: `multiples of ${SPACING_GRID_PX}px`,
        message: `AG-009: Gap value ${gap}px is off the ${SPACING_GRID_PX}px grid on <${el.tag}> "${cap(el.selector)}".`
      });
    }
    const padding = el.computed.paddingPx;
    if (padding !== undefined) {
      for (const [i, side] of (["top", "right", "bottom", "left"] as const).entries()) {
        const pxValue = padding[i as 0 | 1 | 2 | 3];
        if (pxValue !== undefined && !isOnGrid(pxValue)) {
          violations.push({
            agId: "AG-009",
            severity: "hard_fail",
            selector: el.selector,
            measured: `padding-${side}=${pxValue}px`,
            cap: `multiples of ${SPACING_GRID_PX}px`,
            message: `AG-009: Padding-${side} value ${pxValue}px is off the ${SPACING_GRID_PX}px grid on <${el.tag}> "${cap(el.selector)}".`
          });
        }
      }
    }
  }
  return violations;
}

function checkAG010(elements: readonly RenderedElement[]): Violation[] {
  const motionCap = CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs;
  const violations: Violation[] = [];
  for (const el of elements) {
    const dur = el.computed.animationDurationMs;
    if (dur !== undefined && dur > motionCap) {
      violations.push({
        agId: "AG-010",
        severity: "hard_fail",
        selector: el.selector,
        measured: `animationDuration=${dur}ms`,
        cap: `≤${motionCap}ms`,
        message: `AG-010: Animation duration ${dur}ms exceeds ${motionCap}ms cap on <${el.tag}> "${cap(el.selector)}".`
      });
    }
  }
  return violations;
}

function checkAG011(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    if (el.semanticHint === "overlay") continue;
    const bf = el.computed.backdropFilter ?? "";
    // String check on a known CSS keyword — not a selector or user-controlled
    // string; "blur" is a fixed CSS function name, not a substring attack surface.
    if (bf !== "" && bf !== "none" && bf.includes("blur")) {
      violations.push({
        agId: "AG-011",
        severity: "hard_fail",
        selector: el.selector,
        measured: `backdropFilter="${cap(bf)}"`,
        cap: "backdrop-filter:blur only on genuine overlays (modal/tooltip/popover)",
        message: `AG-011: Decorative glassmorphism (backdrop-filter:blur) detected on <${el.tag}> "${cap(el.selector)}". Only permitted on genuine floating overlays.`
      });
    }
  }
  return violations;
}

/**
 * AG-012 — Non-waivable DOM-structure assertion.
 *
 * Detects: a flex/grid container with ≥3 roughly-equal-width direct children
 * where each child has the internal structure of a generic feature card
 * (icon-ish + short title + body text). The check is structural and numeric,
 * NOT semantic or vibe-based.
 *
 * Width-data absence: when ANY feature-card-structured child is missing widthPx,
 * `widthUniformity` returns "unknown" and a `warning`-severity violation is
 * emitted — the C1 rule must never be silently skipped.
 */
function checkAG012(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    const display = el.computed.display ?? "";
    if (display !== "flex" && display !== "grid") continue;
    const children = directChildren(elements, el.selector);
    if (children.length < 3) continue;

    const matchingCards = children.filter((child) =>
      hasFeatureCardStructure(elements, child)
    );
    if (matchingCards.length < 3) continue;

    // We have ≥3 feature-card-structured children — classify width uniformity.
    // IMPORTANT: pass only the matchingCards so that widthPx absence on any
    // feature-card triggers "unknown" rather than being silently ignored.
    const uniformity = widthUniformity(matchingCards);

    if (uniformity === "equal") {
      violations.push({
        agId: "AG-012",
        severity: "hard_fail",
        selector: el.selector,
        measured: `${matchingCards.length} equal-width feature-card children (icon+title+body)`,
        cap: "0 — generic 3-card feature grids are forbidden in developer dashboards",
        message: `AG-012: Generic 3-card feature-soup layout detected on <${el.tag}> "${cap(el.selector)}". Found ${matchingCards.length} equal-width children each with icon+title+body structure. Use data tables, list panels, or structured hierarchy instead.`
      });
    } else if (uniformity === "unknown") {
      // Width data unavailable — declare the uncertainty rather than silently pass.
      violations.push({
        agId: "AG-012",
        severity: "warning",
        selector: el.selector,
        measured: `${matchingCards.length} feature-card-structured children; equal-width check skipped: widthPx unavailable`,
        cap: "0 — generic 3-card feature grids are forbidden (width data needed to confirm)",
        message: `AG-012: Found ${matchingCards.length} feature-card-structured children on <${el.tag}> "${cap(el.selector)}" but widthPx is unavailable for width-equality check. Provide widthPx in the snapshot to resolve this warning.`
      });
    }
    // "unequal" — children are clearly different widths, not the forbidden pattern.
  }
  return violations;
}

// Navigation/header tags that are exempt from the CTA-section check in AG-014.
const NAV_CHROME_TAGS = new Set(["nav", "header"]);

// Tags that qualify as top-level document roots for the AG-014 isTopLevel check.
// These are checked against the RESOLVED PARENT ELEMENT's tag — not against the
// parentSelector string — so compound selector names like "body > main" or
// "#root > main" still resolve correctly via element-pointer lookup.
const TOP_LEVEL_PARENT_TAGS = new Set(["body", "main"]);

/**
 * Returns true when `el` is a top-level section element.
 *
 * "Top-level" means:
 *   - el.parentSelector is null (no parent — it IS the root), OR
 *   - the resolved parent element's tag is "body" or "main" (case-insensitive)
 *
 * This is a parent-pointer resolution, NOT a string match against parentSelector.
 * The parentSelector field is an opaque parent-pointer whose string form may be
 * any valid selector (e.g. "body > main", "#root > main", "html > body") — we
 * look up the actual parent element and check its tag, making this robust to
 * whatever naming the Playwright extractor uses.
 *
 * role="region" also qualifies as top-level (ARIA landmark).
 */
function isTopLevelSection(
  elements: readonly RenderedElement[],
  el: RenderedElement
): boolean {
  if (el.parentSelector === null) return true;
  if (el.role === "region") return true;
  const parent = elements.find((e) => e.selector === el.parentSelector);
  if (parent === undefined) return true; // parent pointer dangling → treat as root
  return TOP_LEVEL_PARENT_TAGS.has(parent.tag.toLowerCase());
}

/**
 * AG-014 — Marketing-page pattern DOM-structure assertion.
 *
 * Detects hero + equal-feature-card-row + CTA skeleton. All three must appear
 * in the snapshot for the hard_fail to trigger.
 *
 * hasHero: uses directChildren() for cardinality and heading check.
 * DESIGN NOTE — hasHero depth exemption: hasHero intentionally does NOT check
 * the hero element's own depth (parentSelector). The three-component conjunction
 * (hero AND equal-card-row AND CTA-section) is the safety net: a heading-section
 * deep in a dashboard can match hasHero alone without firing AG-014 as long as
 * the other two components are absent. Adding parent-tag depth checks to hasHero
 * would require the same parent-pointer resolution as isTopLevelSection and risks
 * false-negatives on real marketing pages that nest a hero under a wrapper div.
 * Current design limitation: documented and accepted; the run-status-dashboard
 * test proves no false-positive in the known operator dashboard pattern.
 *
 * hasCtaSection: uses isTopLevelSection() — resolves the actual parent element
 * by pointer and checks its tag, not the parentSelector string. This is robust
 * to compound selector names like "body > main" or "#root > main".
 * Additional guards:
 *   (a) tag is section or div — NOT nav/header
 *   (b) none of its ancestors is a nav/header element
 *   (c) parent element tag is "body" or "main" (or parentSelector is null)
 *   (d) has a direct button/a/role=button/role=link child
 *   (e) has a heading child (h1-h3, role=heading) OR substantial text (>60 chars)
 *       to distinguish a CTA block from a bare link row
 */
function checkAG014(elements: readonly RenderedElement[]): Violation[] {
  // A hero: section/header/div with ≤5 direct children (from the flat list)
  // including at least one h1/h2 or role=heading, and total text > 40 chars.
  const hasHero = elements.some((el) => {
    if (el.tag !== "section" && el.tag !== "header" && el.tag !== "div") return false;
    const children = directChildren(elements, el.selector);
    if (children.length < 1 || children.length > 5) return false;
    if (el.textLength <= 40) return false;
    return children.some(
      (c) => c.tag === "h1" || c.tag === "h2" || c.role === "heading"
    );
  });

  const hasEqualCardRow = elements.some((el) => {
    const display = el.computed.display ?? "";
    if (display !== "flex" && display !== "grid") return false;
    const children = directChildren(elements, el.selector);
    return children.length >= 3 && widthUniformity(children) === "equal";
  });

  const hasCtaSection = elements.some((el) => {
    if (NAV_CHROME_TAGS.has(el.tag)) return false;
    if (el.tag !== "section" && el.tag !== "div") return false;

    // Must not be inside a nav or header.
    // ancestors() is cycle-safe (visited-set guard inside).
    const elAncestors = ancestors(elements, el);
    if (elAncestors.some((a) => NAV_CHROME_TAGS.has(a.tag))) return false;

    // Parent-pointer resolution — robust to compound selector names.
    if (!isTopLevelSection(elements, el)) return false;

    const children = directChildren(elements, el.selector);

    const hasCallToAction = children.some(
      (c) =>
        c.tag === "button" ||
        c.tag === "a" ||
        c.role === "button" ||
        c.role === "link"
    );
    if (!hasCallToAction) return false;

    // Must have substantive content beyond just a link/button
    const hasHeadingChild = children.some(
      (c) => c.tag === "h1" || c.tag === "h2" || c.tag === "h3" || c.role === "heading"
    );
    const hasSubstantialText = el.textLength > 60;

    return hasHeadingChild || hasSubstantialText;
  });

  if (hasHero && hasEqualCardRow && hasCtaSection) {
    return [
      {
        agId: "AG-014",
        severity: "hard_fail",
        measured: "hero-section + equal-card-row + CTA-section all present",
        cap: "0 marketing-page patterns in developer dashboards",
        message:
          "AG-014: Marketing-page skeleton detected (hero section + equal feature-card row + CTA section). Every screen element must serve information or action, not marketing copy."
      }
    ];
  }
  return [];
}

/**
 * AG-013 — Deterministic partial check: verify computed color values are
 * members of the canonical manifest palette.
 *
 * What IS checkable: whether computed.color / computed.backgroundColor are
 * hex values that exist in the manifest's canonical token palette.
 *
 * What is NOT checkable here: whether the element is using the correct TOKEN
 * NAME for that hex value (e.g. --accent vs --status-pending both map to
 * #6366F1 — the token-name mapping requires a design-system injected map).
 * That unmechanizable part is noted in UNCHECKED_RULES.
 *
 * Non-hex values (rgba, transparent, inherit, etc.) are not checked here —
 * they cannot be compared against the hex palette without a CSS parser.
 *
 * Intentional severity override: the manifest defines AG-013 as "hard_fail"
 * at the policy level, but this deterministic tier emits "warning" because
 * we can only check palette membership, not token identity. A false hard_fail
 * here (wrong severity) would be worse than a false pass on token misuse.
 * The token-name identity layer (which justifies hard_fail) requires a full
 * design-system token map and is declared in UNCHECKED_RULES.
 */
function checkAG013(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    for (const [prop, value] of [
      ["color", el.computed.color],
      ["backgroundColor", el.computed.backgroundColor]
    ] as const) {
      if (value === undefined || value === "") continue;
      const hex = normalizeHex(value);
      if (hex === null) continue; // rgba/named/inherit — not checkable at this tier
      if (!CANONICAL_PALETTE_HEX.has(hex)) {
        violations.push({
          agId: "AG-013",
          severity: "warning",
          selector: el.selector,
          measured: `${prop}=${cap(value)} (normalized: #${hex})`,
          cap: "all color values must be members of the canonical manifest palette",
          message: `AG-013: Off-palette color detected — ${prop}=${cap(value)} on <${el.tag}> "${cap(el.selector)}" is not in the canonical manifest palette. Use a token reference.`
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// AG rules genuinely NOT mechanically checkable from the snapshot
// (declared explicitly; callers receive these as `uncheckedRules` in the report)
// ---------------------------------------------------------------------------

const UNCHECKED_RULES: ReadonlyArray<{ id: string; reason: string }> = [
  {
    id: "AG-002",
    reason:
      "Detecting a 'second accent color' requires knowing which colors are intentional UI accents vs semantic status fills vs decorative backgrounds. The snapshot provides raw color values but cannot reliably distinguish accent-role use from status-role use without full token-map analysis. A future tier (color-role tagger) is required."
  },
  {
    id: "AG-008",
    reason:
      "Detecting warm/cool tint in neutral grays requires converting colors to HSL and checking the saturation channel while distinguishing intentional accent tints from tinted neutrals. The snapshot provides hex color values but the checker would need a list of all neutral elements, which cannot be reliably inferred from tag/role alone."
  },
  {
    id: "AG-015",
    reason:
      "Asserting that 'blocked state is visually dominant' requires judgment about visual prominence (z-index stacking, rendered size relative to viewport, ARIA live regions). These cannot be assessed from the flat snapshot element list without layout geometry that goes beyond the current RenderedElement contract."
  }
];

// Note on AG-013: a deterministic partial check (hex palette membership) IS
// implemented in checkAG013(). The unmechanizable part — verifying that the
// correct TOKEN NAME (e.g. --accent vs --status-pending) is used for a given
// hex value — requires a design-system token map injected at check time and
// is not handled here. AG-013 is in CHECKED_RULE_IDS because a real check runs.

// ---------------------------------------------------------------------------
// S1 density assertions (AG-016, AG-017, AG-018) — added dashQuality S1
// ---------------------------------------------------------------------------

/**
 * AG-016 — Pill-tab navigation detection (hard_fail).
 *
 * Checks: any element with role="tab" that has borderRadiusPx > 2 (the
 * --radius-sm cap for tab elements). Pill-shaped tabs are a consumer/marketing
 * UI pattern; developer dashboards must use underline-only active indicators.
 *
 * Cap: 2px (--radius-sm). Anything above this on a role=tab element is a pill.
 */
function checkAG016(elements: readonly RenderedElement[]): Violation[] {
  const TAB_RADIUS_CAP_PX = 2; // --radius-sm: tab element cap
  const violations: Violation[] = [];
  for (const el of elements) {
    if (el.role !== "tab") continue;
    const r = el.computed.borderRadiusPx;
    if (r !== undefined && r > TAB_RADIUS_CAP_PX) {
      violations.push({
        agId: "AG-016",
        severity: "hard_fail",
        selector: el.selector,
        measured: `borderRadius=${r}px on role="tab"`,
        cap: `≤${TAB_RADIUS_CAP_PX}px (--radius-sm; underline-only active state required, no pill tabs)`,
        message: `AG-016: Pill-tab pattern detected — role="tab" element "${cap(el.selector)}" has border-radius ${r}px, exceeding the ${TAB_RADIUS_CAP_PX}px cap. Tab navigation must use underline-only active state (2px --accent border-bottom).`
      });
    }
  }
  return violations;
}

/**
 * AG-017 — Task-row height-density assertion (warning).
 *
 * Checks: any element with role="row" or role="listitem" that has
 * heightPx > 48. At standard density, task/queue list rows must be ≤48px.
 * Taller rows signal consumer-UI padding rather than information density.
 *
 * Severity is "warning" (not hard_fail) because a slightly taller row could
 * be intentional at a non-standard density level; the checker flags it for
 * human review rather than blocking automatically.
 *
 * Requires heightPx in ComputedStyleSubset — elements without heightPx are
 * silently skipped (cannot assert what we cannot measure).
 */
function checkAG017(elements: readonly RenderedElement[]): Violation[] {
  const ROW_HEIGHT_CAP_PX = 48;
  const violations: Violation[] = [];
  for (const el of elements) {
    if (el.role !== "row" && el.role !== "listitem") continue;
    const h = el.computed.heightPx;
    if (h !== undefined && h > ROW_HEIGHT_CAP_PX) {
      violations.push({
        agId: "AG-017",
        severity: "warning",
        selector: el.selector,
        measured: `heightPx=${h}px on role="${el.role}"`,
        cap: `≤${ROW_HEIGHT_CAP_PX}px (standard density cap for task/list rows)`,
        message: `AG-017: Task row exceeds density cap — <${el.tag}> "${cap(el.selector)}" has height ${h}px > ${ROW_HEIGHT_CAP_PX}px. Dense list rows must be ≤48px at standard density.`
      });
    }
  }
  return violations;
}

/**
 * AG-018 — Empty-state icon pattern detection (hard_fail).
 *
 * Checks: any container element with EXACTLY 2 direct children where:
 *   (a) one child is an SVG/icon-like element (tag=svg|img, role=img|presentation)
 *   (b) one child is a short paragraph (tag=p|span, textLength ≤ 80 chars)
 *
 * This matches the canonical "illustration above label" empty-state pattern
 * (e.g. large SVG above "No tasks yet") that belongs on consumer UIs, not
 * developer dashboards. Developer empty states must use plain monospace text.
 *
 * Why exactly-2 children: looser matching (≤3 children) risks false-positives
 * on real icon+label pairs in header rows. The 2-child constraint is the
 * tightest falsifiable assertion that covers the forbidden pattern.
 */
function checkAG018(elements: readonly RenderedElement[]): Violation[] {
  const violations: Violation[] = [];
  for (const el of elements) {
    const children = directChildren(elements, el.selector);
    // Must have exactly 2 direct children — no more, no less
    if (children.length !== 2) continue;

    const hasIconChild = children.some(
      (c) =>
        c.tag === "svg" ||
        c.tag === "img" ||
        c.role === "img" ||
        c.role === "presentation"
    );
    if (!hasIconChild) continue;

    const hasShortParagraph = children.some(
      (c) =>
        (c.tag === "p" || c.tag === "span") &&
        c.textLength > 0 &&
        c.textLength <= 80
    );
    if (!hasShortParagraph) continue;

    violations.push({
      agId: "AG-018",
      severity: "hard_fail",
      selector: el.selector,
      measured: `2 children: icon + short-paragraph (textLength=${el.textLength})`,
      cap: "0 — icon-above-text empty states are generic consumer UI patterns; use plain mono text only",
      message: `AG-018: Empty-state icon pattern on <${el.tag}> "${cap(el.selector)}": SVG/icon directly above a short paragraph is the sole content. Use plain monospace text ("no tasks recorded yet") instead of decorative illustration.`
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all mechanically-checkable anti-generic rules against a RenderedSnapshot.
 *
 * IMPORTANT: this function does NOT re-parse or re-validate the input snapshot.
 * Callers must validate the snapshot against RenderedSnapshotSchema before passing
 * it here. Passing an invalid snapshot produces undefined behavior.
 *
 * Returns an AntiGenericReport with:
 *   - violations: every detected violation with its AG-NNN id and measured-vs-cap
 *   - uncheckedRules: AG-NNN ids not (fully) checkable at this tier
 *   - blocking: true iff any violation is "hard_fail"
 *
 * This function is pure and synchronous — safe to call from any context.
 */
export function runAntiGenericChecker(snapshot: RenderedSnapshot): AntiGenericReport {
  const { elements } = snapshot;
  const violations: Violation[] = [
    ...checkAG001(elements),
    ...checkAG003(elements),
    ...checkAG004(elements),
    ...checkAG005(elements),
    ...checkAG006(elements),
    ...checkAG007(elements),
    ...checkAG009(elements),
    ...checkAG010(elements),
    ...checkAG011(elements),
    ...checkAG012(elements),
    ...checkAG013(elements),
    ...checkAG014(elements),
    ...checkAG016(elements),
    ...checkAG017(elements),
    ...checkAG018(elements)
  ];
  return {
    violations,
    uncheckedRules: UNCHECKED_RULES.map((r) => r.id),
    blocking: violations.some((v) => v.severity === "hard_fail")
  };
}

/**
 * AG-NNN ids that are not (fully) mechanically checkable at this tier.
 * Exported for test assertions (the set must not silently grow or shrink).
 * Note: AG-013 partial hex-palette check IS implemented; only the token-name
 * identity layer remains unchecked.
 */
export const UNCHECKED_RULE_IDS: ReadonlyArray<string> = UNCHECKED_RULES.map((r) => r.id);

/**
 * AG-NNN ids for which this module runs deterministic checks.
 * Exported for test assertions (coverage must not silently regress).
 * AG-013 appears here because checkAG013 is deterministic (palette membership).
 */
export const CHECKED_RULE_IDS: ReadonlyArray<string> = [
  "AG-001",
  "AG-003",
  "AG-004",
  "AG-005",
  "AG-006",
  "AG-007",
  "AG-009",
  "AG-010",
  "AG-011",
  "AG-012",
  "AG-013",
  "AG-014",
  "AG-016",
  "AG-017",
  "AG-018"
];
