/**
 * RunSummary — run-level progress strip (dashQuality S4).
 *
 * Sits directly under the RunHeader. Carries the "how far along is this run"
 * signal that the dense task list alone never gave: a segmented progress meter
 * (proportional status bands) + a textual count row + a review-gate pass tally.
 *
 * This is the primary void-killer: it adds high-signal run-level density at the
 * top so a sparse run no longer reads as "the app just stopped."
 *
 * Design discipline:
 *   - AG-001 no gradients — segments are flat status-token fills.
 *   - AG-002 single accent — status colors are semantic, not decorative accents.
 *   - Counts use the AA-safe -text token variants (small text ≥4.5:1).
 *   - The meter is aria-hidden decoration; the accessible summary lives in the
 *     count row text + an aria-label on the region.
 *
 * R2-C boundary: web-local types only; no import from src/.
 */

import type {
  ReviewGateViewModel,
  TaskQueueEntryViewModel,
} from "../types/dashboard.ts";
import { computeRunStats } from "../utils/runStats.ts";

interface RunSummaryProps {
  taskQueue: TaskQueueEntryViewModel[] | readonly TaskQueueEntryViewModel[];
  reviewGates: ReviewGateViewModel[];
}

export function RunSummary({ taskQueue, reviewGates }: RunSummaryProps) {
  const stats = computeRunStats(taskQueue, reviewGates);
  const visibleSegments = stats.segments.filter((s) => s.count > 0);

  const accessibleSummary =
    `Run progress: ${stats.total} ${stats.total === 1 ? "task" : "tasks"}, ` +
    `${stats.blocked} blocked, ${stats.inProgress} in flight, ` +
    `${stats.ready} ready, ${stats.done} done. ` +
    `Review gates: ${stats.gatesPassed} of ${stats.gatesTotal} passed` +
    (stats.gatesBlocked > 0 ? `, ${stats.gatesBlocked} blocked.` : ".");

  return (
    <section className="run-summary" aria-label={accessibleSummary}>
      {/* Segmented progress meter — proportional status bands. Decorative; the
          accessible name on the region carries the numbers. */}
      <div className="run-summary__meter" aria-hidden="true">
        {stats.total === 0 ? (
          <div className="run-summary__meter-empty" />
        ) : (
          visibleSegments.map((seg) => (
            <div
              key={seg.id}
              className="run-summary__meter-seg"
              style={{
                flexGrow: seg.count,
                backgroundColor: seg.fill,
              }}
            />
          ))
        )}
      </div>

      {/* Count row — mono labels, AA-safe colored counts. */}
      <div className="run-summary__counts" aria-hidden="true">
        <span className="run-summary__total mono">
          {stats.total} {stats.total === 1 ? "task" : "tasks"}
        </span>
        {stats.segments.map((seg) => (
          <span key={seg.id} className="run-summary__count mono">
            <span
              className="run-summary__count-num"
              style={{ color: seg.count > 0 ? seg.text : "var(--text-secondary)" }}
            >
              {seg.count}
            </span>{" "}
            <span className="run-summary__count-label">{seg.label}</span>
          </span>
        ))}

        {/* Gate pass tally — pushed to the right rail of the strip. */}
        <span className="run-summary__gates mono">
          <span className="run-summary__gates-label">gates</span>{" "}
          <span
            className="run-summary__gates-num"
            style={{
              color:
                stats.gatesBlocked > 0
                  ? "var(--status-error-text)"
                  : "var(--text-secondary)",
            }}
          >
            {stats.gatesPassed}/{stats.gatesTotal}
          </span>
        </span>
      </div>
    </section>
  );
}
