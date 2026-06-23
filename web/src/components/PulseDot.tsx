/**
 * PulseDot — live status indicator dot + label.
 *
 * Composed into the RunHeader row. Not a standalone layout block.
 * Only the "running" state uses the permitted looping animation (AG-010).
 * Dot size is 7×7px (on the 8px grid via 4px rounding).
 */

import type { PulseState } from "../types/dashboard.ts";

interface PulseDotProps {
  pulseState: PulseState;
  activeLockCount: number;
}

// dotColor = saturated base (fill/dot — 3:1 UI-component contrast is fine).
// textColor = AA-compliant `-text` variant (the label is small text and MUST
// clear 4.5:1; --status-muted #6B6B6B fails AA, so idle routes to muted-text).
const STATE_CONFIG: Record<
  PulseState,
  { dotColor: string; textColor: string; label: string; pulse: boolean }
> = {
  running: { dotColor: "var(--status-running)", textColor: "var(--status-running-text)", label: "LIVE", pulse: true },
  blocked: { dotColor: "var(--status-error)", textColor: "var(--status-error-text)", label: "BLOCKED", pulse: false },
  complete: { dotColor: "var(--status-success)", textColor: "var(--status-success-text)", label: "DONE", pulse: false },
  idle: { dotColor: "var(--status-muted)", textColor: "var(--status-muted-text)", label: "IDLE", pulse: false },
};

export function PulseDot({ pulseState, activeLockCount }: PulseDotProps) {
  const config = STATE_CONFIG[pulseState];

  return (
    <div className="pulse-group" aria-label={`Run status: ${config.label}`}>
      <span
        className={config.pulse ? "pulse-dot pulse-running" : "pulse-dot"}
        style={{ backgroundColor: config.dotColor }}
        aria-hidden="true"
      />
      <span className="pulse-label" style={{ color: config.textColor }}>
        {config.label}
      </span>
      {activeLockCount > 0 && (
        <span className="pulse-locks" aria-label={`${activeLockCount} active locks`}>
          {activeLockCount} lock{activeLockCount !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}
