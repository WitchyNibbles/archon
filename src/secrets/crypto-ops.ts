/**
 * @module secrets/crypto-ops
 *
 * Low-level AES-256-GCM + scrypt helpers for the encrypted-file secret backend (P5-S3).
 *
 * All crypto uses Node built-in `node:crypto` ONLY — no third-party deps.
 *
 * ## Cipher spec (CC-2)
 *   - Algorithm:  AES-256-GCM (AEAD — auth tag covers ciphertext + IV + additional data)
 *   - IV:         12 bytes, randomly generated per write via crypto.randomBytes(12)
 *                 NEVER derived, NEVER reused across entries or writes.
 *   - KDF:        scrypt (crypto.scryptSync) — derives a 32-byte data key from the
 *                 master key + a per-entry random salt.
 *   - KDF params: N=131072, r=8, p=1 (memory cost ≈ 128*N*r = 128 MB)
 *   - Salt:       16 bytes minimum, randomly generated per entry via crypto.randomBytes(16)
 *                 NEVER reused, NEVER derived. One salt per secret entry.
 *   - Auth tag:   16-byte GCM tag. setAuthTag() is called BEFORE decipher.final() so
 *                 the runtime verifies the tag before ANY plaintext bytes are returned.
 *                 A tampered ciphertext, tag, IV, or salt WILL cause final() to throw.
 *   - Data key:   derived from master key + salt on each operation; NEVER cached beyond
 *                 the duration of a single encrypt/decrypt call.
 *
 * ## Accepted residual (B.4 / CC-4)
 *   The master key and derived data key pass through Node's JS heap as ordinary strings /
 *   Buffers.  Node provides no secure-erase primitive for heap memory.  Accepted residual:
 *   the key material may persist in process memory until GC, and may appear in
 *   /proc/environ (before deletion), swap, or core dumps.  This is documented here per
 *   the council mandate and is an accepted risk for a single-operator local tool.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// ---------------------------------------------------------------------------
// Named KDF constants (CC-2 — never inline magic numbers)
// ---------------------------------------------------------------------------

/** scrypt cost parameter N. Higher = more memory + time. Set to 2^17 = 131072. */
export const SCRYPT_N = 131_072;

/** scrypt block size parameter. */
export const SCRYPT_R = 8;

/** scrypt parallelization parameter. */
export const SCRYPT_P = 1;

/** Derived key length in bytes for AES-256. */
export const KEY_BYTES = 32;

/** IV length in bytes for AES-256-GCM. */
export const IV_BYTES = 12;

/** GCM authentication tag length in bytes. */
export const TAG_BYTES = 16;

/** Per-entry salt length in bytes (≥16 per CC-2). */
export const SALT_BYTES = 16;

/**
 * maxmem for scryptSync — must accommodate N*r*128 bytes = 131072*8*128 = 128 MiB.
 * We add a 10% headroom.
 */
const SCRYPT_MAXMEM = Math.ceil(SCRYPT_N * SCRYPT_R * 128 * 1.1);

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypts `plaintext` using AES-256-GCM with a freshly derived data key.
 *
 * The data key is derived from `masterKey` + a freshly generated random `salt`
 * via scrypt.  A freshly generated random `iv` is used for the cipher.  Both
 * are returned so the caller can persist them alongside the ciphertext.
 *
 * The data key is NOT returned and is not held beyond this function call.
 *
 * @param masterKey - The master key buffer (e.g. from hex/base64 env var).
 * @param plaintext - The plaintext bytes to encrypt.
 * @returns An object with `salt`, `iv`, `authTag`, and `ciphertext` — all Buffers.
 */
export function encryptEntry(
  masterKey: Buffer,
  plaintext: Buffer,
): {
  readonly salt: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
} {
  // Fresh random salt per entry (CC-2: never reuse).
  const salt = randomBytes(SALT_BYTES);

  // Fresh random IV per write (CC-2: never derived, never reused).
  const iv = randomBytes(IV_BYTES);

  // Derive data key — scrypt with named constants.  Never cached beyond this call.
  const dataKey = scryptSync(masterKey, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // GCM tag defaults to 16 bytes — explicit for documentation.
  const authTag = cipher.getAuthTag();

  // Zero the data key buffer before releasing (best-effort; Node GC determines lifetime).
  dataKey.fill(0);

  return { salt, iv, authTag, ciphertext };
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypts `ciphertext` using AES-256-GCM, verifying the auth tag before returning
 * ANY plaintext (CC-2 verify-before-return guarantee).
 *
 * `decipher.setAuthTag(authTag)` is called before `decipher.final()`.  If the tag
 * does not match (tampered ciphertext, tag, IV, or salt) `final()` throws and this
 * function re-throws — no plaintext bytes are returned.
 *
 * @param masterKey   - The master key buffer.
 * @param salt        - The per-entry salt used during encryption.
 * @param iv          - The per-write IV used during encryption.
 * @param authTag     - The GCM authentication tag produced during encryption.
 * @param ciphertext  - The ciphertext bytes to decrypt.
 * @returns The decrypted plaintext buffer.
 * @throws If auth-tag verification fails (tampered data).
 */
export function decryptEntry(
  masterKey: Buffer,
  salt: Buffer,
  iv: Buffer,
  authTag: Buffer,
  ciphertext: Buffer,
): Buffer {
  // Re-derive the data key from master key + stored salt.  Not cached.
  const dataKey = scryptSync(masterKey, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);

  // CRITICAL (CC-2 verify-before-return): setAuthTag BEFORE any data flows through final().
  // If the auth tag does not match, final() throws — no plaintext is returned.
  decipher.setAuthTag(authTag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    // Zero the data key before re-throwing — best-effort.
    dataKey.fill(0);
    throw new Error(
      `AES-256-GCM auth-tag verification failed — ciphertext may be tampered. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Zero the data key buffer before returning.
  dataKey.fill(0);

  return plaintext;
}
