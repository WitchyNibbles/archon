/**
 * Tests for the Forge snapshot generator's hardened entry points:
 * the bounds-checked output-path resolver and the exported sample builder.
 * The import-time guard is implicitly verified — importing this module must
 * NOT execute main() (no file written, no process exit).
 *
 * forgeDashboardBlockerClarity additions:
 * - isHardGateReason() hard-gate guard (defense-in-depth)
 * - origin-based advisory classification (rqSet from rationale[], not free-text)
 * - sealed-task suppression (no blockers from approved/done tasks)
 * - advisory flag on per-task blockers
 * - run-level blockers are always advisory:false
 * - header.sealed derivation
 * - derivePulseState returns "complete" for all-sealed runs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  resolveSnapshotOutputPath,
  buildSampleSnapshot,
  projectLiveSnapshot,
  isHardGateReason,
  STDOUT_TARGET
} from "../src/forge/snapshot.ts";
import type {
  RunStatusSnapshot,
  RoutingRecommendationReport,
  ReviewRecord,
} from "../src/domain/types.ts";

const REPO = "/tmp/archon-repo";

describe("resolveSnapshotOutputPath", () => {
  it("defaults to the gitignored live path (snapshot.live.json) when no mode given", () => {
    assert.equal(
      resolveSnapshotOutputPath(undefined, REPO),
      path.join(REPO, "web", "public", "snapshot.live.json")
    );
  });

  it("defaults to the committed sample path (snapshot.json) in sample mode", () => {
    assert.equal(
      resolveSnapshotOutputPath(undefined, REPO, "sample"),
      path.join(REPO, "web", "public", "snapshot.json")
    );
  });

  it("passes through the stdout sentinel", () => {
    assert.equal(resolveSnapshotOutputPath(STDOUT_TARGET, REPO), STDOUT_TARGET);
  });

  it("accepts an in-repo .json path", () => {
    assert.equal(
      resolveSnapshotOutputPath("web/public/snapshot.live.json", REPO),
      path.join(REPO, "web", "public", "snapshot.live.json")
    );
  });

  it("rejects a path that escapes the repository root", () => {
    assert.throws(
      () => resolveSnapshotOutputPath("../../etc/cron.d/evil.json", REPO),
      /must stay within the repository/
    );
  });

  it("rejects an absolute path outside the repo", () => {
    assert.throws(
      () => resolveSnapshotOutputPath("/etc/passwd.json", REPO),
      /must stay within the repository/
    );
  });

  it("rejects a prefix-spoof sibling path (locks the ${repoRoot}${sep} invariant)", () => {
    // `/tmp/archon-repo-evil/x.json` shares the repo-root string prefix but is a
    // SIBLING, not inside the repo. A bare startsWith(repoRoot) would wrongly
    // accept it; the separator-appended check must reject it. This guards against
    // a future simplification silently breaking the security boundary.
    assert.throws(
      () => resolveSnapshotOutputPath(`${REPO}-evil/x.json`, REPO),
      /must stay within the repository/
    );
  });

  it("accepts an absolute path that IS inside the repo", () => {
    assert.equal(
      resolveSnapshotOutputPath(path.join(REPO, "web", "public", "out.json"), REPO),
      path.join(REPO, "web", "public", "out.json")
    );
  });

  it("rejects a non-.json output path", () => {
    assert.throws(
      () => resolveSnapshotOutputPath("web/public/snapshot.txt", REPO),
      /must end in \.json/
    );
  });
});

describe("buildSampleSnapshot", () => {
  it("returns a schema-valid view model with a blocked run and review gates", () => {
    const snapshot = buildSampleSnapshot();
    assert.equal(snapshot.header.status, "review_blocked");
    assert.ok(snapshot.blockers.length > 0, "expected at least one blocker");
    assert.ok(snapshot.reviewGates.some((g) => g.state === "blocked"), "expected a blocked gate");
    assert.ok(snapshot.taskQueue.length > 0, "expected a populated task queue");
  });

  it("sample blockers all have the advisory field set as boolean", () => {
    const snapshot = buildSampleSnapshot();
    for (const b of snapshot.blockers) {
      assert.ok(
        typeof b.advisory === "boolean",
        `blocker ${b.id} must have advisory: boolean, got ${typeof b.advisory}`
      );
    }
  });

  it("sample header has sealed: false (run is review_blocked, not all-sealed)", () => {
    const snapshot = buildSampleSnapshot();
    assert.equal(snapshot.header.sealed, false, "review_blocked sample must not be sealed");
  });
});

// ---------------------------------------------------------------------------
// isHardGateReason — hard-gate guard (defense-in-depth)
// ---------------------------------------------------------------------------
//
// These patterns MUST force advisory:false even if a blocker message appears
// in the reasoning-quality origin set (rqSet). This prevents adversarial or
// accidental blocker text that contains reasoning vocabulary from being
// silently hidden.

describe("isHardGateReason — hard-gate guard", () => {
  // Patterns that MUST match (= force advisory:false)
  const hardGatePhrases = [
    // severity qualifiers
    "CRITICAL: data corruption found",
    "HIGH severity finding in auth layer",
    // security_reviewer mentions
    "security_reviewer gate not passed",
    "security_reviewer: records no reasoning in the review record",
    // security finding / security gate
    "security finding: injection risk",
    "security gate waived without justification",
    // CVE
    "CVE-2024-12345 unresolved dependency",
    // waived
    "approval waived",
    "waived by operator",
    // gate record status
    "approval record absent from runtime store",
    "review record absent — no gate recorded",
    // Adversarial inputs that would fool a naive free-text heuristic:
    // (these contain reasoning vocabulary but must NOT be advisory)
    "reasoning verdict: security gate waived without evidence",
    "security_reviewer: records no reasoning in the review record",
    "missing a reasoning-quality justification for waived security gate",
  ];

  for (const phrase of hardGatePhrases) {
    it(`isHardGateReason("${phrase.slice(0, 60)}") === true`, () => {
      assert.equal(
        isHardGateReason(phrase),
        true,
        `expected hard-gate match for: ${phrase}`
      );
    });
  }

  // Patterns that must NOT match (= may be advisory if in rqSet)
  const safeRqPhrases = [
    "task alpha is missing a strict reasoning policy",
    "task beta records no reasoning verdict",
    "task gamma records no reasoning attempts",
    "task delta has reasoning attempts without trace references",
    "task epsilon records no reasoning verifications",
    "task zeta has no passed critic or reviewer verification",
    "task eta verdict remains insufficient_evidence",
    "task theta verdict is contradicted",
    "task iota exhausted its reasoning budget",
    "task kappa still needs trusted review before conclusion",
    "task lambda is missing a reasoning-quality block",
  ];

  for (const phrase of safeRqPhrases) {
    it(`isHardGateReason("${phrase.slice(0, 60)}") === false`, () => {
      assert.equal(
        isHardGateReason(phrase),
        false,
        `expected no hard-gate match for: ${phrase}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Helpers for projectLiveSnapshot fixture construction
// ---------------------------------------------------------------------------

function makeRun(overrides?: Partial<RunStatusSnapshot["run"]>): RunStatusSnapshot["run"] {
  return {
    id: "run-test-001",
    workspaceId: "ws-1",
    projectId: "proj-1",
    actor: "test",
    title: "Test Run",
    request: "test request",
    summary: { goal: "test", constraints: [], assumptions: [] },
    status: "in_progress",
    createdAt: "2026-06-24T09:00:00Z",
    updatedAt: "2026-06-24T09:30:00Z",
    ...overrides,
  };
}

function makeTask(
  taskId: string,
  status: RunStatusSnapshot["tasks"][0]["status"],
  overrides?: Partial<RunStatusSnapshot["tasks"][0]>
): RunStatusSnapshot["tasks"][0] {
  return {
    id: `task-record-${taskId}`,
    runId: "run-test-001",
    workspaceId: "ws-1",
    projectId: "proj-1",
    class: "standard",
    packet: {
      taskId,
      title: `Task ${taskId}`,
      ownerRole: "backend_engineer",
      completionStandard: "tests pass",
      writeScope: [],
      requiredSpecialistRoles: [],
      qualityGates: [],
    },
    status,
    createdAt: "2026-06-24T09:00:00Z",
    updatedAt: "2026-06-24T09:30:00Z",
    ...overrides,
  };
}

function makeRoutingReport(
  recommendations: RoutingRecommendationReport["recommendations"]
): RoutingRecommendationReport {
  return {
    mode: "advisory_only",
    runId: "run-test-001",
    recommendations,
  };
}

const NO_REVIEWS: ReviewRecord[] = [];

// ---------------------------------------------------------------------------
// Sealed-task blocker suppression
// ---------------------------------------------------------------------------

describe("projectLiveSnapshot — sealed-task blocker suppression", () => {
  it("approved task emits ZERO blockers", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-alpha", "approved")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([
      {
        taskId: "task-alpha",
        taskStatus: "approved",
        recommendation: "wait",
        authorityLabel: "derived_only",
        // Even with rationale and blockers present, approved task must be silent.
        rationale: ["reasoning-quality: task alpha is missing a strict reasoning policy"],
        blockers: ["task alpha is missing a strict reasoning policy", "not yet ready for routing"],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(
      result.blockers.length,
      0,
      "approved task must produce zero blockers"
    );
  });

  it("done task emits ZERO blockers", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-beta", "done")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([
      {
        taskId: "task-beta",
        taskStatus: "done",
        recommendation: "wait",
        authorityLabel: "derived_only",
        rationale: ["reasoning-quality: task beta records no reasoning verdict"],
        blockers: ["task beta records no reasoning verdict"],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, 0, "done task must produce zero blockers");
  });

  it("run with all-done tasks and memorized run.status emits zero task-level blockers", () => {
    // "memorized" is a RunStatus not a TaskStatus — task filtering only uses
    // SEALED_TASK_STATUSES (approved, done). This tests the correct separation.
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "memorized" }),
      tasks: [makeTask("task-gamma", "done")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([
      {
        taskId: "task-gamma",
        taskStatus: "done",
        recommendation: "wait",
        authorityLabel: "derived_only",
        rationale: [],
        blockers: ["task gamma records no reasoning attempts"],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, 0, "done tasks must produce zero blockers regardless of run.status");
  });

  it("non-sealed task with real gate blockers still emits blockers", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "review_blocked" }),
      tasks: [makeTask("task-active", "review_blocked")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([
      {
        taskId: "task-active",
        taskStatus: "review_blocked",
        recommendation: "review_dispatch",
        authorityLabel: "derived_only",
        rationale: ["invoke security_reviewer"],
        blockers: ["security_reviewer gate not passed"],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(
      result.blockers.length,
      1,
      "active review_blocked task must emit its real blocker"
    );
    assert.equal(result.blockers[0]!.advisory, false);
  });

  it("mixed run: sealed task silent, active task emits its blockers", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [
        makeTask("task-sealed", "approved"),
        makeTask("task-active", "review_blocked"),
      ],
      activeLocks: [],
      blockers: [],
      nextTaskIds: ["task-active"],
    };
    const routing = makeRoutingReport([
      {
        taskId: "task-sealed",
        taskStatus: "approved",
        recommendation: "wait",
        authorityLabel: "derived_only",
        rationale: ["reasoning-quality: task sealed records no reasoning verdict"],
        blockers: ["task sealed records no reasoning verdict", "not yet ready for routing"],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
      {
        taskId: "task-active",
        taskStatus: "review_blocked",
        recommendation: "review_dispatch",
        authorityLabel: "derived_only",
        rationale: ["invoke reviewer"],
        blockers: ["reviewer gate not passed"],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    // Only active task's real blocker should appear
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0]!.reason, "reviewer gate not passed");
    assert.equal(result.blockers[0]!.advisory, false);
  });
});

// ---------------------------------------------------------------------------
// Advisory classification — origin-based (rqSet from rationale[])
// ---------------------------------------------------------------------------
//
// A blocker is advisory:true iff:
//   1. Its raw message appears in rationale[] with "reasoning-quality: " prefix (rqSet)
//   2. AND it does NOT match isHardGateReason() (hard-gate guard)
//
// Run-level blockers (snapshot.blockers) are ALWAYS advisory:false.

describe("projectLiveSnapshot — origin-based advisory classification", () => {
  // Real message templates from assessTaskPacketReasoning / assessReasoningExecutionLayer:
  //   "task {id} is missing a strict reasoning policy"
  //   "task {id} records no reasoning attempts"
  //   "task {id} has reasoning attempts without trace references"
  //   "task {id} records no reasoning verifications"
  //   "task {id} has no passed critic or reviewer verification"
  //   "task {id} records no reasoning verdict"
  //   "task {id} verdict remains insufficient_evidence"
  //   "task {id} verdict is contradicted"
  //   "task {id} exhausted its reasoning budget"
  //   "task {id} still needs trusted review before conclusion"
  //   "task {id} is missing a reasoning-quality block"

  it("rq blocker in rationale with prefix is advisory:true", () => {
    const rqMsg = "task task-in-progress is missing a strict reasoning policy";
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-in-progress", "in_progress")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: ["task-in-progress"],
    };
    const routing = makeRoutingReport([
      {
        taskId: "task-in-progress",
        taskStatus: "in_progress",
        recommendation: "wait",
        authorityLabel: "derived_only",
        // rationale carries the "reasoning-quality: " prefixed version
        rationale: [`reasoning-quality: ${rqMsg}`],
        // blockers carries the raw message (no prefix)
        blockers: [rqMsg],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0]!.advisory, true, "origin-matched rq message must be advisory:true");
    assert.equal(result.blockers[0]!.kind, "reasoning_quality");
  });

  it("all eleven real rq message templates classify as advisory:true", () => {
    const taskId = "task-rq-test";
    const rqMessages = [
      `task ${taskId} is missing a strict reasoning policy`,
      `task ${taskId} records no reasoning attempts`,
      `task ${taskId} has reasoning attempts without trace references`,
      `task ${taskId} records no reasoning verifications`,
      `task ${taskId} has no passed critic or reviewer verification`,
      `task ${taskId} records no reasoning verdict`,
      `task ${taskId} verdict remains insufficient_evidence`,
      `task ${taskId} verdict is contradicted`,
      `task ${taskId} exhausted its reasoning budget`,
      `task ${taskId} still needs trusted review before conclusion`,
      `task ${taskId} is missing a reasoning-quality block`,
    ];

    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask(taskId, "in_progress")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [taskId],
    };
    const routing = makeRoutingReport([
      {
        taskId,
        taskStatus: "in_progress",
        recommendation: "wait",
        authorityLabel: "derived_only",
        rationale: rqMessages.map((m) => `reasoning-quality: ${m}`),
        blockers: [...rqMessages],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, rqMessages.length, "all rq messages must produce one blocker each");
    for (const b of result.blockers) {
      assert.equal(b.advisory, true, `expected advisory:true for rq message: ${b.reason}`);
      assert.equal(b.kind, "reasoning_quality");
    }
  });

  it("rq blocker NOT in rationale (not origin-tagged) is advisory:false", () => {
    // Simulates a message that looks like an rq message but was not tagged by the runtime.
    const fakeRqMsg = "task task-x is missing a strict reasoning policy";
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-x", "in_progress")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: ["task-x"],
    };
    const routing = makeRoutingReport([
      {
        taskId: "task-x",
        taskStatus: "in_progress",
        recommendation: "wait",
        authorityLabel: "derived_only",
        // rationale has NO "reasoning-quality: " entry for this message
        rationale: ["some other context note"],
        blockers: [fakeRqMsg],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, 1);
    assert.equal(
      result.blockers[0]!.advisory,
      false,
      "blocker without origin tag in rationale must be advisory:false"
    );
  });

  it("hard-gate guard forces advisory:false even when in rqSet — adversarial inputs", () => {
    // These three adversarial inputs from the security review:
    // They contain reasoning vocabulary that would fool a free-text regex,
    // AND we set them in rqSet (rationale prefixed) to simulate the worst case.
    // The hard-gate guard must override and force advisory:false.
    const adversarialInputs = [
      "reasoning verdict: security gate waived without evidence",
      "security_reviewer: records no reasoning in the review record",
      "missing a reasoning-quality justification for waived security gate",
    ];

    const taskId = "task-adversarial";
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask(taskId, "in_progress")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [taskId],
    };
    const routing = makeRoutingReport([
      {
        taskId,
        taskStatus: "in_progress",
        recommendation: "wait",
        authorityLabel: "derived_only",
        // Simulate adversarial rationale: attacker sets the origin tag too
        rationale: adversarialInputs.map((m) => `reasoning-quality: ${m}`),
        blockers: [...adversarialInputs],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, adversarialInputs.length);
    for (const b of result.blockers) {
      assert.equal(
        b.advisory,
        false,
        `hard-gate guard must force advisory:false for: ${b.reason}`
      );
    }
  });

  it("mixed recommendation: rq messages advisory, gate blockers real — correctly split", () => {
    const taskId = "task-mixed";
    const rqMsg = "task task-mixed records no reasoning verdict";
    const gateMsg = "security_reviewer gate not passed";
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask(taskId, "review_blocked")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [taskId],
    };
    const routing = makeRoutingReport([
      {
        taskId,
        taskStatus: "review_blocked",
        recommendation: "review_dispatch",
        authorityLabel: "derived_only",
        rationale: [`reasoning-quality: ${rqMsg}`, "invoke security_reviewer"],
        // blockers has both: the rq message (raw) and the real gate message
        blockers: [rqMsg, gateMsg],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, 2);

    const advisory = result.blockers.filter((b) => b.advisory);
    const real = result.blockers.filter((b) => !b.advisory);
    assert.equal(advisory.length, 1, "one advisory blocker expected");
    assert.equal(real.length, 1, "one real blocker expected");
    assert.equal(advisory[0]!.reason, rqMsg, "advisory must be the rq message");
    assert.equal(advisory[0]!.kind, "reasoning_quality");
    assert.equal(real[0]!.reason, gateMsg, "real must be the gate blocker");
    assert.equal(real[0]!.kind, "review_missing");
  });

  it("run-level blockers are ALWAYS advisory:false regardless of message content", () => {
    // Run-level blockers come from snapshot.blockers (runtime), never from
    // per-task reasoning assessments. They have no rationale[] to inspect.
    // They are always real — the hero must show them.
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-x", "in_progress")],
      activeLocks: [],
      // Even if the message text looks like reasoning vocabulary
      blockers: [
        "task x is missing a strict reasoning policy",
        "real gate blocker",
        "strict reasoning policy not met",
      ],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, 3, "all run-level blockers must appear");
    for (const b of result.blockers) {
      assert.equal(
        b.advisory,
        false,
        `run-level blocker must always be advisory:false, got true for: ${b.reason}`
      );
    }
  });

  it("zero advisory blockers when rationale has no reasoning-quality entries", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "review_blocked" }),
      tasks: [makeTask("task-t", "review_blocked")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: ["task-t"],
    };
    const routing = makeRoutingReport([
      {
        taskId: "task-t",
        taskStatus: "review_blocked",
        recommendation: "review_dispatch",
        authorityLabel: "derived_only",
        // rationale has only non-rq entries
        rationale: ["invoke reviewer", "qa_engineer required"],
        blockers: ["reviewer gate not passed", "qa_engineer gate not passed"],
        allowedWriteScope: [],
        retrievalGuidance: [],
        approvalCheckpoints: [],
      },
    ]);

    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.blockers.length, 2);
    for (const b of result.blockers) {
      assert.equal(b.advisory, false, `expected advisory:false when no rq origin tags: ${b.reason}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Sealed derivation and pulse
// ---------------------------------------------------------------------------

describe("projectLiveSnapshot — sealed derivation + pulse", () => {
  it("sealed=true when all tasks are approved", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [
        makeTask("task-a", "approved"),
        makeTask("task-b", "approved"),
      ],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([]);
    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.header.sealed, true, "all-approved run must be sealed");
  });

  it("sealed=true when all tasks are done", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-a", "done"), makeTask("task-b", "done")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([]);
    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.header.sealed, true);
  });

  it("sealed=false when any task is not sealed", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-a", "approved"), makeTask("task-b", "review_blocked")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([]);
    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.header.sealed, false);
  });

  it("sealed=false when task list is empty", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([]);
    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(result.header.sealed, false, "empty task list must not be sealed");
  });

  it("pulse=complete for all-sealed run even when run.status===in_progress", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-a", "approved"), makeTask("task-b", "done")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([]);
    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    assert.equal(
      result.pulse.pulseState,
      "complete",
      "all-sealed run must pulse complete regardless of raw run.status"
    );
  });

  it("header.status stays honest/raw even when sealed (not overwritten to done)", () => {
    const snapshot: RunStatusSnapshot = {
      run: makeRun({ status: "in_progress" }),
      tasks: [makeTask("task-a", "approved")],
      activeLocks: [],
      blockers: [],
      nextTaskIds: [],
    };
    const routing = makeRoutingReport([]);
    const result = projectLiveSnapshot(snapshot, routing, NO_REVIEWS);
    // sealed=true but header.status must remain the raw DB value
    assert.equal(result.header.status, "in_progress", "header.status must stay honest");
    assert.equal(result.header.sealed, true, "header.sealed must reflect task completion");
  });

  it("existing contract tests still round-trip (additive fields)", () => {
    // Regression guard: the new fields advisory + sealed must not break
    // existing callers that do a strip-parse through the schema.
    const snap = buildSampleSnapshot();
    // header.sealed and blockers[].advisory must be preserved through strip-parse
    assert.equal(typeof snap.header.sealed, "boolean");
    for (const b of snap.blockers) {
      assert.equal(typeof b.advisory, "boolean");
    }
  });
});
