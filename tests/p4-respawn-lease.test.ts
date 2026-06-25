// Phase 4 (ahrP4InteractiveWatcher): unit tests for respawn-lease.ts
//
// RED phase — these must fail before respawn-lease.ts is created.
//
// Key contracts under test:
//   INFRA-C1: claimRespawnLease is ATOMIC — two simultaneous callers for the
//             same runId must result in exactly ONE winner. Contention test
//             asserts claimer count == 1, not merely idempotent consume.
//   INFRA-C2: advisory lock carries TTL semantics via connection-close auto-release.
//             We verify that when a claimant "disconnects" (simulate via released
//             flag), a new caller can claim the same lease.
//   INFRA-C3 is exercised in p4-stop-hook.test.ts (file write path).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claimRespawnLease,
  releaseRespawnLease,
  readRespawnOwner,
  makeInMemoryLeaseStore
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
