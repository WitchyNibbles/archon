/**
 * RunHeader — one 48px row below the topbar (spec section 2).
 *
 * Contains: run title | runId (mono) | status badge | authority badge | updatedAt (mono)
 * Right side: PulseDot | SnapshotAge | updatedAt
 *
 * P1-S2b (C5): adds SnapshotAge to show how old the snapshot file is.
 * DISTINCT signals in the right rail:
 *   PulseDot    — live run state (running/blocked/idle)
 *   SnapshotAge — when this view was generated ("snapshot 3m old")
 *   updatedAt   — when the run data was last written in the database
 *
 * The run title is h1 for the page (landmark heading). One h1 per page.
 */

import type { RunHeaderViewModel } from "../types/dashboard.ts";
import { AuthorityBadge } from "./AuthorityBadge.tsx";
import { PulseDot } from "./PulseDot.tsx";
import { SnapshotAge } from "./SnapshotAge.tsx";
import { FeedStatus } from "./FeedStatus.tsx";
import type { RunPulseViewModel } from "../types/dashboard.ts";

interface RunHeaderProps {
  header: RunHeaderViewModel;
  pulse: RunPulseViewModel;
  /** ISO timestamp when the snapshot file was generated (P1-S2b, C5). */
  generatedAt: string;
  /** Auto-refresh health — "stale" shows a distinct reconnecting indicator (S2, C4). */
  feedPhase: "live" | "stale";
  /** Consecutive failed polls, surfaced for operator diagnosis (S2, C4). */
  feedErrors: number;
}

/*
 * Status text colors for the run header status badge (visible text — must meet WCAG AA ≥4.5:1).
 * --status-pending (#6366F1) ≈ 3.5:1 on dark surface — fails AA for text.
 * --status-pending-text (#A5B4FC) ≈ 8.0:1 — AAA, correct for text labels.
 * --status-error (#EF4444) ≈ 3.5:1 — fails AA for text; use --status-error-text (#F87171 ≈ 4.6:1).
 */
const STATUS_COLOR: Record<string, string> = {
  in_progress:    "var(--status-running)",
  review_blocked: "var(--status-error-text)",
  done:           "var(--status-success)",
  approved:       "var(--status-success)",
  memorized:      "var(--status-success)",
  ready:          "var(--status-pending-text)",
  planned:        "var(--status-pending-text)",
  decomposed:     "var(--status-pending-text)",
  intake:         "var(--status-pending-text)",
};

function formatTimestamp(iso: string): string {
  // Display as compact UTC: 2026-06-23 14:32Z
  // Item 8: guard against Invalid Date (new Date("bad") does not throw;
  // isNaN(d.getTime()) is the correct check).
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return iso;
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}Z`;
}

export function RunHeader({ header, pulse, generatedAt, feedPhase, feedErrors }: RunHeaderProps) {
  const statusColor = STATUS_COLOR[header.status] ?? "var(--status-muted)";

  /*
   * Axe fix: <header> is the correct semantic element here.
   * <header> inside <main> maps to the "sectionheader" role (not "banner"),
   * which is valid. Using role="banner" on a <div> inside <main> is invalid
   * per ARIA spec (banner must be at the document/body landmark level).
   * Native <header> semantics + no explicit role is correct.
   */
  return (
    <header className="run-header">
      <div className="run-header__left">
        <h1 className="run-header__title">{header.title}</h1>
        <span className="run-header__id mono" aria-label={`Run ID: ${header.runId}`}>
          {header.runId}
        </span>
        <span
          className="status-badge"
          style={{ color: statusColor }}
          aria-label={`Status: ${header.status}`}
        >
          <span
            className="status-badge__dot"
            style={{ backgroundColor: statusColor }}
            aria-hidden="true"
          />
          {header.status}
        </span>
        {/*
         * Sealed badge: shown when all tasks are approved/done/memorized.
         * Uses --status-success-text (AA-safe, 10.8:1 on dark surface).
         * Does NOT replace the authority badge — both remain visible.
         * No second accent: success green is a semantic status color only.
         */}
        {header.sealed && (
          <span
            className="sealed-badge mono"
            aria-label="Run sealed: all tasks complete"
            data-testid="sealed-badge"
          >
            Sealed
          </span>
        )}
        <AuthorityBadge authorityLabel={header.authorityLabel} />
      </div>
      <div className="run-header__right">
        {/*
         * FeedStatus: is auto-refresh currently succeeding? DISTINCT from PulseDot
         * (run state), SnapshotAge (view age), and updatedAt (DB write time). When
         * the poll loop is failing this shows "reconnecting…" so the on-screen data
         * is never mistaken for a fresh poll (C4).
         */}
        <FeedStatus phase={feedPhase} consecutiveErrors={feedErrors} />
        <PulseDot
          pulseState={pulse.pulseState}
          activeLockCount={pulse.activeLockCount}
        />
        {/*
         * SnapshotAge: how old is the snapshot file (view staleness).
         * DISTINCT from updatedAt (data freshness) and AuthorityBadge (trust level).
         * Visual distinction: plain mono text with "snapshot" prefix vs the indigo
         * authority pill and the run data timestamp with no prefix.
         */}
        <SnapshotAge generatedAt={generatedAt} />
        <span className="run-header__updated mono" aria-label={`Last updated: ${header.updatedAt}`}>
          {formatTimestamp(header.updatedAt)}
        </span>
      </div>
    </header>
  );
}
