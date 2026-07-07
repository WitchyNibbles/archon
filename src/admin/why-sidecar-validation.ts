/**
 * @module admin/why-sidecar-validation
 *
 * Round-14 CRITICAL fix: read-time validation for `archon why`'s sidecar
 * fields (why.ts's readContextGuardSidecar/readHookBlockerSidecar). Sidecars
 * are attacker-shapeable files on disk (the same FS threat model already
 * documented for context-guard.json in runtime/handoff-consumer.ts's C1) —
 * a bare non-empty-string check let ANY string through a field, and
 * why-vocabulary.ts's buildKnownVocabulary folds these fields into
 * knownSafeTokens unconditionally, so a hand-crafted sidecar putting a
 * secret-shaped string in blockerKind/state/recordedAt/invocationId became
 * globally trusted vocabulary and leaked verbatim. Trust is established HERE,
 * at read time, never assumed from disk content.
 *
 * Each function returns the value only if it passes validation, `undefined`
 * otherwise — callers treat an invalid field exactly like an absent one
 * (dropped from both the vocabulary and any free-text path; per
 * why-diagnosis.ts's existing policy, a task/run id may still reach display
 * via `structured()` AFTER sanitization, but an invalid enum/shape field here
 * is simply omitted, matching why.ts's existing "absence tolerated" contract
 * for sidecars).
 */

const ISO_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/;
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Validates `value` is an exact member of `allowed` — the shared way every
 * sidecar enum field (blockerKind, state) is checked, so a future field
 * follows the same discipline rather than a new one-off comparison. */
export function validateEnumMember<T extends string>(
  value: string | undefined,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined) return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Validates `value` is EXACTLY a canonical `Date.prototype.toISOString()`
 * string — the sole contract this validator accepts (round-15 MEDIUM fix).
 * `Date.parse` alone is not enough: JS silently NORMALIZES an out-of-range
 * date instead of rejecting it (`Date.parse("2026-02-30T...")` succeeds and
 * quietly becomes March 2), so a shape-matching-but-invalid date used to
 * round-trip as "valid". The real check is RE-SERIALIZE and compare: parse,
 * then `new Date(ms).toISOString()`, then require EXACT string equality
 * against the input. Every writer of a `recordedAt` field this module reads
 * (`.claude/hooks/hook-policy.mjs`) always calls `new Date().toISOString()`
 * — verified — so exact equality against that canonical form is the
 * cleanest, least-surprising contract: a real, valid instant serialized in
 * any other (still ISO-legal) form, e.g. a non-UTC offset or a different
 * fractional-second precision, is deliberately rejected too, not just
 * invalid dates. The shape regex remains a cheap first-pass filter. */
export function validateIsoTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ISO_TIMESTAMP_SHAPE.test(value)) return undefined;
  const parsedMs = Date.parse(value);
  if (Number.isNaN(parsedMs)) return undefined;
  return new Date(parsedMs).toISOString() === value ? value : undefined;
}

/** Validates `value` is UUID-shaped (fixed-width, machine-generated shape —
 * the same SAFE_UUID contract why-redaction.ts trusts by shape alone). */
export function validateUuid(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return UUID_SHAPE.test(value) ? value : undefined;
}
