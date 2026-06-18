// Agentic Runtime Metrics — observability surface for the agentic loop (§19.1).
//
// Derives counters from the agentic runtime tables (invocations, handoffs,
// context samples, subtasks, debate sessions). These are the §19.1 counters that
// the runtime tables can faithfully support; counters that require an external
// metrics sink (e.g. handoff validation failures, which throw rather than
// persist) are intentionally not fabricated here.
//
// Store-agnostic: callers inject the adapter so unit tests run without a DB.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LabeledCount {
  label: string;
  count: number;
}

export interface AgenticMetrics {
  runId: string;
  invocationsTotal: number;
  invocationsByStatus: readonly LabeledCount[];
  handoffsTotal: number;
  handoffsByReason: readonly LabeledCount[];
  contextThresholdCrossedTotal: number;
  subtasksTotal: number;
  subtasksByStatus: readonly LabeledCount[];
  debateSessionsTotal: number;
  debateSessionsByStatus: readonly LabeledCount[];
}

export interface AgenticMetricsStoreLike {
  getAgenticMetrics(
    runId: string,
    handoffPct: number
  ): Promise<Omit<AgenticMetrics, "runId">>;
}

// ---------------------------------------------------------------------------
// collectAgenticMetrics
// ---------------------------------------------------------------------------

export async function collectAgenticMetrics(
  store: AgenticMetricsStoreLike,
  runId: string,
  options?: { handoffPct?: number | undefined }
): Promise<AgenticMetrics> {
  const handoffPct = options?.handoffPct ?? 70;
  const metrics = await store.getAgenticMetrics(runId, handoffPct);
  return { runId, ...metrics };
}

// ---------------------------------------------------------------------------
// formatPrometheus — Prometheus exposition text
// ---------------------------------------------------------------------------

// Escape per the Prometheus exposition format: backslash, double-quote, and
// newline must be escaped inside a quoted label value. (Braces are legal inside
// a quoted value and need no escaping.)
function sanitizeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export function formatPrometheus(metrics: AgenticMetrics): string {
  const run = sanitizeLabel(metrics.runId);
  const lines: string[] = [];

  lines.push("# HELP archon_agent_invocations_total Agent invocations by status.");
  lines.push("# TYPE archon_agent_invocations_total gauge");
  lines.push(`archon_agent_invocations_total{run_id="${run}"} ${metrics.invocationsTotal}`);
  for (const { label, count } of metrics.invocationsByStatus) {
    lines.push(`archon_agent_invocations_total{run_id="${run}",status="${sanitizeLabel(label)}"} ${count}`);
  }

  lines.push("# HELP archon_agent_handoffs_total Agent handoffs by reason.");
  lines.push("# TYPE archon_agent_handoffs_total gauge");
  lines.push(`archon_agent_handoffs_total{run_id="${run}"} ${metrics.handoffsTotal}`);
  for (const { label, count } of metrics.handoffsByReason) {
    lines.push(`archon_agent_handoffs_total{run_id="${run}",reason="${sanitizeLabel(label)}"} ${count}`);
  }

  lines.push("# HELP archon_context_threshold_crossed_total Invocations that crossed the handoff threshold.");
  lines.push("# TYPE archon_context_threshold_crossed_total gauge");
  lines.push(`archon_context_threshold_crossed_total{run_id="${run}"} ${metrics.contextThresholdCrossedTotal}`);

  lines.push("# HELP archon_subtasks_total Subtasks by status.");
  lines.push("# TYPE archon_subtasks_total gauge");
  lines.push(`archon_subtasks_total{run_id="${run}"} ${metrics.subtasksTotal}`);
  for (const { label, count } of metrics.subtasksByStatus) {
    lines.push(`archon_subtasks_total{run_id="${run}",status="${sanitizeLabel(label)}"} ${count}`);
  }

  lines.push("# HELP archon_debate_sessions_total Debate sessions by status.");
  lines.push("# TYPE archon_debate_sessions_total gauge");
  lines.push(`archon_debate_sessions_total{run_id="${run}"} ${metrics.debateSessionsTotal}`);
  for (const { label, count } of metrics.debateSessionsByStatus) {
    lines.push(`archon_debate_sessions_total{run_id="${run}",status="${sanitizeLabel(label)}"} ${count}`);
  }

  return `${lines.join("\n")}\n`;
}
