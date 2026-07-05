/**
 * @module admin/why-redaction
 *
 * Secret redaction for `archon why` (audit F9, round-2 security repair).
 *
 * Split out of why-diagnosis.ts (round-2 reviewer LOW: single-responsibility +
 * file-size ratchet) — this module owns ONLY text-sanitization primitives, no
 * ranking/evidence logic. Pure, no IO.
 *
 * Round-2 gate found the round-1 version broken in BOTH directions:
 *   - UNDER-redaction (HIGH): `\b(token|secret|password|...)\b` requires a word
 *     boundary immediately before the keyword, which FAILS on compound
 *     env-var names — there is no boundary between "PG" and "PASSWORD" in
 *     "PGPASSWORD" (both are \w chars), so PGPASSWORD=, MYSQL_PWD=, and
 *     AWS_SECRET_ACCESS_KEY= all sailed through unredacted. There was also no
 *     rule at all for basic-auth connection URLs
 *     (postgresql://user:pass@host:port/db), despite the module comment
 *     claiming to mirror db-error-scrub.ts's scrubPgCredentials — which was
 *     neither called nor replicated.
 *   - OVER-redaction (MEDIUM): the opaque-token fallback matched ANY 24+ char
 *     alnum run ANYWHERE in the text, with no positional context requirement
 *     and `/` in its charset — so a long task id or file path following a CLI
 *     flag (`--task-id auditP3ArchonWhyRepairVerification123456`) was
 *     destroyed just as readily as a real secret.
 *
 * Fixes, in order applied by `redactSecretLikeSubstrings`:
 *   1. REUSE `scrubPgCredentials` (db-error-scrub.ts) for URL-embedded
 *      credentials — the precedent this module always claimed to follow, now
 *      actually called instead of re-implemented.
 *   2. Labeled/compound keyword fields: match the surrounding identifier
 *      greedily (`[\w-]*keyword[\w-]*`) rather than anchoring `\b` directly on
 *      the keyword — this is what lets PGPASSWORD, MYSQL_PWD, and
 *      AWS_SECRET_ACCESS_KEY resolve correctly (the keyword only needs to be a
 *      SUBSTRING of the identifier, not the whole identifier).
 *   3. Authorization headers / Bearer tokens — unchanged from round 1, already
 *      correct.
 *   4. Opaque-token fallback — narrowed to fire ONLY in value position
 *      (immediately after a `:`/`=` separator) and with `/` dropped from its
 *      charset, so file paths, task ids, and script paths passed as bare
 *      CLI-flag values (space-separated, not `key=value`) are never touched;
 *      the keyword/URL rules above remain the primary catchers for anything
 *      that actually looks like a credential.
 */

import { scrubPgCredentials } from "./db-error-scrub.ts";

export const MAX_COMMAND_DISPLAY_LENGTH = 120;

// Keyword set matched as a SUBSTRING of a larger identifier, not a whole-word
// match — this is what makes compound env-var names (PGPASSWORD, MYSQL_PWD,
// AWS_SECRET_ACCESS_KEY) resolve. Deliberately coverage-over-precision: a key
// name that merely contains one of these substrings (e.g. "oauth_redirect")
// has its value redacted too. That is an accepted false-positive, not a bug.
const SECRET_KEYWORD_ALTERNATION =
  "password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|accesskey|auth|credential";

const LABELED_FIELD_PATTERN = new RegExp(
  `\\b([\\w-]*(?:${SECRET_KEYWORD_ALTERNATION})[\\w-]*)(\\s*[:=]\\s*)([^\\s"'\`]+)`,
  "gi"
);

/**
 * Redacts secret-shaped substrings from arbitrary text: URL-embedded
 * credentials, labeled key=value / key: value credential fields (including
 * compound env-var names), `Authorization:` headers, `Bearer` tokens, and
 * (fallback, value-position only) long opaque alnum/base64-ish runs assigned
 * to an unrecognized key.
 */
export function redactSecretLikeSubstrings(text: string): string {
  // 1. URL-embedded credentials — reuse the existing scrubPgCredentials
  //    precedent (handles postgres[ql]://user:pass@host:port/db) instead of
  //    re-implementing a second URL-credential scrubber.
  let result = scrubPgCredentials(text);

  // 2. Labeled / compound credential fields. See LABELED_FIELD_PATTERN comment
  //    above for why this catches PGPASSWORD=, MYSQL_PWD=, AWS_SECRET_ACCESS_KEY=
  //    where a `\b`-anchored whole-word match would not.
  result = result.replace(LABELED_FIELD_PATTERN, "$1$2[redacted]");

  // 3. Authorization headers (value may be "Bearer xyz" or a bare token).
  //    Token components exclude quote/backtick characters so a shell-quoted
  //    header (`"Authorization: Bearer xyz"`) redacts cleanly without
  //    swallowing the closing quote into the replacement.
  result = result.replace(
    /\bAuthorization:\s*[^\s"'`]+(?:\s+[^\s"'`]+)?/gi,
    "Authorization: [redacted]"
  );

  // 4. Bearer tokens outside an Authorization header.
  result = result.replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [redacted]");

  // 5. Fallback: long opaque token-shaped runs, but ONLY in value position —
  //    immediately after a `:`/`=` separator. This is the round-2 MEDIUM fix:
  //    requiring the preceding separator scopes the fallback to genuine
  //    key=value / key: value shapes (the same context every rule above
  //    requires), so a bare CLI-flag value like `--task-id <42-char-id>`
  //    (space-separated, no separator immediately before the id) is never
  //    touched. `/` is also dropped from the charset so a path segment can
  //    never qualify even if it did appear after a separator.
  result = result.replace(
    /([:=]\s*)([A-Za-z0-9_+]{24,}={0,2})(?=\s|["'`]|$)/g,
    (_match, sep: string) => `${sep}[redacted]`
  );

  return result;
}

/** Truncates text to a safe display prefix, with an explicit ellipsis marker
 * when truncation occurred (never silently drops characters unmarked). */
export function truncateForDisplay(text: string, maxLength = MAX_COMMAND_DISPLAY_LENGTH): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/** Applies redaction then truncation — the combined safe-display transform. */
export function sanitizeForDisplay(text: string): string {
  return truncateForDisplay(redactSecretLikeSubstrings(text));
}
