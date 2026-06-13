import { requireGrafanaConfig, resolveGrafanaConfig, type GrafanaConfig } from "./config.ts";

// --- archon_grafana_query types ---

export type GrafanaDatasourceType = "loki" | "prometheus";

export interface GrafanaQueryTimeRange {
  from: string;
  to: string;
}

export interface GrafanaQueryInput {
  datasource: string;
  query: string;
  time_range: GrafanaQueryTimeRange;
}

export interface GrafanaQueryLogLine {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
}

export interface GrafanaQuerySeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface GrafanaQueryResult {
  datasource: string;
  datasourceType: GrafanaDatasourceType;
  query: string;
  timeRange: GrafanaQueryTimeRange;
  resultType: string;
  series: GrafanaQuerySeries[];
  logLines: GrafanaQueryLogLine[];
  totalCount: number;
}

export interface GrafanaHealthResponse {
  commit: string;
  database: string;
  version: string;
}

export interface GrafanaDatasource {
  id?: number | undefined;
  uid: string;
  name: string;
  type: string;
  isDefault?: boolean | undefined;
}

export interface GrafanaQueryLogsInput {
  query: string;
  datasourceUid?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  since?: string | undefined;
  limit?: number | undefined;
  direction?: "backward" | "forward" | undefined;
}

export interface GrafanaLogLine {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
}

export interface GrafanaQueryLogsResult {
  datasource: Pick<GrafanaDatasource, "uid" | "name" | "type">;
  query: string;
  direction: "backward" | "forward";
  lineCount: number;
  lines: GrafanaLogLine[];
  stats?: unknown;
}

type FetchLike = typeof fetch;

function buildRequestHeaders(config: GrafanaConfig, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: config.authHeaderValue,
    ...(config.orgId ? { "X-Grafana-Org-Id": config.orgId } : {}),
    ...extra
  };
}

export class GrafanaClient {
  private readonly config: GrafanaConfig;
  private readonly fetchFn: FetchLike;

  constructor(config: GrafanaConfig, fetchFn: FetchLike = fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  private async requestJson<T>(
    requestPath: string,
    init: RequestInit = {},
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    const url = new URL(requestPath, `${this.config.baseUrl}/`);
    const response = await this.fetchFn(url, {
      ...init,
      headers: {
        ...buildRequestHeaders(this.config, extraHeaders),
        ...(init.headers && typeof init.headers === "object" ? (init.headers as Record<string, string>) : {})
      },
      signal: init.signal ?? AbortSignal.timeout(this.config.timeoutMs)
    });

    if (!response.ok) {
      const body = await response.text();
      const summary = body.trim().slice(0, 240);
      throw new Error(
        `Grafana request failed (${response.status} ${init.method ?? "GET"} ${requestPath})${summary ? `: ${summary}` : ""}`
      );
    }

    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<GrafanaHealthResponse> {
    return this.requestJson<GrafanaHealthResponse>("/api/health");
  }

  async listDatasources(): Promise<GrafanaDatasource[]> {
    return this.requestJson<GrafanaDatasource[]>("/api/datasources");
  }

  async getDatasourceByUid(uid: string): Promise<GrafanaDatasource> {
    return this.requestJson<GrafanaDatasource>(`/api/datasources/uid/${encodeURIComponent(uid)}`);
  }

  async queryLogs(input: GrafanaQueryLogsInput): Promise<GrafanaQueryLogsResult> {
    const datasourceUid = input.datasourceUid ?? this.config.logsDatasourceUid;
    if (!datasourceUid) {
      throw new Error(
        "Grafana log queries require a datasource uid via the tool input or ARCHON_GRAFANA_LOGS_DATASOURCE_UID"
      );
    }

    const datasource = await this.getDatasourceByUid(datasourceUid);
    if (datasource.type !== "loki") {
      throw new Error(`Grafana log queries currently support Loki datasources only; got ${datasource.type}`);
    }

    const params = new URLSearchParams({
      query: input.query,
      direction: input.direction ?? "backward",
      limit: String(input.limit ?? 200)
    });
    if (input.start) {
      params.set("start", input.start);
    }
    if (input.end) {
      params.set("end", input.end);
    }
    if (input.since) {
      params.set("since", input.since);
    }

    // Query Loki through Grafana's datasource proxy so consumers only need Grafana credentials.
    const response = await this.requestJson<{
      status: string;
      data?: {
        result?: Array<{
          stream: Record<string, string>;
          values: Array<[string, string]>;
        }>;
        stats?: unknown;
      };
    }>(
      `/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}/loki/api/v1/query_range?${params.toString()}`,
      {},
      this.config.lokiTenantId ? { "X-Scope-OrgID": this.config.lokiTenantId } : {}
    );

    const lines: GrafanaLogLine[] = [];
    for (const stream of response.data?.result ?? []) {
      for (const [timestamp, line] of stream.values ?? []) {
        lines.push({
          timestamp,
          line,
          labels: stream.stream
        });
      }
    }

    return {
      datasource: {
        uid: datasource.uid,
        name: datasource.name,
        type: datasource.type
      },
      query: input.query,
      direction: input.direction ?? "backward",
      lineCount: lines.length,
      lines,
      stats: response.data?.stats
    };
  }

  async archonGrafanaQuery(input: GrafanaQueryInput): Promise<GrafanaQueryResult> {
    const { datasource, query, time_range } = input;

    const dsType = inferDatasourceType(datasource);

    if (dsType === "loki") {
      return this.queryLoki(datasource, query, time_range);
    }

    return this.queryPrometheus(datasource, query, time_range);
  }

  private async queryLoki(
    datasource: string,
    query: string,
    timeRange: GrafanaQueryTimeRange
  ): Promise<GrafanaQueryResult> {
    const params = new URLSearchParams({
      query,
      start: timeRange.from,
      end: timeRange.to,
      limit: "1000"
    });

    const response = await this.requestJson<{
      status: string;
      data?: {
        resultType?: string;
        result?: Array<{
          stream: Record<string, string>;
          values: Array<[string, string]>;
        }>;
      };
    }>(`/loki/api/v1/query_range?${params.toString()}`);

    const logLines: GrafanaQueryLogLine[] = [];
    for (const stream of response.data?.result ?? []) {
      for (const [timestamp, line] of stream.values ?? []) {
        logLines.push({
          timestamp,
          line,
          labels: stream.stream
        });
      }
    }

    return {
      datasource,
      datasourceType: "loki",
      query,
      timeRange,
      resultType: response.data?.resultType ?? "streams",
      series: [],
      logLines,
      totalCount: logLines.length
    };
  }

  private async queryPrometheus(
    datasource: string,
    query: string,
    timeRange: GrafanaQueryTimeRange
  ): Promise<GrafanaQueryResult> {
    const params = new URLSearchParams({
      query,
      start: timeRange.from,
      end: timeRange.to,
      step: "60"
    });

    const response = await this.requestJson<{
      status: string;
      data?: {
        resultType?: string;
        result?: Array<{
          metric: Record<string, string>;
          values: Array<[number, string]>;
        }>;
      };
    }>(`/api/v1/query_range?${params.toString()}`);

    const series: GrafanaQuerySeries[] = (response.data?.result ?? []).map((r) => ({
      metric: r.metric,
      values: r.values
    }));

    return {
      datasource,
      datasourceType: "prometheus",
      query,
      timeRange,
      resultType: response.data?.resultType ?? "matrix",
      series,
      logLines: [],
      totalCount: series.reduce((sum, s) => sum + s.values.length, 0)
    };
  }
}

export function createGrafanaClient(env: NodeJS.ProcessEnv = process.env, fetchFn: FetchLike = fetch): GrafanaClient {
  return new GrafanaClient(requireGrafanaConfig(env), fetchFn);
}

const MAX_QUERY_LENGTH = 10_000;

export function inferDatasourceType(datasource: string): GrafanaDatasourceType {
  const lower = datasource.toLowerCase();
  if (lower.includes("loki")) {
    return "loki";
  }
  return "prometheus";
}

export interface ArchonGrafanaQueryOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
}

export function executeArchonGrafanaQuery(
  input: GrafanaQueryInput,
  options: ArchonGrafanaQueryOptions = {}
): Promise<GrafanaQueryResult> | { error: string } {
  const env = options.env ?? process.env;

  // Validate query length before any env access
  if (typeof input.query === "string" && input.query.length > MAX_QUERY_LENGTH) {
    return { error: `query exceeds maximum length of ${MAX_QUERY_LENGTH} characters` };
  }

  const resolution = resolveGrafanaConfig(env);
  if (!resolution.configured || !resolution.config) {
    return { error: `Grafana integration is not configured: ${resolution.issues.join("; ")}` };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const client = new GrafanaClient(resolution.config, fetchFn);
  return client.archonGrafanaQuery(input);
}
