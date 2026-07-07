/**
 * @module admin/why-redaction-shapes
 *
 * Structural shape-safety checks for `why-redaction.ts` (audit F9, round-8
 * terminal design; extracted round-14 to give why-redaction.ts real ratchet
 * headroom rather than sitting exactly at its frozen line cap — the same
 * "extract a cohesive helper" move already applied twice before, to
 * why-redaction-keywords.ts). This module owns every shape-only safety
 * check that is NOT about keywords/flags: UUID, ISO timestamp, path
 * segments, and URL path/query tokens. See why-redaction.ts's module header
 * for the full allowlist contract these are one piece of.
 */

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

/** The bounded, non-vocabulary shapes that can still prove safety on their
 * own: an exact vocabulary member, a UUID (fixed-width, machine-generated),
 * or an ISO timestamp (fixed-format, machine-generated). Reused both for
 * plain-token classification AND for classifying the individual SEGMENTS of
 * a path or the individual TOKENS inside a URL's path/query (round-8 finding
 * 2) — "bounded safe shape" is now one well-defined concept applied
 * uniformly everywhere a value needs proving, not a per-context ad hoc list. */
export function isBoundedSafeShape(token: string, knownSafeTokens: ReadonlySet<string>): boolean {
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
 * other checks.
 *
 * Round-9 MEDIUM fix: this function's wholesale-collapse contract was always
 * what the CODE here did; the observed mismatch was that `classifyToken`'s
 * old blanket `[redacted]`-substring short-circuit bypassed this function
 * ENTIRELY for a URL where stage 1 had already partially redacted one
 * key=value pair. Narrowing that short-circuit to an exact-match check
 * (round-9 CRITICAL fix, see why-redaction.ts's `classifyToken`) means this
 * function is now ALWAYS the one deciding a URL-shaped token's fate. */
export function classifyUrlToken(token: string, knownSafeTokens: ReadonlySet<string>): string | undefined {
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

export function isSafeValueShape(token: string, knownSafeTokens: ReadonlySet<string>): boolean {
  return isBoundedSafeShape(token, knownSafeTokens) || isSafePathToken(token, knownSafeTokens);
}
