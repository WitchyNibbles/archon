/**
 * Sidebar — 240px left navigation column.
 *
 * Contains: archon mark + wordmark | run list (active highlighted) | views.
 * The mark is a 20×20px indigo square (--radius-sm). No SVG asset needed.
 *
 * Phase 0: static — the active run is passed as a prop; no routing yet.
 *
 * Accessibility (item 5, WCAG 4.1.2):
 * - The active run item is a non-interactive container with aria-current="page".
 *   No role="link" — it has no real destination in Phase 0.
 * - Placeholder view items use role="button" aria-disabled="true" to signal
 *   they are interactive affordances awaiting implementation — not role="link"
 *   which implies navigation to a URL.
 * Phase 1: replace with <a> or TanStack Router <Link> when routes are wired.
 */

import type { RunHeaderViewModel } from "../types/dashboard.ts";

interface SidebarProps {
  currentRun: RunHeaderViewModel;
}

const RUN_STATUS_DOT_COLOR: Record<string, string> = {
  in_progress: "var(--status-running)",
  review_blocked: "var(--status-error)",
  done: "var(--status-success)",
  approved: "var(--status-success)",
  memorized: "var(--status-success)",
  ready: "var(--status-pending)",
  planned: "var(--status-pending)",
  decomposed: "var(--status-pending)",
  intake: "var(--status-pending)",
};

export function Sidebar({ currentRun }: SidebarProps) {
  const activeDotColor =
    RUN_STATUS_DOT_COLOR[currentRun.status] ?? "var(--status-muted)";

  return (
    <aside className="sidebar" aria-label="Navigation">
      {/* Logo / mark */}
      <div className="sidebar__logo">
        <div className="sidebar__mark" aria-hidden="true" />
        <span className="sidebar__wordmark mono">archon</span>
      </div>

      {/* Run list */}
      <nav className="sidebar__section" aria-label="Runs">
        <div className="sidebar__section-label mono" aria-hidden="true">
          Runs
        </div>
        {/*
         * Active run: non-interactive container.
         * aria-current="page" communicates the active context.
         * No tabIndex, no role="link" — nothing to navigate to in Phase 0.
         */}
        <div
          className="sidebar__item sidebar__item--active"
          aria-current="page"
          aria-label={`Current run: ${currentRun.title}`}
        >
          <span
            className="sidebar__item-dot"
            style={{ backgroundColor: activeDotColor }}
            aria-hidden="true"
          />
          <span className="sidebar__item-label">{currentRun.title}</span>
        </div>
      </nav>

      {/* Views */}
      <nav className="sidebar__section" aria-label="Views">
        <div className="sidebar__section-label mono" aria-hidden="true">
          Views
        </div>
        {/*
         * Placeholder items: role="button" aria-disabled="true" signals
         * "this will be interactive" without implying navigation.
         * Not tabbable (tabIndex omitted from disabled buttons per convention;
         * aria-disabled keeps them in the accessibility tree for screen readers).
         */}
        <div
          className="sidebar__item"
          role="button"
          aria-disabled="true"
          aria-label="All runs (not available in Phase 0)"
        >
          All runs
        </div>
        <div
          className="sidebar__item"
          role="button"
          aria-disabled="true"
          aria-label="Blocked runs (not available in Phase 0)"
        >
          Blocked
        </div>
      </nav>
    </aside>
  );
}
