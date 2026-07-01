// Phase 4 (ahrP4InteractiveWatcher): per-run respawn lease.
// fs/promises imported here (top-level) for makeFileLockLeaseStore.
// The import is referenced only by makeFileLockLeaseStore; other exports
// have no dependency on fs.
import { link as linkLock, unlink, open as openLock, mkdir as mkdirLock, rename as renameLock } from "node:fs/promises";
import { randomBytes } from "node:crypto";

//
// Atomicity choice (INFRA-C1) — TWO implementations:
//
//   makeFileLockLeaseStore (primary, cross-process):
//     Stages the lock content in a private temp file, then link()s it to the
//     per-runId .lock path. link() is atomic and fails with EEXIST if the target
//     exists — the same exclusivity as O_CREAT|O_EXCL — but the lock file, the
//     instant it becomes visible, ALREADY contains the full JSON (no empty
//     create-then-write window a concurrent claimant could misread as corrupt).
//     Both Node (daemon) and bash (watcher) contend on the SAME per-runId
//     .lock file under .archon/work/daemon/. This is the POSIX cross-language
//     primitive that satisfies INFRA-C1 (exactly one winner across processes).
//     Lock path: .archon/work/daemon/respawn-lease-<sanitizedRunId>.lock
//     Lock format: {"owner","runId","claimedAt"} JSON.
//     TTL: a stale lock (claimedAt older than staleAfterMs) is reclaimed via a
//     rename() compare-and-swap (evictStale) so exactly one racer re-creates it
//     (INFRA-C2: crash/process-exit recovery).
//     An in-process mutex chains concurrent Node callers as a fast-path so
//     redundant OS-level lock attempts from the same process are avoided.
//     FILESYSTEM: link()/rename() atomicity requires a local POSIX filesystem;
//     NFS/SMB do not guarantee it.
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

// A lock id becomes a filename component (respawn-lease-<id>.lock). Cap it well
// under the POSIX 255-byte per-component limit so a long id cannot produce an
// ENAMETOOLONG at claim time (Q5). Real ids are UUIDs / short slugs.
const MAX_LEASE_ID_LENGTH = 200;

/**
 * Validate that a runId or taskId contains only safe characters and is not
 * absurdly long. Returns false for empty strings, strings longer than
 * MAX_LEASE_ID_LENGTH, or strings with characters outside [A-Za-z0-9_-].
 */
export function isValidLeaseId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_LEASE_ID_LENGTH &&
    SAFE_ID_RE.test(id)
  );
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
// A fresh claim stages the lock JSON in a private temp file (O_EXCL open, so a
// pre-planted symlink cannot redirect the write) and then link()s it onto the
// per-runId .lock path. link() is atomic and fails EEXIST if the target exists —
// the same exclusivity as O_CREAT|O_EXCL — but the lock file, the instant it is
// visible, ALREADY contains the full JSON (no empty create-then-write window a
// concurrent claimant could misread as corrupt). The bash watcher only READS
// this JSON, never creates it.
//
// Reclaiming a stale/abandoned lock cannot use a bare unlink (a late racer would
// unlink a fresh winner's lock); it uses a rename() compare-and-swap with a
// post-move staleness re-verify + restore (see evictStale).
//
// FILESYSTEM REQUIREMENT: link()/rename() atomicity holds on local POSIX
// filesystems. On NFS/SMB these are NOT guaranteed atomic — INFRA-C1 can be
// silently violated — so lockDir must be a local filesystem path.
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
 *   A fresh claim link()s a fully-written temp file onto the lock path; link()
 *   fails EEXIST if the target exists, so the kernel guarantees at most one
 *   winner and losers receive EEXIST. An in-process mutex chains concurrent Node
 *   callers as a fast-path to avoid redundant OS-level attempts from the same
 *   process. Stale-lock reclaim is serialized cross-process via a rename()
 *   compare-and-swap (evictStale).
 */
export function makeFileLockLeaseStore(
  options: FileLockLeaseStoreOptions
): LeaseStore {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const lockDir = options.lockDir;

  // S4: reject path-traversal in the caller-supplied lock directory. A `..`
  // segment would let a misconfigured/malicious caller redirect every lock write
  // (and mkdir) outside the intended tree. Relative dirs are allowed (several
  // callers pass cwd-relative paths) — but never traversal segments.
  for (const seg of lockDir.split(/[\\/]/)) {
    if (seg === "..") {
      throw new Error(
        `makeFileLockLeaseStore: lockDir must not contain '..' path segments: ${lockDir}`
      );
    }
  }

  // A lock file is a tiny JSON object. Cap the bytes we read/parse so an attacker
  // with write access to lockDir cannot force an unbounded read via a giant file (S6).
  const MAX_LOCK_BYTES = 4096;

  // Per-runId in-process mutex (fast-path over the OS lock — avoids redundant
  // link() attempts from concurrent callers in the same Node process).
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

  // Unpredictable per-write temp name (CSPRNG, not Math.random) so a co-located
  // attacker cannot pre-plant the temp path as a symlink (S1/S9).
  function tempPath(lp: string): string {
    return `${lp}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  }

  // Write via O_CREAT|O_EXCL ("wx"): the create refuses to follow a pre-planted
  // symlink at the target, so an attacker cannot redirect the write elsewhere (S1/S2).
  async function writeFileExclusive(p: string, content: string): Promise<void> {
    const fh = await openLock(p, "wx");
    try {
      await fh.writeFile(content, "utf8");
    } finally {
      await fh.close();
    }
  }

  async function readLock(lp: string): Promise<LockFileContent | undefined> {
    let fh: Awaited<ReturnType<typeof openLock>> | undefined;
    try {
      // Read a bounded number of bytes from a SINGLE open fd. Reading from the fd
      // (not re-resolving the path) closes the stat→read TOCTOU (S-N3): an
      // attacker cannot swap a small file for a huge one between calls. Anything
      // larger than the cap is treated as corrupt (S6).
      fh = await openLock(lp, "r");
      const buf = Buffer.alloc(MAX_LOCK_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, MAX_LOCK_BYTES + 1, 0);
      if (bytesRead > MAX_LOCK_BYTES) return undefined; // oversized → corrupt
      const parsed: unknown = JSON.parse(buf.toString("utf8", 0, bytesRead));
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
    } finally {
      if (fh !== undefined) {
        try { await fh.close(); } catch { /* best-effort */ }
      }
    }
  }

  // Staleness computed from already-read content (no second file read — avoids
  // the owner/staleness desync a re-read would cause, R2/Q6). `undefined`
  // (corrupt/unreadable) is treated as stale.
  function isContentStale(content: LockFileContent | undefined, now: Date): boolean {
    if (content === undefined) return true;
    const claimedMs = new Date(content.claimedAt).getTime();
    if (!Number.isFinite(claimedMs)) return true;
    return now.getTime() - claimedMs > staleAfterMs;
  }

  // Same-owner idempotent refresh: overwrite our OWN lock with a new claimedAt.
  // Safe because we already hold it; rename() is atomic.
  async function writeLockContent(lp: string, owner: RespawnOwner, runId: string, now: Date): Promise<void> {
    await mkdirLock(lockDir, { recursive: true });
    const content: LockFileContent = { owner, runId, claimedAt: now.toISOString() };
    const tmp = tempPath(lp);
    await writeFileExclusive(tmp, `${JSON.stringify(content)}\n`);
    await renameLock(tmp, lp);
  }

  async function tryAtomicCreate(lp: string, owner: RespawnOwner, runId: string, now: Date): Promise<boolean> {
    // Atomic exclusive create WITH content already present: stage the full JSON
    // in a private temp file, then link() it to the lock path. link() fails
    // EEXIST if lp exists (same exclusivity as O_EXCL), but the lock file — the
    // instant it is visible — already holds the complete JSON, so a concurrent
    // claimant can never observe an empty mid-creation file (the original
    // create-then-write double-winner bug).
    await mkdirLock(lockDir, { recursive: true });
    const content: LockFileContent = { owner, runId, claimedAt: now.toISOString() };
    const tmp = tempPath(lp);
    await writeFileExclusive(tmp, `${JSON.stringify(content)}\n`);
    try {
      await linkLock(tmp, lp);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw err;
    } finally {
      // Remove the staging file (the durable lock is the linked lp). Best-effort:
      // the CSPRNG name means an orphan can't collide, and it only encodes pid +
      // runId — non-secret metadata already present in the lock file itself (S8).
      try { await unlink(tmp); } catch { /* best-effort temp cleanup */ }
    }
  }

  // Atomically evict a lock we have determined to be stale, so exactly ONE racer
  // proceeds to re-create it (R1). rename() of the same source is a
  // compare-and-swap: only the first caller moves lp aside; concurrent callers
  // get ENOENT. After moving it aside we RE-VERIFY the moved content is still
  // stale — if a concurrent reclaimer refreshed lp between our stale-check and
  // our rename, we RESTORE it and lose, rather than evicting a live winner's
  // lock. (For the two possible lease owners in this system — daemon and
  // interactive — this is race-free; a >2-writer restore window is theoretical.)
  // Returns true iff THIS caller won the eviction and lp is now free.
  async function evictStale(lp: string, now: Date): Promise<boolean> {
    const evicted = `${lp}.evicting.${process.pid}.${randomBytes(8).toString("hex")}`;
    try {
      await renameLock(lp, evicted);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false; // another racer already evicted/reclaimed it
      throw err; // EACCES etc. — surface rather than silently stranding the lock (S5)
    }
    const moved = await readLock(evicted);
    if (moved !== undefined && !isContentStale(moved, now)) {
      // We moved a FRESH lock aside (a concurrent reclaim refreshed it after our
      // stale-check). Put it back if lp is still free, then lose.
      try { await linkLock(evicted, lp); } catch { /* lp already re-created — drop our copy */ }
      try { await unlink(evicted); } catch { /* best-effort */ }
      return false;
    }
    try { await unlink(evicted); } catch { /* best-effort */ }
    return true;
  }

  function assertValidRunId(method: string, runId: string): void {
    // S3: enforce the charset/length contract at the store boundary. Invalid ids
    // are otherwise silently sanitized for the path but written raw into the JSON.
    if (!isValidLeaseId(runId)) {
      throw new TypeError(
        `${method}: invalid runId ${JSON.stringify(runId)} — must match ^[A-Za-z0-9_-]+$ and be <= ${MAX_LEASE_ID_LENGTH} chars`
      );
    }
  }

  function assertValidOwner(method: string, owner: RespawnOwner): void {
    // R-M2/S-N1: an oversized owner would push the lock JSON past MAX_LOCK_BYTES,
    // making readLock report the just-granted lock as corrupt → immediately
    // reclaimable by anyone. Constrain owner to the same safe, bounded token.
    if (!isValidLeaseId(owner)) {
      throw new TypeError(
        `${method}: invalid owner ${JSON.stringify(owner)} — must match ^[A-Za-z0-9_-]+$ and be <= ${MAX_LEASE_ID_LENGTH} chars`
      );
    }
  }

  return {
    async tryAcquire(runId, owner, opts): Promise<ClaimResult> {
      assertValidRunId("tryAcquire", runId);
      assertValidOwner("tryAcquire", owner);
      return withMutex(runId, async () => {
        const now = opts?.now ?? new Date();
        const lp = lockPath(runId);

        // Fast path: atomic exclusive create (link a fully-written temp).
        if (await tryAtomicCreate(lp, owner, runId, now)) {
          return { granted: true, runId, owner };
        }

        // EEXIST: a lock file exists. Read it to determine owner / staleness.
        const existing = await readLock(lp);

        // Staleness is checked FIRST — before the same-owner shortcut. A stale
        // lock (even our OWN stale lock) may be concurrently evicted+reclaimed by
        // a different owner right now, so it must be reclaimed EXCLUSIVELY. The
        // same-owner idempotent path below uses an unconditional rename, which
        // would clobber that concurrent winner's fresh lock (INFRA-C1 violation,
        // e.g. daemon crash → stale → daemon restarts while interactive reclaims).
        //
        // Corrupt/unreadable (undefined) counts as stale: with the atomic link
        // create, `undefined` no longer means "mid-creation", only "genuinely
        // corrupt or abandoned".
        if (isContentStale(existing, now)) {
          // Evict via rename compare-and-swap so exactly one racer re-creates.
          if ((await evictStale(lp, now)) && (await tryAtomicCreate(lp, owner, runId, now))) {
            return { granted: true, runId, owner };
          }
          // Either we lost the eviction, or another process claimed the freed
          // slot first — report the current owner.
          const current = await readLock(lp);
          return { granted: false, runId, currentOwner: current?.owner ?? "unknown" };
        }

        // Not stale, same owner: idempotent re-claim (refresh claimedAt). Safe —
        // a NON-stale lock cannot be concurrently evicted (evictStale only fires
        // on stale locks), so the rename cannot clobber a different winner.
        if (existing !== undefined && existing.owner === owner) {
          await writeLockContent(lp, owner, runId, now);
          return { granted: true, runId, owner };
        }

        // Held by a different, non-stale owner.
        return { granted: false, runId, currentOwner: existing!.owner };
      });
    },

    async release(runId, owner): Promise<void> {
      assertValidRunId("release", runId);
      assertValidOwner("release", owner);
      return withMutex(runId, async () => {
        const lp = lockPath(runId);
        const existing = await readLock(lp);
        if (existing !== undefined && existing.owner === owner) {
          try {
            await unlink(lp);
          } catch (err: unknown) {
            // ENOENT = already gone (fine). Anything else (EACCES/EIO/EROFS)
            // means the lease is stuck until TTL with no signal — surface it (S5/R-M3).
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
        // No-op if not held or held by a different owner.
      });
    },

    async readOwner(runId): Promise<RespawnOwner | undefined> {
      assertValidRunId("readOwner", runId);
      const lp = lockPath(runId);
      // (readOwner takes no owner argument, so no owner validation here.)
      // Single read (R2/Q6): compute staleness from the SAME content we return,
      // so a concurrent replacement cannot desync owner vs staleness verdict.
      const existing = await readLock(lp);
      if (isContentStale(existing, new Date())) return undefined;
      return existing!.owner;
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
 * callers race for the same runId. The LeaseStore implementation ensures this
 * via a cross-process file lock (link()/rename() on a local POSIX filesystem,
 * production) or a per-key mutex (in-memory adapter).
 *
 * INFRA-C2: Stale leases (claimedAt age > staleAfterMs) are automatically
 * reclaimable — recovering a lease whose holder crashed without releasing it.
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
 * No-op if the lease is not held by the given owner. For the file-lock store,
 * this removes the .lock file (the successor's crash-recovery path is the
 * staleAfterMs TTL, INFRA-C2).
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
