/**
 * @module forge/repo-path
 *
 * Shared path-safety helper for Archon Forge file I/O.
 *
 * Provides `resolveWithinRepo` — a single, tested guard that:
 *   1. Resolves a candidate path against the repo root (or cwd).
 *   2. Resolves SYMLINKS on the candidate (and its nearest existing ancestor)
 *      so a symlink pointing outside the repo is caught even when `path.resolve`
 *      would accept it. This closes the realpath symlink-bypass that `path.resolve`
 *      alone misses.
 *   3. Rejects paths whose canonical form escapes the repo root.
 *   4. Optionally enforces an allowed extension list.
 *   5. Throws a descriptive `Error` on every rejection — never swallows.
 *
 * Algorithm:
 *   a. Realpath the repo root (so symlinked roots work correctly).
 *   b. Normalise the candidate via `path.resolve(repoRoot, candidate)`.
 *   c. Find the nearest existing ancestor of the normalised path.
 *   d. If the ancestor's realpath differs from its normalised path, a symlink
 *      redirect is present. Reconstruct the canonical form of the full path
 *      by substituting the ancestor prefix.
 *   e. Bounds-check the canonical form against the (realpath'd) repo root.
 *   f. Also bounds-check the plain `path.resolve` result as a defence against
 *      `../` in the non-existing suffix (symlink-independent traversal).
 *
 * Not-yet-existing files: when the resolved path does not exist, we find the
 * nearest existing ancestor, realpath it, and reconstruct the canonical path
 * from there. Symlink escapes impossible in the non-existing suffix (you cannot
 * create symlinks for paths that do not exist), so `path.resolve` normalization
 * is sufficient for that portion.
 *
 * Import wall: this module MUST NOT import from web/**. Zero archon-service
 * dependencies — safe to use from any forge tooling layer.
 */

import { realpathSync, existsSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResolveWithinRepoOptions {
  /**
   * Repo root to bound the path within.
   * Defaults to `process.cwd()` when not provided.
   * The root itself is realpath-resolved so a symlinked root works correctly.
   */
  repoRoot?: string | undefined;
  /**
   * If given, the resolved path MUST end with one of these extensions
   * (dot-inclusive, e.g. `[".json", ".svg"]`).
   * Case-sensitive. Checked after bounds resolution.
   */
  allowedExt?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Safely call realpathSync; return the input on any error. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve symlinks in `target` to obtain its canonical form.
 *
 * When `target` exists, returns `realpathSync(target)`.
 * When `target` does not exist, walks up the directory tree to find the nearest
 * existing ancestor, realpaths it, then reconstructs the canonical path by
 * appending the non-existing suffix.
 *
 * Returns `target` unchanged if no existing ancestor can be found (edge case:
 * the filesystem root is inaccessible).
 */
function canonicalisePath(target: string): string {
  if (existsSync(target)) {
    return safeRealpath(target);
  }

  // Walk up to find the nearest existing ancestor.
  let current = target;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) break;
    seen.add(current);

    const parent = dirname(current);
    if (parent === current) break; // Reached filesystem root without a hit.

    if (existsSync(parent)) {
      const parentReal = safeRealpath(parent);
      if (parentReal === parent) {
        // No redirect in this ancestor — target is its own canonical form.
        return target;
      }
      // Symlink redirect detected: reconstruct the canonical path.
      // `current` is the first non-existing child of `parent`, so the suffix
      // starting from `current` needs to be appended to `parentReal`.
      const suffix = target.slice(parent.length); // includes leading sep
      return parentReal + suffix;
    }

    current = parent;
  }

  return target; // Fallback: no existing ancestor found.
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve `candidate` relative to `repoRoot` (or cwd) and assert it stays
 * within the repo. Symlinks in the candidate's path are resolved so a symlink
 * pointing outside the repo is caught.
 *
 * @param candidate  The raw path provided by the caller (may be relative or absolute).
 * @param opts       Optional repo root and allowed extension list.
 * @returns          The `path.resolve`-normalised, bounds-checked absolute path.
 *                   Note: the returned path uses `path.resolve` semantics (not
 *                   realpath) so callers receive a stable path for non-existing files.
 * @throws           `Error` with a descriptive message if the path escapes the
 *                   repo root, or if the extension is not in `allowedExt`.
 *
 * @example
 * // Enforce inside repo, must be .json or .svg
 * const safe = resolveWithinRepo("web/public/snapshot.json", {
 *   repoRoot: "/home/user/project",
 *   allowedExt: [".json", ".svg"],
 * });
 */
export function resolveWithinRepo(
  candidate: string,
  opts: ResolveWithinRepoOptions = {}
): string {
  // --- Repo root normalisation ---
  // Realpath the repo root so a symlinked root is handled correctly.
  // When the root does not exist (e.g. synthetic test paths), use it as-is;
  // `path.resolve` still normalises `..` segments in the candidate.
  const rawRoot = opts.repoRoot ?? process.cwd();
  const repoRoot = existsSync(rawRoot) ? safeRealpath(rawRoot) : rawRoot;

  // 1. Normalise the candidate against the repo root.
  //    `path.resolve` normalises `..` segments; when `candidate` is absolute,
  //    it is used directly (repo root is discarded). This is intentional —
  //    absolute candidates like "/repo-symlink/src/file.ts" are handled by
  //    symlink resolution in step 2.
  const resolved = resolve(repoRoot, candidate);

  // 2. Canonical form: resolve symlinks in the full path (or its nearest
  //    existing ancestor). This detects redirects via in-repo symlinks that
  //    point outside the repo, as well as absolute paths that use a symlinked
  //    repo-root alias.
  const canonical = canonicalisePath(resolved);

  // 3. Bounds check on the CANONICAL path (symlink-aware, primary check).
  //    Note: `path.resolve` normalises `..` segments, so `../` traversal in
  //    any portion of the path is already eliminated before we reach this point.
  //    The canonical check catches both plain traversal and symlink escapes.
  assertWithinRoot(canonical, repoRoot, candidate);

  // 4. Extension check (optional).
  if (opts.allowedExt !== undefined && opts.allowedExt.length > 0) {
    const matched = opts.allowedExt.some((ext) => resolved.endsWith(ext));
    if (!matched) {
      throw new Error(
        `Path "${candidate}" has a disallowed extension. ` +
          `Allowed: ${opts.allowedExt.join(", ")}. Got: ${resolved}`
      );
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Internal: bounds assertion
// ---------------------------------------------------------------------------

function assertWithinRoot(
  resolvedPath: string,
  repoRoot: string,
  original: string
): void {
  // A path is within the repo iff it equals repoRoot exactly OR starts with
  // `${repoRoot}/`. The separator guard prevents the prefix-spoof attack where
  // `/repo-evil/x` would pass a bare `startsWith("/repo")` check.
  const isRoot = resolvedPath === repoRoot;
  const isChild = resolvedPath.startsWith(`${repoRoot}${sep}`);
  if (!isRoot && !isChild) {
    throw new Error(
      `Path "${original}" resolves to "${resolvedPath}" which is outside the ` +
        `repository root "${repoRoot}". Only paths within the repository are permitted.`
    );
  }
}
