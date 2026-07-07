import test from "node:test";
import assert from "node:assert/strict";

import { isBoundedSafeShape, isSafeValueShape, classifyUrlToken } from "../src/admin/why-redaction-shapes.ts";

// ---------------------------------------------------------------------------
// Round-14: these shape checks were extracted from why-redaction.ts into
// their own module to give it real ratchet headroom. Direct unit coverage
// here, independent of the end-to-end sanitizeFreeText tests in
// admin-why-redaction.test.ts.
// ---------------------------------------------------------------------------

test("isBoundedSafeShape: a UUID is safe with no vocabulary", () => {
  assert.equal(isBoundedSafeShape("a1b2c3d4-e5f6-7890-abcd-ef1234567890", new Set()), true);
});

test("isBoundedSafeShape: an ISO timestamp is safe with no vocabulary", () => {
  assert.equal(isBoundedSafeShape("2026-07-04T12:34:56.789Z", new Set()), true);
});

test("isBoundedSafeShape: an ordinary secret-shaped token is unsafe with no vocabulary, safe as a vocabulary member", () => {
  assert.equal(isBoundedSafeShape("hunter2Aa1", new Set()), false);
  assert.equal(isBoundedSafeShape("hunter2Aa1", new Set(["hunter2Aa1"])), true);
});

test("isSafeValueShape: a bare path with every segment vocabulary-known is safe", () => {
  assert.equal(isSafeValueShape("src/admin/why-redaction.ts", new Set(["src", "admin", "why-redaction.ts"])), true);
});

test("isSafeValueShape: a bare path with an unknown segment is unsafe wholesale", () => {
  assert.equal(isSafeValueShape("src/admin/hunter2Aa1", new Set(["src", "admin"])), false);
});

test("classifyUrlToken: a credential-free URL with an unsafe query token collapses the path+query wholesale", () => {
  assert.equal(classifyUrlToken("https://api.github.com/repos/owner/repo", new Set()), "https://api.github.com/[redacted]");
});

test("classifyUrlToken: a credential-free URL with every path token vocabulary-known survives whole", () => {
  const url = "https://api.github.com/repos/owner/repo";
  const vocab = new Set(["repos", "owner", "repo"]);
  assert.equal(classifyUrlToken(url, vocab), url);
});

test("classifyUrlToken: a non-URL-shaped token returns undefined (caller falls through)", () => {
  assert.equal(classifyUrlToken("not-a-url", new Set()), undefined);
});
