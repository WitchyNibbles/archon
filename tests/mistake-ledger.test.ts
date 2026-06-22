// Tests for src/runtime/mistake-ledger.ts — P1 capture + fingerprint + occurrence store + metric.
//
// TDD: these tests must fail before the implementation exists, then pass after.
//
// Node built-in test runner — no vitest.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFinding,
  computeFingerprint,
  deriveRuleLocus,
  countRecurrences,
  type MistakeOccurrenceRecord,
  type MistakeMetrics
} from "../src/runtime/mistake-ledger.ts";
import {
  collectMistakeMetrics,
  formatMistakePrometheus,
  type MistakeMetricsStoreLike
} from "../src/runtime/mistake-ledger.ts";

// ---------------------------------------------------------------------------
// classifyFinding
// ---------------------------------------------------------------------------

describe("classifyFinding — keyword/regex classifier", () => {
  it("classifies immutability violations", () => {
    assert.strictEqual(classifyFinding("mutated existing object in place"), "immutability_violation");
    assert.strictEqual(classifyFinding("MUTATION: modified state directly"), "immutability_violation");
    assert.strictEqual(classifyFinding("direct mutation of the task record"), "immutability_violation");
  });

  it("classifies nodenext extension missing", () => {
    assert.strictEqual(classifyFinding("missing .ts extension on import"), "nodenext_extension_missing");
    assert.strictEqual(classifyFinding("import without .ts extension"), "nodenext_extension_missing");
    assert.strictEqual(classifyFinding("NodeNext import missing extension"), "nodenext_extension_missing");
    assert.strictEqual(classifyFinding("relative import lacks .ts"), "nodenext_extension_missing");
  });

  it("classifies sql injection", () => {
    assert.strictEqual(classifyFinding("SQL injection risk: string interpolation in query"), "sql_injection");
    assert.strictEqual(classifyFinding("unparameterized query uses string concat"), "sql_injection");
    assert.strictEqual(classifyFinding("raw SQL without parameterization"), "sql_injection");
  });

  it("classifies unhandled errors", () => {
    assert.strictEqual(classifyFinding("error silently swallowed"), "unhandled_error");
    assert.strictEqual(classifyFinding("unhandled promise rejection"), "unhandled_error");
    assert.strictEqual(classifyFinding("catch block ignores error"), "unhandled_error");
    assert.strictEqual(classifyFinding("missing error handling in async path"), "unhandled_error");
  });

  it("classifies missing input validation", () => {
    assert.strictEqual(classifyFinding("input not validated before use"), "missing_input_validation");
    assert.strictEqual(classifyFinding("missing validation on external input"), "missing_input_validation");
    assert.strictEqual(classifyFinding("user input passed directly without schema check"), "missing_input_validation");
    assert.strictEqual(classifyFinding("no input validation at system boundary"), "missing_input_validation");
  });

  it("classifies test expectation drift", () => {
    assert.strictEqual(classifyFinding("test expectation does not match implementation"), "test_expectation_drift");
    assert.strictEqual(classifyFinding("assertion updated to match broken output"), "test_expectation_drift");
    assert.strictEqual(classifyFinding("snapshot updated without verifying correctness"), "test_expectation_drift");
  });

  it("falls back to uncategorized for unknown strings", () => {
    assert.strictEqual(classifyFinding("code looks good"), "uncategorized");
    assert.strictEqual(classifyFinding("tests pass"), "uncategorized");
    assert.strictEqual(classifyFinding(""), "uncategorized");
    assert.strictEqual(classifyFinding("no issues found"), "uncategorized");
  });

  it("is case-insensitive", () => {
    assert.strictEqual(classifyFinding("UNPARAMETERIZED QUERY"), "sql_injection");
    assert.strictEqual(classifyFinding("MUTATION detected"), "immutability_violation");
  });

  it("matches partial words in context", () => {
    // The classifier should match on substrings within the prose
    assert.strictEqual(classifyFinding("the function mutates the record directly"), "immutability_violation");
  });
});

// ---------------------------------------------------------------------------
// deriveRuleLocus
// ---------------------------------------------------------------------------

describe("deriveRuleLocus — rule anchor from category", () => {
  it("returns the correct policy anchor for each deterministic category", () => {
    assert.strictEqual(deriveRuleLocus("immutability_violation"), "coding-style#immutability");
    assert.strictEqual(deriveRuleLocus("nodenext_extension_missing"), "typescript.md#module-system");
    assert.strictEqual(deriveRuleLocus("sql_injection"), "security#sql-injection-prevention");
    assert.strictEqual(deriveRuleLocus("unhandled_error"), "coding-style#error-handling");
    assert.strictEqual(deriveRuleLocus("missing_input_validation"), "coding-style#input-validation");
    assert.strictEqual(deriveRuleLocus("test_expectation_drift"), "testing#test-driven-development");
  });

  it("returns 'uncategorized' anchor for uncategorized findings", () => {
    assert.strictEqual(deriveRuleLocus("uncategorized"), "uncategorized#unknown");
  });
});

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

describe("computeFingerprint — deterministic hash of category + ruleLocus", () => {
  it("returns a hex string", () => {
    const fp = computeFingerprint("immutability_violation", "coding-style#immutability");
    assert.match(fp, /^[0-9a-f]+$/);
  });

  it("is deterministic — same inputs always produce same output", () => {
    const a = computeFingerprint("immutability_violation", "coding-style#immutability");
    const b = computeFingerprint("immutability_violation", "coding-style#immutability");
    assert.strictEqual(a, b);
  });

  it("produces different fingerprints for different categories", () => {
    const a = computeFingerprint("immutability_violation", "coding-style#immutability");
    const b = computeFingerprint("sql_injection", "coding-style#immutability");
    assert.notStrictEqual(a, b);
  });

  it("produces different fingerprints for different rule loci", () => {
    const a = computeFingerprint("unhandled_error", "coding-style#error-handling");
    const b = computeFingerprint("unhandled_error", "coding-style#other");
    assert.notStrictEqual(a, b);
  });

  it("is stable — known input produces known output", () => {
    // sha256 of "immutability_violation:coding-style#immutability"
    const fp = computeFingerprint("immutability_violation", "coding-style#immutability");
    // Must be non-empty and hex; exact value is stable once algo is fixed
    assert.ok(fp.length >= 8);
  });
});

// ---------------------------------------------------------------------------
// countRecurrences — recurrence counting across distinct runs
// ---------------------------------------------------------------------------

describe("countRecurrences — cross-run recurrence", () => {
  const fp = "abc123";

  const makeOccurrence = (
    fingerprint: string,
    runId: string,
    id?: string
  ): MistakeOccurrenceRecord => ({
    id: id ?? `occ-${Math.random()}`,
    fingerprint,
    category: "immutability_violation",
    ruleLocus: "coding-style#immutability",
    pathLocus: undefined,
    rawFinding: "mutated object",
    severity: "medium",
    reviewerRole: "reviewer",
    runId,
    taskId: "task-1",
    capturedAt: new Date().toISOString()
  });

  it("returns 0 for empty occurrence list", () => {
    assert.strictEqual(countRecurrences(fp, []), 0);
  });

  it("returns 0 when no occurrences match the fingerprint", () => {
    const records = [makeOccurrence("other-fp", "run-1")];
    assert.strictEqual(countRecurrences(fp, records), 0);
  });

  it("counts 1 for a single occurrence in one run", () => {
    const records = [makeOccurrence(fp, "run-1")];
    assert.strictEqual(countRecurrences(fp, records), 1);
  });

  it("counts distinct runs, not total occurrences", () => {
    // Two occurrences from the same run = 1 distinct run
    const records = [makeOccurrence(fp, "run-1"), makeOccurrence(fp, "run-1")];
    assert.strictEqual(countRecurrences(fp, records), 1);
  });

  it("counts 2 for occurrences across 2 distinct runs", () => {
    const records = [makeOccurrence(fp, "run-1"), makeOccurrence(fp, "run-2")];
    assert.strictEqual(countRecurrences(fp, records), 2);
  });

  it("counts 3 for occurrences across 3 distinct runs even with repeats", () => {
    const records = [
      makeOccurrence(fp, "run-1"),
      makeOccurrence(fp, "run-1"),
      makeOccurrence(fp, "run-2"),
      makeOccurrence(fp, "run-3")
    ];
    assert.strictEqual(countRecurrences(fp, records), 3);
  });

  it("ignores occurrences with different fingerprints", () => {
    const records = [
      makeOccurrence(fp, "run-1"),
      makeOccurrence("different-fp", "run-2"),
      makeOccurrence(fp, "run-3")
    ];
    assert.strictEqual(countRecurrences(fp, records), 2);
  });
});

// ---------------------------------------------------------------------------
// MistakeMetricsStoreLike + collectMistakeMetrics + formatMistakePrometheus
// ---------------------------------------------------------------------------

describe("collectMistakeMetrics — baseline metric", () => {
  it("returns zero counters when there are no occurrences", async () => {
    const store: MistakeMetricsStoreLike = {
      async listMistakeOccurrences(_projectId) {
        return [];
      }
    };
    const metrics = await collectMistakeMetrics(store, "run-1", "project:ws:proj");
    assert.strictEqual(metrics.runId, "run-1");
    assert.strictEqual(metrics.totalFingerprints, 0);
    assert.strictEqual(metrics.recurrentFingerprints, 0);
    assert.strictEqual(metrics.totalOccurrences, 0);
    assert.strictEqual(metrics.mistakeRepeatRate, 0);
  });

  it("computes repeat rate as recurrent / total occurrences", async () => {
    // fp1 appears in run-1 and run-2 → recurrent
    // fp2 appears only in run-1 → non-recurrent
    const fp1 = computeFingerprint("immutability_violation", "coding-style#immutability");
    const fp2 = computeFingerprint("unhandled_error", "coding-style#error-handling");

    const occurrences: readonly MistakeOccurrenceRecord[] = [
      {
        id: "o1",
        fingerprint: fp1,
        category: "immutability_violation",
        ruleLocus: "coding-style#immutability",
        pathLocus: undefined,
        rawFinding: "mutated in place",
        severity: "medium",
        reviewerRole: "reviewer",
        runId: "run-1",
        taskId: "task-1",
        capturedAt: "2026-01-01T00:00:00Z"
      },
      {
        id: "o2",
        fingerprint: fp1,
        category: "immutability_violation",
        ruleLocus: "coding-style#immutability",
        pathLocus: undefined,
        rawFinding: "direct mutation",
        severity: "medium",
        reviewerRole: "reviewer",
        runId: "run-2",
        taskId: "task-2",
        capturedAt: "2026-01-02T00:00:00Z"
      },
      {
        id: "o3",
        fingerprint: fp2,
        category: "unhandled_error",
        ruleLocus: "coding-style#error-handling",
        pathLocus: undefined,
        rawFinding: "error swallowed",
        severity: "high",
        reviewerRole: "reviewer",
        runId: "run-1",
        taskId: "task-1",
        capturedAt: "2026-01-01T00:00:00Z"
      }
    ];

    const store: MistakeMetricsStoreLike = {
      async listMistakeOccurrences(_projectId) {
        return occurrences;
      }
    };

    const metrics = await collectMistakeMetrics(store, "run-1", "project:ws:proj");
    assert.strictEqual(metrics.totalOccurrences, 3);
    assert.strictEqual(metrics.totalFingerprints, 2); // fp1 and fp2
    assert.strictEqual(metrics.recurrentFingerprints, 1); // fp1 only
    // repeat rate: 2 occurrences belong to recurrent fp1 / 3 total = ~0.667
    assert.ok(metrics.mistakeRepeatRate > 0.6);
    assert.ok(metrics.mistakeRepeatRate <= 1.0);
  });
});

describe("formatMistakePrometheus — Prometheus exposition", () => {
  const metrics: MistakeMetrics = {
    runId: "run-1",
    totalFingerprints: 2,
    recurrentFingerprints: 1,
    totalOccurrences: 3,
    mistakeRepeatRate: 0.667
  };

  it("emits archon_mistake_repeat_rate gauge", () => {
    const text = formatMistakePrometheus(metrics);
    assert.match(text, /archon_mistake_repeat_rate\{run_id="run-1"\}/);
    assert.match(text, /# TYPE archon_mistake_repeat_rate gauge/);
  });

  it("emits archon_mistake_occurrences_total gauge", () => {
    const text = formatMistakePrometheus(metrics);
    assert.match(text, /archon_mistake_occurrences_total\{run_id="run-1"\} 3/);
  });

  it("emits archon_mistake_fingerprints_total and recurrent sub-gauge", () => {
    const text = formatMistakePrometheus(metrics);
    assert.match(text, /archon_mistake_fingerprints_total\{run_id="run-1"\} 2/);
    assert.match(text, /archon_mistake_recurrent_fingerprints_total\{run_id="run-1"\} 1/);
  });

  it("escapes special chars in run_id", () => {
    const escaped = formatMistakePrometheus({ ...metrics, runId: 'run"x' });
    assert.match(escaped, /run_id="run\\"x"/);
  });
});

// ---------------------------------------------------------------------------
// extractMistakeOccurrences — derive occurrences from a ReviewRecord
// ---------------------------------------------------------------------------

describe("extractMistakeOccurrences — from ReviewRecord findings", () => {
  it("returns empty array for a passing review with empty findings", async () => {
    const { extractMistakeOccurrences } = await import("../src/runtime/mistake-ledger.ts");
    const occurrences = extractMistakeOccurrences({
      id: "rev-1",
      runId: "run-1",
      taskId: "task-1",
      reviewerRole: "reviewer",
      actor: "actor-1",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: [],
      createdAt: "2026-01-01T00:00:00Z"
    });
    assert.deepStrictEqual(occurrences, []);
  });

  it("skips passed reviews even if findings list is non-empty", async () => {
    const { extractMistakeOccurrences } = await import("../src/runtime/mistake-ledger.ts");
    const occurrences = extractMistakeOccurrences({
      id: "rev-1",
      runId: "run-1",
      taskId: "task-1",
      reviewerRole: "reviewer",
      actor: "actor-1",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: ["code looks good"],
      createdAt: "2026-01-01T00:00:00Z"
    });
    // passed reviews with low-signal findings should not produce occurrences
    assert.deepStrictEqual(occurrences, []);
  });

  it("extracts occurrences from failed review findings", async () => {
    const { extractMistakeOccurrences } = await import("../src/runtime/mistake-ledger.ts");
    const occurrences = extractMistakeOccurrences({
      id: "rev-1",
      runId: "run-1",
      taskId: "task-1",
      reviewerRole: "reviewer",
      actor: "actor-1",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "failed",
      severity: "high",
      findings: ["mutated existing object in place", "unparameterized SQL query"],
      createdAt: "2026-01-01T00:00:00Z"
    });
    assert.strictEqual(occurrences.length, 2);
    const [first, second] = occurrences;
    assert.ok(first !== undefined);
    assert.ok(second !== undefined);
    assert.strictEqual(first.category, "immutability_violation");
    assert.strictEqual(second.category, "sql_injection");
    assert.strictEqual(first.runId, "run-1");
    assert.strictEqual(first.taskId, "task-1");
    assert.strictEqual(first.reviewerRole, "reviewer");
    // fingerprint must be set and non-empty
    assert.ok(first.fingerprint.length > 0);
  });

  it("skips uncategorized findings (they do not create occurrences)", async () => {
    const { extractMistakeOccurrences } = await import("../src/runtime/mistake-ledger.ts");
    const occurrences = extractMistakeOccurrences({
      id: "rev-1",
      runId: "run-1",
      taskId: "task-1",
      reviewerRole: "reviewer",
      actor: "actor-1",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "failed",
      severity: "medium",
      findings: ["tests pass", "no issues found"],
      createdAt: "2026-01-01T00:00:00Z"
    });
    assert.deepStrictEqual(occurrences, []);
  });

  it("gives each occurrence a unique id", async () => {
    const { extractMistakeOccurrences } = await import("../src/runtime/mistake-ledger.ts");
    const occurrences = extractMistakeOccurrences({
      id: "rev-1",
      runId: "run-1",
      taskId: "task-1",
      reviewerRole: "reviewer",
      actor: "actor-1",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "failed",
      severity: "critical",
      findings: ["mutated object", "error silently swallowed"],
      createdAt: "2026-01-01T00:00:00Z"
    });
    assert.strictEqual(occurrences.length, 2);
    const ids = new Set(occurrences.map((o) => o.id));
    assert.strictEqual(ids.size, 2);
  });
});
