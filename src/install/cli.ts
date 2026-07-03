import { cp, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";
import {
  archonMcpConfigFragment,
  grafanaMcpConfigFragment,
  obsidianMcpConfigFragment,
  playwrightMcpConfigFragment,
  mergeClaudeMd,
  mergeDotClaudeMd,
  mergeClaudeSettings,
  mergeGitignore,
  mergeMcpJson,
  mergePackageJson,
  stripArchonFromMcpJson
} from "./merge.ts";
import { repoLocalSkillIdPrefixes } from "../archon/repo-local-skill-surface.ts";
import { detectGrafanaRepoConfig } from "../grafana/config.ts";
import { resolveRuntimeEnvironmentConfig } from "../runtime/config.ts";
import type {
  InstallMode,
  InstallOptions,
  InstallSummary,
  VerifySummary,
  WorkflowScaffoldOptions,
  WorkflowScaffoldSummary
} from "./types.ts";
import { buildNextSteps } from "./next-steps.ts";
import { probeManagedFile } from "./capability/probes-file.ts";
import type { ReadFileFn } from "./capability/probes-file.ts";
import { runL1Probes } from "./capability/probes-config.ts";
import { assembleCapabilityReport, buildL2L3PlaceholderProbes } from "./capability/report.ts";
import type { CapabilityReport, ProbeResult } from "./capability/types.ts";
import { createDefaultEccSpawnFn } from "./ecc-plugin.ts";
import { runL2Probes, createFindAgentFilesFn } from "./capability/probes-external.ts";
import {
  managedFileCapability,
  printInstallSummary,
  runGuidedPhase,
  createDefaultGuidedInitIo,
} from "./guided-init.ts";
import {
  buildBriefFromTemplate,
  buildPlanArtifact,
  buildTaskFromTemplate,
  appendReasoningHardeningSections,
  buildReviewFromTemplate,
  buildHappyPathFixtureBrief,
  buildHappyPathFixtureTask,
  buildHappyPathFixtureReview,
} from "./scaffold-templates.ts";
import {
  maybeRunConsumerRepairPhase,
  createDefaultRepairFns,
} from "./consumer-repair.ts";
import type { RepairReport } from "./consumer-repair.ts";

// Re-export for backward compatibility with tests that import from cli.ts
export { managedFileCapability } from "./guided-init.ts";
export { runEccInstallFromCli } from "./guided-init.ts";

interface InstallFile {
  source: string;
  target: string;
  overwriteManaged: boolean;
}

type ManagedFileStrategy = "merge" | "replace";
type InstallPlanMode = "install-once" | "managed" | "seed";

interface InstallPlanEntry {
  target: string;
  mode: InstallPlanMode;
  strategy: ManagedFileStrategy | "seed";
  resolveDesiredContent: (targetRoot: string, currentContent: string | undefined) => Promise<string>;
}

interface InstallManifestRecord {
  target: string;
  strategy: ManagedFileStrategy;
  contentHash: string;
}

interface InstallManifest {
  version: number;
  files: InstallManifestRecord[];
}

interface ResolvedPlanEntry {
  absolutePath: string;
  entry: InstallPlanEntry;
  invalidReason: string | undefined;
  target: string;
  currentContent: string | undefined;
  currentExists: boolean;
  desiredContent: string;
}

interface PlannedWrite extends ResolvedPlanEntry {
  action: "conflict" | "create" | "skip" | "update";
}

interface ParsedInstallCommand {
  command: "init" | "upgrade";
  dryRun: boolean;
  targetArg: string;
  withGrafana?: boolean;
  withObsidian?: boolean;
  /**
   * When true, run the consented ECC plugin install after the managed file writes.
   * Writes to ~/.claude (user-global). MUST be set explicitly via --install-plugin.
   *
   * Council C5: --yes alone MUST NOT set this flag. ~/.claude writes require
   * a separate explicit opt-in via --install-plugin (or interactive consent in S4).
   * This invariant is enforced at the flag-parse level: parseInstallCommand only sets
   * installPlugin when the --install-plugin flag is present in rawArgs.
   */
  installPlugin?: boolean;
  /**
   * When true, bypasses the ECC major-version confirmation gate (--confirm-ecc-major).
   * Only relevant when installPlugin is also true.
   * Council C6: major version bump requires explicit confirmation.
   */
  confirmEccMajor?: boolean;
  /**
   * --yes: accept CONSUMER-REPO consents (npm install, DB migrate, bootstrap-project).
   * Council C5: MUST NOT imply installPlugin. ~/. claude writes still require
   * --install-plugin or interactive consent.
   */
  yes?: boolean;
  /**
   * --run-db-setup: explicit consent for npm install + archon migrate + bootstrap-project.
   * Equivalent to --yes for the DB setup step (more explicit, single-purpose flag).
   */
  runDbSetup?: boolean;
  /**
   * --no-plugin: explicitly decline ECC plugin install. Suppresses the TTY prompt.
   * Takes precedence over --install-plugin when both are present.
   */
  noPlugin?: boolean;
  /**
   * --json: emit the post-install capability report as JSON to stdout.
   * Human text report is still shown; JSON is appended at the end.
   */
  jsonReport?: boolean;
}

interface ParsedVerifyCommand {
  command: "verify";
  targetArg: string;
  /** When true, emit the engine CapabilityReport as JSON instead of the text summary. */
  json: boolean;
}

interface ParsedScaffoldCommand {
  command: "scaffold-workflow";
  targetArg: string;
  taskId: string;
  force: boolean;
  forceActive: boolean;
}

interface ParsedHappyPathFixtureCommand {
  command: "seed-happy-path-fixture";
  targetArg: string;
  taskId: string;
  force: boolean;
  forceActive: boolean;
}

interface ParsedUpgradeReasoningWorkflowCommand {
  command: "upgrade-reasoning-workflow";
  targetArg: string;
  taskId: string;
  mode: "dual" | "strict";
  force: boolean;
}

type ParsedCliArgs =
  | ParsedInstallCommand
  | ParsedVerifyCommand
  | ParsedScaffoldCommand
  | ParsedHappyPathFixtureCommand
  | ParsedUpgradeReasoningWorkflowCommand;

const installManifestRelativePath = ".archon/install-manifest.json";
const installManifestVersion = 1;
const generatedReviewIdentityAdapter = `import {
  createHeaderReviewIdentityAdapter,
  createReviewPrincipalAdapter
} from "@witchynibbles/archon";

export const reviewIdentityAdapters = {
  auth_context_passthrough: createReviewPrincipalAdapter(async ({ authContext }) => {
    const candidate =
      typeof authContext === "object" && authContext !== null
        ? (authContext as Record<string, unknown>)
        : {};

    if (candidate.verified !== true) {
      throw new Error("Auth context principal is not verified");
    }

    return {
      provider: String(candidate.provider ?? ""),
      subject: String(candidate.subject ?? ""),
      verified: true,
      displayName: typeof candidate.displayName === "string" ? candidate.displayName : undefined,
      email: typeof candidate.email === "string" ? candidate.email : undefined
    };
  }),
  forwarded_headers: createHeaderReviewIdentityAdapter({
    provider: "forwarded_headers",
    subjectHeader: "x-archon-review-subject",
    verifiedHeader: "x-archon-review-verified",
    verifiedValue: "true",
    displayNameHeader: "x-archon-review-name",
    emailHeader: "x-archon-review-email",
    groupsHeader: "x-archon-review-groups"
  })
};

export default createReviewPrincipalAdapter(async () => {
  throw new Error(
    "Implement archon/review-identity-adapter.ts with your authenticated principal lookup or select ARCHON_REVIEW_IDENTITY_BACKEND from reviewIdentityAdapters before trusting review actions"
  );
});
`;

function usage(): never {
  throw new Error(
    "Usage: archon --dry-run [--with-grafana] [--with-obsidian] --target <path> | <path>\n" +
      "   or: archon init (--apply | --dry-run) [--with-grafana] [--with-obsidian] --target <path> | <path>\n" +
      "   or: archon upgrade (--apply | --dry-run) [--with-grafana] [--with-obsidian] --target <path> | <path>\n" +
      "   or: archon verify --target <path> | <path>\n" +
      "   or: archon scaffold-workflow --target <path> --task-id <task-id> [--force] [--force-active]\n" +
      "   or: archon seed-happy-path-fixture --target <path> --task-id fixture-<name> [--force]\n" +
      "   or: archon upgrade-reasoning-workflow --target <path> --task-id <task-id> [--mode dual|strict] [--force]"
  );
}

async function ensureDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isDirectory();
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  if (!(await fileExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}

function isSafeArchonEnvKey(candidate: string): boolean {
  return /^ARCHON_[A-Z0-9_]+$/.test(candidate);
}

function parseArchonEnvContent(content: string): NodeJS.ProcessEnv {
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
    if (!isSafeArchonEnvKey(key)) {
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

async function loadTargetRuntimeEnv(targetRoot: string): Promise<NodeJS.ProcessEnv> {
  const targetEnv = { ...process.env };

  for (const relativePath of [".env.archon.example", ".env.archon"]) {
    const content = await readFileIfExists(path.join(targetRoot, relativePath));
    if (!content) {
      continue;
    }

    Object.assign(targetEnv, parseArchonEnvContent(content));
  }

  return targetEnv;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function inspectManagedTarget(
  targetRoot: string,
  relativePath: string
): Promise<{
  absolutePath: string;
  content: string | undefined;
  exists: boolean;
  invalidReason: string | undefined;
}> {
  const absolutePath = path.resolve(targetRoot, relativePath);
  const rootRealPath = await realpath(targetRoot);

  if (!isPathWithinRoot(targetRoot, absolutePath)) {
    return {
      absolutePath,
      content: undefined,
      exists: false,
      invalidReason: "target path escapes the target root"
    };
  }

  const relativeFromRoot = path.relative(targetRoot, absolutePath);
  const pathSegments = relativeFromRoot.split(path.sep).filter((segment) => segment.length > 0);
  const parentSegments = pathSegments.slice(0, -1);
  let currentPath = targetRoot;

  for (const segment of parentSegments) {
    currentPath = path.join(currentPath, segment);

    let currentStat;
    try {
      currentStat = await lstat(currentPath);
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") {
        currentPath = path.join(currentPath, ...parentSegments.slice(parentSegments.indexOf(segment) + 1));
        break;
      }
      throw error;
    }

    if (!currentStat.isDirectory()) {
      return {
        absolutePath,
        content: undefined,
        exists: false,
        invalidReason: "managed path parent is not an in-root directory"
      };
    }

    const currentRealPath = await realpath(currentPath);
    if (!isPathWithinRoot(rootRealPath, currentRealPath)) {
      return {
        absolutePath,
        content: undefined,
        exists: false,
        invalidReason: "managed path parent resolves outside the target root"
      };
    }
  }

  try {
    const targetStat = await lstat(absolutePath);
    if (!targetStat.isFile()) {
      return {
        absolutePath,
        content: undefined,
        exists: false,
        invalidReason: "managed path is not an in-root regular file"
      };
    }

    const targetRealPath = await realpath(absolutePath);
    if (!isPathWithinRoot(rootRealPath, targetRealPath)) {
      return {
        absolutePath,
        content: undefined,
        exists: false,
        invalidReason: "managed path resolves outside the target root"
      };
    }

    return {
      absolutePath,
      content: await readFile(absolutePath, "utf8"),
      exists: true,
      invalidReason: undefined
    };
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      throw error;
    }

    return {
      absolutePath,
      content: undefined,
      exists: false,
      invalidReason: undefined
    };
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentRoot: string) {
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(currentRoot, { withFileTypes: true })
    );
    for (const entry of entries) {
      const fullPath = path.join(currentRoot, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createInstallSummary(mode: InstallMode, nextSteps: string[]): InstallSummary {
  return {
    mode,
    writesPerformed: false,
    created: [],
    updated: [],
    skipped: [],
    backups: [],
    plannedBackups: [],
    conflicts: [],
    orphans: [],
    runtimeRegistration: undefined,
    runtimeBackupManifest: undefined,
    runtimeMigrationReport: undefined,
    nextSteps
  };
}

async function writeJsonArtifact(
  targetRoot: string,
  relativePath: string,
  payload: unknown,
  summary: InstallSummary
): Promise<void> {
  const inspection = await inspectManagedTarget(targetRoot, relativePath);
  if (inspection.invalidReason) {
    throw new Error(`Runtime artifact at ${relativePath} is not an in-root regular file.`);
  }

  const absolutePath = inspection.absolutePath;
  const nextContent = `${JSON.stringify(payload, null, 2)}\n`;
  const existingContent = inspection.content;

  if (existingContent === nextContent) {
    return;
  }

  await ensureDirectory(absolutePath);
  await writeFile(absolutePath, nextContent, "utf8");
  if (existingContent === undefined) {
    summary.created.push(relativePath);
  } else {
    summary.updated.push(relativePath);
  }
  summary.writesPerformed = true;
}

async function writeRuntimeMigrationArtifacts(params: {
  targetRoot: string;
  manifest: InstallManifest;
  summary: InstallSummary;
  orphans: readonly string[];
  conflicts: readonly string[];
}): Promise<void> {
  const projectSlug = path.basename(params.targetRoot);
  const runtimeEnv = await loadTargetRuntimeEnv(params.targetRoot);
  const runtimeConfig = resolveRuntimeEnvironmentConfig(runtimeEnv, {
    projectSlug,
    cwd: params.targetRoot
  });

  const registrationPath = ".archon/runtime/registration-intent.json";
  const backupManifestPath = ".archon/runtime/backup-manifest.json";
  const migrationReportPath = ".archon/runtime/migration-report.json";
  params.summary.runtimeRegistration = registrationPath;
  params.summary.runtimeBackupManifest = backupManifestPath;
  params.summary.runtimeMigrationReport = migrationReportPath;

  await writeJsonArtifact(
    params.targetRoot,
    registrationPath,
    {
      repoPath: params.targetRoot,
      projectSlug,
      runtimeProfile: runtimeConfig.runtimeProfile,
      dataRoot: runtimeConfig.dataRoot,
      installManifestPath: runtimeConfig.installManifestPath
    },
    params.summary
  );

  await writeJsonArtifact(
    params.targetRoot,
    backupManifestPath,
    {
      version: params.manifest.version,
      files: params.manifest.files
    },
    params.summary
  );

  await writeJsonArtifact(
    params.targetRoot,
    migrationReportPath,
    {
      // "upgrade-applied" is honest: the upgrade ran and applied managed-file changes.
      // Operator should run archon:doctor + archon:verify:setup to confirm full readiness.
      status: "upgrade-applied",
      project: {
        repoPath: params.targetRoot,
        projectSlug
      },
      registrationIntentPath: registrationPath,
      backupManifestPath,
      orphans: [...params.orphans],
      conflicts: [...params.conflicts],
      cleanupRecommendation:
        params.orphans.length > 0
          ? "review orphaned managed files before deleting legacy artifacts"
          : "legacy compatibility window still active; archive legacy managed files after doctor and verify pass",
      verification: {
        commands: ["npm run archon:doctor", "npm run archon:verify:setup"]
      }
    },
    params.summary
  );
}

function normalizeManifestRecord(record: InstallManifestRecord): InstallManifestRecord {
  return {
    target: record.target.replace(/\\/g, "/"),
    strategy: record.strategy,
    contentHash: record.contentHash
  };
}

function serializeInstallManifest(manifest: InstallManifest): string {
  return `${JSON.stringify(
    {
      version: installManifestVersion,
      files: [...manifest.files]
        .map(normalizeManifestRecord)
        .sort((left, right) => left.target.localeCompare(right.target))
    },
    null,
    2
  )}\n`;
}

async function readInstallManifest(targetRoot: string): Promise<InstallManifest | undefined> {
  const inspection = await inspectManagedTarget(targetRoot, installManifestRelativePath);
  if (inspection.invalidReason) {
    throw new Error(`Install manifest at ${installManifestRelativePath} is not an in-root regular file.`);
  }

  const manifestContent = inspection.content;
  if (!manifestContent) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestContent);
  } catch {
    throw new Error(`Install manifest at ${installManifestRelativePath} is not valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Install manifest at ${installManifestRelativePath} has an invalid shape.`);
  }

  const candidate = parsed as {
    files?: unknown;
    version?: unknown;
  };

  if (candidate.version !== installManifestVersion) {
    throw new Error(
      `Install manifest at ${installManifestRelativePath} has unsupported version ${String(candidate.version)}.`
    );
  }

  if (!Array.isArray(candidate.files)) {
    throw new Error(`Install manifest at ${installManifestRelativePath} is missing its files list.`);
  }

  const files = candidate.files.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Install manifest at ${installManifestRelativePath} has an invalid file record.`);
    }

    const record = entry as {
      contentHash?: unknown;
      strategy?: unknown;
      target?: unknown;
    };

    if (typeof record.target !== "string" || typeof record.contentHash !== "string") {
      throw new Error(`Install manifest at ${installManifestRelativePath} has an invalid file record.`);
    }

    if (record.strategy !== "merge" && record.strategy !== "replace") {
      throw new Error(`Install manifest at ${installManifestRelativePath} has an unsupported strategy.`);
    }

    return normalizeManifestRecord({
      target: record.target,
      strategy: record.strategy,
      contentHash: record.contentHash
    });
  });

  return {
    version: installManifestVersion,
    files
  };
}

async function buildManifest(sourceRoot: string): Promise<InstallFile[]> {
  const manifest: InstallFile[] = [];

  const recursiveRoots = [".archon/playwright", ".archon/rules", ".archon/templates", ".githooks", "plugins/archon"];

  for (const relativeRoot of recursiveRoots) {
    const sourcePath = path.join(sourceRoot, relativeRoot);
    if (!(await directoryExists(sourcePath))) {
      continue;
    }

    for (const filePath of await listFilesRecursive(sourcePath)) {
      const relativePath = path.relative(sourceRoot, filePath);
      const overwriteManaged = !relativePath.startsWith(".archon/memory/");
      manifest.push({
        source: filePath,
        target: relativePath,
        overwriteManaged
      });
    }
  }

  const scaffoldFiles = [".archon/memory/README.md", ".archon/skills/README.md"];

  for (const relativePath of scaffoldFiles) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!(await fileExists(sourcePath))) {
      continue;
    }

    manifest.push({
      source: sourcePath,
      target: relativePath,
      overwriteManaged: true
    });
  }

  const repoLocalSkillPrefixes = repoLocalSkillIdPrefixes.map((prefix) => `.claude/skills/${prefix}`);
  const skillsRoot = path.join(sourceRoot, ".claude/skills");
  for (const skillPath of await listFilesRecursive(skillsRoot)) {
    const relativePath = path.relative(sourceRoot, skillPath);
    if (!repoLocalSkillPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
      continue;
    }

    manifest.push({
      source: skillPath,
      target: relativePath,
      overwriteManaged: true
    });
  }

  const agentsRoot = path.join(sourceRoot, ".claude/agents");
  for (const agentPath of await listFilesRecursive(agentsRoot)) {
    // Agents are directory-based: .claude/agents/<name>/AGENT.md
    // Preserve the full relative path from the agents root.
    const relativePath = path.relative(agentsRoot, agentPath);
    manifest.push({
      source: agentPath,
      target: path.join(".claude/agents", relativePath),
      overwriteManaged: true
    });
  }

  // Dynamically enumerate all *.mjs files in source .claude/hooks/ so the manifest
  // never drifts from the directory. withFileTypes guards against a directory whose
  // name ends in .mjs being included. Sort for a stable, deterministic manifest order.
  const hooksSourceDir = path.join(sourceRoot, ".claude/hooks");
  const hookMjsFiles = readdirSync(hooksSourceDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
    .map((e) => e.name)
    .sort();
  for (const hookFile of hookMjsFiles) {
    manifest.push({
      source: path.join(hooksSourceDir, hookFile),
      target: `.claude/hooks/${hookFile}`,
      overwriteManaged: true
    });
  }

  manifest.push(
    {
      source: path.join(sourceRoot, ".env.example"),
      target: ".env.archon.example",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "docker-compose.yml"),
      target: "docker-compose.archon.yml",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "scripts/check-archon-happy-path.sh"),
      target: "scripts/check-archon-happy-path.sh",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "scripts/check-archon-workflow.ts"),
      target: "scripts/check-archon-workflow.ts",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "scripts/check-archon-workflow-live.sh"),
      target: "scripts/check-archon-workflow-live.sh",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "scripts/check-archon-install-live.sh"),
      target: "scripts/check-archon-install-live.sh",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "scripts/check-archon-branch-name.sh"),
      target: "scripts/check-archon-branch-name.sh",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "scripts/check-archon-git-guard.sh"),
      target: "scripts/check-archon-git-guard.sh",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "scripts/check-archon-commit-msg.sh"),
      target: "scripts/check-archon-commit-msg.sh",
      overwriteManaged: true
    },
    {
      source: path.join(sourceRoot, "scripts/archon-session-start.sh"),
      target: "scripts/archon-session-start.sh",
      overwriteManaged: true
    }
  );

  const installedPolicyFiles: InstallFile[] = [
    {
      source: path.join(sourceRoot, ".archon/templates/review-identity-bindings.json"),
      target: ".archon/review-identity-bindings.json",
      overwriteManaged: false
    },
    {
      source: path.join(sourceRoot, ".archon/templates/review-identity-adapter.fixture.json"),
      target: ".archon/review-identity-adapter.fixture.json",
      overwriteManaged: false
    }
  ];

  for (const file of installedPolicyFiles) {
    if (await fileExists(file.source)) {
      manifest.push(file);
    }
  }

  return manifest;
}

async function readObsidianVaultPath(targetRoot: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(targetRoot, ".env.archon"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("ARCHON_OBSIDIAN_VAULT_PATH=")) continue;
      const val = trimmed.slice("ARCHON_OBSIDIAN_VAULT_PATH=".length).replace(/^"(.*)"$/, "$1").trim();
      return val.length > 0 ? val : undefined;
    }
  } catch {
    // .env.archon not present or unreadable
  }
  return undefined;
}

async function buildInstallPlan(
  sourceRoot: string,
  options: {
    withGrafana?: boolean;
    withObsidian?: boolean;
    obsidianVaultPath?: string;
  } = {}
): Promise<InstallPlanEntry[]> {
  const plan: InstallPlanEntry[] = [];
  const copiedFiles = await buildManifest(sourceRoot);

  for (const file of copiedFiles) {
    plan.push({
      target: file.target,
      mode: file.overwriteManaged ? "managed" : "install-once",
      strategy: "replace",
      resolveDesiredContent: async () => readFile(file.source, "utf8")
    });
  }

  const sourceConfig = await readFile(path.join(sourceRoot, ".claude/settings.json"), "utf8");
  const cleanedSettingsSource = stripArchonFromMcpJson(sourceConfig);

  // MCP servers belong in .mcp.json, not .claude/settings.json — Claude Code
  // reads project-scope MCP registrations from .mcp.json only.
  let mcpConfigSource = mergeMcpJson(undefined, archonMcpConfigFragment());
  mcpConfigSource = mergeMcpJson(mcpConfigSource, playwrightMcpConfigFragment());
  if (options.withGrafana) {
    mcpConfigSource = mergeMcpJson(mcpConfigSource, grafanaMcpConfigFragment());
  }
  if (options.withObsidian) {
    mcpConfigSource = mergeMcpJson(mcpConfigSource, obsidianMcpConfigFragment(options.obsidianVaultPath));
  }
  const setupScriptSh = await readFile(path.join(sourceRoot, "scripts/setup-archon.sh"), "utf8");
  const setupScriptPs1 = await readFile(path.join(sourceRoot, "scripts/setup-archon.ps1"), "utf8");

  plan.push(
    {
      target: ".claude/settings.json",
      mode: "managed",
      strategy: "merge",
      resolveDesiredContent: async (_targetRoot, currentContent) =>
        mergeClaudeSettings(currentContent, cleanedSettingsSource)
    },
    {
      target: ".mcp.json",
      mode: "managed",
      strategy: "merge",
      resolveDesiredContent: async (_targetRoot, currentContent) =>
        mergeMcpJson(currentContent, mcpConfigSource)
    },
    {
      target: ".claude.md",
      mode: "managed",
      strategy: "merge",
      resolveDesiredContent: async (_targetRoot, currentContent) => mergeDotClaudeMd(currentContent)
    },
    {
      target: "CLAUDE.md",
      mode: "managed",
      strategy: "merge",
      resolveDesiredContent: async (_targetRoot, currentContent) => mergeClaudeMd(currentContent)
    },
    {
      target: "package.json",
      mode: "managed",
      strategy: "merge",
      resolveDesiredContent: async (targetRoot, currentContent) => {
        const dependencyPath = path.relative(targetRoot, sourceRoot);
        return mergePackageJson(
          currentContent,
          dependencyPath,
          {
            ...(options.withGrafana ? { withGrafana: true } : {})
          }
        );
      }
    },
    {
      target: ".gitignore",
      mode: "managed",
      strategy: "merge",
      resolveDesiredContent: async (_targetRoot, currentContent) =>
        mergeGitignore(currentContent)
    },
    {
      target: "scripts/archon-setup.sh",
      mode: "managed",
      strategy: "replace",
      resolveDesiredContent: async () => setupScriptSh
    },
    {
      target: "scripts/archon-setup.ps1",
      mode: "managed",
      strategy: "replace",
      resolveDesiredContent: async () => setupScriptPs1
    },
    {
      target: "archon/review-identity-adapter.ts",
      mode: "seed",
      strategy: "seed",
      resolveDesiredContent: async () => generatedReviewIdentityAdapter
    },
    {
      target: ".graphifyignore",
      mode: "seed",
      strategy: "seed",
      resolveDesiredContent: async () => readFile(path.join(sourceRoot, ".graphifyignore"), "utf8")
    }
  );

  return plan;
}

async function detectInstalledGrafana(targetRoot: string): Promise<boolean> {
  const detection = await detectGrafanaRepoConfig(targetRoot);
  return detection.configured || detection.codex.hasGrafanaMcp || detection.packageJson.hasManagedScript;
}

async function detectInstalledObsidian(targetRoot: string): Promise<boolean> {
  const mcpConfig = await readFileIfExists(path.join(targetRoot, ".mcp.json"));
  return Boolean(mcpConfig?.includes('"obsidian"') && mcpConfig.includes("mcpvault"));
}

async function backupExistingFile(
  targetRoot: string,
  relativePath: string,
  timestamp: string,
  summary: InstallSummary,
  dryRun: boolean
): Promise<void> {
  const backupPath = path.join(targetRoot, ".archon/install-backups", timestamp, relativePath);
  const relativeBackupPath = path.relative(targetRoot, backupPath);
  summary.plannedBackups.push(relativeBackupPath);
  if (dryRun) {
    return;
  }

  await ensureDirectory(backupPath);
  await cp(path.join(targetRoot, relativePath), backupPath);
  summary.backups.push(relativeBackupPath);
  summary.writesPerformed = true;
}

function resolveCliTarget(args: string[], ignoredArgs: ReadonlySet<string> = new Set(["--dry-run"])): string {
  const targetIndex = args.indexOf("--target");

  if (targetIndex !== -1) {
    const targetArg = args[targetIndex + 1];
    if (!targetArg || targetArg.startsWith("-")) {
      throw new Error("Target path must follow --target and cannot start with '-'.");
    }
    return targetArg;
  }

  const positionalTarget = args.find((arg) => !ignoredArgs.has(arg));
  if (!positionalTarget || positionalTarget.startsWith("-")) {
    usage();
  }

  return positionalTarget;
}

function parseInstallCommand(command: "init" | "upgrade", args: string[]): ParsedInstallCommand {
  const hasDryRun = args.includes("--dry-run");
  const hasApply = args.includes("--apply");

  if (Number(hasDryRun) + Number(hasApply) !== 1) {
    throw new Error(`${command} requires exactly one of --apply or --dry-run.`);
  }

  // C5: installPlugin ONLY from --install-plugin flag; never inferred from --yes or any other flag.
  const hasInstallPlugin = args.includes("--install-plugin");
  const hasConfirmEccMajor = args.includes("--confirm-ecc-major");

  const knownFlags = new Set([
    "--dry-run",
    "--apply",
    "--with-grafana",
    "--with-obsidian",
    "--install-plugin",
    "--confirm-ecc-major",
    // C5: --yes consents only to consumer-repo steps; NEVER implies --install-plugin.
    // Listed here so resolveCliTarget does not mistake it for a positional path arg.
    "--yes",
    // S4 flags: DB setup, explicit plugin decline, JSON report
    "--run-db-setup",
    "--no-plugin",
    "--json",
  ]);

  // LOW-8: warn when --confirm-ecc-major is set without --install-plugin
  if (hasConfirmEccMajor && !hasInstallPlugin) {
    console.warn(
      "Warning: --confirm-ecc-major has no effect without --install-plugin. " +
      "Add --install-plugin to enable the ECC plugin install with major-version confirmation."
    );
  }

  return {
    command,
    dryRun: hasDryRun,
    targetArg: resolveCliTarget(args, knownFlags),
    ...(args.includes("--with-grafana") ? { withGrafana: true } : {}),
    ...(args.includes("--with-obsidian") ? { withObsidian: true } : {}),
    // C5: only set when the flag is explicitly present
    ...(hasInstallPlugin ? { installPlugin: true } : {}),
    ...(hasConfirmEccMajor ? { confirmEccMajor: true } : {}),
    // S4 flags
    ...(args.includes("--yes") ? { yes: true } : {}),
    ...(args.includes("--run-db-setup") ? { runDbSetup: true } : {}),
    ...(args.includes("--no-plugin") ? { noPlugin: true } : {}),
    ...(args.includes("--json") ? { jsonReport: true } : {}),
  };
}

function parseTaskId(
  args: string[],
  command: "scaffold-workflow" | "seed-happy-path-fixture" | "upgrade-reasoning-workflow"
): string {
  const taskIdIndex = args.indexOf("--task-id");

  if (taskIdIndex === -1) {
    throw new Error(`${command} requires --task-id <task-id>.`);
  }

  const taskId = args[taskIdIndex + 1];
  if (!taskId || taskId.startsWith("-")) {
    throw new Error("Task id must follow --task-id and cannot start with '-'.");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    throw new Error(`task_id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$: ${taskId}`);
  }

  return taskId;
}

function parseWorkflowMutationCommand(
  command: "scaffold-workflow" | "seed-happy-path-fixture",
  args: string[]
): ParsedScaffoldCommand | ParsedHappyPathFixtureCommand {
  if (args.includes("--apply") || args.includes("--dry-run")) {
    throw new Error(`${command} does not support --apply or --dry-run.`);
  }

  const resolveScaffoldTarget = (): string => {
    const targetIndex = args.indexOf("--target");

    if (targetIndex !== -1) {
      const targetArg = args[targetIndex + 1];
      if (!targetArg || targetArg.startsWith("-")) {
        throw new Error("Target path must follow --target and cannot start with '-'.");
      }
      return targetArg;
    }

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--task-id") {
        index += 1;
        continue;
      }
      if (arg === "--force" || arg === "--force-active") {
        continue;
      }
      if (!arg.startsWith("-")) {
        return arg;
      }
      usage();
    }

    usage();
  };

  return {
    command,
    targetArg: resolveScaffoldTarget(),
    taskId: parseTaskId(args, command),
    force: args.includes("--force"),
    forceActive: args.includes("--force-active")
  };
}

function parseUpgradeReasoningWorkflowCommand(
  args: string[]
): ParsedUpgradeReasoningWorkflowCommand {
  if (args.includes("--apply") || args.includes("--dry-run") || args.includes("--force-active")) {
    throw new Error("upgrade-reasoning-workflow does not support --apply, --dry-run, or --force-active.");
  }

  const modeIndex = args.indexOf("--mode");
  const modeRaw = modeIndex === -1 ? "strict" : args[modeIndex + 1];
  if (!modeRaw || modeRaw.startsWith("-")) {
    throw new Error("Mode must follow --mode and cannot start with '-'.");
  }
  if (modeRaw !== "dual" && modeRaw !== "strict") {
    throw new Error("upgrade-reasoning-workflow mode must be dual or strict.");
  }

  return {
    command: "upgrade-reasoning-workflow",
    targetArg: resolveCliTarget(args, new Set(["--task-id", "--mode", "--force"])),
    taskId: parseTaskId(args, "upgrade-reasoning-workflow"),
    mode: modeRaw,
    force: args.includes("--force")
  };
}

export function parseCliArgs(rawArgs: string[]): ParsedCliArgs {
  const command = rawArgs[0];

  if (command === "init" || command === "upgrade") {
    return parseInstallCommand(command, rawArgs.slice(1));
  }

  if (command === "verify") {
    const commandArgs = rawArgs.slice(1);
    if (
      commandArgs.includes("--apply") ||
      commandArgs.includes("--dry-run") ||
      commandArgs.includes("--with-grafana")
    ) {
      throw new Error("verify does not support --apply, --dry-run, or --with-grafana.");
    }

    const json = commandArgs.includes("--json");
    return {
      command: "verify",
      targetArg: resolveCliTarget(commandArgs, new Set(["--json"])),
      json
    };
  }

  if (command === "scaffold-workflow") {
    return parseWorkflowMutationCommand("scaffold-workflow", rawArgs.slice(1));
  }

  if (command === "seed-happy-path-fixture") {
    return parseWorkflowMutationCommand("seed-happy-path-fixture", rawArgs.slice(1));
  }

  if (command === "upgrade-reasoning-workflow") {
    return parseUpgradeReasoningWorkflowCommand(rawArgs.slice(1));
  }

  if (rawArgs.includes("--apply")) {
    throw new Error("--apply is only supported with the init or upgrade commands.");
  }

  if (!rawArgs.includes("--dry-run")) {
    throw new Error(
      "Mutating installs require 'init --apply'. Legacy direct invocation without 'init' is dry-run only."
    );
  }

  return {
    command: "init",
    dryRun: true,
    targetArg: resolveCliTarget(rawArgs, new Set(["--dry-run", "--with-grafana", "--with-obsidian"])),
    ...(rawArgs.includes("--with-grafana") ? { withGrafana: true } : {}),
    ...(rawArgs.includes("--with-obsidian") ? { withObsidian: true } : {})
  };
}

async function resolvePlanEntry(entry: InstallPlanEntry, targetRoot: string): Promise<ResolvedPlanEntry> {
  const inspection = await inspectManagedTarget(targetRoot, entry.target);
  const currentContent = inspection.content;
  const desiredContent = await entry.resolveDesiredContent(targetRoot, currentContent);

  return {
    absolutePath: inspection.absolutePath,
    entry,
    invalidReason: inspection.invalidReason,
    target: entry.target,
    currentContent,
    currentExists: inspection.exists,
    desiredContent
  };
}

function resolveInstallAction(resolved: ResolvedPlanEntry): PlannedWrite {
  if (resolved.invalidReason) {
    return { ...resolved, action: "conflict" };
  }

  if (!resolved.currentExists) {
    return { ...resolved, action: "create" };
  }

  if (resolved.currentContent === resolved.desiredContent) {
    return { ...resolved, action: "skip" };
  }

  if (resolved.entry.mode === "managed") {
    return { ...resolved, action: "update" };
  }

  return { ...resolved, action: "skip" };
}

function resolveUpgradeAction(
  resolved: ResolvedPlanEntry,
  manifestRecord: InstallManifestRecord | undefined
): PlannedWrite {
  if (resolved.invalidReason) {
    return { ...resolved, action: "conflict" };
  }

  if (!resolved.currentExists) {
    return { ...resolved, action: "create" };
  }

  if (resolved.currentContent === resolved.desiredContent) {
    return { ...resolved, action: "skip" };
  }

  if (!manifestRecord) {
    return { ...resolved, action: "conflict" };
  }

  if (resolved.entry.strategy !== "replace") {
    return { ...resolved, action: "update" };
  }

  const currentContent = resolved.currentContent;
  if (currentContent === undefined) {
    return { ...resolved, action: "conflict" };
  }

  const currentHash = hashContent(currentContent);
  const desiredHash = hashContent(resolved.desiredContent);
  if (currentHash !== manifestRecord.contentHash && desiredHash !== manifestRecord.contentHash) {
    return { ...resolved, action: "conflict" };
  }

  return { ...resolved, action: "update" };
}

async function writeFileContent(absolutePath: string, content: string): Promise<void> {
  await ensureDirectory(absolutePath);
  await writeFile(absolutePath, content, "utf8");
}

async function applyPlannedWrite(
  targetRoot: string,
  plannedWrite: PlannedWrite,
  timestamp: string,
  summary: InstallSummary,
  dryRun: boolean
): Promise<void> {
  if (plannedWrite.action === "skip" || plannedWrite.action === "conflict") {
    summary.skipped.push(plannedWrite.target);
    return;
  }

  if (plannedWrite.action === "create") {
    summary.created.push(plannedWrite.target);
    if (dryRun) {
      return;
    }

    await writeFileContent(plannedWrite.absolutePath, plannedWrite.desiredContent);
    summary.writesPerformed = true;
    return;
  }

  await backupExistingFile(targetRoot, plannedWrite.target, timestamp, summary, dryRun);
  summary.updated.push(plannedWrite.target);
  if (dryRun) {
    return;
  }

  await writeFileContent(plannedWrite.absolutePath, plannedWrite.desiredContent);
  summary.writesPerformed = true;
}

async function writeInstallManifest(
  targetRoot: string,
  plannedWrites: PlannedWrite[],
  existingManifest?: InstallManifest
): Promise<boolean> {
  const activeManagedTargets = new Set(
    plannedWrites
      .filter((plannedWrite) => plannedWrite.entry.mode === "managed")
      .map((plannedWrite) => plannedWrite.target)
  );

  const orphanRecords: InstallManifestRecord[] = [];
  for (const record of existingManifest?.files ?? []) {
    if (activeManagedTargets.has(record.target)) {
      continue;
    }

    if (await fileExists(path.join(targetRoot, record.target))) {
      orphanRecords.push(record);
    }
  }

  const manifest: InstallManifest = {
    version: installManifestVersion,
    files: [
      ...plannedWrites
        .filter((plannedWrite) => plannedWrite.entry.mode === "managed")
        .map((plannedWrite) => ({
          target: plannedWrite.target,
          strategy: plannedWrite.entry.strategy as ManagedFileStrategy,
          contentHash: hashContent(plannedWrite.desiredContent)
        })),
      ...orphanRecords
    ]
  };

  const manifestContent = serializeInstallManifest(manifest);
  const manifestInspection = await inspectManagedTarget(targetRoot, installManifestRelativePath);
  if (manifestInspection.invalidReason) {
    throw new Error(`Install manifest at ${installManifestRelativePath} is not an in-root regular file.`);
  }

  if (manifestInspection.content === manifestContent) {
    return false;
  }

  await writeFileContent(manifestInspection.absolutePath, manifestContent);
  return true;
}

async function buildLegacyInstallManifest(sourceRoot: string, targetRoot: string): Promise<InstallManifest> {
  const planEntries = (await buildInstallPlan(sourceRoot)).filter((entry) => entry.mode === "managed");
  const files: InstallManifestRecord[] = [];

  for (const entry of planEntries) {
    const resolved = await resolvePlanEntry(entry, targetRoot);
    if (!resolved.currentExists || resolved.invalidReason || resolved.currentContent === undefined) {
      continue;
    }

    files.push({
      target: resolved.target,
      strategy: resolved.entry.strategy as ManagedFileStrategy,
      contentHash: hashContent(resolved.currentContent)
    });
  }

  return {
    version: installManifestVersion,
    files
  };
}

async function loadInstallManifestOrBackfill(
  sourceRoot: string,
  targetRoot: string
): Promise<{
  existingManifest: InstallManifest | undefined;
  manifest: InstallManifest;
}> {
  const existingManifest = await readInstallManifest(targetRoot);
  if (existingManifest) {
    return {
      existingManifest,
      manifest: existingManifest
    };
  }

  return {
    existingManifest: undefined,
    manifest: await buildLegacyInstallManifest(sourceRoot, targetRoot)
  };
}

async function buildManagedUpgradePlan(
  sourceRoot: string,
  targetRoot: string,
  manifest: InstallManifest,
  options: {
    withGrafana?: boolean;
    withObsidian?: boolean;
    obsidianVaultPath?: string;
  } = {}
): Promise<{
  orphans: string[];
  plannedWrites: PlannedWrite[];
}> {
  const planEntries = (await buildInstallPlan(sourceRoot, options)).filter(
    (entry) => entry.mode === "managed"
  );
  const manifestRecords = new Map(manifest.files.map((record) => [record.target, record] as const));
  const plannedTargets = new Set(planEntries.map((entry) => entry.target));

  const orphans: string[] = [];
  for (const record of manifest.files) {
    if (plannedTargets.has(record.target)) {
      continue;
    }

    const inspection = await inspectManagedTarget(targetRoot, record.target);
    if (inspection.exists || inspection.invalidReason) {
      orphans.push(record.target);
    }
  }

  const plannedWrites: PlannedWrite[] = [];
  for (const entry of planEntries) {
    const resolved = await resolvePlanEntry(entry, targetRoot);
    plannedWrites.push(resolveUpgradeAction(resolved, manifestRecords.get(entry.target)));
  }

  return {
    orphans: orphans.sort((left, right) => left.localeCompare(right)),
    plannedWrites
  };
}

function assertTargetRoot(sourceRoot: string, targetRoot: string): void {
  if (sourceRoot === targetRoot) {
    throw new Error("Refusing to install into the archon source repository");
  }
}

export async function installArchonIntoProject(options: InstallOptions): Promise<InstallSummary> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetRoot = path.resolve(options.targetRoot);
  const mode: InstallMode = options.dryRun ? "dry-run" : "apply";
  const dryRun = mode === "dry-run";
  const withGrafana = options.withGrafana ?? (await detectInstalledGrafana(targetRoot));
  const withObsidian = options.withObsidian ?? (await detectInstalledObsidian(targetRoot));
  const obsidianVaultPath = withObsidian ? await readObsidianVaultPath(targetRoot) : undefined;

  assertTargetRoot(sourceRoot, targetRoot);

  const summary = createInstallSummary(mode, buildNextSteps("init", mode, { withGrafana, withObsidian }));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const plannedWrites: PlannedWrite[] = [];

  for (const entry of await buildInstallPlan(sourceRoot, { withGrafana, withObsidian, obsidianVaultPath })) {
    const plannedWrite = resolveInstallAction(await resolvePlanEntry(entry, targetRoot));
    plannedWrites.push(plannedWrite);
    if (plannedWrite.action === "conflict") {
      summary.conflicts.push(plannedWrite.target);
    }
    await applyPlannedWrite(targetRoot, plannedWrite, timestamp, summary, dryRun);
  }

  if (!dryRun) {
    if (await writeInstallManifest(targetRoot, plannedWrites)) {
      summary.writesPerformed = true;
    }
  }

  return summary;
}

export async function upgradeArchonInProject(options: InstallOptions): Promise<InstallSummary> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetRoot = path.resolve(options.targetRoot);
  const mode: InstallMode = options.dryRun ? "dry-run" : "apply";
  const dryRun = mode === "dry-run";
  const withGrafana = options.withGrafana ?? (await detectInstalledGrafana(targetRoot));
  const withObsidian = options.withObsidian ?? (await detectInstalledObsidian(targetRoot));
  const obsidianVaultPath = withObsidian ? await readObsidianVaultPath(targetRoot) : undefined;

  assertTargetRoot(sourceRoot, targetRoot);

  const summary = createInstallSummary(mode, buildNextSteps("upgrade", mode, { withGrafana, withObsidian }));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { existingManifest, manifest } = await loadInstallManifestOrBackfill(sourceRoot, targetRoot);
  const { orphans, plannedWrites } = await buildManagedUpgradePlan(sourceRoot, targetRoot, manifest, {
    withGrafana,
    withObsidian,
    obsidianVaultPath
  });

  summary.orphans.push(...orphans);
  for (const plannedWrite of plannedWrites) {
    if (plannedWrite.action === "conflict") {
      summary.conflicts.push(plannedWrite.target);
    }
  }

  if (summary.conflicts.length > 0 && !dryRun) {
    return summary;
  }

  for (const plannedWrite of plannedWrites) {
    await applyPlannedWrite(targetRoot, plannedWrite, timestamp, summary, dryRun);
  }

  if (!dryRun) {
    if (await writeInstallManifest(targetRoot, plannedWrites, existingManifest ?? manifest)) {
      summary.writesPerformed = true;
    }
    await writeRuntimeMigrationArtifacts({
      targetRoot,
      manifest: existingManifest ?? manifest,
      summary,
      orphans,
      conflicts: summary.conflicts
    });
  }

  return summary;
}

export async function verifyArchonInstall(options: InstallOptions): Promise<VerifySummary> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetRoot = path.resolve(options.targetRoot);
  const withGrafana = options.withGrafana ?? (await detectInstalledGrafana(targetRoot));
  const withObsidian = options.withObsidian ?? (await detectInstalledObsidian(targetRoot));
  const obsidianVaultPath = withObsidian ? await readObsidianVaultPath(targetRoot) : undefined;

  assertTargetRoot(sourceRoot, targetRoot);

  const { manifest } = await loadInstallManifestOrBackfill(sourceRoot, targetRoot);
  const planEntries = (await buildInstallPlan(sourceRoot, { withGrafana, withObsidian, obsidianVaultPath })).filter(
    (entry) => entry.mode === "managed"
  );
  const plannedTargets = new Set(planEntries.map((entry) => entry.target));

  const missing: string[] = [];
  const modified: string[] = [];
  for (const entry of planEntries) {
    const resolved = await resolvePlanEntry(entry, targetRoot);
    if (resolved.invalidReason) { modified.push(entry.target); continue; }
    // Use pre-read content — avoids a double fs read. Probe owns the comparison logic.
    const readFn: ReadFileFn = async (_p) => resolved.currentContent;
    const probe = await probeManagedFile(readFn, {
      capability: "managed-files", code: "managed-file",
      relativePath: entry.target, absolutePath: resolved.absolutePath,
      desiredContent: resolved.desiredContent,
    });
    if (probe.status !== "ok") {
      (probe.code.endsWith("-missing") ? missing : modified).push(entry.target);
    }
  }

  const orphans: string[] = [];
  for (const record of manifest.files) {
    if (plannedTargets.has(record.target)) {
      continue;
    }

    const inspection = await inspectManagedTarget(targetRoot, record.target);
    if (inspection.exists || inspection.invalidReason) {
      orphans.push(record.target);
    }
  }

  return {
    ok: missing.length === 0 && modified.length === 0 && orphans.length === 0,
    missing,
    modified,
    orphans: orphans.sort((left, right) => left.localeCompare(right))
  };
}

// managedFileCapability moved to src/install/guided-init.ts (S4 extraction).
// Re-exported from cli.ts at the top of the file for backward compatibility.

/** Runs L0 + L1 + L2/L3 placeholder probes; returns assembled CapabilityReport for verify. */
async function runVerifyCapabilityEngine(
  sourceRoot: string,
  targetRoot: string
): Promise<CapabilityReport> {
  const withGrafana = await detectInstalledGrafana(targetRoot);
  const withObsidian = await detectInstalledObsidian(targetRoot);
  const obsidianVaultPath = withObsidian ? await readObsidianVaultPath(targetRoot) : undefined;
  const planEntries = (await buildInstallPlan(sourceRoot, { withGrafana, withObsidian, obsidianVaultPath }))
    .filter((e) => e.mode === "managed");

  const l0Probes: ProbeResult[] = [];
  for (const entry of planEntries) {
    const resolved = await resolvePlanEntry(entry, targetRoot);
    // LOW-8: use per-capability naming instead of the generic "managed-files" sentinel
    const capability = managedFileCapability(entry.target);
    if (resolved.invalidReason) {
      l0Probes.push({ capability, layer: "L0", status: "blocked", code: "managed-file-invalid", detail: `Managed path issue: ${entry.target} (${resolved.invalidReason})`, remediation: "Run 'archon upgrade --apply' to restore managed files." });
      continue;
    }
    const readFn: ReadFileFn = async (_p) => resolved.currentContent;
    l0Probes.push(await probeManagedFile(readFn, { capability, code: "managed-file", relativePath: entry.target, absolutePath: resolved.absolutePath, desiredContent: resolved.desiredContent }));
  }

  const fsReadFn: ReadFileFn = async (p) => { try { return await readFile(p, "utf8"); } catch { return undefined; } };
  const allProbes: readonly ProbeResult[] = [...l0Probes, ...await runL1Probes(fsReadFn, targetRoot), ...buildL2L3PlaceholderProbes()];
  return assembleCapabilityReport(allProbes, "verify");
}

/**
 * Runs L0+L1+real L2 probes for the post-install capability check.
 *
 * Unlike runVerifyCapabilityEngine (which uses L2/L3 placeholders for the fast
 * headless verify command), this function runs real L2 probes via runL2Probes
 * so the post-install report reflects actual external state (ECC presence,
 * node_modules, playwright, adapter-stub, skill-ref namespace).
 *
 * Used by the guided phase (init/upgrade --apply) to print the honest
 * post-install capability report including real external checks.
 */
async function runPostInstallCapabilityEngine(
  sourceRoot: string,
  targetRoot: string
): Promise<CapabilityReport> {
  const withGrafana = await detectInstalledGrafana(targetRoot);
  const withObsidian = await detectInstalledObsidian(targetRoot);
  const obsidianVaultPath = withObsidian ? await readObsidianVaultPath(targetRoot) : undefined;
  const planEntries = (await buildInstallPlan(sourceRoot, { withGrafana, withObsidian, obsidianVaultPath }))
    .filter((e) => e.mode === "managed");

  const l0Probes: ProbeResult[] = [];
  for (const entry of planEntries) {
    const resolved = await resolvePlanEntry(entry, targetRoot);
    const capability = managedFileCapability(entry.target);
    if (resolved.invalidReason) {
      l0Probes.push({ capability, layer: "L0", status: "blocked", code: "managed-file-invalid", detail: `Managed path issue: ${entry.target} (${resolved.invalidReason})`, remediation: "Run 'archon upgrade --apply' to restore managed files." });
      continue;
    }
    const readFn: ReadFileFn = async (_p) => resolved.currentContent;
    l0Probes.push(await probeManagedFile(readFn, { capability, code: "managed-file", relativePath: entry.target, absolutePath: resolved.absolutePath, desiredContent: resolved.desiredContent }));
  }

  const fsReadFn: ReadFileFn = async (p) => { try { return await readFile(p, "utf8"); } catch { return undefined; } };
  const l1Probes = await runL1Probes(fsReadFn, targetRoot);
  const l2Probes = await runL2Probes(
    createDefaultEccSpawnFn(),
    fsReadFn,
    createFindAgentFilesFn(),
    targetRoot
  );
  const allProbes: readonly ProbeResult[] = [...l0Probes, ...l1Probes, ...l2Probes];
  return assembleCapabilityReport(allProbes, "verify");
}

// printInstallSummary moved to src/install/guided-init.ts (S4 extraction).
// runGuidedPhase (from guided-init.ts) calls it internally; no direct call needed here.

function printVerifySummary(targetRoot: string, summary: VerifySummary): void {
  console.log(`archon verify for ${targetRoot}`);
  console.log(`status: ${summary.ok ? "ok" : "drifted"}`);
  console.log(`missing: ${summary.missing.length}`);
  console.log(`modified: ${summary.modified.length}`);
  console.log(`orphans: ${summary.orphans.length}`);

  if (summary.missing.length > 0) {
    console.log("Missing:");
    for (const filePath of summary.missing) {
      console.log(`- ${filePath}`);
    }
  }

  if (summary.modified.length > 0) {
    console.log("Modified:");
    for (const filePath of summary.modified) {
      console.log(`- ${filePath}`);
    }
  }

  if (summary.orphans.length > 0) {
    console.log("Orphans:");
    for (const filePath of summary.orphans) {
      console.log(`- ${filePath}`);
    }
  }
}

function printWorkflowScaffoldSummary(targetRoot: string, summary: WorkflowScaffoldSummary): void {
  console.log(`archon scaffold-workflow for ${targetRoot}`);
  console.log(`task_id: ${summary.taskId}`);
  console.log(`created: ${summary.created.length}`);
  console.log(`updated: ${summary.updated.length}`);

  if (summary.created.length > 0) {
    console.log("Created:");
    for (const filePath of summary.created) {
      console.log(`- ${filePath}`);
    }
  }

  if (summary.updated.length > 0) {
    console.log("Updated:");
    for (const filePath of summary.updated) {
      console.log(`- ${filePath}`);
    }
  }

  console.log("Next steps:");
  for (const [index, step] of summary.nextSteps.entries()) {
    console.log(`${index + 1}. ${step}`);
  }
}

function printHappyPathFixtureSummary(targetRoot: string, summary: WorkflowScaffoldSummary): void {
  console.log(`archon seed-happy-path-fixture for ${targetRoot}`);
  console.log(`task_id: ${summary.taskId}`);
  console.log(`created: ${summary.created.length}`);
  console.log(`updated: ${summary.updated.length}`);

  if (summary.created.length > 0) {
    console.log("Created:");
    for (const filePath of summary.created) {
      console.log(`- ${filePath}`);
    }
  }

  if (summary.updated.length > 0) {
    console.log("Updated:");
    for (const filePath of summary.updated) {
      console.log(`- ${filePath}`);
    }
  }

  console.log("Next steps:");
  for (const [index, step] of summary.nextSteps.entries()) {
    console.log(`${index + 1}. ${step}`);
  }
}

function printUpgradeReasoningWorkflowSummary(targetRoot: string, summary: WorkflowScaffoldSummary): void {
  console.log(`archon upgrade-reasoning-workflow for ${targetRoot}`);
  console.log(`task_id: ${summary.taskId}`);
  console.log(`created: ${summary.created.length}`);
  console.log(`updated: ${summary.updated.length}`);

  if (summary.created.length > 0) {
    console.log("Created:");
    for (const filePath of summary.created) {
      console.log(`- ${filePath}`);
    }
  }

  if (summary.updated.length > 0) {
    console.log("Updated:");
    for (const filePath of summary.updated) {
      console.log(`- ${filePath}`);
    }
  }

  console.log("Next steps:");
  for (const [index, step] of summary.nextSteps.entries()) {
    console.log(`${index + 1}. ${step}`);
  }
}

async function prepareWorkflowArtifactPaths(
  options: WorkflowScaffoldOptions,
  pathMode: "live-workflow" | "synthetic-fixture"
): Promise<{
  targetRoot: string;
  activeRelativePath: string;
  briefRelativePath: string;
  taskRelativePath: string;
  reviewRelativePaths: {
    reviewer: string;
    qa_engineer: string;
    security_reviewer: string;
  };
  resolvedArtifactPaths: Map<string, string>;
}> {
  const targetRoot = path.resolve(options.targetRoot);
  const activeRelativePath = ".archon/ACTIVE";
  const briefRelativePath = `.archon/work/briefs/brief-${options.taskId}.md`;
  const taskRelativePath = `.archon/work/tasks/task-${options.taskId}.md`;
  const reviewRelativePaths = {
    reviewer: `.archon/work/reviews/review-${options.taskId}-reviewer.md`,
    qa_engineer: `.archon/work/reviews/review-${options.taskId}-qa_engineer.md`,
    security_reviewer: `.archon/work/reviews/review-${options.taskId}-security_reviewer.md`
  } as const;

  if (pathMode === "live-workflow") {
    const activeInspection = await inspectManagedTarget(targetRoot, activeRelativePath);
    if (activeInspection.invalidReason) {
      throw new Error(`refusing to scaffold ${activeRelativePath}: ${activeInspection.invalidReason}`);
    }

    if (activeInspection.content) {
      const activeTaskId = activeInspection.content
        .split("\n")
        .map((line) => line.replace("\r", ""))
        .find((line) => line.startsWith("task_id="))
        ?.slice("task_id=".length);

      if (activeTaskId && activeTaskId !== options.taskId && !options.forceActive) {
        throw new Error(`refusing to replace active task ${activeTaskId} without --force-active`);
      }
    }
  }

  const artifactPaths = [
    briefRelativePath,
    taskRelativePath,
    reviewRelativePaths.reviewer,
    reviewRelativePaths.qa_engineer,
    reviewRelativePaths.security_reviewer
  ];
  if (pathMode === "live-workflow") {
    artifactPaths.unshift(activeRelativePath);
  }
  const existingArtifacts: string[] = [];
  const resolvedArtifactPaths = new Map<string, string>();

  for (const artifactPath of artifactPaths) {
    const inspection = await inspectManagedTarget(targetRoot, artifactPath);
    if (inspection.invalidReason) {
      throw new Error(`refusing to scaffold ${artifactPath}: ${inspection.invalidReason}`);
    }
    resolvedArtifactPaths.set(artifactPath, inspection.absolutePath);
    if (inspection.exists) {
      existingArtifacts.push(artifactPath);
    }
  }

  if (existingArtifacts.length > 0 && !options.force) {
    throw new Error(
      `refusing to overwrite existing workflow artifacts without --force: ${existingArtifacts.join(", ")}`
    );
  }

  return {
    targetRoot,
    activeRelativePath,
    briefRelativePath,
    taskRelativePath,
    reviewRelativePaths,
    resolvedArtifactPaths
  };
}

function assertHappyPathFixtureTaskId(taskId: string): void {
  if (!taskId.startsWith("fixture-")) {
    throw new Error("seed-happy-path-fixture requires a task id starting with fixture-");
  }
}

async function writeWorkflowArtifactSet(
  targetRoot: string,
  writes: Array<{ absolutePath: string; content: string }>
): Promise<Pick<WorkflowScaffoldSummary, "created" | "updated">> {
  const created: string[] = [];
  const updated: string[] = [];

  for (const write of writes) {
    await ensureDirectory(write.absolutePath);
    const existed = await fileExists(write.absolutePath);
    await writeFile(write.absolutePath, write.content, "utf8");
    const relativePath = path.relative(targetRoot, write.absolutePath);
    if (existed) {
      updated.push(relativePath);
    } else {
      created.push(relativePath);
    }
  }

  return {
    created,
    updated
  };
}

export async function scaffoldWorkflowArtifacts(options: WorkflowScaffoldOptions): Promise<WorkflowScaffoldSummary> {
  const {
    targetRoot,
    activeRelativePath,
    briefRelativePath,
    taskRelativePath,
    reviewRelativePaths,
    resolvedArtifactPaths
  } = await prepareWorkflowArtifactPaths(options, "live-workflow");
  const planRelativePath = `.archon/work/plans/plan-${options.taskId}.md`;

  const briefTemplate = await readFile(
    path.join(options.sourceRoot, ".archon", "templates", "intake-brief.md"),
    "utf8"
  );
  const taskTemplate = await readFile(
    path.join(options.sourceRoot, ".archon", "templates", "task-packet.md"),
    "utf8"
  );
  const reviewTemplate = await readFile(
    path.join(options.sourceRoot, ".archon", "templates", "review-gate.md"),
    "utf8"
  );

  const writes: Array<{ absolutePath: string; content: string }> = [
    {
      absolutePath: resolvedArtifactPaths.get(activeRelativePath) ?? path.join(targetRoot, activeRelativePath),
      content: `task_id=${options.taskId}\nworkflow=archon\nstate=active\n`
    },
    {
      absolutePath: resolvedArtifactPaths.get(briefRelativePath) ?? path.join(targetRoot, briefRelativePath),
      content: `${buildBriefFromTemplate(briefTemplate, options.taskId).trimEnd()}\n`
    },
    {
      absolutePath: path.join(targetRoot, planRelativePath),
      content: `${buildPlanArtifact(options.taskId).trimEnd()}\n`
    },
    {
      absolutePath: resolvedArtifactPaths.get(taskRelativePath) ?? path.join(targetRoot, taskRelativePath),
      content: `${buildTaskFromTemplate(taskTemplate, options.taskId).trimEnd()}\n`
    },
    {
      absolutePath:
        resolvedArtifactPaths.get(reviewRelativePaths.reviewer) ??
        path.join(targetRoot, reviewRelativePaths.reviewer),
      content: `${buildReviewFromTemplate(reviewTemplate, options.taskId, "reviewer").trimEnd()}\n`
    },
    {
      absolutePath:
        resolvedArtifactPaths.get(reviewRelativePaths.qa_engineer) ??
        path.join(targetRoot, reviewRelativePaths.qa_engineer),
      content: `${buildReviewFromTemplate(reviewTemplate, options.taskId, "qa_engineer").trimEnd()}\n`
    },
    {
      absolutePath:
        resolvedArtifactPaths.get(reviewRelativePaths.security_reviewer) ??
        path.join(targetRoot, reviewRelativePaths.security_reviewer),
      content: `${buildReviewFromTemplate(reviewTemplate, options.taskId, "security_reviewer").trimEnd()}\n`
    }
  ];

  const { created, updated } = await writeWorkflowArtifactSet(targetRoot, writes);

  return {
    taskId: options.taskId,
    created,
    updated,
    nextSteps: [
      "Fill in the brief and task packet with real request, scope, and verification details.",
      "Run specialists and replace pending review skeletons with real gate output.",
      `Run npm run archon:check-workflow -- --task-id ${options.taskId} after required reviews pass.`,
      `Use npm run archon:check:happy-path -- --task-id ${options.taskId} only after the workflow is review-complete.`
    ]
  };
}

export async function seedHappyPathFixtureArtifacts(
  options: WorkflowScaffoldOptions
): Promise<WorkflowScaffoldSummary> {
  assertHappyPathFixtureTaskId(options.taskId);
  if (options.forceActive) {
    throw new Error("seed-happy-path-fixture does not support --force-active because fixtures never become active");
  }
  const {
    targetRoot,
    briefRelativePath,
    taskRelativePath,
    reviewRelativePaths,
    resolvedArtifactPaths
  } = await prepareWorkflowArtifactPaths(options, "synthetic-fixture");

  const writes: Array<{ absolutePath: string; content: string }> = [
    {
      absolutePath: resolvedArtifactPaths.get(briefRelativePath) ?? path.join(targetRoot, briefRelativePath),
      content: `${buildHappyPathFixtureBrief(options.taskId).trimEnd()}\n`
    },
    {
      absolutePath: resolvedArtifactPaths.get(taskRelativePath) ?? path.join(targetRoot, taskRelativePath),
      content: `${buildHappyPathFixtureTask(options.taskId).trimEnd()}\n`
    },
    {
      absolutePath:
        resolvedArtifactPaths.get(reviewRelativePaths.reviewer) ??
        path.join(targetRoot, reviewRelativePaths.reviewer),
      content: `${buildHappyPathFixtureReview(options.taskId, "reviewer").trimEnd()}\n`
    },
    {
      absolutePath:
        resolvedArtifactPaths.get(reviewRelativePaths.qa_engineer) ??
        path.join(targetRoot, reviewRelativePaths.qa_engineer),
      content: `${buildHappyPathFixtureReview(options.taskId, "qa_engineer").trimEnd()}\n`
    },
    {
      absolutePath:
        resolvedArtifactPaths.get(reviewRelativePaths.security_reviewer) ??
        path.join(targetRoot, reviewRelativePaths.security_reviewer),
      content: `${buildHappyPathFixtureReview(options.taskId, "security_reviewer").trimEnd()}\n`
    }
  ];

  const { created, updated } = await writeWorkflowArtifactSet(targetRoot, writes);

  return {
    taskId: options.taskId,
    created,
    updated,
    nextSteps: [
      `Run bash scripts/check-archon-happy-path.sh --task-id ${options.taskId}.`,
      "Treat this fixture as synthetic install proof only; replace it with real workflow artifacts before live work.",
      "Do not point .archon/ACTIVE at this fixture task id and do not treat the review markdown as gate authority."
    ]
  };
}

export async function upgradeReasoningWorkflowArtifacts(options: {
  sourceRoot: string;
  targetRoot: string;
  taskId: string;
  mode: "dual" | "strict";
  force?: boolean | undefined;
}): Promise<WorkflowScaffoldSummary> {
  const targetRoot = path.resolve(options.targetRoot);
  const taskRelativePath = `.archon/work/tasks/task-${options.taskId}.md`;
  const inspection = await inspectManagedTarget(targetRoot, taskRelativePath);
  if (inspection.invalidReason) {
    throw new Error(`refusing to upgrade ${taskRelativePath}: ${inspection.invalidReason}`);
  }
  if (!inspection.exists || !inspection.content) {
    throw new Error(`missing task artifact: ${taskRelativePath}`);
  }

  const nextContent = `${appendReasoningHardeningSections(inspection.content, options.mode).trimEnd()}\n`;
  if (nextContent === inspection.content && !options.force) {
    return {
      taskId: options.taskId,
      created: [],
      updated: [],
      nextSteps: [
        "Task already contains reasoning hardening sections.",
        `If you want to rewrite the task packet in ${options.mode} mode anyway, rerun with --force.`,
        `Run npm run archon:check-workflow -- --task-id ${options.taskId} after updating the content.`
      ]
    };
  }

  const { created, updated } = await writeWorkflowArtifactSet(targetRoot, [
    {
      absolutePath: inspection.absolutePath,
      content: nextContent
    }
  ]);

  return {
    taskId: options.taskId,
    created,
    updated,
    nextSteps: [
      `Fill the backfilled reasoning attempt, verification, and verdict sections with real evidence for ${options.taskId}.`,
      `If this task should hard-block on reasoning quality, keep mode \`${options.mode}\` and add passed critic verification plus a supported verdict.`,
      `Run npm run archon:check-workflow -- --task-id ${options.taskId} after the upgraded packet is complete.`
    ]
  };
}

async function main() {
  const parsedArgs = parseCliArgs(process.argv.slice(2));

  const sourceRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const targetRoot = path.resolve(parsedArgs.targetArg);

  if (parsedArgs.command === "scaffold-workflow") {
    const summary = await scaffoldWorkflowArtifacts({
      sourceRoot,
      targetRoot,
      taskId: parsedArgs.taskId,
      force: parsedArgs.force,
      forceActive: parsedArgs.forceActive
    });
    printWorkflowScaffoldSummary(targetRoot, summary);
    return;
  }

  if (parsedArgs.command === "seed-happy-path-fixture") {
    const summary = await seedHappyPathFixtureArtifacts({
      sourceRoot,
      targetRoot,
      taskId: parsedArgs.taskId,
      force: parsedArgs.force,
      forceActive: parsedArgs.forceActive
    });
    printHappyPathFixtureSummary(targetRoot, summary);
    return;
  }

  if (parsedArgs.command === "upgrade-reasoning-workflow") {
    const summary = await upgradeReasoningWorkflowArtifacts({
      sourceRoot,
      targetRoot,
      taskId: parsedArgs.taskId,
      mode: parsedArgs.mode,
      force: parsedArgs.force
    });
    printUpgradeReasoningWorkflowSummary(targetRoot, summary);
    return;
  }

  if (parsedArgs.command === "verify") {
    if (parsedArgs.json) {
      // --json: emit engine CapabilityReport; no text output (C2).
      const report = await runVerifyCapabilityEngine(sourceRoot, targetRoot);
      console.log(JSON.stringify(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
      return;
    }

    // Default text path: unchanged behavior (backward-compatible).
    const summary = await verifyArchonInstall({
      sourceRoot,
      targetRoot
    });
    printVerifySummary(targetRoot, summary);
    if (!summary.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const withGrafana = parsedArgs.withGrafana ?? false;
  const withObsidian = parsedArgs.withObsidian ?? false;

  // S5 consumer repair: detect + backup + repair BEFORE the managed-file pass.
  // Delegates to maybeRunConsumerRepairPhase (exported for testability).
  // Only runs for upgrade --apply (not dry-run, not init).
  const repairReport: RepairReport | undefined = await maybeRunConsumerRepairPhase(
    parsedArgs.command,
    parsedArgs.dryRun,
    targetRoot,
    createDefaultRepairFns()
  );

  const summary = parsedArgs.command === "init"
    ? await installArchonIntoProject({
        sourceRoot,
        targetRoot,
        dryRun: parsedArgs.dryRun,
        withGrafana: parsedArgs.withGrafana,
        withObsidian: parsedArgs.withObsidian
      })
    : await upgradeArchonInProject({
        sourceRoot,
        targetRoot,
        dryRun: parsedArgs.dryRun,
        withGrafana: parsedArgs.withGrafana,
        withObsidian: parsedArgs.withObsidian
      });

  // For upgrade: halt on conflicts before guided phase (file state not safe to act on)
  if (parsedArgs.command === "upgrade" && summary.conflicts.length > 0 && !parsedArgs.dryRun) {
    printInstallSummary(parsedArgs.command, targetRoot, summary, createDefaultGuidedInitIo());
    process.exitCode = 1;
    return;
  }

  // Delegate all post-install orchestration (print summary, consent, DB setup,
  // capability report) to runGuidedPhase.
  // C5: installPlugin, yes, runDbSetup, noPlugin all come from parsedArgs directly.
  //     The guided phase enforces that eccConsented is NEVER derived from yes.
  const guidedResult = await runGuidedPhase({
    command: parsedArgs.command,
    targetRoot,
    summary,
    withGrafana,
    withObsidian,
    yes: parsedArgs.yes,
    installPlugin: parsedArgs.installPlugin,
    noPlugin: parsedArgs.noPlugin,
    runDbSetup: parsedArgs.runDbSetup,
    confirmEccMajor: parsedArgs.confirmEccMajor,
    jsonReport: parsedArgs.jsonReport,
    repairReport,
    getCapabilityReport: () => runPostInstallCapabilityEngine(sourceRoot, targetRoot),
  });

  if (guidedResult.exitCode !== 0) {
    process.exitCode = guidedResult.exitCode;
  }
}

// runEccInstallFromCli moved to src/install/guided-init.ts (S4 extraction).
// Re-exported from cli.ts at module level for backward compatibility with tests.

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

// Backward-compatibility aliases (devgod names → archon names)
export const installDevgodIntoProject = installArchonIntoProject;
export const upgradeDevgodInProject = upgradeArchonInProject;
export const verifyDevgodInstall = verifyArchonInstall;

/**
 * Exposed for testing: returns the list of files the installer will copy into a
 * consumer repo. Tests use this to verify manifest-settings.json parity.
 */
export const buildInstallManifest = buildManifest;
