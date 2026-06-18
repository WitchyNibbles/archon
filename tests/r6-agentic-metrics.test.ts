// Tests for R6: agentic runtime observability metrics (§19.1).
//
// Covers collectAgenticMetrics aggregation, the Prometheus formatter, and the
// store's grouped-count queries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectAgenticMetrics,
  formatPrometheus,
  type AgenticMetricsStoreLike
} from "../src/runtime/agentic-metrics.ts";
import { AgentRuntimeStore } from "../src/store/agent-runtime-store.ts";

const sampleMetrics = {
  invocationsTotal: 5,
  invocationsByStatus: [
    { label: "running", count: 1 },
    { label: "completed", count: 4 }
  ],
  handoffsTotal: 3,
  handoffsByReason: [
    { label: "context_threshold_70", count: 2 },
    { label: "crash_recovery", count: 1 }
  ],
  contextThresholdCrossedTotal: 2,
  subtasksTotal: 4,
  subtasksByStatus: [{ label: "completed", count: 4 }],
  debateSessionsTotal: 1,
  debateSessionsByStatus: [{ label: "decided", count: 1 }]
};

describe("collectAgenticMetrics", () => {
  it("attaches the runId and passes through store metrics", async () => {
    let capturedPct = 0;
    const store: AgenticMetricsStoreLike = {
      async getAgenticMetrics(_runId, handoffPct) {
        capturedPct = handoffPct;
        return sampleMetrics;
      }
    };
    const metrics = await collectAgenticMetrics(store, "run-1", { handoffPct: 70 });
    assert.strictEqual(metrics.runId, "run-1");
    assert.strictEqual(metrics.invocationsTotal, 5);
    assert.strictEqual(metrics.handoffsTotal, 3);
    assert.strictEqual(capturedPct, 70);
  });

  it("defaults handoffPct to 70", async () => {
    let capturedPct = 0;
    const store: AgenticMetricsStoreLike = {
      async getAgenticMetrics(_runId, handoffPct) {
        capturedPct = handoffPct;
        return sampleMetrics;
      }
    };
    await collectAgenticMetrics(store, "run-1");
    assert.strictEqual(capturedPct, 70);
  });
});

describe("formatPrometheus", () => {
  it("emits all five counter families with run_id labels", () => {
    const text = formatPrometheus({ runId: "run-1", ...sampleMetrics });
    assert.match(text, /archon_agent_invocations_total\{run_id="run-1"\} 5/);
    assert.match(text, /archon_agent_invocations_total\{run_id="run-1",status="completed"\} 4/);
    assert.match(text, /archon_agent_handoffs_total\{run_id="run-1",reason="crash_recovery"\} 1/);
    assert.match(text, /archon_context_threshold_crossed_total\{run_id="run-1"\} 2/);
    assert.match(text, /archon_subtasks_total\{run_id="run-1"\} 4/);
    assert.match(text, /archon_debate_sessions_total\{run_id="run-1",status="decided"\} 1/);
    // HELP/TYPE headers present
    assert.match(text, /# TYPE archon_agent_invocations_total gauge/);
  });

  it("escapes quotes in label values", () => {
    const text = formatPrometheus({
      runId: 'run"x',
      ...sampleMetrics,
      handoffsByReason: [{ label: 'we"ird', count: 1 }]
    });
    assert.match(text, /reason="we\\"ird"/);
    assert.match(text, /run_id="run\\"x"/);
  });

  it("escapes newlines and carriage returns in label values", () => {
    const text = formatPrometheus({
      runId: "run-1",
      ...sampleMetrics,
      handoffsByReason: [{ label: "line1\nline2\rline3", count: 1 }]
    });
    assert.match(text, /reason="line1\\nline2\\rline3"/);
    // No raw newline should leak into the middle of a label value line.
    const reasonLine = text.split("\n").find((l) => l.includes("line1")) ?? "";
    assert.ok(reasonLine.includes("line1\\nline2\\rline3"));
  });
});

// ---------------------------------------------------------------------------
// Full dispatch chain: store query -> collect -> Prometheus (R6 CLI surface)
// ---------------------------------------------------------------------------

describe("metrics dispatch chain (store -> collect -> format)", () => {
  it("produces Prometheus text end-to-end through AgentRuntimeStore", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("from agent_invocations")) {
          return { rows: [{ label: "completed", count: 3 }] };
        }
        if (sql.includes("from agent_handoffs")) {
          return { rows: [{ label: "context_threshold_70", count: 1 }] };
        }
        if (sql.includes("from agent_context_samples")) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes("from agent_subtasks")) {
          return { rows: [{ label: "completed", count: 2 }] };
        }
        if (sql.includes("from agent_debate_sessions")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };
    const store = new AgentRuntimeStore(client as never);
    const metrics = await collectAgenticMetrics(store, "run-cli", { handoffPct: 70 });
    const text = formatPrometheus(metrics);
    assert.match(text, /archon_agent_invocations_total\{run_id="run-cli"\} 3/);
    assert.match(text, /archon_subtasks_total\{run_id="run-cli"\} 2/);
    assert.match(text, /archon_debate_sessions_total\{run_id="run-cli"\} 0/);
  });
});

describe("AgentRuntimeStore.getAgenticMetrics", () => {
  it("issues grouped-count queries and aggregates totals", async () => {
    const client = {
      async query(sql: string, _params?: unknown[]) {
        if (sql.includes("from agent_invocations")) {
          return { rows: [{ label: "running", count: 1 }, { label: "completed", count: 2 }] };
        }
        if (sql.includes("from agent_handoffs")) {
          return { rows: [{ label: "context_threshold_70", count: 3 }] };
        }
        if (sql.includes("from agent_context_samples")) {
          return { rows: [{ count: 2 }] };
        }
        if (sql.includes("from agent_subtasks")) {
          return { rows: [{ label: "completed", count: 4 }] };
        }
        if (sql.includes("from agent_debate_sessions")) {
          return { rows: [{ label: "decided", count: 1 }] };
        }
        return { rows: [] };
      }
    };
    const store = new AgentRuntimeStore(client as never);
    const metrics = await store.getAgenticMetrics("run-1", 70);
    assert.strictEqual(metrics.invocationsTotal, 3);
    assert.strictEqual(metrics.handoffsTotal, 3);
    assert.strictEqual(metrics.contextThresholdCrossedTotal, 2);
    assert.strictEqual(metrics.subtasksTotal, 4);
    assert.strictEqual(metrics.debateSessionsTotal, 1);
    assert.deepStrictEqual(metrics.invocationsByStatus, [
      { label: "running", count: 1 },
      { label: "completed", count: 2 }
    ]);
  });
});
