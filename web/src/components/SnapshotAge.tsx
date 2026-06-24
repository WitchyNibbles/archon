/**
 * SnapshotAge — renders a snapshot-generation-age signal (C5, P1-S2b).
 *
 * DISTINCT FROM:
 *   AuthorityBadge  → encodes data TRUST level (runtime_authoritative vs derived_only)
 *   header.updatedAt → when the run record was last written in the database
 *   SnapshotAge      → when the snapshot file was generated (how stale is this view)
 *
 * Design:
 *   - Geist Mono, 10px, --text-secondary (#A0A0A0 on #0A0A0A — AAA 7.6:1)
 *   - Prefix "snapshot" + relative age in parentheses makes the semantic clear
 *   - <time datetime="..."> for machine-readable semantics (WCAG 1.3.1)
 *   - Left border separator to group it visually in the right rail, separate from
 *     the updatedAt span that has the same separator treatment
 *   - NOT an indigo pill (that shape is reserved for authority labels only)
 *   - Role "status" is intentionally NOT used — this is static metadata, not a live alert
 *
 * Accessibility:
 *   - aria-label="Snapshot generated X ago" provides an accessible name that
 *     does not rely on color or position alone
 *   - Text is always readable (color is supplementary, not the only differentiator)
 *   - Contrast: --text-secondary (#A0A0A0) on --surface-base (#0A0A0A) = 7.6:1 (AAA)
 */

/** Format a UTC ISO string as a relative age string, e.g. "3m", "2h", "1d". */
function formatRelativeAge(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    // Malformed date — show the raw string rather than nothing
    return isoString;
  }
  const nowMs = Date.now();
  const ageMs = nowMs - d.getTime();

  if (ageMs < 0) {
    // Clock skew or future-dated snapshot — show "just now"
    return "just now";
  }

  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(ageMs / 86_400_000);
  return `${days}d`;
}

interface SnapshotAgeProps {
  generatedAt: string;
}

export function SnapshotAge({ generatedAt }: SnapshotAgeProps) {
  const relativeAge = formatRelativeAge(generatedAt);
  // "just now" (clock-skew / future-dated snapshot) is already a complete phrase:
  // appending " ago"/" old" yields the incoherent "just now ago" / "just now old"
  // (read verbatim by screen readers — WCAG 1.3.1). Drop the suffix in that case.
  const isJustNow = relativeAge === "just now";
  const accessibleLabel = isJustNow
    ? "Snapshot generated just now"
    : `Snapshot generated ${relativeAge} ago`;

  return (
    <span
      className="snapshot-age"
      aria-label={accessibleLabel}
      data-testid="snapshot-age"
    >
      {/*
       * "snapshot" prefix makes this semantically distinct from the
       * run data-freshness timestamp (which uses no prefix).
       * The <time> element gives machines the ISO timestamp.
       */}
      snapshot{" "}
      <time dateTime={generatedAt} className="snapshot-age__value mono">
        {relativeAge}
      </time>
      {/* "old" suffix only when the value is a duration, not the "just now" phrase. */}
      {isJustNow ? null : <>{" "}old</>}
    </span>
  );
}
