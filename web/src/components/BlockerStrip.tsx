/**
 * BlockerStrip — HERO region (spec section 1, AG-015).
 *
 * Full-width, pinned strip directly under the topbar. Renders horizontal
 * scrolling blocker pills. Never disappears — empty state shows a calm
 * "no active blockers" row (disappearing UI is disorienting per spec).
 *
 * Blocker classification (forgeDashboardBlockerClarity):
 * - advisory:false → HERO panel (error/warning tinted, dominant)
 * - advisory:true  → SEPARATE "Advisories (N)" section (muted, de-emphasised)
 *
 * Each pill: kind badge | taskId | reason (2-line clamp) | first nextAction.
 * Blocked kind = red left-stripe. Warning kinds (stale_recovery, generic) = amber.
 * Reasoning_quality kind = muted (advisory-only).
 *
 * Visual dominance: --status-error tint background + error border bottom (AG-015).
 *
 * Accessibility (items 3, 11):
 * - kind label TEXT uses --status-error-text / --status-warning (AA-compliant).
 *   Left stripe and pill border use raw error/warning for UI components (3:1 OK).
 * - Pill border colors referenced via CSS vars (--blocker-pill-border-error/warning)
 *   defined in :root — no inline rgba literals (AG-013).
 */

import type { BlockerViewModel, BlockerKind } from "../types/dashboard.ts";

interface BlockerStripProps {
  blockers: BlockerViewModel[];
}

const WARNING_KINDS: BlockerKind[] = ["stale_recovery", "generic"];

function isWarningKind(kind: BlockerKind): boolean {
  return WARNING_KINDS.includes(kind);
}

function BlockerPill({ blocker }: { blocker: BlockerViewModel }) {
  const isWarning = isWarningKind(blocker.kind);

  /*
   * Left stripe and pill border: UI component colors (3:1 sufficient for non-text).
   * Kind label TEXT: AA-compliant text variants via CSS vars.
   * Border color: tokenised CSS vars (AG-013, item 11).
   */
  const stripeColor    = isWarning ? "var(--status-warning)"       : "var(--status-error)";
  const kindTextColor  = isWarning ? "var(--status-warning)"       : "var(--status-error-text)";
  const borderColorVar = isWarning
    ? "var(--blocker-pill-border-warning)"
    : "var(--blocker-pill-border-error)";

  const firstAction = blocker.nextActions[0];

  return (
    <article
      className="blocker-pill"
      style={{
        /* item 11: CSS vars from :root, no inline rgba literals */
        borderColor:     borderColorVar,
        borderLeftColor: stripeColor,
      }}
      aria-label={`${blocker.kind} blocker${blocker.taskId ? ` for ${blocker.taskId}` : ""}`}
    >
      <div className="blocker-pill__meta">
        {/* item 3: kind label uses AA-compliant text color */}
        <span
          className="blocker-pill__kind mono"
          style={{ color: kindTextColor }}
        >
          {blocker.kind}
        </span>
        {blocker.taskId && (
          <span className="blocker-pill__taskid mono">{blocker.taskId}</span>
        )}
      </div>
      <p className="blocker-pill__reason">{blocker.reason}</p>
      {firstAction && (
        <div className="blocker-pill__action">
          <span className="blocker-pill__arrow mono" aria-hidden="true">
            →
          </span>
          <span>{firstAction}</span>
        </div>
      )}
    </article>
  );
}

function AdvisoryPill({ blocker }: { blocker: BlockerViewModel }) {
  const firstAction = blocker.nextActions[0];

  return (
    <article
      className="advisory-pill"
      aria-label={`advisory signal${blocker.taskId ? ` for ${blocker.taskId}` : ""}`}
    >
      <div className="advisory-pill__meta">
        <span className="advisory-pill__kind mono">
          {blocker.kind}
        </span>
        {blocker.taskId && (
          <span className="advisory-pill__taskid mono">{blocker.taskId}</span>
        )}
      </div>
      <p className="advisory-pill__reason">{blocker.reason}</p>
      {firstAction && (
        <div className="advisory-pill__action">
          <span className="advisory-pill__arrow mono" aria-hidden="true">
            →
          </span>
          <span>{firstAction}</span>
        </div>
      )}
    </article>
  );
}

export function BlockerStrip({ blockers }: BlockerStripProps) {
  const realBlockers = blockers.filter((b) => !b.advisory);
  const advisoryBlockers = blockers.filter((b) => b.advisory);
  const hasRealBlockers = realBlockers.length > 0;
  const hasAdvisories = advisoryBlockers.length > 0;

  return (
    <div className="blocker-strip-container">
      {/* HERO: real blockers section */}
      <section
        className={`blocker-strip${hasRealBlockers ? " blocker-strip--active" : " blocker-strip--idle"}`}
        aria-label="Active blockers"
        aria-live="polite"
      >
        <div className="blocker-strip__header">
          <h2 className="blocker-strip__title mono">
            Active Blockers
          </h2>
          {hasRealBlockers && (
            <span
              className="blocker-strip__count mono"
              aria-label={`${realBlockers.length} active blockers`}
            >
              {realBlockers.length}
            </span>
          )}
        </div>

        {hasRealBlockers ? (
          <div
            className="blocker-strip__pills"
            role="list"
            /*
             * tabIndex="0" makes this scrollable region keyboard-accessible
             * (WCAG 2.1 SC 2.1.1, axe rule: scrollable-region-focusable).
             * At narrow viewports the pill row overflows and requires scrolling.
             */
            tabIndex={0}
          >
            {realBlockers.map((b) => (
              <div key={b.id} role="listitem">
                <BlockerPill blocker={b} />
              </div>
            ))}
          </div>
        ) : (
          <div className="blocker-strip__empty">
            <span className="blocker-strip__empty-label mono">
              No active blockers
            </span>
          </div>
        )}
      </section>

      {/* Advisory signals — de-emphasised, NOT hero styling */}
      {hasAdvisories && (
        <section
          className="advisory-strip"
          aria-label={`Advisories (${advisoryBlockers.length})`}
        >
          <div className="advisory-strip__header">
            <h3 className="advisory-strip__title mono">
              Advisories
            </h3>
            <span
              className="advisory-strip__count mono"
              aria-label={`${advisoryBlockers.length} advisory signals`}
            >
              {advisoryBlockers.length}
            </span>
          </div>
          <div
            className="advisory-strip__pills"
            role="list"
            tabIndex={0}
          >
            {advisoryBlockers.map((b) => (
              <div key={b.id} role="listitem">
                <AdvisoryPill blocker={b} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
