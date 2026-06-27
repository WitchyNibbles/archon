/**
 * RunFooter — persistent run status bar at the bottom of the main column (S4).
 *
 * Two jobs:
 *   1. Bracket the void. The task list is `flex: 1` and a sparse run leaves a
 *      large empty tail; a fixed-height footer caps it with real signal so the
 *      content area reads as "bracketed" rather than "the app stopped."
 *   2. Decode the gate mini-pills. The REV / SEC / QA chips on task rows are
 *      cryptic without a key — this footer carries the legend (role + state
 *      color meaning) so the dense rows become legible at a glance.
 *
 * Distinct from RunHeader's PulseDot: the header dot is the live run-state badge;
 * this footer is reference (legend) + a compact lock echo. No second accent; all
 * colors are semantic status tokens. Counts/labels use AA-safe -text variants.
 *
 * R2-C boundary: web-local types only; no import from src/.
 */

import type {
  AuthorityLabel,
  RunPulseViewModel,
} from "../types/dashboard.ts";

interface RunFooterProps {
  pulse: RunPulseViewModel;
  authorityLabel: AuthorityLabel;
}

/** Gate role legend entries — mirrors GATE_ROLE_ABBREV in TaskRow. */
const GATE_LEGEND: ReadonlyArray<{ abbrev: string; role: string }> = [
  { abbrev: "REV", role: "reviewer" },
  { abbrev: "SEC", role: "security" },
  { abbrev: "QA", role: "qa" },
];

/** Gate-state color key — mirrors GATE_STATE_PILL_COLOR in TaskRow. */
const STATE_KEY: ReadonlyArray<{ label: string; color: string }> = [
  { label: "passed", color: "var(--status-success-text)" },
  { label: "pending", color: "var(--status-pending-text)" },
  { label: "blocked", color: "var(--status-error-text)" },
];

export function RunFooter({ pulse, authorityLabel }: RunFooterProps) {
  return (
    <footer className="run-footer" aria-label="Run status legend">
      {/* Gate legend — decodes the REV/SEC/QA row chips. */}
      <div className="run-footer__legend" aria-hidden="true">
        <span className="run-footer__legend-title mono">gates</span>
        {GATE_LEGEND.map((g) => (
          <span key={g.abbrev} className="run-footer__legend-item mono">
            <span className="run-footer__legend-abbrev">{g.abbrev}</span>
            <span className="run-footer__legend-role">{g.role}</span>
          </span>
        ))}
        <span className="run-footer__legend-sep" />
        {STATE_KEY.map((s) => (
          <span key={s.label} className="run-footer__state-item mono">
            <span
              className="run-footer__state-swatch"
              style={{ backgroundColor: s.color }}
            />
            <span className="run-footer__state-label">{s.label}</span>
          </span>
        ))}
      </div>

      {/* Right rail: lock echo + authority honesty reminder. */}
      <div className="run-footer__meta mono">
        <span className="run-footer__locks">
          {pulse.activeLockCount} lock{pulse.activeLockCount === 1 ? "" : "s"}
        </span>
        <span className="run-footer__authority">{authorityLabel}</span>
      </div>
    </footer>
  );
}
