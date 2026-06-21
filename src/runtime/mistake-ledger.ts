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
// P2: Distillation — select fingerprints with ≥ 2 distinct run occurrences
// ---------------------------------------------------------------------------

/**
 * POLICY CONSTANT allowlist of deterministic, mechanically-verifiable mistake
 * categories eligible for AUTONOMOUS promotion (council condition 4 / hybrid-C).
 *
 * IMPORTANT: This list is code — NOT runtime-mutable. Expanding it requires a
 * new council-approved change. Start with only "nodenext_extension_missing"
 * because it is detected by a deterministic pattern rule (import lacks `.ts`)
 * with no semantic ambiguity. All other categories require human judgment.
 */
export const AUTONOMOUS_PROMOTION_ALLOWLIST: readonly MistakeCategory[] = [
  "nodenext_extension_missing"
] as const;

/** Promotion path for a distilled anti-pattern candidate. */
export type DistillationPromotionPath = "autonomous" | "review_required";

/**
 * A distilled candidate ready for promotion or draft storage.
 * Produced by selectDistillationCandidates — pure function, no side effects.
 */
export interface DistillationCandidate {
  /** SHA-256 fingerprint that identifies this mistake pattern. */
  readonly fingerprint: string;
  readonly category: MistakeCategory;
  readonly ruleLocus: string;
  /** Number of DISTINCT run IDs that contained at least one occurrence. */
  readonly distinctRunCount: number;
  /**
   * "autonomous" = category is in AUTONOMOUS_PROMOTION_ALLOWLIST; auto-promote.
   * "review_required" = must be stored as a pending draft awaiting human review.
   */
  readonly promotionPath: DistillationPromotionPath;
  /** Representative occurrences for provenance (one per distinct run). */
  readonly representativeOccurrences: readonly MistakeOccurrenceRecord[];
}

/**
 * Draft anti-pattern candidate stored for human review.
 * Used for review_required candidates that cannot be auto-promoted.
 */
export interface AntiPatternDraft {
  readonly id: string;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly category: MistakeCategory;
  readonly ruleLocus: string;
  readonly distinctRunCount: number;
  readonly promotionPath: DistillationPromotionPath;
  readonly content: string;
  /** "pending" = awaiting human review; "promoted" = human approved and promoted. */
  readonly status: "pending" | "promoted";
  readonly createdAt: string;
}

/**
 * Selects distillation candidates from all occurrence records.
 *
 * Algorithm:
 * 1. Group occurrences by fingerprint.
 * 2. Count distinct run IDs per fingerprint.
 * 3. Exclude fingerprints with < 2 distinct runs (council condition 3).
 * 4. Classify remaining fingerprints as "autonomous" (in allowlist) or
 *    "review_required" (council condition 4 / hybrid-C).
 *
 * PURE function — no side effects. Callers are responsible for acting on results.
 */
export function selectDistillationCandidates(
  occurrences: readonly MistakeOccurrenceRecord[]
): readonly DistillationCandidate[] {
  // Group by fingerprint → map of runId sets and representative occurrences
  const byFingerprint = new Map<
    string,
    {
      category: MistakeCategory;
      ruleLocus: string;
      runs: Set<string>;
      occurrencesByRun: Map<string, MistakeOccurrenceRecord>;
    }
  >();

  for (const occ of occurrences) {
    const entry = byFingerprint.get(occ.fingerprint) ?? {
      category: occ.category,
      ruleLocus: occ.ruleLocus,
      runs: new Set<string>(),
      occurrencesByRun: new Map<string, MistakeOccurrenceRecord>()
    };

    entry.runs.add(occ.runId);
    // Keep one representative occurrence per run (first seen wins)
    if (!entry.occurrencesByRun.has(occ.runId)) {
      entry.occurrencesByRun.set(occ.runId, occ);
    }

    byFingerprint.set(occ.fingerprint, entry);
  }

  const candidates: DistillationCandidate[] = [];
  const allowlistSet = new Set<string>(AUTONOMOUS_PROMOTION_ALLOWLIST);

  for (const [fingerprint, entry] of byFingerprint) {
    // Council condition 3: require ≥ 2 distinct runs
    if (entry.runs.size < 2) {
      continue;
    }

    const promotionPath: DistillationPromotionPath = allowlistSet.has(entry.category)
      ? "autonomous"
      : "review_required";

    candidates.push({
      fingerprint,
      category: entry.category,
      ruleLocus: entry.ruleLocus,
      distinctRunCount: entry.runs.size,
      promotionPath,
      representativeOccurrences: [...entry.occurrencesByRun.values()]
    });
  }

  return candidates;
}

/**
 * Builds the content string for an anti_pattern memory entry.
 *
 * Includes:
 * - Category and policy anchor (ruleLocus)
 * - Distinct run count (provenance signal)
 * - How to detect before acting (prevention guidance)
 * - Fingerprint (for cross-referencing)
 */
export function buildAntiPatternContent(candidate: DistillationCandidate): string {
  const lines: string[] = [
    `Anti-pattern: ${candidate.category}`,
    `Policy anchor: ${candidate.ruleLocus}`,
    `Fingerprint: ${candidate.fingerprint}`,
    `Recurrence: seen in ${candidate.distinctRunCount} distinct run(s)`,
    "",
    "Prevention / detection guidance:",
    ...getDetectionGuidance(candidate.category),
    "",
    "Provenance (representative run IDs):",
    ...candidate.representativeOccurrences.map(
      (occ) => `  run=${occ.runId} task=${occ.taskId}: ${occ.rawFinding}`
    )
  ];
  return lines.join("\n");
}

const DETECTION_GUIDANCE: Readonly<Record<MistakeCategory, readonly string[]>> = {
  nodenext_extension_missing: [
    "  - All relative imports in TypeScript source must end with .ts extension.",
    "  - Before writing any import statement, verify it includes .ts suffix.",
    "  - NodeNext module resolution requires explicit extensions — no omissions allowed.",
    "  - Run: grep -rn \"from '\\./\" src/ | grep -v \"\\.ts'\" to detect violations."
  ],
  immutability_violation: [
    "  - Never mutate objects or arrays in place; return new copies via spread.",
    "  - Use const for bindings; use Readonly<T> for data structures.",
    "  - Before modifying an object field, verify you are working on a new copy."
  ],
  sql_injection: [
    "  - Always use parameterized queries; never interpolate variables into SQL strings.",
    "  - Review every query construction site before submitting code."
  ],
  unhandled_error: [
    "  - Wrap all async calls in try/catch; never silently swallow errors.",
    "  - Ensure every catch block either re-throws or logs with sufficient context."
  ],
  missing_input_validation: [
    "  - Validate all external inputs at system boundaries using schema validation.",
    "  - Never pass raw user/API input to business logic without validation."
  ],
  test_expectation_drift: [
    "  - Write assertions against stable outcomes, not implementation details.",
    "  - Update tests only when the behavior being tested has intentionally changed."
  ],
  uncategorized: [
    "  - Review the raw findings and classify before acting."
  ]
};

function getDetectionGuidance(category: MistakeCategory): readonly string[] {
  return DETECTION_GUIDANCE[category] ?? DETECTION_GUIDANCE.uncategorized;
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
