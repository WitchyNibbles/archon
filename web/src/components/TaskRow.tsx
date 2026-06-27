/**
 * TaskRow — flat list row for the TaskListView (dashQuality S1).
 *
 * HARD RULE: This component is NOT TaskCard. It does not reuse .task-card
 * styles, does not use border-radius on the row, and renders as a flat row —
 * not a padded card with a full border (council condition C10).
 *
 * Structure (single row, ~36px standard / 48px max):
 *   [2px left border] [status dot] [task ID mono] [title] [gate mini-pills] [owner mono]
 *
 * Left border color encodes task status (same palette as TaskCard).
 * Gate mini-pills show one pill per review gate for this task:
 *   blocked  → --status-error-text text
 *   passed   → --status-success-text text
 *   pending  → --status-pending-text text
 *   waived   → --status-muted-text text
 *
 * Pill labels: abbreviated gate role ("REV" / "SEC" / "QA").
 * Pill radius: --radius-sm (2px) — the same data-surface cap used for badges.
 *
 * Empty task list state: handled by TaskListView — not here.
 *
 * A11y:
 *   - role="listitem" — proper list-row semantics; must be inside role="list"
 *     (role="row" requires a table context — axe aria-required-parent violation)
 *   - AG-017 detector checks for role="row" OR role="listitem" (both fine)
 *   - aria-label provides a complete accessible name
 *   - Keyboard: focus-visible outline via CSS
 *
 * Contrast (WCAG AA):
 *   All status dot + text colors are pulled from the existing WCAG-verified
 *   token palette (--status-*-text variants at ≥4.5:1 on --surface-raised).
 */

import { useId, useState } from "react";
import type {
  BlockerViewModel,
  ReviewGateViewModel,
  ReviewState,
  TaskQueueEntryViewModel,
} from "../types/dashboard.ts";

interface TaskRowProps {
  task: TaskQueueEntryViewModel;
  /** All review gates for this task (may be empty). */
  gates: ReviewGateViewModel[];
  /** Blockers attributable to this task — when present the row drills down (S3a). */
  blockers: readonly BlockerViewModel[];
}

// ── Status → left-border + dot color map ─────────────────────────────────────

const STATUS_BORDER_COLOR: Record<string, string> = {
  blocked:        "var(--status-error)",
  review_blocked: "var(--status-error)",
  in_progress:    "var(--status-running)",
  ready:          "var(--status-pending)",
  approved:       "var(--status-success)",
  done:           "var(--status-success)",
};

const STATUS_DOT_COLOR: Record<string, string> = {
  blocked:        "var(--status-error)",
  review_blocked: "var(--status-error)",
  in_progress:    "var(--status-running)",
  ready:          "var(--status-pending)",
  approved:       "var(--status-success)",
  done:           "var(--status-success)",
};

// ── Gate mini-pill colors (text labels — AA-compliant -text variants) ─────────

const GATE_STATE_PILL_COLOR: Record<ReviewState, string> = {
  blocked: "var(--status-error-text)",
  pending: "var(--status-pending-text)",
  passed:  "var(--status-success-text)",
  waived:  "var(--status-muted-text)",
};

const GATE_STATE_PILL_BORDER: Record<ReviewState, string> = {
  blocked: "rgba(239, 68, 68, 0.25)",
  pending: "rgba(99, 102, 241, 0.25)",
  passed:  "rgba(34, 197, 94, 0.25)",
  waived:  "rgba(107, 107, 107, 0.25)",
};

// ── Gate role abbreviations ───────────────────────────────────────────────────

const GATE_ROLE_ABBREV: Record<string, string> = {
  reviewer:         "REV",
  security_reviewer: "SEC",
  qa_engineer:      "QA",
};

// ── Gate mini-pill subcomponent ───────────────────────────────────────────────

function GateMiniPill({ gate }: { gate: ReviewGateViewModel }) {
  const textColor   = GATE_STATE_PILL_COLOR[gate.state] ?? "var(--status-muted-text)";
  const borderColor = GATE_STATE_PILL_BORDER[gate.state] ?? "rgba(107, 107, 107, 0.25)";
  const abbrev      = GATE_ROLE_ABBREV[gate.role] ?? gate.role.slice(0, 3).toUpperCase();

  return (
    <span
      className="gate-mini-pill"
      style={{ color: textColor, borderColor }}
      aria-label={`${gate.role} gate: ${gate.state}`}
    >
      {abbrev}
    </span>
  );
}

// ── TaskRow ───────────────────────────────────────────────────────────────────

export function TaskRow({ task, gates, blockers }: TaskRowProps) {
  const borderColor = STATUS_BORDER_COLOR[task.status] ?? "var(--border-default)";
  const dotColor    = STATUS_DOT_COLOR[task.status]    ?? "var(--status-muted)";
  const isRunning   = task.status === "in_progress";

  const hasDetail = blockers.length > 0;
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();

  // Shared row content (identical whether the row is a static div or an expand button).
  const rowContent = (
    <>
      {/* Status dot */}
      <span
        className={isRunning ? "task-row__dot pulse-running" : "task-row__dot"}
        style={{ backgroundColor: dotColor }}
        aria-hidden="true"
      />

      {/* Task ID — Geist Mono */}
      <span className="task-row__id mono" aria-hidden="true">
        {task.taskId}
      </span>

      {/* Title */}
      <span className="task-row__title">{task.title}</span>

      {/* Gate mini-pills */}
      {gates.length > 0 && (
        <span className="task-row__gates" aria-label="Gate states">
          {gates.map((gate) => (
            <GateMiniPill key={`${task.taskId}-${gate.role}`} gate={gate} />
          ))}
        </span>
      )}

      {/* Owner role — Geist Mono, right-aligned */}
      <span className="task-row__owner mono" aria-label={`Owner: ${task.ownerRole}`}>
        {task.ownerRole}
      </span>

      {/* Drill-down chevron — only when there is detail to reveal (S3a) */}
      {hasDetail && (
        <span className="task-row__chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      )}
    </>
  );

  // No attributable blockers → the original static, non-expandable row.
  if (!hasDetail) {
    return (
      <div className="task-row" role="listitem">
        <div
          className="task-row__line"
          style={{ borderLeftColor: borderColor }}
          aria-label={`Task ${task.taskId}: ${task.title}, status: ${task.status}`}
          tabIndex={0}
        >
          {rowContent}
        </div>
      </div>
    );
  }

  // S3a drill-down: a native <button> toggles an inline detail region naming WHY the
  // task is stuck (blocker reasons + next actions). Native button = free keyboard support.
  const blockerCount = blockers.length;
  return (
    <div className="task-row" role="listitem">
      <button
        type="button"
        className="task-row__line task-row__line--expandable"
        style={{ borderLeftColor: borderColor }}
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={`Task ${task.taskId}: ${task.title}, status: ${task.status}, ${blockerCount} ${blockerCount === 1 ? "blocker" : "blockers"}. ${expanded ? "Collapse" : "Expand"} blocker detail.`}
        onClick={() => setExpanded((v) => !v)}
      >
        {rowContent}
      </button>

      {expanded && (
        <div
          id={detailId}
          className="task-row__detail"
          role="group"
          aria-label={`Blockers for task ${task.taskId}`}
        >
          <ul className="task-row__blockers">
            {blockers.map((b) => (
              <li key={b.id} className="task-row__blocker">
                <span className="task-row__blocker-kind mono">{b.kind}</span>
                <span className="task-row__blocker-reason">{b.reason}</span>
                {b.nextActions.length > 0 && (
                  <ul className="task-row__next-actions">
                    {b.nextActions.map((action, i) => (
                      <li key={i} className="task-row__next-action mono">
                        {action}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
