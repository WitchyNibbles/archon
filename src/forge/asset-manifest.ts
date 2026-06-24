/**
 * @module forge/asset-manifest
 *
 * Manifest reconciler for the Archon Frontend Forge pipeline (P1-S6).
 *
 * Port of §15.2 `reconcile` from docs/archon_frontend_forge_codex_imagegen_roadmap.md
 * to TypeScript, adapted to the Archon src/forge Zod-contract style.
 *
 * Responsibilities:
 *   - Detect which AssetRequest output files exist on disk.
 *   - Build AssetManifestEntry records for present outputs.
 *   - Flag missing outputs (no file at outputPath).
 *   - Flag duplicate outputPath values across requests.
 *   - Record promptHash (sha256[:16] of the request prompt).
 *   - Idempotent: same input => same output across repeated calls.
 *
 * Hard constraints:
 *   - NO DB writes.
 *   - NO network calls.
 *   - NO mutable shared state.
 *   - NO side effects beyond reading the filesystem.
 *
 * Zero archon-service dependencies — safe to import from any tooling layer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AssetRequest, AssetManifestEntry } from "./asset-contract.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The result of a single reconcile run.
 *
 * Idempotency guarantee: calling reconcileAssets with the same requests and
 * the same filesystem state always returns an equivalent result.
 */
export interface ReconcileResult {
  /**
   * Manifest entries for AssetRequests whose output files were found on disk.
   * Ordered by id (stable sort).
   */
  entries: AssetManifestEntry[];

  /**
   * IDs of AssetRequests whose output file did not exist at reconcile time.
   * Ordered by id.
   */
  missingOutputs: string[];

  /**
   * Output paths that appear in more than one AssetRequest.
   * Duplicate paths are flagged regardless of whether the file exists.
   * Ordered (stable).
   */
  duplicatePaths: string[];
}

// ---------------------------------------------------------------------------
// promptHash: sha256[:16] of the prompt string
//
// Deterministic: same prompt => same hash. Uses Node's built-in crypto
// module (synchronous, no SubtleCrypto Promise required).
// ---------------------------------------------------------------------------

function computePromptHash(prompt: string): string {
  return crypto
    .createHash("sha256")
    .update(prompt, "utf8")
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile a set of AssetRequests against the current filesystem state.
 *
 * For each request:
 *   - If outputPath exists: build an AssetManifestEntry and add to entries.
 *   - If outputPath does not exist: add the id to missingOutputs.
 *
 * Duplicate outputPath detection: any path that appears in more than one
 * request is added to duplicatePaths (regardless of file existence).
 *
 * This function is PURE with respect to any shared state:
 *   - No DB reads/writes.
 *   - No in-memory singletons mutated.
 *   - No file writes (read-only filesystem access).
 *   - Same input + same filesystem => identical output.
 *
 * @param requests - The array of AssetRequests to reconcile.
 * @returns A ReconcileResult with entries, missingOutputs, and duplicatePaths.
 */
/**
 * @param requests   the planned asset requests to reconcile against disk.
 * @param requestDir optional directory the request JSON files live in (roadmap
 *   §13 `asset_requests/`). When given, each entry's `originalRequestPath` is
 *   `requestDir/<id>.json`; otherwise it falls back to the bare `<id>.json`.
 *   Either way the value is non-empty, so entries satisfy
 *   `AssetManifestEntrySchema` (`originalRequestPath` is `z.string().min(1)`).
 */
export function reconcileAssets(
  requests: AssetRequest[],
  requestDir?: string
): ReconcileResult {
  // --- Duplicate path detection -------------------------------------------
  const pathCounts = new Map<string, number>();
  for (const req of requests) {
    const prev = pathCounts.get(req.outputPath) ?? 0;
    pathCounts.set(req.outputPath, prev + 1);
  }
  const duplicatePaths = Array.from(pathCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([p]) => p)
    .sort();

  // --- Per-request reconcile -----------------------------------------------
  const entries: AssetManifestEntry[] = [];
  const missingOutputs: string[] = [];

  for (const req of requests) {
    const fileExists = fs.existsSync(req.outputPath);

    if (!fileExists) {
      missingOutputs.push(req.id);
      continue;
    }

    const entry = buildManifestEntry(req, requestDir);
    entries.push(entry);
  }

  // Stable sort by id for idempotency
  entries.sort((a, b) => a.id.localeCompare(b.id));
  missingOutputs.sort();

  return { entries, missingOutputs, duplicatePaths };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a manifest entry for a request whose output file is confirmed to exist.
 *
 * The entry is derived entirely from the AssetRequest — no file reading
 * beyond the existence check done in reconcileAssets.
 */
function buildManifestEntry(req: AssetRequest, requestDir?: string): AssetManifestEntry {
  // Infer generatedBy from provider
  const generatedBy = providerLabel(req.provider);

  // Always non-empty so the entry satisfies AssetManifestEntrySchema
  // (originalRequestPath is z.string().min(1)). Qualified by requestDir when known.
  const requestFile = `${req.id}.json`;
  const originalRequestPath = requestDir ? path.join(requestDir, requestFile) : requestFile;

  return {
    id: req.id,
    provider: req.provider,
    type: req.assetType,
    path: req.outputPath,
    promptHash: computePromptHash(req.prompt),
    originalRequestPath,
    alt: req.altText,
    usedIn: [],
    approved: false,
    generatedBy,
    qaStatus: "pending",
    notes: []
  };
}

/** Human-readable attribution label for each provider. */
function providerLabel(provider: AssetRequest["provider"]): string {
  switch (provider) {
    case "codex_builtin_imagegen": return "codex:$imagegen";
    case "manual_upload":          return "manual_upload";
    case "placeholder_svg":        return "placeholder_svg";
    // TypeScript exhaustiveness — unreachable if provider vocabulary is maintained
    default: {
      const _exhaustive: never = provider;
      return String(_exhaustive);
    }
  }
}
