import test from "node:test";
import assert from "node:assert/strict";

import { validateEnumMember, validateIsoTimestamp, validateUuid } from "../src/admin/why-sidecar-validation.ts";

// ---------------------------------------------------------------------------
// Round-14 CRITICAL fix: read-time validation for sidecar fields. Sidecars
// are attacker-shapeable files on disk; these functions are the boundary
// that establishes trust, never the disk content itself.
// ---------------------------------------------------------------------------

test("validateEnumMember: an exact member of the allowed set passes through", () => {
  assert.equal(validateEnumMember("registered", ["registered", "handoff_written"]), "registered");
});

test("validateEnumMember: an attacker-controlled secret-shaped string is rejected", () => {
  assert.equal(validateEnumMember("hunter2Aa1SuperSecret9", ["registered", "handoff_written"]), undefined);
});

test("validateEnumMember: undefined input passes through as undefined", () => {
  assert.equal(validateEnumMember(undefined, ["registered", "handoff_written"]), undefined);
});

test("validateIsoTimestamp: a real ISO-8601 timestamp passes through", () => {
  const ts = "2026-07-07T00:00:00.000Z";
  assert.equal(validateIsoTimestamp(ts), ts);
});

test("validateIsoTimestamp: an attacker-controlled secret-shaped string is rejected", () => {
  assert.equal(validateIsoTimestamp("hunter2Aa1SuperSecret9"), undefined);
});

test("validateIsoTimestamp: a shape-matching but semantically invalid date is rejected", () => {
  assert.equal(validateIsoTimestamp("2026-13-40T99:99:99Z"), undefined);
});

// Round-15 MEDIUM fix: Date.parse silently NORMALIZES an out-of-range day
// instead of rejecting it (Feb 30 becomes March 2) — the round-trip
// (re-serialize + exact-compare) is what actually catches this, not
// Date.parse's non-NaN check alone.
test("validateIsoTimestamp: day overflow (Feb 30) silently normalizes under Date.parse alone but is rejected by the round-trip check", () => {
  const feb30 = "2026-02-30T00:00:00.000Z";
  assert.equal(Number.isNaN(Date.parse(feb30)), false, "Date.parse must NOT report NaN for this input (that is exactly the bug)");
  assert.equal(validateIsoTimestamp(feb30), undefined);
});

test("validateIsoTimestamp: a valid leap day (2028-02-29, a real leap year) round-trips and is accepted", () => {
  const leapDay = "2028-02-29T00:00:00.000Z";
  assert.equal(validateIsoTimestamp(leapDay), leapDay);
});

test("validateUuid: a real UUID passes through", () => {
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  assert.equal(validateUuid(uuid), uuid);
});

test("validateUuid: an attacker-controlled secret-shaped string is rejected", () => {
  assert.equal(validateUuid("hunter2Aa1SuperSecret9"), undefined);
});
