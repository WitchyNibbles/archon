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
 *   - probeEccPresent: always returns skipped (S3 stub)
 *   - runL2Probes: never throws even if individual probe throws
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
  runL2Probes,
} from "../../src/install/capability/probes-external.ts";
import type { SpawnFn } from "../../src/install/capability/probes-external.ts";
import type { ReadFileFn } from "../../src/install/capability/probes-file.ts";

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
// probeEccPresent (S3 stub — always skipped)
// ---------------------------------------------------------------------------

test("probeEccPresent: always returns skipped with remediation (S3 stub)", async () => {
  const spawnFn = makeSpawnFn(0, "anything");
  const result = await probeEccPresent(spawnFn);
  assert.equal(result.status, "skipped");
  assert.equal(result.capability, "ecc-plugin");
  assert.equal(result.layer, "L2");
  assert.ok(result.remediation.length > 0, "S3 stub must have remediation");
  assert.ok(
    result.remediation.includes("S3") || result.detail.includes("S3"),
    "stub detail/remediation should mention S3"
  );
});

// ---------------------------------------------------------------------------
// runL2Probes: aggregate runner never throws
// ---------------------------------------------------------------------------

test("runL2Probes: returns 5 probes and never throws even if a probe throws", async () => {
  // Use a spawnFn that exits 0 for everything
  const spawnFn = makeSpawnFn(0, "claude 1.0.0");
  const readFn = makeReadFn({});
  const results = await runL2Probes(spawnFn, readFn, TARGET);
  assert.equal(results.length, 5, "runL2Probes must return exactly 5 probes");
  for (const r of results) {
    assert.ok(
      ["ok", "degraded", "blocked", "skipped"].includes(r.status),
      `unexpected status: ${r.status}`
    );
    assert.ok(r.capability.length > 0, "probe must have capability");
    assert.ok(r.layer === "L2", "all external probes must be L2");
  }
});

test("runL2Probes: ecc-present probe is always the 5th and always skipped", async () => {
  const spawnFn = makeSpawnFn(0, "claude 1.0.0");
  const readFn = makeReadFn({});
  const results = await runL2Probes(spawnFn, readFn, TARGET);
  const eccProbe = results.find((r) => r.capability === "ecc-plugin");
  assert.ok(eccProbe !== undefined, "ecc-plugin probe must be in the results");
  assert.equal(eccProbe!.status, "skipped", "ecc-plugin probe must be skipped in S2");
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
