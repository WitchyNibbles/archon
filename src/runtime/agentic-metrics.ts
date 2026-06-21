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

// ---------------------------------------------------------------------------
// InjectionPreventionMetrics — MPL P4: injected-prevention hit-rate
// ---------------------------------------------------------------------------

/**
 * Metrics for the primary MPL P4 metric: injected-prevention hit-rate.
 *
 * Primary metric:
 *   archon_injection_prevention_hit_rate — fraction of injection events where
 *   the same mistake fingerprint was NOT repeated in subsequent runs.
 *   Trends up as archon learns (complement of mistake_repeat_rate).
 *
 * Secondary metric:
 *   archon_mistake_repeat_rate — fraction of occurrences that belong to
 *   recurrent fingerprints (P1 baseline). Kept as secondary since it is
 *   gameable (just stop flagging mistakes).
 */
export interface InjectionPreventionMetrics {
  readonly runId: string;
  /** Total anti-patterns injected into agent contexts this run. */
  readonly injectedCount: number;
  /** Count of injection events where the fingerprint was NOT repeated in later runs. */
  readonly preventedCount: number;
  /**
   * Primary P4 metric: preventedCount / injectedCount.
   * Range [0, 1]. Trends up as injection is effective.
   */
  readonly hitRate: number;
  /**
   * Secondary metric: fraction of occurrences in recurrent fingerprints (P1 baseline).
   * Range [0, 1]. Trends down as archon learns.
   */
  readonly mistakeRepeatRate: number;
}

/**
 * Format Prometheus exposition text for injection-prevention metrics.
 *
 * Counters:
 *   archon_injection_prevention_hit_rate        — primary P4 metric (float 0..1)
 *   archon_injection_prevention_injected_total  — total injections
 *   archon_injection_prevention_prevented_total — prevented occurrences
 *   archon_mistake_repeat_rate                  — secondary P1 baseline (float 0..1)
 */
export function formatInjectionPreventionPrometheus(metrics: InjectionPreventionMetrics): string {
  const run = sanitizeLabel(metrics.runId);
  const lines: string[] = [];

  lines.push(
    "# HELP archon_injection_prevention_hit_rate Fraction of injected anti-patterns that prevented a mistake repeat."
  );
  lines.push("# TYPE archon_injection_prevention_hit_rate gauge");
  lines.push(`archon_injection_prevention_hit_rate{run_id="${run}"} ${metrics.hitRate}`);

  lines.push(
    "# HELP archon_injection_prevention_injected_total Total anti-patterns injected into agent contexts."
  );
  lines.push("# TYPE archon_injection_prevention_injected_total gauge");
  lines.push(
    `archon_injection_prevention_injected_total{run_id="${run}"} ${metrics.injectedCount}`
  );

  lines.push(
    "# HELP archon_injection_prevention_prevented_total Anti-pattern injections that prevented a repeat."
  );
  lines.push("# TYPE archon_injection_prevention_prevented_total gauge");
  lines.push(
    `archon_injection_prevention_prevented_total{run_id="${run}"} ${metrics.preventedCount}`
  );

  lines.push(
    "# HELP archon_mistake_repeat_rate Fraction of mistake occurrences that are recurrent (secondary P1 baseline)."
  );
  lines.push("# TYPE archon_mistake_repeat_rate gauge");
  lines.push(`archon_mistake_repeat_rate{run_id="${run}"} ${metrics.mistakeRepeatRate}`);

  return `${lines.join("\n")}\n`;
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
