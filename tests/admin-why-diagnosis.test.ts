import test from "node:test";
import assert from "node:assert/strict";

import {
  diagnoseStall,
  formatStallDiagnosis,
  STALL_CAUSE_RANKS,
  type StallCauseId,
  type StallSignals
} from "../src/admin/why-diagnosis.ts";

// ---------------------------------------------------------------------------
// A minimal "healthy" baseline: a run with no blocking signals at all. Each
// test flips exactly one signal on to prove it is (a) detected + ranked with the
// correct next-command when present, and (b) absent from the causes when off.
// ---------------------------------------------------------------------------

function baseline(overrides: Partial<StallSignals> = {}): StallSignals {
  return {
    now: "2026-07-05T00:00:00.000Z",
    scope: {},
    run: { id: "run-1", status: "in_progress" },
    taskCounts: { ready: 0, in_progress: 1, review_blocked: 0, approved: 0, done: 2, blocked: 0 },
    integrity: { status: "consistent", contradictions: [] },
    sidecars: {},
    ...overrides
  };
}

function causeIds(diagnosis: ReturnType<typeof diagnoseStall>): StallCauseId[] {
  return diagnosis.causes.map((c) => c.id);
}

function cause(diagnosis: ReturnType<typeof diagnoseStall>, id: StallCauseId) {
  return diagnosis.causes.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Healthy state
// ---------------------------------------------------------------------------

test("healthy: no signals → not stuck, 3-line summary, no causes", () => {
  const d = diagnoseStall(baseline());
  assert.equal(d.stuck, false);
  assert.equal(d.causes.length, 0);
  assert.ok(d.healthy);
  assert.equal(d.healthy!.summaryLines.length, 3);
});

test("healthy: no run → explicit no-run summary", () => {
  const d = diagnoseStall({ now: "t", scope: {}, run: undefined, sidecars: {} });
  assert.equal(d.stuck, false);
  assert.match(d.healthy!.summaryLines[0]!, /No active run/);
});

// ---------------------------------------------------------------------------
// Each cause class — present → ranked with correct next-command
// ---------------------------------------------------------------------------

test("integrity_contradiction present → detected, top rank, reconcile command", () => {
  const d = diagnoseStall(
    baseline({ integrity: { status: "contradicted", contradictions: ["local disagrees with runtime"] } })
  );
  assert.equal(d.stuck, true);
  const c = cause(d, "integrity_contradiction");
  assert.ok(c);
  assert.equal(c!.rank, STALL_CAUSE_RANKS.integrity_contradiction);
  assert.match(c!.nextCommand, /reconcile-runtime-state --apply/);
  assert.equal(d.causes[0]!.id, "integrity_contradiction", "ranks first");
});

test("integrity absent (consistent) → not reported", () => {
  const d = diagnoseStall(baseline());
  assert.equal(causeIds(d).includes("integrity_contradiction"), false);
});

test("integrity contradicted but empty contradictions → not reported", () => {
  const d = diagnoseStall(baseline({ integrity: { status: "contradicted", contradictions: [] } }));
  assert.equal(causeIds(d).includes("integrity_contradiction"), false);
});

test("orphan_duplicate_runs present → prune-orphans command", () => {
  const d = diagnoseStall(baseline({ duplicateRuns: [{ taskKey: "t1", runIds: ["run-1", "run-2"] }] }));
  const c = cause(d, "orphan_duplicate_runs");
  assert.ok(c);
  assert.match(c!.nextCommand, /prune-orphans --confirm/);
});

test("orphan_duplicate_runs absent → not reported", () => {
  assert.equal(causeIds(diagnoseStall(baseline())).includes("orphan_duplicate_runs"), false);
  assert.equal(causeIds(diagnoseStall(baseline({ duplicateRuns: [] }))).includes("orphan_duplicate_runs"), false);
});

test("review_gate_missing present → review-orchestrator flow, lists missing roles", () => {
  const d = diagnoseStall(
    baseline({
      closureBlocks: [{ taskId: "t1", kind: "missing_review", missingRoles: ["security_reviewer"] }]
    })
  );
  const c = cause(d, "review_gate_missing");
  assert.ok(c);
  assert.match(c!.nextCommand, /review-orchestrator/);
  assert.deepEqual(c!.evidence.values.missingRoles, ["security_reviewer"]);
});

test("approval_missing present → save-approval path, distinct from review gate", () => {
  const d = diagnoseStall(
    baseline({ closureBlocks: [{ taskId: "t1", kind: "missing_approval", missingRoles: [] }] })
  );
  assert.ok(cause(d, "approval_missing"));
  assert.equal(causeIds(d).includes("review_gate_missing"), false);
});

test("closure gates absent → neither review nor approval reported", () => {
  const d = diagnoseStall(baseline());
  assert.equal(causeIds(d).includes("review_gate_missing"), false);
  assert.equal(causeIds(d).includes("approval_missing"), false);
});

test("council_gate present → record-council command", () => {
  const d = diagnoseStall(baseline({ councilGates: [{ taskId: "t1", outcome: undefined }] }));
  const c = cause(d, "council_gate");
  assert.ok(c);
  assert.match(c!.nextCommand, /record-council/);
  assert.deepEqual(c!.evidence.values.outcomes, ["unset"]);
});

test("council_gate absent → not reported", () => {
  assert.equal(causeIds(diagnoseStall(baseline())).includes("council_gate"), false);
});

test("retro_seal_gate present → record-retro command", () => {
  const d = diagnoseStall(baseline({ retroSealBlocked: true }));
  const c = cause(d, "retro_seal_gate");
  assert.ok(c);
  assert.match(c!.nextCommand, /record-retro/);
});

test("retro_seal_gate absent → not reported", () => {
  assert.equal(causeIds(diagnoseStall(baseline({ retroSealBlocked: false }))).includes("retro_seal_gate"), false);
});

test("respawn_budget_exhausted present (count >= budget) → recover command", () => {
  const d = diagnoseStall(
    baseline({ respawn: { taskId: "t1", count: 8, budget: 8, leaseHeld: false } })
  );
  const c = cause(d, "respawn_budget_exhausted");
  assert.ok(c);
  assert.match(c!.nextCommand, /recover --apply-safe/);
});

test("respawn budget NOT exhausted (count < budget) → not reported", () => {
  const d = diagnoseStall(baseline({ respawn: { taskId: "t1", count: 2, budget: 8, leaseHeld: false } }));
  assert.equal(causeIds(d).includes("respawn_budget_exhausted"), false);
});

test("respawn_lease_held present → lease/recover next step", () => {
  const d = diagnoseStall(
    baseline({ respawn: { taskId: "t1", count: 0, budget: 8, leaseHeld: true, leaseOwner: "daemon-A" } })
  );
  const c = cause(d, "respawn_lease_held");
  assert.ok(c);
  assert.equal(c!.evidence.values.owner, "daemon-A");
});

test("respawn lease not held → not reported", () => {
  const d = diagnoseStall(baseline({ respawn: { taskId: "t1", count: 0, budget: 8, leaseHeld: false } }));
  assert.equal(causeIds(d).includes("respawn_lease_held"), false);
});

test("hook_blocker present → re-run failed command", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        hookBlocker: {
          taskId: "t1",
          blockerKind: "runtime_preflight",
          command: "npm test",
          summary: "tests failed"
        }
      }
    })
  );
  const c = cause(d, "hook_blocker");
  assert.ok(c);
  assert.match(c!.nextCommand, /npm test/);
});

test("context_guard_pending present (state != registered) → continue-session", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: { contextGuard: { state: "handoff_written", taskId: "t1", invocationId: "inv-1" } }
    })
  );
  const c = cause(d, "context_guard_pending");
  assert.ok(c);
  assert.match(c!.nextCommand, /continue-session/);
});

test("context_guard in 'registered' state → NOT a stall", () => {
  const d = diagnoseStall(
    baseline({ sidecars: { contextGuard: { state: "registered", taskId: "t1", invocationId: "inv-1" } } })
  );
  assert.equal(causeIds(d).includes("context_guard_pending"), false);
});

test("daemon_handoff_blocked present → surfaces first nextAction", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        daemonHandoff: {
          state: "blocked",
          blockerKind: "review_queue",
          reason: "review queue needs a role",
          nextActions: ["run the reviewer"]
        }
      }
    })
  );
  const c = cause(d, "daemon_handoff_blocked");
  assert.ok(c);
  assert.equal(c!.nextCommand, "run the reviewer");
});

test("daemon_supervisor_blocked present (state=blocked) → reported", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        daemonSupervisor: {
          state: "blocked",
          blockerKind: "runtime_preflight",
          reason: "preflight failed",
          nextActions: ["fix preflight"]
        }
      }
    })
  );
  assert.ok(cause(d, "daemon_supervisor_blocked"));
});

test("daemon_supervisor completed (not blocked) → not reported", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        daemonSupervisor: { state: "completed", reason: "done", nextActions: [] }
      }
    })
  );
  assert.equal(causeIds(d).includes("daemon_supervisor_blocked"), false);
});

test("all sidecars absent → tolerated, none reported", () => {
  const d = diagnoseStall(baseline({ sidecars: {} }));
  assert.equal(causeIds(d).includes("hook_blocker"), false);
  assert.equal(causeIds(d).includes("context_guard_pending"), false);
  assert.equal(causeIds(d).includes("daemon_handoff_blocked"), false);
  assert.equal(causeIds(d).includes("daemon_supervisor_blocked"), false);
});

// ---------------------------------------------------------------------------
// Advisory owner-work: informational, never a stall on its own
// ---------------------------------------------------------------------------

test("owner_work only → advisory, NOT stuck", () => {
  const d = diagnoseStall(baseline({ ownerWork: { directiveKind: "dispatch_owner", taskIds: ["t1"] } }));
  assert.equal(d.stuck, false, "advisory alone is not a stall");
  const c = cause(d, "owner_work_pending");
  assert.ok(c);
  assert.equal(c!.advisory, true);
  assert.ok(d.healthy, "healthy summary still present");
});

test("owner_work alongside a real block → stuck, advisory ranked last", () => {
  const d = diagnoseStall(
    baseline({
      retroSealBlocked: true,
      ownerWork: { directiveKind: "dispatch_owner", taskIds: ["t1"] }
    })
  );
  assert.equal(d.stuck, true);
  assert.equal(d.causes.at(-1)!.id, "owner_work_pending");
});

// ---------------------------------------------------------------------------
// Ranking: multiple causes ordered most-blocking first
// ---------------------------------------------------------------------------

test("ranking: integrity > review > council > retro > lease > sidecar", () => {
  const d = diagnoseStall(
    baseline({
      integrity: { status: "contradicted", contradictions: ["x"] },
      closureBlocks: [{ taskId: "t1", kind: "missing_review", missingRoles: ["qa_engineer"] }],
      councilGates: [{ taskId: "t1", outcome: "rework_required" }],
      retroSealBlocked: true,
      respawn: { taskId: "t1", count: 8, budget: 8, leaseHeld: true, leaseOwner: "d" },
      sidecars: {
        hookBlocker: { taskId: "t1", blockerKind: "generic_nonzero_bash", command: "x", summary: "y" }
      }
    })
  );
  assert.deepEqual(causeIds(d), [
    "integrity_contradiction",
    "review_gate_missing",
    "council_gate",
    "retro_seal_gate",
    "respawn_lease_held",
    "respawn_budget_exhausted",
    "hook_blocker"
  ]);
});

// ---------------------------------------------------------------------------
// Task-scope focus filter
// ---------------------------------------------------------------------------

test("--task-id focus: only the named task's blocks are reported", () => {
  const d = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      closureBlocks: [
        { taskId: "t1", kind: "missing_review", missingRoles: ["reviewer"] },
        { taskId: "t2", kind: "missing_approval", missingRoles: [] }
      ]
    })
  );
  assert.equal(causeIds(d).includes("review_gate_missing"), false, "t1 block filtered out");
  assert.ok(cause(d, "approval_missing"), "t2 block kept");
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("formatStallDiagnosis: healthy render mentions nothing-stuck", () => {
  const text = formatStallDiagnosis(diagnoseStall(baseline()));
  assert.match(text, /Nothing is stuck/);
});

test("formatStallDiagnosis: stuck render has evidence + fix per cause", () => {
  const d = diagnoseStall(baseline({ retroSealBlocked: true }));
  const text = formatStallDiagnosis(d);
  assert.match(text, /is stuck/);
  assert.match(text, /evidence:/);
  assert.match(text, /fix:/);
  assert.match(text, /record-retro/);
});
