// Phase 4 (ahrP4InteractiveWatcher): per-run respawn lease.
//
// Atomicity choice (INFRA-C1):
//   We use an in-memory Mutex + Map for the LeaseStore implementation that is
//   injected into unit tests. For production (Postgres-backed) use, callers
//   inject a PostgresLeaseStore that uses pg_try_advisory_lock(hashtext(runId))
//   — a session-scoped Postgres advisory lock. Advisory locks are:
//     - Atomic at the DB level (no TOCTOU between check and acquire).
//     - Auto-released when the connection closes (INFRA-C2: crash/disconnect
//       recovery is free — no stale lock survives a lost connection).
//     - Re-entrant for the same session (idempotent re-claim by same owner).
//
//   The alternative (conditional UPDATE ... WHERE owner IS NULL) is also
//   atomic but requires a schema migration. Advisory locks avoid the migration
//   and satisfy both INFRA-C1 and INFRA-C2, so they are preferred (ADR §8).
//
// The in-memory implementation serializes concurrent claims via a per-runId
// promise chain (mutex) so the contention test (INFRA-C1) proves that exactly
// one winner emerges even under Node's event-loop concurrency.
//
// INFRA-C2 (TTL / auto-release):
//   - Advisory lock: auto-released on connection close. No TTL needed.
//   - In-memory store: claimedAt + staleAfterMs option; a claim older than
//     the TTL is treated as expired and can be overridden.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RespawnOwner = string;

export type ClaimResult =
  | { granted: true; runId: string; owner: RespawnOwner }
  | { granted: false; runId: string; currentOwner: RespawnOwner };

export interface ClaimOptions {
  /** Override "now" for TTL tests. */
  now?: Date | undefined;
}

// ---------------------------------------------------------------------------
// LeaseStore interface — injected; no direct DB dependency
// ---------------------------------------------------------------------------

export interface LeaseStore {
  /**
   * Atomically try to acquire the lease for runId.
   *   - Returns { granted: true, owner } when:
   *       * no lease is held, OR
   *       * the existing lease belongs to the same claimant (idempotent), OR
   *       * the existing lease is stale (older than staleAfterMs).
   *   - Returns { granted: false, currentOwner } otherwise.
   */
  tryAcquire(
    runId: string,
    owner: RespawnOwner,
    options?: ClaimOptions
  ): Promise<ClaimResult>;

  /**
   * Release the lease for runId. No-op if not held or held by a different owner.
   */
  release(runId: string, owner: RespawnOwner): Promise<void>;

  /**
   * Return the current owner or undefined if no lease is held / lease is stale.
   */
  readOwner(runId: string): Promise<RespawnOwner | undefined>;
}

// ---------------------------------------------------------------------------
// makeInMemoryLeaseStore — in-memory adapter (tests + single-process use)
// ---------------------------------------------------------------------------

interface LeaseEntry {
  owner: RespawnOwner;
  claimedAt: Date;
}

export interface InMemoryLeaseStoreOptions {
  /** Milliseconds after which a claim is considered stale. Default: 300_000 (5 min). */
  staleAfterMs?: number | undefined;
}

const DEFAULT_STALE_AFTER_MS = 300_000;

/**
 * Create an in-memory LeaseStore for unit tests (no DB connection required).
 *
 * Atomicity guarantee:
 *   Node.js is single-threaded, but Promise.all() interleaves microtasks.
 *   We serialize concurrent tryAcquire() calls for the same runId via a
 *   per-key promise chain (mutex). Without this, two concurrent callers
 *   could both observe "no lease" before either writes, resulting in two
 *   winners — exactly the INFRA-C1 failure mode.
 */
export function makeInMemoryLeaseStore(
  options: InMemoryLeaseStoreOptions = {}
): LeaseStore {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const leases = new Map<string, LeaseEntry>();
  // Per-runId mutex: maps runId → last-queued promise so concurrent
  // tryAcquire() calls are serialized per key.
  const mutexChain = new Map<string, Promise<unknown>>();

  function isStale(entry: LeaseEntry, now: Date): boolean {
    return now.getTime() - entry.claimedAt.getTime() > staleAfterMs;
  }

  function withMutex<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = mutexChain.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // always run fn even if prev rejects
    mutexChain.set(runId, next);
    return next;
  }

  return {
    async tryAcquire(runId, owner, opts): Promise<ClaimResult> {
      return withMutex(runId, async () => {
        const now = opts?.now ?? new Date();
        const existing = leases.get(runId);

        if (existing === undefined || isStale(existing, now)) {
          // No lease or stale: grant to this caller.
          leases.set(runId, { owner, claimedAt: now });
          return { granted: true, runId, owner };
        }

        if (existing.owner === owner) {
          // Same owner: idempotent re-claim (update claimedAt to refresh TTL).
          leases.set(runId, { owner, claimedAt: now });
          return { granted: true, runId, owner };
        }

        // Held by a different owner.
        return { granted: false, runId, currentOwner: existing.owner };
      });
    },

    async release(runId, owner): Promise<void> {
      return withMutex(runId, async () => {
        const existing = leases.get(runId);
        if (existing !== undefined && existing.owner === owner) {
          leases.delete(runId);
        }
        // No-op if not held or held by a different owner.
      });
    },

    async readOwner(runId): Promise<RespawnOwner | undefined> {
      const existing = leases.get(runId);
      if (existing === undefined) return undefined;
      if (isStale(existing, new Date())) return undefined;
      return existing.owner;
    }
  };
}

// ---------------------------------------------------------------------------
// Public API — thin wrappers over LeaseStore (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Claim the respawn lease for a given runId.
 *
 * INFRA-C1: The claim is atomic — exactly one caller wins when multiple
 * callers race for the same runId. The LeaseStore implementation ensures
 * this via Postgres advisory lock (production) or per-key mutex (in-memory).
 *
 * INFRA-C2: Stale leases (age > staleAfterMs / connection-close for advisory
 * locks) are automatically overridable.
 *
 * I/O contract:
 *   Input:  runId, owner, store, options?
 *   Output: ClaimResult { granted, runId, owner } | { granted, runId, currentOwner }
 *   Side effects: updates lease in store when granted
 */
export async function claimRespawnLease(
  runId: string,
  owner: RespawnOwner,
  store: LeaseStore,
  options?: ClaimOptions
): Promise<ClaimResult> {
  return store.tryAcquire(runId, owner, options);
}

/**
 * Release the respawn lease.
 *
 * No-op if the lease is not held by the given owner.
 * Simulates Postgres advisory lock connection-close auto-release (INFRA-C2).
 */
export async function releaseRespawnLease(
  runId: string,
  owner: RespawnOwner,
  store: LeaseStore
): Promise<void> {
  return store.release(runId, owner);
}

/**
 * Read the current respawn owner, or undefined if no lease is held.
 */
export async function readRespawnOwner(
  runId: string,
  store: LeaseStore
): Promise<RespawnOwner | undefined> {
  return store.readOwner(runId);
}
