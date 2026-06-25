/**
 * @module forge/repair-plan
 *
 * RepairPlan builder for Archon Frontend Forge (Phase 3, P3-CritiqueRepair).
 *
 * Council condition #3 (non-waivable): every repair item must cite a CONCRETE,
 * machine-readable diff (agId + measured + cap + instruction) — never a vague
 * "improve" directive. Instruction strings are derived deterministically from
 * the violation's measured/cap fields using a per-AG template table.
 *
 * Design constraints:
 *   - Zero archon-service dependencies (pure module)
 *   - Only `zod` + existing forge types
 *   - No `any`; all unknowns narrowed explicitly
 *   - Pure + deterministic: same input => same output
 *   - Stable ordering: by agId then selector
 */

import { z } from "zod";
import type { Violation, AntiGenericReport } from "./anti-generic-types.ts";
import type { AssetQAReport } from "./asset-qa.ts";

// ---------------------------------------------------------------------------
// String length caps (prevent unbounded message bloat)
// ---------------------------------------------------------------------------

const MAX_INSTRUCTION_LEN = 512;
const MAX_SELECTOR_LEN = 512;
const MAX_MEASURED_LEN = 128;
const MAX_CAP_LEN = 128;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const RepairPlanItemSchema = z.object({
  /**
   * The AG-NNN rule id or QA-NNN asset-QA finding id that this item addresses.
   * Format: AG-NNN or QA-NNN.
   */
  ruleId: z.string().min(1).max(16),

  /** Severity mirroring the source violation. */
  severity: z.enum(["hard_fail", "warning"]),

  /**
   * CSS selector of the violating element (from RenderedElement.selector).
   * Omitted for page-level violations.
   */
  selector: z.string().max(MAX_SELECTOR_LEN).optional(),

  /**
   * What was measured (e.g. "borderRadius=12px").
   * Carries forward from the violation for machine-readable diffing.
   */
  measured: z.string().max(MAX_MEASURED_LEN).optional(),

  /**
   * The cap or threshold that was violated (e.g. "≤8px").
   * Carries forward from the violation for machine-readable diffing.
   */
  cap: z.string().max(MAX_CAP_LEN).optional(),

  /**
   * Concrete, actionable repair instruction derived from the diff.
   * Council #3: MUST cite agId + measured + cap when available.
   * NEVER a vague "improve".
   * Capped at MAX_INSTRUCTION_LEN characters.
   */
  instruction: z.string().min(1).max(MAX_INSTRUCTION_LEN)
});

export type RepairPlanItem = z.infer<typeof RepairPlanItemSchema>;

export const RepairPlanSchema = z.object({
  /**
   * All repair items, one per violation.
   * Order: by ruleId (lexicographic) then by selector (lexicographic).
   */
  items: z.array(RepairPlanItemSchema),

  /**
   * True iff any item has severity === "hard_fail".
   * Mirrors the blocking flag from the source anti-generic report.
   */
  blocking: z.boolean(),

  /** Total item count (convenience field). */
  count: z.number().int().nonnegative()
});

export type RepairPlan = z.infer<typeof RepairPlanSchema>;

// ---------------------------------------------------------------------------
// Per-AG instruction template table
//
// Each template is a function that takes the violation and returns a concrete
// instruction string. For AGs with numeric measured/cap values the template
// interpolates them explicitly. For AGs without a bespoke template the
// fallback produces a measured/cap-citing instruction (still concrete, not vague).
// ---------------------------------------------------------------------------

type InstructionFn = (v: ViolationLike) => string;

interface ViolationLike {
  measured?: string | undefined;
  cap?: string | undefined;
  selector?: string | undefined;
}

/**
 * Truncate a string to a given max length, appending "…" when cut.
 */
function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Safely format a violation field for inclusion in an instruction string.
 * Returns an empty fallback string if the field is missing.
 */
function fmt(field: string | undefined, fallback: string): string {
  return field !== undefined && field.length > 0 ? field : fallback;
}

const AG_INSTRUCTION_TEMPLATES: Readonly<Record<string, InstructionFn>> = {
  "AG-001": (v) =>
    `Remove gradient fill (${fmt(v.measured, "gradient detected")}) from the element's ` +
    `background. Use a flat token from the surface ramp (--surface-raised, --surface-elevated, ` +
    `or --surface-overlay). Cap: ${fmt(v.cap, "no gradient fills on UI surfaces")}.`,

  "AG-002": (v) =>
    `Remove the second accent color (${fmt(v.measured, "extra accent detected")}). ` +
    `Retain only the primary indigo accent #6366F1. Cap: ${fmt(v.cap, "single accent only")}.`,

  "AG-003": (v) =>
    `Reduce borderRadius from ${fmt(v.measured, "current value")} to within ` +
    `${fmt(v.cap, "≤8px")} on this element. ` +
    `Use --radius-md (4px) for cards/panels or --radius-lg (6px) for modals/dropdowns.`,

  "AG-004": (v) =>
    `Remove box-shadow (${fmt(v.measured, "shadow detected")}) from this element. ` +
    `Replace elevation with a luminance step: upgrade background to --surface-raised or ` +
    `--surface-elevated. Cap: ${fmt(v.cap, "no box-shadow on dark surfaces")}.`,

  "AG-005": (v) =>
    `Change text color from ${fmt(v.measured, "pure #FFFFFF")} to --text-primary (#EDEDED). ` +
    `Cap: ${fmt(v.cap, "use --text-primary, not pure #FFFFFF")}.`,

  "AG-006": (v) =>
    `Change canvas background from ${fmt(v.measured, "pure #000000")} to --surface-base (#0A0A0A). ` +
    `Cap: ${fmt(v.cap, "use --surface-base, not pure #000000")}.`,

  "AG-007": (v) =>
    `Replace font-family ${fmt(v.measured, "system font stack")} with Geist Sans for body/UI text ` +
    `or Geist Mono for code/metadata. Remove system-ui / -apple-system stack entirely. ` +
    `Cap: ${fmt(v.cap, "Geist Sans + Geist Mono only; Inter is the sole permitted fallback")}.`,

  "AG-008": (v) =>
    `Correct neutral gray tint: ${fmt(v.measured, "tinted neutral detected")} must be replaced ` +
    `with a pure neutral from the surface/text ramp. Cap: ${fmt(v.cap, "no warm/cool tint in neutral grays")}.`,

  "AG-009": (v) =>
    `Align spacing value ${fmt(v.measured, "off-grid value")} to the nearest multiple of 4px ` +
    `(4, 8, 12, 16, 24, 32, 48, 64, 96, 128). ` +
    `Cap: ${fmt(v.cap, "multiples of 4px only")}.`,

  "AG-010": (v) =>
    `Reduce animation duration from ${fmt(v.measured, "current value")} to ` +
    `${fmt(v.cap, "≤200ms")}. ` +
    `Use enter easing cubic-bezier(0.16,1,0.3,1) for enter or cubic-bezier(0.4,0,1,1) for exit.`,

  "AG-011": (v) =>
    `Remove decorative backdrop-filter (${fmt(v.measured, "blur detected")}) from this element. ` +
    `backdrop-filter:blur is only permitted on genuine floating overlays (modal/tooltip/popover). ` +
    `Cap: ${fmt(v.cap, "overlays only")}.`,

  "AG-012": (v) =>
    `Refactor the equal-width card grid (${fmt(v.measured, "3+ equal feature cards detected")}) ` +
    `into a data-focused layout: use a list panel, a data table, or a structured hierarchy. ` +
    `Generic icon+title+body card grids are forbidden in developer dashboards. ` +
    `Cap: ${fmt(v.cap, "0 — generic feature-card grids forbidden")}.`,

  "AG-013": (v) =>
    `Replace ad-hoc color value ${fmt(v.measured, "off-palette color detected")} ` +
    `with the appropriate token reference from the manifest palette. ` +
    `Cap: ${fmt(v.cap, "all colors must be manifest token references")}.`,

  "AG-014": (v) =>
    `Remove the marketing-page pattern (${fmt(v.measured, "hero + equal-card-row + CTA detected")}). ` +
    `Replace hero/feature-grid/CTA sections with information-serving or action-serving elements: ` +
    `tables, panels, status indicators. Cap: ${fmt(v.cap, "0 marketing patterns in developer dashboards")}.`,

  "AG-015": (v) =>
    `Increase visual prominence of the blocked-state indicator (${fmt(v.measured, "blocked indicator detected")}). ` +
    `Blocked runs must be the most visually dominant element: use a full-width banner, ` +
    `high-contrast color, or modal interruption. Cap: ${fmt(v.cap, "blocked state must be visually dominant")}.`
};

/**
 * Fallback instruction for AGs without a bespoke template.
 * Still concrete: always cites measured and cap.
 */
function fallbackInstruction(ruleId: string, v: ViolationLike): string {
  const measuredPart = v.measured !== undefined ? ` Measured: ${v.measured}.` : "";
  const capPart = v.cap !== undefined ? ` Required: ${v.cap}.` : "";
  return `${ruleId}: Fix the violation flagged on this element.${measuredPart}${capPart} ` +
    `Consult the constraints manifest for the exact rule.`;
}

/**
 * Build a concrete repair instruction for a given rule id + violation context.
 */
function buildInstruction(ruleId: string, v: ViolationLike): string {
  const templateFn = AG_INSTRUCTION_TEMPLATES[ruleId];
  const raw = templateFn !== undefined
    ? templateFn(v)
    : fallbackInstruction(ruleId, v);
  return trunc(raw, MAX_INSTRUCTION_LEN);
}

// ---------------------------------------------------------------------------
// Sort key helpers
// ---------------------------------------------------------------------------

/**
 * Stable sort key: ruleId (lexicographic) then selector (lexicographic, empty last).
 */
function sortKey(item: RepairPlanItem): string {
  return `${item.ruleId}|||${item.selector ?? ""}`;
}

// ---------------------------------------------------------------------------
// Anti-generic violation → RepairPlanItem
// ---------------------------------------------------------------------------

function violationToItem(v: Violation): RepairPlanItem {
  const instruction = buildInstruction(v.agId, {
    measured: v.measured,
    cap: v.cap,
    selector: v.selector
  });
  return {
    ruleId: v.agId,
    severity: v.severity,
    selector: v.selector,
    measured: v.measured !== undefined ? trunc(v.measured, MAX_MEASURED_LEN) : undefined,
    cap: v.cap !== undefined ? trunc(v.cap, MAX_CAP_LEN) : undefined,
    instruction
  };
}

// ---------------------------------------------------------------------------
// Asset-QA finding → RepairPlanItem
// ---------------------------------------------------------------------------

function qaFindingToItem(f: AssetQAReport["findings"][number], assetPath: string): RepairPlanItem | null {
  // Only convert "fail" findings; pass/warn/unchecked are not actionable repair items.
  if (f.severity !== "fail") return null;
  const instruction = buildInstruction(f.id, {
    measured: f.measured,
    cap: f.expected
  });
  return {
    ruleId: f.id,
    severity: "hard_fail", // all QA fails are blocking
    selector: assetPath,   // use the asset path as the "selector" for traceability
    measured: f.measured !== undefined ? trunc(f.measured, MAX_MEASURED_LEN) : undefined,
    cap: f.expected !== undefined ? trunc(f.expected, MAX_CAP_LEN) : undefined,
    instruction
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a deterministic RepairPlan from one AntiGenericReport plus optional
 * AssetQAReports.
 *
 * Items are 1:1 from anti-generic violations + asset-QA fail findings.
 * Order: by ruleId (lexicographic) then selector (lexicographic).
 * Blocking mirrors the anti-generic report's blocking flag OR any QA fail.
 *
 * This function is pure and synchronous — same input => same output.
 */
export function buildRepairPlan(
  antiGeneric: AntiGenericReport,
  assetQa?: readonly AssetQAReport[]
): RepairPlan {
  const items: RepairPlanItem[] = [];

  // Map anti-generic violations 1:1 to repair items.
  for (const v of antiGeneric.violations) {
    items.push(violationToItem(v));
  }

  // Map asset-QA fail findings 1:1 to repair items.
  if (assetQa !== undefined) {
    for (const report of assetQa) {
      for (const f of report.findings) {
        const item = qaFindingToItem(f, report.assetPath);
        if (item !== null) items.push(item);
      }
    }
  }

  // Stable deterministic sort: ruleId then selector.
  const sorted = [...items].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const blocking =
    antiGeneric.blocking ||
    (assetQa !== undefined && assetQa.some((r) => !r.pass));

  return {
    items: sorted,
    blocking,
    count: sorted.length
  };
}
