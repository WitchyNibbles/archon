/**
 * verify --json integration tests — S1.
 *
 * Proves the #140 wrong-file class is caught by the L1 mcp-archon probe through
 * the product's own read model. D-C11 (BOTH): this is the unit-test leg;
 * the pack-install CI leg is in .github/workflows/ci.yml + scripts/ci/assert-verify-json.mjs.
 *
 * Tests:
 *   1. After init --apply, L1 mcp probes return ok — proves MCP config lands in .mcp.json.
 *   2. Wrong-file case: .mcp.json lacks mcpServers.archon → L1 probe returns blocked.
 *   3. verify --json report has the required shape (ok, blockers, advisories, probes).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  probeMcpJsonArchon,
  probeMcpJsonPlaywright,
} from "../../src/install/capability/probes-config.ts";
import type { ReadFileFn } from "../../src/install/capability/probes-file.ts";
import { assembleCapabilityReport } from "../../src/install/capability/report.ts";
import { installArchonIntoProject } from "../../src/install/cli.ts";

const sourceRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

/** Real fs ReadFileFn used by integration tests. */
const fsReadFn: ReadFileFn = async (absolutePath: string) => {
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Wrong-file class detection (pure unit test — no real fs needed)
// ---------------------------------------------------------------------------

test("#140 class: L1 mcp-archon probe returns blocked when .mcp.json lacks mcpServers.archon", async () => {
  // Simulate .mcp.json that exists but has no archon key — the exact #140 scenario.
  const fakeReadFn: ReadFileFn = async (p: string) => {
    if (p.endsWith(".mcp.json")) {
      return JSON.stringify({ mcpServers: { playwright: { command: "node", args: [] } } });
    }
    return undefined;
  };
  const result = await probeMcpJsonArchon(fakeReadFn, "/fake/target");
  assert.equal(result.status, "blocked", "archon MCP absent must be blocked");
  assert.equal(result.capability, "mcp-archon");
  assert.equal(result.layer, "L1");
  assert.equal(result.code, "mcp-archon-absent");
});

test("#140 class: L1 mcp-playwright probe returns blocked when .mcp.json lacks mcpServers.playwright", async () => {
  const fakeReadFn: ReadFileFn = async (p: string) => {
    if (p.endsWith(".mcp.json")) {
      return JSON.stringify({ mcpServers: { archon: { command: "node", args: [] } } });
    }
    return undefined;
  };
  const result = await probeMcpJsonPlaywright(fakeReadFn, "/fake/target");
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "mcp-playwright-absent");
});

test("#140 class: report.ok=false when mcp-archon L1 probe is blocked", () => {
  const probe = {
    capability: "mcp-archon",
    layer: "L1" as const,
    status: "blocked" as const,
    code: "mcp-archon-absent",
    detail: ".mcp.json does not contain mcpServers.archon",
    remediation: "Run 'archon upgrade --apply'",
  };
  const report = assembleCapabilityReport([probe], "verify");
  assert.equal(report.ok, false);
  assert.ok(report.blockers.length > 0);
});

// ---------------------------------------------------------------------------
// Integration: after init --apply, L1 MCP probes pass
// ---------------------------------------------------------------------------

test("after init --apply into temp dir, mcp-archon and mcp-playwright L1 probes return ok", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "archon-verify-json-test-"));
  try {
    // Minimal package.json required for init
    await writeFile(path.join(tempDir, "package.json"), '{"name":"smoke-test","private":true}', "utf8");

    // Run install (same as init --apply)
    await installArchonIntoProject({ sourceRoot, targetRoot: tempDir });

    // Now run L1 probes against the installed temp dir
    const archonProbe = await probeMcpJsonArchon(fsReadFn, tempDir);
    const playwrightProbe = await probeMcpJsonPlaywright(fsReadFn, tempDir);

    assert.equal(
      archonProbe.status,
      "ok",
      `mcp-archon probe failed: ${archonProbe.detail} (code=${archonProbe.code}) — ` +
        "this catches the #140 class: MCP config was written to the wrong file."
    );
    assert.equal(
      playwrightProbe.status,
      "ok",
      `mcp-playwright probe failed: ${playwrightProbe.detail}`
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CapabilityReport JSON shape contract
// ---------------------------------------------------------------------------

test("assembleCapabilityReport: output shape matches doctor JSON contract (ok, blockers, advisories, nextActions, reason, probes)", () => {
  const probes = [
    {
      capability: "mcp-archon",
      layer: "L1" as const,
      status: "ok" as const,
      code: "mcp-archon-present",
      detail: "ok",
      remediation: "",
    },
    {
      capability: "ecc-plugin",
      layer: "L2" as const,
      status: "skipped" as const,
      code: "ecc-plugin-placeholder",
      detail: "not yet implemented",
      remediation: "",
    },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  // Verify all fields required by doctor JSON contract
  assert.equal(typeof report.ok, "boolean");
  assert.ok(Array.isArray(report.blockers));
  assert.ok(Array.isArray(report.advisories));
  assert.ok(Array.isArray(report.nextActions));
  assert.equal(typeof report.reason, "string");
  assert.ok(Array.isArray(report.probes));
  // Serialises to valid JSON
  const json = JSON.stringify(report);
  const parsed = JSON.parse(json) as typeof report;
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.probes));
});
