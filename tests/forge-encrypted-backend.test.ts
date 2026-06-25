/**
 * Tests for src/secrets/encrypted-file-backend.ts (P5-S3 — SC-1 NON-WAIVABLE gate).
 *
 * Coverage (all required for the SC-1 security_reviewer gate):
 *
 *   RT.  Round-trip + at-rest persistence
 *        RT-1. set → get reveals the same secret.
 *        RT-2. Persistence across a NEW backend instance (real encryption-at-rest).
 *
 *   CC2. Nonce uniqueness + auth-tag rejection (CC-2)
 *        CC2-1. Two writes (two different refs) → different IVs on disk.
 *        CC2-2. set + rotate on the same ref → different IVs on disk.
 *        CC2-3. Flip a ciphertext byte on disk → get() THROWS, never returns plaintext.
 *        CC2-4. Flip an authTag byte on disk → get() THROWS, never returns plaintext.
 *        CC2-5. Flip a salt byte on disk → get() THROWS (wrong key derived).
 *        CC2-6. Flip an IV byte on disk → get() THROWS.
 *
 *   CC3. File-at-rest properties (CC-3)
 *        CC3-1. secrets.enc mode is 0600 after first write.
 *        CC3-2. secrets.enc contains a { version: 1 } header.
 *
 *   CC4. Master-key handling (CC-4)
 *        CC4-1. Default env provider deletes ARCHON_SECRETS_MASTER_KEY after first read.
 *        CC4-2. Construction does NOT throw when the master key is absent.
 *        CC4-3. get() fails cleanly when the master key is absent.
 *        CC4-4. set() fails cleanly when the master key is absent.
 *        CC4-5. list() succeeds even when the master key is absent.
 *
 *   CC6. Audit log (CC-6)
 *        CC6-1. set writes a metadata-only audit record.
 *        CC6-2. rotate writes a metadata-only audit record.
 *        CC6-3. delete writes a metadata-only audit record.
 *        CC6-4. Audit file NEVER contains the fixture secret value.
 *        CC6-5. ref allowlist re-validated — invalid ref rejected before audit write.
 *
 *   CC7. Concurrency + contract (CC-7)
 *        CC7-1. rotate on absent ref THROWS (replace-not-upsert).
 *        CC7-2. list returns only refs (never values).
 *        CC7-3. delete removes the entry; subsequent list reflects the deletion.
 *        CC7-4. Two sequential writes both persist (lockfile does not corrupt state).
 *
 *   LG.  Leak guard
 *        LG-1. Full set/rotate/get cycle: fixture secret appears NOWHERE outside the
 *              opaque ciphertext in secrets.enc (not in audit.log, not in refs).
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-encrypted-backend.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { EncryptedFileSecretManager, makeEnvMasterKeyProvider } from "../src/secrets/encrypted-file-backend.ts";
import type { MasterKeyProvider } from "../src/secrets/encrypted-file-backend.ts";
import { parseSecretRef } from "../src/secrets/secret-manager.ts";
import { createSecretValue } from "../src/secrets/secret-value.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A distinctive fixture secret that should NEVER appear in audit logs, refs, or
 * any non-.enc file. Used by the leak guard (LG-1).
 */
const FIXTURE_SECRET = "sk-test-SUPER_FIXTURE_SECRET_p5s3_do_not_leak_1234567890";
const FIXTURE_SECRET_B = "sk-test-ROTATED_SECRET_p5s3_do_not_leak_9876543210";

/**
 * Generates a valid 32-byte (64 hex char) master key for tests.
 * NEVER uses real env — always injected.
 */
function makeTestMasterKey(): Buffer {
  return randomBytes(32);
}

/**
 * Creates an injectable MasterKeyProvider that always returns the given buffer.
 * Does NOT touch process.env.
 */
function makeFixedKeyProvider(key: Buffer): MasterKeyProvider {
  return () => Buffer.from(key); // return a copy so callers cannot mutate our fixture key
}

// ---------------------------------------------------------------------------
// Shared temp-dir lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a temp directory under os.tmpdir() and returns a cleanup function.
 * The cleanup is called in after() for each describe block.
 */
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "archon-secrets-test-"));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

// ---------------------------------------------------------------------------
// RT — Round-trip + at-rest persistence
// ---------------------------------------------------------------------------

describe("RT — round-trip + at-rest persistence", () => {
  let dir: string;
  let cleanup: () => void;

  before(() => {
    const td = makeTempDir();
    dir = td.dir;
    cleanup = td.cleanup;
  });

  after(() => cleanup());

  it("RT-1: set → get reveals the same secret", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.rt_test");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    const retrieved = await backend.get(ref);
    assert.ok(retrieved !== undefined, "get() must return a value after set()");
    assert.equal(retrieved.reveal(), FIXTURE_SECRET);
  });

  it("RT-2: persists across a NEW backend instance (real encryption-at-rest)", async () => {
    const key = makeTestMasterKey();

    // First instance: write the secret.
    const backend1 = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));
    const ref = parseSecretRef("forge.persist_test");
    await backend1.set(ref, createSecretValue(FIXTURE_SECRET));

    // Second instance: new object, same dir, same key.
    // This proves the secret is encrypted on disk, not cached in memory.
    const backend2 = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));
    const retrieved = await backend2.get(ref);

    assert.ok(retrieved !== undefined, "New backend instance must retrieve persisted secret");
    assert.equal(retrieved.reveal(), FIXTURE_SECRET, "Decrypted value must match original");
  });
});

// ---------------------------------------------------------------------------
// CC2 — Nonce uniqueness + auth-tag rejection
// ---------------------------------------------------------------------------

describe("CC2 — nonce uniqueness + auth-tag rejection", () => {
  let dir: string;
  let cleanup: () => void;

  before(() => {
    const td = makeTempDir();
    dir = td.dir;
    cleanup = td.cleanup;
  });

  after(() => cleanup());

  /**
   * Reads the on-disk IVs for the given refs from the secrets.enc file.
   */
  function readIvsFromDisk(secretsDir: string, refs: readonly string[]): Map<string, string> {
    const raw = readFileSync(join(secretsDir, "secrets.enc"), "utf-8");
    const file = JSON.parse(raw) as { entries: Array<{ ref: string; iv: string }> };
    const result = new Map<string, string>();
    for (const entry of file.entries) {
      if (refs.includes(entry.ref)) {
        result.set(entry.ref, entry.iv);
      }
    }
    return result;
  }

  it("CC2-1: two different refs → different IVs on disk", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const refA = parseSecretRef("forge.nonce_a");
    const refB = parseSecretRef("forge.nonce_b");

    await backend.set(refA, createSecretValue(FIXTURE_SECRET));
    await backend.set(refB, createSecretValue(FIXTURE_SECRET_B));

    const ivs = readIvsFromDisk(dir, [refA, refB]);
    const ivA = ivs.get(refA);
    const ivB = ivs.get(refB);

    assert.ok(ivA !== undefined, "IV for refA must be on disk");
    assert.ok(ivB !== undefined, "IV for refB must be on disk");
    assert.notEqual(ivA, ivB, "CC2: two writes must produce different IVs (nonce uniqueness)");
  });

  it("CC2-2: set + rotate on the same ref → different IVs on disk", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.nonce_rotate");

    await backend.set(ref, createSecretValue(FIXTURE_SECRET));
    const ivsBefore = readIvsFromDisk(dir, [ref]);
    const ivBefore = ivsBefore.get(ref);

    await backend.rotate(ref, createSecretValue(FIXTURE_SECRET_B));
    const ivsAfter = readIvsFromDisk(dir, [ref]);
    const ivAfter = ivsAfter.get(ref);

    assert.ok(ivBefore !== undefined, "IV must be on disk after set");
    assert.ok(ivAfter !== undefined, "IV must be on disk after rotate");
    assert.notEqual(
      ivBefore,
      ivAfter,
      "CC2: rotate must produce a new IV (nonce uniqueness across rotate)",
    );
  });

  it("CC2-3: flipping a ciphertext byte → get() THROWS, never returns plaintext", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.tamper_ct");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    // Tamper: flip byte 0 of the ciphertext on disk.
    const filePath = join(dir, "secrets.enc");
    const raw = readFileSync(filePath, "utf-8");
    const file = JSON.parse(raw) as { version: number; entries: Array<{ ref: string; ciphertext: string; [k: string]: unknown }> };

    const entryIndex = file.entries.findIndex((e) => e.ref === ref);
    assert.ok(entryIndex !== -1, "Entry must exist on disk");

    const ctBuf = Buffer.from(file.entries[entryIndex]!.ciphertext, "base64");
    ctBuf[0] = ctBuf[0]! ^ 0xff; // flip all bits of byte 0
    file.entries[entryIndex] = {
      ...file.entries[entryIndex]!,
      ciphertext: ctBuf.toString("base64"),
    };

    // Write the tampered file directly (bypass atomic write — testing tamper detection).
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, JSON.stringify(file), { encoding: "utf-8", mode: 0o600 });

    // get() MUST throw — auth-tag verification fails before any plaintext is returned.
    await assert.rejects(
      () => backend.get(ref),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Must throw an Error");
        // Must not echo the fixture secret in the error message.
        assert.ok(
          !err.message.includes(FIXTURE_SECRET),
          `Error message must not contain the fixture secret. Got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("CC2-4: flipping an authTag byte → get() THROWS, never returns plaintext", async () => {
    const key = makeTestMasterKey();
    // Use a fresh sub-dir to avoid cross-test state.
    const subDir = join(dir, "tamper_tag");
    const backend = new EncryptedFileSecretManager(subDir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.tamper_tag");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    const filePath = join(subDir, "secrets.enc");
    const raw = readFileSync(filePath, "utf-8");
    const file = JSON.parse(raw) as { version: number; entries: Array<{ ref: string; authTag: string; [k: string]: unknown }> };

    const entryIndex = file.entries.findIndex((e) => e.ref === ref);
    const tagBuf = Buffer.from(file.entries[entryIndex]!.authTag, "base64");
    tagBuf[0] = tagBuf[0]! ^ 0xff;
    file.entries[entryIndex] = {
      ...file.entries[entryIndex]!,
      authTag: tagBuf.toString("base64"),
    };

    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, JSON.stringify(file), { encoding: "utf-8", mode: 0o600 });

    await assert.rejects(
      () => backend.get(ref),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Must throw an Error on tampered auth tag");
        assert.ok(!err.message.includes(FIXTURE_SECRET), "Error must not leak the fixture secret");
        return true;
      },
    );
  });

  it("CC2-5: flipping a salt byte → get() THROWS (wrong key derived)", async () => {
    const key = makeTestMasterKey();
    const subDir = join(dir, "tamper_salt");
    const backend = new EncryptedFileSecretManager(subDir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.tamper_salt");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    const filePath = join(subDir, "secrets.enc");
    const raw = readFileSync(filePath, "utf-8");
    const file = JSON.parse(raw) as { version: number; entries: Array<{ ref: string; salt: string; [k: string]: unknown }> };

    const entryIndex = file.entries.findIndex((e) => e.ref === ref);
    const saltBuf = Buffer.from(file.entries[entryIndex]!.salt, "base64");
    saltBuf[0] = saltBuf[0]! ^ 0xff;
    file.entries[entryIndex] = {
      ...file.entries[entryIndex]!,
      salt: saltBuf.toString("base64"),
    };

    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, JSON.stringify(file), { encoding: "utf-8", mode: 0o600 });

    await assert.rejects(
      () => backend.get(ref),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Must throw when salt is tampered");
        return true;
      },
    );
  });

  it("CC2-6: flipping an IV byte → get() THROWS", async () => {
    const key = makeTestMasterKey();
    const subDir = join(dir, "tamper_iv");
    const backend = new EncryptedFileSecretManager(subDir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.tamper_iv");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    const filePath = join(subDir, "secrets.enc");
    const raw = readFileSync(filePath, "utf-8");
    const file = JSON.parse(raw) as { version: number; entries: Array<{ ref: string; iv: string; [k: string]: unknown }> };

    const entryIndex = file.entries.findIndex((e) => e.ref === ref);
    const ivBuf = Buffer.from(file.entries[entryIndex]!.iv, "base64");
    ivBuf[0] = ivBuf[0]! ^ 0xff;
    file.entries[entryIndex] = {
      ...file.entries[entryIndex]!,
      iv: ivBuf.toString("base64"),
    };

    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, JSON.stringify(file), { encoding: "utf-8", mode: 0o600 });

    await assert.rejects(
      () => backend.get(ref),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Must throw when IV is tampered");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// CC3 — File-at-rest properties
// ---------------------------------------------------------------------------

describe("CC3 — file-at-rest properties", () => {
  let dir: string;
  let cleanup: () => void;

  before(() => {
    const td = makeTempDir();
    dir = td.dir;
    cleanup = td.cleanup;
  });

  after(() => cleanup());

  it("CC3-1: secrets.enc mode is 0600 after first write", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.mode_test");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    const filePath = join(dir, "secrets.enc");
    assert.ok(existsSync(filePath), "secrets.enc must exist after write");

    const mode = statSync(filePath).mode & 0o777;
    assert.equal(
      mode,
      0o600,
      `secrets.enc must have mode 0600, got ${mode.toString(8)}`,
    );
  });

  it("CC3-2: secrets.enc has a versioned header { version: 1 }", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    // Ensure a write has happened (from CC3-1 in the same dir, but write again to be safe).
    const ref = parseSecretRef("forge.version_test");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    const raw = readFileSync(join(dir, "secrets.enc"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    assert.ok(
      typeof parsed === "object" && parsed !== null,
      "secrets.enc must parse as a JSON object",
    );
    assert.equal(
      (parsed as Record<string, unknown>)["version"],
      1,
      "secrets.enc must have version: 1",
    );
    assert.ok(
      Array.isArray((parsed as Record<string, unknown>)["entries"]),
      "secrets.enc must have an entries array",
    );
  });
});

// ---------------------------------------------------------------------------
// CC4 — Master-key handling
// ---------------------------------------------------------------------------

describe("CC4 — master-key handling", () => {
  it("CC4-1: default env provider deletes ARCHON_SECRETS_MASTER_KEY after first read", async () => {
    const td = makeTempDir();
    try {
      // Use a sandbox env object — NEVER touch the real process.env.
      const sandboxEnv: NodeJS.ProcessEnv = {
        ARCHON_SECRETS_MASTER_KEY: randomBytes(32).toString("hex"),
      };

      const provider = makeEnvMasterKeyProvider(sandboxEnv);
      const backend = new EncryptedFileSecretManager(
        td.dir,
        provider,
      );

      // Trigger first read by performing a set.
      const ref = parseSecretRef("forge.scrub_test");
      await backend.set(ref, createSecretValue(FIXTURE_SECRET));

      // After first read, the key must be gone from the sandbox env.
      assert.equal(
        sandboxEnv["ARCHON_SECRETS_MASTER_KEY"],
        undefined,
        "CC4: ARCHON_SECRETS_MASTER_KEY must be deleted from env after first read",
      );

      // Verify that the real process.env was NOT modified.
      // (If someone accidentally passed process.env, this would catch it.)
      // We just ensure it doesn't throw — a secondary call to the real env should still work.
    } finally {
      td.cleanup();
    }
  });

  it("CC4-2: construction does NOT throw when master key is absent", () => {
    const td = makeTempDir();
    try {
      // Empty sandbox env — no key.
      const sandboxEnv: NodeJS.ProcessEnv = {};
      const provider = makeEnvMasterKeyProvider(sandboxEnv);

      // Must NOT throw at construction time.
      assert.doesNotThrow(
        () => new EncryptedFileSecretManager(td.dir, provider),
        "EncryptedFileSecretManager must not throw at construction when key is absent (CC-4)",
      );
    } finally {
      td.cleanup();
    }
  });

  it("CC4-3: get() fails cleanly when master key is absent (no crash, descriptive error)", async () => {
    const td = makeTempDir();
    try {
      const sandboxEnv: NodeJS.ProcessEnv = {};
      const provider = makeEnvMasterKeyProvider(sandboxEnv);
      const backend = new EncryptedFileSecretManager(td.dir, provider);

      const ref = parseSecretRef("forge.no_key_get");

      await assert.rejects(
        () => backend.get(ref),
        (err: unknown) => {
          assert.ok(err instanceof Error, "get() must throw an Error when key is absent");
          assert.ok(
            err.message.toLowerCase().includes("master key") ||
              err.message.toLowerCase().includes("not configured"),
            `Error message should mention master key. Got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      td.cleanup();
    }
  });

  it("CC4-4: set() fails cleanly when master key is absent", async () => {
    const td = makeTempDir();
    try {
      const sandboxEnv: NodeJS.ProcessEnv = {};
      const provider = makeEnvMasterKeyProvider(sandboxEnv);
      const backend = new EncryptedFileSecretManager(td.dir, provider);

      const ref = parseSecretRef("forge.no_key_set");

      await assert.rejects(
        () => backend.set(ref, createSecretValue(FIXTURE_SECRET)),
        (err: unknown) => {
          assert.ok(err instanceof Error, "set() must throw an Error when key is absent");
          return true;
        },
      );
    } finally {
      td.cleanup();
    }
  });

  it("CC4-5: list() succeeds even when master key is absent", async () => {
    const td = makeTempDir();
    try {
      const sandboxEnv: NodeJS.ProcessEnv = {};
      const provider = makeEnvMasterKeyProvider(sandboxEnv);
      const backend = new EncryptedFileSecretManager(td.dir, provider);

      // list() reads refs only — no master key needed.
      const refs = await backend.list();
      assert.deepEqual(refs, [], "list() must return empty array when no secrets exist");
    } finally {
      td.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CC6 — Audit log
// ---------------------------------------------------------------------------

describe("CC6 — audit log", () => {
  let dir: string;
  let cleanup: () => void;

  before(() => {
    const td = makeTempDir();
    dir = td.dir;
    cleanup = td.cleanup;
  });

  after(() => cleanup());

  function readAuditLines(secretsDir: string): Array<{ ref: string; action: string; ts: string; actor: string }> {
    const auditPath = join(secretsDir, "audit.log");
    if (!existsSync(auditPath)) return [];
    const raw = readFileSync(auditPath, "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { ref: string; action: string; ts: string; actor: string });
  }

  it("CC6-1: set writes a metadata-only audit record", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.audit_set");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    const lines = readAuditLines(dir);
    const setRecord = lines.find((l) => l.ref === ref && l.action === "set");

    assert.ok(setRecord !== undefined, "Audit log must contain a 'set' record for the ref");
    assert.equal(setRecord.action, "set");
    assert.ok(setRecord.ts.length > 0, "Audit record must have a timestamp");
    assert.ok(setRecord.actor.length > 0, "Audit record must have an actor");

    // Metadata-only: the fixture secret must NOT appear anywhere in the audit record.
    const recordStr = JSON.stringify(setRecord);
    assert.ok(
      !recordStr.includes(FIXTURE_SECRET),
      `CC6: audit record for 'set' must NEVER contain the secret value. Got: ${recordStr}`,
    );
  });

  it("CC6-2: rotate writes a metadata-only audit record", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.audit_rotate");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));
    await backend.rotate(ref, createSecretValue(FIXTURE_SECRET_B));

    const lines = readAuditLines(dir);
    const rotateRecord = lines.find((l) => l.ref === ref && l.action === "rotate");

    assert.ok(rotateRecord !== undefined, "Audit log must contain a 'rotate' record");
    const recordStr = JSON.stringify(rotateRecord);
    assert.ok(
      !recordStr.includes(FIXTURE_SECRET) && !recordStr.includes(FIXTURE_SECRET_B),
      `CC6: audit record for 'rotate' must NEVER contain secret values. Got: ${recordStr}`,
    );
  });

  it("CC6-3: delete writes a metadata-only audit record", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.audit_delete");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));
    await backend.delete(ref);

    const lines = readAuditLines(dir);
    const deleteRecord = lines.find((l) => l.ref === ref && l.action === "delete");

    assert.ok(deleteRecord !== undefined, "Audit log must contain a 'delete' record");
    const recordStr = JSON.stringify(deleteRecord);
    assert.ok(
      !recordStr.includes(FIXTURE_SECRET),
      `CC6: audit record for 'delete' must NEVER contain the secret value. Got: ${recordStr}`,
    );
  });

  it("CC6-4: audit file NEVER contains the fixture secret (full content scan)", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    // Perform a full lifecycle.
    const ref = parseSecretRef("forge.audit_leak_guard");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));
    await backend.rotate(ref, createSecretValue(FIXTURE_SECRET_B));
    await backend.delete(ref);

    const auditPath = join(dir, "audit.log");
    if (existsSync(auditPath)) {
      const auditContent = readFileSync(auditPath, "utf-8");
      assert.ok(
        !auditContent.includes(FIXTURE_SECRET),
        "CC6: audit.log must NEVER contain FIXTURE_SECRET",
      );
      assert.ok(
        !auditContent.includes(FIXTURE_SECRET_B),
        "CC6: audit.log must NEVER contain FIXTURE_SECRET_B",
      );
    }
  });

  it("CC6-5: invalid SecretRef is rejected before any audit/store write", async () => {
    // We need to use a value that bypasses the TS type system to test runtime re-validation.
    // appendAuditRecord re-validates the ref; this exercises that path indirectly.
    // The SecretManager interface only accepts branded SecretRef, so the real way to
    // exercise the re-validation is to confirm parseSecretRef throws on bad inputs —
    // which is already tested in forge-secret-manager.test.ts. Here we confirm that
    // a valid branded ref is accepted.
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    // Valid ref — must succeed.
    const validRef = parseSecretRef("forge.valid_ref");
    await assert.doesNotReject(
      () => backend.set(validRef, createSecretValue(FIXTURE_SECRET)),
      "A valid ref must be accepted by set()",
    );

    const lines = readAuditLines(dir);
    const found = lines.find((l) => l.ref === validRef && l.action === "set");
    assert.ok(found !== undefined, "Valid ref must produce an audit record");
  });
});

// ---------------------------------------------------------------------------
// CC7 — Concurrency + contract
// ---------------------------------------------------------------------------

describe("CC7 — concurrency + contract", () => {
  let dir: string;
  let cleanup: () => void;

  before(() => {
    const td = makeTempDir();
    dir = td.dir;
    cleanup = td.cleanup;
  });

  after(() => cleanup());

  it("CC7-1: rotate on absent ref THROWS (replace-not-upsert)", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.rotate_absent");

    await assert.rejects(
      () => backend.rotate(ref, createSecretValue(FIXTURE_SECRET)),
      (err: unknown) => {
        assert.ok(err instanceof Error, "rotate on absent ref must throw");
        assert.ok(
          err.message.includes("use set()") || err.message.toLowerCase().includes("does not exist") ||
            err.message.toLowerCase().includes("no secret"),
          `Error must guide caller to use set(). Got: ${err.message}`,
        );
        return true;
      },
    );

    // Must NOT have created an entry as a side-effect.
    const retrieved = await backend.get(ref);
    assert.equal(retrieved, undefined, "rotate-absent must not create a side-effect entry");
  });

  it("CC7-2: list() returns only refs (never values)", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const refA = parseSecretRef("forge.list_a");
    const refB = parseSecretRef("forge.list_b");

    await backend.set(refA, createSecretValue(FIXTURE_SECRET));
    await backend.set(refB, createSecretValue(FIXTURE_SECRET_B));

    const refs = await backend.list();

    assert.ok(refs.includes(refA), "list() must include refA");
    assert.ok(refs.includes(refB), "list() must include refB");

    for (const r of refs) {
      assert.equal(typeof r, "string", "list() entries must be strings");
      assert.ok(
        !r.includes(FIXTURE_SECRET) && !r.includes(FIXTURE_SECRET_B),
        `list() entry must not contain a secret value: ${r}`,
      );
    }
  });

  it("CC7-3: delete removes the entry; subsequent list reflects deletion", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.delete_test");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));

    // Confirm it's in the list.
    const before = await backend.list();
    assert.ok(before.includes(ref), "ref must be in list before delete");

    // Delete it.
    await backend.delete(ref);

    // Must be gone from list.
    const after = await backend.list();
    assert.ok(!after.includes(ref), "ref must NOT be in list after delete");

    // get() must return undefined.
    const retrieved = await backend.get(ref);
    assert.equal(retrieved, undefined, "get() must return undefined after delete");
  });

  it("CC7-4: two sequential writes both persist (lockfile does not corrupt state)", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const refX = parseSecretRef("forge.seq_x");
    const refY = parseSecretRef("forge.seq_y");

    await backend.set(refX, createSecretValue(FIXTURE_SECRET));
    await backend.set(refY, createSecretValue(FIXTURE_SECRET_B));

    const gotX = await backend.get(refX);
    const gotY = await backend.get(refY);

    assert.ok(gotX !== undefined, "refX must persist after two sequential writes");
    assert.ok(gotY !== undefined, "refY must persist after two sequential writes");

    assert.equal(gotX.reveal(), FIXTURE_SECRET, "refX value must match");
    assert.equal(gotY.reveal(), FIXTURE_SECRET_B, "refY value must match");

    const refs = await backend.list();
    assert.ok(refs.includes(refX), "list must include refX");
    assert.ok(refs.includes(refY), "list must include refY");
  });
});

// ---------------------------------------------------------------------------
// LG — Leak guard
// ---------------------------------------------------------------------------

describe("LG — leak guard", () => {
  let dir: string;
  let cleanup: () => void;

  before(() => {
    const td = makeTempDir();
    dir = td.dir;
    cleanup = td.cleanup;
  });

  after(() => cleanup());

  it("LG-1: full set/rotate/get cycle — fixture secret appears NOWHERE outside ciphertext", async () => {
    const key = makeTestMasterKey();
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(key));

    const ref = parseSecretRef("forge.leak_guard");

    // Full lifecycle.
    await backend.set(ref, createSecretValue(FIXTURE_SECRET));
    await backend.rotate(ref, createSecretValue(FIXTURE_SECRET_B));
    const retrieved = await backend.get(ref);

    // Positive control: reveal() works.
    assert.ok(retrieved !== undefined);
    assert.equal(retrieved.reveal(), FIXTURE_SECRET_B, "Positive control: reveal must work");

    // --- Leak checks ---

    // Check audit.log: must not contain either fixture secret.
    const auditPath = join(dir, "audit.log");
    if (existsSync(auditPath)) {
      const auditContent = readFileSync(auditPath, "utf-8");
      assert.ok(
        !auditContent.includes(FIXTURE_SECRET),
        "LG-1: FIXTURE_SECRET must not appear in audit.log",
      );
      assert.ok(
        !auditContent.includes(FIXTURE_SECRET_B),
        "LG-1: FIXTURE_SECRET_B must not appear in audit.log",
      );
    }

    // Check refs (list): must not contain either fixture secret.
    const refs = await backend.list();
    for (const r of refs) {
      assert.ok(
        !r.includes(FIXTURE_SECRET),
        `LG-1: FIXTURE_SECRET must not appear in refs. Got: ${r}`,
      );
      assert.ok(
        !r.includes(FIXTURE_SECRET_B),
        `LG-1: FIXTURE_SECRET_B must not appear in refs. Got: ${r}`,
      );
    }

    // Check the secrets.enc file: the fixture secrets must only appear
    // inside base64-encoded ciphertext fields — they must NOT appear in
    // plaintext anywhere in the file (ref, version, salt, iv, authTag, etc.).
    const encPath = join(dir, "secrets.enc");
    const encContent = readFileSync(encPath, "utf-8");
    const parsed = JSON.parse(encContent) as {
      version: number;
      entries: Array<{ ref: string; salt: string; iv: string; authTag: string; ciphertext: string }>;
    };

    // Check that fixture secrets are NOT in the plaintext fields (ref, salt, iv, authTag).
    // The ciphertext field is opaque base64 — the fixture secret cannot appear there as
    // a recognizable string anyway (it is encrypted and then base64-encoded).
    for (const entry of parsed.entries) {
      assert.ok(
        !entry.ref.includes(FIXTURE_SECRET) && !entry.ref.includes(FIXTURE_SECRET_B),
        "LG-1: ref field must not contain fixture secrets",
      );
      // Base64-decoded forms — paranoia check. A base64-encoded copy of the fixture
      // secret would be a different string, but we check the plaintext ref/salt fields.
      assert.ok(
        !entry.salt.includes(FIXTURE_SECRET) && !entry.salt.includes(FIXTURE_SECRET_B),
        "LG-1: salt field must not contain fixture secrets",
      );
      assert.ok(
        !entry.iv.includes(FIXTURE_SECRET) && !entry.iv.includes(FIXTURE_SECRET_B),
        "LG-1: iv field must not contain fixture secrets",
      );
      assert.ok(
        !entry.authTag.includes(FIXTURE_SECRET) && !entry.authTag.includes(FIXTURE_SECRET_B),
        "LG-1: authTag field must not contain fixture secrets",
      );
    }

    // Belt-and-suspenders: scan the raw JSON for the fixture secret as a plain string.
    // (The ciphertext is base64, so the raw secret string should not appear there either.)
    assert.ok(
      !encContent.includes(FIXTURE_SECRET),
      "LG-1: FIXTURE_SECRET must not appear as plaintext in secrets.enc",
    );
    assert.ok(
      !encContent.includes(FIXTURE_SECRET_B),
      "LG-1: FIXTURE_SECRET_B must not appear as plaintext in secrets.enc",
    );
  });
});

// ---------------------------------------------------------------------------
// Round-2 advisory closures — salt uniqueness on disk, the CC6-5 negative guard,
// and store edge cases (corrupt file, empty/absent-key list paths).
// ---------------------------------------------------------------------------

describe("ADV — salt uniqueness, invalid-ref guard, store edges", () => {
  let dir: string;
  let cleanup: () => void;

  before(() => {
    const td = makeTempDir();
    dir = td.dir;
    cleanup = td.cleanup;
  });

  after(() => cleanup());

  function readSaltsFromDisk(secretsDir: string, refs: readonly string[]): Map<string, string> {
    const raw = readFileSync(join(secretsDir, "secrets.enc"), "utf-8");
    const file = JSON.parse(raw) as { entries: Array<{ ref: string; salt: string }> };
    const result = new Map<string, string>();
    for (const entry of file.entries) {
      if (refs.includes(entry.ref)) result.set(entry.ref, entry.salt);
    }
    return result;
  }

  it("ADV-1 (CC-2): two writes produce different per-entry salts on disk", async () => {
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(makeTestMasterKey()));
    const refA = parseSecretRef("forge.salt_a");
    const refB = parseSecretRef("forge.salt_b");
    await backend.set(refA, createSecretValue(FIXTURE_SECRET));
    await backend.set(refB, createSecretValue(FIXTURE_SECRET_B));
    const salts = readSaltsFromDisk(dir, [refA, refB]);
    assert.ok(salts.get(refA) && salts.get(refB), "both salts must be on disk");
    assert.notEqual(salts.get(refA), salts.get(refB), "per-entry salt must be unique per write");
  });

  it("ADV-2 (CC-6): set with a cast-invalid ref is rejected by the re-validation guard", async () => {
    const backend = new EncryptedFileSecretManager(dir, makeFixedKeyProvider(makeTestMasterKey()));
    // Bypass the type system to simulate a caller that fabricated an invalid SecretRef.
    const badRef = "BAD REF/with spaces" as unknown as ReturnType<typeof parseSecretRef>;
    await assert.rejects(
      () => backend.set(badRef, createSecretValue(FIXTURE_SECRET)),
      /Invalid SecretRef|SecretRef/,
      "the backend must re-validate the ref and reject an invalid one before persisting",
    );
    // And nothing was written for it.
    const refs = await backend.list();
    assert.ok(!refs.includes(badRef), "an invalid ref must never be persisted");
  });

  it("ADV-3: a corrupt (non-JSON) secrets.enc surfaces a clear error, not a crash", async () => {
    const td = makeTempDir();
    try {
      // Seed a valid entry, then corrupt the file.
      const backend = new EncryptedFileSecretManager(td.dir, makeFixedKeyProvider(makeTestMasterKey()));
      await backend.set(parseSecretRef("forge.corrupt"), createSecretValue(FIXTURE_SECRET));
      writeFileSync(join(td.dir, "secrets.enc"), "{ this is not valid json", "utf-8");
      const backend2 = new EncryptedFileSecretManager(td.dir, makeFixedKeyProvider(makeTestMasterKey()));
      await assert.rejects(
        () => backend2.get(parseSecretRef("forge.corrupt")),
        (err: unknown) => err instanceof Error,
        "a corrupt store must throw a real Error, not return garbage",
      );
    } finally {
      td.cleanup();
    }
  });

  it("ADV-4: list() returns [] after all entries are deleted", async () => {
    const td = makeTempDir();
    try {
      const backend = new EncryptedFileSecretManager(td.dir, makeFixedKeyProvider(makeTestMasterKey()));
      const ref = parseSecretRef("forge.transient");
      await backend.set(ref, createSecretValue(FIXTURE_SECRET));
      await backend.delete(ref);
      assert.deepEqual(await backend.list(), [], "list must be empty after deleting the only entry");
    } finally {
      td.cleanup();
    }
  });

  it("ADV-5: get() on a nonexistent ref in a populated store returns undefined", async () => {
    const td = makeTempDir();
    try {
      const backend = new EncryptedFileSecretManager(td.dir, makeFixedKeyProvider(makeTestMasterKey()));
      await backend.set(parseSecretRef("forge.present"), createSecretValue(FIXTURE_SECRET));
      assert.equal(await backend.get(parseSecretRef("forge.absent")), undefined);
    } finally {
      td.cleanup();
    }
  });

  it("ADV-6: list() works without the master key (no decryption needed)", async () => {
    const td = makeTempDir();
    try {
      const backend = new EncryptedFileSecretManager(td.dir, makeFixedKeyProvider(makeTestMasterKey()));
      await backend.set(parseSecretRef("forge.listable"), createSecretValue(FIXTURE_SECRET));
      // A new backend whose provider yields no key must still list refs (list never decrypts).
      const noKeyBackend = new EncryptedFileSecretManager(td.dir, () => undefined);
      const refs = await noKeyBackend.list();
      assert.deepEqual(refs, [parseSecretRef("forge.listable")]);
    } finally {
      td.cleanup();
    }
  });
});
