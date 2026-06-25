/**
 * Tests for src/forge/constraints-manifest-resolver.ts — CC-17.
 *
 * Asserts:
 *   1. shipped_default branch: when no repo-local manifest exists, returns the
 *      shipped default manifest with `usingDefault: true` and `source: "shipped_default"`.
 *   2. repo_local branch: when a valid repo-local manifest exists at the conventional
 *      path, prefers it with `usingDefault: false` and `source: "repo_local"`.
 *   3. repo_local invalid JSON schema: throws with a descriptive message when the
 *      repo-local manifest fails ConstraintsManifestSchema validation.
 *   4. usingDefault flag is present on the return value in both branches (non-vacuous:
 *      the flag is the CC-17 contract; its absence is a violation).
 *
 * Tests use injectable deps so no real FS access is needed.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-constraints-manifest-resolver.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  resolveConstraintsManifest,
  REPO_LOCAL_MANIFEST_PATH,
  type ResolverDeps,
} from "../src/forge/constraints-manifest-resolver.ts";
import { CONSTRAINTS_MANIFEST } from "../src/forge/constraints-manifest.ts";

/** A schema-valid value that DIFFERS from the shipped default, so repo-local content is distinguishable. */
const REPO_LOCAL_DARK_BASE = "#010101";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake ResolverDeps that simulates the repo-local manifest being absent.
 */
function noLocalManifestDeps(): ResolverDeps {
  return {
    fileExists(_path: string): boolean {
      return false;
    },
    readJson(_path: string): unknown {
      throw new Error("readJson must not be called when fileExists returns false");
    },
  };
}

/**
 * Build a fake ResolverDeps that simulates a valid repo-local manifest.
 *
 * The manifest content is the shipped default manifest (version 2) serialised to
 * a plain object — the resolver must accept it as a valid repo-local manifest.
 */
function validLocalManifestDeps(repoRoot: string): ResolverDeps {
  const expectedPath = path.join(repoRoot, REPO_LOCAL_MANIFEST_PATH);
  // Deep-clone the shipped default, then mutate one schema-valid field so the repo-local
  // result is DISTINGUISHABLE from the shipped default (non-vacuous content assertion).
  const manifestClone = JSON.parse(JSON.stringify(CONSTRAINTS_MANIFEST)) as {
    identity: { darkBase: string };
  };
  manifestClone.identity.darkBase = REPO_LOCAL_DARK_BASE;
  return {
    fileExists(p: string): boolean {
      return p === expectedPath;
    },
    readJson(p: string): unknown {
      if (p !== expectedPath) {
        throw new Error(`readJson called with unexpected path: "${p}"`);
      }
      return manifestClone;
    },
  };
}

/**
 * Build a fake ResolverDeps where the repo-local file exists but `readJson` throws
 * (e.g. malformed JSON → SyntaxError from JSON.parse in the real dep).
 */
function malformedJsonDeps(repoRoot: string): ResolverDeps {
  const expectedPath = path.join(repoRoot, REPO_LOCAL_MANIFEST_PATH);
  return {
    fileExists(p: string): boolean {
      return p === expectedPath;
    },
    readJson(_p: string): unknown {
      throw new SyntaxError("Unexpected token } in JSON at position 42");
    },
  };
}

/**
 * Build a fake ResolverDeps where the repo-local manifest file exists but contains
 * invalid content (fails ConstraintsManifestSchema validation).
 */
function invalidLocalManifestDeps(repoRoot: string): ResolverDeps {
  const expectedPath = path.join(repoRoot, REPO_LOCAL_MANIFEST_PATH);
  return {
    fileExists(p: string): boolean {
      return p === expectedPath;
    },
    readJson(_p: string): unknown {
      // version field is wrong type — schema expects z.literal(2)
      return { version: "not-a-number", identity: {} };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const FAKE_REPO_ROOT = "/fake/consuming-repo";

describe("resolveConstraintsManifest — shipped_default branch (CC-17)", () => {
  it("returns the shipped default manifest when no repo-local manifest exists", () => {
    const result = resolveConstraintsManifest(FAKE_REPO_ROOT, noLocalManifestDeps());
    assert.deepEqual(
      result.manifest,
      CONSTRAINTS_MANIFEST,
      "Should return the shipped CONSTRAINTS_MANIFEST when no repo-local manifest is present"
    );
  });

  it("sets usingDefault to true when falling back to the shipped default", () => {
    const result = resolveConstraintsManifest(FAKE_REPO_ROOT, noLocalManifestDeps());
    assert.equal(
      result.usingDefault,
      true,
      "usingDefault must be true when the shipped default is used (CC-17: no silent inherit)"
    );
  });

  it("sets source to 'shipped_default' when falling back to the shipped default", () => {
    const result = resolveConstraintsManifest(FAKE_REPO_ROOT, noLocalManifestDeps());
    assert.equal(result.source, "shipped_default");
  });

  it("usingDefault flag is present on the return value (CC-17 contract — non-vacuous)", () => {
    const result = resolveConstraintsManifest(FAKE_REPO_ROOT, noLocalManifestDeps());
    // The flag must be a boolean property — not undefined, null, or missing.
    assert.ok(
      "usingDefault" in result && typeof result.usingDefault === "boolean",
      "usingDefault must be a boolean property on the result (CC-17 requires explicit flag)"
    );
  });
});

describe("resolveConstraintsManifest — repo_local branch (CC-17)", () => {
  it("returns the repo-local manifest when a valid one exists at the conventional path", () => {
    const result = resolveConstraintsManifest(
      FAKE_REPO_ROOT,
      validLocalManifestDeps(FAKE_REPO_ROOT)
    );
    // Non-vacuous: the repo-local fixture differs from the shipped default in darkBase,
    // so this proves the resolver returned the REPO-LOCAL content, not the default.
    assert.equal(
      result.manifest.identity.darkBase,
      REPO_LOCAL_DARK_BASE,
      "Should return the repo-local manifest's darkBase, proving repo-local content was used"
    );
    assert.notDeepEqual(
      result.manifest,
      CONSTRAINTS_MANIFEST,
      "Repo-local manifest must NOT be the shipped default (proves non-vacuous source distinction)"
    );
  });

  it("sets usingDefault to false when a valid repo-local manifest is found", () => {
    const result = resolveConstraintsManifest(
      FAKE_REPO_ROOT,
      validLocalManifestDeps(FAKE_REPO_ROOT)
    );
    assert.equal(
      result.usingDefault,
      false,
      "usingDefault must be false when a repo-local manifest is used"
    );
  });

  it("sets source to 'repo_local' when a valid repo-local manifest is found", () => {
    const result = resolveConstraintsManifest(
      FAKE_REPO_ROOT,
      validLocalManifestDeps(FAKE_REPO_ROOT)
    );
    assert.equal(result.source, "repo_local");
  });

  it("usingDefault flag is present and is false on the return value (CC-17 contract)", () => {
    const result = resolveConstraintsManifest(
      FAKE_REPO_ROOT,
      validLocalManifestDeps(FAKE_REPO_ROOT)
    );
    assert.ok(
      "usingDefault" in result && typeof result.usingDefault === "boolean",
      "usingDefault must be a boolean property on the result"
    );
    assert.equal(result.usingDefault, false);
  });

  it("resolves against the correct conventional path under the given repoRoot", () => {
    // Verify the resolver queries fileExists with the right path.
    const queriedPaths: string[] = [];
    const spyDeps: ResolverDeps = {
      fileExists(p: string): boolean {
        queriedPaths.push(p);
        return false; // pretend absent so we don't need readJson
      },
      readJson(_p: string): unknown {
        return null;
      },
    };
    resolveConstraintsManifest(FAKE_REPO_ROOT, spyDeps);
    const expectedPath = path.join(FAKE_REPO_ROOT, REPO_LOCAL_MANIFEST_PATH);
    assert.ok(
      queriedPaths.includes(expectedPath),
      `Expected fileExists to be called with "${expectedPath}", got: ${queriedPaths.join(", ")}`
    );
  });
});

describe("resolveConstraintsManifest — invalid repo-local manifest (CC-17 error path)", () => {
  it("throws a descriptive Error when the repo-local manifest fails schema validation", () => {
    assert.throws(
      () =>
        resolveConstraintsManifest(
          FAKE_REPO_ROOT,
          invalidLocalManifestDeps(FAKE_REPO_ROOT)
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Expected an Error instance");
        assert.ok(
          err.message.includes("failed schema validation"),
          `Error message should mention schema validation. Got: "${err.message}"`
        );
        assert.ok(
          err.message.includes(REPO_LOCAL_MANIFEST_PATH),
          `Error message should include the manifest path. Got: "${err.message}"`
        );
        return true;
      },
      "resolveConstraintsManifest must throw when repo-local manifest is schema-invalid"
    );
  });

  it("throws a contextual Error when the repo-local manifest is unreadable/malformed JSON", () => {
    assert.throws(
      () => resolveConstraintsManifest(FAKE_REPO_ROOT, malformedJsonDeps(FAKE_REPO_ROOT)),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Expected an Error instance");
        assert.ok(
          err.message.includes("could not be read/parsed"),
          `Error should mention read/parse failure. Got: "${err.message}"`
        );
        assert.ok(
          err.message.includes(REPO_LOCAL_MANIFEST_PATH),
          `Error should include the manifest path. Got: "${err.message}"`
        );
        return true;
      },
      "resolveConstraintsManifest must wrap a JSON parse failure with context"
    );
  });
});

describe("REPO_LOCAL_MANIFEST_PATH constant (CC-17 conventional path)", () => {
  it("is a non-empty string pointing inside .archon/forge/", () => {
    assert.ok(
      typeof REPO_LOCAL_MANIFEST_PATH === "string" && REPO_LOCAL_MANIFEST_PATH.length > 0,
      "REPO_LOCAL_MANIFEST_PATH must be a non-empty string"
    );
    assert.ok(
      REPO_LOCAL_MANIFEST_PATH.startsWith(".archon/forge/"),
      `REPO_LOCAL_MANIFEST_PATH should be inside .archon/forge/, got: "${REPO_LOCAL_MANIFEST_PATH}"`
    );
  });
});
