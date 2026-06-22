// Memory, embeddings, retrieval refresh, repo markdown indexing, plan context.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { embedQueryText, runEmbeddingJobs, type EmbeddingProvider } from "./runtime/embedding-runner.ts";


import { createHashEmbeddingProvider } from "./runtime/hash-embedding-provider.ts";
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
  inspectRepoContextFreshness
} from "./runtime/repo-context-profile.ts";
import { withClient } from "./admin/db.ts";


import {
  buildPlanningContextReport,
  formatPlanningContextReportMarkdown,
  searchLocalWorkflowArtifacts,
  type PlanningContextRepoContextState,
  type PlanningContextRetrievalState
} from "./admin/planning-context.ts";




import {
  isRetrievalRole
} from "./domain/contracts.ts";


import {
  ArchonCoreService
} from "./core/service.ts";
import { compareMemorySearchResults } from "./core/policy.ts";
import { annotateConflictSignals } from "./core/search-memory-results.ts";
import type {
  RuntimeProjectRegistrationRecord,
  RetrievalRole,
  SearchMemoryResult
} from "./domain/types.ts";
import type { ArchonStore as ArchonStoreContract } from "./store/types.ts";
import { appendAutomaticRefreshDeferredSummary, repoRoot, resolveCommandFlag, resolveCommandPositionals, resolveMarkdownFormatFlag, sameStringArray } from "./workflow.ts";
import type { EnvShape } from "./workflow.ts";
import { createRuntimeStore, executeRefreshRepoContextCommandFromArgs, resolveAutoRefreshRepoContextEnabled } from "./runtime.ts";
import type { PostgresStoreClient, RefreshRepoContextResult } from "./runtime.ts";

export type IndexRepoMarkdownStore = Parameters<typeof indexRepoMarkdown>[0]["store"];

export type RetrievalFreshnessStore = Pick<
  ArchonStoreContract,
  "getProjectContext" | "getProjectRuntimeRegistration"
>;

export type RefreshRetrievalStore = IndexRepoMarkdownStore &
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


export async function createEmbeddingProvider(env: EnvShape = process.env): Promise<EmbeddingProvider> {
  const providerModulePath = env.ARCHON_EMBEDDING_PROVIDER_MODULE;
  if (!providerModulePath) {
    if (isAnthropicEmbeddingConfigured(env)) {
      return createAnthropicEmbeddingProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ARCHON_EMBEDDING_MODEL?.trim() || undefined
      });
    }
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


export function resolveRepoMarkdownInclude(env: EnvShape): string[] {
  const includeValue = env.ARCHON_REPO_MARKDOWN_INCLUDE ?? DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS.join(",");
  return includeValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}


export const repoMarkdownCommandFlagsWithValues = new Set([
  "--workspace-slug",
  "--workspace-name",
  "--project-slug",
  "--project-name",
  "--embedding-model"
]);


export const planContextRefreshPassthroughFlagsWithValues = new Set([
  "--workspace-slug",
  "--project-slug"
]);


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


export function resolveRepoMarkdownTargetRoot(
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


export function resolveEmbeddingJobLimit(env: EnvShape, candidate?: string | undefined): number {
  const limitValue = candidate ?? env.ARCHON_EMBEDDING_JOB_LIMIT ?? "10";
  const limit = Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid embedding job limit: ${limitValue}`);
  }
  return limit;
}


export function resolveArtifactsOnlyRetrievalRefresh(args: readonly string[], env: EnvShape): boolean {
  if (args.includes("--artifacts-only")) {
    return true;
  }

  const candidate = env.ARCHON_RETRIEVAL_REFRESH_MODE?.trim().toLowerCase();
  return candidate === "artifacts_only" || candidate === "artifacts-only" || candidate === "fast";
}


export interface RetrievalIndexManifestRecord {
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


export function readRetrievalIndexManifest(
  registration: RuntimeProjectRegistrationRecord
): RetrievalIndexManifestRecord | undefined {
  const candidate = registration.manifest.retrievalIndex;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  return candidate as RetrievalIndexManifestRecord;
}


export interface ExecutePlanContextCommandOptions {
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


export function resolveAutoRefreshRetrievalEnabled(args: readonly string[], env: EnvShape): boolean {
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


export async function resolvePlanningRepoContextState(
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


export async function resolvePlanningRetrievalState(
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


export function dedupePlanningContextResults(results: readonly SearchMemoryResult[]): SearchMemoryResult[] {
  const unique = new Map<string, SearchMemoryResult>();
  for (const result of results) {
    const key = result.citation.canonicalRef.trim().length > 0 ? result.citation.canonicalRef : result.id;
    if (!unique.has(key)) {
      unique.set(key, result);
    }
  }

  return [...unique.values()];
}


export async function planContextCommand(args: readonly string[]) {
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


export async function runEmbeddingJobsCommand() {
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


export async function indexRepoMarkdownCommand() {
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


export async function refreshRetrievalCommand() {
  console.log(JSON.stringify(await executeRefreshRetrievalCommand()));
}
