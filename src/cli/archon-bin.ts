#!/usr/bin/env node
/**
 * archon-bin.ts — Compiled bin entry for the archon package.
 *
 * This file compiles to dist/cli/archon-bin.js and is wired as the `archon`
 * bin in package.json.  It must run WITHOUT --experimental-strip-types.
 *
 * Routing mirrors src/admin/archon.ts but targets compiled .js siblings
 * rather than .ts source files via --experimental-strip-types.
 *
 * Path resolution: this module is at dist/cli/archon-bin.js in the installed
 * package, so:
 *   path.resolve(__dirname, "..")           → dist/
 *   path.resolve(__dirname, "../admin.js")  → dist/admin.js
 *   path.resolve(__dirname, "../install/cli.js") → dist/install/cli.js
 *   path.resolve(__dirname, "../mcp/server.js")  → dist/mcp/server.js
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Compiled sibling paths (relative to dist/cli/)
const adminCliPath = path.resolve(__dirname, "../admin.js");
const installCliPath = path.resolve(__dirname, "../install/cli.js");
const mcpServerPath = path.resolve(__dirname, "../mcp/server.js");

const adminCommands = new Set([
  "migrate",
  "health",
  "doctor",
  "bootstrap-project",
  "verify-setup",
  "verify-live-migrations",
  "refresh-retrieval",
  "refresh-repo-context",
  "repair-task-queue",
  "run-embedding-jobs",
  "verify-review-identity",
  "record-review",
  "status",
  "coverage",
  "gaps",
  "checkpoint",
  "resume",
  "continue-session",
  "workflow-proof",
  "seed-workflow-proof",
  "advance-active-task",
  "reconcile-runtime-state",
  "sync-runtime-exports",
  "daemon",
  "supervisor",
  "supervisor-history",
  "ops",
  "loop",
  "recover",
  "index-repo-markdown",
  "report",
  "plan-context",
  "export-docs",
  "/export-docs",
  "github-dispatch",
  "autonomous-enable",
  "init-task",
  // NOTE: "mcp" is intentionally absent — it is handled by the dedicated
  // `command === "mcp"` branch above the adminCommands lookup, so including
  // it here would create an unreachable dead branch.
]);

const installCommands = new Set([
  "init",
  "upgrade",
  "verify",
  "scaffold-workflow",
  "upgrade-reasoning-workflow",
  "seed-happy-path-fixture",
]);

function printUsage(): void {
  process.stdout.write(
    [
      "archon",
      "",
      "Implicit workflow controller by default.",
      "",
      "Usage:",
      "  archon <runtime-command> [args]",
      "  archon <install-command> [args]",
      "",
      "Runtime commands:",
      "  status | coverage | gaps | checkpoint | resume | workflow-proof",
      "  migrate | health | doctor [--repair] | bootstrap-project | verify-setup",
      "  daemon | supervisor | ops | loop | recover | report | plan-context",
      "  verify-review-identity | record-review | index-repo-markdown",
      "  mcp | autonomous-enable | github-dispatch | export-docs",
      "",
      "Install commands:",
      "  init | upgrade | verify | scaffold-workflow | upgrade-reasoning-workflow",
      ""
    ].join("\n")
  );
}

function resolveRealPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const scriptPath = installCommands.has(command)
    ? installCliPath
    : command === "mcp"
      ? mcpServerPath
      : adminCommands.has(command)
        ? adminCliPath
        : undefined;

  if (!scriptPath) {
    throw new Error(`Unknown archon command: ${command}`);
  }

  // Load .env.archon for runtime commands if the file exists in the cwd.
  const nodeArgs: string[] = [];
  if (
    scriptPath !== installCliPath &&
    existsSync(path.resolve(process.cwd(), ".env.archon"))
  ) {
    nodeArgs.push("--env-file=.env.archon");
  }

  // No --experimental-strip-types — these are compiled .js files.
  if (scriptPath === mcpServerPath) {
    nodeArgs.push(scriptPath, ...rest);
  } else {
    nodeArgs.push(scriptPath, command, ...rest);
  }

  const result = spawnSync(process.execPath, nodeArgs, {
    stdio: "inherit",
    env: process.env,
  });

  if (typeof result.status === "number") {
    process.exitCode = result.status;
    return;
  }

  process.exitCode = 1;
}

const entryPath = process.argv[1] ? resolveRealPath(process.argv[1]) : "";
const modulePath = resolveRealPath(fileURLToPath(import.meta.url));

if (
  process.env.ARCHON_FORCE_CLI_ENTRYPOINT === pathToFileURL(modulePath).href ||
  entryPath === modulePath
) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
