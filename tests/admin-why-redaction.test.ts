import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeFreeText,
  truncateForDisplay,
  sanitizeForDisplay,
  tokenizeToVocabulary,
  MAX_SANITIZE_INPUT_LENGTH
} from "../src/admin/why-redaction.ts";

// ---------------------------------------------------------------------------
// Round-5 vocabulary anchoring: "a generic identifier SHAPE can never be
// safe, because real tokens look exactly like our ids" — the gate's own
// ruling. Rounds 2-4 each patched a shape-hunting/shape-allowlisting scrubber
// and each left a bypass (compound env-vars, then JSON-shaped secrets, then
// bare-prose secrets that merely LOOKED like a safe identifier). This suite
// proves the vocabulary-anchored model both directions: every adversarial
// fixture (including round 5's own bare-prose probes) must redact regardless
// of vocabulary; every legitimate free-text shape must survive ONLY when
// backed by an explicit vocabulary (or a flag name / ISO timestamp / UUID, or
// a path/URL every one of whose segments/tokens independently passes those
// same checks — round-8 TERMINAL DESIGN: there is no bare-number shape
// exemption anymore; see why-redaction.ts's module header).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Adversarial fixtures — rounds 2, 3, 4, and round 5's own probes. Every one
// must have its secret payload fully absent from output, called with NO
// vocabulary (the strictest, default case) — proving stage-1 markers and the
// vocabulary-anchored default-deny both hold with zero context supplied.
// ---------------------------------------------------------------------------

const ADVERSARIAL_FIXTURES: Array<{ name: string; text: string; secret: string }> = [
  { name: "JSON-shaped secret", text: '{"password":"hunter2Aa1!"}', secret: "hunter2Aa1!" },
  {
    name: "nested/JS-object-shaped secret",
    text: '{"user": {"password": "hunter2Aa1!"}}',
    secret: "hunter2Aa1!"
  },
  {
    name: "curl basic auth",
    text: "curl -u archon:hunter2Aa1! https://api.example.com",
    secret: "hunter2Aa1!"
  },
  {
    name: "mysqldump concatenated -p flag",
    text: "mysqldump -pSuperSecret123 -u root mydb",
    secret: "SuperSecret123"
  },
  {
    name: "mongodb+srv URL",
    text: "mongodb+srv://archon:hunter2Aa1!@cluster0.example.mongodb.net/db",
    secret: "hunter2Aa1!"
  },
  {
    name: "AWS access key id",
    text: "backup key is AKIAIOSFODNN7EXAMPLE for this job",
    secret: "AKIAIOSFODNN7EXAMPLE"
  },
  { name: "compound env-var PGPASSWORD", text: "PGPASSWORD=hunter2Aa1! psql -h db.internal", secret: "hunter2Aa1!" },
  { name: "compound env-var MYSQL_PWD", text: "MYSQL_PWD=letmein123 mysql -u root", secret: "letmein123" },
  {
    name: "Postgres basic-auth URL",
    text: 'psql "postgresql://archon:hunter2Aa1!@db.internal:5432/archon"',
    secret: "hunter2Aa1!"
  },
  {
    name: "Authorization Bearer header",
    text: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"',
    secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
  },
  // Round-5 CRITICAL fixtures: bare credentials in ordinary prose that
  // shape-matched the round-4 generic-identifier allowlist and survived.
  { name: "bare GitHub PAT in prose", text: "token ghp_1234567890abcdefghijklmnopqrstuvwxyz is invalid", secret: "ghp_1234567890abcdefghijklmnopqrstuvwxyz" },
  { name: "bare password in prose (no label, no colon)", text: "password is hunter2Aa1", secret: "hunter2Aa1" },
  { name: "Stripe-style live key prefix", text: "using key sk_live_51H8xyzABCDEFGHIJKLMN in prod", secret: "sk_live_51H8xyzABCDEFGHIJKLMN" },
  { name: "Anthropic API key prefix", text: "export ANTHROPIC_API_KEY=sk-ant-api03-fakekeyfortest0000", secret: "sk-ant-api03-fakekeyfortest0000" },
  { name: "npm token prefix", text: "auth token npm_abcdefghijklmnopqrstuvwxyz0123456789 leaked", secret: "npm_abcdefghijklmnopqrstuvwxyz0123456789" },
  // Round-6 HIGH fixtures: the gate's own live probes — an unbounded numeric
  // secret shape-matched the round-5 `SAFE_NUMBER` allowlist and survived.
  {
    name: "long numeric token after a space-separated --token flag",
    text: "--token 837215098172340192",
    secret: "837215098172340192"
  },
  {
    name: "bare long numeric secret in prose, no flag",
    text: "the secret value is 98765432109876543210",
    secret: "98765432109876543210"
  },
  {
    name: "7-digit OTP after --token (short enough to tempt a lax bound, still redacts)",
    text: "--token 8372150",
    secret: "8372150"
  },
  // Round-7 CRITICAL fixtures: the round-6 SAFE_NUMBER bound only capped the
  // integer part — the fractional group was still unbounded, so a decimal
  // secret shape-matched and survived whole.
  {
    name: "round-7 CRITICAL: decimal secret in prose (long fraction, short-looking integer part)",
    text: "the secret value is 9.87215098172340192",
    secret: "9.87215098172340192"
  },
  {
    name: "round-7 CRITICAL: bare decimal secret, no surrounding label",
    text: "9.87215098172340192",
    secret: "9.87215098172340192"
  },
  {
    name: "round-7 CRITICAL: long-fraction variant with a 1-digit integer part",
    text: "value 1.234567890123456789",
    secret: "1.234567890123456789"
  },
  // Round-7 HIGH fixtures: the gate's own four live probes for the keyword
  // list gap ("code" collision avoided via compound-phrase scoping; pin/otp
  // added directly; prose "<keyword> is <value>" adjacency).
  { name: "round-7 HIGH: compound code-phrase label, colon-joined", text: "OTP code: 482913", secret: "482913" },
  { name: "round-7 HIGH: --pin flag value", text: "--pin 482913", secret: "482913" },
  { name: "round-7 HIGH: --otp flag value", text: "--otp 482913", secret: "482913" },
  { name: "round-7 HIGH: prose keyword-adjacency, no flag, no colon", text: "your otp is 482913", secret: "482913" },
  // Round-7 HIGH: the remaining new keywords (passphrase, mfa, passcode,
  // cvv), each proven wired into both the colon/equals and space-separated
  // stage-1 rules.
  { name: "round-7 HIGH: --passphrase flag value", text: "--passphrase hunter2Aa1", secret: "hunter2Aa1" },
  { name: "round-7 HIGH: --mfa flag value", text: "--mfa 482913", secret: "482913" },
  { name: "round-7 HIGH: --passcode flag value", text: "--passcode 482913", secret: "482913" },
  { name: "round-7 HIGH: cvv colon-joined field", text: "cvv: 123", secret: "123" },
  // Round-8 finding 5: the gate's entire round-7 probe list, encoded here.
  // NONE of the labels below ("2FA", "code", "recovery", "backup",
  // "security", "activation", "session", "CVC", "TOTP", "PIN number") is a
  // recognized keyword in SECRET_KEYWORD_ALTERNATION or CODE_ADJACENT_KEYWORD_ALTERNATION
  // — every one of these redacts purely because a bare number no longer
  // survives by shape at all (round-8 finding 1), proving the keyword layer
  // is genuinely non-load-bearing for this entire probe class.
  { name: "round-8 probe: 2FA colon-joined", text: "2FA: 482913", secret: "482913" },
  { name: "round-8 probe: bare --code flag (never a recognized keyword)", text: "--code 482913", secret: "482913" },
  { name: "round-8 probe: recovery code colon-joined", text: "recovery code: 482913", secret: "482913" },
  { name: "round-8 probe: backup code colon-joined", text: "backup code: 482913", secret: "482913" },
  { name: "round-8 probe: security code colon-joined", text: "security code: 482913", secret: "482913" },
  { name: "round-8 probe: activation code colon-joined", text: "activation code: 482913", secret: "482913" },
  {
    name: "round-8 probe: license key colon-joined (alphanumeric — already closed by round-5 default-deny)",
    text: "license key: XYZ123ABC9",
    secret: "XYZ123ABC9"
  },
  { name: "round-8 probe: session id colon-joined", text: "session id: 482913", secret: "482913" },
  { name: "round-8 probe: CVC colon-joined", text: "CVC: 123", secret: "123" },
  { name: "round-8 probe: bare CVC, no colon", text: "CVC 482913", secret: "482913" },
  { name: "round-8 probe: TOTP colon-joined", text: "TOTP: 482913", secret: "482913" },
  { name: "round-8 probe: TOTP prose adjacency", text: "TOTP is 482913", secret: "482913" },
  { name: "round-8 probe: PIN number colon-joined", text: "PIN number: 482913", secret: "482913" },
  { name: "round-8 probe: PIN number prose adjacency", text: "PIN number is 482913", secret: "482913" },
  {
    name: "round-8 probe: recovery code prose adjacency, no flag, no colon",
    text: "your recovery code is 482913",
    secret: "482913"
  },
  // Round-9 LOW finding 2: 3 named round-7 probe-list phrasings that were
  // never actually encoded as fixtures despite being explicitly named by the
  // round-7 gate alongside the ones above — "card verification value" (the
  // full spelled-out phrase, distinct from the CVC/cvv abbreviation already
  // covered), the "--2fa" flag form (distinct from the "2FA:" colon form
  // already covered), and the bare space-separated "PIN number 482913" (no
  // colon, no "is" — distinct from both the colon-joined and prose-adjacency
  // "PIN number" forms already covered, and explicitly called out by the
  // round-7 gate's own consistency finding as its own case).
  { name: "round-9 probe: card verification value, colon-joined", text: "card verification value: 482913", secret: "482913" },
  { name: "round-9 probe: --2fa flag", text: "--2fa 482913", secret: "482913" },
  { name: "round-9 probe: bare PIN number, space-separated, no colon, no \"is\"", text: "PIN number 482913", secret: "482913" }
];

for (const fixture of ADVERSARIAL_FIXTURES) {
  test(`sanitizeFreeText redacts: ${fixture.name}`, () => {
    const result = sanitizeFreeText(fixture.text);
    assert.equal(result.includes(fixture.secret), false, `secret leaked: ${result}`);
  });
}

// Property-style test (round-5 LOW fix — the round-4 version generated one
// `test()` per fixture PLUS a second loop restating the same assertion,
// which the gate correctly called "two tests", not one. This is now the ONLY
// aggregate check: a single real loop over the fixture list, so a future
// fixture added to the array is automatically covered without a new test
// needing to be written, and without a redundant per-fixture test alongside it.
test("property: no adversarial fixture's secret substring survives sanitizeFreeText, called with no vocabulary", () => {
  for (const fixture of ADVERSARIAL_FIXTURES) {
    const result = sanitizeFreeText(fixture.text);
    assert.equal(
      result.includes(fixture.secret),
      false,
      `${fixture.name}: secret substring "${fixture.secret}" survived in "${result}"`
    );
  }
});

// ---------------------------------------------------------------------------
// Pass-direction, vocabulary-gated: a token that shape-matches an "ordinary
// identifier" survives ONLY when the caller's vocabulary vouches for it — NOT
// because of its shape alone (round-5 CRITICAL fix). Both directions proven
// on the SAME token.
// ---------------------------------------------------------------------------

test("pass-direction: a task id survives when it IS in the supplied vocabulary", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  assert.equal(sanitizeFreeText(taskId, new Set([taskId])), taskId);
});

test("CRITICAL fix, both directions: the SAME shaped token redacts with no vocabulary, survives with it", () => {
  const token = "hunter2Aa1";
  assert.equal(sanitizeFreeText(token), "[redacted]", "no vocabulary → generic identifier shape is NOT enough");
  assert.equal(sanitizeFreeText(token, new Set([token])), token, "vocabulary membership → survives");
});

test("pass-direction: a task id after a space-separated CLI flag survives when flag words + id are vocabulary", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  const line = "npx tsx ./src/admin.ts status --task-id " + taskId;
  // Round-8: "./src/admin.ts" is path-shaped but no longer blanket-safe by
  // shape — it needs vocabulary backing. In real usage `tokenizeToVocabulary`
  // adds it as ONE WHOLE STRING (it contains no whitespace) straight from the
  // literal `RECOMMENDED_COMMANDS` template that produced this exact line, so
  // it is included here as a whole-string entry, not per-segment. Round-12:
  // `--task-id` is no longer safe by "no keyword substring" shape alone (the
  // inversion) — it survives here because it too is a literal token inside
  // `RECOMMENDED_COMMANDS`'s own templates, exactly like `RECOMMENDED_
  // COMMANDS`'s real vocabulary already includes it via `buildKnownVocabulary`.
  const vocabulary = new Set(["npx", "tsx", "./src/admin.ts", "status", "--task-id", taskId]);
  assert.equal(sanitizeFreeText(line, vocabulary), line);
});

test("pass-direction: a task id after an =-joined CLI flag survives via the flag-value split when the flag is vocabulary-known", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  const line = `--task-id=${taskId}`;
  // Round-12: the flag half is no longer safe by shape alone — it must be an
  // exact `knownSafeTokens` member (as `--task-id` is, via `RECOMMENDED_
  // COMMANDS`'s own templates in real usage) or a canonical keyword spelling.
  assert.equal(sanitizeFreeText(line, new Set(["--task-id", taskId])), line);
  assert.notEqual(sanitizeFreeText(line), line, "without vocabulary backing, the whole token redacts");
});

test("pass-direction: a recommended-command-shaped line with flags + a vocabulary-known task id survives intact", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  const line = `npx tsx ./src/admin.ts status --task-id ${taskId}`;
  assert.equal(sanitizeFreeText(line, new Set(["npx", "tsx", "./src/admin.ts", "status", "--task-id", taskId])), line);
});

// ---------------------------------------------------------------------------
// Pass-direction, structural shapes still safe by shape alone (round-8:
// UUID and ISO timestamp only — flag names are covered separately below).
// ---------------------------------------------------------------------------

test("pass-direction: a UUID survives with no vocabulary", () => {
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  assert.equal(sanitizeFreeText(uuid), uuid);
});

test("pass-direction (round-5 fix): an ISO-8601 timestamp survives with no vocabulary", () => {
  const timestamp = "2026-07-04T12:34:56.789Z";
  assert.equal(sanitizeFreeText(timestamp), timestamp);
});

// ---------------------------------------------------------------------------
// Round-8 TERMINAL DESIGN: paths and URLs are TOKENIZED, not blanket-exempt.
// A path survives WHOLE only if every "/"-separated segment is a vocabulary
// member or a bounded safe shape (UUID/ISO-timestamp); otherwise the ENTIRE
// token redacts. Both directions proven on the SAME shapes that round 5/6
// previously granted a blanket pass to with NO vocabulary at all.
// ---------------------------------------------------------------------------

test("round-8 BOTH DIRECTIONS: an absolute file path redacts wholesale with no vocabulary, survives as a whole-string vocabulary member", () => {
  const filePath = "/home/eimi/projects/archon/.archon/work/daemon/hook-blocker-state-verification.json";
  assert.equal(sanitizeFreeText(filePath), "[redacted]", "no vocabulary → path is no longer blanket-safe by shape");
  assert.equal(
    sanitizeFreeText(filePath, new Set([filePath])),
    filePath,
    "whole-string vocabulary membership → survives (the real relief valve: a collector-constructed sidecar path is added as ONE STRING)"
  );
});

test("round-8 BOTH DIRECTIONS: a bare relative path redacts wholesale with no vocabulary, survives when every segment is vocabulary/shape-safe", () => {
  const filePath = "src/admin/why-redaction.ts";
  assert.equal(sanitizeFreeText(filePath), "[redacted]", "no vocabulary → redacts wholesale");
  // Per-segment vocabulary (as opposed to whole-string membership) also
  // works — every "/"-separated piece must individually pass.
  assert.equal(sanitizeFreeText(filePath, new Set(["src", "admin", "why-redaction.ts"])), filePath);
});

test("round-8: a path with ONE unsafe segment redacts the WHOLE token, not just the bad segment", () => {
  const path = "logs/hunter2Aa1notASafeShape";
  const result = sanitizeFreeText(path, new Set(["logs"]));
  assert.equal(result.includes("hunter2Aa1notASafeShape"), false);
  assert.equal(result, "[redacted]", "one bad segment redacts the entire path, never a partial `logs/[redacted]`");
});

test("round-8: a path segment that is UUID-shaped counts as a bounded safe shape, mixed with a vocabulary segment", () => {
  // Note: an ISO timestamp is NOT usable as a path segment here — timestamps
  // contain `:`, and the path shape gate deliberately excludes `:` (it is one
  // of the two characters that signal a credential-bearing URL/connection-
  // string shape). A UUID segment has no such conflict.
  const path = "requests/a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  assert.equal(sanitizeFreeText(path, new Set(["requests"])), path);
});

test("round-5 MEDIUM fix retained: a URL WITH userinfo still redacts (stage 1, unaffected by round-8's stage-2 rework)", () => {
  const url = "https://archon:hunter2Aa1!@api.example.com/path";
  const result = sanitizeFreeText(url);
  assert.equal(result.includes("hunter2Aa1!"), false);
  assert.match(result, /^https:\/\/\[redacted\]$/);
});

test("pass-direction: a bare scheme://authority URL with NO path at all survives with no vocabulary", () => {
  const url = "https://api.github.com";
  assert.equal(sanitizeFreeText(url), url, "nothing after the authority — nothing to redact");
});

test("round-8 BOTH DIRECTIONS: a credential-free URL's path+query collapses wholesale with no vocabulary, survives when every path/query token is vocabulary/shape-safe", () => {
  const url = "https://api.github.com/repos/owner/repo";
  assert.equal(
    sanitizeFreeText(url),
    "https://api.github.com/[redacted]",
    "no vocabulary → path+query collapses wholesale, authority (scheme+host) is kept"
  );
  assert.equal(sanitizeFreeText(url, new Set(["repos", "owner", "repo"])), url);
});

test("round-8 supersedes round-6's query-string-email fix: without vocabulary, a query value redacts along with the rest of the path+query", () => {
  // Round 6 fixed this specific URL to survive so an unrelated `@` (a query-
  // string email) didn't over-redact the whole URL by shape alone. Round 8's
  // terminal design is stricter: an unlabeled, non-vocabulary token anywhere
  // in a URL's path/query is now treated the same as any other free-text
  // token — it must be vouched for, or the whole path+query collapses. This
  // is the accepted, disclosed trade-off (see the module header): the
  // authority survives, the content after it does not, unless vouched for.
  const url = "https://x.example.com/search?email=foo@bar.com";
  assert.equal(sanitizeFreeText(url), "https://x.example.com/[redacted]");
});

// ---------------------------------------------------------------------------
// Round-9 CRITICAL fix: `classifyToken`'s old blanket
// `core.includes("[redacted]")` short-circuit treated ANY partial stage-1
// redaction inside a token as whole-token clearance, skipping stage 2 (URL
// tokenization, path-segment checks, the catch-all) entirely. A token that
// mixes already-redacted stage-1 content with UNTOUCHED live secret content,
// glued together with no whitespace, used to leak the untouched portion in
// full. The fix narrows the short-circuit to an EXACT match on `[redacted]`,
// so a partially-redacted token always falls through to full re-analysis.
// ---------------------------------------------------------------------------

test("round-9 CRITICAL: the gate's own live repro — a URL query string with one stage-1-caught secret and one untouched secret, glued with no whitespace", () => {
  const url = "https://x.com/callback?state=xK9pQ7mZvL3nR8tYbW2cAe&password=hunter2Aa1";
  const result = sanitizeFreeText(url);
  assert.equal(result.includes("xK9pQ7mZvL3nR8tYbW2cAe"), false, `the untouched "state" secret must not survive: ${result}`);
  assert.equal(result.includes("hunter2Aa1"), false, `the stage-1-caught "password" secret must not survive either: ${result}`);
});

test("round-9 CRITICAL: hyphen-joined-blob variant — a bounded stage-1 match (AWS key id) glued via a hyphen to an untouched secret in the SAME token", () => {
  // WELL_KNOWN_SECRET_PREFIX_PATTERN / AWS_KEY_ID_PATTERN are bounded to
  // `[A-Z0-9]`/`[A-Za-z0-9_-]` character classes, so a stage-1 match against
  // an all-uppercase AWS key id stops cleanly at the hyphen, leaving the
  // remainder glued to the resulting "[redacted]" marker with no whitespace
  // in between — the exact "partial substring, non-URL" shape the gate's
  // repro targets, distinct from the URL-tokenized case above.
  const text = "AKIAIOSFODNN7EXAMPLE-anotherSecretRightHere";
  const result = sanitizeFreeText(text);
  assert.equal(result.includes("AKIAIOSFODNN7EXAMPLE"), false, `the stage-1-caught AWS key id must not survive: ${result}`);
  assert.equal(result.includes("anotherSecretRightHere"), false, `the untouched hyphen-glued remainder must not survive: ${result}`);
});

test("round-9 CRITICAL: a token that IS exactly the [redacted] marker still short-circuits (no change in behavior for the fully-redacted case)", () => {
  // "--token" survives as a flag name; its value is fully consumed by stage 1
  // into the bare "[redacted]" token, which must still short-circuit cleanly
  // (an exact-match core), proving the narrowed guard didn't regress the
  // common single-word-secret case this guard was originally written for.
  const result = sanitizeFreeText("--token 123456");
  assert.equal(result, "--token [redacted]");
});

// ---------------------------------------------------------------------------
// Round-9 HIGH fix: stage 1 (`applySecretMarkerRules`) had no visibility into
// `knownSafeTokens` at all, so its value-redacting rules force-redacted ANY
// value adjacent to a keyword, even a legitimate vocabulary member. Both
// directions on the SAME text, proving the vocabulary now wins even in a
// keyword-adjacent position.
// ---------------------------------------------------------------------------

test("round-9 HIGH, both directions: a vocabulary-member value next to a keyword survives; a non-vocabulary value in the same position still redacts", () => {
  const text = "password task-abc123";
  const noVocabResult = sanitizeFreeText(text);
  // Without a vocabulary, the value redacts (as it always has) — AND, per
  // round 5's disclosed friction, so does the bare label word "password"
  // itself at stage 2 (ordinary English prose, not a vocabulary member).
  // The load-bearing assertion here is the ABSENCE of the secret value.
  assert.equal(noVocabResult.includes("task-abc123"), false, `no vocabulary → the value must still redact: ${noVocabResult}`);
  const vocabResult = sanitizeFreeText(text, new Set(["task-abc123"]));
  assert.equal(vocabResult, "[redacted] task-abc123", "a vocabulary-member value survives even directly adjacent to a keyword, at stage 1 already");
});

test("round-9 HIGH: the same vocabulary-blindness fix holds for a colon-joined labeled field", () => {
  const vocabResult = sanitizeFreeText("token: task-abc123", new Set(["task-abc123"]));
  assert.equal(vocabResult, "[redacted] task-abc123", "the value survives via the stage-1 vocabulary fix; the bare label word 'token' still redacts at stage 2 like any other non-vocabulary prose word");
  const noVocabResult = sanitizeFreeText("token: task-abc123");
  assert.equal(noVocabResult.includes("task-abc123"), false, "without vocabulary backing, the value still redacts");
});

// ---------------------------------------------------------------------------
// Round-10 MEDIUM: the round-9 vocabulary-threading fix was applied to all 6
// stage-1 value-capturing rules, but only 2 of them (PROSE_SECRET_KEYWORD_
// PATTERN, LABELED_FIELD_PATTERN) got dedicated regression tests. These 4
// tests close the gap for the remaining sites — SPACE_SEPARATED_SECRET_FLAG,
// LABELED_CODE_PHRASE_PATTERN, SPACE_SEPARATED_CODE_PHRASE_PATTERN, and
// MYSQL_CONCAT_PASSWORD_FLAG — each proven both directions on the same text.
// ---------------------------------------------------------------------------

test("round-10 MEDIUM: SPACE_SEPARATED_SECRET_FLAG is vocabulary-aware, both directions", () => {
  const noVocab = sanitizeFreeText("--token task-abc123");
  assert.equal(noVocab.includes("task-abc123"), false, "no vocabulary → the value still redacts");
  const vocab = sanitizeFreeText("--token task-abc123", new Set(["task-abc123"]));
  assert.equal(vocab, "--token task-abc123", "a vocabulary-member value survives the space-separated flag rule");
});

test("round-10 MEDIUM: LABELED_CODE_PHRASE_PATTERN is vocabulary-aware, both directions", () => {
  const noVocab = sanitizeFreeText("pin code: task-abc123");
  assert.equal(noVocab.includes("task-abc123"), false, "no vocabulary → the value still redacts");
  const vocab = sanitizeFreeText("pin code: task-abc123", new Set(["task-abc123"]));
  assert.equal(vocab.endsWith("task-abc123"), true, "a vocabulary-member value survives the colon-joined code-phrase rule");
});

test("round-10 MEDIUM: SPACE_SEPARATED_CODE_PHRASE_PATTERN is vocabulary-aware, both directions", () => {
  const noVocab = sanitizeFreeText("pin code task-abc123");
  assert.equal(noVocab.includes("task-abc123"), false, "no vocabulary → the value still redacts");
  const vocab = sanitizeFreeText("pin code task-abc123", new Set(["task-abc123"]));
  assert.equal(vocab.endsWith("task-abc123"), true, "a vocabulary-member value survives the space-separated code-phrase rule");
});

test("round-10/round-12: MYSQL_CONCAT_PASSWORD_FLAG threads knownSafeTokens at stage 1, but the glued flag+value token is wholesale-redacted at stage 2 either way (round-12 inversion, locked)", () => {
  const noVocab = sanitizeFreeText("mysqldump -ptask-abc123 -u root");
  assert.equal(noVocab.includes("task-abc123"), false, "no vocabulary → the concatenated -p value still redacts");
  // Round-12: `-ptask-abc123` is one GLUED, flag-shaped token — it is not
  // itself an exact `knownSafeTokens` member and is not a canonical keyword
  // spelling, so stage 2's positive-match-only rule redacts it WHOLESALE
  // even when the bare value alone (without the glued "-p") is vocabulary
  // -known. This is the same accepted trade-off as any other flag with no
  // canonical spelling — see the module header and design-history's
  // round-12 entry. Stage 1's vocabulary threading (round-9 fix) still runs
  // and is still correct at ITS layer; it is simply no longer the deciding
  // factor for the final rendered output once stage 2 re-evaluates the
  // resulting flag-shaped token.
  const vocab = sanitizeFreeText("mysqldump -ptask-abc123 -u root", new Set(["task-abc123", "mysqldump", "-u", "root"]));
  assert.equal(vocab, "mysqldump [redacted] -u root", "the glued -p flag+value redacts wholesale; surrounding vocabulary-known tokens are unaffected");
});

// ---------------------------------------------------------------------------
// Round-10 CRITICAL: `--firstSecretHere123-password verysecretvalue` glues a
// live secret to a recognized keyword via a hyphen, landing inside what used
// to be an UNBOUNDED label-capture prefix in stage 1 (never re-examined) and
// then trusted unconditionally by the old `SAFE_FLAG_NAME`'s dash-prefix-
// shape-alone grant at stage 2. Fixed on both ends: (a) the compound-keyword
// capture groups in LABELED_FIELD_PATTERN/SPACE_SEPARATED_SECRET_FLAG are now
// bounded to 12 chars each side, so an attempt to glue this much extra
// content simply fails to match at all (falls through untouched); (b)
// `isSafeFlagName` no longer blanket-trusts any dash-prefixed alnum-hyphen
// blob — a flag body is safe only if it IS, exactly, one recognized keyword
// (the designed `--token <value>` case) or contains no keyword substring at
// all. Anything else (a keyword with extra glued content on either side)
// falls through to ordinary default-deny.
// ---------------------------------------------------------------------------

test("round-10 CRITICAL: the gate's own live repro — a secret glued to a keyword via hyphen, inside what used to be an unbounded label prefix", () => {
  const result = sanitizeFreeText("--firstSecretHere123-password verysecretvalue");
  assert.equal(result.includes("firstSecretHere123"), false, `the glued-into-the-label secret must not survive: ${result}`);
  assert.equal(result.includes("verysecretvalue"), false, `the ordinary value-position secret must not survive either: ${result}`);
});

test("round-10 CRITICAL: hyphen-glued-AFTER variant — the secret trails the keyword instead of leading it", () => {
  const result = sanitizeFreeText("--password-secretHere value");
  assert.equal(result.includes("secretHere"), false, `the glued-after secret must not survive: ${result}`);
});

test("round-12 CRITICAL (fail-closed inversion): a flag with NO keyword content at all now ALSO redacts by default — only vocabulary or a canonical spelling survives", () => {
  // Rounds 10-11 trusted any flag body that didn't (recognizably) CONTAIN a
  // keyword — a fail-OPEN design that each round's gate defeated through a
  // new recognition gap. Round 12 inverted this: a flag survives only on a
  // POSITIVE match, so a flag with zero keyword content is no exception.
  assert.equal(sanitizeFreeText("--experimental-strip-types"), "[redacted]");
  assert.equal(sanitizeFreeText("--max-warnings"), "[redacted]");
  assert.equal(sanitizeFreeText("--preserve-env"), "[redacted]");
  // The escape hatch is unchanged: the SAME vocabulary mechanism every other
  // structured value already uses.
  assert.equal(sanitizeFreeText("--experimental-strip-types", new Set(["--experimental-strip-types"])), "--experimental-strip-types");
  assert.equal(
    sanitizeFreeText(
      "node --experimental-strip-types --test tests/admin-why-redaction.test.ts",
      new Set(["node", "--experimental-strip-types", "--test", "tests/admin-why-redaction.test.ts"])
    ),
    "node --experimental-strip-types --test tests/admin-why-redaction.test.ts"
  );
});

test("round-10 CRITICAL: a flag that IS exactly a recognized keyword still survives — the designed labeled-flag case is unaffected", () => {
  assert.equal(sanitizeFreeText("--token"), "--token");
  assert.equal(sanitizeFreeText("--password"), "--password");
  assert.equal(sanitizeFreeText("--api-key"), "--api-key");
  assert.equal(sanitizeFreeText("--pin 482913").startsWith("--pin "), true);
});

// ---------------------------------------------------------------------------
// Round-11 CRITICAL: splitting a recognized keyword with a single internal
// hyphen (`pass-word`, `to-ken`, `se-cret`, `au-th`, `cred-ential`) defeated
// BOTH stage-1 pattern recognition (all built from a literal, separator-free
// keyword alternation) AND the round-10 `isSafeFlagName` backstop
// (`SECRET_KEYWORD_ANYWHERE`/`BARE_SECRET_KEYWORD`, same literal
// alternation) — the whole flag body, including a glued live secret, sailed
// through as an inert "safe-looking" flag name. Root-cause fix: the keyword
// alternation itself (`why-redaction-keywords.ts`) is now separator-
// tolerant, so every site that consults it is fixed by one shared source,
// not a per-site patch. Every repro below must fully redact, both a
// mixed-case secret AND an all-lowercase, no-digit secret (finding 2's own
// residual concern: a keyword-segment plus non-word residue must never pass
// as a safe flag merely because it happens to be lowercase).
// ---------------------------------------------------------------------------

test("round-11 CRITICAL: hyphen-split keyword + glued secret must redact, one case per named keyword", () => {
  const repros = [
    "--pass-word-hunter2Aa1Zz9",
    "--to-ken-hunter2Aa1Zz9",
    "--se-cret-hunter2Aa1Zz9",
    "--au-th-hunter2Aa1Zz9",
    "--cred-ential-hunter2Aa1Zz9",
    "--api-key-hunter2Aa1Zz9",
    "--access-key-hunter2Aa1Zz9"
  ];
  for (const repro of repros) {
    const result = sanitizeFreeText(repro);
    assert.equal(result.includes("hunter2Aa1Zz9"), false, `${repro}: glued secret survived in "${result}"`);
  }
});

test("round-11 CRITICAL: hyphen-split keyword + all-lowercase, no-digit glued secret must still redact (the exact residual finding 2 warns about)", () => {
  const result = sanitizeFreeText("--pass-word-hunterbunny value");
  assert.equal(result.includes("hunterbunny"), false, `all-lowercase glued secret survived: ${result}`);
});

test("round-12 (supersedes round-11): a bare hyphen-split keyword is NO LONGER a positive match — it now redacts unless vocabulary-known", () => {
  // Round 11 treated `--pass-word` as legitimate because SEPARATOR-TOLERANT
  // RECOGNITION matched it against the keyword list. Round 12's fail-closed
  // allowlist (`CANONICAL_BARE_SECRET_KEYWORD_FLAGS`) is deliberately EXACT,
  // not separator-tolerant — recognition looseness has no place in a
  // POSITIVE trust grant (see why-redaction-keywords.ts). `--pass-word` is
  // not itself a canonical spelling, so it now redacts by default, same as
  // any other non-canonical flag; it still survives via `knownSafeTokens`.
  assert.equal(sanitizeFreeText("--pass-word"), "[redacted]");
  assert.equal(sanitizeFreeText("--to-ken"), "[redacted]");
  assert.equal(sanitizeFreeText("--pass-word", new Set(["--pass-word"])), "--pass-word");
});

// ---------------------------------------------------------------------------
// Round-11 MEDIUM: the round-10 backstop's over-redaction of benign compound
// flags is an ACCEPTED, DOCUMENTED trade-off (design choice (b) — see
// why-redaction.ts's module header and why-redaction-design-history.md's
// round-11 entry for why a shape-based exemption was rejected as
// unfalsifiable: `--auth-timeout` and a lowercase-only glued secret like
// `--auth-hunterbunny` are IDENTICAL by shape). These tests LOCK the current
// (over-redacting) behavior so a future change to it is a deliberate,
// reviewed decision, not a silent regression.
// ---------------------------------------------------------------------------

test("round-11 MEDIUM (locked trade-off): benign compound flags with an embedded keyword substring still redact wholesale", () => {
  const benignFlags = [
    "--token-refresh-interval",
    "--auth-timeout",
    "--tokenizer",
    "--secretless-mode",
    "--passwordless-login",
    "--auth-provider",
    "--credential-source"
  ];
  for (const flag of benignFlags) {
    assert.equal(sanitizeFreeText(flag), "[redacted]", `${flag}: expected the locked over-redaction trade-off, got a different result`);
  }
});

// Round-12 note: the former "control" case here (a compound flag with NO
// embedded keyword substring surviving unchanged) no longer exists as a
// distinct behavior — round 12's inversion redacts EVERY non-canonical flag
// uniformly, keyword-bearing or not. See the round-12 CRITICAL test above
// (fail-closed inversion) for the current, merged coverage of this case.

// ---------------------------------------------------------------------------
// Round-12 CRITICAL (finding 1, third recurrence): rounds 10-11 each widened
// keyword RECOGNITION and each left a bypass. Two-plus separators and an
// interposed digit defeated round-11's recognition entirely — but under the
// round-12 fail-closed inversion, a recognition MISS can only cause MORE
// redaction, never less, so these repros must redact by CONSTRUCTION, not
// because any particular regex happens to catch them.
// ---------------------------------------------------------------------------

test("round-12 CRITICAL: double-separator and digit-interposed keyword splits redact in flag position", () => {
  const repros = [
    "--pass--word-hunter2Aa1Zz9",
    "--pass___word-hunter2Aa1Zz9",
    "--pass---word-hunter2Aa1Zz9",
    "--p4ssword-hunter2Aa1Zz9",
    "--to9ken-hunter2Aa1Zz9",
    "--se-cr3t-hunter2Aa1Zz9",
    "--au7h-hunter2Aa1Zz9"
  ];
  for (const repro of repros) {
    const result = sanitizeFreeText(repro);
    assert.equal(result, "[redacted]", `${repro}: expected wholesale redaction, got "${result}"`);
  }
});

test("round-12 CRITICAL: double-separator and digit-interposed keyword splits redact in labeled (colon/equals) position", () => {
  const repros = ["pass--word: hunter2Aa1Zz9", "p4ssword: hunter2Aa1Zz9", "to9ken=hunter2Aa1Zz9"];
  for (const repro of repros) {
    const result = sanitizeFreeText(repro);
    assert.equal(result.includes("hunter2Aa1Zz9"), false, `${repro}: glued secret survived in "${result}"`);
  }
});

test("round-12 CRITICAL: double-separator and digit-interposed keyword splits redact in prose position", () => {
  const repros = ["your p4ssword is hunter2Aa1Zz9", "the to9ken is hunter2Aa1Zz9"];
  for (const repro of repros) {
    const result = sanitizeFreeText(repro);
    assert.equal(result.includes("hunter2Aa1Zz9"), false, `${repro}: glued secret survived in "${result}"`);
  }
});

test("round-12 CRITICAL: next-idiom probes — triple separators, mixed dash/underscore runs, still redact by construction", () => {
  const repros = ["--pass----word-hunter2Aa1Zz9", "--pass-_-word-hunter2Aa1Zz9", "--PASS__WORD-hunter2Aa1Zz9"];
  for (const repro of repros) {
    const result = sanitizeFreeText(repro);
    assert.equal(result, "[redacted]", `${repro}: expected wholesale redaction (fail-closed by construction), got "${result}"`);
  }
});

// ---------------------------------------------------------------------------
// Round-12 CRITICAL (finding 4, closed): isSafeFlagName now consults
// knownSafeTokens directly for an exact flag-name match — the alternative
// the round-11 write-up never considered. Both directions.
// ---------------------------------------------------------------------------

test("round-12: an unrecognized flag body redacts by default; the SAME flag survives as an exact knownSafeTokens member", () => {
  assert.equal(sanitizeFreeText("--custom-flag-name"), "[redacted]");
  assert.equal(sanitizeFreeText("--custom-flag-name", new Set(["--custom-flag-name"])), "--custom-flag-name");
});

test("round-12: the designed labeled-flag case (an exact canonical keyword spelling) survives with NO vocabulary at all", () => {
  for (const flag of ["--token", "--password", "--api-key", "--access-key", "--auth", "--pin", "--cvv"]) {
    assert.equal(sanitizeFreeText(flag), flag, `${flag}: canonical bare keyword flags remain a designed safe case`);
  }
});

// ---------------------------------------------------------------------------
// Round-12 MEDIUM (finding 6, LOW in the gate, locked here): a labeled
// bare-word form over-redacts the LABEL too, not just the value — a safe-
// direction side effect, not a bug, disclosed in the module header.
// ---------------------------------------------------------------------------

test("round-12 (finding 6, documented): a labeled bare-word form redacts the label as well as the value", () => {
  const result = sanitizeFreeText("pass-word: hunter2Aa1Zz9");
  assert.equal(result, "[redacted] [redacted]", "the label 'pass-word:' is not a recognized safe shape either, so it redacts too (safe direction)");
});

// ---------------------------------------------------------------------------
// Round-12 HIGH (finding 2): input-length cap restores linear-time behavior
// by construction. Generous wall-clock budget (1s) to stay CI-stable while
// still catching a genuine regression back to polynomial blowup.
// ---------------------------------------------------------------------------

test("round-12 HIGH: the gate's adversarial near-miss shape completes within budget above the input cap, and produces capped output", () => {
  const unit = "cr-ed-en-tial-X";
  const aboveCap = unit.repeat(Math.ceil((MAX_SANITIZE_INPUT_LENGTH * 3) / unit.length));
  assert.ok(aboveCap.length > MAX_SANITIZE_INPUT_LENGTH, "fixture must actually exceed the cap");
  const start = Date.now();
  const result = sanitizeFreeText(aboveCap);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1000, `expected under 1000ms, took ${elapsedMs}ms`);
  assert.ok(result.endsWith("[truncated]"), `expected a visible truncation marker, got "${result}"`);
});

test("round-12 HIGH: the gate's exact 120KB repro also completes fast now (was 5.2s)", () => {
  const unit = "cr-ed-en-tial-X";
  const size120k = unit.repeat(Math.ceil(120000 / unit.length));
  const start = Date.now();
  sanitizeFreeText(size120k);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1000, `expected under 1000ms, took ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// Round-8 finding 1 (terminal design): the free-text numeric shape-exemption
// is GONE. A bare number now survives ONLY as an exact vocabulary member —
// never by shape alone, regardless of how short it is. Both directions on
// the SAME values that round 6/7 previously granted a blanket pass to.
// Round-12 note: the FLAG name itself (`--port`, `--exit-code`, ...) is now
// ALSO subject to the fail-closed inversion (it is not a canonical keyword
// spelling), so the vocabulary-survives direction adds the flag name too —
// the test's load-bearing point remains the numeric VALUE's own behavior.
// ---------------------------------------------------------------------------

test("round-8 BOTH DIRECTIONS: a port number redacts with no vocabulary, survives when the value IS in the vocabulary", () => {
  assert.equal(sanitizeFreeText("--port 8080"), "[redacted] [redacted]");
  assert.equal(sanitizeFreeText("--port 8080", new Set(["--port", "8080"])), "--port 8080");
});

test("round-8 BOTH DIRECTIONS: an exit code redacts with no vocabulary, survives when the value IS in the vocabulary", () => {
  assert.equal(sanitizeFreeText("--exit-code 137"), "[redacted] [redacted]");
  assert.equal(sanitizeFreeText("--exit-code 137", new Set(["--exit-code", "137"])), "--exit-code 137");
});

test("round-8 BOTH DIRECTIONS: a count redacts with no vocabulary, survives when the value IS in the vocabulary", () => {
  assert.equal(sanitizeFreeText("--count 42"), "[redacted] [redacted]");
  assert.equal(sanitizeFreeText("--count 42", new Set(["--count", "42"])), "--count 42");
});

test("round-8 BOTH DIRECTIONS: a 4-digit year redacts with no vocabulary, survives when the value IS in the vocabulary", () => {
  assert.equal(sanitizeFreeText("--year 2026"), "[redacted] [redacted]");
  assert.equal(sanitizeFreeText("--year 2026", new Set(["--year", "2026"])), "--year 2026");
});

test("pass-direction (unaffected by the numeric-exemption removal): an ISO-8601 timestamp still survives with no vocabulary", () => {
  const timestamp = "2026-07-04T12:34:56.789Z";
  assert.equal(sanitizeFreeText(timestamp), timestamp);
});

test("round-8 BOTH DIRECTIONS: a short decimal number redacts with no vocabulary, survives when the value IS in the vocabulary", () => {
  for (const n of ["1.5", "99.9", "3.14"]) {
    assert.equal(sanitizeFreeText(n), "[redacted]", `"${n}" must redact with no vocabulary (round-8 terminal design)`);
    assert.equal(sanitizeFreeText(n, new Set([n])), n, `"${n}" must survive as a vocabulary member`);
  }
});

// ---------------------------------------------------------------------------
// Round-7's "code" scoping (compound pin/otp/verification/auth-code phrase,
// never bare `code`) is retained as documented DEFENSE-IN-DEPTH — but it is
// no longer what makes exit-code/error-code/status-code survive. They survive
// because their VALUES aren't redacted at all when in the vocabulary (or
// redact along with everything else in free text when not) — the keyword
// layer is irrelevant to this outcome either way (round-8 finding 4).
// ---------------------------------------------------------------------------

test("round-8: an error code and a status code behave exactly like any other numeric flag value (keyword-independent)", () => {
  assert.equal(sanitizeFreeText("--error-code 404"), "[redacted] [redacted]");
  assert.equal(sanitizeFreeText("--error-code 404", new Set(["--error-code", "404"])), "--error-code 404");
  assert.equal(sanitizeFreeText("--status-code 200"), "[redacted] [redacted]");
  assert.equal(sanitizeFreeText("--status-code 200", new Set(["--status-code", "200"])), "--status-code 200");
});

test("defense-in-depth, now non-load-bearing: a space-separated secret-labeled flag still redacts its value directly (no vocabulary needed to reach that outcome anymore)", () => {
  // "123456" would ALSO redact purely because bare numbers no longer survive
  // by shape (round-8 finding 1) — the labeled-flag rule (round-6) still
  // fires too, but it is redundant for this outcome now, not load-bearing.
  const result = sanitizeFreeText("--token 123456");
  assert.equal(result.includes("123456"), false);
  assert.equal(result, "--token [redacted]");
});

test("default-deny still catches a genuine unlabeled key=value pair with no recognized keyword", () => {
  // An unrecognized "KEY=value" token where KEY doesn't start with "-" is not
  // a flag=value pair — it's an opaque token that fails every safe shape, so
  // the WHOLE token (key and value) is redacted, not just the value half.
  const result = sanitizeFreeText("SOME_CUSTOM_VAR=hunter2Aa1notASafeShape!");
  assert.equal(result.includes("hunter2Aa1notASafeShape!"), false);
  assert.equal(result, "[redacted]");
});

// ---------------------------------------------------------------------------
// Accepted friction (documented in why-redaction.ts's module header, and
// re-disclosed for round 5): a colon-containing identifier is
// indistinguishable in shape from a label:value credential, so it redacts by
// default regardless of vocabulary. Proven here alongside a vocabulary that
// covers every OTHER word in the line, isolating the colon-specific friction.
// ---------------------------------------------------------------------------

test("accepted friction: a colon-containing compound word redacts even when every other word is known vocabulary", () => {
  const vocabulary = new Set(["npm", "run", "test", "&&"]);
  const result = sanitizeFreeText("npm run build:dist && npm test", vocabulary);
  assert.equal(result.includes("build:dist"), false);
  assert.match(result, /npm run \[redacted\] && npm test/);
});

// ---------------------------------------------------------------------------
// Honest re-disclosure of the round-5 friction: ordinary English prose in a
// caught error message is now vocabulary-gated too, not just identifiers with
// colons — this is the intentionally WIDER footprint the round-5 gate asked
// to see re-disclosed, not silently absorbed.
// ---------------------------------------------------------------------------

test("re-disclosed friction: an ordinary English sentence with no vocabulary redacts word-by-word", () => {
  const result = sanitizeFreeText("build failed repeatedly and was escalated");
  for (const word of ["build", "failed", "repeatedly", "escalated"]) {
    assert.equal(result.includes(word), false, `prose word "${word}" must not survive with no vocabulary`);
  }
  assert.match(result, /^(\[redacted\] ?)+$/);
});

// ---------------------------------------------------------------------------
// Round-6 MEDIUM: the membership-invariant regression test. Round 5's
// adversarial probing held because vocabulary membership is EXACT-match, not
// fuzzy/substring/case-insensitive — but that property previously had no
// dedicated CI guard. This test proves it structurally: for a sample
// vocabulary token, every mutation (one-char change, case change,
// pluralization, substring-superset) must redact, while only the exact
// token survives. Loops over a transformation list rather than hand-picking
// one mutation, so a future regression in the exact-match check is caught
// regardless of which transformation exposes it.
// ---------------------------------------------------------------------------

test("membership invariant: only an EXACT vocabulary match survives — mutations, case changes, pluralization, and substring-supersets all redact", () => {
  const token = "reviewer";
  const vocabulary = new Set([token]);

  // The exact token survives.
  assert.equal(sanitizeFreeText(token, vocabulary), token, "the exact vocabulary member must survive");

  const transformations: Array<{ name: string; mutate: (t: string) => string }> = [
    { name: "one-char mutation (swap a middle character)", mutate: (t) => `${t.slice(0, 3)}x${t.slice(4)}` },
    { name: "one-char mutation (append a character)", mutate: (t) => `${t}x` },
    { name: "one-char mutation (drop the last character)", mutate: (t) => t.slice(0, -1) },
    { name: "case change (capitalize first letter)", mutate: (t) => `${t[0]!.toUpperCase()}${t.slice(1)}` },
    { name: "case change (all uppercase)", mutate: (t) => t.toUpperCase() },
    { name: "pluralization (trailing s)", mutate: (t) => `${t}s` },
    { name: "substring-superset (prefix added)", mutate: (t) => `the${t}` },
    { name: "substring-superset (suffix added)", mutate: (t) => `${t}2` }
  ];

  for (const { name, mutate } of transformations) {
    const mutated = mutate(token);
    assert.notEqual(mutated, token, `${name}: the transformation must actually change the token to test anything`);
    const result = sanitizeFreeText(mutated, vocabulary);
    assert.equal(
      result,
      "[redacted]",
      `${name}: "${mutated}" is NOT an exact vocabulary match and must redact (got "${result}")`
    );
  }
});

// ---------------------------------------------------------------------------
// Round-7's boundedness-audit regression guard, updated for round 8: there is
// no `SAFE_NUMBER` anymore (a bare number never passes by shape at all,
// regardless of length — round-8 finding 1), so a 100-digit run is covered
// by the "round-8 BOTH DIRECTIONS" numeric tests above, not this list. What
// remains genuinely bounded-by-shape is `SAFE_ISO_TIMESTAMP` and `SAFE_UUID`
// — this guard proves each rejects a 100-char adversarial token of its own
// shape family. `PATH_LIKE_SHAPE`/`URL_STRUCTURE` are intentionally excluded:
// they are gates, not grants (see the module header's boundedness table), and
// a length rejection there would break real long paths/URLs.
// ---------------------------------------------------------------------------

const BOUNDED_SHAPE_ADVERSARIAL_PROBES: Array<{ name: string; token: string }> = [
  {
    name: "SAFE_ISO_TIMESTAMP: a valid date/time prefix with an 80-digit fractional-seconds run (100 chars total)",
    token: `2026-07-04T12:34:56.${"9".repeat(80)}`
  },
  {
    name: "SAFE_UUID: a valid UUID padded with 64 extra hex characters (100 chars total)",
    token: `a1b2c3d4-e5f6-7890-abcd-ef1234567890${"a".repeat(64)}`
  }
];

// ---------------------------------------------------------------------------
// Round-8 finding 3 (LOW, internal consistency): with findings 1+2 in place,
// the colon-joined, space-separated/flag, and no-flag prose join forms all
// converge to the SAME outcome for a given keyword+value pair — none of them
// is "more" or "less" strict than the others. Verified as a matrix (keyword ×
// join form), not a single hand-picked example, so a future regression in any
// ONE join form's rule is caught regardless of which keyword exposes it.
// ---------------------------------------------------------------------------

test("matrix: colon-joined, space-separated, and prose-adjacency joins produce an equivalent redaction outcome for the same keyword+value", () => {
  const secretValue = "482913";
  const keywords = ["token", "password", "secret"];
  const joinForms: Array<{ name: string; build: (keyword: string) => string }> = [
    { name: "colon-joined", build: (keyword) => `${keyword}: ${secretValue}` },
    { name: "space-separated flag", build: (keyword) => `--${keyword} ${secretValue}` },
    { name: "prose adjacency", build: (keyword) => `${keyword} is ${secretValue}` }
  ];

  for (const keyword of keywords) {
    const outcomes = joinForms.map(({ name, build }) => {
      const text = build(keyword);
      const result = sanitizeFreeText(text);
      return { name, text, result };
    });

    for (const { name, text, result } of outcomes) {
      assert.equal(
        result.includes(secretValue),
        false,
        `keyword "${keyword}", join form "${name}": secret leaked in "${result}" (from "${text}")`
      );
      assert.ok(
        result.includes("[redacted]"),
        `keyword "${keyword}", join form "${name}": expected a "[redacted]" marker in "${result}" (from "${text}")`
      );
    }
  }
});

test("boundedness audit: each bounded SAFE_* shape rejects a 100-char adversarial token of its own shape family", () => {
  for (const { name, token } of BOUNDED_SHAPE_ADVERSARIAL_PROBES) {
    assert.equal(token.length, 100, `${name}: fixture must actually be 100 chars (got ${token.length})`);
    const result = sanitizeFreeText(token);
    assert.equal(result, "[redacted]", `${name}: a 100-char token must NOT pass as a bounded-safe shape (got "${result}")`);
  }
});

// ---------------------------------------------------------------------------
// Truncation ordering: redact BEFORE truncate, never the reverse.
// ---------------------------------------------------------------------------

test("truncateForDisplay: truncates long text with an explicit ellipsis marker", () => {
  const long = "x".repeat(200);
  const truncated = truncateForDisplay(long, 10);
  assert.equal(truncated.length, 11);
  assert.ok(truncated.endsWith("…"));
});

test("truncateForDisplay: short text passes through unchanged", () => {
  assert.equal(truncateForDisplay("npm test", 120), "npm test");
});

test("sanitizeForDisplay: redacts BEFORE truncating, not after", () => {
  const padding = "x".repeat(100);
  const long = `${padding} PGPASSWORD=hunter2Aa1!`;
  const result = sanitizeForDisplay(long);
  assert.equal(result.includes("hunter2Aa1!"), false);
});

test("sanitizeForDisplay: redacts then truncates in one call", () => {
  // The trailing filler is 100 repeated whitespace-separated tokens — each
  // one redacts to "[redacted]" (round-8: bare numbers no longer survive by
  // shape), which only makes the padded string LONGER after redaction, so
  // truncation still has plenty of length left to exercise regardless.
  const long = `PGPASSWORD=hunter2 ${Array(100).fill("1").join(" ")}`;
  const result = sanitizeForDisplay(long);
  assert.equal(result.includes("hunter2"), false);
  assert.ok(result.endsWith("…"));
  assert.ok(result.length <= 121);
});

test("sanitizeForDisplay honors a supplied vocabulary the same way sanitizeFreeText does", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  assert.equal(sanitizeForDisplay(taskId, new Set([taskId])), taskId);
  assert.equal(sanitizeForDisplay(taskId), "[redacted]");
});

// ---------------------------------------------------------------------------
// tokenizeToVocabulary / extractTokenCore: the exact tokenization used to
// build a vocabulary from static command/path strings must match how free
// text is scanned, or a vocabulary entry could silently never match.
// ---------------------------------------------------------------------------

test("tokenizeToVocabulary splits on whitespace and strips wrapper punctuation identically to free-text scanning", () => {
  const tokens = tokenizeToVocabulary("`npx tsx ./src/admin.ts status` --task-id");
  assert.deepEqual(tokens, ["npx", "tsx", "./src/admin.ts", "status", "--task-id"]);
});

test("tokenizeToVocabulary drops empty pieces", () => {
  assert.deepEqual(tokenizeToVocabulary("  a   b  "), ["a", "b"]);
});
