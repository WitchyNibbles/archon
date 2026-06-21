// Mistake Pattern Ledger — P1 + P1.5: capture + layered fingerprint + occurrence store + baseline metric.
//
// Pure, store-agnostic module (mirrors autonomous-execution.ts style).
// No durable promotion, no anti_pattern memory type, no context injection — those are P2+.
//
// P1 fingerprint = SHA-256(category + ":" + ruleLocus)
// P1.5 fingerprint = SHA-256(category + ":" + ruleLocus + ":" + symbolLocus) when symbolLocus is present.
// symbolLocus is derived from ReviewFinding.symbol (preferred) or ReviewFinding.file when
// structured findingDetails are supplied on the ReviewRecord. Free-text findings (no details)
// continue to use the P1 coarse fingerprint.
//
// Node built-in crypto only — no external deps.

import { createHash, randomUUID } from "node:crypto";
import type { ReviewRecord, ReviewFinding, ReviewSeverity, GateReviewRole } from "../domain/types.ts";

// ---------------------------------------------------------------------------
// MistakeCategory enum
// ---------------------------------------------------------------------------

export const mistakeCategories = [
  "immutability_violation",
  "nodenext_extension_missing",
  "sql_injection",
  "unhandled_error",
  "missing_input_validation",
  "test_expectation_drift",
  "uncategorized"
] as const;

export type MistakeCategory = (typeof mistakeCategories)[number];

// ---------------------------------------------------------------------------
// MistakeOccurrenceRecord
// ---------------------------------------------------------------------------

export interface MistakeOccurrenceRecord {
  /** UUID generated at capture time. */
  readonly id: string;
  /**
   * P1:   SHA-256 hex of `category + ":" + ruleLocus`     (no symbolLocus)
   * P1.5: SHA-256 hex of `category + ":" + ruleLocus + ":" + symbolLocus` when present.
   * Stable identifier across runs.
   */
  readonly fingerprint: string;
  readonly category: MistakeCategory;
  /** Policy anchor — e.g. "coding-style#immutability". Never changes for a category. */
  readonly ruleLocus: string;
  /**
   * Symbol or file locus — populated from ReviewFinding.symbol (preferred) or
   * ReviewFinding.file when structured findingDetails are present.
   * undefined when using P1 free-text path.
   */
  readonly symbolLocus: string | undefined;
  /** File path hint — metadata only, never in the fingerprint hash. */
  readonly pathLocus: string | undefined;
  /** Original finding string verbatim. */
  readonly rawFinding: string;
  readonly severity: ReviewSeverity;
  readonly reviewerRole: GateReviewRole;
  readonly runId: string;
  readonly taskId: string;
  readonly capturedAt: string;
}

// ---------------------------------------------------------------------------
// MistakeMetrics
// ---------------------------------------------------------------------------

export interface MistakeMetrics {
  readonly runId: string;
  /** Count of distinct fingerprints observed (unique mistake types). */
  readonly totalFingerprints: number;
  /** Fingerprints that appeared in ≥ 2 distinct runs. */
  readonly recurrentFingerprints: number;
  /** Total occurrence records (raw count). */
  readonly totalOccurrences: number;
  /**
   * Primary P1 baseline metric: proportion of occurrences that belong to
   * recurrent fingerprints. Trends down as archon learns. Range [0, 1].
   * Formula: occurrences_matching_recurrent_fingerprint / total_occurrences
   */
  readonly mistakeRepeatRate: number;
}

export interface MistakeMetricsStoreLike {
  /**
   * Return all occurrence records for the project, across all runs.
   * Cross-run data is required to compute the recurrence signal.
   * The key is projectId (not runId) — aligned with MistakeLedgerStoreLike in store/types.ts.
   * Callers must pass the same projectId used when appending occurrences.
   */
  listMistakeOccurrences(projectId: string): Promise<readonly MistakeOccurrenceRecord[]>;
}

// ---------------------------------------------------------------------------
// Classifier — keyword / regex → MistakeCategory
// ---------------------------------------------------------------------------

interface ClassifierRule {
  readonly category: Exclude<MistakeCategory, "uncategorized">;
  readonly patterns: readonly RegExp[];
}

const CLASSIFIER_RULES: readonly ClassifierRule[] = [
  {
    category: "immutability_violation",
    patterns: [
      /\bmutate[sd]?\b/i,
      /\bmutation\b/i,
      /\bin[- ]?place\b/i,
      /\bdirect(?:ly)?\s+modif/i,
      /\bmodified?\s+(?:in[- ]?place|existing|state)\b/i,
      /\bassigned?\s+directly/i
    ]
  },
  {
    category: "nodenext_extension_missing",
    patterns: [
      /\.ts\s+extension\b/i,
      /\bextension\s+(?:on|in)\s+import\b/i,
      /\bimport\s+(?:without|lacks?|missing)\b/i,
      /\bmissing\s+(?:the\s+)?\.ts\b/i,
      /\bnodenext\s+import/i,
      /relative\s+import\s+lacks?\b/i
    ]
  },
  {
    category: "sql_injection",
    patterns: [
      /\bsql\s+injection\b/i,
      /\bunparameterized\b/i,
      /\bstring\s+(?:interpolation|concat(?:enation)?)\s+in\s+(?:a\s+)?query\b/i,
      /\braw\s+sql\b/i,
      /\bquery\s+(?:uses?\s+)?(?:string|variable)/i,
      /\bparameteriz(?:ed|ation)\b.*\bquery\b/i,
      /\bquery\b.*\bparameteriz(?:ed|ation)\b/i
    ]
  },
  {
    category: "unhandled_error",
    patterns: [
      /\bsilently\s+swallowed?\b/i,
      /\bunhandled\b/i,
      /\bcatch\s+block\s+(?:ignores?|swallows?)\b/i,
      /\bmissing\s+error\s+handling\b/i,
      /\berror\s+(?:is\s+)?ignored\b/i,
      /\bpromise\s+rejection\b/i
    ]
  },
  {
    category: "missing_input_validation",
    patterns: [
      /\binput\s+(?:not\s+)?validat/i,
      /\bmissing\s+validation\b/i,
      /\bwithout\s+(?:a\s+)?(?:schema\s+)?(?:check|validation)\b/i,
      /\bno\s+input\s+validation\b/i,
      /\bexternal\s+input\b.*\bvalidat/i,
      /\bvalidat\b.*\bboundary\b/i,
      /\buser\s+input\s+passed\s+directly\b/i
    ]
  },
  {
    category: "test_expectation_drift",
    patterns: [
      /\btest\s+expectation\b/i,
      /\bsnapshot\s+updated?\b/i,
      /\bassertion\s+updated?\b/i,
      /\bexpectation\s+does\s+not\s+match\b/i,
      /\bexpected\s+output\s+changed\b/i
    ]
  }
];

/**
 * Deterministic keyword/regex classifier — maps a free-text finding string to a
 * fixed MistakeCategory. Falls back to "uncategorized" when no rule matches.
 *
 * Step-0 decision: symbolLocus is NOT derivable from current corpus; classifier
 * runs on plain prose. "uncategorized" fallback is expected for ≥50% of findings
 * in the current corpus (all-positive "code looks good" type findings), which is
 * why extractMistakeOccurrences only records classified findings.
 */
export function classifyFinding(finding: string): MistakeCategory {
  for (const rule of CLASSIFIER_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(finding)) {
        return rule.category;
      }
    }
  }
  return "uncategorized";
}

// ---------------------------------------------------------------------------
// deriveRuleLocus — stable policy anchor per category
// ---------------------------------------------------------------------------

const RULE_LOCUS_MAP: Readonly<Record<MistakeCategory, string>> = {
  immutability_violation: "coding-style#immutability",
  nodenext_extension_missing: "typescript.md#module-system",
  sql_injection: "security#sql-injection-prevention",
  unhandled_error: "coding-style#error-handling",
  missing_input_validation: "coding-style#input-validation",
  test_expectation_drift: "testing#test-driven-development",
  uncategorized: "uncategorized#unknown"
};

/**
 * Returns the canonical policy anchor for a category. Fully move-invariant —
 * the locus references the *rule*, not a file path.
 */
export function deriveRuleLocus(category: MistakeCategory): string {
  return RULE_LOCUS_MAP[category];
}

// ---------------------------------------------------------------------------
// computeFingerprint — SHA-256 hex of "category:ruleLocus"
// ---------------------------------------------------------------------------

/**
 * Deterministic fingerprint for a mistake pattern.
 *
 * P1   fingerprint = SHA-256(category + ":" + ruleLocus)
 * P1.5 fingerprint = SHA-256(category + ":" + ruleLocus + ":" + symbolLocus) when symbolLocus present.
 *
 * pathLocus is excluded: metadata only, never in the hash.
 * symbolLocus increases cardinality: same category in different symbols → different fingerprints.
 */
export function computeFingerprint(
  category: MistakeCategory,
  ruleLocus: string,
  symbolLocus?: string | undefined
): string {
  const base = `${category}:${ruleLocus}`;
  const input = symbolLocus !== undefined ? `${base}:${symbolLocus}` : base;
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// extractMistakeOccurrences — derive occurrences from a ReviewRecord
// ---------------------------------------------------------------------------

/**
 * Derive symbolLocus from a ReviewFinding.
 *
 * Preference order: symbol > file > undefined.
 * The locus is used in the P1.5 fingerprint to increase cardinality.
 */
function deriveSymbolLocus(finding: ReviewFinding): string | undefined {
  if (finding.symbol !== undefined && finding.symbol.trim().length > 0) {
    return finding.symbol.trim();
  }
  if (finding.file !== undefined && finding.file.trim().length > 0) {
    return finding.file.trim();
  }
  return undefined;
}

/**
 * Capture hook: given a persisted ReviewRecord, derive zero or more
 * MistakeOccurrenceRecord entries.
 *
 * Two-path processing:
 *
 * (A) Structured path — when `review.findingDetails` is present:
 *     - `category` taken from `finding.category` (must be a known MistakeCategory; drop if absent or uncategorized).
 *     - `symbolLocus` derived from `finding.symbol` (preferred) or `finding.file`.
 *     - Fingerprint = SHA-256(category + ":" + ruleLocus [+ ":" + symbolLocus when present]).
 *
 * (B) Free-text path — when `review.findingDetails` is absent:
 *     - Classifier runs on each string in `review.findings` (P1 coarse path).
 *     - `symbolLocus` remains undefined; P1 coarse fingerprint used.
 *
 * Invariants:
 * - Only failed or issue-flagged reviews produce occurrences (state !== "passed").
 * - "uncategorized" findings (either explicit or classifier fallback) are dropped.
 * - Each occurrence is a new immutable record with a unique id.
 *
 * This function is PURE (no side effects). Callers are responsible for persisting
 * the returned records. Must never throw — caller wraps in try/catch.
 */
export function extractMistakeOccurrences(review: ReviewRecord): readonly MistakeOccurrenceRecord[] {
  // Passed reviews: we do not record "passing" findings as mistakes
  if (review.state === "passed") {
    return [];
  }

  const occurrences: MistakeOccurrenceRecord[] = [];

  if (review.findingDetails !== undefined && review.findingDetails.length > 0) {
    // --- Structured path (P1.5) ---
    for (const finding of review.findingDetails) {
      // Validate category is a known MistakeCategory (not a plain string for unknown things)
      const categoryRaw = finding.category;
      if (categoryRaw === undefined) {
        // No category — skip (cannot fingerprint without a category)
        continue;
      }

      // Type-narrow: cast to MistakeCategory only if the string is valid
      if (!(mistakeCategories as readonly string[]).includes(categoryRaw)) {
        // Unknown or uncategorized string — skip to avoid pollution
        continue;
      }
      const category = categoryRaw as MistakeCategory;

      if (category === "uncategorized") {
        // Explicit uncategorized — drop
        continue;
      }

      const ruleLocus = deriveRuleLocus(category);
      const symbolLocus = deriveSymbolLocus(finding);
      const fingerprint = computeFingerprint(category, ruleLocus, symbolLocus);

      occurrences.push({
        id: randomUUID(),
        fingerprint,
        category,
        ruleLocus,
        symbolLocus,
        pathLocus: finding.file,
        rawFinding: finding.message,
        severity: review.severity,
        reviewerRole: review.reviewerRole,
        runId: review.runId,
        taskId: review.taskId,
        capturedAt: review.createdAt
      });
    }
  } else {
    // --- Free-text path (P1 backward compat) ---
    for (const rawFinding of review.findings) {
      const category = classifyFinding(rawFinding);

      // Drop uncategorized — they would all share the same fingerprint and pollute
      // the metric with noise. The council can revisit in P2 once the classifier
      // has been validated against more data.
      if (category === "uncategorized") {
        continue;
      }

      const ruleLocus = deriveRuleLocus(category);
      const fingerprint = computeFingerprint(category, ruleLocus);

      occurrences.push({
        id: randomUUID(),
        fingerprint,
        category,
        ruleLocus,
        symbolLocus: undefined, // not derivable from free-text findings
        pathLocus: undefined, // not derivable from free-text findings; P2 concern
        rawFinding,
        severity: review.severity,
        reviewerRole: review.reviewerRole,
        runId: review.runId,
        taskId: review.taskId,
        capturedAt: review.createdAt
      });
    }
  }

  return occurrences;
}

// ---------------------------------------------------------------------------
// countRecurrences — recurrence counting across distinct runs
// ---------------------------------------------------------------------------

/**
 * Given a list of occurrence records and a fingerprint, count how many
 * DISTINCT run IDs contain an occurrence with that fingerprint.
 *
 * Distinct-run counting (not raw occurrence count) is the correct signal:
 * 5 occurrences in the same run = the same mistake in one run, not recurrence.
 */
export function countRecurrences(
  fingerprint: string,
  occurrences: readonly MistakeOccurrenceRecord[]
): number {
  const runs = new Set<string>();
  for (const occ of occurrences) {
    if (occ.fingerprint === fingerprint) {
      runs.add(occ.runId);
    }
  }
  return runs.size;
}

// ---------------------------------------------------------------------------
// collectMistakeMetrics — aggregate the baseline metric
// ---------------------------------------------------------------------------

/**
 * Compute the P1 baseline mistake metrics from the occurrence store.
 *
 * recurrentFingerprints = fingerprints seen in ≥ 2 distinct runs
 * mistakeRepeatRate     = occurrences_in_recurrent_fps / total_occurrences
 *
 * P4 will measure the delta vs this P1 baseline after injection (P3) is active.
 */
export async function collectMistakeMetrics(
  store: MistakeMetricsStoreLike,
  runId: string,
  projectId: string
): Promise<MistakeMetrics> {
  const allOccurrences = await store.listMistakeOccurrences(projectId);
  const totalOccurrences = allOccurrences.length;

  if (totalOccurrences === 0) {
    return {
      runId,
      totalFingerprints: 0,
      recurrentFingerprints: 0,
      totalOccurrences: 0,
      mistakeRepeatRate: 0
    };
  }

  // Group by fingerprint
  const fingerprintToRuns = new Map<string, Set<string>>();
  for (const occ of allOccurrences) {
    const runs = fingerprintToRuns.get(occ.fingerprint) ?? new Set<string>();
    runs.add(occ.runId);
    fingerprintToRuns.set(occ.fingerprint, runs);
  }

  const totalFingerprints = fingerprintToRuns.size;

  // Recurrent = fingerprint appears in ≥ 2 distinct runs
  const recurrentFps = new Set<string>();
  for (const [fp, runs] of fingerprintToRuns) {
    if (runs.size >= 2) {
      recurrentFps.add(fp);
    }
  }
  const recurrentFingerprints = recurrentFps.size;

  // Count occurrences that belong to recurrent fingerprints
  let recurrentOccurrenceCount = 0;
  for (const occ of allOccurrences) {
    if (recurrentFps.has(occ.fingerprint)) {
      recurrentOccurrenceCount += 1;
    }
  }

  const mistakeRepeatRate =
    totalOccurrences === 0 ? 0 : recurrentOccurrenceCount / totalOccurrences;

  return {
    runId,
    totalFingerprints,
    recurrentFingerprints,
    totalOccurrences,
    mistakeRepeatRate
  };
}

// ---------------------------------------------------------------------------
// formatMistakePrometheus — Prometheus exposition text
// ---------------------------------------------------------------------------

function sanitizeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Emit Prometheus exposition text for the mistake metrics.
 *
 * Counters:
 *   archon_mistake_repeat_rate              — primary P1 baseline (float 0..1)
 *   archon_mistake_occurrences_total        — raw occurrence count
 *   archon_mistake_fingerprints_total       — distinct pattern types
 *   archon_mistake_recurrent_fingerprints_total — patterns seen in ≥ 2 runs
 */
export function formatMistakePrometheus(metrics: MistakeMetrics): string {
  const run = sanitizeLabel(metrics.runId);
  const lines: string[] = [];

  lines.push("# HELP archon_mistake_repeat_rate Fraction of mistake occurrences that are recurrent (seen in ≥ 2 runs).");
  lines.push("# TYPE archon_mistake_repeat_rate gauge");
  lines.push(`archon_mistake_repeat_rate{run_id="${run}"} ${metrics.mistakeRepeatRate}`);

  lines.push("# HELP archon_mistake_occurrences_total Total captured mistake occurrence records.");
  lines.push("# TYPE archon_mistake_occurrences_total gauge");
  lines.push(`archon_mistake_occurrences_total{run_id="${run}"} ${metrics.totalOccurrences}`);

  lines.push("# HELP archon_mistake_fingerprints_total Distinct mistake fingerprints observed.");
  lines.push("# TYPE archon_mistake_fingerprints_total gauge");
  lines.push(`archon_mistake_fingerprints_total{run_id="${run}"} ${metrics.totalFingerprints}`);

  lines.push("# HELP archon_mistake_recurrent_fingerprints_total Fingerprints appearing in ≥ 2 distinct runs.");
  lines.push("# TYPE archon_mistake_recurrent_fingerprints_total gauge");
  lines.push(`archon_mistake_recurrent_fingerprints_total{run_id="${run}"} ${metrics.recurrentFingerprints}`);

  return `${lines.join("\n")}\n`;
}
