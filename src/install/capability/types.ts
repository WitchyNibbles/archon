// FROZEN CONTRACT after S1 — changes require a named migration (council C14).
// This file is the single source of truth for probe and report types consumed by
// all capability surfaces: verify, doctor (S2), init post-check (S4), and CI.
// Do NOT rename, reorder, or remove fields without opening a named migration task.

/**
 * Probe layer — four levels from cheapest (L0) to most expensive (L3).
 * Severity policy (which layers block in which context) lives in report.ts.
 */
export type ProbeLayer = "L0" | "L1" | "L2" | "L3";

/**
 * Probe status — four possible outcomes.
 * Probes NEVER decide severity; that responsibility belongs exclusively to report.ts.
 */
export type ProbeStatus = "ok" | "degraded" | "blocked" | "skipped";

/**
 * Result returned by every capability probe.
 *
 * SECURITY OBLIGATION (council C8): The `detail` and `remediation` fields MUST
 * be passed through `scrubPgCredentials()` (src/admin/db-error-scrub.ts) before
 * being populated in this struct whenever they may contain database connection
 * strings, usernames, passwords, host names, or port numbers. Probe authors bear
 * this responsibility at the call site. The report assembler applies a second
 * scrub pass as defence-in-depth, but the primary obligation is here.
 */
export interface ProbeResult {
  /** Capability name matching a CAPABILITY_REGISTRY entry, e.g. 'mcp-archon'. */
  readonly capability: string;
  readonly layer: ProbeLayer;
  readonly status: ProbeStatus;
  /** Short machine-readable outcome code, e.g. 'mcp-archon-present'. */
  readonly code: string;
  /**
   * Human-readable status detail.
   * MUST be scrubbed of credentials before populating (see C8 obligation above).
   */
  readonly detail: string;
  /**
   * Exact operator action to resolve a non-ok status. Empty string when status is ok.
   * MUST be scrubbed of credentials before populating (see C8 obligation above).
   */
  readonly remediation: string;
}

/**
 * Assembled capability report.
 *
 * Shape is byte-compatible with doctorCommand JSON output (runtime.ts):
 *   { ok, blockers, advisories, nextActions, reason }
 * The `probes` field is additive — callers that need per-probe detail use it.
 * Do not rename or remove the core fields without a named migration (C14).
 */
export interface CapabilityReport {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly advisories: readonly string[];
  readonly nextActions: readonly string[];
  readonly reason: string;
  /** Raw probe results for callers that need per-probe granularity. */
  readonly probes: readonly ProbeResult[];
}
