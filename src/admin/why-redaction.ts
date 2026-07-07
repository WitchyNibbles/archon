/**
 * @module admin/why-redaction
 *
 * Secret redaction for `archon why` (audit F9). TERMINAL DESIGN (round 8,
 * hardened rounds 9-11, STRUCTURALLY INVERTED at round 12) — see
 * `src/admin/why-redaction-design-history.md` for the full round-1-through-12
 * narrative; this header states only the CURRENT contract.
 *
 * MODEL: vocabulary-anchored default-deny, POSITIVE-MATCH-ONLY trust grants.
 * Stage 1 (`applySecretMarkerRules`) runs high-confidence context markers
 * (credential URLs, AWS key ids, well-known secret-token prefixes, labeled
 * `key=value` fields, Authorization/Bearer headers, mysqldump's `-p<value>`)
 * plus best-effort keyword-adjacent value redaction, vocabulary-aware (an
 * exact `knownSafeTokens` member survives even next to a keyword). Stage 2
 * (`classifyToken`, via `sanitizeFreeText`) then classifies every remaining
 * whitespace token. A free-text token survives ONLY if it is:
 *
 *   1. An EXACT member of a `knownSafeTokens` vocabulary the caller supplies
 *      — built, at diagnosis time, from the STRUCTURED context the collector
 *      already holds (task ids, run ids, role names, status/enum/outcome
 *      tokens, this module's own recommended command words, sidecar paths it
 *      constructed). See why-diagnosis.ts's `buildKnownVocabulary`.
 *   2. A flag name (`-x`, `--long-flag`) that IS, EXACTLY, a canonical
 *      secret-keyword flag spelling (`--token`, `--password`, `--api-key`),
 *      or an exact `knownSafeTokens` member (round-12 STRUCTURAL INVERSION —
 *      see `isSafeFlagName`). EVERY OTHER flag body redacts, including one
 *      with no keyword content at all — an ACCEPTED, DOCUMENTED trade-off
 *      (round-12 MEDIUM, owner: backend-engineer; see design-history).
 *   3. A UUID or ISO-timestamp shape — machine-generated, not
 *      attacker-controlled. There is no bare-number shape exemption.
 *   4. A path whose EVERY `/`-separated segment independently passes one of
 *      these same checks — otherwise the WHOLE token redacts.
 *   5. A `scheme://host...` URL whose EVERY path/query token independently
 *      passes one of these same checks — otherwise the path+query collapses
 *      wholesale to `scheme://host/[redacted]`. A URL WITH a userinfo
 *      component is caught by stage 1's `CREDENTIAL_URL_WITH_USERINFO` first.
 *
 * Everything else redacts. `sanitizeFreeText`/`sanitizeForDisplay` default
 * `knownSafeTokens` to an EMPTY set. Stage 1's keyword-adjacency rules AND
 * `isSafeFlagName`'s canonical-spelling list are non-load-bearing, BEST-
 * EFFORT coverage only (round-12): a recognition miss anywhere can only
 * cause MORE redaction, never less — fail-closed STRUCTURE, not keyword
 * breadth, is the boundary. Labeled bare-word forms (`pass-word: value`)
 * redact the LABEL too at stage 2 (not a recognized safe shape) — a safe-
 * direction over-redaction, disclosed per round-12 finding 6.
 *
 * INPUT-LENGTH CAP (round-12 HIGH fix): `sanitizeFreeText` caps input to
 * `MAX_SANITIZE_INPUT_LENGTH` (8192 chars) BEFORE the pipeline runs.
 * Adversarial near-miss input (`"cr-ed-en-tial-X".repeat(n)`) measured
 * polynomial blowup in the full multi-pass pipeline; every regex here is
 * individually linear-time, but that does not bound the FULL pipeline
 * against arbitrary-length input — the cap is the real, load-bearing bound.
 *
 * `classifyToken`'s only whole-token short-circuit is an EXACT match on the
 * `[redacted]` marker (round-9 fix; see design-history).
 *
 * EXEMPTION CHECKLIST (every structural shape-exemption):
 *
 *   - Flag name (`isSafeFlagName`) — POSITIVE match only (round-12
 *     inversion): an exact `knownSafeTokens` member, or the body IS,
 *     EXACTLY, one canonical keyword spelling
 *     (`why-redaction-keywords.ts`'s `CANONICAL_BARE_SECRET_KEYWORD_FLAGS`).
 *     No substring/"contains a keyword" check remains, so no separator,
 *     digit, case, or unicode mutation can convert a recognition miss into a
 *     trust grant — there is nothing left to defeat.
 *   - ISO-8601 timestamp (`SAFE_ISO_TIMESTAMP`, fractional seconds bounded
 *     to 1-9 digits) — machine-generated, never attacker-supplied. The ONLY
 *     numeric-adjacent shape safe without vocabulary backing.
 *   - UUID (`SAFE_UUID`) — fixed-width, every group is `{n}`, exactly 36
 *     characters total; machine-generated, fixed width leaves no room to
 *     smuggle variable-length secret data.
 *   - Path segment / URL path-query token (`isBoundedSafeShape`, reused by
 *     `isSafePathToken`/`classifyUrlToken`) — a vocabulary member, UUID, or
 *     ISO timestamp appearing as ONE segment/token of an otherwise path- or
 *     URL-shaped token; the WHOLE token/path+query redacts otherwise. Length
 *     is deliberately UNBOUNDED at this level — see the residual note below.
 *   - Shell operator (`SHELL_OPERATOR`) — pure punctuation, no alphanumeric
 *     content, no character budget to carry a secret.
 *
 * BOUNDEDNESS AUDIT (every SAFE_* shape regex, bounded or justified — round-14:
 * SAFE_UUID/SAFE_ISO_TIMESTAMP/PATH_LIKE_SHAPE/URL_STRUCTURE now live in
 * why-redaction-shapes.ts; this table still describes the CURRENT contract):
 *
 *   | Pattern               | Bounded?                  | Why
 *   |-----------------------|---------------------------|---------------------------------------
 *   | SAFE_UUID             | yes, fixed-width          | every group is `{n}`; exactly 36 chars total
 *   | SAFE_ISO_TIMESTAMP    | yes, fraction ≤9 digits   | fractional-seconds group is bounded, never unbounded `\d+`
 *   | isSafeFlagName        | N/A — positive match only | round-12: exact vocabulary member OR exact canonical spelling; no substring check left to defeat
 *   | SAFE_FLAG_VALUE_PAIR  | N/A — splitter, not a gate| the extracted value is re-validated independently
 *   | SHELL_OPERATOR        | yes, closed alphabet      | punctuation-only; zero alphanumeric content
 *   | PATH_LIKE_SHAPE       | N/A — gate, not a grant   | only decides ELIGIBILITY for per-segment checks
 *   | URL_STRUCTURE         | N/A — gate, not a grant   | only decides ELIGIBILITY for per-token checks
 *   (there is no `SAFE_NUMBER` and no blanket `SAFE_PATH`/`SAFE_URL_NO_USERINFO`)
 *
 * RESIDUAL, ACCEPTED TRADE-OFF (final disclosure): nothing survives by shape
 * alone except an exact vocabulary member, an ISO timestamp, a UUID, a
 * canonical-spelling flag name, or a path/URL every one of whose segments/
 * tokens independently passes one of those same checks. Paths and URLs are
 * deliberately UNBOUNDED in length, so an unlabeled secret formatted to look
 * like a long path segment or URL query token that ALSO happens to collide
 * with a bounded safe shape is a narrow residual (unchanged since round 8).
 * The round-12 input-length cap adds one more, similarly narrow residual: an
 * attacker who controls BOTH content and the exact 8192-char cutoff could in
 * principle craft a secret whose PREFIX, cut at that exact point, collides
 * with a UUID/timestamp shape — everything past the cut is unconditionally
 * dropped (`[truncated]`), so at most a bounded fixed-width fragment is at
 * risk, never the whole secret; not worth chasing further per this module's
 * own doctrine. Structured evidence (why-diagnosis.ts's `structured()`)
 * never calls `sanitizeFreeText`; the sidecar pointer in every cause's
 * evidence remains the relief valve for the raw original text.
 */

import { scrubPgCredentials } from "./db-error-scrub.ts";
import {
  SECRET_KEYWORD_ALTERNATION,
  CODE_ADJACENT_KEYWORD_ALTERNATION,
  CANONICAL_BARE_SECRET_KEYWORD_ALTERNATION
} from "./why-redaction-keywords.ts";
import { isSafeValueShape, classifyUrlToken } from "./why-redaction-shapes.ts";

export const MAX_COMMAND_DISPLAY_LENGTH = 120;

/** Round-12 HIGH fix: hard input-length cap applied BEFORE the redaction
 * pipeline runs (unrelated to `MAX_COMMAND_DISPLAY_LENGTH`, a much smaller
 * POST-redaction display cap). Restores a real linear-time bound BY
 * CONSTRUCTION: the gate measured polynomial blowup (~O(n^1.5-2)) against
 * adversarial near-miss input (`"cr-ed-en-tial-X".repeat(n)`, 120KB took
 * 5.2s) — no regex micro-tuning closes that for arbitrary-length input, so
 * the input is capped first. 8192 chars is far more than any legitimate
 * caller needs (display is already truncated to 120 chars downstream). */
export const MAX_SANITIZE_INPUT_LENGTH = 8192;

/** The default vocabulary for callers that don't supply one — deliberately
 * empty, so "no vocabulary given" means "strictest possible redaction", never
 * a silent fallback to shape-only trust. */
const EMPTY_VOCABULARY: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------
// Stage 1 — high-confidence secret markers. Run BEFORE tokenization; redact
// by pattern/context regardless of vocabulary. Kept from round 2/3/4 (URL
// credentials, labeled fields, Authorization/Bearer, mysqldump -p); extended
// in round 5 (well-known secret-token prefixes; userinfo-scoped credential
// URLs) and round 6 (space-separated labeled flags, see finding 1b below).
// ---------------------------------------------------------------------------

// SECRET_KEYWORD_ALTERNATION lives in why-redaction-keywords.ts, separator-
// tolerant (rounds 11-12), best-effort VALUE-redaction coverage only (round
// 12 — see the module header). Label-capture halves are bounded `{0,12}`
// each side of the keyword (round-10 fix — see design-history) so an
// oversized glued prefix/suffix simply fails to match rather than being
// absorbed into the never-re-examined "label" half.
const LABELED_FIELD_PATTERN = new RegExp(
  `\\b([\\w-]{0,12}(?:${SECRET_KEYWORD_ALTERNATION})[\\w-]{0,12})(\\s*[:=]\\s*)([^\\s"'\`]+)`,
  "gi"
);

// Round-6 gate finding 1b: LABELED_FIELD_PATTERN only fires on a `:`/`=` join
// — it never covered the CLI convention of a space-separated secret-labeled
// flag and its value (`--token 8372150`, `--password hunter2Aa1`, `--key
// <v>`, `--secret <v>`). Redacts the value regardless of its own shape, so a
// short (in-bound) numeric OTP/PIN passed as a flag value is caught even
// though `SAFE_NUMBER`'s bound alone would have let it through. Round-10:
// bounded `{0,12}` each side of the keyword for the same reason as
// `LABELED_FIELD_PATTERN` above.
const SPACE_SEPARATED_SECRET_FLAG = new RegExp(
  `(--?[\\w-]{0,12}(?:${SECRET_KEYWORD_ALTERNATION})[\\w-]{0,12})(\\s+)([^\\s"'\`]+)`,
  "gi"
);

// Round-7 gate finding 2: the keyword list above gained `pin`/`otp`/etc, but
// "code" itself was deliberately NOT added — bare `code` would collide with
// this codebase's own `exit-code`/`error-code`/`status-code` vocabulary. This
// scoped pair covers "pin code"/"otp code"/"verification code"/"auth code"
// as a COMPOUND phrase (colon/equals-joined and space-joined) without ever
// matching bare `code`, since the phrase requires one of these four specific
// words immediately before it. Round-12 MEDIUM fix (finding 3): the word list
// itself now lives in why-redaction-keywords.ts (`CODE_ADJACENT_KEYWORD_
// ALTERNATION`) alongside every other keyword-ish list, instead of as a
// hand-written duplicate here.
const LABELED_CODE_PHRASE_PATTERN = new RegExp(
  `\\b((?:${CODE_ADJACENT_KEYWORD_ALTERNATION})[\\s-]*code)(\\s*[:=]\\s*)([^\\s"'\`]+)`,
  "gi"
);

const SPACE_SEPARATED_CODE_PHRASE_PATTERN = new RegExp(
  `\\b((?:${CODE_ADJACENT_KEYWORD_ALTERNATION})[\\s-]*code)(\\s+)([^\\s"'\`]+)`,
  "gi"
);

// Round-8 gate finding 1 (root-cause fix, filler-word regex bug): a
// recognized secret keyword followed by 0-2 filler words (pure letters —
// never itself an already-redacted "[redacted]" marker or a flag) then a
// value token redacts that value. Round 7 required AT LEAST ONE filler word
// (`{1,2}`), which silently missed the ZERO-filler case — a bare, unprefixed
// "password hunter2Aa1" or "PIN 482913" (keyword directly adjacent to its
// value, no "is"/"code" in between, no leading dash) matched neither this
// rule (needed a filler) nor SPACE_SEPARATED_SECRET_FLAG (needed a leading
// dash), so it leaked. `{0,2}` closes that gap at the regex level — this is
// a correctness fix to the pattern itself, independent of and in addition to
// round 8's numeric-exemption removal below (which is what actually makes
// this whole keyword-adjacency family NON-LOAD-BEARING for numeric secrets —
// see the module header's "keyword rules are defense-in-depth only" note).
const PROSE_SECRET_KEYWORD_PATTERN = new RegExp(
  `(\\b(?:${SECRET_KEYWORD_ALTERNATION})\\b(?:\\s+[A-Za-z]+){0,2}\\s+)([^\\s"'\`]+)`,
  "gi"
);

// A `scheme://...` URL that carries a userinfo component (`user:pass@host` or
// `user@host`) — generalizes round-3's Postgres-only reuse of
// scrubPgCredentials to mysql://, mongodb://, mongodb+srv://, redis://,
// https://user:pass@..., etc. Requires an `@` inside the authority segment
// (before the first `/` or whitespace) so a credential-FREE URL is left
// alone for stage 2's `SAFE_URL_NO_USERINFO` to allowlist instead (round-5
// MEDIUM fix — round 4's version redacted every URL unconditionally).
// scrubPgCredentials runs first so the Postgres case keeps its existing,
// slightly friendlier "postgres://[redacted]" partial-redaction shape; this
// is the generic backstop for every other scheme.
const CREDENTIAL_URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'`/@]*@[^\s"'`]*/gi;

// AWS access-key-id-shaped tokens (AKIA/ASIA/AGPA/AIDA/AROA/ANPA/ANVA
// prefixes are all real AWS credential-type prefixes) — redacted regardless
// of surrounding context, since these are unambiguously credential material
// wherever they appear.
const AWS_KEY_ID_PATTERN = /\b(AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{12,}\b/g;

// Well-known secret-token prefixes (round-5 gate's own adversarial probes:
// GitHub personal-access tokens, Stripe-style live keys, Anthropic API keys,
// npm tokens). Cheap, loud, defense-in-depth: even if a token like this
// appears in ordinary prose ("token ghp_XXXX is invalid"), it is redacted by
// context marker alone, before stage 2 ever has to reason about vocabulary.
const WELL_KNOWN_SECRET_PREFIX_PATTERN = /\b(ghp_|gho_|ghu_|ghs_|ghr_|sk_live_|sk_test_|sk-ant-|npm_)[A-Za-z0-9_-]+/g;

// mysqldump/mysql's `-p<password>` concatenated-value flag (no `=`, no space
// before the value) — round-4 adversarial fixture. Deliberately broad: any
// `-p<non-whitespace>` token is treated as this flag and its value redacted,
// even though this occasionally over-redacts an unrelated `-p` flag from
// another CLI (e.g. `-port`). Over-redaction here is the accepted trade-off;
// silently letting a password through because it wasn't preceded by "=" is not.
const MYSQL_CONCAT_PASSWORD_FLAG = /(^|\s)(-p)([^\s"'`]+)/g;

/** Round-9 HIGH fix: stage 1's labeled/space-separated/prose keyword rules
 * used to redact any value adjacent to a keyword UNCONDITIONALLY — they had
 * no visibility into `knownSafeTokens` at all, so a legitimate vocabulary
 * member (a task id, run id, or other structured value the collector itself
 * vouches for) redacted just because it happened to sit next to a keyword
 * (`"password task-abc123"` destroyed `task-abc123` even though stage 2
 * alone would have correctly kept it). A value that is an EXACT vocabulary
 * member survives even in a keyword-adjacent position — it is OUR id; it
 * cannot be the secret the keyword is labeling. `extractTokenCore` strips
 * incidental trailing punctuation (a comma, a period) before the membership
 * check, mirroring how stage 2 tokenizes, so a vocabulary value followed by
 * ordinary prose punctuation still matches. */
function redactValueUnlessVocabulary(value: string, knownSafeTokens: ReadonlySet<string>): string {
  return knownSafeTokens.has(extractTokenCore(value)) ? value : "[redacted]";
}

function applySecretMarkerRules(text: string, knownSafeTokens: ReadonlySet<string>): string {
  let result = scrubPgCredentials(text);
  result = result.replace(
    CREDENTIAL_URL_WITH_USERINFO,
    (_match, scheme: string) => `${scheme.toLowerCase()}://[redacted]`
  );
  result = result.replace(AWS_KEY_ID_PATTERN, "[redacted]");
  result = result.replace(WELL_KNOWN_SECRET_PREFIX_PATTERN, "[redacted]");
  result = result.replace(
    LABELED_CODE_PHRASE_PATTERN,
    (_match, label: string, sep: string, value: string) => `${label}${sep}${redactValueUnlessVocabulary(value, knownSafeTokens)}`
  );
  result = result.replace(
    SPACE_SEPARATED_CODE_PHRASE_PATTERN,
    (_match, label: string, sep: string, value: string) => `${label}${sep}${redactValueUnlessVocabulary(value, knownSafeTokens)}`
  );
  result = result.replace(
    LABELED_FIELD_PATTERN,
    (_match, label: string, sep: string, value: string) => `${label}${sep}${redactValueUnlessVocabulary(value, knownSafeTokens)}`
  );
  result = result.replace(
    SPACE_SEPARATED_SECRET_FLAG,
    (_match, flag: string, sep: string, value: string) => `${flag}${sep}${redactValueUnlessVocabulary(value, knownSafeTokens)}`
  );
  result = result.replace(
    PROSE_SECRET_KEYWORD_PATTERN,
    (_match, prefix: string, value: string) => `${prefix}${redactValueUnlessVocabulary(value, knownSafeTokens)}`
  );
  result = result.replace(/\bAuthorization:\s*[^\s"'`]+(?:\s+[^\s"'`]+)?/gi, "Authorization: [redacted]");
  result = result.replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [redacted]");
  result = result.replace(
    MYSQL_CONCAT_PASSWORD_FLAG,
    (_match, lead: string, flag: string, value: string) => `${lead}${flag}${redactValueUnlessVocabulary(value, knownSafeTokens)}`
  );
  return result;
}

// ---------------------------------------------------------------------------
// Stage 2 — vocabulary-anchored default-deny. Every token stage 1 didn't
// already redact is classified here. See the module header for the full
// allowlist contract and disclosure.
// ---------------------------------------------------------------------------

/** Bare flag shape (`--task-id`, `-h`, `--apply-safe`) — a GATE, not a grant;
 * see `isSafeFlagName` below for the round-12 fail-closed trust decision. */
const SAFE_FLAG_SHAPE = /^--?[A-Za-z][A-Za-z0-9-]*$/;

/** Matches a flag body that IS, EXACTLY, one canonical secret-keyword flag
 * spelling (`token`, `password`, `api-key`, …) — the designed, legitimate
 * case (`--token <value>`, `--password <value>`, `--api-key <value>`): the
 * flag name IS the label naming its own value, with nothing else attached.
 * Deliberately EXACT, not separator-tolerant — see
 * `why-redaction-keywords.ts`'s `CANONICAL_BARE_SECRET_KEYWORD_FLAGS` for why
 * recognition looseness has no place in a POSITIVE trust grant. */
const CANONICAL_BARE_SECRET_KEYWORD = new RegExp(`^(?:${CANONICAL_BARE_SECRET_KEYWORD_ALTERNATION})$`, "i");

/**
 * Round-12 CRITICAL fix — INVERTED the trust decision (rounds 10-11 each
 * widened keyword RECOGNITION and each left a bypass: two-plus separators,
 * an interposed digit, and any future recognition-defeating mutation would
 * have kept reintroducing the same bug class forever, because a
 * recognition MISS was treated as grounds to TRUST the whole flag body).
 * The fix is structural, not another regex patch: a flag body is now
 * emitted verbatim ONLY on a POSITIVE match against a bounded safe set —
 *
 *   (a) an EXACT, case-SENSITIVE member of the caller's `knownSafeTokens`
 *       vocabulary (closes the round-11 gate's own finding 4 — this was
 *       never wired in before), or
 *   (b) the flag body IS, EXACTLY, one canonical secret-keyword spelling,
 *       case-INSENSITIVE (`CANONICAL_BARE_SECRET_KEYWORD`; round-13 LOW,
 *       deliberate: `--TOKEN`/`--Password` are the SAME known keyword name in
 *       a different case, never a secret — unlike (a), a fixed spelling
 *       carries no caller-supplied data for case to narrow) — the designed labeled-flag case.
 *
 * EVERYTHING ELSE in flag position now redacts, including a flag with NO
 * keyword content at all (`--experimental-strip-types`, `--max-warnings`) —
 * an ACCEPTED, DOCUMENTED trade-off (round-12 MEDIUM, module header + design-
 * history's round-12 entry): rather than a hardcoded "well-known benign
 * flag" allowlist (its own forever-widening maintenance trap), a caller
 * threads a specific flag through `knownSafeTokens` — same mechanism task/
 * run ids already use. Keyword RECOGNITION (`SECRET_KEYWORD_ALTERNATION`) is
 * no longer consulted here at all — a miss can only cause MORE redaction, so
 * the bug class this function existed to close (rounds 10-12) ends by
 * construction: no separator/digit/case/unicode mutation converts a miss
 * into a leak again.
 */
function isSafeFlagName(token: string, knownSafeTokens: ReadonlySet<string>): boolean {
  if (!SAFE_FLAG_SHAPE.test(token)) return false;
  if (knownSafeTokens.has(token)) return true;
  const body = token.replace(/^--?/, "");
  return CANONICAL_BARE_SECRET_KEYWORD.test(body);
}

/** `--flag=value` — a SPLITTER, not a gate: both halves are re-validated
 * independently. The flag half is only safe if `isSafeFlagName` accepts it
 * (round-10: no longer trusted by dash-prefix shape alone — see
 * `isSafeFlagName`); the value half must still pass `isSafeValueShape` on
 * its own (vocabulary or structural shape). */
const SAFE_FLAG_VALUE_PAIR = /^(--?[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/;

/** Pure shell syntax (redirects, pipes, `&&`, bare `--`) — cannot itself carry
 * a secret since it has no alphanumeric content. */
const SHELL_OPERATOR = /^[-&|;<>()]+$/;

// Round-14: isBoundedSafeShape/isSafeValueShape/classifyUrlToken (UUID/ISO-
// timestamp/path-segment/URL-path-query shape checks — round-8 finding 2)
// now live in why-redaction-shapes.ts, extracted to give this file real
// ratchet headroom instead of sitting exactly at its frozen line cap.

const TOKEN_WRAPPER_PATTERN = /^([`"'(]*)([\s\S]*?)([`"'),.;]*)$/;

/**
 * Strips wrapper punctuation (quotes, backticks, parens, trailing prose
 * punctuation) from one whitespace-delimited token, returning its bare
 * "core". Exported so a caller building a `knownSafeTokens` vocabulary from
 * static command/path strings tokenizes IDENTICALLY to how free text is
 * scanned — a vocabulary entry tokenized differently would silently never
 * match (see `tokenizeToVocabulary` below).
 */
export function extractTokenCore(token: string): string {
  const match = TOKEN_WRAPPER_PATTERN.exec(token);
  return match?.[2] ?? token;
}

/**
 * Splits `text` on whitespace and extracts each token's bare core (dropping
 * empties) — the standard way to turn a static command template or sidecar
 * path string into vocabulary entries for `sanitizeFreeText`'s allowlist.
 */
export function tokenizeToVocabulary(text: string): string[] {
  return text
    .split(/\s+/)
    .map((piece) => extractTokenCore(piece))
    .filter((core) => core.length > 0);
}

/**
 * Classifies one whitespace-delimited token against the vocabulary + shape
 * allowlist. Wrapper punctuation is stripped before classification and
 * reattached after.
 *
 * Round-9 CRITICAL fix: a token whose core is EXACTLY the `[redacted]`
 * marker (stage 1 fully consumed it — nothing else to analyze) is left
 * alone. A token that merely CONTAINS `[redacted]` as a substring, glued to
 * OTHER untouched content with no whitespace (e.g. a URL query string where
 * stage 1's labeled-field rule redacted one `key=value` pair but left a
 * neighboring `&otherKey=stillLiveSecret` pair untouched in the SAME
 * whitespace token), is NOT given a free pass — it falls through to full
 * classification below, exactly like any other token. Every branch below
 * (`classifyUrlToken`'s per-piece analysis, the flag-value split, the final
 * catch-all) already replaces its ENTIRE matched scope rather than leaving
 * fragments, so re-running this pipeline on a partially-redacted token
 * correctly re-examines — and if unsafe, fully collapses — the untouched
 * remainder rather than exempting the whole token because ONE fragment of it
 * happened to already read `[redacted]`. The prior blanket
 * `core.includes("[redacted]")` short-circuit was the bug: it treated any
 * substring match as whole-token clearance, letting the untouched remainder
 * of a mixed token leak in full (live repro: `https://x.com/callback?
 * state=<secret>&password=<secret>` — stage 1 catches only the `password`
 * value; the old code then let `state=<secret>` through unexamined).
 */
function classifyToken(token: string, knownSafeTokens: ReadonlySet<string>): string {
  const match = TOKEN_WRAPPER_PATTERN.exec(token);
  const prefix = match?.[1] ?? "";
  const core = match?.[2] ?? token;
  const suffix = match?.[3] ?? "";
  if (core.length === 0) return token;
  if (core === "[redacted]") return token;

  if (SHELL_OPERATOR.test(core) || isSafeFlagName(core, knownSafeTokens)) {
    return token;
  }

  // URL-shaped tokens get their own rendering (authority kept, path+query
  // tokenized/wholesale-redacted — see `classifyUrlToken`) rather than a
  // plain safe/unsafe boolean, so check this BEFORE the generic shape check.
  const urlRendering = classifyUrlToken(core, knownSafeTokens);
  if (urlRendering !== undefined) {
    return `${prefix}${urlRendering}${suffix}`;
  }

  if (isSafeValueShape(core, knownSafeTokens)) {
    return token;
  }

  const flagValueMatch = SAFE_FLAG_VALUE_PAIR.exec(core);
  // The flag half of `--flag=value` must independently pass `isSafeFlagName`
  // (round-12 positive-match rule); if it doesn't, the WHOLE token falls
  // through to the catch-all, as if this branch had never matched.
  if (flagValueMatch && isSafeFlagName(flagValueMatch[1] ?? "", knownSafeTokens)) {
    const flag = flagValueMatch[1] ?? "";
    const value = flagValueMatch[2] ?? "";
    const valueUrlRendering = classifyUrlToken(value, knownSafeTokens);
    const safeValue =
      valueUrlRendering !== undefined
        ? valueUrlRendering
        : isSafeValueShape(value, knownSafeTokens)
          ? value
          : "[redacted]";
    return `${prefix}${flag}=${safeValue}${suffix}`;
  }

  return `${prefix}[redacted]${suffix}`;
}

/**
 * Sanitizes free text SOURCED FROM OUTSIDE this module — a hook-blocker's
 * recorded command/summary, a seed-failure reason, a daemon's recorded
 * reason/nextActions text, or any other caught-error message. Redacts by
 * default: only a token that is an exact member of `knownSafeTokens`, a flag
 * name, an ISO timestamp, a UUID, a path whose every segment passes the same
 * bounded checks, or a URL whose every path/query token passes them, survives
 * (round-8 terminal design — see the module header). A bare number no longer
 * survives by shape alone.
 *
 * `knownSafeTokens` defaults to an EMPTY set — a caller that doesn't supply a
 * vocabulary gets the strictest possible behavior, never a silent fallback
 * to shape-only trust.
 *
 * Do NOT call this on values the diagnosis layer generated itself (task ids,
 * run ids, role names, counts, its own recommended commands) — those are
 * structured, not free text, and should pass through `structured()` in
 * why-diagnosis.ts's `buildEvidence` instead.
 *
 * Round-12 HIGH fix: the input is capped to `MAX_SANITIZE_INPUT_LENGTH`
 * BEFORE the pipeline runs (truncate first, append `[truncated]`) — this is
 * what actually bounds the pipeline's runtime, not any regex-level tuning.
 */
export function sanitizeFreeText(
  text: string,
  knownSafeTokens: ReadonlySet<string> = EMPTY_VOCABULARY
): string {
  const wasTruncated = text.length > MAX_SANITIZE_INPUT_LENGTH;
  const capped = wasTruncated ? text.slice(0, MAX_SANITIZE_INPUT_LENGTH) : text;
  const marked = applySecretMarkerRules(capped, knownSafeTokens);
  const sanitized = marked
    .split(/(\s+)/)
    .map((piece) => (/^\s+$/.test(piece) || piece.length === 0 ? piece : classifyToken(piece, knownSafeTokens)))
    .join("");
  // The `[truncated]` marker is appended AFTER classification, as a literal
  // hardcoded suffix — never fed through `classifyToken` itself, so it can't
  // be mistaken for (or collapse into) a redacted token.
  return wasTruncated ? `${sanitized} [truncated]` : sanitized;
}

/** Truncates text to a safe display prefix, with an explicit ellipsis marker
 * when truncation occurred (never silently drops characters unmarked). */
export function truncateForDisplay(text: string, maxLength = MAX_COMMAND_DISPLAY_LENGTH): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/** Applies redaction then truncation — order matters: truncating first could
 * cut a token in half and hide it from the allowlist classifier, or worse,
 * cut a stage-1 marker match in half and leave a fragment of a secret
 * dangling past the truncation boundary. Redacting first guarantees nothing
 * unsafe survives regardless of where the truncation cut falls. */
export function sanitizeForDisplay(
  text: string,
  knownSafeTokens: ReadonlySet<string> = EMPTY_VOCABULARY
): string {
  return truncateForDisplay(sanitizeFreeText(text, knownSafeTokens));
}
