// Tests for slices 2–4 of the Option B review-floor relaxation.
//
// Slice 2: immutable `class` column guard.
// Slice 3: review_floor_reductions provenance (stub-only at this level — SQL is tested separately).
// Slice 4: effectiveRequiredReviewsForTask wired into the three gate sites.
//
// These tests are written FIRST (TDD red phase) and must remain the canonical
// regression guard for the gate contract changes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildInitiativeRecords } from "../src/admin/init-task.ts";
import {
  effectiveRequiredReviewsForTask,
  effectiveRequiredReviews
} from "../src/domain/contracts.ts";
import { isReviewFloorReduced } from "../src/domain/contracts.ts";
import { evaluateReviewDecision, collectUnsatisfiedReviewRoles } from "../src/core/policy.ts";
import { requiredGateReviews } from "../src/domain/types.ts";
import type { TaskRecord, ReviewRecord, ReviewFloorReductionRecord } from "../src/domain/types.ts";
import type { TaskClass } from "../src/domain/task-class.ts";
import { MemoryStore } from "../src/store/memory-store.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_NOW = "2026-01-01T00:00:00.000Z";

function makeTask(
  cls: TaskClass,
  allowedWriteScope: string[],
  requiredReviews: ("reviewer" | "security_reviewer" | "qa_engineer")[] = []
): TaskRecord {
  return {
    id: "task-uuid-1",
    runId: "run-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    class: cls,
    packet: {
      taskId: "test-task",
      title: "Test task",
      ownerRole: "backend_engineer",
      completionStandard: "artifact_complete",
      requiredSpecialistRoles: [],
      qualityGates: [],
      goal: "Test goal",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope,
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews,
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: ""
    },
    status: "in_progress",
    createdAt: BASE_NOW,
    updatedAt: BASE_NOW
  };
}

function makeReview(
  role: "reviewer" | "security_reviewer" | "qa_engineer",
  state: "passed" | "failed" | "waived" = "passed"
): ReviewRecord {
  return {
    id: `review-${role}`,
    runId: "run-1",
    taskId: "test-task",
    reviewerRole: role,
    actor: "orchestrator",
    actorRole: "reviewer",
    source: "orchestrator",
    state,
    severity: "low",
    findings: [],
    evidenceRefs: [],
    createdAt: BASE_NOW
  };
}

// ---------------------------------------------------------------------------
// Slice 2: immutable class in TaskRecord
// ---------------------------------------------------------------------------

test("slice 2: buildInitiativeRecords sets task.class to the validated taskClass", () => {
  const result = buildInitiativeRecords({
    id: "my-task",
    title: "My task",
    ownerRole: "planner",
    goal: "Do stuff",
    allowedWriteScope: ["sandbox/"],
    workspaceId: "ws-1",
    projectId: "proj-1",
    runId: "run-1",
    taskUuid: "uuid-1",
    now: BASE_NOW,
    class: "docs_only"
  });
  assert.equal(result.task.class, "docs_only");
  assert.equal(result.taskClass, "docs_only");
});

test("slice 2: buildInitiativeRecords defaults task.class to prototype_slice when unspecified", () => {
  const result = buildInitiativeRecords({
    id: "my-task",
    title: "My task",
    ownerRole: "planner",
    goal: "Do stuff",
    allowedWriteScope: ["sandbox/"],
    workspaceId: "ws-1",
    projectId: "proj-1",
    runId: "run-1",
    taskUuid: "uuid-1",
    now: BASE_NOW
  });
  assert.equal(result.task.class, "prototype_slice");
});

test("slice 2: makeTask helper produces a TaskRecord with a class field", () => {
  const task = makeTask("memory_curation", [".archon/work/scratch"]);
  assert.equal(task.class, "memory_curation");
});

// ---------------------------------------------------------------------------
// Slice 4: effectiveRequiredReviewsForTask - core contract
// ---------------------------------------------------------------------------

test("slice 4: prototype_slice always returns full trio regardless of scope", () => {
  const task = makeTask("prototype_slice", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: security_sensitive always returns full trio regardless of scope", () => {
  const task = makeTask("security_sensitive", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: release_candidate always returns full trio regardless of scope", () => {
  const task = makeTask("release_candidate", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: docs_only with safe scope and flag ON returns [reviewer] only", () => {
  const task = makeTask("docs_only", [".archon/work/scratch"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor, ["reviewer"]);
});

test("slice 4: state_sync with safe scope and flag ON returns [reviewer] only", () => {
  const task = makeTask("state_sync", [".archon/work/state"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor, ["reviewer"]);
});

test("slice 4: memory_curation with safe scope and flag ON returns [reviewer] only", () => {
  const task = makeTask("memory_curation", [".archon/work/scratch"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor, ["reviewer"]);
});

test("slice 4: scaffold_only with safe scope and flag ON returns [reviewer] only", () => {
  const task = makeTask("scaffold_only", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor, ["reviewer"]);
});

test("slice 4: docs_only with flag OFF returns full trio (default safe)", () => {
  const task = makeTask("docs_only", [".archon/work/scratch"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: false });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: docs_only with deny scope (CLAUDE.md) and flag ON returns full trio", () => {
  const task = makeTask("docs_only", ["CLAUDE.md"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: docs_only with deny scope (.claude) and flag ON returns full trio", () => {
  const task = makeTask("docs_only", [".claude"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: docs_only with deny scope (.archon/rules) and flag ON returns full trio", () => {
  const task = makeTask("docs_only", [".archon/rules"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: docs_only with empty scope and flag ON returns full trio (deny-by-default)", () => {
  const task = makeTask("docs_only", []);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: docs_only with mixed safe+deny scope and flag ON returns full trio", () => {
  const task = makeTask("docs_only", ["sandbox/ok", ".claude/hooks/x"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: effectiveRequiredReviewsForTask with no options returns full trio (flag default OFF)", () => {
  const task = makeTask("docs_only", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task);
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: additive requiredReviews in packet still unions on top of floor (non-opt-out task)", () => {
  // A prototype_slice with a packet-level required 'security_reviewer' should still get the trio.
  const task = makeTask("prototype_slice", ["src/"], ["security_reviewer"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: additive requiredReviews in packet on opt-out task — packet can only add roles, not remove trio roles", () => {
  // With flag OFF the full trio floor still applies. Packet requiredReviews can only ADD.
  const task = makeTask("docs_only", ["sandbox/"], ["security_reviewer"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: false });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

// ---------------------------------------------------------------------------
// Slice 4: env var flag resolution (ARCHON_REVIEW_FLOOR_REDUCTION)
// ---------------------------------------------------------------------------

test("slice 4: env ARCHON_REVIEW_FLOOR_REDUCTION=1 enables reduction", () => {
  const task = makeTask("docs_only", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task, { env: { ARCHON_REVIEW_FLOOR_REDUCTION: "1" } });
  assert.deepEqual(floor, ["reviewer"]);
});

test("slice 4: env ARCHON_REVIEW_FLOOR_REDUCTION=true enables reduction", () => {
  const task = makeTask("docs_only", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task, { env: { ARCHON_REVIEW_FLOOR_REDUCTION: "true" } });
  assert.deepEqual(floor, ["reviewer"]);
});

test("slice 4: env ARCHON_REVIEW_FLOOR_REDUCTION=0 keeps full trio", () => {
  const task = makeTask("docs_only", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task, { env: { ARCHON_REVIEW_FLOOR_REDUCTION: "0" } });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: env ARCHON_REVIEW_FLOOR_REDUCTION absent keeps full trio", () => {
  const task = makeTask("docs_only", ["sandbox/"]);
  const floor = effectiveRequiredReviewsForTask(task, { env: {} });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

// ---------------------------------------------------------------------------
// Slice 4: Anti-drift — all three gate sites must agree on the floor
// ---------------------------------------------------------------------------

test("slice 4: anti-drift — evaluateReviewDecision uses same floor as effectiveRequiredReviewsForTask (opt-out reduced)", () => {
  // Flag ON, docs_only safe scope → floor is [reviewer].
  // Build task with process.env flag temporarily set.
  const OLD_ENV = process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
  process.env.ARCHON_REVIEW_FLOOR_REDUCTION = "1";
  try {
    const task = makeTask("docs_only", [".archon/work/scratch"]);
    const expectedFloor = effectiveRequiredReviewsForTask(task);
    assert.deepEqual(expectedFloor, ["reviewer"]);

    // evaluateReviewDecision with ONLY a reviewer review should approve.
    const reviews: ReviewRecord[] = [makeReview("reviewer")];
    const decision = evaluateReviewDecision(task, reviews);
    assert.equal(decision.decision, "approved", `expected approved but got: ${decision.blockers.join("; ")}`);
  } finally {
    if (OLD_ENV === undefined) {
      delete process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
    } else {
      process.env.ARCHON_REVIEW_FLOOR_REDUCTION = OLD_ENV;
    }
  }
});

test("slice 4: anti-drift — evaluateReviewDecision uses same floor as effectiveRequiredReviewsForTask (full trio required)", () => {
  const OLD_ENV = process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
  process.env.ARCHON_REVIEW_FLOOR_REDUCTION = "1";
  try {
    // prototype_slice → always trio.
    const task = makeTask("prototype_slice", ["sandbox/"]);
    const expectedFloor = effectiveRequiredReviewsForTask(task);
    assert.deepEqual(expectedFloor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);

    // Only one review provided → must block.
    const reviews: ReviewRecord[] = [makeReview("reviewer")];
    const decision = evaluateReviewDecision(task, reviews);
    assert.equal(decision.decision, "blocked");
  } finally {
    if (OLD_ENV === undefined) {
      delete process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
    } else {
      process.env.ARCHON_REVIEW_FLOOR_REDUCTION = OLD_ENV;
    }
  }
});

test("slice 4: anti-drift — collectUnsatisfiedReviewRoles uses same floor as effectiveRequiredReviewsForTask", () => {
  const OLD_ENV = process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
  process.env.ARCHON_REVIEW_FLOOR_REDUCTION = "1";
  try {
    const task = makeTask("docs_only", [".archon/work/scratch"]);
    const expectedFloor = effectiveRequiredReviewsForTask(task);
    assert.deepEqual(expectedFloor, ["reviewer"]);

    // With only a reviewer review, unsatisfied should be empty.
    const reviews: ReviewRecord[] = [makeReview("reviewer")];
    const unsatisfied = collectUnsatisfiedReviewRoles(task, reviews);
    assert.deepEqual(unsatisfied, []);
  } finally {
    if (OLD_ENV === undefined) {
      delete process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
    } else {
      process.env.ARCHON_REVIEW_FLOOR_REDUCTION = OLD_ENV;
    }
  }
});

test("slice 4: anti-drift — collectUnsatisfiedReviewRoles still blocks when missing roles", () => {
  const OLD_ENV = process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
  process.env.ARCHON_REVIEW_FLOOR_REDUCTION = "1";
  try {
    // prototype_slice with only reviewer → security_reviewer + qa_engineer still unsatisfied.
    const task = makeTask("prototype_slice", ["sandbox/"]);
    const reviews: ReviewRecord[] = [makeReview("reviewer")];
    const unsatisfied = collectUnsatisfiedReviewRoles(task, reviews);
    assert.ok(unsatisfied.includes("security_reviewer"), "missing security_reviewer");
    assert.ok(unsatisfied.includes("qa_engineer"), "missing qa_engineer");
  } finally {
    if (OLD_ENV === undefined) {
      delete process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
    } else {
      process.env.ARCHON_REVIEW_FLOOR_REDUCTION = OLD_ENV;
    }
  }
});

// ---------------------------------------------------------------------------
// Slice 4: each deny-listed root forces trio even for opt-out classes
// ---------------------------------------------------------------------------

const denyListedScopeEntries = [
  ".archon/rules",
  ".archon/memory",
  ".archon/ACTIVE",
  "CLAUDE.md",
  "AGENTS.md",
  ".claude",
  ".codex",
  "README.md",
  "docs",
  ".agents/skills"
];

for (const denyEntry of denyListedScopeEntries) {
  test(`slice 4: docs_only with deny scope ${denyEntry} returns full trio`, () => {
    const task = makeTask("docs_only", [denyEntry]);
    const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
    assert.deepEqual(
      floor.sort(),
      ["qa_engineer", "reviewer", "security_reviewer"],
      `expected trio for deny scope ${denyEntry}`
    );
  });
}

// ---------------------------------------------------------------------------
// Slice 4: effectiveRequiredReviews (old function) still works for backward compat
// ---------------------------------------------------------------------------

test("slice 4: legacy effectiveRequiredReviews always seeds full trio (backward compat)", () => {
  const floor = effectiveRequiredReviews([]);
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

test("slice 4: legacy effectiveRequiredReviews with undefined seeds full trio", () => {
  const floor = effectiveRequiredReviews(undefined);
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

// ---------------------------------------------------------------------------
// Fix A regression: the reduced floor must NOT union the stored trio.
// validateTaskPacket forces every validated packet to store the full trio in
// requiredReviews; if the reduced branch unioned requiredReviews it would re-add
// security_reviewer + qa_engineer and silently nullify the reduction. This is the
// validated-packet case that the original implementation got wrong.
// ---------------------------------------------------------------------------

test("Fix A: docs_only + safe scope + flag ON + stored full trio in requiredReviews still reduces to [reviewer]", () => {
  const task = makeTask("docs_only", ["sandbox/"], ["reviewer", "security_reviewer", "qa_engineer"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  assert.deepEqual(floor, ["reviewer"]);
});

test("Fix A: same task with flag OFF keeps the full trio (no reduction without the flag)", () => {
  const task = makeTask("docs_only", ["sandbox/"], ["reviewer", "security_reviewer", "qa_engineer"]);
  const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: false });
  assert.deepEqual(floor.sort(), ["qa_engineer", "reviewer", "security_reviewer"]);
});

// ---------------------------------------------------------------------------
// Shared predicate: isReviewFloorReduced is the single source of truth that both
// the gate floor and the provenance write consume (condition 5: no drift).
// ---------------------------------------------------------------------------

test("isReviewFloorReduced: true only for opt-out class + safe scope + flag ON", () => {
  assert.equal(
    isReviewFloorReduced(makeTask("docs_only", ["sandbox/"]), { reductionEnabled: true }),
    true
  );
});

test("isReviewFloorReduced: false when flag OFF, non-opt-out class, or unsafe scope", () => {
  assert.equal(isReviewFloorReduced(makeTask("docs_only", ["sandbox/"]), { reductionEnabled: false }), false);
  assert.equal(isReviewFloorReduced(makeTask("prototype_slice", ["sandbox/"]), { reductionEnabled: true }), false);
  assert.equal(isReviewFloorReduced(makeTask("docs_only", [".claude/hooks/x.mjs"]), { reductionEnabled: true }), false);
  assert.equal(isReviewFloorReduced(makeTask("docs_only", []), { reductionEnabled: true }), false);
});

test("isReviewFloorReduced agrees with effectiveRequiredReviewsForTask (no drift)", () => {
  for (const cls of ["docs_only", "state_sync", "memory_curation", "scaffold_only", "prototype_slice", "security_sensitive", "release_candidate"] as TaskClass[]) {
    for (const scope of [["sandbox/"], [".archon/rules"], []]) {
      for (const enabled of [true, false]) {
        const task = makeTask(cls, scope);
        const reduced = isReviewFloorReduced(task, { reductionEnabled: enabled });
        const floor = effectiveRequiredReviewsForTask(task, { reductionEnabled: enabled });
        assert.equal(
          reduced,
          floor.length === 1 && floor[0] === "reviewer",
          `drift for ${cls}/${JSON.stringify(scope)}/${enabled}`
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Fix B: provenance row derivation + store idempotency / readback.
// ---------------------------------------------------------------------------

function buildReductionRecord(task: TaskRecord, decidedAt: string): ReviewFloorReductionRecord {
  // Mirrors the exact derivation in service.recordReview's approval branch.
  const effectiveFloor = effectiveRequiredReviewsForTask(task, { reductionEnabled: true });
  const droppedRoles = requiredGateReviews.filter((role) => !effectiveFloor.includes(role));
  return {
    id: `red-${decidedAt}`,
    runId: task.runId,
    taskId: task.packet.taskId,
    derivedClass: task.class,
    droppedRoles: [...droppedRoles],
    effectiveFloor: [...effectiveFloor],
    writeScopeSnapshot: [...task.packet.allowedWriteScope],
    basis: "opt_out_class+scope_review_safe",
    source: "runtime",
    decidedAt
  };
}

test("Fix B: a reduced approval derives effectiveFloor=[reviewer], droppedRoles=[security_reviewer,qa_engineer]", () => {
  const task = makeTask("docs_only", ["sandbox/"], ["reviewer", "security_reviewer", "qa_engineer"]);
  const record = buildReductionRecord(task, BASE_NOW);
  assert.deepEqual(record.effectiveFloor, ["reviewer"]);
  assert.deepEqual(record.droppedRoles.sort(), ["qa_engineer", "security_reviewer"]);
  assert.deepEqual(record.writeScopeSnapshot, ["sandbox/"]);
  assert.equal(record.derivedClass, "docs_only");
});

test("Fix B: saveReviewFloorReduction is idempotent on (runId,taskId,decidedAt) and readable", async () => {
  const store = new MemoryStore();
  const task = makeTask("docs_only", ["sandbox/"]);
  const record = buildReductionRecord(task, BASE_NOW);

  await store.saveReviewFloorReduction(record);
  await store.saveReviewFloorReduction({ ...record, id: "different-id" }); // same key → no dup

  const rows = await store.getReviewFloorReductions(task.runId, task.packet.taskId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.effectiveFloor, ["reviewer"]);

  // A distinct decision event (different decidedAt) is recorded as audit history.
  await store.saveReviewFloorReduction(buildReductionRecord(task, "2026-02-02T00:00:00.000Z"));
  const rows2 = await store.getReviewFloorReductions(task.runId, task.packet.taskId);
  assert.equal(rows2.length, 2);
});
