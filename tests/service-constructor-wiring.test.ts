/**
 * Regression guard for the ArchonCoreService constructor wiring invariant
 * (resolves the slice-4 carried LOW).
 *
 * The managers wired in the ArchonCoreService constructor form several mutually-
 * referencing pairs/rings — statusPlanner<->recovery, gateClosure<->taskLifecycle,
 * and the gateClosure->memorySearch->statusPlanner->gateClosure ring. Each cross-
 * manager dependency is a LAZY `this.<field>` arrow closure that is only evaluated
 * when the wrapped method is actually invoked. Because every manager constructor
 * only STORES its deps (it never invokes them), construction order is immaterial
 * and no closure can ever read a manager field before it is assigned.
 *
 * The carried LOW was that this safety was implicit: the statusPlanner closure
 * textually references `this.recovery` before `this.recovery` is assigned, which
 * is only safe because the read is lazy. If a future refactor converted any such
 * dep from a lazy `this.<field>` read into an EAGER capture (e.g.
 * `const r = this.recovery;` outside the arrow), the captured value would be
 * `undefined` and the first cross-manager call would throw
 * "Cannot read properties of undefined".
 *
 * This test locks the invariant down: it constructs the service and, WITHOUT any
 * warm-up, immediately drives every mutually-recursive path across the freshly-
 * wired managers. It fails fast (TypeError) if any cross-manager dep is ever
 * converted from a lazy read into an eager pre-initialization capture.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ArchonCoreService } from "../src/core/service.ts";
import { createTrustedReviewActionContextForTest } from "../src/core/review-context.ts";
import type { ResolveReviewActionContext } from "../src/core/review-context.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import type { TaskPacketInput } from "../src/domain/types.ts";

function resolver(): ResolveReviewActionContext {
  return async (input) =>
    createTrustedReviewActionContextForTest({
      actor: input.actor,
      actorRole: input.reviewerRole
    });
}

function packet(taskId: string): TaskPacketInput {
  return {
    taskId,
    title: `Task ${taskId}`,
    ownerRole: "backend_engineer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["backend_engineer"],
    qualityGates: ["product_acceptance"],
    goal: "test goal",
    inputs: [],
    outputs: [],
    dependencies: [],
    allowedWriteScope: ["src/"],
    outOfScope: [],
    acceptanceCriteria: ["passes tests"],
    verificationSteps: ["npm test"],
    securityChecks: ["validate inputs"],
    antiPatterns: ["no hardcoded secrets"],
    rollbackNotes: "revert",
    handoffFormat: "summary only",
    requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"],
    reasoningPolicy: { mode: "legacy" }
  };
}

test("ArchonCoreService: freshly-constructed service drives every mutually-recursive manager path", async () => {
  const service = new ArchonCoreService(new MemoryStore(), {
    resolveReviewActionContext: resolver()
  });

  // Seed a real run + task graph so the cross-manager derivations have data.
  const run = await service.intakeRequest({
    workspaceSlug: "ws-wiring",
    projectSlug: "proj-wiring",
    actor: "manager",
    title: "constructor wiring regression",
    request: "prove no closure captures a pre-initialization manager field"
  });
  await service.createTaskGraph(run.id, [packet("task-a")]);

  // getStatus → statusPlanner.findTaskBlockers → gateClosure.findTaskBlockers
  // (gateClosure<->taskLifecycle ring + gateClosure-owned blocker helper).
  const status = await service.getStatus(run.id);
  assert.equal(status.run.id, run.id);

  // getExecutionPlan → statusPlanner.inspectRecovery → recovery.inspectRecovery
  // → recovery.getStatus → statusPlanner.getStatus (statusPlanner<->recovery pair,
  // both edges crossed in one call).
  const plan = await service.getExecutionPlan(run.id);
  assert.equal(plan.runId, run.id);

  // inspectRecovery directly (recovery.getStatus → statusPlanner.getStatus again,
  // plus recovery.syncRunState → taskLifecycle on applyRecovery below).
  const inspection = await service.inspectRecovery(run.id);
  assert.equal(inspection.runId, run.id);

  // applyRecovery with no selected actions exercises recovery.syncRunState →
  // taskLifecycle and recovery.getStatus → statusPlanner in one call.
  const applied = await service.applyRecovery(run.id, []);
  assert.equal(applied.mode, "applied");

  // recommendRouting / resumeRun round out the planner surface.
  await service.recommendRouting(run.id);
  await service.resumeRun(run.id);

  // No exception thrown ⇒ every lazy `this.<field>` closure resolved a fully-
  // initialized manager. An eager pre-init capture would have thrown a TypeError
  // on the first cross-manager hop above.
  assert.ok(true);
});
