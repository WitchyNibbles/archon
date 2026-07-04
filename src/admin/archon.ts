import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  // init-task is dispatched by src/admin.ts; wiring it here makes the operator-
  // facing `archon init-task …` route (and the hook's unblock hint) actually work.
  "init-task",
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
  "mcp",
  "autonomous-enable"
]);

const installCommands = new Set([
  "init",
  "upgrade",
  "verify",
  "scaffold-workflow",
  "upgrade-reasoning-workflow",
  "seed-happy-path-fixture"
]);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../..");
const adminCliPath = path.join(repoRoot, "src/admin.ts");
const installCliPath = path.join(repoRoot, "src/install/cli.ts");
const mcpServerPath = path.join(repoRoot, "src/mcp/server.ts");

function resolveRealPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "archon",
      "",
      "Implicit workflow controller by default. Use this command unless the user explicitly opts into another tool or mode.",
      "",
      "Usage:",
      "  archon <runtime-command> [args]",
      "  archon <install-command> [args]",
      "",
      "Runtime commands:",
      "  status | coverage | gaps | checkpoint | resume | workflow-proof | seed-workflow-proof | advance-active-task | reconcile-runtime-state | sync-runtime-exports | daemon | supervisor | supervisor-history | ops | loop | recover | report | plan-context | export-docs | github-dispatch",
      "  migrate | health | doctor [--repair] | bootstrap-project | verify-setup | verify-live-migrations",
      "  verify-review-identity | record-review | index-repo-markdown | refresh-retrieval | refresh-repo-context | repair-task-queue | run-embedding-jobs",
      "  init-task --id <id> --title \"<title>\" --scope <comma,paths> [--update-scope]",
      "  autonomous-enable [--run-id <id>] [--profile <p>] [--phase <p>] [--disable]",
      "  mcp",
      "",
      "Install commands:",
      "  init | upgrade | verify | scaffold-workflow | upgrade-reasoning-workflow | seed-happy-path-fixture",
      ""
    ].join("\n")
  );
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

  const nodeArgs: string[] = [];
  if (
    (scriptPath === adminCliPath || scriptPath === mcpServerPath) &&
    existsSync(path.resolve(process.cwd(), ".env.archon"))
  ) {
    nodeArgs.push("--env-file=.env.archon");
  }
  if (scriptPath === mcpServerPath) {
    nodeArgs.push("--experimental-strip-types", scriptPath, ...rest);
  } else {
    nodeArgs.push("--experimental-strip-types", scriptPath, command, ...rest);
  }

  const result = spawnSync(process.execPath, nodeArgs, {
    stdio: "inherit",
    env: process.env
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
    console.error(message);
    process.exitCode = 1;
  }
}
