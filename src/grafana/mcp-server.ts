import process from "node:process";
import { isMainModule } from "../shared/is-main-module.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGrafanaClient, type ArchonGrafanaQueryOptions } from "./client.ts";
import { loadDevgodEnvFile } from "./config.ts";
import { createGrafanaMcpToolDefinitions } from "./tools.ts";
import { getPackageVersion } from "../shared/package-version.ts";

export interface GrafanaMcpServerOptions {
  /** Override options for archon_grafana_query (e.g. to inject a mock fetch in tests). */
  queryOptions?: ArchonGrafanaQueryOptions;
}

export function createGrafanaMcpServer(options: GrafanaMcpServerOptions = {}) {
  // Defer createGrafanaClient so the server can start even without a full Grafana config.
  // The devgod_* tools that require a live client will throw at call time if not configured;
  // archon_grafana_query handles missing config gracefully via executeArchonGrafanaQuery.
  let client: ReturnType<typeof createGrafanaClient> | undefined;

  function getClient() {
    if (!client) {
      client = createGrafanaClient();
    }
    return client;
  }

  const server = new McpServer({
    name: "archon-grafana",
    version: getPackageVersion()
  });

  for (const tool of createGrafanaMcpToolDefinitions(
    {
      testConnection() {
        return getClient().testConnection();
      },
      listDatasources() {
        return getClient().listDatasources();
      },
      queryLogs(input) {
        return getClient().queryLogs(input);
      }
    },
    options.queryOptions ?? {}
  )) {
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

if (isMainModule(import.meta.url)) {
  startGrafanaMcpServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
