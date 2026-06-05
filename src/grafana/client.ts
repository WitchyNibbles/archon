import { requireGrafanaConfig, type GrafanaConfig } from "./config.ts";

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
}

export function createGrafanaClient(env: NodeJS.ProcessEnv = process.env, fetchFn: FetchLike = fetch): GrafanaClient {
  return new GrafanaClient(requireGrafanaConfig(env), fetchFn);
}
