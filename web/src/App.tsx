/**
 * App — Archon Forge Run Status Dashboard (dashQuality S1).
 *
 * Changes from Phase 0:
 *   - Loading: full-shell skeleton (sidebar + header stay, shimmer rows in
 *     content area). NOT a centered full-page spinner (council condition C12).
 *   - Tab bar: Tasks (default) / Gates below RunHeader, above BlockerStrip.
 *     Underline-only active state, roving tabindex keyboard nav (C10).
 *   - Tasks tab (default): flat status-grouped TaskListView — renders ALL
 *     taskQueue entries. The void is gone.
 *   - Gates tab: GateSwimlane demoted here; kept, not deleted (C14).
 *   - Error state: unchanged — ErrorPanel still shows on initial load failure.
 *
 * The tab state is local UI state only; no URL routing in this slice.
 */

import { useEffect, useState } from "react";
import { fetchDashboardSnapshot } from "./data/snapshot.ts";
import type { DashboardViewModel } from "./types/dashboard.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { RunHeader } from "./components/RunHeader.tsx";
import { BlockerStrip } from "./components/BlockerStrip.tsx";
import { GateSwimlane } from "./components/GateSwimlane.tsx";
import { TabBar, type DashboardTab } from "./components/TabBar.tsx";
import { TaskListView } from "./components/TaskListView.tsx";

// ── Load-state machine ────────────────────────────────────────────────────────

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: DashboardViewModel };

// ── Error panel ───────────────────────────────────────────────────────────────

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="state-panel" role="alert" aria-label="Dashboard error">
      <span className="state-panel__error-label">Error</span>
      <p className="state-panel__code">{message}</p>
    </div>
  );
}

// ── Shell skeleton (C12) ──────────────────────────────────────────────────────
//
// Full-shell skeleton: sidebar mark + shimmer blobs, main header shimmer,
// tab bar placeholder, then 5 shimmer rows in the content area.
// Respects prefers-reduced-motion (animation removed, opacity-only fallback).
// No centered full-page spinner.

const SKELETON_ROW_COUNT = 5;

function DashboardSkeleton() {
  return (
    <div
      className="app-layout"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading dashboard"
    >
      {/* Sidebar skeleton */}
      <aside className="sidebar" aria-hidden="true">
        <div className="sidebar__logo">
          <div className="sidebar__mark" />
          <div className="skeleton-blob shimmer" />
        </div>
        <div className="sidebar__section">
          <div className="skeleton-section-label shimmer" />
          <div className="sidebar__item">
            <div className="skeleton-run-item shimmer" />
          </div>
        </div>
      </aside>

      {/* Main skeleton */}
      <main className="main" aria-label="Loading content">
        {/* Run header skeleton */}
        <div className="run-header skeleton-header" aria-hidden="true">
          <div className="skeleton-header__title shimmer" />
          <div className="skeleton-header__meta shimmer" />
        </div>

        {/* Tab bar skeleton — preserves layout; no interactive state */}
        <div className="tab-bar" aria-hidden="true" />

        {/* Shimmer rows */}
        <div
          className="task-list-view"
          aria-hidden="true"
          role="presentation"
        >
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
            <div key={i} className="skeleton-row shimmer" />
          ))}
        </div>
      </main>
    </div>
  );
}

// ── Dashboard (success state) ─────────────────────────────────────────────────

interface DashboardProps {
  data: DashboardViewModel;
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
}

function Dashboard({ data, activeTab, onTabChange }: DashboardProps) {
  return (
    <div className="app-layout">
      {/* Sidebar: archon mark, run list, views */}
      <Sidebar currentRun={data.header} />

      {/* Main content area */}
      <main className="main">
        {/* Topbar: run title, runId, status, authority badge, pulse, snapshot age */}
        <RunHeader
          header={data.header}
          pulse={data.pulse}
          generatedAt={data.generatedAt}
        />

        {/* Tab bar: Tasks (default) / Gates — underline-only active state (C10) */}
        <TabBar activeTab={activeTab} onTabChange={onTabChange} />

        {/* HERO: blocker strip — always rendered, dominant when blockers exist */}
        <BlockerStrip blockers={data.blockers} />

        {/* Tasks tab panel: flat status-grouped task list — renders ALL tasks */}
        {activeTab === "tasks" && (
          <TaskListView
            taskQueue={data.taskQueue}
            reviewGates={data.reviewGates}
            tabPanelId="tabpanel-tasks"
            labelledBy="tab-tasks"
          />
        )}

        {/* Gates tab panel: swimlane view demoted here (C14 — kept, not deleted) */}
        {activeTab === "gates" && (
          <div
            id="tabpanel-gates"
            role="tabpanel"
            aria-labelledby="tab-gates"
            aria-label="Review gate swimlanes"
            className="swimlane-area"
          >
            <GateSwimlane
              taskQueue={data.taskQueue}
              reviewGates={data.reviewGates}
            />
          </div>
        )}
      </main>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<DashboardTab>("tasks");

  useEffect(() => {
    let cancelled = false;

    fetchDashboardSnapshot()
      .then((data) => {
        if (!cancelled) {
          setState({ status: "success", data });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "Unknown error loading snapshot";
          setState({ status: "error", message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return <DashboardSkeleton />;
  }

  if (state.status === "error") {
    return <ErrorPanel message={state.message} />;
  }

  return (
    <Dashboard
      data={state.data}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}
