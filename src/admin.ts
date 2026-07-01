// Thin CLI entry point for archon admin. Domain logic lives in the extracted
// modules below; everything remains importable from this module (P8-T1 split).
import { realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";








import { loadDotEnv, withClient } from "./admin/db.ts";
import { validateArchonConfig, assertValidArchonConfig } from "./config/validate.ts";
import type { ArchonConfig } from "./config/schema.ts";




import {
  buildContextStatusObservation
} from "./admin/status.ts";
import { AgentRuntimeStore } from "./store/agent-runtime-store.ts";
import { collectAgenticMetrics, formatPrometheus } from "./runtime/agentic-metrics.ts";
import { resolveArchonContextPolicy } from "./runtime/context-budget.ts";










import { PostgresStore } from "./store/postgres-store.ts";
import { initTaskCommand } from "./admin/init-task.ts";
import { recordCouncilCommand } from "./admin/record-council.ts";
import { pruneOrphansCommand } from "./admin/prune-orphans.ts";
import { sweepOrphansCommand } from "./admin/sweep-orphans.ts";
import { reconcileRunClosure, reconcileAllRuns } from "./admin/close-run.ts";
import { ArchonCoreService } from "./core/service.ts";
import { continueSessionCommand } from "./admin/continue-session.ts";
import { forgeCommand } from "./admin/forge.ts";
import { secretCommand } from "./admin/secret.ts";
import { advanceActiveTaskCommand, checkpointCommand, coverageCommand, gapsCommand, githubDispatchCommand, opsCommand, repairTaskQueueCommand, reportCommand, resumeCommand, statusCommand, syncRuntimeExportsCommand } from "./workflow.ts";
import { bootstrapProject, doctorCommand, health, migrate, reconcileRuntimeStateCommand, recoverCommand, refreshRepoContextCommand, verifyLiveMigrations, verifySetup } from "./runtime.ts";
import { indexRepoMarkdownCommand, planContextCommand, refreshRetrievalCommand, runEmbeddingJobsCommand } from "./memory.ts";
import { recordReviewCommand, saveApprovalCommand, saveReviewCommand, seedWorkflowProofCommand, verifyReviewIdentityCommand, workflowProofCommand } from "./review.ts";
import { exportDocsCommand } from "./export.ts";
import { daemonCommand, loopCommand, supervisorCommand, supervisorHistoryCommand } from "./daemon.ts";
import { autonomousEnableCommand } from "./admin/autonomous-enable.ts";
export * from "./workflow.ts";
export * from "./runtime.ts";
export * from "./memory.ts";
export * from "./review.ts";
export * from "./export.ts";
export * from "./daemon.ts";


/**
 * Per-command required environment variables for fail-fast startup validation.
 *
 * Commands in this map have their required vars checked at startup (in addition
 * to format validation for every var in process.env).
 *
 * Commands NOT in this map are either:
 *   - Explicitly exempt (doctor — its own preflight handles config errors and
 *     must work even with a broken DATABASE_URL so the operator can diagnose).
 *   - Unknown (fall through to dispatch so "Unknown command" shows, not a
 *     spurious config error).
 *
 * "init-task" and "record-council" need both a DB connection AND a project
 * identity to record workflow state — add ARCHON_PROJECT_SLUG for those.
 */
const COMMAND_REQUIRED = new Map<string, readonly (keyof ArchonConfig)[]>([
  // DB-backed commands — require a live postgres connection
  ["migrate",                 ["ARCHON_CORE_DATABASE_URL"]],
  ["health",                  ["ARCHON_CORE_DATABASE_URL"]],
  ["bootstrap-project",       ["ARCHON_CORE_DATABASE_URL"]],
  ["verify-setup",            ["ARCHON_CORE_DATABASE_URL"]],
  ["verify-live-migrations",  ["ARCHON_CORE_DATABASE_URL"]],
  ["run-embedding-jobs",      ["ARCHON_CORE_DATABASE_URL"]],
  ["refresh-retrieval",       ["ARCHON_CORE_DATABASE_URL"]],
  ["refresh-repo-context",    ["ARCHON_CORE_DATABASE_URL"]],
  ["repair-task-queue",       ["ARCHON_CORE_DATABASE_URL"]],
  ["verify-review-identity",  ["ARCHON_CORE_DATABASE_URL"]],
  ["record-review",           ["ARCHON_CORE_DATABASE_URL"]],
  ["status",                  ["ARCHON_CORE_DATABASE_URL"]],
  ["coverage",                ["ARCHON_CORE_DATABASE_URL"]],
  ["gaps",                    ["ARCHON_CORE_DATABASE_URL"]],
  ["checkpoint",              ["ARCHON_CORE_DATABASE_URL"]],
  ["resume",                  ["ARCHON_CORE_DATABASE_URL"]],
  ["ops",                     ["ARCHON_CORE_DATABASE_URL"]],
  ["loop",                    ["ARCHON_CORE_DATABASE_URL"]],
  ["recover",                 ["ARCHON_CORE_DATABASE_URL"]],
  ["report",                  ["ARCHON_CORE_DATABASE_URL"]],
  ["workflow-proof",          ["ARCHON_CORE_DATABASE_URL"]],
  ["seed-workflow-proof",     ["ARCHON_CORE_DATABASE_URL"]],
  ["advance-active-task",     ["ARCHON_CORE_DATABASE_URL"]],
  ["reconcile-runtime-state", ["ARCHON_CORE_DATABASE_URL"]],
  ["sync-runtime-exports",    ["ARCHON_CORE_DATABASE_URL"]],
  ["daemon",                  ["ARCHON_CORE_DATABASE_URL"]],
  ["autonomous-enable",       ["ARCHON_CORE_DATABASE_URL"]],
  ["supervisor",              ["ARCHON_CORE_DATABASE_URL"]],
  ["supervisor-history",      ["ARCHON_CORE_DATABASE_URL"]],
  ["plan-context",            ["ARCHON_CORE_DATABASE_URL"]],
  ["export-docs",             ["ARCHON_CORE_DATABASE_URL"]],
  ["/export-docs",            ["ARCHON_CORE_DATABASE_URL"]],
  ["github-dispatch",         ["ARCHON_CORE_DATABASE_URL"]],
  ["index-repo-markdown",     ["ARCHON_CORE_DATABASE_URL"]],
  ["save-review",             ["ARCHON_CORE_DATABASE_URL"]],
  ["save-approval",           ["ARCHON_CORE_DATABASE_URL"]],
  ["prune-orphans",           ["ARCHON_CORE_DATABASE_URL"]],
  ["sweep-orphans",           ["ARCHON_CORE_DATABASE_URL"]],
  ["close-run",               ["ARCHON_CORE_DATABASE_URL"]],
  ["continue-session",        ["ARCHON_CORE_DATABASE_URL"]],
  ["forge",                   ["ARCHON_CORE_DATABASE_URL"]],
  ["secret",                  ["ARCHON_CORE_DATABASE_URL"]],
  ["context-status",          ["ARCHON_CORE_DATABASE_URL"]],
  ["handoffs",                ["ARCHON_CORE_DATABASE_URL"]],
  ["invocations",             ["ARCHON_CORE_DATABASE_URL"]],
  ["subtasks",                ["ARCHON_CORE_DATABASE_URL"]],
  ["debates",                 ["ARCHON_CORE_DATABASE_URL"]],
  ["metrics",                 ["ARCHON_CORE_DATABASE_URL"]],
  // Project-identity commands — also need ARCHON_PROJECT_SLUG
  ["init-task",               ["ARCHON_CORE_DATABASE_URL", "ARCHON_PROJECT_SLUG"]],
  ["record-council",          ["ARCHON_CORE_DATABASE_URL", "ARCHON_PROJECT_SLUG"]],
]);

async function main() {
  await loadDotEnv();

  // Parse command and args BEFORE running config validation so that the
  // "Unknown command" error and "doctor" diagnostics are never blocked by a
  // bad-config startup failure.
  const command = process.argv[2];
  const args = process.argv.slice(3);

  // Fail-fast startup validation: format-check all ARCHON_* vars, plus a
  // per-command required-vars check for commands that need specific vars to
  // be present.
  //
  // Exempt: doctor (its own preflight handles config errors; must work even
  // when DATABASE_URL is malformed so the operator can diagnose the issue).
  // Unknown commands: not in COMMAND_REQUIRED → skip assertValidArchonConfig
  // so "Unknown command" shows rather than a spurious config error.
  const required = COMMAND_REQUIRED.get(command ?? "");
  if (required !== undefined) {
    const cfgResult = validateArchonConfig(
      process.env as Record<string, string | undefined>,
      { required }
    );
    assertValidArchonConfig(cfgResult);
  }

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

  if (command === "autonomous-enable") {
    await autonomousEnableCommand(args);
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

  if (command === "prune-orphans") {
    await withClient(async (client) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dataRoot = process.env.ARCHON_DATA_ROOT ?? process.cwd();
      const repoRoot = process.cwd();
      await pruneOrphansCommand(args, {
        query: async (text, values) => {
          const result = await client.query(text, values as unknown[]);
          return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
        },
        withTransaction: async (work) => {
          await client.query("begin");
          try {
            const value = await work();
            await client.query("commit");
            return value;
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
        },
        writeFile: async (filePath, content) => {
          const nodePath = await import("node:path");
          await mkdir(nodePath.dirname(filePath), { recursive: true });
          await writeFile(filePath, content, "utf8");
        },
        now: () => new Date().toISOString(),
        writeLine: (line) => { process.stdout.write(`${line}\n`); },
        dataRoot,
        repoRoot
      });
    });
    return;
  }

  if (command === "sweep-orphans") {
    await withClient(async (client) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dataRoot = process.env.ARCHON_DATA_ROOT ?? process.cwd();
      const repoRoot = process.cwd();
      const workspaceSlug = process.env.ARCHON_WORKSPACE_SLUG ?? "default";
      const projectSlug = process.env.ARCHON_PROJECT_SLUG;
      const projectId = projectSlug ? `project:${workspaceSlug}:${projectSlug}` : undefined;
      await sweepOrphansCommand(args, {
        query: async (text, values) => {
          const result = await client.query(text, values as unknown[]);
          return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
        },
        withTransaction: async (work) => {
          await client.query("begin");
          try {
            const value = await work();
            await client.query("commit");
            return value;
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
        },
        writeFile: async (filePath, content) => {
          const nodePath = await import("node:path");
          await mkdir(nodePath.dirname(filePath), { recursive: true });
          await writeFile(filePath, content, "utf8");
        },
        now: () => new Date().toISOString(),
        writeLine: (line) => { process.stdout.write(`${line}\n`); },
        dataRoot,
        repoRoot,
        projectId
      });
    });
    return;
  }

  if (command === "close-run") {
    const confirm = args.includes("--confirm");
    const allRuns = args.includes("--all");
    const runIdFlagIdx = args.indexOf("--run-id");
    const runIdArg = runIdFlagIdx !== -1 ? args[runIdFlagIdx + 1] : undefined;
    if (runIdFlagIdx !== -1 && (runIdArg === undefined || runIdArg.startsWith("--"))) {
      throw new Error("close-run: --run-id requires a value (a run id or 'latest')");
    }
    await withClient(async (client) => {
      const store = new PostgresStore(client as ConstructorParameters<typeof PostgresStore>[0]);
      const service = new ArchonCoreService(store);
      const workspaceSlug = process.env.ARCHON_WORKSPACE_SLUG ?? "default";
      const projectSlug = process.env.ARCHON_PROJECT_SLUG;
      const TERMINAL_RUN_STATUSES = new Set(["done", "memorized"]);
      const closeRunDeps = {
        getStatusSnapshot: (id: string) => service.getStatus(id),
        getReviews: (id: string, taskId: string) => store.getReviews(id, taskId),
        getApprovals: (id: string, taskId: string) => store.getApprovals(id, taskId),
        getReviewFloorReductions: (id: string, taskId: string) => store.getReviewFloorReductions(id, taskId),
        updateTask: (taskRecord: Parameters<typeof store.updateTask>[0]) => store.updateTask(taskRecord),
        updateRun: (runRecord: Parameters<typeof store.updateRun>[0]) => store.updateRun(runRecord),
        onRunSealed: async (sealedRunId: string) => {
          // Best-effort: clear a dangling active-task pointer when its run is sealed.
          if (!projectSlug) return;
          const ctx = await store.getProjectContext({ workspaceSlug, projectSlug });
          if (!ctx) return;
          const state = await store.getProjectRuntimeState(ctx.project.id);
          if (state?.activeRunId === sealedRunId && state.activeTaskId) {
            await store.saveProjectRuntimeState({ ...state, activeTaskId: undefined, updatedAt: new Date().toISOString() });
          }
        },
        now: () => new Date().toISOString(),
        writeLine: (line: string) => { process.stdout.write(`${line}\n`); }
      };

      if (allRuns) {
        if (!projectSlug) {
          throw new Error("close-run --all: ARCHON_PROJECT_SLUG is required to enumerate the project's runs");
        }
        const runs = await store.findRunsByProjectActivity({ workspaceSlug, projectSlug, timezone: "UTC" });
        const candidateRunIds = runs
          .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
          .map((run) => run.id);
        await reconcileAllRuns(candidateRunIds, confirm, closeRunDeps);
        return;
      }

      let runId = runIdArg && runIdArg !== "latest" ? runIdArg : undefined;
      if (!runId) {
        const latest = projectSlug ? await store.findLatestRun({ workspaceSlug, projectSlug }) : undefined;
        runId = latest?.id;
      }
      if (!runId) {
        throw new Error("close-run: could not resolve a run — pass --run-id <id> or set ARCHON_PROJECT_SLUG");
      }
      await reconcileRunClosure(runId, confirm, closeRunDeps);
    });
    return;
  }

  if (command === "continue-session") {
    await continueSessionCommand(args);
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
