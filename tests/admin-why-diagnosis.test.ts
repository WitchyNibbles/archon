import test from "node:test";
import assert from "node:assert/strict";

import {
  diagnoseStall,
  formatStallDiagnosis,
  serializeStallDiagnosis,
  assertDiagnosisEvidenceRegistered,
  STALL_CAUSE_RANKS,
  type StallCauseId,
  type StallCauseEvidence,
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
  // Round-8 finding 5 (structured-evidence pass-direction proof): `count` and
  // `budget` are tagged `structured()`, not `freeText()` — they never call
  // `sanitizeFreeText`/`sanitizeForDisplay` at all, so why-redaction.ts's
  // round-8 removal of the free-text numeric shape-exemption has ZERO effect
  // on them. They render as the actual numbers, not "[redacted]", proving the
  // real mechanism the round-8 gate's own rationale relies on: legitimate
  // numeric evidence reaches output through structured fields, not prose.
  assert.equal(c!.evidence.values.count, 8);
  assert.equal(c!.evidence.values.budget, 8);
  assert.equal(formatStallDiagnosis(d).includes("[redacted]"), false, "structured numeric evidence must never render as redacted");
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
  // Round-5: `owner` is freeText sourced from a lock file another process
  // wrote — "daemon-A" is not part of this diagnosis's known vocabulary (it
  // is not a task/run id, role, enum, or command word this module
  // recommends), so it redacts by default under vocabulary-anchoring. A
  // generic identifier SHAPE is never enough to prove safety (round-5 gate
  // CRITICAL finding) — see why-redaction.ts's module header.
  assert.equal(c!.evidence.values.owner, "[redacted]");
});

test("respawn_lease_held: an owner value that IS in the known vocabulary (matches the in-scope run id) survives", () => {
  const d = diagnoseStall(
    baseline({
      run: { id: "run-1", status: "in_progress" },
      respawn: { taskId: "t1", count: 0, budget: 8, leaseHeld: true, leaseOwner: "run-1" }
    })
  );
  const c = cause(d, "respawn_lease_held");
  assert.ok(c);
  assert.equal(c!.evidence.values.owner, "run-1");
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
  // Round-4: nextCommand no longer embeds the raw command directly (single-
  // egress discipline — the redacted command lives ONCE, in evidence.values,
  // and nextCommand just points there + at the sidecar file).
  // Round-5: "npm"/"test" are ordinary prose, not part of this diagnosis's
  // known vocabulary (neither is a task/run id, role, enum, or a command
  // this module itself recommends), so they redact by default — the
  // intended, honestly re-disclosed friction (why-redaction.ts's module
  // header), not a bug.
  assert.equal(c!.evidence.values.command, "[redacted] [redacted]");
  assert.match(c!.nextCommand, /this cause's evidence/);
  assert.match(c!.nextCommand, /hook-blocker-state\.json/);
});

test("hook_blocker: a recorded command matching this module's own recommended-command vocabulary survives", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        hookBlocker: {
          taskId: "t1",
          blockerKind: "runtime_preflight",
          command: "npx tsx ./src/admin.ts status --task-id t1",
          summary: "status check failed"
        }
      }
    })
  );
  const c = cause(d, "hook_blocker");
  assert.ok(c);
  // "npx"/"tsx"/"./src/admin.ts"/"status" all appear verbatim inside this
  // module's own RECOMMENDED_COMMANDS templates, so they are known
  // vocabulary; "t1" is the hookBlocker's own taskId, also known. Nothing in
  // this recorded command is unrecognized, so nothing redacts.
  assert.equal(c!.evidence.values.command, "npx tsx ./src/admin.ts status --task-id t1");
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
  // Round-5: nextActions is freeText sourced from a daemon-written sidecar
  // file, so under vocabulary-anchoring almost every prose word in it
  // redacts by default (none of it is a task/run id, role, enum, or command
  // word this module itself recommends — see why-redaction.ts's module
  // header for the honestly re-disclosed friction). The point of THIS test
  // is structural, not lexical: both steps must survive the join, in order,
  // none silently dropped — proven by both numbered markers being present
  // with the "then" joiner between them (joinNextActions's own
  // code-generated structure, never itself redacted).
  assert.match(c!.nextCommand, /^1\).*then 2\)/);
  // Round-12: flag names are no longer safe by shape/absence-of-keyword
  // alone (the fail-closed inversion — see why-redaction.ts's module
  // header) — `--repair` is not a canonical keyword spelling and this
  // sidecar-sourced free text carries no vocabulary, so it now redacts like
  // any other non-canonical flag. The structural join assertion above (both
  // numbered steps present, joined by "then") remains this test's point.
  assert.match(c!.nextCommand, /\[redacted\]/, "non-canonical flags in free text redact under the round-12 inversion");
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
    baseline({ blockedTasks: [{ taskId: "t1", reason: "build failed repeatedly and was escalated" }] })
  );
  assert.equal(d.stuck, true);
  const c = cause(d, "task_blocked");
  assert.ok(c);
  assert.equal(c!.rank, STALL_CAUSE_RANKS.task_blocked);
  assert.match(c!.nextCommand, /recover --apply-safe/);
  // Round-5: `reason` is freeText sourced from seed-failure metadata —
  // ordinary prose that (aside from incidental overlaps with this module's
  // own command vocabulary) is not part of the known vocabulary, so it
  // redacts by default. This is the intended, honestly re-disclosed friction
  // (why-redaction.ts's module header) — NOT a functional regression: the
  // cause is still detected, ranked, and actionable regardless of what the
  // raw reason text said.
  const reasons = c!.evidence.values.reasons as string[];
  for (const word of ["build", "repeatedly", "escalated"]) {
    assert.equal(reasons[0]!.includes(word), false, `original prose word "${word}" must not survive`);
  }
  assert.match(reasons[0]!, /\[redacted\]/);
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
// Security fix: hook-blocker command/summary must never leak secrets
// verbatim, in EITHER the human evidence values or the nextCommand string —
// both are part of the same StallDiagnosis object, so both --json and human
// output are covered by one assertion on the diagnosis object.
//
// Low-level redaction-function unit tests (keyword matching, URL scrubbing,
// truncation, the narrowed opaque-token fallback) live in
// tests/admin-why-redaction.test.ts alongside the module they exercise. The
// tests below are integration-level: they prove `diagnoseStall` actually
// routes EVERY cause's evidence + nextCommand through the single choke point
// (round-2 HIGH fix), not just hook_blocker.
// ---------------------------------------------------------------------------

test("second egress (round-2 HIGH fix): task_blocked's raw seedFailure reason is redacted, not just hook_blocker's command", () => {
  const secretReason = "build step failed: PGPASSWORD=hunter2Aa1! psql connection refused";
  const d = diagnoseStall(
    baseline({ blockedTasks: [{ taskId: "t1", reason: secretReason }] })
  );
  const c = cause(d, "task_blocked");
  assert.ok(c);
  const reasons = c!.evidence.values.reasons as string[];
  assert.equal(reasons[0]!.includes("hunter2Aa1!"), false, "reason must be redacted, not passed through raw");
  // Round-9 CRITICAL fix: the "PGPASSWORD=[redacted]" token (stage-1's own
  // partial redaction, not a whole-token exact "[redacted]") no longer
  // short-circuits at stage 2 — it now falls through to full re-analysis and,
  // since "PGPASSWORD=[redacted]" isn't a flag=value pair (no leading dash)
  // or any other recognized safe shape, the WHOLE token collapses to a bare
  // "[redacted]" rather than preserving the "PGPASSWORD=" label text. This is
  // MORE conservative than before, never less safe.
  assert.match(reasons[0]!, /\[redacted\]/);
  assert.equal(reasons[0]!.includes("PGPASSWORD="), false);
});

test("single choke point: EVERY freeText-tagged cause class redacts its evidence values, not just the ones that opt in", () => {
  // Planted across every genuinely free-text channel in the diagnosis layer —
  // task_blocked's seedFailure reason, a respawn lease owner identity, and a
  // hook-blocker's recorded command/summary. (councilGates.outcome and
  // reviewBlockedTasks.blockers are deliberately NOT included here — under
  // the round-4 provenance model those are structured/trusted, generated by
  // this codebase's own policy code, not external free text; planting a
  // "secret" there would be testing the wrong thing.)
  const secret = "AWS_SECRET_ACCESS_KEY=AKIA_LEAKED_12345678";
  const d = diagnoseStall(
    baseline({
      blockedTasks: [{ taskId: "t1", reason: secret }],
      respawn: { taskId: "t4", count: 0, budget: 8, leaseHeld: true, leaseOwner: secret },
      sidecars: {
        hookBlocker: { taskId: "t1", blockerKind: "generic_nonzero_bash", command: secret, summary: secret }
      }
    })
  );
  const serialized = JSON.stringify(d);
  assert.equal(serialized.includes("AKIA_LEAKED_12345678"), false, "no freeText channel may leak the raw secret value");
  assert.ok(serialized.includes("[redacted]"), "the redaction marker must appear in its place");
});

test("daemon_handoff_blocked nextCommand (built from external sidecar text) is also redacted", () => {
  const d = diagnoseStall(
    baseline({
      sidecars: {
        daemonHandoff: {
          state: "blocked",
          reason: "r",
          nextActions: ["PGPASSWORD=hunter2Aa1! npm run archon:doctor -- --repair"]
        }
      }
    })
  );
  const c = cause(d, "daemon_handoff_blocked");
  assert.ok(c);
  assert.equal(c!.nextCommand.includes("hunter2Aa1!"), false);
  // Round-9 CRITICAL fix: see the matching comment in the task_blocked test
  // above — the "PGPASSWORD=[redacted]" token now fully collapses to a bare
  // "[redacted]" at stage 2 instead of preserving the label text, since it is
  // no longer whole-token-exempt merely for containing the marker substring.
  assert.match(c!.nextCommand, /\[redacted\]/);
  assert.equal(c!.nextCommand.includes("PGPASSWORD="), false);
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

// QA LOW (round-2): the out-of-scope direction above was tested, but the
// keep-direction under a POPULATED, MATCHING --task-id scope was not —
// prove both halves of the filter, not just the exclusion half.
test("--task-id filter: context_guard_pending kept under a populated, matching scope", () => {
  const inScope = diagnoseStall(
    baseline({
      scope: { taskId: "t1" },
      sidecars: { contextGuard: { state: "handoff_written", taskId: "t1", invocationId: "inv-1" } }
    })
  );
  assert.ok(cause(inScope, "context_guard_pending"), "matching --task-id must keep the cause");
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

// ---------------------------------------------------------------------------
// Round-5 gate finding 2: the compile-time evidence brand alone is
// convention — `{ ... } as StallCauseEvidence` compiles fine, since `as`
// casts bypass structural checks entirely. `buildEvidence()` registers every
// object it constructs in a private WeakSet; both render paths
// (`formatStallDiagnosis`, `serializeStallDiagnosis`) must THROW when a
// cause's evidence was never registered, so a cast that skips the
// constructor fails loudly instead of silently skipping redaction.
// ---------------------------------------------------------------------------

function castEvidenceLiteral(source: string, values: Record<string, unknown>): StallCauseEvidence {
  // Simulates the ONLY way a caller could bypass `buildEvidence()`: the
  // `EVIDENCE_BRAND` symbol is not exported, so no code outside
  // why-diagnosis.ts can construct a real `StallCauseEvidence` object
  // literal — an `as unknown as` cast is the sole escape hatch, and it is
  // exactly what this test exercises.
  return { source, values } as unknown as StallCauseEvidence;
}

function diagnosisWithCastEvidence() {
  const d = diagnoseStall(baseline({ retroSealBlocked: true }));
  const castCause = {
    ...d.causes[0]!,
    evidence: castEvidenceLiteral("forged source", { fake: "value" })
  };
  return { ...d, causes: [castCause] };
}

test("runtime brand: assertDiagnosisEvidenceRegistered throws on an as-cast literal evidence object", () => {
  assert.throws(() => assertDiagnosisEvidenceRegistered(diagnosisWithCastEvidence()), /not constructed via buildEvidence/);
});

test("runtime brand: formatStallDiagnosis throws (not silently renders) an as-cast literal evidence object", () => {
  assert.throws(() => formatStallDiagnosis(diagnosisWithCastEvidence()), /not constructed via buildEvidence/);
});

test("runtime brand: serializeStallDiagnosis throws (not silently serializes) an as-cast literal evidence object", () => {
  assert.throws(() => serializeStallDiagnosis(diagnosisWithCastEvidence()), /not constructed via buildEvidence/);
});

test("runtime brand: a real diagnosis (every cause built via buildEvidence) never throws on either render path", () => {
  const d = diagnoseStall(baseline({ retroSealBlocked: true }));
  assert.doesNotThrow(() => assertDiagnosisEvidenceRegistered(d));
  assert.doesNotThrow(() => formatStallDiagnosis(d));
  assert.doesNotThrow(() => serializeStallDiagnosis(d));
  assert.equal(serializeStallDiagnosis(d), JSON.stringify(d));
});
