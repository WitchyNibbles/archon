import test from "node:test";
import assert from "node:assert/strict";

import {
  SECRET_KEYWORDS,
  SECRET_KEYWORD_ALTERNATION,
  CODE_ADJACENT_WORDS,
  CODE_ADJACENT_KEYWORD_ALTERNATION,
  CANONICAL_BARE_SECRET_KEYWORD_FLAGS,
  CANONICAL_BARE_SECRET_KEYWORD_ALTERNATION
} from "../src/admin/why-redaction-keywords.ts";

// ---------------------------------------------------------------------------
// SECRET_KEYWORD_ALTERNATION — best-effort, separator-tolerant RECOGNITION
// (round 11, widened round 12). This is stage-1 VALUE-redaction coverage
// only, not a security boundary — see admin-why-redaction.test.ts for the
// end-to-end behavior through sanitizeFreeText, and why-redaction.ts's
// module header for why a recognition miss here is safe by construction.
// ---------------------------------------------------------------------------

test("SECRET_KEYWORD_ALTERNATION matches every canonical keyword unsplit", () => {
  const pattern = new RegExp(`^(?:${SECRET_KEYWORD_ALTERNATION})$`, "i");
  for (const keyword of SECRET_KEYWORDS) {
    assert.equal(pattern.test(keyword), true, `canonical keyword "${keyword}" must match its own alternation`);
  }
});

test("SECRET_KEYWORD_ALTERNATION tolerates a bounded run (0-3) of hyphens or underscores between any two letters", () => {
  const pattern = new RegExp(`^(?:${SECRET_KEYWORD_ALTERNATION})$`, "i");
  assert.equal(pattern.test("pass-word"), true);
  assert.equal(pattern.test("pass_word"), true);
  assert.equal(pattern.test("pass--word"), true, "round-12: two separators must also be tolerated");
  assert.equal(pattern.test("pass___word"), true, "round-12: three separators must also be tolerated");
  assert.equal(pattern.test("pass-_-word"), true, "round-12: a mixed dash/underscore run must be tolerated");
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

// ---------------------------------------------------------------------------
// CODE_ADJACENT_WORDS / CODE_ADJACENT_KEYWORD_ALTERNATION — round-12 MEDIUM
// fix (finding 3): this scoped, deliberately-separate list now lives here
// too, instead of as a hand-written duplicate in why-redaction.ts.
// ---------------------------------------------------------------------------

test("CODE_ADJACENT_KEYWORD_ALTERNATION matches every word in CODE_ADJACENT_WORDS unsplit", () => {
  const pattern = new RegExp(`^(?:${CODE_ADJACENT_KEYWORD_ALTERNATION})$`, "i");
  for (const word of CODE_ADJACENT_WORDS) {
    assert.equal(pattern.test(word), true, `"${word}" must match its own alternation`);
  }
});

test("CODE_ADJACENT_WORDS is deliberately distinct from SECRET_KEYWORDS ('verification' is not a bare secret-flag keyword)", () => {
  assert.equal(CODE_ADJACENT_WORDS.includes("verification"), true);
  assert.equal((SECRET_KEYWORDS as readonly string[]).includes("verification"), false);
});

// ---------------------------------------------------------------------------
// CANONICAL_BARE_SECRET_KEYWORD_FLAGS / _ALTERNATION — round-12 CRITICAL
// fix: the fail-closed allowlist. Deliberately EXACT, not separator-
// tolerant — recognition looseness has no place in a positive trust grant.
// ---------------------------------------------------------------------------

test("CANONICAL_BARE_SECRET_KEYWORD_ALTERNATION matches every listed canonical spelling exactly", () => {
  const pattern = new RegExp(`^(?:${CANONICAL_BARE_SECRET_KEYWORD_ALTERNATION})$`, "i");
  for (const flag of CANONICAL_BARE_SECRET_KEYWORD_FLAGS) {
    assert.equal(pattern.test(flag), true, `"${flag}" must match its own alternation`);
  }
});

test("CANONICAL_BARE_SECRET_KEYWORD_ALTERNATION is exact — separator or digit mutations of a canonical spelling must NOT match", () => {
  const pattern = new RegExp(`^(?:${CANONICAL_BARE_SECRET_KEYWORD_ALTERNATION})$`, "i");
  assert.equal(pattern.test("pass-word"), false, "a hyphen split must not match — recognition looseness is not a trust grant");
  assert.equal(pattern.test("p4ssword"), false, "a digit-interposed mutation must not match");
  assert.equal(pattern.test("password-extra"), false, "extra glued content must not match");
});

test("CANONICAL_BARE_SECRET_KEYWORD_FLAGS includes both hyphenated and joined spellings of the two multi-word flags", () => {
  assert.equal(CANONICAL_BARE_SECRET_KEYWORD_FLAGS.includes("api-key"), true);
  assert.equal(CANONICAL_BARE_SECRET_KEYWORD_FLAGS.includes("apikey"), true);
  assert.equal(CANONICAL_BARE_SECRET_KEYWORD_FLAGS.includes("access-key"), true);
  assert.equal(CANONICAL_BARE_SECRET_KEYWORD_FLAGS.includes("accesskey"), true);
});

test("CANONICAL_BARE_SECRET_KEYWORD_FLAGS is the single canonical source (no accidental duplicate entries)", () => {
  const unique = new Set(CANONICAL_BARE_SECRET_KEYWORD_FLAGS);
  assert.equal(unique.size, CANONICAL_BARE_SECRET_KEYWORD_FLAGS.length, "must not contain duplicates");
});
