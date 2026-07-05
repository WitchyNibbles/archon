---
name: archon-observability
description: Use when a task carries the observability gate, or touches SLI/SLO design, alerting, Grafana dashboards, log-signal quality, or archon's own run telemetry (status / metrics / closure surfaces). Owned by observability-engineer.
---

# Archon Observability

Use when defining or reviewing observability for archon: SLIs/SLOs for runs, alert
rules, Grafana dashboards, log signal quality, or the run-telemetry surfaces archon
already exposes. Goal: make system state visible with real thresholds and actionable
alerts — never round-number guesses, never "no errors in the logs" as proof.

## SLI / SLO framing for archon runs

- **SLI (what to measure):** pick indicators the runtime can faithfully report — run
  completion rate, task advance latency, handoff rate at the context threshold,
  review-gate pass rate, orphaned-task count, injected-prevention hit-rate. Do not
  invent an SLI the tables can't back.
- **SLO (target threshold):** derive from what the autonomous loop must deliver, then
  compute an **error budget** (e.g. "≤ N% of runs stall past M hours"). A threshold
  with no error-budget math is a guess — reject it.
- Every SLO names its measurement command/query and the alert that fires when the
  budget burns.

## Surfaces inventory (verified in src/admin + src/grafana — cite these, not invented ones)

- **`npx tsx src/admin.ts status --run-id <id>`** — active-run/active-task pointers,
  task-queue statuses, authority mismatches. The run-state SLI source.
- **`npx tsx src/admin.ts metrics <run-id> [--format json|prometheus]`** — agentic
  counters from `src/runtime/agentic-metrics.ts` (`collectAgenticMetrics` /
  `formatPrometheus`): `archon_agent_invocations_total{status}`,
  `archon_agent_handoffs_total{reason}`, `archon_subtasks_total{status}`,
  `archon_debate_sessions_total{status}`. The Prometheus format is the scrape surface.
- **Injected-prevention hit-rate** — `InjectionPreventionMetrics` /
  `formatInjectionPreventionPrometheus` in the same module (MPL P4); the primary
  learning-loop SLI.
- **`npx tsx src/admin.ts health`** — runtime/DB reachability (a liveness probe, not a
  correctness proof).
- **`npx tsx src/admin.ts workflow-proof` / `report`** — gate-satisfaction state per
  run/task; the review/verification SLI source.
- **`npx tsx src/admin.ts supervisor-history`** — supervisor/closure history; the run
  closure-signal surface.
- **`src/grafana/`** — the Grafana integration: `config.ts` (`resolveGrafanaConfig` /
  `requireGrafanaConfig`, env-driven), `client.ts`, `tools.ts`, `mcp-server.ts` (MCP
  tools to query/manage Grafana). Dashboards consume the `metrics` Prometheus output.
- **web/ Forge Run-Status dashboard** — the operator-facing UI surface over run status.

Before citing any surface in a review, confirm it still exists in `src/admin.ts` /
`src/runtime/agentic-metrics.ts` / `src/grafana/` — do not cite a surface from memory.

## Alert-worthiness checklist

An alert ships only when ALL hold:
- It maps to a burned/burning error budget on a defined SLO — not a raw spike.
- It is **actionable**: the on-call has a concrete first step (which command/dashboard).
- Signal-to-noise is defended: it stays silent when nothing is wrong (no page-on-every-blip).
- It has a defined severity and an owner.
- Its firing condition is testable against real signal before it ships.

## Log-signal quality bar

- Correct level (error for failures, not info); structured fields over prose blobs.
- **No secret / PII leakage** — never log tokens, credentials, or request payloads that
  carry them.
- Durable structured telemetry over a throwaway print that gets ripped out next week.
- "No errors in the logs" is NEVER proof of correct behavior — verify against the SLI.

## Pitfalls

- Round-number SLOs with no error-budget calculation
- Alerts that page on every spike (low signal-to-noise) or that no one can action
- Citing a dashboard/command that does not exist in `src/admin`/`src/grafana`
- Logging credentials or PII; treating clean logs as a correctness proof
- Instrumenting a throwaway log line where durable structured telemetry is needed

## Verification

- Each SLO shows its measurement command (e.g. `admin.ts metrics <run> --format prometheus`)
  and its error-budget math.
- Each alert is validated against real signal and has severity + owner + first-step.
- The observability gate is not complete while any critical-path trace or alert gap is
  unstated — surface it with a fix or an explicit, owned acceptance.
