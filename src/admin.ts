// Thin CLI entry point for archon admin. Domain logic lives in the extracted
// modules below; everything remains importable from this module (P8-T1 split).
import { realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";








import { loadDotEnv, withClient } from "./admin/db.ts";




import {
  buildContextStatusObservation
} from "./admin/status.ts";
import { AgentRuntimeStore } from "./store/agent-runtime-store.ts";
import { collectAgenticMetrics, formatPrometheus } from "./runtime/agentic-metrics.ts";
import { resolveArchonContextPolicy } from "./runtime/context-budget.ts";










import { PostgresStore } from "./store/postgres-store.ts";
import { initTaskCommand } from "./admin/init-task.ts";
import { recordCouncilCommand } from "./admin/record-council.ts";
import { forgeCommand } from "./admin/forge.ts";
import { secretCommand } from "./admin/secret.ts";
import { advanceActiveTaskCommand, checkpointCommand, coverageCommand, gapsCommand, githubDispatchCommand, opsCommand, repairTaskQueueCommand, reportCommand, resumeCommand, statusCommand, syncRuntimeExportsCommand } from "./workflow.ts";
import { bootstrapProject, doctorCommand, health, migrate, reconcileRuntimeStateCommand, recoverCommand, refreshRepoContextCommand, verifyLiveMigrations, verifySetup } from "./runtime.ts";
import { indexRepoMarkdownCommand, planContextCommand, refreshRetrievalCommand, runEmbeddingJobsCommand } from "./memory.ts";
import { recordReviewCommand, saveApprovalCommand, saveReviewCommand, seedWorkflowProofCommand, verifyReviewIdentityCommand, workflowProofCommand } from "./review.ts";
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

  if (command === "save-approval") {
    await saveApprovalCommand(args);
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

  if (command === "forge") {
    await forgeCommand(args);
    return;
  }

  if (command === "secret") {
    await secretCommand(args);
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

  if (command === "handoffs") {
    const runId = args[0];
    const taskId = args[1];
    if (!runId || !taskId) {
      throw new Error("handoffs requires <run-id> <task-id>");
    }
    await withClient(async (client) => {
      const store = new AgentRuntimeStore(client as ConstructorParameters<typeof AgentRuntimeStore>[0]);
      const records = await store.listHandoffsForTask(runId, taskId);
      process.stdout.write(JSON.stringify(records, null, 2) + "\n");
    });
    return;
  }

  if (command === "invocations") {
    const runId = args[0];
    const taskId = args[1]; // optional
    if (!runId) {
      throw new Error("invocations requires <run-id> [task-id]");
    }
    await withClient(async (client) => {
      const store = new AgentRuntimeStore(client as ConstructorParameters<typeof AgentRuntimeStore>[0]);
      const records = await store.listInvocationsForRun(runId, taskId);
      process.stdout.write(JSON.stringify(records, null, 2) + "\n");
    });
    return;
  }

  if (command === "subtasks") {
    const taskId = args[0];
    if (!taskId) {
      throw new Error("subtasks requires <task-id>");
    }
    await withClient(async (client) => {
      const store = new AgentRuntimeStore(client as ConstructorParameters<typeof AgentRuntimeStore>[0]);
      const records = await store.listSubtasksForTask(taskId);
      process.stdout.write(JSON.stringify(records, null, 2) + "\n");
    });
    return;
  }

  if (command === "debates") {
    const runId = args[0];
    const taskId = args[1]; // optional
    if (!runId) {
      throw new Error("debates requires <run-id> [task-id]");
    }
    await withClient(async (client) => {
      const store = new AgentRuntimeStore(client as ConstructorParameters<typeof AgentRuntimeStore>[0]);
      const records = await store.listDebateSessionsForRun(runId, taskId);
      process.stdout.write(JSON.stringify(records, null, 2) + "\n");
    });
    return;
  }

  if (command === "metrics") {
    const runId = args[0];
    if (!runId) {
      throw new Error("metrics requires <run-id> [--format json|prometheus]");
    }
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    await withClient(async (client) => {
      const store = new AgentRuntimeStore(client as ConstructorParameters<typeof AgentRuntimeStore>[0]);
      const metrics = await collectAgenticMetrics(store, runId, {
        handoffPct: resolveArchonContextPolicy().handoffPct
      });
      if (format === "prometheus") {
        process.stdout.write(formatPrometheus(metrics));
      } else {
        process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
      }
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
