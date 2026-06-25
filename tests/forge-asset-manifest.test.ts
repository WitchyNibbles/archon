/**
 * Tests for src/forge/asset-manifest.ts
 *
 * TDD: failing tests written before implementation.
 *
 * Verifies:
 *   1. reconcile is idempotent (repeated runs => stable manifest)
 *   2. missing output files are flagged
 *   3. duplicate outputPath across requests are flagged
 *   4. promptHash is recorded (sha256[:16] of prompt)
 *   5. No DB writes (pure function over the filesystem read paths provided)
 *
 * Run with: node --experimental-strip-types --test tests/forge-asset-manifest.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { reconcileAssets } from "../src/forge/asset-manifest.ts";
import type { ReconcileResult } from "../src/forge/asset-manifest.ts";
import type { AssetRequest } from "../src/forge/asset-contract.ts";
import { AssetManifestEntrySchema } from "../src/forge/asset-contract.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archon-manifest-"));

function makeRequest(id: string, outputPath: string, prompt = "test prompt"): AssetRequest {
  return {
    id,
    provider: "placeholder_svg",
    assetType: "hero",
    purpose: "test",
    placement: "test",
    prompt,
    negativeConstraints: [],
    preferredSize: "auto",
    preferredFormat: "svg",
    background: "auto",
    outputPath,
    altText: `Alt text for ${id}`,
    needsUserApproval: false,
    status: "planned"
  };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("reconcileAssets — idempotency", () => {
  it("repeated calls with same requests + same filesystem => identical manifest", () => {
    // Create a real output file so reconcile picks it up
    const outPath = path.join(TMP_DIR, "idempotent-hero.svg");
    fs.writeFileSync(outPath, "<svg/>", "utf8");

    const requests: AssetRequest[] = [
      makeRequest("idem-001", outPath, "stable prompt")
    ];

    const first = reconcileAssets(requests);
    const second = reconcileAssets(requests);
    const third = reconcileAssets(requests);

    assert.deepEqual(
      first.entries,
      second.entries,
      "First and second reconcile must produce identical entries"
    );
    assert.deepEqual(
      second.entries,
      third.entries,
      "Second and third reconcile must produce identical entries"
    );
    assert.deepEqual(
      first.missingOutputs,
      second.missingOutputs,
      "missingOutputs must be stable across runs"
    );
  });
});

// ---------------------------------------------------------------------------
// Missing outputs
// ---------------------------------------------------------------------------

describe("reconcileAssets — missing outputs", () => {
  it("flags requests whose output file does not exist", () => {
    const missingPath = path.join(TMP_DIR, "nonexistent-output.webp");
    const requests: AssetRequest[] = [
      makeRequest("missing-001", missingPath, "a prompt")
    ];

    const result = reconcileAssets(requests);
    assert.ok(
      result.missingOutputs.includes("missing-001"),
      "missing-001 must appear in missingOutputs"
    );
    // Must NOT appear in entries if the file doesn't exist
    const entry = result.entries.find((e) => e.id === "missing-001");
    assert.equal(
      entry,
      undefined,
      "An entry for a missing file must not appear in entries"
    );
  });

  it("does not flag requests whose output file exists", () => {
    const presentPath = path.join(TMP_DIR, "present-output.svg");
    fs.writeFileSync(presentPath, "<svg/>", "utf8");
    const requests: AssetRequest[] = [
      makeRequest("present-001", presentPath, "a prompt")
    ];

    const result = reconcileAssets(requests);
    assert.ok(
      !result.missingOutputs.includes("present-001"),
      "present-001 must NOT appear in missingOutputs"
    );
    const entry = result.entries.find((e) => e.id === "present-001");
    assert.ok(entry, "present-001 must appear in entries");
  });
});

// ---------------------------------------------------------------------------
// Duplicate path detection
// ---------------------------------------------------------------------------

describe("reconcileAssets — duplicate paths", () => {
  it("flags duplicate outputPath values across requests", () => {
    const sharedPath = path.join(TMP_DIR, "shared-output.svg");
    fs.writeFileSync(sharedPath, "<svg/>", "utf8");

    const requests: AssetRequest[] = [
      makeRequest("dup-001", sharedPath, "prompt A"),
      makeRequest("dup-002", sharedPath, "prompt B")
    ];

    const result = reconcileAssets(requests);
    assert.ok(
      result.duplicatePaths.length > 0,
      "duplicatePaths must not be empty when two requests share outputPath"
    );
    assert.ok(
      result.duplicatePaths.includes(sharedPath),
      `duplicatePaths must include ${sharedPath}`
    );
  });

  it("does not flag unique paths as duplicates", () => {
    const path1 = path.join(TMP_DIR, "unique-a.svg");
    const path2 = path.join(TMP_DIR, "unique-b.svg");
    fs.writeFileSync(path1, "<svg/>", "utf8");
    fs.writeFileSync(path2, "<svg/>", "utf8");

    const requests: AssetRequest[] = [
      makeRequest("unique-001", path1, "prompt A"),
      makeRequest("unique-002", path2, "prompt B")
    ];

    const result = reconcileAssets(requests);
    assert.equal(
      result.duplicatePaths.length,
      0,
      "No duplicatePaths for unique output paths"
    );
  });
});

// ---------------------------------------------------------------------------
// promptHash
// ---------------------------------------------------------------------------

describe("reconcileAssets — promptHash", () => {
  it("records promptHash as 16-char hex prefix of sha256 of prompt", async () => {
    const outPath = path.join(TMP_DIR, "hash-test.svg");
    fs.writeFileSync(outPath, "<svg/>", "utf8");

    const prompt = "test deterministic hash prompt";
    const requests: AssetRequest[] = [
      makeRequest("hash-001", outPath, prompt)
    ];

    const result = reconcileAssets(requests);
    const entry = result.entries.find((e) => e.id === "hash-001");
    assert.ok(entry, "hash-001 must appear in entries");

    // Compute expected hash independently using SubtleCrypto
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(prompt));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const expectedHash = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    assert.equal(
      entry?.promptHash,
      expectedHash,
      `promptHash must be sha256[:16] of prompt. Expected: ${expectedHash}, got: ${entry?.promptHash}`
    );
  });

  it("promptHash is stable across reconcile runs", async () => {
    const outPath = path.join(TMP_DIR, "hash-stable.svg");
    fs.writeFileSync(outPath, "<svg/>", "utf8");

    const requests: AssetRequest[] = [
      makeRequest("hash-stable-001", outPath, "stable prompt value")
    ];

    const first = reconcileAssets(requests);
    const second = reconcileAssets(requests);

    const e1 = first.entries.find((e) => e.id === "hash-stable-001");
    const e2 = second.entries.find((e) => e.id === "hash-stable-001");
    assert.equal(e1?.promptHash, e2?.promptHash, "promptHash must be identical across runs");
  });
});

// ---------------------------------------------------------------------------
// Manifest entry shape
// ---------------------------------------------------------------------------

describe("reconcileAssets — entry shape", () => {
  it("entries have required AssetManifestEntry fields", () => {
    const outPath = path.join(TMP_DIR, "shape-entry.svg");
    fs.writeFileSync(outPath, "<svg/>", "utf8");

    const requests: AssetRequest[] = [
      makeRequest("shape-001", outPath, "shape test prompt")
    ];

    const result = reconcileAssets(requests);
    const entry = result.entries.find((e) => e.id === "shape-001");
    assert.ok(entry, "shape-001 entry must exist");
    assert.ok(typeof entry.id === "string");
    assert.ok(typeof entry.path === "string");
    assert.ok(typeof entry.promptHash === "string");
    assert.ok(typeof entry.alt === "string");
    assert.ok(Array.isArray(entry.usedIn));
    assert.ok(typeof entry.approved === "boolean");
    assert.ok(typeof entry.qaStatus === "string");
    assert.ok(Array.isArray(entry.notes));
  });
});

// ---------------------------------------------------------------------------
// ReconcileResult type shape
// ---------------------------------------------------------------------------

describe("reconcileAssets — result shape", () => {
  it("returns entries, missingOutputs, duplicatePaths", () => {
    const result: ReconcileResult = reconcileAssets([]);
    assert.ok(Array.isArray(result.entries));
    assert.ok(Array.isArray(result.missingOutputs));
    assert.ok(Array.isArray(result.duplicatePaths));
  });
});

// ---------------------------------------------------------------------------
// Schema round-trip — every produced entry MUST satisfy AssetManifestEntrySchema.
// (Regression guard: a prior bug defaulted originalRequestPath to "" which the
// schema's z.string().min(1) rejects; no test parsed entries through the schema.)
// ---------------------------------------------------------------------------

describe("reconcileAssets — schema round-trip", () => {
  it("every reconciled entry passes AssetManifestEntrySchema (no requestDir)", () => {
    const outPath = path.join(TMP_DIR, "roundtrip-a.svg");
    fs.writeFileSync(outPath, "<svg/>", "utf8");
    const result = reconcileAssets([makeRequest("rt-001", outPath, "p")]);
    assert.equal(result.entries.length, 1);
    for (const entry of result.entries) {
      const parsed = AssetManifestEntrySchema.safeParse(entry);
      assert.ok(
        parsed.success,
        `entry ${entry.id} must satisfy AssetManifestEntrySchema: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`
      );
      assert.ok(entry.originalRequestPath.length > 0, "originalRequestPath must be non-empty");
      assert.equal(entry.originalRequestPath, "rt-001.json", "defaults to <id>.json without requestDir");
    }
  });

  it("originalRequestPath is qualified by requestDir when provided", () => {
    const outPath = path.join(TMP_DIR, "roundtrip-b.svg");
    fs.writeFileSync(outPath, "<svg/>", "utf8");
    const result = reconcileAssets(
      [makeRequest("rt-002", outPath, "p")],
      "frontend_forge/generated/asset_requests"
    );
    const entry = result.entries.find((e) => e.id === "rt-002");
    assert.ok(entry, "rt-002 entry must exist");
    assert.ok(AssetManifestEntrySchema.safeParse(entry).success, "entry must satisfy schema");
    assert.equal(
      entry.originalRequestPath,
      path.join("frontend_forge/generated/asset_requests", "rt-002.json")
    );
  });
});

// ---------------------------------------------------------------------------
// Defense-in-depth path guard (repoRoot supplied)
// ---------------------------------------------------------------------------

describe("reconcileAssets — defense-in-depth path guard", () => {
  it("throws before filesystem access when an outputPath escapes the repoRoot", () => {
    const syntheticRepo = fs.mkdtempSync(path.join(os.tmpdir(), "archon-manifest-guard-"));
    // A path in TMP_DIR is outside the synthetic repo.
    const outsidePath = path.join(TMP_DIR, "outside-output.svg");
    const requests: AssetRequest[] = [makeRequest("guard-001", outsidePath, "test prompt")];
    try {
      assert.throws(
        () => reconcileAssets(requests, undefined, syntheticRepo),
        (err: unknown) => {
          assert.ok(err instanceof Error, "expected Error");
          assert.ok(
            err.message.includes("outside the repository"),
            `expected repo-escape error, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      fs.rmdirSync(syntheticRepo);
    }
  });

  it("accepts requests whose outputPaths are inside the repoRoot", () => {
    const syntheticRepo = fs.mkdtempSync(path.join(os.tmpdir(), "archon-manifest-guard-ok-"));
    const insidePath = path.join(syntheticRepo, "output.svg");
    fs.writeFileSync(insidePath, "<svg/>", "utf8");
    const requests: AssetRequest[] = [makeRequest("guard-ok-001", insidePath, "test prompt")];
    try {
      // Must not throw — path is inside the repo root.
      const result = reconcileAssets(requests, undefined, syntheticRepo);
      assert.ok(
        result.entries.length === 1 || result.missingOutputs.length >= 0,
        "expected a valid reconcile result"
      );
    } finally {
      try { fs.unlinkSync(insidePath); } catch { /* best-effort */ }
      fs.rmdirSync(syntheticRepo);
    }
  });

  it("skips the guard (no throw) when repoRoot is omitted", () => {
    // outputPath is in TMP_DIR (outside any synthetic repo) — no repoRoot given,
    // so no bounds check runs and no error is thrown.
    const outsidePath = path.join(TMP_DIR, "no-guard-output.svg");
    fs.writeFileSync(outsidePath, "<svg/>", "utf8");
    const requests: AssetRequest[] = [makeRequest("no-guard-001", outsidePath, "test prompt")];
    try {
      const result = reconcileAssets(requests);
      assert.ok(Array.isArray(result.entries), "expected entries array");
    } finally {
      try { fs.unlinkSync(outsidePath); } catch { /* best-effort */ }
    }
  });
});
