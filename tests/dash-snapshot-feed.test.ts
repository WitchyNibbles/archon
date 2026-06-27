/**
 * Unit tests for dashQuality S2 snapshot-feed state machine (council C4).
 *
 * `snapshotFeedReducer` is a pure reducer in the isolated web/ workspace (no React/DOM
 * dependency) — unit-tested here with the root node:test runner (R2-C web→src wall
 * unaffected; type imports are erased at runtime).
 *
 * C4: poll/refresh failures preserve the last-good render AND surface a distinct
 * stale/error state; never replace a good dashboard with the full ErrorPanel; never
 * present stale as fresh; recovery returns cleanly to live.
 *
 * Run: node --experimental-strip-types --test tests/dash-snapshot-feed.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  snapshotFeedReducer,
  initialSnapshotFeedState,
  consecutiveErrorsOf,
  type SnapshotFeedState,
} from "../web/src/utils/snapshotFeed.ts";
import type { DashboardViewModel } from "../web/src/types/dashboard.ts";

// Minimal stand-in view models — the reducer never inspects the shape, only carries it.
const dataA = { generatedAt: "2026-06-27T00:00:00Z", _tag: "A" } as unknown as DashboardViewModel;
const dataB = { generatedAt: "2026-06-27T00:01:00Z", _tag: "B" } as unknown as DashboardViewModel;

function succeed(state: SnapshotFeedState, data: DashboardViewModel, at: number): SnapshotFeedState {
  return snapshotFeedReducer(state, { type: "poll_succeeded", data, at });
}
function fail(state: SnapshotFeedState, message: string): SnapshotFeedState {
  return snapshotFeedReducer(state, { type: "poll_failed", message });
}

describe("snapshotFeedReducer — C4 non-destructive feed", () => {
  it("starts in loading with no data", () => {
    assert.equal(initialSnapshotFeedState.phase, "loading");
  });

  it("initial load failure (no data yet) → hard error state", () => {
    const next = fail(initialSnapshotFeedState, "boom");
    assert.equal(next.phase, "error");
    assert.equal(next.phase === "error" && next.message, "boom");
  });

  it("first success → live with data, freshness stamp, zero errors", () => {
    const next = succeed(initialSnapshotFeedState, dataA, 1000);
    assert.equal(next.phase, "live");
    if (next.phase !== "live") throw new Error("unreachable");
    assert.equal(next.data, dataA);
    assert.equal(next.lastUpdatedAt, 1000);
    assert.equal(next.consecutiveErrors, 0);
  });

  it("poll failure AFTER a good render → stale, preserves last-good data (C4)", () => {
    const live = succeed(initialSnapshotFeedState, dataA, 1000);
    const stale = fail(live, "network down");
    assert.equal(stale.phase, "stale");
    if (stale.phase !== "stale") throw new Error("unreachable");
    // Last-good data and its freshness stamp are preserved, NOT wiped to ErrorPanel.
    assert.equal(stale.data, dataA);
    assert.equal(stale.lastUpdatedAt, 1000);
    assert.equal(stale.message, "network down");
    assert.equal(stale.consecutiveErrors, 1);
  });

  it("consecutive failures increment the backoff counter while holding last-good data", () => {
    let s: SnapshotFeedState = succeed(initialSnapshotFeedState, dataA, 1000);
    s = fail(s, "e1");
    s = fail(s, "e2");
    s = fail(s, "e3");
    assert.equal(s.phase, "stale");
    if (s.phase !== "stale") throw new Error("unreachable");
    assert.equal(s.consecutiveErrors, 3);
    assert.equal(s.data, dataA); // still last-good
    assert.equal(consecutiveErrorsOf(s), 3);
  });

  it("recovery: success after stale → back to live, errors reset, fresh data + stamp", () => {
    let s: SnapshotFeedState = succeed(initialSnapshotFeedState, dataA, 1000);
    s = fail(s, "e1");
    s = fail(s, "e2");
    s = succeed(s, dataB, 5000);
    assert.equal(s.phase, "live");
    if (s.phase !== "live") throw new Error("unreachable");
    assert.equal(s.data, dataB);
    assert.equal(s.lastUpdatedAt, 5000);
    assert.equal(s.consecutiveErrors, 0);
  });

  it("recovery from a hard error (no prior data) → success returns to live", () => {
    // Initial load failed (error phase, no data). A later successful poll must
    // recover cleanly to live with fresh data — not get stuck in error.
    const err = fail(initialSnapshotFeedState, "initial boom");
    assert.equal(err.phase, "error");
    const recovered = succeed(err, dataB, 7000);
    assert.equal(recovered.phase, "live");
    if (recovered.phase !== "live") throw new Error("unreachable");
    assert.equal(recovered.data, dataB);
    assert.equal(recovered.lastUpdatedAt, 7000);
    assert.equal(recovered.consecutiveErrors, 0);
  });

  it("consecutiveErrorsOf is 0 for loading, error, and live states", () => {
    assert.equal(consecutiveErrorsOf(initialSnapshotFeedState), 0);
    assert.equal(consecutiveErrorsOf({ phase: "error", message: "x" }), 0);
    assert.equal(consecutiveErrorsOf(succeed(initialSnapshotFeedState, dataA, 1)), 0);
  });

  it("success always stamps the provided time (never presents stale as fresh)", () => {
    const s = succeed(initialSnapshotFeedState, dataA, 42);
    assert.equal(s.phase === "live" && s.lastUpdatedAt, 42);
  });
});
