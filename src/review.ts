// Review gate, review identity, record-review, workflow proof, approvals.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
  effectiveRequiredReviewsForTask,
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
import { AgentRuntimeStore } from "./store/agent-runtime-store.ts";
import type { ArchonStore as ArchonStoreContract } from "./store/types.ts";
import { alignQueueToActiveTask, buildDefaultProductState, maybeContinueWorkflowAfterProof, pathExists, repoRoot, resolveCommandFlag, resolveRunIdForCommand, syncRuntimeWorkflowExports } from "./workflow.ts";
import type { EnvShape } from "./workflow.ts";
import { clearSeedFailureMetadata, readSeedFailureMetadata } from "./runtime.ts";


export interface LoadedReviewIdentityAdapter {
  adapter: ReviewPrincipalAdapter<unknown>;
  modulePath?: string | undefined;
  selectedBackend?: string | undefined;
  availableBackends: string[];
}


export function createReviewIdentityFixtureAdapter(): ReviewPrincipalAdapter<unknown> {
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


export async function loadConfiguredReviewIdentityAdapter(options: {
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


export async function inspectReviewIdentityAdapterBackends(modulePath: string): Promise<string[]> {
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


export async function createLiveReviewIdentityAdapter(options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): Promise<LoadedReviewIdentityAdapter> {
  return loadConfiguredReviewIdentityAdapter({
    cwd: options.cwd,
    env: options.env,
    requireLiveAdapter: true
  });
}


export async function resolveReviewIdentityFilePath(options: {
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


export function isRepoTemplateReviewIdentityPath(filePath: string): boolean {
  const relative = path.relative(repoRoot, filePath);
  return (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    (relative === ".archon/templates/review-identity-bindings.json" ||
      relative === ".archon/templates/review-identity-adapter.fixture.json")
  );
}


export async function verifyReviewIdentityCommand() {
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


export function resolveAdapterModulePath(cwd: string, modulePath: string | undefined): string | undefined {
  if (!modulePath) {
    return undefined;
  }

  return path.isAbsolute(modulePath) ? modulePath : path.resolve(cwd, modulePath);
}


export interface RecordReviewCommandInput {
  runId: string;
  taskId: string;
  actor: string;
  review: ReviewInput;
  authContext?: unknown;
}


export interface RecordReviewCommandResult {
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


export interface ExecuteRecordReviewCommandOptions {
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


export interface ExecuteRecordReviewCommandFromArgsOptions {
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


export interface ExecuteWorkflowProofCommandOptions {
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
  /** AC11: check whether a threshold-crossing invocation committed a handoff. Optional — only fires when provided. */
  getAgentHandoffCheck?: ((taskId: string) => Promise<{
    hasInvocations: boolean;
    hasContextThreshold: boolean;
    hasHandoff: boolean;
  }>) | undefined;
  /**
   * SDD §18.3 review independence. Returns the task's implementing-role surface so
   * workflow-proof can reject a task whose implementing role also satisfied a
   * required review gate, or whose reviewer ran as a subagent of the implementer.
   * Optional — only fires when provided.
   */
  getReviewIndependenceCheck?: ((taskId: string) => Promise<{
    hasInvocations: boolean;
    implementerRoles: string[];
    subagentReviewerRoles: string[];
  }>) | undefined;
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


export interface ExecuteSeedWorkflowProofCommandOptions extends ExecuteWorkflowProofCommandOptions {
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


export function normalizeRecordReviewCommandInput(raw: string): RecordReviewCommandInput {
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


export async function readRecordReviewCommandInput(
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


export async function resolveRequiredReviewIdentityFilePath(options: {
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


export function bindingValueContainsPlaceholder(value: string): boolean {
  return /replace-with-/i.test(value);
}


export async function bindingsUsePlaceholderContent(bindingsPath: string): Promise<boolean> {
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


export async function closeWorkflowProofCoverageGaps(
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


export async function recordReviewCommand(args: readonly string[]) {
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

  const requiredReviews = effectiveRequiredReviewsForTask(task);
  const latestReviews = requiredReviews
    .map((role) => reviews.filter((review) => review.reviewerRole === role).at(-1))
    .filter((review): review is ReviewRecord => review !== undefined);

  if (latestReviews.length !== requiredReviews.length) {
    throw new Error(`Task ${taskId} is missing one or more required runtime reviews`);
  }

  if (options.integrityCheckMode !== "allow_seed_failure_recovery") {
    const untrustedReviews = latestReviews.filter((review) => review.source !== "orchestrator");
    if (untrustedReviews.length > 0) {
      const details = untrustedReviews.map((review) => `reviewer=${review.source}`).join(", ");
      throw new Error(`Task ${taskId} required review provenance is not orchestrator-written: ${details}`);
    }
  }

  enforcePlaywrightWorkflowProof(task.packet, latestReviews);

  const latestApproval = (await options.getApprovals(runId, taskId)).at(-1);
  if (!latestApproval) {
    throw new Error(`Task ${taskId} is missing a runtime approval record`);
  }
  const allowSeededApproval = options.integrityCheckMode === "allow_seed_failure_recovery";
  const approvalProvenanceOk =
    latestApproval.source === "orchestrator" ||
    (allowSeededApproval && latestApproval.source === "seed");
  if (!approvalProvenanceOk || latestApproval.decision !== "approved") {
    throw new Error(
      `Task ${taskId} latest runtime approval must be orchestrator-written approved, found ${latestApproval.source} ${latestApproval.decision}`
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

  // AC11: if a managed invocation crossed the 70% context threshold, a handoff
  // must have been committed before workflow-proof can pass.
  if (options.getAgentHandoffCheck) {
    const handoffCheck = await options.getAgentHandoffCheck(taskId);
    if (handoffCheck.hasInvocations && handoffCheck.hasContextThreshold && !handoffCheck.hasHandoff) {
      throw new Error(
        `Task ${taskId} workflow-proof blocked (AC11): context threshold was crossed but no handoff was committed. ` +
        `Ensure the agent called archon_handoff_prepare + archon_handoff_commit before stopping.`
      );
    }
  }

  // SDD §18.3: review independence — a role that implemented the task cannot
  // satisfy its own required review gate, and a subagent cannot approve its
  // parent's work. Only fires for managed runs (specialist_owner invocations
  // recorded for the task); otherwise it is a no-op.
  if (options.getReviewIndependenceCheck) {
    const independence = await options.getReviewIndependenceCheck(taskId);
    if (independence.hasInvocations) {
      const implementerRoleSet = new Set(independence.implementerRoles);
      const roleOverlap = latestReviews.filter((review) =>
        implementerRoleSet.has(review.reviewerRole)
      );
      if (roleOverlap.length > 0) {
        const detail = Array.from(new Set(roleOverlap.map((review) => review.reviewerRole))).join(", ");
        throw new Error(
          `Task ${taskId} workflow-proof blocked (SDD §18.3 review independence): ` +
          `the implementing role(s) also satisfied required review gate(s): ${detail}. ` +
          `A role that implemented a task cannot satisfy its own review gate.`
        );
      }

      if (independence.subagentReviewerRoles.length > 0) {
        const detail = Array.from(new Set(independence.subagentReviewerRoles)).join(", ");
        throw new Error(
          `Task ${taskId} workflow-proof blocked (SDD §18.3 review independence): ` +
          `a reviewer invocation [${detail}] descends from the implementing invocation. ` +
          `Subagents cannot approve their parent's work.`
        );
      }
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


export function enforcePlaywrightWorkflowProof(packet: TaskPacketInput, latestReviews: readonly ReviewRecord[]): void {
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


export function buildWorkflowProofSeedTaskPacket(taskId: string): TaskPacketInput {
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
        getApprovals: options.getApprovals,
        // Thread the runtime gate checks through the seed path so it cannot be
        // used to bypass the AC11 handoff gate or the §18.3 independence gate.
        // For a freshly seeded run with no managed invocations these are no-ops.
        getAgentHandoffCheck: options.getAgentHandoffCheck,
        getReviewIndependenceCheck: options.getReviewIndependenceCheck
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


export function parseExpectedReviewTarget(target: string): {
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


export async function workflowProofCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const agentStore = new AgentRuntimeStore(client);
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
      },
      getAgentHandoffCheck(taskId) {
        return agentStore.checkHandoffPresenceForTask(taskId);
      },
      getReviewIndependenceCheck(taskId) {
        return agentStore.checkReviewIndependenceForTask(taskId);
      }
    });

    console.log(JSON.stringify(result));
  });
}


export function createWorkflowProofSeedResolver(): ResolveReviewActionContext {
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


export async function seedWorkflowProofCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const store = new PostgresStore(client);
    const agentStore = new AgentRuntimeStore(client);
    const service = new ArchonCoreService(store, {
      resolveReviewActionContext: createWorkflowProofSeedResolver(),
      reviewSource: "seed"
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
      },
      getAgentHandoffCheck(taskId) {
        return agentStore.checkHandoffPresenceForTask(taskId);
      },
      getReviewIndependenceCheck(taskId) {
        return agentStore.checkReviewIndependenceForTask(taskId);
      }
    });

    console.log(JSON.stringify(result));
  });
}


export async function saveReviewCommand(args: readonly string[]) {
  const taskId = resolveCommandFlag(args, "--task-id");
  const role = resolveCommandFlag(args, "--role");
  const outcome = resolveCommandFlag(args, "--outcome");
  const findings = resolveCommandFlag(args, "--findings") ?? "";
  const source = resolveCommandFlag(args, "--source") ?? "orchestrator";

  if (!taskId) {
    throw new Error("save-review requires --task-id");
  }
  if (!role) {
    throw new Error("save-review requires --role");
  }
  if (!outcome || (outcome !== "passed" && outcome !== "failed")) {
    throw new Error("save-review requires --outcome <passed|failed>");
  }
  if (source !== "orchestrator") {
    throw new Error("save-review only accepts --source orchestrator; self-attestation is not permitted");
  }

  const workspaceSlug = process.env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = process.env.ARCHON_PROJECT_SLUG;
  if (!workspaceSlug || !projectSlug) {
    throw new Error("save-review requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG to be set");
  }

  const workspaceId = `workspace:${workspaceSlug}`;
  const projectId = `project:${workspaceSlug}:${projectSlug}`;

  const runId = await withClient(async (client) => {
    const store = new PostgresStore(client);
    // Resolve the active run so the review is run-scoped (two-authorities fix).
    const state = await store.getProjectRuntimeState(projectId);
    const activeRunId = state?.activeRunId;
    await store.saveOrchestratorReview({
      taskId,
      role,
      outcome,
      findings,
      workspaceId,
      projectId,
      runId: activeRunId
    });
    return activeRunId;
  });

  console.log(JSON.stringify({ saved: true, taskId, role, outcome, source, runId: runId ?? null }));
}

// ─── save-approval ────────────────────────────────────────────────────────────
//
// Writes an orchestrator approval record for a task and transitions its status
// to "approved", provided that all required reviews already exist and pass.
//
// TRUST GATE: only --source orchestrator is accepted. Self-attestation is
// explicitly forbidden and will throw before any DB access.
//
// REVIEW FLOOR: the existing evaluateReviewDecision logic is NOT bypassed.
// If the task's required reviews are missing or blocked, the command throws
// with the list of blockers. The decision gate is identical to the one the
// service layer enforces in recordReview().

type ApprovalStore = Pick<
  ArchonStoreContract,
  "getProjectRuntimeState" | "getTasksByRun" | "getReviews" | "saveApproval" | "updateTask"
>;

export interface SaveApprovalCommandDeps {
  withClientFn?: <T>(fn: (store: ApprovalStore) => Promise<T>) => Promise<T>;
  env?: NodeJS.ProcessEnv;
}

export async function saveApprovalCommand(
  args: readonly string[],
  deps?: SaveApprovalCommandDeps
): Promise<void> {
  const taskId = resolveCommandFlag(args, "--task-id");
  const source = resolveCommandFlag(args, "--source") ?? "orchestrator";
  const actor = resolveCommandFlag(args, "--actor") ?? "orchestrator";
  const rationale = resolveCommandFlag(args, "--rationale") ?? "All required reviews passed";

  if (!taskId) {
    throw new Error("save-approval requires --task-id");
  }

  // TRUST GATE — identical invariant to save-review (review.ts:1407-1409).
  if (source !== "orchestrator") {
    throw new Error(
      "save-approval only accepts --source orchestrator; self-attestation and seed approval are not permitted"
    );
  }

  const env = deps?.env ?? process.env;
  const workspaceSlug = env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = env.ARCHON_PROJECT_SLUG;
  if (!workspaceSlug || !projectSlug) {
    throw new Error("save-approval requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG to be set");
  }

  const projectId = `project:${workspaceSlug}:${projectSlug}`;
  const now = new Date().toISOString();

  const withClientFn: <T>(fn: (store: ApprovalStore) => Promise<T>) => Promise<T> =
    deps?.withClientFn ??
    ((fn) => withClient((client) => fn(new PostgresStore(client) as unknown as ApprovalStore)));

  const result = await withClientFn(async (store) => {
    const state = await store.getProjectRuntimeState(projectId);
    if (!state?.activeRunId) {
      throw new Error(`save-approval: no active run found for project ${projectId}`);
    }
    const runId = state.activeRunId;

    const allTasks = await store.getTasksByRun(runId);
    const task = allTasks.find((candidate) => candidate.packet.taskId === taskId);
    if (!task) {
      throw new Error(`save-approval: task "${taskId}" not found in run ${runId}`);
    }

    const reviews = await store.getReviews(runId, taskId);
    const decision = evaluateReviewDecision(task, reviews);

    if (decision.decision !== "approved") {
      throw new Error(
        `save-approval: task "${taskId}" is not approvable — ${decision.blockers.join("; ")}`
      );
    }

    const approval: ApprovalRecord = {
      id: randomUUID(),
      runId,
      taskId,
      actor,
      actorRole: "manager" as RetrievalRole,
      source: "orchestrator",
      decision: "approved",
      rationale,
      createdAt: now
    };

    await store.saveApproval(approval);

    const updatedTask = {
      ...task,
      status: "approved" as const,
      updatedAt: now
    };
    await store.updateTask(updatedTask);

    return { taskId, runId, decision: "approved", source };
  });

  console.log(JSON.stringify({ saved: true, ...result }));
}
