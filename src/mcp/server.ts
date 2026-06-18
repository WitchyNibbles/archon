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

  const handoffSurface: HandoffToolSurface = {
    handoffStore: store,
    contextStore: store
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
        return {
          status: row.status,
          taskId: row.taskId,
          runId: row.runId,
          allowedWriteScope: [],
          depth: row.depth,
          spawnPolicy
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
