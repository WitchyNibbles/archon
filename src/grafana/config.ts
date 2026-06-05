import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const grafanaEnvKeys = [
  "ARCHON_GRAFANA_URL",
  "ARCHON_GRAFANA_TOKEN",
  "ARCHON_GRAFANA_USERNAME",
  "ARCHON_GRAFANA_PASSWORD",
  "ARCHON_GRAFANA_ORG_ID",
  "ARCHON_GRAFANA_LOGS_DATASOURCE_UID",
  "ARCHON_GRAFANA_LOKI_TENANT_ID",
  "ARCHON_GRAFANA_TIMEOUT_MS"
] as const;

export interface GrafanaConfig {
  baseUrl: string;
  authMode: "basic" | "token";
  authHeaderValue: string;
  orgId?: string | undefined;
  logsDatasourceUid?: string | undefined;
  lokiTenantId?: string | undefined;
  timeoutMs: number;
}

export interface GrafanaConfigResolution {
  configured: boolean;
  config?: GrafanaConfig | undefined;
  issues: string[];
}

export interface GrafanaRepoSignalResolution {
  configured: boolean;
  hasAnySignal: boolean;
  issues: string[];
  env: GrafanaConfigResolution & { presentKeys: string[] };
  codex: { hasGrafanaMcp: boolean };
  packageJson: { hasManagedScript: boolean };
}

function isSafeDevgodEnvKey(candidate: string): boolean {
  return /^DEVGOD_[A-Z0-9_]+$/.test(candidate);
}

function parseDevgodEnvContent(content: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1] ?? "";
    if (!isSafeDevgodEnvKey(key)) {
      continue;
    }

    const rawValue = (match[2] ?? "").trim();
    if (rawValue.startsWith('"')) {
      const quotedMatch = rawValue.match(/^"((?:\\.|[^"])*)"(?:\s+#.*)?$/);
      if (quotedMatch) {
        parsed[key] = quotedMatch[1]
          ?.replace(/\\\\/g, "\\")
          .replace(/\\"/g, '"')
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\\$/g, "$");
        continue;
      }
    }

    if (rawValue.startsWith("'")) {
      const quotedMatch = rawValue.match(/^'([^']*)'(?:\s+#.*)?$/);
      if (quotedMatch) {
        parsed[key] = quotedMatch[1] ?? "";
        continue;
      }
    }

    parsed[key] = rawValue.replace(/\s+#.*$/, "").trimEnd();
  }

  return parsed;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function loadDevgodEnvFile(cwd = process.cwd()): Promise<void> {
  const envPath = path.join(cwd, ".env.archon");

  try {
    const content = await readFile(envPath, "utf8");
    const parsed = parseDevgodEnvContent(content);

    for (const key of grafanaEnvKeys) {
      const value = parsed[key];
      if (typeof value === "string" && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

export async function detectGrafanaRepoConfig(cwd = process.cwd()): Promise<GrafanaRepoSignalResolution> {
  const envContent = await readFileIfExists(path.join(cwd, ".env.archon"));
  const envVars = envContent ? parseDevgodEnvContent(envContent) : {};
  const presentKeys = grafanaEnvKeys.filter((key) => typeof envVars[key] === "string");
  const envResolution = resolveGrafanaConfig(envVars);

  const codexConfig = await readFileIfExists(path.join(cwd, ".codex", "config.toml"));
  const packageJsonContent = await readFileIfExists(path.join(cwd, "package.json"));

  let hasManagedScript = false;
  if (packageJsonContent) {
    try {
      const packageJson = JSON.parse(packageJsonContent) as {
        scripts?: Record<string, unknown>;
      };
      hasManagedScript = typeof packageJson.scripts?.["archon:grafana:mcp"] === "string";
    } catch {
      hasManagedScript = false;
    }
  }

  const hasGrafanaMcp = codexConfig?.includes("[mcp_servers.grafana]") ?? false;
  const hasAnySignal = presentKeys.length > 0 || hasGrafanaMcp || hasManagedScript;

  return {
    configured: envResolution.configured,
    hasAnySignal,
    issues: envResolution.configured ? [] : hasAnySignal ? envResolution.issues : [],
    env: {
      ...envResolution,
      presentKeys
    },
    codex: {
      hasGrafanaMcp
    },
    packageJson: {
      hasManagedScript
    }
  };
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseTimeout(candidate: string | undefined): number {
  const trimmed = trimEnv(candidate);
  if (!trimmed) {
    return 15_000;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15_000;
  }

  return parsed;
}

export function resolveGrafanaConfig(env: NodeJS.ProcessEnv = process.env): GrafanaConfigResolution {
  const issues: string[] = [];
  const baseUrlValue = trimEnv(env.ARCHON_GRAFANA_URL);

  if (!baseUrlValue) {
    return {
      configured: false,
      issues: ["missing ARCHON_GRAFANA_URL"]
    };
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    return {
      configured: false,
      issues: [`invalid ARCHON_GRAFANA_URL: ${baseUrlValue}`]
    };
  }

  const token = trimEnv(env.ARCHON_GRAFANA_TOKEN);
  const username = trimEnv(env.ARCHON_GRAFANA_USERNAME);
  const password = trimEnv(env.ARCHON_GRAFANA_PASSWORD);

  let authMode: GrafanaConfig["authMode"] | undefined;
  let authHeaderValue: string | undefined;
  if (token) {
    authMode = "token";
    authHeaderValue = `Bearer ${token}`;
  } else if (username && password) {
    authMode = "basic";
    authHeaderValue = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  } else {
    issues.push(
      "set ARCHON_GRAFANA_TOKEN or both ARCHON_GRAFANA_USERNAME and ARCHON_GRAFANA_PASSWORD"
    );
  }

  if (!authMode || !authHeaderValue) {
    return {
      configured: false,
      issues
    };
  }

  return {
    configured: true,
    config: {
      baseUrl: baseUrl.toString().replace(/\/+$/, ""),
      authMode,
      authHeaderValue,
      orgId: trimEnv(env.ARCHON_GRAFANA_ORG_ID),
      logsDatasourceUid: trimEnv(env.ARCHON_GRAFANA_LOGS_DATASOURCE_UID),
      lokiTenantId: trimEnv(env.ARCHON_GRAFANA_LOKI_TENANT_ID),
      timeoutMs: parseTimeout(env.ARCHON_GRAFANA_TIMEOUT_MS)
    },
    issues: []
  };
}

export function requireGrafanaConfig(env: NodeJS.ProcessEnv = process.env): GrafanaConfig {
  const resolution = resolveGrafanaConfig(env);
  if (!resolution.configured || !resolution.config) {
    throw new Error(`Grafana integration is not configured: ${resolution.issues.join("; ")}`);
  }

  return resolution.config;
}
