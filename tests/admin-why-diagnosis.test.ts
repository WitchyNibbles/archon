import test from "node:test";
import assert from "node:assert/strict";

import {
  diagnoseStall,
  formatStallDiagnosis,
  redactSecretLikeSubstrings,
  truncateForDisplay,
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

test("daemon_handoff_blocked present, single-step nextActions → numbered next command", () => {
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
  assert.equal(c!.nextCommand, "1) run the reviewer");
});

// HIGH fix: nextCommand must join the FULL nextActions array, not silently
// truncate to nextActions[0]. Proven against the real 2-step array runtime.ts
// emits from its preflight blocker (see runtime.ts's runtime execution
// preflight nextActions — "run `npm run archon:doctor -- --repair`..." then
// "if task-state drift remains...run `npm run archon:reconcile`...").
test("daemon_handoff_blocked present, real 2-step nextActions → BOTH steps joined, none dropped", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        daemonHandoff: {
          state: "blocked",
          blockerKind: "runtime_preflight",
          reason: "runtime execution preflight failed",
          nextActions: [
            "run `npm run archon:doctor -- --repair` to replay safe runtime setup healing",
            "if task-state drift remains after services are healthy, run `npm run archon:reconcile` before retrying execution"
          ]
        }
      }
    })
  );
  const c = cause(d, "daemon_handoff_blocked");
  assert.ok(c);
  assert.match(c!.nextCommand, /archon:doctor -- --repair/);
  assert.match(c!.nextCommand, /archon:reconcile/, "second step must NOT be silently dropped");
  assert.equal(c!.nextCommand.indexOf("archon:doctor") < c!.nextCommand.indexOf("archon:reconcile"), true);
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

// LOW fix: daemon_supervisor_blocked must also cover max_cycles_reached and
// invalid — not just the literal "blocked" state.
test("daemon_supervisor_blocked present (state=max_cycles_reached) → reported", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        daemonSupervisor: {
          state: "max_cycles_reached",
          reason: "hit cycle limit",
          nextActions: ["raise the cycle limit or intervene"]
        }
      }
    })
  );
  const c = cause(d, "daemon_supervisor_blocked");
  assert.ok(c, "max_cycles_reached must be surfaced");
  assert.match(c!.what, /max-cycles/);
});

test("daemon_supervisor_blocked present (state=invalid) → reported", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        daemonSupervisor: {
          state: "invalid",
          reason: "unrecognized supervisor state",
          nextActions: []
        }
      }
    })
  );
  const c = cause(d, "daemon_supervisor_blocked");
  assert.ok(c, "invalid state must be surfaced");
  assert.match(c!.what, /invalid state/);
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

// ---------------------------------------------------------------------------
// CRITICAL fix: task_blocked / task_review_blocked — `why` must never say
// "nothing is stuck" while a task explicitly failed (blocked) or is stuck
// waiting on review (review_blocked). Both directions, both cause classes.
// ---------------------------------------------------------------------------

test("task_blocked present → detected, ranked near the top, recover command", () => {
  const d = diagnoseStall(
    baseline({ blockedTasks: [{ taskId: "t1", reason: "build failed 3x, escalated" }] })
  );
  assert.equal(d.stuck, true);
  const c = cause(d, "task_blocked");
  assert.ok(c);
  assert.equal(c!.rank, STALL_CAUSE_RANKS.task_blocked);
  assert.match(c!.nextCommand, /recover --apply-safe/);
  assert.deepEqual(c!.evidence.values.reasons, ["build failed 3x, escalated"]);
  // Must rank ahead of every governance/sidecar cause class.
  assert.ok(c!.rank < STALL_CAUSE_RANKS.review_gate_missing);
  assert.ok(c!.rank < STALL_CAUSE_RANKS.orphan_duplicate_runs);
});

test("task_blocked absent → not reported (baseline has no blocked task)", () => {
  const d = diagnoseStall(baseline());
  assert.equal(causeIds(d).includes("task_blocked"), false);
});

test("task_review_blocked present → detected, lists the blocking review roles", () => {
  const d = diagnoseStall(
    baseline({
      reviewBlockedTasks: [{ taskId: "t1", blockers: ["missing required review: security_reviewer"] }]
    })
  );
  assert.equal(d.stuck, true);
  const c = cause(d, "task_review_blocked");
  assert.ok(c);
  assert.equal(c!.rank, STALL_CAUSE_RANKS.task_review_blocked);
  assert.deepEqual(c!.evidence.values.blockers, ["missing required review: security_reviewer"]);
});

test("task_review_blocked absent → not reported", () => {
  const d = diagnoseStall(baseline());
  assert.equal(causeIds(d).includes("task_review_blocked"), false);
});

test("task_blocked and task_review_blocked both rank ahead of orphan/duplicate and closure gates", () => {
  const d = diagnoseStall(
    baseline({
      blockedTasks: [{ taskId: "t1", reason: "r" }],
      reviewBlockedTasks: [{ taskId: "t2", blockers: ["b"] }],
      duplicateRuns: [{ taskKey: "t3", runIds: ["run-a", "run-b"] }],
      closureBlocks: [{ taskId: "t4", kind: "missing_approval", missingRoles: [] }]
    })
  );
  const ids = causeIds(d);
  assert.deepEqual(ids.slice(0, 4), [
    "task_blocked",
    "task_review_blocked",
    "orphan_duplicate_runs",
    "approval_missing"
  ]);
});

// ---------------------------------------------------------------------------
// MEDIUM fix: headline blocking-count must equal the numbered list count —
// verified by rendering and counting the numbered lines, not just eyeballing.
// ---------------------------------------------------------------------------

test("formatStallDiagnosis: headline count matches numbered-list count exactly (advisory excluded from both)", () => {
  const d = diagnoseStall(
    baseline({
      retroSealBlocked: true,
      blockedTasks: [{ taskId: "t1", reason: "r" }],
      ownerWork: { directiveKind: "dispatch_owner", taskIds: ["t2"] }
    })
  );
  const text = formatStallDiagnosis(d);
  const headlineMatch = text.match(/(\d+) things are blocking it/);
  assert.ok(headlineMatch, "expected a headline count");
  const claimedCount = Number(headlineMatch![1]);

  const numberedLines = text.split("\n").filter((line) => /^\d+\. /.test(line));
  assert.equal(numberedLines.length, claimedCount, "numbered list must match the claimed count exactly");

  // The advisory owner-work cause must NOT be numbered, and must appear in the
  // separate "Also (advisory...)" section instead.
  assert.equal(numberedLines.some((line) => /Owner work is simply/.test(line)), false);
  assert.match(text, /Also \(advisory/);
});

test("formatStallDiagnosis: single blocking cause + no advisory → singular headline, exactly 1 numbered item", () => {
  const d = diagnoseStall(baseline({ retroSealBlocked: true }));
  const text = formatStallDiagnosis(d);
  assert.match(text, /Here's why .* is stuck:/);
  const numberedLines = text.split("\n").filter((line) => /^\d+\. /.test(line));
  assert.equal(numberedLines.length, 1);
});

// ---------------------------------------------------------------------------
// LOW fix: retro_seal_gate evidence carries the seal-ready task ids, not just
// the bare run id.
// ---------------------------------------------------------------------------

test("retro_seal_gate evidence includes sealReadyTaskIds when provided", () => {
  const d = diagnoseStall(
    baseline({ retroSealBlocked: true, sealReadyTaskIds: ["t1", "t2"] })
  );
  const c = cause(d, "retro_seal_gate");
  assert.ok(c);
  assert.deepEqual(c!.evidence.values.tasks, ["t1", "t2"]);
});

// ---------------------------------------------------------------------------
// Security MEDIUM fix: hook-blocker command/summary must never leak secrets
// verbatim, in EITHER the human evidence values or the nextCommand string —
// both are part of the same StallDiagnosis object, so both --json and human
// output are covered by one assertion on the diagnosis object.
// ---------------------------------------------------------------------------

test("redactSecretLikeSubstrings: labeled key=value credential fields are scrubbed", () => {
  assert.equal(
    redactSecretLikeSubstrings("npm publish --token=sk-abcdEFGH12345678901234"),
    "npm publish --token=[redacted]"
  );
  assert.equal(
    redactSecretLikeSubstrings("curl -H \"Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\""),
    'curl -H "Authorization: [redacted]"'
  );
});

test("redactSecretLikeSubstrings: leaves ordinary command text alone", () => {
  assert.equal(redactSecretLikeSubstrings("npm run build:dist && npm test"), "npm run build:dist && npm test");
});

test("truncateForDisplay: truncates long text with an explicit ellipsis marker", () => {
  const long = "x".repeat(200);
  const truncated = truncateForDisplay(long, 10);
  assert.equal(truncated.length, 11); // 10 chars + ellipsis marker
  assert.ok(truncated.endsWith("…"));
});

test("truncateForDisplay: short text passes through unchanged", () => {
  assert.equal(truncateForDisplay("npm test", 120), "npm test");
});

test("hook_blocker cause: a credential embedded in the recorded command never appears verbatim in evidence or nextCommand", () => {
  const secretCommand = "curl -H \"Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789\" https://api.example.com";
  const d = diagnoseStall(
    baseline({
      sidecars: {
        hookBlocker: {
          taskId: "t1",
          blockerKind: "generic_nonzero_bash",
          command: secretCommand,
          summary: "request failed"
        }
      }
    })
  );
  const c = cause(d, "hook_blocker");
  assert.ok(c);
  const evidenceCommand = String(c!.evidence.values.command);
  assert.equal(evidenceCommand.includes("sk-live-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(c!.nextCommand.includes("sk-live-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  // The pointer to the sidecar file must still be present so the operator can
  // find the (equally-scrubbed-at-source) full record if truly needed.
  assert.match(c!.nextCommand, /hook-blocker-state\.json/);
});

// ---------------------------------------------------------------------------
// --task-id scope filter, exercised across every filtered signal type. Each
// case proves the same shape: an out-of-scope signal for a DIFFERENT task is
// dropped, while the in-scope signal for the FOCUSED task is kept.
// ---------------------------------------------------------------------------

test("--task-id filter: task_blocked scoped correctly", () => {
  const d = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      blockedTasks: [
        { taskId: "t1", reason: "r1" },
        { taskId: "t2", reason: "r2" }
      ]
    })
  );
  assert.deepEqual(cause(d, "task_blocked")!.evidence.values.tasks, ["t2"]);
});

test("--task-id filter: task_review_blocked scoped correctly", () => {
  const d = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      reviewBlockedTasks: [
        { taskId: "t1", blockers: ["b1"] },
        { taskId: "t2", blockers: ["b2"] }
      ]
    })
  );
  assert.deepEqual(cause(d, "task_review_blocked")!.evidence.values.tasks, ["t2"]);
});

test("--task-id filter: orphan_duplicate_runs scoped by task_key", () => {
  const d = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      duplicateRuns: [
        { taskKey: "t1", runIds: ["run-a"] },
        { taskKey: "t2", runIds: ["run-b"] }
      ]
    })
  );
  assert.deepEqual(cause(d, "orphan_duplicate_runs")!.evidence.values.taskKeys, ["t2"]);
});

test("--task-id filter: council_gate scoped correctly", () => {
  const d = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      councilGates: [
        { taskId: "t1", outcome: undefined },
        { taskId: "t2", outcome: undefined }
      ]
    })
  );
  assert.deepEqual(cause(d, "council_gate")!.evidence.values.tasks, ["t2"]);
});

test("--task-id filter: respawn lease/budget only applies when the focused task matches", () => {
  const inScope = diagnoseStall(
    baseline({
      scope: { taskId: "t1" },
      respawn: { taskId: "t1", count: 8, budget: 8, leaseHeld: true, leaseOwner: "d" }
    })
  );
  assert.ok(cause(inScope, "respawn_lease_held"));
  assert.ok(cause(inScope, "respawn_budget_exhausted"));

  const outOfScope = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      respawn: { taskId: "t1", count: 8, budget: 8, leaseHeld: true, leaseOwner: "d" }
    })
  );
  assert.equal(causeIds(outOfScope).includes("respawn_lease_held"), false);
  assert.equal(causeIds(outOfScope).includes("respawn_budget_exhausted"), false);
});

test("--task-id filter: hook_blocker scoped correctly", () => {
  const outOfScope = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      sidecars: {
        hookBlocker: { taskId: "t1", blockerKind: "generic_nonzero_bash", command: "x", summary: "y" }
      }
    })
  );
  assert.equal(causeIds(outOfScope).includes("hook_blocker"), false);

  const inScope = diagnoseStall(
    baseline({
      scope: { taskId: "t1" },
      sidecars: {
        hookBlocker: { taskId: "t1", blockerKind: "generic_nonzero_bash", command: "x", summary: "y" }
      }
    })
  );
  assert.ok(cause(inScope, "hook_blocker"));
});

test("--task-id filter: context_guard_pending scoped correctly", () => {
  const outOfScope = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      sidecars: { contextGuard: { state: "handoff_written", taskId: "t1", invocationId: "inv-1" } }
    })
  );
  assert.equal(causeIds(outOfScope).includes("context_guard_pending"), false);
});

test("--task-id filter: owner_work_pending scoped correctly", () => {
  const d = diagnoseStall(
    baseline({
      scope: { taskId: "t2" },
      ownerWork: { directiveKind: "dispatch_owner", taskIds: ["t1", "t2"] }
    })
  );
  assert.deepEqual(cause(d, "owner_work_pending")!.evidence.values.tasks, ["t2"]);
});

// ---------------------------------------------------------------------------
// Determinism: identical input run twice must produce byte-identical output.
// ---------------------------------------------------------------------------

test("diagnoseStall is deterministic: same signals in, identical diagnosis out, run twice", () => {
  const signals = baseline({
    integrity: { status: "contradicted", contradictions: ["x"] },
    blockedTasks: [{ taskId: "t1", reason: "r" }],
    reviewBlockedTasks: [{ taskId: "t2", blockers: ["b"] }],
    closureBlocks: [{ taskId: "t3", kind: "missing_review", missingRoles: ["qa_engineer"] }],
    councilGates: [{ taskId: "t4", outcome: "rework_required" }],
    retroSealBlocked: true,
    sealReadyTaskIds: ["t1", "t2", "t3", "t4"],
    respawn: { taskId: "t5", count: 8, budget: 8, leaseHeld: true, leaseOwner: "d" },
    ownerWork: { directiveKind: "dispatch_owner", taskIds: ["t6"] },
    sidecars: {
      hookBlocker: { taskId: "t7", blockerKind: "generic_nonzero_bash", command: "x", summary: "y" },
      contextGuard: { state: "handoff_written", taskId: "t8", invocationId: "inv-1" },
      daemonHandoff: { state: "blocked", reason: "r", nextActions: ["a", "b"] },
      daemonSupervisor: { state: "blocked", reason: "r", nextActions: ["a"] }
    }
  });
  const first = diagnoseStall(signals);
  const second = diagnoseStall(signals);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(formatStallDiagnosis(first), formatStallDiagnosis(second));
});
