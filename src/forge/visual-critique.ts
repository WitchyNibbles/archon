/**
 * @module forge/visual-critique
 *
 * VisualCritique aggregator for Archon Frontend Forge (Phase 3, P3-CritiqueRepair).
 *
 * Council condition #1 (non-waivable): This module can return `decision: "rework"`
 * for output that is "technically correct but GENERIC" — not just for a11y or
 * layout defects. The AG-012 three-card soup triggers rework deterministically.
 *
 * Design constraints:
 *   - Composes existing forge modules (import only; does NOT modify them)
 *   - Scores are DETERMINISTICALLY derived from violation counts — NOT model opinion
 *   - Pure + deterministic: same input => same output
 *   - Zero archon-service dependencies
 *   - No `any`; all unknowns narrowed explicitly
 */

import { z } from "zod";
import type { AntiGenericReport } from "./anti-generic-types.ts";
import type { AssetQAReport } from "./asset-qa.ts";
import { buildRepairPlan, RepairPlanSchema } from "./repair-plan.ts";

// ---------------------------------------------------------------------------
// String caps
// ---------------------------------------------------------------------------

const MAX_ISSUE_MSG_LEN = 512;
const MAX_ITEMS = 200;

// ---------------------------------------------------------------------------
// Scores schema
//
// A fixed, small set of integer scores derived DETERMINISTICALLY from the inputs:
//   - originality:    5 − (hard_fail violation count), floored at 0
//   - accessibility:  1-5 scale based on any AG-005/AG-006 or WCAG-adjacent violations
//   - asset_quality:  5 if all assetQa pass, or number of passing QA reports as integer
//
// These are NOT model opinions — they are mechanical summaries of the violation data.
// ---------------------------------------------------------------------------

export const ScoresSchema = z.object({
  /**
   * Originality score 1–5.
   * 5 = no hard_fail violations; decreases by 1 for each hard_fail, floored at 1.
   */
  originality: z.number().int().min(1).max(5),

  /**
   * Accessibility score 1–5.
   * 5 = no text/color violations (AG-005, AG-006, AG-013); decreases by 1 per
   * accessibility-relevant hard_fail, floored at 1.
   */
  accessibility: z.number().int().min(1).max(5),

  /**
   * Asset quality score 0–5.
   * 5 = no asset QA reports provided or all pass.
   * Count of failing reports subtracted from 5, floored at 0.
   */
  asset_quality: z.number().int().min(0).max(5)
});

export type Scores = z.infer<typeof ScoresSchema>;

// ---------------------------------------------------------------------------
// VisualCritique schema
// ---------------------------------------------------------------------------

export const VisualCritiqueSchema = z.object({
  /**
   * Deterministic scores derived from violation counts (NOT model opinion).
   */
  scores: ScoresSchema,

  /**
   * Messages from hard_fail violations (blocking issues).
   * Each capped to MAX_ISSUE_MSG_LEN.
   */
  blockingIssues: z.array(z.string().max(MAX_ISSUE_MSG_LEN)).max(MAX_ITEMS),

  /**
   * Messages from warning-severity violations (non-blocking).
   */
  nonBlockingIssues: z.array(z.string().max(MAX_ISSUE_MSG_LEN)).max(MAX_ITEMS),

  /**
   * Hard_fail violation messages from anti-generic rules (the "AI smell" signal).
   * Council #1: these are the falsifiable generic-detection violations.
   */
  genericAiSmell: z.array(z.string().max(MAX_ISSUE_MSG_LEN)).max(MAX_ITEMS),

  /**
   * The full repair plan, embedded in the critique.
   * Dependency: repair-plan.ts → visual-critique.ts (one-directional).
   */
  repairPlan: RepairPlanSchema,

  /**
   * Critique decision.
   * "rework" iff anti-generic.blocking === true OR any assetQa[].pass === false.
   * "pass" when all checks pass.
   */
  decision: z.enum(["pass", "rework"]),

  /**
   * True when the decision is ambiguous or when non-mechanical checks are present
   * (e.g. unchecked QA findings). The S5 pipeline may use this to pause for
   * human/operator review. Currently: true when uncheckedCoverage is non-empty.
   */
  askUser: z.boolean(),

  /**
   * Anti-generic uncheckedRules surfaced here so advisory gaps are NEVER hidden.
   * Council requirement: unchecked rules must always be visible to the caller.
   */
  uncheckedCoverage: z.array(z.string()).max(MAX_ITEMS)
});

export type VisualCritique = z.infer<typeof VisualCritiqueSchema>;

// ---------------------------------------------------------------------------
// AG ids relevant to accessibility scoring
// ---------------------------------------------------------------------------

const ACCESSIBILITY_AG_IDS = new Set(["AG-005", "AG-006", "AG-013"]);

// ---------------------------------------------------------------------------
// Score derivation (deterministic)
// ---------------------------------------------------------------------------

function deriveScores(
  antiGeneric: AntiGenericReport,
  assetQa: readonly AssetQAReport[] | undefined
): Scores {
  const hardFailCount = antiGeneric.violations.filter(
    (v) => v.severity === "hard_fail"
  ).length;

  // Originality: 5 minus hard_fail count, floored at 1.
  const originality = Math.max(1, 5 - hardFailCount) as 1 | 2 | 3 | 4 | 5;

  // Accessibility: 5 minus count of accessibility-relevant hard_fails, floored at 1.
  const accessibilityViolations = antiGeneric.violations.filter(
    (v) => v.severity === "hard_fail" && ACCESSIBILITY_AG_IDS.has(v.agId)
  ).length;
  const accessibility = Math.max(1, 5 - accessibilityViolations) as 1 | 2 | 3 | 4 | 5;

  // Asset quality: 5 minus count of failing QA reports, floored at 0.
  const failingQaCount = assetQa !== undefined
    ? assetQa.filter((r) => !r.pass).length
    : 0;
  const asset_quality = Math.max(0, 5 - failingQaCount) as 0 | 1 | 2 | 3 | 4 | 5;

  return { originality, accessibility, asset_quality };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildVisualCritiqueInputs {
  antiGeneric: AntiGenericReport;
  assetQa?: readonly AssetQAReport[] | undefined;
}

/**
 * Build a deterministic VisualCritique from anti-generic checker output and
 * optional asset QA reports.
 *
 * Council #1: `decision` will be "rework" for a blocking anti-generic report
 * (e.g. the 3-card AG-012 soup) OR for any failing asset-QA result.
 * This is the falsifiable gate — generic-but-otherwise-valid output triggers rework.
 *
 * Council #3: The embedded repairPlan provides machine-readable repair items
 * citing agId + measured + cap + concrete instruction.
 *
 * This function is pure and synchronous — same input => same output.
 *
 * @param inputs - AntiGenericReport (required) + optional array of AssetQAReports.
 * @returns A parsed-and-validated VisualCritique.
 */
export function buildVisualCritique(inputs: BuildVisualCritiqueInputs): VisualCritique {
  const { antiGeneric, assetQa } = inputs;

  const scores = deriveScores(antiGeneric, assetQa);

  // Separate violations by severity.
  const hardFails = antiGeneric.violations.filter((v) => v.severity === "hard_fail");
  const warnings = antiGeneric.violations.filter((v) => v.severity === "warning");

  // blockingIssues: hard_fail violation messages.
  const blockingIssues = hardFails.map((v) =>
    v.message.slice(0, MAX_ISSUE_MSG_LEN)
  );

  // nonBlockingIssues: warning violation messages + asset-QA warn findings.
  const nonBlockingIssues: string[] = warnings.map((v) =>
    v.message.slice(0, MAX_ISSUE_MSG_LEN)
  );
  if (assetQa !== undefined) {
    for (const report of assetQa) {
      for (const f of report.findings) {
        if (f.severity === "warn" && !f.unchecked) {
          nonBlockingIssues.push(f.message.slice(0, MAX_ISSUE_MSG_LEN));
        }
      }
    }
  }

  // genericAiSmell: hard_fail violation messages from anti-generic rules.
  // These are the "AI generic smell" signals (council #1).
  const genericAiSmell = hardFails.map((v) => v.message.slice(0, MAX_ISSUE_MSG_LEN));

  // Build the repair plan (one-directional dependency: repair-plan feeds in).
  const repairPlan = buildRepairPlan(antiGeneric, assetQa);

  // Decision: rework iff any hard_fail OR any failing asset-QA.
  const qaFailing =
    assetQa !== undefined && assetQa.some((r) => !r.pass);
  const decision: "pass" | "rework" =
    antiGeneric.blocking || qaFailing ? "rework" : "pass";

  // askUser: true when unchecked coverage is non-empty (advisory gaps present).
  const uncheckedCoverage = [...antiGeneric.uncheckedRules];
  const askUser = uncheckedCoverage.length > 0;

  const raw = {
    scores,
    blockingIssues,
    nonBlockingIssues,
    genericAiSmell,
    repairPlan,
    decision,
    askUser,
    uncheckedCoverage
  };

  // Strict Zod parse — throws on schema violations (never silently accepts bad data).
  return VisualCritiqueSchema.parse(raw);
}
