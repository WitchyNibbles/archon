// Phase 4 (ahrP4InteractiveWatcher): unit tests for respawn-lease.ts
//
// Key contracts under test:
//   INFRA-C1: claimRespawnLease is ATOMIC — two simultaneous callers for the
//             same runId must result in exactly ONE winner. Contention test
//             asserts claimer count == 1, not merely idempotent consume.
//             Cross-process test spawns TWO child node processes that contend
//             on the same file-lock; asserts exactly ONE wins.
//   INFRA-C2: TTL semantics — stale lock file is reclaimed by new caller.
//   INFRA-C3 is exercised in p4-stop-hook.test.ts (file write path).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  claimRespawnLease,
  releaseRespawnLease,
  readRespawnOwner,
  makeInMemoryLeaseStore,
  makeFileLockLeaseStore,
  isValidLeaseId
} from "../src/runtime/respawn-lease.ts";
import type { LeaseStore } from "../src/runtime/respawn-lease.ts";

// ---------------------------------------------------------------------------
// In-memory LeaseStore for unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("makeInMemoryLeaseStore", () => {
  it("exports a factory that returns a LeaseStore", () => {
    const store = makeInMemoryLeaseStore();
    assert.equal(typeof store.tryAcquire, "function");
    assert.equal(typeof store.release, "function");
    assert.equal(typeof store.readOwner, "function");
  });
});

// ---------------------------------------------------------------------------
// claimRespawnLease — basic success/failure paths
// ---------------------------------------------------------------------------

describe("claimRespawnLease", () => {
  it("grants the lease to the first caller", async () => {
    const store = makeInMemoryLeaseStore();
    const result = await claimRespawnLease("run-001", "daemon", store);
    assert.equal(result.granted, true);
    assert.equal(result.owner, "daemon");
    assert.equal(result.runId, "run-001");
  });

  it("denies a second caller for the same runId when lease is held", async () => {
    const store = makeInMemoryLeaseStore();
    await claimRespawnLease("run-002", "daemon", store);
    const result2 = await claimRespawnLease("run-002", "interactive", store);
    assert.equal(result2.granted, false);
    assert.equal(result2.currentOwner, "daemon");
  });

  it("grants lease to same owner again (idempotent re-claim)", async () => {
    const store = makeInMemoryLeaseStore();
    await claimRespawnLease("run-003", "daemon", store);
    const result2 = await claimRespawnLease("run-003", "daemon", store);
    assert.equal(result2.granted, true);
    assert.equal(result2.owner, "daemon");
  });

  it("different runIds are independent leases", async () => {
    const store = makeInMemoryLeaseStore();
    const r1 = await claimRespawnLease("run-A", "daemon", store);
    const r2 = await claimRespawnLease("run-B", "interactive", store);
    assert.equal(r1.granted, true);
    assert.equal(r2.granted, true);
  });
});

// ---------------------------------------------------------------------------
// INFRA-C1 CONTENTION TEST — simultaneous callers, only one wins
//
// This is the load-bearing test: two concurrent claim() calls must result in
// exactly one winner. Tests idempotent consume of handoff row is insufficient;
// this verifies the process-spawn gate itself.
// ---------------------------------------------------------------------------

describe("claimRespawnLease contention (INFRA-C1)", () => {
  it("when N callers race, exactly 1 wins the lease", async () => {
    const store = makeInMemoryLeaseStore();
    const runId = "run-contention-001";
    const callers = ["daemon", "interactive", "interactive2", "daemon2"];

    // Launch all claims simultaneously (Promise.all, no await between them).
    const results = await Promise.all(
      callers.map((owner) => claimRespawnLease(runId, owner, store))
    );

    const winners = results.filter((r) => r.granted);
    const losers = results.filter((r) => !r.granted);

    // CRITICAL: exactly 1 winner.
    assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}`);
    assert.equal(losers.length, callers.length - 1);

    // All losers must report the same currentOwner (the winner).
    const winnerOwner = winners[0]!.owner;
    for (const loser of losers) {
      assert.equal(loser.currentOwner, winnerOwner);
    }
  });

  it("spawn-count invariant: exactly 1 launch for N contenders", async () => {
    // This is the process-spawn proxy: count how many callers would proceed to
    // spawn claude. Only the lease winner should ever spawn.
    const store = makeInMemoryLeaseStore();
    const runId = "run-contention-spawn";
    const callers = Array.from({ length: 8 }, (_, i) => `caller-${i}`);

    let spawnCount = 0;
    await Promise.all(
      callers.map(async (owner) => {
        const result = await claimRespawnLease(runId, owner, store);
        if (result.granted) {
          spawnCount++;
        }
      })
    );

    assert.equal(spawnCount, 1, `spawn-count must be 1, got ${spawnCount}`);
  });
});

// ---------------------------------------------------------------------------
// releaseRespawnLease + INFRA-C2: after release, new caller can claim
// ---------------------------------------------------------------------------

describe("releaseRespawnLease (INFRA-C2 auto-release simulation)", () => {
  it("after explicit release, a new caller can claim the lease", async () => {
    const store = makeInMemoryLeaseStore();
    const runId = "run-release-001";

    await claimRespawnLease(runId, "daemon", store);
    // Verify held
    const held = await claimRespawnLease(runId, "interactive", store);
    assert.equal(held.granted, false);

    // Release (simulates daemon connection-close / advisory lock release)
    await releaseRespawnLease(runId, "daemon", store);

    // New caller can now claim
    const result = await claimRespawnLease(runId, "interactive", store);
    assert.equal(result.granted, true);
    assert.equal(result.owner, "interactive");
  });

  it("releasing an unheld lease is a no-op (not an error)", async () => {
    const store = makeInMemoryLeaseStore();
    // Should not throw
    await releaseRespawnLease("run-notexist", "daemon", store);
  });

  it("TTL stale lease is overridable after staleness threshold", async () => {
    // Simulate a stale lease by injecting a fake claimedAt in the past.
    // The in-memory store accepts a staleAfterMs option to control the TTL.
    const store = makeInMemoryLeaseStore({ staleAfterMs: 10 });
    const runId = "run-ttl-001";

    // Claim with a backdated now so it's immediately stale
    const first = await claimRespawnLease(runId, "daemon", store, { now: new Date(Date.now() - 100) });
    assert.equal(first.granted, true);

    // Now claim with present time — stale so a new caller wins
    const second = await claimRespawnLease(runId, "interactive", store, { now: new Date() });
    assert.equal(second.granted, true, "stale lease should be overridable");
  });
});

// ---------------------------------------------------------------------------
// readRespawnOwner
// ---------------------------------------------------------------------------

describe("readRespawnOwner", () => {
  it("returns undefined when no lease held", async () => {
    const store = makeInMemoryLeaseStore();
    const owner = await readRespawnOwner("run-unknown", store);
    assert.equal(owner, undefined);
  });

  it("returns the current owner when lease is held", async () => {
    const store = makeInMemoryLeaseStore();
    await claimRespawnLease("run-read-001", "daemon", store);
    const owner = await readRespawnOwner("run-read-001", store);
    assert.equal(owner, "daemon");
  });
});

// ---------------------------------------------------------------------------
// LeaseStore interface contract (structural typing check)
// ---------------------------------------------------------------------------

describe("LeaseStore structural contract", () => {
  it("in-memory store satisfies the LeaseStore interface at runtime", () => {
    const store: LeaseStore = makeInMemoryLeaseStore();
    assert.ok(store);
  });
});

// ---------------------------------------------------------------------------
// isValidLeaseId — charset validation (MED-2 / non-blocking 6)
// ---------------------------------------------------------------------------

describe("isValidLeaseId", () => {
  it("accepts safe ids", () => {
    assert.equal(isValidLeaseId("run-001"), true);
    assert.equal(isValidLeaseId("task_abc"), true);
    assert.equal(isValidLeaseId("RunABC123"), true);
    assert.equal(isValidLeaseId("a-b_c-1"), true);
  });

  it("rejects empty string", () => {
    assert.equal(isValidLeaseId(""), false);
  });

  it("rejects ids with spaces", () => {
    assert.equal(isValidLeaseId("run 001"), false);
  });

  it("rejects ids with shell metacharacters", () => {
    assert.equal(isValidLeaseId("run;id"), false);
    assert.equal(isValidLeaseId("run$(id)"), false);
    assert.equal(isValidLeaseId("run`id`"), false);
    assert.equal(isValidLeaseId("run/id"), false);
    assert.equal(isValidLeaseId("run.id"), false);
  });

  it("rejects ids with path traversal sequences", () => {
    assert.equal(isValidLeaseId("../etc/passwd"), false);
    assert.equal(isValidLeaseId("run..id"), false);
  });

  it("rejects ids longer than the max length (filename-component safety)", () => {
    assert.equal(isValidLeaseId("a".repeat(200)), true, "200 chars is the boundary and allowed");
    assert.equal(isValidLeaseId("a".repeat(201)), false, "201 chars exceeds the cap");
  });
});

// ---------------------------------------------------------------------------
// makeFileLockLeaseStore — cross-process file-lock adapter (INFRA-C1)
// ---------------------------------------------------------------------------

let tmpLockDir: string;

beforeEach(async () => {
  tmpLockDir = path.join(os.tmpdir(), `archon-lease-test-${Date.now()}`);
  await mkdir(tmpLockDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpLockDir, { recursive: true, force: true });
});

describe("makeFileLockLeaseStore", () => {
  it("exports a factory that returns a LeaseStore", () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    assert.equal(typeof store.tryAcquire, "function");
    assert.equal(typeof store.release, "function");
    assert.equal(typeof store.readOwner, "function");
  });

  it("grants lease to first caller", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    const result = await claimRespawnLease("run-fl-001", "daemon", store);
    assert.equal(result.granted, true);
    assert.equal(result.owner, "daemon");
  });

  it("denies second caller when lease is held", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    await claimRespawnLease("run-fl-002", "daemon", store);
    const result2 = await claimRespawnLease("run-fl-002", "interactive", store);
    assert.equal(result2.granted, false);
    assert.equal(result2.currentOwner, "daemon");
  });

  it("idempotent re-claim by same owner", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    await claimRespawnLease("run-fl-003", "daemon", store);
    const r2 = await claimRespawnLease("run-fl-003", "daemon", store);
    assert.equal(r2.granted, true);
  });

  it("releases lease and allows new caller", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    await claimRespawnLease("run-fl-004", "daemon", store);
    await releaseRespawnLease("run-fl-004", "daemon", store);
    const r2 = await claimRespawnLease("run-fl-004", "interactive", store);
    assert.equal(r2.granted, true);
  });

  it("readOwner returns current owner", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    await claimRespawnLease("run-fl-005", "daemon", store);
    const owner = await readRespawnOwner("run-fl-005", store);
    assert.equal(owner, "daemon");
  });

  it("readOwner returns undefined when no lease held", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    const owner = await readRespawnOwner("run-fl-none", store);
    assert.equal(owner, undefined);
  });

  it("TTL-reclaim: stale lock file is overridable by new caller (INFRA-C2)", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir, staleAfterMs: 10 });
    const runId = "run-fl-ttl-001";

    // Claim with a backdated claimedAt so it's immediately stale.
    const first = await claimRespawnLease(runId, "daemon", store, {
      now: new Date(Date.now() - 100)
    });
    assert.equal(first.granted, true);

    // A new caller with present time should reclaim the stale lock.
    const second = await claimRespawnLease(runId, "interactive", store, {
      now: new Date()
    });
    assert.equal(second.granted, true, "stale lock must be reclaimable");
    assert.equal(second.owner, "interactive");
  });

  it("TTL-reclaim: writes a stale lock file on disk and reclaims it (INFRA-C2)", async () => {
    // Write a stale lock file manually (simulates a crashed process that never
    // released its lock).
    const runId = "run-fl-ttl-disk";
    const lockPath = path.join(tmpLockDir, `respawn-lease-${runId}.lock`);
    const staleContent = JSON.stringify({
      owner: "daemon",
      runId,
      claimedAt: new Date(Date.now() - 600_000).toISOString() // 10 min ago
    });
    await writeFile(lockPath, `${staleContent}\n`, "utf8");

    // A new caller should reclaim it.
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir, staleAfterMs: 300_000 });
    const result = await claimRespawnLease(runId, "interactive", store);
    assert.equal(result.granted, true, "stale disk lock must be reclaimed");
    assert.equal(result.owner, "interactive");
  });

  it("in-process contention: N callers race, exactly 1 wins (INFRA-C1)", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    const runId = "run-fl-contend-001";
    const callers = ["daemon", "interactive", "interactive2", "daemon2"];

    const results = await Promise.all(
      callers.map((owner) => claimRespawnLease(runId, owner, store))
    );

    const winners = results.filter((r) => r.granted);
    assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}`);
  });

  // Q1: a corrupt (malformed-JSON) lock file must be reclaimable. The fix's
  // central claim is that readLock → undefined now means "genuinely corrupt or
  // abandoned" (never "mid-creation"), so a new claimant reclaims it.
  it("reclaims a corrupt (malformed-JSON) lock file", async () => {
    const runId = "run-fl-corrupt";
    const lp = path.join(tmpLockDir, `respawn-lease-${runId}.lock`);
    await writeFile(lp, "{ this is not valid json", "utf8");

    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    const result = await claimRespawnLease(runId, "interactive", store);
    assert.equal(result.granted, true, "a corrupt lock must be reclaimed, not deadlock");
    assert.equal(result.owner, "interactive");
    assert.equal(await readRespawnOwner(runId, store), "interactive");
  });

  // Q3: readOwner must report undefined for a stale on-disk lock (the isContentStale
  // path inside readOwner, previously uncovered for the file-lock store).
  it("readOwner returns undefined for a stale on-disk lock", async () => {
    const runId = "run-fl-readowner-stale";
    const lp = path.join(tmpLockDir, `respawn-lease-${runId}.lock`);
    await writeFile(
      lp,
      `${JSON.stringify({ owner: "daemon", runId, claimedAt: new Date(Date.now() - 600_000).toISOString() })}\n`,
      "utf8"
    );
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir, staleAfterMs: 300_000 });
    assert.equal(await readRespawnOwner(runId, store), undefined, "stale lock owner must read as undefined");
  });

  // Q4 / R1: two independent stores concurrently reclaiming the SAME stale lock
  // must yield exactly one winner via the rename() compare-and-swap eviction, not
  // a bare unlink (which let a late racer evict the fresh winner's lock).
  //
  // The stale lock is owned by a THIRD party ("crashed-process") so BOTH
  // claimants take the evictStale path (neither matches the stale owner) — this
  // genuinely exercises the CAS, rather than one caller shortcutting through the
  // same-owner idempotent path.
  it("concurrent stale-reclaim by two independent stores yields exactly one winner (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const runId = `run-fl-stale-race-${round}`;
      const lp = path.join(tmpLockDir, `respawn-lease-${runId}.lock`);
      await writeFile(
        lp,
        `${JSON.stringify({ owner: "crashed-process", runId, claimedAt: new Date(Date.now() - 600_000).toISOString() })}\n`,
        "utf8"
      );

      const storeA = makeFileLockLeaseStore({ lockDir: tmpLockDir, staleAfterMs: 300_000 });
      const storeB = makeFileLockLeaseStore({ lockDir: tmpLockDir, staleAfterMs: 300_000 });
      const [rA, rB] = await Promise.all([
        claimRespawnLease(runId, "interactive", storeA),
        claimRespawnLease(runId, "daemon", storeB)
      ]);

      const granted = [rA, rB].filter((r) => r.granted);
      assert.equal(
        granted.length,
        1,
        `round ${round}: exactly one may reclaim a stale lock, got ${granted.length} ` +
          `(rA=${JSON.stringify(rA)} rB=${JSON.stringify(rB)})`
      );
      // The loser reports the winner as current owner, OR "unknown" if it read lp
      // while the winner was still materializing its lock (evictStale moved the
      // stale lock aside → brief window before tryAtomicCreate links the new one).
      // Both are correct; the invariant that matters is exactly-one-winner (Q-L3).
      const loser = [rA, rB].find((r) => !r.granted);
      assert.ok(
        loser?.currentOwner === granted[0]!.owner || loser?.currentOwner === "unknown",
        `round ${round}: loser currentOwner must be the winner or "unknown", got ${loser?.currentOwner}`
      );
    }
  });

  // R-M1: a daemon restarting to reclaim its OWN stale lock must not clobber a
  // different owner that concurrently evicted+won that stale lock. Because
  // staleness is checked before the same-owner shortcut, the restarting daemon
  // goes through evictStale too — so exactly one winner even here.
  it("same-owner reclaim of a stale lock races safely against a different owner (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const runId = `run-fl-restart-race-${round}`;
      const lp = path.join(tmpLockDir, `respawn-lease-${runId}.lock`);
      // Stale lock owned by "daemon" (the crashed daemon's own lock).
      await writeFile(
        lp,
        `${JSON.stringify({ owner: "daemon", runId, claimedAt: new Date(Date.now() - 600_000).toISOString() })}\n`,
        "utf8"
      );

      const storeDaemon = makeFileLockLeaseStore({ lockDir: tmpLockDir, staleAfterMs: 300_000 });
      const storeInteractive = makeFileLockLeaseStore({ lockDir: tmpLockDir, staleAfterMs: 300_000 });
      const [rD, rI] = await Promise.all([
        claimRespawnLease(runId, "daemon", storeDaemon), // same owner as stale lock
        claimRespawnLease(runId, "interactive", storeInteractive)
      ]);

      const granted = [rD, rI].filter((r) => r.granted);
      assert.equal(
        granted.length,
        1,
        `round ${round}: exactly one winner in daemon-restart race, got ${granted.length} ` +
          `(rD=${JSON.stringify(rD)} rI=${JSON.stringify(rI)})`
      );
    }
  });

  // S3: invalid runIds must be rejected at the store boundary (not silently
  // sanitized into the path while written raw into the JSON).
  it("rejects invalid runIds on tryAcquire / release / readOwner", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    for (const bad of ["run id", "run/../x", "run$(x)", "", "a".repeat(201)]) {
      await assert.rejects(() => claimRespawnLease(bad, "daemon", store), /invalid runId/, `claim ${JSON.stringify(bad)}`);
      await assert.rejects(() => releaseRespawnLease(bad, "daemon", store), /invalid runId/, `release ${JSON.stringify(bad)}`);
      await assert.rejects(() => readRespawnOwner(bad, store), /invalid runId/, `readOwner ${JSON.stringify(bad)}`);
    }
  });

  // R-M2/S-N1: an oversized/invalid owner would bloat the lock JSON past
  // MAX_LOCK_BYTES (→ readLock treats a just-granted lock as corrupt) — reject it.
  it("rejects invalid owners on tryAcquire / release", async () => {
    const store = makeFileLockLeaseStore({ lockDir: tmpLockDir });
    for (const bad of ["owner with spaces", "", "x".repeat(4000)]) {
      await assert.rejects(() => claimRespawnLease("run-owner-check", bad, store), /invalid owner/, `claim owner ${bad.slice(0, 12)}`);
      await assert.rejects(() => releaseRespawnLease("run-owner-check", bad, store), /invalid owner/, `release owner ${bad.slice(0, 12)}`);
    }
  });

  // S4: a lockDir with a traversal segment must be rejected at construction.
  it("rejects a lockDir containing '..' traversal segments", () => {
    assert.throws(
      () => makeFileLockLeaseStore({ lockDir: `${tmpLockDir}/../evil` }),
      /must not contain '\.\.'/,
      "traversal lockDir must be rejected"
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-process contention test (INFRA-C1): TWO child node processes race
// on the SAME runId file-lock; exactly ONE must win.
// ---------------------------------------------------------------------------

describe("makeFileLockLeaseStore cross-process contention (INFRA-C1)", () => {
  it("spawn-count invariant: exactly 1 of 2 child processes wins the file lock", async () => {
    // Write a small claimant script to the scratchpad so we can spawn it.
    const claimantScript = path.join(tmpLockDir, "claimant.mts");
    const lockDir = tmpLockDir;
    // The script claims the lock, prints "granted" or "denied", exits.
    await writeFile(claimantScript, `
import { makeFileLockLeaseStore, claimRespawnLease } from ${JSON.stringify(
      path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
        "..", "src", "runtime", "respawn-lease.ts")
    )};
const owner = process.argv[2] ?? "unknown";
const store = makeFileLockLeaseStore({ lockDir: ${JSON.stringify(lockDir)} });
const result = await claimRespawnLease("run-xproc-001", owner, store);
process.stdout.write(JSON.stringify(result) + "\\n");
`, "utf8");

    function runClaimant(ownerName: string): Promise<string> {
      return new Promise((resolve, reject) => {
        // Strip coverage instrumentation from the child env. Under the coverage
        // gate (c8 sets NODE_V8_COVERAGE/NODE_OPTIONS on the parent, inherited by
        // children) each `--experimental-strip-types` cold start is slow enough to
        // blow a tight timeout — the source of this test's flakiness. The children
        // only exercise the cross-process O_EXCL lock; they need no coverage.
        const childEnv = { ...process.env };
        delete childEnv.NODE_V8_COVERAGE;
        delete childEnv.NODE_OPTIONS;
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", claimantScript, ownerName],
          { stdio: ["ignore", "pipe", "pipe"], env: childEnv }
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
        // Generous bound: two Node cold starts under CI load can take several
        // seconds each. The atomic claim itself is instant — this only guards a
        // genuinely hung child. stderr is surfaced so a real failure is diagnosable.
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`claimant ${ownerName} timed out; stderr=${err.trim()}`));
        }, 30000);
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`claimant ${ownerName} exited ${String(code)}; stderr=${err.trim()}`));
            return;
          }
          resolve(out.trim());
        });
        child.on("error", reject);
      });
    }

    // Spawn both concurrently (not sequentially).
    const [out1, out2] = await Promise.all([
      runClaimant("daemon"),
      runClaimant("interactive")
    ]);

    const r1 = JSON.parse(out1) as { granted: boolean };
    const r2 = JSON.parse(out2) as { granted: boolean };

    const grantedCount = [r1, r2].filter((r) => r.granted).length;
    assert.equal(grantedCount, 1, `cross-process spawn-count must be 1, got ${grantedCount} (r1=${out1} r2=${out2})`);
  });

  // -------------------------------------------------------------------------
  // INFRA-C1 regression (deterministic): the create-then-write window must not
  // let two concurrent claimants both win.
  //
  // Two SEPARATE store instances share the lock dir — separate per-store mutex
  // chains, so their claims for the same runId genuinely race via Promise.all.
  // The guarantee rests on link() atomicity (exactly one of two concurrent links
  // to the same target succeeds), NOT on process-spawn timing, so this is
  // deterministic and fast.
  //
  // Against the previous open("wx")+separate-write implementation this reliably
  // reproduced two winners: the loser hit EEXIST, read the winner's still-empty
  // lock file (readLock → undefined), treated it as corrupt, and overwrote it.
  // -------------------------------------------------------------------------

  it("two independent stores racing a FRESH lock yield exactly one winner (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const runId = `run-xproc-fresh-${round}`;
      const storeA = makeFileLockLeaseStore({ lockDir: tmpLockDir });
      const storeB = makeFileLockLeaseStore({ lockDir: tmpLockDir });

      const [rA, rB] = await Promise.all([
        claimRespawnLease(runId, "daemon", storeA),
        claimRespawnLease(runId, "interactive", storeB)
      ]);

      const granted = [rA, rB].filter((r) => r.granted);
      assert.equal(
        granted.length,
        1,
        `round ${round}: exactly one claimant may win a fresh lock, got ${granted.length} ` +
          `(rA=${JSON.stringify(rA)} rB=${JSON.stringify(rB)})`
      );
      // The loser must report the winner as the current owner.
      const loser = [rA, rB].find((r) => !r.granted);
      assert.equal(loser?.currentOwner, granted[0]!.owner, `round ${round}: loser must see the winner`);
    }
  });
});
