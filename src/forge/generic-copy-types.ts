/**
 * @module forge/generic-copy-types
 *
 * Zod schemas and inferred TypeScript types for the generic-copy checker
 * (Phase 1, S4 — COPY dimension of the anti-generic gate).
 *
 * The DOM/style dimension lives in anti-generic-types.ts +
 * anti-generic-checker.ts. This module is intentionally separate: it carries
 * only the copy-specific schemas and has zero archon-service dependencies, so
 * it is safe to import from web/, tooling, or any agent layer.
 *
 * Rule id namespace: CG-NNN (Copy Generic).
 * DOM/style rules use AG-NNN (Anti Generic).
 *
 * Style mirrors anti-generic-types.ts:
 *   - Stable rule ids (CG-NNN)
 *   - Explicit string length caps on all text fields
 *   - uncheckedRules declared at schema level (never silently hidden)
 *   - No `any`; all fields typed or narrowed
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// String length caps (prevent unbounded data in finding payloads and inputs)
// ---------------------------------------------------------------------------

/**
 * Maximum length for a copy-block key (location).
 * In practice, block keys are short names like "hero", "pricing". 256 chars
 * is generous enough for any realistic case while bounding adversarial input.
 */
export const MAX_LOCATION_LEN = 256;

/**
 * Maximum length for a copy-block value (the actual copy text).
 * A full landing-page copy block should not exceed 8 KB. This prevents a
 * caller from feeding an entire codebase as a "copy block".
 */
export const MAX_COPY_TEXT_LEN = 8_192;

/**
 * Maximum length for a forbidden phrase string.
 * All known phrases are < 30 chars; 64 is a safe upper bound.
 */
export const MAX_PHRASE_LEN = 64;

/**
 * Maximum length for a finding message.
 * Human-readable; generous but bounded so logs don't balloon.
 */
export const MAX_MESSAGE_LEN = 512;

/**
 * Maximum length for a section name.
 * Section names like "Features", "Pricing" are short. 128 is generous.
 */
export const MAX_SECTION_NAME_LEN = 128;

/** Maximum number of sections in the input. */
export const MAX_SECTIONS = 64;

/** Maximum number of findings in a report. */
export const MAX_FINDINGS = 256;

/** Maximum number of unchecked-rule entries. */
export const MAX_UNCHECKED_RULES = 32;

// ---------------------------------------------------------------------------
// CopyInput — input contract
//
// The checker takes a flat map of named copy blocks and an optional list of
// section names. This is intentionally NOT tied to a full FrontendSpec (which
// does not exist in the codebase yet). The S5 pipeline will supply these
// fields once the spec schema is defined.
// ---------------------------------------------------------------------------

/**
 * Input to the generic-copy checker.
 *
 * `copyBlocks` — a named map of raw copy text, keyed by block name
 *   (e.g. `{ hero: "Build something great.", pricing: "Simple pricing." }`).
 *   Keys are used as the `location` in findings so they should be descriptive.
 *
 * `sectionNames` — optional list of page-level section names used by CG-002
 *   (feature-card soup heuristic). If omitted, CG-002 is skipped because the
 *   checker cannot evaluate the "features" section heuristic without section
 *   metadata.
 */
export const CopyInputSchema = z.object({
  /** Named copy blocks. */
  copyBlocks: z.record(
    z.string().max(MAX_LOCATION_LEN),
    z.string().max(MAX_COPY_TEXT_LEN)
  ),

  /** Optional page-section names for the CG-002 feature-card-soup heuristic. */
  sectionNames: z
    .array(z.string().max(MAX_SECTION_NAME_LEN))
    .max(MAX_SECTIONS)
    .optional()
});

export type CopyInput = z.infer<typeof CopyInputSchema>;

// ---------------------------------------------------------------------------
// CopyFinding — one finding emitted by the checker
// ---------------------------------------------------------------------------

/**
 * A single finding from the generic-copy checker.
 *
 * `ruleId`   — stable CG-NNN identifier.
 * `phrase`   — the specific forbidden phrase that was matched (CG-001 only).
 * `location` — the copy-block key where the finding was detected. Omitted for
 *              page-level findings (e.g. CG-002 which looks at sectionNames).
 * `severity` — "hard_fail" blocks the gate; "warning" is advisory.
 *              All current CG rules are "warning"; blocking is determined by
 *              total finding count (>= 3), not individual severity.
 * `message`  — human-readable description for the repair loop.
 */
export const CopyFindingSchema = z.object({
  /**
   * Stable rule id in the CG-NNN namespace.
   * CG-001: forbidden SaaS phrase
   * CG-002: feature-card soup heuristic
   * CG-003: placeholder / lorem ipsum copy
   */
  ruleId: z.string().regex(/^CG-\d{3}$/),

  /**
   * The forbidden phrase that was matched (CG-001 only).
   * Capped at MAX_PHRASE_LEN to prevent adversarial inputs from inflating logs.
   */
  phrase: z.string().max(MAX_PHRASE_LEN).optional(),

  /**
   * The copy-block key where the finding was detected.
   * Capped at MAX_LOCATION_LEN. Omitted for page-level findings (CG-002).
   */
  location: z.string().max(MAX_LOCATION_LEN).optional(),

  /** Severity level. All current CG rules are "warning". */
  severity: z.enum(["hard_fail", "warning"]),

  /** Human-readable description for the repair loop. */
  message: z.string().max(MAX_MESSAGE_LEN)
});

export type CopyFinding = z.infer<typeof CopyFindingSchema>;

// ---------------------------------------------------------------------------
// CopyReport — output contract
// ---------------------------------------------------------------------------

/**
 * The full result returned by checkGenericCopy().
 *
 * `findings`       — all detected findings, in stable order (ruleId ascending,
 *                    then phrase ascending, then location ascending).
 * `blocking`       — true iff findings.length >= 3 (the §10.1 blocking rule).
 *                    Individual finding severity does NOT affect this flag;
 *                    only count matters.
 * `score`          — total finding count (== findings.length). Provided as a
 *                    convenience so callers don't need to compute `.length`.
 * `uncheckedRules` — non-mechanical aspects that cannot be checked
 *                    deterministically. Declared explicitly so advisory
 *                    coverage is visible and never silently hidden.
 */
export const CopyReportSchema = z.object({
  /** All findings, in stable deterministic order. */
  findings: z.array(CopyFindingSchema).max(MAX_FINDINGS),

  /**
   * True iff total findings >= 3.
   *
   * Rationale: §10.1 sets the threshold at 3 findings because 1-2 forbidden
   * phrases may appear in otherwise-specific copy by coincidence. Three or more
   * signals a systematic pattern of AI-SaaS sludge that warrants regeneration.
   */
  blocking: z.boolean(),

  /**
   * Total finding count. Always equals findings.length.
   * Provided as a named field for convenience and machine-readability by the
   * S5 pipeline, which logs score alongside other gate metrics.
   */
  score: z.number().int().nonnegative(),

  /**
   * Non-mechanical rules declared here so advisory coverage is never hidden.
   * These aspects require human or model judgment and cannot be evaluated
   * deterministically by a static text scan.
   */
  uncheckedRules: z.array(z.string()).max(MAX_UNCHECKED_RULES)
});

export type CopyReport = z.infer<typeof CopyReportSchema>;
