/**
 * @module admin/why-redaction
 *
 * Secret redaction for `archon why` (audit F9, round-4 design inversion).
 *
 * Round 3's `redactSecretLikeSubstrings` was a SHAPE-HUNTING scrubber: it
 * looked for patterns that "look like" a secret (labeled fields, URLs,
 * Authorization headers, long opaque runs) and redacted only those. Round 4's
 * gate found a THIRD consecutive bypass in the same family — JSON/JS-object
 * shaped secrets (`{"password":"hunter2Aa1!"}`) sailed through with zero
 * redaction, because every prior rule assumed a bare `key=value` /
 * `key: value` shape and none of them matched inside a quoted JSON string.
 * Chasing one more shape after this one would only produce a fourth bypass —
 * "stop chasing shapes" was the gate's explicit direction.
 *
 * DESIGN INVERSION — redact by default, allowlist the safe:
 *
 * This module now has two exported entry points with opposite defaults:
 *
 *   - `sanitizeFreeText(text)` — for text SOURCED FROM OUTSIDE this module
 *     (a hook-blocker's recorded command/summary, a seed-failure reason, a
 *     daemon's recorded reason/nextActions, any other caught-error message).
 *     Everything is redacted UNLESS it matches a narrow, explicit safe-shape
 *     allowlist (see `isSafeValueShape` below). A JSON blob, a connection
 *     string, a curl `-u user:pass`, a mysqldump `-pPassword`, an AWS key id —
 *     none of these match any allowed shape, so none of them can survive by
 *     omission. This is the fix for the CRITICAL/HIGH findings.
 *   - Values the diagnosis layer itself GENERATED — task ids, run ids, role
 *     names, status tokens, counts, file paths it constructed, the commands
 *     it recommends — are never passed through `sanitizeFreeText` at all.
 *     They are tagged `structured()` and pass through unchanged. See
 *     why-diagnosis.ts's `buildEvidence` for where that provenance split is
 *     enforced (a branded type — a raw string cannot be assigned as evidence
 *     without going through one of the two tagging functions).
 *
 * Known, accepted friction (proposed to the gate, not silently absorbed):
 * because a legitimate identifier (`build:dist`, `archon:doctor`) and a
 * credential fragment (`user:pass`) are the SAME shape — an alnum run
 * containing a colon — `sanitizeFreeText` cannot tell them apart, and by
 * design it does NOT try to. Any token containing a colon (outside a
 * recognized flag) is redacted. This means some benign free-text detail
 * written into a sidecar file — an npm script name embedded in a recorded
 * command, for example — will now be redacted along with real secrets. The
 * sidecar pointer already present in every cause's evidence (e.g.
 * `.archon/work/daemon/hook-blocker-state.json`) is the relief valve: the
 * operator can read the untouched original there. This trade-off is
 * deliberate, not an oversight — flagging it explicitly per the gate's
 * request rather than trying to special-case it away (which is exactly the
 * shape-chasing this redesign exists to stop).
 */

import { scrubPgCredentials } from "./db-error-scrub.ts";

export const MAX_COMMAND_DISPLAY_LENGTH = 120;

// ---------------------------------------------------------------------------
// Stage 1 — high-confidence secret markers. These run BEFORE tokenization and
// redact by pattern/context regardless of what the resulting shape would
// otherwise look like. Kept from round 2/3 (URL credentials, labeled fields,
// Authorization/Bearer) and extended per the round-4 adversarial fixture list
// (generic non-Postgres URL schemes, AWS key ids, mysqldump's concatenated
// `-p<value>` flag).
// ---------------------------------------------------------------------------

const SECRET_KEYWORD_ALTERNATION =
  "password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|accesskey|auth|credential";

const LABELED_FIELD_PATTERN = new RegExp(
  `\\b([\\w-]*(?:${SECRET_KEYWORD_ALTERNATION})[\\w-]*)(\\s*[:=]\\s*)([^\\s"'\`]+)`,
  "gi"
);

// Any `scheme://...` credential-shaped URL — generalizes round-3's Postgres-
// only reuse of scrubPgCredentials to mysql://, mongodb://, mongodb+srv://,
// redis://, https://user:pass@..., etc. (round-4 finding: non-Postgres
// credentials leaked). scrubPgCredentials is still called first so the
// Postgres case keeps its existing, slightly friendlier "postgres://
// [redacted]" shape; this is the generic backstop for every other scheme.
const GENERIC_CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'`]*/gi;

// AWS access-key-id-shaped tokens (AKIA/ASIA/AGPA/AIDA/AROA/ANPA/ANVA
// prefixes are all real AWS credential-type prefixes) — redacted regardless
// of surrounding context, since these are unambiguously credential material
// wherever they appear.
const AWS_KEY_ID_PATTERN = /\b(AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{12,}\b/g;

// mysqldump/mysql's `-p<password>` concatenated-value flag (no `=`, no space
// before the value) — round-4 adversarial fixture. Deliberately broad: any
// `-p<non-whitespace>` token is treated as this flag and its value redacted,
// even though this occasionally over-redacts an unrelated `-p` flag from
// another CLI (e.g. `-port`). Over-redaction here is the accepted trade-off;
// silently letting a password through because it wasn't preceded by "=" is not.
const MYSQL_CONCAT_PASSWORD_FLAG = /(^|\s)(-p)([^\s"'`]+)/g;

function applySecretMarkerRules(text: string): string {
  let result = scrubPgCredentials(text);
  result = result.replace(GENERIC_CREDENTIAL_URL, (_match, scheme: string) => `${scheme.toLowerCase()}://[redacted]`);
  result = result.replace(AWS_KEY_ID_PATTERN, "[redacted]");
  result = result.replace(LABELED_FIELD_PATTERN, "$1$2[redacted]");
  result = result.replace(/\bAuthorization:\s*[^\s"'`]+(?:\s+[^\s"'`]+)?/gi, "Authorization: [redacted]");
  result = result.replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [redacted]");
  result = result.replace(MYSQL_CONCAT_PASSWORD_FLAG, "$1$2[redacted]");
  return result;
}

// ---------------------------------------------------------------------------
// Stage 2 — default-deny allowlist. Every token that stage 1 didn't already
// redact is classified; only an explicit safe shape survives.
// ---------------------------------------------------------------------------

/** camelCase / snake_case / kebab-case identifiers — the shape of every task
 * id, run id, role name, status token, and enum value this codebase uses.
 * Deliberately excludes `.`, `:`, `/`, `@` — none of our own identifiers use
 * them, and excluding them is what keeps connection strings and label:value
 * pairs out of this bucket. */
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** A plain filesystem path: absolute or `./`/`../`-relative, containing only
 * path-safe characters — explicitly no `@` or `:` (the two characters that
 * signal a credential-bearing URL/connection-string shape). */
const SAFE_PATH = /^\.{0,2}\/[A-Za-z0-9_\-./]*$/;

const SAFE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const SAFE_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;

/** A flag name on its own (`--task-id`, `-h`, `--apply-safe`) — never a
 * credential by itself, only ever a label. */
const SAFE_FLAG_NAME = /^--?[A-Za-z][A-Za-z0-9-]*$/;

/** `--flag=value` — the flag half is always safe; the value half must still
 * pass `isSafeValueShape` on its own. */
const SAFE_FLAG_VALUE_PAIR = /^(--?[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/;

/** Pure shell syntax (redirects, pipes, `&&`, bare `--`) — cannot itself carry
 * a secret since it has no alphanumeric content. */
const SHELL_OPERATOR = /^[-&|;<>()]+$/;

function isSafeValueShape(token: string): boolean {
  return (
    SAFE_UUID.test(token) ||
    SAFE_IDENTIFIER.test(token) ||
    SAFE_PATH.test(token) ||
    SAFE_NUMBER.test(token)
  );
}

const TOKEN_WRAPPER_PATTERN = /^([`"'(]*)([\s\S]*?)([`"'),.;]*)$/;

/**
 * Classifies one whitespace-delimited token. Wrapper punctuation (quotes,
 * backticks, parens, trailing prose punctuation) is stripped before
 * classification and reattached after, so it never interferes with shape
 * matching. Anything stage 1 already redacted (contains the literal
 * `[redacted]` marker) is left alone rather than re-processed.
 */
function classifyToken(token: string): string {
  const match = TOKEN_WRAPPER_PATTERN.exec(token);
  const prefix = match?.[1] ?? "";
  const core = match?.[2] ?? token;
  const suffix = match?.[3] ?? "";
  if (core.length === 0) return token;
  if (core.includes("[redacted]")) return token;

  if (SHELL_OPERATOR.test(core) || SAFE_FLAG_NAME.test(core) || isSafeValueShape(core)) {
    return token;
  }

  const flagValueMatch = SAFE_FLAG_VALUE_PAIR.exec(core);
  if (flagValueMatch) {
    const flag = flagValueMatch[1] ?? "";
    const value = flagValueMatch[2] ?? "";
    const safeValue = isSafeValueShape(value) ? value : "[redacted]";
    return `${prefix}${flag}=${safeValue}${suffix}`;
  }

  return `${prefix}[redacted]${suffix}`;
}

/**
 * Sanitizes free text SOURCED FROM OUTSIDE this module — a hook-blocker's
 * recorded command/summary, a seed-failure reason, a daemon's recorded
 * reason/nextActions text, or any other caught-error message. Redacts by
 * default: only text matching an explicit safe-shape allowlist survives. See
 * the module header for the full rationale and the accepted friction this
 * trades off.
 *
 * Do NOT call this on values the diagnosis layer generated itself (task ids,
 * run ids, role names, counts, its own recommended commands) — those are
 * structured, not free text, and should pass through `structured()` in
 * why-diagnosis.ts's `buildEvidence` instead. Running this on already-trusted
 * structured text would only add noise (e.g. redacting `<id>` placeholders),
 * not safety.
 */
export function sanitizeFreeText(text: string): string {
  const marked = applySecretMarkerRules(text);
  return marked
    .split(/(\s+)/)
    .map((piece) => (/^\s+$/.test(piece) || piece.length === 0 ? piece : classifyToken(piece)))
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
 * unsafe survives regardless of where the truncation cut falls (round-4 LOW
 * fix: order truncation AFTER redaction, not before). */
export function sanitizeForDisplay(text: string): string {
  return truncateForDisplay(sanitizeFreeText(text));
}
