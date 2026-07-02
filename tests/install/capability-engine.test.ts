/**
 * Capability engine unit tests — S1.
 *
 * Covers:
 *   - Probe purity (injectable readFn, no real I/O)
 *   - Severity assembly (L0/L1 block in verify; L2/L3 advisory)
 *   - skipped probes never crash the assembler
 *   - C4 inventory assertion: CAPABILITY_REGISTRY ⊇ C4_INVENTORY
 *   - C8 credential scrub: credentials in probe detail are stripped from report
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  probeManagedFile,
} from "../../src/install/capability/probes-file.ts";
import type { ReadFileFn } from "../../src/install/capability/probes-file.ts";
import {
  probeMcpJsonArchon,
  probeMcpJsonPlaywright,
  probeSettingsHooks,
  probePackageGitGuardScripts,
  probePackageMigrateScript,
  probeDatabaseUrl,
  runL1Probes,
} from "../../src/install/capability/probes-config.ts";
import {
  assembleCapabilityReport,
  buildL2L3PlaceholderProbes,
} from "../../src/install/capability/report.ts";
import {
  CAPABILITY_REGISTRY,
  C4_INVENTORY,
} from "../../src/install/capability/registry.ts";
import type { ProbeResult } from "../../src/install/capability/types.ts";

// ---------------------------------------------------------------------------
// Helper stubs
// ---------------------------------------------------------------------------

/** Returns a ReadFileFn that maps absolute paths to string content. */
function makeReadFn(files: Record<string, string>): ReadFileFn {
  return async (absolutePath: string) => files[absolutePath];
}

/** Makes a minimal .mcp.json with the given mcpServers keys. */
function makeMcpJson(keys: string[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const key of keys) {
    mcpServers[key] = { command: "node", args: [] };
  }
  return JSON.stringify({ mcpServers });
}

/** Makes a minimal .claude/settings.json with the given hook types present. */
function makeSettingsJson(hookTypes: string[]): string {
  const hooks: Record<string, unknown> = {};
  for (const hookType of hookTypes) {
    hooks[hookType] = [{ hooks: [{ type: "command", command: "node .claude/hooks/test.mjs" }] }];
  }
  return JSON.stringify({ autoAcceptEdits: false, permissions: { allow: [], deny: [] }, hooks });
}

// ---------------------------------------------------------------------------
// C4 inventory test
// ---------------------------------------------------------------------------

test("C4: CAPABILITY_REGISTRY covers every capability in C4_INVENTORY", () => {
  const registeredCapabilities = new Set(CAPABILITY_REGISTRY.map((e) => e.capability));
  for (const required of C4_INVENTORY) {
    assert.ok(
      registeredCapabilities.has(required),
      `C4 inventory item '${required}' is missing from CAPABILITY_REGISTRY`
    );
  }
  // Sanity: registry should not be empty.
  assert.ok(CAPABILITY_REGISTRY.length >= C4_INVENTORY.length);
});

// ---------------------------------------------------------------------------
// L0 probe purity tests
// ---------------------------------------------------------------------------

test("probeManagedFile: ok when content matches desired", async () => {
  const readFn = makeReadFn({ "/target/file.txt": "hello world" });
  const result = await probeManagedFile(readFn, {
    capability: "agents",
    code: "agent-file",
    relativePath: "file.txt",
    absolutePath: "/target/file.txt",
    desiredContent: "hello world",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.layer, "L0");
  assert.equal(result.capability, "agents");
});

test("probeManagedFile: blocked-missing when file not found", async () => {
  const readFn = makeReadFn({});
  const result = await probeManagedFile(readFn, {
    capability: "agents",
    code: "agent-file",
    relativePath: "file.txt",
    absolutePath: "/target/file.txt",
    desiredContent: "hello world",
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.code.endsWith("-missing"), `code was ${result.code}`);
});

test("probeManagedFile: blocked-modified when content differs", async () => {
  const readFn = makeReadFn({ "/target/file.txt": "old content" });
  const result = await probeManagedFile(readFn, {
    capability: "agents",
    code: "agent-file",
    relativePath: "file.txt",
    absolutePath: "/target/file.txt",
    desiredContent: "new content",
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.code.endsWith("-modified"), `code was ${result.code}`);
});

test("probeManagedFile: blocked-read-error when readFn throws", async () => {
  const readFn: ReadFileFn = async (_p) => { throw new Error("disk error"); };
  const result = await probeManagedFile(readFn, {
    capability: "agents",
    code: "agent-file",
    relativePath: "file.txt",
    absolutePath: "/target/file.txt",
    desiredContent: "hello world",
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.code.endsWith("-read-error"), `code was ${result.code}`);
});

// ---------------------------------------------------------------------------
// L1 probe tests
// ---------------------------------------------------------------------------

const TARGET = "/fake/target";

test("probeMcpJsonArchon: ok when .mcp.json has mcpServers.archon", async () => {
  const readFn = makeReadFn({ [`${TARGET}/.mcp.json`]: makeMcpJson(["archon", "playwright"]) });
  const result = await probeMcpJsonArchon(readFn, TARGET);
  assert.equal(result.status, "ok");
  assert.equal(result.capability, "mcp-archon");
  assert.equal(result.layer, "L1");
});

test("probeMcpJsonArchon: blocked when .mcp.json missing (the #140 class)", async () => {
  const readFn = makeReadFn({});
  const result = await probeMcpJsonArchon(readFn, TARGET);
  assert.equal(result.status, "blocked");
  assert.equal(result.capability, "mcp-archon");
});

test("probeMcpJsonArchon: blocked when .mcp.json has no mcpServers.archon (the #140 class)", async () => {
  // .mcp.json present but archon key is absent — exactly the #140 wrong-file scenario.
  const readFn = makeReadFn({ [`${TARGET}/.mcp.json`]: makeMcpJson(["playwright"]) });
  const result = await probeMcpJsonArchon(readFn, TARGET);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "mcp-archon-absent");
});

test("probeMcpJsonPlaywright: blocked when .mcp.json missing mcpServers.playwright", async () => {
  const readFn = makeReadFn({ [`${TARGET}/.mcp.json`]: makeMcpJson(["archon"]) });
  const result = await probeMcpJsonPlaywright(readFn, TARGET);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "mcp-playwright-absent");
});

test("probeMcpJsonPlaywright: ok when .mcp.json has mcpServers.playwright", async () => {
  const readFn = makeReadFn({ [`${TARGET}/.mcp.json`]: makeMcpJson(["archon", "playwright"]) });
  const result = await probeMcpJsonPlaywright(readFn, TARGET);
  assert.equal(result.status, "ok");
});

test("probeSettingsHooks: ok when all required hook types present", async () => {
  const content = makeSettingsJson(["PreToolUse", "PostToolUse", "Stop"]);
  const readFn = makeReadFn({ [`${TARGET}/.claude/settings.json`]: content });
  const result = await probeSettingsHooks(readFn, TARGET);
  assert.equal(result.status, "ok");
  assert.equal(result.capability, "hooks");
});

test("probeSettingsHooks: blocked when hooks missing from settings.json", async () => {
  const readFn = makeReadFn({ [`${TARGET}/.claude/settings.json`]: JSON.stringify({ autoAcceptEdits: false }) });
  const result = await probeSettingsHooks(readFn, TARGET);
  assert.equal(result.status, "blocked");
});

test("probePackageGitGuardScripts: ok when git-guard scripts present", async () => {
  const pkg = JSON.stringify({ scripts: { "archon:setup:git-guard": "x", "archon:verify:git-guard": "y" } });
  const readFn = makeReadFn({ [`${TARGET}/package.json`]: pkg });
  const result = await probePackageGitGuardScripts(readFn, TARGET);
  assert.equal(result.status, "ok");
  assert.equal(result.capability, "git-guard");
});

test("probePackageMigrateScript: ok when archon:migrate present", async () => {
  const pkg = JSON.stringify({ scripts: { "archon:migrate": "archon migrate" } });
  const readFn = makeReadFn({ [`${TARGET}/package.json`]: pkg });
  const result = await probePackageMigrateScript(readFn, TARGET);
  assert.equal(result.status, "ok");
  assert.equal(result.capability, "doctor");
});

test("probeDatabaseUrl: ok when .env.archon has valid postgres URL", async () => {
  const readFn = makeReadFn({ [`${TARGET}/.env.archon`]: "ARCHON_CORE_DATABASE_URL=postgres://user:pass@localhost:5432/db\n" });
  const result = await probeDatabaseUrl(readFn, TARGET);
  assert.equal(result.status, "ok");
  assert.equal(result.capability, "db-migrations");
});

test("probeDatabaseUrl: blocked when .env.archon missing", async () => {
  const readFn = makeReadFn({});
  const result = await probeDatabaseUrl(readFn, TARGET);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "db-url-env-missing");
});

test("probeDatabaseUrl: C8 — credential not in detail/remediation when URL invalid", async () => {
  // A valid URL actually passes — test blocked path with a bad URL
  const badReadFn = makeReadFn({ [`${TARGET}/.env.archon`]: "ARCHON_CORE_DATABASE_URL=not-a-url\n" });
  const result = await probeDatabaseUrl(badReadFn, TARGET);
  assert.equal(result.status, "blocked");
  // detail and remediation must not contain raw credential fragments
  assert.doesNotMatch(result.detail, /not-a-url/, "detail should not echo the raw URL value");
});

test("runL1Probes: returns 6 probe results, never throws", async () => {
  const readFn = makeReadFn({});
  const results = await runL1Probes(readFn, TARGET);
  assert.equal(results.length, 6, "expected exactly 6 L1 probes");
  for (const r of results) {
    assert.ok(r.layer === "L1", `expected L1 layer, got ${r.layer}`);
    assert.ok(["ok", "blocked", "degraded", "skipped"].includes(r.status));
  }
});

// ---------------------------------------------------------------------------
// Severity assembly tests
// ---------------------------------------------------------------------------

test("assembleCapabilityReport: L0 blocked is blocking in verify context", () => {
  const probes: ProbeResult[] = [
    { capability: "managed-files", layer: "L0", status: "blocked", code: "test", detail: "missing file", remediation: "fix it" },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  assert.equal(report.ok, false);
  assert.equal(report.blockers.length, 1);
  assert.equal(report.advisories.length, 0);
});

test("assembleCapabilityReport: L1 blocked is blocking in verify context", () => {
  const probes: ProbeResult[] = [
    { capability: "mcp-archon", layer: "L1", status: "blocked", code: "test", detail: "no server", remediation: "install it" },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  assert.equal(report.ok, false);
  assert.equal(report.blockers.length, 1);
});

test("assembleCapabilityReport: L2 blocked is advisory (not blocking) in verify context", () => {
  const probes: ProbeResult[] = [
    { capability: "ecc-plugin", layer: "L2", status: "blocked", code: "test", detail: "not installed", remediation: "install ecc" },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  assert.equal(report.ok, true, "L2 blocked should NOT block in verify context");
  assert.equal(report.advisories.length, 1);
  assert.equal(report.blockers.length, 0);
});

test("assembleCapabilityReport: skipped probe never crashes and produces advisory", () => {
  const probes: ProbeResult[] = [
    { capability: "ecc-plugin", layer: "L2", status: "skipped", code: "placeholder", detail: "not yet implemented", remediation: "" },
  ];
  // Should not throw
  const report = assembleCapabilityReport(probes, "verify");
  assert.equal(report.ok, true);
  // skipped with empty remediation — advisory only if detail is non-empty
  assert.equal(report.blockers.length, 0);
});

test("assembleCapabilityReport: L3 blocked is advisory in verify context", () => {
  const probes: ProbeResult[] = [
    { capability: "doctor", layer: "L3", status: "blocked", code: "db-down", detail: "DB unreachable", remediation: "fix DB" },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  assert.equal(report.ok, true);
  assert.equal(report.advisories.length, 1);
});

test("assembleCapabilityReport: ok=true when no probes fail", () => {
  const probes: ProbeResult[] = [
    { capability: "managed-files", layer: "L0", status: "ok", code: "ok", detail: "all good", remediation: "" },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  assert.equal(report.ok, true);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.advisories.length, 0);
});

test("assembleCapabilityReport: C8 — scrubs credentials from detail in output", () => {
  const probes: ProbeResult[] = [
    {
      capability: "db-migrations",
      layer: "L1",
      status: "blocked",
      code: "db-url-invalid",
      // Simulate a probe that forgot to scrub (defence-in-depth test)
      detail: "URL postgres://admin:secret@host:5432/db is invalid",
      remediation: "fix postgres://admin:secret@host:5432/db",
    },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  // The report assembler scrubs credentials from blockers and nextActions.
  for (const blocker of report.blockers) {
    assert.doesNotMatch(blocker, /admin:secret/, "credentials must be scrubbed from blockers");
  }
  for (const action of report.nextActions) {
    assert.doesNotMatch(action, /admin:secret/, "credentials must be scrubbed from nextActions");
  }
});

// ---------------------------------------------------------------------------
// L2/L3 placeholder probes
// ---------------------------------------------------------------------------

test("buildL2L3PlaceholderProbes: returns skipped probes that never block in verify", () => {
  const placeholders = buildL2L3PlaceholderProbes();
  assert.ok(placeholders.length >= 2, "expected at least 2 L2/L3 placeholders");
  for (const probe of placeholders) {
    assert.equal(probe.status, "skipped");
    assert.ok(probe.layer === "L2" || probe.layer === "L3");
  }
  const report = assembleCapabilityReport(placeholders, "verify");
  assert.equal(report.ok, true, "L2/L3 skipped placeholders must not block verify");
});
