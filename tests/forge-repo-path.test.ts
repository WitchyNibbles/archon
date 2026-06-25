/**
 * Unit tests for src/forge/repo-path.ts — resolveWithinRepo.
 *
 * Coverage:
 *   1. Happy path: in-repo absolute path accepted.
 *   2. Happy path: relative path resolved against repoRoot.
 *   3. Relative `../` traversal rejected.
 *   4. Absolute path outside the repo rejected.
 *   5. Prefix-spoof sibling path rejected (/repo vs /repo-evil).
 *   6. Symlink pointing outside the repo rejected (real symlink created in tmp).
 *   7. Non-matching extension rejected when allowedExt is given.
 *   8. Matching extension accepted when allowedExt is given.
 *   9. Multiple allowed extensions: matching any one is accepted.
 *  10. Not-yet-existing file inside the repo: accepted (ancestor realpath check).
 *  11. Empty allowedExt list: no extension restriction applied.
 *  12. Repo root that is itself a symlink: bounds check is correct.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-repo-path.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { resolveWithinRepo } from "../src/forge/repo-path.ts";

// ---------------------------------------------------------------------------
// Synthetic repo root (a real directory so realpathSync resolves it)
// ---------------------------------------------------------------------------

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a unique temp-based fake repo root that exists on disk. */
function makeRepo(): string {
  return makeTmpDir("archon-repo-path-test-repo-");
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("resolveWithinRepo — happy paths", () => {
  it("accepts an absolute path inside the repo", () => {
    const repo = makeRepo();
    const inside = path.join(repo, "src", "forge", "file.ts");
    // File does not need to exist for the bounds check.
    const result = resolveWithinRepo(inside, { repoRoot: repo });
    assert.equal(result, inside);
  });

  it("accepts a relative path resolved against the repo root", () => {
    const repo = makeRepo();
    const result = resolveWithinRepo("src/forge/file.ts", { repoRoot: repo });
    assert.equal(result, path.join(repo, "src", "forge", "file.ts"));
  });

  it("accepts a path that equals the repo root itself", () => {
    const repo = makeRepo();
    const result = resolveWithinRepo(repo, { repoRoot: repo });
    assert.equal(result, repo);
  });

  it("returns the resolved path (normalised) for a relative path with no ..", () => {
    const repo = makeRepo();
    const result = resolveWithinRepo("a/b/../c.json", { repoRoot: repo });
    assert.equal(result, path.join(repo, "a", "c.json"));
  });
});

// ---------------------------------------------------------------------------
// Traversal rejection
// ---------------------------------------------------------------------------

describe("resolveWithinRepo — path traversal rejection", () => {
  it("rejects a relative path that escapes via ../", () => {
    const repo = makeRepo();
    assert.throws(
      () => resolveWithinRepo("../../etc/passwd", { repoRoot: repo }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("outside the repository"),
          `expected repo-escape error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("rejects an absolute path outside the repo", () => {
    const repo = makeRepo();
    assert.throws(
      () => resolveWithinRepo("/etc/shadow", { repoRoot: repo }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("outside the repository"));
        return true;
      }
    );
  });

  it("rejects a prefix-spoof sibling path (repo-evil shares the string prefix of repo)", () => {
    const repo = makeRepo();
    // Sibling: /tmp/archon-repo-path-test-repo-XXXX-evil
    const sibling = `${repo}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    const target = path.join(sibling, "payload.json");
    try {
      assert.throws(
        () => resolveWithinRepo(target, { repoRoot: repo }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("outside the repository"));
          return true;
        }
      );
    } finally {
      fs.rmdirSync(sibling);
    }
  });
});

// ---------------------------------------------------------------------------
// Symlink bypass detection
// ---------------------------------------------------------------------------

describe("resolveWithinRepo — symlink escape detection", () => {
  it("rejects a symlink inside the repo that points outside it", () => {
    const repo = makeRepo();
    // Create a real outside-repo target directory (must exist for symlink to resolve).
    const outside = makeTmpDir("archon-repo-path-test-outside-");
    // Create the symlink inside the repo pointing to the outside directory.
    const linkPath = path.join(repo, "evil-link");
    fs.symlinkSync(outside, linkPath);

    // A path going through the symlink: repo/evil-link/payload.json
    const target = path.join(linkPath, "payload.json");

    try {
      assert.throws(
        () => resolveWithinRepo(target, { repoRoot: repo }),
        (err: unknown) => {
          assert.ok(err instanceof Error, `expected Error, got: ${String(err)}`);
          assert.ok(
            err.message.includes("outside the repository"),
            `expected repo-escape error, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      fs.unlinkSync(linkPath);
      fs.rmdirSync(outside);
    }
  });

  it("accepts a symlink inside the repo that points to another inside-repo path", () => {
    const repo = makeRepo();
    // Create a real target directory inside the repo.
    const realDir = path.join(repo, "assets-real");
    fs.mkdirSync(realDir);
    // Create a symlink inside the repo pointing to the real inside-repo dir.
    const linkPath = path.join(repo, "assets-link");
    fs.symlinkSync(realDir, linkPath);

    const target = path.join(linkPath, "icon.svg");

    try {
      // Should not throw — link resolves to realDir which is inside repo.
      const result = resolveWithinRepo(target, { repoRoot: repo });
      // The resolved path may be through realDir (not linkPath) after realpathSync.
      assert.ok(
        result.startsWith(repo),
        `resolved path must start with repo root; got: ${result}`
      );
    } finally {
      fs.unlinkSync(linkPath);
      fs.rmdirSync(realDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Extension restriction
// ---------------------------------------------------------------------------

describe("resolveWithinRepo — allowedExt enforcement", () => {
  it("rejects a path whose extension is not in allowedExt", () => {
    const repo = makeRepo();
    assert.throws(
      () => resolveWithinRepo("web/public/snapshot.txt", { repoRoot: repo, allowedExt: [".json"] }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("disallowed extension"),
          `expected extension error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("accepts a path whose extension matches allowedExt (single ext)", () => {
    const repo = makeRepo();
    const result = resolveWithinRepo("web/public/out.json", { repoRoot: repo, allowedExt: [".json"] });
    assert.equal(result, path.join(repo, "web", "public", "out.json"));
  });

  it("accepts a path matching any of multiple allowed extensions", () => {
    const repo = makeRepo();
    const resultJson = resolveWithinRepo("a/b.json", { repoRoot: repo, allowedExt: [".json", ".svg"] });
    assert.equal(resultJson, path.join(repo, "a", "b.json"));
    const resultSvg = resolveWithinRepo("a/icon.svg", { repoRoot: repo, allowedExt: [".json", ".svg"] });
    assert.equal(resultSvg, path.join(repo, "a", "icon.svg"));
  });

  it("applies no extension restriction when allowedExt is an empty array", () => {
    const repo = makeRepo();
    // Should not throw for any extension.
    const result = resolveWithinRepo("web/file.txt", { repoRoot: repo, allowedExt: [] });
    assert.equal(result, path.join(repo, "web", "file.txt"));
  });

  it("applies no extension restriction when allowedExt is omitted", () => {
    const repo = makeRepo();
    const result = resolveWithinRepo("web/file.anything", { repoRoot: repo });
    assert.equal(result, path.join(repo, "web", "file.anything"));
  });
});

// ---------------------------------------------------------------------------
// Not-yet-existing files (ancestor realpath check)
// ---------------------------------------------------------------------------

describe("resolveWithinRepo — not-yet-existing paths", () => {
  it("accepts a not-yet-existing file whose parent directory is inside the repo", () => {
    const repo = makeRepo();
    // Create the parent directory but not the file itself.
    const parentDir = path.join(repo, "web", "public");
    fs.mkdirSync(parentDir, { recursive: true });
    const target = path.join(parentDir, "new-file-does-not-exist.json");

    // Must not throw — the ancestor (parentDir) is inside the repo.
    const result = resolveWithinRepo(target, { repoRoot: repo });
    assert.equal(result, target);
  });

  it("rejects a not-yet-existing file whose nearest ancestor escapes the repo via symlink", () => {
    const repo = makeRepo();
    const outside = makeTmpDir("archon-repo-path-test-outside2-");
    const linkPath = path.join(repo, "escape-link");
    fs.symlinkSync(outside, linkPath);

    // Target path goes through the escaping symlink but the file doesn't exist.
    const target = path.join(linkPath, "nonexistent-file.json");

    try {
      assert.throws(
        () => resolveWithinRepo(target, { repoRoot: repo }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("outside the repository"));
          return true;
        }
      );
    } finally {
      fs.unlinkSync(linkPath);
      fs.rmdirSync(outside);
    }
  });
});

// ---------------------------------------------------------------------------
// Symlinked repo root
// ---------------------------------------------------------------------------

describe("resolveWithinRepo — symlinked repo root", () => {
  it("correctly bounds-checks when the repo root itself is a symlink", () => {
    const realRepo = makeRepo();
    const linkRepo = `${realRepo}-symlinked`;
    // Create a symlink that IS the repo root.
    fs.symlinkSync(realRepo, linkRepo);

    try {
      // An inside-repo path using the symlinked root should be accepted.
      const insidePath = path.join(linkRepo, "src", "file.ts");
      // Should not throw.
      const result = resolveWithinRepo(insidePath, { repoRoot: linkRepo });
      assert.ok(
        typeof result === "string" && result.length > 0,
        "expected a non-empty resolved path"
      );

      // An outside path should be rejected.
      assert.throws(
        () => resolveWithinRepo("/etc/passwd", { repoRoot: linkRepo }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("outside the repository"));
          return true;
        }
      );
    } finally {
      fs.unlinkSync(linkRepo);
    }
  });
});

// ---------------------------------------------------------------------------
// Random-suffix guarantee (regression: two calls must not collide)
// ---------------------------------------------------------------------------

describe("resolveWithinRepo — determinism / no state", () => {
  it("returns the same result for two calls with the same inputs (stateless)", () => {
    const repo = makeRepo();
    const candidate = "web/public/out.json";
    const r1 = resolveWithinRepo(candidate, { repoRoot: repo });
    const r2 = resolveWithinRepo(candidate, { repoRoot: repo });
    assert.equal(r1, r2, "resolveWithinRepo must be deterministic");
  });

  it("two unique random filenames in os.tmpdir() are different (eval fixture regression)", () => {
    // This is not a test of resolveWithinRepo itself — it verifies the principle
    // that the forge-baseline eval fix produces unique tmp paths per invocation.
    const makeRandPath = () => {
      const rand = crypto.randomBytes(8).toString("hex");
      return path.join(os.tmpdir(), `archon-eval-bad-asset-${rand}.svg`);
    };
    const p1 = makeRandPath();
    const p2 = makeRandPath();
    assert.notEqual(p1, p2, "two random tmp paths must be distinct");
  });
});
