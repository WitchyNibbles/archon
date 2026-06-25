/**
 * Tests for CC-16: gitignore coverage of secret-related paths.
 *
 * Asserts that:
 *   - `.env.archon` is git-ignored (already was; regression guard).
 *   - A path matching dataRoot/secrets/secrets.enc is git-ignored (added by P5-S1 for
 *     the Pillar B encrypted-file backend, matching the dataRoot/secrets/ pattern).
 *
 * Both assertions use `git check-ignore --quiet` via child_process, which is the
 * authoritative tool for evaluating gitignore rules (it accounts for rule
 * precedence, negations, and gitignore file stacking). Tests are non-vacuous:
 *   - The `.env.archon` test fails if the rule is removed from .gitignore.
 *   - The secrets path test fails if `dataRoot/secrets/` is removed from .gitignore.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/secret-store-gitignore.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Return true if `git check-ignore` considers `filePath` to be ignored.
 *
 * `git check-ignore --quiet <path>` exits with code 0 when the path is ignored,
 * code 1 when it is not ignored, and non-zero (>1) on error. We only check the
 * exit code so the path does not need to exist on disk.
 *
 * Note: paths must be relative to the repo root for git check-ignore to resolve
 * them against the correct .gitignore files.
 */
function isGitIgnored(repoRelativePath: string): boolean {
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", repoRelativePath],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }
  );
  // Exit code 0 = ignored, 1 = not ignored, anything else = git error
  if (result.status === null) {
    throw new Error(
      `git check-ignore did not produce an exit code for "${repoRelativePath}". ` +
        `stderr: ${result.stderr ?? "(none)"}`
    );
  }
  if (result.status > 1) {
    throw new Error(
      `git check-ignore exited with error code ${result.status} for "${repoRelativePath}". ` +
        `stderr: ${result.stderr ?? "(none)"}`
    );
  }
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("secret-related paths are git-ignored (CC-16)", () => {
  it(".env.archon is git-ignored (regression guard — was already ignored)", () => {
    // Non-vacuous: fails if the .env.archon rule is removed from .gitignore.
    const ignored = isGitIgnored(".env.archon");
    assert.ok(
      ignored,
      ".env.archon must be git-ignored. It holds bootstrap config including secret refs. " +
        "Check that .gitignore contains a rule matching '.env.archon'."
    );
  });

  it("dataRoot/secrets/secrets.enc is git-ignored (Pillar B secret store path)", () => {
    // Non-vacuous: fails if the dataRoot/secrets/ rule is removed from .gitignore.
    // This path matches the `dataRoot/secrets/` pattern added by P5-S1.
    const ignored = isGitIgnored("dataRoot/secrets/secrets.enc");
    assert.ok(
      ignored,
      "dataRoot/secrets/secrets.enc must be git-ignored. " +
        "This is the Pillar B encrypted-file secret store location (CC-16/B.3). " +
        "Check that .gitignore contains 'dataRoot/secrets/'."
    );
  });

  it("an arbitrarily-nested secrets/ path is git-ignored (belt-and-suspenders pattern check)", () => {
    // The gitignore rule uses `dataRoot/secrets/` which anchors to paths starting
    // with "dataRoot/secrets/". Verify a concrete nested path is also covered.
    const ignored = isGitIgnored("dataRoot/secrets/v1/keystore.bin");
    assert.ok(
      ignored,
      "dataRoot/secrets/v1/keystore.bin must be git-ignored. " +
        "The dataRoot/secrets/ rule should cover all nested paths under the secrets directory."
    );
  });

  it("src/forge/ is NOT git-ignored (sanity: shipped forge modules must not be ignored)", () => {
    // Sanity check that the gitignore rules have not accidentally swept in src/forge/.
    // If this fails something is very wrong with the .gitignore configuration.
    const ignored = isGitIgnored("src/forge/constraints-manifest.ts");
    assert.ok(
      !ignored,
      "src/forge/constraints-manifest.ts must NOT be git-ignored. " +
        "The forge modules are tracked source files, not generated artifacts."
    );
  });
});
