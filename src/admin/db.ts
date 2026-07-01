import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Client as PgClient } from "pg";
import { scrubPgError } from "./db-error-scrub.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

export async function loadDotEnv(): Promise<void> {
  // When archon runs as a node_module in a consuming project, process.cwd() is the
  // consuming project root. Check there first so project-specific config (vault path,
  // enabled flags, etc.) wins over the bundled fallback env.
  const candidates: string[] = [
    path.join(process.cwd(), ".env.archon"),
    path.join(repoRoot, ".env")
  ];

  for (const envPath of candidates) {
    try {
      const raw = await readFile(envPath, "utf8");
      applyDotEnvText(raw, process.env);
      return;
    } catch {
      // try next candidate
    }
  }
}

function applyDotEnvText(raw: string, env: NodeJS.ProcessEnv): void {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...rest] = trimmed.split("=");
    if (!key || key in env) {
      continue;
    }

    const value = rest.join("=").replace(/^"(.*)"$/, "$1");
    env[key] = value;
  }
}

/**
 * Composes a postgres:// URL from the `ARCHON_POSTGRES_*` docker-compose
 * convenience variables.
 *
 * Returns undefined when any required part (user, password, db) is absent
 * so that the caller can distinguish "not configured via parts" from
 * "configured but produces an empty URL."
 *
 * Precedence contract (enforced by resolveDatabaseUrl):
 *   ARCHON_CORE_DATABASE_URL  (explicit URL — always wins)
 *   ARCHON_POSTGRES_*         (docker-compose convenience — only when explicit URL absent)
 *
 * The composed URL always targets 127.0.0.1 (docker-compose bind address).
 * ARCHON_POSTGRES_PORT defaults to 5533 (the archon docker default port).
 */
export function composeDatabaseUrlFromParts(env: NodeJS.ProcessEnv): string | undefined {
  const user = env.ARCHON_POSTGRES_USER?.trim();
  const password = env.ARCHON_POSTGRES_PASSWORD?.trim();
  const db = env.ARCHON_POSTGRES_DB?.trim();
  const port = env.ARCHON_POSTGRES_PORT?.trim() ?? "5533";

  if (!user || !password || !db) {
    return undefined;
  }

  // Percent-encode each component so special characters in passwords do not
  // corrupt the URL structure.
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  const encodedDb = encodeURIComponent(db);
  return `postgres://${encodedUser}:${encodedPassword}@127.0.0.1:${port}/${encodedDb}`;
}

/**
 * Resolves the database URL to use for a connection.
 *
 * Resolution order (first match wins):
 *   1. ARCHON_CORE_DATABASE_URL — canonical; explicit URL always takes precedence.
 *   2. ARCHON_POSTGRES_* parts  — docker-compose convenience; composed when the
 *      explicit URL is absent and all required parts (user, password, db) are set.
 *
 * Returns undefined when neither source is configured.
 * Does NOT throw — callers decide how to handle the undefined case.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.ARCHON_CORE_DATABASE_URL?.trim();
  if (explicit) {
    return explicit;
  }
  return composeDatabaseUrlFromParts(env);
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = resolveDatabaseUrl(env);
  if (url) {
    return url;
  }
  throw new Error(
    "ARCHON_CORE_DATABASE_URL is required — set it to a pgvector-capable Postgres connection " +
    "string (e.g. postgres://user:pass@host:5432/db). " +
    "When using docker-compose, you may instead set ARCHON_POSTGRES_USER, " +
    "ARCHON_POSTGRES_PASSWORD, ARCHON_POSTGRES_DB, and ARCHON_POSTGRES_PORT " +
    "(defaults to 5533) to have the URL composed automatically."
  );
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
      throw scrubPgError(error);
    }
    client = await createClient(connectionString);
    try {
      await client.connect();
    } catch (retryError) {
      await safeEnd(client);
      throw scrubPgError(retryError);
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
