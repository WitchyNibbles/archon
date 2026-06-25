/**
 * @module secrets/secret-value
 *
 * Redacting `SecretValue` type and `createSecretValue` factory (P5-S2, CC-1).
 *
 * ## Redaction mechanism (CC-1 — the heart of this slice)
 *
 * The raw string is held in a **module-private `WeakMap`** keyed on the instance —
 * it is NEVER stored as an own property of the `SecretValue` object. This is the
 * strongest available redaction in Node: because the secret is not an own property
 * (enumerable OR non-enumerable, string OR symbol keyed), EVERY reflection and
 * serialisation path on the object surfaces nothing:
 *
 *   - `{...v}` spread / `Object.keys|values|entries(v)`        — no own props at all.
 *   - `Object.getOwnPropertySymbols(v)` / `Reflect.ownKeys(v)` — return `[]` (the
 *     earlier symbol-keyed-own-property design leaked here; the WeakMap closes it).
 *   - `Object.getOwnPropertyDescriptors(v)`                    — `{}`.
 *   - `util.inspect(v)` / `console.log` / `util.format("%o", v)` — `[util.inspect.custom]`
 *     returns "[REDACTED]"; there are no own props for the default inspector either.
 *   - `JSON.stringify(v)`                                      — `toJSON()` → "[REDACTED]".
 *   - Template literals / `String(v)` / concatenation         — `toString()` → "[REDACTED]".
 *   - `structuredClone(v)`                                     — copies no own data (would lose
 *     the secret); the WeakMap entry is keyed on the original instance only.
 *
 * The raw value is exposed ONLY through the explicit `.reveal()` method, which reads
 * the WeakMap. `.reveal()` throws if called on an object not minted by
 * `createSecretValue` (no silent `undefined`).
 *
 * ## What is NOT here
 *   - Encryption (P5-S3)
 *   - File I/O (P5-S3)
 *   - process.env master-key handling (P5-S3)
 */

import * as util from "node:util";

// ---------------------------------------------------------------------------
// SecretValue interface
// ---------------------------------------------------------------------------

/**
 * A branded wrapper around a secret string whose raw content is not reachable
 * through any standard enumeration, reflection, or serialisation path.
 *
 * Security contract (CC-1):
 *   - `toString()` / `toJSON()` / `[util.inspect.custom]()` → "[REDACTED]"
 *   - no own properties → spread / Object.* / getOwnPropertySymbols / Reflect.ownKeys leak nothing
 *   - `.reveal()` → the raw string (point-of-use only; never log the result)
 *
 * The brand is enforced nominally at the type level only.
 */
export interface SecretValue {
  /** Nominal type brand — compile-time only; never accessed at runtime. */
  readonly __brand: "SecretValue";

  /**
   * Returns the raw secret string.
   *
   * SECURITY: Call this ONLY at the point where the secret is consumed
   * (e.g. building an HTTP Authorization header inside `generate()`).
   * Do NOT assign the result to a variable that outlives the immediate use.
   * Do NOT pass the result to any logger, error message, or serialiser.
   *
   * Throws if called on an object not produced by `createSecretValue`.
   */
  reveal(): string;

  /** Always returns "[REDACTED]". Prevents accidental logging via string coercion. */
  toString(): string;

  /** Always returns "[REDACTED]". Prevents accidental serialisation via JSON.stringify. */
  toJSON(): string;

  /**
   * Custom Node.js util.inspect hook.
   * Returns "[REDACTED]" so `util.inspect`, `console.log`, and `util.format`
   * cannot surface the raw value.
   */
  [util.inspect.custom](): string;
}

// ---------------------------------------------------------------------------
// Module-private raw store — the secret lives HERE, never on the instance
// ---------------------------------------------------------------------------

/**
 * Maps a `SecretValueImpl` instance to its raw secret string.
 *
 * Keeping the raw value off the instance entirely is what makes redaction
 * complete: reflection over the object (own properties, symbols, descriptors)
 * finds nothing, because the secret is not a property of the object at all.
 * The WeakMap is module-private (not exported), so no external code can read it,
 * and entries are garbage-collected when the instance is no longer referenced.
 */
const rawStore = new WeakMap<object, string>();

// ---------------------------------------------------------------------------
// SecretValueImpl — the concrete class (not exported; only the interface is)
// ---------------------------------------------------------------------------

/**
 * Internal implementation class.  Not exported — callers see only `SecretValue`.
 * The instance carries NO own data property; the raw value lives in `rawStore`.
 */
class SecretValueImpl {
  constructor(raw: string) {
    rawStore.set(this, raw);
    // Freeze the instance so no one can attach own properties after construction.
    Object.freeze(this);
  }

  reveal(): string {
    // `has` (not `=== undefined`) so a legitimately-empty-string secret would still be
    // distinguishable from a foreign object — though createSecretValue rejects empty inputs.
    if (!rawStore.has(this)) {
      // Defensive: only objects minted by createSecretValue are in the store.
      throw new Error("reveal() called on an object not produced by createSecretValue");
    }
    return rawStore.get(this) as string;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [util.inspect.custom](): string {
    return "[REDACTED]";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a `SecretValue` wrapping the given raw string.
 *
 * The raw string is held in a module-private WeakMap, never as a property of the
 * returned object. Use `.reveal()` at point-of-use only — never log, store, or
 * spread the result.
 *
 * @param raw - The plaintext secret value (e.g. an API key string).
 * @returns A `SecretValue` whose raw content is unreachable through enumeration,
 *   reflection, serialisation, or inspection.
 */
export function createSecretValue(raw: string): SecretValue {
  // An empty secret is always a caller error (e.g. an unset env var read as ""). Fail loudly
  // rather than silently wrapping a useless value that would later select a misconfigured path.
  if (raw.length === 0) {
    throw new Error("createSecretValue: refusing to wrap an empty secret string");
  }
  return new SecretValueImpl(raw) as unknown as SecretValue;
}
