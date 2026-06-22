// MPL P2: distillation + hybrid-C gated anti-pattern promotion tests.
//
// TDD: these tests must fail before implementation, pass after.
//
// Node built-in test runner only — no vitest.
//
// Council conditions under test:
//   1. P0 trust gate NOT regressed — promoteMemory still requires sealed context.
//   2. anti_pattern role-gate — only reviewer/security_reviewer actorRole allowed.
//   3. Recurrence ≥ 2 DISTINCT runs before distillation eligibility.
//   4. Classifier integrity / hybrid-C — autonomous for allowlisted, draft-only for rest.
//   5. Migration 025 — tested via MemoryType type: "anti_pattern" accepted everywhere.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUTONOMOUS_PROMOTION_ALLOWLIST,
  selectDistillationCandidates,
  buildAntiPatternContent,
  type AntiPatternDraft
} from "../src/runtime/mistake-ledger.ts";
import {
  computeFingerprint,
  type MistakeOccurrenceRecord
} from "../src/runtime/mistake-ledger.ts";
import { MemoryAntiPatternDraftStore } from "../src/store/memory-store.ts";
import {
  validateMemoryPromotion
} from "../src/domain/contracts.ts";
import { memoryTypes } from "../src/domain/types.ts";
import { createTrustedReviewActionContextForTest, isTrustedReviewActionContext } from "../src/core/review-context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOccurrence(
  overrides: Partial<MistakeOccurrenceRecord> = {}
): MistakeOccurrenceRecord {
  const category = overrides.category ?? "immutability_violation";
  const ruleLocus = overrides.ruleLocus ?? "coding-style#immutability";
  const fp = computeFingerprint(category, ruleLocus, overrides.symbolLocus);
  return {
    id: `occ-${Math.random().toString(36).slice(2)}`,
    fingerprint: fp,
    category,
    ruleLocus,
    symbolLocus: undefined,
    pathLocus: undefined,
    rawFinding: "mutated object in place",
    severity: "medium",
    reviewerRole: "reviewer",
    runId: "run-1",
    taskId: "task-1",
    capturedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function makeNodeNextOccurrence(runId: string): MistakeOccurrenceRecord {
  return makeOccurrence({
    category: "nodenext_extension_missing",
    ruleLocus: "typescript.md#module-system",
    rawFinding: "import lacks .ts extension",
    runId
  });
}

function makeImmutabilityOccurrence(runId: string): MistakeOccurrenceRecord {
  return makeOccurrence({
    category: "immutability_violation",
    ruleLocus: "coding-style#immutability",
    rawFinding: "mutated object in place",
    runId
  });
}

// ---------------------------------------------------------------------------
// Council condition 5: "anti_pattern" in memoryTypes
// ---------------------------------------------------------------------------

describe("memoryTypes — anti_pattern included (migration 025 domain side)", () => {
  it("memoryTypes array contains anti_pattern", () => {
    assert.ok(
      (memoryTypes as readonly string[]).includes("anti_pattern"),
      `memoryTypes should include "anti_pattern" but got: ${JSON.stringify(memoryTypes)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Council condition 3: recurrence ≥ 2 distinct runs
// ---------------------------------------------------------------------------

describe("selectDistillationCandidates — recurrence threshold", () => {
  it("returns empty when no occurrences", () => {
    const result = selectDistillationCandidates([]);
    assert.deepEqual(result, []);
  });

  it("excludes fingerprint seen in only 1 run (single occurrence)", () => {
    const occurrences = [makeImmutabilityOccurrence("run-A")];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 0, "single-run fingerprint must not distill");
  });

  it("excludes fingerprint with multiple occurrences in the SAME run", () => {
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-A"), // same run — does NOT count
      makeImmutabilityOccurrence("run-A")
    ];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 0, "same-run repeats must not qualify as recurrent");
  });

  it("includes fingerprint seen in ≥ 2 distinct runs", () => {
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-B") // different run — qualifies
    ];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 1, "fingerprint in 2 distinct runs must distill");
  });

  it("includes fingerprint seen in 3 distinct runs (still qualifies)", () => {
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-B"),
      makeImmutabilityOccurrence("run-C")
    ];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.distinctRunCount, 3);
  });

  it("handles multiple distinct fingerprints, only qualifying ones returned", () => {
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-B"), // qualifies
      makeNodeNextOccurrence("run-A") // only 1 run — excluded
    ];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.category, "immutability_violation");
  });

  it("promotes occurrences from the same run only once per run per fingerprint", () => {
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-A"), // dupe in same run — run-A counted once
      makeImmutabilityOccurrence("run-B")  // run-B: qualifies with 2 distinct
    ];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.distinctRunCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Council condition 4: hybrid-C allowlist classification
// ---------------------------------------------------------------------------

describe("selectDistillationCandidates — hybrid-C classification", () => {
  it("AUTONOMOUS_PROMOTION_ALLOWLIST contains exactly nodenext_extension_missing", () => {
    assert.ok(
      Array.isArray(AUTONOMOUS_PROMOTION_ALLOWLIST),
      "must be an array"
    );
    assert.deepEqual(
      [...AUTONOMOUS_PROMOTION_ALLOWLIST].sort(),
      ["nodenext_extension_missing"],
      "allowlist must contain exactly nodenext_extension_missing"
    );
  });

  it("classifies nodenext_extension_missing as autonomous", () => {
    const occurrences = [
      makeNodeNextOccurrence("run-A"),
      makeNodeNextOccurrence("run-B")
    ];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.promotionPath, "autonomous");
  });

  it("classifies immutability_violation as review_required (not in allowlist)", () => {
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-B")
    ];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.promotionPath, "review_required");
  });

  it("classifies sql_injection as review_required (not in allowlist)", () => {
    const occ1 = makeOccurrence({
      category: "sql_injection",
      ruleLocus: "security#sql-injection-prevention",
      runId: "run-A"
    });
    const occ2 = makeOccurrence({
      category: "sql_injection",
      ruleLocus: "security#sql-injection-prevention",
      runId: "run-B"
    });
    const result = selectDistillationCandidates([occ1, occ2]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.promotionPath, "review_required");
  });

  it("mixes autonomous and review_required candidates correctly", () => {
    const occurrences = [
      makeNodeNextOccurrence("run-A"),
      makeNodeNextOccurrence("run-B"),    // autonomous
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-B") // review_required
    ];
    const result = selectDistillationCandidates(occurrences);
    assert.strictEqual(result.length, 2);
    const autonomous = result.filter((c) => c.promotionPath === "autonomous");
    const reviewRequired = result.filter((c) => c.promotionPath === "review_required");
    assert.strictEqual(autonomous.length, 1);
    assert.strictEqual(autonomous[0]!.category, "nodenext_extension_missing");
    assert.strictEqual(reviewRequired.length, 1);
    assert.strictEqual(reviewRequired[0]!.category, "immutability_violation");
  });
});

// ---------------------------------------------------------------------------
// buildAntiPatternContent — content builder
// ---------------------------------------------------------------------------

describe("buildAntiPatternContent — anti-pattern entry content builder", () => {
  it("includes category and ruleLocus in content", () => {
    const occurrences = [
      makeNodeNextOccurrence("run-A"),
      makeNodeNextOccurrence("run-B")
    ];
    const [candidate] = selectDistillationCandidates(occurrences);
    assert.ok(candidate);
    const content = buildAntiPatternContent(candidate);
    assert.ok(content.includes("nodenext_extension_missing"), "must include category");
    assert.ok(content.includes("typescript.md#module-system"), "must include ruleLocus");
  });

  it("includes distinct run count in content", () => {
    const occurrences = [
      makeNodeNextOccurrence("run-A"),
      makeNodeNextOccurrence("run-B"),
      makeNodeNextOccurrence("run-C")
    ];
    const [candidate] = selectDistillationCandidates(occurrences);
    assert.ok(candidate);
    const content = buildAntiPatternContent(candidate);
    assert.ok(content.includes("3"), "must include distinct run count");
  });

  it("includes 'how to detect before acting' guidance", () => {
    const occurrences = [
      makeNodeNextOccurrence("run-A"),
      makeNodeNextOccurrence("run-B")
    ];
    const [candidate] = selectDistillationCandidates(occurrences);
    assert.ok(candidate);
    const content = buildAntiPatternContent(candidate);
    assert.ok(
      content.toLowerCase().includes("detect") || content.toLowerCase().includes("prevention"),
      "content must include detection/prevention guidance"
    );
  });
});

// ---------------------------------------------------------------------------
// Council condition 2: anti_pattern role-gate in validateMemoryPromotion
// ---------------------------------------------------------------------------

describe("validateMemoryPromotion — anti_pattern role-gate", () => {
  const baseInput = {
    scope: "project" as const,
    entryType: "anti_pattern" as const,
    title: "Test anti-pattern",
    content: "anti-pattern content without secrets",
    sourceRunId: "run-1",
    reviewer: "orchestrator",
    actor: "orchestrator"
  };

  it("rejects anti_pattern promotion with non-review actorRole (engineer)", () => {
    const errors = validateMemoryPromotion({
      ...baseInput,
      actorRole: "backend_engineer"
    });
    assert.ok(
      errors.some((e) => e.includes("actorRole") || e.includes("role")),
      `expected role-gate error for backend_engineer, got: ${JSON.stringify(errors)}`
    );
  });

  it("rejects anti_pattern promotion with no actorRole", () => {
    const errors = validateMemoryPromotion({
      ...baseInput
      // actorRole absent
    });
    assert.ok(
      errors.some((e) => e.includes("actorRole") || e.includes("role")),
      `expected role-gate error when actorRole absent, got: ${JSON.stringify(errors)}`
    );
  });

  it("accepts anti_pattern promotion with actorRole=reviewer", () => {
    const errors = validateMemoryPromotion({
      ...baseInput,
      actorRole: "reviewer"
    });
    const roleErrors = errors.filter((e) => e.includes("actorRole") || e.includes("role"));
    assert.strictEqual(roleErrors.length, 0, `unexpected role error for reviewer: ${JSON.stringify(errors)}`);
  });

  it("accepts anti_pattern promotion with actorRole=security_reviewer", () => {
    const errors = validateMemoryPromotion({
      ...baseInput,
      actorRole: "security_reviewer"
    });
    const roleErrors = errors.filter((e) => e.includes("actorRole") || e.includes("role"));
    assert.strictEqual(roleErrors.length, 0, `unexpected role error for security_reviewer: ${JSON.stringify(errors)}`);
  });

  it("fact/pattern entryType does not require actorRole", () => {
    // Non-anti_pattern types should not be gated on actorRole
    const factErrors = validateMemoryPromotion({
      scope: "project" as const,
      entryType: "fact" as const,
      title: "fact entry",
      content: "some fact content",
      sourceRunId: "run-1",
      reviewer: "orchestrator",
      actor: "orchestrator"
      // no actorRole
    });
    const roleErrors = factErrors.filter((e) => e.includes("actorRole") || e.includes("role"));
    assert.strictEqual(roleErrors.length, 0, "fact type should not require actorRole");
  });
});

// ---------------------------------------------------------------------------
// Council condition 1: P0 trust gate — promoteMemory still requires sealed context
// Autonomous promotion path uses service.promoteMemory which goes through the resolver.
// This test verifies the trust predicate itself (existing P0 gate — not regressed).
// ---------------------------------------------------------------------------

describe("isTrustedReviewActionContext — P0 trust gate not regressed", () => {
  it("rejects a plain object (not registered in WeakSet)", () => {
    const plainCtx = { actor: "bad-actor", actorRole: "reviewer" };
    assert.strictEqual(
      isTrustedReviewActionContext(plainCtx as Parameters<typeof isTrustedReviewActionContext>[0]),
      false,
      "plain object must not pass trust gate"
    );
  });

  it("accepts a WeakSet-registered context created via ForTest", () => {
    const ctx = createTrustedReviewActionContextForTest({
      actor: "test-actor",
      actorRole: "reviewer"
    });
    assert.strictEqual(
      isTrustedReviewActionContext(ctx),
      true,
      "ForTest context must pass trust gate (WeakSet registered)"
    );
  });
});

// ---------------------------------------------------------------------------
// MemoryAntiPatternDraftStore — in-memory draft store
// ---------------------------------------------------------------------------

describe("MemoryAntiPatternDraftStore — draft candidate persistence", () => {
  it("starts empty", async () => {
    const store = new MemoryAntiPatternDraftStore();
    const drafts = await store.listAntiPatternDrafts("proj-1");
    assert.deepEqual(drafts, []);
  });

  it("appends and lists drafts for a project", async () => {
    const store = new MemoryAntiPatternDraftStore();
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-B")
    ];
    const [candidate] = selectDistillationCandidates(occurrences);
    assert.ok(candidate);

    const draft: AntiPatternDraft = {
      id: "draft-1",
      projectId: "proj-1",
      fingerprint: candidate.fingerprint,
      category: candidate.category,
      ruleLocus: candidate.ruleLocus,
      distinctRunCount: candidate.distinctRunCount,
      promotionPath: candidate.promotionPath,
      content: buildAntiPatternContent(candidate),
      status: "pending",
      createdAt: "2026-01-01T00:00:00Z"
    };

    await store.appendAntiPatternDraft("proj-1", draft);
    const drafts = await store.listAntiPatternDrafts("proj-1");
    assert.strictEqual(drafts.length, 1);
    assert.strictEqual(drafts[0]!.fingerprint, candidate.fingerprint);
    assert.strictEqual(drafts[0]!.status, "pending");
  });

  it("is idempotent by draft id (upsert semantics)", async () => {
    const store = new MemoryAntiPatternDraftStore();
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-B")
    ];
    const [candidate] = selectDistillationCandidates(occurrences);
    assert.ok(candidate);

    const draft: AntiPatternDraft = {
      id: "draft-dedup",
      projectId: "proj-1",
      fingerprint: candidate.fingerprint,
      category: candidate.category,
      ruleLocus: candidate.ruleLocus,
      distinctRunCount: candidate.distinctRunCount,
      promotionPath: candidate.promotionPath,
      content: buildAntiPatternContent(candidate),
      status: "pending",
      createdAt: "2026-01-01T00:00:00Z"
    };

    await store.appendAntiPatternDraft("proj-1", draft);
    await store.appendAntiPatternDraft("proj-1", { ...draft, distinctRunCount: 5 });
    const drafts = await store.listAntiPatternDrafts("proj-1");
    assert.strictEqual(drafts.length, 1, "upsert by id — must not duplicate");
    assert.strictEqual(drafts[0]!.distinctRunCount, 5, "upsert must take the newer value");
  });

  it("isolates drafts by projectId", async () => {
    const store = new MemoryAntiPatternDraftStore();
    const occurrences = [
      makeImmutabilityOccurrence("run-A"),
      makeImmutabilityOccurrence("run-B")
    ];
    const [candidate] = selectDistillationCandidates(occurrences);
    assert.ok(candidate);

    const draft: AntiPatternDraft = {
      id: "draft-proj-iso",
      projectId: "proj-X",
      fingerprint: candidate.fingerprint,
      category: candidate.category,
      ruleLocus: candidate.ruleLocus,
      distinctRunCount: candidate.distinctRunCount,
      promotionPath: candidate.promotionPath,
      content: buildAntiPatternContent(candidate),
      status: "pending",
      createdAt: "2026-01-01T00:00:00Z"
    };

    await store.appendAntiPatternDraft("proj-X", draft);
    const draftsX = await store.listAntiPatternDrafts("proj-X");
    const draftsY = await store.listAntiPatternDrafts("proj-Y");
    assert.strictEqual(draftsX.length, 1);
    assert.strictEqual(draftsY.length, 0);
  });
});
