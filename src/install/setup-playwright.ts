import { access, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

interface CliArgs {
  verifyOnly: boolean;
}

// Canonical archon control-layer root for Playwright assets. The installer
// (src/install/merge.ts) writes the MCP config to `.archon/playwright/`, and
// cli.ts treats `.archon/playwright` as a recursive overlay root, so the setup
// script MUST read/create the same location. Keeping these derivations in one
// place (and exporting them) is what the regression test pins so the
// historical `.devgod`→`.archon` rename can never drift back out of sync.
export const PLAYWRIGHT_CONFIG_DIR = path.join(".archon", "playwright");
export const PLAYWRIGHT_ARTIFACTS_DIR = path.join(".archon", "work", "artifacts", "playwright");

// Pinned Playwright version for the system/MCP browser install. Kept exact (no
// `@latest`) so a fresh install is reproducible and cannot silently pull a new
// or compromised Playwright release. MUST match the web workspace pin
// (web/package.json `@playwright/test`) so the browser binaries the daemon
// installs line up with the version the web-e2e suite runs against. Bump both
// together (and re-verify the browser install) when upgrading.
export const PLAYWRIGHT_VERSION = "1.61.0";

/** The exact `playwright@<version>` spec passed to npx (never `@latest`). */
export function playwrightPackageSpec(): string {
  return `playwright@${PLAYWRIGHT_VERSION}`;
}

/** Relative paths of the required Playwright MCP configs, matching merge.ts. */
export function playwrightConfigRelativePaths(): readonly string[] {
  return [
    path.join(PLAYWRIGHT_CONFIG_DIR, "mcp.json"),
    path.join(PLAYWRIGHT_CONFIG_DIR, "mcp.vision.json")
  ];
}

/** Absolute browsers cache path (PLAYWRIGHT_BROWSERS_PATH) under the repo root. */
export function playwrightBrowsersPath(repoRoot: string): string {
  return path.join(repoRoot, PLAYWRIGHT_CONFIG_DIR, "browsers");
}

function parseArgs(argv: readonly string[]): CliArgs {
  return {
    verifyOnly: argv.includes("--verify")
  };
}

export function buildPlaywrightEnv(repoRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(repoRoot),
    PLAYWRIGHT_SKIP_BROWSER_GC: "1"
  };
}

/**
 * Validate an operator-supplied npx binary override (ARCHON_PLAYWRIGHT_NPX_BIN).
 *
 * This is a trusted local override (it names the executable used to run the
 * Playwright install), but it is passed to `spawn` WITHOUT `shell: true`, so it
 * is never shell-interpreted. We still reject obviously-malformed values —
 * whitespace, newlines, NUL, and shell metacharacters — so a typo or an injected
 * value fails loudly with a clear message instead of spawning something unexpected
 * (or being interpreted as a shell string by a future caller that adds `shell`).
 * Returns the value unchanged when valid; throws a descriptive error otherwise.
 */
export function validateNpxBinOverride(value: string): string {
  const reject = (): never => {
    throw new Error(
      `ARCHON_PLAYWRIGHT_NPX_BIN contains disallowed characters (whitespace, control, or shell metacharacters): ` +
        `${JSON.stringify(value)}. Set it to a plain executable name (e.g. "npx") or a metacharacter-free path.`
    );
  };

  // Reject control characters (C0 range incl. NUL/newlines, and DEL) by code
  // point. Done numerically rather than via a control-character regex range so
  // the source stays free of control chars (and the no-control-regex lint rule).
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      reject();
    }
  }

  // Reject whitespace and shell metacharacters. A legitimate binary name or path
  // (e.g. "npx", "/opt/my-tools/npx", "npx.cmd") uses none of these.
  if (/[\s;&|<>$`"'\\(){}*?!]/.test(value)) {
    reject();
  }

  return value;
}

function npxCommand(): string {
  const override = process.env.ARCHON_PLAYWRIGHT_NPX_BIN;
  if (typeof override === "string" && override.length > 0) {
    return validateNpxBinOverride(override);
  }

  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function spawnCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function ensurePlaywrightArtifactsDirs(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, PLAYWRIGHT_CONFIG_DIR), { recursive: true });
  await mkdir(path.join(repoRoot, PLAYWRIGHT_ARTIFACTS_DIR), { recursive: true });
}

async function ensureConfigExists(repoRoot: string): Promise<void> {
  for (const relativePath of playwrightConfigRelativePaths()) {
    try {
      await access(path.join(repoRoot, relativePath));
    } catch {
      throw new Error(`missing required Playwright MCP config: ${relativePath}`);
    }
  }
}

async function installChromium(repoRoot: string): Promise<void> {
  const env = buildPlaywrightEnv(repoRoot);
  const args = ["--yes", playwrightPackageSpec(), "install"];
  if (process.platform === "linux" && (process.env.CI === "true" || process.env.ARCHON_PLAYWRIGHT_INSTALL_DEPS === "1")) {
    args.push("--with-deps");
  }
  args.push("chromium");

  await spawnCommand(npxCommand(), args, { cwd: repoRoot, env });
}

async function verifyChromiumLaunch(repoRoot: string): Promise<void> {
  const env = buildPlaywrightEnv(repoRoot);
  await spawnCommand(
    npxCommand(),
    [
      "--yes",
      `--package=${playwrightPackageSpec()}`,
      "node",
      "-e",
      [
        "const { chromium } = require('playwright');",
        "(async () => {",
        "  const browser = await chromium.launch({ headless: true });",
        "  const page = await browser.newPage();",
        "  await page.goto('about:blank');",
        "  await browser.close();",
        "})();"
      ].join(" ")
    ],
    { cwd: repoRoot, env }
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();

  await ensureConfigExists(repoRoot);
  await ensurePlaywrightArtifactsDirs(repoRoot);

  if (!args.verifyOnly) {
    await installChromium(repoRoot);
  }

  await verifyChromiumLaunch(repoRoot);
  console.log(args.verifyOnly ? "playwright verified" : "playwright setup complete");
}

// Only run as a CLI entry point — guard so the module can be imported by tests
// (and by tooling) without triggering a real Playwright install.
//
// Compare the invoked script path against this module's path, resolving symlinks
// on BOTH sides. Node canonicalizes symlinks in import.meta.url, but a consumer
// that invokes this file via node (e.g. `node ./node_modules/@witchynibbles/archon/dist/install/setup-playwright.js`)
// where node_modules/@witchynibbles/archon is a symlink (npm link / workspaces) passes the symlinked
// path in argv[1]. Without realpath on both sides the comparison is false and the
// installer's `archon:setup:playwright` script would silently no-op.
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
const invokedPath = typeof process.argv[1] === "string" ? canonical(process.argv[1]) : "";
const isDirectRun = invokedPath !== "" && canonical(fileURLToPath(import.meta.url)) === invokedPath;

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
