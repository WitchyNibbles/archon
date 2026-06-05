import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGrafanaClient } from "./client.ts";
import { loadDevgodEnvFile } from "./config.ts";
import { createGrafanaMcpToolDefinitions } from "./tools.ts";

export function createGrafanaMcpServer() {
  const client = createGrafanaClient();
  const server = new McpServer({
    name: "archon-grafana",
    version: "0.1.0"
  });

  for (const tool of createGrafanaMcpToolDefinitions({
    testConnection() {
      return client.testConnection();
    },
    listDatasources() {
      return client.listDatasources();
    },
    queryLogs(input) {
      return client.queryLogs(input);
    }
  })) {
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

export async function startGrafanaMcpServer(): Promise<void> {
  await loadDevgodEnvFile();
  const server = createGrafanaMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && process.argv[1].endsWith("src/grafana/mcp-server.ts")) {
  startGrafanaMcpServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
