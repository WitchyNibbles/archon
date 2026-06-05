import { z } from "zod";
import type {
  GrafanaDatasource,
  GrafanaHealthResponse,
  GrafanaQueryLogsInput,
  GrafanaQueryLogsResult
} from "./client.ts";

export interface GrafanaRuntimeSurface {
  testConnection(): Promise<GrafanaHealthResponse>;
  listDatasources(): Promise<GrafanaDatasource[]>;
  queryLogs(input: GrafanaQueryLogsInput): Promise<GrafanaQueryLogsResult>;
}

export interface GrafanaMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  invoke: (input: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[];
    structuredContent: Record<string, unknown>;
  }>;
}

function buildTextResult(summary: string, structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent
  };
}

export function createGrafanaMcpToolDefinitions(
  runtime: GrafanaRuntimeSurface
): readonly GrafanaMcpToolDefinition[] {
  return [
    {
      name: "devgod_grafana_test_connection",
      description: "Verify Grafana auth and reachability using the configured DevGod Grafana connection.",
      inputSchema: {},
      async invoke() {
        const result = await runtime.testConnection();
        return buildTextResult(
          `Grafana reachable: ${result.version} (${result.database})`,
          { health: result }
        );
      }
    },
    {
      name: "devgod_grafana_list_datasources",
      description: "List Grafana datasources visible to the configured DevGod Grafana connection.",
      inputSchema: {},
      async invoke() {
        const datasources = await runtime.listDatasources();
        return buildTextResult(
          `Grafana returned ${datasources.length} datasource${datasources.length === 1 ? "" : "s"}.`,
          {
            datasources: datasources.map((datasource) => ({
              uid: datasource.uid,
              name: datasource.name,
              type: datasource.type,
              isDefault: datasource.isDefault ?? false
            }))
          }
        );
      }
    },
    {
      name: "devgod_grafana_query_logs",
      description: "Query Loki-backed logs through Grafana for debugging and research.",
      inputSchema: {
        query: z.string().trim().min(1),
        datasourceUid: z.string().trim().optional(),
        start: z.string().trim().optional(),
        end: z.string().trim().optional(),
        since: z.string().trim().optional(),
        limit: z.number().int().min(1).max(5_000).optional(),
        direction: z.enum(["backward", "forward"]).optional()
      },
      async invoke(input) {
        const result = await runtime.queryLogs({
          query: String(input.query),
          datasourceUid: typeof input.datasourceUid === "string" ? input.datasourceUid.trim() : undefined,
          start: typeof input.start === "string" ? input.start.trim() : undefined,
          end: typeof input.end === "string" ? input.end.trim() : undefined,
          since: typeof input.since === "string" ? input.since.trim() : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
          direction: input.direction === "forward" ? "forward" : "backward"
        });

        return buildTextResult(
          `Grafana returned ${result.lineCount} log line${result.lineCount === 1 ? "" : "s"} from ${result.datasource.name}.`,
          {
            datasource: result.datasource,
            query: result.query,
            direction: result.direction,
            lineCount: result.lineCount,
            lines: result.lines
          }
        );
      }
    }
  ];
}
