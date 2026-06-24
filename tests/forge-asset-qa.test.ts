/**
 * Tests for src/forge/asset-qa.ts
 *
 * TDD: failing tests written before implementation.
 *
 * Verifies:
 *   1. A good fallback SVG PASSES QA
 *   2. Wrong format (file extension mismatch) FAILS
 *   3. Empty altText FAILS
 *   4. SVG with embedded <script> FAILS
 *   5. SVG with <image> (raster) FAILS
 *   6. Findings carry id + measured-vs-expected
 *   7. Non-mechanical checks emit explicit unchecked flags
 *
 * Run with: node --experimental-strip-types --test tests/forge-asset-qa.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runAssetQA } from "../src/forge/asset-qa.ts";
import type { AssetQAReport } from "../src/forge/asset-qa.ts";
import type { AssetRequest } from "../src/forge/asset-contract.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Write a temp file and return the path. Caller must unlink. */
function writeTmp(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function makeRequest(overrides: Partial<AssetRequest> = {}): AssetRequest {
  return {
    id: "test-asset",
    provider: "placeholder_svg",
    assetType: "hero",
    purpose: "Test QA",
    placement: "test-slot",
    prompt: "test prompt",
    negativeConstraints: [],
    preferredSize: "auto",
    preferredFormat: "svg",
    background: "auto",
    outputPath: "web/public/fallbacks/hero.svg",
    altText: "A hero placeholder image",
    needsUserApproval: false,
    status: "planned",
    ...overrides
  };
}

// Minimal well-formed SVG (passes all QA checks)
const GOOD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400">
  <rect width="800" height="400" fill="#0A0A0A"/>
  <text x="400" y="200" fill="#EDEDED" font-family="Geist Sans, sans-serif" text-anchor="middle">hero placeholder</text>
</svg>`;

// ---------------------------------------------------------------------------
// Setup: create a temp directory for test files
// ---------------------------------------------------------------------------

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archon-asset-qa-"));

// ---------------------------------------------------------------------------
// Good asset passes
// ---------------------------------------------------------------------------

describe("runAssetQA — good asset passes", () => {
  it("a well-formed SVG with correct format and altText passes", () => {
    const svgPath = writeTmp(TMP_DIR, "hero-good.svg", GOOD_SVG);
    const req = makeRequest({ outputPath: svgPath, preferredFormat: "svg" });
    const report = runAssetQA(svgPath, req);
    const failures = report.findings.filter(
      (f) => f.severity === "fail" && !f.unchecked
    );
    assert.equal(
      failures.length,
      0,
      `Good SVG must produce no failures; got: ${JSON.stringify(failures)}`
    );
    assert.equal(report.pass, true, "Good SVG must PASS overall");
    fs.unlinkSync(svgPath);
  });

  it("committed fallback for hero passes QA", () => {
    const fallbackPath = path.join(
      process.cwd(),
      "web/public/fallbacks/hero.svg"
    );
    if (!fs.existsSync(fallbackPath)) {
      // Skip if fallback not yet generated (CI/no-codex run)
      return;
    }
    const req = makeRequest({
      outputPath: fallbackPath,
      assetType: "hero",
      preferredFormat: "svg"
    });
    const report = runAssetQA(fallbackPath, req);
    const failures = report.findings.filter(
      (f) => f.severity === "fail" && !f.unchecked
    );
    assert.equal(
      failures.length,
      0,
      `hero fallback SVG must pass QA; failures: ${JSON.stringify(failures)}`
    );
  });
});

// ---------------------------------------------------------------------------
// File existence check
// ---------------------------------------------------------------------------

describe("runAssetQA — file existence", () => {
  it("fails when the file does not exist", () => {
    const req = makeRequest({
      outputPath: "/nonexistent/path/to/asset.svg",
      preferredFormat: "svg"
    });
    const report = runAssetQA("/nonexistent/path/to/asset.svg", req);
    const missing = report.findings.find((f) => f.id === "QA-001");
    assert.ok(missing, "QA-001 (file exists) finding must be present");
    assert.equal(missing?.severity, "fail", "Missing file must be a fail");
    assert.equal(report.pass, false, "Missing file must FAIL overall");
  });
});

// ---------------------------------------------------------------------------
// Format mismatch
// ---------------------------------------------------------------------------

describe("runAssetQA — format mismatch", () => {
  it("fails when file extension does not match preferredFormat", () => {
    // Write an SVG file but request says format=webp
    const svgPath = writeTmp(TMP_DIR, "format-mismatch.svg", GOOD_SVG);
    const req = makeRequest({ outputPath: svgPath, preferredFormat: "webp" });
    const report = runAssetQA(svgPath, req);
    const mismatch = report.findings.find((f) => f.id === "QA-002");
    assert.ok(mismatch, "QA-002 (format mismatch) finding must be present");
    assert.equal(mismatch?.severity, "fail", "Format mismatch must be a fail");
    assert.ok(
      typeof mismatch?.measured === "string" && mismatch.measured.includes("svg"),
      "measured must describe the actual extension"
    );
    assert.ok(
      typeof mismatch?.expected === "string" && mismatch.expected.includes("webp"),
      "expected must cite preferredFormat"
    );
    fs.unlinkSync(svgPath);
  });
});

// ---------------------------------------------------------------------------
// Empty altText
// ---------------------------------------------------------------------------

describe("runAssetQA — altText presence", () => {
  it("fails when altText is empty", () => {
    const svgPath = writeTmp(TMP_DIR, "alt-empty.svg", GOOD_SVG);
    const req = makeRequest({ outputPath: svgPath, altText: "" });
    const report = runAssetQA(svgPath, req);
    const altFail = report.findings.find((f) => f.id === "QA-003");
    assert.ok(altFail, "QA-003 (altText present) finding must be present");
    assert.equal(altFail?.severity, "fail", "Empty altText must be a fail");
    fs.unlinkSync(svgPath);
  });

  it("fails when altText is whitespace-only", () => {
    const svgPath = writeTmp(TMP_DIR, "alt-whitespace.svg", GOOD_SVG);
    const req = makeRequest({ outputPath: svgPath, altText: "   " });
    const report = runAssetQA(svgPath, req);
    const altFail = report.findings.find((f) => f.id === "QA-003");
    assert.ok(altFail, "QA-003 finding must be present for whitespace-only altText");
    assert.equal(altFail?.severity, "fail");
    fs.unlinkSync(svgPath);
  });
});

// ---------------------------------------------------------------------------
// SVG with embedded <script> fails
// ---------------------------------------------------------------------------

describe("runAssetQA — SVG security checks", () => {
  it("fails when SVG contains a <script> tag", () => {
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <script>alert("xss")</script>
  <rect width="100" height="100" fill="#0A0A0A"/>
</svg>`;
    const svgPath = writeTmp(TMP_DIR, "script-bad.svg", maliciousSvg);
    const req = makeRequest({ outputPath: svgPath });
    const report = runAssetQA(svgPath, req);
    const scriptFail = report.findings.find((f) => f.id === "QA-004");
    assert.ok(scriptFail, "QA-004 (no script) finding must be present");
    assert.equal(scriptFail?.severity, "fail", "<script> must be a fail");
    assert.equal(report.pass, false);
    fs.unlinkSync(svgPath);
  });

  it("fails when SVG contains <image> (raster embedding)", () => {
    const rasterSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <image href="data:image/png;base64,abc" width="100" height="100"/>
  <rect width="100" height="100" fill="#0A0A0A"/>
</svg>`;
    const svgPath = writeTmp(TMP_DIR, "raster-bad.svg", rasterSvg);
    const req = makeRequest({ outputPath: svgPath });
    const report = runAssetQA(svgPath, req);
    const rasterFail = report.findings.find((f) => f.id === "QA-005");
    assert.ok(rasterFail, "QA-005 (no raster <image>) finding must be present");
    assert.equal(rasterFail?.severity, "fail", "<image> must be a fail");
    assert.equal(report.pass, false);
    fs.unlinkSync(svgPath);
  });

  it("fails when SVG contains on* event attributes", () => {
    const eventSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <rect width="100" height="100" fill="#0A0A0A" onclick="evil()"/>
</svg>`;
    const svgPath = writeTmp(TMP_DIR, "event-bad.svg", eventSvg);
    const req = makeRequest({ outputPath: svgPath });
    const report = runAssetQA(svgPath, req);
    const eventFail = report.findings.find((f) => f.id === "QA-006");
    assert.ok(eventFail, "QA-006 (no on* events) finding must be present");
    assert.equal(eventFail?.severity, "fail");
    assert.equal(report.pass, false);
    fs.unlinkSync(svgPath);
  });
});

// ---------------------------------------------------------------------------
// Byte size check
// ---------------------------------------------------------------------------

describe("runAssetQA — byte size", () => {
  it("fails when SVG is unreasonably large (> 500KB)", () => {
    const hugeContent = "x".repeat(600_000);
    const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!-- ${hugeContent} --></svg>`;
    const svgPath = writeTmp(TMP_DIR, "huge.svg", bigSvg);
    const req = makeRequest({ outputPath: svgPath });
    const report = runAssetQA(svgPath, req);
    const sizeFail = report.findings.find((f) => f.id === "QA-007");
    assert.ok(sizeFail, "QA-007 (byte size) finding must be present for huge SVG");
    assert.equal(sizeFail?.severity, "fail");
    fs.unlinkSync(svgPath);
  });
});

// ---------------------------------------------------------------------------
// Finding structure — id + measured/expected
// ---------------------------------------------------------------------------

describe("runAssetQA — finding structure", () => {
  it("every finding has an id, severity, and message", () => {
    const svgPath = writeTmp(TMP_DIR, "empty-alt-struct.svg", GOOD_SVG);
    const req = makeRequest({ outputPath: svgPath, altText: "" });
    const report = runAssetQA(svgPath, req);
    for (const finding of report.findings) {
      assert.ok(typeof finding.id === "string" && finding.id.length > 0, "finding.id must be a non-empty string");
      assert.ok(
        finding.severity === "pass" || finding.severity === "fail" || finding.severity === "warn",
        `finding.severity must be pass|fail|warn, got: ${finding.severity}`
      );
      assert.ok(typeof finding.message === "string", "finding.message must be a string");
    }
    fs.unlinkSync(svgPath);
  });

  it("non-mechanical findings carry explicit unchecked flag", () => {
    const svgPath = writeTmp(TMP_DIR, "unchecked.svg", GOOD_SVG);
    const req = makeRequest({ outputPath: svgPath });
    const report = runAssetQA(svgPath, req);
    // There must be at least one unchecked finding declared
    const unchecked = report.findings.filter((f) => f.unchecked === true);
    assert.ok(
      unchecked.length > 0,
      "At least one finding must carry unchecked=true for non-mechanical checks"
    );
    fs.unlinkSync(svgPath);
  });
});

// ---------------------------------------------------------------------------
// AssetQAReport type shape
// ---------------------------------------------------------------------------

describe("runAssetQA — report shape", () => {
  it("returns a report with pass boolean and findings array", () => {
    const svgPath = writeTmp(TMP_DIR, "shape-test.svg", GOOD_SVG);
    const req = makeRequest({ outputPath: svgPath });
    const report: AssetQAReport = runAssetQA(svgPath, req);
    assert.ok(typeof report.pass === "boolean", "report.pass must be boolean");
    assert.ok(Array.isArray(report.findings), "report.findings must be an array");
    assert.ok(typeof report.assetPath === "string", "report.assetPath must be a string");
    fs.unlinkSync(svgPath);
  });
});
