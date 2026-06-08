import { access, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installArchonIntoProject, upgradeArchonInProject, verifyArchonInstall } from "./install/cli.ts";
import { embedQueryText, runEmbeddingJobs, type EmbeddingProvider } from "./runtime/embedding-runner.ts";
import {
  resolveRuntimeEnvironmentConfig,
  runtimeModeFromProfile
} from "./runtime/config.ts";
import { createHashEmbeddingProvider } from "./runtime/hash-embedding-provider.ts";
import {
  captureRepoMarkdownSnapshot,
  DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS,
  indexRepoMarkdown
} from "./runtime/repo-markdown-indexer.ts";
import {
  inspectRepoContextFreshness,
  probeRepoContextProfile
} from "./runtime/repo-context-profile.ts";
import { loadDotEnv, withClient } from "./admin/db.ts";
import { buildRunEvidenceReport, formatRunEvidenceReportMarkdown } from "./admin/report.ts";
import {
  buildAutonomousOperatorSummary,
  classifyContinueAnalysisDirective,
  resolveContinuationCapabilities,
  selectLocalContinuationProvider,
  type AutonomousContinuationProvider,
  type AutonomousContinuationScheduleKind,
  type AutonomousOperatorSummary,
  type AutonomousWakeOwner,
  type ContinueAnalysisDirectiveClassification
} from "./admin/autonomous-summary.ts";
import {
  buildPlanningContextReport,
  formatPlanningContextReportMarkdown,
  searchLocalWorkflowArtifacts,
  type PlanningContextRepoContextState,
  type PlanningContextRetrievalState
} from "./admin/planning-context.ts";
import { dispatchGithubWorkItem } from "./admin/github-dispatch.ts";
import { buildOperatorDashboardReport, formatOperatorDashboardReport } from "./admin/ops.ts";
import { inspectGraphifyStatus, type GraphifyStatusObservation } from "./admin/graphify.ts";
import {
  buildOperatorStatusReport,
  type DaemonContinuationStatusObservation,
  type DaemonOperatorHandoffObservation,
  type DaemonSupervisorStatusObservation,
  type ReviewIdentityStatusObservation
} from "./admin/status.ts";
import { parseExportDocsRequest } from "./docs-export/parser.ts";
import { resolveObsidianConfig, validateObsidianConfig } from "./docs-export/obsidian-config.ts";
import { DocsSummarizer } from "./docs-export/summarizer.ts";
import { ObsidianMarkdownRenderer } from "./docs-export/renderer.ts";
import { ObsidianVaultWriter } from "./docs-export/obsidian-writer.ts";
import { buildObsidianTargetPath } from "./docs-export/targets.ts";
import { RuntimeWorklogProvider, type WorklogProvider } from "./docs-export/worklog-provider.ts";
import {
  advanceTaskQueue,
  repairTaskQueueContent,
  deriveTaskQueueEvidence,
  parseTaskQueueContent,
  type TaskQueue
} from "./archon/task-queue.ts";
import {
  effectiveRequiredReviews,
  isGateReviewRole,
  isPlaywrightRequiredForTask,
  isRetrievalRole,
  isReviewSeverity,
  isReviewState
} from "./domain/contracts.ts";
import { analysisPhases } from "./domain/types.ts";
import {
  createReviewActionContextResolver,
  createReviewPrincipalAdapter,
  loadReviewIdentityBindings,
  loadReviewIdentityFixtures,
  verifyReviewIdentityAdapter,
  type AuthenticatedPrincipal,
  type ReviewPrincipalAdapter
} from "./core/review-context.ts";
import {
  ArchonCoreService,
  type DirectiveExecutionResult,
  type ExecuteDirectiveStepOptions
} from "./core/service.ts";
import { evaluateReviewDecision } from "./core/policy.ts";
import { compareMemorySearchResults } from "./core/policy.ts";
import type { ResolveReviewActionContext } from "./core/review-context.ts";
import { annotateConflictSignals } from "./core/search-memory-results.ts";
import type {
  ApprovalRecord,
  ArchitectureDecisionRecord,
  AutonomousExecutionState,
  CheckpointRecord,
  ComprehensionSummary,
  ContinuationAction,
  CoverageGapRecord,
  CoverageItemRecord,
  DuplicateFamilyRecord,
  HandoffInput,
  IntakeRequestInput,
  MigrationLedgerEntryRecord,
  ParityRequirementRecord,
  ProjectRuntimeStateRecord,
  ProgressProofRecord,
  RecoveryApplyResult,
  RecoveryInspectionReport,
  ProjectRecord,
  ReviewInput,
  ReviewRecord,
  RuntimeMigrationJournalRecord,
  RuntimeProjectRegistrationRecord,
  RoutingRecommendationReport,
  RunExecutionPlan,
  RunRecord,
  RetrievalRole,
  SearchMemoryResult,
  RunStatusSnapshot,
  TaskPacketInput,
  TaskStatus,
  UnderstandingMapRecord
} from "./domain/types.ts";
import type { WorkspaceRecord } from "./domain/types.ts";
import type { ExportDocsCommandResult } from "./docs-export/models.ts";
import { PostgresStore } from "./store/postgres-store.ts";
import type { ArchonStore as ArchonStoreContract } from "./store/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
type EnvShape = NodeJS.ProcessEnv;
type PostgresStoreClient = ConstructorParameters<typeof PostgresStore>[0];
const MAX_CHECKPOINT_STRING_LENGTH = 512;
const MAX_CHECKPOINT_ARRAY_ITEMS = 32;
const MAX_CHECKPOINT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_CHECKPOINT_INPUT_BYTES = 64 * 1024;
const MAX_DAEMON_STAGNANT_TURNS = 2;
type IndexRepoMarkdownStore = Parameters<typeof indexRepoMarkdown>[0]["store"];
type RetrievalFreshnessStore = Pick<
  ArchonStoreContract,
  "getProjectContext" | "getProjectRuntimeRegistration"
>;
type RefreshRetrievalStore = IndexRepoMarkdownStore &
  Pick<
    ArchonStoreContract,
    | "getProjectContext"
    | "getProjectRuntimeRegistration"
    | "saveProjectRuntimeRegistration"
    | "leaseEmbeddingJobs"
    | "getEmbeddingSource"
    | "completeEmbeddingJob"
    | "failEmbeddingJob"
  >;
type RefreshRepoContextStore = Pick<
  ArchonStoreContract,
  "getProjectContext" | "getProjectRuntimeRegistration" | "saveProjectRuntimeRegistration"
>;

interface LoadedReviewIdentityAdapter {
  adapter: ReviewPrincipalAdapter<unknown>;
  modulePath?: string | undefined;
  selectedBackend?: string | undefined;
  availableBackends: string[];
}

async function migrate() {
  const migrationsDir = path.resolve(__dirname, "sql/migrations");
  const migrationPaths = (await readdir(migrationsDir))
    .filter((entry) => /^\d+_.*\.sql$/i.test(entry))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(migrationsDir, entry));

  await withClient(async (client) => {
    for (const migrationPath of migrationPaths) {
      const sql = await readFile(migrationPath, "utf8");
      await client.query(sql);
    }
  });
  console.log("migrations applied");
}

async function health() {
  await withClient(async (client) => {
    await client.query("select 1");
  });
  console.log("healthy");
}

async function bootstrapProject() {
  const workspaceSlug = process.env.ARCHON_WORKSPACE_SLUG ?? "default";
  const workspaceName = process.env.ARCHON_WORKSPACE_NAME ?? "Default Workspace";
  const projectSlug = process.env.ARCHON_PROJECT_SLUG;
  const projectName = process.env.ARCHON_PROJECT_NAME;
  const repoPath = path.resolve(process.env.ARCHON_PROJECT_REPO_PATH ?? process.cwd());

  if (!projectSlug) {
    throw new Error("ARCHON_PROJECT_SLUG is required");
  }

  const runtimeConfig = resolveRuntimeEnvironmentConfig(process.env, {
    projectSlug,
    cwd: repoPath
  });
  await mkdir(runtimeConfig.dataRoot, { recursive: true });

  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const { workspace, project } = await store.ensureProjectContext({
      workspaceSlug,
      workspaceName,
      projectSlug,
      projectName,
      repoPath
    });
    await store.saveProjectRuntimeRegistration({
      projectId: project.id,
      workspaceId: workspace.id,
      repoPath,
      runtimeProfile: runtimeConfig.runtimeProfile,
      dataRoot: runtimeConfig.dataRoot,
      installManifestPath: runtimeConfig.installManifestPath,
      manifest: {
        installManifestPath: runtimeConfig.installManifestPath
      },
      provenance: {
        authority: "runtime_authoritative",
        source: "bootstrap-project",
        version: "0.1.0"
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await syncRuntimeMigrationJournal({
      store,
      workspace,
      project,
      repoPath,
      status: "registered"
    });
  });

  console.log(`bootstrapped ${workspaceSlug}/${projectSlug}`);
}

async function verifySetup() {
  const workspaceSlug = process.env.ARCHON_WORKSPACE_SLUG ?? "default";
  const projectSlug = process.env.ARCHON_PROJECT_SLUG;

  if (!projectSlug) {
    throw new Error("ARCHON_PROJECT_SLUG is required");
  }

  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const extensionResult = await client.query<{ extversion: string }>(
      `select extversion from pg_extension where extname = 'vector'`
    );

    if (extensionResult.rows.length === 0) {
      throw new Error("pgvector extension is not installed in the target database");
    }

    const tablesResult = await client.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name in (
           'workspaces',
           'projects',
           'runs',
           'tasks',
           'task_dependencies',
           'artifacts',
           'handoffs',
           'approvals',
           'reviews',
           'locks',
           'memory_entries',
           'embedding_jobs',
           'runtime_project_registrations',
           'runtime_migration_journals'
         )`
    );

    const requiredTables = new Set([
      "workspaces",
      "projects",
      "runs",
      "tasks",
      "task_dependencies",
      "artifacts",
      "handoffs",
      "approvals",
      "reviews",
      "locks",
      "memory_entries",
      "embedding_jobs",
      "runtime_project_registrations",
      "runtime_migration_journals"
    ]);

    for (const row of tablesResult.rows) {
      requiredTables.delete(row.table_name);
    }

    if (requiredTables.size > 0) {
      throw new Error(`Missing required tables: ${[...requiredTables].join(", ")}`);
    }

    const columnsResult = await client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
       from information_schema.columns
       where table_schema = 'public'
         and (
           (table_name = 'artifacts' and column_name in ('metadata'))
           or (table_name = 'memory_entries' and column_name in ('metadata'))
           or (table_name = 'handoffs' and column_name in ('owner_role', 'completion_standard', 'execution_evidence', 'quality_gate_evidence'))
           or
           (table_name = 'reviews' and column_name in ('actor', 'actor_role', 'waiver_authority', 'identity_assurance'))
           or (table_name = 'approvals' and column_name in ('actor', 'actor_role', 'identity_assurance'))
         )`
    );

    const requiredColumns = new Set([
      "artifacts.metadata",
      "memory_entries.metadata",
      "handoffs.owner_role",
      "handoffs.completion_standard",
      "handoffs.execution_evidence",
      "handoffs.quality_gate_evidence",
      "reviews.actor",
      "reviews.actor_role",
      "reviews.waiver_authority",
      "reviews.identity_assurance",
      "approvals.actor",
      "approvals.actor_role",
      "approvals.identity_assurance"
    ]);

    for (const row of columnsResult.rows) {
      requiredColumns.delete(`${row.table_name}.${row.column_name}`);
    }

    if (requiredColumns.size > 0) {
      throw new Error(`Missing required columns: ${[...requiredColumns].join(", ")}`);
    }

    const projectResult = await client.query<{ id: string; slug: string }>(
      `select p.id, p.slug
       from projects p
       join workspaces w on w.id = p.workspace_id
       where w.slug = $1 and p.slug = $2`,
      [workspaceSlug, projectSlug]
    );

    if (projectResult.rows.length === 0) {
      throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
    }

    const projectId = projectResult.rows[0]!.id;
    const registrationResult = await client.query<{
      data_root: string;
      runtime_profile: string;
    }>(
      `select data_root, runtime_profile
       from runtime_project_registrations
       where project_id = $1`,
      [projectId]
    );

    if (registrationResult.rows.length === 0) {
      throw new Error(`Project ${workspaceSlug}/${projectSlug} is not runtime-registered`);
    }

    const projectContext = await store.getProjectContext({
      workspaceSlug,
      projectSlug
    });
    if (!projectContext) {
      throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
    }

    const registration = registrationResult.rows[0]!;
    await access(registration.data_root);

    await syncRuntimeMigrationJournal({
      store,
      workspace: projectContext.workspace,
      project: projectContext.project,
      repoPath: path.resolve(process.env.ARCHON_PROJECT_REPO_PATH ?? process.cwd()),
      status: "verified"
    });
  });

  console.log("setup verified");
}

async function verifyLiveMigrations() {
  await migrate();
  await migrate();
  await health();
  await bootstrapProject();
  await verifySetup();

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "archon-live-migrations-"));

  try {
    await writeFile(path.join(fixtureRoot, "package.json"), '{ "name": "fixture", "private": true }\n', "utf8");
    await installArchonIntoProject({
      sourceRoot: repoRoot,
      targetRoot: fixtureRoot
    });

    const driftTarget = path.join(fixtureRoot, "scripts", "check-archon-workflow.sh");
    const driftedContent = `${await readFile(driftTarget, "utf8")}# local drift\n`;
    await writeFile(driftTarget, driftedContent, "utf8");
    await rm(path.join(fixtureRoot, ".archon", "install-manifest.json"));

    const upgradeSummary = await upgradeArchonInProject({
      sourceRoot: repoRoot,
      targetRoot: fixtureRoot
    });
    if (!upgradeSummary.runtimeMigrationReport || !upgradeSummary.runtimeBackupManifest) {
      throw new Error("upgrade did not emit the expected runtime migration artifacts");
    }
    if (upgradeSummary.backups.length === 0) {
      throw new Error("upgrade did not capture a managed-file backup for rollback proof");
    }

    const verifySummary = await verifyArchonInstall({
      sourceRoot: repoRoot,
      targetRoot: fixtureRoot
    });
    if (!verifySummary.ok) {
      throw new Error(
        `upgraded fixture did not verify cleanly (missing=${verifySummary.missing.length}, modified=${verifySummary.modified.length}, orphans=${verifySummary.orphans.length})`
      );
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  console.log("live migrations verified");
}

async function createEmbeddingProvider(env: EnvShape = process.env): Promise<EmbeddingProvider> {
  const providerModulePath = env.ARCHON_EMBEDDING_PROVIDER_MODULE;
  if (!providerModulePath) {
    return createHashEmbeddingProvider({
      model: env.ARCHON_EMBEDDING_MODEL?.trim() || undefined
    });
  }

  const resolvedPath = path.isAbsolute(providerModulePath)
    ? providerModulePath
    : path.resolve(repoRoot, providerModulePath);
  const providerModule = await import(pathToFileURL(resolvedPath).href);
  const factory = providerModule.createEmbeddingProvider ?? providerModule.default;

  if (typeof factory !== "function") {
    throw new Error("embedding provider module must export createEmbeddingProvider() or default()");
  }

  return await factory();
}

function createReviewIdentityFixtureAdapter(): ReviewPrincipalAdapter<unknown> {
  return async ({ authContext }) => {
    const candidate =
      typeof authContext === "object" && authContext !== null
        ? (authContext as Record<string, unknown>)
        : {};

    return {
      provider: String(candidate.provider ?? ""),
      subject: String(candidate.subject ?? ""),
      verified: candidate.verified === true
    };
  };
}

async function loadConfiguredReviewIdentityAdapter(options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  requireLiveAdapter?: boolean | undefined;
} = {}): Promise<LoadedReviewIdentityAdapter> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const adapterModulePath = env.ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE;
  if (!adapterModulePath) {
    if (options.requireLiveAdapter) {
      throw new Error("ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE is required for live review actions");
    }

    return {
      adapter: createReviewIdentityFixtureAdapter(),
      availableBackends: []
    };
  }

  const resolvedPath = path.isAbsolute(adapterModulePath)
    ? adapterModulePath
    : path.resolve(cwd, adapterModulePath);
  const adapterModule = await import(pathToFileURL(resolvedPath).href);
  const availableBackends =
    adapterModule.reviewIdentityAdapters &&
    typeof adapterModule.reviewIdentityAdapters === "object" &&
    !Array.isArray(adapterModule.reviewIdentityAdapters)
      ? Object.keys(adapterModule.reviewIdentityAdapters as Record<string, unknown>).sort((left, right) =>
          left.localeCompare(right)
        )
      : [];
  const selectedBackend = env.ARCHON_REVIEW_IDENTITY_BACKEND?.trim() || undefined;

  if (selectedBackend) {
    const candidate = (adapterModule.reviewIdentityAdapters as Record<string, unknown> | undefined)?.[selectedBackend];
    if (typeof candidate !== "function") {
      throw new Error(`review identity backend not found: ${selectedBackend}`);
    }

    return {
      adapter: candidate as ReviewPrincipalAdapter<unknown>,
      modulePath: resolvedPath,
      selectedBackend,
      availableBackends
    };
  }

  if (availableBackends.length === 1) {
    const onlyBackend = availableBackends[0] as string;
    const candidate = (adapterModule.reviewIdentityAdapters as Record<string, unknown>)[onlyBackend];
    if (typeof candidate === "function") {
      return {
        adapter: candidate as ReviewPrincipalAdapter<unknown>,
        modulePath: resolvedPath,
        selectedBackend: onlyBackend,
        availableBackends
      };
    }
  }

  const factory = adapterModule.createReviewIdentityAdapter;

  if (typeof factory === "function") {
    const created = await factory();
    if (typeof created !== "function") {
      throw new Error("createReviewIdentityAdapter() must return a function");
    }
    return {
      adapter: created as ReviewPrincipalAdapter<unknown>,
      modulePath: resolvedPath,
      selectedBackend,
      availableBackends
    };
  }

  if (typeof adapterModule.default === "function") {
    return {
      adapter: adapterModule.default as ReviewPrincipalAdapter<unknown>,
      modulePath: resolvedPath,
      selectedBackend,
      availableBackends
    };
  }

  throw new Error(
    "review identity adapter module must export default(adapter), createReviewIdentityAdapter(), or reviewIdentityAdapters"
  );
}

async function inspectReviewIdentityAdapterBackends(modulePath: string): Promise<string[]> {
  const adapterModule = await import(pathToFileURL(modulePath).href);
  if (
    !adapterModule.reviewIdentityAdapters ||
    typeof adapterModule.reviewIdentityAdapters !== "object" ||
    Array.isArray(adapterModule.reviewIdentityAdapters)
  ) {
    return [];
  }

  return Object.keys(adapterModule.reviewIdentityAdapters as Record<string, unknown>).sort((left, right) =>
    left.localeCompare(right)
  );
}

async function createLiveReviewIdentityAdapter(options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): Promise<LoadedReviewIdentityAdapter> {
  return loadConfiguredReviewIdentityAdapter({
    cwd: options.cwd,
    env: options.env,
    requireLiveAdapter: true
  });
}

async function resolveReviewIdentityFilePath(options: {
  envVarValue: string | undefined;
  liveRelativePath: string;
  templateRelativePath: string;
  cwd?: string | undefined;
}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  if (options.envVarValue) {
    const configuredPath = path.isAbsolute(options.envVarValue)
      ? options.envVarValue
      : path.resolve(cwd, options.envVarValue);
    if (await pathExists(configuredPath)) {
      return configuredPath;
    }
    return path.resolve(repoRoot, options.templateRelativePath);
  }

  const livePath = path.resolve(cwd, options.liveRelativePath);
  try {
    await access(livePath);
    return livePath;
  } catch {
    return path.resolve(repoRoot, options.templateRelativePath);
  }
}

function isRepoTemplateReviewIdentityPath(filePath: string): boolean {
  const relative = path.relative(repoRoot, filePath);
  return (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    (relative === ".archon/templates/review-identity-bindings.json" ||
      relative === ".archon/templates/review-identity-adapter.fixture.json")
  );
}

async function verifyReviewIdentityCommand() {
  const result = await executeVerifyReviewIdentityCommand({
    cwd: process.cwd(),
    env: process.env
  });
  console.log(JSON.stringify(result));
}

export async function executeVerifyReviewIdentityCommand(options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const bindingsPath = await resolveReviewIdentityFilePath({
    envVarValue: env.ARCHON_REVIEW_IDENTITY_BINDINGS,
    liveRelativePath: ".archon/review-identity-bindings.json",
    templateRelativePath: ".archon/templates/review-identity-bindings.json",
    cwd
  });
  const fixturesPath = await resolveReviewIdentityFilePath({
    envVarValue: env.ARCHON_REVIEW_IDENTITY_FIXTURES,
    liveRelativePath: ".archon/review-identity-adapter.fixture.json",
    templateRelativePath: ".archon/templates/review-identity-adapter.fixture.json",
    cwd
  });

  if (
    !env.ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE &&
    (!isRepoTemplateReviewIdentityPath(bindingsPath) || !isRepoTemplateReviewIdentityPath(fixturesPath))
  ) {
    throw new Error("ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE is required for verify-review-identity");
  }

  const configuredAdapterPath = resolveAdapterModulePath(cwd, env.ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE);
  const useTemplateFallbackAdapter =
    isRepoTemplateReviewIdentityPath(bindingsPath) &&
    isRepoTemplateReviewIdentityPath(fixturesPath) &&
    (!configuredAdapterPath || !(await pathExists(configuredAdapterPath)));

  const [bindings, fixtures, adapter] = await Promise.all([
    loadReviewIdentityBindings(bindingsPath),
    loadReviewIdentityFixtures(fixturesPath),
    loadConfiguredReviewIdentityAdapter(
      useTemplateFallbackAdapter
        ? {
            env: {
              ...env,
              ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE: undefined
            },
            cwd
          }
        : { env, cwd }
    )
  ]);

  const result = await verifyReviewIdentityAdapter({
    bindings,
    fixtures,
    adapter: adapter.adapter
  });

  if (result.failed > 0) {
    throw new Error(
      `Review identity verification failed: ${result.failures
        .map((failure) => `${failure.fixture}: ${failure.message}`)
        .join("; ")}`
    );
  }

  return result;
}

function resolveAdapterModulePath(cwd: string, modulePath: string | undefined): string | undefined {
  if (!modulePath) {
    return undefined;
  }

  return path.isAbsolute(modulePath) ? modulePath : path.resolve(cwd, modulePath);
}

interface RecordReviewCommandInput {
  runId: string;
  taskId: string;
  actor: string;
  review: ReviewInput;
  authContext?: unknown;
}

interface RecordReviewCommandResult {
  mode: "live";
  bindingsPath: string;
  adapterModulePath: string;
  selectedBackend?: string | undefined;
  availableBackends: string[];
  principal: AuthenticatedPrincipal;
  review: ReviewRecord;
  blockers: string[];
  taskStatus: TaskStatus;
}

interface ExecuteRecordReviewCommandOptions {
  adapter: ReviewPrincipalAdapter<unknown>;
  adapterModulePath: string;
  selectedBackend?: string | undefined;
  availableBackends?: string[] | undefined;
  bindingsPath: string;
  recordReview: (input: {
    command: RecordReviewCommandInput;
    resolver: ResolveReviewActionContext;
  }) => Promise<{
    review: ReviewRecord;
    blockers: string[];
    task: {
      status: TaskStatus;
    };
  }>;
}

interface ExecuteRecordReviewCommandFromArgsOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  createLiveAdapter?: (() => Promise<{
    adapter: ReviewPrincipalAdapter<unknown>;
    modulePath: string;
    selectedBackend?: string | undefined;
    availableBackends?: string[] | undefined;
  }>) | undefined;
  recordReview: ExecuteRecordReviewCommandOptions["recordReview"];
}

interface ExecuteStatusCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  inspectReviewIdentity?: (() => Promise<ReviewIdentityStatusObservation>) | undefined;
  inspectGraphify?: (() => Promise<GraphifyStatusObservation>) | undefined;
  findLatestRun?: ((workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>) | undefined;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getExecutionPlan?: ((runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>) | undefined;
  getProjectRuntimeState?: ((projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>) | undefined;
}

interface ExecuteDoctorCommandOptions extends ExecuteStatusCommandOptions {
  findProjectContext?: ((
    workspaceSlug: string,
    projectSlug: string
  ) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>) | undefined;
  getProjectRuntimeRegistration: (
    projectId: string
  ) => Promise<RuntimeProjectRegistrationRecord | undefined>;
  pathExists?: ((candidatePath: string) => Promise<boolean>) | undefined;
  inspectGraphify?: (() => Promise<GraphifyStatusObservation>) | undefined;
}

interface DoctorCheckObservation {
  authorityLabel: "runtime_authoritative" | "derived_only";
  ok: boolean;
  summary: string;
}

export interface DoctorCommandReport {
  ok: boolean;
  run?:
    | {
        authorityLabel: "runtime_authoritative";
        id: string;
        workspaceId: string;
        projectId: string;
      }
    | undefined;
  project: {
    authorityLabel: "runtime_authoritative";
    workspaceSlug: string;
    projectSlug: string;
    workspaceId: string;
    projectId: string;
  };
  runtime: {
    authorityLabel: "runtime_authoritative";
    runtimeMode: string | undefined;
    runtimeProfile: string | undefined;
    dataRoot: string | undefined;
  };
  checks: {
    registration: DoctorCheckObservation;
    repoPath: DoctorCheckObservation;
    dataRoot: DoctorCheckObservation;
    reviewIdentity: DoctorCheckObservation;
  };
  blockers: string[];
  advisories: string[];
}

interface ExecuteDoctorRepairCommandOptions extends ExecuteDoctorCommandOptions {
  runBootstrapRepair?: (() => Promise<void>) | undefined;
  runSetupRepair?: ((cwd: string, env: EnvShape) => Promise<void>) | undefined;
  getProjectContext?: ((
    params: {
      workspaceSlug: string;
      projectSlug: string;
    }
  ) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>) | undefined;
  getProjectRuntimeState?: ((projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>) | undefined;
  saveProjectRuntimeState?: ((state: ProjectRuntimeStateRecord) => Promise<void>) | undefined;
  getExecutionPlan?: ExecuteLoopCommandOptions["getExecutionPlan"];
  applyRecovery?: ExecuteLoopCommandOptions["applyRecovery"];
}

interface DoctorRepairObservation {
  requested: true;
  attempted: boolean;
  status: "not_needed" | "repaired" | "skipped" | "failed";
  executionReady: boolean;
  stepsAttempted: string[];
  stepsApplied: string[];
  integrityRepairsAttempted: string[];
  integrityRepairsApplied: string[];
  skippedReasons: string[];
  failure?: string | undefined;
}

interface DoctorRepairCommandResult {
  ok: boolean;
  executionReady: boolean;
  report?: DoctorCommandReport | undefined;
  repair: DoctorRepairObservation;
}

interface ExecuteRuntimePreflightCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  findLatestRun?: ExecuteStatusCommandOptions["findLatestRun"];
  getStatusSnapshot?: ExecuteStatusCommandOptions["getStatusSnapshot"];
  findProjectContext?: ExecuteDoctorCommandOptions["findProjectContext"];
  getProjectRuntimeRegistration?: ExecuteDoctorCommandOptions["getProjectRuntimeRegistration"];
  pathExists?: ExecuteDoctorCommandOptions["pathExists"];
  inspectReviewIdentity?: ExecuteStatusCommandOptions["inspectReviewIdentity"];
  skipRuntimePreflight?: boolean | undefined;
  requireRuntimePreflight?: boolean | undefined;
  runtimePreflightBypassToken?: symbol | undefined;
}

interface RuntimeExecutionPreflightFailure {
  blockers: string[];
  reason: string;
  activeRunId: string | null;
  nextActions: string[];
}

const INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN = Symbol("archon.runtime_preflight_bypass");

function extractRuntimeExecutionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error).trim() || "unknown runtime error";
}

export function isRuntimeExecutionPreflightConnectionError(error: unknown): boolean {
  const message = extractRuntimeExecutionErrorMessage(error);
  return (
    /ARCHON_CORE_DATABASE_URL is required/i.test(message) ||
    /\bECONNREFUSED\b/i.test(message) ||
    /\bECONNRESET\b/i.test(message) ||
    /\bENOTFOUND\b/i.test(message) ||
    /\bETIMEDOUT\b/i.test(message) ||
    /\bConnection terminated unexpectedly\b/i.test(message) ||
    /\bconnect\b.*\brefused\b/i.test(message)
  );
}

export function buildRuntimeExecutionConnectionFailure(error: unknown): RuntimeExecutionPreflightFailure {
  const message = extractRuntimeExecutionErrorMessage(error);
  const summary = /ARCHON_CORE_DATABASE_URL is required/i.test(message)
    ? "ARCHON_CORE_DATABASE_URL is missing"
    : `database unavailable: ${message}`;
  return {
    blockers: [summary],
    reason: `runtime execution preflight failed: ${summary}`,
    activeRunId: null,
    nextActions: [
      "restore Postgres connectivity or set a valid `ARCHON_CORE_DATABASE_URL`",
      "rerun `npm run archon:doctor` after connectivity is restored"
    ]
  };
}

interface ExecuteOpsCommandOptions extends ExecuteStatusCommandOptions {
  getExecutionPlan: (runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>;
  getRoutingReport: (runId: string) => Promise<RoutingRecommendationReport>;
  inspectRecovery: (runId: string, staleAfterHours: number) => Promise<RecoveryInspectionReport>;
}

interface ExecuteLoopCommandOptions extends ExecuteStatusCommandOptions {
  getExecutionPlan: (runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>;
  applyRecovery: (runId: string, actionIds: readonly string[], staleAfterHours: number) => Promise<RecoveryApplyResult>;
  findProjectContext?: ExecuteDoctorCommandOptions["findProjectContext"];
  getProjectRuntimeRegistration?: ExecuteDoctorCommandOptions["getProjectRuntimeRegistration"];
  pathExists?: ExecuteDoctorCommandOptions["pathExists"];
  skipRuntimePreflight?: boolean | undefined;
  runtimePreflightBypassToken?: symbol | undefined;
  executeDirectiveStep?: ((
    runId: string,
    input: Omit<ExecuteDirectiveStepOptions, "executeReviewRecommendation"> & {
      reviewCommands: readonly RecordReviewCommandInput[];
    }
  ) => Promise<DirectiveExecutionResult>) | undefined;
}

interface ExecuteRecoverCommandOptions extends ExecuteStatusCommandOptions {
  inspectRecovery: (runId: string, staleAfterHours: number) => Promise<RecoveryInspectionReport>;
  applyRecovery: (runId: string, actionIds: readonly string[], staleAfterHours: number) => Promise<RecoveryApplyResult>;
  saveProjectRuntimeState?: ((state: ProjectRuntimeStateRecord) => Promise<void>) | undefined;
}

interface ExecuteReportCommandOptions extends ExecuteStatusCommandOptions {
  getExecutionPlan: (runId: string, staleAfterHours: number) => Promise<RunExecutionPlan>;
  getRoutingReport: (runId: string) => Promise<RoutingRecommendationReport>;
  inspectRecovery: (runId: string, staleAfterHours: number) => Promise<RecoveryInspectionReport>;
  getHandoffs: (runId: string, taskId: string) => Promise<readonly {
    createdAt: string;
    actor: string;
    ownerRole: RetrievalRole;
    completionStandard: string;
  }[]>;
  getReviews: (runId: string, taskId: string) => Promise<readonly ReviewRecord[]>;
  getApprovals: (runId: string, taskId: string) => Promise<readonly {
    createdAt: string;
    actor: string;
    actorRole: RetrievalRole;
    identityAssurance: "authenticated" | "legacy_backfill";
    decision: string;
  }[]>;
  getLoopHistory?: ((runId: string, limit: number) => Promise<readonly SearchMemoryResult[]>) | undefined;
}

interface ExecuteWorkflowProofCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  allowQueueContinuation?: boolean | undefined;
  integrityCheckMode?: "strict" | "allow_seed_failure_recovery" | undefined;
  findLatestRun?: ((workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>) | undefined;
  findLatestRunForTask?: ((
    workspaceSlug: string,
    projectSlug: string,
    taskId: string
  ) => Promise<{ id: string } | undefined>) | undefined;
  getProjectContext?: (params: {
    workspaceSlug: string;
    projectSlug: string;
  }) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  getProjectRuntimeState?: ((projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>) | undefined;
  saveProjectRuntimeState?: ((state: ProjectRuntimeStateRecord) => Promise<void>) | undefined;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getReviews: (runId: string, taskId: string) => Promise<readonly ReviewRecord[]>;
  getApprovals: (runId: string, taskId: string) => Promise<readonly ApprovalRecord[]>;
}

export interface WorkflowProofResult {
  authorityLabel: "runtime_authoritative";
  runId: string;
  taskId: string;
  taskStatus: TaskStatus;
  reviewDecision: "approved";
  blockers: [];
  latestReviews: ReviewRecord[];
  latestApproval: ApprovalRecord;
  continuationApplied: boolean;
  nextTaskId: string | null;
}

interface ExecuteSeedWorkflowProofCommandOptions extends ExecuteWorkflowProofCommandOptions {
  cwd?: string | undefined;
  getProjectContext: (params: {
    workspaceSlug: string;
    projectSlug: string;
  }) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  saveProjectRuntimeState: (state: ProjectRuntimeStateRecord) => Promise<void>;
  intakeRequest: (input: IntakeRequestInput) => Promise<RunRecord>;
  createTaskGraph: (runId: string, taskPackets: TaskPacketInput[]) => Promise<readonly unknown[]>;
  claimTask: (runId: string, taskId: string, actor: string) => Promise<unknown>;
  submitHandoff: (runId: string, taskId: string, handoff: HandoffInput) => Promise<unknown>;
  recordReview: (runId: string, taskId: string, actor: string, review: ReviewInput) => Promise<unknown>;
  failTask?: ((runId: string, taskId: string, reason: string) => Promise<unknown>) | undefined;
}

export interface SeedWorkflowProofResult extends WorkflowProofResult {
  mode: "local_workflow_proof_seed";
  workspaceSlug: string;
  projectSlug: string;
}

interface ExecuteSeedModernizationProofCommandOptions extends ExecuteSeedWorkflowProofCommandOptions {
  configureAutonomousExecution: (
    runId: string,
    input: Pick<AutonomousExecutionState, "profile" | "phase" | "manifest">
  ) => Promise<unknown>;
  upsertCoverageItems: (runId: string, items: CoverageItemRecord[]) => Promise<unknown>;
  upsertUnderstandingMaps: (runId: string, maps: UnderstandingMapRecord[]) => Promise<unknown>;
  upsertRuntimeTraces: (
    runId: string,
    traces: NonNullable<AutonomousExecutionState["runtimeTraces"]>
  ) => Promise<unknown>;
  upsertDuplicateFamilies: (runId: string, records: DuplicateFamilyRecord[]) => Promise<unknown>;
  upsertArchitectureDecisions: (runId: string, records: ArchitectureDecisionRecord[]) => Promise<unknown>;
  upsertMigrationLedgerEntries: (runId: string, records: MigrationLedgerEntryRecord[]) => Promise<unknown>;
  upsertParityRequirements: (runId: string, records: ParityRequirementRecord[]) => Promise<unknown>;
}

export interface SeedModernizationProofResult extends WorkflowProofResult {
  mode: "local_modernization_proof_seed";
  workspaceSlug: string;
  projectSlug: string;
  autonomous: {
    profile: AutonomousExecutionState["profile"];
    phase: AutonomousExecutionState["phase"];
    readinessScope: ComprehensionSummary["readinessScope"];
    rewriteReadiness: ComprehensionSummary["rewriteReadiness"];
    missingArtifactKinds: ComprehensionSummary["missingArtifactKinds"];
    duplicateFamilyCount: number;
    architectureDecisionCount: number;
    migrationLedgerCount: number;
    parityRequirementCount: number;
  };
}

interface ExecuteReconcileRuntimeStateCommandOptions extends ExecuteLoopCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  getProjectContext: (params: {
    workspaceSlug: string;
    projectSlug: string;
  }) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  saveProjectRuntimeState: (state: ProjectRuntimeStateRecord) => Promise<void>;
}

interface ExecuteAdvanceActiveTaskCommandOptions extends ExecuteWorkflowProofCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  getProjectContext: (params: {
    workspaceSlug: string;
    projectSlug: string;
  }) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  saveProjectRuntimeState: (state: ProjectRuntimeStateRecord) => Promise<void>;
}

interface ExecuteSyncRuntimeExportsCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  getProjectContext: (params: {
    workspaceSlug: string;
    projectSlug: string;
  }) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  saveProjectRuntimeState?: ((state: ProjectRuntimeStateRecord) => Promise<void>) | undefined;
}

export interface AdvanceActiveTaskCommandResult {
  mode: "dry_run" | "applied";
  taskId: string;
  nextTaskId: string | null;
  proof: WorkflowProofResult;
  queue: TaskQueue;
}

export interface SyncRuntimeExportsCommandResult {
  mode: "runtime_export_sync";
  workspaceSlug: string;
  projectSlug: string;
  activeTaskId: string | null;
  queue: TaskQueue;
}

type RuntimeStateReconcileAction =
  | "none"
  | "rebuild_missing_runtime_state"
  | "rebuild_stale_runtime_queue"
  | "sync_active_task_to_in_progress"
  | "activate_owner_dispatch_target"
  | "clear_completed_active_task";

export interface ReconcileRuntimeStateCommandResult {
  mode: "dry_run" | "applied";
  workspaceSlug: string;
  projectSlug: string;
  activeRunId: string | null;
  activeTaskId: string | null;
  queue: TaskQueue;
  repairAction: RuntimeStateReconcileAction;
  runtimeStateChanged: boolean;
  localExportsSynced: boolean;
  reason: string;
  executionPlanDirectiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
}

interface DaemonCycleRecord {
  cycle: number;
  directiveKind: RunExecutionPlan["directive"]["kind"];
  action:
    | "run_codex_owner"
    | "run_codex_analysis"
    | "run_workflow_proof"
    | "apply_runtime_continuation"
    | "record_review"
    | "reconcile_runtime_state"
    | "request_scope_expansion"
    | "advance_active_task"
    | "blocked"
    | "complete";
  runId: string;
  taskId: string | null;
  summary: string;
  sessionId?: string | null | undefined;
}

export interface DaemonCommandResult {
  authorityLabel: "derived_only";
  workspaceSlug: string;
  projectSlug: string;
  status: "completed" | "blocked" | "max_cycles_reached";
  reason: string;
  activeRunId: string | null;
  activeTaskId: string | null;
  sessionId: string | null;
  cycles: DaemonCycleRecord[];
}

interface SupervisorActionRecord {
  cycle: number;
  action:
    | "enqueue_operator_continuation"
    | "enqueue_review_action"
    | "materialize_app_automation"
    | "materialize_cli_scheduler";
  targetId?: string | undefined;
  taskId?: string | undefined;
  reviewRole?: ReviewRecord["reviewerRole"] | undefined;
  filePath: string;
  summary: string;
}

export interface SupervisorCommandResult {
  authorityLabel: "derived_only";
  workspaceSlug: string;
  projectSlug: string;
  status: "completed" | "blocked" | "max_cycles_reached";
  reason: string;
  activeRunId: string | null;
  activeTaskId: string | null;
  sessionId: string | null;
  daemonRuns: DaemonCommandResult[];
  actions: SupervisorActionRecord[];
}

export interface SupervisorHistoryCommandResult {
  authorityLabel: "derived_only";
  historyPath: string;
  scope: "run" | "all";
  runId?: string | undefined;
  retainedCount: number;
  filteredCount: number;
  returnedCount: number;
  truncated: boolean;
  entries: DaemonSupervisorStatusObservation["history"];
  latestStatus?:
    | Pick<
        DaemonSupervisorStatusObservation,
        | "state"
        | "blockerKind"
        | "reason"
        | "activeRunId"
        | "activeTaskId"
        | "sessionId"
        | "supervisorCycles"
        | "updatedAt"
      >
    | undefined;
}

interface RunCodexTurnInput {
  claudeBin: string;
  cwd: string;
  env: EnvShape;
  prompt: string;
  sessionId?: string | undefined;
}

interface RunCodexTurnResult {
  sessionId?: string | undefined;
  finalMessage?: string | undefined;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DaemonPromptMode = "full" | "delta";

type DaemonPromptContinuationAction =
  | { kind: "run_workflow_proof"; taskId: string }
  | { kind: "resolve_blocking_gap"; gapId: string; targetId: string }
  | {
      kind: "resume_target";
      targetId: string;
      source?: "blocking_gap" | "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
    };

type DaemonPromptDirective =
  | RunExecutionPlan["directive"]
  | {
      kind: "continue_analysis";
      targetId: string;
      actions: DaemonPromptContinuationAction[];
    }
  | {
      kind: "dispatch_owner";
      rationale: string[];
    };

interface ParsedDaemonTurnMessage {
  summary: string;
  status: "completed" | "blocked" | "needs_review" | "needs_followup";
  blockers: string[];
  checkpoint?: {
    evidenceRefs: string[];
    nextActions: string[];
    activeTargets: string[];
    openGaps: string[];
    compressedContextSummary?: string | undefined;
    compressedContextRef?: string | undefined;
    compressedContextSourceRefs: string[];
  } | undefined;
  scopeRequest?: {
    blockedPaths: string[];
    requestedWriteScope: string[];
    reason?: string | undefined;
  } | undefined;
}

interface DaemonStagnationMetadata {
  runId: string;
  taskId: string;
  directiveKind: RunExecutionPlan["directive"]["kind"];
  progressKey: string;
  count: number;
  updatedAt: string;
  lastStatus?: ParsedDaemonTurnMessage["status"] | undefined;
  lastSummary?: string | undefined;
  lastBlockers?: string[] | undefined;
}

interface DaemonPromptMetadata {
  taskId?: string | undefined;
  packetFingerprint?: string | undefined;
}

interface ExecuteDaemonCommandOptions extends ExecuteAdvanceActiveTaskCommandOptions, ExecuteLoopCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  runCodexTurn?: ((input: RunCodexTurnInput) => Promise<RunCodexTurnResult>) | undefined;
  upsertCoverageGaps?: ((runId: string, gaps: CoverageGapRecord[]) => Promise<unknown>) | undefined;
  checkpointRun?: ((
    runId: string,
    checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">,
    options?: {
      authorityLabel?: CheckpointRecord["authorityLabel"] | undefined;
    }
  ) => Promise<unknown>) | undefined;
  now?: (() => Date) | undefined;
}

interface ExecuteSupervisorCommandOptions extends ExecuteDaemonCommandOptions {}

interface ExecuteSupervisorHistoryCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  findLatestRun?: ((workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>) | undefined;
}

function resolveRepoMarkdownInclude(env: EnvShape): string[] {
  const includeValue = env.ARCHON_REPO_MARKDOWN_INCLUDE ?? DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS.join(",");
  return includeValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const repoMarkdownCommandFlagsWithValues = new Set([
  "--workspace-slug",
  "--workspace-name",
  "--project-slug",
  "--project-name",
  "--embedding-model"
]);

const planContextRefreshPassthroughFlagsWithValues = new Set([
  "--workspace-slug",
  "--project-slug"
]);

function resolveCommandPositionals(
  args: readonly string[],
  flagsWithValues: ReadonlySet<string> = new Set()
): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (value.startsWith("-")) {
      if (flagsWithValues.has(value)) {
        index += 1;
      }
      continue;
    }

    positionals.push(value);
  }

  return positionals;
}

export function buildPlanContextRefreshArgs(args: readonly string[]): string[] {
  const passthrough: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("-")) {
      continue;
    }

    if (planContextRefreshPassthroughFlagsWithValues.has(value)) {
      passthrough.push(value);
      const nextValue = args[index + 1];
      if (typeof nextValue === "string") {
        passthrough.push(nextValue);
        index += 1;
      }
    }
  }

  return passthrough;
}

function resolveRepoMarkdownTargetRoot(
  env: EnvShape,
  args: readonly string[] = [],
  cwd = process.cwd()
): string {
  const [targetRoot] = resolveCommandPositionals(args, repoMarkdownCommandFlagsWithValues);
  if (targetRoot) {
    return path.resolve(cwd, targetRoot);
  }

  if (env.ARCHON_REPO_MARKDOWN_ROOT) {
    return path.resolve(cwd, env.ARCHON_REPO_MARKDOWN_ROOT);
  }

  return path.resolve(cwd);
}

function resolveEmbeddingJobLimit(env: EnvShape, candidate?: string | undefined): number {
  const limitValue = candidate ?? env.ARCHON_EMBEDDING_JOB_LIMIT ?? "10";
  const limit = Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid embedding job limit: ${limitValue}`);
  }
  return limit;
}

function resolveArtifactsOnlyRetrievalRefresh(args: readonly string[], env: EnvShape): boolean {
  if (args.includes("--artifacts-only")) {
    return true;
  }

  const candidate = env.ARCHON_RETRIEVAL_REFRESH_MODE?.trim().toLowerCase();
  return candidate === "artifacts_only" || candidate === "artifacts-only" || candidate === "fast";
}

interface RetrievalIndexManifestRecord {
  status?: string | undefined;
  repoRoot?: string | undefined;
  include?: string[] | undefined;
  fileCount?: number | undefined;
  fingerprint?: string | undefined;
  embeddingModel?: string | undefined;
  indexedAt?: string | undefined;
  jobsQueued?: number | undefined;
  chunksStored?: number | undefined;
  filesIndexed?: number | undefined;
  embeddingLeased?: number | undefined;
  embeddingCompleted?: number | undefined;
  embeddingFailed?: number | undefined;
  embeddedAt?: string | undefined;
}

function readRetrievalIndexManifest(
  registration: RuntimeProjectRegistrationRecord
): RetrievalIndexManifestRecord | undefined {
  const candidate = registration.manifest.retrievalIndex;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  return candidate as RetrievalIndexManifestRecord;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface ExecutePlanContextCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  searchMemory: (input: {
    workspaceSlug: string;
    projectSlug: string;
    query: string;
    limit: number;
    includeGlobal: boolean;
    queryEmbedding?: readonly number[] | undefined;
    embeddingModel?: string | undefined;
    requesterRole: RetrievalRole;
  }) => Promise<readonly SearchMemoryResult[]>;
  embedQuery?: ((input: { model: string; text: string }) => Promise<readonly number[]>) | undefined;
  getRepoContext?: (() => Promise<PlanningContextRepoContextState>) | undefined;
  refreshRepoContext?: (() => Promise<RefreshRepoContextResult>) | undefined;
  getRetrievalFreshness?: (() => Promise<PlanningContextRetrievalState>) | undefined;
  refreshRetrieval?: (() => Promise<RefreshRetrievalResult>) | undefined;
}

interface ExecuteExportDocsCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  now?: Date | undefined;
  resolveObsidianConfig?: typeof resolveObsidianConfig | undefined;
  validateObsidianConfig?: typeof validateObsidianConfig | undefined;
  createWorklogProvider: (input: {
    workspaceSlug: string;
    projectSlug: string;
  }) => WorklogProvider;
}

export interface ExecuteIndexRepoMarkdownCommandOptions {
  env?: EnvShape | undefined;
  argv?: readonly string[] | undefined;
  withClient?: typeof withClient | undefined;
  createStore?: ((client: PostgresStoreClient) => IndexRepoMarkdownStore) | undefined;
  indexRepoMarkdown?: typeof indexRepoMarkdown | undefined;
}

export interface ExecuteRefreshRetrievalCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  argv?: readonly string[] | undefined;
  withClient?: typeof withClient | undefined;
  createStore?: ((client: PostgresStoreClient) => RefreshRetrievalStore) | undefined;
  captureSnapshot?: typeof captureRepoMarkdownSnapshot | undefined;
  indexRepoMarkdown?: typeof indexRepoMarkdown | undefined;
  runEmbeddingJobs?: typeof runEmbeddingJobs | undefined;
  createEmbeddingProvider?: typeof createEmbeddingProvider | undefined;
  now?: (() => Date) | undefined;
}

export interface ExecuteRefreshRepoContextCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  argv?: readonly string[] | undefined;
  withClient?: typeof withClient | undefined;
  createStore?: ((client: PostgresStoreClient) => RefreshRepoContextStore) | undefined;
  now?: (() => Date) | undefined;
}

export interface ExecuteRepairTaskQueueCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
}

export interface RepairTaskQueueResult {
  authorityLabel: "derived_only";
  queuePath: string;
  changed: boolean;
  repairedTasks: number;
}

export interface RefreshRetrievalResult {
  authorityLabel: "runtime_authoritative";
  workspaceSlug: string;
  projectSlug: string;
  repoRoot: string;
  mode: "full" | "artifacts_only";
  filesIndexed: number;
  chunksStored: number;
  jobsQueued: number;
  embeddingJobs?: {
    leased: number;
    completed: number;
    failed: number;
  } | undefined;
}

export interface RefreshRepoContextResult {
  authorityLabel: "runtime_authoritative";
  workspaceSlug: string;
  projectSlug: string;
  repoRoot: string;
  slotCount: number;
  status?: "ready" | "degraded" | undefined;
  fingerprint?: string | undefined;
}

export function createRuntimeStore(client: PostgresStoreClient): PostgresStore {
  return new PostgresStore(client);
}

export async function createPlanContextEmbedQuery(
  env: EnvShape = process.env,
  options: {
    provider?: EmbeddingProvider | undefined;
  } = {}
): Promise<ExecutePlanContextCommandOptions["embedQuery"]> {
  const embeddingModel = env.ARCHON_EMBEDDING_MODEL?.trim();
  if (!embeddingModel) {
    return undefined;
  }

  const provider = options.provider ?? (await createEmbeddingProvider(env));
  return ({ model, text }) =>
    embedQueryText({
      provider,
      model,
      text
    });
}

function resolveAutoRefreshRetrievalEnabled(args: readonly string[], env: EnvShape): boolean {
  if (args.includes("--auto-refresh-retrieval")) {
    return true;
  }
  if (args.includes("--no-auto-refresh-retrieval")) {
    return false;
  }

  const candidate = env.ARCHON_AUTO_REFRESH_RETRIEVAL?.trim().toLowerCase();
  if (!candidate) {
    return false;
  }

  if (["0", "false", "no", "off"].includes(candidate)) {
    return false;
  }

  if (["1", "true", "yes", "on"].includes(candidate)) {
    return true;
  }

  return false;
}

function resolveAutoRefreshRepoContextEnabled(args: readonly string[], env: EnvShape): boolean {
  if (args.includes("--auto-refresh-repo-context")) {
    return true;
  }
  if (args.includes("--no-auto-refresh-repo-context")) {
    return false;
  }

  const candidate = env.ARCHON_AUTO_REFRESH_REPO_CONTEXT?.trim().toLowerCase();
  if (!candidate) {
    return false;
  }

  if (["0", "false", "no", "off"].includes(candidate)) {
    return false;
  }

  if (["1", "true", "yes", "on"].includes(candidate)) {
    return true;
  }

  return false;
}

function appendAutomaticRefreshDeferredSummary(summary: string, kind: "repo context" | "retrieval"): string {
  return `${summary}; automatic ${kind} refresh deferred for interactive planning`;
}

async function resolvePlanningRepoContextState(
  args: readonly string[],
  env: EnvShape,
  options: ExecutePlanContextCommandOptions
): Promise<PlanningContextRepoContextState | undefined> {
  if (!options.getRepoContext) {
    return undefined;
  }

  let repoContext = await options.getRepoContext();
  if (
    !options.refreshRepoContext ||
    !resolveAutoRefreshRepoContextEnabled(args, env) ||
    repoContext.state === "fresh"
  ) {
    if (repoContext.state === "fresh" || !options.refreshRepoContext) {
      return repoContext;
    }

    return {
      ...repoContext,
      summary: appendAutomaticRefreshDeferredSummary(repoContext.summary, "repo context")
    };
  }

  try {
    await options.refreshRepoContext();
    repoContext = await options.getRepoContext();
    if (repoContext.state === "fresh") {
      return {
        ...repoContext,
        summary: `${repoContext.summary} after automatic refresh`
      };
    }

    return repoContext;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...repoContext,
      summary: `${repoContext.summary}; automatic refresh failed: ${message}`
    };
  }
}

async function resolvePlanningRetrievalState(
  args: readonly string[],
  env: EnvShape,
  options: ExecutePlanContextCommandOptions
): Promise<PlanningContextRetrievalState | undefined> {
  if (!options.getRetrievalFreshness) {
    return undefined;
  }

  let retrieval = await options.getRetrievalFreshness();
  if (!options.refreshRetrieval || !resolveAutoRefreshRetrievalEnabled(args, env) || retrieval.state === "fresh") {
    if (retrieval.state === "fresh" || !options.refreshRetrieval) {
      return retrieval;
    }

    return {
      ...retrieval,
      summary: appendAutomaticRefreshDeferredSummary(retrieval.summary, "retrieval")
    };
  }

  try {
    await options.refreshRetrieval();
    retrieval = await options.getRetrievalFreshness();
    if (retrieval.state === "fresh") {
      return {
        ...retrieval,
        summary: `${retrieval.summary} after automatic refresh`
      };
    }

    return retrieval;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...retrieval,
      summary: `${retrieval.summary}; automatic refresh failed: ${message}`
    };
  }
}

function normalizeRecordReviewCommandInput(raw: string): RecordReviewCommandInput {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const runId = typeof parsed.runId === "string" ? parsed.runId.trim() : "";
  const taskId = typeof parsed.taskId === "string" ? parsed.taskId.trim() : "";
  const actor = typeof parsed.actor === "string" ? parsed.actor.trim() : "";
  const reviewCandidate =
    typeof parsed.review === "object" && parsed.review !== null && !Array.isArray(parsed.review)
      ? (parsed.review as Record<string, unknown>)
      : undefined;

  if (runId.length === 0) {
    throw new Error("record-review input requires runId");
  }

  if (taskId.length === 0) {
    throw new Error("record-review input requires taskId");
  }

  if (actor.length === 0) {
    throw new Error("record-review input requires actor");
  }

  if (!reviewCandidate) {
    throw new Error("record-review input requires review");
  }

  const reviewerRole =
    typeof reviewCandidate.reviewerRole === "string" ? reviewCandidate.reviewerRole.trim() : "";
  const state = typeof reviewCandidate.state === "string" ? reviewCandidate.state.trim() : "";
  const severity = typeof reviewCandidate.severity === "string" ? reviewCandidate.severity.trim() : "";
  const findings = Array.isArray(reviewCandidate.findings)
    ? reviewCandidate.findings.map((finding) => String(finding))
    : undefined;
  const waiverReason =
    typeof reviewCandidate.waiverReason === "string" ? reviewCandidate.waiverReason : undefined;

  if (!isGateReviewRole(reviewerRole)) {
    throw new Error("record-review input requires review.reviewerRole to be a required gate role");
  }

  if (!isReviewState(state)) {
    throw new Error("record-review input requires review.state to be a valid review state");
  }

  if (!isReviewSeverity(severity)) {
    throw new Error("record-review input requires review.severity to be a valid review severity");
  }

  if (!findings) {
    throw new Error("record-review input requires review.findings to be an array of strings");
  }

  return {
    runId,
    taskId,
    actor,
    review: {
      reviewerRole,
      state,
      severity,
      findings,
      waiverReason
    },
    authContext: parsed.authContext
  };
}

function resolveCommandFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function hasCommandFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function stripCommandFlag(args: readonly string[], flag: string): string[] {
  return args.filter((value) => value !== flag);
}

function resolveDaemonSupervisorHistoryReadOptions(
  args: readonly string[],
  env: EnvShape | undefined,
  defaultRunId: string
): DaemonSupervisorHistoryReadOptions {
  const limitValue =
    resolveCommandFlag(args, "--daemon-supervisor-history-limit") ??
    env?.ARCHON_DAEMON_SUPERVISOR_HISTORY_LIMIT ??
    "5";
  const limit = Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Invalid --daemon-supervisor-history-limit value: ${limitValue}`);
  }

  const scopeValue =
    resolveCommandFlag(args, "--daemon-supervisor-history-scope") ??
    env?.ARCHON_DAEMON_SUPERVISOR_HISTORY_SCOPE ??
    "run";
  if (scopeValue !== "run" && scopeValue !== "all") {
    throw new Error(`Invalid --daemon-supervisor-history-scope value: ${scopeValue}`);
  }

  const runId =
    resolveCommandFlag(args, "--daemon-supervisor-history-run-id") ??
    env?.ARCHON_DAEMON_SUPERVISOR_HISTORY_RUN_ID ??
    defaultRunId;

  return {
    limit,
    scope: scopeValue,
    runId: scopeValue === "run" ? runId : undefined
  };
}

function resolveSupervisorHistoryRetentionLimit(args: readonly string[], env: EnvShape | undefined): number {
  const retentionValue =
    resolveCommandFlag(args, "--supervisor-history-retention") ??
    env?.ARCHON_SUPERVISOR_HISTORY_RETENTION ??
    "200";
  const retentionLimit = Number.parseInt(retentionValue, 10);
  if (!Number.isInteger(retentionLimit) || retentionLimit <= 0) {
    throw new Error(`Invalid --supervisor-history-retention value: ${retentionValue}`);
  }
  return retentionLimit;
}

async function resolveActiveTaskIdFromFile(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const activeContent = await readFile(path.join(cwd, ".archon", "ACTIVE"), "utf8");
    const taskIdLine = activeContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("task_id="));

    if (!taskIdLine) {
      return undefined;
    }

    const taskId = taskIdLine.slice("task_id=".length).trim();
    return taskId.length > 0 ? taskId : undefined;
  } catch {
    return undefined;
  }
}

async function readActiveWorkflowExport(cwd = process.cwd()): Promise<{
  activeState: "active" | "idle" | "complete" | "unknown";
  activeTaskId: string | null;
}> {
  try {
    const activeContent = await readFile(path.join(cwd, ".archon", "ACTIVE"), "utf8");
    const lines = activeContent.split(/\r?\n/).map((line) => line.trim());
    const taskIdLine = lines.find((line) => line.startsWith("task_id="));
    const stateLine = lines.find((line) => line.startsWith("state="));
    const activeTaskId = taskIdLine ? taskIdLine.slice("task_id=".length).trim() || null : null;
    const rawState = stateLine ? stateLine.slice("state=".length).trim().toLowerCase() : "";
    const activeState =
      rawState === "active" || rawState === "idle" || rawState === "complete" ? rawState : "unknown";
    return {
      activeState,
      activeTaskId
    };
  } catch {
    return {
      activeState: "unknown",
      activeTaskId: null
    };
  }
}

async function readTaskQueueExport(cwd = process.cwd()): Promise<TaskQueue> {
  try {
    const queueContent = await readFile(path.join(cwd, ".archon", "work", "task-queue.json"), "utf8");
    return parseTaskQueueContent(queueContent);
  } catch {
    return buildDefaultTaskQueue();
  }
}

function readSeedFailureMetadata(
  runtimeState:
    | {
        metadata?: Record<string, unknown> | undefined;
        lastVerifiedRunId?: string | null | undefined;
      }
    | undefined
):
  | {
      runId: string;
      taskId: string;
      reason: string;
      failedAt?: string | undefined;
      recoveryState: "requires_reproof" | "stale_metadata";
    }
  | undefined {
  const candidate = runtimeState?.metadata?.seedFailure;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  if (
    typeof record.runId !== "string" ||
    typeof record.taskId !== "string" ||
    typeof record.reason !== "string"
  ) {
    return undefined;
  }

  return {
    runId: record.runId,
    taskId: record.taskId,
    reason: record.reason,
    failedAt: typeof record.failedAt === "string" ? record.failedAt : undefined,
    recoveryState: runtimeState?.lastVerifiedRunId ? "stale_metadata" : "requires_reproof"
  };
}

function readLastIntegrityRepairMetadata(
  runtimeState:
    | {
        metadata?: Record<string, unknown> | undefined;
      }
    | undefined
):
  | {
      source: "doctor_repair" | "recover_apply" | "reconcile_runtime_state" | "sync_runtime_exports";
      kind:
        | "local_export_resync"
        | "runtime_metadata_cleanup"
        | "runtime_task_reconcile"
        | "recovery_action_apply";
      summary: string;
      repairedAt: string;
    }
  | undefined {
  const candidate = runtimeState?.metadata?.lastIntegrityRepair;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  if (
    (record.source !== "doctor_repair" &&
      record.source !== "recover_apply" &&
      record.source !== "reconcile_runtime_state" &&
      record.source !== "sync_runtime_exports") ||
    (record.kind !== "local_export_resync" &&
      record.kind !== "runtime_metadata_cleanup" &&
      record.kind !== "runtime_task_reconcile" &&
      record.kind !== "recovery_action_apply") ||
    typeof record.summary !== "string" ||
    typeof record.repairedAt !== "string"
  ) {
    return undefined;
  }

  return {
    source: record.source,
    kind: record.kind,
    summary: record.summary,
    repairedAt: record.repairedAt
  };
}

function hasLocalWorkflowExportDrift(input: {
  runtimeState: {
    activeTaskId: string | null;
    projectStatus: string;
  };
  localExports:
    | {
        activeState: "active" | "idle" | "complete" | "unknown";
        activeTaskId: string | null;
        queueProjectStatus: string;
        queueCurrentTaskId: string | null;
      }
    | undefined;
}): boolean {
  const expectedActiveState =
    input.runtimeState.activeTaskId !== null
      ? "active"
      : isCompleteProjectStatus(input.runtimeState.projectStatus)
        ? "complete"
        : "idle";

  if (!input.localExports) {
    return true;
  }

  return (
    input.localExports.activeState !== expectedActiveState ||
    (input.localExports.activeTaskId ?? null) !== input.runtimeState.activeTaskId ||
    (input.localExports.queueCurrentTaskId ?? null) !== input.runtimeState.activeTaskId ||
    input.localExports.queueProjectStatus !== input.runtimeState.projectStatus
  );
}

function clearSeedFailureMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata || !("seedFailure" in metadata)) {
    return metadata ?? {};
  }

  const { seedFailure: _seedFailure, ...rest } = metadata;
  return rest;
}

function withLastIntegrityRepairMetadata(
  metadata: Record<string, unknown> | undefined,
  input: {
    source: "doctor_repair" | "recover_apply" | "reconcile_runtime_state" | "sync_runtime_exports";
    kind:
      | "local_export_resync"
      | "runtime_metadata_cleanup"
      | "runtime_task_reconcile"
      | "recovery_action_apply";
    summary: string;
  }
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    lastIntegrityRepair: {
      source: input.source,
      kind: input.kind,
      summary: input.summary,
      repairedAt: new Date().toISOString()
    }
  };
}

async function clearStaleSeedFailureRuntimeMetadata(input: {
  report: DoctorCommandReport;
  options: ExecuteDoctorRepairCommandOptions;
}): Promise<boolean> {
  if (!input.options.getProjectRuntimeState || !input.options.saveProjectRuntimeState) {
    return false;
  }

  const runtimeState = await input.options.getProjectRuntimeState(input.report.project.projectId);
  if (!runtimeState?.metadata?.seedFailure || !runtimeState.lastVerifiedRunId) {
    return false;
  }

  await input.options.saveProjectRuntimeState({
    ...runtimeState,
    metadata: withLastIntegrityRepairMetadata(clearSeedFailureMetadata(runtimeState.metadata), {
      source: "doctor_repair",
      kind: "runtime_metadata_cleanup",
      summary: "cleared stale persisted seed failure metadata after authoritative proof"
    }),
    updatedAt: new Date().toISOString()
  });
  return true;
}

async function persistIntegrityRepairRuntimeMetadata(input: {
  report: DoctorCommandReport;
  options: ExecuteDoctorRepairCommandOptions;
  source: "doctor_repair" | "recover_apply" | "reconcile_runtime_state" | "sync_runtime_exports";
  kind:
    | "local_export_resync"
    | "runtime_metadata_cleanup"
    | "runtime_task_reconcile"
    | "recovery_action_apply";
  summary: string;
}): Promise<boolean> {
  if (!input.options.getProjectRuntimeState || !input.options.saveProjectRuntimeState) {
    return false;
  }

  const runtimeState = await input.options.getProjectRuntimeState(input.report.project.projectId);
  if (!runtimeState) {
    return false;
  }

  await input.options.saveProjectRuntimeState({
    ...runtimeState,
    metadata: withLastIntegrityRepairMetadata(runtimeState.metadata, {
      source: input.source,
      kind: input.kind,
      summary: input.summary
    }),
    updatedAt: new Date().toISOString()
  });
  return true;
}

async function persistRecoverIntegrityRepairMetadata(input: {
  runId: string;
  options: ExecuteRecoverCommandOptions;
  appliedActionIds: readonly string[];
}): Promise<boolean> {
  if (
    input.appliedActionIds.length === 0 ||
    !input.options.getStatusSnapshot ||
    !input.options.getProjectRuntimeState ||
    !input.options.saveProjectRuntimeState
  ) {
    return false;
  }

  const snapshot = await input.options.getStatusSnapshot(input.runId);
  const runtimeState = await input.options.getProjectRuntimeState(snapshot.run.projectId);
  if (!runtimeState) {
    return false;
  }

  await input.options.saveProjectRuntimeState({
    ...runtimeState,
    metadata: withLastIntegrityRepairMetadata(runtimeState.metadata, {
      source: "recover_apply",
      kind: "recovery_action_apply",
      summary: `recover applied safe runtime recovery actions: ${input.appliedActionIds.join(", ")}`
    }),
    updatedAt: new Date().toISOString()
  });
  return true;
}

async function persistProjectIntegrityRepairMetadata(input: {
  projectId: string;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  saveProjectRuntimeState: (state: ProjectRuntimeStateRecord) => Promise<void>;
  source: "doctor_repair" | "recover_apply" | "reconcile_runtime_state" | "sync_runtime_exports";
  kind:
    | "local_export_resync"
    | "runtime_metadata_cleanup"
    | "runtime_task_reconcile"
    | "recovery_action_apply";
  summary: string;
}): Promise<boolean> {
  const runtimeState = await input.getProjectRuntimeState(input.projectId);
  if (!runtimeState) {
    return false;
  }

  await input.saveProjectRuntimeState({
    ...runtimeState,
    metadata: withLastIntegrityRepairMetadata(runtimeState.metadata, {
      source: input.source,
      kind: input.kind,
      summary: input.summary
    }),
    updatedAt: new Date().toISOString()
  });
  return true;
}

function buildDefaultTaskQueue(): TaskQueue {
  return {
    project_status: "idle",
    current_task_id: null,
    tasks: []
  };
}

function buildDefaultProductState(): Record<string, unknown> {
  return {
    status: "idle",
    items: []
  };
}

function parseTaskQueueRecord(candidate: TaskQueue | Record<string, unknown> | undefined): TaskQueue {
  return parseTaskQueueContent(JSON.stringify(candidate ?? buildDefaultTaskQueue()));
}

function parseTaskQueueRecordOrDefault(candidate: TaskQueue | Record<string, unknown> | undefined): TaskQueue {
  try {
    return parseTaskQueueRecord(candidate);
  } catch {
    return buildDefaultTaskQueue();
  }
}

function mapSnapshotTaskStatusToQueueStatus(status: TaskStatus): TaskQueue["tasks"][number]["status"] {
  switch (status) {
    case "ready":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "approved":
    case "done":
      return "done";
    case "blocked":
    case "review_blocked":
      return "blocked";
  }
}

function mapSnapshotTaskPacketToQueueClass(packet: TaskPacketInput): TaskQueue["tasks"][number]["class"] {
  if (packet.qualityGates.includes("release_readiness_required")) {
    return "release_candidate";
  }

  if (packet.qualityGates.includes("product_acceptance")) {
    return "prototype_slice";
  }

  return "docs_only";
}

function buildAuthoritativeTaskQueueFromSnapshot(
  snapshot: RunStatusSnapshot,
  activeTaskId: string | null
): TaskQueue {
  return {
    project_status: snapshot.run.status,
    current_task_id: activeTaskId,
    tasks: snapshot.tasks.map((task) => ({
      id: task.packet.taskId,
      title: task.packet.title,
      status: mapSnapshotTaskStatusToQueueStatus(task.status),
      class: mapSnapshotTaskPacketToQueueClass(task.packet),
      depends_on: [...task.packet.dependencies],
      acceptance_criteria: [...task.packet.acceptanceCriteria],
      verification: [...task.packet.verificationSteps],
      evidence: deriveTaskQueueEvidence({
        taskId: task.packet.taskId,
        verification: task.packet.verificationSteps,
        qualityGates: task.packet.qualityGates
      }),
      blocker:
        task.status === "blocked"
          ? "runtime task blocked"
          : task.status === "review_blocked"
            ? "awaiting required reviews"
            : null
    }))
  };
}

function alignQueueToActiveTask(
  candidate: TaskQueue | Record<string, unknown> | undefined,
  taskId: string
): TaskQueue {
  const queue = parseTaskQueueRecord(candidate);
  const existingTask = queue.tasks.find((task) => task.id === taskId);

  const tasks = existingTask
    ? queue.tasks.map((task) =>
        task.id === taskId
      ? {
          ...task,
          status: "in_progress" as const,
          blocker: null
        }
          : task
      )
    : [
        ...queue.tasks,
        {
          id: taskId,
          title: taskId,
          status: "in_progress" as const,
          class: "release_candidate" as const,
          depends_on: [],
          acceptance_criteria: ["runtime active task must align with the task packet before completion"],
          verification: ["runtime reconciliation required before queue advancement"],
          evidence: ["runtime synthesized active-task export"],
          blocker: null
        }
      ];

  return {
    project_status: "in_progress",
    current_task_id: taskId,
    tasks
  };
}

function readDaemonSessionId(metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined): string | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const sessionId = (candidate as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : undefined;
}

function readDaemonPromptMetadata(
  metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined
): DaemonPromptMetadata | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const taskId =
    typeof record.lastPromptTaskId === "string" && record.lastPromptTaskId.trim().length > 0
      ? record.lastPromptTaskId.trim()
      : undefined;
  const packetFingerprint =
    typeof record.lastPromptPacketFingerprint === "string" && record.lastPromptPacketFingerprint.trim().length > 0
      ? record.lastPromptPacketFingerprint.trim()
      : undefined;

  if (!taskId && !packetFingerprint) {
    return undefined;
  }

  return {
    taskId,
    packetFingerprint
  };
}

function readDaemonStagnationMetadata(
  metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined
): DaemonStagnationMetadata | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const stagnation = (candidate as Record<string, unknown>).stagnation;
  if (!stagnation || typeof stagnation !== "object" || Array.isArray(stagnation)) {
    return undefined;
  }

  const record = stagnation as Record<string, unknown>;
  const runId = typeof record.runId === "string" && record.runId.trim().length > 0 ? record.runId.trim() : undefined;
  const taskId = typeof record.taskId === "string" && record.taskId.trim().length > 0 ? record.taskId.trim() : undefined;
  const directiveKind =
    record.directiveKind === "complete" ||
    record.directiveKind === "dispatch_owner" ||
    record.directiveKind === "dispatch_reviews" ||
    record.directiveKind === "apply_recovery" ||
    record.directiveKind === "dispatch_subagents" ||
    record.directiveKind === "rebuild_inventory" ||
    record.directiveKind === "trace_runtime" ||
    record.directiveKind === "checkpoint" ||
    record.directiveKind === "replan_migration" ||
    record.directiveKind === "continue_analysis" ||
    record.directiveKind === "blocked"
      ? record.directiveKind
      : undefined;
  const progressKey =
    typeof record.progressKey === "string" && record.progressKey.trim().length > 0 ? record.progressKey.trim() : undefined;
  const count = typeof record.count === "number" && Number.isInteger(record.count) && record.count > 0 ? record.count : undefined;
  if (!runId || !taskId || !directiveKind || !progressKey || !count) {
    return undefined;
  }

  const status =
    record.lastStatus === "completed" ||
    record.lastStatus === "blocked" ||
    record.lastStatus === "needs_review" ||
    record.lastStatus === "needs_followup"
      ? record.lastStatus
      : undefined;

  return {
    runId,
    taskId,
    directiveKind,
    progressKey,
    count,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    lastStatus: status,
    lastSummary: typeof record.lastSummary === "string" ? record.lastSummary : undefined,
    lastBlockers: Array.isArray(record.lastBlockers)
      ? record.lastBlockers.filter((value): value is string => typeof value === "string")
      : undefined
  };
}

function parseDaemonTurnMessage(message: string | undefined): ParsedDaemonTurnMessage | undefined {
  if (!message) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : undefined;
    const status =
      parsed.status === "completed" ||
      parsed.status === "blocked" ||
      parsed.status === "needs_review" ||
      parsed.status === "needs_followup"
        ? parsed.status
        : undefined;
    const blockers = Array.isArray(parsed.blockers)
      ? parsed.blockers.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const scopeRequestCandidate =
      parsed.scope_request && typeof parsed.scope_request === "object" && !Array.isArray(parsed.scope_request)
        ? (parsed.scope_request as Record<string, unknown>)
        : undefined;
    const blockedPaths = Array.isArray(scopeRequestCandidate?.blocked_paths)
      ? scopeRequestCandidate.blocked_paths.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const requestedWriteScope = Array.isArray(scopeRequestCandidate?.requested_write_scope)
      ? scopeRequestCandidate.requested_write_scope.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointCandidate =
      parsed.checkpoint && typeof parsed.checkpoint === "object" && !Array.isArray(parsed.checkpoint)
        ? (parsed.checkpoint as Record<string, unknown>)
        : undefined;
    const checkpointEvidenceRefs = Array.isArray(checkpointCandidate?.evidence_refs)
      ? checkpointCandidate.evidence_refs.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointNextActions = Array.isArray(checkpointCandidate?.next_actions)
      ? checkpointCandidate.next_actions.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointActiveTargets = Array.isArray(checkpointCandidate?.active_targets)
      ? checkpointCandidate.active_targets.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointOpenGaps = Array.isArray(checkpointCandidate?.open_gaps)
      ? checkpointCandidate.open_gaps.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointCompressedContextSourceRefs = Array.isArray(checkpointCandidate?.compressed_context_source_refs)
      ? checkpointCandidate.compressed_context_source_refs.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpoint =
      checkpointCandidate && checkpointEvidenceRefs.length > 0
        ? {
            evidenceRefs: checkpointEvidenceRefs,
            nextActions: checkpointNextActions,
            activeTargets: checkpointActiveTargets,
            openGaps: checkpointOpenGaps,
            compressedContextSummary:
              typeof checkpointCandidate.compressed_context_summary === "string" &&
                checkpointCandidate.compressed_context_summary.trim().length > 0
                ? checkpointCandidate.compressed_context_summary.trim()
                : undefined,
            compressedContextRef:
              typeof checkpointCandidate.compressed_context_ref === "string" &&
                checkpointCandidate.compressed_context_ref.trim().length > 0
                ? checkpointCandidate.compressed_context_ref.trim()
                : undefined,
            compressedContextSourceRefs: checkpointCompressedContextSourceRefs
          }
        : undefined;
    const scopeRequest =
      blockedPaths.length > 0 || requestedWriteScope.length > 0
        ? {
            blockedPaths,
            requestedWriteScope,
            reason:
              typeof scopeRequestCandidate?.reason === "string" && scopeRequestCandidate.reason.trim().length > 0
                ? scopeRequestCandidate.reason.trim()
                : undefined
          }
        : undefined;

    if (!summary || !status) {
      return undefined;
    }

    return {
      summary,
      status,
      blockers,
      checkpoint,
      scopeRequest
    };
  } catch {
    return undefined;
  }
}

function buildDirectiveProgressFingerprint(directive: RunExecutionPlan["directive"]): string {
  if (directive.kind === "dispatch_owner") {
    return JSON.stringify({
      kind: directive.kind,
      taskId: directive.recommendation.taskId,
      targetRole: directive.recommendation.targetRole
    });
  }

  if (directive.kind === "dispatch_reviews") {
    return JSON.stringify({
      kind: directive.kind,
      targets: directive.recommendations.map((recommendation) => ({
        taskId: recommendation.taskId,
        reviewRole: recommendation.targetReviewRole
      }))
    });
  }

  if (directive.kind === "continue_analysis") {
    return JSON.stringify({
      kind: directive.kind,
      targetId: directive.targetId,
      source: directive.source,
      actions: directive.actions.map((action) => action.kind),
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "blocked") {
    return JSON.stringify({
      kind: directive.kind,
      blockers: directive.blockers
    });
  }

  if (directive.kind === "apply_recovery") {
    return JSON.stringify({
      kind: directive.kind,
      actions: directive.actions.map((action) => action.id)
    });
  }

  if (directive.kind === "dispatch_subagents") {
    return JSON.stringify({
      kind: directive.kind,
      pendingInvestigations: directive.pendingInvestigations,
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "rebuild_inventory") {
    return JSON.stringify({
      kind: directive.kind,
      missingUnderstandingKinds: directive.missingUnderstandingKinds,
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "trace_runtime") {
    return JSON.stringify({
      kind: directive.kind,
      targetIds: directive.targetIds,
      gapIds: directive.gapIds,
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "checkpoint") {
    return JSON.stringify({
      kind: directive.kind,
      checkpointId: directive.checkpointId ?? null,
      progressProofId: directive.progressProofId ?? null,
      nextActions: directive.nextActions
    });
  }

  if (directive.kind === "replan_migration") {
    return JSON.stringify({
      kind: directive.kind,
      phase: directive.phase,
      fallbackPhase: directive.fallbackPhase ?? null,
      nextActions: directive.nextActions
    });
  }

  return JSON.stringify({ kind: directive.kind });
}

function buildDaemonProgressKey(input: {
  runtimeState: ProjectRuntimeStateRecord | undefined;
  snapshot: RunStatusSnapshot;
  directive: RunExecutionPlan["directive"];
  activeTaskId: string;
}): string {
  const activeTask = input.snapshot.tasks.find((task) => task.packet.taskId === input.activeTaskId);
  return JSON.stringify({
    runtimeActiveRunId: input.runtimeState?.activeRunId ?? null,
    runtimeActiveTaskId: input.runtimeState?.activeTaskId ?? null,
    runStatus: input.snapshot.run.status,
    activeTaskStatus: activeTask?.status ?? null,
    activeTaskUpdatedAt: activeTask?.updatedAt ?? null,
    autonomousUpdatedAt: input.snapshot.autonomousExecution?.state.updatedAt ?? null,
    lastCheckpointId: input.snapshot.autonomousExecution?.state.lastCheckpointId ?? null,
    lastProgressProofId: input.snapshot.autonomousExecution?.state.lastProgressProofId ?? null,
    directive: buildDirectiveProgressFingerprint(input.directive)
  });
}

async function persistDaemonTurnCheckpoint(input: {
  runId: string;
  taskId: string;
  snapshot: RunStatusSnapshot;
  message: ParsedDaemonTurnMessage | undefined;
  checkpointRun?: ExecuteDaemonCommandOptions["checkpointRun"];
  now: () => Date;
}): Promise<string | undefined> {
  if (
    !input.message?.checkpoint ||
    !input.checkpointRun ||
    (input.message.status !== "needs_followup" && input.message.status !== "needs_review")
  ) {
    return undefined;
  }

  const createdAt = input.now().toISOString();
  const checkpointId = `cp-daemon-${input.taskId}-${createdAt.replace(/[:.]/g, "-")}`;
  const phase: CheckpointRecord["phase"] = input.snapshot.autonomousExecution?.state.phase ?? "implementation";
  const checkpoint = input.message.checkpoint;

  await input.checkpointRun(
    input.runId,
    {
      checkpointId,
      phase,
      activeTargets: [...checkpoint.activeTargets],
      recentEvidenceRefs: [...checkpoint.evidenceRefs],
      openGaps: [...checkpoint.openGaps],
      nextActions:
        checkpoint.nextActions.length > 0 ? [...checkpoint.nextActions] : [`continue ${input.taskId}`],
      compressedContextRef: checkpoint.compressedContextRef,
      compressedContextSummary: checkpoint.compressedContextSummary ?? input.message.summary,
      compressedContextSourceRefs:
        checkpoint.compressedContextSourceRefs.length > 0
          ? [...checkpoint.compressedContextSourceRefs]
          : [...checkpoint.evidenceRefs],
      createdAt
    },
    {
      authorityLabel: "runtime_authoritative"
    }
  );

  return checkpointId;
}

function daemonMessageHasScopeConflict(message: ParsedDaemonTurnMessage | undefined): boolean {
  if (!message) {
    return false;
  }

  const combined = [message.summary, ...message.blockers].join("\n");
  return /\bout of scope\b|\bwrite scope\b|\bscope mismatch\b|\boutside the allowed scope\b/i.test(combined);
}

async function withDaemonLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  const lockPath = path.join(daemonDir, "daemon.lock");
  await mkdir(daemonDir, { recursive: true });

  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`archon daemon lock already exists: ${path.relative(cwd, lockPath)}`);
    }
    throw error;
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function runCodexTurnViaCli(input: RunCodexTurnInput): Promise<RunCodexTurnResult> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "archon-daemon-schema-"));
  const schemaPath = path.join(tempDir, "daemon-output.schema.json");
  await writeFile(
    schemaPath,
    JSON.stringify(
      {
        type: "object",
        properties: {
          summary: { type: "string" },
          status: {
            type: "string",
            enum: ["completed", "blocked", "needs_review", "needs_followup"]
          },
          blockers: {
            type: "array",
            items: { type: "string" }
          },
          checkpoint: {
            type: "object",
            properties: {
              evidence_refs: {
                type: "array",
                items: { type: "string" }
              },
              next_actions: {
                type: "array",
                items: { type: "string" }
              },
              active_targets: {
                type: "array",
                items: { type: "string" }
              },
              open_gaps: {
                type: "array",
                items: { type: "string" }
              },
              compressed_context_summary: { type: "string" },
              compressed_context_ref: { type: "string" },
              compressed_context_source_refs: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["evidence_refs"],
            additionalProperties: false
          },
          scope_request: {
            type: "object",
            properties: {
              blocked_paths: {
                type: "array",
                items: { type: "string" }
              },
              requested_write_scope: {
                type: "array",
                items: { type: "string" }
              },
              reason: { type: "string" }
            },
            required: ["blocked_paths", "requested_write_scope"],
            additionalProperties: false
          }
        },
        required: ["summary", "status", "blockers"],
        additionalProperties: false
      },
      null,
      2
    ),
    "utf8"
  );

  const args = input.sessionId
    ? ["exec", "resume", input.sessionId, input.prompt, "--json", "--output-schema", schemaPath]
    : ["exec", input.prompt, "--json", "--output-schema", schemaPath];

  try {
    const child = spawn(input.claudeBin, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    let sessionId = input.sessionId;
    let finalMessage: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
          sessionId = parsed.thread_id;
        }
        if (parsed.type === "item.completed") {
          const item = parsed.item;
          if (item && typeof item === "object" && (item as Record<string, unknown>).type === "agent_message") {
            const text = (item as Record<string, unknown>).text;
            if (typeof text === "string" && text.trim().length > 0) {
              finalMessage = text.trim();
            }
          }
        }
      } catch {
        // Ignore non-JSONL or partial lines; the daemon only needs best-effort session/message extraction.
      }
    }

    if (exitCode !== 0) {
      const reason = stderr.trim() || stdout.trim() || `codex exited with code ${exitCode}`;
      throw new Error(`codex exec failed: ${reason}`);
    }

    return {
      sessionId,
      finalMessage,
      stdout,
      stderr,
      exitCode
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function buildDaemonTaskPacketFingerprint(packet: TaskPacketInput | undefined): string | undefined {
  if (!packet) {
    return undefined;
  }

  const fingerprintSource = {
    taskId: packet.taskId,
    goal: packet.goal ?? null,
    allowedWriteScope: packet.allowedWriteScope ?? [],
    acceptanceCriteria: packet.acceptanceCriteria ?? [],
    verificationSteps: packet.verificationSteps ?? [],
    requiredReviews: packet.requiredReviews ?? []
  };

  return createHash("sha256").update(JSON.stringify(fingerprintSource)).digest("hex");
}

export function determineDaemonPromptMode(input: {
  sessionId?: string | undefined;
  previousTaskId?: string | undefined;
  previousPacketFingerprint?: string | undefined;
  taskId: string;
  packetFingerprint?: string | undefined;
}): DaemonPromptMode {
  if (!input.sessionId || !input.packetFingerprint) {
    return "full";
  }

  if (
    input.previousTaskId === input.taskId &&
    input.previousPacketFingerprint === input.packetFingerprint
  ) {
    return "delta";
  }

  return "full";
}

export function buildDaemonTaskPrompt(input: {
  promptMode: DaemonPromptMode;
  directive: DaemonPromptDirective;
  taskId: string;
  packet?: TaskPacketInput | undefined;
  operatorNotes?: string | undefined;
  compressedContextSummary?: string | undefined;
  compressedContextRef?: string | undefined;
}): string {
  const packet = input.packet;
  const baseLines = [
    input.promptMode === "delta"
      ? "Continue the active archon worker session for the current task."
      : "Operate as the active archon worker for the current task.",
    `Active task: ${input.taskId}`,
    `Directive: ${input.directive.kind}`,
    packet?.goal ? `Goal: ${packet.goal}` : undefined,
    packet?.allowedWriteScope?.length ? `Allowed write scope: ${packet.allowedWriteScope.join(", ")}` : undefined
  ];

  const detailLines =
    input.promptMode === "full"
      ? [
          packet?.acceptanceCriteria?.length
            ? `Acceptance criteria: ${packet.acceptanceCriteria.join(" | ")}`
            : undefined,
          packet?.verificationSteps?.length
            ? `Verification steps: ${packet.verificationSteps.join(" | ")}`
            : undefined,
          packet?.requiredReviews?.length
            ? `Required reviews: ${packet.requiredReviews.join(", ")}`
            : undefined
        ]
      : [
          "Previously bootstrapped task requirements remain in force unless explicitly updated below.",
          input.compressedContextSummary
            ? `Compressed context: ${input.compressedContextSummary}`
            : undefined,
          input.compressedContextRef ? `Compressed context ref: ${input.compressedContextRef}` : undefined
        ];

  const guidanceLines = [
    "Follow the repository CLAUDE.md and the archon workflow.",
    "Use runtime-backed archon commands when they are needed for proof, status, or advancement.",
    "Scale, latency, or item volume are not blockers by themselves when the task can be chunked and resumed.",
    "If you make tractable progress without finishing, return status needs_followup and include checkpoint.evidence_refs plus a compressed checkpoint summary so the daemon can persist progress and continue.",
    input.promptMode === "delta"
      ? "If scope blocks the next required edit, stop immediately and return the minimum safe scope_request delta."
      : "If a required edit falls outside the allowed write scope, stop immediately, name the exact blocked paths, and include a scope_request with blocked_paths, requested_write_scope, and a short reason describing the minimum safe scope expansion.",
    "Do not spend another turn repeating the same blocked attempt when runtime state has not changed.",
    "Complete the task if possible; otherwise stop at the real blocker and state it explicitly.",
    input.operatorNotes ? `Operator notes: ${input.operatorNotes}` : undefined,
    input.directive.kind === "continue_analysis"
      ? `Autonomous target: ${input.directive.targetId}. Typed continuation actions: ${input.directive.actions.map(formatContinuationAction).join(" | ")}`
      : undefined,
    input.directive.kind === "dispatch_owner"
      ? `Owner rationale: ${input.directive.rationale.join(" | ")}`
      : undefined
  ];

  const lines = [...baseLines, ...detailLines, ...guidanceLines].filter(
    (value): value is string => Boolean(value)
  );

  return lines.join("\n");
}

function formatContinuationAction(action: DaemonPromptContinuationAction): string {
  if (action.kind === "run_workflow_proof") {
    return `run_workflow_proof(${action.taskId})`;
  }
  if (action.kind === "resolve_blocking_gap") {
    return `resolve_blocking_gap(${action.gapId} -> ${action.targetId})`;
  }
  return `resume_target(${action.targetId})`;
}

function resolveDaemonWorkflowProofTaskId(
  directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>
): string | undefined {
  const workflowProofAction = directive.actions.find(
    (action): action is Extract<ContinuationAction, { kind: "run_workflow_proof" }> =>
      action.kind === "run_workflow_proof"
  );
  return workflowProofAction?.taskId;
}

function collectCommandFlagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`${flag} requires a value`);
    }
    values.push(value);
    index += 1;
  }

  return values;
}

function collectCommandFreeText(
  args: readonly string[],
  options: {
    valueFlags?: readonly string[] | undefined;
    booleanFlags?: readonly string[] | undefined;
  } = {}
): string {
  const valueFlags = new Set(options.valueFlags ?? []);
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const tokens: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (booleanFlags.has(value)) {
      continue;
    }
    tokens.push(value);
  }

  return tokens.join(" ").trim();
}

async function resolveRunIdForCommand(
  args: readonly string[],
  options: {
    env?: EnvShape | undefined;
    findLatestRun?: ((workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>) | undefined;
  }
): Promise<string> {
  const env = options.env ?? process.env;
  const runId = resolveCommandFlag(args, "--run-id");
  if (runId && runId !== "latest") {
    return runId;
  }

  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug || !options.findLatestRun) {
    throw new Error("status-like commands require --run-id <run-id> or --run-id latest with workspace/project");
  }

  const latestRun = await options.findLatestRun(workspaceSlug, projectSlug);
  if (!latestRun) {
    throw new Error(`No runs found for ${workspaceSlug}/${projectSlug}`);
  }

  return latestRun.id;
}

function resolveFormatFlag(args: readonly string[]): "json" | "text" {
  const format = resolveCommandFlag(args, "--format") ?? "json";
  if (format !== "json" && format !== "text") {
    throw new Error(`Invalid --format value: ${format}`);
  }
  return format;
}

function resolveMarkdownFormatFlag(args: readonly string[]): "json" | "markdown" {
  const format = resolveCommandFlag(args, "--format") ?? "json";
  if (format !== "json" && format !== "markdown") {
    throw new Error(`Invalid --format value: ${format}`);
  }
  return format;
}

async function readRecordReviewCommandInput(
  args: readonly string[],
  options: {
    cwd?: string | undefined;
  } = {}
): Promise<RecordReviewCommandInput> {
  const cwd = options.cwd ?? process.cwd();
  const inputArg = resolveCommandFlag(args, "--input");
  if (!inputArg) {
    throw new Error("record-review requires --input <file.json>");
  }

  const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(cwd, inputArg);
  return normalizeRecordReviewCommandInput(await readFile(inputPath, "utf8"));
}

async function resolveRequiredReviewIdentityFilePath(options: {
  envVarName: string;
  envVarValue: string | undefined;
  liveRelativePath: string;
  cwd?: string | undefined;
}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const filePath = options.envVarValue
    ? path.isAbsolute(options.envVarValue)
      ? options.envVarValue
      : path.resolve(cwd, options.envVarValue)
    : path.resolve(cwd, options.liveRelativePath);

  try {
    await access(filePath);
  } catch {
    throw new Error(`${options.envVarName} or ${options.liveRelativePath} is required for live review actions`);
  }

  return filePath;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function bindingValueContainsPlaceholder(value: string): boolean {
  return /replace-with-/i.test(value);
}

async function bindingsUsePlaceholderContent(bindingsPath: string): Promise<boolean> {
  const bindings = await loadReviewIdentityBindings(bindingsPath);
  return bindings.bindings.some((binding) => {
    if (
      bindingValueContainsPlaceholder(binding.principal.provider) ||
      bindingValueContainsPlaceholder(binding.principal.subject)
    ) {
      return true;
    }

    return binding.actors.some((actor) => {
      if (bindingValueContainsPlaceholder(actor.actor)) {
        return true;
      }

      return actor.roles.some((role) => bindingValueContainsPlaceholder(role));
    });
  });
}

export async function inspectReviewIdentityStatus(options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): Promise<ReviewIdentityStatusObservation> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const adapterModulePath = env.ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE
    ? path.isAbsolute(env.ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE)
      ? env.ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE
      : path.resolve(cwd, env.ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE)
    : undefined;
  const bindingsPath = env.ARCHON_REVIEW_IDENTITY_BINDINGS
    ? path.isAbsolute(env.ARCHON_REVIEW_IDENTITY_BINDINGS)
      ? env.ARCHON_REVIEW_IDENTITY_BINDINGS
      : path.resolve(cwd, env.ARCHON_REVIEW_IDENTITY_BINDINGS)
    : path.resolve(cwd, ".archon/review-identity-bindings.json");
  const adapterConfigured = adapterModulePath !== undefined;
  const adapterExists = adapterModulePath ? await pathExists(adapterModulePath) : false;
  const bindingsPresent = await pathExists(bindingsPath);
  const bindingsUseShippedTemplate = isRepoTemplateReviewIdentityPath(bindingsPath);
  const notes: string[] = [];
  let bindingsUsePlaceholderTemplate = false;
  let bindingsInvalid = false;
  let selectedBackend: string | undefined;
  let availableBackends: string[] = [];

  if (!adapterConfigured) {
    notes.push("adapter module not configured");
  } else if (!adapterExists) {
    notes.push("adapter module path does not exist");
  } else {
    try {
      availableBackends = await inspectReviewIdentityAdapterBackends(adapterModulePath);
      const loaded = await loadConfiguredReviewIdentityAdapter({
        cwd,
        env
      });
      selectedBackend = loaded.selectedBackend;
      availableBackends = loaded.availableBackends;
      if (availableBackends.length > 1 && !selectedBackend) {
        notes.push("multiple review backends are available but none is selected");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (availableBackends.length > 1 && !selectedBackend) {
        notes.push("multiple review backends are available but none is selected");
      }
      notes.push(`review identity adapter module is invalid: ${message}`);
    }
  }

  if (bindingsPresent && !bindingsUseShippedTemplate) {
    try {
      bindingsUsePlaceholderTemplate = await bindingsUsePlaceholderContent(bindingsPath);
    } catch {
      bindingsInvalid = true;
    }
  }

  if (!bindingsPresent) {
    notes.push("review identity bindings file missing");
  } else if (bindingsUseShippedTemplate) {
    notes.push("bindings path resolves to the shipped template, not a live reviewed file");
  } else if (bindingsInvalid) {
    notes.push("review identity bindings file is invalid and cannot be trusted");
  } else if (bindingsUsePlaceholderTemplate) {
    notes.push("bindings file still contains shipped placeholder values and is not live-trust-ready");
  }

  return {
    authorityLabel: "derived_only",
    adapterConfigured,
    adapterExists,
    adapterModulePath,
    selectedBackend,
    availableBackends,
    bindingsPresent,
    bindingsPath,
    bindingsUseShippedTemplate,
    liveTrustReady:
      adapterConfigured &&
      adapterExists &&
      bindingsPresent &&
      !bindingsUseShippedTemplate &&
      !bindingsUsePlaceholderTemplate &&
      !(availableBackends.length > 1 && !selectedBackend) &&
      !bindingsInvalid,
    notes
  };
}

export async function executeRecordReviewCommand(
  command: RecordReviewCommandInput,
  options: ExecuteRecordReviewCommandOptions
): Promise<RecordReviewCommandResult> {
  if (isRepoTemplateReviewIdentityPath(options.bindingsPath)) {
    throw new Error("record-review requires a live reviewed bindings file, not the shipped template");
  }

  if (await bindingsUsePlaceholderContent(options.bindingsPath)) {
    throw new Error("record-review requires reviewed bindings without shipped placeholder values");
  }

  const bindings = await loadReviewIdentityBindings(options.bindingsPath);
  const authenticate = createReviewPrincipalAdapter(options.adapter);
  const principal = await authenticate({
    runId: command.runId,
    taskId: command.taskId,
    actor: command.actor,
    reviewerRole: command.review.reviewerRole,
    reviewState: command.review.state,
    authContext: command.authContext ?? {}
  });
  const resolver = createReviewActionContextResolver({
    bindings,
    resolveAuthenticatedPrincipal() {
      return principal;
    }
  });
  const result = await options.recordReview({
    command,
    resolver
  });

  return {
    mode: "live",
    bindingsPath: options.bindingsPath,
    adapterModulePath: options.adapterModulePath,
    selectedBackend: options.selectedBackend,
    availableBackends: [...(options.availableBackends ?? [])],
    principal,
    review: result.review,
    blockers: result.blockers,
    taskStatus: result.task.status
  };
}

export async function executeRecordReviewCommandFromArgs(
  args: readonly string[],
  options: ExecuteRecordReviewCommandFromArgsOptions
): Promise<RecordReviewCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const command = await readRecordReviewCommandInput(args, { cwd });
  const bindingsPath = await resolveRequiredReviewIdentityFilePath({
    envVarName: "ARCHON_REVIEW_IDENTITY_BINDINGS",
    envVarValue: env.ARCHON_REVIEW_IDENTITY_BINDINGS,
    liveRelativePath: ".archon/review-identity-bindings.json",
    cwd
  });
  const liveAdapter = options.createLiveAdapter
    ? await options.createLiveAdapter()
    : await createLiveReviewIdentityAdapter({ cwd, env });
  if (!liveAdapter.modulePath) {
    throw new Error("record-review requires a resolved live adapter module path");
  }

  return executeRecordReviewCommand(command, {
    adapter: liveAdapter.adapter,
    adapterModulePath: liveAdapter.modulePath,
    selectedBackend: liveAdapter.selectedBackend,
    availableBackends: liveAdapter.availableBackends,
    bindingsPath,
    recordReview: options.recordReview
  });
}

async function readLoopReviewCommandInputs(
  args: readonly string[],
  options: {
    cwd?: string | undefined;
  } = {}
): Promise<readonly RecordReviewCommandInput[]> {
  const cwd = options.cwd ?? process.cwd();
  const inputArgs = collectCommandFlagValues(args, "--review-input");

  return Promise.all(
    inputArgs.map(async (inputArg) => {
      const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(cwd, inputArg);
      return normalizeRecordReviewCommandInput(await readFile(inputPath, "utf8"));
    })
  );
}

interface DaemonReviewQueueEntry {
  filePath: string;
  command: RecordReviewCommandInput;
}

interface FailedDaemonReviewQueueEntry {
  filePath: string;
  error: string;
}

interface StaleDaemonReviewQueueEntry {
  filePath: string;
  reason: string;
}

interface OperatorContinuationActionCommand {
  runId: string;
  taskId: string;
  blockerKind: "operator_required_continuation";
  action: {
    kind: "continue_with_analysis";
    targetId: string;
    source?: "blocking_gap" | "progress_proof" | "checkpoint" | undefined;
    sourceId?: string | undefined;
    operatorNotes: string;
  };
}

interface DaemonOperatorActionQueueEntry {
  filePath: string;
  command: OperatorContinuationActionCommand;
}

interface FailedDaemonOperatorActionQueueEntry {
  filePath: string;
  error: string;
}

function resolveDaemonReviewInputDir(args: readonly string[], options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicit = resolveCommandFlag(args, "--review-input-dir") ?? env.ARCHON_REVIEW_INPUT_DIR;
  const candidate = explicit ?? path.join(".archon", "review-actions");
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}

function resolveDaemonOperatorActionDir(args: readonly string[], options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicit = resolveCommandFlag(args, "--operator-action-dir") ?? env.ARCHON_OPERATOR_ACTION_DIR;
  const candidate = explicit ?? path.join(".archon", "operator-actions");
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}

function normalizeOperatorContinuationActionCommand(raw: string): OperatorContinuationActionCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`operator action input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("operator action input must be a JSON object");
  }

  const candidate = parsed as Record<string, unknown>;
  const runId = typeof candidate.runId === "string" && candidate.runId.trim().length > 0 ? candidate.runId.trim() : undefined;
  const taskId = typeof candidate.taskId === "string" && candidate.taskId.trim().length > 0 ? candidate.taskId.trim() : undefined;
  if (!runId) {
    throw new Error("operator action runId is required");
  }
  if (!taskId) {
    throw new Error("operator action taskId is required");
  }
  if (candidate.blockerKind !== "operator_required_continuation") {
    throw new Error("operator action blockerKind must be operator_required_continuation");
  }
  const action = candidate.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("operator action payload is required");
  }
  const actionCandidate = action as Record<string, unknown>;
  if (actionCandidate.kind !== "continue_with_analysis") {
    throw new Error("operator action kind must be continue_with_analysis");
  }
  const targetId =
    typeof actionCandidate.targetId === "string" && actionCandidate.targetId.trim().length > 0
      ? actionCandidate.targetId.trim()
      : undefined;
  const source =
    actionCandidate.source === "blocking_gap" ||
    actionCandidate.source === "progress_proof" ||
    actionCandidate.source === "checkpoint"
      ? actionCandidate.source
      : undefined;
  const sourceId =
    typeof actionCandidate.sourceId === "string" && actionCandidate.sourceId.trim().length > 0
      ? actionCandidate.sourceId.trim()
      : undefined;
  const operatorNotes =
    typeof actionCandidate.operatorNotes === "string" && actionCandidate.operatorNotes.trim().length > 0
      ? actionCandidate.operatorNotes.trim()
      : undefined;
  if (!targetId) {
    throw new Error("operator action action.targetId is required");
  }
  if (!operatorNotes) {
    throw new Error("operator action action.operatorNotes is required");
  }

  return {
    runId,
    taskId,
    blockerKind: "operator_required_continuation",
    action: {
      kind: "continue_with_analysis",
      targetId,
      source,
      sourceId,
      operatorNotes
    }
  };
}

async function readDaemonReviewQueueState(reviewInputDir: string): Promise<{
  entries: DaemonReviewQueueEntry[];
  failedEntries: FailedDaemonReviewQueueEntry[];
}> {
  let entries: string[] = [];
  try {
    entries = await readdir(reviewInputDir);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { entries: [], failedEntries: [] };
    }
    throw error;
  }

  const queueEntries: DaemonReviewQueueEntry[] = [];
  const failedEntries: FailedDaemonReviewQueueEntry[] = [];

  for (const entry of entries.filter((candidate) => candidate.endsWith(".json")).sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(reviewInputDir, entry);
    try {
      queueEntries.push({
        filePath,
        command: normalizeRecordReviewCommandInput(await readFile(filePath, "utf8"))
      });
    } catch (error) {
      failedEntries.push({
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    entries: queueEntries,
    failedEntries
  };
}

async function readDaemonOperatorActionQueueState(operatorActionDir: string): Promise<{
  entries: DaemonOperatorActionQueueEntry[];
  failedEntries: FailedDaemonOperatorActionQueueEntry[];
}> {
  let entries: string[] = [];
  try {
    entries = await readdir(operatorActionDir);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { entries: [], failedEntries: [] };
    }
    throw error;
  }

  const queueEntries: DaemonOperatorActionQueueEntry[] = [];
  const failedEntries: FailedDaemonOperatorActionQueueEntry[] = [];

  for (const entry of entries.filter((candidate) => candidate.endsWith(".json")).sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(operatorActionDir, entry);
    try {
      queueEntries.push({
        filePath,
        command: normalizeOperatorContinuationActionCommand(await readFile(filePath, "utf8"))
      });
    } catch (error) {
      failedEntries.push({
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    entries: queueEntries,
    failedEntries
  };
}

async function archiveConsumedDaemonReviewQueueEntries(
  consumedEntries: readonly DaemonReviewQueueEntry[],
  cwd: string
): Promise<void> {
  if (consumedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "processed-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of consumedEntries) {
    const archivedPath = path.join(archiveDir, path.basename(entry.filePath));
    await rename(entry.filePath, archivedPath);
  }
}

async function archiveConsumedDaemonOperatorActionQueueEntries(
  consumedEntries: readonly DaemonOperatorActionQueueEntry[],
  cwd: string
): Promise<void> {
  if (consumedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "processed-operator-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of consumedEntries) {
    const archivedPath = path.join(archiveDir, path.basename(entry.filePath));
    await rename(entry.filePath, archivedPath);
  }
}

async function archiveFailedDaemonReviewQueueEntries(
  failedEntries: readonly FailedDaemonReviewQueueEntry[],
  cwd: string,
  nowValue: string
): Promise<void> {
  if (failedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "failed-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of failedEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.error.json`),
      `${JSON.stringify(
        {
          file: baseName,
          error: entry.error,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}

async function archiveFailedDaemonOperatorActionQueueEntries(
  failedEntries: readonly FailedDaemonOperatorActionQueueEntry[],
  cwd: string,
  nowValue: string
): Promise<void> {
  if (failedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "failed-operator-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of failedEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.error.json`),
      `${JSON.stringify(
        {
          file: baseName,
          error: entry.error,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}

function matchesDaemonOperatorContinuationAction(input: {
  entry: DaemonOperatorActionQueueEntry;
  runId: string;
  taskId: string;
  directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
  classification: ContinueAnalysisDirectiveClassification;
}): boolean {
  if (
    input.entry.command.runId !== input.runId ||
    input.entry.command.taskId !== input.taskId ||
    input.entry.command.blockerKind !== "operator_required_continuation"
  ) {
    return false;
  }

  if (input.entry.command.action.targetId !== input.directive.targetId) {
    return false;
  }

  if (input.entry.command.action.source && input.entry.command.action.source !== input.directive.source) {
    return false;
  }

  const expectedSourceId =
    input.classification.action?.kind === "resume_target" ? input.classification.action.sourceId : undefined;
  if ((input.entry.command.action.sourceId ?? undefined) !== (expectedSourceId ?? undefined)) {
    return false;
  }

  return true;
}

async function archiveStaleDaemonReviewQueueEntries(
  staleEntries: readonly StaleDaemonReviewQueueEntry[],
  cwd: string,
  nowValue: string,
  expectedReviewTargets: readonly string[]
): Promise<void> {
  if (staleEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "stale-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of staleEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.reason.json`),
      `${JSON.stringify(
        {
          file: baseName,
          reason: entry.reason,
          expectedReviewTargets,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}

async function writeDaemonReviewQueueStatus(
  cwd: string,
  status: {
    state: "processed" | "blocked" | "failed";
    reviewInputDir: string;
    reason: string;
    expectedReviewTargets?: string[] | undefined;
    queuedFiles?: string[] | undefined;
    consumedFiles?: string[] | undefined;
    failedFiles?: { file: string; error: string }[] | undefined;
    staleFiles?: { file: string; reason: string }[] | undefined;
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "review-queue-status.json"),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8"
  );
}

async function writeDaemonContinuationStatus(
  cwd: string,
  status: {
    state: "blocked";
    directiveKind: "continue_analysis";
    executionMode: "operator_required";
    targetId: string;
    source: "blocking_gap" | "progress_proof" | "checkpoint";
    sourceId?: string | undefined;
    actionKind?: ContinuationAction["kind"] | undefined;
    provider?: AutonomousContinuationProvider | undefined;
    wakeOwner?: AutonomousWakeOwner | undefined;
    scheduleKind?: AutonomousContinuationScheduleKind | undefined;
    schedule?: string | undefined;
    summary: string;
    nextActions: string[];
    blockers: string[];
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "continuation-status.json"),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8"
  );
}

async function writeDaemonAutomationEnvelope(
  cwd: string,
  envelope: {
    provider: Exclude<AutonomousContinuationProvider, "none" | "manual_operator_handoff">;
    wakeOwner: "operator";
    continuationIntent: "defer_same_thread" | "defer_fresh_run";
    targetMode: "same_thread" | "fresh_run";
    scheduleKind: Exclude<AutonomousContinuationScheduleKind, "none" | "manual">;
    schedule: string;
    targetId: string;
    source: "progress_proof" | "checkpoint";
    sourceId?: string | undefined;
    summary: string;
    nextActions: string[];
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string;
    activeTaskId: string;
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "automation-envelope.json"),
    `${JSON.stringify(envelope, null, 2)}\n`,
    "utf8"
  );
}

async function clearDaemonContinuationStatus(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "continuation-status.json"), {
    force: true
  });
}

async function clearDaemonAutomationEnvelope(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "automation-envelope.json"), {
    force: true
  });
}

async function readDaemonAutomationEnvelope(
  cwd: string
): Promise<
  | {
      provider: Exclude<AutonomousContinuationProvider, "none" | "manual_operator_handoff">;
      wakeOwner: "operator";
      continuationIntent: "defer_same_thread" | "defer_fresh_run";
      targetMode: "same_thread" | "fresh_run";
      scheduleKind: Exclude<AutonomousContinuationScheduleKind, "none" | "manual">;
      schedule: string;
      targetId: string;
      source: "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
      summary: string;
      nextActions: string[];
      workspaceSlug: string;
      projectSlug: string;
      activeRunId: string;
      activeTaskId: string;
      updatedAt?: string | undefined;
    }
  | undefined
> {
  const envelopePath = path.join(cwd, ".archon", "work", "daemon", "automation-envelope.json");
  let raw: string;
  try {
    raw = await readFile(envelopePath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const provider =
    parsed.provider === "claude_cli_exec_scheduler" ||
    parsed.provider === "claude_app_thread_automation" ||
    parsed.provider === "claude_app_standalone_automation"
      ? parsed.provider
      : undefined;
  const wakeOwner = parsed.wakeOwner === "operator" ? "operator" : undefined;
  const continuationIntent =
    parsed.continuationIntent === "defer_same_thread" || parsed.continuationIntent === "defer_fresh_run"
      ? parsed.continuationIntent
      : undefined;
  const targetMode =
    parsed.targetMode === "same_thread" || parsed.targetMode === "fresh_run" ? parsed.targetMode : undefined;
  const scheduleKind =
    parsed.scheduleKind === "cron" || parsed.scheduleKind === "rrule" ? parsed.scheduleKind : undefined;
  const schedule = typeof parsed.schedule === "string" ? parsed.schedule : undefined;
  const targetId = typeof parsed.targetId === "string" ? parsed.targetId : undefined;
  const source = parsed.source === "progress_proof" || parsed.source === "checkpoint" ? parsed.source : undefined;
  const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
  const workspaceSlug = typeof parsed.workspaceSlug === "string" ? parsed.workspaceSlug : undefined;
  const projectSlug = typeof parsed.projectSlug === "string" ? parsed.projectSlug : undefined;
  const activeRunId = typeof parsed.activeRunId === "string" ? parsed.activeRunId : undefined;
  const activeTaskId = typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined;
  if (
    !provider ||
    !wakeOwner ||
    !continuationIntent ||
    !targetMode ||
    !scheduleKind ||
    !schedule ||
    !targetId ||
    !source ||
    !summary ||
    !workspaceSlug ||
    !projectSlug ||
    !activeRunId ||
    !activeTaskId
  ) {
    return undefined;
  }

  return {
    provider,
    wakeOwner,
    continuationIntent,
    targetMode,
    scheduleKind,
    schedule,
    targetId,
    source,
    sourceId: typeof parsed.sourceId === "string" ? parsed.sourceId : undefined,
    summary,
    nextActions: Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === "string")
      : [],
    workspaceSlug,
    projectSlug,
    activeRunId,
    activeTaskId,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined
  };
}

function convertSupportedCronScheduleToRrule(schedule: string): string {
  switch (schedule.trim()) {
    case "*/30 * * * *":
      return "FREQ=MINUTELY;INTERVAL=30";
    case "0 * * * *":
      return "FREQ=HOURLY;INTERVAL=1";
    default:
      throw new Error(`unsupported cron schedule for Codex app automation handoff: ${schedule}`);
  }
}

function buildAppAutomationPrompt(input: {
  envelope: {
    continuationIntent: "defer_same_thread" | "defer_fresh_run";
    targetMode: "same_thread" | "fresh_run";
    targetId: string;
    source: "progress_proof" | "checkpoint";
    sourceId?: string | undefined;
    summary: string;
    nextActions: string[];
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string;
    activeTaskId: string;
  };
  cwd: string;
}): string {
  const lines = [
    `Resume deferred archon work for workspace ${input.envelope.workspaceSlug} project ${input.envelope.projectSlug}.`,
    `Repo root: ${input.cwd}`,
    `Active run: ${input.envelope.activeRunId}`,
    `Active task: ${input.envelope.activeTaskId}`,
    `Continuation target: ${input.envelope.targetId}`,
    `Continuation intent: ${input.envelope.continuationIntent}`,
    `Target mode: ${input.envelope.targetMode}`,
    `Resume source: ${input.envelope.source}${input.envelope.sourceId ? ` (${input.envelope.sourceId})` : ""}`,
    `Summary: ${input.envelope.summary}`,
    "Before making changes, read `.archon/work/daemon/automation-envelope.json` and confirm the active runtime task still matches this request.",
    "Carry out the recorded continuation target, record concrete progress or blockers, and stop if the task becomes blocked by external input or no longer remains active."
  ];
  if (input.envelope.nextActions.length > 0) {
    lines.push(`Next actions: ${input.envelope.nextActions.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

async function detectGitAutomationExecutionEnvironment(cwd: string): Promise<"worktree" | "local"> {
  try {
    await access(path.join(cwd, ".git"));
    return "worktree";
  } catch {
    return "local";
  }
}

async function writeDaemonAppAutomationRequest(
  cwd: string,
  input: {
    envelope: {
      provider: "claude_app_thread_automation" | "claude_app_standalone_automation";
      continuationIntent: "defer_same_thread" | "defer_fresh_run";
      targetMode: "same_thread" | "fresh_run";
      scheduleKind: "cron" | "rrule";
      schedule: string;
      targetId: string;
      source: "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
      summary: string;
      nextActions: string[];
      workspaceSlug: string;
      projectSlug: string;
      activeRunId: string;
      activeTaskId: string;
    };
    updatedAt: string;
  }
): Promise<string> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  const relativePath = ".archon/work/daemon/app-automation-request.json";
  const appSchedule =
    input.envelope.scheduleKind === "rrule"
      ? input.envelope.schedule
      : convertSupportedCronScheduleToRrule(input.envelope.schedule);
  const prompt = buildAppAutomationPrompt({
    envelope: input.envelope,
    cwd
  });
  const executionEnvironment =
    input.envelope.provider === "claude_app_standalone_automation"
      ? await detectGitAutomationExecutionEnvironment(cwd)
      : undefined;
  const request =
    input.envelope.provider === "claude_app_thread_automation"
      ? {
          tool: "automation_update",
          request: {
            mode: "suggested_create",
            kind: "heartbeat",
            destination: "thread",
            name: `Archon same-thread follow-up: ${input.envelope.activeTaskId}`,
            prompt,
            rrule: appSchedule,
            status: "ACTIVE"
          },
          context: {
            provider: input.envelope.provider,
            workspaceSlug: input.envelope.workspaceSlug,
            projectSlug: input.envelope.projectSlug,
            activeRunId: input.envelope.activeRunId,
            activeTaskId: input.envelope.activeTaskId,
            targetId: input.envelope.targetId,
            targetMode: input.envelope.targetMode,
            notes: [
              "Apply this request through the Codex app automation surface as a thread heartbeat.",
              "The automation should return to the same conversation rather than starting a fresh background run."
            ],
            generatedAt: input.updatedAt
          }
        }
      : {
          tool: "automation_update",
          request: {
            mode: "suggested_create",
            kind: "cron",
            executionEnvironment,
            cwds: [cwd],
            name: `Archon deferred run: ${input.envelope.activeTaskId}`,
            prompt,
            rrule: appSchedule,
            status: "ACTIVE"
          },
          context: {
            provider: input.envelope.provider,
            workspaceSlug: input.envelope.workspaceSlug,
            projectSlug: input.envelope.projectSlug,
            activeRunId: input.envelope.activeRunId,
            activeTaskId: input.envelope.activeTaskId,
            targetId: input.envelope.targetId,
            targetMode: input.envelope.targetMode,
            executionEnvironment,
            notes: [
              "Apply this request through the Codex app automation surface as a standalone automation.",
              executionEnvironment === "worktree"
                ? "Worktree execution is recommended because the repo exposes Git metadata."
                : "Local-project execution is suggested because no Git metadata was detected in the repo root."
            ],
            generatedAt: input.updatedAt
          }
        };
  await writeFile(path.join(cwd, relativePath), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return relativePath;
}

async function clearDaemonAppAutomationRequest(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "app-automation-request.json"), {
    force: true
  });
}

function buildCliSchedulerPrompt(input: Parameters<typeof buildAppAutomationPrompt>[0]): string {
  return `${buildAppAutomationPrompt(input)}Return a final response that matches the provided output schema when the scheduled Codex CLI run completes.\n`;
}

function buildDaemonCliOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      status: {
        type: "string",
        enum: ["completed", "blocked", "needs_review", "needs_followup"]
      },
      blockers: {
        type: "array",
        items: { type: "string" }
      },
      checkpoint: {
        type: "object",
        properties: {
          evidence_refs: {
            type: "array",
            items: { type: "string" }
          },
          next_actions: {
            type: "array",
            items: { type: "string" }
          },
          active_targets: {
            type: "array",
            items: { type: "string" }
          },
          open_gaps: {
            type: "array",
            items: { type: "string" }
          },
          compressed_context_summary: { type: "string" },
          compressed_context_ref: { type: "string" },
          compressed_context_source_refs: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["evidence_refs"],
        additionalProperties: false
      },
      scope_request: {
        type: "object",
        properties: {
          blocked_paths: {
            type: "array",
            items: { type: "string" }
          },
          requested_write_scope: {
            type: "array",
            items: { type: "string" }
          },
          reason: { type: "string" }
        },
        required: ["blocked_paths", "requested_write_scope"],
        additionalProperties: false
      }
    },
    required: ["summary", "status", "blockers"],
    additionalProperties: false
  };
}

function convertSupportedCronScheduleToSystemdOnCalendar(schedule: string): string | undefined {
  switch (schedule.trim()) {
    case "*/30 * * * *":
      return "*-*-* *:0/30:00";
    case "0 * * * *":
      return "hourly";
    default:
      return undefined;
  }
}

async function writeDaemonCliSchedulerRequest(
  cwd: string,
  input: {
    envelope: {
      provider: "claude_cli_exec_scheduler";
      continuationIntent: "defer_same_thread" | "defer_fresh_run";
      targetMode: "same_thread" | "fresh_run";
      scheduleKind: "cron" | "rrule";
      schedule: string;
      targetId: string;
      source: "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
      summary: string;
      nextActions: string[];
      workspaceSlug: string;
      projectSlug: string;
      activeRunId: string;
      activeTaskId: string;
    };
    sessionId: string | null;
    updatedAt: string;
  }
): Promise<{
  requestPath: string;
  promptPath: string;
  outputSchemaPath: string;
  runnable: boolean;
  manualReviewRequired: boolean;
}> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  const requestPath = ".archon/work/daemon/cli-scheduler-request.json";
  const promptPath = ".archon/work/daemon/cli-scheduler-prompt.txt";
  const outputSchemaPath = ".archon/work/daemon/cli-scheduler-output-schema.json";
  const prompt = buildCliSchedulerPrompt({
    envelope: input.envelope,
    cwd
  });
  await writeFile(path.join(cwd, promptPath), prompt, "utf8");
  await writeFile(
    path.join(cwd, outputSchemaPath),
    `${JSON.stringify(buildDaemonCliOutputSchema(), null, 2)}\n`,
    "utf8"
  );

  const requiresResumeSession =
    input.envelope.continuationIntent === "defer_same_thread" && input.envelope.targetMode === "same_thread";
  const runnable = !requiresResumeSession || Boolean(input.sessionId);
  const manualReviewRequired = !runnable;
  const commandCore =
    requiresResumeSession && input.sessionId
      ? `codex exec resume ${input.sessionId} "$(cat ${promptPath})" --json --output-schema ${outputSchemaPath}`
      : `codex exec "$(cat ${promptPath})" --json --output-schema ${outputSchemaPath}`;
  const shellCommand = runnable ? `cd ${JSON.stringify(cwd)} && ${commandCore}` : undefined;
  const systemdOnCalendar =
    input.envelope.scheduleKind === "cron"
      ? convertSupportedCronScheduleToSystemdOnCalendar(input.envelope.schedule)
      : undefined;
  const request = {
    tool: "codex",
    request: {
      subcommand: "exec",
      resumeSessionId: input.sessionId ?? undefined,
      promptPath,
      outputSchemaPath,
      json: true,
      cwd,
      runnable
    },
    scheduler: {
      scheduleKind: input.envelope.scheduleKind,
      schedule: input.envelope.schedule,
      launcherHints: shellCommand
        ? [
            {
              kind: "cron",
              schedule: input.envelope.schedule,
              shellCommand
            },
            ...(systemdOnCalendar
              ? [
                  {
                    kind: "systemd",
                    onCalendar: systemdOnCalendar,
                    shellCommand
                  }
                ]
              : [])
          ]
        : [],
      manualReviewRequired
    },
    context: {
      provider: input.envelope.provider,
      workspaceSlug: input.envelope.workspaceSlug,
      projectSlug: input.envelope.projectSlug,
      activeRunId: input.envelope.activeRunId,
      activeTaskId: input.envelope.activeTaskId,
      targetId: input.envelope.targetId,
      targetMode: input.envelope.targetMode,
      continuationIntent: input.envelope.continuationIntent,
      notes: manualReviewRequired
        ? [
            "No persisted Codex session id was available for a same-thread CLI resume.",
            "Review this handoff manually before converting it into a fresh-run scheduler job or another automation owner."
          ]
        : [
            requiresResumeSession
              ? "This handoff uses codex exec resume to preserve the same-thread continuation context."
              : "This handoff uses a fresh codex exec run for deferred continuation.",
            "Install one of the launcher hints under your preferred local scheduler."
          ],
      generatedAt: input.updatedAt
    }
  };
  await writeFile(path.join(cwd, requestPath), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return {
    requestPath,
    promptPath,
    outputSchemaPath,
    runnable,
    manualReviewRequired
  };
}

async function clearDaemonCliSchedulerRequest(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "cli-scheduler-request.json"), {
    force: true
  });
  await rm(path.join(cwd, ".archon", "work", "daemon", "cli-scheduler-prompt.txt"), {
    force: true
  });
  await rm(path.join(cwd, ".archon", "work", "daemon", "cli-scheduler-output-schema.json"), {
    force: true
  });
}

async function writeDaemonOperatorHandoff(
  cwd: string,
  handoff: {
    state: "blocked";
    blockerKind:
      | "bootstrapping"
      | "runtime_preflight"
      | "missing_active_runtime"
      | "review_queue"
      | "review_execution_unsupported"
      | "operator_required_continuation"
      | "workflow_proof_failure"
      | "scope_expansion_required"
      | "runtime_blocked"
      | "recovery_required"
      | "runtime_task_missing"
      | "active_task_mismatch";
    reason: string;
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string | null;
    activeTaskId: string | null;
    sessionId: string | null;
    cycle: number;
    directiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
    nextActions: string[];
    detailFiles: {
      continuationStatus?: string | undefined;
      automationEnvelope?: string | undefined;
      appAutomationRequest?: string | undefined;
      cliSchedulerRequest?: string | undefined;
      reviewQueueStatus?: string | undefined;
      scopeExpansionRequest?: string | undefined;
    };
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "operator-handoff.json"),
    `${JSON.stringify(handoff, null, 2)}\n`,
    "utf8"
  );
}

async function clearDaemonOperatorHandoff(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json"), {
    force: true
  });
}

async function writeDaemonScopeExpansionRequest(
  cwd: string,
  request: {
    runId: string;
    taskId: string;
    directiveKind: RunExecutionPlan["directive"]["kind"];
    blockedPaths: string[];
    requestedWriteScope: string[];
    reason: string;
    updatedAt: string;
  }
): Promise<string> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  const relativePath = ".archon/work/daemon/scope-expansion-request.json";
  await writeFile(path.join(cwd, relativePath), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return relativePath;
}

async function clearDaemonScopeExpansionRequest(cwd: string): Promise<void> {
  await rm(path.join(cwd, ".archon", "work", "daemon", "scope-expansion-request.json"), {
    force: true
  });
}

async function writeDaemonSupervisorStatus(
  cwd: string,
  status: {
    state: "completed" | "blocked" | "max_cycles_reached";
    blockerKind?:
      | "runtime_preflight"
      | "missing_review_actor_bindings"
      | "handoff_missing"
      | "unsupported_handoff"
      | "continuation_derivation_failed"
      | "review_derivation_failed"
      | undefined;
    reason: string;
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string | null;
    activeTaskId: string | null;
    sessionId: string | null;
    supervisorCycles: number;
    nextActions: string[];
    missingReviewRoles: string[];
    actions: Array<{
      cycle: number;
      action:
        | "enqueue_operator_continuation"
        | "enqueue_review_action"
        | "materialize_app_automation"
        | "materialize_cli_scheduler";
      targetId?: string | undefined;
      taskId?: string | undefined;
      reviewRole?: string | undefined;
      filePath: string;
      summary: string;
    }>;
    updatedAt: string;
  }
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    path.join(daemonDir, "supervisor-status.json"),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8"
  );
}

interface DaemonSupervisorHistoryReadOptions {
  limit: number;
  scope: "run" | "all";
  runId?: string | undefined;
}

interface DaemonSupervisorHistoryReadResult {
  entries: DaemonSupervisorStatusObservation["history"];
  retainedCount: number;
  filteredCount: number;
}

async function appendDaemonSupervisorHistory(
  cwd: string,
  entry: {
    recordedAt: string;
    state: "completed" | "blocked" | "max_cycles_reached";
    blockerKind?:
      | "runtime_preflight"
      | "missing_review_actor_bindings"
      | "handoff_missing"
      | "unsupported_handoff"
      | "continuation_derivation_failed"
      | "review_derivation_failed"
      | undefined;
    reason: string;
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string | null;
    activeTaskId: string | null;
    sessionId: string | null;
    supervisorCycles: number;
    nextActions: string[];
    missingReviewRoles: string[];
    actions: Array<{
      cycle: number;
      action:
        | "enqueue_operator_continuation"
        | "enqueue_review_action"
        | "materialize_app_automation"
        | "materialize_cli_scheduler";
      targetId?: string | undefined;
      taskId?: string | undefined;
      reviewRole?: string | undefined;
      filePath: string;
      summary: string;
    }>;
  },
  retentionLimit: number
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  const historyPath = path.join(daemonDir, "supervisor-history.jsonl");
  await mkdir(daemonDir, { recursive: true });
  let existingLines: string[] = [];
  try {
    existingLines = (await readFile(historyPath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const retainedLines = [...existingLines, JSON.stringify(entry)].slice(-retentionLimit);
  await writeFile(historyPath, retainedLines.length > 0 ? `${retainedLines.join("\n")}\n` : "", "utf8");
}

async function readDaemonContinuationStatus(
  cwd: string
): Promise<DaemonContinuationStatusObservation | undefined> {
  const statusPath = path.join(cwd, ".archon", "work", "daemon", "continuation-status.json");
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state = parsed.state === "blocked" ? "blocked" : "invalid";
    const directiveKind = parsed.directiveKind === "continue_analysis" ? "continue_analysis" : "continue_analysis";
    const executionMode: DaemonContinuationStatusObservation["executionMode"] =
      parsed.executionMode === "operator_required" ? "operator_required" : "unknown";
    const targetId = typeof parsed.targetId === "string" ? parsed.targetId : undefined;
    const source =
      parsed.source === "blocking_gap" || parsed.source === "progress_proof" || parsed.source === "checkpoint"
        ? parsed.source
        : undefined;
    const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId : undefined;
    const actionKind =
      parsed.actionKind === "resolve_blocking_gap" ||
      parsed.actionKind === "run_workflow_proof" ||
      parsed.actionKind === "resume_target"
        ? parsed.actionKind
        : undefined;
    const provider =
      parsed.provider === "none" ||
      parsed.provider === "manual_operator_handoff" ||
      parsed.provider === "claude_cli_exec_scheduler" ||
      parsed.provider === "claude_cli_exec" ||
      parsed.provider === "claude_app_thread_automation" ||
      parsed.provider === "claude_app_standalone_automation"
        ? parsed.provider
        : undefined;
    const wakeOwner =
      parsed.wakeOwner === "none" || parsed.wakeOwner === "runtime" || parsed.wakeOwner === "operator"
        ? parsed.wakeOwner
        : undefined;
    const scheduleKind =
      parsed.scheduleKind === "none" ||
      parsed.scheduleKind === "manual" ||
      parsed.scheduleKind === "cron" ||
      parsed.scheduleKind === "rrule"
        ? parsed.scheduleKind
        : undefined;
    const schedule = typeof parsed.schedule === "string" ? parsed.schedule : undefined;
    const derivedProviderSelection =
      provider && wakeOwner
        ? undefined
        : executionMode === "operator_required"
          ? selectLocalContinuationProvider({
              executionMode,
              continuationIntent:
                source === "checkpoint"
                  ? "defer_same_thread"
                  : source === "progress_proof"
                    ? "defer_fresh_run"
                    : "blocked_external"
            })
          : undefined;
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary
        : "daemon continuation status file is missing a valid summary";
    const nextActions = Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === "string")
      : [];
    const blockers = Array.isArray(parsed.blockers)
      ? parsed.blockers.filter((value): value is string => typeof value === "string")
      : [];
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      directiveKind,
      executionMode,
      targetId,
      source,
      sourceId,
      actionKind,
      provider:
        provider === "claude_cli_exec"
          ? "claude_cli_exec_scheduler"
          : (provider ?? derivedProviderSelection?.provider),
      wakeOwner: wakeOwner ?? derivedProviderSelection?.wakeOwner,
      scheduleKind: scheduleKind ?? derivedProviderSelection?.scheduleKind,
      schedule: schedule ?? derivedProviderSelection?.schedule,
      summary,
      nextActions,
      blockers,
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      directiveKind: "continue_analysis",
      executionMode: "unknown",
      summary: `failed to parse daemon continuation status: ${error instanceof Error ? error.message : String(error)}`,
      nextActions: [],
      blockers: [],
      updatedAt: undefined
    };
  }
}

async function readDaemonOperatorHandoff(
  cwd: string
): Promise<DaemonOperatorHandoffObservation | undefined> {
  const handoffPath = path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json");
  let raw: string;
  try {
    raw = await readFile(handoffPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state = parsed.state === "blocked" ? "blocked" : "invalid";
    const blockerKind =
      parsed.blockerKind === "bootstrapping" ||
      parsed.blockerKind === "runtime_preflight" ||
      parsed.blockerKind === "missing_active_runtime" ||
      parsed.blockerKind === "review_queue" ||
      parsed.blockerKind === "review_execution_unsupported" ||
      parsed.blockerKind === "operator_required_continuation" ||
      parsed.blockerKind === "workflow_proof_failure" ||
      parsed.blockerKind === "scope_expansion_required" ||
      parsed.blockerKind === "runtime_blocked" ||
      parsed.blockerKind === "recovery_required" ||
      parsed.blockerKind === "runtime_task_missing" ||
      parsed.blockerKind === "active_task_mismatch"
        ? parsed.blockerKind
        : "unknown";
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason
        : "daemon operator handoff is missing a valid reason";
    const workspaceSlug = typeof parsed.workspaceSlug === "string" ? parsed.workspaceSlug : undefined;
    const projectSlug = typeof parsed.projectSlug === "string" ? parsed.projectSlug : undefined;
    const activeRunId =
      parsed.activeRunId === null || typeof parsed.activeRunId === "string" ? parsed.activeRunId : undefined;
    const activeTaskId =
      parsed.activeTaskId === null || typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined;
    const sessionId =
      parsed.sessionId === null || typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    const cycle = typeof parsed.cycle === "number" ? parsed.cycle : undefined;
    const directiveKind =
      parsed.directiveKind === "complete" ||
      parsed.directiveKind === "dispatch_owner" ||
      parsed.directiveKind === "dispatch_reviews" ||
      parsed.directiveKind === "apply_recovery" ||
      parsed.directiveKind === "dispatch_subagents" ||
      parsed.directiveKind === "rebuild_inventory" ||
      parsed.directiveKind === "trace_runtime" ||
      parsed.directiveKind === "checkpoint" ||
      parsed.directiveKind === "replan_migration" ||
      parsed.directiveKind === "continue_analysis" ||
      parsed.directiveKind === "blocked"
        ? parsed.directiveKind
        : undefined;
    const nextActions = Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === "string")
      : [];
    const detailFilesCandidate =
      parsed.detailFiles && typeof parsed.detailFiles === "object" && !Array.isArray(parsed.detailFiles)
        ? (parsed.detailFiles as Record<string, unknown>)
        : {};
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      blockerKind,
      reason,
      workspaceSlug,
      projectSlug,
      activeRunId,
      activeTaskId,
      sessionId,
      cycle,
      directiveKind,
      nextActions,
      detailFiles: {
        continuationStatus:
          typeof detailFilesCandidate.continuationStatus === "string"
            ? detailFilesCandidate.continuationStatus
            : undefined,
        automationEnvelope:
          typeof detailFilesCandidate.automationEnvelope === "string"
            ? detailFilesCandidate.automationEnvelope
            : undefined,
        appAutomationRequest:
          typeof detailFilesCandidate.appAutomationRequest === "string"
            ? detailFilesCandidate.appAutomationRequest
            : undefined,
        cliSchedulerRequest:
          typeof detailFilesCandidate.cliSchedulerRequest === "string"
            ? detailFilesCandidate.cliSchedulerRequest
            : undefined,
        reviewQueueStatus:
          typeof detailFilesCandidate.reviewQueueStatus === "string"
            ? detailFilesCandidate.reviewQueueStatus
            : undefined,
        scopeExpansionRequest:
          typeof detailFilesCandidate.scopeExpansionRequest === "string"
            ? detailFilesCandidate.scopeExpansionRequest
            : undefined
      },
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      blockerKind: "unknown",
      reason: `failed to parse daemon operator handoff: ${error instanceof Error ? error.message : String(error)}`,
      nextActions: [],
      detailFiles: {}
    };
  }
}

async function readDaemonSupervisorStatus(
  cwd: string,
  historyOptions: DaemonSupervisorHistoryReadOptions
): Promise<DaemonSupervisorStatusObservation | undefined> {
  const statusPath = path.join(cwd, ".archon", "work", "daemon", "supervisor-status.json");
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state =
      parsed.state === "completed" || parsed.state === "blocked" || parsed.state === "max_cycles_reached"
        ? parsed.state
        : "invalid";
    const blockerKind =
      parsed.blockerKind === "runtime_preflight" ||
      parsed.blockerKind === "missing_review_actor_bindings" ||
      parsed.blockerKind === "handoff_missing" ||
      parsed.blockerKind === "unsupported_handoff" ||
      parsed.blockerKind === "continuation_derivation_failed" ||
      parsed.blockerKind === "review_derivation_failed"
        ? parsed.blockerKind
        : typeof parsed.blockerKind === "string"
          ? "unknown"
          : undefined;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason
        : "daemon supervisor status is missing a valid reason";
    const workspaceSlug = typeof parsed.workspaceSlug === "string" ? parsed.workspaceSlug : undefined;
    const projectSlug = typeof parsed.projectSlug === "string" ? parsed.projectSlug : undefined;
    const activeRunId =
      parsed.activeRunId === null || typeof parsed.activeRunId === "string" ? parsed.activeRunId : undefined;
    const activeTaskId =
      parsed.activeTaskId === null || typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined;
    const sessionId =
      parsed.sessionId === null || typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    const supervisorCycles = typeof parsed.supervisorCycles === "number" ? parsed.supervisorCycles : undefined;
    const nextActions = Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === "string")
      : [];
    const missingReviewRoles = Array.isArray(parsed.missingReviewRoles)
      ? parsed.missingReviewRoles.filter((value): value is string => typeof value === "string")
      : [];
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return [];
          }
          const candidate = value as Record<string, unknown>;
          const action =
            candidate.action === "enqueue_operator_continuation" ||
            candidate.action === "enqueue_review_action" ||
            candidate.action === "materialize_app_automation" ||
            candidate.action === "materialize_cli_scheduler"
              ? (candidate.action as
                  | "enqueue_operator_continuation"
                  | "enqueue_review_action"
                  | "materialize_app_automation"
                  | "materialize_cli_scheduler")
              : undefined;
          const cycle = typeof candidate.cycle === "number" ? candidate.cycle : undefined;
          const filePath = typeof candidate.filePath === "string" ? candidate.filePath : undefined;
          const summary = typeof candidate.summary === "string" ? candidate.summary : undefined;
          if (!action || cycle === undefined || !filePath || !summary) {
            return [];
          }
          return [
            {
              cycle,
              action,
              targetId: typeof candidate.targetId === "string" ? candidate.targetId : undefined,
              taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
              reviewRole: typeof candidate.reviewRole === "string" ? candidate.reviewRole : undefined,
              filePath,
              summary
            }
          ];
        })
      : [];
    const historyResult = await readDaemonSupervisorHistory(cwd, historyOptions);
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      blockerKind,
      reason,
      workspaceSlug,
      projectSlug,
      activeRunId,
      activeTaskId,
      sessionId,
      supervisorCycles,
      nextActions,
      missingReviewRoles,
      actions,
      history: historyResult.entries,
      historyView: {
        scope: historyOptions.scope,
        runId: historyOptions.scope === "run" ? historyOptions.runId : undefined,
        limit: historyOptions.limit,
        retainedCount: historyResult.retainedCount,
        filteredCount: historyResult.filteredCount,
        returnedCount: historyResult.entries.length,
        truncated: historyResult.filteredCount > historyResult.entries.length
      },
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      blockerKind: "unknown",
      reason: `failed to parse daemon supervisor status: ${error instanceof Error ? error.message : String(error)}`,
      nextActions: [],
      missingReviewRoles: [],
      actions: [],
      history: [],
      historyView: {
        scope: historyOptions.scope,
        runId: historyOptions.scope === "run" ? historyOptions.runId : undefined,
        limit: historyOptions.limit,
        retainedCount: 0,
        filteredCount: 0,
        returnedCount: 0,
        truncated: false
      },
      updatedAt: undefined
    };
  }
}

async function readDaemonSupervisorHistory(
  cwd: string,
  options: DaemonSupervisorHistoryReadOptions
): Promise<DaemonSupervisorHistoryReadResult> {
  const historyPath = path.join(cwd, ".archon", "work", "daemon", "supervisor-history.jsonl");
  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return {
        entries: [],
        retainedCount: 0,
        filteredCount: 0
      };
    }
    throw error;
  }

  const retainedEntries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const state =
          parsed.state === "completed" || parsed.state === "blocked" || parsed.state === "max_cycles_reached"
            ? parsed.state
            : undefined;
        const reason =
          typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason.trim() : undefined;
        const recordedAt =
          typeof parsed.recordedAt === "string" && parsed.recordedAt.trim().length > 0
            ? parsed.recordedAt.trim()
            : undefined;
        const activeRunId =
          parsed.activeRunId === null || typeof parsed.activeRunId === "string" ? parsed.activeRunId : undefined;
        const activeTaskId =
          parsed.activeTaskId === null || typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined;
        if (!state || !reason || !recordedAt) {
          return [];
        }
        const blockerKind =
          parsed.blockerKind === "runtime_preflight" ||
          parsed.blockerKind === "missing_review_actor_bindings" ||
          parsed.blockerKind === "handoff_missing" ||
          parsed.blockerKind === "unsupported_handoff" ||
          parsed.blockerKind === "continuation_derivation_failed" ||
          parsed.blockerKind === "review_derivation_failed"
            ? parsed.blockerKind
            : typeof parsed.blockerKind === "string"
              ? "unknown"
              : undefined;
        const supervisorCycles =
          typeof parsed.supervisorCycles === "number" ? parsed.supervisorCycles : undefined;
        const actionCount = Array.isArray(parsed.actions) ? parsed.actions.length : 0;
        return [
          {
            recordedAt,
            state,
            activeRunId,
            activeTaskId,
            blockerKind,
            reason,
            supervisorCycles,
            actionCount
          } satisfies DaemonSupervisorStatusObservation["history"][number]
        ];
      } catch {
        return [];
      }
    });

  const filteredEntries =
    options.scope === "run" && options.runId
      ? retainedEntries.filter((entry) => entry.activeRunId === options.runId)
      : retainedEntries;

  return {
    entries: options.limit === 0 ? [] : filteredEntries.slice(-options.limit),
    retainedCount: retainedEntries.length,
    filteredCount: filteredEntries.length
  };
}

export async function createLiveLoopReviewCommandExecutor(
  options: {
    cwd?: string | undefined;
    env?: EnvShape | undefined;
    createLiveAdapter?: ExecuteRecordReviewCommandFromArgsOptions["createLiveAdapter"];
    recordReview: ExecuteRecordReviewCommandOptions["recordReview"];
  }
): Promise<(command: RecordReviewCommandInput) => Promise<RecordReviewCommandResult>> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const bindingsPath = await resolveRequiredReviewIdentityFilePath({
    envVarName: "ARCHON_REVIEW_IDENTITY_BINDINGS",
    envVarValue: env.ARCHON_REVIEW_IDENTITY_BINDINGS,
    liveRelativePath: ".archon/review-identity-bindings.json",
    cwd
  });
  const liveAdapter = options.createLiveAdapter
    ? await options.createLiveAdapter()
    : await createLiveReviewIdentityAdapter({ cwd, env });

  if (!liveAdapter.modulePath) {
    throw new Error("loop review execution requires a resolved live adapter module path");
  }
  const adapterModulePath = liveAdapter.modulePath;

  return (command) =>
    executeRecordReviewCommand(command, {
      adapter: liveAdapter.adapter,
      adapterModulePath,
      selectedBackend: liveAdapter.selectedBackend,
      availableBackends: liveAdapter.availableBackends,
      bindingsPath,
      recordReview: options.recordReview
    });
}

export function createQueuedLoopReviewExecutor(
  runId: string,
  reviewCommands: readonly RecordReviewCommandInput[],
  executeReviewCommand: (command: RecordReviewCommandInput) => Promise<RecordReviewCommandResult>
): ExecuteDirectiveStepOptions["executeReviewRecommendation"] {
  const remaining = [...reviewCommands];

  return async ({ directive }) => {
    const matchIndex = remaining.findIndex(
      (command) =>
        command.runId === runId &&
        directive.recommendations.some(
          (recommendation) =>
            recommendation.taskId === command.taskId &&
            recommendation.targetReviewRole === command.review.reviewerRole
        )
    );

    if (matchIndex < 0) {
      const nextRecommendation = directive.recommendations[0];
      return {
        executed: false,
        taskId: nextRecommendation?.taskId,
        reviewRole: nextRecommendation?.targetReviewRole,
        evidence: [
          "no matching trusted review input was supplied for the remaining review directives",
          ...directive.recommendations.map(
            (recommendation) =>
              `${recommendation.taskId}:${recommendation.targetReviewRole ?? "unknown"}`
          )
        ]
      };
    }

    const command = remaining.splice(matchIndex, 1)[0]!;
    const result = await executeReviewCommand(command);
    return {
      executed: true,
      taskId: command?.taskId,
      actor: command?.actor,
      reviewRole: command?.review.reviewerRole,
      evidence: [
        `recorded ${command?.review.reviewerRole} for ${command?.taskId} via ${command?.actor}`,
        `authenticated principal ${result.principal.provider}:${result.principal.subject}`
      ]
    };
  };
}

async function closeWorkflowProofCoverageGaps(
  runId: string,
  taskId: string,
  options: {
    getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
    upsertCoverageGaps?: ((runId: string, gaps: CoverageGapRecord[]) => Promise<unknown>) | undefined;
  }
): Promise<number> {
  if (!options.upsertCoverageGaps) {
    return 0;
  }

  const proofSnapshot = await options.getStatusSnapshot(runId);
  const workflowProofGaps =
    proofSnapshot.autonomousExecution?.state.gaps.filter(
      (gap) =>
        gap.status === "open" &&
        (
          gap.targetId === `task:${taskId}` ||
          gap.suggestedNextActions.some((action) => /\bworkflow-proof\b/i.test(action))
        )
    ) ?? [];

  if (workflowProofGaps.length === 0) {
    return 0;
  }

  await options.upsertCoverageGaps(
    runId,
    workflowProofGaps.map((gap) => ({
      ...gap,
      status: "closed"
    }))
  );
  return workflowProofGaps.length;
}

function resolveWorkflowProofTaskIdForContinuationAction(
  action: ContinuationAction
): string | undefined {
  if (action.kind === "run_workflow_proof") {
    return action.taskId;
  }

  if (
    (action.kind === "resolve_blocking_gap" || action.kind === "resume_target") &&
    action.targetId.startsWith("task:")
  ) {
    const taskId = action.targetId.slice("task:".length).trim();
    return taskId.length > 0 ? taskId : undefined;
  }

  return undefined;
}

function isSelfReferentialResumeTarget(action: ContinuationAction): boolean {
  if (action.kind !== "resume_target") {
    return false;
  }

  return (
    (action.source === "progress_proof" && action.targetId.startsWith("proof:")) ||
    (action.source === "checkpoint" && action.targetId.startsWith("checkpoint:"))
  );
}

function validateResumeTargetSource(
  action: Extract<ContinuationAction, { kind: "resume_target" }>,
  autonomousState: AutonomousExecutionState
): { valid: true } | { valid: false; reason: string } {
  if (action.source === "progress_proof") {
    if (!action.sourceId?.trim()) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} is missing the originating progress proof id`
      };
    }

    const sourceProof = autonomousState.progressProofs.find((proof) => proof.proofId === action.sourceId);
    if (!sourceProof) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} references missing progress proof ${action.sourceId}`
      };
    }

    if (sourceProof.nextTarget.trim() !== action.targetId) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} no longer matches progress proof ${action.sourceId}`
      };
    }

    return { valid: true };
  }

  if (action.source === "checkpoint") {
    if (!action.sourceId?.trim()) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} is missing the originating checkpoint id`
      };
    }

    const sourceCheckpoint = autonomousState.checkpoints.find(
      (checkpoint) => checkpoint.checkpointId === action.sourceId
    );
    if (!sourceCheckpoint) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} references missing checkpoint ${action.sourceId}`
      };
    }

    if (!sourceCheckpoint.activeTargets.some((target) => target.trim() === action.targetId)) {
      return {
        valid: false,
        reason: `resume target ${action.targetId} no longer matches checkpoint ${action.sourceId}`
      };
    }

    return { valid: true };
  }

  return {
    valid: false,
    reason: `resume target ${action.targetId} uses unsupported source ${action.source}`
  };
}

export function createSupportedContinuationExecutor(options: {
  env?: EnvShape | undefined;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
  getReviews: (runId: string, taskId: string) => Promise<readonly ReviewRecord[]>;
  getApprovals: (runId: string, taskId: string) => Promise<readonly ApprovalRecord[]>;
  upsertCoverageGaps?: ((runId: string, gaps: CoverageGapRecord[]) => Promise<unknown>) | undefined;
  recordProgressProof?: ((runId: string, proof: ProgressProofRecord) => Promise<unknown>) | undefined;
  checkpointRun?: ((
    runId: string,
    checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">,
    options?: {
      authorityLabel?: CheckpointRecord["authorityLabel"] | undefined;
    }
  ) => Promise<unknown>) | undefined;
  now?: (() => Date) | undefined;
}): NonNullable<ExecuteDirectiveStepOptions["executeContinuationAction"]> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  return async ({ runId, directive, action }) => {
    const workflowProofTaskId = resolveWorkflowProofTaskIdForContinuationAction(action);
    if (!workflowProofTaskId) {
      if (
        action.kind === "resume_target" &&
        (action.targetId === "review:authenticated" || isSelfReferentialResumeTarget(action))
      ) {
        const snapshot = await options.getStatusSnapshot(runId);
        const autonomousState = snapshot.autonomousExecution?.state;
        const approvedTasks = snapshot.tasks.filter((task) => task.status === "approved");

        if (!autonomousState) {
          return {
            executed: false,
            taskId: directive.targetId,
            evidence: ["autonomous execution state is unavailable for stale resume-target normalization"]
          };
        }
        const sourceValidation = validateResumeTargetSource(action, autonomousState);
        if (!sourceValidation.valid) {
          return {
            executed: false,
            taskId: directive.targetId,
            evidence: [sourceValidation.reason]
          };
        }
        if (action.targetId === "review:authenticated" && approvedTasks.length !== 1) {
          return {
            executed: false,
            taskId: directive.targetId,
            evidence: [
              `review:authenticated resume normalization requires exactly one approved task, found ${approvedTasks.length}`
            ]
          };
        }

        const createdAt = now().toISOString();
        const approvedTask = approvedTasks[0];
        const taskId = approvedTask?.packet.taskId ?? directive.targetId;
        const evidenceRef = approvedTask
          ? `runtime://task/${approvedTask.packet.taskId}`
          : `runtime://autonomous/${action.source}/${action.targetId.replaceAll(":", "/")}`;

        if (action.source === "progress_proof") {
          if (!options.recordProgressProof) {
            return {
              executed: false,
              taskId,
              evidence: ["no supported continuation executor is available to normalize stale progress proofs"]
            };
          }

          const nextCycle =
            autonomousState.progressProofs.reduce((highest, proof) => Math.max(highest, proof.cycle), 0) + 1;
          const whyNext =
            action.targetId === "review:authenticated"
              ? "stale review:authenticated progress target was already satisfied"
              : `stale self-referential progress target ${action.targetId} was already exhausted`;
          await options.recordProgressProof(runId, {
            cycle: nextCycle,
            proofId: `proof-autoresume-${createdAt}`,
            phaseBefore: autonomousState.phase,
            phaseAfter: autonomousState.phase,
            evidenceRefs: [evidenceRef],
            coverageDelta: {},
            blockingGapDelta: { closed: 1, opened: 0 },
            nextTarget: "   ",
            whyNext,
            createdAt
          });

          return {
            executed: true,
            taskId,
            evidence: [
              action.targetId === "review:authenticated"
                ? `cleared stale progress-proof target review:authenticated for approved task ${approvedTask!.packet.taskId}`
                : `cleared stale self-referential progress-proof target ${action.targetId}`
            ]
          };
        }

        if (action.source === "checkpoint") {
          if (!options.checkpointRun) {
            return {
              executed: false,
              taskId,
              evidence: ["no supported continuation executor is available to normalize stale checkpoints"]
            };
          }

          const latestCheckpoint = [...autonomousState.checkpoints].sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt)
          )[0];
          await options.checkpointRun(
            runId,
            {
              checkpointId: `cp-autoresume-${createdAt}`,
              phase: autonomousState.phase,
              activeTargets: [],
              recentEvidenceRefs: [evidenceRef],
              openGaps: autonomousState.gaps
                .filter((gap) => gap.status === "open")
                .map((gap) => gap.id),
              nextActions: [],
              compressedContextRef: latestCheckpoint?.compressedContextRef,
              createdAt
            },
            {
              authorityLabel: "operator_import"
            }
          );

          return {
            executed: true,
            taskId,
            evidence: [
              action.targetId === "review:authenticated"
                ? `cleared stale checkpoint target review:authenticated for approved task ${approvedTask!.packet.taskId}`
                : `cleared stale self-referential checkpoint target ${action.targetId}`
            ]
          };
        }
      }

      return {
        executed: false,
        taskId: directive.targetId,
        evidence: [
          action.kind === "resume_target"
            ? `no supported continuation executor is available for resume_target target=${action.targetId} source=${action.source}${action.sourceId ? ` sourceId=${action.sourceId}` : ""}`
            : `no supported continuation executor is available for ${action.kind}`
        ]
      };
    }

    try {
      await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", workflowProofTaskId], {
        env,
        getStatusSnapshot: options.getStatusSnapshot,
        getReviews: options.getReviews,
        getApprovals: options.getApprovals
      });
    } catch (error) {
      return {
        executed: false,
        taskId: workflowProofTaskId,
        evidence: [error instanceof Error ? error.message : String(error)]
      };
    }

    const closedGapCount = await closeWorkflowProofCoverageGaps(runId, workflowProofTaskId, {
      getStatusSnapshot: options.getStatusSnapshot,
      upsertCoverageGaps: options.upsertCoverageGaps
    });

    return {
      executed: true,
      taskId: workflowProofTaskId,
      evidence: [
        closedGapCount > 0
          ? `workflow proof passed for ${workflowProofTaskId}; closed ${closedGapCount} autonomous gap(s)`
          : `workflow proof passed for ${workflowProofTaskId}`
      ]
    };
  };
}

async function recordReviewCommand(args: readonly string[]) {
  const result = await executeRecordReviewCommandFromArgs(args, {
    async recordReview({ command: reviewCommand, resolver }) {
      return withClient(async (client) => {
        const service = new ArchonCoreService(new PostgresStore(client), {
          resolveReviewActionContext: resolver
        });
        return service.recordReview(
          reviewCommand.runId,
          reviewCommand.taskId,
          reviewCommand.actor,
          reviewCommand.review
        );
      });
    }
  });

  console.log(JSON.stringify(result));
}

export async function executeStatusCommandFromArgs(
  args: readonly string[],
  options: ExecuteStatusCommandOptions
) {
  const env = options.env;
  const runId = await resolveRunIdForCommand(args, {
    env,
    findLatestRun: options.findLatestRun
  });
  const daemonSupervisorHistoryOptions = resolveDaemonSupervisorHistoryReadOptions(args, env, runId);

  const staleAfterDaysValue = resolveCommandFlag(args, "--stale-after-days") ?? "1";
  const staleAfterDays = Number.parseInt(staleAfterDaysValue, 10);
  if (!Number.isInteger(staleAfterDays) || staleAfterDays < 0) {
    throw new Error(`Invalid --stale-after-days value: ${staleAfterDaysValue}`);
  }

  const reviewIdentity = options.inspectReviewIdentity
    ? await options.inspectReviewIdentity()
    : await inspectReviewIdentityStatus({
        cwd: options.cwd,
        env
      });
  const graphify = options.inspectGraphify
    ? await options.inspectGraphify()
    : await inspectGraphifyStatus({
        cwd: options.cwd
      });
  const [snapshot, executionPlan] = await Promise.all([
    options.getStatusSnapshot(runId),
    options.getExecutionPlan ? options.getExecutionPlan(runId, staleAfterDays * 24) : Promise.resolve(undefined)
  ]);
  const [runtimeState, localActiveExport, localQueueExport] = await Promise.all([
    options.getProjectRuntimeState ? options.getProjectRuntimeState(snapshot.run.projectId) : Promise.resolve(undefined),
    readActiveWorkflowExport(options.cwd ?? process.cwd()),
    readTaskQueueExport(options.cwd ?? process.cwd())
  ]);
  const daemonContinuation = await readDaemonContinuationStatus(options.cwd ?? process.cwd());
  const daemonHandoff = await readDaemonOperatorHandoff(options.cwd ?? process.cwd());
  const daemonSupervisor = await readDaemonSupervisorStatus(
    options.cwd ?? process.cwd(),
    daemonSupervisorHistoryOptions
  );
  const contradictions: string[] = [];
  const seedFailure = readSeedFailureMetadata(runtimeState);
  const lastIntegrityRepair = readLastIntegrityRepairMetadata(runtimeState);
  if (runtimeState) {
    const runtimeQueue = parseTaskQueueRecordOrDefault(runtimeState.taskQueue);
    const runtimeActiveTaskId = runtimeState.activeTaskId ?? null;
    const localClaimsComplete =
      localActiveExport.activeState === "complete" || isCompleteProjectStatus(localQueueExport.project_status);

    if (seedFailure?.recoveryState === "stale_metadata") {
      contradictions.push(
        "runtime state still carries persisted seed failure metadata after authoritative workflow proof"
      );
    }

    if (localClaimsComplete && !runtimeState.lastVerifiedRunId) {
      contradictions.push("local exports claim complete but runtime state has no authoritative workflow proof");
    }
    if (localClaimsComplete && snapshot.run.status !== "approved" && snapshot.run.status !== "done") {
      contradictions.push(`local exports claim complete while runtime run status is ${snapshot.run.status}`);
    }
    if ((localActiveExport.activeTaskId ?? localQueueExport.current_task_id ?? null) !== runtimeActiveTaskId) {
      const localTaskId = localActiveExport.activeTaskId ?? localQueueExport.current_task_id ?? null;
      if (localTaskId || runtimeActiveTaskId) {
        contradictions.push(
          `local active task ${localTaskId ?? "none"} disagrees with runtime active task ${runtimeActiveTaskId ?? "none"}`
        );
      }
    }
    if ((localQueueExport.current_task_id ?? null) !== (runtimeQueue.current_task_id ?? null)) {
      contradictions.push(
        `local queue current task ${localQueueExport.current_task_id ?? "none"} disagrees with runtime queue current task ${runtimeQueue.current_task_id ?? "none"}`
      );
    }
  }

  return buildOperatorStatusReport({
    snapshot,
    executionPlan,
    daemonContinuation,
    daemonHandoff,
    daemonSupervisor,
    reviewIdentity,
    graphify,
    integrity: runtimeState
      ? {
          authorityLabel: "derived_only",
          status: contradictions.length > 0 ? "contradicted" : "consistent",
          contradictions,
          runtimeState: {
            authorityLabel: "runtime_authoritative",
            activeTaskId: runtimeState.activeTaskId ?? null,
            projectStatus: parseTaskQueueRecordOrDefault(runtimeState.taskQueue).project_status,
            lastVerifiedRunId: runtimeState.lastVerifiedRunId ?? null,
            seedFailure,
            lastIntegrityRepair
          },
          localExports: {
            authorityLabel: "derived_only",
            activeState: localActiveExport.activeState,
            activeTaskId: localActiveExport.activeTaskId,
            queueProjectStatus: localQueueExport.project_status,
            queueCurrentTaskId: localQueueExport.current_task_id
          }
        }
      : {
          authorityLabel: "derived_only",
          status: "unavailable",
          contradictions: []
        },
    staleAfterDays
  });
}

export interface AutonomousCoverageCommandReport {
  authorityLabel: "runtime_authoritative";
  runId: string;
  autonomous: AutonomousOperatorSummary;
  items: CoverageItemRecord[];
}

export interface AutonomousGapsCommandReport {
  authorityLabel: "runtime_authoritative";
  runId: string;
  autonomous: AutonomousOperatorSummary;
  gaps: CoverageGapRecord[];
}

export interface AutonomousCheckpointCommandReport {
  authorityLabel: "runtime_authoritative";
  runId: string;
  autonomous: AutonomousOperatorSummary;
  checkpoints: CheckpointRecord[];
  latestCheckpoint?: CheckpointRecord | undefined;
  latestProgressProof?: ProgressProofRecord | undefined;
  updatedCheckpointId?: string | undefined;
}

export interface AutonomousResumeCommandReport {
  authorityLabel: "runtime_authoritative";
  runId: string;
  autonomous: AutonomousOperatorSummary;
  executionPlan: RunExecutionPlan;
}

export interface ExecuteCoverageCommandOptions {
  env?: EnvShape | undefined;
  findLatestRun?: (workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>;
  getStatusSnapshot: (runId: string) => Promise<RunStatusSnapshot>;
}

export interface ExecuteGapsCommandOptions extends ExecuteCoverageCommandOptions {}

export interface ExecuteCheckpointCommandOptions extends ExecuteCoverageCommandOptions {
  cwd?: string | undefined;
  checkpointRun?: (
    runId: string,
    checkpoint: Omit<CheckpointRecord, "runId" | "authorityLabel">,
    options?: {
      authorityLabel?: CheckpointRecord["authorityLabel"] | undefined;
    }
  ) => Promise<unknown>;
}

export interface ExecuteResumeCommandOptions {
  env?: EnvShape | undefined;
  findLatestRun?: (workspaceSlug: string, projectSlug: string) => Promise<{ id: string } | undefined>;
  getResumeSnapshot: (runId: string) => Promise<import("./domain/types.ts").RunResumeSnapshot>;
}

function buildCoverageCommandReport(snapshot: RunStatusSnapshot): AutonomousCoverageCommandReport {
  return {
    authorityLabel: "runtime_authoritative",
    runId: snapshot.run.id,
    autonomous: buildAutonomousOperatorSummary({ snapshot }),
    items: snapshot.autonomousExecution ? [...snapshot.autonomousExecution.state.coverageItems] : []
  };
}

function buildGapsCommandReport(snapshot: RunStatusSnapshot, gaps: CoverageGapRecord[]): AutonomousGapsCommandReport {
  return {
    authorityLabel: "runtime_authoritative",
    runId: snapshot.run.id,
    autonomous: buildAutonomousOperatorSummary({ snapshot }),
    gaps
  };
}

function buildCheckpointCommandReport(input: {
  snapshot: RunStatusSnapshot;
  updatedCheckpointId?: string | undefined;
}): AutonomousCheckpointCommandReport {
  const autonomous = buildAutonomousOperatorSummary({ snapshot: input.snapshot });
  return {
    authorityLabel: "runtime_authoritative",
    runId: input.snapshot.run.id,
    autonomous,
    checkpoints: input.snapshot.autonomousExecution ? [...input.snapshot.autonomousExecution.state.checkpoints] : [],
    latestCheckpoint: autonomous.latestCheckpoint,
    latestProgressProof: autonomous.latestProgressProof,
    updatedCheckpointId: input.updatedCheckpointId
  };
}

function buildResumeCommandReport(
  snapshot: import("./domain/types.ts").RunResumeSnapshot
): AutonomousResumeCommandReport {
  return {
    authorityLabel: "runtime_authoritative",
    runId: snapshot.run.id,
    autonomous: buildAutonomousOperatorSummary({
      snapshot,
      executionPlan: snapshot.executionPlan
    }),
    executionPlan: snapshot.executionPlan
  };
}

function formatCoverageCommandReport(report: AutonomousCoverageCommandReport): string {
  const lines = [
    `Run ${report.runId}`,
    `configured: ${report.autonomous.configured ? "yes" : "no"}`,
    `resume: ${report.autonomous.resume.summary}`
  ];

  if (!report.autonomous.configured) {
    lines.push(
      `autonomy-note: run-level workflow proof can still be valid; no active autonomous continuation target is recorded for this run`
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(`profile: ${report.autonomous.profile}`);
  lines.push(`phase: ${report.autonomous.phase}`);
  lines.push(`items: ${report.items.length}`);
  if (report.autonomous.coverageSummary) {
    lines.push(
      `coverage: critical=${report.autonomous.coverageSummary.criticalItemCoverage} validation=${report.autonomous.coverageSummary.criticalItemValidation} callsites=${report.autonomous.coverageSummary.callsiteCoverage} runtime-traces=${report.autonomous.coverageSummary.runtimeTraceCoverage}`
    );
    lines.push(
      `gaps: open=${report.autonomous.coverageSummary.openGapCount} blocking=${report.autonomous.coverageSummary.blockingGapCount}`
    );
  }
  if (report.autonomous.blockers.length > 0) {
    for (const blocker of report.autonomous.blockers) {
      lines.push(`blocked: ${blocker}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatGapsCommandReport(report: AutonomousGapsCommandReport): string {
  const lines = [
    `Run ${report.runId}`,
    `configured: ${report.autonomous.configured ? "yes" : "no"}`,
    `gaps: ${report.gaps.length}`
  ];
  if (report.gaps.length === 0) {
    lines.push(`resume: ${report.autonomous.resume.summary}`);
    if (!report.autonomous.configured) {
      lines.push(
        `autonomy-note: run-level workflow proof can still be valid; no active autonomous continuation target is recorded for this run`
      );
    }
    return `${lines.join("\n")}\n`;
  }
  for (const gap of report.gaps) {
    lines.push(
      `${gap.id} severity=${gap.severity} blocking=${gap.blocking ? "yes" : "no"} target=${gap.targetId}: ${gap.description}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatCheckpointCommandReport(report: AutonomousCheckpointCommandReport): string {
  const lines = [
    `Run ${report.runId}`,
    `configured: ${report.autonomous.configured ? "yes" : "no"}`,
    `checkpoints: ${report.checkpoints.length}`
  ];
  if (report.updatedCheckpointId) {
    lines.push(`updated-checkpoint: ${report.updatedCheckpointId}`);
  }
  if (report.latestCheckpoint) {
    lines.push(
      `latest-checkpoint: ${report.latestCheckpoint.checkpointId} authority=${report.latestCheckpoint.authorityLabel}`
    );
    if (report.latestCheckpoint.activeTargets.length > 0) {
      lines.push(`active-targets: ${report.latestCheckpoint.activeTargets.join(", ")}`);
    }
    if (report.latestCheckpoint.nextActions.length > 0) {
      lines.push(`next-actions: ${report.latestCheckpoint.nextActions.join("; ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatResumeCommandReport(report: AutonomousResumeCommandReport): string {
  const lines = [
    `Run ${report.runId}`,
    `directive: ${report.executionPlan.directive.kind}`,
    `resume: ${report.autonomous.resume.status}/${report.autonomous.resume.source} ${report.autonomous.resume.summary}`
  ];
  if (report.autonomous.resume.nextTarget) {
    lines.push(`next-target: ${report.autonomous.resume.nextTarget}`);
  }
  if (report.autonomous.resume.nextActions.length > 0) {
    lines.push(`next-actions: ${report.autonomous.resume.nextActions.join("; ")}`);
  }
  if (report.autonomous.resume.blockers.length > 0) {
    for (const blocker of report.autonomous.resume.blockers) {
      lines.push(`blocked: ${blocker}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function readCheckpointInput(
  inputArg: string,
  cwd: string
): Promise<Omit<CheckpointRecord, "runId" | "authorityLabel">> {
  const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(cwd, inputArg);
  await validateCheckpointInputPath(inputPath, cwd);
  const fileStats = await stat(inputPath);
  if (fileStats.size > MAX_CHECKPOINT_INPUT_BYTES) {
    throw new Error(
      `checkpoint input from ${inputPath} exceeds the maximum size of ${MAX_CHECKPOINT_INPUT_BYTES} bytes`
    );
  }
  const content = await readFile(inputPath, "utf8");
  const parsed = JSON.parse(content) as unknown;
  return parseCheckpointInput(parsed, inputPath);
}

function parseCheckpointInput(
  input: unknown,
  sourceLabel: string
): Omit<CheckpointRecord, "runId" | "authorityLabel"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`checkpoint input from ${sourceLabel} must be a JSON object`);
  }

  const record = input as Record<string, unknown>;
  const checkpointId = readRequiredStringField(record, "checkpointId", sourceLabel);
  const phase = readRequiredStringField(record, "phase", sourceLabel);
  validateCheckpointString(checkpointId, "checkpointId");
  if (!analysisPhases.includes(phase as (typeof analysisPhases)[number])) {
    throw new Error(`checkpoint input from ${sourceLabel} has invalid phase: ${phase}`);
  }

  const activeTargets = readRequiredStringArrayField(record, "activeTargets", sourceLabel);
  const recentEvidenceRefs = readRequiredStringArrayField(record, "recentEvidenceRefs", sourceLabel);
  const openGaps = readRequiredStringArrayField(record, "openGaps", sourceLabel);
  const nextActions = readRequiredStringArrayField(record, "nextActions", sourceLabel);
  const compressedContextRef = readOptionalStringField(record, "compressedContextRef");
  const createdAt = readRequiredStringField(record, "createdAt", sourceLabel);

  validateCheckpointStringArray(activeTargets, "activeTargets");
  validateCheckpointStringArray(recentEvidenceRefs, "recentEvidenceRefs");
  validateCheckpointStringArray(openGaps, "openGaps");
  validateCheckpointStringArray(nextActions, "nextActions");
  validateCheckpointTimestamp(createdAt, sourceLabel);
  if (compressedContextRef) {
    validateCompressedContextRef(compressedContextRef);
  }

  return {
    checkpointId,
    phase: phase as CheckpointRecord["phase"],
    activeTargets,
    recentEvidenceRefs,
    openGaps,
    nextActions,
    compressedContextRef,
    createdAt
  };
}

async function validateCheckpointInputPath(inputPath: string, cwd: string): Promise<void> {
  const [resolvedInputPath, resolvedCwd] = await Promise.all([realpath(inputPath), realpath(cwd)]);
  const relativePath = path.relative(resolvedCwd, resolvedInputPath);
  if (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  ) {
    return;
  }
  throw new Error(`checkpoint input path must stay within ${resolvedCwd}`);
}

function readRequiredStringField(
  record: Record<string, unknown>,
  field: string,
  sourceLabel: string
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`checkpoint input from ${sourceLabel} is missing required string field ${field}`);
  }
  return value.trim();
}

function readOptionalStringField(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`checkpoint input has invalid optional string field ${field}`);
  }
  return value.trim();
}

function readRequiredStringArrayField(
  record: Record<string, unknown>,
  field: string,
  sourceLabel: string
): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`checkpoint input from ${sourceLabel} is missing required string[] field ${field}`);
  }
  return value.map((entry) => entry.trim());
}

function validateCheckpointString(value: string, field: string): void {
  if (value.length > MAX_CHECKPOINT_STRING_LENGTH) {
    throw new Error(`checkpoint input has ${field} longer than ${MAX_CHECKPOINT_STRING_LENGTH} characters`);
  }
  if (/[\r\n\t]/.test(value)) {
    throw new Error(`checkpoint input has invalid control characters in ${field}`);
  }
}

function validateCheckpointStringArray(values: readonly string[], field: string): void {
  if (values.length > MAX_CHECKPOINT_ARRAY_ITEMS) {
    throw new Error(`checkpoint input has too many ${field} entries`);
  }
  for (const value of values) {
    validateCheckpointString(value, `${field}[]`);
  }
}

function validateCheckpointTimestamp(value: string, sourceLabel: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`checkpoint input from ${sourceLabel} has invalid createdAt timestamp`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`checkpoint input from ${sourceLabel} has invalid createdAt timestamp`);
  }
  if (parsed > Date.now() + MAX_CHECKPOINT_FUTURE_SKEW_MS) {
    throw new Error(`checkpoint input from ${sourceLabel} has createdAt too far in the future`);
  }
}

function validateCompressedContextRef(value: string): void {
  validateCheckpointString(value, "compressedContextRef");
  if (!value.startsWith("memory://")) {
    throw new Error("checkpoint input has invalid compressedContextRef scheme");
  }
}

export async function executeCoverageCommandFromArgs(
  args: readonly string[],
  options: ExecuteCoverageCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveFormatFlag(args);
  const snapshot = await options.getStatusSnapshot(runId);
  return {
    format,
    report: buildCoverageCommandReport(snapshot)
  };
}

export async function executeGapsCommandFromArgs(
  args: readonly string[],
  options: ExecuteGapsCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveFormatFlag(args);
  const snapshot = await options.getStatusSnapshot(runId);
  const allGaps = snapshot.autonomousExecution?.state.gaps ?? [];
  const includeClosed = args.includes("--all");
  const blockingOnly = args.includes("--blocking-only");
  const gaps = allGaps.filter((gap) => (includeClosed ? true : gap.status === "open")).filter((gap) =>
    blockingOnly ? gap.blocking && (includeClosed ? true : gap.status === "open") : true
  );
  return {
    format,
    report: buildGapsCommandReport(snapshot, gaps)
  };
}

export async function executeCheckpointCommandFromArgs(
  args: readonly string[],
  options: ExecuteCheckpointCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveFormatFlag(args);
  const inputArg = resolveCommandFlag(args, "--input");
  let updatedCheckpointId: string | undefined;
  if (inputArg) {
    if (!options.checkpointRun) {
      throw new Error("checkpoint mutation is not available for this command surface");
    }
    const checkpoint = await readCheckpointInput(inputArg, options.cwd ?? process.cwd());
    await options.checkpointRun(runId, checkpoint, {
      authorityLabel: "operator_import"
    });
    updatedCheckpointId = checkpoint.checkpointId;
  }
  const snapshot = await options.getStatusSnapshot(runId);
  return {
    format,
    report: buildCheckpointCommandReport({
      snapshot,
      updatedCheckpointId
    })
  };
}

export async function executeResumeCommandFromArgs(
  args: readonly string[],
  options: ExecuteResumeCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveFormatFlag(args);
  const snapshot = await options.getResumeSnapshot(runId);
  return {
    format,
    report: buildResumeCommandReport(snapshot)
  };
}

async function runtimePathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function resolveProjectSelector(
  args: readonly string[],
  env: EnvShape
): { workspaceSlug: string; projectSlug: string } {
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("doctor requires workspace/project context when no explicit run id is provided");
  }

  return { workspaceSlug, projectSlug };
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readJsonFileIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function syncRuntimeMigrationJournal(options: {
  store: PostgresStore;
  workspace: WorkspaceRecord;
  project: ProjectRecord;
  repoPath: string;
  status: string;
  runId?: string | undefined;
}): Promise<RuntimeMigrationJournalRecord | undefined> {
  const runtimeDir = path.join(options.repoPath, ".archon", "runtime");
  const migrationReportPath = path.join(runtimeDir, "migration-report.json");
  const registrationIntentPath = path.join(runtimeDir, "registration-intent.json");
  const backupManifestPath = path.join(runtimeDir, "backup-manifest.json");
  const migrationReport = await readJsonFileIfExists<{
    status?: string;
    cleanupRecommendation?: string;
    conflicts?: string[];
    orphans?: string[];
  }>(migrationReportPath);

  if (!migrationReport) {
    return undefined;
  }

  const registrationIntent = await readJsonFileIfExists<Record<string, unknown>>(registrationIntentPath);
  const backupManifest = await readJsonFileIfExists<Record<string, unknown>>(backupManifestPath);
  const timestamp = new Date().toISOString();
  const journal: RuntimeMigrationJournalRecord = {
    id: `runtime-migration:${options.project.id}:external-runtime-refactor`,
    workspaceId: options.workspace.id,
    projectId: options.project.id,
    runId: options.runId,
    phase: "external-runtime-refactor",
    status: options.status,
    backupManifestPath,
    verificationReportPath: migrationReportPath,
    rollbackState: backupManifest ? "backup_manifest_recorded" : "not_available",
    details: {
      reportedStatus: migrationReport.status ?? "planned",
      cleanupRecommendation: migrationReport.cleanupRecommendation ?? null,
      conflicts: migrationReport.conflicts ?? [],
      orphans: migrationReport.orphans ?? [],
      registrationIntentPath,
      registrationIntent,
      backupManifest
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await options.store.saveRuntimeMigrationJournal(journal);
  return journal;
}

export async function executeDoctorCommandFromArgs(
  args: readonly string[],
  options: ExecuteDoctorCommandOptions
): Promise<DoctorCommandReport> {
  const env = options.env ?? process.env;
  const explicitRunId = resolveCommandFlag(args, "--run-id");
  const projectSelector =
    explicitRunId && explicitRunId !== "latest"
      ? {
          workspaceSlug: resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG ?? "unknown",
          projectSlug: resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG ?? "unknown"
        }
      : resolveProjectSelector(args, env);
  const latestRun =
    explicitRunId === "latest" || !explicitRunId
      ? await options.findLatestRun?.(projectSelector.workspaceSlug, projectSelector.projectSlug)
      : undefined;
  const resolvedRunId =
    explicitRunId && explicitRunId !== "latest" ? explicitRunId : latestRun?.id;
  const snapshot = resolvedRunId ? await options.getStatusSnapshot(resolvedRunId) : undefined;
  const projectContext =
    projectSelector.workspaceSlug !== "unknown" && projectSelector.projectSlug !== "unknown"
      ? await options.findProjectContext?.(projectSelector.workspaceSlug, projectSelector.projectSlug)
      : undefined;

  if (!snapshot && !projectContext) {
    throw new Error(`Project ${projectSelector.workspaceSlug}/${projectSelector.projectSlug} is not bootstrapped`);
  }

  const projectId = snapshot?.run.projectId ?? projectContext?.project.id;
  const workspaceId = snapshot?.run.workspaceId ?? projectContext?.workspace.id;
  if (!projectId || !workspaceId) {
    throw new Error("doctor could not resolve project context");
  }

  const registration = await options.getProjectRuntimeRegistration(projectId);
  const reviewIdentity = options.inspectReviewIdentity
    ? await options.inspectReviewIdentity()
    : await inspectReviewIdentityStatus({
        cwd: options.cwd,
        env
      });
  const currentRepoPath = path.resolve(options.cwd ?? process.cwd());
  const canAccessPath = options.pathExists ?? runtimePathExists;

  const registrationCheck = registration
    ? {
        authorityLabel: "runtime_authoritative" as const,
        ok: true,
        summary: "runtime registration present"
      }
    : {
        authorityLabel: "runtime_authoritative" as const,
        ok: false,
        summary: "project is bootstrapped but not runtime-registered"
      };

  const repoPathCheck = registration
    ? path.resolve(registration.repoPath) === currentRepoPath
      ? {
          authorityLabel: "runtime_authoritative" as const,
          ok: true,
          summary: "repo path matches runtime registration"
        }
      : {
          authorityLabel: "runtime_authoritative" as const,
          ok: false,
          summary: `repo path mismatch: registered ${registration.repoPath}, current ${currentRepoPath}`
        }
    : {
        authorityLabel: "runtime_authoritative" as const,
        ok: false,
        summary: "repo path could not be checked without runtime registration"
      };

  const dataRootCheck = registration
    ? (await canAccessPath(registration.dataRoot))
      ? {
          authorityLabel: "runtime_authoritative" as const,
          ok: true,
          summary: "runtime data root is accessible"
        }
      : {
          authorityLabel: "runtime_authoritative" as const,
          ok: false,
          summary: `runtime data root is missing or inaccessible: ${registration.dataRoot}`
        }
    : {
        authorityLabel: "runtime_authoritative" as const,
        ok: false,
        summary: "runtime data root could not be checked without runtime registration"
      };

  const reviewIdentityCheck = {
    authorityLabel: "derived_only" as const,
    ok: reviewIdentity.liveTrustReady,
    summary: reviewIdentity.liveTrustReady
      ? "review identity bindings are live-trust ready"
      : reviewIdentity.notes[0] ?? "review identity is not live-trust ready"
  };

  const checks = {
    registration: registrationCheck,
    repoPath: repoPathCheck,
    dataRoot: dataRootCheck,
    reviewIdentity: reviewIdentityCheck
  };

  const blockers = [
    registrationCheck,
    repoPathCheck,
    dataRootCheck
  ]
    .filter((check) => !check.ok)
    .map((check) => check.summary);
  const advisories = reviewIdentityCheck.ok ? [] : [reviewIdentityCheck.summary];

  return {
    ok: blockers.length === 0,
    run: snapshot
      ? {
          authorityLabel: "runtime_authoritative" as const,
          id: snapshot.run.id,
          workspaceId: snapshot.run.workspaceId,
          projectId: snapshot.run.projectId
        }
      : undefined,
    project: {
      authorityLabel: "runtime_authoritative" as const,
      workspaceSlug: projectSelector.workspaceSlug,
      projectSlug: projectSelector.projectSlug,
      workspaceId,
      projectId
    },
    runtime: {
      authorityLabel: "runtime_authoritative" as const,
      runtimeMode: registration?.runtimeProfile ? runtimeModeFromProfile(registration.runtimeProfile) : undefined,
      runtimeProfile: registration?.runtimeProfile,
      dataRoot: registration?.dataRoot
    },
    checks,
    blockers,
    advisories
  };
}

function buildDoctorExecutionReady(report: DoctorCommandReport): boolean {
  return report.ok && report.checks.reviewIdentity.ok;
}

function isDoctorBootstrapRepairableError(error: unknown): boolean {
  const message = extractRuntimeExecutionErrorMessage(error);
  return (
    /is not bootstrapped/i.test(message) ||
    /doctor could not resolve project context/i.test(message)
  );
}

async function runSpawnedCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: EnvShape;
  }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit"
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

async function runLocalDoctorSetupRepair(cwd: string, env: EnvShape): Promise<void> {
  const isWindows = process.platform === "win32";
  const candidates = isWindows
    ? [
        path.join(cwd, "scripts", "archon-setup.ps1"),
        path.join(cwd, "scripts", "setup-archon.ps1")
      ]
    : [
        path.join(cwd, "scripts", "archon-setup.sh"),
        path.join(cwd, "scripts", "setup-archon.sh")
      ];

  for (const candidate of candidates) {
    if (!(await runtimePathExists(candidate))) {
      continue;
    }

    if (isWindows) {
      await runSpawnedCommand(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-File", candidate],
        { cwd, env }
      );
      return;
    }

    await runSpawnedCommand("bash", [candidate], { cwd, env });
    return;
  }

  const relativeCandidates = candidates.map((candidate) => path.relative(cwd, candidate) || candidate);
  throw new Error(`no local archon setup script found (${relativeCandidates.join(", ")})`);
}

async function runBootstrapAndVerifySetupRepair(): Promise<void> {
  await bootstrapProject();
  await verifySetup();
}

function resolveDoctorRepairPlan(input: {
  report?: DoctorCommandReport | undefined;
  error?: unknown;
}): {
  step: "setup_script" | "bootstrap_verify" | undefined;
  skippedReasons: string[];
} {
  const skippedReasons: string[] = [];

  if (input.error) {
    if (isRuntimeExecutionPreflightConnectionError(input.error)) {
      return {
        step: "setup_script",
        skippedReasons
      };
    }

    if (isDoctorBootstrapRepairableError(input.error)) {
      return {
        step: "bootstrap_verify",
        skippedReasons
      };
    }

    return {
      step: undefined,
      skippedReasons: [
        `doctor failed before a safe repair plan could be derived: ${extractRuntimeExecutionErrorMessage(input.error)}`
      ]
    };
  }

  const report = input.report;
  if (!report) {
    return {
      step: undefined,
      skippedReasons: ["doctor did not produce a report"]
    };
  }

  if (!report.checks.reviewIdentity.ok) {
    skippedReasons.push(
      `review identity requires live operator remediation: ${report.checks.reviewIdentity.summary}`
    );
  }

  if (!report.checks.registration.ok || !report.checks.repoPath.ok || !report.checks.dataRoot.ok) {
    return {
      step: "bootstrap_verify",
      skippedReasons
    };
  }

  if (!report.checks.dataRoot.ok) {
    return {
      step: "setup_script",
      skippedReasons
    };
  }

  return {
    step: undefined,
    skippedReasons
  };
}

function isDoctorSafeRuntimeReconcileAction(action: RuntimeStateReconcileAction): boolean {
  return (
    action === "rebuild_missing_runtime_state" ||
    action === "sync_active_task_to_in_progress" ||
    action === "activate_owner_dispatch_target"
  );
}

function resolveDoctorRepairReconcileOptions(
  options: ExecuteDoctorRepairCommandOptions
): ExecuteReconcileRuntimeStateCommandOptions | undefined {
  const getProjectContext =
    options.getProjectContext ??
    (options.findProjectContext
      ? async (params: { workspaceSlug: string; projectSlug: string }) =>
          options.findProjectContext!(params.workspaceSlug, params.projectSlug)
      : undefined);

  if (
    !getProjectContext ||
    !options.getProjectRuntimeState ||
    !options.saveProjectRuntimeState ||
    !options.getStatusSnapshot ||
    !options.getExecutionPlan ||
    !options.applyRecovery
  ) {
    return undefined;
  }

  return {
    cwd: options.cwd,
    env: options.env,
    findLatestRun: options.findLatestRun,
    getProjectContext,
    getProjectRuntimeState: options.getProjectRuntimeState,
    saveProjectRuntimeState: options.saveProjectRuntimeState,
    getStatusSnapshot: options.getStatusSnapshot,
    getExecutionPlan: options.getExecutionPlan,
    applyRecovery: options.applyRecovery
  };
}

function resolveDoctorRepairSyncOptions(
  options: ExecuteDoctorRepairCommandOptions
): ExecuteSyncRuntimeExportsCommandOptions | undefined {
  const getProjectContext =
    options.getProjectContext ??
    (options.findProjectContext
      ? async (params: { workspaceSlug: string; projectSlug: string }) =>
          options.findProjectContext!(params.workspaceSlug, params.projectSlug)
      : undefined);

  if (!getProjectContext || !options.getProjectRuntimeState) {
    return undefined;
  }

  return {
    cwd: options.cwd,
    env: options.env,
    getProjectContext,
    getProjectRuntimeState: options.getProjectRuntimeState
  };
}

function isIntegrityRepairStepLabel(stepLabel: string): boolean {
  return (
    stepLabel === "sync local workflow exports from runtime state" ||
    stepLabel === "sync local workflow exports from runtime state after persisted seed failure" ||
    stepLabel === "clear stale persisted seed failure metadata after authoritative proof" ||
    stepLabel === "reconcile authoritative runtime task state"
  );
}

function deriveIntegrityRepairSteps(stepLabels: readonly string[]): string[] {
  return stepLabels.filter((stepLabel) => isIntegrityRepairStepLabel(stepLabel));
}

export async function executeDoctorRepairCommandFromArgs(
  args: readonly string[],
  options: ExecuteDoctorRepairCommandOptions
): Promise<DoctorRepairCommandResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const cleanArgs = stripCommandFlag(args, "--repair");
  const resolveStatusArgs = (runId: string) =>
    hasCommandFlag(cleanArgs, "--run-id") ? cleanArgs : (["--run-id", runId, ...cleanArgs] as const);
  const runBootstrapRepair = options.runBootstrapRepair ?? runBootstrapAndVerifySetupRepair;
  const runSetupRepair = options.runSetupRepair ?? runLocalDoctorSetupRepair;
  const repairStepsAttempted: string[] = [];
  const repairStepsApplied: string[] = [];
  let pendingSemanticRepair = false;

  let initialReport: DoctorCommandReport | undefined;
  let initialError: unknown;
  try {
    initialReport = await executeDoctorCommandFromArgs(cleanArgs, options);
  } catch (error) {
    initialError = error;
  }

  const plan = resolveDoctorRepairPlan({
    report: initialReport,
    error: initialError
  });
  const baseRepair: DoctorRepairObservation = {
    requested: true,
    attempted: false,
    status: "not_needed",
    executionReady: initialReport ? buildDoctorExecutionReady(initialReport) : false,
    stepsAttempted: repairStepsAttempted,
    stepsApplied: repairStepsApplied,
    integrityRepairsAttempted: deriveIntegrityRepairSteps(repairStepsAttempted),
    integrityRepairsApplied: deriveIntegrityRepairSteps(repairStepsApplied),
    skippedReasons: [...plan.skippedReasons]
  };

  if (!plan.step) {
    if (initialError) {
      return {
        ok: false,
        executionReady: false,
        report: initialReport,
        repair: {
          ...baseRepair,
          status: "failed",
          failure: extractRuntimeExecutionErrorMessage(initialError)
        }
      };
    }
  }

  let report = initialReport;
  let skippedReasons = [...plan.skippedReasons];

  if (plan.step) {
    const stepLabel =
      plan.step === "setup_script"
        ? "run local archon setup script"
        : "rerun bootstrap-project and verify-setup";
    repairStepsAttempted.push(stepLabel);

    try {
      if (plan.step === "setup_script") {
        await runSetupRepair(cwd, env);
      } else {
        await runBootstrapRepair();
      }
      repairStepsApplied.push(stepLabel);
      report = await executeDoctorCommandFromArgs(cleanArgs, options);
      const finalPlan = resolveDoctorRepairPlan({
        report
      });
      skippedReasons = [...new Set([...skippedReasons, ...finalPlan.skippedReasons])];
      if (finalPlan.step) {
        const executionReady = buildDoctorExecutionReady(report);
        return {
          ok: report.ok,
          executionReady,
          report,
          repair: {
            requested: true,
            attempted: repairStepsAttempted.length > 0,
            status: "failed",
            executionReady,
            stepsAttempted: repairStepsAttempted,
            stepsApplied: repairStepsApplied,
            integrityRepairsAttempted: deriveIntegrityRepairSteps(repairStepsAttempted),
            integrityRepairsApplied: deriveIntegrityRepairSteps(repairStepsApplied),
            skippedReasons,
            failure: `safe repair did not clear ${finalPlan.step}`
          }
        };
      }
    } catch (error) {
      return {
        ok: false,
        executionReady: false,
        report: initialReport,
        repair: {
          requested: true,
          attempted: repairStepsAttempted.length > 0,
          status: "failed",
          executionReady: false,
          stepsAttempted: repairStepsAttempted,
          stepsApplied: repairStepsApplied,
          integrityRepairsAttempted: deriveIntegrityRepairSteps(repairStepsAttempted),
          integrityRepairsApplied: deriveIntegrityRepairSteps(repairStepsApplied),
          skippedReasons,
          failure: extractRuntimeExecutionErrorMessage(error)
        }
      };
    }
  }

  const reconcileOptions = report ? resolveDoctorRepairReconcileOptions(options) : undefined;
  if (report && buildDoctorExecutionReady(report) && reconcileOptions) {
    const reconcileStepLabel = "reconcile authoritative runtime task state";
    const reconcileArgs = [
      "--workspace-slug",
      report.project.workspaceSlug,
      "--project-slug",
      report.project.projectSlug,
      "--format",
      "json"
    ] as const;
    const preview = await executeReconcileRuntimeStateCommandFromArgs(reconcileArgs, reconcileOptions);

    if (preview.result.runtimeStateChanged) {
      if (isDoctorSafeRuntimeReconcileAction(preview.result.repairAction)) {
        repairStepsAttempted.push(reconcileStepLabel);
        await executeReconcileRuntimeStateCommandFromArgs(
          [
            ...reconcileArgs,
            "--apply"
          ],
          reconcileOptions
        );
        await persistIntegrityRepairRuntimeMetadata({
          report,
          options,
          source: "doctor_repair",
          kind: "runtime_task_reconcile",
          summary: reconcileStepLabel
        });
        repairStepsApplied.push(reconcileStepLabel);
        report = await executeDoctorCommandFromArgs(cleanArgs, options);
      } else {
        pendingSemanticRepair = true;
        skippedReasons = [
          ...new Set([
            ...skippedReasons,
            `runtime reconcile requires operator review: ${preview.result.reason}`
          ])
        ];
      }
    }
  }

  if (report && report.run && buildDoctorExecutionReady(report)) {
    const statusReport = await executeStatusCommandFromArgs(resolveStatusArgs(report.run.id), options);
    if (statusReport.integrity.runtimeState?.seedFailure?.recoveryState === "stale_metadata") {
      const clearStepLabel = "clear stale persisted seed failure metadata after authoritative proof";
      repairStepsAttempted.push(clearStepLabel);
      const cleared = await clearStaleSeedFailureRuntimeMetadata({
        report,
        options
      });
      if (cleared) {
        repairStepsApplied.push(clearStepLabel);
        report = await executeDoctorCommandFromArgs(cleanArgs, options);
      } else {
        skippedReasons = [
          ...new Set([
            ...skippedReasons,
            "stale persisted seed failure metadata could not be auto-cleared"
          ])
        ];
      }
    }
  }

  const syncOptions = report ? resolveDoctorRepairSyncOptions(options) : undefined;
  if (report && report.run && buildDoctorExecutionReady(report) && syncOptions) {
    const statusReport = await executeStatusCommandFromArgs(resolveStatusArgs(report.run.id), options);
    const runtimeIntegrity = statusReport.integrity.runtimeState;
    const seedFailure = runtimeIntegrity?.seedFailure;
    let runtimeQueueTrusted = false;
    if (runtimeIntegrity) {
      try {
        const runtimeState = await options.getProjectRuntimeState?.(report.project.projectId);
        parseTaskQueueRecord(runtimeState?.taskQueue);
        runtimeQueueTrusted = true;
      } catch {
        runtimeQueueTrusted = false;
      }
    }
    const localWorkflowExportDrift =
      runtimeIntegrity !== undefined &&
      hasLocalWorkflowExportDrift({
        runtimeState: {
          activeTaskId: runtimeIntegrity.activeTaskId,
          projectStatus: runtimeIntegrity.projectStatus
        },
        localExports: statusReport.integrity.localExports
      });
    const safeToResyncLocalExports =
      ((statusReport.integrity.status === "contradicted") || (seedFailure !== undefined && localWorkflowExportDrift)) &&
      runtimeIntegrity !== undefined &&
      runtimeQueueTrusted &&
      (runtimeIntegrity.lastVerifiedRunId !== null || !isCompleteProjectStatus(runtimeIntegrity.projectStatus));

    if (safeToResyncLocalExports) {
      const syncStepLabel = seedFailure
        ? "sync local workflow exports from runtime state after persisted seed failure"
        : "sync local workflow exports from runtime state";
      repairStepsAttempted.push(syncStepLabel);
      const syncArgs = [
        "--workspace-slug",
        report.project.workspaceSlug,
        "--project-slug",
        report.project.projectSlug,
        "--format",
        "json"
      ] as const;
      await executeSyncRuntimeExportsCommandFromArgs(syncArgs, syncOptions);
      await persistIntegrityRepairRuntimeMetadata({
        report,
        options,
        source: "doctor_repair",
        kind: "local_export_resync",
        summary: syncStepLabel
      });
      repairStepsApplied.push(syncStepLabel);
    } else if (statusReport.integrity.status === "contradicted") {
      skippedReasons = [
        ...new Set([
          ...skippedReasons,
          "local workflow exports contradict runtime authority and could not be safely auto-repaired"
        ])
      ];
    }
  }

  if (!report) {
    return {
      ok: false,
      executionReady: false,
      report,
      repair: {
        requested: true,
        attempted: repairStepsAttempted.length > 0,
        status: "failed",
        executionReady: false,
        stepsAttempted: repairStepsAttempted,
        stepsApplied: repairStepsApplied,
        integrityRepairsAttempted: deriveIntegrityRepairSteps(repairStepsAttempted),
        integrityRepairsApplied: deriveIntegrityRepairSteps(repairStepsApplied),
        skippedReasons,
        failure: "doctor did not produce a report after repair"
      }
    };
  }

  const executionReady = buildDoctorExecutionReady(report) && !pendingSemanticRepair;
  const status =
    repairStepsApplied.length > 0 ? "repaired" : skippedReasons.length > 0 ? "skipped" : "not_needed";

  return {
    ok: report.ok,
    executionReady,
    report,
    repair: {
      requested: true,
      attempted: repairStepsAttempted.length > 0,
      status,
      executionReady,
      stepsAttempted: repairStepsAttempted,
      stepsApplied: repairStepsApplied,
      integrityRepairsAttempted: deriveIntegrityRepairSteps(repairStepsAttempted),
      integrityRepairsApplied: deriveIntegrityRepairSteps(repairStepsApplied),
      skippedReasons
    }
  };
}

async function executeRuntimeExecutionPreflight(
  args: readonly string[],
  options: ExecuteRuntimePreflightCommandOptions
): Promise<RuntimeExecutionPreflightFailure | undefined> {
  if (options.skipRuntimePreflight) {
    if (options.runtimePreflightBypassToken !== INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN) {
      throw new Error("skipRuntimePreflight is reserved for internal runtime execution orchestration");
    }
    return undefined;
  }

  const runtimeProjectContextResolver = (options as {
    getProjectContext?: ((
      params: {
        workspaceSlug: string;
        projectSlug: string;
      }
    ) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>) | undefined;
  }).getProjectContext;
  const findProjectContext =
    options.findProjectContext ??
    (runtimeProjectContextResolver
      ? (workspaceSlug: string, projectSlug: string) =>
          runtimeProjectContextResolver({
            workspaceSlug,
            projectSlug
          })
      : undefined);

  if (!options.getStatusSnapshot || !options.getProjectRuntimeRegistration || !findProjectContext) {
    if (options.requireRuntimePreflight) {
      throw new Error(
        "runtime execution preflight hooks are required for this execution path; use the CLI/runtime surface or provide the full runtime context"
      );
    }
    return undefined;
  }

  const report = await executeDoctorCommandFromArgs(args, {
    cwd: options.cwd,
    env: options.env,
    findLatestRun: options.findLatestRun,
    getStatusSnapshot: options.getStatusSnapshot,
    findProjectContext,
    getProjectRuntimeRegistration: options.getProjectRuntimeRegistration,
    pathExists: options.pathExists,
    inspectReviewIdentity: options.inspectReviewIdentity
  });

  const blockers = [...report.blockers];
  if (!report.checks.reviewIdentity.ok) {
    blockers.push(report.checks.reviewIdentity.summary);
  }

  if (blockers.length === 0) {
    return undefined;
  }

  return {
    blockers,
    reason: `runtime execution preflight failed: ${blockers.join(" | ")}`,
    activeRunId: report.run?.id ?? null,
    nextActions: [
      "run `npm run archon:doctor -- --repair` to replay safe runtime setup healing",
      "if task-state drift remains after services are healthy, run `npm run archon:reconcile` before retrying execution"
    ]
  };
}

async function doctorCommand(args: readonly string[]) {
  if (hasCommandFlag(args, "--repair")) {
    await withClient(async (client) => {
      const store = new PostgresStore(client);
      const service = new ArchonCoreService(store);
      const result = await executeDoctorRepairCommandFromArgs(args, {
        cwd: process.cwd(),
        env: process.env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        findProjectContext(workspaceSlug, projectSlug) {
          return store.getProjectContext({ workspaceSlug, projectSlug });
        },
        getProjectContext(params) {
          return store.getProjectContext(params);
        },
        getProjectRuntimeState(projectId) {
          return store.getProjectRuntimeState(projectId);
        },
        saveProjectRuntimeState(state) {
          return store.saveProjectRuntimeState(state);
        },
        getStatusSnapshot(runId) {
          return service.getStatus(runId);
        },
        getExecutionPlan(runId, staleAfterHours) {
          return service.getExecutionPlan(runId, { staleAfterHours });
        },
        applyRecovery(runId, actionIds, staleAfterHours) {
          return service.applyRecovery(runId, actionIds, { staleAfterHours });
        },
        getProjectRuntimeRegistration(projectId) {
          return store.getProjectRuntimeRegistration(projectId);
        }
      });
      console.log(JSON.stringify(result));
    });
    return;
  }

  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const report = await executeDoctorCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      findProjectContext(workspaceSlug, projectSlug) {
        return store.getProjectContext({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeRegistration(projectId) {
        return store.getProjectRuntimeRegistration(projectId);
      }
    });
    console.log(JSON.stringify(report));
  });
}

async function statusCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const report = await executeStatusCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      }
    });
    console.log(JSON.stringify(report));
  });
}

async function coverageCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, report } = await executeCoverageCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      }
    });

    if (format === "text") {
      process.stdout.write(formatCoverageCommandReport(report));
      return;
    }

    console.log(JSON.stringify(report));
  });
}

async function gapsCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, report } = await executeGapsCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      }
    });

    if (format === "text") {
      process.stdout.write(formatGapsCommandReport(report));
      return;
    }

    console.log(JSON.stringify(report));
  });
}

async function checkpointCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, report } = await executeCheckpointCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      checkpointRun(runId, checkpoint, checkpointOptions) {
        return service.checkpointRun(runId, checkpoint, checkpointOptions);
      }
    });

    if (format === "text") {
      process.stdout.write(formatCheckpointCommandReport(report));
      return;
    }

    console.log(JSON.stringify(report));
  });
}

async function resumeCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, report } = await executeResumeCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getResumeSnapshot(runId) {
        return service.resumeRun(runId);
      }
    });

    if (format === "text") {
      process.stdout.write(formatResumeCommandReport(report));
      return;
    }

    console.log(JSON.stringify(report));
  });
}

export async function executeOpsCommandFromArgs(
  args: readonly string[],
  options: ExecuteOpsCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);
  if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }

  const format = resolveFormatFlag(args);
  const [status, executionPlan, routing, recovery] = await Promise.all([
    executeStatusCommandFromArgs(args, options),
    options.getExecutionPlan(runId, staleAfterHours),
    options.getRoutingReport(runId),
    options.inspectRecovery(runId, staleAfterHours)
  ]);
  const report = buildOperatorDashboardReport({
    status,
    executionPlan,
    routing,
    recovery
  });

  return {
    format,
    report
  };
}

async function opsCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const result = await executeOpsCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      getRoutingReport(runId) {
        return service.recommendRouting(runId);
      },
      inspectRecovery(runId, staleAfterHours) {
        return service.inspectRecovery(runId, { staleAfterHours });
      }
    });

    if (result.format === "text") {
      process.stdout.write(formatOperatorDashboardReport(result.report));
      return;
    }

    console.log(JSON.stringify(result.report));
  });
}

export async function executeRecoverCommandFromArgs(
  args: readonly string[],
  options: ExecuteRecoverCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);
  if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }

  const applyValues = collectCommandFlagValues(args, "--apply");
  const applySafe = args.includes("--apply-safe");
  if (applyValues.length > 0 && applySafe) {
    throw new Error("recover accepts either --apply-safe or one/more --apply <action-id> flags, not both");
  }

  if (applyValues.length === 0 && !applySafe) {
    return options.inspectRecovery(runId, staleAfterHours);
  }

  const result = await options.applyRecovery(runId, applyValues, staleAfterHours);
  await persistRecoverIntegrityRepairMetadata({
    runId,
    options,
    appliedActionIds: result.appliedActionIds
  });
  return result;
}

async function recoverCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const result = await executeRecoverCommandFromArgs(args, {
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      inspectRecovery(runId, staleAfterHours) {
        return service.inspectRecovery(runId, { staleAfterHours });
      },
      applyRecovery(runId, actionIds, staleAfterHours) {
        return service.applyRecovery(runId, actionIds, { staleAfterHours });
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      }
    });
    console.log(JSON.stringify(result));
  });
}

export interface LoopCommandResult {
  mode: "advisory_only" | "applied" | "executed";
  runId: string;
  initialPlan: RunExecutionPlan;
  appliedRecoveryActionIds: string[];
  executedSteps: DirectiveExecutionResult["steps"];
  finalPlan: RunExecutionPlan;
  snapshot: RunStatusSnapshot;
}

function formatLoopCommandResult(result: LoopCommandResult): string {
  const lines = [
    `Run ${result.runId}`,
    `mode: ${result.mode}`,
    `initial-directive: ${result.initialPlan.directive.kind}`,
    `applied-safe-recovery: ${
      result.appliedRecoveryActionIds.length > 0 ? result.appliedRecoveryActionIds.join(", ") : "none"
    }`
  ];

  if (result.executedSteps.length > 0) {
    for (const step of result.executedSteps) {
      const targetParts = [step.taskId, step.reviewRole, step.actor].filter(Boolean);
      lines.push(
        `executed: ${step.directiveKind} ${step.outcome}${
          targetParts.length > 0 ? ` (${targetParts.join(", ")})` : ""
        }`
      );
    }
  } else {
    lines.push("executed: none");
  }

  lines.push(
    `final-directive: ${result.finalPlan.directive.kind}`
  );

  if (result.finalPlan.directive.kind === "dispatch_owner") {
    lines.push(
      `next: route ${result.finalPlan.directive.recommendation.taskId} to ${result.finalPlan.directive.recommendation.targetRole}`
    );
  } else if (result.finalPlan.directive.kind === "dispatch_reviews") {
    for (const recommendation of result.finalPlan.directive.recommendations) {
      if (recommendation.targetReviewRole) {
        lines.push(`next: request ${recommendation.targetReviewRole} for ${recommendation.taskId}`);
      }
    }
  } else if (result.finalPlan.directive.kind === "apply_recovery") {
    for (const action of result.finalPlan.directive.actions) {
      lines.push(`next: recover ${action.id}`);
    }
  } else if (result.finalPlan.directive.kind === "dispatch_subagents") {
    for (const investigation of result.finalPlan.directive.pendingInvestigations) {
      lines.push(`next: dispatch subagent ${investigation}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "rebuild_inventory") {
    if (result.finalPlan.directive.missingUnderstandingKinds.length > 0) {
      lines.push(`next: rebuild ${result.finalPlan.directive.missingUnderstandingKinds.join(", ")}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "trace_runtime") {
    if (result.finalPlan.directive.targetIds.length > 0) {
      lines.push(`next: trace ${result.finalPlan.directive.targetIds.join(", ")}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "checkpoint") {
    if (result.finalPlan.directive.checkpointId) {
      lines.push(`next: checkpoint ${result.finalPlan.directive.checkpointId}`);
    }
    if (result.finalPlan.directive.progressProofId) {
      lines.push(`next: proof ${result.finalPlan.directive.progressProofId}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "replan_migration") {
    lines.push(`next: replan ${result.finalPlan.directive.phase}`);
    if (result.finalPlan.directive.fallbackPhase) {
      lines.push(`next: fallback ${result.finalPlan.directive.fallbackPhase}`);
    }
    for (const action of result.finalPlan.directive.nextActions) {
      lines.push(`next: ${action}`);
    }
  } else if (result.finalPlan.directive.kind === "continue_analysis") {
    lines.push(`next: continue ${result.finalPlan.directive.targetId}`);
    if (result.finalPlan.directive.actions.length > 0) {
      lines.push(`typed-actions: ${result.finalPlan.directive.actions.map(formatContinuationAction).join("; ")}`);
    }
    if (result.finalPlan.directive.nextActions.length > 0) {
      lines.push(`guidance: ${result.finalPlan.directive.nextActions.join("; ")}`);
    }
  } else if (result.finalPlan.directive.kind === "blocked") {
    for (const blocker of result.finalPlan.directive.blockers) {
      lines.push(`blocked: ${blocker}`);
    }
  } else {
    lines.push("next: none");
  }

  return `${lines.join("\n")}\n`;
}

export async function executeLoopCommandFromArgs(
  args: readonly string[],
  options: ExecuteLoopCommandOptions
): Promise<{ format: "json" | "text"; result: LoopCommandResult }> {
  const requiresRuntimeMutationPreflight =
    args.includes("--apply-safe-recovery") || args.includes("--execute-supported-directives");
  const runtimePreflightFailure = await executeRuntimeExecutionPreflight(
    args,
    {
      ...(options as ExecuteRuntimePreflightCommandOptions),
      requireRuntimePreflight: requiresRuntimeMutationPreflight
    }
  );
  if (runtimePreflightFailure) {
    throw new Error(runtimePreflightFailure.reason);
  }

  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);
  if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }

  const format = resolveFormatFlag(args);
  const applySafeRecovery = args.includes("--apply-safe-recovery");
  const executeSupportedDirectives = args.includes("--execute-supported-directives");
  const ownerActor = resolveCommandFlag(args, "--owner-actor")?.trim() || undefined;
  const reviewCommands = await readLoopReviewCommandInputs(args, { cwd: options.cwd });
  const initialPlan = await options.getExecutionPlan(runId, staleAfterHours);
  let appliedRecoveryActionIds: string[] = [];
  let executedSteps: DirectiveExecutionResult["steps"] = [];
  let snapshot: RunStatusSnapshot;
  let finalPlan = initialPlan;

  if (applySafeRecovery && initialPlan.directive.kind === "apply_recovery") {
    const recoveryResult = await options.applyRecovery(
      runId,
      initialPlan.directive.actions.map((action) => action.id),
      staleAfterHours
    );
    appliedRecoveryActionIds = [...recoveryResult.appliedActionIds];
    snapshot = recoveryResult.snapshot;
    finalPlan = await options.getExecutionPlan(runId, staleAfterHours);
  } else {
    snapshot = await options.getStatusSnapshot(runId);
  }

  if (executeSupportedDirectives) {
    if (!options.executeDirectiveStep) {
      throw new Error("loop directive execution is not available for this runtime surface");
    }
    const executionResult = await options.executeDirectiveStep(runId, {
      staleAfterHours,
      ownerActor,
      reviewCommands
    });
    executedSteps = executionResult.steps;
    finalPlan = executionResult.finalPlan;
    snapshot = executionResult.snapshot;
  }

  return {
    format,
    result: {
      mode:
        executedSteps.length > 0
          ? "executed"
          : appliedRecoveryActionIds.length > 0
            ? "applied"
            : "advisory_only",
      runId,
      initialPlan,
      appliedRecoveryActionIds,
      executedSteps,
      finalPlan,
      snapshot
    }
  };
}

async function loopCommand(args: readonly string[]) {
  try {
    await withClient(async (client) => {
      const store = new PostgresStore(client);
      const service = new ArchonCoreService(store);
      const { format, result } = await executeLoopCommandFromArgs(args, {
        cwd: process.cwd(),
        env: process.env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        findProjectContext(workspaceSlug, projectSlug) {
          return store.getProjectContext({ workspaceSlug, projectSlug });
        },
        getProjectRuntimeRegistration(projectId) {
          return store.getProjectRuntimeRegistration(projectId);
        },
        getStatusSnapshot(runId) {
          return service.getStatus(runId);
        },
        getExecutionPlan(runId, staleAfterHours) {
          return service.getExecutionPlan(runId, { staleAfterHours });
        },
        applyRecovery(runId, actionIds, staleAfterHours) {
          return service.applyRecovery(runId, actionIds, { staleAfterHours });
        },
        async executeDirectiveStep(runId, input) {
          const executeReviewRecommendation =
            input.reviewCommands.length > 0
              ? createQueuedLoopReviewExecutor(
                  runId,
                  input.reviewCommands,
                  await createLiveLoopReviewCommandExecutor({
                    cwd: process.cwd(),
                    env: process.env,
                    recordReview({ command, resolver }) {
                      const reviewService = new ArchonCoreService(store, {
                        resolveReviewActionContext: resolver
                      });
                      return reviewService.recordReview(
                        command.runId,
                        command.taskId,
                        command.actor,
                        command.review
                      );
                    }
                  })
                )
              : undefined;
          const executeContinuationAction = createSupportedContinuationExecutor({
            env: process.env,
            getStatusSnapshot(runId) {
              return service.getStatus(runId);
            },
            getReviews(runId, taskId) {
              return store.getReviews(runId, taskId);
            },
            getApprovals(runId, taskId) {
              return store.getApprovals(runId, taskId);
            },
            upsertCoverageGaps(runId, gaps) {
              return service.upsertCoverageGaps(runId, gaps);
            },
            recordProgressProof(runId, proof) {
              return service.recordProgressProof(runId, proof);
            },
            checkpointRun(runId, checkpoint, checkpointOptions) {
              return service.checkpointRun(runId, checkpoint, checkpointOptions);
            }
          });

          return service.executeDirectiveStep(runId, {
            staleAfterHours: input.staleAfterHours,
            ownerActor: input.ownerActor,
            ...(executeReviewRecommendation ? { executeReviewRecommendation } : {}),
            executeContinuationAction
          });
        }
      });

      if (format === "text") {
        process.stdout.write(formatLoopCommandResult(result));
        return;
      }

      console.log(JSON.stringify(result));
    });
  } catch (error) {
    if (isRuntimeExecutionPreflightConnectionError(error)) {
      throw new Error(buildRuntimeExecutionConnectionFailure(error).reason);
    }
    throw error;
  }
}

export async function executeReportCommandFromArgs(
  args: readonly string[],
  options: ExecuteReportCommandOptions
) {
  const runId = await resolveRunIdForCommand(args, {
    env: options.env,
    findLatestRun: options.findLatestRun
  });
  const format = resolveMarkdownFormatFlag(args);
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);
  if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }

  const [status, executionPlan, routing, recovery] = await Promise.all([
    executeStatusCommandFromArgs(args, options),
    options.getExecutionPlan(runId, staleAfterHours),
    options.getRoutingReport(runId),
    options.inspectRecovery(runId, staleAfterHours)
  ]);
  const snapshot = await options.getStatusSnapshot(runId);

  const handoffsByTask = Object.fromEntries(
    await Promise.all(
      snapshot.tasks.map(async (task) => [task.packet.taskId, await options.getHandoffs(runId, task.packet.taskId)])
    )
  );
  const reviewsByTask = Object.fromEntries(
    await Promise.all(
      snapshot.tasks.map(async (task) => [task.packet.taskId, await options.getReviews(runId, task.packet.taskId)])
    )
  );
  const approvalsByTask = Object.fromEntries(
    await Promise.all(
      snapshot.tasks.map(async (task) => [task.packet.taskId, await options.getApprovals(runId, task.packet.taskId)])
    )
  );

  return {
    format,
    report: buildRunEvidenceReport({
      snapshot,
      executionPlan,
      status,
      routing,
      recovery,
      handoffsByTask,
      reviewsByTask,
      approvalsByTask,
      loopHistoryResults: options.getLoopHistory ? await options.getLoopHistory(runId, 20) : []
    })
  };
}

export async function executeWorkflowProofCommandFromArgs(
  args: readonly string[],
  options: ExecuteWorkflowProofCommandOptions
): Promise<WorkflowProofResult> {
  const taskId = resolveCommandFlag(args, "--task-id");
  if (!taskId) {
    throw new Error("workflow-proof requires --task-id <task-id>");
  }

  const explicitRunId = resolveCommandFlag(args, "--run-id");
  let runId: string;

  if (explicitRunId && explicitRunId !== "latest") {
    runId = explicitRunId;
  } else if (options.findLatestRunForTask) {
    const env = options.env ?? process.env;
    const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
    const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

    if (!workspaceSlug || !projectSlug) {
      throw new Error("workflow-proof requires workspace/project context when using --run-id latest");
    }

    const latestRunForTask = await options.findLatestRunForTask(workspaceSlug, projectSlug, taskId);
    if (!latestRunForTask) {
      throw new Error(`No runs found for ${workspaceSlug}/${projectSlug} with task ${taskId}`);
    }

    runId = latestRunForTask.id;
  } else {
    runId = await resolveRunIdForCommand(args, {
      env: options.env,
      findLatestRun: options.findLatestRun
    });
  }

  const snapshot = await options.getStatusSnapshot(runId);
  const task = snapshot.tasks.find((candidate) => candidate.packet.taskId === taskId);

  if (!task) {
    throw new Error(`Task ${taskId} not found in runtime run ${runId}`);
  }

  const reviews = await options.getReviews(runId, taskId);
  const decision = evaluateReviewDecision(task, reviews);
  if (decision.decision !== "approved") {
    throw new Error(`Task ${taskId} is not approved in runtime: ${decision.blockers.join("; ")}`);
  }

  if (task.status !== "approved") {
    throw new Error(`Task ${taskId} runtime status must be approved, found ${task.status}`);
  }

  const requiredReviews = effectiveRequiredReviews(task.packet.requiredReviews);
  const latestReviews = requiredReviews
    .map((role) => reviews.filter((review) => review.reviewerRole === role).at(-1))
    .filter((review): review is ReviewRecord => review !== undefined);

  if (latestReviews.length !== requiredReviews.length) {
    throw new Error(`Task ${taskId} is missing one or more required runtime reviews`);
  }

  enforcePlaywrightWorkflowProof(task.packet, latestReviews);

  const latestApproval = (await options.getApprovals(runId, taskId)).at(-1);
  if (!latestApproval) {
    throw new Error(`Task ${taskId} is missing a runtime approval record`);
  }
  if (latestApproval.identityAssurance !== "authenticated" || latestApproval.decision !== "approved") {
    throw new Error(
      `Task ${taskId} latest runtime approval must be authenticated approved, found ${latestApproval.identityAssurance} ${latestApproval.decision}`
    );
  }

  if (options.getProjectRuntimeState) {
    const runtimeState = await options.getProjectRuntimeState(snapshot.run.projectId);
    const seedFailure = readSeedFailureMetadata(runtimeState);
    if (
      seedFailure?.recoveryState === "stale_metadata" &&
      options.integrityCheckMode !== "allow_seed_failure_recovery"
    ) {
      throw new Error(
        `Task ${taskId} runtime integrity is contradicted: stale persisted seed failure metadata remains after authoritative workflow proof`
      );
    }
  }

  const continuation = await maybeContinueWorkflowAfterProof(
    {
      runId,
      taskId
    },
    args,
    options
  );

  return {
    authorityLabel: "runtime_authoritative",
    runId,
    taskId,
    taskStatus: task.status,
    reviewDecision: "approved",
    blockers: [],
    latestReviews,
    latestApproval,
    continuationApplied: continuation.applied,
    nextTaskId: continuation.nextTaskId
  };
}

function enforcePlaywrightWorkflowProof(packet: TaskPacketInput, latestReviews: readonly ReviewRecord[]): void {
  if (!isPlaywrightRequiredForTask(packet)) {
    return;
  }

  const qaReview = latestReviews.find((review) => review.reviewerRole === "qa_engineer");
  if (!qaReview) {
    throw new Error(`Task ${packet.taskId} is missing the qa_engineer runtime review required for Playwright proof`);
  }

  const evidenceRefs = qaReview.evidenceRefs ?? [];
  const hasPlaywrightEvidence = evidenceRefs.some((ref) => /playwright/i.test(ref));
  if (!hasPlaywrightEvidence) {
    throw new Error(`Task ${packet.taskId} qa_engineer review must cite Playwright evidence refs before workflow-proof`);
  }
}

async function maybeContinueWorkflowAfterProof(
  proof: {
    runId: string;
    taskId: string;
  },
  args: readonly string[],
  options: ExecuteWorkflowProofCommandOptions
): Promise<{
  applied: boolean;
  nextTaskId: string | null;
}> {
  if (
    options.allowQueueContinuation === false ||
    !options.getProjectContext ||
    !options.getProjectRuntimeState ||
    !options.saveProjectRuntimeState
  ) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const env = options.env ?? process.env;
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const runtimeState = await options.getProjectRuntimeState(projectContext.project.id);
  if (!runtimeState?.activeTaskId || runtimeState.activeTaskId !== proof.taskId) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  if (runtimeState.activeRunId && runtimeState.activeRunId !== proof.runId) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const queue = parseTaskQueueRecordOrDefault(runtimeState.taskQueue);
  if (queue.current_task_id !== proof.taskId) {
    return {
      applied: false,
      nextTaskId: null
    };
  }

  const advanced = advanceTaskQueue(queue, proof.taskId);
  const nextRuntimeState: ProjectRuntimeStateRecord = {
    projectId: projectContext.project.id,
    workspaceId: projectContext.workspace.id,
    activeRunId: proof.runId,
    activeTaskId: advanced.nextTask?.id ?? undefined,
    taskQueue: advanced.queue,
    productState: runtimeState.productState ?? buildDefaultProductState(),
    lastVerifiedRunId: proof.runId,
    metadata: clearSeedFailureMetadata(runtimeState.metadata),
    createdAt: runtimeState.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await options.saveProjectRuntimeState(nextRuntimeState);
  await syncRuntimeWorkflowExports(options.cwd, nextRuntimeState);

  return {
    applied: true,
    nextTaskId: advanced.nextTask?.id ?? null
  };
}

function buildWorkflowProofSeedTaskPacket(taskId: string): TaskPacketInput {
  return {
    taskId,
    title: `Local workflow proof seed for ${taskId}`,
    ownerRole: "planner",
    completionStandard: "specialist_verified",
    requiredSpecialistRoles: ["planner"],
    qualityGates: ["tdd_required", "release_readiness_required", "setup_replay_required"],
    goal: `Seed authoritative runtime workflow proof for ${taskId}`,
    inputs: ["local workflow artifacts", "runtime store"],
    outputs: ["approved runtime workflow proof"],
    dependencies: [],
    allowedWriteScope: [".archon/work"],
    outOfScope: ["production deploys", "manual database edits"],
    acceptanceCriteria: [
      `workflow-proof resolves ${taskId} from the latest runtime run`,
      "required reviewer, qa, and security reviews are recorded as authenticated approvals"
    ],
    verificationSteps: [
      `node --experimental-strip-types src/admin.ts workflow-proof --run-id latest --task-id ${taskId}`
    ],
    uiSurface: "none",
    playwrightRequired: false,
    requiredReviews: ["reviewer", "security_reviewer", "qa_engineer"],
    securityChecks: [
      "use the trusted review-context resolver",
      "keep the seed path explicit and local-development oriented"
    ],
    antiPatterns: ["manual SQL approvals", "summary-only runtime proof"],
    rollbackNotes: "delete the seeded runtime run if local proof state must be reset",
    handoffFormat: "summary + verification evidence + local proof context"
  };
}

function buildModernizationProofSeedTaskPacket(taskId: string): TaskPacketInput {
  return {
    taskId,
    title: `Local modernization proof seed for ${taskId}`,
    ownerRole: "qa_engineer",
    completionStandard: "specialist_verified",
    requiredSpecialistRoles: ["qa_engineer", "reviewer", "security_reviewer"],
    qualityGates: [
      "coverage_ledger_required",
      "progress_proof_required",
      "setup_replay_required",
      "release_readiness_required"
    ],
    goal: `Seed authoritative runtime modernization proof for ${taskId}`,
    inputs: ["installed repo workflow artifacts", "runtime store", "modernization evidence scaffold"],
    outputs: ["approved modernization proof run", "ready modernization summary"],
    dependencies: [],
    allowedWriteScope: [".archon/work", "runtime://authoritative-state"],
    outOfScope: ["production deploys", "destructive data migration"],
    acceptanceCriteria: [
      `workflow-proof resolves ${taskId} from the latest runtime run`,
      "status reports modernization_program rewrite readiness as ready",
      "duplicate-family, architecture, migration, and parity evidence are present in runtime state"
    ],
    verificationSteps: [
      `node --experimental-strip-types src/admin.ts workflow-proof --run-id latest --task-id ${taskId}`,
      "node --experimental-strip-types src/admin.ts status",
      "node --experimental-strip-types src/admin.ts report --format json"
    ],
    uiSurface: "none",
    playwrightRequired: false,
    requiredReviews: ["reviewer", "security_reviewer", "qa_engineer"],
    securityChecks: [
      "use the trusted review-context resolver",
      "keep the seed path explicit and local-development oriented",
      "do not leak package-repo runtime state into the installed target"
    ],
    antiPatterns: ["profile-limited rewrite claims", "summary-only modernization evidence"],
    rollbackNotes: "delete the seeded runtime run if local modernization proof state must be reset",
    handoffFormat: "summary + verification evidence + modernization readiness"
  };
}

function buildModernizationUnderstandingMaps(now: string): UnderstandingMapRecord[] {
  return [
    "repo_map",
    "subsystems",
    "route_map",
    "model_map",
    "integration_map",
    "authz_map",
    "config_coupling",
    "runtime_side_effects",
    "domain_map",
    "symbol_graph",
    "call_graph",
    "dependency_graph",
    "invariant_ledger",
    "duplicate_families",
    "architecture_decisions",
    "migration_ledger",
    "parity_matrix"
  ].map((kind) => ({
    kind,
    itemCount: 1,
    analyzedCount: 1,
    sourceRefs: ["seed://modernization-proof"],
    evidenceRefs: ["seed://modernization-proof"],
    updatedAt: now
  }));
}

function buildModernizationCoverageItems(now: string): CoverageItemRecord[] {
  return [
    {
      id: "service:modernization-proof-core",
      category: "services",
      state: "validated",
      criticality: "critical",
      sources: ["seed://modernization-proof"],
      dependencies: ["model:migration-ledger", "graph:call-graph"],
      callsiteCount: 3,
      callsitesAnalyzed: 3,
      runtimeTraced: true,
      businessRules: ["modernization planning must preserve all validated invariants"],
      evidenceRefs: ["seed://modernization-proof"],
      verificationRefs: ["seed://modernization-proof"],
      lastUpdatedAt: now
    }
  ];
}

function buildModernizationDuplicateFamilies(now: string): DuplicateFamilyRecord[] {
  return [
    {
      familyId: "duplicate:modernization-proof",
      capability: "workflow modernization readiness",
      members: [
        {
          itemId: "service:modernization-proof-core",
          kind: "shared_core",
          role: "runtime readiness coordinator"
        },
        {
          itemId: "model:migration-ledger",
          kind: "intentional_variant",
          role: "schema transition verifier"
        }
      ],
      sharedAbstraction: "ModernizationProofAdapter",
      intentionalVariants: ["migration ledger retains rollout metadata while readiness summary stays operator-facing"],
      accidentalDivergences: [],
      centralizationCandidate: "centralize modernization proof derivation behind ModernizationProofAdapter",
      parityRequirements: ["prove installed harness and package runtime derive equivalent modernization readiness"],
      evidenceRefs: ["seed://modernization-proof"],
      verificationRefs: ["seed://modernization-proof"],
      lastUpdatedAt: now
    }
  ];
}

function buildModernizationArchitectureDecisions(now: string): ArchitectureDecisionRecord[] {
  return [
    {
      decisionId: "adr:installed-modernization-proof",
      title: "Installed modernization proof remains behind runtime-backed boundaries",
      status: "accepted",
      options: ["status-only heuristic proof", "runtime-backed modernization proof seed"],
      chosenOption: "runtime-backed modernization proof seed",
      boundedContexts: ["installed-harness", "modernization-analysis"],
      consistencyNeeds: ["single rewrite readiness model", "single review authority"],
      rationale: ["installed repos must surface the same rewrite-readiness contract as the package runtime"],
      evidenceRefs: ["seed://modernization-proof"],
      verificationRefs: ["seed://modernization-proof"],
      lastUpdatedAt: now
    }
  ];
}

function buildModernizationMigrationLedger(now: string): MigrationLedgerEntryRecord[] {
  return [
    {
      entryId: "migration:installed-modernization-proof",
      boundedContext: "modernization-analysis",
      sourceModels: ["legacy_workflow_reports"],
      targetModels: ["modernization_readiness_records"],
      strategy: "expand_contract",
      consistencyClass: "strong",
      ownership: "backend_engineer",
      rolloutSteps: ["add readiness records", "backfill modernization evidence", "cut reads to readiness records"],
      rollbackPlan: ["restore reads to legacy workflow reports", "leave additive schema in place"],
      evidenceRefs: ["seed://modernization-proof"],
      verificationRefs: ["seed://modernization-proof"],
      lastUpdatedAt: now
    }
  ];
}

function buildModernizationParityRequirements(now: string): ParityRequirementRecord[] {
  return [
    {
      requirementId: "parity:installed-modernization-proof",
      capability: "installed modernization proof",
      status: "planned",
      legacyRefs: ["legacy_workflow_reports.readiness"],
      targetRefs: ["modernization_readiness_records.readiness"],
      acceptanceChecks: ["prove installed target and package runtime expose the same rewrite-readiness result"],
      evidenceRefs: ["seed://modernization-proof"],
      verificationRefs: ["seed://modernization-proof"],
      lastUpdatedAt: now
    }
  ];
}

export async function executeSeedWorkflowProofCommandFromArgs(
  args: readonly string[],
  options: ExecuteSeedWorkflowProofCommandOptions
): Promise<SeedWorkflowProofResult> {
  const env = options.env ?? process.env;
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("seed-workflow-proof requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
  }

  const explicitTaskId = resolveCommandFlag(args, "--task-id");
  const projectRuntimeState = await options.getProjectRuntimeState(projectContext.project.id);
  const resolvedTaskId = explicitTaskId ?? projectRuntimeState?.activeTaskId;

  if (!resolvedTaskId) {
    throw new Error("seed-workflow-proof requires --task-id or an active runtime task");
  }

  const run = await options.intakeRequest({
    workspaceSlug,
    projectSlug,
    actor: "archon-local-seed-manager",
    title: `Seed workflow proof for ${resolvedTaskId}`,
    request: `Create a local authoritative runtime workflow proof run for ${resolvedTaskId}.`
  });

  try {
    await options.createTaskGraph(run.id, [buildWorkflowProofSeedTaskPacket(resolvedTaskId)]);
    await options.claimTask(run.id, resolvedTaskId, "planner");
    await options.submitHandoff(run.id, resolvedTaskId, {
      actor: "planner",
      ownerRole: "planner",
      completionStandard: "specialist_verified",
      summary: `Seeded local workflow proof runtime state for ${resolvedTaskId}.`,
      changedFiles: [".archon/ACTIVE"],
      blockers: [],
      verificationNotes: ["runtime workflow proof seeded locally"],
      executionEvidence: ["task graph created", "task claimed", "handoff submitted"],
      qualityGateEvidence: ["seed command test coverage", "local runtime proof replay path"],
      contextRefs: [`brief://${resolvedTaskId}`, "seed://workflow-proof"]
    });

    await options.recordReview(run.id, resolvedTaskId, "reviewer-actor", {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await options.recordReview(run.id, resolvedTaskId, "security-actor", {
      reviewerRole: "security_reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await options.recordReview(run.id, resolvedTaskId, "qa-actor", {
      reviewerRole: "qa_engineer",
      state: "passed",
      severity: "low",
      findings: []
    });

    const proof = await executeWorkflowProofCommandFromArgs(
      ["--run-id", run.id, "--task-id", resolvedTaskId],
      {
        env,
        integrityCheckMode: "allow_seed_failure_recovery",
        getProjectRuntimeState: options.getProjectRuntimeState,
        getStatusSnapshot: options.getStatusSnapshot,
        getReviews: options.getReviews,
        getApprovals: options.getApprovals
      }
    );

    const refreshedRuntimeState = (await options.getProjectRuntimeState(projectContext.project.id)) ?? projectRuntimeState;
    const nextRuntimeState: ProjectRuntimeStateRecord = {
      projectId: projectContext.project.id,
      workspaceId: projectContext.workspace.id,
      activeRunId: run.id,
      activeTaskId: resolvedTaskId,
      taskQueue: alignQueueToActiveTask(refreshedRuntimeState?.taskQueue, resolvedTaskId),
      productState: refreshedRuntimeState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: proof.runId,
      metadata: clearSeedFailureMetadata(refreshedRuntimeState?.metadata),
      createdAt: refreshedRuntimeState?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await options.saveProjectRuntimeState(nextRuntimeState);
    await syncRuntimeWorkflowExports(options.cwd, nextRuntimeState);

    return {
      mode: "local_workflow_proof_seed",
      workspaceSlug,
      projectSlug,
      ...proof
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await options.failTask?.(run.id, resolvedTaskId, `workflow proof seed failed: ${reason}`);
    throw error;
  }
}

export async function executeSeedModernizationProofCommandFromArgs(
  args: readonly string[],
  options: ExecuteSeedModernizationProofCommandOptions
): Promise<SeedModernizationProofResult> {
  const env = options.env ?? process.env;
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("seed-modernization-proof requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
  }

  const explicitTaskId = resolveCommandFlag(args, "--task-id");
  const projectRuntimeState = await options.getProjectRuntimeState(projectContext.project.id);
  const resolvedTaskId = explicitTaskId ?? projectRuntimeState?.activeTaskId;

  if (!resolvedTaskId) {
    throw new Error("seed-modernization-proof requires --task-id or an active runtime task");
  }

  const run = await options.intakeRequest({
    workspaceSlug,
    projectSlug,
    actor: "archon-local-seed-manager",
    title: `Seed modernization proof for ${resolvedTaskId}`,
    request: `Create a local authoritative modernization-proof runtime run for ${resolvedTaskId}.`
  });
  try {
    await options.createTaskGraph(run.id, [buildModernizationProofSeedTaskPacket(resolvedTaskId)]);
    await options.claimTask(run.id, resolvedTaskId, "qa_engineer");
    await options.submitHandoff(run.id, resolvedTaskId, {
      actor: "qa_engineer",
      ownerRole: "qa_engineer",
      completionStandard: "specialist_verified",
      summary: `Seeded local modernization-proof runtime state for ${resolvedTaskId}.`,
      changedFiles: [".archon/ACTIVE"],
      blockers: [],
      verificationNotes: ["runtime modernization proof seeded locally"],
      executionEvidence: ["task graph created", "task claimed", "handoff submitted", "autonomous evidence seeded"],
      qualityGateEvidence: ["seed command test coverage", "installed repo modernization replay path"],
      contextRefs: [`brief://${resolvedTaskId}`, "seed://modernization-proof"]
    });

    await options.recordReview(run.id, resolvedTaskId, "reviewer-actor", {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await options.recordReview(run.id, resolvedTaskId, "security-actor", {
      reviewerRole: "security_reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await options.recordReview(run.id, resolvedTaskId, "qa-actor", {
      reviewerRole: "qa_engineer",
      state: "passed",
      severity: "low",
      findings: []
    });

    const now = new Date().toISOString();
    await options.configureAutonomousExecution(run.id, {
      profile: "modernization_program",
      phase: "modernization_strategy",
      manifest: {
        runId: run.id,
        profile: "modernization_program",
        requiredCategories: ["services"],
        thresholds: {
          criticalItemCoverage: 0.9,
          criticalItemValidation: 0.75,
          callsiteCoverage: 0.9,
          runtimeTraceCoverage: 0.85,
          inventoryCompleteness: 1,
          businessRuleCoverage: 0.9,
          maxContradictionGapCount: 0,
          maxOpenBlockers: 0
        }
      }
    });
    await options.upsertCoverageItems(run.id, buildModernizationCoverageItems(now));
    await options.upsertUnderstandingMaps(run.id, buildModernizationUnderstandingMaps(now));
    await options.upsertRuntimeTraces(run.id, [
      {
        traceId: "trace:modernization-proof-core",
        targetId: "service:modernization-proof-core",
        kind: "side_effect",
        risky: true,
        sideEffects: ["persists modernization artifact evidence"],
        evidenceRefs: ["seed://modernization-proof"],
        createdAt: now
      }
    ]);
    await options.upsertDuplicateFamilies(run.id, buildModernizationDuplicateFamilies(now));
    await options.upsertArchitectureDecisions(run.id, buildModernizationArchitectureDecisions(now));
    await options.upsertMigrationLedgerEntries(run.id, buildModernizationMigrationLedger(now));
    await options.upsertParityRequirements(run.id, buildModernizationParityRequirements(now));

    const proof = await executeWorkflowProofCommandFromArgs(
      ["--run-id", run.id, "--task-id", resolvedTaskId],
      {
        env,
        integrityCheckMode: "allow_seed_failure_recovery",
        getProjectRuntimeState: options.getProjectRuntimeState,
        getStatusSnapshot: options.getStatusSnapshot,
        getReviews: options.getReviews,
        getApprovals: options.getApprovals
      }
    );

    const status = await options.getStatusSnapshot(run.id);
    const comprehensionSummary = status.autonomousExecution?.comprehensionSummary;
    const phaseReadiness = status.autonomousExecution?.phaseReadiness;
    if (!status.autonomousExecution || !comprehensionSummary || !phaseReadiness) {
      throw new Error("seed-modernization-proof expected autonomous execution to be configured");
    }
    if (status.autonomousExecution.state.profile !== "modernization_program") {
      throw new Error(
        `seed-modernization-proof expected modernization_program profile, found ${status.autonomousExecution.state.profile}`
      );
    }
    if (comprehensionSummary.rewriteReadiness !== "ready") {
      throw new Error(
        `seed-modernization-proof expected ready rewrite readiness, found ${comprehensionSummary.rewriteReadiness}: ${comprehensionSummary.missingEvidence.join("; ")}`
      );
    }
    if (phaseReadiness.status !== "ready") {
      throw new Error(`seed-modernization-proof expected ready phase readiness, found ${phaseReadiness.status}`);
    }

    const refreshedRuntimeState =
      (await options.getProjectRuntimeState(projectContext.project.id)) ?? projectRuntimeState;
    const nextRuntimeState: ProjectRuntimeStateRecord = {
      projectId: projectContext.project.id,
      workspaceId: projectContext.workspace.id,
      activeRunId: run.id,
      activeTaskId: resolvedTaskId,
      taskQueue: alignQueueToActiveTask(refreshedRuntimeState?.taskQueue, resolvedTaskId),
      productState: refreshedRuntimeState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: proof.runId,
      metadata: clearSeedFailureMetadata(refreshedRuntimeState?.metadata),
      createdAt: refreshedRuntimeState?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await options.saveProjectRuntimeState(nextRuntimeState);
    await syncRuntimeWorkflowExports(options.cwd, nextRuntimeState);

    return {
      mode: "local_modernization_proof_seed",
      workspaceSlug,
      projectSlug,
      autonomous: {
        profile: status.autonomousExecution.state.profile,
        phase: status.autonomousExecution.state.phase,
        readinessScope: comprehensionSummary.readinessScope,
        rewriteReadiness: comprehensionSummary.rewriteReadiness,
        missingArtifactKinds: comprehensionSummary.missingArtifactKinds,
        duplicateFamilyCount: comprehensionSummary.duplicateFamilyCount,
        architectureDecisionCount: comprehensionSummary.architectureDecisionCount,
        migrationLedgerCount: comprehensionSummary.migrationLedgerCount,
        parityRequirementCount: comprehensionSummary.parityRequirementCount
      },
      ...proof
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await options.failTask?.(run.id, resolvedTaskId, `modernization proof seed failed: ${reason}`);
    throw error;
  }
}

function normalizeWorkflowExportState(queue: TaskQueue, taskId: string | null): "active" | "idle" | "complete" {
  if (taskId) {
    return "active";
  }

  const projectStatus = queue.project_status.trim().toLowerCase();
  if (projectStatus === "complete" || projectStatus === "completed" || projectStatus === "done") {
    return "complete";
  }

  return "idle";
}

function formatActiveWorkflowContent(taskId: string | null, queue: TaskQueue): string {
  const lines = [];
  if (taskId) {
    lines.push(`task_id=${taskId}`);
  }
  lines.push("workflow=archon");
  lines.push(`state=${normalizeWorkflowExportState(queue, taskId)}`);
  return `${lines.join("\n")}\n`;
}

function isCompleteProjectStatus(projectStatus: string | undefined): boolean {
  const normalized = projectStatus?.trim().toLowerCase();
  return normalized === "complete" || normalized === "completed" || normalized === "done";
}

async function writeFileIfChanged(filePath: string, content: string): Promise<boolean> {
  try {
    const existing = await readFile(filePath, "utf8");
    if (existing === content) {
      return false;
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") {
      throw error;
    }
  }

  await writeFile(filePath, content, "utf8");
  return true;
}

async function syncRuntimeWorkflowExports(
  cwd: string | undefined,
  runtimeState: {
    activeTaskId?: string | null | undefined;
    taskQueue: ProjectRuntimeStateRecord["taskQueue"];
    lastVerifiedRunId?: string | null | undefined;
  }
): Promise<boolean> {
  if (!cwd) {
    return false;
  }

  const queue = parseTaskQueueRecord(runtimeState.taskQueue);
  if (isCompleteProjectStatus(queue.project_status) && !runtimeState.lastVerifiedRunId) {
    throw new Error("Cannot sync complete workflow exports without authoritative runtime proof (missing last verified run)");
  }
  const activeTaskId =
    runtimeState.activeTaskId && runtimeState.activeTaskId.trim().length > 0
      ? runtimeState.activeTaskId.trim()
      : queue.current_task_id;
  const archonRoot = path.join(path.resolve(cwd), ".archon");
  const workRoot = path.join(archonRoot, "work");

  await mkdir(workRoot, { recursive: true });
  const queueChanged = await writeFileIfChanged(
    path.join(workRoot, "task-queue.json"),
    `${JSON.stringify(queue, null, 2)}\n`
  );
  const activeChanged = await writeFileIfChanged(
    path.join(archonRoot, "ACTIVE"),
    formatActiveWorkflowContent(activeTaskId ?? null, queue)
  );
  return queueChanged || activeChanged;
}

function formatAdvanceActiveTaskCommandResult(result: AdvanceActiveTaskCommandResult): string {
  return [
    `mode: ${result.mode}`,
    `completed-task: ${result.taskId}`,
    `proof-run: ${result.proof.runId}`,
    `next-task: ${result.nextTaskId ?? "none"}`,
    `queue-current-task: ${result.queue.current_task_id ?? "none"}`
  ].join("\n");
}

function formatSyncRuntimeExportsCommandResult(result: SyncRuntimeExportsCommandResult): string {
  return [
    `mode: ${result.mode}`,
    `workspace: ${result.workspaceSlug}`,
    `project: ${result.projectSlug}`,
    `active-task: ${result.activeTaskId ?? "none"}`,
    `queue-current-task: ${result.queue.current_task_id ?? "none"}`,
    `project-status: ${result.queue.project_status}`
  ].join("\n");
}

function formatReconcileRuntimeStateCommandResult(result: ReconcileRuntimeStateCommandResult): string {
  return [
    `mode: ${result.mode}`,
    `workspace: ${result.workspaceSlug}`,
    `project: ${result.projectSlug}`,
    `active-run: ${result.activeRunId ?? "none"}`,
    `active-task: ${result.activeTaskId ?? "none"}`,
    `repair-action: ${result.repairAction}`,
    `runtime-state-changed: ${result.runtimeStateChanged ? "yes" : "no"}`,
    `local-exports-synced: ${result.localExportsSynced ? "yes" : "no"}`,
    `directive: ${result.executionPlanDirectiveKind ?? "none"}`,
    `reason: ${result.reason}`
  ].join("\n");
}

function buildRuntimeStateFromSnapshot(input: {
  projectContext: { workspace: WorkspaceRecord; project: ProjectRecord };
  existingState: ProjectRuntimeStateRecord | undefined;
  runId: string;
  activeTaskId: string | null;
  snapshot: RunStatusSnapshot;
  now: string;
}): ProjectRuntimeStateRecord {
  return {
    projectId: input.projectContext.project.id,
    workspaceId: input.projectContext.workspace.id,
    activeRunId: input.runId,
    activeTaskId: input.activeTaskId ?? undefined,
    taskQueue: buildAuthoritativeTaskQueueFromSnapshot(input.snapshot, input.activeTaskId),
    productState: input.existingState?.productState ?? buildDefaultProductState(),
    lastVerifiedRunId: input.existingState?.lastVerifiedRunId,
    metadata: input.existingState?.metadata ?? {},
    createdAt: input.existingState?.createdAt ?? input.now,
    updatedAt: input.now
  };
}

export async function executeReconcileRuntimeStateCommandFromArgs(
  args: readonly string[],
  options: ExecuteReconcileRuntimeStateCommandOptions
): Promise<{ format: "json" | "text"; result: ReconcileRuntimeStateCommandResult }> {
  const env = options.env ?? process.env;
  const format = resolveFormatFlag(args);
  const apply = hasCommandFlag(args, "--apply");
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);

  if (!Number.isInteger(staleAfterHours) || staleAfterHours <= 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }
  if (!workspaceSlug || !projectSlug) {
    throw new Error("reconcile-runtime-state requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
  }

  const existingState = await options.getProjectRuntimeState(projectContext.project.id);
  const latestRun = existingState?.activeRunId
    ? undefined
    : await options.findLatestRun?.(workspaceSlug, projectSlug);
  const resolvedRunId = existingState?.activeRunId ?? latestRun?.id ?? null;
  const existingQueue = parseTaskQueueRecordOrDefault(existingState?.taskQueue);

  if (!resolvedRunId) {
    const localExportsSynced =
      apply &&
      await syncRuntimeWorkflowExports(options.cwd, {
        activeTaskId: existingState?.activeTaskId ?? null,
        taskQueue: existingState?.taskQueue ?? existingQueue,
        lastVerifiedRunId: existingState?.lastVerifiedRunId
      });
    return {
      format,
      result: {
        mode: apply ? "applied" : "dry_run",
        workspaceSlug,
        projectSlug,
        activeRunId: existingState?.activeRunId ?? null,
        activeTaskId: existingState?.activeTaskId ?? null,
        queue: existingQueue,
        repairAction: "none",
        runtimeStateChanged: false,
        localExportsSynced,
        reason: "no runtime run is available to reconcile"
      }
    };
  }

  const snapshot = await options.getStatusSnapshot(resolvedRunId);
  const authoritativeInProgressTasks = snapshot.tasks.filter((task) => task.status === "in_progress");
  const inProgressTaskId =
    authoritativeInProgressTasks.length === 1 ? authoritativeInProgressTasks[0]!.packet.taskId : undefined;

  let desiredActiveTaskId: string | null =
    existingState?.activeTaskId && existingState.activeTaskId.trim().length > 0
      ? existingState.activeTaskId.trim()
      : null;
  let repairAction: RuntimeStateReconcileAction = !existingState ? "rebuild_missing_runtime_state" : "none";
  let reason = !existingState
    ? "runtime state record is missing and can be rebuilt from the authoritative runtime snapshot"
    : "runtime state already matches authoritative runtime signals";
  let executionPlanDirectiveKind: RunExecutionPlan["directive"]["kind"] | undefined;

  if (authoritativeInProgressTasks.length > 1) {
    desiredActiveTaskId = existingState?.activeTaskId ?? null;
    reason = `multiple in-progress runtime tasks make automatic reconciliation unsafe: ${authoritativeInProgressTasks
      .map((task) => task.packet.taskId)
      .join(", ")}`;
    if (repairAction === "rebuild_missing_runtime_state") {
      repairAction = "none";
    }
  } else if (inProgressTaskId) {
    desiredActiveTaskId = inProgressTaskId;
    if (!existingState) {
      reason = `rebuilt missing runtime state from the authoritative in-progress task ${inProgressTaskId}`;
    } else if (existingState.activeTaskId !== inProgressTaskId) {
      repairAction = "sync_active_task_to_in_progress";
      reason = `runtime active task drifted from the authoritative in-progress task ${inProgressTaskId}`;
    }
  } else {
    const executionPlan = await options.getExecutionPlan(resolvedRunId, staleAfterHours);
    executionPlanDirectiveKind = executionPlan.directive.kind;

    if (
      executionPlan.directive.kind === "dispatch_owner" &&
      snapshot.nextTaskIds.length === 1 &&
      snapshot.nextTaskIds[0] === executionPlan.directive.recommendation.taskId
    ) {
      desiredActiveTaskId = executionPlan.directive.recommendation.taskId;
      if (!existingState) {
        reason = `rebuilt missing runtime state and activated the unique owner-dispatch target ${desiredActiveTaskId}`;
      } else if (existingState.activeTaskId !== desiredActiveTaskId) {
        repairAction = "activate_owner_dispatch_target";
        reason = `activated the unique owner-dispatch target ${desiredActiveTaskId}`;
      }
    } else if (
      executionPlan.directive.kind === "complete" ||
      (snapshot.tasks.length > 0 && snapshot.tasks.every((task) => task.status === "approved" || task.status === "done"))
    ) {
      desiredActiveTaskId = null;
      if (!existingState) {
        reason = "rebuilt missing runtime state for a completed run with no active task";
      } else if (existingState.activeTaskId || existingQueue.current_task_id) {
        repairAction = "clear_completed_active_task";
        reason = "cleared a stale active task from a completed runtime run";
      }
    } else {
      desiredActiveTaskId = existingState?.activeTaskId ?? null;
      if (repairAction === "rebuild_missing_runtime_state") {
        reason = "rebuilt missing runtime state from the authoritative runtime snapshot without changing task ownership";
      }
    }
  }

  const nextState = buildRuntimeStateFromSnapshot({
    projectContext,
    existingState,
    runId: resolvedRunId,
    activeTaskId: desiredActiveTaskId,
    snapshot,
    now: new Date().toISOString()
  });
  const runtimeStateChanged =
    !existingState ||
    existingState.activeRunId !== nextState.activeRunId ||
    (existingState.activeTaskId ?? null) !== (nextState.activeTaskId ?? null) ||
    JSON.stringify(parseTaskQueueRecordOrDefault(existingState.taskQueue)) !==
      JSON.stringify(parseTaskQueueRecord(nextState.taskQueue));
  const normalizedRepairAction =
    runtimeStateChanged && repairAction === "none" ? "rebuild_stale_runtime_queue" : repairAction;

  if (apply && runtimeStateChanged) {
    await options.saveProjectRuntimeState(nextState);
    await persistProjectIntegrityRepairMetadata({
      projectId: projectContext.project.id,
      getProjectRuntimeState: options.getProjectRuntimeState,
      saveProjectRuntimeState: options.saveProjectRuntimeState,
      source: "reconcile_runtime_state",
      kind: "runtime_task_reconcile",
      summary: `${normalizedRepairAction}: ${reason}`
    });
  }
  const localExportsSynced =
    apply &&
    await syncRuntimeWorkflowExports(options.cwd, {
      activeTaskId: nextState.activeTaskId ?? null,
      taskQueue: nextState.taskQueue,
      lastVerifiedRunId: nextState.lastVerifiedRunId
    });
  if (apply && !runtimeStateChanged && localExportsSynced) {
    await persistProjectIntegrityRepairMetadata({
      projectId: projectContext.project.id,
      getProjectRuntimeState: options.getProjectRuntimeState,
      saveProjectRuntimeState: options.saveProjectRuntimeState,
      source: "reconcile_runtime_state",
      kind: "local_export_resync",
      summary: "reconcile command resynced local workflow exports from authoritative runtime state"
    });
  }

  return {
    format,
    result: {
      mode: apply ? "applied" : "dry_run",
      workspaceSlug,
      projectSlug,
      activeRunId: nextState.activeRunId ?? null,
      activeTaskId: nextState.activeTaskId ?? null,
      queue: parseTaskQueueRecord(nextState.taskQueue),
      repairAction: normalizedRepairAction,
      runtimeStateChanged,
      localExportsSynced,
      reason,
      executionPlanDirectiveKind
    }
  };
}

export async function executeSyncRuntimeExportsCommandFromArgs(
  args: readonly string[],
  options: ExecuteSyncRuntimeExportsCommandOptions
): Promise<{ format: "json" | "text"; result: SyncRuntimeExportsCommandResult }> {
  const env = options.env ?? process.env;
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("sync-runtime-exports requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
  }

  const runtimeState = await options.getProjectRuntimeState(projectContext.project.id);
  const queue = parseTaskQueueRecord(runtimeState?.taskQueue);
  const activeTaskId = runtimeState?.activeTaskId ?? null;
  const synced = await syncRuntimeWorkflowExports(options.cwd, {
    activeTaskId,
    taskQueue: queue,
    lastVerifiedRunId: runtimeState?.lastVerifiedRunId
  });
  if (synced && runtimeState && options.saveProjectRuntimeState) {
    await persistProjectIntegrityRepairMetadata({
      projectId: projectContext.project.id,
      getProjectRuntimeState: options.getProjectRuntimeState,
      saveProjectRuntimeState: options.saveProjectRuntimeState,
      source: "sync_runtime_exports",
      kind: "local_export_resync",
      summary: "sync-runtime-exports resynced local workflow exports from authoritative runtime state"
    });
  }

  return {
    format: resolveFormatFlag(args),
    result: {
      mode: "runtime_export_sync",
      workspaceSlug,
      projectSlug,
      activeTaskId,
      queue
    }
  };
}

export async function executeAdvanceActiveTaskCommandFromArgs(
  args: readonly string[],
  options: ExecuteAdvanceActiveTaskCommandOptions
): Promise<{ format: "json" | "text"; result: AdvanceActiveTaskCommandResult }> {
  const env = options.env ?? process.env;
  const explicitTaskId = resolveCommandFlag(args, "--task-id");
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("advance-active-task requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const projectContext = await options.getProjectContext({
    workspaceSlug,
    projectSlug
  });
  if (!projectContext) {
    throw new Error(`Project ${workspaceSlug}/${projectSlug} is not bootstrapped`);
  }

  const projectRuntimeState = await options.getProjectRuntimeState(projectContext.project.id);
  const activeTaskId = projectRuntimeState?.activeTaskId;

  if (!activeTaskId) {
    throw new Error("advance-active-task requires an active runtime task");
  }
  if (explicitTaskId && explicitTaskId !== activeTaskId) {
    throw new Error(
      `advance-active-task task mismatch: active runtime task is "${activeTaskId}", not "${explicitTaskId}"`
    );
  }

  const format = resolveFormatFlag(args);
  const proof = await executeWorkflowProofCommandFromArgs([...args, "--task-id", activeTaskId], {
    ...options,
    allowQueueContinuation: false
  });
  const queue = parseTaskQueueRecord(projectRuntimeState?.taskQueue);

  if (queue.current_task_id !== activeTaskId) {
    throw new Error(
      `advance-active-task requires runtime queue current_task_id "${queue.current_task_id ?? "none"}" to match active task "${activeTaskId}"`
    );
  }

  const advanced = advanceTaskQueue(queue, activeTaskId);
  const result: AdvanceActiveTaskCommandResult = {
    mode: args.includes("--apply") ? "applied" : "dry_run",
    taskId: activeTaskId,
    nextTaskId: advanced.nextTask?.id ?? null,
    proof,
    queue: advanced.queue
  };

  if (result.mode === "dry_run") {
    return {
      format,
      result
    };
  }

  const nextRuntimeState: ProjectRuntimeStateRecord = {
    projectId: projectContext.project.id,
    workspaceId: projectContext.workspace.id,
    activeRunId: proof.runId,
    activeTaskId: result.nextTaskId ?? undefined,
    taskQueue: advanced.queue,
    productState: projectRuntimeState?.productState ?? buildDefaultProductState(),
    lastVerifiedRunId: proof.runId,
    metadata: clearSeedFailureMetadata(projectRuntimeState?.metadata),
    createdAt: projectRuntimeState?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await options.saveProjectRuntimeState(nextRuntimeState);
  await syncRuntimeWorkflowExports(options.cwd, nextRuntimeState);

  return {
    format,
    result
  };
}

function formatDaemonCommandResult(result: DaemonCommandResult): string {
  const lines = [
    `status: ${result.status}`,
    `reason: ${result.reason}`,
    `workspace: ${result.workspaceSlug}`,
    `project: ${result.projectSlug}`,
    `active-run: ${result.activeRunId ?? "none"}`,
    `active-task: ${result.activeTaskId ?? "none"}`,
    `session-id: ${result.sessionId ?? "none"}`
  ];

  if (result.cycles.length > 0) {
    lines.push("cycles:");
    for (const cycle of result.cycles) {
      lines.push(
        `- cycle=${cycle.cycle} directive=${cycle.directiveKind} action=${cycle.action} task=${cycle.taskId ?? "none"} run=${cycle.runId} ${cycle.summary}`
      );
    }
  }

  return lines.join("\n");
}

function formatRuntimeExecutionPreflightFailureResult(input: {
  status: "blocked";
  reason: string;
  workspaceSlug: string;
  projectSlug: string;
  activeRunId: string | null;
  activeTaskId: string | null;
  sessionId: string | null;
}): string {
  return [
    `status: ${input.status}`,
    `reason: ${input.reason}`,
    `workspace: ${input.workspaceSlug}`,
    `project: ${input.projectSlug}`,
    `active-run: ${input.activeRunId ?? "none"}`,
    `active-task: ${input.activeTaskId ?? "none"}`,
    `session-id: ${input.sessionId ?? "none"}`
  ].join("\n");
}

function formatSupervisorCommandResult(result: SupervisorCommandResult): string {
  const lines = [
    `status: ${result.status}`,
    `reason: ${result.reason}`,
    `workspace: ${result.workspaceSlug}`,
    `project: ${result.projectSlug}`,
    `active-run: ${result.activeRunId ?? "none"}`,
    `active-task: ${result.activeTaskId ?? "none"}`,
    `session-id: ${result.sessionId ?? "none"}`
  ];

  if (result.actions.length > 0) {
    lines.push("actions:");
    for (const action of result.actions) {
      lines.push(
        `- cycle=${action.cycle} action=${action.action} target=${action.targetId ?? action.taskId ?? "none"}${action.reviewRole ? ` role=${action.reviewRole}` : ""} ${action.summary}`
      );
    }
  }

  if (result.daemonRuns.length > 0) {
    lines.push("daemon-runs:");
    for (const daemonRun of result.daemonRuns) {
      lines.push(
        `- status=${daemonRun.status} reason=${daemonRun.reason} task=${daemonRun.activeTaskId ?? "none"} run=${daemonRun.activeRunId ?? "none"}`
      );
    }
  }

  return lines.join("\n");
}

function formatSupervisorHistoryCommandResult(result: SupervisorHistoryCommandResult): string {
  const lines = [
    "Supervisor history",
    `scope: ${result.scope}`,
    `run-id: ${result.runId ?? "all"}`,
    `history-path: ${result.historyPath}`,
    `retained: ${result.retainedCount}`,
    `filtered: ${result.filteredCount}`,
    `returned: ${result.returnedCount}`,
    `truncated: ${result.truncated ? "yes" : "no"}`
  ];

  if (result.latestStatus) {
    lines.push(
      `latest-status: ${result.latestStatus.state}${result.latestStatus.blockerKind ? ` ${result.latestStatus.blockerKind}` : ""} ${result.latestStatus.reason}`
    );
    if (result.latestStatus.activeRunId || result.latestStatus.activeTaskId) {
      lines.push(
        `latest-target: run=${result.latestStatus.activeRunId ?? "none"} task=${result.latestStatus.activeTaskId ?? "none"}`
      );
    }
  }

  if (result.entries.length === 0) {
    lines.push("entries: none");
    return lines.join("\n");
  }

  lines.push("entries:");
  for (const entry of result.entries) {
    lines.push(
      `- ${entry.recordedAt} run=${entry.activeRunId ?? "unknown"} task=${entry.activeTaskId ?? "unknown"} state=${entry.state}${entry.blockerKind ? ` blocker=${entry.blockerKind}` : ""} actions=${entry.actionCount} reason=${entry.reason}`
    );
  }

  return lines.join("\n");
}

function buildSupervisorOperatorNotes(input: {
  targetId: string;
  summary: string;
  nextActions: readonly string[];
  override?: string | undefined;
}): string {
  if (input.override?.trim()) {
    return input.override.trim();
  }

  const lines = [`Local supervisor authorized advisory continuation for ${input.targetId}.`];
  if (input.summary.trim()) {
    lines.push(`Reason: ${input.summary.trim()}`);
  }
  if (input.nextActions.length > 0) {
    lines.push(`Context: ${input.nextActions.join(" | ")}`);
  }
  return lines.join(" ");
}

async function writeSupervisorOperatorContinuationAction(input: {
  cwd: string;
  operatorActionDir: string;
  runId: string;
  taskId: string;
  targetId: string;
  source: "blocking_gap" | "progress_proof" | "checkpoint";
  sourceId?: string | undefined;
  operatorNotes: string;
  cycle: number;
  nowValue: string;
}): Promise<string> {
  await mkdir(input.operatorActionDir, { recursive: true });
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTimestamp = input.nowValue.replace(/[^0-9A-Za-z]/g, "");
  const fileName = `supervisor-${String(input.cycle).padStart(2, "0")}-${safeRunId}-${safeTaskId}-${safeTimestamp}.json`;
  const filePath = path.join(input.operatorActionDir, fileName);
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        runId: input.runId,
        taskId: input.taskId,
        blockerKind: "operator_required_continuation",
        action: {
          kind: "continue_with_analysis",
          targetId: input.targetId,
          source: input.source,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          operatorNotes: input.operatorNotes
        },
        supervisor: {
          kind: "local_supervisor",
          generatedAt: input.nowValue
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path.relative(input.cwd, filePath) || path.basename(filePath);
}

interface DaemonReviewQueueStatusObservation {
  authorityLabel: "derived_only";
  state: "processed" | "blocked" | "failed" | "invalid";
  reviewInputDir?: string | undefined;
  reason: string;
  expectedReviewTargets: string[];
  queuedFiles: string[];
  consumedFiles: string[];
  failedFiles: { file: string; error: string }[];
  staleFiles: { file: string; reason: string }[];
  updatedAt?: string | undefined;
}

async function readDaemonReviewQueueStatus(
  cwd: string
): Promise<DaemonReviewQueueStatusObservation | undefined> {
  const statusPath = path.join(cwd, ".archon", "work", "daemon", "review-queue-status.json");
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state =
      parsed.state === "processed" || parsed.state === "blocked" || parsed.state === "failed"
        ? parsed.state
        : "invalid";
    const reviewInputDir = typeof parsed.reviewInputDir === "string" ? parsed.reviewInputDir : undefined;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason
        : "daemon review queue status is missing a valid reason";
    const expectedReviewTargets = Array.isArray(parsed.expectedReviewTargets)
      ? parsed.expectedReviewTargets.filter((value): value is string => typeof value === "string")
      : [];
    const queuedFiles = Array.isArray(parsed.queuedFiles)
      ? parsed.queuedFiles.filter((value): value is string => typeof value === "string")
      : [];
    const consumedFiles = Array.isArray(parsed.consumedFiles)
      ? parsed.consumedFiles.filter((value): value is string => typeof value === "string")
      : [];
    const failedFiles = Array.isArray(parsed.failedFiles)
      ? parsed.failedFiles.flatMap((value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  file: typeof (value as { file?: unknown }).file === "string" ? (value as { file: string }).file : "unknown",
                  error:
                    typeof (value as { error?: unknown }).error === "string"
                      ? (value as { error: string }).error
                      : "unknown"
                }
              ]
            : []
        )
      : [];
    const staleFiles = Array.isArray(parsed.staleFiles)
      ? parsed.staleFiles.flatMap((value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  file: typeof (value as { file?: unknown }).file === "string" ? (value as { file: string }).file : "unknown",
                  reason:
                    typeof (value as { reason?: unknown }).reason === "string"
                      ? (value as { reason: string }).reason
                      : "unknown"
                }
              ]
            : []
        )
      : [];
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      reviewInputDir,
      reason,
      expectedReviewTargets,
      queuedFiles,
      consumedFiles,
      failedFiles,
      staleFiles,
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      reason: `failed to parse daemon review queue status: ${error instanceof Error ? error.message : String(error)}`,
      expectedReviewTargets: [],
      queuedFiles: [],
      consumedFiles: [],
      failedFiles: [],
      staleFiles: [],
      updatedAt: undefined
    };
  }
}

function parseSupervisorReviewActorBindings(
  args: readonly string[],
  env: EnvShape
): Partial<Record<ReviewRecord["reviewerRole"], string>> {
  const bindings: Partial<Record<ReviewRecord["reviewerRole"], string>> = {};
  const mappingArgs = collectCommandFlagValues(args, "--review-actor");
  for (const mapping of mappingArgs) {
    const separatorIndex = mapping.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === mapping.length - 1) {
      throw new Error(`Invalid --review-actor value: ${mapping}`);
    }
    const role = mapping.slice(0, separatorIndex).trim();
    const actor = mapping.slice(separatorIndex + 1).trim();
    if (!isGateReviewRole(role)) {
      throw new Error(`Invalid review role in --review-actor: ${role}`);
    }
    if (!actor) {
      throw new Error(`Invalid empty actor in --review-actor: ${mapping}`);
    }
    bindings[role] = actor;
  }

  const envBindings: Array<[ReviewRecord["reviewerRole"], string | undefined]> = [
    ["reviewer", env.ARCHON_SUPERVISOR_REVIEWER_ACTOR],
    ["security_reviewer", env.ARCHON_SUPERVISOR_SECURITY_REVIEWER_ACTOR],
    ["qa_engineer", env.ARCHON_SUPERVISOR_QA_ENGINEER_ACTOR]
  ];
  for (const [role, actor] of envBindings) {
    if (!bindings[role] && actor?.trim()) {
      bindings[role] = actor.trim();
    }
  }

  return bindings;
}

function parseExpectedReviewTarget(target: string): {
  taskId: string;
  reviewRole: ReviewRecord["reviewerRole"];
} | undefined {
  const separatorIndex = target.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === target.length - 1) {
    return undefined;
  }
  const taskId = target.slice(0, separatorIndex).trim();
  const reviewRole = target.slice(separatorIndex + 1).trim();
  if (!taskId || !isGateReviewRole(reviewRole)) {
    return undefined;
  }
  return {
    taskId,
    reviewRole
  };
}

async function resolveSupervisorReviewAuthContext(input: {
  cwd: string;
  env: EnvShape;
  actor: string;
}): Promise<{ provider: string; subject: string; verified: true } | undefined> {
  let bindingsPath: string;
  try {
    bindingsPath = await resolveRequiredReviewIdentityFilePath({
      envVarName: "ARCHON_REVIEW_IDENTITY_BINDINGS",
      envVarValue: input.env.ARCHON_REVIEW_IDENTITY_BINDINGS,
      liveRelativePath: ".archon/review-identity-bindings.json",
      cwd: input.cwd
    });
  } catch {
    return undefined;
  }

  if (isRepoTemplateReviewIdentityPath(bindingsPath)) {
    return undefined;
  }

  if (await bindingsUsePlaceholderContent(bindingsPath)) {
    return undefined;
  }

  const bindings = await loadReviewIdentityBindings(bindingsPath);
  const matches = bindings.bindings
    .filter((binding) => binding.actors.some((actorBinding) => actorBinding.actor === input.actor))
    .map((binding) => ({
      provider: binding.principal.provider,
      subject: binding.principal.subject
    }))
    .filter(
      (binding, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.provider === binding.provider && candidate.subject === binding.subject
        ) === index
    );

  if (matches.length !== 1) {
    return undefined;
  }

  return {
    provider: matches[0]!.provider,
    subject: matches[0]!.subject,
    verified: true
  };
}

async function writeSupervisorReviewAction(input: {
  cwd: string;
  reviewInputDir: string;
  runId: string;
  taskId: string;
  reviewRole: ReviewRecord["reviewerRole"];
  actor: string;
  authContext?: { provider: string; subject: string; verified: true } | undefined;
  cycle: number;
  nowValue: string;
}): Promise<string> {
  await mkdir(input.reviewInputDir, { recursive: true });
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTimestamp = input.nowValue.replace(/[^0-9A-Za-z]/g, "");
  const fileName = `supervisor-${String(input.cycle).padStart(2, "0")}-${safeRunId}-${safeTaskId}-${input.reviewRole}-${safeTimestamp}.json`;
  const filePath = path.join(input.reviewInputDir, fileName);
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        runId: input.runId,
        taskId: input.taskId,
        actor: input.actor,
        review: {
          reviewerRole: input.reviewRole,
          state: "passed",
          severity: "low",
          findings: []
        },
        ...(input.authContext ? { authContext: input.authContext } : {}),
        supervisor: {
          kind: "local_supervisor",
          generatedAt: input.nowValue
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path.relative(input.cwd, filePath) || path.basename(filePath);
}

export async function executeDaemonCommandFromArgs(
  args: readonly string[],
  options: ExecuteDaemonCommandOptions
): Promise<{ format: "json" | "text"; result: DaemonCommandResult }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const format = resolveFormatFlag(args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;
  const maxCyclesValue = resolveCommandFlag(args, "--max-cycles") ?? "8";
  const maxCycles = Number.parseInt(maxCyclesValue, 10);
  const staleAfterHoursValue = resolveCommandFlag(args, "--stale-after-hours") ?? "24";
  const staleAfterHours = Number.parseInt(staleAfterHoursValue, 10);
  const claudeBin = resolveCommandFlag(args, "--claude-bin") ?? env.ARCHON_CLAUDE_BIN ?? "claude";
  const reviewInputDir = resolveDaemonReviewInputDir(args, { cwd, env });
  const operatorActionDir = resolveDaemonOperatorActionDir(args, { cwd, env });

  if (!workspaceSlug || !projectSlug) {
    throw new Error("daemon requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }
  if (!Number.isInteger(maxCycles) || maxCycles <= 0) {
    throw new Error(`Invalid --max-cycles value: ${maxCyclesValue}`);
  }
  if (!Number.isInteger(staleAfterHours) || staleAfterHours < 0) {
    throw new Error(`Invalid --stale-after-hours value: ${staleAfterHoursValue}`);
  }

  const runCodexTurn = options.runCodexTurn ?? runCodexTurnViaCli;
  const now = options.now ?? (() => new Date());

  const result = await withDaemonLock(cwd, async () => {
    const cycles: DaemonCycleRecord[] = [];
    let latestSessionId: string | undefined;
    const blockedResult = async (input: {
      blockerKind:
        | "bootstrapping"
        | "runtime_preflight"
        | "missing_active_runtime"
        | "review_queue"
        | "review_execution_unsupported"
        | "operator_required_continuation"
        | "workflow_proof_failure"
        | "scope_expansion_required"
        | "runtime_blocked"
        | "recovery_required"
        | "runtime_task_missing"
        | "active_task_mismatch";
      reason: string;
      cycle: number;
      activeRunId: string | null;
      activeTaskId: string | null;
      directiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
      nextActions?: string[] | undefined;
      detailFiles?: {
        continuationStatus?: string | undefined;
        reviewQueueStatus?: string | undefined;
        scopeExpansionRequest?: string | undefined;
      } | undefined;
    }) => {
      await writeDaemonOperatorHandoff(cwd, {
        state: "blocked",
        blockerKind: input.blockerKind,
        reason: input.reason,
        workspaceSlug,
        projectSlug,
        activeRunId: input.activeRunId,
        activeTaskId: input.activeTaskId,
        sessionId: latestSessionId ?? null,
        cycle: input.cycle,
        directiveKind: input.directiveKind,
        nextActions: [...(input.nextActions ?? [])],
        detailFiles: { ...(input.detailFiles ?? {}) },
        updatedAt: now().toISOString()
      });

      return {
        authorityLabel: "derived_only" as const,
        workspaceSlug,
        projectSlug,
        status: "blocked" as const,
        reason: input.reason,
        activeRunId: input.activeRunId,
        activeTaskId: input.activeTaskId,
        sessionId: latestSessionId ?? null,
        cycles
      };
    };

    const attemptRuntimeReconcile = async (cycle: number): Promise<ReconcileRuntimeStateCommandResult | undefined> => {
      const baseArgs = [
        "--workspace-slug",
        workspaceSlug,
        "--project-slug",
        projectSlug,
        "--stale-after-hours",
        String(staleAfterHours),
        "--format",
        "json"
      ] as const;
      const preview = await executeReconcileRuntimeStateCommandFromArgs(
        baseArgs,
        options
      );
      const repairAction = preview.result.repairAction;
      const shouldApply =
        repairAction === "rebuild_missing_runtime_state" ||
        repairAction === "sync_active_task_to_in_progress" ||
        repairAction === "activate_owner_dispatch_target";

      if (!preview.result.runtimeStateChanged || !shouldApply) {
        return undefined;
      }

      const { result } = await executeReconcileRuntimeStateCommandFromArgs(
        [
          ...baseArgs,
          "--apply",
        ],
        options
      );

      cycles.push({
        cycle,
        directiveKind: result.executionPlanDirectiveKind ?? "blocked",
        action: "reconcile_runtime_state",
        runId: result.activeRunId ?? "none",
        taskId: result.activeTaskId,
        sessionId: latestSessionId ?? null,
        summary: `${result.repairAction}: ${result.reason}`
      });
      return result;
    };

    const runtimePreflightFailure = await executeRuntimeExecutionPreflight(
      args,
      {
        ...(options as ExecuteRuntimePreflightCommandOptions),
        requireRuntimePreflight: true
      }
    );
    if (runtimePreflightFailure) {
      return blockedResult({
        blockerKind: "runtime_preflight",
        reason: runtimePreflightFailure.reason,
        cycle: 1,
        activeRunId: runtimePreflightFailure.activeRunId,
        activeTaskId: null,
        nextActions: runtimePreflightFailure.nextActions
      });
    }

    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      const projectContext = await options.getProjectContext({
        workspaceSlug,
        projectSlug
      });
      if (!projectContext) {
        return blockedResult({
          blockerKind: "bootstrapping",
          reason: `Project ${workspaceSlug}/${projectSlug} is not bootstrapped`,
          cycle,
          activeRunId: null,
          activeTaskId: null,
          nextActions: []
        });
      }

      await attemptRuntimeReconcile(cycle);

      const projectRuntimeState = await options.getProjectRuntimeState(projectContext.project.id);
      const activeRunId = projectRuntimeState?.activeRunId ?? null;
      const activeTaskId = projectRuntimeState?.activeTaskId ?? null;
      latestSessionId = latestSessionId ?? readDaemonSessionId(projectRuntimeState?.metadata);
      await clearDaemonContinuationStatus(cwd);
      await clearDaemonAutomationEnvelope(cwd);
      await clearDaemonAppAutomationRequest(cwd);
      await clearDaemonCliSchedulerRequest(cwd);
      await clearDaemonOperatorHandoff(cwd);
      await clearDaemonScopeExpansionRequest(cwd);

      if (!activeRunId || !activeTaskId) {
        if (cycles.length > 0) {
          return {
            authorityLabel: "derived_only" as const,
            workspaceSlug,
            projectSlug,
            status: "completed" as const,
            reason: "daemon reached an idle runtime state with no active task remaining",
            activeRunId,
            activeTaskId,
            sessionId: latestSessionId ?? null,
            cycles
          };
        }

        return blockedResult({
          blockerKind: "missing_active_runtime",
          reason: "daemon requires an active runtime run and task",
          cycle,
          activeRunId,
          activeTaskId,
          nextActions: []
        });
      }

      const loop = await executeLoopCommandFromArgs(
        [
          "--run-id",
          activeRunId,
          "--format",
          "json",
          "--stale-after-hours",
          String(staleAfterHours),
          "--apply-safe-recovery"
        ],
        {
          ...options,
          skipRuntimePreflight: true,
          runtimePreflightBypassToken: INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN
        }
      );
      const directive = loop.result.finalPlan.directive;
      const runDaemonCodexTurn = async (input: {
        directive: RunExecutionPlan["directive"];
        summaryAction: "run_codex_owner" | "run_codex_analysis";
        activeRunId: string;
        activeTaskId: string;
        operatorNotes?: string | undefined;
      }) => {
        const snapshot = await options.getStatusSnapshot(input.activeRunId);
        const taskRecord = snapshot.tasks.find((task) => task.packet.taskId === input.activeTaskId);
        if (!taskRecord) {
          const reconciled = await attemptRuntimeReconcile(cycle);
          if (reconciled?.runtimeStateChanged) {
            return undefined;
          }
          cycles.push({
            cycle,
            directiveKind: input.directive.kind,
            action: "blocked",
            runId: input.activeRunId,
            taskId: input.activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: "active runtime task is missing from the run snapshot"
          });

          return blockedResult({
            blockerKind: "runtime_task_missing",
            reason: "active runtime task is missing from the run snapshot",
            cycle,
            activeRunId: input.activeRunId,
            activeTaskId: input.activeTaskId,
            directiveKind: input.directive.kind,
            nextActions: [
              "inspect `npm run archon:status -- --format json` to confirm the runtime task snapshot",
              "run `npm run archon:reconcile` to repair safe runtime/local task drift before retrying the daemon"
            ]
          });
        }
        const beforeProgressKey = buildDaemonProgressKey({
          runtimeState: projectRuntimeState,
          snapshot,
          directive: input.directive,
          activeTaskId: input.activeTaskId
        });
        const promptMetadata = readDaemonPromptMetadata(projectRuntimeState?.metadata);
        const packetFingerprint = buildDaemonTaskPacketFingerprint(taskRecord.packet);
        const promptMode = determineDaemonPromptMode({
          sessionId: latestSessionId,
          previousTaskId: promptMetadata?.taskId,
          previousPacketFingerprint: promptMetadata?.packetFingerprint,
          taskId: input.activeTaskId,
          packetFingerprint
        });
        const latestCheckpoint = snapshot.autonomousExecution?.state.checkpoints.at(-1);

        const prompt = buildDaemonTaskPrompt({
          promptMode,
          directive: input.directive,
          taskId: input.activeTaskId,
          packet: taskRecord.packet,
          operatorNotes: input.operatorNotes,
          compressedContextSummary:
            promptMode === "delta"
              ? latestCheckpoint?.compressedContextSummary
              : undefined,
          compressedContextRef:
            promptMode === "delta"
              ? latestCheckpoint?.compressedContextRef
              : undefined
        });
        const codexTurn = await runCodexTurn({
          claudeBin,
          cwd,
          env,
          prompt,
          sessionId: latestSessionId
        });

        latestSessionId = codexTurn.sessionId ?? latestSessionId;
        const parsedTurnMessage = parseDaemonTurnMessage(codexTurn.finalMessage);
        await persistDaemonTurnCheckpoint({
          runId: input.activeRunId,
          taskId: input.activeTaskId,
          snapshot,
          message: parsedTurnMessage,
          checkpointRun: options.checkpointRun,
          now
        });
        const refreshedProjectRuntimeState = await options.getProjectRuntimeState(projectContext.project.id);
        const refreshedSnapshot = await options.getStatusSnapshot(input.activeRunId);
        const refreshedPlan = await options.getExecutionPlan(input.activeRunId, staleAfterHours);
        const afterProgressKey = buildDaemonProgressKey({
          runtimeState: refreshedProjectRuntimeState,
          snapshot: refreshedSnapshot,
          directive: refreshedPlan.directive,
          activeTaskId: input.activeTaskId
        });
        const noProgress = beforeProgressKey === afterProgressKey;
        const priorStagnation = readDaemonStagnationMetadata(projectRuntimeState?.metadata);
        const stagnantTurnCount =
          noProgress &&
          priorStagnation &&
          priorStagnation.runId === input.activeRunId &&
          priorStagnation.taskId === input.activeTaskId &&
          priorStagnation.directiveKind === input.directive.kind &&
          priorStagnation.progressKey === beforeProgressKey
            ? priorStagnation.count + 1
            : noProgress
              ? 1
              : 0;
        await options.saveProjectRuntimeState({
          projectId: refreshedProjectRuntimeState?.projectId ?? projectRuntimeState?.projectId ?? projectContext.project.id,
          workspaceId: refreshedProjectRuntimeState?.workspaceId ?? projectRuntimeState?.workspaceId ?? projectContext.workspace.id,
          activeRunId: refreshedProjectRuntimeState?.activeRunId,
          activeTaskId: refreshedProjectRuntimeState?.activeTaskId,
          taskQueue: refreshedProjectRuntimeState?.taskQueue ?? projectRuntimeState?.taskQueue ?? buildDefaultTaskQueue(),
          productState: refreshedProjectRuntimeState?.productState ?? projectRuntimeState?.productState ?? buildDefaultProductState(),
          lastVerifiedRunId: refreshedProjectRuntimeState?.lastVerifiedRunId ?? projectRuntimeState?.lastVerifiedRunId,
          metadata: {
            ...(refreshedProjectRuntimeState?.metadata ?? projectRuntimeState?.metadata ?? {}),
            archonDaemon: {
              sessionId: latestSessionId,
              lastRunId: input.activeRunId,
              lastTaskId: input.activeTaskId,
              lastDirectiveKind: input.directive.kind,
              lastPromptTaskId: input.activeTaskId,
              lastPromptPacketFingerprint: packetFingerprint,
              lastPromptMode: promptMode,
              ...(noProgress
                ? {
                    stagnation: {
                      runId: input.activeRunId,
                      taskId: input.activeTaskId,
                      directiveKind: input.directive.kind,
                      progressKey: beforeProgressKey,
                      count: stagnantTurnCount,
                      updatedAt: now().toISOString(),
                      lastStatus: parsedTurnMessage?.status,
                      lastSummary: parsedTurnMessage?.summary,
                      lastBlockers: parsedTurnMessage?.blockers
                    }
                  }
                : {}),
              updatedAt: now().toISOString()
            }
          },
          createdAt: refreshedProjectRuntimeState?.createdAt ?? projectRuntimeState?.createdAt ?? now().toISOString(),
          updatedAt: now().toISOString()
        });

        cycles.push({
          cycle,
          directiveKind: input.directive.kind,
          action: input.summaryAction,
          runId: input.activeRunId,
          taskId: input.activeTaskId,
          sessionId: latestSessionId ?? null,
          summary: parsedTurnMessage?.summary || codexTurn.finalMessage?.slice(0, 160) || "codex turn executed"
        });

        if (noProgress) {
          const workerSummary =
            parsedTurnMessage
              ? [parsedTurnMessage.summary, ...parsedTurnMessage.blockers].filter(Boolean).join(" | ")
              : "runtime state was unchanged after the Codex turn";
          const scopeConflict = daemonMessageHasScopeConflict(parsedTurnMessage);
          const shouldBlockNow =
            parsedTurnMessage?.status === "blocked" || stagnantTurnCount >= MAX_DAEMON_STAGNANT_TURNS;

          if (shouldBlockNow) {
            let scopeExpansionRequestPath: string | undefined;
            if (scopeConflict && parsedTurnMessage?.scopeRequest) {
              scopeExpansionRequestPath = await writeDaemonScopeExpansionRequest(cwd, {
                runId: input.activeRunId,
                taskId: input.activeTaskId,
                directiveKind: input.directive.kind,
                blockedPaths: [...parsedTurnMessage.scopeRequest.blockedPaths],
                requestedWriteScope:
                  parsedTurnMessage.scopeRequest.requestedWriteScope.length > 0
                    ? [...parsedTurnMessage.scopeRequest.requestedWriteScope]
                    : [...parsedTurnMessage.scopeRequest.blockedPaths],
                reason: parsedTurnMessage.scopeRequest.reason ?? parsedTurnMessage.summary,
                updatedAt: now().toISOString()
              });
            }
            const reason = scopeConflict
              ? `daemon stopped after a scope-blocked no-progress turn: ${workerSummary}`
              : parsedTurnMessage?.status === "blocked"
                ? `daemon stopped after a blocked no-progress turn: ${workerSummary}`
                : `daemon detected ${stagnantTurnCount} consecutive no-progress turns for ${input.activeTaskId}: ${workerSummary}`;
            const nextActions = scopeConflict
              ? [
                  "widen the task packet allowed write scope to include the blocked paths or split them into a follow-on task",
                  "record the exact blocked paths in the blocker handoff before rerouting"
                ]
              : [
                  "inspect the active task packet and daemon session for missing runtime proof, handoff, or verification steps",
                  "reroute only after a concrete runtime state change is possible"
                ];
            cycles.push({
              cycle,
              directiveKind: input.directive.kind,
              action: scopeConflict ? "request_scope_expansion" : "blocked",
              runId: input.activeRunId,
              taskId: input.activeTaskId,
              sessionId: latestSessionId ?? null,
              summary: reason
            });

            return blockedResult({
              blockerKind: scopeConflict ? "scope_expansion_required" : "runtime_blocked",
              reason,
              cycle,
              activeRunId: input.activeRunId,
              activeTaskId: input.activeTaskId,
              directiveKind: input.directive.kind,
              nextActions,
              detailFiles: scopeExpansionRequestPath
                ? {
                    scopeExpansionRequest: scopeExpansionRequestPath
                  }
                : undefined
            });
          }
        }

        return undefined;
      };
      const handleOperatorRequiredContinuation = async (input: {
        directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
        classification: ContinueAnalysisDirectiveClassification;
      }
      ): Promise<DaemonCommandResult | undefined> => {
        let queuedOperatorActions: DaemonOperatorActionQueueEntry[];
        let failedOperatorActions: FailedDaemonOperatorActionQueueEntry[];
        try {
          const queueState = await readDaemonOperatorActionQueueState(operatorActionDir);
          queuedOperatorActions = queueState.entries;
          failedOperatorActions = queueState.failedEntries;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          cycles.push({
            cycle,
            directiveKind: input.directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: `operator action queue error: ${message}`
          });

          return blockedResult({
            blockerKind: "operator_required_continuation",
            reason: `operator action queue error: ${message}`,
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: input.directive.kind,
            nextActions: [...input.directive.nextActions]
          });
        }

        if (failedOperatorActions.length > 0) {
          await archiveFailedDaemonOperatorActionQueueEntries(failedOperatorActions, cwd, now().toISOString());
        }

        const matchingOperatorAction = queuedOperatorActions.find((entry) =>
          matchesDaemonOperatorContinuationAction({
            entry,
            runId: activeRunId,
            taskId: activeTaskId,
            directive: input.directive,
            classification: input.classification
          })
        );

        if (matchingOperatorAction) {
          await archiveConsumedDaemonOperatorActionQueueEntries([matchingOperatorAction], cwd);
          const codexResult = await runDaemonCodexTurn({
            directive: input.directive,
            summaryAction: "run_codex_analysis",
            activeRunId,
            activeTaskId,
            operatorNotes: matchingOperatorAction.command.action.operatorNotes
          });
          return codexResult;
        }

        const providerSelection = selectLocalContinuationProvider({
          executionMode: input.classification.executionMode,
          continuationIntent: input.classification.continuationIntent,
          capabilities: resolveContinuationCapabilities(env)
        });
        const updatedAt = now().toISOString();
        await writeDaemonContinuationStatus(cwd, {
          state: "blocked",
          directiveKind: "continue_analysis",
          executionMode: "operator_required",
          targetId: input.directive.targetId,
          source: input.directive.source,
          sourceId:
            input.classification.action?.kind === "resume_target"
              ? input.classification.action.sourceId
              : undefined,
          actionKind: input.classification.action?.kind,
          provider: providerSelection.provider,
          wakeOwner: providerSelection.wakeOwner,
          scheduleKind: providerSelection.scheduleKind,
          schedule: providerSelection.schedule,
          summary: input.classification.summary,
          nextActions: [...input.directive.nextActions],
          blockers: [...input.directive.blockers],
          updatedAt
        });
        if (
          (providerSelection.provider === "claude_app_thread_automation" ||
            providerSelection.provider === "claude_app_standalone_automation" ||
            providerSelection.provider === "claude_cli_exec_scheduler") &&
          providerSelection.wakeOwner === "operator" &&
          providerSelection.scheduleKind !== "none" &&
          providerSelection.scheduleKind !== "manual" &&
          typeof providerSelection.schedule === "string" &&
          (input.classification.continuationIntent === "defer_same_thread" ||
            input.classification.continuationIntent === "defer_fresh_run") &&
          (input.directive.source === "checkpoint" || input.directive.source === "progress_proof")
        ) {
          await writeDaemonAutomationEnvelope(cwd, {
            provider: providerSelection.provider,
            wakeOwner: "operator",
            continuationIntent: input.classification.continuationIntent,
            targetMode: input.classification.continuationIntent === "defer_same_thread" ? "same_thread" : "fresh_run",
            scheduleKind: providerSelection.scheduleKind,
            schedule: providerSelection.schedule,
            targetId: input.directive.targetId,
            source: input.directive.source,
            sourceId:
              input.classification.action?.kind === "resume_target"
                ? input.classification.action.sourceId
                : undefined,
            summary: input.classification.summary,
            nextActions: [...input.directive.nextActions],
            workspaceSlug,
            projectSlug,
            activeRunId,
            activeTaskId,
            updatedAt
          });
        } else {
          await clearDaemonAutomationEnvelope(cwd);
        }
        cycles.push({
          cycle,
          directiveKind: input.directive.kind,
          action: "blocked",
          runId: activeRunId,
          taskId: activeTaskId,
          sessionId: latestSessionId ?? null,
          summary: input.classification.summary
        });

        return blockedResult({
          blockerKind: "operator_required_continuation",
          reason: input.classification.summary,
          cycle,
          activeRunId,
          activeTaskId,
          directiveKind: input.directive.kind,
          nextActions: [...input.directive.nextActions],
          detailFiles: {
            continuationStatus: ".archon/work/daemon/continuation-status.json",
            ...(providerSelection.provider === "claude_app_thread_automation" ||
            providerSelection.provider === "claude_app_standalone_automation" ||
            providerSelection.provider === "claude_cli_exec_scheduler"
              ? {
                  automationEnvelope: ".archon/work/daemon/automation-envelope.json"
                }
              : {})
          }
        });
      };

      if (directive.kind === "complete") {
        const advanced = await executeAdvanceActiveTaskCommandFromArgs(
          [
            "--workspace-slug",
            workspaceSlug,
            "--project-slug",
            projectSlug,
            "--run-id",
            activeRunId,
            "--apply",
            "--format",
            "json"
          ],
          options
        );

        cycles.push({
          cycle,
          directiveKind: directive.kind,
          action: advanced.result.nextTaskId ? "advance_active_task" : "complete",
          runId: activeRunId,
          taskId: activeTaskId,
          sessionId: latestSessionId ?? null,
          summary: advanced.result.nextTaskId
            ? `advanced to ${advanced.result.nextTaskId}`
            : "advanced the final active task and closed the queue"
        });

        if (!advanced.result.nextTaskId) {
          const refreshedState = await options.getProjectRuntimeState(projectContext.project.id);
          return {
            authorityLabel: "derived_only" as const,
            workspaceSlug,
            projectSlug,
            status: "completed" as const,
            reason: "daemon advanced the final active task and no next task remains",
            activeRunId: refreshedState?.activeRunId ?? null,
            activeTaskId: refreshedState?.activeTaskId ?? null,
            sessionId: latestSessionId ?? null,
            cycles
          };
        }

        continue;
      }

      if (directive.kind === "dispatch_reviews") {
        if (!options.executeDirectiveStep) {
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: "runtime surface does not support authenticated review execution"
          });

          return blockedResult({
            blockerKind: "review_execution_unsupported",
            reason: "required authenticated reviews block the active run",
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: []
          });
        }

        let queuedReviewEntries: DaemonReviewQueueEntry[];
        let failedReviewEntries: FailedDaemonReviewQueueEntry[];
        try {
          const queueState = await readDaemonReviewQueueState(reviewInputDir);
          queuedReviewEntries = queueState.entries;
          failedReviewEntries = queueState.failedEntries;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: `review input queue error: ${message}`
          });

          return blockedResult({
            blockerKind: "review_queue",
            reason: `review input queue error: ${message}`,
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: []
          });
        }

        const expectedReviewTargets = directive.recommendations.map(
          (recommendation) => `${recommendation.taskId}:${recommendation.targetReviewRole ?? "unknown"}`
        );
        if (failedReviewEntries.length > 0) {
          const timestamp = now().toISOString();
          await archiveFailedDaemonReviewQueueEntries(failedReviewEntries, cwd, timestamp);
          await writeDaemonReviewQueueStatus(cwd, {
            state: "failed",
            reviewInputDir,
            reason: `${failedReviewEntries.length} queued review action file(s) were invalid and moved to failed-review-actions`,
            expectedReviewTargets,
            queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
            failedFiles: failedReviewEntries.map((entry) => ({
              file: path.basename(entry.filePath),
              error: entry.error
            })),
            updatedAt: timestamp
          });
        }

        if (queuedReviewEntries.length === 0) {
          await writeDaemonReviewQueueStatus(cwd, {
            state: failedReviewEntries.length > 0 ? "failed" : "blocked",
            reviewInputDir,
            reason: `required authenticated reviews are pending; no usable review action files were found in ${reviewInputDir}`,
            expectedReviewTargets,
            failedFiles: failedReviewEntries.map((entry) => ({
              file: path.basename(entry.filePath),
              error: entry.error
            })),
            updatedAt: now().toISOString()
          });
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary: `required authenticated reviews are pending; no review action files were found in ${reviewInputDir}`
          });

          return blockedResult({
            blockerKind: "review_queue",
            reason: "required authenticated reviews block the active run",
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: [],
            detailFiles: {
              reviewQueueStatus: ".archon/work/daemon/review-queue-status.json"
            }
          });
        }

        const executionResult = await options.executeDirectiveStep(activeRunId, {
          staleAfterHours,
          reviewCommands: queuedReviewEntries.map((entry) => entry.command)
        });

        const consumedEntries: DaemonReviewQueueEntry[] = [];
        const staleEntries: StaleDaemonReviewQueueEntry[] = [];
        for (const step of executionResult.steps) {
          if (
            step.directiveKind !== "dispatch_reviews" ||
            step.outcome !== "executed" ||
            !step.taskId ||
            !step.reviewRole
          ) {
            continue;
          }

          const matchIndex = queuedReviewEntries.findIndex(
            (entry) =>
              entry.command.runId === activeRunId &&
              entry.command.taskId === step.taskId &&
              entry.command.review.reviewerRole === step.reviewRole &&
              (step.actor ? entry.command.actor === step.actor : true)
          );
          if (matchIndex >= 0) {
            const consumed = queuedReviewEntries.splice(matchIndex, 1)[0]!;
            consumedEntries.push(consumed);
          }

          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "record_review",
            runId: activeRunId,
            taskId: step.taskId,
            sessionId: latestSessionId ?? null,
            summary: `recorded ${step.reviewRole}${step.actor ? ` via ${step.actor}` : ""}`
          });
        }

        if (consumedEntries.length > 0) {
          await archiveConsumedDaemonReviewQueueEntries(consumedEntries, cwd);
        }

        if (queuedReviewEntries.length > 0) {
          staleEntries.push(
            ...queuedReviewEntries.map((entry) => ({
              filePath: entry.filePath,
              reason: "queued review action no longer matched the active runtime review directives"
            }))
          );
          await archiveStaleDaemonReviewQueueEntries(
            staleEntries,
            cwd,
            now().toISOString(),
            expectedReviewTargets
          );
          queuedReviewEntries = [];
        }

        if (!executionResult.steps.some((step) => step.directiveKind === "dispatch_reviews" && step.outcome === "executed")) {
          const unsupportedStep = executionResult.steps.find((step) => step.directiveKind === "dispatch_reviews");
          const mismatchReason =
            staleEntries.length > 0
              ? `queued review actions did not match the pending runtime review directives from ${reviewInputDir}`
              : undefined;
          const detailedReason =
            unsupportedStep?.evidence.join(" | ") ||
            `queued review actions did not match the pending runtime review directives from ${reviewInputDir}`;
          await writeDaemonReviewQueueStatus(cwd, {
            state: "blocked",
            reviewInputDir,
            reason: mismatchReason ? `${mismatchReason}: ${detailedReason}` : detailedReason,
            expectedReviewTargets,
            queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
            failedFiles: failedReviewEntries.map((entry) => ({
              file: path.basename(entry.filePath),
              error: entry.error
            })),
            staleFiles: staleEntries.map((entry) => ({
              file: path.basename(entry.filePath),
              reason: entry.reason
            })),
            updatedAt: now().toISOString()
          });
          cycles.push({
            cycle,
            directiveKind: directive.kind,
            action: "blocked",
            runId: activeRunId,
            taskId: activeTaskId,
            sessionId: latestSessionId ?? null,
            summary:
              mismatchReason ? `${mismatchReason}: ${detailedReason}` : detailedReason
          });

          return blockedResult({
            blockerKind: "review_queue",
            reason: "required authenticated reviews block the active run",
            cycle,
            activeRunId,
            activeTaskId,
            directiveKind: directive.kind,
            nextActions: [],
            detailFiles: {
              reviewQueueStatus: ".archon/work/daemon/review-queue-status.json"
            }
          });
        }

        await writeDaemonReviewQueueStatus(cwd, {
          state: "processed",
          reviewInputDir,
          reason: "queued authenticated review actions were applied",
          expectedReviewTargets,
          consumedFiles: consumedEntries.map((entry) => path.basename(entry.filePath)),
          queuedFiles: queuedReviewEntries.map((entry) => path.basename(entry.filePath)),
          failedFiles: failedReviewEntries.map((entry) => ({
            file: path.basename(entry.filePath),
            error: entry.error
          })),
          staleFiles: staleEntries.map((entry) => ({
            file: path.basename(entry.filePath),
            reason: entry.reason
          })),
          updatedAt: now().toISOString()
        });

        continue;
      }

      if (directive.kind === "blocked" || directive.kind === "apply_recovery") {
        cycles.push({
          cycle,
          directiveKind: directive.kind,
          action: "blocked",
          runId: activeRunId,
          taskId: activeTaskId,
          sessionId: latestSessionId ?? null,
          summary:
            directive.kind === "blocked"
              ? directive.blockers.join(" | ") || "runtime reported no executable next step"
              : "runtime still requires explicit recovery before the daemon can continue"
        });

        return blockedResult({
          blockerKind: directive.kind === "blocked" ? "runtime_blocked" : "recovery_required",
          reason:
            directive.kind === "blocked"
              ? "runtime reported no executable next step"
              : "safe recovery could not clear the active runtime blockers",
          cycle,
          activeRunId,
          activeTaskId,
          directiveKind: directive.kind,
          nextActions: []
        });
      }

      if (directive.kind === "continue_analysis") {
        if (options.executeDirectiveStep) {
          const executionResult = await options.executeDirectiveStep(activeRunId, {
            staleAfterHours,
            reviewCommands: []
          });
          const continueStep = executionResult.steps.find((step) => step.directiveKind === "continue_analysis");

          if (continueStep?.outcome === "executed") {
            cycles.push({
              cycle,
              directiveKind: directive.kind,
              action: "apply_runtime_continuation",
              runId: activeRunId,
              taskId: continueStep.taskId ?? activeTaskId,
              sessionId: latestSessionId ?? null,
              summary: continueStep.evidence.join(" | ") || "runtime continuation executed"
            });
            continue;
          }

          if (continueStep?.outcome === "unsupported") {
            const snapshot = await options.getStatusSnapshot(activeRunId);
            const classification = classifyContinueAnalysisDirective({
              directive,
              state: snapshot.autonomousExecution?.state
            });
            if (classification.executionMode === "operator_required") {
              const handled = await handleOperatorRequiredContinuation({
                directive,
                classification
              });
              if (handled) {
                return handled;
              }
              continue;
            }
          }
        }

        const workflowProofTaskId = resolveDaemonWorkflowProofTaskId(directive);
        if (workflowProofTaskId) {
          try {
            await executeWorkflowProofCommandFromArgs(
              ["--run-id", activeRunId, "--task-id", workflowProofTaskId],
              {
                env,
                getStatusSnapshot: options.getStatusSnapshot,
                getReviews: options.getReviews,
                getApprovals: options.getApprovals
              }
            );

            const closedGapCount = await closeWorkflowProofCoverageGaps(activeRunId, workflowProofTaskId, {
              getStatusSnapshot: options.getStatusSnapshot,
              upsertCoverageGaps: options.upsertCoverageGaps
            });

            cycles.push({
              cycle,
              directiveKind: directive.kind,
              action: "run_workflow_proof",
              runId: activeRunId,
              taskId: workflowProofTaskId,
              sessionId: latestSessionId ?? null,
              summary:
                closedGapCount > 0
                  ? `workflow proof passed for ${workflowProofTaskId}; closed ${closedGapCount} autonomous gap(s)`
                  : `workflow proof passed for ${workflowProofTaskId}`
            });
            continue;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            cycles.push({
              cycle,
              directiveKind: directive.kind,
              action: "blocked",
              runId: activeRunId,
              taskId: workflowProofTaskId,
              sessionId: latestSessionId ?? null,
              summary: message
            });

            return blockedResult({
              blockerKind: "workflow_proof_failure",
              reason: message,
              cycle,
              activeRunId,
              activeTaskId,
              directiveKind: directive.kind,
              nextActions: []
            });
          }
        }
      }

      if (directive.kind === "continue_analysis") {
        const snapshot = await options.getStatusSnapshot(activeRunId);
        const classification = classifyContinueAnalysisDirective({
          directive,
          state: snapshot.autonomousExecution?.state
        });
        if (classification.executionMode === "operator_required") {
          const handled = await handleOperatorRequiredContinuation({
            directive,
            classification
          });
          if (handled) {
            return handled;
          }
          continue;
        }
      }

      if (directive.kind === "dispatch_owner" && directive.recommendation.taskId !== activeTaskId) {
        const reconciled = await attemptRuntimeReconcile(cycle);
        if (reconciled?.runtimeStateChanged) {
          continue;
        }
        cycles.push({
          cycle,
          directiveKind: directive.kind,
          action: "blocked",
          runId: activeRunId,
          taskId: activeTaskId,
          sessionId: latestSessionId ?? null,
          summary: `runtime wants ${directive.recommendation.taskId} but active task is ${activeTaskId}`
        });

        return blockedResult({
          blockerKind: "active_task_mismatch",
          reason: "runtime active-task pointer does not match the owner dispatch target",
          cycle,
          activeRunId,
          activeTaskId,
          directiveKind: directive.kind,
          nextActions: [
            "inspect `npm run archon:status -- --format json` to compare the active runtime task and owner dispatch target",
            "run `npm run archon:reconcile` to align the active runtime task with the authoritative owner-dispatch target"
          ]
        });
      }

      const codexResult = await runDaemonCodexTurn({
        directive,
        summaryAction: directive.kind === "dispatch_owner" ? "run_codex_owner" : "run_codex_analysis",
        activeRunId,
        activeTaskId
      });
      if (codexResult) {
        return codexResult;
      }
    }

    const projectContext = await options.getProjectContext({
      workspaceSlug,
      projectSlug
    });
    const runtimeState = projectContext
      ? await options.getProjectRuntimeState(projectContext.project.id)
      : undefined;

    return {
      authorityLabel: "derived_only" as const,
      workspaceSlug,
      projectSlug,
      status: "max_cycles_reached" as const,
      reason: `daemon stopped after reaching the configured cycle budget (${maxCycles})`,
      activeRunId: runtimeState?.activeRunId ?? null,
      activeTaskId: runtimeState?.activeTaskId ?? null,
      sessionId: latestSessionId ?? null,
      cycles
    };
  });

  return {
    format,
    result
  };
}

export async function executeSupervisorCommandFromArgs(
  args: readonly string[],
  options: ExecuteSupervisorCommandOptions
): Promise<{ format: "json" | "text"; result: SupervisorCommandResult }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const format = resolveFormatFlag(args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;
  const maxSupervisorCyclesValue = resolveCommandFlag(args, "--max-supervisor-cycles") ?? "4";
  const maxSupervisorCycles = Number.parseInt(maxSupervisorCyclesValue, 10);
  const operatorActionDir = resolveDaemonOperatorActionDir(args, { cwd, env });
  const reviewActorBindings = parseSupervisorReviewActorBindings(args, env);
  const operatorNotesOverride =
    resolveCommandFlag(args, "--operator-notes") ?? env.ARCHON_SUPERVISOR_OPERATOR_NOTES;
  const historyRetentionLimit = resolveSupervisorHistoryRetentionLimit(args, env);
  const now = options.now ?? (() => new Date());

  if (!workspaceSlug || !projectSlug) {
    throw new Error("supervisor requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }
  if (!Number.isInteger(maxSupervisorCycles) || maxSupervisorCycles <= 0) {
    throw new Error(`Invalid --max-supervisor-cycles value: ${maxSupervisorCyclesValue}`);
  }

  const daemonRuns: DaemonCommandResult[] = [];
  const actions: SupervisorActionRecord[] = [];
  const finalize = async (input: {
    status: SupervisorCommandResult["status"];
    reason: string;
    activeRunId: string | null;
    activeTaskId: string | null;
    sessionId: string | null;
    blockerKind?:
      | "missing_review_actor_bindings"
      | "handoff_missing"
      | "unsupported_handoff"
      | "continuation_derivation_failed"
      | "review_derivation_failed"
      | undefined;
    nextActions?: string[] | undefined;
    missingReviewRoles?: string[] | undefined;
  }): Promise<{ format: "json" | "text"; result: SupervisorCommandResult }> => {
    const result: SupervisorCommandResult = {
      authorityLabel: "derived_only",
      workspaceSlug,
      projectSlug,
      status: input.status,
      reason: input.reason,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      sessionId: input.sessionId,
      daemonRuns,
      actions
    };
    await writeDaemonSupervisorStatus(cwd, {
      state: input.status,
      blockerKind: input.blockerKind,
      reason: input.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      sessionId: input.sessionId,
      supervisorCycles: daemonRuns.length,
      nextActions: [...(input.nextActions ?? [])],
      missingReviewRoles: [...(input.missingReviewRoles ?? [])],
      actions,
      updatedAt: now().toISOString()
    });
    await appendDaemonSupervisorHistory(cwd, {
      recordedAt: now().toISOString(),
      state: input.status,
      blockerKind: input.blockerKind,
      reason: input.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      sessionId: input.sessionId,
      supervisorCycles: daemonRuns.length,
      nextActions: [...(input.nextActions ?? [])],
      missingReviewRoles: [...(input.missingReviewRoles ?? [])],
      actions
    }, historyRetentionLimit);
    return {
      format,
      result
    };
  };

  for (let cycle = 1; cycle <= maxSupervisorCycles; cycle += 1) {
    const daemonResult = await executeDaemonCommandFromArgs(args, options);
    daemonRuns.push(daemonResult.result);

    if (daemonResult.result.status !== "blocked") {
      return finalize({
        status: daemonResult.result.status,
        reason: daemonResult.result.reason,
        activeRunId: daemonResult.result.activeRunId,
        activeTaskId: daemonResult.result.activeTaskId,
        sessionId: daemonResult.result.sessionId
      });
    }

    const handoff = await readDaemonOperatorHandoff(cwd);
    if (!handoff || handoff.state !== "blocked") {
      return finalize({
        status: "blocked",
        blockerKind: "handoff_missing",
        reason: daemonResult.result.reason,
        activeRunId: daemonResult.result.activeRunId,
        activeTaskId: daemonResult.result.activeTaskId,
        sessionId: daemonResult.result.sessionId
      });
    }

    if (handoff.blockerKind === "review_queue") {
      const reviewQueueStatus = await readDaemonReviewQueueStatus(cwd);
      if (
        !reviewQueueStatus ||
        reviewQueueStatus.state === "invalid" ||
        !reviewQueueStatus.reviewInputDir ||
        !handoff.activeRunId
      ) {
        return finalize({
          status: "blocked",
          blockerKind: "review_derivation_failed",
          reason: "supervisor could not derive trusted review actions from the daemon review-queue handoff",
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId
        });
      }

      const pendingTargets = reviewQueueStatus.expectedReviewTargets
        .map((target) => ({ raw: target, parsed: parseExpectedReviewTarget(target) }))
        .filter(
          (target): target is { raw: string; parsed: { taskId: string; reviewRole: ReviewRecord["reviewerRole"] } } =>
            target.parsed !== undefined
        );
      if (pendingTargets.length === 0) {
        return finalize({
          status: "blocked",
          blockerKind: "review_derivation_failed",
          reason: reviewQueueStatus.reason,
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId
        });
      }

      const missingRoles = pendingTargets
        .map((target) => target.parsed.reviewRole)
        .filter((role, index, array) => array.indexOf(role) === index)
        .filter((role) => !reviewActorBindings[role]);
      if (missingRoles.length > 0) {
        return finalize({
          status: "blocked",
          blockerKind: "missing_review_actor_bindings",
          reason: `supervisor is missing review actor bindings for: ${missingRoles.join(", ")}`,
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
          nextActions: missingRoles.map((role) => `provide --review-actor ${role}=<actor>`),
          missingReviewRoles: missingRoles
        });
      }

      const nowValue = now().toISOString();
      for (const target of pendingTargets) {
        const actor = reviewActorBindings[target.parsed.reviewRole]!;
        const authContext = await resolveSupervisorReviewAuthContext({
          cwd,
          env,
          actor
        });
        const filePath = await writeSupervisorReviewAction({
          cwd,
          reviewInputDir: reviewQueueStatus.reviewInputDir,
          runId: handoff.activeRunId,
          taskId: target.parsed.taskId,
          reviewRole: target.parsed.reviewRole,
          actor,
          authContext,
          cycle,
          nowValue
        });
        actions.push({
          cycle,
          action: "enqueue_review_action",
          taskId: target.parsed.taskId,
          reviewRole: target.parsed.reviewRole,
          filePath,
          summary: `queued trusted ${target.parsed.reviewRole} review action via ${actor}`
        });
      }
      continue;
    }

    if (handoff.blockerKind !== "operator_required_continuation") {
      return finalize({
        status: "blocked",
        blockerKind: "unsupported_handoff",
        reason: handoff.reason,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        nextActions: [...handoff.nextActions]
      });
    }

    const continuationStatus = await readDaemonContinuationStatus(cwd);
    if (
      !continuationStatus ||
      continuationStatus.state !== "blocked" ||
      continuationStatus.executionMode !== "operator_required" ||
      !continuationStatus.targetId ||
      !continuationStatus.source ||
      !handoff.activeRunId ||
      !handoff.activeTaskId
    ) {
      return finalize({
        status: "blocked",
        blockerKind: "continuation_derivation_failed",
        reason: "supervisor could not derive a trusted operator continuation action from the daemon handoff",
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId
      });
    }

    if (
      continuationStatus.provider === "claude_app_thread_automation" ||
      continuationStatus.provider === "claude_app_standalone_automation"
    ) {
      const envelope = await readDaemonAutomationEnvelope(cwd);
      if (
        !envelope ||
        envelope.provider !== continuationStatus.provider ||
        envelope.targetId !== continuationStatus.targetId
      ) {
        return finalize({
          status: "blocked",
          blockerKind: "continuation_derivation_failed",
          reason: "supervisor could not derive the Codex app automation handoff from the daemon envelope",
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId
        });
      }

      const nowValue = now().toISOString();
      const appAutomationRequestPath = await writeDaemonAppAutomationRequest(cwd, {
        envelope: {
          provider: envelope.provider,
          continuationIntent: envelope.continuationIntent,
          targetMode: envelope.targetMode,
          scheduleKind: envelope.scheduleKind,
          schedule: envelope.schedule,
          targetId: envelope.targetId,
          source: envelope.source,
          sourceId: envelope.sourceId,
          summary: envelope.summary,
          nextActions: envelope.nextActions,
          workspaceSlug: envelope.workspaceSlug,
          projectSlug: envelope.projectSlug,
          activeRunId: envelope.activeRunId,
          activeTaskId: envelope.activeTaskId
        },
        updatedAt: nowValue
      });
      await writeDaemonOperatorHandoff(cwd, {
        state: "blocked",
        blockerKind: handoff.blockerKind,
        reason: handoff.reason,
        workspaceSlug: handoff.workspaceSlug ?? workspaceSlug,
        projectSlug: handoff.projectSlug ?? projectSlug,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        cycle,
        directiveKind: handoff.directiveKind,
        nextActions: [`apply the Codex app automation request in ${appAutomationRequestPath}`, ...handoff.nextActions],
        detailFiles: {
          ...handoff.detailFiles,
          appAutomationRequest: appAutomationRequestPath
        },
        updatedAt: nowValue
      });
      const summary =
        envelope.provider === "claude_app_thread_automation"
          ? `materialized Codex app thread automation request for ${continuationStatus.targetId}`
          : `materialized Codex app standalone automation request for ${continuationStatus.targetId}`;
      actions.push({
        cycle,
        action: "materialize_app_automation",
        targetId: continuationStatus.targetId,
        filePath: appAutomationRequestPath,
        summary
      });
      return finalize({
        status: "completed",
        reason: summary,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        nextActions: [`apply the Codex app automation request in ${appAutomationRequestPath}`]
      });
    }

    if (continuationStatus.provider === "claude_cli_exec_scheduler") {
      const envelope = await readDaemonAutomationEnvelope(cwd);
      if (!envelope || envelope.provider !== "claude_cli_exec_scheduler" || envelope.targetId !== continuationStatus.targetId) {
        return finalize({
          status: "blocked",
          blockerKind: "continuation_derivation_failed",
          reason: "supervisor could not derive the CLI scheduler handoff from the daemon envelope",
          activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
          activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
          sessionId: handoff.sessionId ?? daemonResult.result.sessionId
        });
      }

      const nowValue = now().toISOString();
      const schedulerRequest = await writeDaemonCliSchedulerRequest(cwd, {
        envelope: {
          provider: envelope.provider,
          continuationIntent: envelope.continuationIntent,
          targetMode: envelope.targetMode,
          scheduleKind: envelope.scheduleKind,
          schedule: envelope.schedule,
          targetId: envelope.targetId,
          source: envelope.source,
          sourceId: envelope.sourceId,
          summary: envelope.summary,
          nextActions: envelope.nextActions,
          workspaceSlug: envelope.workspaceSlug,
          projectSlug: envelope.projectSlug,
          activeRunId: envelope.activeRunId,
          activeTaskId: envelope.activeTaskId
        },
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        updatedAt: nowValue
      });
      await writeDaemonOperatorHandoff(cwd, {
        state: "blocked",
        blockerKind: handoff.blockerKind,
        reason: handoff.reason,
        workspaceSlug: handoff.workspaceSlug ?? workspaceSlug,
        projectSlug: handoff.projectSlug ?? projectSlug,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        cycle,
        directiveKind: handoff.directiveKind,
        nextActions: [`apply the CLI scheduler request in ${schedulerRequest.requestPath}`, ...handoff.nextActions],
        detailFiles: {
          ...handoff.detailFiles,
          cliSchedulerRequest: schedulerRequest.requestPath
        },
        updatedAt: nowValue
      });
      const summary = schedulerRequest.manualReviewRequired
        ? `materialized CLI scheduler handoff for ${continuationStatus.targetId}; manual review is required before same-thread resume can be scheduled`
        : `materialized CLI scheduler handoff for ${continuationStatus.targetId}`;
      actions.push({
        cycle,
        action: "materialize_cli_scheduler",
        targetId: continuationStatus.targetId,
        filePath: schedulerRequest.requestPath,
        summary
      });
      return finalize({
        status: "completed",
        reason: summary,
        activeRunId: handoff.activeRunId ?? daemonResult.result.activeRunId,
        activeTaskId: handoff.activeTaskId ?? daemonResult.result.activeTaskId,
        sessionId: handoff.sessionId ?? daemonResult.result.sessionId,
        nextActions: [`apply the CLI scheduler request in ${schedulerRequest.requestPath}`]
      });
    }

    const summary = buildSupervisorOperatorNotes({
      targetId: continuationStatus.targetId,
      summary: continuationStatus.summary,
      nextActions: continuationStatus.nextActions,
      override: operatorNotesOverride
    });
    const nowValue = now().toISOString();
    const filePath = await writeSupervisorOperatorContinuationAction({
      cwd,
      operatorActionDir,
      runId: handoff.activeRunId,
      taskId: handoff.activeTaskId,
      targetId: continuationStatus.targetId,
      source: continuationStatus.source,
      sourceId: continuationStatus.sourceId,
      operatorNotes: summary,
      cycle,
      nowValue
    });
    actions.push({
      cycle,
      action: "enqueue_operator_continuation",
      targetId: continuationStatus.targetId,
      filePath,
      summary
    });
  }

  const latestRun = daemonRuns.at(-1);
  return finalize({
    status: "max_cycles_reached",
    reason: `supervisor stopped after reaching the configured cycle budget (${maxSupervisorCycles})`,
    activeRunId: latestRun?.activeRunId ?? null,
    activeTaskId: latestRun?.activeTaskId ?? null,
    sessionId: latestRun?.sessionId ?? null
  });
}

export async function executeSupervisorHistoryCommandFromArgs(
  args: readonly string[],
  options: ExecuteSupervisorHistoryCommandOptions
): Promise<{ format: "json" | "text"; result: SupervisorHistoryCommandResult }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const format = resolveFormatFlag(args);
  const scopeValue =
    resolveCommandFlag(args, "--daemon-supervisor-history-scope") ??
    env.ARCHON_DAEMON_SUPERVISOR_HISTORY_SCOPE ??
    "run";

  if (scopeValue !== "run" && scopeValue !== "all") {
    throw new Error(`Invalid --daemon-supervisor-history-scope value: ${scopeValue}`);
  }

  const resolvedRunId =
    scopeValue === "run"
      ? await resolveRunIdForCommand(args, {
          env,
          findLatestRun: options.findLatestRun
        })
      : undefined;
  const historyOptions = resolveDaemonSupervisorHistoryReadOptions(args, env, resolvedRunId ?? "unknown");
  const historyResult = await readDaemonSupervisorHistory(cwd, historyOptions);
  const latestStatus = await readDaemonSupervisorStatus(cwd, {
    scope: "all",
    limit: 0
  });

  return {
    format,
    result: {
      authorityLabel: "derived_only",
      historyPath: ".archon/work/daemon/supervisor-history.jsonl",
      scope: historyOptions.scope,
      runId: historyOptions.scope === "run" ? historyOptions.runId : undefined,
      retainedCount: historyResult.retainedCount,
      filteredCount: historyResult.filteredCount,
      returnedCount: historyResult.entries.length,
      truncated: historyResult.filteredCount > historyResult.entries.length,
      entries: historyResult.entries,
      latestStatus:
        latestStatus &&
        (historyOptions.scope === "all" || !historyOptions.runId || latestStatus.activeRunId === historyOptions.runId)
          ? {
              state: latestStatus.state,
              blockerKind: latestStatus.blockerKind,
              reason: latestStatus.reason,
              activeRunId: latestStatus.activeRunId,
              activeTaskId: latestStatus.activeTaskId,
              sessionId: latestStatus.sessionId,
              supervisorCycles: latestStatus.supervisorCycles,
              updatedAt: latestStatus.updatedAt
            }
          : undefined
    }
  };
}

export async function executeExportDocsCommandFromArgs(
  args: readonly string[],
  options: ExecuteExportDocsCommandOptions
): Promise<ExportDocsCommandResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("export-docs requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const resolveObsidianConfigImpl = options.resolveObsidianConfig ?? resolveObsidianConfig;
  const validateObsidianConfigImpl = options.validateObsidianConfig ?? validateObsidianConfig;
  const config = resolveObsidianConfigImpl(env, {
    cwd,
    projectSlug
  });
  await validateObsidianConfigImpl(config);

  const rawQuery = collectCommandFreeText(args, {
    valueFlags: ["--workspace-slug", "--project-slug"],
    booleanFlags: ["--overwrite"]
  });
  const request = parseExportDocsRequest(rawQuery, config, {
    now: options.now
  });
  const provider = options.createWorklogProvider({
    workspaceSlug,
    projectSlug
  });
  const entries = await provider.getEntries(request);

  if (entries.length === 0) {
    const dateLabel =
      request.dateFrom && request.dateTo && request.dateFrom === request.dateTo
        ? request.dateFrom
        : request.dateFrom && request.dateTo
          ? `${request.dateFrom} to ${request.dateTo}`
          : "the requested range";
    return {
      request,
      message: `No matching worklog entries found for ${dateLabel}. No note was created.`,
      matchedEntries: 0
    };
  }

  const summary = new DocsSummarizer().summarize(entries, request);
  const markdown = new ObsidianMarkdownRenderer().render(summary, request);
  const writer = new ObsidianVaultWriter(config.vaultPath!);
  const targetPath = await writer.writeNote(markdown, buildObsidianTargetPath(request, summary), args.includes("--overwrite"));
  const vaultIndexPath = await writer.writeVaultIndex(
    request.destination,
    projectSlug,
    request.dateFrom ?? new Date().toISOString().slice(0, 10)
  );

  return {
    request,
    summary,
    targetPath,
    vaultIndexPath,
    message: `Exported Obsidian note:\n${targetPath}\nVault index updated:\n${vaultIndexPath}`,
    matchedEntries: entries.length
  };
}

async function reportCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const result = await executeReportCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      getRoutingReport(runId) {
        return service.recommendRouting(runId);
      },
      inspectRecovery(runId, staleAfterHours) {
        return service.inspectRecovery(runId, { staleAfterHours });
      },
      getHandoffs(runId, taskId) {
        return store.getHandoffs(runId, taskId);
      },
      getReviews(runId, taskId) {
        return store.getReviews(runId, taskId);
      },
      getApprovals(runId, taskId) {
        return store.getApprovals(runId, taskId);
      },
      getLoopHistory(runId, limit) {
        return service.getLoopExecutionHistory(runId, { limit });
      }
    });

    if (result.format === "markdown") {
      process.stdout.write(formatRunEvidenceReportMarkdown(result.report));
      return;
    }

    console.log(JSON.stringify(result.report));
  });
}

async function workflowProofCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const result = await executeWorkflowProofCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      findLatestRunForTask(workspaceSlug, projectSlug, taskId) {
        return store.findLatestRunForTask({ workspaceSlug, projectSlug, taskId });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getReviews(runId, taskId) {
        return store.getReviews(runId, taskId);
      },
      getApprovals(runId, taskId) {
        return store.getApprovals(runId, taskId);
      }
    });

    console.log(JSON.stringify(result));
  });
}

function createWorkflowProofSeedResolver(): ResolveReviewActionContext {
  return createReviewActionContextResolver({
    bindings: {
      bindings: [
        {
          principal: { provider: "archon-local-seed", subject: "reviewer-actor" },
          actors: [{ actor: "reviewer-actor", roles: ["reviewer"] }]
        },
        {
          principal: { provider: "archon-local-seed", subject: "security-actor" },
          actors: [{ actor: "security-actor", roles: ["security_reviewer"] }]
        },
        {
          principal: { provider: "archon-local-seed", subject: "qa-actor" },
          actors: [{ actor: "qa-actor", roles: ["qa_engineer"] }]
        }
      ]
    },
    async resolveAuthenticatedPrincipal(input) {
      return {
        provider: "archon-local-seed",
        subject: input.actor,
        verified: true
      };
    }
  });
}

async function seedWorkflowProofCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store, {
      resolveReviewActionContext: createWorkflowProofSeedResolver()
    });
    const result = await executeSeedWorkflowProofCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      intakeRequest(input) {
        return service.intakeRequest(input);
      },
      createTaskGraph(runId, taskPackets) {
        return service.createTaskGraph(runId, taskPackets);
      },
      claimTask(runId, taskId, actor) {
        return service.claimTask(runId, taskId, actor);
      },
      submitHandoff(runId, taskId, handoff) {
        return service.submitHandoff(runId, taskId, handoff);
      },
      recordReview(runId, taskId, actor, review) {
        return service.recordReview(runId, taskId, actor, review);
      },
      failTask(runId, taskId, reason) {
        return service.failTask(runId, taskId, reason);
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getReviews(runId, taskId) {
        return store.getReviews(runId, taskId);
      },
      getApprovals(runId, taskId) {
        return store.getApprovals(runId, taskId);
      }
    });

    console.log(JSON.stringify(result));
  });
}

async function seedModernizationProofCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store, {
      resolveReviewActionContext: createWorkflowProofSeedResolver()
    });
    const result = await executeSeedModernizationProofCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      intakeRequest(input) {
        return service.intakeRequest(input);
      },
      createTaskGraph(runId, taskPackets) {
        return service.createTaskGraph(runId, taskPackets);
      },
      claimTask(runId, taskId, actor) {
        return service.claimTask(runId, taskId, actor);
      },
      submitHandoff(runId, taskId, handoff) {
        return service.submitHandoff(runId, taskId, handoff);
      },
      recordReview(runId, taskId, actor, review) {
        return service.recordReview(runId, taskId, actor, review);
      },
      failTask(runId, taskId, reason) {
        return service.failTask(runId, taskId, reason);
      },
      configureAutonomousExecution(runId, input) {
        return service.configureAutonomousExecution(runId, input);
      },
      upsertCoverageItems(runId, items) {
        return service.upsertCoverageItems(runId, items);
      },
      upsertUnderstandingMaps(runId, maps) {
        return service.upsertUnderstandingMaps(runId, maps);
      },
      upsertRuntimeTraces(runId, traces) {
        return service.upsertRuntimeTraces(runId, traces);
      },
      upsertDuplicateFamilies(runId, records) {
        return service.upsertDuplicateFamilies(runId, records);
      },
      upsertArchitectureDecisions(runId, records) {
        return service.upsertArchitectureDecisions(runId, records);
      },
      upsertMigrationLedgerEntries(runId, records) {
        return service.upsertMigrationLedgerEntries(runId, records);
      },
      upsertParityRequirements(runId, records) {
        return service.upsertParityRequirements(runId, records);
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getReviews(runId, taskId) {
        return store.getReviews(runId, taskId);
      },
      getApprovals(runId, taskId) {
        return store.getApprovals(runId, taskId);
      }
    });

    console.log(JSON.stringify(result));
  });
}

async function advanceActiveTaskCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, result } = await executeAdvanceActiveTaskCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      findLatestRunForTask(workspaceSlug, projectSlug, taskId) {
        return store.findLatestRunForTask({ workspaceSlug, projectSlug, taskId });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getReviews(runId, taskId) {
        return store.getReviews(runId, taskId);
      },
      getApprovals(runId, taskId) {
        return store.getApprovals(runId, taskId);
      }
    });

    if (format === "text") {
      process.stdout.write(`${formatAdvanceActiveTaskCommandResult(result)}\n`);
      return;
    }

    console.log(JSON.stringify(result));
  });
}

async function syncRuntimeExportsCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const { format, result } = await executeSyncRuntimeExportsCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      }
    });

    if (format === "text") {
      process.stdout.write(`${formatSyncRuntimeExportsCommandResult(result)}\n`);
      return;
    }

    console.log(JSON.stringify(result));
  });
}

async function reconcileRuntimeStateCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const service = new ArchonCoreService(store);
    const { format, result } = await executeReconcileRuntimeStateCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      applyRecovery(runId, actionIds, staleAfterHours) {
        return service.applyRecovery(runId, actionIds, { staleAfterHours });
      }
    });

    if (format === "text") {
      process.stdout.write(`${formatReconcileRuntimeStateCommandResult(result)}\n`);
      return;
    }

    console.log(JSON.stringify(result));
  });
}

async function daemonCommand(args: readonly string[]) {
  const env = process.env;
  const cwd = process.cwd();
  const format = resolveFormatFlag(args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG ?? "unknown";
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG ?? "unknown";
  try {
    await withClient(async (client) => {
      const store = new PostgresStore(client);
      const service = new ArchonCoreService(store);
      const { format: resolvedFormat, result } = await executeDaemonCommandFromArgs(args, {
        cwd,
        env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        getProjectContext(params) {
          return store.getProjectContext(params);
        },
        getProjectRuntimeRegistration(projectId) {
          return store.getProjectRuntimeRegistration(projectId);
        },
        getProjectRuntimeState(projectId) {
          return store.getProjectRuntimeState(projectId);
        },
        saveProjectRuntimeState(state) {
          return store.saveProjectRuntimeState(state);
        },
        getStatusSnapshot(runId) {
          return service.getStatus(runId);
        },
        getExecutionPlan(runId, staleAfterHours) {
          return service.getExecutionPlan(runId, { staleAfterHours });
        },
        applyRecovery(runId, actionIds, staleAfterHours) {
          return service.applyRecovery(runId, actionIds, { staleAfterHours });
        },
        async executeDirectiveStep(runId, input) {
          const executeReviewRecommendation =
            input.reviewCommands.length > 0
              ? createQueuedLoopReviewExecutor(
                  runId,
                  input.reviewCommands,
                  await createLiveLoopReviewCommandExecutor({
                    cwd,
                    env,
                    recordReview({ command, resolver }) {
                      const reviewService = new ArchonCoreService(store, {
                        resolveReviewActionContext: resolver
                      });
                      return reviewService.recordReview(
                        command.runId,
                        command.taskId,
                        command.actor,
                        command.review
                      );
                    }
                  })
                )
              : undefined;

          return service.executeDirectiveStep(runId, {
            staleAfterHours: input.staleAfterHours,
            ownerActor: input.ownerActor,
            executeContinuationAction: createSupportedContinuationExecutor({
              env,
              getStatusSnapshot(candidateRunId) {
                return service.getStatus(candidateRunId);
              },
              getReviews(candidateRunId, taskId) {
                return store.getReviews(candidateRunId, taskId);
              },
              getApprovals(candidateRunId, taskId) {
                return store.getApprovals(candidateRunId, taskId);
              },
              upsertCoverageGaps(candidateRunId, gaps) {
                return service.upsertCoverageGaps(candidateRunId, gaps);
              },
              recordProgressProof(candidateRunId, proof) {
                return service.recordProgressProof(candidateRunId, proof);
              },
              checkpointRun(candidateRunId, checkpoint, checkpointOptions) {
                return service.checkpointRun(candidateRunId, checkpoint, checkpointOptions);
              }
            }),
            ...(executeReviewRecommendation ? { executeReviewRecommendation } : {})
          });
        },
        upsertCoverageGaps(runId, gaps) {
          return service.upsertCoverageGaps(runId, gaps);
        },
        checkpointRun(runId, checkpoint, checkpointOptions) {
          return service.checkpointRun(runId, checkpoint, checkpointOptions);
        },
        getReviews(runId, taskId) {
          return store.getReviews(runId, taskId);
        },
        getApprovals(runId, taskId) {
          return store.getApprovals(runId, taskId);
        }
      });

      if (resolvedFormat === "text") {
        process.stdout.write(`${formatDaemonCommandResult(result)}\n`);
        return;
      }

      console.log(JSON.stringify(result));
    });
  } catch (error) {
    if (!isRuntimeExecutionPreflightConnectionError(error)) {
      throw error;
    }
    const failure = buildRuntimeExecutionConnectionFailure(error);
    const result: DaemonCommandResult = {
      authorityLabel: "derived_only",
      workspaceSlug,
      projectSlug,
      status: "blocked",
      reason: failure.reason,
      activeRunId: null,
      activeTaskId: null,
      sessionId: null,
      cycles: []
    };
    await writeDaemonOperatorHandoff(cwd, {
      state: "blocked",
      blockerKind: "runtime_preflight",
      reason: failure.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: null,
      activeTaskId: null,
      sessionId: null,
      cycle: 0,
      nextActions: failure.nextActions,
      detailFiles: {},
      updatedAt: new Date().toISOString()
    });
    if (format === "text") {
      process.stdout.write(
        `${formatRuntimeExecutionPreflightFailureResult({
          status: "blocked",
          reason: result.reason,
          workspaceSlug: result.workspaceSlug,
          projectSlug: result.projectSlug,
          activeRunId: result.activeRunId,
          activeTaskId: result.activeTaskId,
          sessionId: result.sessionId
        })}\n`
      );
      return;
    }
    console.log(JSON.stringify(result));
  }
}

async function supervisorCommand(args: readonly string[]) {
  const env = process.env;
  const cwd = process.cwd();
  const format = resolveFormatFlag(args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG ?? "unknown";
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG ?? "unknown";
  try {
    await withClient(async (client) => {
      const store = new PostgresStore(client);
      const service = new ArchonCoreService(store);
      const { format: resolvedFormat, result } = await executeSupervisorCommandFromArgs(args, {
        cwd,
        env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        getProjectContext(params) {
          return store.getProjectContext(params);
        },
        getProjectRuntimeRegistration(projectId) {
          return store.getProjectRuntimeRegistration(projectId);
        },
        getProjectRuntimeState(projectId) {
          return store.getProjectRuntimeState(projectId);
        },
        saveProjectRuntimeState(state) {
          return store.saveProjectRuntimeState(state);
        },
        getStatusSnapshot(runId) {
          return service.getStatus(runId);
        },
        getExecutionPlan(runId, staleAfterHours) {
          return service.getExecutionPlan(runId, { staleAfterHours });
        },
        applyRecovery(runId, actionIds, staleAfterHours) {
          return service.applyRecovery(runId, actionIds, { staleAfterHours });
        },
        async executeDirectiveStep(runId, input) {
          const executeReviewRecommendation =
            input.reviewCommands.length > 0
              ? createQueuedLoopReviewExecutor(
                  runId,
                  input.reviewCommands,
                  await createLiveLoopReviewCommandExecutor({
                    cwd,
                    env,
                    recordReview({ command, resolver }) {
                      const reviewService = new ArchonCoreService(store, {
                        resolveReviewActionContext: resolver
                      });
                      return reviewService.recordReview(
                        command.runId,
                        command.taskId,
                        command.actor,
                        command.review
                      );
                    }
                  })
                )
              : undefined;

          return service.executeDirectiveStep(runId, {
            staleAfterHours: input.staleAfterHours,
            ownerActor: input.ownerActor,
            executeContinuationAction: createSupportedContinuationExecutor({
              env,
              getStatusSnapshot(candidateRunId) {
                return service.getStatus(candidateRunId);
              },
              getReviews(candidateRunId, taskId) {
                return store.getReviews(candidateRunId, taskId);
              },
              getApprovals(candidateRunId, taskId) {
                return store.getApprovals(candidateRunId, taskId);
              },
              upsertCoverageGaps(candidateRunId, gaps) {
                return service.upsertCoverageGaps(candidateRunId, gaps);
              },
              recordProgressProof(candidateRunId, proof) {
                return service.recordProgressProof(candidateRunId, proof);
              },
              checkpointRun(candidateRunId, checkpoint, checkpointOptions) {
                return service.checkpointRun(candidateRunId, checkpoint, checkpointOptions);
              }
            }),
            ...(executeReviewRecommendation ? { executeReviewRecommendation } : {})
          });
        },
        upsertCoverageGaps(runId, gaps) {
          return service.upsertCoverageGaps(runId, gaps);
        },
        checkpointRun(runId, checkpoint, checkpointOptions) {
          return service.checkpointRun(runId, checkpoint, checkpointOptions);
        },
        getReviews(runId, taskId) {
          return store.getReviews(runId, taskId);
        },
        getApprovals(runId, taskId) {
          return store.getApprovals(runId, taskId);
        }
      });

      if (resolvedFormat === "text") {
        process.stdout.write(`${formatSupervisorCommandResult(result)}\n`);
        return;
      }

      console.log(JSON.stringify(result));
    });
  } catch (error) {
    if (!isRuntimeExecutionPreflightConnectionError(error)) {
      throw error;
    }
    const failure = buildRuntimeExecutionConnectionFailure(error);
    const result: SupervisorCommandResult = {
      authorityLabel: "derived_only",
      workspaceSlug,
      projectSlug,
      status: "blocked",
      reason: failure.reason,
      activeRunId: null,
      activeTaskId: null,
      sessionId: null,
      daemonRuns: [],
      actions: []
    };
    await writeDaemonSupervisorStatus(cwd, {
      state: "blocked",
      blockerKind: "runtime_preflight",
      reason: failure.reason,
      workspaceSlug,
      projectSlug,
      activeRunId: null,
      activeTaskId: null,
      sessionId: null,
      supervisorCycles: 0,
      nextActions: failure.nextActions,
      missingReviewRoles: [],
      actions: [],
      updatedAt: new Date().toISOString()
    });
    if (format === "text") {
      process.stdout.write(`${formatSupervisorCommandResult(result)}\n`);
      return;
    }
    console.log(JSON.stringify(result));
  }
}

async function supervisorHistoryCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const { format, result } = await executeSupervisorHistoryCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      }
    });

    if (format === "text") {
      process.stdout.write(`${formatSupervisorHistoryCommandResult(result)}\n`);
      return;
    }

    console.log(JSON.stringify(result));
  });
}

export async function executePlanContextCommandFromArgs(
  args: readonly string[],
  options: ExecutePlanContextCommandOptions
) {
  const env = options.env ?? process.env;
  const query = resolveCommandFlag(args, "--query");
  if (!query) {
    throw new Error("plan-context requires --query <text>");
  }

  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;
  if (!workspaceSlug || !projectSlug) {
    throw new Error("plan-context requires workspace/project via flags or environment");
  }

  const roleCandidate = resolveCommandFlag(args, "--role") ?? "planner";
  if (!isRetrievalRole(roleCandidate)) {
    throw new Error(`Invalid --role value: ${roleCandidate}`);
  }

  const limitValue = resolveCommandFlag(args, "--limit") ?? "5";
  const limit = Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid --limit value: ${limitValue}`);
  }

  const format = resolveMarkdownFormatFlag(args);
  const includeGlobal = !args.includes("--project-only");
  const cwd = options.cwd ?? process.cwd();
  const repoContext = await resolvePlanningRepoContextState(args, env, options);
  const retrieval = await resolvePlanningRetrievalState(args, env, options);
  const embeddingModel = env.ARCHON_EMBEDDING_MODEL?.trim();
  const queryEmbedding =
    embeddingModel && options.embedQuery
      ? await options.embedQuery({
          model: embeddingModel,
          text: query
        })
      : undefined;
  const [retrievedResults, localWorkflowResults] = await Promise.all([
    options.searchMemory({
      workspaceSlug,
      projectSlug,
      query,
      limit,
      includeGlobal,
      queryEmbedding,
      embeddingModel,
      requesterRole: roleCandidate
    }),
    searchLocalWorkflowArtifacts({
      cwd,
      query,
      projectSlug,
      requesterRole: roleCandidate,
      limit
    })
  ]);
  const results = annotateConflictSignals(
    dedupePlanningContextResults([...retrievedResults, ...localWorkflowResults])
      .sort(compareMemorySearchResults)
      .slice(0, limit)
  );

  return {
    format,
    report: buildPlanningContextReport({
      query,
      requesterRole: roleCandidate,
      repoContext,
      retrieval,
      results
    })
  };
}

function dedupePlanningContextResults(results: readonly SearchMemoryResult[]): SearchMemoryResult[] {
  const unique = new Map<string, SearchMemoryResult>();
  for (const result of results) {
    const key = result.citation.canonicalRef.trim().length > 0 ? result.citation.canonicalRef : result.id;
    if (!unique.has(key)) {
      unique.set(key, result);
    }
  }

  return [...unique.values()];
}

async function planContextCommand(args: readonly string[]) {
  const embedQuery = await createPlanContextEmbedQuery(process.env);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? process.env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? process.env.ARCHON_PROJECT_SLUG;
  const refreshArgs = buildPlanContextRefreshArgs(args);

  await withClient(async (client) => {
    const store = createRuntimeStore(client);
    const service = new ArchonCoreService(store);
    const result = await executePlanContextCommandFromArgs(args, {
      env: process.env,
      searchMemory(input) {
        return service.searchMemory(input);
      },
      getRepoContext() {
        return inspectRepoContextFreshness({
          cwd: process.cwd(),
          env: process.env,
          store
        });
      },
      refreshRepoContext() {
        return executeRefreshRepoContextCommandFromArgs(refreshArgs, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...(workspaceSlug ? { ARCHON_WORKSPACE_SLUG: workspaceSlug } : {}),
            ...(projectSlug ? { ARCHON_PROJECT_SLUG: projectSlug } : {})
          },
          argv: ["node", "src/admin.ts", "refresh-repo-context"],
          withClient: async (callback) => callback(client),
          createStore() {
            return store;
          }
        });
      },
      getRetrievalFreshness() {
        return inspectRetrievalFreshness({
          cwd: process.cwd(),
          env: process.env,
          store
        });
      },
      refreshRetrieval() {
        return executeRefreshRetrievalCommand({
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...(workspaceSlug ? { ARCHON_WORKSPACE_SLUG: workspaceSlug } : {}),
            ...(projectSlug ? { ARCHON_PROJECT_SLUG: projectSlug } : {})
          },
          argv: ["node", "src/admin.ts", "refresh-retrieval"],
          withClient: async (callback) => callback(client),
          createStore() {
            return store;
          }
        });
      },
      embedQuery
    });

    if (result.format === "markdown") {
      process.stdout.write(formatPlanningContextReportMarkdown(result.report));
      return;
    }

    console.log(JSON.stringify(result.report));
  });
}

async function exportDocsCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const result = await executeExportDocsCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      createWorklogProvider({ workspaceSlug, projectSlug }) {
        return new RuntimeWorklogProvider(createRuntimeStore(client), {
          workspaceSlug,
          projectSlug
        });
      }
    });

    process.stdout.write(`${result.message}\n`);
  });
}

export async function executeGithubDispatchCommandFromArgs(args: readonly string[]) {
  const inputArg = resolveCommandFlag(args, "--input");
  if (!inputArg) {
    throw new Error("github-dispatch requires --input <github-event.json>");
  }
  const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(process.cwd(), inputArg);
  const taskId = resolveCommandFlag(args, "--task-id");
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? process.env.ARCHON_WORKSPACE_SLUG ?? "default";
  const workspaceName = resolveCommandFlag(args, "--workspace-name") ?? process.env.ARCHON_WORKSPACE_NAME;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? process.env.ARCHON_PROJECT_SLUG;
  const projectName = resolveCommandFlag(args, "--project-name") ?? process.env.ARCHON_PROJECT_NAME;

  if (!projectSlug) {
    throw new Error("github-dispatch requires ARCHON_PROJECT_SLUG or --project-slug");
  }

  return withClient(async (client) =>
    dispatchGithubWorkItem({
      store: createRuntimeStore(client),
      workspaceSlug,
      workspaceName,
      projectSlug,
      projectName,
      inputPath,
      taskId,
      dryRun: args.includes("--dry-run")
    })
  );
}

async function githubDispatchCommand(args: readonly string[]) {
  console.log(JSON.stringify(await executeGithubDispatchCommandFromArgs(args)));
}

async function runEmbeddingJobsCommand() {
  const provider = await createEmbeddingProvider();
  const limit = resolveEmbeddingJobLimit(process.env, process.argv[3]);

  await withClient(async (client) => {
    const result = await runEmbeddingJobs({
      store: createRuntimeStore(client),
      provider,
      limit
    });
    console.log(JSON.stringify(result));
  });
}

export async function executeIndexRepoMarkdownCommand(options: ExecuteIndexRepoMarkdownCommandOptions = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const args = argv.slice(3);
  const withClientImpl = options.withClient ?? withClient;
  const createStoreImpl = options.createStore ?? ((client: PostgresStoreClient) => createRuntimeStore(client));
  const indexRepoMarkdownImpl = options.indexRepoMarkdown ?? indexRepoMarkdown;

  const targetRepoRoot = resolveRepoMarkdownTargetRoot(env, args);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG ?? "default";
  const workspaceName =
    resolveCommandFlag(args, "--workspace-name") ?? env.ARCHON_WORKSPACE_NAME ?? "Default Workspace";
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;
  const projectName = resolveCommandFlag(args, "--project-name") ?? env.ARCHON_PROJECT_NAME;
  const include = resolveRepoMarkdownInclude(env);
  const embeddingModel = resolveCommandFlag(args, "--embedding-model") ?? env.ARCHON_EMBEDDING_MODEL;

  if (!projectSlug) {
    throw new Error("ARCHON_PROJECT_SLUG is required");
  }

  return withClientImpl(async (client) =>
    indexRepoMarkdownImpl({
      store: createStoreImpl(client),
      repoRoot: targetRepoRoot,
      workspaceSlug,
      workspaceName,
      projectSlug,
      projectName,
      include,
      embeddingModel
    })
  );
}

async function indexRepoMarkdownCommand() {
  console.log(JSON.stringify(await executeIndexRepoMarkdownCommand()));
}

export async function inspectRetrievalFreshness(input: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  store: RetrievalFreshnessStore;
  captureSnapshot?: typeof captureRepoMarkdownSnapshot | undefined;
}): Promise<PlanningContextRetrievalState> {
  const env = input.env ?? process.env;
  const workspaceSlug = env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = env.ARCHON_PROJECT_SLUG;
  if (!workspaceSlug || !projectSlug) {
    return {
      authorityLabel: "derived_only",
      state: "degraded",
      summary: "workspace/project context is missing for retrieval freshness"
    };
  }

  const context = await input.store.getProjectContext({ workspaceSlug, projectSlug });
  if (!context) {
    return {
      authorityLabel: "derived_only",
      state: "degraded",
      summary: `project ${workspaceSlug}/${projectSlug} is not bootstrapped for retrieval freshness`
    };
  }

  const registration = await input.store.getProjectRuntimeRegistration(context.project.id);
  if (!registration) {
    return {
      authorityLabel: "derived_only",
      state: "missing",
      summary: "runtime registration is missing retrieval metadata"
    };
  }

  const manifest = readRetrievalIndexManifest(registration);
  if (!manifest) {
    return {
      authorityLabel: "derived_only",
      state: "missing",
      summary: "retrieval index has not been bootstrapped yet"
    };
  }

  const include = resolveRepoMarkdownInclude(env);
  const captureSnapshotImpl = input.captureSnapshot ?? captureRepoMarkdownSnapshot;
  const repoPath = path.resolve(registration.repoPath || input.cwd || process.cwd());

  try {
    const snapshot = await captureSnapshotImpl({
      repoRoot: repoPath,
      include
    });
    const embeddingModel = env.ARCHON_EMBEDDING_MODEL?.trim() || undefined;

    if (!sameStringArray(manifest.include ?? [], snapshot.include)) {
      return {
        authorityLabel: "derived_only",
        state: "stale",
        summary: "repo retrieval index does not match the current repo snapshot"
      };
    }

    if ((manifest.fingerprint ?? "") !== snapshot.fingerprint) {
      return {
        authorityLabel: "derived_only",
        state: "stale",
        summary: "repo retrieval index does not match the current repo snapshot"
      };
    }

    if ((manifest.embeddingModel ?? undefined) !== embeddingModel) {
      return {
        authorityLabel: "derived_only",
        state: "stale",
        summary: "repo retrieval embeddings no longer match the configured embedding model"
      };
    }

    const manifestStatus = manifest.status ?? "missing";
    if (embeddingModel && manifestStatus === "artifacts_only_pending_embeddings") {
      return {
        authorityLabel: "derived_only",
        state: "degraded",
        summary: "repo retrieval index matches the current repo snapshot, but embeddings are still pending"
      };
    }

    if (embeddingModel && manifestStatus !== "ready") {
      return {
        authorityLabel: "derived_only",
        state: "degraded",
        summary: `repo retrieval index is ${manifestStatus}`
      };
    }

    if (!embeddingModel && !["ready", "artifacts_only"].includes(manifestStatus)) {
      return {
        authorityLabel: "derived_only",
        state: "degraded",
        summary: `repo retrieval index is ${manifestStatus}`
      };
    }

    return {
      authorityLabel: "derived_only",
      state: "fresh",
      summary: "repo retrieval index matches the current repo snapshot"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      authorityLabel: "derived_only",
      state: "degraded",
      summary: `retrieval freshness check failed: ${message}`
    };
  }
}

export async function executeRefreshRetrievalCommand(
  options: ExecuteRefreshRetrievalCommandOptions = {}
): Promise<RefreshRetrievalResult> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const args = argv.slice(3);
  const cwd = options.cwd ?? process.cwd();
  const withClientImpl = options.withClient ?? withClient;
  const createStoreImpl = options.createStore ?? ((client: PostgresStoreClient) => createRuntimeStore(client));
  const captureSnapshotImpl = options.captureSnapshot ?? captureRepoMarkdownSnapshot;
  const indexRepoMarkdownImpl = options.indexRepoMarkdown ?? indexRepoMarkdown;
  const runEmbeddingJobsImpl = options.runEmbeddingJobs ?? runEmbeddingJobs;
  const createEmbeddingProviderImpl = options.createEmbeddingProvider ?? createEmbeddingProvider;
  const now = (options.now ?? (() => new Date()))().toISOString();

  const targetRepoRoot = resolveRepoMarkdownTargetRoot(env, args, cwd);
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG ?? "default";
  const workspaceName =
    resolveCommandFlag(args, "--workspace-name") ?? env.ARCHON_WORKSPACE_NAME ?? "Default Workspace";
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;
  const projectName = resolveCommandFlag(args, "--project-name") ?? env.ARCHON_PROJECT_NAME;
  const include = resolveRepoMarkdownInclude(env);
  const embeddingModel = (resolveCommandFlag(args, "--embedding-model") ?? env.ARCHON_EMBEDDING_MODEL)?.trim()
    || undefined;
  const artifactsOnly = resolveArtifactsOnlyRetrievalRefresh(args, env);

  if (!projectSlug) {
    throw new Error("ARCHON_PROJECT_SLUG is required");
  }

  return withClientImpl(async (client) => {
    const store = createStoreImpl(client);
    const snapshot = await captureSnapshotImpl({
      repoRoot: targetRepoRoot,
      include
    });
    const indexResult = await indexRepoMarkdownImpl({
      store,
      repoRoot: targetRepoRoot,
      workspaceSlug,
      workspaceName,
      projectSlug,
      projectName,
      include,
      embeddingModel
    });

    let embeddingJobs:
      | {
          leased: number;
          completed: number;
          failed: number;
        }
      | undefined;
    if (embeddingModel && !artifactsOnly) {
      const provider = await createEmbeddingProviderImpl(env);
      embeddingJobs = await runEmbeddingJobsImpl({
        store,
        provider,
        limit: Math.max(resolveEmbeddingJobLimit(env), indexResult.jobsQueued || 0)
      });
    }

    const context = await store.getProjectContext({
      workspaceSlug,
      projectSlug
    });
    if (!context) {
      throw new Error(`Project ${workspaceSlug}/${projectSlug} must be bootstrapped before retrieval refresh`);
    }

    const registration = await store.getProjectRuntimeRegistration(context.project.id);
    if (!registration) {
      throw new Error(`Project ${workspaceSlug}/${projectSlug} must be runtime-registered before retrieval refresh`);
    }

    const retrievalStatus = embeddingModel
      ? artifactsOnly
        ? "artifacts_only_pending_embeddings"
        : (embeddingJobs?.failed ?? 0) === 0
          ? "ready"
          : "degraded"
      : "artifacts_only";

    await store.saveProjectRuntimeRegistration({
      ...registration,
      manifest: {
        ...registration.manifest,
        retrievalIndex: {
          status: retrievalStatus,
          repoRoot: targetRepoRoot,
          include: [...snapshot.include],
          fileCount: snapshot.fileCount,
          fingerprint: snapshot.fingerprint,
          embeddingModel,
          indexedAt: now,
          filesIndexed: indexResult.filesIndexed,
          chunksStored: indexResult.chunksStored,
          jobsQueued: indexResult.jobsQueued,
          embeddingLeased: embeddingJobs?.leased,
          embeddingCompleted: embeddingJobs?.completed,
          embeddingFailed: embeddingJobs?.failed,
          embeddedAt: embeddingJobs ? now : undefined
        }
      },
      updatedAt: now
    });

    return {
      authorityLabel: "runtime_authoritative",
      workspaceSlug,
      projectSlug,
      repoRoot: targetRepoRoot,
      mode: artifactsOnly ? "artifacts_only" : "full",
      filesIndexed: indexResult.filesIndexed,
      chunksStored: indexResult.chunksStored,
      jobsQueued: indexResult.jobsQueued,
      embeddingJobs
    };
  });
}

async function refreshRetrievalCommand() {
  console.log(JSON.stringify(await executeRefreshRetrievalCommand()));
}

export async function executeRefreshRepoContextCommandFromArgs(
  argsOrOptions: readonly string[] | ExecuteRefreshRepoContextCommandOptions = [],
  maybeOptions: ExecuteRefreshRepoContextCommandOptions = {}
): Promise<RefreshRepoContextResult> {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  const resolvedOptions = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as ExecuteRefreshRepoContextCommandOptions;
  const env = resolvedOptions.env ?? process.env;
  const argv = resolvedOptions.argv ?? process.argv;
  const cwd = resolvedOptions.cwd ?? process.cwd();
  const effectiveArgs = Array.isArray(argsOrOptions)
    ? args.length > 0
      ? args
      : argv.slice(3)
    : [];
  const withClientImpl = resolvedOptions.withClient ?? withClient;
  const createStoreImpl =
    resolvedOptions.createStore ?? ((client: PostgresStoreClient) => createRuntimeStore(client));
  const now = (resolvedOptions.now ?? (() => new Date()))().toISOString();
  const targetRepoRoot = resolveRepoMarkdownTargetRoot(env, effectiveArgs, cwd);
  const workspaceSlug = resolveCommandFlag(effectiveArgs, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG ?? "default";
  const projectSlug = resolveCommandFlag(effectiveArgs, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!projectSlug) {
    throw new Error("ARCHON_PROJECT_SLUG is required");
  }

  return withClientImpl(async (client: PostgresStoreClient) => {
    const store = createStoreImpl(client);
    const context = await store.getProjectContext({
      workspaceSlug,
      projectSlug
    });
    if (!context) {
      throw new Error(`Project ${workspaceSlug}/${projectSlug} must be bootstrapped before repo context refresh`);
    }

    const registration = await store.getProjectRuntimeRegistration(context.project.id);
    if (!registration) {
      throw new Error(`Project ${workspaceSlug}/${projectSlug} must be runtime-registered before repo context refresh`);
    }

    const profile = await probeRepoContextProfile({
      repoRoot: targetRepoRoot,
      now
    });

    await store.saveProjectRuntimeRegistration({
      ...registration,
      manifest: {
        ...registration.manifest,
        repoContextProfile: profile
      },
      updatedAt: now
    });

    return {
      authorityLabel: "runtime_authoritative",
      workspaceSlug,
      projectSlug,
      repoRoot: targetRepoRoot,
      slotCount: Object.keys(profile.slots).length,
      status: profile.status,
      fingerprint: profile.fingerprint
    };
  });
}

async function refreshRepoContextCommand(args: readonly string[]) {
  console.log(JSON.stringify(await executeRefreshRepoContextCommandFromArgs(args)));
}

export async function executeRepairTaskQueueCommandFromArgs(
  args: readonly string[],
  options: ExecuteRepairTaskQueueCommandOptions = {}
): Promise<RepairTaskQueueResult> {
  const cwd = options.cwd ?? process.cwd();
  const queuePathArg = resolveCommandFlag(args, "--queue-path");
  const queuePath = queuePathArg ? path.resolve(cwd, queuePathArg) : path.join(cwd, ".archon", "work", "task-queue.json");
  const existing = await readFile(queuePath, "utf8");
  const repaired = repairTaskQueueContent(existing);

  if (repaired.changed) {
    await writeFile(queuePath, repaired.content, "utf8");
  }

  return {
    authorityLabel: "derived_only",
    queuePath,
    changed: repaired.changed,
    repairedTasks: repaired.repairedTasks
  };
}

async function repairTaskQueueCommand(args: readonly string[]) {
  console.log(JSON.stringify(await executeRepairTaskQueueCommandFromArgs(args)));
}

async function main() {
  await loadDotEnv();
  const command = process.argv[2];
  const args = process.argv.slice(3);

  if (command === "migrate") {
    await migrate();
    return;
  }

  if (command === "health") {
    await health();
    return;
  }

  if (command === "bootstrap-project") {
    await bootstrapProject();
    return;
  }

  if (command === "verify-setup") {
    await verifySetup();
    return;
  }

  if (command === "verify-live-migrations") {
    await verifyLiveMigrations();
    return;
  }

  if (command === "run-embedding-jobs") {
    await runEmbeddingJobsCommand();
    return;
  }

  if (command === "refresh-retrieval") {
    await refreshRetrievalCommand();
    return;
  }

  if (command === "refresh-repo-context") {
    await refreshRepoContextCommand(args);
    return;
  }

  if (command === "repair-task-queue") {
    await repairTaskQueueCommand(args);
    return;
  }

  if (command === "verify-review-identity") {
    await verifyReviewIdentityCommand();
    return;
  }

  if (command === "record-review") {
    await recordReviewCommand(args);
    return;
  }

  if (command === "status") {
    await statusCommand(args);
    return;
  }

  if (command === "coverage") {
    await coverageCommand(args);
    return;
  }

  if (command === "gaps") {
    await gapsCommand(args);
    return;
  }

  if (command === "checkpoint") {
    await checkpointCommand(args);
    return;
  }

  if (command === "resume") {
    await resumeCommand(args);
    return;
  }

  if (command === "doctor") {
    await doctorCommand(args);
    return;
  }

  if (command === "ops") {
    await opsCommand(args);
    return;
  }

  if (command === "loop") {
    await loopCommand(args);
    return;
  }

  if (command === "recover") {
    await recoverCommand(args);
    return;
  }

  if (command === "report") {
    await reportCommand(args);
    return;
  }

  if (command === "workflow-proof") {
    await workflowProofCommand(args);
    return;
  }

  if (command === "seed-workflow-proof") {
    await seedWorkflowProofCommand(args);
    return;
  }

  if (command === "seed-modernization-proof") {
    await seedModernizationProofCommand(args);
    return;
  }

  if (command === "advance-active-task") {
    await advanceActiveTaskCommand(args);
    return;
  }

  if (command === "reconcile-runtime-state") {
    await reconcileRuntimeStateCommand(args);
    return;
  }

  if (command === "sync-runtime-exports") {
    await syncRuntimeExportsCommand(args);
    return;
  }

  if (command === "daemon") {
    await daemonCommand(args);
    return;
  }

  if (command === "supervisor") {
    await supervisorCommand(args);
    return;
  }

  if (command === "supervisor-history") {
    await supervisorHistoryCommand(args);
    return;
  }

  if (command === "plan-context") {
    await planContextCommand(args);
    return;
  }

  if (command === "export-docs" || command === "/export-docs") {
    await exportDocsCommand(args);
    return;
  }

  if (command === "github-dispatch") {
    await githubDispatchCommand(args);
    return;
  }

  if (command === "index-repo-markdown") {
    await indexRepoMarkdownCommand();
    return;
  }

  throw new Error(`Unknown command: ${command ?? "<none>"}`);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
