/**
 * Unit tests for dashQuality S2 bounded-poll backoff schedule (council C3).
 *
 * `nextPollDelayMs` is a pure function in the isolated web/ workspace; no React/DOM
 * dependency, so it is unit-tested here with the root node:test runner (same pattern
 * as tests/dash-snapshot-age.test.ts; `import` of a .ts type-only-at-runtime module
 * via --experimental-strip-types; the one-directional R2-C web→src wall is unaffected).
 *
 * C3: bounded interval poll, exponential backoff + hard cap on consecutive errors.
 *
 * Run: node --experimental-strip-types --test tests/dash-poll-schedule.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  nextPollDelayMs,
  BASE_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
} from "../web/src/utils/pollSchedule.ts";

describe("nextPollDelayMs — C3 bounded backoff", () => {
  it("zero errors → steady base interval", () => {
    assert.equal(nextPollDelayMs(0), BASE_POLL_INTERVAL_MS);
  });

  it("each consecutive error doubles the delay (exponential backoff)", () => {
    assert.equal(nextPollDelayMs(1), BASE_POLL_INTERVAL_MS * 2);
    assert.equal(nextPollDelayMs(2), BASE_POLL_INTERVAL_MS * 4);
    assert.equal(nextPollDelayMs(3), BASE_POLL_INTERVAL_MS * 8);
  });

  it("never exceeds the hard cap, no matter how many errors", () => {
    assert.equal(nextPollDelayMs(100), MAX_POLL_INTERVAL_MS);
    assert.equal(nextPollDelayMs(1_000_000), MAX_POLL_INTERVAL_MS);
  });

  it("delay is monotonically non-decreasing in error count", () => {
    let prev = 0;
    for (let n = 0; n <= 30; n += 1) {
      const d = nextPollDelayMs(n);
      assert.ok(d >= prev, `delay at ${n} (${d}) should be >= delay at ${n - 1} (${prev})`);
      assert.ok(d <= MAX_POLL_INTERVAL_MS, `delay at ${n} must not exceed cap`);
      prev = d;
    }
  });

  it("the cap is reached and held (backoff is bounded, not unbounded)", () => {
    assert.equal(nextPollDelayMs(50), MAX_POLL_INTERVAL_MS);
    assert.equal(nextPollDelayMs(51), MAX_POLL_INTERVAL_MS);
  });

  it("treats negative / NaN / ±Infinity / fractional error counts as a safe value", () => {
    assert.equal(nextPollDelayMs(-5), BASE_POLL_INTERVAL_MS);
    assert.equal(nextPollDelayMs(Number.NaN), BASE_POLL_INTERVAL_MS);
    // ±Infinity is not a finite count → coerced to 0 errors (base), never NaN/Infinity delay.
    assert.equal(nextPollDelayMs(Number.POSITIVE_INFINITY), BASE_POLL_INTERVAL_MS);
    assert.equal(nextPollDelayMs(Number.NEGATIVE_INFINITY), BASE_POLL_INTERVAL_MS);
    assert.equal(nextPollDelayMs(1.9), BASE_POLL_INTERVAL_MS * 2);
  });

  it("base never drops below the configured steady interval", () => {
    for (let n = 0; n <= 5; n += 1) {
      assert.ok(nextPollDelayMs(n) >= BASE_POLL_INTERVAL_MS);
    }
  });
});
