import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { executeArchonGrafanaQuery, inferDatasourceType } from "../src/grafana/client.ts";
import type { GrafanaQueryInput } from "../src/grafana/client.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal env that satisfies resolveGrafanaConfig. */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ARCHON_GRAFANA_URL: "http://grafana.test",
    ARCHON_GRAFANA_TOKEN: "test-token-redacted",
    ...overrides
  };
}

function makeTimeRange() {
  return { from: "2024-01-01T00:00:00Z", to: "2024-01-01T01:00:00Z" };
}

/** Loki query_range response fixture. */
function lokiResponse() {
  return {
    status: "success",
    data: {
      resultType: "streams",
      result: [
        {
          stream: { app: "myapp", level: "info" },
          values: [
            ["1704067200000000000", "hello world"],
            ["1704067260000000000", "another line"]
          ]
        }
      ]
    }
  };
}

/** Prometheus query_range response fixture. */
function prometheusResponse() {
  return {
    status: "success",
    data: {
      resultType: "matrix",
      result: [
        {
          metric: { __name__: "up", job: "prometheus" },
          values: [
            [1704067200, "1"],
            [1704067260, "1"]
          ]
        }
      ]
    }
  };
}

/**
 * Creates a mock fetch that returns canned JSON.
 * Captures the last request URL and headers for assertion.
 */
function makeMockFetch(responseBody: unknown, status = 200): {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  const mockFetch = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const urlStr = url instanceof URL ? url.toString() : String(url);
    const rawHeaders = init?.headers;
    const headers: Record<string, string> =
      rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)
        ? (rawHeaders as Record<string, string>)
        : {};
    calls.push({ url: urlStr, headers });

    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  };

  return { fetch: mockFetch as typeof fetch, calls };
}

// ---------------------------------------------------------------------------
// inferDatasourceType
// ---------------------------------------------------------------------------

describe("inferDatasourceType", () => {
  it("returns loki for names containing 'loki'", () => {
    assert.equal(inferDatasourceType("loki"), "loki");
    assert.equal(inferDatasourceType("Loki-prod"), "loki");
    assert.equal(inferDatasourceType("my-LOKI-ds"), "loki");
  });

  it("returns prometheus for names not containing 'loki'", () => {
    assert.equal(inferDatasourceType("prometheus"), "prometheus");
    assert.equal(inferDatasourceType("thanos"), "prometheus");
    assert.equal(inferDatasourceType("mimir"), "prometheus");
  });
});

// ---------------------------------------------------------------------------
// executeArchonGrafanaQuery — missing env vars
// ---------------------------------------------------------------------------

describe("executeArchonGrafanaQuery — missing env vars", () => {
  it("returns error (not throw) when ARCHON_GRAFANA_URL is absent", async () => {
    const result = executeArchonGrafanaQuery(
      {
        datasource: "loki",
        query: '{app="test"}',
        time_range: makeTimeRange()
      },
      { env: { ARCHON_GRAFANA_TOKEN: "tok" } }
    );

    assert.ok("error" in result, "expected an error object, not a Promise");
    const errResult = result as { error: string };
    assert.match(errResult.error, /ARCHON_GRAFANA_URL/i);
    // Token must NOT appear in the error message
    assert.ok(!errResult.error.includes("tok"), "auth token must not appear in error message");
  });

  it("returns error when ARCHON_GRAFANA_TOKEN is absent", async () => {
    const result = executeArchonGrafanaQuery(
      {
        datasource: "prometheus",
        query: "up",
        time_range: makeTimeRange()
      },
      { env: { ARCHON_GRAFANA_URL: "http://grafana.test" } }
    );

    assert.ok("error" in result, "expected an error object, not a Promise");
    const errResult = result as { error: string };
    assert.match(errResult.error, /ARCHON_GRAFANA_TOKEN|ARCHON_GRAFANA_USERNAME/i);
  });

  it("returns error when both URL and token are absent", async () => {
    const result = executeArchonGrafanaQuery(
      {
        datasource: "loki",
        query: '{job="test"}',
        time_range: makeTimeRange()
      },
      { env: {} }
    );

    assert.ok("error" in result, "expected an error object, not a Promise");
  });
});

// ---------------------------------------------------------------------------
// executeArchonGrafanaQuery — query length validation
// ---------------------------------------------------------------------------

describe("executeArchonGrafanaQuery — query length validation", () => {
  it("rejects queries over 10000 characters", async () => {
    const longQuery = "x".repeat(10_001);
    const result = executeArchonGrafanaQuery(
      {
        datasource: "loki",
        query: longQuery,
        time_range: makeTimeRange()
      },
      { env: makeEnv() }
    );

    assert.ok("error" in result, "expected an error object for oversized query");
    const errResult = result as { error: string };
    assert.match(errResult.error, /10.?000|maximum length/i);
  });

  it("accepts queries of exactly 10000 characters", async () => {
    const { fetch: mockFetch } = makeMockFetch(lokiResponse());
    const borderQuery = "x".repeat(10_000);
    const result = executeArchonGrafanaQuery(
      {
        datasource: "loki",
        query: borderQuery,
        time_range: makeTimeRange()
      },
      { env: makeEnv(), fetchFn: mockFetch }
    );

    // Should return a Promise (not an error object) since validation passes
    assert.ok(result instanceof Promise, "expected a Promise for a 10000-char query");
    // Resolve it to avoid unhandled rejection
    await result;
  });
});

// ---------------------------------------------------------------------------
// executeArchonGrafanaQuery — Loki routing
// ---------------------------------------------------------------------------

describe("executeArchonGrafanaQuery — Loki routing", () => {
  it("routes to /loki/api/v1/query_range for a loki datasource", async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(lokiResponse());
    const input: GrafanaQueryInput = {
      datasource: "loki-prod",
      query: '{app="myapp"}',
      time_range: makeTimeRange()
    };

    const result = await (executeArchonGrafanaQuery(input, { env: makeEnv(), fetchFn: mockFetch }) as Promise<unknown>);

    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].url.includes("/loki/api/v1/query_range"),
      `expected Loki endpoint, got: ${calls[0].url}`
    );
  });

  it("returns parsed log lines for a Loki response", async () => {
    const { fetch: mockFetch } = makeMockFetch(lokiResponse());
    const input: GrafanaQueryInput = {
      datasource: "loki",
      query: '{app="myapp"}',
      time_range: makeTimeRange()
    };

    const result = await (executeArchonGrafanaQuery(input, { env: makeEnv(), fetchFn: mockFetch }) as Promise<{
      datasourceType: string;
      logLines: Array<{ line: string; timestamp: string; labels: Record<string, string> }>;
      totalCount: number;
    }>);

    assert.equal(result.datasourceType, "loki");
    assert.equal(result.logLines.length, 2);
    assert.equal(result.logLines[0].line, "hello world");
    assert.equal(result.logLines[0].labels.app, "myapp");
    assert.equal(result.totalCount, 2);
  });

  it("sends Authorization: Bearer header for Loki requests", async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(lokiResponse());
    const input: GrafanaQueryInput = {
      datasource: "loki",
      query: '{job="test"}',
      time_range: makeTimeRange()
    };

    await (executeArchonGrafanaQuery(input, {
      env: makeEnv({ ARCHON_GRAFANA_TOKEN: "secret-token" }),
      fetchFn: mockFetch
    }) as Promise<unknown>);

    assert.equal(calls.length, 1);
    const authHeader = calls[0].headers["Authorization"] ?? "";
    assert.match(authHeader, /^Bearer /);
    // Verify the token IS sent in the header (correct behavior)
    assert.ok(authHeader.includes("secret-token"), "Bearer header must include the token");
  });

  it("does not include auth token in error messages", async () => {
    // Simulate a 401 response (token invalid)
    const { fetch: mockFetch } = makeMockFetch({ message: "Unauthorized" }, 401);
    const input: GrafanaQueryInput = {
      datasource: "loki",
      query: '{app="test"}',
      time_range: makeTimeRange()
    };

    try {
      await (executeArchonGrafanaQuery(input, {
        env: makeEnv({ ARCHON_GRAFANA_TOKEN: "my-secret-token" }),
        fetchFn: mockFetch
      }) as Promise<unknown>);
      assert.fail("expected an error to be thrown for a 401 response");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(
        !message.includes("my-secret-token"),
        `auth token must not appear in error message; got: ${message}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// executeArchonGrafanaQuery — Prometheus routing
// ---------------------------------------------------------------------------

describe("executeArchonGrafanaQuery — Prometheus routing", () => {
  it("routes to /api/v1/query_range for a prometheus datasource", async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(prometheusResponse());
    const input: GrafanaQueryInput = {
      datasource: "prometheus-prod",
      query: "up",
      time_range: makeTimeRange()
    };

    await (executeArchonGrafanaQuery(input, { env: makeEnv(), fetchFn: mockFetch }) as Promise<unknown>);

    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].url.includes("/api/v1/query_range"),
      `expected Prometheus endpoint, got: ${calls[0].url}`
    );
    // Must NOT use the Loki endpoint
    assert.ok(
      !calls[0].url.includes("/loki/"),
      `must not route to Loki endpoint for a prometheus datasource`
    );
  });

  it("returns parsed series for a Prometheus response", async () => {
    const { fetch: mockFetch } = makeMockFetch(prometheusResponse());
    const input: GrafanaQueryInput = {
      datasource: "prometheus",
      query: "up",
      time_range: makeTimeRange()
    };

    const result = await (executeArchonGrafanaQuery(input, { env: makeEnv(), fetchFn: mockFetch }) as Promise<{
      datasourceType: string;
      series: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
      logLines: unknown[];
      totalCount: number;
    }>);

    assert.equal(result.datasourceType, "prometheus");
    assert.equal(result.series.length, 1);
    assert.equal(result.series[0].metric.__name__, "up");
    assert.equal(result.series[0].values.length, 2);
    assert.equal(result.logLines.length, 0);
    assert.equal(result.totalCount, 2);
  });

  it("sends Authorization: Bearer header for Prometheus requests", async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(prometheusResponse());
    const input: GrafanaQueryInput = {
      datasource: "prometheus",
      query: "up",
      time_range: makeTimeRange()
    };

    await (executeArchonGrafanaQuery(input, {
      env: makeEnv({ ARCHON_GRAFANA_TOKEN: "prom-secret" }),
      fetchFn: mockFetch
    }) as Promise<unknown>);

    assert.equal(calls.length, 1);
    const authHeader = calls[0].headers["Authorization"] ?? "";
    assert.match(authHeader, /^Bearer /);
    assert.ok(authHeader.includes("prom-secret"), "Bearer header must include the token");
  });
});

// ---------------------------------------------------------------------------
// archon_grafana_query MCP tool — integration via tool definition
// ---------------------------------------------------------------------------

describe("archon_grafana_query MCP tool definition", () => {
  it("is present in the tool list returned by createGrafanaMcpToolDefinitions", async () => {
    const { createGrafanaMcpToolDefinitions } = await import("../src/grafana/tools.ts");

    const tools = createGrafanaMcpToolDefinitions(
      {
        testConnection: async () => ({ commit: "", database: "", version: "" }),
        listDatasources: async () => [],
        queryLogs: async () => ({
          datasource: { uid: "x", name: "x", type: "loki" },
          query: "",
          direction: "backward",
          lineCount: 0,
          lines: []
        })
      },
      {}
    );

    const toolNames = tools.map((t) => t.name);
    assert.ok(toolNames.includes("archon_grafana_query"), `expected archon_grafana_query in ${toolNames.join(", ")}`);
  });

  it("returns a soft error message (not throw) when ARCHON_GRAFANA_URL is missing", async () => {
    const { createGrafanaMcpToolDefinitions } = await import("../src/grafana/tools.ts");

    const tools = createGrafanaMcpToolDefinitions(
      {
        testConnection: async () => ({ commit: "", database: "", version: "" }),
        listDatasources: async () => [],
        queryLogs: async () => ({
          datasource: { uid: "x", name: "x", type: "loki" },
          query: "",
          direction: "backward",
          lineCount: 0,
          lines: []
        })
      },
      { env: {} }
    );

    const tool = tools.find((t) => t.name === "archon_grafana_query");
    assert.ok(tool, "archon_grafana_query tool not found");

    const result = await tool.invoke({
      datasource: "loki",
      query: '{app="test"}',
      time_range: { from: "2024-01-01T00:00:00Z", to: "2024-01-01T01:00:00Z" }
    });

    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /error/i);
    assert.match(result.content[0].text, /ARCHON_GRAFANA_URL/i);
  });
});
