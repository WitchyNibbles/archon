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
import type { ResolveReviewActionContext } from "../src/core/review-context.ts";
import type {
  ReviewRecord,
  ReviewFinding,
  ReviewInput
} from "../src/domain/types.ts";
import {
  executeWorkflowProofCommandFromArgs,
  normalizeRecordReviewCommandInput,
  parseReviewFindingsJson,
  saveReviewCommand
} from "../src/review.ts";
import type { SaveReviewCommandDeps, WorkflowProofResult } from "../src/review.ts";
import type { ApprovalRecord, TaskRecord } from "../src/domain/types.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import { ArchonCoreService } from "../src/core/service.ts";

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

// ---------------------------------------------------------------------------
// A-prime. Gate edge cases added in gate-2 (Fix #7)
// ---------------------------------------------------------------------------

describe("canReviewRecordSatisfyGate — gate-2 edge cases", () => {

  // ── A15: A11-symmetric — MORE findingDetails than findings → NOT satisfied ─

  it("A15: passed + more findingDetails than findings (symmetric of A11) → gate NOT satisfied", () => {
    const review = makeReview({
      state: "passed",
      findings: ["finding A"],   // only one string finding
      findingDetails: [           // two detail records — length mismatch
        {
          message: "finding A",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Deliberate"
        },
        {
          message: "finding B",
          severity: "medium",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Also deliberate"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });

  // ── A16: findings:[] + accepted findingDetails → NOT satisfied (Fix #2) ──

  it("A16: passed + findings:[] + accepted findingDetails present → gate NOT satisfied (Fix #2)", () => {
    // Without Fix #2, canReviewRecordSatisfyGate skipped the acceptance check
    // because findings.length===0, so a review with accepted details but no
    // corresponding strings in findings[] would incorrectly pass the gate.
    const review = makeReview({
      state: "passed",
      findings: [],  // empty — but accepted details are present
      findingDetails: [
        {
          message: "silent accepted finding",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Tracked"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });
});

// ---------------------------------------------------------------------------
// B-double-prime. validateReviewAction — empty-findings + accepted details
// (Fix #2 mirror at the input layer)
// ---------------------------------------------------------------------------

describe("validateReviewAction — empty-findings with accepted details (Fix #2)", () => {
  const ctx = createTrustedReviewActionContextForTest({ actor: "review-orchestrator", actorRole: "reviewer" });

  it("Be1: state=passed, findings:[], accepted findingDetail → validation error (Fix #2)", () => {
    const errors = validateReviewAction(ctx, {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: [],     // empty — but an accepted detail is present
      findingDetails: [
        {
          message: "silent finding",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Trade-off"
        }
      ]
    } satisfies ReviewInput);
    assert.ok(errors.length > 0, "accepted finding without matching findings[] entry must be rejected");
    assert.ok(errors.some((e) => /findingDetails|accept/i.test(e)), errors.join(" | "));
  });
});

// ---------------------------------------------------------------------------
// C-prime. parseReviewFindingsJson — gate-2 additions (Fix #4, Fix #10)
// ---------------------------------------------------------------------------

describe("parseReviewFindingsJson — gate-2 additions", () => {

  // ── Fix #4: severity: null rejected (not silently cast) ─────────────────

  it("C11: severity: null → throws (not silently cast to null)", () => {
    const input = JSON.stringify([
      {
        message: "some finding",
        severity: null    // null — must be rejected, not cast
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /severity/i);
  });

  // ── Fix #10 siblings of C10 for empty-string and novel-string severity ──

  it("C12: severity: '' (empty string) → throws (not a valid ReviewSeverity)", () => {
    const input = JSON.stringify([
      {
        message: "some finding",
        severity: ""   // empty string — not a valid value
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /severity/i);
  });

  it("C13: severity: 'unknown' (unrecognised string) → throws", () => {
    const input = JSON.stringify([
      {
        message: "some finding",
        severity: "unknown"   // not in ReviewSeverity enum
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /severity/i);
  });

  // ── Fix #3: acceptedByRole must be a known agent role ───────────────────

  it("C14: acceptedByRole with freeform string → throws (Fix #3)", () => {
    const input = JSON.stringify([
      {
        message: "some finding",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "my-custom-role",   // not a known agent role
        acceptanceReason: "Trade-off"
      }
    ]);
    assert.throws(() => parseReviewFindingsJson(input), /acceptedByRole|gate review role/i);
  });

  it("C15: acceptedByRole = 'reviewer' (known role) → parses cleanly", () => {
    const input = JSON.stringify([
      {
        message: "some finding",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "reviewer",   // known gate role
        acceptanceReason: "Deliberate trade-off"
      }
    ]);
    const result = parseReviewFindingsJson(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.acceptedByRole, "reviewer");
  });
});

// ---------------------------------------------------------------------------
// G. saveReviewCommand — multi-finding CLI path (Fix #1)
// ---------------------------------------------------------------------------

describe("saveReviewCommand — multi-finding findings stored as string[] (Fix #1)", () => {

  it("G1: N=2 accepted findings stored as 2-element string[], not 1 joined string", async () => {
    const findingsJson = JSON.stringify([
      {
        message: "finding one",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Tracked in follow-up"
      },
      {
        message: "finding two",
        severity: "medium",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Deliberate trade-off"
      }
    ]);

    type CapturedInput = { findings: readonly string[]; findingDetails?: readonly ReviewFinding[] | undefined };
    let capturedInput: CapturedInput | null = null;

    const withClientFn: SaveReviewCommandDeps["withClientFn"] = async (fn) => {
      const fakeStore = {
        getProjectRuntimeState: async (_projectId: string) => undefined,
        saveOrchestratorReview: async (input: {
          taskId: string;
          role: string;
          outcome: string;
          findings: readonly string[];
          workspaceId: string;
          projectId: string;
          runId?: string | null | undefined;
          findingDetails?: readonly ReviewFinding[] | undefined;
        }) => {
          capturedInput = { findings: input.findings, findingDetails: input.findingDetails };
        }
      };
      return fn(fakeStore as Parameters<typeof fn>[0]);
    };

    await saveReviewCommand(
      [
        "--task-id", "task-g1",
        "--role", "reviewer",
        "--outcome", "passed",
        "--findings-json", findingsJson
      ],
      {
        env: { ARCHON_WORKSPACE_SLUG: "ws-test", ARCHON_PROJECT_SLUG: "proj-test" },
        withClientFn
      }
    );

    assert.ok(capturedInput !== null, "saveOrchestratorReview must have been called");
    const captured = capturedInput as CapturedInput;
    assert.strictEqual(captured.findings.length, 2, "2 findings stored as 2 elements, not 1 joined string");
    assert.deepEqual([...captured.findings], ["finding one", "finding two"]);

    // Reconstruct a ReviewRecord from the captured data and verify gate satisfaction
    const reviewRecord: ReviewRecord = makeReview({
      state: "passed",
      source: "orchestrator",
      actor: "review-orchestrator",
      actorRole: "reviewer",
      reviewerRole: "reviewer",
      findings: [...captured.findings],
      findingDetails: captured.findingDetails
    });
    assert.strictEqual(
      canReviewRecordSatisfyGate(reviewRecord), true,
      "stored multi-finding record must satisfy the gate"
    );
  });
});

// ---------------------------------------------------------------------------
// H. normalizeRecordReviewCommandInput — Fix #8
// ---------------------------------------------------------------------------

describe("normalizeRecordReviewCommandInput — findingDetails guard (Fix #8)", () => {

  it("H1: input with findingDetails in review → throws explicit error", () => {
    const input = JSON.stringify({
      runId: "run-h1",
      taskId: "task-h1",
      actor: "reviewer-actor",
      review: {
        reviewerRole: "reviewer",
        state: "passed",
        severity: "low",
        findings: [],
        findingDetails: [{ message: "some finding", severity: "low" }]
      }
    });
    assert.throws(
      () => normalizeRecordReviewCommandInput(input),
      /findingDetails|save-review/i
    );
  });
});

// ---------------------------------------------------------------------------
// E-prime. executeWorkflowProofCommandFromArgs — Fix #9
// ---------------------------------------------------------------------------

describe("executeWorkflowProofCommandFromArgs — acceptedFindings surface (Fix #9)", () => {

  // Reuse makeApprovedSnapshot from the E section above — declared at module scope.
  // The helper is defined in the E describe block but is a plain function — we
  // duplicate a minimal version here so this section is self-contained.

  function makeSnapshot9(taskId: string): import("../src/domain/types.ts").RunStatusSnapshot {
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
    const task: TaskRecord = {
      id: "task-db-id",
      runId: "run-fix9",
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
        id: "run-fix9",
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

  const fix9Approval: ApprovalRecord = {
    id: "approval-fix9",
    runId: "run-fix9",
    taskId: "task-fix9",
    actor: "review-orchestrator",
    actorRole: "planner",
    source: "orchestrator",
    decision: "approved",
    rationale: "All gates passed",
    createdAt: "2026-07-01T00:00:00Z"
  };

  it("E3: reviewer with accepted finding appears; clean-pass reviews (findings:[]) contribute nothing — Fix #9 findings.length>0 filter", async () => {
    // This test proves Fix #9's pre-filter: only reviews where findings.length>0
    // contribute to acceptedFindings. A clean-pass review (findings:[]) with no
    // findingDetails produces nothing regardless.
    const reviewerWithAccepted: ReviewRecord = makeReview({
      runId: "run-fix9",
      taskId: "task-fix9",
      reviewerRole: "reviewer",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: ["doc nit"],
      findingDetails: [
        {
          message: "doc nit",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Minor doc gap; tracked externally"
        }
      ]
    });
    // qa and security are clean-pass (findings:[]) — Fix #9 pre-filter excludes them
    const cleanQa: ReviewRecord = makeReview({
      runId: "run-fix9",
      taskId: "task-fix9",
      reviewerRole: "qa_engineer",
      actorRole: "qa_engineer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: [],
      findingDetails: undefined
    });
    const cleanSecurity: ReviewRecord = makeReview({
      runId: "run-fix9",
      taskId: "task-fix9",
      reviewerRole: "security_reviewer",
      actorRole: "security_reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: [],
      findingDetails: undefined
    });

    const result = await executeWorkflowProofCommandFromArgs(
      ["--run-id", "run-fix9", "--task-id", "task-fix9"],
      {
        getStatusSnapshot: async () => makeSnapshot9("task-fix9"),
        getReviews: async () => [reviewerWithAccepted, cleanQa, cleanSecurity],
        getApprovals: async () => [fix9Approval]
      }
    );

    const accepted = (result as WorkflowProofResult).acceptedFindings;
    assert.ok(Array.isArray(accepted), "acceptedFindings must be an array");
    assert.strictEqual(accepted.length, 1,
      "exactly 1 accepted finding from reviewer; clean-pass qa+security contribute nothing"
    );
    assert.strictEqual(accepted[0]!.role, "reviewer");
    assert.strictEqual(accepted[0]!.message, "doc nit");
  });

  it("E4: multi-role passed reviews each contribute accepted findings to the surface", async () => {
    // Three reviews — reviewer and qa each have one accepted finding; security is clean.
    // This proves the flatMap covers multiple roles.
    const reviewerReview: ReviewRecord = makeReview({
      runId: "run-fix9",
      taskId: "task-fix9",
      reviewerRole: "reviewer",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: ["reviewer finding"],
      findingDetails: [
        {
          message: "reviewer finding",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Tracked externally"
        }
      ]
    });
    const qaReview: ReviewRecord = makeReview({
      runId: "run-fix9",
      taskId: "task-fix9",
      reviewerRole: "qa_engineer",
      actorRole: "qa_engineer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: ["qa finding"],
      findingDetails: [
        {
          message: "qa finding",
          severity: "medium",
          disposition: "accepted",
          acceptedByRole: "qa_engineer",
          acceptanceReason: "Deliberate"
        }
      ]
    });
    const secReview: ReviewRecord = makeReview({
      runId: "run-fix9",
      taskId: "task-fix9",
      reviewerRole: "security_reviewer",
      actorRole: "security_reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: [],
      findingDetails: undefined
    });

    const result = await executeWorkflowProofCommandFromArgs(
      ["--run-id", "run-fix9", "--task-id", "task-fix9"],
      {
        getStatusSnapshot: async () => makeSnapshot9("task-fix9"),
        getReviews: async () => [reviewerReview, qaReview, secReview],
        getApprovals: async () => [fix9Approval]
      }
    );

    const accepted = (result as WorkflowProofResult).acceptedFindings;
    assert.ok(Array.isArray(accepted), "acceptedFindings must be an array");
    assert.strictEqual(accepted.length, 2, "two accepted findings from reviewer and qa_engineer");
    assert.ok(accepted.some((f) => f.role === "reviewer" && f.message === "reviewer finding"), "reviewer finding present");
    assert.ok(accepted.some((f) => f.role === "qa_engineer" && f.message === "qa finding"), "qa finding present");
  });
});

// ---------------------------------------------------------------------------
// I. ArchonCoreService.recordReview — findings derivation from accepted
//    findingDetails (Fix #5 — service-level shouldDeriveFromDetails)
// ---------------------------------------------------------------------------

describe("ArchonCoreService.recordReview — findings derivation from accepted findingDetails (Fix #5)", () => {

  function makeTrustedResolver(): ResolveReviewActionContext {
    return async (_input) =>
      createTrustedReviewActionContextForTest({ actor: "review-orchestrator", actorRole: "reviewer" });
  }

  async function buildReviewBlockedTask(service: InstanceType<typeof ArchonCoreService>) {
    const run = await service.intakeRequest({
      workspaceSlug: "test-ws",
      projectSlug: "test-proj",
      actor: "manager",
      title: "Derivation test run",
      request: "test"
    });

    const taskId = "derivation-test-task";
    await service.createTaskGraph(run.id, [
      {
        taskId,
        title: "Derivation test task",
        ownerRole: "backend_engineer",
        completionStandard: "artifact_complete",
        requiredSpecialistRoles: ["backend_engineer"],
        qualityGates: ["product_acceptance"],
        goal: "Validate findingDetails-to-findings derivation",
        inputs: ["task description"],
        outputs: ["stored review"],
        dependencies: [],
        allowedWriteScope: ["src/"],
        outOfScope: ["unrelated concerns"],
        acceptanceCriteria: ["stored findings derived from findingDetails"],
        verificationSteps: ["assert findings equals findingDetails.map(f=>f.message)"],
        securityChecks: ["no secrets in findings"],
        antiPatterns: ["divergent findings and findingDetails"],
        rollbackNotes: "no rollback needed",
        handoffFormat: "summary only",
        requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"]
      }
    ]);

    await service.claimTask(run.id, taskId, "backend-agent");
    await service.submitHandoff(run.id, taskId, {
      actor: "backend-agent",
      ownerRole: "backend_engineer",
      completionStandard: "artifact_complete",
      summary: "Implementation complete.",
      changedFiles: ["src/core/service.ts"],
      blockers: [],
      verificationNotes: ["all tests pass"],
      executionEvidence: ["ran node --test"],
      qualityGateEvidence: ["product acceptance: derivation logic verified"],
      contextRefs: ["tests/finding-acceptance-records.test.ts"]
    });

    return { runId: run.id, taskId };
  }

  it("I1: recordReview with accepted findingDetails + different caller findings[] → stored findings = findingDetails.map(f=>f.message)", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store, {
      reviewSource: "orchestrator",
      resolveReviewActionContext: makeTrustedResolver()
    });

    const { runId, taskId } = await buildReviewBlockedTask(service);

    const findingDetails: ReviewFinding[] = [
      {
        message: "accepted finding from detail A",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Deliberate trade-off; tracked in issue #500"
      },
      {
        message: "accepted finding from detail B",
        severity: "medium",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Out of scope for this task; owner aware"
      }
    ];

    // Caller passes stale/different findings[] — derivation must override with
    // findingDetails.map(f=>f.message) so the stored record is canonical.
    await service.recordReview(runId, taskId, "reviewer-actor", {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: ["stale finding A", "stale finding B"],  // will be overridden
      findingDetails
    });

    const reviews = await store.getReviews(runId, taskId);
    const stored = reviews.find((r) => r.reviewerRole === "reviewer");
    assert.ok(stored !== undefined, "reviewer review must be stored");
    assert.deepEqual(
      stored.findings,
      findingDetails.map((f) => f.message),
      "stored findings must be derived from findingDetails.map(f=>f.message), not the caller's stale array"
    );
    assert.strictEqual(canReviewRecordSatisfyGate(stored), true,
      "derived findings must satisfy the gate"
    );
  });
});

// ---------------------------------------------------------------------------
// Gate-3 Fix #2 — acceptance authority restricted to gate review roles
// ---------------------------------------------------------------------------

describe("Gate-3 Fix #2 — acceptedByRole restricted to gate review roles", () => {
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

  // Fix 4: direct test — validateReviewAction rejects non-gate acceptedByRole
  it("Bd6: validateReviewAction rejects non-gate acceptedByRole 'my-custom-role'", () => {
    const errors = validateReviewAction(ctx, makeInput([
      {
        message: "some finding",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "my-custom-role",
        acceptanceReason: "Deliberate"
      }
    ]));
    assert.ok(
      errors.some((e) => /acceptedByRole|gate review role/i.test(e)),
      `expected error mentioning acceptedByRole or gate review role, got: ${errors.join(" | ")}`
    );
  });

  // Fix 4 (continued): memory_curator is a retrieval role, not a gate role — must be rejected
  it("Bd7: validateReviewAction rejects 'memory_curator' as acceptedByRole (retrieval role, not gate role)", () => {
    const errors = validateReviewAction(ctx, makeInput([
      {
        message: "some finding",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "memory_curator",
        acceptanceReason: "Deliberate"
      }
    ]));
    assert.ok(
      errors.some((e) => /acceptedByRole|gate review role/i.test(e)),
      `memory_curator must be rejected — not a gate review role; errors: ${errors.join(" | ")}`
    );
  });

  // Fix 5: direct test — checkFindingsAreFullyAccepted (via canReviewRecordSatisfyGate)
  // returns false for non-gate acceptedByRole
  it("A17: canReviewRecordSatisfyGate returns false when acceptedByRole is non-gate role 'memory_curator'", () => {
    const review = makeReview({
      state: "passed",
      findings: ["some finding"],
      findingDetails: [
        {
          message: "some finding",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "memory_curator",  // retrieval role, NOT a gate review role
          acceptanceReason: "Deliberate trade-off"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false,
      "memory_curator is a retrieval role, not a gate review role — must be rejected"
    );
  });

  // C16: parseReviewFindingsJson rejects 'memory_curator' acceptedByRole at parse time
  it("C16: parseReviewFindingsJson rejects 'memory_curator' acceptedByRole (not a gate review role)", () => {
    const input = JSON.stringify([
      {
        message: "some finding",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "memory_curator",
        acceptanceReason: "Trade-off"
      }
    ]);
    assert.throws(
      () => parseReviewFindingsJson(input),
      /acceptedByRole|gate review role/i
    );
  });
});

// ---------------------------------------------------------------------------
// Gate-3 Fix #3 — empty message guard
// ---------------------------------------------------------------------------

describe("Gate-3 Fix #3 — empty message is rejected", () => {

  // parseReviewFindingsJson rejects empty message
  it("C17: parseReviewFindingsJson rejects empty message string", () => {
    const input = JSON.stringify([
      {
        message: "",
        severity: "low"
      }
    ]);
    assert.throws(
      () => parseReviewFindingsJson(input),
      /message.*empty|empty.*message/i
    );
  });

  it("C18: parseReviewFindingsJson rejects whitespace-only message", () => {
    const input = JSON.stringify([
      {
        message: "   ",
        severity: "low"
      }
    ]);
    assert.throws(
      () => parseReviewFindingsJson(input),
      /message.*empty|empty.*message/i
    );
  });

  // checkFindingsAreFullyAccepted (via gate) rejects empty message on accepted findings
  it("A18: canReviewRecordSatisfyGate returns false for accepted finding with empty message", () => {
    const review = makeReview({
      state: "passed",
      findings: [""],
      findingDetails: [
        {
          message: "",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Trade-off"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false,
      "accepted finding with empty message must be rejected by the gate"
    );
  });

  it("A19: canReviewRecordSatisfyGate returns false for accepted finding with whitespace-only message", () => {
    const review = makeReview({
      state: "passed",
      findings: ["   "],
      findingDetails: [
        {
          message: "   ",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Trade-off"
        }
      ]
    });
    assert.strictEqual(canReviewRecordSatisfyGate(review), false,
      "accepted finding with whitespace-only message must be rejected by the gate"
    );
  });
});

// ---------------------------------------------------------------------------
// Gate-3 Fix #6 — G2: N=3 multi-finding CLI save test
// ---------------------------------------------------------------------------

describe("saveReviewCommand — N=3 multi-finding (Gate-3 Fix #6, G-suite extension)", () => {

  it("G2: N=3 accepted findings stored as 3-element string[], gate satisfied", async () => {
    const findingsJson = JSON.stringify([
      {
        message: "finding alpha",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Tracked in follow-up A"
      },
      {
        message: "finding beta",
        severity: "medium",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Deliberate trade-off B"
      },
      {
        message: "finding gamma",
        severity: "low",
        disposition: "accepted",
        acceptedByRole: "reviewer",
        acceptanceReason: "Owner aware, issue #300"
      }
    ]);

    type CapturedInput = { findings: readonly string[]; findingDetails?: readonly ReviewFinding[] | undefined };
    let capturedInput: CapturedInput | null = null;

    const withClientFn: SaveReviewCommandDeps["withClientFn"] = async (fn) => {
      const fakeStore = {
        getProjectRuntimeState: async (_projectId: string) => undefined,
        saveOrchestratorReview: async (input: {
          taskId: string;
          role: string;
          outcome: string;
          findings: readonly string[];
          workspaceId: string;
          projectId: string;
          runId?: string | null | undefined;
          findingDetails?: readonly ReviewFinding[] | undefined;
        }) => {
          capturedInput = { findings: input.findings, findingDetails: input.findingDetails };
        }
      };
      return fn(fakeStore as Parameters<typeof fn>[0]);
    };

    await saveReviewCommand(
      [
        "--task-id", "task-g2",
        "--role", "reviewer",
        "--outcome", "passed",
        "--findings-json", findingsJson
      ],
      {
        env: { ARCHON_WORKSPACE_SLUG: "ws-test", ARCHON_PROJECT_SLUG: "proj-test" },
        withClientFn
      }
    );

    assert.ok(capturedInput !== null, "saveOrchestratorReview must have been called");
    const captured = capturedInput as CapturedInput;
    assert.strictEqual(captured.findings.length, 3, "3 findings stored as 3 separate elements");
    assert.deepEqual([...captured.findings], ["finding alpha", "finding beta", "finding gamma"]);

    const reviewRecord: ReviewRecord = makeReview({
      state: "passed",
      source: "orchestrator",
      actor: "review-orchestrator",
      actorRole: "reviewer",
      reviewerRole: "reviewer",
      findings: [...captured.findings],
      findingDetails: captured.findingDetails
    });
    assert.strictEqual(
      canReviewRecordSatisfyGate(reviewRecord), true,
      "stored N=3 multi-finding record must satisfy the gate"
    );
  });
});

// ---------------------------------------------------------------------------
// Gate-3 Fix #6 — H2: findingDetails: null in normalizeRecordReviewCommandInput
// ---------------------------------------------------------------------------

describe("normalizeRecordReviewCommandInput — findingDetails: null guard (Gate-3 Fix #6, H-suite)", () => {

  it("H2: input with findingDetails: null → throws (null also blocked)", () => {
    const input = JSON.stringify({
      runId: "run-h2",
      taskId: "task-h2",
      actor: "reviewer-actor",
      review: {
        reviewerRole: "reviewer",
        state: "passed",
        severity: "low",
        findings: [],
        findingDetails: null   // null is not undefined — must also be blocked
      }
    });
    assert.throws(
      () => normalizeRecordReviewCommandInput(input),
      /findingDetails|save-review/i
    );
  });
});

// ---------------------------------------------------------------------------
// Gate-3 Fix #6 — E5: three-role aggregate acceptedFindings surface test
// ---------------------------------------------------------------------------

describe("executeWorkflowProofCommandFromArgs — three-role aggregate (Gate-3 Fix #6, E-suite)", () => {

  function makeSnapshot3Role(taskId: string): import("../src/domain/types.ts").RunStatusSnapshot {
    const packet: import("../src/domain/types.ts").TaskPacketInput = {
      taskId,
      title: "Three-role aggregate test task",
      ownerRole: "backend_engineer",
      completionStandard: "specialist_verified",
      requiredSpecialistRoles: [],
      qualityGates: [],
      goal: "test three-role aggregate",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope: ["src/"],
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"],
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: "standard"
    };
    const task: import("../src/domain/types.ts").TaskRecord = {
      id: "task-db-e5",
      runId: "run-e5",
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
        id: "run-e5",
        workspaceId: "ws-1",
        projectId: "proj-1",
        actor: "review-orchestrator",
        title: "Three-role aggregate test run",
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

  const e5Approval: ApprovalRecord = {
    id: "approval-e5",
    runId: "run-e5",
    taskId: "e5-task",
    actor: "review-orchestrator",
    actorRole: "planner",
    source: "orchestrator",
    decision: "approved",
    rationale: "All gates passed",
    createdAt: "2026-07-01T00:00:00Z"
  };

  it("E5: reviewer + qa_engineer + security_reviewer each contribute one accepted finding → 3 in acceptedFindings", async () => {
    const reviewerReview: ReviewRecord = makeReview({
      runId: "run-e5",
      taskId: "e5-task",
      reviewerRole: "reviewer",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: ["reviewer finding"],
      findingDetails: [
        {
          message: "reviewer finding",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "reviewer",
          acceptanceReason: "Deliberate: tracked in #101"
        }
      ]
    });
    const qaReview: ReviewRecord = makeReview({
      runId: "run-e5",
      taskId: "e5-task",
      reviewerRole: "qa_engineer",
      actorRole: "qa_engineer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: ["qa finding"],
      findingDetails: [
        {
          message: "qa finding",
          severity: "medium",
          disposition: "accepted",
          acceptedByRole: "qa_engineer",
          acceptanceReason: "Deliberate: owner aware"
        }
      ]
    });
    const secReview: ReviewRecord = makeReview({
      runId: "run-e5",
      taskId: "e5-task",
      reviewerRole: "security_reviewer",
      actorRole: "security_reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: ["security finding"],
      findingDetails: [
        {
          message: "security finding",
          severity: "low",
          disposition: "accepted",
          acceptedByRole: "security_reviewer",
          acceptanceReason: "Mitigated at gateway layer"
        }
      ]
    });

    const result = await executeWorkflowProofCommandFromArgs(
      ["--run-id", "run-e5", "--task-id", "e5-task"],
      {
        getStatusSnapshot: async () => makeSnapshot3Role("e5-task"),
        getReviews: async () => [reviewerReview, qaReview, secReview],
        getApprovals: async () => [e5Approval]
      }
    );

    const accepted = (result as WorkflowProofResult).acceptedFindings;
    assert.ok(Array.isArray(accepted), "acceptedFindings must be an array");
    assert.strictEqual(accepted.length, 3, "one accepted finding from each of the three roles");
    assert.ok(accepted.some((f) => f.role === "reviewer" && f.message === "reviewer finding"), "reviewer finding present");
    assert.ok(accepted.some((f) => f.role === "qa_engineer" && f.message === "qa finding"), "qa_engineer finding present");
    assert.ok(accepted.some((f) => f.role === "security_reviewer" && f.message === "security finding"), "security_reviewer finding present");
  });
});
