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
  extractEnvValue,
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
import { managedFileCapability } from "../../src/install/cli.ts";

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

test("probeDatabaseUrl: C8 — credential not in detail/remediation when URL invalid (LOW-11)", async () => {
  // LOW-11: use a credential-bearing URL so the scrub is non-vacuous.
  const credUrl = "postgres://user:secret@host/db";
  const badReadFn = makeReadFn({ [`${TARGET}/.env.archon`]: `ARCHON_CORE_DATABASE_URL=${credUrl}\n` });
  const result = await probeDatabaseUrl(badReadFn, TARGET);
  // postgres://user:secret@host/db is invalid (no port, but still parseable) — may be ok or blocked
  // The critical assertion is that "secret" never appears in any output field.
  assert.doesNotMatch(result.detail, /secret/, "detail must not contain the raw password");
  assert.doesNotMatch(result.remediation ?? "", /secret/, "remediation must not contain the raw password");
  assert.doesNotMatch(result.code, /secret/, "code must not contain the raw password");
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

test("assembleCapabilityReport: skipped probe with remediation surfaces in nextActions (LOW-7)", () => {
  // S1 accepted LOW: assert that skipped probes with non-empty remediation add
  // to nextActions so operators know what manual step to take when a tool is absent.
  const remediation = "Run: npm run archon:setup:playwright";
  const probes: ProbeResult[] = [
    {
      capability: "playwright-browsers",
      layer: "L2",
      status: "skipped",
      code: "playwright-browsers-placeholder",
      detail: "Playwright browser check not yet implemented",
      remediation,
    },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  assert.equal(report.ok, true, "skipped probe must not block");
  assert.ok(
    report.nextActions.includes(remediation),
    `nextActions must include the skipped probe's remediation: ${remediation}`
  );
});

test("assembleCapabilityReport: skipped probe with empty remediation does NOT add to nextActions", () => {
  const probes: ProbeResult[] = [
    { capability: "ecc-plugin", layer: "L2", status: "skipped", code: "x", detail: "skipped", remediation: "" },
  ];
  const report = assembleCapabilityReport(probes, "verify");
  assert.equal(report.nextActions.length, 0, "empty remediation must not add to nextActions");
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

test("assembleCapabilityReport: C8 — scrubs credentials from all report fields (MEDIUM-6)", () => {
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

  // Blockers and nextActions must be scrubbed.
  for (const blocker of report.blockers) {
    assert.doesNotMatch(blocker, /admin:secret/, "credentials must be scrubbed from blockers");
  }
  for (const action of report.nextActions) {
    assert.doesNotMatch(action, /admin:secret/, "credentials must be scrubbed from nextActions");
  }

  // MEDIUM-6: report.probes[*].detail and .remediation must also be scrubbed (HIGH-2 fix).
  for (const probe of report.probes) {
    assert.doesNotMatch(probe.detail, /admin:secret/, `probes[${probe.capability}].detail must be scrubbed`);
    assert.doesNotMatch(probe.remediation ?? "", /admin:secret/, `probes[${probe.capability}].remediation must be scrubbed`);
  }

  // MEDIUM-6: full JSON.stringify round-trip must not contain the raw credential.
  const serialised = JSON.stringify(report);
  assert.doesNotMatch(serialised, /admin:secret/, "raw credential must not appear anywhere in serialised report");
});

// ---------------------------------------------------------------------------
// L2/L3 placeholder probes
// ---------------------------------------------------------------------------

test("buildL2L3PlaceholderProbes: returns exactly 3 skipped probes that never block in verify (LOW-10)", () => {
  const placeholders = buildL2L3PlaceholderProbes();
  // LOW-10: must be exactly 3 (ecc-plugin L2, playwright-browsers L2, doctor L3).
  assert.equal(placeholders.length, 3, "expected exactly 3 L2/L3 placeholder probes");
  for (const probe of placeholders) {
    assert.equal(probe.status, "skipped");
    assert.ok(probe.layer === "L2" || probe.layer === "L3");
  }
  const report = assembleCapabilityReport(placeholders, "verify");
  assert.equal(report.ok, true, "L2/L3 skipped placeholders must not block verify");
});

// ---------------------------------------------------------------------------
// MEDIUM-4: extractEnvValue direct unit tests
// ---------------------------------------------------------------------------

test("extractEnvValue: plain key=value", () => {
  assert.equal(extractEnvValue("KEY=value\n", "KEY"), "value");
});

test("extractEnvValue: double-quoted value", () => {
  assert.equal(extractEnvValue('KEY="hello world"\n', "KEY"), "hello world");
});

test("extractEnvValue: single-quoted value", () => {
  assert.equal(extractEnvValue("KEY='hello world'\n", "KEY"), "hello world");
});

test("extractEnvValue: export-prefixed key", () => {
  assert.equal(extractEnvValue("export KEY=value\n", "KEY"), "value");
});

test("extractEnvValue: inline comment stripped", () => {
  assert.equal(extractEnvValue("KEY=value # this is a comment\n", "KEY"), "value");
});

test("extractEnvValue: returns undefined when key absent", () => {
  assert.equal(extractEnvValue("OTHER=value\n", "KEY"), undefined);
});

test("extractEnvValue: ignores comment lines", () => {
  const content = "# KEY=value\nKEY=real\n";
  assert.equal(extractEnvValue(content, "KEY"), "real");
});

test("extractEnvValue: postgres URL round-trips without mutation", () => {
  const url = "postgres://user:pass@localhost:5432/db";
  const content = `ARCHON_CORE_DATABASE_URL=${url}\n`;
  assert.equal(extractEnvValue(content, "ARCHON_CORE_DATABASE_URL"), url);
});

// ---------------------------------------------------------------------------
// MEDIUM-5: canonical #140 regression test
// ---------------------------------------------------------------------------

test("MEDIUM-5 / #140 class: mcp-archon probe blocked when fragment is in settings.json but .mcp.json is absent", async () => {
  // This is the exact failure mode of #140: the installer wrote mcpServers.archon
  // to .claude/settings.json instead of .mcp.json. The fragment is "present somewhere"
  // but .mcp.json is absent → the L1 probe must return blocked regardless.
  const settingsWithArchon = JSON.stringify({
    autoAcceptEdits: false,
    hooks: { PreToolUse: [], PostToolUse: [], Stop: [] },
    // Fragment that belongs in .mcp.json was written here by mistake
    mcpServers: { archon: { command: "node", args: [".claude/mcp/archon.mjs"] } },
  });
  const readFn = makeReadFn({
    // .mcp.json is ABSENT (not in the map)
    [`${TARGET}/.claude/settings.json`]: settingsWithArchon,
  });

  const result = await probeMcpJsonArchon(readFn, TARGET);
  assert.equal(
    result.status,
    "blocked",
    "#140 regression: probe must return blocked when .mcp.json is absent, even if fragment exists in settings.json"
  );
  assert.equal(result.capability, "mcp-archon");
  // Code must distinguish file-missing from other failures
  assert.equal(result.code, "mcp-archon-file-missing", "code should be file-missing when .mcp.json is absent");
});

// ---------------------------------------------------------------------------
// LOW-8: per-capability naming for L0 probes (S2 fix)
// ---------------------------------------------------------------------------

test("LOW-8: managedFileCapability maps .claude/agents/ files to 'agents'", () => {
  assert.equal(managedFileCapability(".claude/agents/planner/AGENT.md"), "agents");
  assert.equal(managedFileCapability(".claude/agents/reviewer/AGENT.md"), "agents");
  assert.equal(managedFileCapability("AGENTS.md"), "agents");
});

test("LOW-8: managedFileCapability maps .claude/skills/ files to 'skills'", () => {
  assert.equal(managedFileCapability(".claude/skills/archon-execution/SKILL.md"), "skills");
  assert.equal(managedFileCapability(".claude/skills/archon-intake/SKILL.md"), "skills");
});

test("LOW-8: managedFileCapability maps .claude/hooks/ files to 'hooks'", () => {
  assert.equal(managedFileCapability(".claude/hooks/archon-pre-tool.mjs"), "hooks");
  assert.equal(managedFileCapability(".claude/hooks/archon-stop.mjs"), "hooks");
  assert.equal(managedFileCapability(".claude/settings.json"), "hooks");
});

test("LOW-8: managedFileCapability maps .archon/rules/ to 'rules'", () => {
  assert.equal(managedFileCapability(".archon/rules/review-gate-policy.md"), "rules");
});

test("LOW-8: managedFileCapability maps .archon/templates/ to 'workflow-scaffold'", () => {
  assert.equal(managedFileCapability(".archon/templates/review-identity-adapter.fixture.json"), "workflow-scaffold");
});

test("LOW-8: managedFileCapability maps .githooks/ files to 'git-guard'", () => {
  assert.equal(managedFileCapability(".githooks/commit-msg"), "git-guard");
});

test("LOW-8: managedFileCapability maps .mcp.json and plugins/archon/ to 'mcp-archon'", () => {
  assert.equal(managedFileCapability(".mcp.json"), "mcp-archon");
  assert.equal(managedFileCapability("plugins/archon/index.js"), "mcp-archon");
});

test("LOW-8: managedFileCapability falls back to 'managed-files' for unmapped paths", () => {
  assert.equal(managedFileCapability("some-other-file.txt"), "managed-files");
  assert.equal(managedFileCapability("package.json"), "managed-files");
});

test("LOW-8: managedFileCapability maps .archon/playwright/ to 'playwright-browsers'", () => {
  assert.equal(managedFileCapability(".archon/playwright/playwright.config.ts"), "playwright-browsers");
});
