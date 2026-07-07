import test from "node:test";
import assert from "node:assert/strict";

import { SECRET_KEYWORDS, SECRET_KEYWORD_ALTERNATION } from "../src/admin/why-redaction-keywords.ts";

// ---------------------------------------------------------------------------
// Round-11 CRITICAL fix: SECRET_KEYWORD_ALTERNATION is the ONE shared,
// separator-tolerant source every keyword-consulting site in
// why-redaction.ts is built from. These tests exercise the exported regex
// source directly, independent of how any particular consuming site wraps
// it — see admin-why-redaction.test.ts for the end-to-end behavior through
// sanitizeFreeText.
// ---------------------------------------------------------------------------

test("SECRET_KEYWORD_ALTERNATION matches every canonical keyword unsplit", () => {
  const pattern = new RegExp(`^(?:${SECRET_KEYWORD_ALTERNATION})$`, "i");
  for (const keyword of SECRET_KEYWORDS) {
    assert.equal(pattern.test(keyword), true, `canonical keyword "${keyword}" must match its own alternation`);
  }
});

test("SECRET_KEYWORD_ALTERNATION tolerates a single hyphen or underscore between any two letters", () => {
  const pattern = new RegExp(`^(?:${SECRET_KEYWORD_ALTERNATION})$`, "i");
  assert.equal(pattern.test("pass-word"), true);
  assert.equal(pattern.test("pass_word"), true);
  assert.equal(pattern.test("to-ken"), true);
  assert.equal(pattern.test("se-cret"), true);
  assert.equal(pattern.test("au-th"), true);
  assert.equal(pattern.test("cred-ential"), true);
  assert.equal(pattern.test("api-key"), true);
  assert.equal(pattern.test("access-key"), true);
});

test("SECRET_KEYWORD_ALTERNATION as a substring search still requires the full keyword's letters in order", () => {
  const pattern = new RegExp(SECRET_KEYWORD_ALTERNATION, "i");
  // An ordinary English word that merely shares a PREFIX with a keyword must
  // not match — "author" starts with "auth" but is not itself the keyword,
  // and the boundary is enforced by callers via `\b...\b`, not by this
  // source fragment alone (this test documents that division of concerns).
  assert.equal(pattern.test("hunter2Aa1Zz9"), false, "an ordinary secret-shaped value must not itself look like a keyword");
});

test("SECRET_KEYWORDS is the single canonical source (no accidental duplicate entries)", () => {
  const unique = new Set(SECRET_KEYWORDS);
  assert.equal(unique.size, SECRET_KEYWORDS.length, "SECRET_KEYWORDS must not contain duplicates");
});
