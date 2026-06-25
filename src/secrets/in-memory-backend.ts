/**
 * @module secrets/in-memory-backend
 *
 * TEST-ONLY in-memory `SecretManager` implementation (P5-S2).
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * WARNING — NOT FOR PRODUCTION USE
 *
 * This backend stores secrets as `SecretValue` instances in a plain `Map` in
 * process memory.  It provides:
 *   - No encryption at rest.
 *   - No persistence across process restarts.
 *   - No audit log.
 *   - No access control.
 *
 * It exists solely as:
 *   1. A test double for `SecretManager` unit tests and forge pipeline tests.
 *   2. A seam that P5-S3's `EncryptedFileSecretManager` replaces in production.
 *
 * The production backend (P5-S3) uses AES-256-GCM + scrypt under dataRoot/secrets/.
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */

import type { SecretManager, SecretRef } from "./secret-manager.ts";
import type { SecretValue } from "./secret-value.ts";

// ---------------------------------------------------------------------------
// InMemorySecretManager
// ---------------------------------------------------------------------------

/**
 * A `Map`-backed `SecretManager` implementation for use in tests only.
 *
 * Audit semantics: this backend does NOT write audit records (no file I/O).
 * The P5-S3 encrypted-file backend will enforce audit writes.
 *
 * All operations are synchronous under the hood but the interface is async so
 * the test double is a drop-in replacement for the production backend.
 */
export class InMemorySecretManager implements SecretManager {
  /**
   * The underlying store. Map from SecretRef string to SecretValue.
   *
   * Private — never expose the raw Map so callers cannot bypass the interface.
   */
  readonly #store: Map<SecretRef, SecretValue> = new Map();

  /**
   * Retrieves the secret associated with `ref`.
   * Returns `undefined` when the ref is not present.
   */
  async get(ref: SecretRef): Promise<SecretValue | undefined> {
    return this.#store.get(ref);
  }

  /**
   * Stores (or overwrites) the secret for `ref`.
   *
   * Note: this backend does NOT produce audit records. The encrypted-file
   * backend (P5-S3) will.
   */
  async set(ref: SecretRef, value: SecretValue): Promise<void> {
    this.#store.set(ref, value);
  }

  /**
   * Replaces the EXISTING secret for `ref` with `next` (replace, not upsert).
   *
   * Per the SecretManager contract, rotate requires the ref to exist; rotating a
   * missing ref throws (use `set` to create) so a typo cannot silently create a
   * secret. The previous value is discarded; subsequent `get` calls return `next`.
   *
   * @throws If no secret currently exists at `ref`.
   */
  async rotate(ref: SecretRef, next: SecretValue): Promise<void> {
    if (!this.#store.has(ref)) {
      throw new Error(`rotate: no secret exists at ref "${ref}" — use set() to create it`);
    }
    this.#store.set(ref, next);
  }

  /**
   * Removes the secret for `ref`.  Silently succeeds if the ref is absent.
   */
  async delete(ref: SecretRef): Promise<void> {
    this.#store.delete(ref);
  }

  /**
   * Lists all stored refs.
   *
   * Returns ONLY `SecretRef[]` — never values.  This is enforced by the
   * type signature and the implementation: only the Map keys are returned.
   */
  async list(): Promise<SecretRef[]> {
    // Array.from preserves insertion order (Map iteration order is insertion-ordered).
    // Keys are SecretRef (the Map is typed), so no cast is needed.
    return Array.from(this.#store.keys());
  }

  // ---------------------------------------------------------------------------
  // Test helpers (not on the SecretManager interface)
  // ---------------------------------------------------------------------------

  /**
   * Returns the number of stored secrets.  Useful for assertions in tests.
   * NOT part of the SecretManager interface.
   */
  get size(): number {
    return this.#store.size;
  }

  /**
   * Clears all stored secrets.  Useful for resetting state between test cases.
   * NOT part of the SecretManager interface.
   */
  clear(): void {
    this.#store.clear();
  }
}
