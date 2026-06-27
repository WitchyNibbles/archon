/**
 * Snapshot age utilities — C11 stale-color escalation.
 *
 * Extracted from SnapshotAge.tsx to satisfy the react-refresh/only-export-components
 * ESLint rule (a file must not export both components and non-component functions).
 *
 * C11 thresholds:
 *   < 5 min  → --text-secondary   (fresh; no alarm)
 *   5–60 min → --status-warning-text  (stale; amber; 9.5:1 AAA on #111)
 *   > 60 min → --status-error-text    (very stale; red; 4.57:1 AA on #111)
 */

/**
 * Returns the CSS color token string for the snapshot age indicator based on
 * how many minutes old the snapshot is.
 */
export function snapshotAgeColor(ageMinutes: number): string {
  if (ageMinutes >= 60) return "var(--status-error-text)";
  if (ageMinutes >= 5)  return "var(--status-warning-text)";
  return "var(--text-secondary)";
}
