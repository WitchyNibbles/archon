/**
 * AuthorityBadge — runtime_authoritative vs derived_only pill.
 *
 * "runtime_authoritative" → solid accent pill, label RUNTIME
 * "derived_only"          → ghost pill (surface-elevated bg), label ADVISORY
 *
 * Uses --radius-sm (2px) per the data surface radius cap.
 * Single accent only — no second color introduced here.
 */

import type { AuthorityLabel } from "../types/dashboard.ts";

interface AuthorityBadgeProps {
  authorityLabel: AuthorityLabel;
}

export function AuthorityBadge({ authorityLabel }: AuthorityBadgeProps) {
  if (authorityLabel === "runtime_authoritative") {
    return (
      <span className="badge-pill badge-pill--runtime" aria-label="Authority: runtime authoritative">
        RUNTIME
      </span>
    );
  }

  return (
    <span className="badge-pill badge-pill--advisory" aria-label="Authority: derived only (advisory)">
      ADVISORY
    </span>
  );
}
