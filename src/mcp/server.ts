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

export function createArchonMcpServer(
  runtime: McpRuntimeSurface = {
    status: getStatusSurface,
    runtimeHealth: getRuntimeHealthSurface,
    ops: getOpsSurface,
    loop: getLoopSurface,
    report: getReportSurface,
    planContext: getPlanContextSurface
  }
) {
  const server = new McpServer({
    name: "archon",
    version: "0.1.0"
  });

  for (const tool of createMcpToolDefinitions(runtime)) {
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
  const server = createArchonMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && process.argv[1].endsWith("src/mcp/server.ts")) {
  startArchonMcpServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
