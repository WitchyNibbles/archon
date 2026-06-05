import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildRuntimeExecutionConnectionFailure,
  isRuntimeExecutionPreflightConnectionError,
  executeCheckpointCommandFromArgs,
  executeCoverageCommandFromArgs,
  createSupportedContinuationExecutor,
  createLiveLoopReviewCommandExecutor,
  createQueuedLoopReviewExecutor,
  executeGapsCommandFromArgs,
  executeLoopCommandFromArgs,
  createPlanContextEmbedQuery,
  createRuntimeStore,
  executeDoctorCommandFromArgs,
  executeOpsCommandFromArgs,
  executePlanContextCommandFromArgs,
  executeResumeCommandFromArgs,
  executeReportCommandFromArgs,
  executeStatusCommandFromArgs
} from "../admin.ts";
import { ArchonCoreService } from "../core/service.ts";
import type {
  CoverageGapRecord,
  RecoveryInspectionReport,
  RetrievalRole,
  RoutingRecommendationReport,
  RunExecutionPlan,
  RunStatusSnapshot,
  SearchMemoryResult
} from "../domain/types.ts";
import type { DirectiveExecutionResult } from "../core/service.ts";
import { PostgresStore } from "../store/postgres-store.ts";
import { loadDotEnv, withClient } from "./db.ts";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../..");

interface RuntimeSurfaceService {
  getStatus(runId: string): Promise<RunStatusSnapshot>;
  resumeRun?: ((runId: string) => Promise<import("../domain/types.ts").RunResumeSnapshot>) | undefined;
  getExecutionPlan(
    runId: string,
    options?: { staleAfterHours?: number | undefined }
  ): Promise<RunExecutionPlan>;
  checkpointRun?: ((
    runId: string,
    checkpoint: Omit<import("../domain/types.ts").CheckpointRecord, "runId" | "authorityLabel">,
    options?: {
      authorityLabel?: import("../domain/types.ts").CheckpointRecord["authorityLabel"] | undefined;
    }
  ) => Promise<unknown>) | undefined;
  recordProgressProof?: ((
    runId: string,
    proof: import("../domain/types.ts").ProgressProofRecord
  ) => Promise<unknown>) | undefined;
  applyRecovery(
    runId: string,
    actionIds: readonly string[],
    options: { staleAfterHours: number }
  ): Promise<import("../domain/types.ts").RecoveryApplyResult>;
  upsertCoverageGaps?: ((runId: string, gaps: CoverageGapRecord[]) => Promise<unknown>) | undefined;
  executeDirectiveStep?: ((
    runId: string,
    input: import("../core/service.ts").ExecuteDirectiveStepOptions
  ) => Promise<DirectiveExecutionResult>) | undefined;
  recommendRouting(runId: string): Promise<RoutingRecommendationReport>;
  inspectRecovery(runId: string, input: { staleAfterHours: number }): Promise<RecoveryInspectionReport>;
  searchMemory(input: {
    workspaceSlug: string;
    projectSlug: string;
    query: string;
    limit: number;
    includeGlobal: boolean;
    queryEmbedding?: readonly number[] | undefined;
    embeddingModel?: string | undefined;
    requesterRole?: RetrievalRole | undefined;
  }): Promise<readonly SearchMemoryResult[]>;
  getLoopExecutionHistory?: ((
    runId: string,
    options?: {
      limit?: number | undefined;
      requesterRole?: import("../domain/types.ts").TaskPacketInput["requiredSpecialistRoles"][number] | undefined;
    }
  ) => Promise<SearchMemoryResult[]>) | undefined;
}

type RuntimeClient = Parameters<Parameters<typeof withClient>[0]>[0];

export interface RuntimeSurfaceDependencies {
  loadDotEnv?: typeof loadDotEnv;
  withClient?: typeof withClient;
  createStore?: (client: RuntimeClient) => PostgresStore;
  createService?: (store: PostgresStore) => RuntimeSurfaceService;
  createPlanContextEmbedQuery?: typeof createPlanContextEmbedQuery;
  inspectQdrant?: ((
    registration: import("../domain/types.ts").RuntimeProjectRegistrationRecord
  ) => Promise<{ ok: boolean; summary: string }>) | undefined;
  inspectReviewIdentity?: (() => Promise<import("./status.ts").ReviewIdentityStatusObservation>) | undefined;
}

export interface RuntimeSurfaceOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  dependencies?: RuntimeSurfaceDependencies | undefined;
}

function resolveContext(options: RuntimeSurfaceOptions) {
  return {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env
  };
}

async function withRuntime<T>(
  options: RuntimeSurfaceOptions,
  callback: (input: { store: PostgresStore; service: RuntimeSurfaceService; env: NodeJS.ProcessEnv; cwd: string }) => Promise<T>
): Promise<T> {
  const context = resolveContext(options);
  const dependencies = options.dependencies ?? {};
  const loadDotEnvImpl = dependencies.loadDotEnv ?? loadDotEnv;
  const withClientImpl = dependencies.withClient ?? withClient;
  const createStoreImpl = dependencies.createStore ?? ((client: RuntimeClient) => createRuntimeStore(client));
  const createServiceImpl = dependencies.createService ?? ((store: PostgresStore) => new ArchonCoreService(store));

  await loadDotEnvImpl();

  return withClientImpl(async (client) => {
    const store = createStoreImpl(client);
    const service = createServiceImpl(store);
    return callback({
      store,
      service,
      env: context.env,
      cwd: context.cwd
    });
  });
}

export async function getStatusSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  return withRuntime(options, async ({ store, service, env, cwd }) =>
    executeStatusCommandFromArgs(args, {
      cwd,
      env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      }
    })
  );
}

export async function getRuntimeHealthSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  const dependencies = options.dependencies ?? {};
  return withRuntime(options, async ({ store, service, env, cwd }) =>
    executeDoctorCommandFromArgs(args, {
      cwd,
      env,
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
      },
      inspectQdrant: dependencies.inspectQdrant,
      inspectReviewIdentity: dependencies.inspectReviewIdentity
    })
  );
}

export async function getCoverageSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  return withRuntime(options, async ({ store, service, env }) =>
    executeCoverageCommandFromArgs(args, {
      env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      }
    })
  );
}

export async function getGapsSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  return withRuntime(options, async ({ store, service, env }) =>
    executeGapsCommandFromArgs(args, {
      env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      }
    })
  );
}

export async function getCheckpointSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  return withRuntime(options, async ({ store, service, env, cwd }) =>
    executeCheckpointCommandFromArgs(args, {
      cwd,
      env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      checkpointRun(runId, checkpoint, checkpointOptions) {
        if (!service.checkpointRun) {
          throw new Error("runtime surface does not support checkpoint mutation");
        }
        return service.checkpointRun(runId, checkpoint, checkpointOptions);
      }
    })
  );
}

export async function getResumeSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  return withRuntime(options, async ({ store, service, env }) =>
    executeResumeCommandFromArgs(args, {
      env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getResumeSnapshot(runId) {
        if (!service.resumeRun) {
          throw new Error("runtime surface does not support resume snapshots");
        }
        return service.resumeRun(runId);
      }
    })
  );
}

export async function getOpsSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  return withRuntime(options, async ({ store, service, env, cwd }) =>
    executeOpsCommandFromArgs(args, {
      cwd,
      env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
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
    })
  );
}

export async function getLoopSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  const dependencies = options.dependencies ?? {};
  try {
    return await withRuntime(options, async ({ store, service, env, cwd }) =>
      executeLoopCommandFromArgs(args, {
        cwd,
        env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        },
        findProjectContext(workspaceSlug, projectSlug) {
          return store.getProjectContext({ workspaceSlug, projectSlug });
        },
        getProjectRuntimeRegistration(projectId) {
          return store.getProjectRuntimeRegistration(projectId);
        },
        inspectQdrant: dependencies.inspectQdrant,
        inspectReviewIdentity: dependencies.inspectReviewIdentity,
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
          if (!service.executeDirectiveStep) {
            throw new Error("runtime surface does not support directive execution");
          }
          const reviewCommands = input.reviewCommands as readonly {
            runId: string;
            taskId: string;
            actor: string;
            review: import("../domain/types.ts").ReviewInput;
          }[];

          const executeReviewRecommendation =
            reviewCommands.length > 0
              ? createQueuedLoopReviewExecutor(
                  runId,
                  reviewCommands,
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
          const executeContinuationAction = createSupportedContinuationExecutor({
            env,
            getStatusSnapshot(runId) {
              return service.getStatus(runId);
            },
            getReviews(runId, taskId) {
              return store.getReviews(runId, taskId);
            },
            getApprovals(runId, taskId) {
              return store.getApprovals(runId, taskId);
            },
            upsertCoverageGaps: service.upsertCoverageGaps
              ? (runId, gaps) => service.upsertCoverageGaps!(runId, gaps)
              : undefined,
            recordProgressProof: service.recordProgressProof
              ? (runId, proof) => service.recordProgressProof!(runId, proof)
              : undefined,
            checkpointRun: service.checkpointRun
              ? (runId, checkpoint, checkpointOptions) =>
                  service.checkpointRun!(runId, checkpoint, checkpointOptions)
              : undefined
          });

          return service.executeDirectiveStep(runId, {
            staleAfterHours: input.staleAfterHours,
            ownerActor: input.ownerActor,
            ...(executeReviewRecommendation ? { executeReviewRecommendation } : {}),
            executeContinuationAction
          });
        }
      })
    );
  } catch (error) {
    if (isRuntimeExecutionPreflightConnectionError(error)) {
      throw new Error(buildRuntimeExecutionConnectionFailure(error).reason);
    }
    throw error;
  }
}

export async function getReportSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  return withRuntime(options, async ({ store, service, env, cwd }) =>
    executeReportCommandFromArgs(args, {
      cwd,
      env,
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
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
        return service.getLoopExecutionHistory
          ? service.getLoopExecutionHistory(runId, { limit })
          : Promise.resolve([]);
      }
    })
  );
}

export async function getPlanContextSurface(args: readonly string[], options: RuntimeSurfaceOptions = {}) {
  const createPlanContextEmbedQueryImpl =
    options.dependencies?.createPlanContextEmbedQuery ?? createPlanContextEmbedQuery;

  return withRuntime(options, async ({ service, env }) => {
    const embedQuery = await createPlanContextEmbedQueryImpl(env);
    return executePlanContextCommandFromArgs(args, {
      env,
      searchMemory(input) {
        return service.searchMemory(input);
      },
      embedQuery
    });
  });
}

export function getRepoRoot(): string {
  return repoRoot;
}
