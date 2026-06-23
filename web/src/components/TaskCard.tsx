/**
 * TaskCard — a task appearing in a swimlane column.
 *
 * Displays: taskId (mono) | title | status dot | ownerRole (mono) | gate state row.
 * Left border stripe encodes the gate state for this column's role:
 *   blocked  → --status-error stripe (3px)
 *   pending  → --status-pending stripe (3px)
 *   passed   → --status-success stripe (3px) + ✓ PASSED badge (no opacity reduction)
 *   waived   → --status-muted stripe (3px)
 *
 * Accessibility: NO opacity reduction on passed state (WCAG AA contrast, item 1).
 * Settled/passed state is communicated via the success border stripe + passed badge.
 *
 * Radius: --radius-md (4px) — data surface.
 * No box-shadow — elevation via luminance step (surface-raised).
 */

import type {
  ReviewGateViewModel,
  ReviewState,
  ReviewSeverity,
  TaskQueueEntryViewModel,
} from "../types/dashboard.ts";

interface TaskCardProps {
  task: TaskQueueEntryViewModel;
  gate: ReviewGateViewModel;
}

/*
 * Gate state dot + text colors.
 * Dot colors: UI components — 3:1 contrast ratio acceptable (non-text).
 * Text colors: text labels — must meet WCAG AA 4.5:1 on --surface-raised (#111111).
 *
 * --status-pending (#6366F1, indigo) ≈ 3.5:1 on #111111 — insufficient for text.
 * --status-pending-text (#A5B4FC, indigo-300) ≈ 8.0:1 on #111111 — AAA, use for text labels.
 */
const GATE_STATE_DOT_COLOR: Record<ReviewState, string> = {
  pending: "var(--status-pending)",       // dot: 3:1 OK for non-text UI
  blocked: "var(--status-error)",         // dot: 3:1 OK for non-text UI
  passed:  "var(--status-success)",
  waived:  "var(--status-muted)",
};

const GATE_STATE_TEXT_COLOR: Record<ReviewState, string> = {
  pending: "var(--status-pending-text)",  // text: AA-compliant lighter variant
  blocked: "var(--status-error-text)",    // text: AA-compliant lighter variant
  passed:  "var(--status-success)",
  waived:  "var(--status-muted)",
};

const TASK_STATUS_COLOR: Record<string, string> = {
  in_progress:    "var(--status-running)",
  review_blocked: "var(--status-error-text)",   // text label — AA variant
  blocked:        "var(--status-error-text)",
  approved:       "var(--status-success)",
  done:           "var(--status-success)",
  ready:          "var(--status-pending-text)", // text label — AA variant
};

const TASK_STATUS_DOT_COLOR: Record<string, string> = {
  in_progress:    "var(--status-running)",
  review_blocked: "var(--status-error)",    // dot: UI component, 3:1 OK
  blocked:        "var(--status-error)",
  approved:       "var(--status-success)",
  done:           "var(--status-success)",
  ready:          "var(--status-pending)",
};

const SEVERITY_COLOR: Record<ReviewSeverity, string> = {
  critical: "var(--status-error-text)", // text label — AA variant
  high:     "var(--status-error-text)",
  medium:   "var(--status-warning)",
  low:      "var(--text-secondary)",
};

export function TaskCard({ task, gate }: TaskCardProps) {
  const gateDotColor  = GATE_STATE_DOT_COLOR[gate.state];
  const gateTextColor = GATE_STATE_TEXT_COLOR[gate.state];
  const taskStatusDotColor  = TASK_STATUS_DOT_COLOR[task.status] ?? "var(--status-muted)";
  const taskStatusTextColor = TASK_STATUS_COLOR[task.status]    ?? "var(--text-secondary)";
  const isPassed = gate.state === "passed";

  return (
    <article
      className={`task-card task-card--${gate.state}`}
      style={{
        /*
         * Item 1: NO opacity reduction on passed state.
         * Left border stripe color communicates gate state — no blanket dimming.
         */
        borderLeftColor: gateDotColor,
      }}
      aria-label={`Task ${task.taskId}: ${task.title}, gate state: ${gate.state}`}
    >
      {/* Row 1: task ID + owner */}
      <div className="task-card__row">
        <span className="task-card__id mono">{task.taskId}</span>
        <span className="task-card__owner mono">{task.ownerRole}</span>
      </div>

      {/* Row 2: title */}
      <div className="task-card__title">{task.title}</div>

      {/* Row 3: task status */}
      <div className="task-card__row">
        <span
          className="task-card__status"
          style={{ color: taskStatusTextColor }}
          aria-label={`Task status: ${task.status}`}
        >
          <span
            className={
              task.status === "in_progress"
                ? "task-dot pulse-running"
                : "task-dot"
            }
            style={{ backgroundColor: taskStatusDotColor }}
            aria-hidden="true"
          />
          {task.status}
        </span>
      </div>

      {/* Row 4: gate state */}
      <div className="task-card__gate-row" aria-label={`${gate.role} gate: ${gate.state}`}>
        <span className="task-card__gate-label mono">{gate.role} gate</span>
        <span
          className="task-card__gate-state mono"
          style={{ color: gateTextColor }}
        >
          <span
            className="task-dot"
            style={{ backgroundColor: gateDotColor }}
            aria-hidden="true"
          />
          {gate.state}
        </span>

        {/* Severity badge — error/critical/high use AA text variant */}
        {gate.severity && gate.state === "blocked" && (
          <span
            className="task-card__severity mono"
            style={{ color: SEVERITY_COLOR[gate.severity] }}
            aria-label={`Severity: ${gate.severity}`}
          >
            {gate.severity.toUpperCase()}
          </span>
        )}

        {/*
         * Passed state: actor + check badge.
         * Item 1: replaces opacity trick — passed state communicated via badge.
         * Not dimmed; the success stripe + badge carry the "settled" signal.
         */}
        {isPassed && (
          <span
            className="task-card__passed-badge mono"
            aria-label={gate.actor ? `Reviewed by ${gate.actor}` : "Gate passed"}
          >
            {gate.actor ? gate.actor : "passed"}
          </span>
        )}
      </div>
    </article>
  );
}
