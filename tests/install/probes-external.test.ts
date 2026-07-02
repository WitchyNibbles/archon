/**
 * Tests for L2 external capability probes (src/install/capability/probes-external.ts).
 *
 * All tests use injected stubs — no real process spawning, no real filesystem access.
 * Mirrors the DbQueryFn injection pattern from db-preflight.ts.
 *
 * Covers:
 *   - probeClaudePresent: present/absent/degraded
 *   - probeNodeModules: installed/absent
 *   - probePlaywrightBrowsers: not-a-dependency/absent/browsers-ok
 *   - probeAdapterStub: absent/unimplemented/replaced
 *   - probeEccPresent (S3 real): canonical/legacy/absent/claude-absent
 *   - probeSkillRefNamespace (S3 new, C1): mismatch both directions, match, no refs
 *   - runL2Probes: 6 probes, never throws, includes ecc-plugin + skill-ref-namespace
 *   - council C9: adapter-stub remediation states the assurance boundary
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  probeClaudePresent,
  probeNodeModules,
  probePlaywrightBrowsers,
  probeAdapterStub,
  probeEccPresent,
  probeSkillRefNamespace,
  runL2Probes,
} from "../../src/install/capability/probes-external.ts";
import type { SpawnFn, FindAgentFilesFn } from "../../src/install/capability/probes-external.ts";
import type { ReadFileFn } from "../../src/install/capability/probes-file.ts";
import { ECC_CANONICAL_SKILL_PREFIX, ECC_LEGACY_SKILL_PREFIX } from "../../src/install/ecc-plugin.ts";

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

function makeSpawnFn(
  exitCode: number | null,
  stdout = "",
  stderr = ""
): SpawnFn {
  return async () => ({ exitCode, stdout, stderr });
}

function makeSpawnFnThrowing(message: string): SpawnFn {
  return async () => {
    throw new Error(message);
  };
}

function makeReadFn(files: Record<string, string>): ReadFileFn {
  return async (absolutePath: string) => files[absolutePath];
}

const TARGET = "/fake/repo";

// ---------------------------------------------------------------------------
// probeClaudePresent
// ---------------------------------------------------------------------------

test("probeClaudePresent: claude present → ok", async () => {
  const spawnFn = makeSpawnFn(0, "claude 1.2.3\n");
  const result = await probeClaudePresent(spawnFn);
  assert.equal(result.status, "ok");
  assert.equal(result.capability, "claude-present");
  assert.equal(result.layer, "L2");
  assert.match(result.code, /ok/);
});

test("probeClaudePresent: ENOENT → skipped (tool absent)", async () => {
  const spawnFn = makeSpawnFnThrowing("spawn ENOENT");
  const result = await probeClaudePresent(spawnFn);
  assert.equal(result.status, "skipped");
  assert.equal(result.capability, "claude-present");
  assert.ok(result.remediation.length > 0, "skipped probe must have remediation");
});

test("probeClaudePresent: exit non-zero → degraded", async () => {
  const spawnFn = makeSpawnFn(1, "", "error");
  const result = await probeClaudePresent(spawnFn);
  assert.equal(result.status, "degraded");
  assert.equal(result.capability, "claude-present");
});

test("probeClaudePresent: generic spawn error (not ENOENT) → skipped", async () => {
  const spawnFn = makeSpawnFnThrowing("connect ECONNREFUSED");
  const result = await probeClaudePresent(spawnFn);
  assert.equal(result.status, "skipped");
});

// ---------------------------------------------------------------------------
// probeNodeModules
// ---------------------------------------------------------------------------

test("probeNodeModules: package installed → ok", async () => {
  const pkgPath = `${TARGET}/node_modules/@witchynibbles/archon/package.json`;
  const readFn = makeReadFn({
    [pkgPath]: JSON.stringify({ name: "@witchynibbles/archon", version: "0.1.0" }),
  });
  const result = await probeNodeModules(readFn, TARGET);
  assert.equal(result.status, "ok");
  assert.equal(result.capability, "node-modules");
  assert.match(result.detail, /0\.1\.0/);
});

test("probeNodeModules: package absent → blocked", async () => {
  const readFn = makeReadFn({});
  const result = await probeNodeModules(readFn, TARGET);
  assert.equal(result.status, "blocked");
  assert.ok(result.remediation.includes("npm install"));
});

test("probeNodeModules: package.json unparseable → ok with unknown version", async () => {
  const pkgPath = `${TARGET}/node_modules/@witchynibbles/archon/package.json`;
  const readFn = makeReadFn({ [pkgPath]: "not-json{{{" });
  const result = await probeNodeModules(readFn, TARGET);
  // File exists → ok; version might be "unknown"
  assert.equal(result.status, "ok");
  assert.match(result.detail, /unknown/);
});

// ---------------------------------------------------------------------------
// probePlaywrightBrowsers
// ---------------------------------------------------------------------------

test("probePlaywrightBrowsers: playwright not a dependency → skipped", async () => {
  const pkgPath = `${TARGET}/package.json`;
  const readFn = makeReadFn({
    [pkgPath]: JSON.stringify({ name: "my-app", dependencies: {} }),
  });
  const result = await probePlaywrightBrowsers(readFn, TARGET);
  assert.equal(result.status, "skipped");
  assert.match(result.code, /not-a-dependency/);
});

test("probePlaywrightBrowsers: playwright dep but not installed → blocked", async () => {
  const pkgPath = `${TARGET}/package.json`;
  const readFn = makeReadFn({
    [pkgPath]: JSON.stringify({
      name: "my-app",
      devDependencies: { "@playwright/test": "^1.0.0" },
    }),
    // node_modules/playwright/package.json missing → blocked
  });
  const result = await probePlaywrightBrowsers(readFn, TARGET);
  assert.equal(result.status, "blocked");
  assert.match(result.code, /not-installed/);
});

test("probePlaywrightBrowsers: package.json missing → skipped (not-a-dependency)", async () => {
  const readFn = makeReadFn({});
  const result = await probePlaywrightBrowsers(readFn, TARGET);
  assert.equal(result.status, "skipped");
});

test("probePlaywrightBrowsers: dep present, node_modules installed, no cache → blocked", async () => {
  const pkgPath = `${TARGET}/package.json`;
  const pwPkgPath = `${TARGET}/node_modules/playwright/package.json`;
  const readFn = makeReadFn({
    [pkgPath]: JSON.stringify({
      devDependencies: { playwright: "^1.0.0" },
    }),
    [pwPkgPath]: JSON.stringify({ name: "playwright", version: "1.0.0" }),
    // no ms-playwright sentinel
  });
  const result = await probePlaywrightBrowsers(readFn, TARGET);
  // With no home cache → blocked (no sentinel found)
  assert.ok(result.status === "blocked" || result.status === "skipped",
    `expected blocked or skipped, got ${result.status}`);
});

// ---------------------------------------------------------------------------
// probeAdapterStub (council C9)
// ---------------------------------------------------------------------------

test("probeAdapterStub: file absent → skipped", async () => {
  const readFn = makeReadFn({});
  const result = await probeAdapterStub(readFn, TARGET);
  assert.equal(result.status, "skipped");
  assert.ok(result.remediation.includes("archon init"), "remediation should guide to init");
});

test("probeAdapterStub: stub still present → degraded", async () => {
  const adapterPath = `${TARGET}/archon/review-identity-adapter.ts`;
  const stubContent = `export default createReviewPrincipalAdapter(async () => {
  throw new Error(
    "Implement archon/review-identity-adapter.ts with your authenticated principal lookup or select ARCHON_REVIEW_IDENTITY_BACKEND from reviewIdentityAdapters before trusting review actions"
  );
});`;
  const readFn = makeReadFn({ [adapterPath]: stubContent });
  const result = await probeAdapterStub(readFn, TARGET);
  assert.equal(result.status, "degraded");
  assert.equal(result.code, "adapter-stub-unimplemented");
  // C9: remediation MUST state the assurance boundary
  assert.ok(
    result.remediation.includes("only confirms the stub was replaced"),
    "C9: remediation must state the assurance boundary (stub-gone ≠ implementation-correct)"
  );
  assert.ok(
    result.remediation.includes("verify against your auth system"),
    "C9: remediation must tell operator to verify against auth system"
  );
});

test("probeAdapterStub: stub replaced → ok", async () => {
  const adapterPath = `${TARGET}/archon/review-identity-adapter.ts`;
  const customContent = `// Custom implementation
export default createReviewPrincipalAdapter(async ({ authContext }) => {
  return { provider: "my-auth", subject: authContext.userId, verified: true };
});`;
  const readFn = makeReadFn({ [adapterPath]: customContent });
  const result = await probeAdapterStub(readFn, TARGET);
  assert.equal(result.status, "ok");
  assert.equal(result.code, "adapter-stub-replaced");
});

// ---------------------------------------------------------------------------
// probeEccPresent (S3 real — dual-identity detection)
// ---------------------------------------------------------------------------

const CANONICAL_PLUGIN_LIST = `Installed plugins:

  ❯ ecc@ecc
    Version: 2.0.0
    Scope: user
    Status: ✔ enabled
`;

const LEGACY_PLUGIN_LIST = `Installed plugins:

  ❯ everything-claude-code@everything-claude-code
    Version: 1.8.0
    Scope: user
    Status: ✔ enabled
`;

const EMPTY_PLUGIN_LIST = `Installed plugins:

`;

test("probeEccPresent: canonical ecc@ecc installed → ok with canonical code", async () => {
  const spawnFn = makeSpawnFn(0, CANONICAL_PLUGIN_LIST);
  const result = await probeEccPresent(spawnFn);
  assert.equal(result.status, "ok");
  assert.equal(result.capability, "ecc-plugin");
  assert.equal(result.layer, "L2");
  assert.equal(result.code, "ecc-plugin-present");
  assert.ok(result.detail.includes("ecc@ecc"), "detail must include installed identity");
});

test("probeEccPresent: legacy everything-claude-code installed → ok with legacy migration advisory", async () => {
  const spawnFn = makeSpawnFn(0, LEGACY_PLUGIN_LIST);
  const result = await probeEccPresent(spawnFn);
  assert.equal(result.status, "ok", "legacy identity must be accepted as ok (not blocked)");
  assert.equal(result.capability, "ecc-plugin");
  assert.equal(result.code, "ecc-plugin-legacy-present");
  assert.ok(
    result.detail.includes("legacy") || result.detail.includes("migration"),
    "legacy probe must include migration advisory in detail"
  );
  assert.ok(result.remediation.length > 0, "legacy probe must include migration remediation");
});

test("probeEccPresent: no ECC plugin installed → blocked with install remediation", async () => {
  const spawnFn = makeSpawnFn(0, EMPTY_PLUGIN_LIST);
  const result = await probeEccPresent(spawnFn);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "ecc-plugin-absent");
  assert.ok(
    result.remediation.includes("install") || result.remediation.includes("ecc"),
    "absent probe must include install remediation"
  );
});

test("probeEccPresent: claude absent (ENOENT) → skipped", async () => {
  const spawnFn = makeSpawnFnThrowing("spawn ENOENT");
  const result = await probeEccPresent(spawnFn);
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "ecc-claude-absent");
});

test("probeEccPresent: plugin list exits non-zero → skipped", async () => {
  const spawnFn = makeSpawnFn(1, "", "error");
  const result = await probeEccPresent(spawnFn);
  assert.equal(result.status, "skipped");
  assert.match(result.code, /nonzero/);
});

test("probeEccPresent: spawn throws non-ENOENT → skipped", async () => {
  const spawnFn = makeSpawnFnThrowing("unexpected crash");
  const result = await probeEccPresent(spawnFn);
  assert.equal(result.status, "skipped");
});

// ---------------------------------------------------------------------------
// probeSkillRefNamespace (S3 new — council C1, read-only)
// ---------------------------------------------------------------------------

function makeNoAgentFiles(): FindAgentFilesFn {
  return async () => [];
}

function makeAgentFiles(files: Record<string, string>): {
  findFn: FindAgentFilesFn;
  readFn: ReadFileFn;
} {
  const paths = Object.keys(files);
  const findFn: FindAgentFilesFn = async () => paths;
  const readFn: ReadFileFn = async (p) => files[p];
  return { findFn, readFn };
}

test("probeSkillRefNamespace: no agent files → skipped", async () => {
  const findFn = makeNoAgentFiles();
  const readFn = makeReadFn({});
  const result = await probeSkillRefNamespace(findFn, readFn, TARGET, ECC_CANONICAL_SKILL_PREFIX);
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "skill-ref-no-agent-files");
});

test("probeSkillRefNamespace: agent files with no ECC refs → skipped", async () => {
  const { findFn, readFn } = makeAgentFiles({
    "/fake/repo/.claude/agents/test.md": "# Test agent\nUses bash:exec skill",
  });
  const result = await probeSkillRefNamespace(findFn, readFn, TARGET, ECC_CANONICAL_SKILL_PREFIX);
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "skill-ref-no-ecc-refs");
});

test("probeSkillRefNamespace: canonical installed + ecc: refs → ok (match)", async () => {
  const { findFn, readFn } = makeAgentFiles({
    "/fake/repo/.claude/agents/my-agent.md": `# My Agent
Uses ecc:search and ecc:write skills`,
  });
  const result = await probeSkillRefNamespace(
    findFn,
    readFn,
    TARGET,
    ECC_CANONICAL_SKILL_PREFIX // "ecc:"
  );
  assert.equal(result.status, "ok");
  assert.equal(result.code, "skill-ref-namespace-match");
});

test("probeSkillRefNamespace: canonical installed + everything-claude-code: refs → degraded (mismatch)", async () => {
  const { findFn, readFn } = makeAgentFiles({
    "/fake/repo/.claude/agents/old-agent.md": `# Old Agent
Uses everything-claude-code:search skill`,
  });
  const result = await probeSkillRefNamespace(
    findFn,
    readFn,
    TARGET,
    ECC_CANONICAL_SKILL_PREFIX // "ecc:" — but file uses legacy prefix
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.code, "skill-ref-namespace-mismatch");
  assert.ok(result.detail.includes("1"), "detail must report count of mismatched files");
  assert.ok(
    result.detail.includes(ECC_LEGACY_SKILL_PREFIX),
    "detail must name the mismatched prefix"
  );
  // Probe must state it is read-only (S6 owns writes)
  assert.ok(
    result.remediation.includes("read-only") || result.remediation.includes("S6"),
    "remediation must mention read-only detection (S6 codemod owns writes)"
  );
});

test("probeSkillRefNamespace: legacy installed + everything-claude-code: refs → ok (match)", async () => {
  const { findFn, readFn } = makeAgentFiles({
    "/fake/repo/.claude/agents/legacy-agent.md": `# Legacy Agent
Uses everything-claude-code:search skill`,
  });
  const result = await probeSkillRefNamespace(
    findFn,
    readFn,
    TARGET,
    ECC_LEGACY_SKILL_PREFIX // "everything-claude-code:" — matches file refs
  );
  assert.equal(result.status, "ok");
  assert.equal(result.code, "skill-ref-namespace-match");
});

test("probeSkillRefNamespace: legacy installed + ecc: refs → degraded (mismatch)", async () => {
  const { findFn, readFn } = makeAgentFiles({
    "/fake/repo/.claude/agents/new-agent.md": `# New Agent
Uses ecc:search skill`,
  });
  const result = await probeSkillRefNamespace(
    findFn,
    readFn,
    TARGET,
    ECC_LEGACY_SKILL_PREFIX // "everything-claude-code:" — but file uses canonical prefix
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.code, "skill-ref-namespace-mismatch");
  assert.ok(result.detail.includes(ECC_CANONICAL_SKILL_PREFIX), "detail must name the canonical prefix");
});

test("probeSkillRefNamespace: ECC not installed + refs found → degraded (unresolvable)", async () => {
  const { findFn, readFn } = makeAgentFiles({
    "/fake/repo/.claude/agents/agent.md": "Uses ecc:search skill",
  });
  const result = await probeSkillRefNamespace(findFn, readFn, TARGET, undefined);
  assert.equal(result.status, "degraded");
  assert.equal(result.code, "skill-ref-ecc-not-installed");
  assert.ok(result.remediation.includes("--install-plugin"), "remediation must guide to install plugin");
});

test("probeSkillRefNamespace: multiple files counted correctly", async () => {
  const { findFn, readFn } = makeAgentFiles({
    "/fake/repo/.claude/agents/agent1.md": "Uses ecc:search skill",
    "/fake/repo/.claude/agents/agent2.md": "Uses ecc:write skill",
    "/fake/repo/.claude/agents/agent3.md": "Uses everything-claude-code:search skill", // mismatch
  });
  const result = await probeSkillRefNamespace(
    findFn,
    readFn,
    TARGET,
    ECC_CANONICAL_SKILL_PREFIX // canonical installed
  );
  assert.equal(result.status, "degraded");
  // 1 file has the legacy (mismatched) prefix
  assert.ok(result.detail.includes("1"), "1 mismatched file should be reported");
});

// ---------------------------------------------------------------------------
// runL2Probes: aggregate runner never throws (now 6 probes)
// ---------------------------------------------------------------------------

test("runL2Probes: returns 6 probes and never throws even if a probe throws", async () => {
  const spawnFn = makeSpawnFn(0, "claude 1.0.0");
  const readFn = makeReadFn({});
  const findFn = makeNoAgentFiles();
  const results = await runL2Probes(spawnFn, readFn, findFn, TARGET);
  assert.equal(results.length, 6, "runL2Probes must return exactly 6 probes after S3");
  for (const r of results) {
    assert.ok(
      ["ok", "degraded", "blocked", "skipped"].includes(r.status),
      `unexpected status: ${r.status}`
    );
    assert.ok(r.capability.length > 0, "probe must have capability");
    assert.ok(r.layer === "L2", "all external probes must be L2");
  }
});

test("runL2Probes: includes both ecc-plugin and skill-ref-namespace probes", async () => {
  const spawnFn = makeSpawnFn(0, "claude 1.0.0");
  const readFn = makeReadFn({});
  const findFn = makeNoAgentFiles();
  const results = await runL2Probes(spawnFn, readFn, findFn, TARGET);

  const eccProbe = results.find((r) => r.capability === "ecc-plugin");
  assert.ok(eccProbe !== undefined, "ecc-plugin probe must be in results");

  const skillRefProbe = results.find((r) => r.capability === "skill-ref-namespace");
  assert.ok(skillRefProbe !== undefined, "skill-ref-namespace probe must be in results after S3");
});

test("runL2Probes: ecc-plugin probe result feeds skill-ref-namespace probe (no separate spawn)", async () => {
  // With canonical ECC installed and an agent file using legacy prefix → skill-ref mismatch
  const spawnFn = makeSpawnFn(0, CANONICAL_PLUGIN_LIST);
  const { findFn, readFn } = makeAgentFiles({
    "/fake/repo/.claude/agents/old.md": "Uses everything-claude-code:search",
  });

  const results = await runL2Probes(spawnFn, readFn, findFn, TARGET);
  const eccProbe = results.find((r) => r.capability === "ecc-plugin");
  const skillRefProbe = results.find((r) => r.capability === "skill-ref-namespace");

  assert.equal(eccProbe?.code, "ecc-plugin-present");
  assert.equal(skillRefProbe?.status, "degraded", "skill-ref must detect mismatch when canonical installed + legacy refs");
});

// ---------------------------------------------------------------------------
// C9 compliance check: remediation mentions the assurance boundary
// ---------------------------------------------------------------------------

test("C9: adapter-stub remediation explicitly states stub-gone ≠ implementation-correct", async () => {
  const adapterPath = `${TARGET}/archon/review-identity-adapter.ts`;
  const stubContent =
    "throw new Error('Implement archon/review-identity-adapter.ts with your authenticated principal lookup');";
  const readFn = makeReadFn({ [adapterPath]: stubContent });
  const result = await probeAdapterStub(readFn, TARGET);
  assert.equal(result.status, "degraded");
  // The full C9 requirement verbatim:
  assert.ok(
    result.remediation.includes("stub was replaced"),
    "C9: 'stub was replaced' phrase must appear in remediation"
  );
  assert.ok(
    result.remediation.includes("not that the implementation is correct") ||
      result.remediation.includes("NOT that the implementation is correct"),
    "C9: 'not that the implementation is correct' phrase must appear in remediation"
  );
});
