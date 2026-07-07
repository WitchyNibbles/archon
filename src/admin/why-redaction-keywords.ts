/**
 * @module admin/why-redaction-keywords
 *
 * Canonical secret-keyword vocabulary shared by every keyword-consulting site
 * in `why-redaction.ts`. See `src/admin/why-redaction-design-history.md`'s
 * round-11 and round-12 entries for the full root-cause narrative.
 *
 * Round 11 made keyword RECOGNITION separator-tolerant (a split keyword like
 * `pass-word` is still recognized). Round 12's gate found that widening
 * recognition can never fully converge — two-plus separators or an
 * interposed digit (`--pass--word-X`, `--p4ssword-X`) still defeated it, and
 * `isSafeFlagName` treated a recognition MISS as grounds for TRUST, so every
 * miss (forever) converted directly into a leak. Round 12 inverted that
 * trust decision structurally (see `why-redaction.ts`'s `isSafeFlagName`):
 * a flag body is emitted verbatim ONLY on a POSITIVE match against a bounded
 * safe set (an exact vocabulary member, or an exact canonical keyword flag
 * name) — never because recognition of an UNSAFE shape failed. Under that
 * inversion, `SECRET_KEYWORD_ALTERNATION`'s separator-tolerant recognition is
 * downgraded from a security boundary to best-effort stage-1 VALUE-redaction
 * coverage: a recognition miss there can only cause a value to be
 * OVER-redacted by the stage-2 default-deny that already runs on every
 * token, never under-redacted.
 *
 * This module is the ONE place every keyword-ish list `why-redaction.ts`
 * consults is derived from — `SECRET_KEYWORDS` (stage-1 recognition),
 * `CODE_ADJACENT_WORDS` (the narrow "X code" compound-phrase rule), and
 * `CANONICAL_BARE_SECRET_KEYWORD_FLAGS` (the round-12 fail-closed allowlist)
 * are three DIFFERENT, deliberately-scoped lists for three different
 * purposes — not accidental duplicates — but they all live here so no
 * consulting site keeps its own copy.
 */

/** Canonical, separator-free spelling of every recognized secret keyword,
 * used by stage-1's best-effort value-redaction rules (`SECRET_KEYWORD_
 * ALTERNATION` below). NOT used to grant flag-name trust (see
 * `CANONICAL_BARE_SECRET_KEYWORD_FLAGS` for that, a deliberately separate,
 * exact-match-only list). */
export const SECRET_KEYWORDS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "auth",
  "credential",
  "passphrase",
  "passcode",
  "otp",
  "mfa",
  "pin",
  "cvv"
] as const;

/**
 * Builds a regex-alternation SOURCE fragment for one keyword that tolerates
 * a BOUNDED RUN (0-3) of `-`/`_` separators between any two of its letters —
 * `password` (via this) also matches `pass-word`, `pass--word`,
 * `pass___word`, etc. Round-11 fix tolerated exactly one separator per
 * letter-gap; round 12 widened the bound to 0-3 per the gate's own
 * two-plus-separator and digit-interposed repros. This is now explicitly
 * BEST-EFFORT COVERAGE, not a security boundary (round-12 inversion — see
 * this module's header): widening (or a future gap in) this recognition can
 * only affect which value stage 1 redacts a beat earlier, never whether an
 * unrecognized flag NAME is trusted (`isSafeFlagName` no longer trusts on a
 * recognition miss at all). No backtracking blowup risk: each letter is
 * followed by a BOUNDED quantifier on a simple character class, never a
 * nested/unbounded one, so this stays linear-time regardless of input
 * length (the round-12 HIGH ReDoS finding was closed by an input-length cap
 * in `why-redaction.ts`, not by this bound alone — belt and suspenders).
 */
function looseKeywordSource(keyword: string): string {
  return keyword.split("").join("[-_]{0,3}");
}

/**
 * Regex-alternation source combining every keyword's separator-tolerant
 * form — the shared source `why-redaction.ts`'s stage-1 value-redaction
 * rules (`LABELED_FIELD_PATTERN`, `SPACE_SEPARATED_SECRET_FLAG`,
 * `PROSE_SECRET_KEYWORD_PATTERN`) are built from. Best-effort coverage only
 * (round 12) — see this module's header.
 */
export const SECRET_KEYWORD_ALTERNATION = SECRET_KEYWORDS.map(looseKeywordSource).join("|");

/** Round-7 gate finding 2: bare `code` would collide with this codebase's
 * own `exit-code`/`error-code`/`status-code` vocabulary, so the "X code"
 * compound-phrase rule in `why-redaction.ts` (`LABELED_CODE_PHRASE_PATTERN`/
 * `SPACE_SEPARATED_CODE_PHRASE_PATTERN`) only fires after one of these four
 * specific words. Deliberately NOT merged into `SECRET_KEYWORDS`: these are
 * modifiers of the word "code", not themselves bare secret-flag names —
 * `--verification` alone is not a designed labeled-flag case the way
 * `--token`/`--password` are, so it must never gain `isSafeFlagName`'s bare-
 * keyword trust. Round-12 MEDIUM fix (finding 3): this list previously lived
 * as a hand-written duplicate in `why-redaction.ts`; it now lives here, next
 * to every other keyword-ish list, with this ownership note recorded instead
 * of silently drifting out of sync with `SECRET_KEYWORDS` again. */
export const CODE_ADJACENT_WORDS = ["pin", "verification", "otp", "auth"] as const;

/** Loose, separator-tolerant alternation for `CODE_ADJACENT_WORDS` — same
 * best-effort stage-1 coverage rationale as `SECRET_KEYWORD_ALTERNATION`. */
export const CODE_ADJACENT_KEYWORD_ALTERNATION = CODE_ADJACENT_WORDS.map(looseKeywordSource).join("|");

/**
 * Round-12 CRITICAL fix — the fail-closed allowlist. Exact (not
 * separator-tolerant, not substring) flag-body spellings that ARE,
 * entirely, the designed labeled-flag case (`--token <value>`,
 * `--password <value>`, `--api-key <value>`): the flag name IS the label
 * naming its own value, with nothing else attached. `api-key`/`access-key`
 * are listed both with and without their canonical hyphen since both
 * spellings are real, published CLI conventions.
 *
 * This is the ONLY way (besides an exact `knownSafeTokens` vocabulary
 * member — see `isSafeFlagName`) a flag body may be emitted verbatim. It is
 * intentionally exact and unbounded-by-tolerance: recognition MISSES here
 * are safe by construction (they fall through to redaction), so there is no
 * incentive to widen this list defensively the way `SECRET_KEYWORD_
 * ALTERNATION` was repeatedly (and unsuccessfully) widened across rounds
 * 10-12 — adding a keyword here only WIDENS what survives, so each entry is
 * individually justified: every one of these IS a real, designed CLI flag
 * name for supplying a secret, never a shape or substring guess.
 */
export const CANONICAL_BARE_SECRET_KEYWORD_FLAGS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "api-key",
  "accesskey",
  "access-key",
  "auth",
  "credential",
  "passphrase",
  "passcode",
  "otp",
  "mfa",
  "pin",
  "cvv"
] as const;

export const CANONICAL_BARE_SECRET_KEYWORD_ALTERNATION = CANONICAL_BARE_SECRET_KEYWORD_FLAGS.join("|");
