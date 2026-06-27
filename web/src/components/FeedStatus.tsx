/**
 * FeedStatus — dashQuality S2 distinct auto-refresh indicator (council C4).
 *
 * Surfaces the health of the bounded poll loop itself, DISTINCT from the three
 * existing right-rail signals:
 *   PulseDot     → live RUN state (running / blocked / idle)
 *   SnapshotAge  → how old the snapshot's generatedAt is (view staleness, color-escalated)
 *   updatedAt    → when the run record was last written in the DB
 *   FeedStatus   → is auto-refresh currently SUCCEEDING? (this component)
 *
 * Two phases:
 *   live  → subtle "auto" affordance: auto-refresh is on and the last poll succeeded.
 *           Static metadata; no aria-live (nothing changed that needs announcing).
 *   stale → loud-but-not-panic "reconnecting…": the last poll failed, so what's on
 *           screen is the last-good render, NOT a fresh one. role="status" + polite
 *           live region announces the transition once. Honest — never fake-fresh.
 *
 * Color is supplementary: the text label ("auto" / "reconnecting…") carries the meaning,
 * so the signal survives for color-blind users and at any contrast (WCAG 1.4.1).
 */

interface FeedStatusProps {
  phase: "live" | "stale";
  /** Consecutive failed polls; surfaced in the title for operator diagnosis. */
  consecutiveErrors?: number;
}

export function FeedStatus({ phase, consecutiveErrors = 0 }: FeedStatusProps) {
  if (phase === "stale") {
    const attempts =
      consecutiveErrors > 0
        ? ` (${consecutiveErrors} failed ${consecutiveErrors === 1 ? "attempt" : "attempts"})`
        : "";
    return (
      <span
        className="feed-status feed-status--stale"
        role="status"
        aria-live="polite"
        aria-label={`Auto-refresh failing; showing last good snapshot${attempts}`}
        title={`Auto-refresh is failing — showing the last good snapshot${attempts}. Retrying with backoff.`}
        data-testid="feed-status"
        data-phase="stale"
      >
        <span className="feed-status__dot" aria-hidden="true" />
        reconnecting…
      </span>
    );
  }

  return (
    <span
      className="feed-status feed-status--live"
      aria-label="Auto-refresh active"
      title="Auto-refresh is active"
      data-testid="feed-status"
      data-phase="live"
    >
      <span className="feed-status__dot" aria-hidden="true" />
      auto
    </span>
  );
}
