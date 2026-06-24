/**
 * Dashboard snapshot fetcher — P1-S2b (C5).
 *
 * Prefer /snapshot.live.json (written by `forge snapshot --watch`).
 * Fall back to /snapshot.json (committed synthetic sample) when the live
 * file is absent (404) — not on other HTTP errors.
 *
 * Both files must pass full structural + enum validation (item 7).
 * Throws SnapshotFetchError with a precise field-level message on any bad value.
 *
 * Phase 1 note: swap this for TanStack Query polling by wrapping fetchDashboardSnapshot
 * in a useQuery call with a suitable staleTime/refetchInterval.
 */

import type { DashboardViewModel } from "../types/dashboard.ts";

const LIVE_SNAPSHOT_URL = "/snapshot.live.json";
const FALLBACK_SNAPSHOT_URL = "/snapshot.json";

export class SnapshotFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "SnapshotFetchError";
  }
}

// ── Inline enum validators ────────────────────────────────────────────────────
// The Zod schema lives in src/forge/ and cannot be imported here (import wall).
// These mirror the union literals in src/forge/dashboard-contract.ts.
// If a value is added to the contract, add it here too.

const RUN_STATUSES = new Set([
  "intake", "planned", "decomposed", "ready",
  "in_progress", "review_blocked", "approved", "memorized", "done",
]);

const TASK_STATUSES = new Set([
  "ready", "in_progress", "review_blocked", "approved", "done", "blocked",
]);

const REVIEW_STATES = new Set(["pending", "passed", "blocked", "waived"]);

const REVIEW_SEVERITIES = new Set(["low", "medium", "high", "critical"]);

const GATE_ROLES = new Set(["reviewer", "security_reviewer", "qa_engineer"]);

const AUTHORITY_LABELS = new Set(["runtime_authoritative", "derived_only"]);

const PULSE_STATES = new Set(["idle", "running", "blocked", "complete"]);

const ROUTING_KINDS = new Set(["owner_dispatch", "review_dispatch", "wait"]);

const BLOCKER_KINDS = new Set([
  "review_missing", "approval_missing", "lock_conflict",
  "dependency_unresolved", "stale_recovery", "generic",
]);

// ── Field validators ──────────────────────────────────────────────────────────

function requireString(obj: Record<string, unknown>, field: string, ctx: string): string {
  const v = obj[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new SnapshotFetchError(`${ctx}.${field} must be a non-empty string (got ${JSON.stringify(v)})`);
  }
  return v;
}

function requireEnum(obj: Record<string, unknown>, field: string, allowed: Set<string>, ctx: string): string {
  const v = requireString(obj, field, ctx);
  if (!allowed.has(v)) {
    throw new SnapshotFetchError(`${ctx}.${field} "${v}" is not a valid value (allowed: ${[...allowed].join(", ")})`);
  }
  return v;
}

function asObj(v: unknown, ctx: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new SnapshotFetchError(`${ctx} must be a plain object`);
  }
  return v as Record<string, unknown>;
}

function asArray(v: unknown, ctx: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new SnapshotFetchError(`${ctx} must be an array`);
  }
  return v;
}

// ── Sub-validators ────────────────────────────────────────────────────────────

function validateHeader(raw: unknown): void {
  const obj = asObj(raw, "header");
  requireString(obj, "runId", "header");
  requireString(obj, "title", "header");
  requireEnum(obj, "status", RUN_STATUSES, "header");
  requireEnum(obj, "authorityLabel", AUTHORITY_LABELS, "header");
  requireString(obj, "updatedAt", "header");
}

function validateBlocker(raw: unknown, i: number): void {
  const ctx = `blockers[${i}]`;
  const obj = asObj(raw, ctx);
  requireString(obj, "id", ctx);
  requireEnum(obj, "kind", BLOCKER_KINDS, ctx);
  requireString(obj, "reason", ctx);
  asArray(obj["nextActions"], `${ctx}.nextActions`);
  // taskId is optional — skip if absent
  if ("taskId" in obj && obj["taskId"] !== undefined) {
    requireString(obj, "taskId", ctx);
  }
}

function validateTaskQueueEntry(raw: unknown, i: number): void {
  const ctx = `taskQueue[${i}]`;
  const obj = asObj(raw, ctx);
  requireString(obj, "taskId", ctx);
  requireString(obj, "title", ctx);
  requireEnum(obj, "status", TASK_STATUSES, ctx);
  requireString(obj, "ownerRole", ctx);
  // routingRecommendation is optional
  if ("routingRecommendation" in obj && obj["routingRecommendation"] !== undefined) {
    requireEnum(obj, "routingRecommendation", ROUTING_KINDS, ctx);
  }
  asArray(obj["blockers"], `${ctx}.blockers`);
  requireString(obj, "updatedAt", ctx);
}

function validateReviewGate(raw: unknown, i: number): void {
  const ctx = `reviewGates[${i}]`;
  const obj = asObj(raw, ctx);
  requireEnum(obj, "role", GATE_ROLES, ctx);
  requireEnum(obj, "state", REVIEW_STATES, ctx);
  // severity is optional
  if ("severity" in obj && obj["severity"] !== undefined) {
    requireEnum(obj, "severity", REVIEW_SEVERITIES, ctx);
  }
  requireString(obj, "taskId", ctx);
  // actor, reviewedAt are optional strings
}

function validatePulse(raw: unknown): void {
  const obj = asObj(raw, "pulse");
  requireEnum(obj, "pulseState", PULSE_STATES, "pulse");
  const lockCount = obj["activeLockCount"];
  if (typeof lockCount !== "number" || !Number.isInteger(lockCount) || lockCount < 0) {
    throw new SnapshotFetchError(`pulse.activeLockCount must be a non-negative integer (got ${JSON.stringify(lockCount)})`);
  }
  asArray(obj["lockedTaskIds"], "pulse.lockedTaskIds");
}

// ── Main validator ────────────────────────────────────────────────────────────

function validateSnapshot(raw: unknown): DashboardViewModel {
  const obj = asObj(raw, "snapshot");

  validateHeader(obj["header"]);

  const blockers = asArray(obj["blockers"], "blockers");
  blockers.forEach((b, i) => validateBlocker(b, i));

  const taskQueue = asArray(obj["taskQueue"], "taskQueue");
  taskQueue.forEach((t, i) => validateTaskQueueEntry(t, i));

  const reviewGates = asArray(obj["reviewGates"], "reviewGates");
  reviewGates.forEach((g, i) => validateReviewGate(g, i));

  validatePulse(obj["pulse"]);

  // generatedAt is required (P1-S2b, C5 — honest staleness).
  // Must be a non-empty ISO string; Invalid Date is caught at render time via
  // formatRelativeAge, but we validate the field exists here.
  requireString(obj, "generatedAt", "snapshot");

  return raw as DashboardViewModel;
}

// ── Live-prefer fetch strategy ────────────────────────────────────────────────

/**
 * Try to fetch the live snapshot. Returns null when the live file is absent.
 *
 * "Absent" is detected in two ways:
 *   1. HTTP 404 — standard server-side not-found.
 *   2. HTTP 200 but body is not valid JSON — happens when a static file server
 *      (e.g. `vite preview`) serves the SPA index.html fallback for unknown
 *      paths instead of returning a true 404. We treat a JSON parse failure as
 *      "file not present" and silently fall through.
 *
 * Any other HTTP error (5xx, 403, etc.) is surfaced as a real error.
 */
async function fetchLive(): Promise<unknown | null> {
  const res = await fetch(LIVE_SNAPSHOT_URL);

  if (res.status === 404) {
    // Standard server-side not-found — fall through to committed sample.
    return null;
  }

  if (!res.ok) {
    throw new SnapshotFetchError(
      `Failed to fetch live snapshot: HTTP ${res.status}`,
      res.status
    );
  }

  // Parse JSON — if the body is not JSON (e.g. the SPA HTML fallback from
  // a static file server), treat as "not present" and fall through.
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    // Non-JSON body — server returned the SPA HTML fallback for this path.
    // Not a real error; just means the live file does not exist yet.
    return null;
  }
  return parsed;
}

/**
 * Fetch the committed fallback snapshot. A non-200 here is always an error —
 * the fallback must always be present (it is committed to the repo).
 */
async function fetchFallback(): Promise<unknown> {
  const res = await fetch(FALLBACK_SNAPSHOT_URL);
  if (!res.ok) {
    throw new SnapshotFetchError(
      `Failed to fetch fallback snapshot: HTTP ${res.status}`,
      res.status
    );
  }
  return res.json() as Promise<unknown>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchDashboardSnapshot(): Promise<DashboardViewModel> {
  // 1. Try live snapshot (written by `forge snapshot --watch`)
  const liveRaw = await fetchLive();

  // 2. Fall back to committed sample only on 404
  const raw = liveRaw ?? (await fetchFallback());

  // 3. Validate — throws SnapshotFetchError on any structural or enum mismatch
  return validateSnapshot(raw);
}
