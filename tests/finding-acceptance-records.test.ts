/**
 * Finding Acceptance Records — TDD suite.
 *
 * All tests in this file MUST FAIL before the implementation is complete and
 * MUST PASS after. Uses Node built-in test runner (no vitest).
 *
 * Covers:
 *   A. canReviewRecordSatisfyGate — accepted-finding gate predicate
 *   B. validateReviewAction — input-validation defense-in-depth
 *   C. parseReviewFindingsJson — acceptance field parsing
 *   D. JSON round-trip — acceptance fields survive serialize/deserialize
 *   E. WorkflowProofResult — acceptedFindings surface in proof output
 *   F. Backward-compat — existing zero-finding and waived paths unchanged
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canReviewRecordSatisfyGate, validateReviewAction } from "../src/domain/contracts.ts";
import { createTrustedReviewActionContextForTest } from "../src/core/review-context.ts";
import type {
  ReviewRecord,
  ReviewFinding,
  ReviewInput
} from "../src/domain/types.ts";
import { executeWorkflowProofCommandFromArgs, parseReviewFindingsJson } from "../src/review.ts";
import type { WorkflowProofResult } from "../src/review.ts";
import type { ApprovalRecord, TaskRecord } from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReview(
  overrides: Partial<ReviewRecord> & {
    findingDetails?: readonly ReviewFinding[] | undefined;
  } = {}
): ReviewRecord {
  return {
    id: "rev-001",
    runId: "run-001",
    taskId: "task-001",
    reviewerRole: "reviewer",
    actor: "review-orchestrator",
    actorRole: "reviewer",
    source: "orchestrator",
    state: "passed",
    severity: "low",
    findings: [],
    waiverReason: undefined,
    evidenceRefs: [],
    createdAt: "2026-07-01T00:00:00Z",
    findingDetails: undefined,
    ...overrides
  } satisfies ReviewRecord;
}

// ---------------------------------------------------------------------------
// A. canReviewRecordSatisfyGate — acceptance gate predicate
// ---------------------------------------------------------------------------

describe("canReviewRecordSatisfyGate — accepted findings", () => {

  // ── A1: backward compat — zero findings still passes ─────────────────────

  it("A1: passed + zero findings → gate satisfied (unchanged)", () => {
    const review = makeReview({ state: "passed", findings: [], findingDetails: undefined });
    assert.strictEqual(canReviewRecordSatisfyGate(review), true);
  });

  // ── A2: finding with no disposition blocks gate ───────────────────────────

  it("A2: passed + finding with no disposition → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["mutation in recordReview"],
      findingDetails: [
        { message: "mutation in recordReview", severity: "low", category: "immutability_violation" }
        // disposition is absent / undefined
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A3: fully accepted low severity → gate satisfied ─────────────────────

  it("A3: passed + fully accepted low severity finding → gate satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["mutation in recordReview"],
      findingDetails: [
        {
          message: "mutation in recordReview",
          severity: "low",
          category: "immutability_violation",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Deliberate trade-off: this hot path is documented and owner is aware"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), true);
  });

  // ── A4: fully accepted medium severity → gate satisfied ──────────────────

  it("A4: passed + fully accepted medium severity finding → gate satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["missing input validation in handler"],
      findingDetails: [
        {
          message: "missing input validation in handler",
          severity: "medium",
          disposition: "accepted",
          acceptedByRole: "security_reviewer",
          acceptanceReason: "Validation is enforced at the API gateway layer; this handler is internal-only"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), true);
  });

  // ── A5: accepted finding missing reason → gate NOT satisfied ─────────────

  it("A5: passed + accepted finding with empty acceptanceReason → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["mutation in recordReview"],
      findingDetails: [
        {
          message: "mutation in recordReview",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: ""   // empty — invalid
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A6: accepted finding missing acceptedByRole → gate NOT satisfied ─────

  it("A6: passed + accepted finding with empty acceptedByRole → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["mutation found"],
      findingDetails: [
        {
          message: "mutation found",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "",    // empty — invalid
          acceptanceReason: "Intentional for perf"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A7: accepted high severity → gate NOT satisfied ──────────────────────

  it("A7: passed + accepted finding with severity 'high' → gate NOT satisfied (hard rule)", () => {
    const review = makeReview({
      state: "passed",
      findings: ["SQL injection possible"],
      findingDetails: [
        {
          message: "SQL injection possible",
          severity: "high",
          disposition: "accepted",
          acceptedByRole: "security_reviewer",
          acceptanceReason: "Will fix in follow-up"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A8: accepted critical severity → gate NOT satisfied ──────────────────

  it("A8: passed + accepted finding with severity 'critical' → gate NOT satisfied (hard rule)", () => {
    const review = makeReview({
      state: "passed",
      findings: ["RCE via deserialization"],
      findingDetails: [
        {
          message: "RCE via deserialization",
          severity: "critical",
          disposition: "accepted",
          acceptedByRole: "security_reviewer",
          acceptanceReason: "Acknowledged risk"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A9: one accepted, one unaccepted → gate NOT satisfied ────────────────

  it("A9: passed + one fully accepted + one with no disposition → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["finding A", "finding B (open)"],
      findingDetails: [
        {
          message: "finding A",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Out of scope for this task"
        },
        {
          message: "finding B (open)",
          severity: "medium"
          // no disposition — open finding
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A10: findingDetails absent but findings non-empty → gate NOT satisfied

  it("A10: passed + non-empty findings + no findingDetails → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["mutation found"],
      findingDetails: undefined  // cannot verify acceptance without details
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A11: findingDetails length mismatch → gate NOT satisfied ─────────────

  it("A11: passed + findings.length !== findingDetails.length → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["finding A", "finding B"],
      findingDetails: [
        // Only one detail for two findings
        {
          message: "finding A",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Deliberate"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A12: security_reviewer severity rule still applies ───────────────────

  it("A12: security_reviewer with zero findings + high severity → gate NOT satisfied (existing rule)", () => {
    const review = makeReview({
      reviewerRole: "security_reviewer",
      actorRole: "security_reviewer",
      state: "passed",
      severity: "high",     // security_reviewer cannot pass with high overall severity
      findings: [],
      findingDetails: undefined
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A13: waived path unchanged ───────────────────────────────────────────

  it("A13: waived review with valid waiverReason → gate satisfied (unchanged)", () => {
    const review = makeReview({
      state: "waived",
      findings: [],
      waiverReason: "Docs-only task; waiver granted by planner",
      actorRole: "planner",
      reviewerRole: "reviewer"
    });
    // planner is in managerWaiverRoles and CAN waive the "reviewer" gate role.
    // All other conditions are satisfied: source=orchestrator, non-empty actor,
    // valid actorRole, valid reviewerRole, valid state, non-empty waiverReason.
    // Assert the specific expected value — not just typeof — to prove the waived
    // path is intact and returns the correct decision.
    const result = canReviewRecordSatisfyGate(review);
    assert.strictEqual(result, true);  // planner can waive reviewer — waived path unchanged
  });

  // ── A14: accepted finding with undefined severity → gate NOT satisfied ────
  // Regression: the old exclusion list (severity === "high" || severity === "critical")
  // was bypassed when severity was undefined. The positive allowlist fixes this.

  it("A14: passed + accepted finding with undefined severity → gate NOT satisfied (allowlist bypass fix)", () => {
    const review = makeReview({
      state: "passed",
      findings: ["some low-signal finding"],
      findingDetails: [
        {
          message: "some low-signal finding",
          // severity field intentionally omitted — undefined
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Low signal, owner aware"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });
});

// ---------------------------------------------------------------------------
// B. validateReviewAction — input validation defense-in-depth
// ---------------------------------------------------------------------------

describe("validateReviewAction — acceptance input validation", () => {

  // These exercise the gate-level contract (canReviewRecordSatisfyGate) which
  // embeds the same acceptance rule. Direct validateReviewAction coverage — the
  // input-layer defense-in-depth loop itself — is in the "B-prime" describe block
  // below, using createTrustedReviewActionContextForTest to mint a trusted context.

  // ── B1: accepted finding requires non-empty reason ───────────────────────

  it("B1: findingDetails with disposition=accepted and empty acceptanceReason → findingsAreFullyAccepted returns false (gate-level proxy)", () => {
    // Test the gate-level contract which embeds the input rule
    const review = makeReview({
      state: "passed",
      findings: ["some issue"],
      findingDetails: [
        {
          message: "some issue",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "   "  // whitespace only — must be rejected
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── B2: accepted finding requires non-empty acceptedByRole ───────────────

  it("B2: findingDetails with disposition=accepted and missing acceptedByRole → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["some issue"],
      findingDetails: [
        {
          message: "some issue",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: undefined,  // missing
          acceptanceReason: "Deliberate trade-off"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── B3: high severity accepted finding rejected at input level ───────────

  it("B3: high severity accepted finding → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["critical path injection"],
      findingDetails: [
        {
          message: "critical path injection",
          severity: "high",
          disposition: "accepted",
          acceptedByRole: "security_reviewer",
          acceptanceReason: "Known risk, tracked externally"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── B4: critical severity accepted finding rejected at input level ────────

  it("B4: critical severity accepted finding → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["auth bypass"],
      findingDetails: [
        {
          message: "auth bypass",
          severity: "critical",
          disposition: "accepted",
          acceptedByRole: "security_reviewer",
          acceptanceReason: "Will fix in emergency patch"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });
});

// ---------------------------------------------------------------------------
// B-prime. validateReviewAction — DIRECT coverage of the input-layer acceptance
// loop (not proxied through the gate). Uses a minted trusted context so the
// per-finding acceptance validation branch runs on its own.
// ---------------------------------------------------------------------------

describe("validateReviewAction — direct input-layer acceptance validation", () => {
  const ctx = createTrustedReviewActionContextForTest({ actor: "review-orchestrator", actorRole: "reviewer" });

  function makeInput(findingDetails: readonly ReviewFinding[]): ReviewInput {
    return {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: findingDetails.map((f) => f.message),
      findingDetails
    };
  }

  it("Bd1: accepted finding missing acceptanceReason → errors name acceptanceReason", () => {
    const errors = validateReviewAction(ctx, makeInput([
      { message: "x", severity: "low", disposition: "accepted", acceptedByRole: "reviewer", acceptanceReason: "  " }
    ]));
    assert.ok(errors.some((e) => /acceptanceReason/i.test(e)), errors.join(" | "));
  });

  it("Bd2: accepted finding missing acceptedByRole → errors name acceptedByRole", () => {
    const errors = validateReviewAction(ctx, makeInput([
      { message: "x", severity: "low", disposition: "accepted", acceptedByRole: "", acceptanceReason: "trade-off" }
    ]));
    assert.ok(errors.some((e) => /acceptedByRole/i.test(e)), errors.join(" | "));
  });

  it("Bd3: accepted high-severity finding → errors reject the acceptance (hard rule)", () => {
    const errors = validateReviewAction(ctx, makeInput([
      { message: "x", severity: "high", disposition: "accepted", acceptedByRole: "reviewer", acceptanceReason: "risk" }
    ]));
    assert.ok(errors.some((e) => /accept/i.test(e) && /high/i.test(e)), errors.join(" | "));
  });

  it("Bd4: accepted finding with UNDEFINED severity → rejected at the input layer (bypass fix)", () => {
    const errors = validateReviewAction(ctx, makeInput([
      { message: "x", disposition: "accepted", acceptedByRole: "reviewer", acceptanceReason: "trade-off" }
    ]));
    assert.ok(errors.length > 0, "an accepted finding with no severity must not validate clean");
  });

  it("Bd5: a fully valid low-severity accepted finding produces no acceptance errors", () => {
    const errors = validateReviewAction(ctx, makeInput([
      { message: "x", severity: "low", disposition: "accepted", acceptedByRole: "reviewer", acceptanceReason: "out of scope; owner: infra" }
    ]));
    assert.ok(
      !errors.some((e) => /acceptedByRole|acceptanceReason|cannot be accepted|severity/i.test(e)),
      errors.join(" | ")
    );
  });
});

// ---------------------------------------------------------------------------
// C. parseReviewFindingsJson — acceptance fields parsed and validated
// ---------------------------------------------------------------------------

describe("parseReviewFindingsJson — acceptance fields", () => {

  // ── C1: acceptance fields round-trip through JSON ─────────────────────────

  it("C1: acceptance fields round-trip through parseReviewFindingsJson", () => {
    const input = JSON.stringify([
      {
        message: "mutation in service",
        severity: "low",
        category: "immutability_violation",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Deliberate: hot path, owner aware"
      }
    ]);
    const result = parseReviewFindingsJson(input);
    assert.strictEqual(result.length, 1);
    const finding = result[0]!;
    assert.strictEqual(finding.disposition, "accepted");
    assert.strictEqual(finding.acceptedByRole, "reviewer");
    assert.strictEqual(finding.acceptanceReason, "Deliberate: hot path, owner aware");
  });

  // ── C2: finding without disposition still parses cleanly ─────────────────

  it("C2: finding without disposition parses cleanly (backward compat)", () => {
    const input = JSON.stringify([
      { message: "mutation found", severity: "high", category: "immutability_violation" }
    ]);
    const result = parseReviewFindingsJson(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.disposition, undefined);
    assert.strictEqual(result[0]!.acceptedByRole, undefined);
    assert.strictEqual(result[0]!.acceptanceReason, undefined);
  });

  // ── C3: invalid disposition value rejected ────────────────────────────────

  it("C3: invalid disposition value (not 'accepted') → throws", () => {
    const input = JSON.stringify([
      {
        message: "something",
        disposition: "dismissed"  // invalid — only "accepted" is allowed
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /disposition/i);
  });

  // ── C4: disposition=accepted with empty acceptanceReason rejected ─────────

  it("C4: disposition=accepted with empty acceptanceReason → throws", () => {
    const input = JSON.stringify([
      {
        message: "something",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: ""
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /acceptanceReason/i);
  });

  // ── C5: disposition=accepted with missing acceptedByRole rejected ──────────

  it("C5: disposition=accepted without acceptedByRole → throws", () => {
    const input = JSON.stringify([
      {
        message: "something",
        severity: "low",
        disposition: "accepted",
        acceptanceReason: "Deliberate"
        // acceptedByRole absent
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /acceptedByRole/i);
  });

  // ── C6: high severity accepted finding rejected at parse level ────────────

  it("C6: high severity + disposition=accepted → throws (hard rule)", () => {
    const input = JSON.stringify([
      {
        message: "SQL injection",
        severity: "high",
        disposition: "accepted",
        acceptedByRole: "security_reviewer",
        acceptanceReason: "Will fix later"
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /high.*accept|accept.*high|severity.*accept|accept.*severity/i);
  });

  // ── C7: critical severity accepted finding rejected at parse level ─────────

  it("C7: critical severity + disposition=accepted → throws (hard rule)", () => {
    const input = JSON.stringify([
      {
        message: "RCE",
        severity: "critical",
        disposition: "accepted",
        acceptedByRole: "security_reviewer",
        acceptanceReason: "Acknowledged"
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /critical.*accept|accept.*critical|severity.*accept|accept.*severity/i);
  });

  // ── C8: acceptedByRole must be string if present ──────────────────────────

  it("C8: acceptedByRole as non-string → throws", () => {
    const input = JSON.stringify([
      {
        message: "something",
        disposition: "accepted",
        acceptedByRole: 42,
        acceptanceReason: "Deliberate"
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /acceptedByRole/i);
  });

  // ── C9: acceptanceReason must be string if present ────────────────────────

  it("C9: acceptanceReason as non-string → throws", () => {
    const input = JSON.stringify([
      {
        message: "something",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: 123
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /acceptanceReason/i);
  });

  // ── C10: undefined severity accepted finding rejected at parse level ───────
  // Regression: the old exclusion list (high|critical) was bypassed when severity
  // was absent. The positive allowlist rejects any severity that is not "low" or "medium".

  it("C10: undefined severity + disposition=accepted → throws (allowlist bypass fix)", () => {
    const input = JSON.stringify([
      {
        message: "some finding",
        // severity field intentionally omitted
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Deliberate"
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /severity.*accept|accept.*severity/i);
  });
});

// ---------------------------------------------------------------------------
// D. JSON round-trip — acceptance fields survive serialize/deserialize
// ---------------------------------------------------------------------------

describe("ReviewFinding acceptance fields — JSON round-trip", () => {

  it("D1: acceptance fields survive JSON.stringify + JSON.parse round-trip", () => {
    const finding: ReviewFinding = {
      message: "mutation in recordReview",
      severity: "low",
      category: "immutability_violation",
      file: "src/core/service.ts",
      line: 42,
      symbol: "recordReview",
      disposition: "accepted",
      acceptedByRole: "reviewer",
      acceptanceReason: "Deliberate: this hot path is pre-authorized by the task owner"
    };

    const serialized = JSON.stringify([finding]);
    const deserialized = JSON.parse(serialized) as ReviewFinding[];

    assert.strictEqual(deserialized.length, 1);
    const back = deserialized[0]!;
    assert.strictEqual(back.message, finding.message);
    assert.strictEqual(back.disposition, "accepted");
    assert.strictEqual(back.acceptedByRole, "reviewer");
    assert.strictEqual(back.acceptanceReason, finding.acceptanceReason);
    assert.strictEqual(back.severity, "low");
    assert.strictEqual(back.symbol, "recordReview");
  });

  it("D2: acceptance fields absent in legacy findings survive round-trip as undefined", () => {
    const finding: ReviewFinding = {
      message: "mutation in old record",
      severity: "medium"
      // no acceptance fields
    };

    const serialized = JSON.stringify([finding]);
    const deserialized = JSON.parse(serialized) as ReviewFinding[];
    const back = deserialized[0]!;

    assert.strictEqual(back.disposition, undefined);
    assert.strictEqual(back.acceptedByRole, undefined);
    assert.strictEqual(back.acceptanceReason, undefined);
  });
});

// ---------------------------------------------------------------------------
// E. WorkflowProofResult — acceptedFindings surface in proof output
// ---------------------------------------------------------------------------

describe("executeWorkflowProofCommandFromArgs — acceptedFindings surface", () => {

  // Helper: minimal task for an approved snapshot
  function makeApprovedSnapshot(taskId: string): import("../src/domain/types.ts").RunStatusSnapshot {
    const packet: import("../src/domain/types.ts").TaskPacketInput = {
      taskId,
      title: "Test task",
      ownerRole: "backend_engineer",
      completionStandard: "specialist_verified",
      requiredSpecialistRoles: [],
      qualityGates: [],
      goal: "test",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope: ["src/"],
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews: ["reviewer"],
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: "standard"
    };

    // taskId lives on packet, not on the record itself — proof uses candidate.packet.taskId
    const task: TaskRecord = {
      id: "task-db-id",
      runId: "run-test",
      workspaceId: "ws-1",
      projectId: "proj-1",
      class: "general",
      packet,
      status: "approved",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z"
    };

    return {
      run: {
        id: "run-test",
        workspaceId: "ws-1",
        projectId: "proj-1",
        actor: "review-orchestrator",
        title: "Test run",
        request: "test",
        summary: {
          goal: "test",
          audience: [],
          constraints: [],
          risks: [],
          unknowns: [],
          successCriteria: [],
          outOfScope: [],
          trustBoundaries: [],
          destructiveActions: [],
          externalIntegrations: [],
          stopGo: "go"
        },
        status: "in_progress",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z"
      },
      tasks: [task],
      activeLocks: [],
      blockers: [],
      nextTaskIds: []
    };
  }

  const orchestratorApproval: ApprovalRecord = {
    id: "approval-1",
    runId: "run-test",
    taskId: "accepted-task",
    actor: "review-orchestrator",
    actorRole: "planner",
    source: "orchestrator",
    decision: "approved",
    rationale: "All gates passed",
    createdAt: "2026-07-01T00:00:00Z"
  };

  // Helper: make a clean passed review for a given role (no findings)
  function makeCleanReview(role: "reviewer" | "qa_engineer" | "security_reviewer"): ReviewRecord {
    return makeReview({
      runId: "run-test",
      taskId: "accepted-task",
      reviewerRole: role,
      actorRole: role,
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: [],
      findingDetails: undefined
    });
  }

  it("E1: proof result surfaces accepted findings from reviews with disposition=accepted", async () => {
    const acceptedFinding: ReviewFinding = {
      message: "mutation in recordReview",
      severity: "low",
      category: "immutability_violation",
      disposition: "accepted",
      acceptedByRole: "reviewer",
      acceptanceReason: "Pre-authorized: owner aware, follow-up ticket #123"
    };

    // Reviewer review has an accepted finding; qa and security are clean
    const reviewerReview: ReviewRecord = makeReview({
      runId: "run-test",
      taskId: "accepted-task",
      reviewerRole: "reviewer",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: [acceptedFinding.message],
      findingDetails: [acceptedFinding]
    });

    const result = await executeWorkflowProofCommandFromArgs(
      ["--run-id", "run-test", "--task-id", "accepted-task"],
      {
        getStatusSnapshot: async () => makeApprovedSnapshot("accepted-task"),
        getReviews: async () => [
          reviewerReview,
          makeCleanReview("qa_engineer"),
          makeCleanReview("security_reviewer")
        ],
        getApprovals: async () => [orchestratorApproval]
      }
    );

    assert.ok("acceptedFindings" in result, "WorkflowProofResult must have acceptedFindings field");
    const accepted = (result as WorkflowProofResult).acceptedFindings;
    assert.ok(Array.isArray(accepted), "acceptedFindings must be an array");
    assert.strictEqual(accepted.length, 1, "one accepted finding expected");
    const af = accepted[0]!;
    assert.strictEqual(af.message, "mutation in recordReview");
    assert.strictEqual(af.acceptedByRole, "reviewer");
    assert.strictEqual(af.acceptanceReason, "Pre-authorized: owner aware, follow-up ticket #123");
    assert.strictEqual(af.role, "reviewer");
    assert.strictEqual(af.severity, "low");
  });

  it("E2: proof result has empty acceptedFindings when all reviews have zero findings", async () => {
    const result = await executeWorkflowProofCommandFromArgs(
      ["--run-id", "run-test", "--task-id", "accepted-task"],
      {
        getStatusSnapshot: async () => makeApprovedSnapshot("accepted-task"),
        getReviews: async () => [
          makeCleanReview("reviewer"),
          makeCleanReview("qa_engineer"),
          makeCleanReview("security_reviewer")
        ],
        getApprovals: async () => [orchestratorApproval]
      }
    );

    assert.ok("acceptedFindings" in result, "WorkflowProofResult must have acceptedFindings field");
    const accepted = (result as WorkflowProofResult).acceptedFindings;
    assert.ok(Array.isArray(accepted), "acceptedFindings must be an array");
    assert.strictEqual(accepted.length, 0, "no accepted findings expected when reviews are clean");
  });
});

// ---------------------------------------------------------------------------
// F. Backward-compat — existing passing review scenarios are unchanged
// ---------------------------------------------------------------------------

describe("canReviewRecordSatisfyGate — backward compat (existing passing scenarios)", () => {

  it("F1: source != orchestrator → false (unchanged)", () => {
    const review = makeReview({ source: "seed", state: "passed", findings: [] });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  it("F2: empty actor → false (unchanged)", () => {
    const review = makeReview({ actor: "  ", state: "passed", findings: [] });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  it("F3: actorRole !== reviewerRole → false (unchanged)", () => {
    const review = makeReview({
      state: "passed",
      actorRole: "planner",
      reviewerRole: "reviewer",
      findings: []
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  it("F4: blocked state → false (unchanged)", () => {
    const review = makeReview({ state: "blocked", findings: ["open issue"] });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  it("F5: multiple fully accepted low/medium findings → gate satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["finding one", "finding two"],
      findingDetails: [
        {
          message: "finding one",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Tracked in follow-up #100"
        },
        {
          message: "finding two",
          severity: "medium",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Deliberate trade-off documented in decision log"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), true);
  });
});
