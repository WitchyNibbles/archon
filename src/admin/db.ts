import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Client as PgClient } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

export async function loadDotEnv(): Promise<void> {
  const envPath = path.join(repoRoot, ".env");

  try {
    const raw = await readFile(envPath, "utf8");
    applyDotEnvText(raw, process.env);
  } catch {
    // .env is optional as long as the environment variables were provided another way.
  }
}

function applyDotEnvText(raw: string, env: NodeJS.ProcessEnv): void {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...rest] = trimmed.split("=");
    if (!key || env[key]) {
      continue;
    }

    const value = rest.join("=").replace(/^"(.*)"$/, "$1");
    env[key] = value;
  }
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = env.ARCHON_CORE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("ARCHON_CORE_DATABASE_URL is required");
  }
  return databaseUrl;
}

interface ConnectableClient {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
}

interface WithClientUsingOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  createClient?: ((connectionString: string) => Promise<ConnectableClient> | ConnectableClient) | undefined;
  startRepoLocalPostgres?: ((input: {
    connectionString: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    error: unknown;
  }) => Promise<boolean>) | undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function isConnectionRefusedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message);
}

function resolveLoopbackDatabaseTarget(connectionString: string): { host: string; port: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return undefined;
  }

  if (!/^postgres(ql)?:$/i.test(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
    return undefined;
  }

  return {
    host: parsed.hostname,
    port: parsed.port || "5432"
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseLeadingCommand(commandLine: string): string | undefined {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const quoted = trimmed.match(/^"([^"]+)"/);
  if (quoted) {
    return quoted[1];
  }

  return trimmed.split(/\s+/, 1)[0];
}

export const dbInternals = {
  applyDotEnvText,
  isConnectionRefusedError,
  resolveLoopbackDatabaseTarget,
  parseLeadingCommand
} as const;

async function resolveRepoLocalPgCtlPath(repoRoot: string, postmasterOptionsPath: string): Promise<string | undefined> {
  try {
    const options = await readFile(postmasterOptionsPath, "utf8");
    const postgresBinary = parseLeadingCommand(options);
    if (postgresBinary) {
      const siblingPgCtl = path.join(path.dirname(postgresBinary), "pg_ctl");
      if (await isExecutable(siblingPgCtl)) {
        return siblingPgCtl;
      }
    }
  } catch {
    // Fall back to the packaged local runtime path.
  }

  const packagedPgCtl = path.join(repoRoot, ".devgod", "cache", "local-pg-build", "runtime", "bin", "pg_ctl");
  if (await isExecutable(packagedPgCtl)) {
    return packagedPgCtl;
  }

  return undefined;
}

async function runSpawnedCommand(command: string, args: readonly string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "ignore"
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function startRepoLocalPostgresForConnection(input: {
  connectionString: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  error: unknown;
}): Promise<boolean> {
  if (!isConnectionRefusedError(input.error)) {
    return false;
  }

  const target = resolveLoopbackDatabaseTarget(input.connectionString);
  if (!target) {
    return false;
  }

  const stateRoot = path.join(input.cwd, ".devgod", "state", "local-postgres");
  const dataDir = path.join(stateRoot, "data");
  const socketDir = path.join(stateRoot, "socket");
  const postmasterOptionsPath = path.join(dataDir, "postmaster.opts");
  const logPath = path.join(stateRoot, "postgres.log");

  if (!(await pathExists(dataDir))) {
    return false;
  }

  const pgCtlPath = await resolveRepoLocalPgCtlPath(input.cwd, postmasterOptionsPath);
  if (!pgCtlPath) {
    return false;
  }

  await mkdir(socketDir, { recursive: true });
  await runSpawnedCommand(
    pgCtlPath,
    [
      "-D",
      dataDir,
      "-l",
      logPath,
      "-o",
      `-p ${target.port} -k ${socketDir} -h ${target.host}`,
      "start"
    ],
    {
      cwd: input.cwd,
      env: input.env
    }
  );
  return true;
}

async function safeEnd(client: ConnectableClient): Promise<void> {
  try {
    await client.end();
  } catch {
    // Ignore cleanup failures so the original connection error remains visible.
  }
}

export async function withClientUsing<T>(
  callback: (client: PgClient) => Promise<T>,
  options: WithClientUsingOptions = {}
): Promise<T> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const connectionString = requireDatabaseUrl(env);
  const createClient =
    options.createClient ??
    (async (resolvedConnectionString: string) => {
      const { Client } = await import("pg");
      return new Client({
        connectionString: resolvedConnectionString
      });
    });
  const startRepoLocalPostgres = options.startRepoLocalPostgres ?? startRepoLocalPostgresForConnection;

  let client = await createClient(connectionString);
  try {
    await client.connect();
  } catch (error) {
    await safeEnd(client);
    const started = await startRepoLocalPostgres({
      connectionString,
      cwd,
      env,
      error
    });
    if (!started) {
      throw error;
    }
    client = await createClient(connectionString);
    try {
      await client.connect();
    } catch (retryError) {
      await safeEnd(client);
      throw retryError;
    }
  }

  try {
    return await callback(client as PgClient);
  } finally {
    await safeEnd(client);
  }
}

export async function withClient<T>(callback: (client: PgClient) => Promise<T>): Promise<T> {
  return withClientUsing(callback, {
    cwd: process.cwd(),
    env: process.env
  });
}
