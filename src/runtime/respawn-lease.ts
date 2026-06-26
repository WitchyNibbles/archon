// Phase 4 (ahrP4InteractiveWatcher): per-run respawn lease.
// fs/promises imported here (top-level) for makeFileLockLeaseStore.
// The import is referenced only by makeFileLockLeaseStore; other exports
// have no dependency on fs.
import { open, unlink, readFile as readFileLock, mkdir as mkdirLock, writeFile as writeFileLock, rename as renameLock } from "node:fs/promises";

//
// Atomicity choice (INFRA-C1) — TWO implementations:
//
//   makeFileLockLeaseStore (primary, cross-process):
//     Uses fs.open(lockPath, "wx") — O_CREAT|O_EXCL atomic exclusive create.
//     Both Node (daemon) and bash (watcher) contend on the SAME per-runId
//     .lock file under .archon/work/daemon/. This is the POSIX cross-language
//     primitive that satisfies INFRA-C1 (exactly one winner across processes).
//     Lock path: .archon/work/daemon/respawn-lease-<sanitizedRunId>.lock
//     Lock format: {"owner","runId","claimedAt"} JSON.
//     TTL: stale locks (claimedAt older than staleAfterMs) are unlinked and
//     re-attempted (INFRA-C2: crash/process-exit recovery).
//     An in-process mutex chains concurrent Node callers as a fast-path so
//     redundant OS-level lock attempts from the same process are avoided.
//
//   makeInMemoryLeaseStore (unit-test adapter, single-process):
//     Serializes concurrent claims via a per-runId promise chain (mutex).
//     No file I/O — suitable for unit tests that do not fork child processes.
//     Does NOT satisfy cross-process INFRA-C1 (two separate Node processes
//     each get their own in-memory map and can both win).
//
// INFRA-C2 (TTL / auto-release):
//   - File-lock store: claimedAt in the JSON; stale after staleAfterMs →
//     unlink + re-attempt. Process-exit recovery: lock file simply remains
//     until TTL expires (no connection-close auto-release).
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
// runId / taskId charset validation (non-blocking 6 / MED-2)
// Both components must match ^[A-Za-z0-9_-]+$ before being embedded in a
// path or JSON to prevent injection via crafted IDs.
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate that a runId or taskId contains only safe characters.
 * Returns false for empty strings or strings with characters outside
 * [A-Za-z0-9_-].
 */
export function isValidLeaseId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && SAFE_ID_RE.test(id);
}

/**
 * Sanitize a runId for use in a file path by replacing unsafe characters
 * with underscores. Used internally by makeFileLockLeaseStore.
 */
function sanitizeIdForPath(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

// ---------------------------------------------------------------------------
// makeFileLockLeaseStore — cross-process file-lock adapter (INFRA-C1)
//
// Both the Node daemon and the bash watcher contend on the SAME .lock file
// via OS-level exclusive create (O_CREAT|O_EXCL), which is atomic on all
// POSIX-compliant filesystems.
//
// Bash equivalent (watcher uses same lock file):
//   set -C; : > "$lock" (noclobber) → identical O_CREAT|O_EXCL semantics
//   OR: mkdir "$lock.d" (directory create is also O_CREAT|O_EXCL-like)
// ---------------------------------------------------------------------------

export interface FileLockLeaseStoreOptions {
  /** Base directory for lock files. Default: .archon/work/daemon relative to cwd. */
  lockDir: string;
  /** Milliseconds after which a claim is considered stale. Default: 300_000 (5 min). */
  staleAfterMs?: number | undefined;
}

interface LockFileContent {
  owner: RespawnOwner;
  runId: string;
  claimedAt: string;
}

/**
 * Create a cross-process LeaseStore backed by per-runId .lock files.
 *
 * I/O contract (tryAcquire):
 *   Input:  runId (^[A-Za-z0-9_-]+$), owner, options?
 *   Output: ClaimResult
 *   Side effects:
 *     - Creates lockDir if absent
 *     - Creates/replaces .lock file when granted
 *     - Unlinks stale .lock file when reclaiming
 *     - No-ops when denied (existing non-stale lock)
 *
 * I/O contract (release):
 *   Input:  runId, owner
 *   Output: void
 *   Side effects: unlinks .lock file when owned by caller; no-op otherwise
 *
 * Atomicity guarantee (INFRA-C1):
 *   fs.open(path, "wx") is O_CREAT|O_EXCL — the kernel guarantees at most
 *   one process/thread wins the create. Concurrent losers receive EEXIST.
 *   In-process mutex chains concurrent Node callers as a fast-path to avoid
 *   redundant OS-level attempts from the same process.
 */
export function makeFileLockLeaseStore(
  options: FileLockLeaseStoreOptions
): LeaseStore {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const lockDir = options.lockDir;
  // Per-runId in-process mutex (fast-path over OS lock — avoids redundant
  // O_CREAT|O_EXCL attempts from concurrent callers in the same Node process).
  const mutexChain = new Map<string, Promise<unknown>>();

  function lockPath(runId: string): string {
    return `${lockDir}/respawn-lease-${sanitizeIdForPath(runId)}.lock`;
  }

  function withMutex<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = mutexChain.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    mutexChain.set(runId, next);
    return next;
  }

  async function readLock(lp: string): Promise<LockFileContent | undefined> {
    try {
      const raw = await readFileLock(lp, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).owner === "string" &&
        typeof (parsed as Record<string, unknown>).runId === "string" &&
        typeof (parsed as Record<string, unknown>).claimedAt === "string"
      ) {
        return parsed as LockFileContent;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async function isLockStale(lp: string, now: Date): Promise<boolean> {
    const content = await readLock(lp);
    if (content === undefined) return true;
    const claimedMs = new Date(content.claimedAt).getTime();
    if (!Number.isFinite(claimedMs)) return true;
    return now.getTime() - claimedMs > staleAfterMs;
  }

  async function writeLock(lp: string, owner: RespawnOwner, runId: string, now: Date): Promise<void> {
    await mkdirLock(lockDir, { recursive: true });
    const content: LockFileContent = { owner, runId, claimedAt: now.toISOString() };
    const tmp = `${lp}.tmp.${process.pid}.${Date.now()}`;
    await writeFileLock(tmp, `${JSON.stringify(content)}\n`, "utf8");
    await renameLock(tmp, lp);
  }

  async function tryAtomicCreate(lp: string, owner: RespawnOwner, runId: string, now: Date): Promise<boolean> {
    // O_CREAT|O_EXCL: atomic exclusive create. Returns true on success.
    try {
      await mkdirLock(lockDir, { recursive: true });
      // Open with "wx" = O_WRONLY|O_CREAT|O_EXCL — fails with EEXIST if exists.
      const fh = await open(lp, "wx");
      const content: LockFileContent = { owner, runId, claimedAt: now.toISOString() };
      await fh.writeFile(`${JSON.stringify(content)}\n`, "utf8");
      await fh.close();
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw err;
    }
  }

  return {
    async tryAcquire(runId, owner, opts): Promise<ClaimResult> {
      return withMutex(runId, async () => {
        const now = opts?.now ?? new Date();
        const lp = lockPath(runId);

        // Attempt atomic O_CREAT|O_EXCL create.
        const created = await tryAtomicCreate(lp, owner, runId, now);
        if (created) {
          return { granted: true, runId, owner };
        }

        // EEXIST: lock file exists. Read it to determine owner / staleness.
        const existing = await readLock(lp);

        if (existing === undefined) {
          // Unreadable / corrupt — treat as stale, overwrite.
          await writeLock(lp, owner, runId, now);
          return { granted: true, runId, owner };
        }

        // Same owner: idempotent re-claim (refresh claimedAt).
        if (existing.owner === owner) {
          await writeLock(lp, owner, runId, now);
          return { granted: true, runId, owner };
        }

        // Check staleness.
        const claimedMs = new Date(existing.claimedAt).getTime();
        const stale = !Number.isFinite(claimedMs) || now.getTime() - claimedMs > staleAfterMs;
        if (stale) {
          // Stale: unlink and re-attempt once.
          try { await unlink(lp); } catch { /* ignore */ }
          const reclaimed = await tryAtomicCreate(lp, owner, runId, now);
          if (reclaimed) {
            return { granted: true, runId, owner };
          }
          // Another process grabbed it between unlink and our re-attempt.
          const newExisting = await readLock(lp);
          const newOwner = newExisting?.owner ?? "unknown";
          return { granted: false, runId, currentOwner: newOwner };
        }

        // Not stale, held by a different owner.
        return { granted: false, runId, currentOwner: existing.owner };
      });
    },

    async release(runId, owner): Promise<void> {
      return withMutex(runId, async () => {
        const lp = lockPath(runId);
        const existing = await readLock(lp);
        if (existing !== undefined && existing.owner === owner) {
          try { await unlink(lp); } catch { /* no-op if already gone */ }
        }
        // No-op if not held or held by a different owner.
      });
    },

    async readOwner(runId): Promise<RespawnOwner | undefined> {
      const lp = lockPath(runId);
      const existing = await readLock(lp);
      if (existing === undefined) return undefined;
      const stale = await isLockStale(lp, new Date());
      if (stale) return undefined;
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
