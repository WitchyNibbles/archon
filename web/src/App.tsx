/**
 * App — Archon Forge Run Status Dashboard.
 *
 * dashQuality S1: dense flat status-grouped task list (the void is gone); Tabs Tasks/Gates.
 * dashQuality S2 (council C3/C4): the one-shot mount fetch is replaced by a BOUNDED POLL.
 *   - C3: bounded interval poll (no SSE/websocket — the browser reads static JSON only);
 *     chained setTimeout using nextPollDelayMs (steady base, exponential backoff + hard cap
 *     on consecutive errors); the loop PAUSES when the tab is hidden (visibilitychange) and
 *     refetches immediately on resume.
 *   - C4: poll failures are non-destructive — once we have rendered a good snapshot, a failed
 *     poll keeps the last-good render on screen and surfaces a DISTINCT "reconnecting…" feed
 *     state (FeedStatus). The full ErrorPanel only ever shows on an initial-load failure (no
 *     data yet). Staleness stays honest via SnapshotAge (driven by generatedAt) — never
 *     stale-as-fresh.
 *
 * The tab state is local UI state only; no URL routing in this slice.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import { fetchDashboardSnapshot } from "./data/snapshot.ts";
import type { DashboardViewModel } from "./types/dashboard.ts";
import {
  snapshotFeedReducer,
  initialSnapshotFeedState,
  consecutiveErrorsOf,
} from "./utils/snapshotFeed.ts";
import { nextPollDelayMs } from "./utils/pollSchedule.ts";
import { filterTasks, countBlocked, type TaskFilter } from "./utils/taskFilter.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { RunHeader } from "./components/RunHeader.tsx";
import { RunSummary } from "./components/RunSummary.tsx";
import { RunFooter } from "./components/RunFooter.tsx";
import { BlockerStrip } from "./components/BlockerStrip.tsx";
import { GateSwimlane } from "./components/GateSwimlane.tsx";
import { TabBar, type DashboardTab } from "./components/TabBar.tsx";
import { TaskListView } from "./components/TaskListView.tsx";

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

// ── Dashboard (success / stale state) ─────────────────────────────────────────

interface DashboardProps {
  data: DashboardViewModel;
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  /** Feed health — "stale" renders a distinct reconnecting indicator (C4). */
  feedPhase: "live" | "stale";
  feedErrors: number;
  /** In-run Blocked filter state + toggle (S3a). */
  taskFilter: TaskFilter;
  onToggleBlocked: () => void;
}

function Dashboard({
  data,
  activeTab,
  onTabChange,
  feedPhase,
  feedErrors,
  taskFilter,
  onToggleBlocked,
}: DashboardProps) {
  const blockedCount = countBlocked(data.taskQueue);
  // S3a: the Tasks list honors the in-run Blocked filter. Gates tab is unaffected.
  const visibleTasks = filterTasks(data.taskQueue, taskFilter);

  return (
    <div className="app-layout">
      {/* Sidebar: archon mark, run list, views (Blocked = real in-run filter, S3a) */}
      <Sidebar
        currentRun={data.header}
        blockedFilterActive={taskFilter === "blocked"}
        blockedCount={blockedCount}
        onToggleBlocked={onToggleBlocked}
      />

      {/* Main content area */}
      <main className="main">
        {/* Topbar: run title, runId, status, authority badge, pulse, snapshot age, feed status */}
        <RunHeader
          header={data.header}
          pulse={data.pulse}
          generatedAt={data.generatedAt}
          feedPhase={feedPhase}
          feedErrors={feedErrors}
        />

        {/* Run-level progress strip (S4): segmented status meter + counts + gate
            tally. The primary void-killer — adds "how far along is this run" signal. */}
        <RunSummary taskQueue={data.taskQueue} reviewGates={data.reviewGates} />

        {/* Tab bar: Tasks (default) / Gates — underline-only active state (C10) */}
        <TabBar activeTab={activeTab} onTabChange={onTabChange} />

        {/* HERO: blocker strip — always rendered, dominant when blockers exist */}
        <BlockerStrip blockers={data.blockers} />

        {/* Tasks tab panel: flat status-grouped task list — honors the Blocked filter (S3a) */}
        {activeTab === "tasks" && (
          <TaskListView
            taskQueue={visibleTasks}
            reviewGates={data.reviewGates}
            blockers={data.blockers}
            filterActive={taskFilter === "blocked"}
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

        {/* Persistent run status bar (S4): gate legend (decodes REV/SEC/QA chips)
            + lock echo + authority honesty. Brackets the task-list tail so a
            sparse run no longer reads as a dead void. */}
        <RunFooter pulse={data.pulse} authorityLabel={data.header.authorityLabel} />
      </main>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [feed, dispatch] = useReducer(snapshotFeedReducer, initialSnapshotFeedState);
  const [activeTab, setActiveTab] = useState<DashboardTab>("tasks");
  // S3a: in-run Blocked filter — local UI state (no routing in this slice).
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");

  // Authoritative backoff counter for the poll loop. It is NOT derived from `feed` on
  // render: after dispatch() React batches the state update, so reading it post-dispatch
  // would be a render behind (e.g. on recovery the loop would back off as if still
  // failing). The counter is therefore advanced synchronously from each poll's OUTCOME
  // (0 on success, +1 on failure) so nextPollDelayMs always sees the true current count.
  const errorsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function clearTimer() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }

    async function poll() {
      if (inflight) return; // C3: at most one poll in flight (no concurrent fetches)
      inflight = true;
      let nextErrors = errorsRef.current;
      try {
        const data = await fetchDashboardSnapshot();
        if (cancelled) return;
        nextErrors = 0;
        dispatch({ type: "poll_succeeded", data, at: Date.now() });
      } catch (err: unknown) {
        if (cancelled) return;
        nextErrors = errorsRef.current + 1;
        const message =
          err instanceof Error ? err.message : "Unknown error loading snapshot";
        dispatch({ type: "poll_failed", message });
      } finally {
        inflight = false;
      }
      if (cancelled) return;
      errorsRef.current = nextErrors;
      // C3: schedule the next poll with the freshly-computed backoff. Skip while hidden —
      // the visibilitychange handler resumes the loop on return.
      schedule(nextErrors);
    }

    function schedule(errors: number) {
      clearTimer();
      if (typeof document !== "undefined" && document.hidden) {
        return; // paused; visibilitychange will resume
      }
      timer = setTimeout(poll, nextPollDelayMs(errors));
    }

    function handleVisibility() {
      if (typeof document === "undefined") return;
      if (document.hidden) {
        clearTimer(); // C3: pause polling on a hidden tab
      } else {
        // Resume with an immediate refresh so a returning operator sees current state.
        void poll();
      }
    }

    // Initial load.
    void poll();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, []);

  if (feed.phase === "loading") {
    return <DashboardSkeleton />;
  }

  // C4: full ErrorPanel only when there is NO data at all (initial load failed).
  if (feed.phase === "error") {
    return <ErrorPanel message={feed.message} />;
  }

  // live | stale — both render the dashboard with last-good data; stale adds the
  // distinct reconnecting indicator (never wipes a good dashboard, never fake-fresh).
  return (
    <Dashboard
      data={feed.data}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      feedPhase={feed.phase}
      feedErrors={consecutiveErrorsOf(feed)}
      taskFilter={taskFilter}
      onToggleBlocked={() =>
        setTaskFilter((f) => (f === "blocked" ? "all" : "blocked"))
      }
    />
  );
}
