/**
 * Direct unit tests for GateClosureManager (src/core/gate-closure-manager.ts).
 *
 * This module was extracted from ArchonCoreService (audit F5 / service.ts split
 * slice 5). It is the COMPLETION AUTHORITY of the runtime, so these tests exercise
 * the manager class DIRECTLY against a MemoryStore double + injected deps
 * (requireTask / bumpRunState / resolver / promoteMemory), asserting the gate
 * BOTH ways — it approves only when the floor is met and refuses every other case
 * — so a drift in the trust-context checks, floor-reduction provenance, capture
 * ordering, or dependency-staleness derivation fails here rather than only through
 * the service-level suites.
 *
 * Coverage (cold paths the service-level suites don't isolate):
 *   - submitHandoff: not-in-progress refusal; ownerRole/completionStandard/
 *     validateHandoff refusals; happy path (task → review_blocked, run bumped,
 *     record fields); onHandoff fired; onHandoff error swallowed.
 *   - recordReview REFUSED: missing resolver; not-review_blocked; resolver throw;
 *     unsealed/mismatched context (validateReviewAction); full-trio task with one
 *     review stays review_blocked with blockers.
 *   - recordReview SATISFIED: reduced-floor approval writes the ReviewFloor-
 *     ReductionRecord + releases locks; full-trio approval writes NO reduction
 *     record; reviewSource "seed" provenance stamped on review + approval.
 *   - findings derivation (P2.1/P1.5): accepted findingDetails → derived; clean
 *     pass with provenance-only findingDetails keeps caller findings.
 *   - mistake-ledger capture fires BEFORE distillation, non-blocking.
 *   - findTaskBlockers: base pass-through + stale-dependency reblock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { GateClosureManager } from "../src/core/gate-closure-manager.ts";
import type { HandoffLifecycleEvent } from "../src/core/gate-closure-manager.ts";
import { TaskLifecycleManager } from "../src/core/task-lifecycle.ts";
import { MemorySearchManager } from "../src/core/memory-search-manager.ts";
import { AutonomousExecutionStore } from "../src/core/autonomous-execution-store.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import { createTrustedReviewActionContextForTest } from "../src/core/review-context.ts";
import type { ResolveReviewActionContext } from "../src/core/review-context.ts";
import {
  findBlockingReasonsForTask,
  findTaskDependencies,
  evaluateReviewDecision
} from "../src/core/policy.ts";
import type { ArchonStore } from "../src/store/types.ts";
import type {
  AntiPatternDraftStoreLike,
  MistakeLedgerStoreLike
} from "../src/store/types.ts";
import type {
  HandoffInput,
  LockRecord,
  ReviewInput,
  RunRecord,
  TaskPacketInput,
  TaskRecord
} from "../src/domain/types.ts";
import { isOptOutClass, type TaskClass } from "../src/domain/task-class.ts";

interface Harness {
  store: ArchonStore;
  gate: GateClosureManager;
  lifecycle: TaskLifecycleManager;
}

interface HarnessOptions {
  reviewSource?: "orchestrator" | "seed";
  resolver?: ResolveReviewActionContext;
  onHandoff?: (event: HandoffLifecycleEvent) => Promise<void>;
  mistakeLedgerStore?: MistakeLedgerStoreLike;
  antiPatternDraftStore?: AntiPatternDraftStoreLike;
  promoteMemorySpy?: (runId: string, input: unknown) => Promise<unknown>;
}

// Resolver returns actorRole === reviewerRole so validateReviewAction's
// "actorRole cannot record <role> review" check passes for any gate role.
function trustedResolver(): ResolveReviewActionContext {
  return async (input) =>
    createTrustedReviewActionContextForTest({
      actor: input.actor,
      actorRole: input.reviewerRole
    });
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const store = new MemoryStore();
  const requireRun = async (runId: string): Promise<RunRecord> => {
    const found = await store.getRun(runId);
    if (!found) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return found;
  };
  const requireTask = async (runId: string, taskId: string): Promise<TaskRecord> => {
    const found = await store.getTask(runId, taskId);
    if (!found) {
      throw new Error(`Unknown task ${taskId} for run ${runId}`);
    }
    return found;
  };
  const autonomous = new AutonomousExecutionStore({ store, requireRun });
  // Forward closure to the not-yet-constructed gate (mirrors the composition-root
  // lazy-wiring pattern: closures read `gate` only at call time, never during
  // construction, so the forward reference is safe).
  const lifecycle = new TaskLifecycleManager({
    store,
    requireRun,
    requireTask,
    findTaskBlockers: (task, allTasks, activeLocks) =>
      gate.findTaskBlockers(task, allTasks, activeLocks),
    saveAutonomousExecutionState: (run, update) => autonomous.saveState(run, update)
  });
  const memorySearch = new MemorySearchManager({
    store,
    requireRun,
    // promoteMemory never touches getStatus; a throwing stub proves it isn't hit.
    getStatus: async () => {
      throw new Error("getStatus not wired in gate-closure harness");
    },
    bumpRunState: (runId, status) => lifecycle.bumpRunState(runId, status),
    resolveReviewActionContext: options.resolver
  });
  const gate = new GateClosureManager({
    store,
    requireTask,
    bumpRunState: (runId, status) => lifecycle.bumpRunState(runId, status),
    reviewSource: options.reviewSource ?? "orchestrator",
    onHandoff: options.onHandoff,
    resolveReviewActionContext: options.resolver,
    mistakeLedgerStore: options.mistakeLedgerStore,
    antiPatternDraftStore: options.antiPatternDraftStore,
    promoteMemory: options.promoteMemorySpy
      ? (runId, input) => options.promoteMemorySpy!(runId, input)
      : (runId, input) => memorySearch.promoteMemory(runId, input)
  });

  return { store, gate, lifecycle };
}

async function seedRun(lifecycle: TaskLifecycleManager, slug: string): Promise<RunRecord> {
  return lifecycle.intakeRequest({
    workspaceSlug: `ws-${slug}`,
    projectSlug: `proj-${slug}`,
    actor: "manager",
    title: `gate/closure test run ${slug}`,
    request: "exercise the extracted gate/closure manager directly"
  });
}

function makePacket(overrides: Partial<TaskPacketInput> & { taskId: string }): TaskPacketInput {
  return {
    title: `Task ${overrides.taskId}`,
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
    rollbackNotes: "revert to previous state",
    handoffFormat: "summary only",
    requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"],
    reasoningPolicy: { mode: "legacy" },
    ...overrides
  };
}

// Insert a TaskRecord directly so we can pin its immutable `class` (opt-out
// classes are never assignable through createTaskGraph, by design).
async function insertTask(
  store: ArchonStore,
  run: RunRecord,
  opts: {
    taskId: string;
    cls: TaskClass;
    status: TaskRecord["status"];
    scope?: string[];
    packet?: Partial<TaskPacketInput>;
  }
): Promise<TaskRecord> {
  const existing = await store.getTasksByRun(run.id);
  const task: TaskRecord = {
    id: `uuid-${opts.taskId}`,
    runId: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    class: opts.cls,
    packet: makePacket({
      taskId: opts.taskId,
      allowedWriteScope: opts.scope ?? ["src/"],
      ...opts.packet
    }),
    status: opts.status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await store.replaceTasks([...existing, task]);
  return task;
}

function validHandoff(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    actor: "backend_engineer",
    ownerRole: "backend_engineer",
    completionStandard: "artifact_complete",
    summary: "did the work",
    changedFiles: ["src/x.ts"],
    blockers: [],
    verificationNotes: ["ran npm test"],
    executionEvidence: ["npm test green"],
    qualityGateEvidence: ["product_acceptance met"],
    contextRefs: ["brief-x.md"],
    ...overrides
  };
}

function review(role: ReviewInput["reviewerRole"], overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    reviewerRole: role,
    state: "passed",
    severity: "low",
    findings: [],
    ...overrides
  };
}

async function withReductionFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
  if (value === undefined) {
    delete process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
  } else {
    process.env.ARCHON_REVIEW_FLOOR_REDUCTION = value;
  }
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.ARCHON_REVIEW_FLOOR_REDUCTION;
    } else {
      process.env.ARCHON_REVIEW_FLOOR_REDUCTION = prev;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// submitHandoff — refusals
// ────────────────────────────────────────────────────────────────────────────

test("submitHandoff: refuses when task is not in_progress", async () => {
  const { store, gate, lifecycle } = makeHarness();
  const run = await seedRun(lifecycle, "hs1");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "ready" });
  await assert.rejects(
    () => gate.submitHandoff(run.id, "task-a", validHandoff()),
    /must be in progress before handoff/
  );
});

test("submitHandoff: refuses on ownerRole mismatch", async () => {
  const { store, gate, lifecycle } = makeHarness();
  const run = await seedRun(lifecycle, "hs2");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "in_progress" });
  await assert.rejects(
    () => gate.submitHandoff(run.id, "task-a", validHandoff({ ownerRole: "frontend_designer" })),
    /ownerRole must match task ownerRole/
  );
});

test("submitHandoff: refuses on completionStandard mismatch", async () => {
  const { store, gate, lifecycle } = makeHarness();
  const run = await seedRun(lifecycle, "hs3");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "in_progress" });
  // "specialist_verified" is a VALID completion standard (passes validateHandoff)
  // but differs from the task's "artifact_complete" → the equality check fires.
  await assert.rejects(
    () => gate.submitHandoff(run.id, "task-a", validHandoff({ completionStandard: "specialist_verified" })),
    /completionStandard must match task completionStandard/
  );
});

test("submitHandoff: refuses on invalid handoff (empty changedFiles)", async () => {
  const { store, gate, lifecycle } = makeHarness();
  const run = await seedRun(lifecycle, "hs4");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "in_progress" });
  await assert.rejects(
    () => gate.submitHandoff(run.id, "task-a", validHandoff({ changedFiles: [] })),
    /Invalid handoff:/
  );
});

// ────────────────────────────────────────────────────────────────────────────
// submitHandoff — happy path + onHandoff hook
// ────────────────────────────────────────────────────────────────────────────

test("submitHandoff: valid handoff moves task to review_blocked, bumps run, saves record", async () => {
  const events: HandoffLifecycleEvent[] = [];
  const { store, gate, lifecycle } = makeHarness({
    onHandoff: async (event) => {
      events.push(event);
    }
  });
  const run = await seedRun(lifecycle, "hs5");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "in_progress" });

  const record = await gate.submitHandoff(run.id, "task-a", validHandoff({ summary: "handoff body" }));

  assert.equal(record.taskId, "task-a");
  assert.equal(record.summary, "handoff body");
  const task = await store.getTask(run.id, "task-a");
  assert.equal(task?.status, "review_blocked");
  const bumpedRun = await store.getRun(run.id);
  assert.equal(bumpedRun?.status, "review_blocked");
  const handoffs = await store.getHandoffs(run.id, "task-a");
  assert.equal(handoffs.length, 1);
  // onHandoff fired exactly once with the right identity.
  assert.deepEqual(events, [{ runId: run.id, taskId: "task-a", actor: "backend_engineer" }]);
});

test("submitHandoff: onHandoff ingestion error never blocks handoff completion", async () => {
  const { store, gate, lifecycle } = makeHarness({
    onHandoff: async () => {
      throw new Error("ingestion pipeline exploded");
    }
  });
  const run = await seedRun(lifecycle, "hs6");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "in_progress" });

  // Must resolve, not reject — the swallowed hook error cannot fail the gate.
  const record = await gate.submitHandoff(run.id, "task-a", validHandoff());
  assert.ok(record.id, "handoff record still returned despite hook failure");
  const task = await store.getTask(run.id, "task-a");
  assert.equal(task?.status, "review_blocked");
});

// ────────────────────────────────────────────────────────────────────────────
// recordReview — refusals (trust boundary)
// ────────────────────────────────────────────────────────────────────────────

test("recordReview: refuses without a trusted resolver", async () => {
  const { store, gate, lifecycle } = makeHarness(); // no resolver
  const run = await seedRun(lifecycle, "rr1");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });
  await assert.rejects(
    () => gate.recordReview(run.id, "task-a", "actor", review("reviewer")),
    /recordReview requires a trusted review action context resolver/
  );
});

test("recordReview: refuses when task is not review_blocked", async () => {
  const { store, gate, lifecycle } = makeHarness({ resolver: trustedResolver() });
  const run = await seedRun(lifecycle, "rr2");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "in_progress" });
  await assert.rejects(
    () => gate.recordReview(run.id, "task-a", "actor", review("reviewer")),
    /must be review_blocked before reviews can be recorded/
  );
});

test("recordReview: refuses when the resolver throws", async () => {
  const { store, gate, lifecycle } = makeHarness({
    resolver: async () => {
      throw new Error("principal not bound");
    }
  });
  const run = await seedRun(lifecycle, "rr3");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });
  await assert.rejects(
    () => gate.recordReview(run.id, "task-a", "actor", review("reviewer")),
    /Invalid review action: principal not bound/
  );
});

test("recordReview: refuses an unsealed (untrusted) resolver context", async () => {
  const { store, gate, lifecycle } = makeHarness({
    // Returns a plain object NOT registered in the trusted WeakSet.
    resolver: async (input) =>
      ({ actor: input.actor, actorRole: input.reviewerRole }) as never
  });
  const run = await seedRun(lifecycle, "rr4");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });
  await assert.rejects(
    () => gate.recordReview(run.id, "task-a", "actor", review("reviewer")),
    /Invalid review action: review context must come from the trusted runtime review identity resolver/
  );
});

// ────────────────────────────────────────────────────────────────────────────
// recordReview — gate REFUSES to approve (floor not met)
// ────────────────────────────────────────────────────────────────────────────

test("recordReview: full-trio task with one passing review stays review_blocked with blockers", async () => {
  const { store, gate, lifecycle } = makeHarness({ resolver: trustedResolver() });
  const run = await seedRun(lifecycle, "rr5");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });

  const result = await withReductionFlag("1", () =>
    gate.recordReview(run.id, "task-a", "actor", review("reviewer"))
  );

  assert.notEqual(result.task.status, "approved");
  assert.equal(result.task.status, "review_blocked");
  assert.ok(result.blockers.length > 0, "unmet floor must surface blockers");
  const stored = await store.getTask(run.id, "task-a");
  assert.equal(stored?.status, "review_blocked");
});

// ────────────────────────────────────────────────────────────────────────────
// recordReview — gate SATISFIED (floor met)
// ────────────────────────────────────────────────────────────────────────────

test("recordReview: full-trio task approves only after all three reviews, no floor-reduction record", async () => {
  const { store, gate, lifecycle } = makeHarness({ resolver: trustedResolver() });
  const run = await seedRun(lifecycle, "rr6");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });

  await gate.recordReview(run.id, "task-a", "actor", review("reviewer"));
  await gate.recordReview(run.id, "task-a", "actor", review("qa_engineer"));
  const final = await gate.recordReview(run.id, "task-a", "actor", review("security_reviewer"));

  assert.equal(final.task.status, "approved");
  assert.deepEqual(final.blockers, []);
  // Non-opt-out class → no floor was reduced → no provenance row.
  const reductions = await store.getReviewFloorReductions(run.id, "task-a");
  assert.equal(reductions.length, 0, "full-trio approval must not write a floor-reduction record");
});

test("recordReview: reduced-floor approval writes ReviewFloorReductionRecord and releases locks", async () => {
  const { store, gate, lifecycle } = makeHarness({ resolver: trustedResolver() });
  const run = await seedRun(lifecycle, "rr7");
  // docs_only + review-safe scope → floor reduces to [reviewer] when the flag is ON.
  const task = await insertTask(store, run, {
    taskId: "task-a",
    cls: "docs_only",
    status: "review_blocked",
    scope: ["sandbox/"]
  });
  assert.equal(isOptOutClass(task.class), true, "precondition: docs_only is an opt-out class");
  // An active lock that must be released on approval.
  await store.createLock({
    id: "lock-a",
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.id,
    taskId: "task-a",
    scopePaths: ["sandbox/"],
    status: "active",
    createdAt: new Date().toISOString()
  });

  const result = await withReductionFlag("1", () =>
    gate.recordReview(run.id, "task-a", "actor", review("reviewer"))
  );

  assert.equal(result.task.status, "approved", "single reviewer approves a reduced-floor opt-out task");
  const reductions = await store.getReviewFloorReductions(run.id, "task-a");
  assert.equal(reductions.length, 1, "reduced approval MUST write a provenance row");
  assert.deepEqual(reductions[0]?.effectiveFloor, ["reviewer"]);
  assert.deepEqual(reductions[0]?.droppedRoles.sort(), ["qa_engineer", "security_reviewer"]);
  assert.equal(reductions[0]?.derivedClass, "docs_only");
  assert.deepEqual(reductions[0]?.writeScopeSnapshot, ["sandbox/"]);
  assert.equal(reductions[0]?.basis, "opt_out_class+scope_review_safe");
  assert.equal(reductions[0]?.source, "runtime");
  const activeLocks = await store.getActiveLocks(run.projectId);
  assert.equal(activeLocks.length, 0, "approval releases the task lock");
});

test("recordReview: without the reduction flag, the SAME opt-out task is NOT approved on one review", async () => {
  const { store, gate, lifecycle } = makeHarness({ resolver: trustedResolver() });
  const run = await seedRun(lifecycle, "rr8");
  await insertTask(store, run, {
    taskId: "task-a",
    cls: "docs_only",
    status: "review_blocked",
    scope: ["sandbox/"]
  });

  const result = await withReductionFlag(undefined, () =>
    gate.recordReview(run.id, "task-a", "actor", review("reviewer"))
  );

  assert.equal(result.task.status, "review_blocked", "flag OFF → full trio floor still applies");
  const reductions = await store.getReviewFloorReductions(run.id, "task-a");
  assert.equal(reductions.length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// recordReview — provenance + findings derivation
// ────────────────────────────────────────────────────────────────────────────

test("recordReview: reviewSource 'seed' stamps review + approval as never-trusted", async () => {
  const { store, gate, lifecycle } = makeHarness({
    resolver: trustedResolver(),
    reviewSource: "seed"
  });
  const run = await seedRun(lifecycle, "rr9");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });

  const result = await gate.recordReview(run.id, "task-a", "actor", review("reviewer"));

  assert.equal(result.review.source, "seed");
  const approvals = await store.getApprovals(run.id, "task-a");
  assert.equal(approvals[0]?.source, "seed", "approval provenance must match the seed source");
});

test("recordReview: accepted findingDetails derive findings[] from messages (P2.1)", async () => {
  const { store, gate, lifecycle } = makeHarness({ resolver: trustedResolver() });
  const run = await seedRun(lifecycle, "rr10");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });

  // A passed review with accepted findingDetails must supply matching findings[]
  // (validateReviewAction requires findings.length === findingDetails.length for
  // the fully-accepted path); recordReview then re-derives findings from the
  // detail messages, which must remain canonical.
  const result = await gate.recordReview(run.id, "task-a", "actor", {
    reviewerRole: "reviewer",
    state: "passed",
    severity: "low",
    findings: ["accepted nit about naming"],
    findingDetails: [
      {
        message: "accepted nit about naming",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "cosmetic, tracked separately"
      }
    ]
  });

  assert.deepEqual(result.review.findings, ["accepted nit about naming"]);
});

test("recordReview: clean pass with provenance-only findingDetails keeps caller findings ([])", async () => {
  const { store, gate, lifecycle } = makeHarness({ resolver: trustedResolver() });
  const run = await seedRun(lifecycle, "rr11");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });

  const result = await gate.recordReview(run.id, "task-a", "actor", {
    reviewerRole: "reviewer",
    state: "passed",
    severity: "low",
    findings: [],
    // provenance-only: no acceptance disposition → must NOT derive non-empty findings
    findingDetails: [{ message: "context note", severity: "low" }]
  });

  assert.deepEqual(result.review.findings, [], "provenance-only details must not populate findings on a clean pass");
});

// ────────────────────────────────────────────────────────────────────────────
// recordReview — mistake-ledger capture ordering (non-blocking)
// ────────────────────────────────────────────────────────────────────────────

test("recordReview: mistake capture fires before distillation and never blocks the gate", async () => {
  const callOrder: string[] = [];
  const mistakeLedgerStore: MistakeLedgerStoreLike = {
    async appendMistakeOccurrences() {
      callOrder.push("capture");
    },
    async listMistakeOccurrences() {
      callOrder.push("distill-list");
      return [];
    },
    // Unused on the capture/distillation path exercised here.
    async appendAntiPatternEntry() {
      // no-op
    },
    async listAntiPatternsForLocus() {
      return [];
    }
  };
  const antiPatternDraftStore: AntiPatternDraftStoreLike = {
    async appendAntiPatternDraft() {
      // no-op
    },
    async listAntiPatternDrafts() {
      return [];
    }
  };
  const { store, gate, lifecycle } = makeHarness({
    resolver: trustedResolver(),
    mistakeLedgerStore,
    antiPatternDraftStore
  });
  const run = await seedRun(lifecycle, "rr12");
  await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "review_blocked" });

  // A non-passing review with a categorized finding produces an occurrence.
  const result = await gate.recordReview(run.id, "task-a", "actor", {
    reviewerRole: "reviewer",
    state: "blocked",
    severity: "high",
    findings: [],
    findingDetails: [{ message: "unhandled promise rejection", severity: "high", category: "unhandled_error" }]
  });

  // Gate still returns (capture/distillation are fire-and-forget, non-blocking).
  assert.equal(result.task.status, "review_blocked");
  // Capture (append) must have been invoked before distillation reads the ledger.
  const captureIdx = callOrder.indexOf("capture");
  const distillIdx = callOrder.indexOf("distill-list");
  assert.ok(captureIdx >= 0, "mistake capture must fire");
  assert.ok(distillIdx >= 0, "distillation must run after capture");
  assert.ok(captureIdx < distillIdx, "capture must precede distillation");
});

// ────────────────────────────────────────────────────────────────────────────
// findTaskBlockers — dependency staleness
// ────────────────────────────────────────────────────────────────────────────

test("findTaskBlockers: matches the raw policy blockers when no approved dependency is stale", async () => {
  const { store, gate, lifecycle } = makeHarness();
  const run = await seedRun(lifecycle, "fb1");
  const task = await insertTask(store, run, { taskId: "task-a", cls: "prototype_slice", status: "ready" });
  const all = await store.getTasksByRun(run.id);
  const activeLocks: LockRecord[] = [];

  const blockers = await gate.findTaskBlockers(task, all, activeLocks);
  assert.deepEqual(blockers, findBlockingReasonsForTask(task, all, activeLocks));
});

test("findTaskBlockers: adds a stale-approval blocker when an approved dependency lost its decision", async () => {
  const { store, gate, lifecycle } = makeHarness();
  const run = await seedRun(lifecycle, "fb2");
  // Dependency is marked approved but has NO reviews → decision is not approved (stale).
  const dep = await insertTask(store, run, {
    taskId: "dep",
    cls: "prototype_slice",
    status: "approved"
  });
  const dependent = await insertTask(store, run, {
    taskId: "task-b",
    cls: "prototype_slice",
    status: "ready",
    packet: { dependencies: ["dep"] }
  });
  const all = await store.getTasksByRun(run.id);

  // Precondition: the dependency really is a dependency, and really is stale.
  assert.ok(findTaskDependencies(dependent.packet, all).some((d) => d.packet.taskId === "dep"));
  assert.notEqual(evaluateReviewDecision(dep, []).decision, "approved");

  const blockers = await gate.findTaskBlockers(dependent, all, []);
  assert.ok(
    blockers.some((b) => b.includes("dependency dep has stale approval")),
    `expected stale-approval blocker, got: ${JSON.stringify(blockers)}`
  );
});
