/**
 * Unit tests for the dashQuality S1 snapshot-age color escalation (C11).
 *
 * `snapshotAgeColor` is a pure function in the isolated web/ workspace; it has no
 * React/DOM dependency, so it is unit-tested here with the root node:test runner.
 * (Root tsconfig excludes tests/, and `import type` is erased at runtime, so this
 * does not couple the web workspace's typecheck to the root — the R2-C web→src
 * wall, which is one-directional, is unaffected.)
 *
 * C11 thresholds: <5min secondary · 5–60min (inclusive) warning · >60min error.
 *
 * Run: node --experimental-strip-types --test tests/dash-snapshot-age.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { snapshotAgeColor } from "../web/src/utils/snapshotAge.ts";

const SECONDARY = "var(--text-secondary)";
const WARNING = "var(--status-warning-text)";
const ERROR = "var(--status-error-text)";

describe("snapshotAgeColor — C11 stale-color escalation", () => {
  it("fresh (< 5 min) → secondary, no alarm", () => {
    assert.equal(snapshotAgeColor(0), SECONDARY);
    assert.equal(snapshotAgeColor(4), SECONDARY);
    assert.equal(snapshotAgeColor(4.99), SECONDARY);
  });

  it("5 min boundary (inclusive) → warning", () => {
    assert.equal(snapshotAgeColor(5), WARNING);
  });

  it("5–60 min, 60 inclusive → warning", () => {
    assert.equal(snapshotAgeColor(30), WARNING);
    assert.equal(snapshotAgeColor(59), WARNING);
    // The top threshold is exclusive: exactly 60 minutes is still warning, not error.
    assert.equal(snapshotAgeColor(60), WARNING);
  });

  it("strictly > 60 min → error", () => {
    assert.equal(snapshotAgeColor(60.01), ERROR);
    assert.equal(snapshotAgeColor(61), ERROR);
    assert.equal(snapshotAgeColor(1440), ERROR);
  });
});
