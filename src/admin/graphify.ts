import { access, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type GraphifyState = "ready" | "stale" | "missing_index" | "unconfigured";

export interface GraphifyStatusObservation {
  authorityLabel: "derived_only";
  state: GraphifyState;
  configured: boolean;
  graphBuilt: boolean;
  reportBuilt: boolean;
  wikiBuilt: boolean;
  indexedAt?: string | undefined;
  recommendedCommand?: string | undefined;
  notes: string[];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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

async function resolveGitHeadPath(repoRoot: string): Promise<string | undefined> {
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
    return headPath;
  }

  const refName = headContents.slice("ref:".length).trim();
  if (!refName) {
    return undefined;
  }

  const refPath = path.join(gitDir, ...refName.split("/"));
  if (await pathExists(refPath)) {
    return refPath;
  }

  const packed = await readPackedRef(gitDir, refName);
  return packed ? headPath : undefined;
}

async function isGraphifyConfigured(cwd: string): Promise<boolean> {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return false;
  }

  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
    const scripts =
      parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
        ? (parsed.scripts as Record<string, unknown>)
        : {};
    return typeof scripts["archon:graphify:build"] === "string";
  } catch {
    return false;
  }
}

export async function inspectGraphifyStatus(options: {
  cwd?: string | undefined;
} = {}): Promise<GraphifyStatusObservation> {
  const cwd = options.cwd ?? process.cwd();
  const graphJsonPath = path.join(cwd, "graphify-out", "graph.json");
  const reportPath = path.join(cwd, "graphify-out", "GRAPH_REPORT.md");
  const wikiPath = path.join(cwd, "graphify-out", "wiki", "index.md");
  const recommendedCommand = "npm run archon:graphify:update";
  const notes: string[] = [];

  const [configured, graphBuilt, reportBuilt, wikiBuilt] = await Promise.all([
    isGraphifyConfigured(cwd),
    pathExists(graphJsonPath),
    pathExists(reportPath),
    pathExists(wikiPath)
  ]);

  if (!configured) {
    notes.push("graphify build script not found in package.json; run archon install to add it");
    return {
      authorityLabel: "derived_only",
      state: "unconfigured",
      configured,
      graphBuilt,
      reportBuilt,
      wikiBuilt,
      recommendedCommand: "npm install && npm run archon:graphify:build",
      notes
    };
  }

  if (!graphBuilt) {
    notes.push("graphify-out/graph.json is absent; run npm run archon:graphify:build to create it");
    return {
      authorityLabel: "derived_only",
      state: "missing_index",
      configured,
      graphBuilt,
      reportBuilt,
      wikiBuilt,
      recommendedCommand: "npm run archon:graphify:build",
      notes
    };
  }

  let graphMtime: Date;
  try {
    const graphStat = await stat(graphJsonPath);
    graphMtime = graphStat.mtime;
  } catch {
    notes.push("could not stat graphify-out/graph.json; freshness is advisory only");
    return {
      authorityLabel: "derived_only",
      state: "ready",
      configured,
      graphBuilt,
      reportBuilt,
      wikiBuilt,
      recommendedCommand,
      notes
    };
  }

  const gitHeadPath = await resolveGitHeadPath(cwd);
  if (gitHeadPath) {
    try {
      const headStat = await stat(gitHeadPath);
      if (graphMtime < headStat.mtime) {
        notes.push("graphify-out/graph.json is behind the latest commit; run npm run archon:graphify:update");
        return {
          authorityLabel: "derived_only",
          state: "stale",
          configured,
          graphBuilt,
          reportBuilt,
          wikiBuilt,
          indexedAt: graphMtime.toISOString(),
          recommendedCommand,
          notes
        };
      }
    } catch {
      notes.push("could not stat git HEAD; freshness is advisory only");
    }
  }

  notes.push("graphify advisory context is ready");
  return {
    authorityLabel: "derived_only",
    state: "ready",
    configured,
    graphBuilt,
    reportBuilt,
    wikiBuilt,
    indexedAt: graphMtime.toISOString(),
    recommendedCommand,
    notes
  };
}
