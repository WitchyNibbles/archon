/**
 * install-shims.test.ts
 *
 * P4 (ci/p4-init-shims): verifies that the shipped install shims
 * (install-archon.sh and install-archon.ps1) are clean: no strip-types, no src/
 * paths, and that they delegate to the compiled dist/cli/archon-bin.js entry.
 *
 * Tests that require a built dist/ (dist/cli/archon-bin.js) are skipped when
 * the bin is absent.  The pack-install CI job (which runs build:dist before
 * installing the tarball) provides authoritative compiled-bin coverage; the
 * unit-tests job only runs npm ci + coverage and MUST NOT fail on missing dist.
 *
 * Security acceptance notes (LOW, owner: infra_engineer):
 *   • No bin checksum / signature: in-scope for a local npm-ecosystem dev tool.
 *     Checksum / absolute-path hardening is deferred to a future
 *     enterprise-deployment hardening initiative.
 *   • `node` via ambient PATH: npm-ecosystem standard; shims inherit the shell
 *     environment where the operator already ran `npm install`.  An absolute Node
 *     path is impractical across dev/CI platforms.
 *
 * assert-scripts-clean regex boundary (accepted, owner: infra_engineer):
 *   The regex `experimental-strip-types\s+\S*src/` uses forward slashes only.
 *   Historical .ps1 regressions also used forward slashes (node CLI on Windows
 *   accepts forward slashes for file paths).  A backslash variant has never
 *   appeared in any shipped install shim; the risk is accepted and documented.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access, constants, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(repoRoot, "scripts");
const assertScriptsCleanScript = path.join(repoRoot, "scripts", "ci", "assert-scripts-clean.mjs");
const binPath = path.join(repoRoot, "dist", "cli", "archon-bin.js");

const execFileAsync = promisify(execFile);

/** Returns true when the compiled bin exists (build:dist has run). */
async function compiledBinPresent(): Promise<boolean> {
  try {
    await access(binPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readShim(name: string): Promise<string> {
  return readFile(path.join(scriptsDir, name), "utf8");
}

// ---------------------------------------------------------------------------
// install-archon.sh — static content assertions
// ---------------------------------------------------------------------------

test("install-archon.sh: no strip-types flag", async () => {
  const content = await readShim("install-archon.sh");
  assert.doesNotMatch(
    content,
    /--experimental-strip-types/,
    "install-archon.sh must not invoke the TypeScript source via strip-types"
  );
});

test("install-archon.sh: no src/install/cli path reference", async () => {
  // Fast subset guard: src/install/cli is the specific wrong path used before.
  // The broader set (any src/ in combination with strip-types) is enforced by
  // assert-scripts-clean.mjs in the pack-install CI job.
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

test("install-archon.sh: forwards --target and extra args (${@:2}) to the bin", async () => {
  const content = await readShim("install-archon.sh");
  assert.match(content, /--target/, "install-archon.sh must pass --target to the CLI");
  // ${@:2} passes all args after $1 (e.g. --with-grafana, --with-obsidian)
  assert.match(content, /\$\{@:2\}/, "install-archon.sh must forward extra args via ${@:2}");
});

// ---------------------------------------------------------------------------
// install-archon.ps1 — static content assertions
// ---------------------------------------------------------------------------

test("install-archon.ps1: no strip-types flag", async () => {
  const content = await readShim("install-archon.ps1");
  assert.doesNotMatch(
    content,
    /--experimental-strip-types/,
    "install-archon.ps1 must not invoke the TypeScript source via strip-types"
  );
});

test("install-archon.ps1: no src/install/cli path reference", async () => {
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

test("install-archon.ps1: uses GetFullPath (not Resolve-Path invocation) so non-existent targets work", async () => {
  const content = await readShim("install-archon.ps1");
  assert.match(
    content,
    /GetFullPath/,
    "install-archon.ps1 must use GetFullPath to resolve target path without requiring the directory to exist"
  );
  // Reject the actual PS1 invocation pattern (not just the word in a comment).
  // Resolve-Path throws ItemNotFoundException when the path does not exist;
  // GetFullPath resolves without I/O so the CLI can emit the meaningful error.
  assert.doesNotMatch(
    content,
    /^\s*\$\w+\s*=\s*\(?\s*Resolve-Path\b/m,
    "install-archon.ps1 must not assign via Resolve-Path (throws on non-existent dirs)"
  );
});

test("install-archon.ps1: supports passthrough args for --with-grafana and similar flags", async () => {
  const content = await readShim("install-archon.ps1");
  assert.match(
    content,
    /AdditionalArgs|ValueFromRemainingArguments/,
    "install-archon.ps1 must accept and forward additional arguments (e.g. --with-grafana)"
  );
});

// ---------------------------------------------------------------------------
// Lockstep: .sh and .ps1 behave equivalently
// ---------------------------------------------------------------------------

test("install-archon.sh and .ps1: behaviorally in lockstep (compiled bin, init --apply, no strip-types)", async () => {
  const sh = await readShim("install-archon.sh");
  const ps1 = await readShim("install-archon.ps1");
  assert.doesNotMatch(sh, /--experimental-strip-types/);
  assert.doesNotMatch(ps1, /--experimental-strip-types/);
  assert.match(sh, /dist\/cli\/archon-bin\.js/);
  assert.match(ps1, /dist[/\\]cli[/\\]archon-bin\.js/);
  assert.match(sh, /init --apply/);
  assert.match(ps1, /init.*--apply|--apply.*init/);
});

// ---------------------------------------------------------------------------
// setup-archon.sh / setup-archon.ps1 — should never acquire the same drift
// ---------------------------------------------------------------------------

test("setup-archon.sh: no strip-types flag", async () => {
  const content = await readShim("setup-archon.sh");
  assert.doesNotMatch(content, /--experimental-strip-types/, "setup-archon.sh must not use strip-types");
});

test("setup-archon.ps1: no strip-types flag", async () => {
  const content = await readShim("setup-archon.ps1");
  assert.doesNotMatch(content, /--experimental-strip-types/, "setup-archon.ps1 must not use strip-types");
});

// ---------------------------------------------------------------------------
// package.json files[] guard: phantom scripts must NOT be listed
// ---------------------------------------------------------------------------

test("package.json files[]: archon-setup.sh and archon-setup.ps1 phantom scripts are not listed", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    files: string[];
  };
  assert.ok(
    !pkg.files.includes("scripts/archon-setup.sh"),
    "scripts/archon-setup.sh does not exist on disk and must not appear in package.json files[] (would silently omit from tarball while looking shipped)"
  );
  assert.ok(
    !pkg.files.includes("scripts/archon-setup.ps1"),
    "scripts/archon-setup.ps1 does not exist on disk and must not appear in package.json files[] (would silently omit from tarball while looking shipped)"
  );
});

test("package.json files[]: .claude/settings.json and .graphifyignore actually exist on disk", async () => {
  // Positive guard: npm pack silently omits files[] entries that are missing on disk,
  // producing a tarball that looks correct but omits the file.  This test closes the
  // symmetric gap to the phantom-script removal above: if either file is deleted or
  // moved without updating files[], this test catches it before a release.
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  const graphifyPath = path.join(repoRoot, ".graphifyignore");
  await assert.doesNotReject(
    access(settingsPath, constants.R_OK),
    ".claude/settings.json is listed in package.json files[] and must exist on disk (silently omitted by npm pack if missing)"
  );
  await assert.doesNotReject(
    access(graphifyPath, constants.R_OK),
    ".graphifyignore is listed in package.json files[] and must exist on disk (silently omitted by npm pack if missing)"
  );
});

// ---------------------------------------------------------------------------
// assert-scripts-clean.mjs: adversarial regression test for the regex
// ---------------------------------------------------------------------------

test("assert-scripts-clean.mjs: exits 1 on synthetic dirty shim with strip-types src/ pattern", async () => {
  const tempDir = path.join(tmpdir(), `archon-scripts-adv-${process.pid}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    // Synthetic dirty shim that uses the old pattern
    const dirtyContent = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "node --experimental-strip-types src/install/cli.ts init --apply --target \"$1\" \"${@:2}\""
    ].join("\n");
    await writeFile(path.join(tempDir, "install-archon.sh"), dirtyContent, "utf8");

    let exitCode = 0;
    try {
      await execFileAsync("node", [assertScriptsCleanScript, tempDir]);
    } catch (err: unknown) {
      const e = err as { code?: number };
      exitCode = e.code ?? 1;
    }

    assert.equal(
      exitCode,
      1,
      "assert-scripts-clean.mjs must exit 1 when a shim contains 'experimental-strip-types src/'"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("assert-scripts-clean.mjs: exits 1 on synthetic dirty shim with node_modules/archon/src pattern", async () => {
  const tempDir = path.join(tmpdir(), `archon-scripts-adv2-${process.pid}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    // Synthetic dirty shim that references the installed source path directly.
    const dirtyContent = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'node /path/to/node_modules/archon/src/install/cli.js --target "$1"'
    ].join("\n");
    await writeFile(path.join(tempDir, "install-archon.sh"), dirtyContent, "utf8");

    let exitCode = 0;
    try {
      await execFileAsync("node", [assertScriptsCleanScript, tempDir]);
    } catch (err: unknown) {
      const e = err as { code?: number };
      exitCode = e.code ?? 1;
    }

    assert.equal(
      exitCode,
      1,
      "assert-scripts-clean.mjs must exit 1 when a shim contains 'node_modules/archon/src'"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("assert-scripts-clean.mjs: exits 0 for clean shim with dist/cli reference", async () => {
  const tempDir = path.join(tmpdir(), `archon-scripts-clean-${process.pid}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    const cleanContent = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "BIN=\"$REPO_ROOT/dist/cli/archon-bin.js\"",
      "exec node \"$BIN\" init --apply --target \"$1\" \"${@:2}\""
    ].join("\n");
    await writeFile(path.join(tempDir, "install-archon.sh"), cleanContent, "utf8");

    await assert.doesNotReject(
      execFileAsync("node", [assertScriptsCleanScript, tempDir]),
      "assert-scripts-clean.mjs must exit 0 for a clean shim"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Compiled bin presence (skip when dist not built — unit-tests CI job)
// The pack-install CI job owns compiled-bin functional coverage.
// ---------------------------------------------------------------------------

test("compiled bin dist/cli/archon-bin.js is present (build-only; skipped when dist/ absent)", async (t) => {
  if (!(await compiledBinPresent())) {
    t.skip("dist/cli/archon-bin.js not present — run 'npm run build:dist' to enable this test");
    return;
  }
  await assert.doesNotReject(
    access(binPath, constants.R_OK),
    `Expected compiled bin at ${binPath}`
  );
});

// ---------------------------------------------------------------------------
// Functional: compiled bin routes init --apply to the install CLI (build-only)
// Skipped when dist/ is absent (unit-tests CI job). The pack-install CI job
// also runs an init --apply smoke to give this gate CI enforcement.
// ---------------------------------------------------------------------------

test("compiled bin: init --apply installs into a target dir (build-only; skipped when dist/ absent)", async (t) => {
  if (!(await compiledBinPresent())) {
    t.skip("dist/cli/archon-bin.js not present — run 'npm run build:dist' to enable this test");
    return;
  }

  const targetDir = path.join(tmpdir(), `archon-bin-init-smoke-${process.pid}-${Date.now()}`);
  await mkdir(targetDir, { recursive: true });
  const dockerSentinel = path.join(targetDir, "docker-called");

  // A fake docker stub to prove init --apply does not invoke docker
  const binDir = path.join(targetDir, "bin");
  await mkdir(binDir, { recursive: true });
  const dockerStub = path.join(binDir, "docker");
  await writeFile(dockerStub, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `: > "${dockerSentinel}"`,
    "exit 0"
  ].join("\n"), "utf8");

  const { chmod } = await import("node:fs/promises");
  await chmod(dockerStub, 0o755);

  await writeFile(path.join(targetDir, "package.json"), '{ "name": "fixture", "private": true }\n', "utf8");

  try {
    await execFileAsync(
      process.execPath,
      [binPath, "init", "--apply", "--target", targetDir],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`
        }
      }
    );

    // archon installs devDependencies.archon into the target package.json
    const installedPkg = JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    assert.ok(
      installedPkg.devDependencies?.archon,
      "init --apply via compiled bin must write devDependencies.archon into target package.json"
    );

    // Docker must not have been called
    await assert.rejects(
      access(dockerSentinel),
      "init --apply must not invoke docker"
    );

    // The archon scripts block must be wired
    const scripts = (installedPkg as { scripts?: Record<string, string> }).scripts ?? {};
    assert.ok(
      scripts["archon:migrate"] === "archon migrate",
      "init --apply must wire the archon:migrate script in the target project"
    );
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});
