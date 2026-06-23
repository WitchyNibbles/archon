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

function npxCommand(): string {
  if (typeof process.env.ARCHON_PLAYWRIGHT_NPX_BIN === "string" && process.env.ARCHON_PLAYWRIGHT_NPX_BIN.length > 0) {
    return process.env.ARCHON_PLAYWRIGHT_NPX_BIN;
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
  const args = ["--yes", "playwright@latest", "install"];
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
      "--package=playwright@latest",
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
// that runs `node ./node_modules/archon/src/install/setup-playwright.ts` where
// node_modules/archon is a symlink (npm link / workspaces) passes the symlinked
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
