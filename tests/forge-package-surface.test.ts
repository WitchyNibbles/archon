/**
 * Tests for CC-14: npm pack --dry-run content assertions.
 *
 * Asserts that:
 *   - `dist/forge/` is present in the packed file list (the forge ships to consumers as
 *     compiled JS via dist/**).  P1 removed raw src/*.ts from files[]; forge now ships
 *     compiled.
 *   - `web/` is absent from the packed file list (R2-C: web toolchain boundary preserved).
 *   - No `web/` directory exists in the repo working tree at all (the dogfood dashboard was
 *     deleted outright, not merely excluded from packaging — see docs/forge-operator-runbook.md).
 *   - `src/` is absent from the packed file list (P1 invariant: no raw TypeScript source).
 *
 * All assertions are non-vacuous:
 *   - The dist/forge/ assertion fails if dist/ is removed from package.json files[].
 *   - The packed-file-list web assertion fails if web/** is added to package.json files[]
 *     while a web/ directory exists on disk. On its own it would pass vacuously now that
 *     web/ has been deleted (there is nothing under web/ to pack), so it is paired with...
 *   - ...the working-tree web/ existence assertion, which fails immediately if a `web/`
 *     directory is ever reintroduced at the repo root, regardless of package.json files[].
 *   - The src/ assertion fails if any src/**\/*.ts entry is re-added to files[].
 *
 * This test runs `npm pack --dry-run --json` in the repo root via `child_process`
 * so it reflects the real package content. It is intentionally an integration-style
 * test — the point is to catch `package.json` regressions, not to mock the tool.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-package-surface.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Run `npm pack --dry-run --json` and return the array of packed file paths.
 * Throws if the command fails.
 */
function getPackedFilePaths(): string[] {
  const raw = execSync("npm pack --dry-run --json", {
    cwd: REPO_ROOT,
    // npm pack --dry-run writes progress to stderr, keep it out of stdout
    stdio: ["ignore", "pipe", "ignore"],
  }).toString("utf-8");

  const parsed: unknown = JSON.parse(raw);
  // npm pack --json returns an array with one entry per package
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Unexpected npm pack --json output shape: ${raw}`);
  }
  const entry = parsed[0] as { files?: Array<{ path: string }> };
  if (!Array.isArray(entry.files)) {
    throw new Error(`npm pack output missing files array: ${raw}`);
  }
  return entry.files.map((f) => f.path);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("npm pack surface (CC-14)", () => {
  // Pack once and share across both assertions to avoid running the command twice.
  let packedPaths: string[];

  it("npm pack --dry-run --json runs successfully and returns a non-empty file list", () => {
    packedPaths = getPackedFilePaths();
    assert.ok(
      packedPaths.length > 0,
      "npm pack produced an empty file list — package.json files[] may be misconfigured"
    );
  });

  it("packed file list CONTAINS at least one dist/forge/ entry (forge ships compiled to consumers)", () => {
    // Non-vacuous: this FAILS if dist/ is removed from package.json files[].
    // P1: forge ships as compiled JS under dist/forge/ (not raw src/forge/*.ts).
    const forgeEntries = packedPaths.filter((p) => p.startsWith("dist/forge/"));
    assert.ok(
      forgeEntries.length > 0,
      `Expected dist/forge/ entries in packed file list but found none. ` +
        `Run 'npm run build:dist' and ensure "dist/**" is in package.json files[] (CC-14). ` +
        `Full file list sample (first 20): ${packedPaths.slice(0, 20).join(", ")}`
    );
  });

  it("packed file list contains NOTHING under web/ (R2-C web boundary preserved)", () => {
    // Non-vacuous: this FAILS if web/** is added to package.json files[].
    const webEntries = packedPaths.filter((p) => p.startsWith("web/"));
    assert.deepEqual(
      webEntries,
      [],
      `Packed file list must contain NOTHING under web/ (R2-C boundary violation). ` +
        `Found: ${webEntries.join(", ")}`
    );
  });

  it("no web/ directory exists in the repo working tree (dogfood dashboard removed, not just unpacked)", () => {
    // Non-vacuous even though web/ no longer exists to be packed: this FAILS if a `web/`
    // directory is ever reintroduced at the repo root, with or without being added to
    // package.json files[]. This is the guard that stays meaningful now that the packed-file-list
    // web/ assertion above would otherwise pass vacuously (nothing on disk under web/ to pack).
    assert.equal(
      existsSync(join(REPO_ROOT, "web")),
      false,
      "A web/ directory exists in the repo root. The Forge dogfood dashboard was removed " +
        "entirely (see docs/forge-operator-runbook.md); reintroducing web/ requires updating " +
        "this test and the runbook, not just re-adding it silently."
    );
  });

  it("packed file list contains NOTHING under src/ (P1: no raw TypeScript source shipped)", () => {
    // Non-vacuous: this FAILS if any src/**/*.ts entry is re-added to package.json files[].
    // Consumers get compiled dist/ only — shipping raw .ts would expose the strip-types dep.
    const srcEntries = packedPaths.filter((p) => p.startsWith("src/"));
    assert.deepEqual(
      srcEntries,
      [],
      `Packed file list must contain NOTHING under src/ (P1 invariant). ` +
        `Found: ${srcEntries.join(", ")}`
    );
  });

  it("dist/forge/ entries include key published modules (non-vacuous membership check)", () => {
    // Confirm the compiled forge covers real modules, not just placeholders.
    // This guard makes the test fail if only an empty skeleton was shipped.
    const expectedModules = [
      "dist/forge/constraints-manifest.js",
      "dist/forge/repo-path.js",
      "dist/forge/forge-pipeline.js",
    ];
    for (const mod of expectedModules) {
      assert.ok(
        packedPaths.includes(mod),
        `Expected "${mod}" in packed file list but it was absent. ` +
          `Run 'npm run build:dist' to compile forge modules. dist/forge/ entries: ${packedPaths.filter((p) => p.startsWith("dist/forge/")).join(", ")}`
      );
    }
  });
});
