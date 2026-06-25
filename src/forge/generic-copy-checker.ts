/**
 * @module forge/generic-copy-checker
 *
 * Deterministic generic-copy checker for Archon Forge (Phase 1, S4 —
 * COPY dimension of the anti-generic gate).
 *
 * The DOM/style dimension is anti-generic-checker.ts (AG-NNN rules).
 * This module handles the copy/text dimension (CG-NNN rules).
 *
 * Algorithm source: §10 + §10.1 of the roadmap
 * (`docs/archon_frontend_forge_codex_imagegen_roadmap.md`).
 * The Python `score_generic_ai_smell` stub is ported faithfully, with:
 *   - faithful port of the 5 original forbidden phrases
 *   - extended list of 6 additional AI-SaaS sludge phrases (see FORBIDDEN_PHRASES)
 *   - CG-002 feature-card soup heuristic from §10.1
 *   - CG-003 placeholder/lorem copy (§10 anti-generic rules list)
 *   - getattr(...) boolean hooks replaced with mechanically-checkable CG-003
 *     (placeholder copy is checkable; unjustified gradient and fake dashboard
 *     remain in uncheckedRules because they require visual/model judgment)
 *
 * Design constraints:
 *   - Zero archon-service dependencies (pure module; importable from tooling)
 *   - Only `zod` + local types
 *   - No `any`; all unknowns narrowed explicitly
 *   - Immutable: no mutation, always return new objects
 *   - Deterministic: same input → identical output, stable ordering
 */

import type { CopyInput, CopyFinding, CopyReport } from "./generic-copy-types.ts";
import { CopyInputSchema, MAX_LOCATION_LEN } from "./generic-copy-types.ts";

// ---------------------------------------------------------------------------
// Forbidden phrase list
//
// Source A (§10.1 original): unlock, supercharge, seamless, streamline, all-in-one
// Source B (extended — common AI-SaaS sludge observed across model-generated copy):
//   revolutionize, leverage, cutting-edge, game-changer, next-generation, effortless
//
// The extended list is documented with source "AI-SaaS sludge observation" and
// is intentionally conservative — only phrases that appear near-universally in
// undifferentiated AI-generated marketing copy are included.
//
// Matching rule: WORD BOUNDARY (\\b) regex, case-insensitive.
//
// Decision rationale (word boundary vs stem):
//   - "streamline" (forbidden) vs "streamlined" (not forbidden): word-boundary
//     matching allows "streamlined" without false-positive because "streamlined"
//     has additional characters after the match boundary. However, standard \\b
//     treats the boundary BETWEEN "streamline" and "d" as INSIDE a word, so
//     /\bstreamline\b/ does NOT match "streamlined". Verified: this is the
//     correct behavior and what the tests assert.
//   - "unlock" vs "unlocking": same principle. /\bunlock\b/ does not match
//     "unlocking" because 'k' is followed by 'i' (a word character).
//   - "all-in-one": hyphens are non-word characters under \\b, so
//     /\ball-in-one\b/ matches "all-in-one" correctly with word boundaries
//     at the start of "all" and end of "one".
//   - "cutting-edge": same as "all-in-one" — \\b at "cutting" start and
//     "edge" end.
//   - "game-changer": same pattern.
//   - "next-generation": same pattern.
//
// False-positive avoidance: this list does NOT include common words that appear
// in forbidden phrases as substrings (e.g. "stream" is not listed, only
// "streamline"). Callers who legitimately need "streamlined" in copy are safe.
// ---------------------------------------------------------------------------

export const FORBIDDEN_PHRASES: ReadonlyArray<string> = [
  // §10.1 original five
  "unlock",
  "supercharge",
  "seamless",
  "streamline",
  "all-in-one",
  // Extended AI-SaaS sludge (source B)
  "revolutionize",
  "leverage",
  "cutting-edge",
  "game-changer",
  "next-generation",
  "effortless"
] as const;

// ---------------------------------------------------------------------------
// Unchecked rules
//
// These aspects are part of the §10 anti-generic rules but cannot be evaluated
// deterministically by a static text scan. They require visual inspection or
// model-based judgment.
//
// Declared explicitly here so advisory coverage is NEVER silently hidden.
// ---------------------------------------------------------------------------

export const UNCHECKED_COPY_RULES: ReadonlyArray<string> = [
  "CG-UNCHECKED-specificity: Copy does not verify whether product-specific language or concrete product mechanism is mentioned. Genuine specificity ('our deterministic gate returns rework') vs marketing abstraction ('advanced AI capabilities') requires model judgment.",
  "CG-UNCHECKED-product-mechanism: Copy does not check whether at least one concrete product mechanism (how the product works) is described. This requires understanding the product domain.",
  "CG-UNCHECKED-gradient-presence: Whether the page uses unjustified gradient fills is a visual/CSS check covered by AG-001 in anti-generic-checker.ts, not a copy check.",
  "CG-UNCHECKED-fake-dashboard: Whether the page uses an irrelevant fake dashboard hero is a visual/structural check outside copy analysis."
] as const;

// ---------------------------------------------------------------------------
// Placeholder token patterns for CG-003
//
// These patterns detect obvious placeholder copy that should not appear in
// production. Patterns are intentionally conservative to avoid false positives.
//
// Matching rules:
//   - "lorem ipsum": case-insensitive substring match (Latin placeholder text
//     is unambiguous regardless of capitalization).
//   - "[PLACEHOLDER]" bracket pattern: matches any [ALL_CAPS_WITH_UNDERSCORES]
//     token, case-insensitive on the outer brackets. Common in templates.
//   - "TODO" (uppercase): matches the all-uppercase development marker at word
//     boundaries. Lowercase "todo" (as in "to-do list") is NOT matched to
//     avoid false positives on product copy that mentions task management.
//   - "[INSERT_*]" and similar bracket placeholders are caught by the bracket
//     pattern above.
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  {
    pattern: /lorem\s+ipsum/i,
    description: "lorem ipsum placeholder text"
  },
  {
    pattern: /\[[A-Z][A-Z0-9_]*\]/,
    description: "bracket placeholder token (e.g. [PLACEHOLDER], [INSERT_COPY])"
  },
  {
    pattern: /\bTODO\b/,
    description: "TODO development marker in copy"
  }
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Cap a string to maxLen characters.
 * Used to prevent adversarial long keys from bloating finding messages.
 */
function capString(s: string, maxLen: number): string {
  return s.slice(0, maxLen);
}

/**
 * Build a word-boundary regex for a forbidden phrase.
 *
 * For hyphenated phrases like "all-in-one", the regex is:
 *   /\ball-in-one\b/i
 * which correctly matches "all-in-one" but not "all-in-one-ness" (if such
 * a word existed), because the boundary is checked at the edge of the full
 * phrase.
 *
 * The phrase is escaped for use in a regex (hyphens in phrases like
 * "all-in-one" are literal hyphens in the text, not in a character class,
 * so no escaping is needed; we escape dots and other metacharacters anyway).
 */
function buildPhraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

// Pre-build regex for each forbidden phrase at module load (deterministic,
// avoids re-compilation on every call).
const PHRASE_REGEXES: ReadonlyArray<{ phrase: string; regex: RegExp }> =
  FORBIDDEN_PHRASES.map((phrase) => ({ phrase, regex: buildPhraseRegex(phrase) }));

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/**
 * CG-001: Forbidden SaaS phrase found in a copy block.
 *
 * One finding per (phrase, location) pair. If the same phrase appears multiple
 * times in a single block it is still one finding — the goal is to flag the
 * block, not count occurrences.
 *
 * Ordering: by phrase (FORBIDDEN_PHRASES order), then by location (block key).
 */
function checkForbiddenPhrases(
  copyBlocks: Readonly<Record<string, string>>
): CopyFinding[] {
  const findings: CopyFinding[] = [];
  const entries = Object.entries(copyBlocks);

  for (const { phrase, regex } of PHRASE_REGEXES) {
    for (const [key, text] of entries) {
      if (regex.test(text)) {
        const cappedKey = capString(key, MAX_LOCATION_LEN);
        findings.push({
          ruleId: "CG-001",
          phrase,
          location: cappedKey,
          severity: "warning",
          message: `Generic SaaS copy phrase '${phrase}' found in block '${cappedKey}'. Replace with specific product language describing what the product actually does.`
        });
      }
    }
  }

  return findings;
}

/**
 * CG-002: Likely feature-card soup.
 *
 * A "features" section name (case-insensitive) present AND total section
 * count <= 4 strongly suggests a generic three-column feature-card layout.
 * This is the §10.1 heuristic ported faithfully from the Python stub.
 *
 * The heuristic fires when:
 *   - sectionNames contains a name that lowercases to "features"
 *   - sectionNames.length <= 4
 *
 * This is a warning, not a hard_fail, because the section structure alone
 * is not conclusive; the layout must be inspected visually. The finding
 * instructs the repair loop to inspect before accepting.
 */
function checkFeatureCardSoup(sectionNames: readonly string[]): CopyFinding[] {
  const lowerNames = sectionNames.map((n) => n.toLowerCase());
  const hasFeaturesSection = lowerNames.includes("features");

  if (!hasFeaturesSection || sectionNames.length > 4) {
    return [];
  }

  return [
    {
      ruleId: "CG-002",
      severity: "warning",
      message: `Likely feature-card soup: a 'features' section is present and there are only ${sectionNames.length} total sections (threshold: ≤4). Inspect the layout before accepting — three identical feature cards with vague icons is a hard-fail pattern.`
    }
  ];
}

/**
 * CG-003: Placeholder or lorem ipsum copy detected in a copy block.
 *
 * Checks for:
 *   - "lorem ipsum" (case-insensitive) — Latin filler text
 *   - Bracket placeholder tokens like [PLACEHOLDER], [INSERT_COPY] (all-caps)
 *   - "TODO" (all-caps) development markers at word boundaries
 *
 * One finding per (pattern, location) pair.
 */
function checkPlaceholderCopy(
  copyBlocks: Readonly<Record<string, string>>
): CopyFinding[] {
  const findings: CopyFinding[] = [];
  const entries = Object.entries(copyBlocks);

  for (const { pattern, description } of PLACEHOLDER_PATTERNS) {
    for (const [key, text] of entries) {
      if (pattern.test(text)) {
        const cappedKey = capString(key, MAX_LOCATION_LEN);
        findings.push({
          ruleId: "CG-003",
          location: cappedKey,
          severity: "warning",
          message: `Placeholder copy detected in block '${cappedKey}': ${description}. Replace with real product copy before shipping.`
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Sorting
//
// Findings are sorted in a stable, deterministic order:
//   Primary:   ruleId (CG-001 < CG-002 < CG-003, lexicographic)
//   Secondary: phrase (alphabetical; undefined phrases sort before defined)
//   Tertiary:  location (alphabetical; undefined locations sort after defined)
//
// This ordering is guaranteed to be stable because the inputs (FORBIDDEN_PHRASES
// order, Object.entries order) are fixed, but we apply an explicit sort so
// the output is invariant even if JS engine Map/object ordering changes.
// ---------------------------------------------------------------------------

function sortFindings(findings: CopyFinding[]): CopyFinding[] {
  return [...findings].sort((a, b) => {
    // ruleId
    if (a.ruleId < b.ruleId) return -1;
    if (a.ruleId > b.ruleId) return 1;
    // phrase (undefined → empty string for comparison; undefined sorts before "a")
    const ap = a.phrase ?? "";
    const bp = b.phrase ?? "";
    if (ap < bp) return -1;
    if (ap > bp) return 1;
    // location (undefined → "\xff" sorts after all real keys)
    const al = a.location ?? "\xff";
    const bl = b.location ?? "\xff";
    if (al < bl) return -1;
    if (al > bl) return 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check copy blocks for generic AI-SaaS patterns.
 *
 * Validates `input` strictly against `CopyInputSchema` (throws ZodError on
 * invalid input). Returns a `CopyReport` that is always valid against
 * `CopyReportSchema`.
 *
 * Blocking rule (§10.1): `blocking = findings.length >= 3`.
 * If blocking is true, the design direction should be regenerated before
 * implementation. The copy checker does not regenerate; it only reports.
 *
 * @throws {ZodError} if `input` does not satisfy `CopyInputSchema`.
 */
export function checkGenericCopy(input: CopyInput): CopyReport {
  // Validate input strictly. ZodError propagates to caller — never swallowed.
  const parsed = CopyInputSchema.parse(input);

  const { copyBlocks, sectionNames = [] } = parsed;

  // Collect findings from each rule
  const cg001 = checkForbiddenPhrases(copyBlocks);
  const cg002 = checkFeatureCardSoup(sectionNames);
  const cg003 = checkPlaceholderCopy(copyBlocks);

  const allFindings = sortFindings([...cg001, ...cg002, ...cg003]);

  const score = allFindings.length;
  const blocking = score >= 3;

  return {
    findings: allFindings,
    blocking,
    score,
    uncheckedRules: [...UNCHECKED_COPY_RULES]
  };
}
