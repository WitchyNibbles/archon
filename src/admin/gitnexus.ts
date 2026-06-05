import { access, lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


type GitNexusConfigScope = "project" | "user";
export type GitNexusState =
  | "ready"
  | "stale"
  | "missing_index"
  | "invalid_metadata"
  | "head_unavailable"
  | "unconfigured";

export interface GitNexusStatusObservation {
  authorityLabel: "derived_only";
  state: GitNexusState;
  configured: boolean;
  configuredScopes: GitNexusConfigScope[];
  configPaths: string[];
  repoIndexed: boolean;
  indexRoot: string;
  metaPath: string;
  indexedAt?: string | undefined;
  indexedCommit?: string | undefined;
  headCommit?: string | undefined;
  recommendedCommand?: string | undefined;
  notes: string[];
}

interface GitNexusMeta {
  indexedAt: string;
  lastCommit: string;
}

function normalizeConfigPath(scope: GitNexusConfigScope, cwd: string, homeDirectory: string): string {
  if (scope === "project") {
    return path.resolve(cwd, ".claude/settings.json");
  }

  return path.join(homeDirectory, ".claude", "settings.json");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasGitNexusMcpConfig(configPath: string): Promise<boolean> {
  if (!(await pathExists(configPath))) {
    return false;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const mcpServers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : undefined;

  return Boolean(mcpServers?.gitnexus);
}

async function inspectGitNexusConfig(cwd: string, homeDirectory: string): Promise<{
  configuredScopes: GitNexusConfigScope[];
  configPaths: string[];
  notes: string[];
}> {
  const configuredScopes: GitNexusConfigScope[] = [];
  const configPaths: string[] = [];
  const notes: string[] = [];

  for (const scope of ["project", "user"] as const) {
    const configPath = normalizeConfigPath(scope, cwd, homeDirectory);
    try {
      if (await hasGitNexusMcpConfig(configPath)) {
        configuredScopes.push(scope);
        configPaths.push(configPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`${scope} Codex config could not be parsed: ${message}`);
    }
  }

  return {
    configuredScopes,
    configPaths,
    notes
  };
}

async function resolveGitDirectory(repoRoot: string): Promise<string | undefined> {
  const dotGitPath = path.join(repoRoot, ".git");
  if (!(await pathExists(dotGitPath))) {
    return undefined;
  }

  const fileStat = await lstat(dotGitPath);
  if (fileStat.isDirectory()) {
    return dotGitPath;
  }

  if (!fileStat.isFile()) {
    return undefined;
  }

  const contents = (await readFile(dotGitPath, "utf8")).trim();
  const match = /^gitdir:\s*(.+)$/i.exec(contents);
  if (!match) {
    return undefined;
  }

  const gitDir = match[1]!.trim();
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(repoRoot, gitDir);
}

async function readPackedRef(gitDir: string, refName: string): Promise<string | undefined> {
  const packedRefsPath = path.join(gitDir, "packed-refs");
  if (!(await pathExists(packedRefsPath))) {
    return undefined;
  }

  const lines = (await readFile(packedRefsPath, "utf8")).split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#") || line.startsWith("^")) {
      continue;
    }

    const [commit, ref] = line.trim().split(/\s+/, 2);
    if (ref === refName && commit) {
      return commit.trim();
    }
  }

  return undefined;
}

async function readGitHeadCommit(repoRoot: string): Promise<string | undefined> {
  const gitDir = await resolveGitDirectory(repoRoot);
  if (!gitDir) {
    return undefined;
  }

  const headPath = path.join(gitDir, "HEAD");
  if (!(await pathExists(headPath))) {
    return undefined;
  }

  const headContents = (await readFile(headPath, "utf8")).trim();
  if (!headContents) {
    return undefined;
  }

  if (!headContents.startsWith("ref:")) {
    return headContents;
  }

  const refName = headContents.slice("ref:".length).trim();
  if (!refName) {
    return undefined;
  }

  const refPath = path.join(gitDir, ...refName.split("/"));
  if (await pathExists(refPath)) {
    return (await readFile(refPath, "utf8")).trim();
  }

  return readPackedRef(gitDir, refName);
}

async function readGitNexusMeta(metaPath: string): Promise<GitNexusMeta | undefined> {
  if (!(await pathExists(metaPath))) {
    return undefined;
  }

  const parsed = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  const indexedAt = typeof parsed.indexedAt === "string" ? parsed.indexedAt.trim() : "";
  const lastCommit = typeof parsed.lastCommit === "string" ? parsed.lastCommit.trim() : "";

  if (!indexedAt || !lastCommit) {
    throw new Error("meta.json must include indexedAt and lastCommit");
  }

  return {
    indexedAt,
    lastCommit
  };
}

export async function inspectGitNexusStatus(options: {
  cwd?: string | undefined;
  homeDirectory?: string | undefined;
} = {}): Promise<GitNexusStatusObservation> {
  const cwd = options.cwd ?? process.cwd();
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const indexRoot = path.resolve(cwd, ".gitnexus");
  const metaPath = path.join(indexRoot, "meta.json");
  const config = await inspectGitNexusConfig(cwd, homeDirectory);
  const configured = config.configuredScopes.length > 0;
  const notes = [...config.notes];
  const recommendedCommand = "npx gitnexus analyze --skip-agents-md";

  let meta: GitNexusMeta | undefined;
  try {
    meta = await readGitNexusMeta(metaPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`gitnexus meta is invalid: ${message}`);
    return {
      authorityLabel: "derived_only",
      state: "invalid_metadata",
      configured,
      configuredScopes: config.configuredScopes,
      configPaths: config.configPaths,
      repoIndexed: true,
      indexRoot,
      metaPath,
      recommendedCommand,
      notes
    };
  }

  if (!meta) {
    if (configured) {
      notes.push("gitnexus MCP is configured but this repo has not been indexed yet");
      notes.push(`run ${recommendedCommand} from the repo root`);
      return {
        authorityLabel: "derived_only",
        state: "missing_index",
        configured,
        configuredScopes: config.configuredScopes,
        configPaths: config.configPaths,
        repoIndexed: false,
        indexRoot,
        metaPath,
        recommendedCommand,
        notes
      };
    }

    notes.push("gitnexus MCP config was not detected in project or user Codex config");
    return {
      authorityLabel: "derived_only",
      state: "unconfigured",
      configured,
      configuredScopes: config.configuredScopes,
      configPaths: config.configPaths,
      repoIndexed: false,
      indexRoot,
      metaPath,
      recommendedCommand,
      notes
    };
  }

  const headCommit = await readGitHeadCommit(cwd);
  if (!headCommit) {
    notes.push("current git HEAD could not be resolved; gitnexus freshness is advisory only");
    if (!configured) {
      notes.push("gitnexus index exists but no GitNexus MCP config was detected");
    }
    return {
      authorityLabel: "derived_only",
      state: "head_unavailable",
      configured,
      configuredScopes: config.configuredScopes,
      configPaths: config.configPaths,
      repoIndexed: true,
      indexRoot,
      metaPath,
      indexedAt: meta.indexedAt,
      indexedCommit: meta.lastCommit,
      recommendedCommand,
      notes
    };
  }

  if (meta.lastCommit !== headCommit) {
    notes.push("gitnexus index is behind the current git HEAD");
    notes.push(`run ${recommendedCommand} to refresh advisory evidence`);
    if (!configured) {
      notes.push("gitnexus index exists but no GitNexus MCP config was detected");
    }
    return {
      authorityLabel: "derived_only",
      state: "stale",
      configured,
      configuredScopes: config.configuredScopes,
      configPaths: config.configPaths,
      repoIndexed: true,
      indexRoot,
      metaPath,
      indexedAt: meta.indexedAt,
      indexedCommit: meta.lastCommit,
      headCommit,
      recommendedCommand,
      notes
    };
  }

  if (!configured) {
    notes.push("gitnexus index is current, but no GitNexus MCP config was detected");
  } else {
    notes.push("gitnexus advisory context is ready");
  }

  return {
    authorityLabel: "derived_only",
    state: "ready",
    configured,
    configuredScopes: config.configuredScopes,
    configPaths: config.configPaths,
    repoIndexed: true,
    indexRoot,
    metaPath,
    indexedAt: meta.indexedAt,
    indexedCommit: meta.lastCommit,
    headCommit,
    recommendedCommand,
    notes
  };
}
