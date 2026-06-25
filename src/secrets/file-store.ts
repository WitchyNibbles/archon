/**
 * @module secrets/file-store
 *
 * File-system helpers for the encrypted-file secret backend (P5-S3).
 *
 * Responsibilities:
 *   - Atomic write: temp-in-same-dir → fs.renameSync → chmod 0600 (CC-3)
 *   - O_EXCL lockfile: serialize concurrent writes across processes (CC-7)
 *   - Audit log: metadata-only append (ref, action, ts, actor — never value) (CC-6)
 *   - SecretRef re-validation before any audit/store write (CC-6)
 *   - Secrets dir creation with mode 0700 (CC-3)
 *
 * All file I/O uses Node built-in `node:fs` ONLY — no third-party deps.
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  openSync,
  closeSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { parseSecretRef } from "./secret-manager.ts";
import type { SecretRef } from "./secret-manager.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single encrypted entry stored in the secrets file. */
export interface StoredEntry {
  readonly ref: string;
  /** scrypt salt — base64-encoded. */
  readonly salt: string;
  /** AES-256-GCM IV — base64-encoded. */
  readonly iv: string;
  /** GCM authentication tag — base64-encoded. */
  readonly authTag: string;
  /** AES-256-GCM ciphertext — base64-encoded. */
  readonly ciphertext: string;
}

/** The full JSON structure written to `secrets.enc`. */
export interface SecretsFile {
  /** Version header — always 1 for the initial format. Start versioning from day one (CC-3). */
  readonly version: 1;
  readonly entries: readonly StoredEntry[];
}

/** One audit log line (JSONL format). */
export interface AuditRecord {
  readonly ref: string;
  readonly action: "set" | "rotate" | "delete";
  readonly ts: string;
  readonly actor: string;
}

// ---------------------------------------------------------------------------
// Dir + file paths
// ---------------------------------------------------------------------------

/** Returns the path to the secrets file. */
export function secretsFilePath(secretsDir: string): string {
  return join(secretsDir, "secrets.enc");
}

/** Returns the path to the audit log. */
export function auditLogPath(secretsDir: string): string {
  return join(secretsDir, "audit.log");
}

/** Returns the path to the write-lock file. */
export function lockFilePath(secretsDir: string): string {
  return join(secretsDir, ".write.lock");
}

// ---------------------------------------------------------------------------
// Dir creation
// ---------------------------------------------------------------------------

/**
 * Creates `secretsDir` with mode 0700 if it does not already exist.
 * Idempotent — safe to call on every backend construction.
 */
export function ensureSecretsDir(secretsDir: string): void {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Read the secrets file
// ---------------------------------------------------------------------------

/**
 * Reads and parses `secrets.enc`.
 * Returns an empty store (`{ version: 1, entries: [] }`) when the file does not exist.
 *
 * @throws If the file exists but is malformed JSON or has an unrecognized version.
 */
export function readSecretsFile(secretsDir: string): SecretsFile {
  const filePath = secretsFilePath(secretsDir);

  if (!existsSync(filePath)) {
    return { version: 1, entries: [] };
  }

  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `secrets.enc is not valid JSON — the file may be corrupted. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    (parsed as Record<string, unknown>)["version"] !== 1
  ) {
    throw new Error(
      "secrets.enc has an unrecognized version or missing version field. " +
        "Only version 1 is supported by this backend. " +
        "Manual migration required if upgrading from a future format.",
    );
  }

  const file = parsed as { version: number; entries: unknown };
  if (!Array.isArray(file.entries)) {
    throw new Error("secrets.enc: `entries` must be an array.");
  }

  return parsed as SecretsFile;
}

// ---------------------------------------------------------------------------
// Atomic write (CC-3)
// ---------------------------------------------------------------------------

/**
 * Atomically writes `data` to `secretsFilePath(secretsDir)` using the
 * same-dir temp-file-then-rename pattern.
 *
 * Steps:
 *   1. Create a temp file in `secretsDir` with mode 0600.
 *   2. Write `data` to the temp file.
 *   3. `fs.renameSync` (atomic on one filesystem) the temp over the target.
 *   4. `fs.chmodSync(target, 0o600)` — applied to the final path immediately
 *      after rename to prevent a create→chmod race on the temp path itself.
 *
 * The temp file uses a random suffix so it does not collide in concurrent scenarios.
 */
export function atomicWriteSecretsFile(secretsDir: string, data: SecretsFile): void {
  const targetPath = secretsFilePath(secretsDir);

  // Random 8-byte suffix to avoid temp-file collision.
  const tmpSuffix = randomBytes(8).toString("hex");
  const tmpPath = join(secretsDir, `.secrets_tmp_${tmpSuffix}.enc`);

  const serialized = JSON.stringify(data, null, 2);

  // Write temp with mode 0600 (no create→chmod race on the temp itself).
  writeFileSync(tmpPath, serialized, { encoding: "utf-8", mode: 0o600, flag: "w" });

  // Atomic rename on the same filesystem.
  renameSync(tmpPath, targetPath);

  // Ensure 0600 on the final target (rename preserves mode on Linux, but chmod
  // defensively after rename — the temp was already 0600, so this is belt-and-suspenders).
  chmodSync(targetPath, 0o600);
}

// ---------------------------------------------------------------------------
// O_EXCL write lock (CC-7)
// ---------------------------------------------------------------------------

/**
 * Attempts to acquire the O_EXCL write lock.
 *
 * Opens `<secretsDir>/.write.lock` with the `wx` flag (O_CREAT|O_EXCL|O_WRONLY).
 * If the file already exists (another writer holds the lock), throws EEXIST.
 * The caller MUST call `releaseLock` in a `finally` block.
 *
 * @returns The file descriptor of the lock file (passed to `releaseLock`).
 * @throws If the lock file already exists (EEXIST) — let the caller decide on retry.
 */
export function acquireLock(secretsDir: string): number {
  const lockPath = lockFilePath(secretsDir);
  // "wx" = O_CREAT | O_EXCL | O_WRONLY — throws EEXIST if file exists.
  const fd = openSync(lockPath, "wx");
  return fd;
}

/**
 * Releases the O_EXCL write lock by closing its fd and deleting the lock file.
 *
 * Safe to call even if `fd` is already closed (ignores errors on close).
 * Safe to call even if the lock file has already been deleted.
 */
export function releaseLock(secretsDir: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed — ignore.
  }
  try {
    unlinkSync(lockFilePath(secretsDir));
  } catch {
    // Already removed — ignore.
  }
}

/**
 * Acquires the O_EXCL lock with brief retries (up to `maxAttempts`) to handle
 * transient contention.  Retries are synchronous with a short spin-wait.
 *
 * @param secretsDir - The directory containing the lock file.
 * @param maxAttempts - Maximum number of acquisition attempts (default: 5).
 * @param retryDelayMs - Delay in ms between attempts (default: 50).
 * @returns The file descriptor of the acquired lock file.
 * @throws If the lock cannot be acquired within the allotted attempts.
 */
export function acquireLockWithRetry(
  secretsDir: string,
  maxAttempts = 5,
  retryDelayMs = 50,
): number {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return acquireLock(secretsDir);
    } catch (err) {
      const isEexist =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST";

      if (!isEexist) {
        // Not a contention error — re-throw immediately.
        throw err;
      }

      if (attempt === maxAttempts - 1) {
        throw new Error(
          `Failed to acquire secret-store write lock after ${maxAttempts} attempts. ` +
            `Another process may be holding the lock at "${lockFilePath(secretsDir)}". ` +
            `If no other process is running, delete the lock file and retry.`,
        );
      }

      // Synchronous spin-wait — acceptable for a CLI single-operator tool.
      const deadline = Date.now() + retryDelayMs;
      while (Date.now() < deadline) {
        // busy-wait
      }
    }
  }
  // Unreachable — loop always throws or returns, but TypeScript needs this.
  throw new Error("acquireLockWithRetry: unexpected exit from retry loop");
}

// ---------------------------------------------------------------------------
// Audit log (CC-6)
// ---------------------------------------------------------------------------

/**
 * Appends a metadata-only audit record to `<secretsDir>/audit.log`.
 *
 * Each record is a single JSON line (JSONL) containing:
 *   { ref, action, ts (ISO-8601), actor }
 *
 * The secret VALUE is NEVER included. The `ref` is re-validated via `parseSecretRef`
 * before writing, so an invalid ref is caught here even if a caller bypassed the
 * public API. (CC-6: "re-validate the ref against the allowlist before any write".)
 *
 * @param secretsDir - The secrets directory.
 * @param ref        - The SecretRef being acted on (re-validated here).
 * @param action     - The action being performed.
 * @param actor      - Identity string for the actor (e.g. "cli" or "backend").
 */
export function appendAuditRecord(
  secretsDir: string,
  ref: SecretRef,
  action: "set" | "rotate" | "delete",
  actor = "backend",
): void {
  // Re-validate the ref — CC-6: validate before any audit/store write.
  // parseSecretRef throws on invalid input, which surfaces here before any write.
  parseSecretRef(ref);

  const record: AuditRecord = {
    ref,
    action,
    ts: new Date().toISOString(),
    actor,
  };

  // SECURITY AUDIT: The value is intentionally NOT included in `record`.
  // If you see a secret value in this file, that is a CRITICAL regression.
  appendFileSync(auditLogPath(secretsDir), JSON.stringify(record) + "\n", {
    encoding: "utf-8",
  });
}

// ---------------------------------------------------------------------------
// File mode assertion helper
// ---------------------------------------------------------------------------

/**
 * Returns the permission bits (bottom 9 bits) of `filePath`.
 * Used in tests to assert mode === 0o600.
 */
export function getFileMode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}
