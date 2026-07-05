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
 * ROUND-8 — TERMINAL DESIGN, numeric exemption removed. Round 7's own gate
 * probing found the keyword layer leaking AGAIN (a filler-word regex bug
 * plus roughly a dozen adjacent phrasings — `2FA:`, `--code`, `recovery
 * code`, `backup code`, `security code`, `activation code`, `license key`,
 * `session id`, `CVC`, `TOTP`, `PIN number`, ...). Seven rounds proved the
 * pattern conclusively: enumerated labeling CANNOT converge — there is
 * always another synonym, another join form, another phrasing the list
 * hasn't seen yet. This round removes the load-bearing enumeration itself
 * rather than adding a 13th/14th/15th keyword:
 *
 *   1. THE FREE-TEXT NUMERIC SHAPE-EXEMPTION IS GONE. A bare number in free
 *      text now survives ONLY as an exact vocabulary member (ISO timestamps
 *      keep their own bounded shape-safety — they are machine-generated, not
 *      attacker-supplied, an entirely different case). Rationale: every
 *      number that matters to a diagnosis — ports, exit codes, counts,
 *      respawn cycles — reaches output through this module's STRUCTURED
 *      evidence fields (why-diagnosis.ts's `structured()`), which never call
 *      `sanitizeFreeText` at all. The free-text numeric exemption was never
 *      load-bearing for legitimate output; it was prose cosmetics, and it was
 *      the ONE remaining shape a secret could still hide behind after round
 *      5's identifier-shape fix. With it gone, a numeric secret dies in
 *      EVERY phrasing — `pin code is 482913`, `2FA: 482913`, `--code
 *      482913`, `recovery code 482913`, bare `482913` — with ZERO keyword
 *      dependence. This closes the entire round-6/7 keyword-enumeration bug
 *      CLASS in one structural move.
 *   2. PATHS AND URLS ARE NOW TOKENIZED, NOT EXEMPTED WHOLESALE. A URL keeps
 *      its scheme+authority (that identifies WHERE, not WHAT) but its
 *      path+query is only kept if EVERY token in it independently passes
 *      vocabulary/shape checks — otherwise the whole path+query collapses to
 *      `scheme://host/[redacted]`. A free-text path survives only if EVERY
 *      `/`-separated segment is a vocabulary member or a bounded safe shape
 *      — otherwise the WHOLE token redacts. Collector-constructed sidecar
 *      paths are added to the vocabulary as one whole string (they contain no
 *      whitespace, so `tokenizeToVocabulary` never splits them), so real
 *      evidence paths keep rendering via ordinary exact-match membership —
 *      that is the relief valve, by design, not by luck.
 *   3. THE FILLER-WORD REGEX BUG IS FIXED AT ROOT (a correctness bug,
 *      independent of finding 1 above): the prose-adjacency rule required
 *      AT LEAST ONE filler word between a keyword and its value, so a bare,
 *      unprefixed "password hunter2Aa1" or "PIN 482913" — keyword directly
 *      adjacent to its value, no "is"/"code" in between, no leading dash —
 *      matched neither that rule (needed a filler) nor the space-separated
 *      flag rule (needed a leading dash), and leaked. The filler count is now
 *      `{0,2}`, closing that gap regardless of whether the value is numeric.
 *   4. THE KEYWORD RULES ARE NOW EXPLICITLY DOCUMENTED AS PURE DEFENSE-IN-
 *      DEPTH, NON-LOAD-BEARING. They still run (cheap, and they still catch
 *      alphanumeric secrets like `hunter2Aa1` a beat earlier / with clearer
 *      evidence-value shape), but the SECURITY BOUNDARY is now the
 *      vocabulary-anchored default-deny applied uniformly to every free-text
 *      token, numeric or not. A future keyword gap (a synonym this list
 *      doesn't know) is explicitly NOT a valid finding against this design —
 *      the numeric case it would have exposed is already closed by finding 1,
 *      and a non-numeric case was already closed by round 5's identifier-
 *      shape removal (an unrecognized alphanumeric token was NEVER
 *      shape-exempt; it has always required vocabulary membership).
 *
 * EXEMPTION CHECKLIST (every remaining structural shape-exemption, kept up
 * to date so the next review pass has a checklist instead of rediscovering
 * categories from scratch):
 *
 *   - Flag name (`SAFE_FLAG_NAME`, e.g. `--task-id`, `-h`) — a flag is a
 *     LABEL, not a value; nothing after the label has been read yet, so
 *     there is nothing to leak. Cannot hide a secret by construction.
 *   - ISO-8601 timestamp (`SAFE_ISO_TIMESTAMP`, fractional seconds bounded
 *     to 1-9 digits, round-7 fix) — machine-generated by the runtime's own
 *     clock, never something an attacker supplies as a secret. The ONLY
 *     numeric-adjacent shape still safe without vocabulary backing
 *     (round-8) — a bare integer/decimal is not.
 *   - UUID (`SAFE_UUID`) — fixed-width, every group is `{n}`, exactly 36
 *     characters total; machine-generated, and the fixed width leaves no
 *     room to smuggle variable-length secret data.
 *   - Path segment / URL path-query token (`isBoundedSafeShape`, reused by
 *     `isSafePathToken`/`classifyUrlToken`, round-8) — a vocabulary member,
 *     UUID, or ISO timestamp appearing as ONE segment/token of an otherwise
 *     path- or URL-shaped token. A path or URL survives WHOLE only if EVERY
 *     one of its segments/tokens independently passes this check; otherwise
 *     the entire token (or, for URLs, the entire path+query) redacts. Length
 *     is deliberately UNBOUNDED at the path/URL-structure level — real paths
 *     and URLs are legitimately long, and the actual security-relevant
 *     restriction is exclusion of `@`/`:` (credential-bearing shapes), not
 *     length. See the residual note below.
 *   - Shell operator (`SHELL_OPERATOR`) — pure punctuation with no
 *     alphanumeric content; there is no character budget left to carry a
 *     secret.
 *
 * BOUNDEDNESS AUDIT (kept current — every SAFE_* shape regex, bounded or
 * justified):
 *
 *   | Pattern               | Bounded?                  | Why
 *   |-----------------------|---------------------------|---------------------------------------
 *   | SAFE_UUID             | yes, fixed-width          | every group is `{n}`; exactly 36 chars total
 *   | SAFE_ISO_TIMESTAMP    | yes, fraction ≤9 digits   | round-7 fix: closed the unbounded `\d+` fraction
 *   | SAFE_FLAG_NAME        | N/A — label, not a value  | nothing has been read yet; no value to leak
 *   | SAFE_FLAG_VALUE_PAIR  | N/A — splitter, not a gate| the extracted value is re-validated independently
 *   | SHELL_OPERATOR        | yes, closed alphabet      | punctuation-only; zero alphanumeric content
 *   | PATH_LIKE_SHAPE       | N/A — gate, not a grant   | only decides ELIGIBILITY for per-segment checks
 *   | URL_STRUCTURE         | N/A — gate, not a grant   | only decides ELIGIBILITY for per-token checks
 *   (there is no `SAFE_NUMBER` and no blanket `SAFE_PATH`/`SAFE_URL_NO_USERINFO`
 *   as of round 8 — see the "numeric exemption removed" / "tokenized" notes above)
 *
 * RESIDUAL, ACCEPTED TRADE-OFF (round-8, replaces every prior round's
 * numeric-bound disclosure — that entire category of residual is GONE, not
 * shrunk): nothing survives by shape alone except an exact vocabulary
 * member, an ISO timestamp, a UUID, a flag name, or a path/URL every one of
 * whose segments/tokens independently passes one of those same checks. A
 * bare number — no matter how short — no longer has any shape-only path to
 * survival; it must be vouched for by the vocabulary, exactly like any other
 * unrecognized token. The residual that remains is the same one round 5
 * already disclosed and this round does not change: paths and URLs are
 * deliberately UNBOUNDED in length (bounding them would break real,
 * legitimately long paths and URLs), so an unlabeled secret with no
 * recognized keyword, formatted to look like a long path segment or a URL
 * query token that ALSO happens to be a vocabulary member or a UUID/
 * timestamp shape, is still a residual (this is an extremely narrow,
 * already-accepted case — a secret would have to itself collide with a
 * bounded safe shape, not merely look path/URL-adjacent). Proposed to the
 * gate for ratification as the FINAL disclosure for this design.
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
// already redact is classified. ROUND-8 TERMINAL DESIGN: the free-text
// numeric shape-exemption is GONE — a bare number now survives ONLY as an
// exact vocabulary member (or as part of an ISO timestamp, which stays
// shape-safe — it is machine-generated, never attacker-supplied). Every
// number that matters to a diagnosis reaches output through this module's
// STRUCTURED evidence fields (why-diagnosis.ts's `structured()` — task ids,
// respawn counts/budgets, ranks — never `sanitizeFreeText`), so the free-text
// numeric exemption was never load-bearing for legitimate output; it was
// prose cosmetics that seven rounds of keyword whack-a-mole (rounds 6-7)
// tried and failed to patch around. Removing it closes every numeric-secret
// leak in ONE structural move, regardless of what label precedes the number —
// see the module header for the full disclosure and the "keyword rules are
// now pure defense-in-depth" framing.
// ---------------------------------------------------------------------------

const SAFE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** ISO-8601 timestamp shape, with optional fractional seconds and a
 * `Z`/offset suffix — e.g. `2026-07-04T12:34:56.789Z`. Machine-generated,
 * not attacker-controlled, so safe by shape alone regardless of vocabulary
 * (round-5 fix: round 4 only allowlisted bare numbers, so a full timestamp
 * fell through to redaction; round-7 bounded the fractional-seconds group to
 * 1-9 digits, closing an identical unbounded-digit-run bypass). This is the
 * ONLY numeric-adjacent shape that still survives without vocabulary backing
 * (round-8 terminal design) — a bare integer or decimal no longer does. */
const SAFE_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** A flag name on its own (`--task-id`, `-h`, `--apply-safe`) — never a
 * secret by itself, only ever a label. */
const SAFE_FLAG_NAME = /^--?[A-Za-z][A-Za-z0-9-]*$/;

/** `--flag=value` — the flag half is always safe; the value half must still
 * pass `isSafeValueShape` on its own (vocabulary or structural shape). */
const SAFE_FLAG_VALUE_PAIR = /^(--?[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/;

/** Pure shell syntax (redirects, pipes, `&&`, bare `--`) — cannot itself carry
 * a secret since it has no alphanumeric content. */
const SHELL_OPERATOR = /^[-&|;<>()]+$/;

/** The bounded, non-vocabulary shapes that can still prove safety on their
 * own: an exact vocabulary member, a UUID (fixed-width, machine-generated),
 * or an ISO timestamp (fixed-format, machine-generated). Reused both for
 * plain-token classification AND for classifying the individual SEGMENTS of
 * a path or the individual TOKENS inside a URL's path/query (round-8 finding
 * 2) — "bounded safe shape" is now one well-defined concept applied
 * uniformly everywhere a value needs proving, not a per-context ad hoc list. */
function isBoundedSafeShape(token: string, knownSafeTokens: ReadonlySet<string>): boolean {
  return knownSafeTokens.has(token) || SAFE_UUID.test(token) || SAFE_ISO_TIMESTAMP.test(token);
}

/** Shape GATE (not a safety grant) for "this token looks like a path" —
 * absolute, `./`/`../`-relative, or bare relative, with at least one internal
 * `/`, built from path-safe characters, excluding `@` and `:` (the two
 * characters that signal a credential-bearing URL/connection-string shape).
 * Passing this gate only means the token is ELIGIBLE for per-segment
 * analysis in `isSafePathToken` below — round-8 finding 2 removed the old
 * blanket "any path-shaped token survives" allowlist (round-5/6's `SAFE_PATH`
 * granted safety by shape alone; that is gone). */
const PATH_LIKE_SHAPE = /^\.{0,2}\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/;

/** Round-8 finding 2: a free-text path survives ONLY if EVERY segment is a
 * vocabulary member or a bounded safe shape (UUID/ISO-timestamp) — otherwise
 * the ENTIRE token redacts (never a per-segment partial redaction, which
 * would fragment the path into something unreadable and still leak the
 * segments that "happened" to look safe). In practice: a collector-
 * constructed sidecar path (e.g. `.archon/work/daemon/hook-blocker-
 * state.json`) is added to the vocabulary as ONE WHOLE STRING by
 * `tokenizeToVocabulary` (it contains no whitespace, so it is never split
 * into per-segment vocabulary entries) — so real evidence paths render via
 * plain exact-match membership, checked before this function is ever called.
 * This per-segment path is the fallback for a path-shaped token that is NOT
 * already a whole-string vocabulary member. */
function isSafePathToken(token: string, knownSafeTokens: ReadonlySet<string>): boolean {
  if (!PATH_LIKE_SHAPE.test(token)) return false;
  const segments = token.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  return segments.every((segment) => isBoundedSafeShape(segment, knownSafeTokens));
}

/** `scheme://authority...` structure — captures the scheme, the authority
 * segment (host[:port], no userinfo — a URL WITH userinfo is caught by
 * stage 1's `CREDENTIAL_URL_WITH_USERINFO` before this ever runs), and
 * everything after the authority (the path+query "rest", if any). */
const URL_STRUCTURE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s"'`@/]*)(\/[^\s"'`]*)?$/;

/** Round-8 finding 2: a URL's authority (scheme + host) is safe by shape —
 * it identifies WHERE, not WHAT — but the path+query is free-text content an
 * attacker (or an accidental leak) can put anything into, including an
 * unlabeled secret as a query value. Round-5/6's `SAFE_URL_NO_USERINFO`
 * granted the ENTIRE URL a blanket pass once userinfo was absent; that
 * blanket pass is gone. Now: split the "rest" (path+query) into its
 * component tokens and require EVERY one to be a vocabulary member or a
 * bounded safe shape. If they all pass, the whole URL survives unchanged.
 * If any fails, the path+query is dropped wholesale to a single
 * `[redacted]` marker — `scheme://host/[redacted]` — rather than partially
 * redacting individual tokens (which would still disclose the URL's overall
 * shape/structure to a degree not worth the complexity). Returns `undefined`
 * when the token isn't URL-shaped at all, so the caller falls through to
 * other checks. */
function classifyUrlToken(token: string, knownSafeTokens: ReadonlySet<string>): string | undefined {
  // Whole-string vocabulary membership wins immediately, same as every other
  // shape check — a collector-constructed URL added to the vocabulary as ONE
  // STRING (it contains no whitespace, so `tokenizeToVocabulary` never splits
  // it) must not be needlessly decomposed into path/query tokens that aren't
  // separately in the vocabulary.
  if (knownSafeTokens.has(token)) return token;
  const match = URL_STRUCTURE.exec(token);
  if (!match) return undefined;
  const scheme = match[1] ?? "";
  const authority = match[2] ?? "";
  const rest = match[3];
  if (!rest) {
    // Bare `scheme://authority` with nothing after it — nothing to redact.
    return `${scheme.toLowerCase()}://${authority}`;
  }
  const restTokens = rest.split(/[/?&=]/).filter((piece) => piece.length > 0);
  const allSafe = restTokens.every((piece) => isBoundedSafeShape(piece, knownSafeTokens));
  if (allSafe) {
    return `${scheme.toLowerCase()}://${authority}${rest}`;
  }
  return `${scheme.toLowerCase()}://${authority}/[redacted]`;
}

function isSafeValueShape(token: string, knownSafeTokens: ReadonlySet<string>): boolean {
  return isBoundedSafeShape(token, knownSafeTokens) || isSafePathToken(token, knownSafeTokens);
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

  if (SHELL_OPERATOR.test(core) || SAFE_FLAG_NAME.test(core)) {
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
  if (flagValueMatch) {
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
