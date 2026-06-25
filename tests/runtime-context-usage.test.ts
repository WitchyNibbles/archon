// Phase 1 (ahrP1Sampling) — context-usage pure helper unit tests.
//
// RED phase: these tests import from src/runtime/context-usage.ts which does
// not yet exist. They must FAIL before implementation is written.
//
// Uses node:test + node:assert/strict. No real database connection.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeUsedPct,
  resolveModelContextTokens,
  mergeUsedPct
} from "../src/runtime/context-usage.ts";

// ---------------------------------------------------------------------------
// computeUsedPct
// ---------------------------------------------------------------------------

describe("computeUsedPct", () => {
  it("returns undefined when usage is undefined", () => {
    assert.equal(computeUsedPct(undefined, 200_000), undefined);
  });

  it("returns undefined when contextWindowTokens is 0", () => {
    assert.equal(
      computeUsedPct(
        { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        0
      ),
      undefined
    );
  });

  it("returns undefined when contextWindowTokens is negative", () => {
    assert.equal(
      computeUsedPct(
        { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        -1
      ),
      undefined
    );
  });

  it("computes correct percentage: (input + cache_read + cache_creation + output) / window * 100", () => {
    const result = computeUsedPct(
      { inputTokens: 50_000, outputTokens: 10_000, cacheReadTokens: 20_000, cacheCreationTokens: 10_000 },
      200_000
    );
    // (50000 + 10000 + 20000 + 10000) / 200000 * 100 = 90000/200000 * 100 = 45
    assert.equal(result, 45);
  });

  it("handles zero token usage (all zeros) as 0%", () => {
    const result = computeUsedPct(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      200_000
    );
    assert.equal(result, 0);
  });

  it("handles input+output only (zero cache fields)", () => {
    const result = computeUsedPct(
      { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      200_000
    );
    // 100000 / 200000 * 100 = 50
    assert.equal(result, 50);
  });

  it("clamps to 100 when tokens exceed window (no spurious >100% telemetry)", () => {
    const result = computeUsedPct(
      { inputTokens: 250_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      200_000
    );
    // 250000 / 200000 * 100 = 125, but clamped to 100
    assert.equal(result, 100);
  });

  it("returns undefined when inputTokens is NaN", () => {
    assert.equal(
      computeUsedPct(
        { inputTokens: NaN, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        200_000
      ),
      undefined
    );
  });

  it("returns undefined when outputTokens is Infinity", () => {
    assert.equal(
      computeUsedPct(
        { inputTokens: 0, outputTokens: Infinity, cacheReadTokens: 0, cacheCreationTokens: 0 },
        200_000
      ),
      undefined
    );
  });

  it("clamps to exactly 100 when token sum equals window size", () => {
    const result = computeUsedPct(
      { inputTokens: 200_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      200_000
    );
    // 200000 / 200000 * 100 = 100 (exactly at ceiling, not exceeding it)
    assert.equal(result, 100);
  });
});

// ---------------------------------------------------------------------------
// resolveModelContextTokens
// ---------------------------------------------------------------------------

describe("resolveModelContextTokens", () => {
  it("returns default (200000) when env is empty", () => {
    assert.equal(resolveModelContextTokens({}), 200_000);
  });

  it("returns default when ARCHON_MODEL_CONTEXT_TOKENS is absent", () => {
    assert.equal(resolveModelContextTokens({ OTHER: "val" }), 200_000);
  });

  it("returns parsed value when ARCHON_MODEL_CONTEXT_TOKENS is a valid positive integer", () => {
    assert.equal(resolveModelContextTokens({ ARCHON_MODEL_CONTEXT_TOKENS: "100000" }), 100_000);
  });

  it("returns default when ARCHON_MODEL_CONTEXT_TOKENS is 0", () => {
    assert.equal(resolveModelContextTokens({ ARCHON_MODEL_CONTEXT_TOKENS: "0" }), 200_000);
  });

  it("returns default when ARCHON_MODEL_CONTEXT_TOKENS is negative", () => {
    assert.equal(resolveModelContextTokens({ ARCHON_MODEL_CONTEXT_TOKENS: "-1" }), 200_000);
  });

  it("returns default when ARCHON_MODEL_CONTEXT_TOKENS is non-numeric", () => {
    assert.equal(resolveModelContextTokens({ ARCHON_MODEL_CONTEXT_TOKENS: "not-a-number" }), 200_000);
  });

  it("returns default when ARCHON_MODEL_CONTEXT_TOKENS is empty string", () => {
    assert.equal(resolveModelContextTokens({ ARCHON_MODEL_CONTEXT_TOKENS: "" }), 200_000);
  });
});

// ---------------------------------------------------------------------------
// mergeUsedPct
// ---------------------------------------------------------------------------

describe("mergeUsedPct", () => {
  it("returns undefined when both signals are undefined", () => {
    assert.equal(mergeUsedPct(undefined, undefined), undefined);
  });

  it("returns the defined signal when only cliPct is defined", () => {
    assert.equal(mergeUsedPct(42, undefined), 42);
  });

  it("returns the defined signal when only selfReportPct is defined", () => {
    assert.equal(mergeUsedPct(undefined, 65), 65);
  });

  it("returns the max (conservative) when both signals are defined", () => {
    assert.equal(mergeUsedPct(40, 65), 65);
  });

  it("returns max when cliPct is higher", () => {
    assert.equal(mergeUsedPct(75, 60), 75);
  });

  it("returns either when both are equal", () => {
    assert.equal(mergeUsedPct(50, 50), 50);
  });
});
