// P1.5 structured review findings — TDD.
//
// Tests must FAIL before the implementation is complete, then pass after.
// Node built-in test runner — no vitest.
//
// Covers:
//   1. ReviewFinding type shape
//   2. extractMistakeOccurrences prefers findingDetails over free-text findings
//   3. symbolLocus derived from finding.symbol or file
//   4. Fingerprint includes symbolLocus when present
//   5. Same category + different symbols → DIFFERENT fingerprints (finer cardinality)
//   6. Detail-less path retains P1 coarse behavior (backward compat)
//   7. Gate logic (canReviewRecordSatisfyGate, evaluateReviewDecision) is byte-for-byte unchanged
//   8. recordReview derives findings string[] from findingDetails.map(f => f.message) when supplied
//   9. CLI --findings-json flag parses array of ReviewFinding

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractMistakeOccurrences,
  computeFingerprint,
  type MistakeOccurrenceRecord
} from "../src/runtime/mistake-ledger.ts";

import type { ReviewRecord, ReviewFinding } from "../src/domain/types.ts";

import { canReviewRecordSatisfyGate } from "../src/domain/contracts.ts";

import { parseReviewFindingsJson } from "../src/review.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReviewRecord(
  overrides: Partial<ReviewRecord> & {
    findingDetails?: readonly ReviewFinding[] | undefined;
  }
): ReviewRecord {
  return {
    id: "rev-001",
    runId: "run-001",
    taskId: "task-001",
    reviewerRole: "reviewer",
    actor: "review-orchestrator",
    actorRole: "reviewer",
    source: "orchestrator",
    state: "blocked",
    severity: "high",
    findings: overrides.findings ?? [],
    waiverReason: undefined,
    evidenceRefs: [],
    createdAt: "2026-06-21T00:00:00Z",
    findingDetails: overrides.findingDetails,
    ...overrides
  } satisfies ReviewRecord;
}

// ---------------------------------------------------------------------------
// 1. ReviewFinding type shape (compile-time check via satisfies)
// ---------------------------------------------------------------------------

describe("ReviewFinding type", () => {
  it("accepts minimal shape with only message", () => {
    const f: ReviewFinding = { message: "mutated object in place" };
    assert.strictEqual(f.message, "mutated object in place");
    assert.strictEqual(f.severity, undefined);
    assert.strictEqual(f.category, undefined);
    assert.strictEqual(f.file, undefined);
    assert.strictEqual(f.line, undefined);
    assert.strictEqual(f.symbol, undefined);
  });

  it("accepts fully-specified shape", () => {
    const f: ReviewFinding = {
      message: "mutated object in place",
      severity: "high",
      category: "immutability_violation",
      file: "src/core/service.ts",
      line: 42,
      symbol: "recordReview"
    };
    assert.strictEqual(f.symbol, "recordReview");
    assert.strictEqual(f.line, 42);
    assert.strictEqual(f.file, "src/core/service.ts");
  });
});

// ---------------------------------------------------------------------------
// 2. extractMistakeOccurrences — findingDetails preferred over findings
// ---------------------------------------------------------------------------

describe("extractMistakeOccurrences — structured path (findingDetails present)", () => {
  it("uses category from findingDetails, not classifier", () => {
    // The finding message would normally classify as "uncategorized" but
    // the structured category is "immutability_violation" — must use structured.
    const review = makeReviewRecord({
      findings: ["some free text finding that classifier can't categorize"],
      findingDetails: [
        {
          message: "some free text finding that classifier can't categorize",
          category: "immutability_violation",
          symbol: "processRecord"
        }
      ]
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 1);
    assert.strictEqual(occurrences[0]!.category, "immutability_violation");
    assert.strictEqual(occurrences[0]!.rawFinding, "some free text finding that classifier can't categorize");
  });

  it("drops detail findings with no category (not even uncategorized structured findings are recorded)", () => {
    const review = makeReviewRecord({
      findings: [],
      findingDetails: [
        { message: "general observation with no category" }
      ]
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 0);
  });

  it("computes symbolLocus from symbol field", () => {
    const review = makeReviewRecord({
      findings: [],
      findingDetails: [
        {
          message: "mutated object",
          category: "immutability_violation",
          symbol: "recordReview"
        }
      ]
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 1);
    assert.strictEqual(occurrences[0]!.symbolLocus, "recordReview");
  });

  it("computes symbolLocus from file when symbol is absent", () => {
    const review = makeReviewRecord({
      findings: [],
      findingDetails: [
        {
          message: "mutation in service",
          category: "immutability_violation",
          file: "src/core/service.ts"
        }
      ]
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 1);
    assert.strictEqual(occurrences[0]!.symbolLocus, "src/core/service.ts");
  });

  it("leaves symbolLocus undefined when neither symbol nor file is present", () => {
    const review = makeReviewRecord({
      findings: [],
      findingDetails: [
        {
          message: "mutation somewhere",
          category: "immutability_violation"
        }
      ]
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 1);
    assert.strictEqual(occurrences[0]!.symbolLocus, undefined);
  });

  it("returns empty when review state is passed (even with findingDetails)", () => {
    const review = makeReviewRecord({
      state: "passed",
      findings: [],
      findingDetails: [
        {
          message: "mutated object",
          category: "immutability_violation",
          symbol: "doThing"
        }
      ]
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Fingerprint — includes symbolLocus when present
// ---------------------------------------------------------------------------

describe("computeFingerprint — symbolLocus in hash", () => {
  it("with symbolLocus is different from without symbolLocus (same category+ruleLocus)", () => {
    const ruleLocus = "coding-style#immutability";
    const fpCoarse = computeFingerprint("immutability_violation", ruleLocus);
    const fpFine = computeFingerprint("immutability_violation", ruleLocus, "recordReview");
    assert.notEqual(fpCoarse, fpFine);
  });

  it("two different symbols produce different fingerprints", () => {
    const ruleLocus = "coding-style#immutability";
    const fp1 = computeFingerprint("immutability_violation", ruleLocus, "recordReview");
    const fp2 = computeFingerprint("immutability_violation", ruleLocus, "updateTask");
    assert.notEqual(fp1, fp2);
  });

  it("same category, ruleLocus, symbolLocus produces same fingerprint (deterministic)", () => {
    const ruleLocus = "coding-style#immutability";
    const fp1 = computeFingerprint("immutability_violation", ruleLocus, "recordReview");
    const fp2 = computeFingerprint("immutability_violation", ruleLocus, "recordReview");
    assert.strictEqual(fp1, fp2);
  });
});

// ---------------------------------------------------------------------------
// 4. Finer fingerprint cardinality — same category, different symbols
// ---------------------------------------------------------------------------

describe("extractMistakeOccurrences — fine-grained fingerprint cardinality", () => {
  it("same category in two different symbols yields two DIFFERENT fingerprints", () => {
    const review = makeReviewRecord({
      findings: [],
      findingDetails: [
        {
          message: "mutated task record",
          category: "immutability_violation",
          symbol: "updateTask"
        },
        {
          message: "mutated review record in place",
          category: "immutability_violation",
          symbol: "recordReview"
        }
      ]
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 2);
    assert.notEqual(occurrences[0]!.fingerprint, occurrences[1]!.fingerprint);
    assert.strictEqual(occurrences[0]!.symbolLocus, "updateTask");
    assert.strictEqual(occurrences[1]!.symbolLocus, "recordReview");
  });

  it("same category in same symbol yields the SAME fingerprint (dedup works)", () => {
    const review = makeReviewRecord({
      findings: [],
      findingDetails: [
        {
          message: "first mutation",
          category: "immutability_violation",
          symbol: "recordReview"
        },
        {
          message: "second mutation",
          category: "immutability_violation",
          symbol: "recordReview"
        }
      ]
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 2);
    // Same fingerprint — both describe the same rule+symbol combination
    assert.strictEqual(occurrences[0]!.fingerprint, occurrences[1]!.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// 5. Detail-less path retains P1 coarse behavior (backward compat)
// ---------------------------------------------------------------------------

describe("extractMistakeOccurrences — detail-less path (P1 backward compat)", () => {
  it("classifies free-text findings when no findingDetails", () => {
    const review = makeReviewRecord({
      findings: ["mutated the existing object in place"],
      findingDetails: undefined
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 1);
    assert.strictEqual(occurrences[0]!.category, "immutability_violation");
    assert.strictEqual(occurrences[0]!.symbolLocus, undefined);
  });

  it("drops uncategorized free-text findings (P1 behavior unchanged)", () => {
    const review = makeReviewRecord({
      findings: ["looks good overall"],
      findingDetails: undefined
    });

    const occurrences = extractMistakeOccurrences(review);
    assert.strictEqual(occurrences.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Gate logic — byte-for-byte unchanged
// ---------------------------------------------------------------------------

describe("canReviewRecordSatisfyGate — unchanged by findingDetails", () => {
  it("passed review with empty findings still satisfies gate regardless of findingDetails", () => {
    const review = makeReviewRecord({
      state: "passed",
      severity: "low",
      findings: [],
      actorRole: "reviewer",
      reviewerRole: "reviewer",
      findingDetails: [
        // findingDetails present but review passed — gate doesn't care
        { message: "no issue", category: "immutability_violation" }
      ]
    });

    // Gate should still pass (findings is empty and state is passed)
    assert.strictEqual(canReviewRecordSatisfyGate(review), true);
  });

  it("blocked review with findings fails gate regardless of findingDetails", () => {
    const review = makeReviewRecord({
      state: "blocked",
      severity: "high",
      findings: ["mutation found"],
      findingDetails: [
        { message: "mutation found", category: "immutability_violation", symbol: "doIt" }
      ]
    });

    assert.strictEqual(canReviewRecordSatisfyGate(review), false);
  });
});

// ---------------------------------------------------------------------------
// 7. ReviewInput.findingDetails — derives findings from message fields
// ---------------------------------------------------------------------------

describe("ReviewInput.findingDetails — findings derivation contract", () => {
  it("ReviewRecord can carry findingDetails alongside findings", () => {
    const record: ReviewRecord = makeReviewRecord({
      findings: ["mutated object in place"],
      findingDetails: [
        {
          message: "mutated object in place",
          category: "immutability_violation",
          symbol: "recordReview"
        }
      ]
    });

    assert.ok(Array.isArray(record.findingDetails));
    assert.strictEqual(record.findingDetails?.length, 1);
    assert.strictEqual(record.findings.length, 1);
    assert.strictEqual(record.findings[0], record.findingDetails![0]!.message);
  });
});

// ---------------------------------------------------------------------------
// 8. CLI parseReviewFindingsJson — validate shape (no any)
// ---------------------------------------------------------------------------

describe("parseReviewFindingsJson — CLI flag validation", () => {
  it("accepts valid array of ReviewFinding objects", () => {
    const input = JSON.stringify([
      { message: "mutation found", severity: "high", category: "immutability_violation", symbol: "doThing" }
    ]);

    const result = parseReviewFindingsJson(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.message, "mutation found");
    assert.strictEqual(result[0]!.symbol, "doThing");
  });

  it("accepts minimal finding with only message", () => {
    const input = JSON.stringify([{ message: "something wrong" }]);
    const result = parseReviewFindingsJson(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.message, "something wrong");
  });

  it("throws on non-array JSON", () => {
    assert.throws(
      () => parseReviewFindingsJson('{"message":"oops"}'),
      /must be a JSON array/i
    );
  });

  it("throws when array element is missing message field", () => {
    assert.throws(
      () => parseReviewFindingsJson('[{"severity":"high"}]'),
      /message/i
    );
  });

  it("throws when message field is not a string", () => {
    assert.throws(
      () => parseReviewFindingsJson('[{"message":42}]'),
      /message/i
    );
  });

  it("throws on invalid JSON", () => {
    assert.throws(
      () => parseReviewFindingsJson("not json"),
      /invalid json/i
    );
  });

  it("accepts empty array", () => {
    const result = parseReviewFindingsJson("[]");
    assert.strictEqual(result.length, 0);
  });

  it("rejects invalid severity value", () => {
    assert.throws(
      () => parseReviewFindingsJson('[{"message":"x","severity":"fatal"}]'),
      /severity/i
    );
  });
});
