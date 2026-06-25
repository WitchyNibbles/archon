/**
 * @module secrets/secret-manager
 *
 * The stable seam for the Archon secret-manager subsystem (P5-S2).
 *
 * Exports:
 *   - `SecretRef`         — a branded, regex-allowlisted secret name.
 *   - `parseSecretRef`    — validates and brands a raw string as a SecretRef.
 *   - `SecretManager`     — the pluggable interface consumed by all callers.
 *
 * What is NOT here (later slices):
 *   - Encrypted-file backend (P5-S3)
 *   - Admin CLI verbs (P5-S4)
 *   - API image provider wiring (P5-S5)
 *   - process.env master-key handling (P5-S3)
 *
 * Naming rules (CC-6):
 *   Pattern: ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$
 *   - Lowercase ASCII letters, digits, and underscores only within each segment.
 *   - Segments separated by a single dot.
 *   - Must start with a letter.
 *   - Rejects: empty, spaces, quotes, path separators, control characters,
 *     uppercase, leading digits, leading/trailing dots, consecutive dots.
 *
 * Examples of valid refs: `forge.openai_api_key`, `db.password`, `a`, `x1_y`
 * Examples of invalid refs: `forge/openai`, `Forge.key`, `forge..key`, `.key`,
 *   `forge key`, `forge"key"`, `forge\key`, `forge.1invalid`
 *
 * @see src/secrets/secret-value.ts  for the redacting SecretValue type.
 * @see src/secrets/in-memory-backend.ts  for the test-only Map backend.
 */

import type { SecretValue } from "./secret-value.ts";

// ---------------------------------------------------------------------------
// SecretRef — branded, regex-allowlisted name
// ---------------------------------------------------------------------------

/**
 * A validated, branded secret name.
 *
 * The only way to obtain a SecretRef is via `parseSecretRef`, which enforces
 * the allowlist pattern.  This prevents free-form strings (from user input,
 * env vars, etc.) from flowing into the secret-manager without validation.
 *
 * The brand is enforced at the type level only (nominal typing via a string
 * intersection).  At runtime a SecretRef is just a plain string — but the
 * TypeScript compiler rejects any `string` that was not produced by
 * `parseSecretRef`.
 */
export type SecretRef = string & { readonly __brand: "SecretRef" };

/**
 * Allowlist pattern for SecretRef names.
 *
 * Each dot-separated segment must:
 *   - Start with a lowercase ASCII letter [a-z]
 *   - Contain only [a-z0-9_] after the first character
 *   - Be non-empty
 *
 * Full name: one or more segments joined by single dots.
 *
 * Rejected characters include (but are not limited to):
 *   spaces, tabs, newlines, quotes ('" ` '), path separators (/ \),
 *   control characters, uppercase letters, @ # $ % ^ & * ( ) - + = [ ] { } ,
 */
const SECRET_REF_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Upper bound on a SecretRef name length. A ref is a short identifier (e.g.
 * `forge.openai_api_key`); anything longer is either abuse or a misuse (e.g. a
 * secret value mistakenly passed as the ref). Bounds audit-log size too (CC-6).
 */
export const MAX_SECRET_REF_LENGTH = 128;

/**
 * Validates `raw` against the allowlist pattern and returns a branded SecretRef.
 *
 * Throws a descriptive `Error` on rejection so callers fail fast with a clear
 * reason — never silently accept an invalid name.
 *
 * @throws {Error} If `raw` is empty, does not match the allowlist pattern, or
 *   contains any disallowed character.
 */
export function parseSecretRef(raw: string): SecretRef {
  if (raw.length > MAX_SECRET_REF_LENGTH) {
    // SECURITY: do NOT echo the raw — report only length (it may be a secret passed in error).
    throw new Error(
      `SecretRef name too long (length=${raw.length}, max=${MAX_SECRET_REF_LENGTH}). ` +
        "A ref is a short identifier, not a value.",
    );
  }
  if (raw.length === 0) {
    throw new Error(
      "SecretRef name must not be empty. " +
        "Expected pattern: ^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$",
    );
  }

  if (!SECRET_REF_PATTERN.test(raw)) {
    // SECURITY: do NOT echo the raw input — a caller may mistakenly pass a SECRET as the
    // ref name, and the error message flows to logs. Report only its length, never its value.
    throw new Error(
      `Invalid SecretRef name (length=${raw.length}). ` +
        "Name must match ^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$ — " +
        "lowercase letters/digits/underscores only, segments separated by dots, " +
        "each segment starting with a letter. " +
        "Rejected characters include spaces, quotes, path separators (/\\), " +
        "control characters, and uppercase letters.",
    );
  }

  return raw as SecretRef;
}

// ---------------------------------------------------------------------------
// SecretManager — the pluggable interface
// ---------------------------------------------------------------------------

/**
 * The pluggable secret-manager interface.
 *
 * Design invariants (CC-1, B.1, B.4):
 *   - `get` returns `SecretValue | undefined`; the raw material is only
 *     accessible through SecretValue.reveal() — never via enumeration.
 *   - `set` and `rotate` accept a `SecretValue`, not a raw string, so the
 *     caller must explicitly acknowledge they are handling secret material.
 *   - `list` returns ONLY `SecretRef[]` — never values.  This is non-negotiable.
 *   - Implementations must write metadata-only audit records for `set`,
 *     `rotate`, and `delete` (value never appears in audit; P5-S3 enforces
 *     this for the encrypted-file backend).
 *
 * Implementations shipped with this module:
 *   - `InMemorySecretManager` (src/secrets/in-memory-backend.ts) — TEST-ONLY
 *
 * Production backend (P5-S3):
 *   - `EncryptedFileSecretManager` — AEAD-encrypted file under dataRoot/secrets/
 */
export interface SecretManager {
  /**
   * Retrieves the secret associated with `ref`.
   *
   * Returns `undefined` if the ref does not exist in the store.
   * The raw value is accessible only via `SecretValue.reveal()`.
   */
  get(ref: SecretRef): Promise<SecretValue | undefined>;

  /**
   * Stores (or overwrites) the secret associated with `ref`.
   *
   * Implementations must write a metadata-only audit record (ref, action,
   * timestamp, actor — never the value).
   */
  set(ref: SecretRef, value: SecretValue): Promise<void>;

  /**
   * Atomically replaces the EXISTING secret at `ref` with `next`.
   *
   * Contract: `rotate` requires the ref to already exist — it is a replace, not
   * an upsert. If no secret exists at `ref`, implementations MUST throw (use
   * `set` to create). This prevents a typo'd ref from silently creating a new
   * secret under the guise of rotation. After rotation the previous value must
   * not be retrievable via `get`. Implementations must write a metadata-only
   * audit record.
   *
   * @throws If no secret currently exists at `ref`.
   */
  rotate(ref: SecretRef, next: SecretValue): Promise<void>;

  /**
   * Removes the secret associated with `ref`.
   *
   * Silently succeeds if the ref does not exist.
   * Implementations must write a metadata-only audit record.
   */
  delete(ref: SecretRef): Promise<void>;

  /**
   * Lists all stored secret references.
   *
   * NEVER returns values. Returns an empty array when the store is empty.
   */
  list(): Promise<SecretRef[]>;
}
