// Thin CLI entry point for archon admin. Domain logic lives in the extracted
// modules below; everything remains importable from this module (P8-T1 split).
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
  buildContextStatusObservation,
  type DaemonContinuationStatusObservation,
  type DaemonOperatorHandoffObservation,
  type DaemonSupervisorStatusObservation,
  type ReviewIdentityStatusObservation
} from "./admin/status.ts";
import { AgentRuntimeStore } from "./store/agent-runtime-store.ts";
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
import { initTaskCommand } from "./admin/init-task.ts";
import { recordCouncilCommand } from "./admin/record-council.ts";
import { advanceActiveTaskCommand, checkpointCommand, coverageCommand, gapsCommand, githubDispatchCommand, opsCommand, repairTaskQueueCommand, reportCommand, resumeCommand, statusCommand, syncRuntimeExportsCommand } from "./workflow.ts";
import { bootstrapProject, doctorCommand, health, migrate, reconcileRuntimeStateCommand, recoverCommand, refreshRepoContextCommand, verifyLiveMigrations, verifySetup } from "./runtime.ts";
import { indexRepoMarkdownCommand, planContextCommand, refreshRetrievalCommand, runEmbeddingJobsCommand } from "./memory.ts";
import { recordReviewCommand, saveReviewCommand, seedWorkflowProofCommand, verifyReviewIdentityCommand, workflowProofCommand } from "./review.ts";
import { exportDocsCommand } from "./export.ts";
import { daemonCommand, loopCommand, supervisorCommand, supervisorHistoryCommand } from "./daemon.ts";
export * from "./workflow.ts";
export * from "./runtime.ts";
export * from "./memory.ts";
export * from "./review.ts";
export * from "./export.ts";
export * from "./daemon.ts";


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

  if (command === "save-review") {
    await saveReviewCommand(args);
    return;
  }

  if (command === "init-task") {
    await initTaskCommand(args, {
      withClient: (fn) => withClient((client) => fn(client)),
      createStore: (client) => new PostgresStore(client as ConstructorParameters<typeof PostgresStore>[0])
    });
    return;
  }

  if (command === "record-council") {
    await recordCouncilCommand(args, {
      withClient: (fn) => withClient((client) => fn(client)),
      createStore: (client) => new PostgresStore(client as ConstructorParameters<typeof PostgresStore>[0])
    });
    return;
  }

  if (command === "context-status") {
    const invocationId = args[0];
    if (!invocationId) {
      throw new Error("context-status requires an invocation-id argument");
    }
    await withClient(async (client) => {
      const store = new AgentRuntimeStore(client as ConstructorParameters<typeof AgentRuntimeStore>[0]);
      // Build a ContextBudgetStoreLike adapter that wraps AgentRuntimeStore.
      const budgetStore = {
        recordContextSample: (data: Parameters<typeof store.recordContextSample>[0]) =>
          store.recordContextSample(data),
        getLatestContextSample: (id: string) => store.getLatestContextSample(id),
        hasCommittedHandoff: async (_id: string) => false
      };
      const obs = await buildContextStatusObservation(invocationId, budgetStore);
      process.stdout.write(JSON.stringify(obs, null, 2) + "\n");
    });
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
