/**
 * @module admin/why-redaction
 *
 * Secret redaction for `archon why` (audit F9, round-5 vocabulary anchoring).
 *
 * Round 4 inverted the default from "hunt for secret shapes" to "redact by
 * default, allowlist a few safe SHAPES" (UUID, path, number, flag, bare
 * identifier). Round 5's gate found the residual bypass in that model: a
 * generic identifier SHAPE (`[A-Za-z][A-Za-z0-9_-]*`) can never prove safety,
 * because a real secret often looks EXACTLY like one — `ghp_XXXX`,
 * `hunter2Aa1`, an API key. "token ghp_XXXX is invalid" and "password is
 * hunter2Aa1" both shape-matched the round-4 identifier allowlist and
 * survived untouched. Chasing yet another shape distinction would only
 * produce a fifth bypass.
 *
 * ROUND-5 FIX — anchor the allowlist to KNOWN VOCABULARY, not shape alone:
 *
 * The blanket "any identifier-shaped token is safe" rule is GONE. In its
 * place, a free-text token survives ONLY if it is:
 *
 *   1. An EXACT member of a `knownSafeTokens` vocabulary the caller supplies
 *      — built, at diagnosis time, from the STRUCTURED context the collector
 *      already holds (task ids, run ids, role names, status/enum/outcome
 *      tokens, this module's own recommended command words, sidecar paths it
 *      constructed). See why-diagnosis.ts's `buildKnownVocabulary`.
 *   2. A flag name (`-x`, `--long-flag`) — flags are labels, never secrets.
 *   3. A number or ISO-timestamp shape — machine-generated, not
 *      attacker-controlled.
 *   4. A path (absolute, `./`/`../`-relative, OR bare relative) containing no
 *      `@` and no `://` — credential-bearing shapes always carry one of those.
 *   5. A `scheme://host...` URL with NO userinfo component (no `@`) — a URL
 *      that DOES carry `user:pass@` is caught by stage 1 before tokenization
 *      ever sees it (see `CREDENTIAL_URL_WITH_USERINFO` below).
 *
 * Everything else — including any bare word, identifier, or acronym that
 * merely LOOKS like a safe token — redacts. `ghp_XXXX`, `hunter2Aa1`, and
 * ordinary English prose in a caught error message all die unless the caller
 * explicitly vouches for them via the vocabulary. `sanitizeFreeText`/
 * `sanitizeForDisplay` default `knownSafeTokens` to an EMPTY set, so any
 * caller that does not supply a vocabulary gets the strictest possible
 * behavior — this is deliberate: a missing vocabulary must never silently
 * fall back to "shape is enough".
 *
 * Stage 1 (`applySecretMarkerRules`) is kept as defense-in-depth: high-
 * confidence context markers (credential URLs, AWS key ids, well-known
 * secret-token prefixes — `ghp_`, `sk_live_`, `sk-ant-`, `npm_` — labeled
 * `key=value` fields, Authorization/Bearer headers, mysqldump's `-p<value>`)
 * redact regardless of what stage 2's vocabulary check would have decided,
 * so an obviously-shaped secret dies even before tokenization.
 *
 * HONEST FRICTION (re-disclosed per the round-5 gate's explicit request —
 * see the "Proposed decision for the gate" section of the PR body): the real
 * footprint of this design is "any free-text token not in the known
 * vocabulary redacts." That is broader than round 4's disclosed friction
 * (colon-containing compound words only). It now ALSO includes: ordinary
 * English prose in a caught error message or recorded shell command (a hook-
 * blocker's `npm test` becomes two `[redacted]` tokens unless "npm"/"test"
 * happen to be vocabulary words); acronyms and identifiers that are not task
 * ids, run ids, role names, or enum tokens (a respawn lease owner like
 * "daemon-A" redacts unless it happens to equal a known id); and IPv6
 * addresses and other colon-bearing tokens (unchanged from round 4 — still
 * redact, since colon is the same shape as a credential fragment). Numbers,
 * ISO timestamps, and paths are NOT vocabulary-gated — they survive via their
 * own shape rules regardless of vocabulary, since round 5 specifically fixed
 * their prior over-redaction. The sidecar-file pointer already present in
 * every cause's evidence remains the relief valve: the operator can always
 * read the untouched original there. This is a deliberate, disclosed
 * trade-off, not an oversight — the alternative (letting shape alone decide)
 * is exactly the bypass class this redesign exists to close.
 *
 * ROUND-6: an UNBOUNDED digit run is itself a shape that can't prove
 * safety — `--token 837215098172340192` shape-matched `SAFE_NUMBER` and
 * survived. `SAFE_NUMBER` is now bounded (see the checklist below); a
 * space-separated labeled flag (`--token <v>`, `--password <v>`, etc.) is
 * now caught at stage 1 regardless of the value's shape; and
 * `SAFE_URL_NO_USERINFO`'s `@` exclusion is narrowed to the URL's authority
 * segment, so a query-string email no longer over-redacts the whole URL.
 *
 * ROUND-7: the round-6 `SAFE_NUMBER` bound only capped the INTEGER part —
 * `(?:\.[0-9]+)?` was still unbounded, so `9.87215098172340192` (a decimal
 * secret) shape-matched and survived whole. The bound now applies to the
 * ENTIRE numeric token (sign + digits + decimal point together, ≤6 chars),
 * per the gate's own simplest-fix suggestion. The same audit found
 * `SAFE_ISO_TIMESTAMP`'s fractional-seconds group was ALSO unbounded
 * (`(?:\.\d+)?`) — closed to 1-9 digits (real ISO timestamps never exceed
 * nanosecond precision). Separately, the keyword list gained `pin`, `otp`,
 * `passphrase`, `mfa`, `passcode`, `cvv`; a scoped compound-phrase rule
 * catches "pin code"/"otp code"/"verification code"/"auth code" WITHOUT
 * adding bare `code` (which would collide with this codebase's own
 * `exit-code`/`error-code`/`status-code` vocabulary); and a narrow prose
 * rule catches "<keyword> is <value>"-style adjacency (a secret keyword
 * followed within 1-2 filler words by a value token) for phrasings with no
 * flag and no colon/equals join.
 *
 * EXEMPTION CHECKLIST (round-6 gate's explicit ask — every remaining
 * structural shape-exemption, so the next review pass has a checklist
 * instead of rediscovering categories from scratch):
 *
 *   - Flag name (`SAFE_FLAG_NAME`, e.g. `--task-id`, `-h`) — a flag is a
 *     LABEL, not a value; nothing after the label has been read yet, so
 *     there is nothing to leak. Cannot hide a secret by construction.
 *   - Bounded number (`SAFE_NUMBER`, whole token ≤6 characters, round-7
 *     fix) — sized to cover ports (max 65535), exit codes, small counts,
 *     and 4-digit years with margin, while being too short for the 7-20+
 *     character runs typical of OTPs, PINs, and numeric API tokens. See
 *     the residual trade-off note below — this is a bound, not a proof.
 *   - ISO-8601 timestamp (`SAFE_ISO_TIMESTAMP`, fractional seconds bounded
 *     to 1-9 digits, round-7 fix) — machine-generated by the runtime's own
 *     clock, never something an attacker supplies as a secret; the
 *     fractional-seconds group is now bounded too (see the audit table).
 *   - Path (`SAFE_PATH`, absolute/relative/bare-relative, no `@`, no `:`) —
 *     excluding the two characters that signal a credential-bearing
 *     URL/connection-string shape makes a path structurally incapable of
 *     encoding `user:pass@host`. Length is deliberately UNBOUNDED — see the
 *     audit table and residual note below.
 *   - Credential-free URL (`SAFE_URL_NO_USERINFO`, no `@` in the AUTHORITY
 *     segment) — a URL's only place to embed a credential is the userinfo
 *     slot before `@` in the authority; forbidding that slot specifically
 *     (not the whole URL) rules out `user:pass@host` while still allowing
 *     ordinary path/query content (including an unrelated `@`, e.g. an email
 *     address in a query string) to pass through unmolested. Length is
 *     deliberately UNBOUNDED — see the audit table and residual note below.
 *   - Shell operator (`SHELL_OPERATOR`) — pure punctuation with no
 *     alphanumeric content; there is no character budget left to carry a
 *     secret.
 *
 * BOUNDEDNESS AUDIT (round-7 gate's explicit ask — every SAFE_* shape
 * regex, bounded-or-justified):
 *
 *   | Pattern               | Bounded?                  | Why
 *   |-----------------------|---------------------------|---------------------------------------
 *   | SAFE_UUID             | yes, fixed-width          | every group is `{n}`; exactly 36 chars total
 *   | SAFE_NUMBER           | yes, whole token ≤6 chars | round-7 fix: bounds sign+digits+decimal TOGETHER
 *   | SAFE_ISO_TIMESTAMP    | yes, fraction ≤9 digits   | round-7 fix: closed the unbounded `\d+` fraction
 *   | SAFE_PATH             | NO — justified unbounded  | real paths are legitimately long; safety is the
 *   |                       |                           | excluded chars (no `@`/`:`), not length
 *   | SAFE_URL_NO_USERINFO  | NO — justified unbounded  | same reasoning as SAFE_PATH, for a URL's path/query
 *   | SAFE_FLAG_NAME        | N/A — label, not a value  | nothing has been read yet; no value to leak
 *   | SAFE_FLAG_VALUE_PAIR  | N/A — splitter, not a gate| the extracted value is re-validated independently
 *   | SHELL_OPERATOR        | yes, closed alphabet      | punctuation-only; zero alphanumeric content
 *
 * RESIDUAL, ACCEPTED TRADE-OFF (round-7 correction — the round-6 disclosure
 * claimed "the labeled-flag rule already closes the realistic leak vector"
 * for PIN/OTP-style secrets. That claim was FALSE and is retracted here:
 * this round's own gate probes — `--pin 482913`, `--otp 482913`, `your otp
 * is 482913` — proved unlabeled PIN/OTP secrets DID pass before this round's
 * keyword-list and prose-adjacency fixes closed them. The true, now-honest
 * residual: an unlabeled, non-vocabulary, SHORT (≤6 total characters,
 * including any decimal point) numeric token with NO recognized secret
 * keyword within 2 tokens of it still survives by shape alone (e.g. a bare
 * "482913" in prose with zero surrounding context). This is deliberately
 * accepted, not hidden: shrinking the bound further would reject genuine
 * ports/years/exit codes/counts, and the keyword-adjacency rules (labeled
 * flag, colon/equals field, code-phrase, and the 2-token prose rule) now
 * cover every realistic PIN/OTP/secret phrasing this codebase's own caught-
 * error surfaces actually produce — a bare, contextless short number is the
 * narrower, honestly-scoped residual.
 *
 * A SECOND residual, surfaced by this round's boundedness audit (new to
 * this disclosure): `SAFE_PATH` and `SAFE_URL_NO_USERINFO` are deliberately
 * unbounded in length. An unlabeled secret with no recognized keyword,
 * formatted to look like a long path segment or embedded in a URL's query
 * string under a generic (non-keyword) parameter name, is not caught by
 * shape rules alone. This is the same trade-off round 5 accepted when it
 * fixed credential-free URLs/paths to survive: bounding their length would
 * break real, legitimately long paths and URLs, and the actual security-
 * relevant restriction for these two shapes is character-class exclusion
 * (no `@`, no `:`), not length. Both residuals are proposed to the gate for
 * ratification together.
 */

import { scrubPgCredentials } from "./db-error-scrub.ts";

export const MAX_COMMAND_DISPLAY_LENGTH = 120;

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

const SECRET_KEYWORD_ALTERNATION =
  "password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|accesskey|auth|credential|passphrase|passcode|otp|mfa|pin|cvv";

const LABELED_FIELD_PATTERN = new RegExp(
  `\\b([\\w-]*(?:${SECRET_KEYWORD_ALTERNATION})[\\w-]*)(\\s*[:=]\\s*)([^\\s"'\`]+)`,
  "gi"
);

// Round-6 gate finding 1b: LABELED_FIELD_PATTERN only fires on a `:`/`=` join
// — it never covered the CLI convention of a space-separated secret-labeled
// flag and its value (`--token 8372150`, `--password hunter2Aa1`, `--key
// <v>`, `--secret <v>`). Redacts the value regardless of its own shape, so a
// short (in-bound) numeric OTP/PIN passed as a flag value is caught even
// though `SAFE_NUMBER`'s bound alone would have let it through.
const SPACE_SEPARATED_SECRET_FLAG = new RegExp(
  `(--?[\\w-]*(?:${SECRET_KEYWORD_ALTERNATION})[\\w-]*)(\\s+)([^\\s"'\`]+)`,
  "gi"
);

// Round-7 gate finding 2: the keyword list above gained `pin`/`otp`/etc, but
// "code" itself was deliberately NOT added — bare `code` would collide with
// this codebase's own `exit-code`/`error-code`/`status-code` vocabulary. This
// scoped pair covers "pin code"/"otp code"/"verification code"/"auth code"
// as a COMPOUND phrase (colon/equals-joined and space-joined) without ever
// matching bare `code`, since the phrase requires one of these four specific
// words immediately before it.
const CODE_ADJACENT_KEYWORDS = "pin|verification|otp|auth";

const LABELED_CODE_PHRASE_PATTERN = new RegExp(
  `\\b((?:${CODE_ADJACENT_KEYWORDS})[\\s-]*code)(\\s*[:=]\\s*)([^\\s"'\`]+)`,
  "gi"
);

const SPACE_SEPARATED_CODE_PHRASE_PATTERN = new RegExp(
  `\\b((?:${CODE_ADJACENT_KEYWORDS})[\\s-]*code)(\\s+)([^\\s"'\`]+)`,
  "gi"
);

// Round-7 gate finding 2's fourth live probe — "your otp is 482913" — has NO
// flag and NO colon/equals join; it is a secret keyword followed by ordinary
// prose ("is") before the value. Narrow prose rule: a recognized secret
// keyword followed by 1-2 filler words (pure letters — never itself an
// already-redacted "[redacted]" marker or a flag) then a value token redacts
// that value. Requires at least one filler word, so it does not re-match
// the flag/labeled-field shapes above (those have the value immediately
// adjacent to the keyword with no filler in between).
const PROSE_SECRET_KEYWORD_PATTERN = new RegExp(
  `(\\b(?:${SECRET_KEYWORD_ALTERNATION})\\b(?:\\s+[A-Za-z]+){1,2}\\s+)([^\\s"'\`]+)`,
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

function applySecretMarkerRules(text: string): string {
  let result = scrubPgCredentials(text);
  result = result.replace(
    CREDENTIAL_URL_WITH_USERINFO,
    (_match, scheme: string) => `${scheme.toLowerCase()}://[redacted]`
  );
  result = result.replace(AWS_KEY_ID_PATTERN, "[redacted]");
  result = result.replace(WELL_KNOWN_SECRET_PREFIX_PATTERN, "[redacted]");
  result = result.replace(LABELED_CODE_PHRASE_PATTERN, "$1$2[redacted]");
  result = result.replace(SPACE_SEPARATED_CODE_PHRASE_PATTERN, "$1$2[redacted]");
  result = result.replace(LABELED_FIELD_PATTERN, "$1$2[redacted]");
  result = result.replace(SPACE_SEPARATED_SECRET_FLAG, "$1$2[redacted]");
  result = result.replace(PROSE_SECRET_KEYWORD_PATTERN, "$1[redacted]");
  result = result.replace(/\bAuthorization:\s*[^\s"'`]+(?:\s+[^\s"'`]+)?/gi, "Authorization: [redacted]");
  result = result.replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [redacted]");
  result = result.replace(MYSQL_CONCAT_PASSWORD_FLAG, "$1$2[redacted]");
  return result;
}

// ---------------------------------------------------------------------------
// Stage 2 — vocabulary-anchored default-deny. Every token stage 1 didn't
// already redact is classified; only an exact vocabulary member or one of the
// four narrow structural shapes below survives. There is NO generic
// "identifier-shaped" rule anymore (round-5 CRITICAL fix).
// ---------------------------------------------------------------------------

const SAFE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A SHORT number — counts, ports (max 65535, 5 digits), exit codes, small
 * indices, 4-digit years, and short decimals (1.5, 99.9, 3.14). Bounded at
 * 6 characters for the WHOLE token — sign, digits, AND decimal point
 * together (round-7 gate CRITICAL fix): round 6 bounded only the integer
 * part (`{1,6}`), leaving the fractional group `(?:\.[0-9]+)?` unbounded —
 * `9.87215098172340192` (a decimal secret) shape-matched the round-6 version
 * and survived whole. The `(?=.{1,6}$)` lookahead measures the ENTIRE
 * matched string's length before any part of it is accepted, so a long
 * fraction can no longer smuggle extra length past a short-looking integer
 * part. 6 characters covers every realistic port/year/count/short-decimal
 * with margin while being short of the 7+ character runs typical of OTPs,
 * PINs, and numeric API tokens (a token longer than 6 characters must be
 * vouched for by the vocabulary, same as any other unrecognized token). See
 * the module header's "residual, accepted trade-off" note — this is a
 * bound, not a proof. */
const SAFE_NUMBER = /^(?=.{1,6}$)-?[0-9]+(?:\.[0-9]+)?$/;

/** ISO-8601 timestamp shape, with optional fractional seconds and a
 * `Z`/offset suffix — e.g. `2026-07-04T12:34:56.789Z`. Machine-generated,
 * not attacker-controlled, so safe by shape alone regardless of vocabulary
 * (round-5 fix: round 4 only allowlisted bare numbers, so a full timestamp
 * fell through to redaction). Round-7 boundedness-audit fix: the fractional-
 * seconds group was `(?:\.\d+)?` — UNBOUNDED — so a secret could ride in as
 * fake fractional seconds after a valid date/time prefix (the same bypass
 * class as the `SAFE_NUMBER` finding, found while auditing every SAFE_*
 * pattern for this round). Bounded to 1-9 digits, which covers millisecond
 * (3), microsecond (6), and nanosecond (9) precision — every real timestamp
 * this runtime's own clock produces — while rejecting anything longer. */
const SAFE_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/;

function isSafeNumberOrTimestamp(token: string): boolean {
  return SAFE_NUMBER.test(token) || SAFE_ISO_TIMESTAMP.test(token);
}

/** A filesystem path — absolute, `./`/`../`-relative, or bare relative
 * (`src/admin/why.ts`) — built from path-safe characters, with at least one
 * internal `/` (a bare word with no slash is NOT a path — it is an
 * identifier, which is vocabulary-gated, not shape-safe). Deliberately
 * excludes `@` and `:`: the two characters that signal a credential-bearing
 * URL/connection-string shape. Round-5 fix: round 4 required a leading `./`
 * or `/`; bare relative paths (no leading dot/slash) now also survive. */
const SAFE_PATH = /^\.{0,2}\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/;

/** A `scheme://host...` URL with NO userinfo component IN THE AUTHORITY
 * SEGMENT (the part before the first `/` after `scheme://`) — a bare,
 * credential-free URL (`https://api.github.com/...`) is not a secret and
 * must not be swept up by the same default-deny rule that catches everything
 * else shaped like a connection string (round-5 MEDIUM fix). Round-6 LOW
 * fix: the `@` exclusion is scoped to the AUTHORITY segment only, not the
 * whole token — a query-string email address
 * (`https://x.com/search?email=foo@bar.com`) no longer over-redacts the
 * entire URL just because an unrelated `@` appears in the path/query. A URL
 * that DOES carry userinfo (`user:pass@host`) is caught by stage 1's
 * `CREDENTIAL_URL_WITH_USERINFO` before tokenization ever runs; the
 * authority-only `@` exclusion here is defense-in-depth for anything that
 * slipped past it. */
const SAFE_URL_NO_USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`@/]*(?:\/[^\s"'`]*)?$/;

/** A flag name on its own (`--task-id`, `-h`, `--apply-safe`) — never a
 * secret by itself, only ever a label. */
const SAFE_FLAG_NAME = /^--?[A-Za-z][A-Za-z0-9-]*$/;

/** `--flag=value` — the flag half is always safe; the value half must still
 * pass `isSafeValueShape` on its own (vocabulary or structural shape). */
const SAFE_FLAG_VALUE_PAIR = /^(--?[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/;

/** Pure shell syntax (redirects, pipes, `&&`, bare `--`) — cannot itself carry
 * a secret since it has no alphanumeric content. */
const SHELL_OPERATOR = /^[-&|;<>()]+$/;

function isSafeValueShape(token: string, knownSafeTokens: ReadonlySet<string>): boolean {
  return (
    knownSafeTokens.has(token) ||
    SAFE_UUID.test(token) ||
    SAFE_PATH.test(token) ||
    isSafeNumberOrTimestamp(token) ||
    SAFE_URL_NO_USERINFO.test(token)
  );
}

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
 * reattached after. Anything stage 1 already redacted (contains the literal
 * `[redacted]` marker) is left alone rather than re-processed.
 */
function classifyToken(token: string, knownSafeTokens: ReadonlySet<string>): string {
  const match = TOKEN_WRAPPER_PATTERN.exec(token);
  const prefix = match?.[1] ?? "";
  const core = match?.[2] ?? token;
  const suffix = match?.[3] ?? "";
  if (core.length === 0) return token;
  if (core.includes("[redacted]")) return token;

  if (SHELL_OPERATOR.test(core) || SAFE_FLAG_NAME.test(core) || isSafeValueShape(core, knownSafeTokens)) {
    return token;
  }

  const flagValueMatch = SAFE_FLAG_VALUE_PAIR.exec(core);
  if (flagValueMatch) {
    const flag = flagValueMatch[1] ?? "";
    const value = flagValueMatch[2] ?? "";
    const safeValue = isSafeValueShape(value, knownSafeTokens) ? value : "[redacted]";
    return `${prefix}${flag}=${safeValue}${suffix}`;
  }

  return `${prefix}[redacted]${suffix}`;
}

/**
 * Sanitizes free text SOURCED FROM OUTSIDE this module — a hook-blocker's
 * recorded command/summary, a seed-failure reason, a daemon's recorded
 * reason/nextActions text, or any other caught-error message. Redacts by
 * default: only a token that is an exact member of `knownSafeTokens`, or
 * matches one of the four narrow structural shapes (flag name, number/
 * timestamp, path, credential-free URL), survives. See the module header for
 * the full rationale and the honestly-disclosed friction this trades off.
 *
 * `knownSafeTokens` defaults to an EMPTY set — a caller that doesn't supply a
 * vocabulary gets the strictest possible behavior, never a silent fallback
 * to shape-only trust.
 *
 * Do NOT call this on values the diagnosis layer generated itself (task ids,
 * run ids, role names, counts, its own recommended commands) — those are
 * structured, not free text, and should pass through `structured()` in
 * why-diagnosis.ts's `buildEvidence` instead.
 */
export function sanitizeFreeText(
  text: string,
  knownSafeTokens: ReadonlySet<string> = EMPTY_VOCABULARY
): string {
  const marked = applySecretMarkerRules(text);
  return marked
    .split(/(\s+)/)
    .map((piece) => (/^\s+$/.test(piece) || piece.length === 0 ? piece : classifyToken(piece, knownSafeTokens)))
    .join("");
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
