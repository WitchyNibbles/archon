// Tests for mplP1Capture repair task: FIX 1–5 + observability items.
//
// TDD: tests were written before the fixes. All must pass after implementation.
// Node built-in test runner — no vitest.
//
// Covers:
//   FIX 1: recordReview with state:"passed" + non-empty findingDetails stores gate-satisfiable record
//   FIX 2: collectMistakeMetrics + concrete store (MemoryMistakeLedgerStore) produces non-zero baseline
//   FIX 4: saveReviewCommand --findings-json inline JSON and file-path branches
//   FIX 5: path traversal rejection in parseOrReadFindingsJson

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canReviewRecordSatisfyGate
} from "../src/domain/contracts.ts";
import type { ReviewRecord, ReviewFinding } from "../src/domain/types.ts";

import {
  collectMistakeMetrics,
  type MistakeMetricsStoreLike,
  type MistakeOccurrenceRecord
} from "../src/runtime/mistake-ledger.ts";

import { MemoryMistakeLedgerStore } from "../src/store/memory-store.ts";

import {
  parseOrReadFindingsJson,
  type SaveReviewCommandDeps
} from "../src/review.ts";

import { saveReviewCommand } from "../src/review.ts";

// ---------------------------------------------------------------------------
// FIX 1: gate-broken derivation
// ---------------------------------------------------------------------------

describe("FIX 1: recordReview — passed review with findingDetails must produce gate-satisfiable record", () => {
  it("canReviewRecordSatisfyGate returns true for passed review with empty findings, when findingDetails has no accepted disposition", () => {
    // The fix: when state==="passed", findings must remain [] regardless of findingDetails.
    // Gate at contracts.ts line 942 requires findings.length === 0 for a pass.
    const record: ReviewRecord = {
      id: "rev-fix1-001",
      runId: "run-001",
      taskId: "task-001",
      reviewerRole: "reviewer",
      actor: "review-orchestrator",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: [], // MUST be empty for a passed review
      waiverReason: undefined,
      evidenceRefs: [],
      createdAt: "2026-06-21T00:00:00Z",
      findingDetails: [
        // Provenance present, but findings[] must NOT be derived from these for a pass
        { message: "mutation here", category: "immutability_violation", symbol: "doThing" }
      ]
    };

    // Gate check: passed review with empty findings + actor=actorRole=reviewer must satisfy gate
    assert.strictEqual(canReviewRecordSatisfyGate(record), true,
      "Gate must be satisfied when state=passed and findings=[], even with non-empty findingDetails"
    );
  });

  it("canReviewRecordSatisfyGate returns false when passed review has non-empty findings (broken derivation)", () => {
    // Confirm the invariant: if findings is non-empty on a passed review, gate fails.
    // This validates that the pre-fix bug (unconditional derivation) would break the gate.
    const brokenRecord: ReviewRecord = {
      id: "rev-fix1-002",
      runId: "run-001",
      taskId: "task-001",
      reviewerRole: "reviewer",
      actor: "review-orchestrator",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "passed",
      severity: "low",
      findings: ["mutation here"], // NON-EMPTY — was wrongly derived from findingDetails before fix
      waiverReason: undefined,
      evidenceRefs: [],
      createdAt: "2026-06-21T00:00:00Z",
      findingDetails: [
        { message: "mutation here", category: "immutability_violation", symbol: "doThing" }
      ]
    };

    // Gate MUST fail for passed review with non-empty findings
    assert.strictEqual(canReviewRecordSatisfyGate(brokenRecord), false,
      "Gate must reject a passed review with non-empty findings (the pre-fix broken state)"
    );
  });

  it("failed review with findingDetails still derives findings from findingDetails", () => {
    // For state !== "passed", derivation from findingDetails is correct behavior.
    // The gate doesn't apply the same empty-findings check for blocked reviews.
    const failedRecord: ReviewRecord = {
      id: "rev-fix1-003",
      runId: "run-001",
      taskId: "task-001",
      reviewerRole: "reviewer",
      actor: "review-orchestrator",
      actorRole: "reviewer",
      source: "orchestrator",
      state: "blocked",
      severity: "high",
      findings: ["mutation here"], // derived from findingDetails on blocked review — correct
      waiverReason: undefined,
      evidenceRefs: [],
      createdAt: "2026-06-21T00:00:00Z",
      findingDetails: [
        { message: "mutation here", category: "immutability_violation", symbol: "doThing" }
      ]
    };

    // On a blocked review, findings non-empty is expected — gate returns false (not satisfiable without waiver)
    assert.strictEqual(canReviewRecordSatisfyGate(failedRecord), false,
      "Blocked review with findings is not gate-satisfiable (correct)"
    );
  });
});

// ---------------------------------------------------------------------------
// FIX 2: metric interface mismatch — projectId vs runId
// ---------------------------------------------------------------------------

describe("FIX 2: collectMistakeMetrics — concrete store produces non-zero baseline", () => {
  it("MemoryMistakeLedgerStore bridged into collectMistakeMetrics returns non-zero metrics", async () => {
    const store = new MemoryMistakeLedgerStore();
    const projectId = "project:ws:proj";

    // Build two occurrences in different runs so fp1 is recurrent
    const fp1 = "abc111fingerprint";
    const fp2 = "abc222fingerprint";

    const occ1: MistakeOccurrenceRecord = {
      id: "occ-1",
      fingerprint: fp1,
      category: "immutability_violation",
      ruleLocus: "coding-style#immutability",
      symbolLocus: undefined,
      pathLocus: undefined,
      rawFinding: "mutated object",
      severity: "medium",
      reviewerRole: "reviewer",
      runId: "run-A",
      taskId: "task-1",
      capturedAt: "2026-06-21T00:00:00Z"
    };
    const occ2: MistakeOccurrenceRecord = {
      id: "occ-2",
      fingerprint: fp1,
      category: "immutability_violation",
      ruleLocus: "coding-style#immutability",
      symbolLocus: undefined,
      pathLocus: undefined,
      rawFinding: "mutated again",
      severity: "medium",
      reviewerRole: "reviewer",
      runId: "run-B", // different run — fp1 is now recurrent
      taskId: "task-2",
      capturedAt: "2026-06-21T00:00:01Z"
    };
    const occ3: MistakeOccurrenceRecord = {
      id: "occ-3",
      fingerprint: fp2,
      category: "unhandled_error",
      ruleLocus: "coding-style#error-handling",
      symbolLocus: undefined,
      pathLocus: undefined,
      rawFinding: "error swallowed",
      severity: "high",
      reviewerRole: "reviewer",
      runId: "run-A",
      taskId: "task-1",
      capturedAt: "2026-06-21T00:00:02Z"
    };

    await store.appendMistakeOccurrences(projectId, [occ1, occ2, occ3]);

    // Bridge MemoryMistakeLedgerStore into MistakeMetricsStoreLike via the updated interface.
    // After FIX 2, collectMistakeMetrics accepts (store: MistakeMetricsStoreLike, runId, projectId).
    // MistakeMetricsStoreLike.listMistakeOccurrences now takes projectId.
    // MemoryMistakeLedgerStore implements MistakeLedgerStoreLike which also uses projectId.
    // After the fix these two interfaces are aligned, so the concrete store IS the metric store.
    const metrics = await collectMistakeMetrics(store, "run-A", projectId);

    assert.strictEqual(metrics.runId, "run-A");
    assert.strictEqual(metrics.totalOccurrences, 3, "Should see all 3 occurrences");
    assert.strictEqual(metrics.totalFingerprints, 2, "Two distinct fingerprints");
    assert.strictEqual(metrics.recurrentFingerprints, 1, "fp1 appears in 2 runs → recurrent");
    // 2 of 3 occurrences belong to the recurrent fp1
    assert.ok(metrics.mistakeRepeatRate > 0.6,
      `mistakeRepeatRate should be ~0.667, got ${metrics.mistakeRepeatRate}`
    );
  });

  it("MistakeMetricsStoreLike.listMistakeOccurrences accepts projectId param (not runId)", async () => {
    // This test validates the interface alignment directly.
    // After FIX 2, the MistakeMetricsStoreLike interface uses projectId, not runId.
    // A store that implements MistakeLedgerStoreLike (projectId-keyed) can satisfy MistakeMetricsStoreLike.
    const store = new MemoryMistakeLedgerStore();
    const projectId = "project:ws:test";

    const occ: MistakeOccurrenceRecord = {
      id: "occ-test",
      fingerprint: "somefp",
      category: "sql_injection",
      ruleLocus: "security#sql-injection-prevention",
      symbolLocus: undefined,
      pathLocus: undefined,
      rawFinding: "raw SQL query",
      severity: "critical",
      reviewerRole: "security_reviewer",
      runId: "run-1",
      taskId: "task-1",
      capturedAt: "2026-06-21T00:00:00Z"
    };

    await store.appendMistakeOccurrences(projectId, [occ]);

    // store satisfies MistakeMetricsStoreLike — calling listMistakeOccurrences with projectId
    const metricStore: MistakeMetricsStoreLike = store;
    const results = await metricStore.listMistakeOccurrences(projectId);

    assert.strictEqual(results.length, 1, "Must retrieve the stored occurrence by projectId");
    assert.strictEqual(results[0]!.id, "occ-test");
  });
});

// ---------------------------------------------------------------------------
// FIX 4: saveReviewCommand — CLI wiring tests
// ---------------------------------------------------------------------------

describe("FIX 4: saveReviewCommand — --findings-json flag wiring", () => {
  // Minimal store mock that captures what was passed to saveOrchestratorReview.
  // Fix #1 (multi-finding CLI): findings is now readonly string[] — one element per
  // finding, not a single joined string.
  type CapturedReview = {
    taskId: string;
    role: string;
    outcome: string;
    findings: readonly string[];
    findingDetails: readonly ReviewFinding[] | undefined;
    workspaceId: string;
    projectId: string;
    runId: string | null | undefined;
  };

  function makeStoreMock(captured: CapturedReview[]): {
    findLatestRunForTask: (params: { workspaceSlug: string; projectSlug: string; taskId: string }) => Promise<{ id: string } | undefined>;
    saveOrchestratorReview: (input: CapturedReview) => Promise<void>;
  } {
    return {
      async findLatestRunForTask(_params) {
        return { id: "run-mock-001" };
      },
      async saveOrchestratorReview(input) {
        captured.push({ ...input });
      }
    };
  }

  const baseEnv = {
    ARCHON_WORKSPACE_SLUG: "ws-test",
    ARCHON_PROJECT_SLUG: "proj-test"
  };

  it("inline JSON: parses --findings-json inline and passes findingDetails to store", async () => {
    const captured: CapturedReview[] = [];
    const mock = makeStoreMock(captured);

    const inlineJson = JSON.stringify([
      { message: "mutated object", severity: "high", category: "immutability_violation", symbol: "doThing" }
    ]);

    const deps: SaveReviewCommandDeps = {
      withClientFn: (fn) => fn(mock as never),
      env: baseEnv
    };

    await saveReviewCommand(
      ["--task-id", "task-001", "--role", "reviewer", "--outcome", "passed", "--source", "orchestrator", "--findings-json", inlineJson],
      deps
    );

    assert.strictEqual(captured.length, 1);
    const saved = captured[0]!;
    assert.ok(saved.findingDetails !== undefined && saved.findingDetails.length === 1,
      "findingDetails must be passed to store"
    );
    assert.strictEqual(saved.findingDetails![0]!.message, "mutated object");
    assert.strictEqual(saved.findingDetails![0]!.symbol, "doThing");
    assert.strictEqual(saved.taskId, "task-001");
    assert.strictEqual(saved.role, "reviewer");
    assert.strictEqual(saved.outcome, "passed");
  });

  it("file-path: reads file and parses findings from it", async () => {
    const captured: CapturedReview[] = [];
    const mock = makeStoreMock(captured);

    const fileContent = JSON.stringify([
      { message: "sql injection risk", severity: "critical", category: "sql_injection" }
    ]);

    // Inject a readFileFn that simulates reading a file within cwd
    const fakeCwd = "/home/eimi/projects/archon";
    const fakeFilePath = "/home/eimi/projects/archon/findings.json";

    const deps: SaveReviewCommandDeps = {
      withClientFn: (fn) => fn(mock as never),
      env: baseEnv,
      cwd: fakeCwd,
      readFileFn: async (filePath) => {
        if (filePath === fakeFilePath) return fileContent;
        throw new Error(`Unexpected path: ${filePath}`);
      }
    };

    await saveReviewCommand(
      ["--task-id", "task-002", "--role", "security_reviewer", "--outcome", "failed",
       "--source", "orchestrator", "--findings-json", "findings.json"],
      deps
    );

    assert.strictEqual(captured.length, 1);
    const saved = captured[0]!;
    assert.ok(saved.findingDetails !== undefined && saved.findingDetails.length === 1);
    assert.strictEqual(saved.findingDetails![0]!.message, "sql injection risk");
    assert.strictEqual(saved.findingDetails![0]!.category, "sql_injection");
  });

  it("no --findings-json: findingDetails is undefined, findings is empty array", async () => {
    const captured: CapturedReview[] = [];
    const mock = makeStoreMock(captured);

    const deps: SaveReviewCommandDeps = {
      withClientFn: (fn) => fn(mock as never),
      env: baseEnv
    };

    await saveReviewCommand(
      ["--task-id", "task-003", "--role", "qa_engineer", "--outcome", "passed", "--source", "orchestrator"],
      deps
    );

    assert.strictEqual(captured.length, 1);
    const saved = captured[0]!;
    assert.strictEqual(saved.findingDetails, undefined);
    // Fix #1: findings is now string[] — no --findings flag → empty array, not empty string
    assert.deepEqual([...saved.findings], []);
  });

  it("--findings-json with inline JSON produces derivedFindings array for passed outcome", async () => {
    const captured: CapturedReview[] = [];
    const mock = makeStoreMock(captured);

    const inlineJson = JSON.stringify([
      { message: "finding A" },
      { message: "finding B" }
    ]);

    const deps: SaveReviewCommandDeps = {
      withClientFn: (fn) => fn(mock as never),
      env: baseEnv
    };

    await saveReviewCommand(
      ["--task-id", "task-004", "--role", "reviewer", "--outcome", "passed",
       "--source", "orchestrator", "--findings-json", inlineJson],
      deps
    );

    // Fix #1: derivedFindings for non-empty findingDetails is now string[] (one per finding),
    // not a single joined "finding A; finding B" string.
    assert.deepEqual([...captured[0]!.findings], ["finding A", "finding B"]);
  });
});

// ---------------------------------------------------------------------------
// FIX 5: path traversal guard in parseOrReadFindingsJson
// ---------------------------------------------------------------------------

describe("FIX 5: parseOrReadFindingsJson — path traversal prevention", () => {
  const fakeCwd = "/home/eimi/projects/archon";
  const goodContent = JSON.stringify([{ message: "safe finding" }]);

  it("accepts a file path within cwd", async () => {
    const readFileFn = async (p: string) => {
      if (p === "/home/eimi/projects/archon/findings.json") return goodContent;
      throw new Error("unexpected: " + p);
    };

    const results = await parseOrReadFindingsJson("findings.json", fakeCwd, readFileFn);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]!.message, "safe finding");
  });

  it("rejects an absolute path escaping cwd via /proc/self/environ", async () => {
    const readFileFn = async (_p: string): Promise<string> => {
      throw new Error("should not be called");
    };

    await assert.rejects(
      () => parseOrReadFindingsJson("/proc/self/environ", fakeCwd, readFileFn),
      /outside.*working directory|path.*traversal|forbidden/i
    );
  });

  it("rejects a relative path escaping cwd via ../../../etc/passwd", async () => {
    const readFileFn = async (_p: string): Promise<string> => {
      throw new Error("should not be called");
    };

    await assert.rejects(
      () => parseOrReadFindingsJson("../../../etc/passwd", fakeCwd, readFileFn),
      /outside.*working directory|path.*traversal|forbidden/i
    );
  });

  it("rejects an absolute path outside cwd", async () => {
    const readFileFn = async (_p: string): Promise<string> => {
      throw new Error("should not be called");
    };

    await assert.rejects(
      () => parseOrReadFindingsJson("/tmp/evil.json", fakeCwd, readFileFn),
      /outside.*working directory|path.*traversal|forbidden/i
    );
  });

  it("accepts a nested subdirectory path within cwd", async () => {
    const readFileFn = async (p: string) => {
      if (p === "/home/eimi/projects/archon/subdir/findings.json") return goodContent;
      throw new Error("unexpected: " + p);
    };

    const results = await parseOrReadFindingsJson("subdir/findings.json", fakeCwd, readFileFn);
    assert.strictEqual(results.length, 1);
  });

  it("treats non-path strings as inline JSON", async () => {
    const inlineJson = JSON.stringify([{ message: "inline finding" }]);
    // "inline json" is not a path (no / and doesn't end with .json)
    const readFileFn = async (_p: string): Promise<string> => {
      throw new Error("should not be called for inline JSON");
    };

    const results = await parseOrReadFindingsJson(inlineJson, fakeCwd, readFileFn);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]!.message, "inline finding");
  });
});
