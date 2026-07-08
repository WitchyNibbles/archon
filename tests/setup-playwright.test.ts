/**
 * Regression suite for the Playwright setup path contract.
 *
 * Historical bug: `setup-playwright.ts` read/created `.devgod/playwright/...`
 * while the installer (`merge.ts`) writes the MCP config to `.archon/playwright/...`.
 * A clean checkout therefore threw "missing required Playwright MCP config"
 * before install could run. These tests pin the two modules together so the
 * `.devgod`→`.archon` rename can never silently drift apart again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  PLAYWRIGHT_CONFIG_DIR,
  PLAYWRIGHT_ARTIFACTS_DIR,
  PLAYWRIGHT_VERSION,
  playwrightConfigRelativePaths,
  playwrightBrowsersPath,
  playwrightPackageSpec,
  validateNpxBinOverride,
  buildPlaywrightEnv
} from "../src/install/setup-playwright.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwrightMcpConfigFragment } from "../src/install/merge.ts";

test("setup-playwright derives paths under .archon, never .devgod", () => {
  const derived = [
    PLAYWRIGHT_CONFIG_DIR,
    PLAYWRIGHT_ARTIFACTS_DIR,
    ...playwrightConfigRelativePaths(),
    playwrightBrowsersPath("/repo")
  ];
  for (const p of derived) {
    assert.ok(!p.includes(".devgod"), `path ${p} still references the legacy .devgod root`);
  }
  assert.equal(PLAYWRIGHT_CONFIG_DIR, path.join(".archon", "playwright"));
  assert.equal(PLAYWRIGHT_ARTIFACTS_DIR, path.join(".archon", "work", "artifacts", "playwright"));
});

test("config-existence check matches the installer's MCP config write location", () => {
  // The installer fragment is the source of truth for WHERE the config lands.
  // setup-playwright must check for exactly those paths, or fresh-clone setup
  // throws before install. Cross-module assertion = the real regression guard.
  // playwrightMcpConfigFragment() returns a JSON string; parse it and assert on
  // the actual MCP server args (robust, not substring-on-stringified-JSON).
  const parsed = JSON.parse(playwrightMcpConfigFragment());
  const standardArgs: string = JSON.stringify(parsed.mcpServers?.playwright?.args ?? []);
  const visionArgs: string = JSON.stringify(parsed.mcpServers?.playwright_vision?.args ?? []);

  const [standard, vision] = playwrightConfigRelativePaths();
  // The fragment stores forward slashes; normalize the derived paths to match.
  const toPosix = (p: string) => p.split(path.sep).join("/");
  assert.ok(
    standardArgs.includes(toPosix(standard)),
    `installer playwright config args do not reference setup-playwright's standard config path ${standard}`
  );
  assert.ok(
    visionArgs.includes(toPosix(vision)),
    `installer playwright_vision config args do not reference setup-playwright's vision config path ${vision}`
  );
});

test("playwrightConfigRelativePaths returns standard + vision MCP configs", () => {
  assert.deepEqual(playwrightConfigRelativePaths(), [
    path.join(".archon", "playwright", "mcp.json"),
    path.join(".archon", "playwright", "mcp.vision.json")
  ]);
});

test("buildPlaywrightEnv points the browsers cache under .archon/playwright/browsers", () => {
  const env = buildPlaywrightEnv("/repo/root");
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.join("/repo/root", ".archon", "playwright", "browsers"));
  assert.equal(env.PLAYWRIGHT_SKIP_BROWSER_GC, "1");
});

test("importing the module does not execute the CLI main() (import.meta.url guard)", () => {
  // If the import-time guard regressed, importing setup-playwright.ts at the top
  // of this file would have attempted a real `npx playwright install` and the
  // suite would hang or fail in CI. Reaching this assertion proves the guard
  // kept the module side-effect-free on import.
  assert.ok(typeof buildPlaywrightEnv === "function");
});

test("Playwright version is pinned exact (never @latest)", () => {
  // Exact pin — reproducible, supply-chain-safe. This is now the sole
  // Playwright pin in the repo: the former Forge web/ dashboard test harness
  // carried its own `@playwright/test` devDependency that had to be kept in
  // sync with PLAYWRIGHT_VERSION; it was removed alongside that harness.
  assert.match(PLAYWRIGHT_VERSION, /^\d+\.\d+\.\d+$/, "PLAYWRIGHT_VERSION must be an exact version");
  assert.equal(playwrightPackageSpec(), `playwright@${PLAYWRIGHT_VERSION}`);
  assert.ok(!playwrightPackageSpec().includes("@latest"), "must never use @latest");
});

test("the installer source contains no unpinned playwright@latest reference", () => {
  // Belt-and-suspenders: scan the module source so a future edit reintroducing
  // `playwright@latest` fails loudly here.
  const srcPath = fileURLToPath(new URL("../src/install/setup-playwright.ts", import.meta.url));
  const src = readFileSync(srcPath, "utf8");
  assert.ok(!src.includes("playwright@latest"), "setup-playwright.ts must not reference playwright@latest");
});

test("validateNpxBinOverride accepts plain binary names and metacharacter-free paths", () => {
  for (const ok of ["npx", "npx.cmd", "/usr/bin/npx", "/opt/my-tools/npx", "C:/tools/npx.cmd"]) {
    assert.equal(validateNpxBinOverride(ok), ok, `should accept ${ok}`);
  }
});

test("validateNpxBinOverride rejects whitespace, control, and shell-metacharacter values", () => {
  const bad = [
    "npx;evil",
    "npx|cat",
    "npx $(whoami)",
    "bad name",
    "npx\nrm",
    "npx&background",
    "npx>out",
    "npx<in",
    "a'b",
    'a"b'
  ];
  for (const value of bad) {
    assert.throws(
      () => validateNpxBinOverride(value),
      /ARCHON_PLAYWRIGHT_NPX_BIN contains disallowed characters/,
      `should reject ${JSON.stringify(value)}`
    );
  }
});
