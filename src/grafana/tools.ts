import { z } from "zod";
import type {
  GrafanaDatasource,
  GrafanaHealthResponse,
  GrafanaQueryLogsInput,
  GrafanaQueryLogsResult,
  GrafanaQueryInput,
  GrafanaQueryResult,
  ArchonGrafanaQueryOptions
} from "./client.ts";
import { executeArchonGrafanaQuery } from "./client.ts";

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
  runtime: GrafanaRuntimeSurface,
  queryOptions: ArchonGrafanaQueryOptions = {}
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
    },
    {
      name: "archon_grafana_query",
      description:
        "Query a Grafana-connected datasource (Loki or Prometheus) by name. Routes automatically based on the datasource name: names containing 'loki' use the Loki query_range API; all others use the Prometheus query_range API. Requires ARCHON_GRAFANA_URL and ARCHON_GRAFANA_TOKEN environment variables.",
      inputSchema: {
        datasource: z.string().trim().min(1).describe("Datasource name (e.g. 'loki', 'prometheus-prod')."),
        query: z.string().min(1).max(10_000).describe("Query expression (LogQL for Loki, PromQL for Prometheus)."),
        time_range: z
          .object({
            from: z.string().trim().min(1).describe("Start of the time range as an ISO 8601 string."),
            to: z.string().trim().min(1).describe("End of the time range as an ISO 8601 string.")
          })
          .describe("Time range for the query.")
      },
      async invoke(input) {
        const queryInput: GrafanaQueryInput = {
          datasource: String(input.datasource),
          query: String(input.query),
          time_range: {
            from: String((input.time_range as Record<string, unknown>).from),
            to: String((input.time_range as Record<string, unknown>).to)
          }
        };

        const outcome = executeArchonGrafanaQuery(queryInput, queryOptions);

        if ("error" in outcome) {
          return buildTextResult(`archon_grafana_query error: ${outcome.error}`, { error: outcome.error });
        }

        const result = (await outcome) as GrafanaQueryResult;

        const countLabel =
          result.datasourceType === "loki"
            ? `${result.logLines.length} log line${result.logLines.length === 1 ? "" : "s"}`
            : `${result.series.length} series`;

        return buildTextResult(
          `archon_grafana_query returned ${countLabel} from ${result.datasource} (${result.datasourceType}).`,
          {
            datasource: result.datasource,
            datasourceType: result.datasourceType,
            query: result.query,
            timeRange: result.timeRange,
            resultType: result.resultType,
            totalCount: result.totalCount,
            series: result.datasourceType === "prometheus" ? result.series : undefined,
            logLines: result.datasourceType === "loki" ? result.logLines : undefined
          }
        );
      }
    }
  ];
}
