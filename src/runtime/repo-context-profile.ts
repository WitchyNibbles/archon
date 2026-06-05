import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RuntimeProjectRegistrationRecord } from "../domain/types.ts";
import type { ArchonStore as ArchonStoreContract } from "../store/types.ts";

const EXCLUDED_SEGMENTS = new Set([".git", ".venv", "node_modules", "dist", "build", "coverage", "__pycache__"]);
const VIRTUALENV_CANDIDATES = [".venv", "venv", "env"] as const;
const MAX_PYTHON_FILES = 200;

export interface RepoContextProfileSlotRecord {
  slotKey: string;
  title: string;
  value: string;
  sourceKind: "derived_file" | "derived_manifest";
  sourceRefs: string[];
  capturedAt: string;
  lastValidatedAt: string;
  staleAfterDays: number;
  confidence: "high" | "medium";
}

export interface RepoContextProfileRecord {
  status: "ready" | "degraded";
  repoRoot: string;
  fingerprint: string;
  refreshedAt: string;
  slots: Record<string, RepoContextProfileSlotRecord>;
}

export interface RepoContextFreshnessItem {
  slotKey: string;
  title: string;
  value: string;
  sourceKind: RepoContextProfileSlotRecord["sourceKind"];
  freshness: "fresh" | "stale";
}

export interface RepoContextFreshnessState {
  authorityLabel: "derived_only";
  state: "fresh" | "stale" | "missing" | "degraded";
  summary: string;
  items: RepoContextFreshnessItem[];
}

type RepoContextFreshnessStore = Pick<
  ArchonStoreContract,
  "getProjectContext" | "getProjectRuntimeRegistration"
>;

export async function probeRepoContextProfile(input: {
  repoRoot: string;
  now?: string | undefined;
}): Promise<RepoContextProfileRecord> {
  const repoRoot = await realpath(input.repoRoot);
  const refreshedAt = input.now ?? new Date().toISOString();
  const slots: Record<string, RepoContextProfileSlotRecord> = {};

  const virtualenvPath = await findVirtualenvPath(repoRoot);
  if (virtualenvPath) {
    slots["python.virtualenvPath"] = buildSlot({
      slotKey: "python.virtualenvPath",
      title: "Python virtualenv path",
      value: virtualenvPath,
      sourceKind: "derived_file",
      sourceRefs: [path.posix.join(virtualenvPath, "pyvenv.cfg")],
      capturedAt: refreshedAt,
      confidence: "high"
    });
  }

  const managePyPath = await findManagePyPath(repoRoot);
  if (managePyPath) {
    slots["django.managePyPath"] = buildSlot({
      slotKey: "django.managePyPath",
      title: "Django manage.py path",
      value: managePyPath,
      sourceKind: "derived_file",
      sourceRefs: [managePyPath],
      capturedAt: refreshedAt,
      confidence: "high"
    });
  }

  const djangoDbSelector = await findDjangoDbSelector(repoRoot);
  if (djangoDbSelector) {
    slots["django.dbEnvSelectorVariable"] = buildSlot({
      slotKey: "django.dbEnvSelectorVariable",
      title: "Django DB selector",
      value: djangoDbSelector.variable,
      sourceKind: "derived_file",
      sourceRefs: [djangoDbSelector.relativePath],
      capturedAt: refreshedAt,
      confidence: djangoDbSelector.confidence
    });
  }

  const packageScripts = await readPackageScripts(repoRoot);
  for (const [slotKey, title, scriptName] of [
    ["commands.test", "Test command", "test"],
    ["commands.lint", "Lint command", "lint"],
    ["commands.typecheck", "Typecheck command", "typecheck"]
  ] as const) {
    const value = packageScripts?.[scriptName];
    if (!value) {
      continue;
    }

    slots[slotKey] = buildSlot({
      slotKey,
      title,
      value,
      sourceKind: "derived_manifest",
      sourceRefs: ["package.json"],
      capturedAt: refreshedAt,
      confidence: "high"
    });
  }

  return {
    status: Object.keys(slots).length > 0 ? "ready" : "degraded",
    repoRoot,
    fingerprint: buildProfileFingerprint(slots),
    refreshedAt,
    slots
  };
}

export function readRepoContextProfile(
  registration: RuntimeProjectRegistrationRecord
): RepoContextProfileRecord | undefined {
  const candidate = registration.manifest.repoContextProfile;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  return candidate as RepoContextProfileRecord;
}

export async function inspectRepoContextFreshness(input: {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  store: RepoContextFreshnessStore;
  now?: (() => Date) | undefined;
}): Promise<RepoContextFreshnessState> {
  const env = input.env ?? process.env;
  const workspaceSlug = env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = env.ARCHON_PROJECT_SLUG;
  if (!workspaceSlug || !projectSlug) {
    return {
      authorityLabel: "derived_only",
      state: "degraded",
      summary: "workspace/project context is missing for repo context freshness",
      items: []
    };
  }

  const context = await input.store.getProjectContext({ workspaceSlug, projectSlug });
  if (!context) {
    return {
      authorityLabel: "derived_only",
      state: "degraded",
      summary: `project ${workspaceSlug}/${projectSlug} is not bootstrapped for repo context freshness`,
      items: []
    };
  }

  const registration = await input.store.getProjectRuntimeRegistration(context.project.id);
  if (!registration) {
    return {
      authorityLabel: "derived_only",
      state: "missing",
      summary: "runtime registration is missing repo context metadata",
      items: []
    };
  }

  const profile = readRepoContextProfile(registration);
  if (!profile) {
    return {
      authorityLabel: "derived_only",
      state: "missing",
      summary: "repo context profile has not been captured yet",
      items: []
    };
  }

  const repoRoot = path.resolve(registration.repoPath || input.cwd || process.cwd());

  try {
    const currentProfile = await probeRepoContextProfile({
      repoRoot,
      now: (input.now ?? (() => new Date()))().toISOString()
    });
    const state = profile.fingerprint === currentProfile.fingerprint ? "fresh" : "stale";

    return {
      authorityLabel: "derived_only",
      state,
      summary:
        state === "fresh"
          ? "repo context profile matches the current repo snapshot"
          : "repo context profile no longer matches the current repo snapshot",
      items: listRepoContextFreshnessItems(profile, state)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      authorityLabel: "derived_only",
      state: "degraded",
      summary: `repo context freshness check failed: ${message}`,
      items: listRepoContextFreshnessItems(profile, "stale")
    };
  }
}

function buildSlot(input: {
  slotKey: string;
  title: string;
  value: string;
  sourceKind: RepoContextProfileSlotRecord["sourceKind"];
  sourceRefs: string[];
  capturedAt: string;
  confidence: RepoContextProfileSlotRecord["confidence"];
}): RepoContextProfileSlotRecord {
  return {
    slotKey: input.slotKey,
    title: input.title,
    value: input.value,
    sourceKind: input.sourceKind,
    sourceRefs: [...input.sourceRefs],
    capturedAt: input.capturedAt,
    lastValidatedAt: input.capturedAt,
    staleAfterDays: 30,
    confidence: input.confidence
  };
}

function buildProfileFingerprint(slots: Record<string, RepoContextProfileSlotRecord>): string {
  const fingerprintSource = Object.entries(slots)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slotKey, slot]) => ({
      slotKey,
      value: slot.value,
      sourceRefs: [...slot.sourceRefs].sort()
    }));

  return createHash("sha256").update(JSON.stringify(fingerprintSource)).digest("hex");
}

function listRepoContextFreshnessItems(
  profile: RepoContextProfileRecord,
  freshness: RepoContextFreshnessItem["freshness"]
): RepoContextFreshnessItem[] {
  return Object.values(profile.slots)
    .sort((left, right) => left.slotKey.localeCompare(right.slotKey))
    .map((slot) => ({
      slotKey: slot.slotKey,
      title: slot.title,
      value: slot.value,
      sourceKind: slot.sourceKind,
      freshness
    }));
}

async function findVirtualenvPath(repoRoot: string): Promise<string | undefined> {
  for (const candidate of VIRTUALENV_CANDIDATES) {
    const configPath = path.join(repoRoot, candidate, "pyvenv.cfg");
    if (await isFile(configPath)) {
      return candidate;
    }
  }

  return undefined;
}

async function findManagePyPath(repoRoot: string): Promise<string | undefined> {
  const rootManagePath = path.join(repoRoot, "manage.py");
  if (await isFile(rootManagePath)) {
    return "manage.py";
  }

  const pythonFiles = await collectPythonFiles(repoRoot);
  const match = pythonFiles.find((file) => path.posix.basename(file.relativePath) === "manage.py");
  return match?.relativePath;
}

async function findDjangoDbSelector(repoRoot: string): Promise<{
  variable: string;
  relativePath: string;
  confidence: RepoContextProfileSlotRecord["confidence"];
} | undefined> {
  const pythonFiles = await collectPythonFiles(repoRoot);
  for (const file of pythonFiles) {
    const envVariables = [...file.content.matchAll(/os\.(?:getenv|environ\.get)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)]
      .map((match) => match[1])
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (envVariables.length === 0) {
      continue;
    }

    const preferred = envVariables.find((value) => /(?:DJANGO|DATABASE|DB).*(?:ENV|TARGET|NAME)?/.test(value));
    if (!preferred) {
      continue;
    }

    const confidence = /DATABASES|django/i.test(file.content) ? "high" : "medium";
    return {
      variable: preferred,
      relativePath: file.relativePath,
      confidence
    };
  }

  return undefined;
}

async function readPackageScripts(repoRoot: string): Promise<Record<string, string> | undefined> {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!(await isFile(packageJsonPath))) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    if (!packageJson.scripts || typeof packageJson.scripts !== "object" || Array.isArray(packageJson.scripts)) {
      return undefined;
    }

    return Object.fromEntries(
      Object.entries(packageJson.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return undefined;
  }
}

async function collectPythonFiles(repoRoot: string): Promise<Array<{ relativePath: string; content: string }>> {
  const results: Array<{ relativePath: string; content: string }> = [];
  await walkPythonFiles(repoRoot, repoRoot, results);
  results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return results;
}

async function walkPythonFiles(
  repoRoot: string,
  directory: string,
  results: Array<{ relativePath: string; content: string }>
): Promise<void> {
  if (results.length >= MAX_PYTHON_FILES) {
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (results.length >= MAX_PYTHON_FILES) {
      return;
    }

    const absolutePath = path.join(directory, entry.name);
    const relativePath = normalizeRelativePath(repoRoot, absolutePath);
    const segments = relativePath.split("/");
    if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkPythonFiles(repoRoot, absolutePath, results);
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    if (!relativePath.endsWith(".py")) {
      continue;
    }

    results.push({
      relativePath,
      content: await readFile(absolutePath, "utf8")
    });
  }
}

function normalizeRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep);
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}
