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

const STATE_CONFIG: Record<
  PulseState,
  { color: string; label: string; pulse: boolean }
> = {
  running: { color: "var(--status-running)", label: "LIVE", pulse: true },
  blocked: { color: "var(--status-error)", label: "BLOCKED", pulse: false },
  complete: { color: "var(--status-success)", label: "DONE", pulse: false },
  idle: { color: "var(--status-muted)", label: "IDLE", pulse: false },
};

export function PulseDot({ pulseState, activeLockCount }: PulseDotProps) {
  const config = STATE_CONFIG[pulseState];

  return (
    <div className="pulse-group" aria-label={`Run status: ${config.label}`}>
      <span
        className={config.pulse ? "pulse-dot pulse-running" : "pulse-dot"}
        style={{ backgroundColor: config.color }}
        aria-hidden="true"
      />
      <span className="pulse-label" style={{ color: config.color }}>
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
