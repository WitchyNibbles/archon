/**
 * Snapshot feed state machine — dashQuality S2 (council C4).
 *
 * Encodes the non-destructive refresh contract: once the dashboard has rendered a
 * good snapshot, a failed poll must NOT wipe the screen to the full ErrorPanel. The
 * feed instead enters a distinct `stale` phase that keeps the last-good data on screen
 * while signalling that auto-refresh is currently failing. A later success returns
 * cleanly to `live` with fresh data and a reset backoff counter.
 *
 * Phases:
 *   loading — initial mount, no data yet
 *   error   — initial load failed, still no data (ErrorPanel)
 *   live    — last poll succeeded; data is current
 *   stale   — last poll failed but we hold prior good data (distinct, never fake-fresh)
 *
 * Pure + dependency-free (type imports erase at runtime) so it is unit-tested with the
 * root node:test runner (tests/dash-snapshot-feed.test.ts); the R2-C web→src wall is
 * one-directional and unaffected.
 */

import type { DashboardViewModel } from "../types/dashboard.ts";

export type SnapshotFeedState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "live"; data: DashboardViewModel; lastUpdatedAt: number; consecutiveErrors: 0 }
  | {
      phase: "stale";
      data: DashboardViewModel;
      lastUpdatedAt: number;
      consecutiveErrors: number;
      message: string;
    };

export type SnapshotFeedAction =
  | { type: "poll_succeeded"; data: DashboardViewModel; at: number }
  | { type: "poll_failed"; message: string };

export const initialSnapshotFeedState: SnapshotFeedState = { phase: "loading" };

/** Last-good data + its freshness stamp, if the feed currently has any. */
function lastGood(
  state: SnapshotFeedState
): { data: DashboardViewModel; lastUpdatedAt: number } | undefined {
  if (state.phase === "live" || state.phase === "stale") {
    return { data: state.data, lastUpdatedAt: state.lastUpdatedAt };
  }
  return undefined;
}

/** Consecutive failure count since the last success (0 unless currently stale). */
export function consecutiveErrorsOf(state: SnapshotFeedState): number {
  return state.phase === "stale" ? state.consecutiveErrors : 0;
}

export function snapshotFeedReducer(
  state: SnapshotFeedState,
  action: SnapshotFeedAction
): SnapshotFeedState {
  switch (action.type) {
    case "poll_succeeded":
      // Any success → live, with fresh data, a freshness stamp, and a reset counter.
      return {
        phase: "live",
        data: action.data,
        lastUpdatedAt: action.at,
        consecutiveErrors: 0,
      };

    case "poll_failed": {
      const prior = lastGood(state);
      if (prior) {
        // C4: preserve last-good render; distinct stale phase; bump the backoff counter.
        return {
          phase: "stale",
          data: prior.data,
          lastUpdatedAt: prior.lastUpdatedAt,
          consecutiveErrors: consecutiveErrorsOf(state) + 1,
          message: action.message,
        };
      }
      // No prior good data (initial load failed) → hard error (ErrorPanel).
      return { phase: "error", message: action.message };
    }

    default:
      return state;
  }
}
