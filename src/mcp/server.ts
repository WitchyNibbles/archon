import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  getLoopSurface,
  getOpsSurface,
  getPlanContextSurface,
  getReportSurface,
  getRuntimeHealthSurface,
  getStatusSurface
} from "../admin/runtime-surface.ts";
import { createMcpToolDefinitions, type McpRuntimeSurface } from "./tools.ts";
import { createHandoffToolDefinitions } from "./handoff-tools.ts";
import type { HandoffToolSurface } from "./handoff-tools.ts";
import { createSubtaskToolDefinitions } from "./subtask-tools.ts";
import type { SubtaskToolSurface } from "./subtask-tools.ts";
import { createDebateToolDefinitions } from "./debate-tools.ts";
import type { DebateStoreLike } from "../runtime/debate-controller.ts";
import { loadDotEnv } from "../admin/db.ts";
import {
  agentCatalog,
  defaultArchonSpawnPolicy
} from "../archon/agent-catalog.ts";
import type { AgentRoleId } from "../archon/agent-catalog.ts";
import type { ParentInvocationRef } from "../runtime/subtask-scheduler.ts";

export function createArchonMcpServer(
  runtime: McpRuntimeSurface = {
    status: getStatusSurface,
    runtimeHealth: getRuntimeHealthSurface,
    ops: getOpsSurface,
    loop: getLoopSurface,
    report: getReportSurface,
    planContext: getPlanContextSurface
  },
  handoffSurface?: HandoffToolSurface | undefined,
  subtaskSurface?: SubtaskToolSurface | undefined,
  debateSurface?: DebateStoreLike | undefined
) {
  const server = new McpServer({
    name: "archon",
    version: "0.1.0"
  });

  const runtimeTools = createMcpToolDefinitions(runtime);
  const handoffTools =
    handoffSurface !== undefined ? createHandoffToolDefinitions(handoffSurface) : [];
  const subtaskTools =
    subtaskSurface !== undefined ? createSubtaskToolDefinitions(subtaskSurface) : [];
  const debateTools =
    debateSurface !== undefined ? createDebateToolDefinitions(debateSurface) : [];

  for (const tool of [...runtimeTools, ...handoffTools, ...subtaskTools, ...debateTools]) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      async (input) => tool.invoke(input)
    );
  }

  return server;
}

export async function startArchonMcpServer(): Promise<void> {
  await loadDotEnv();

  const { Client } = await import("pg");
  const client = new Client({
    connectionString: process.env["ARCHON_CORE_DATABASE_URL"]
  });
  await client.connect();

  const { AgentRuntimeStore } = await import("../store/agent-runtime-store.ts");
  // @ts-ignore — pg Client is compatible with SqlClient interface; Parameters<> doesn't work on classes
  const store = new AgentRuntimeStore(client);

  // P3 MPL: wire the anti-pattern injector so the standalone MCP server injects locus-matched
  // anti-patterns into continuation bundles. Fail-safe: if construction throws, injector stays
  // undefined and archon_context_bundle builds exactly as before (no injection, no crash).
  let injector: import("../runtime/continuation-context.ts").AntiPatternInjectorLike | undefined;
  try {
    const { PostgresMistakeLedgerStore } = await import("../store/postgres-store.ts");
    // @ts-ignore — pg Client is compatible with SqlClient interface
    injector = new PostgresMistakeLedgerStore(client);
  } catch {
    // Injector construction failed; proceed without injection (fail-safe).
  }

  const handoffSurface: HandoffToolSurface = {
    handoffStore: store,
    contextStore: store,
    injector
  };

  const subtaskSurface: SubtaskToolSurface = {
    subtaskStore: store,
    invocationStore: {
      async getInvocation(invocationId: string): Promise<ParentInvocationRef | undefined> {
        const row = await store.getInvocationForSpawning(invocationId);
        if (!row) return undefined;
        const entry = agentCatalog[row.role as AgentRoleId] as
          | (typeof agentCatalog)[AgentRoleId]
          | undefined;
        // @ts-ignore — spawnPolicy may not exist on v1 entries
        const spawnPolicy = (entry as { spawnPolicy?: typeof defaultArchonSpawnPolicy })?.spawnPolicy
          ?? defaultArchonSpawnPolicy;
        // SDD §20.2 / TDD §8.2: deny spawning once the parent crossed the threshold.
        const contextThresholdCrossed = await store.hasInvocationCrossedThreshold(invocationId);
        return {
          status: row.status,
          taskId: row.taskId,
          runId: row.runId,
          allowedWriteScope: [],
          depth: row.depth,
          spawnPolicy,
          contextThresholdCrossed
        } satisfies ParentInvocationRef;
      }
    }
  };

  const debateSurface: DebateStoreLike = store;

  const server = createArchonMcpServer(
    undefined,
    handoffSurface,
    subtaskSurface,
    debateSurface
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // client stays alive for duration of process
}

if (process.argv[1] && process.argv[1].endsWith("src/mcp/server.ts")) {
  startArchonMcpServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
