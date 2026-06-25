/**
 * @module forge/constraints-manifest-resolver
 *
 * CC-17: resolve the constraints manifest for a consuming repo.
 *
 * A consuming repo may ship its own constraints manifest alongside the archon
 * package. When present, that repo-local manifest takes precedence so the forge
 * pipeline runs against the consuming repo's own design system, not archon's.
 *
 * If no repo-local manifest is found, the shipped default manifest
 * (`constraints-manifest.ts`) is used and the returned `usingDefault` flag is
 * set to `true`. This flag MUST be surfaced by the caller (e.g. in gate output)
 * so a consuming repo is never silently inheriting archon's design taste.
 * Silent inheritance is a CC-17 / X-2 violation.
 *
 * Design decisions:
 *   - Pure and injectable: file-system operations are injected via `ResolverDeps`
 *     so tests can exercise both branches without touching the real FS.
 *   - No runtime archon-service dependencies — safe to ship with src/forge/.
 *   - Imports only from src/forge/** and node built-ins (CC-15 compliant).
 *
 * Wiring note: callers that surface the flag in gate output should check
 * `result.usingDefault` and emit `"using-default-constraints-manifest": true`
 * into the manifest / gate record when it is set. The resolver's job is to
 * return the flag — propagating it to gate output is the caller's responsibility.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONSTRAINTS_MANIFEST, ConstraintsManifestSchema } from "./constraints-manifest.ts";
import type { ConstraintsManifest } from "./constraints-manifest.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable file-system dependency interface.
 * Keeps the resolver pure and testable without hitting the real FS.
 */
export interface ResolverDeps {
  /** Return true when the file exists on disk. */
  fileExists(path: string): boolean;
  /**
   * Read the file at `path` and return its parsed JSON content.
   * Must throw if the file is missing or the content is not valid JSON.
   */
  readJson(path: string): unknown;
}

/**
 * Source of the resolved manifest — machine-readable discriminant for gate output.
 */
export type ManifestSource = "repo_local" | "shipped_default";

/**
 * The result returned by `resolveConstraintsManifest`.
 *
 * `usingDefault` MUST be checked by the caller. When `true`, the caller must
 * emit a `using-default-constraints-manifest` flag in gate output so the
 * operator knows the consuming repo has not supplied its own constraints (CC-17).
 */
export interface ResolvedConstraintsManifest {
  /** The validated constraints manifest to use for this forge run. */
  manifest: ConstraintsManifest;
  /**
   * True when the shipped default manifest was used because no repo-local
   * manifest was found. Callers MUST surface this as a
   * `using-default-constraints-manifest` flag in gate output — never silently
   * inherit archon's design taste (CC-17 / X-2).
   */
  usingDefault: boolean;
  /** Machine-readable source discriminant. */
  source: ManifestSource;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Conventional path for a repo-local constraints manifest, relative to the repo root.
 * A consuming repo places its manifest at this path to override the shipped default.
 */
export const REPO_LOCAL_MANIFEST_PATH = ".archon/forge/constraints-manifest.json" as const;

// ---------------------------------------------------------------------------
// Default FS deps (production)
// ---------------------------------------------------------------------------

/**
 * Default real-filesystem deps.
 * Isolated so the resolver function stays pure/injectable.
 */
const realFsDeps: ResolverDeps = {
  fileExists(path: string): boolean {
    return existsSync(path);
  },
  readJson(path: string): unknown {
    const text = readFileSync(path, "utf-8");
    return JSON.parse(text) as unknown;
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the constraints manifest for the forge pipeline.
 *
 * Preference order:
 *   1. Repo-local manifest at `<repoRoot>/.archon/forge/constraints-manifest.json`
 *      (parsed and validated against `ConstraintsManifestSchema`).
 *   2. Shipped default (`CONSTRAINTS_MANIFEST` from constraints-manifest.ts).
 *
 * @param repoRoot  Absolute path to the consuming repo root (typically `process.cwd()`).
 * @param deps      Injectable FS dependencies. Defaults to real-fs implementations.
 * @returns         The resolved manifest, source discriminant, and `usingDefault` flag.
 *
 * @example
 * const resolved = resolveConstraintsManifest(process.cwd());
 * if (resolved.usingDefault) {
 *   // Surface the flag so the operator knows archon's defaults are in use.
 *   gateOutput["using-default-constraints-manifest"] = true;
 * }
 * const manifest = resolved.manifest;
 */
export function resolveConstraintsManifest(
  repoRoot: string,
  deps: ResolverDeps = realFsDeps
): ResolvedConstraintsManifest {
  // REPO_LOCAL_MANIFEST_PATH is a fixed in-package constant with no `..` segment, so it
  // carries no path-traversal vector; the only variable is `repoRoot` (process.cwd() in
  // production). `path.join` is used for correct cross-platform joining. We deliberately do
  // NOT route through `resolveWithinRepo` here because that calls `realpathSync` on the real
  // FS, which would break this module's injectable/pure design (fs is supplied via deps).
  const candidatePath = path.join(repoRoot, REPO_LOCAL_MANIFEST_PATH);

  if (deps.fileExists(candidatePath)) {
    let raw: unknown;
    try {
      raw = deps.readJson(candidatePath);
    } catch (err) {
      // Surface a clear, contextual error rather than a bare SyntaxError from JSON.parse.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Repo-local constraints manifest at "${candidatePath}" could not be read/parsed: ${detail}`
      );
    }
    const parsed = ConstraintsManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Repo-local constraints manifest at "${candidatePath}" failed schema validation: ` +
          parsed.error.message
      );
    }
    return {
      manifest: parsed.data,
      usingDefault: false,
      source: "repo_local",
    };
  }

  // No repo-local manifest found — fall back to the shipped default.
  return {
    manifest: CONSTRAINTS_MANIFEST,
    usingDefault: true,
    source: "shipped_default",
  };
}
