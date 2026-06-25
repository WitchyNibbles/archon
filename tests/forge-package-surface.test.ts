/**
 * Tests for CC-14: npm pack --dry-run content assertions.
 *
 * Asserts that:
 *   - `src/forge/` is present in the packed file list (the forge ships to consumers).
 *   - `web/` is absent from the packed file list (R2-C: web toolchain boundary preserved).
 *
 * Both assertions are non-vacuous:
 *   - The forge assertion fails if `src/forge/` is removed from `package.json` `files[]`.
 *   - The web assertion fails if `web/**` is added to `package.json` `files[]`.
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
import { resolve, dirname } from "node:path";
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

  it("packed file list CONTAINS at least one src/forge/ entry (forge ships to consumers)", () => {
    // Non-vacuous: this FAILS if src/forge/ is removed from package.json files[].
    const forgeEntries = packedPaths.filter((p) => p.startsWith("src/forge/"));
    assert.ok(
      forgeEntries.length > 0,
      `Expected src/forge/ entries in packed file list but found none. ` +
        `Add "src/forge/" to package.json files[] to fix CC-14. ` +
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

  it("src/forge/ entries include key published modules (non-vacuous membership check)", () => {
    // Confirm the forge entry covers real modules, not just a .gitkeep placeholder.
    // This guard makes the test fail if only an empty skeleton was shipped.
    const expectedModules = [
      "src/forge/constraints-manifest.ts",
      "src/forge/repo-path.ts",
      "src/forge/forge-pipeline.ts",
    ];
    for (const mod of expectedModules) {
      assert.ok(
        packedPaths.includes(mod),
        `Expected "${mod}" in packed file list but it was absent. ` +
          `Forge pack surface may be incomplete. forge entries: ${packedPaths.filter((p) => p.startsWith("src/forge/")).join(", ")}`
      );
    }
  });
});
