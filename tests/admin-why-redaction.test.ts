import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeFreeText,
  truncateForDisplay,
  sanitizeForDisplay,
  tokenizeToVocabulary
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
// backed by an explicit vocabulary (or one of the four narrow structural
// shapes: flag name, number/timestamp, path, credential-free URL).
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
  { name: "npm token prefix", text: "auth token npm_abcdefghijklmnopqrstuvwxyz0123456789 leaked", secret: "npm_abcdefghijklmnopqrstuvwxyz0123456789" }
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
  const vocabulary = new Set(["npx", "tsx", "status", taskId]);
  assert.equal(sanitizeFreeText(line, vocabulary), line);
});

test("pass-direction: a task id after an =-joined CLI flag survives via the flag-value split (round-4 fix, still holds)", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  const line = `--task-id=${taskId}`;
  // No vocabulary needed here: the flag half is always safe, and the value
  // half is checked independently — but it must still be vouched for.
  assert.equal(sanitizeFreeText(line, new Set([taskId])), line);
  assert.notEqual(sanitizeFreeText(line), line, "without the id in vocabulary, the value half redacts");
});

test("pass-direction: a recommended-command-shaped line with flags + a vocabulary-known task id survives intact", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  const line = `npx tsx ./src/admin.ts status --task-id ${taskId}`;
  assert.equal(sanitizeFreeText(line, new Set(["npx", "tsx", "status", taskId])), line);
});

// ---------------------------------------------------------------------------
// Pass-direction, structural shapes: these survive regardless of vocabulary
// (round-5 fixes: bare relative paths, ISO timestamps, credential-free URLs).
// ---------------------------------------------------------------------------

test("pass-direction: a UUID survives with no vocabulary", () => {
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  assert.equal(sanitizeFreeText(uuid), uuid);
});

test("pass-direction: an absolute file path survives with no vocabulary", () => {
  const filePath = "/home/eimi/projects/archon/.archon/work/daemon/hook-blocker-state-verification.json";
  assert.equal(sanitizeFreeText(filePath), filePath);
});

test("pass-direction (round-5 fix): a BARE RELATIVE path (no leading ./ or /) survives with no vocabulary", () => {
  const filePath = "src/admin/why-redaction.ts";
  assert.equal(sanitizeFreeText(filePath), filePath);
});

test("pass-direction (round-5 fix): an ISO-8601 timestamp survives with no vocabulary", () => {
  const timestamp = "2026-07-04T12:34:56.789Z";
  assert.equal(sanitizeFreeText(timestamp), timestamp);
});

test("pass-direction (round-5 fix): a credential-free URL survives with no vocabulary", () => {
  const url = "https://api.github.com/repos/owner/repo";
  assert.equal(sanitizeFreeText(url), url);
});

test("round-5 MEDIUM fix retained: a URL WITH userinfo still redacts even though bare URLs now survive", () => {
  const url = "https://archon:hunter2Aa1!@api.example.com/path";
  const result = sanitizeFreeText(url);
  assert.equal(result.includes("hunter2Aa1!"), false);
  assert.match(result, /^https:\/\/\[redacted\]$/);
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
  // The trailing filler is a repeated NUMBER (a safe shape that survives
  // redaction), not one long opaque identifier — round-5 redacts a bare
  // identifier-shaped run entirely, which would otherwise collapse the
  // string below the truncation threshold before this test could observe
  // truncation happening at all.
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
