/**
 * @module secrets/encrypted-file-backend
 *
 * Production `SecretManager` implementation using an AES-256-GCM encrypted file
 * under `<secretsDir>/secrets.enc` (P5-S3, Decision B.2-A).
 *
 * ## Security design (CC-2 / CC-3 / CC-4 / CC-6 / CC-7)
 *
 * ### Cipher (CC-2)
 *   AES-256-GCM with:
 *   - A fresh random 12-byte IV per write (never derived, never reused).
 *   - A fresh random 16-byte salt per entry, passed through scrypt
 *     (N=131072, r=8, p=1) to derive the 32-byte data key.
 *   - A 16-byte GCM authentication tag; setAuthTag() is called before
 *     decipher.final() so the tag is verified BEFORE any plaintext is returned.
 *   - A tampered ciphertext, tag, IV, or salt causes final() to throw — callers
 *     receive an error, never partial/garbage plaintext.
 *
 * ### File format (CC-3)
 *   `<secretsDir>/secrets.enc` — a JSON file with:
 *     { version: 1, entries: [{ ref, salt, iv, authTag, ciphertext }] }
 *   All binary fields are base64-encoded.  The plaintext and data key are NEVER
 *   stored.  The file is written atomically (same-dir temp → renameSync → chmod 0600).
 *   The secrets directory is created with mode 0700 if absent.
 *
 * ### Master key (CC-4)
 *   Read LAZILY on first use via an injectable `MasterKeyProvider`.  The default
 *   provider reads `ARCHON_SECRETS_MASTER_KEY` from `process.env`.  Construction
 *   NEVER throws if the key is absent — the daemon starts; operations that need
 *   the key fail cleanly.  After the first successful read by the default env
 *   provider, `delete process.env["ARCHON_SECRETS_MASTER_KEY"]` is called
 *   immediately.  An init-once latch prevents concurrent first-callers from
 *   double-reading after deletion.  The data key is never cached beyond one op.
 *
 * ### Accepted residual (B.4 / CC-4)
 *   The master key and derived data key are held in Node's JS heap as Buffers.
 *   Node provides no secure-erase primitive.  Accepted residual: key material
 *   may appear in /proc/environ (until deleted), swap, or core dumps.  This is
 *   an accepted risk for a single-operator local tool (documented per council
 *   mandate).
 *
 * ### Audit (CC-6)
 *   Every set/rotate/delete writes a metadata-only JSONL record (ref, action,
 *   ISO timestamp, actor — NEVER the value) to `<secretsDir>/audit.log`.
 *   The `ref` is re-validated against the allowlist before any audit/store write.
 *
 * ### Concurrency (CC-7)
 *   Writes are serialized via an O_EXCL lockfile (`<secretsDir>/.write.lock`).
 *   The lock is always released in a `finally` block.
 */

import { createSecretValue } from "./secret-value.ts";
import type { SecretValue } from "./secret-value.ts";
import { parseSecretRef } from "./secret-manager.ts";
import type { SecretManager, SecretRef } from "./secret-manager.ts";
import { encryptEntry, decryptEntry } from "./crypto-ops.ts";
import {
  ensureSecretsDir,
  readSecretsFile,
  atomicWriteSecretsFile,
  acquireLockWithRetry,
  releaseLock,
  appendAuditRecord,
} from "./file-store.ts";
import type { StoredEntry, SecretsFile } from "./file-store.ts";

// ---------------------------------------------------------------------------
// Master-key provider contract
// ---------------------------------------------------------------------------

/**
 * Injectable provider for the master key.
 *
 * The default implementation reads `ARCHON_SECRETS_MASTER_KEY` from `process.env`
 * and immediately deletes it after the first successful read (CC-4).
 *
 * Custom providers (e.g. for tests) receive a `sandboxEnv` object so real env is
 * never touched.
 *
 * @returns The master key as a Buffer, or `undefined` if the key is not present.
 */
export type MasterKeyProvider = () => Buffer | undefined;

/**
 * Creates the default environment-variable master-key provider.
 *
 * Reads from `env["ARCHON_SECRETS_MASTER_KEY"]` (defaults to `process.env`).
 * On first successful read, deletes the key from `env` (CC-4).
 *
 * The value is decoded as a hex string (64 hex chars = 32 bytes = 256-bit key).
 * If the value is not a valid 64-char hex string, the provider throws so the
 * caller surfaces a clear error rather than silently using a weak key.
 *
 * @param env - The environment object to read from and delete from.
 *              Defaults to `process.env`.
 */
export function makeEnvMasterKeyProvider(env: NodeJS.ProcessEnv = process.env): MasterKeyProvider {
  return (): Buffer | undefined => {
    const raw = env["ARCHON_SECRETS_MASTER_KEY"];
    if (raw === undefined || raw === "") {
      return undefined;
    }

    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      // CC-4: Never echo the raw value — just report that it is malformed.
      throw new Error(
        "ARCHON_SECRETS_MASTER_KEY is set but is not a valid 64-character hex string " +
          "(32 bytes / 256 bits required for AES-256). " +
          "Generate one with: node -e \"require('crypto').randomBytes(32).toString('hex')\" | pbcopy",
      );
    }

    const keyBuf = Buffer.from(raw, "hex");

    // CC-4: Delete the master key from the environment immediately after the first
    // successful read so it is no longer visible in process.env (e.g. via /proc/environ).
    // Accepted residual: the key is still in Node heap / swap / core dumps (no secure-erase).
    delete env["ARCHON_SECRETS_MASTER_KEY"];

    return keyBuf;
  };
}

// ---------------------------------------------------------------------------
// EncryptedFileSecretManager
// ---------------------------------------------------------------------------

/**
 * Production `SecretManager` backed by an AES-256-GCM encrypted file.
 *
 * Constructor NEVER throws on a missing master key (CC-4 — daemon must start).
 * Operations that require the master key (`get`, `set`, `rotate`) throw
 * with a descriptive error when the key is absent.  `list` and `delete`
 * work without the master key (list reads refs only; delete removes an entry).
 */
export class EncryptedFileSecretManager implements SecretManager {
  readonly #secretsDir: string;
  readonly #keyProvider: MasterKeyProvider;
  readonly #actor: string;

  // Init-once latch (CC-4): the master key is read exactly once.
  // After the first read, the resolved Buffer (or undefined) is stored here.
  // Concurrent callers block until the latch resolves.
  #masterKeyLatch: Promise<Buffer | undefined> | undefined = undefined;

  /**
   * Creates a new `EncryptedFileSecretManager`.
   *
   * @param secretsDir - Path to the secrets directory (will be created with
   *   mode 0700 if absent).  Do NOT use `resolveRuntimeEnvironmentConfig` here;
   *   P5-S4 is responsible for wiring `<dataRoot>/secrets/`.
   * @param keyProvider - Optional custom master-key provider.  Defaults to
   *   the env-variable provider reading `ARCHON_SECRETS_MASTER_KEY`.
   * @param actor - Optional actor string for audit records.  Defaults to "backend".
   */
  constructor(
    secretsDir: string,
    keyProvider?: MasterKeyProvider,
    actor?: string,
  ) {
    this.#secretsDir = secretsDir;
    this.#keyProvider = keyProvider ?? makeEnvMasterKeyProvider();
    this.#actor = actor ?? "backend";

    // Create the directory now (if absent) — construction is safe even if the
    // master key is absent.
    ensureSecretsDir(secretsDir);
  }

  // ---------------------------------------------------------------------------
  // SecretManager interface
  // ---------------------------------------------------------------------------

  /**
   * CC-6 defence-in-depth: re-validate the ref against the allowlist BEFORE any
   * read/write/lock. A caller could fabricate an invalid `SecretRef` via a cast;
   * validating here (not only inside the audit append, which runs AFTER the
   * encrypted write) guarantees an invalid ref is rejected before anything is
   * persisted to disk. `parseSecretRef` throws on any disallowed name.
   */
  #assertValidRef(ref: SecretRef): void {
    parseSecretRef(ref);
  }

  /** {@inheritDoc SecretManager.get} */
  async get(ref: SecretRef): Promise<SecretValue | undefined> {
    this.#assertValidRef(ref);
    const masterKey = await this.#getMasterKey();
    if (masterKey === undefined) {
      throw new Error(
        `Cannot read secret "${ref}": master key is not configured. ` +
          "Set ARCHON_SECRETS_MASTER_KEY (a 64-char hex string) before using the encrypted-file backend.",
      );
    }

    const file = readSecretsFile(this.#secretsDir);
    const entry = file.entries.find((e) => e.ref === ref);

    if (entry === undefined) {
      return undefined;
    }

    const plaintext = decryptEntry(
      masterKey,
      Buffer.from(entry.salt, "base64"),
      Buffer.from(entry.iv, "base64"),
      Buffer.from(entry.authTag, "base64"),
      Buffer.from(entry.ciphertext, "base64"),
    );

    return createSecretValue(plaintext.toString("utf-8"));
  }

  /** {@inheritDoc SecretManager.set} */
  async set(ref: SecretRef, value: SecretValue): Promise<void> {
    this.#assertValidRef(ref);
    const masterKey = await this.#getMasterKey();
    if (masterKey === undefined) {
      throw new Error(
        `Cannot write secret "${ref}": master key is not configured. ` +
          "Set ARCHON_SECRETS_MASTER_KEY before using the encrypted-file backend.",
      );
    }

    const lockFd = acquireLockWithRetry(this.#secretsDir);
    try {
      const file = readSecretsFile(this.#secretsDir);

      const plaintext = Buffer.from(value.reveal(), "utf-8");
      const { salt, iv, authTag, ciphertext } = encryptEntry(masterKey, plaintext);

      const newEntry: StoredEntry = {
        ref,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      // Replace existing entry with the same ref, or append.
      const existingIndex = file.entries.findIndex((e) => e.ref === ref);
      const updatedEntries: readonly StoredEntry[] =
        existingIndex === -1
          ? [...file.entries, newEntry]
          : [
              ...file.entries.slice(0, existingIndex),
              newEntry,
              ...file.entries.slice(existingIndex + 1),
            ];

      const updatedFile: SecretsFile = { version: 1, entries: updatedEntries };
      atomicWriteSecretsFile(this.#secretsDir, updatedFile);

      // CC-6: Audit AFTER successful write; ref is re-validated inside appendAuditRecord.
      appendAuditRecord(this.#secretsDir, ref, "set", this.#actor);
    } finally {
      releaseLock(this.#secretsDir, lockFd);
    }
  }

  /** {@inheritDoc SecretManager.rotate} */
  async rotate(ref: SecretRef, next: SecretValue): Promise<void> {
    this.#assertValidRef(ref);
    const masterKey = await this.#getMasterKey();
    if (masterKey === undefined) {
      throw new Error(
        `Cannot rotate secret "${ref}": master key is not configured. ` +
          "Set ARCHON_SECRETS_MASTER_KEY before using the encrypted-file backend.",
      );
    }

    const lockFd = acquireLockWithRetry(this.#secretsDir);
    try {
      const file = readSecretsFile(this.#secretsDir);

      const existingIndex = file.entries.findIndex((e) => e.ref === ref);
      if (existingIndex === -1) {
        // CC-7 / SecretManager contract: rotate is replace-not-upsert.
        throw new Error(
          `rotate: no secret exists at ref "${ref}" — use set() to create it first. ` +
            "rotate() requires the ref to already exist so a typo cannot silently create a new secret.",
        );
      }

      const plaintext = Buffer.from(next.reveal(), "utf-8");
      const { salt, iv, authTag, ciphertext } = encryptEntry(masterKey, plaintext);

      const newEntry: StoredEntry = {
        ref,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      const updatedEntries: readonly StoredEntry[] = [
        ...file.entries.slice(0, existingIndex),
        newEntry,
        ...file.entries.slice(existingIndex + 1),
      ];

      const updatedFile: SecretsFile = { version: 1, entries: updatedEntries };
      atomicWriteSecretsFile(this.#secretsDir, updatedFile);

      // CC-6: Audit AFTER successful write.
      appendAuditRecord(this.#secretsDir, ref, "rotate", this.#actor);
    } finally {
      releaseLock(this.#secretsDir, lockFd);
    }
  }

  /** {@inheritDoc SecretManager.delete} */
  async delete(ref: SecretRef): Promise<void> {
    this.#assertValidRef(ref);
    // Note: delete does not require the master key — it removes the ciphertext entry
    // without decrypting it (asymmetry with get/set/rotate is intentional).
    const lockFd = acquireLockWithRetry(this.#secretsDir);
    try {
      const file = readSecretsFile(this.#secretsDir);

      const existingIndex = file.entries.findIndex((e) => e.ref === ref);
      if (existingIndex === -1) {
        // Silently succeed per SecretManager contract.
        return;
      }

      const updatedEntries: readonly StoredEntry[] = [
        ...file.entries.slice(0, existingIndex),
        ...file.entries.slice(existingIndex + 1),
      ];

      const updatedFile: SecretsFile = { version: 1, entries: updatedEntries };
      atomicWriteSecretsFile(this.#secretsDir, updatedFile);

      // CC-6: Audit AFTER successful write.
      appendAuditRecord(this.#secretsDir, ref, "delete", this.#actor);
    } finally {
      releaseLock(this.#secretsDir, lockFd);
    }
  }

  /** {@inheritDoc SecretManager.list} */
  async list(): Promise<SecretRef[]> {
    const file = readSecretsFile(this.#secretsDir);
    // Return only refs — NEVER values (SecretManager contract + CC-6).
    return file.entries.map((e) => e.ref as SecretRef);
  }

  // ---------------------------------------------------------------------------
  // Master-key latch (CC-4 init-once)
  // ---------------------------------------------------------------------------

  /**
   * Returns the master key, resolving it exactly once via the init-once latch.
   *
   * Concurrent callers all await the same Promise so the provider is invoked
   * exactly once.  Subsequent calls return the resolved value immediately.
   *
   * Returns `undefined` if the key is absent — callers must check and throw
   * a descriptive error rather than proceeding with a null key.
   */
  async #getMasterKey(): Promise<Buffer | undefined> {
    if (this.#masterKeyLatch === undefined) {
      // Init-once: capture the provider call in a Promise so concurrent callers
      // share this single resolution.  Synchronous providers are wrapped in
      // Promise.resolve so the latch contract is consistent.
      this.#masterKeyLatch = Promise.resolve().then(() => this.#keyProvider());
    }
    return this.#masterKeyLatch;
  }
}
