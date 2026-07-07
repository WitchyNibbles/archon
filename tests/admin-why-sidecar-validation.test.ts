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

test("validateUuid: a real UUID passes through", () => {
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  assert.equal(validateUuid(uuid), uuid);
});

test("validateUuid: an attacker-controlled secret-shaped string is rejected", () => {
  assert.equal(validateUuid("hunter2Aa1SuperSecret9"), undefined);
});
