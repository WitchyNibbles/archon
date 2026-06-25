/**
 * Tests for P5-S4: `archon secret` admin verb + secret-store-factory.
 *
 * All tests inject:
 *   - A `SecretManager` backend (InMemorySecretManager or temp-dir
 *     EncryptedFileSecretManager with a fixed key for factory tests).
 *   - A fake `readSecretValue` so no TTY is required.
 *   - A sandbox `env` object so real process.env is never touched or read.
 *   - Captured `stdout` / `stderr` buffers for leak assertions.
 *
 * Coverage:
 *   A. secretCommand — set --from-file
 *      A1. Reads value from a valid owner-only file and stores it.
 *      A2. Rejects a world-readable file (mode 0o644) — clear error, no store write.
 *      A3. Rejects a symlink (O_NOFOLLOW) — clear error, no store write.
 *
 *   B. secretCommand — set --from-env
 *      B1. Stores the value AND deletes the var from the sandbox env.
 *      B2. Prints the "remove from .env.archon / clear shell history" instruction.
 *      B3. The var value is never echoed to stdout or stderr.
 *
 *   C. No inline-value path exists
 *      C1. --value flag throws (explicit guard).
 *      C2. A second positional arg (after ref) throws.
 *
 *   D. secretCommand — rotate
 *      D1. Rotates an existing secret.
 *      D2. Throws on absent ref with a clear "use set first" message.
 *
 *   E. secretCommand — list
 *      E1. Prints refs only.
 *      E2. The fixture secret value never appears in stdout.
 *
 *   F. secretCommand — delete
 *      F1. Removes the secret; subsequent list is empty.
 *
 *   G. createSecretManager
 *      G1. Resolves <dataRoot>/secrets/ from the data root.
 *      G2. Throws on unknown backend selector.
 *
 *   H. Leak guard — no command prints the fixture secret to stdout or stderr.
 *
 * Run:
 *   node --experimental-strip-types --test tests/forge-secret-admin.test.ts
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secretCommand } from "../src/admin/secret.ts";
import type { SecretCommandDeps, SecretValueReader } from "../src/admin/secret.ts";
import { createSecretManager } from "../src/secrets/secret-store-factory.ts";
import { InMemorySecretManager } from "../src/secrets/in-memory-backend.ts";
import { parseSecretRef } from "../src/secrets/secret-manager.ts";
import { createSecretValue } from "../src/secrets/secret-value.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fixture secret value that must NEVER appear in any output. */
const FIXTURE_SECRET = "sk-fixture-SUPER_SECRET_do_not_leak_abc123";
const FIXTURE_REF = "forge.test_key";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A simple Writable buffer that accumulates written text. */
class WritableBuffer {
  private chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get value(): string {
    return this.chunks.join("");
  }

  clear(): void {
    this.chunks = [];
  }
}

/** Build a fake SecretValueReader that returns a fixed value. */
function fakeReader(value: string): SecretValueReader {
  return async (_prompt: string) => value;
}

/** Build deps for secretCommand with captured output. */
function buildDeps(
  backend: InMemorySecretManager,
  options: {
    reader?: SecretValueReader;
    env?: NodeJS.ProcessEnv;
    stdout?: WritableBuffer;
    stderr?: WritableBuffer;
  } = {},
): { deps: SecretCommandDeps; out: WritableBuffer; err: WritableBuffer } {
  const out = options.stdout ?? new WritableBuffer();
  const err = options.stderr ?? new WritableBuffer();
  const deps: SecretCommandDeps = {
    backend,
    readSecretValue: options.reader ?? fakeReader(FIXTURE_SECRET),
    env: options.env ?? {},
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: err as unknown as NodeJS.WriteStream,
  };
  return { deps, out, err };
}

/**
 * Helper that intercepts process.exit so tests can assert the exit code
 * without actually terminating the process.
 */
async function runWithExitTrap(
  fn: () => Promise<void>,
): Promise<{ exited: boolean; exitCode: number | undefined }> {
  let exited = false;
  let exitCode: number | undefined;

  const original = process.exit.bind(process);
  // @ts-expect-error — we're patching the built-in
  process.exit = (code?: number) => {
    exited = true;
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  };

  try {
    await fn();
  } catch (err: unknown) {
    // Only swallow our synthetic exit error; re-throw anything else.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("process.exit(")) throw err;
  } finally {
    // @ts-expect-error — restore
    process.exit = original;
  }

  return { exited, exitCode };
}

// ---------------------------------------------------------------------------
// Temp dir for file-based tests
// ---------------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), "archon-secret-test-"));

after(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// A. set --from-file
// ---------------------------------------------------------------------------

describe("A. set --from-file", () => {
  it("A1. reads value from a valid owner-only file and stores it", async () => {
    const filePath = join(TMP_DIR, "valid-secret.txt");
    writeFileSync(filePath, FIXTURE_SECRET, { encoding: "utf8", mode: 0o600 });

    const backend = new InMemorySecretManager();
    const { deps, out } = buildDeps(backend);

    await secretCommand(["set", FIXTURE_REF, "--from-file", filePath], deps);

    // The secret should be stored.
    const stored = await backend.get(parseSecretRef(FIXTURE_REF));
    assert.ok(stored !== undefined, "backend should have the secret");
    assert.equal(stored.reveal(), FIXTURE_SECRET);

    // Output confirms storage without leaking the value.
    assert.match(out.value, /stored/i);
    assert.ok(!out.value.includes(FIXTURE_SECRET), "stdout must not contain the fixture secret");
  });

  it("A2. rejects a world-readable file (mode 0o644) — clear error, no store write", async () => {
    const filePath = join(TMP_DIR, "world-readable.txt");
    writeFileSync(filePath, FIXTURE_SECRET, { encoding: "utf8", mode: 0o644 });

    const backend = new InMemorySecretManager();
    const { deps, err } = buildDeps(backend);

    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["set", FIXTURE_REF, "--from-file", filePath], deps);
    });

    assert.ok(exited, "should have exited non-zero");
    assert.notEqual(exitCode, 0, "exit code should be non-zero");

    // Error message must be descriptive.
    const errText = err.value;
    assert.ok(
      errText.includes("world- or group-readable") || errText.includes("mode"),
      `error message should mention world/group-readable or mode; got: ${errText}`,
    );

    // Backend must not have stored anything.
    assert.equal(backend.size, 0, "backend should have no secrets after rejection");
  });

  it("A3. rejects a symlink (O_NOFOLLOW) — clear error, no store write", async () => {
    const targetPath = join(TMP_DIR, "symlink-target.txt");
    const linkPath = join(TMP_DIR, "symlink-to-secret.txt");
    writeFileSync(targetPath, FIXTURE_SECRET, { encoding: "utf8", mode: 0o600 });
    symlinkSync(targetPath, linkPath);

    const backend = new InMemorySecretManager();
    const { deps, err } = buildDeps(backend);

    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["set", FIXTURE_REF, "--from-file", linkPath], deps);
    });

    assert.ok(exited, "should have exited non-zero for a symlink");
    assert.notEqual(exitCode, 0);

    const errText = err.value;
    assert.ok(
      errText.includes("symbolic link") || errText.includes("symlink") || errText.includes("ELOOP") || errText.includes("ENOTDIR"),
      `error message should mention symlink rejection; got: ${errText}`,
    );

    assert.equal(backend.size, 0, "backend should have no secrets after symlink rejection");
  });
});

// ---------------------------------------------------------------------------
// B. set --from-env
// ---------------------------------------------------------------------------

describe("B. set --from-env", () => {
  it("B1. stores the value AND deletes the var from the sandbox env", async () => {
    const sandboxEnv: NodeJS.ProcessEnv = {
      MY_SECRET_VAR: FIXTURE_SECRET,
    };

    const backend = new InMemorySecretManager();
    const { deps } = buildDeps(backend, { env: sandboxEnv });

    await secretCommand(["set", FIXTURE_REF, "--from-env", "MY_SECRET_VAR"], deps);

    // The var must be gone from the sandbox env (CC-13 scrub).
    assert.equal(
      sandboxEnv["MY_SECRET_VAR"],
      undefined,
      "env var must be deleted from sandbox env after --from-env",
    );

    // The secret must be stored.
    const stored = await backend.get(parseSecretRef(FIXTURE_REF));
    assert.ok(stored !== undefined, "backend should have the secret after --from-env");
    assert.equal(stored.reveal(), FIXTURE_SECRET);
  });

  it("B2. prints the remove-from-.env.archon / clear shell history instruction", async () => {
    const sandboxEnv: NodeJS.ProcessEnv = {
      MY_SECRET_VAR2: FIXTURE_SECRET,
    };

    const backend = new InMemorySecretManager();
    const { deps, out } = buildDeps(backend, { env: sandboxEnv });

    await secretCommand(["set", FIXTURE_REF, "--from-env", "MY_SECRET_VAR2"], deps);

    // Instruction must be printed.
    const output = out.value;
    assert.ok(
      output.includes(".env.archon") && output.includes("history"),
      `instruction must mention BOTH .env.archon and shell history; got: ${output}`,
    );
  });

  it("B3. the var value is never echoed to stdout or stderr", async () => {
    const sandboxEnv: NodeJS.ProcessEnv = {
      MY_SECRET_VAR3: FIXTURE_SECRET,
    };

    const backend = new InMemorySecretManager();
    const out = new WritableBuffer();
    const err = new WritableBuffer();
    const { deps } = buildDeps(backend, { env: sandboxEnv, stdout: out, stderr: err });

    await secretCommand(["set", FIXTURE_REF, "--from-env", "MY_SECRET_VAR3"], deps);

    assert.ok(
      !out.value.includes(FIXTURE_SECRET),
      "stdout must not contain the fixture secret after --from-env",
    );
    assert.ok(
      !err.value.includes(FIXTURE_SECRET),
      "stderr must not contain the fixture secret after --from-env",
    );
  });
});

// ---------------------------------------------------------------------------
// C. No inline-value path exists
// ---------------------------------------------------------------------------

describe("C. No inline-value path", () => {
  it("C1. --value flag is explicitly rejected", async () => {
    const backend = new InMemorySecretManager();
    const { deps, err } = buildDeps(backend);

    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["set", FIXTURE_REF, "--value", FIXTURE_SECRET], deps);
    });

    assert.ok(exited, "--value should cause a non-zero exit");
    assert.notEqual(exitCode, 0);
    const errText = err.value;
    assert.ok(
      errText.includes("--value") || errText.includes("shell history"),
      `error should mention --value or shell history; got: ${errText}`,
    );

    // The FIXTURE_SECRET must not appear in the error output.
    assert.ok(
      !errText.includes(FIXTURE_SECRET),
      "error output must not echo the secret value passed via --value",
    );

    // Nothing was stored.
    assert.equal(backend.size, 0);
  });

  it("C2. a second positional arg after ref is rejected (no inline secret path)", async () => {
    const backend = new InMemorySecretManager();
    const { deps, err } = buildDeps(backend);

    const { exited, exitCode } = await runWithExitTrap(async () => {
      // Second positional arg would be interpreted as an inline value — must be rejected.
      await secretCommand(["set", FIXTURE_REF, FIXTURE_SECRET], deps);
    });

    assert.ok(exited, "second positional arg should cause a non-zero exit");
    assert.notEqual(exitCode, 0);
    const errText = err.value;
    assert.ok(
      errText.includes("positional") || errText.includes("shell history") || errText.includes("Unexpected"),
      `error should mention positional/inline rejection; got: ${errText}`,
    );
    assert.equal(backend.size, 0, "backend must have no secrets after inline-value rejection");
  });
});

// ---------------------------------------------------------------------------
// D. rotate
// ---------------------------------------------------------------------------

describe("D. rotate", () => {
  it("D1. rotates an existing secret", async () => {
    const backend = new InMemorySecretManager();
    // Pre-seed the backend.
    await backend.set(parseSecretRef(FIXTURE_REF), createSecretValue(FIXTURE_SECRET));

    const NEW_VALUE = "sk-rotated-NEW_SECRET_value_xyz";
    const { deps, out } = buildDeps(backend, { reader: fakeReader(NEW_VALUE) });

    await secretCommand(["rotate", FIXTURE_REF], deps);

    const stored = await backend.get(parseSecretRef(FIXTURE_REF));
    assert.ok(stored !== undefined);
    assert.equal(stored.reveal(), NEW_VALUE, "secret should be the new rotated value");
    assert.match(out.value, /rotat/i);
  });

  it("D2. throws on absent ref — clear 'use set first' message, non-zero exit", async () => {
    const backend = new InMemorySecretManager();
    const NEW_VALUE = "sk-rotated-NEW_SECRET_value_xyz";
    const { deps, err } = buildDeps(backend, { reader: fakeReader(NEW_VALUE) });

    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["rotate", "forge.nonexistent"], deps);
    });

    assert.ok(exited, "rotate on absent ref should exit non-zero");
    assert.notEqual(exitCode, 0);

    const errText = err.value;
    assert.ok(
      errText.includes("set") || errText.includes("no secret"),
      `error should mention 'set first' or 'no secret'; got: ${errText}`,
    );
  });
});

// ---------------------------------------------------------------------------
// E. list
// ---------------------------------------------------------------------------

describe("E. list", () => {
  it("E1. prints refs only", async () => {
    const backend = new InMemorySecretManager();
    await backend.set(parseSecretRef(FIXTURE_REF), createSecretValue(FIXTURE_SECRET));
    await backend.set(parseSecretRef("forge.other_key"), createSecretValue("another-secret-value-xyz"));

    const { deps, out } = buildDeps(backend);

    await secretCommand(["list"], deps);

    const output = out.value;
    assert.ok(output.includes(FIXTURE_REF), "output should include the ref name");
    assert.ok(output.includes("forge.other_key"), "output should include both refs");
  });

  it("E2. the fixture secret value never appears in stdout after list", async () => {
    const backend = new InMemorySecretManager();
    await backend.set(parseSecretRef(FIXTURE_REF), createSecretValue(FIXTURE_SECRET));

    const { deps, out, err } = buildDeps(backend);

    await secretCommand(["list"], deps);

    assert.ok(
      !out.value.includes(FIXTURE_SECRET),
      `list stdout must not contain the fixture secret; got: ${out.value}`,
    );
    assert.ok(
      !err.value.includes(FIXTURE_SECRET),
      `list stderr must not contain the fixture secret; got: ${err.value}`,
    );
  });
});

// ---------------------------------------------------------------------------
// F. delete
// ---------------------------------------------------------------------------

describe("F. delete", () => {
  it("F1. removes the secret; subsequent list is empty", async () => {
    const backend = new InMemorySecretManager();
    await backend.set(parseSecretRef(FIXTURE_REF), createSecretValue(FIXTURE_SECRET));

    const { deps, out } = buildDeps(backend);

    await secretCommand(["delete", FIXTURE_REF], deps);

    assert.match(out.value, /deleted/i);

    const refs = await backend.list();
    assert.equal(refs.length, 0, "backend should be empty after delete");

    const stored = await backend.get(parseSecretRef(FIXTURE_REF));
    assert.equal(stored, undefined);
  });
});

// ---------------------------------------------------------------------------
// G. createSecretManager (factory)
// ---------------------------------------------------------------------------

describe("G. createSecretManager", () => {
  it("G1. resolves <dataRoot>/secrets/ from the data root", () => {
    const customDataRoot = join(TMP_DIR, "factory-test-data-root");
    const expectedSecretsDir = join(customDataRoot, "secrets");

    // Inject an env that sets ARCHON_RUNTIME_DATA_ROOT to our custom root.
    const sandboxEnv: NodeJS.ProcessEnv = {
      ARCHON_RUNTIME_DATA_ROOT: customDataRoot,
      // A fixed master key for the backend — 64 hex chars.
      ARCHON_SECRETS_MASTER_KEY: "a".repeat(64),
    };

    // Should not throw; the directory may or may not exist yet.
    const manager = createSecretManager({ env: sandboxEnv, projectSlug: "archon-test" });

    // The returned manager is an EncryptedFileSecretManager — verify by calling list()
    // which does not require the master key and just reads the file (or returns []).
    // The secrets dir itself should be created by the constructor.
    assert.ok(manager !== undefined, "createSecretManager should return a manager");

    // Verify by listing — should return an empty array (fresh dir).
    // We run this asynchronously but the test framework handles it.
    return manager.list().then((refs) => {
      assert.ok(Array.isArray(refs), "list() should return an array");
      // Structurally assert the secrets dir was created at <dataRoot>/secrets/.
      assert.ok(
        existsSync(expectedSecretsDir),
        `secrets dir must be created at ${expectedSecretsDir}`,
      );
      assert.ok(
        statSync(expectedSecretsDir).isDirectory(),
        `${expectedSecretsDir} must be a directory`,
      );
    });
  });

  it("G2. throws on unknown backend selector", () => {
    const sandboxEnv: NodeJS.ProcessEnv = {
      ARCHON_SECRETS_BACKEND: "vault_enterprise",
    };

    assert.throws(
      () => createSecretManager({ env: sandboxEnv }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("vault_enterprise") || err.message.includes("Unknown secret backend"),
          `error should name the unknown selector; got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// H. Leak guard — no command path prints the fixture secret
// ---------------------------------------------------------------------------

describe("H. Leak guard", () => {
  const SECRET_COMMANDS: Array<{ name: string; args: string[]; setup?: (b: InMemorySecretManager) => Promise<void> }> = [
    {
      name: "set (stdin reader)",
      args: ["set", FIXTURE_REF],
      // Default reader returns FIXTURE_SECRET — it must not end up in output.
    },
    {
      name: "rotate",
      args: ["rotate", FIXTURE_REF],
      setup: async (b) => {
        await b.set(parseSecretRef(FIXTURE_REF), createSecretValue(FIXTURE_SECRET));
      },
    },
    {
      name: "list",
      args: ["list"],
      setup: async (b) => {
        await b.set(parseSecretRef(FIXTURE_REF), createSecretValue(FIXTURE_SECRET));
      },
    },
    {
      name: "delete",
      args: ["delete", FIXTURE_REF],
      setup: async (b) => {
        await b.set(parseSecretRef(FIXTURE_REF), createSecretValue(FIXTURE_SECRET));
      },
    },
  ];

  for (const tc of SECRET_COMMANDS) {
    it(`H. "${tc.name}" does not print the fixture secret to stdout or stderr`, async () => {
      const backend = new InMemorySecretManager();
      if (tc.setup !== undefined) {
        await tc.setup(backend);
      }

      const out = new WritableBuffer();
      const err = new WritableBuffer();

      // For rotate, use a different new value so we don't confuse "what was stored" with "what leaked".
      const reader = fakeReader(FIXTURE_SECRET);
      const { deps } = buildDeps(backend, { reader, stdout: out, stderr: err });

      // Run (may or may not exit non-zero — we don't care for this test).
      await runWithExitTrap(async () => {
        await secretCommand(tc.args, deps);
      });

      assert.ok(
        !out.value.includes(FIXTURE_SECRET),
        `"${tc.name}" stdout must not contain the fixture secret; got: ${out.value}`,
      );
      assert.ok(
        !err.value.includes(FIXTURE_SECRET),
        `"${tc.name}" stderr must not contain the fixture secret; got: ${err.value}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// I. Operator-error edge cases (common mistakes)
// ---------------------------------------------------------------------------

describe("I. operator-error edges", () => {
  it("I1. --from-file on a nonexistent path exits non-zero with a clear error", async () => {
    const backend = new InMemorySecretManager();
    const { deps, err } = buildDeps(backend);
    const missing = join(TMP_DIR, "does-not-exist-xyz.txt");
    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["set", FIXTURE_REF, "--from-file", missing], deps);
    });
    assert.ok(exited && exitCode !== 0, "nonexistent --from-file must exit non-zero");
    assert.ok(err.value.includes("cannot open") || err.value.toLowerCase().includes("enoent"),
      `error should explain the open failure; got: ${err.value}`);
    assert.equal(backend.size, 0, "nothing stored on a failed read");
  });

  it("I2. --from-file on a directory is rejected (not a regular file)", async () => {
    const backend = new InMemorySecretManager();
    const { deps, err } = buildDeps(backend);
    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["set", FIXTURE_REF, "--from-file", TMP_DIR], deps);
    });
    assert.ok(exited && exitCode !== 0, "a directory --from-file must exit non-zero");
    assert.ok(err.value.toLowerCase().includes("not a regular file") || err.value.includes("EISDIR")
      || err.value.includes("directory"), `error should reject the directory; got: ${err.value}`);
    assert.equal(backend.size, 0);
  });

  it("I3. --from-env with an unset/empty var exits non-zero and stores nothing", async () => {
    const backend = new InMemorySecretManager();
    const { deps } = buildDeps(backend, { env: { OTHER: "x" } });
    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["set", FIXTURE_REF, "--from-env", "UNSET_VAR"], deps);
    });
    assert.ok(exited && exitCode !== 0, "unset --from-env var must exit non-zero");
    assert.equal(backend.size, 0, "nothing stored when the env var is absent");
  });

  it("I4. set without a <ref> argument exits non-zero", async () => {
    const backend = new InMemorySecretManager();
    const filePath = join(TMP_DIR, "noref.txt");
    writeFileSync(filePath, FIXTURE_SECRET, { encoding: "utf8", mode: 0o600 });
    const { deps } = buildDeps(backend);
    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["set", "--from-file", filePath], deps);
    });
    assert.ok(exited && exitCode !== 0, "set without a ref must exit non-zero");
  });

  it("I5. delete without a <ref> argument exits non-zero", async () => {
    const backend = new InMemorySecretManager();
    const { deps } = buildDeps(backend);
    const { exited, exitCode } = await runWithExitTrap(async () => {
      await secretCommand(["delete"], deps);
    });
    assert.ok(exited && exitCode !== 0, "delete without a ref must exit non-zero");
  });
});
