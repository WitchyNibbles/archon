// Runtime state, migrations, bootstrap/doctor, preflight, repo context, integrity repair.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
import { triggerTaskCloseIngestion } from "./runtime/memory-ingestion-pipeline.ts";
import {
  createAnthropicEmbeddingProvider,
  isAnthropicEmbeddingConfigured
} from "./runtime/anthropic-embedding-provider.ts";
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
import { exportTaskToObsidian } from "./export/obsidian-exporter.ts";
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
  AutonomousExecutionState,
  CheckpointRecord,
  ContinuationAction,
  CoverageGapRecord,
  CoverageItemRecord,
  HandoffInput,
  IntakeRequestInput,
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
  TaskStatus
} from "./domain/types.ts";
import type { WorkspaceRecord } from "./domain/types.ts";
import type { ExportDocsCommandResult } from "./docs-export/models.ts";
import { PostgresStore } from "./store/postgres-store.ts";
import type { ArchonStore as ArchonStoreContract } from "./store/types.ts";
import { INTERNAL_RUNTIME_PREFLIGHT_BYPASS_TOKEN, __dirname, buildAuthoritativeTaskQueueFromSnapshot, buildDefaultProductState, collectCommandFlagValues, executeStatusCommandFromArgs, executeSyncRuntimeExportsCommandFromArgs, hasCommandFlag, hasLocalWorkflowExportDrift, isCompleteProjectStatus, parseTaskQueueRecord, parseTaskQueueRecordOrDefault, readJsonFileIfExists, repoRoot, resolveCommandFlag, resolveFormatFlag, resolveProjectSelector, resolveRunIdForCommand, stripCommandFlag, syncRuntimeWorkflowExports } from "./workflow.ts";
import type { EnvShape, ExecuteStatusCommandOptions, ExecuteSyncRuntimeExportsCommandOptions } from "./workflow.ts";
import { resolveRepoMarkdownTargetRoot } from "./memory.ts";
import { inspectReviewIdentityStatus } from "./review.ts";
import { runSpawnedCommand } from "./daemon.ts";
import type { ExecuteLoopCommandOptions } from "./daemon.ts";

export type PostgresStoreClient = ConstructorParameters<typeof PostgresStore>[0];

export type RefreshRepoContextStore = Pick<
  ArchonStoreContract,
  "getProjectContext" | "getProjectRuntimeRegistration" | "saveProjectRuntimeRegistration"
>;


export async function migrate() {
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


export async function health() {
  await withClient(async (client) => {
    await client.query("select 1");
  });
  console.log("healthy");
}


export async function bootstrapProject() {
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


export async function verifySetup() {
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
           (table_name = 'reviews' and column_name in ('actor', 'actor_role', 'source'))
           or (table_name = 'approvals' and column_name in ('actor', 'actor_role', 'source'))
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
      "reviews.source",
      "approvals.actor",
      "approvals.actor_role",
      "approvals.source"
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


export async function verifyLiveMigrations() {
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

    const driftTarget = path.join(fixtureRoot, "scripts", "check-archon-workflow.ts");
    const driftedContent = `${await readFile(driftTarget, "utf8")}// local drift\n`;
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


export interface ExecuteDoctorCommandOptions extends ExecuteStatusCommandOptions {
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


export interface DoctorCheckObservation {
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


export interface ExecuteDoctorRepairCommandOptions extends ExecuteDoctorCommandOptions {
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


export interface DoctorRepairObservation {
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


export interface DoctorRepairCommandResult {
  ok: boolean;
  executionReady: boolean;
  report?: DoctorCommandReport | undefined;
  repair: DoctorRepairObservation;
}


export interface ExecuteRuntimePreflightCommandOptions {
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


export interface RuntimeExecutionPreflightFailure {
  blockers: string[];
  reason: string;
  activeRunId: string | null;
  nextActions: string[];
}


export function extractRuntimeExecutionErrorMessage(error: unknown): string {
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


export interface ExecuteRecoverCommandOptions extends ExecuteStatusCommandOptions {
  inspectRecovery: (runId: string, staleAfterHours: number) => Promise<RecoveryInspectionReport>;
  applyRecovery: (runId: string, actionIds: readonly string[], staleAfterHours: number) => Promise<RecoveryApplyResult>;
  saveProjectRuntimeState?: ((state: ProjectRuntimeStateRecord) => Promise<void>) | undefined;
}


export interface ExecuteReconcileRuntimeStateCommandOptions extends ExecuteLoopCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  getProjectContext: (params: {
    workspaceSlug: string;
    projectSlug: string;
  }) => Promise<{ workspace: WorkspaceRecord; project: ProjectRecord } | undefined>;
  getProjectRuntimeState: (projectId: string) => Promise<ProjectRuntimeStateRecord | undefined>;
  saveProjectRuntimeState: (state: ProjectRuntimeStateRecord) => Promise<void>;
}


export type RuntimeStateReconcileAction =
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


export interface ExecuteRefreshRepoContextCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  argv?: readonly string[] | undefined;
  withClient?: typeof withClient | undefined;
  createStore?: ((client: PostgresStoreClient) => RefreshRepoContextStore) | undefined;
  now?: (() => Date) | undefined;
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


export function resolveAutoRefreshRepoContextEnabled(args: readonly string[], env: EnvShape): boolean {
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


export function readSeedFailureMetadata(
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


export function readLastIntegrityRepairMetadata(
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


export function clearSeedFailureMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata || !("seedFailure" in metadata)) {
    return metadata ?? {};
  }

  const { seedFailure: _seedFailure, ...rest } = metadata;
  return rest;
}


export function withLastIntegrityRepairMetadata(
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


export async function clearStaleSeedFailureRuntimeMetadata(input: {
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


export async function persistIntegrityRepairRuntimeMetadata(input: {
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


export async function persistRecoverIntegrityRepairMetadata(input: {
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


export async function persistProjectIntegrityRepairMetadata(input: {
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


export async function runtimePathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}


export async function syncRuntimeMigrationJournal(options: {
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


export function buildDoctorExecutionReady(report: DoctorCommandReport): boolean {
  return report.ok && report.checks.reviewIdentity.ok;
}


export function isDoctorBootstrapRepairableError(error: unknown): boolean {
  const message = extractRuntimeExecutionErrorMessage(error);
  return (
    /is not bootstrapped/i.test(message) ||
    /doctor could not resolve project context/i.test(message)
  );
}


export async function runLocalDoctorSetupRepair(cwd: string, env: EnvShape): Promise<void> {
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


export async function runBootstrapAndVerifySetupRepair(): Promise<void> {
  await bootstrapProject();
  await verifySetup();
}


export function resolveDoctorRepairPlan(input: {
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


export function isDoctorSafeRuntimeReconcileAction(action: RuntimeStateReconcileAction): boolean {
  return (
    action === "rebuild_missing_runtime_state" ||
    action === "sync_active_task_to_in_progress" ||
    action === "activate_owner_dispatch_target"
  );
}


export function resolveDoctorRepairReconcileOptions(
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


export function resolveDoctorRepairSyncOptions(
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


export function isIntegrityRepairStepLabel(stepLabel: string): boolean {
  return (
    stepLabel === "sync local workflow exports from runtime state" ||
    stepLabel === "sync local workflow exports from runtime state after persisted seed failure" ||
    stepLabel === "clear stale persisted seed failure metadata after authoritative proof" ||
    stepLabel === "reconcile authoritative runtime task state"
  );
}


export function deriveIntegrityRepairSteps(stepLabels: readonly string[]): string[] {
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


export async function executeRuntimeExecutionPreflight(
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


export async function doctorCommand(args: readonly string[]) {
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


export async function recoverCommand(args: readonly string[]) {
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


export function formatReconcileRuntimeStateCommandResult(result: ReconcileRuntimeStateCommandResult): string {
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


export function buildRuntimeStateFromSnapshot(input: {
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


export function formatRuntimeExecutionPreflightFailureResult(input: {
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


export async function reconcileRuntimeStateCommand(args: readonly string[]) {
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


export async function refreshRepoContextCommand(args: readonly string[]) {
  console.log(JSON.stringify(await executeRefreshRepoContextCommandFromArgs(args)));
}
