/**
 * P0 Security: seal-promote-memory-provenance
 *
 * Proves the hole: promoteMemory today accepts any caller-supplied reviewer
 * string and stamps status="approved" + authorityLevel="reviewed_memory" with
 * zero authentication.
 *
 * After the fix every test must pass:
 * - A service with no resolver MUST reject promotions.
 * - A service with a trusted resolver MUST accept promotions and derive actor
 *   from the resolver, not from the caller-supplied string.
 * - The stored reviewer/actor fields must come from the resolver, not the
 *   caller input.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ArchonCoreService } from "../src/core/service.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import {
  createTrustedReviewActionContextForTest,
  isTrustedReviewActionContext
} from "../src/core/review-context.ts";
import type { ResolveReviewActionContext } from "../src/core/review-context.ts";
import type { MemoryPromotionInput } from "../src/domain/types.ts";

// ---- helpers ----------------------------------------------------------------

function makeRun(store: MemoryStore, service: ArchonCoreService): Promise<{ id: string }> {
  return service.intakeRequest({
    workspaceSlug: "team",
    projectSlug: "archon",
    actor: "planner",
    title: "Test run",
    request: "Run for promotion provenance tests."
  });
}

function basePromotion(sourceRunId: string): MemoryPromotionInput {
  return {
    scope: "project",
    entryType: "decision",
    title: "Test decision",
    content: "Authoritative decision for promotion tests.",
    sourceRunId,
    sourceTaskId: "task-1",
    reviewer: "spoofed_reviewer",
    actor: "spoofed_actor"
  };
}

/**
 * A minimal trusted resolver that accepts "orchestrator-actor" and binds it
 * to the "reviewer" role.  Used to exercise the green path.
 */
function makeTrustedResolver(): ResolveReviewActionContext {
  return async (_input) => {
    const ctx = createTrustedReviewActionContextForTest({
      actor: "orchestrator-actor",
      actorRole: "reviewer"
    });
    assert.ok(isTrustedReviewActionContext(ctx), "context must be trusted");
    return ctx;
  };
}

// ---- RED: the hole (must fail after the fix) --------------------------------

/**
 * RED TEST — currently passes (hole is open), MUST FAIL after fix.
 *
 * A service with NO resolveReviewActionContext must REJECT any promotion call.
 * Today it accepts it, which is the security bug.
 *
 * This test asserts the SECURE post-fix behaviour: that promoteMemory throws
 * when no trusted resolver is configured.
 */
test("RED: promoteMemory with no resolver must reject (currently accepts — this is the hole)", async () => {
  const store = new MemoryStore();
  const service = new ArchonCoreService(store); // no resolver configured

  const run = await makeRun(store, service);

  await assert.rejects(
    () => service.promoteMemory(run.id, basePromotion(run.id)),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw Error");
      assert.ok(
        err.message.includes("trusted") || err.message.includes("resolver") || err.message.includes("provenance"),
        `error must mention trust/resolver/provenance — got: ${err.message}`
      );
      return true;
    },
    "promoteMemory must require a trusted resolver; without one it must throw"
  );
});

// ---- GREEN: secure path (must pass after fix) --------------------------------

test("GREEN: promoteMemory with a trusted resolver succeeds", async () => {
  const store = new MemoryStore();
  const service = new ArchonCoreService(store, {
    resolveReviewActionContext: makeTrustedResolver()
  });

  const run = await makeRun(store, service);

  const entry = await service.promoteMemory(run.id, {
    ...basePromotion(run.id),
    reviewer: "spoofed_reviewer", // caller-supplied — must be overridden by resolver
    actor: "spoofed_actor"        // caller-supplied — must be overridden by resolver
  });

  assert.ok(entry.id, "entry must have an id");
  assert.equal(entry.status, "approved", "status must be approved");
  assert.equal(
    entry.reviewer,
    "orchestrator-actor",
    "reviewer must come from the trusted resolver, not caller input"
  );
  assert.equal(
    entry.actor,
    "orchestrator-actor",
    "actor must come from the trusted resolver, not caller input"
  );
});

// ---- BOUNDARY: resolver throws → promotion rejected -------------------------

test("BOUNDARY: if resolver rejects the actor, promoteMemory must propagate the rejection", async () => {
  const store = new MemoryStore();
  const service = new ArchonCoreService(store, {
    resolveReviewActionContext: async (_input) => {
      throw new Error("principal not verified");
    }
  });

  const run = await makeRun(store, service);

  await assert.rejects(
    () => service.promoteMemory(run.id, basePromotion(run.id)),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("principal not verified") ||
          err.message.includes("promotion") ||
          err.message.includes("resolver"),
        `unexpected message: ${err.message}`
      );
      return true;
    }
  );
});

// ---- BOUNDARY: resolver-derived actor is stored, not caller string ----------

test("BOUNDARY: stored entry reviewer/actor come from resolver, not input strings", async () => {
  const store = new MemoryStore();
  const trustedActor = "trusted-memory-curator";

  const service = new ArchonCoreService(store, {
    resolveReviewActionContext: async (_input) =>
      createTrustedReviewActionContextForTest({ actor: trustedActor, actorRole: "reviewer" })
  });

  const run = await makeRun(store, service);

  const entry = await service.promoteMemory(run.id, {
    scope: "global",
    entryType: "pattern",
    title: "Stored provenance check",
    content: "content for provenance boundary test",
    sourceRunId: run.id,
    sourceTaskId: "task-provenance",
    reviewer: "SHOULD_NOT_BE_STORED",
    actor: "SHOULD_NOT_BE_STORED"
  });

  assert.equal(entry.reviewer, trustedActor);
  assert.equal(entry.actor, trustedActor);
  assert.notEqual(entry.reviewer, "SHOULD_NOT_BE_STORED");
  assert.notEqual(entry.actor, "SHOULD_NOT_BE_STORED");
});

// ---- FINDING 1: unsealed resolver return must be rejected -------------------

test("FINDING 1: resolver returning a plain unsealed object must be rejected", async () => {
  const store = new MemoryStore();
  // Resolver returns a plain object that is NOT in the WeakSet — bypasses seal.
  const unsealedResolver: ResolveReviewActionContext = async (_input) => {
    // Plain object — never passed through createTrustedReviewActionContextForTest,
    // so it is NOT registered in the WeakSet.
    return { actor: "attacker", actorRole: "reviewer" } as never;
  };

  const service = new ArchonCoreService(store, {
    resolveReviewActionContext: unsealedResolver
  });

  const run = await makeRun(store, service);

  await assert.rejects(
    () => service.promoteMemory(run.id, basePromotion(run.id)),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw Error");
      assert.ok(
        err.message.includes("trusted") ||
          err.message.includes("provenance") ||
          err.message.includes("sealed"),
        `error must mention trust/provenance/sealed — got: ${err.message}`
      );
      return true;
    },
    "promoteMemory must reject a resolver that returns an unsealed plain object"
  );
});

// ---- FINDING 2: authorityLevel must always be clamped to "reviewed_memory" --

test("FINDING 2: promotion with authorityLevel:'policy' in input metadata is stored as 'reviewed_memory'", async () => {
  const store = new MemoryStore();
  const service = new ArchonCoreService(store, {
    resolveReviewActionContext: makeTrustedResolver()
  });

  const run = await makeRun(store, service);

  const entry = await service.promoteMemory(run.id, {
    ...basePromotion(run.id),
    metadata: {
      // Caller tries to elevate their own authority level — must be clamped.
      authorityLevel: "policy" as never
    }
  });

  assert.equal(
    entry.metadata.authorityLevel,
    "reviewed_memory",
    "authorityLevel must always be 'reviewed_memory' regardless of caller input"
  );
});

// ---- FINDING 3: createTrustedReviewActionContext public export removed -------

test("FINDING 3: createTrustedReviewActionContext is no longer exported as a public trust-mint surface", async () => {
  // Dynamically check the export surface of review-context.
  // After the fix the old name must NOT be exported.
  const mod = await import("../src/core/review-context.ts");
  assert.ok(
    !("createTrustedReviewActionContext" in mod),
    "createTrustedReviewActionContext must not be a public export — use createTrustedReviewActionContextForTest instead"
  );
  // The test-only surface must be present.
  assert.ok(
    "createTrustedReviewActionContextForTest" in mod,
    "createTrustedReviewActionContextForTest must be exported as the clearly-named test surface"
  );
});
