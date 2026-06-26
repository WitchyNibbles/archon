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
});
