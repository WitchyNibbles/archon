/**
 * @module admin/why-redaction-keywords
 *
 * Canonical secret-keyword vocabulary shared by every keyword-consulting site
 * in `why-redaction.ts` (audit F9, round-11 fix). See
 * `src/admin/why-redaction-design-history.md`'s round-11 entry for the full
 * root-cause narrative: a recognized keyword split by a single hyphen or
 * underscore (`pass-word`, `to-ken`, `au-th`, `se-cret`, `cred-ential`)
 * defeated BOTH stage-1 pattern recognition (`LABELED_FIELD_PATTERN`,
 * `SPACE_SEPARATED_SECRET_FLAG`, `PROSE_SECRET_KEYWORD_PATTERN`, all built
 * from a literal, separator-free keyword alternation) AND the round-10
 * `isSafeFlagName` backstop (`SECRET_KEYWORD_ANYWHERE`, `BARE_SECRET_KEYWORD`
 * — same literal alternation), because every one of those sites embedded its
 * own copy of the same separator-free spelling.
 *
 * This module is the ONE place the canonical keyword list and its
 * separator-tolerant regex form are derived. Every consulting site in
 * `why-redaction.ts` imports `SECRET_KEYWORD_ALTERNATION` from here rather
 * than keeping its own copy — a single shared source, fixed once, applies
 * everywhere at once.
 */

/** Canonical, separator-free spelling of every recognized secret keyword.
 * `api-key`/`access-key`'s previously special-cased hyphenated spellings
 * (`api[_-]?key`, `access[_-]?key`) are gone — `looseKeywordSource` below
 * makes EVERY keyword separator-tolerant uniformly, so the plain `apikey`/
 * `accesskey` entries already match `api-key`, `api_key`, `access-key`, etc.
 * without a special case. */
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
 * an optional single `-` or `_` between any two of its letters —
 * `password` (via this) also matches `pass-word`, `pass_word`,
 * `p-a-s-s-w-o-r-d`, etc. This is the round-11 ROOT-CAUSE fix for the
 * CRITICAL bypass: rather than patching each consulting site's OWN copy of
 * the keyword text, the keyword itself is redefined once, here, to be
 * separator-tolerant — every regex or predicate built from it inherits the
 * fix automatically. There is no backtracking ambiguity (each letter is
 * followed by at most one optional single-character separator, never an
 * unbounded quantifier stacked on itself), so this stays linear-time safe
 * for arbitrarily long input.
 */
function looseKeywordSource(keyword: string): string {
  return keyword.split("").join("[-_]?");
}

/**
 * Regex-alternation source combining every keyword's separator-tolerant
 * form — the SINGLE shared source every keyword-consulting regex or
 * predicate in `why-redaction.ts` is built from (`LABELED_FIELD_PATTERN`,
 * `SPACE_SEPARATED_SECRET_FLAG`, `PROSE_SECRET_KEYWORD_PATTERN`,
 * `SECRET_KEYWORD_ANYWHERE`, `BARE_SECRET_KEYWORD`) — never a per-site copy.
 * Consumers wrap this in their own anchors/bounds (`^...$`, `\b...\b`,
 * `[\w-]{0,12}` context, etc.) as needed; this module only owns the keyword
 * spelling itself.
 */
export const SECRET_KEYWORD_ALTERNATION = SECRET_KEYWORDS.map(looseKeywordSource).join("|");
