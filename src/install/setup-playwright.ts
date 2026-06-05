import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

interface CliArgs {
  verifyOnly: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  return {
    verifyOnly: argv.includes("--verify")
  };
}

function buildPlaywrightEnv(repoRoot: string): NodeJS.ProcessEnv {
  const browsersPath = path.join(repoRoot, ".devgod", "playwright", "browsers");
  return {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
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
  await mkdir(path.join(repoRoot, ".devgod", "playwright"), { recursive: true });
  await mkdir(path.join(repoRoot, ".devgod", "work", "artifacts", "playwright"), { recursive: true });
}

async function ensureConfigExists(repoRoot: string): Promise<void> {
  for (const relativePath of [
    path.join(".devgod", "playwright", "mcp.json"),
    path.join(".devgod", "playwright", "mcp.vision.json")
  ]) {
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
