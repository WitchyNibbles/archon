/**
 * install-shims.test.ts
 *
 * P4 (ci/p4-init-shims): verifies that the shipped install shims (install-archon.sh
 * and install-archon.ps1) are clean: no --experimental-strip-types, no src/ paths,
 * and that they delegate to the compiled dist/cli/archon-bin.js entry.
 *
 * Also asserts that setup-archon.{sh,ps1} never acquired the same drift.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(repoRoot, "scripts");

async function readShim(name: string): Promise<string> {
  return readFile(path.join(scriptsDir, name), "utf8");
}

// ---------------------------------------------------------------------------
// install-archon.sh
// ---------------------------------------------------------------------------

test("install-archon.sh: no --experimental-strip-types", async () => {
  const content = await readShim("install-archon.sh");
  assert.doesNotMatch(
    content,
    /--experimental-strip-types/,
    "install-archon.sh must not invoke the TypeScript source via strip-types"
  );
});

test("install-archon.sh: no src/ path reference", async () => {
  const content = await readShim("install-archon.sh");
  assert.doesNotMatch(
    content,
    /src\/install\/cli/,
    "install-archon.sh must not reference src/install/cli directly"
  );
});

test("install-archon.sh: delegates to compiled dist/cli/archon-bin.js", async () => {
  const content = await readShim("install-archon.sh");
  assert.match(
    content,
    /dist\/cli\/archon-bin\.js/,
    "install-archon.sh must reference the compiled dist/cli/archon-bin.js entry"
  );
});

test("install-archon.sh: passes init --apply to the bin", async () => {
  const content = await readShim("install-archon.sh");
  assert.match(
    content,
    /init --apply/,
    "install-archon.sh must forward 'init --apply' to the archon bin"
  );
});

test("install-archon.sh: forwards --target and extra args through", async () => {
  const content = await readShim("install-archon.sh");
  assert.match(
    content,
    /--target/,
    "install-archon.sh must pass --target to the CLI"
  );
});

// ---------------------------------------------------------------------------
// install-archon.ps1
// ---------------------------------------------------------------------------

test("install-archon.ps1: no --experimental-strip-types", async () => {
  const content = await readShim("install-archon.ps1");
  assert.doesNotMatch(
    content,
    /--experimental-strip-types/,
    "install-archon.ps1 must not invoke the TypeScript source via strip-types"
  );
});

test("install-archon.ps1: no src/ path reference", async () => {
  const content = await readShim("install-archon.ps1");
  assert.doesNotMatch(
    content,
    /src\/install\/cli/,
    "install-archon.ps1 must not reference src/install/cli directly"
  );
});

test("install-archon.ps1: delegates to compiled dist/cli/archon-bin.js", async () => {
  const content = await readShim("install-archon.ps1");
  assert.match(
    content,
    /dist[/\\]cli[/\\]archon-bin\.js/,
    "install-archon.ps1 must reference the compiled dist/cli/archon-bin.js entry"
  );
});

test("install-archon.ps1: passes init --apply to the bin", async () => {
  const content = await readShim("install-archon.ps1");
  assert.match(
    content,
    /init.*--apply|--apply.*init/,
    "install-archon.ps1 must forward 'init --apply' to the archon bin"
  );
});

test("install-archon.ps1: behaviorally mirrors .sh (both use compiled bin, both pass init --apply)", async () => {
  const sh = await readShim("install-archon.sh");
  const ps1 = await readShim("install-archon.ps1");
  // Neither shim should use strip-types
  assert.doesNotMatch(sh, /--experimental-strip-types/);
  assert.doesNotMatch(ps1, /--experimental-strip-types/);
  // Both must reference the compiled bin
  assert.match(sh, /dist\/cli\/archon-bin\.js/);
  assert.match(ps1, /dist[/\\]cli[/\\]archon-bin\.js/);
  // Both must invoke init --apply
  assert.match(sh, /init --apply/);
  assert.match(ps1, /init.*--apply|--apply.*init/);
});

// ---------------------------------------------------------------------------
// setup-archon.sh / setup-archon.ps1 — should never have acquired the same drift
// ---------------------------------------------------------------------------

test("setup-archon.sh: no --experimental-strip-types", async () => {
  const content = await readShim("setup-archon.sh");
  assert.doesNotMatch(
    content,
    /--experimental-strip-types/,
    "setup-archon.sh must not use strip-types"
  );
});

test("setup-archon.ps1: no --experimental-strip-types", async () => {
  const content = await readShim("setup-archon.ps1");
  assert.doesNotMatch(
    content,
    /--experimental-strip-types/,
    "setup-archon.ps1 must not use strip-types"
  );
});

// ---------------------------------------------------------------------------
// Compiled bin presence: dist/cli/archon-bin.js must exist after build
// ---------------------------------------------------------------------------

test("compiled bin dist/cli/archon-bin.js is present (requires 'npm run build:dist' to have run)", async () => {
  const binPath = path.join(repoRoot, "dist", "cli", "archon-bin.js");
  await assert.doesNotReject(
    access(binPath),
    `Expected compiled bin at ${binPath} — run 'npm run build:dist' before running tests`
  );
});
