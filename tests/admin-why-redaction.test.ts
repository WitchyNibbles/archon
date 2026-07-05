import test from "node:test";
import assert from "node:assert/strict";

import {
  redactSecretLikeSubstrings,
  truncateForDisplay,
  sanitizeForDisplay
} from "../src/admin/why-redaction.ts";

// ---------------------------------------------------------------------------
// Round-2 gate finding (HIGH, under-redaction): compound env-var names and
// basic-auth connection URLs must be scrubbed. Every fixture below is
// deliberately SHORT (well under the 24-char opaque-token fallback threshold)
// so these assertions prove the KEYWORD/URL rules themselves are correct —
// not the fallback catching it by accident. This is the fixture list the gate
// asked to see, proven both directions.
// ---------------------------------------------------------------------------

test("compound env-var name PGPASSWORD= is redacted (word-boundary keyword match would miss this)", () => {
  assert.equal(redactSecretLikeSubstrings("PGPASSWORD=hunter2"), "PGPASSWORD=[redacted]");
});

test("compound env-var name MYSQL_PWD= is redacted", () => {
  assert.equal(redactSecretLikeSubstrings("MYSQL_PWD=letmein"), "MYSQL_PWD=[redacted]");
});

test("compound env-var name AWS_SECRET_ACCESS_KEY= is redacted", () => {
  assert.equal(
    redactSecretLikeSubstrings("AWS_SECRET_ACCESS_KEY=AKIA123"),
    "AWS_SECRET_ACCESS_KEY=[redacted]"
  );
});

test("PGPASSWORD inline before a command is redacted, rest of the line untouched", () => {
  const result = redactSecretLikeSubstrings("PGPASSWORD=hunter2Aa1! psql -h db.internal -U archon");
  assert.equal(result.includes("hunter2Aa1!"), false);
  assert.match(result, /^PGPASSWORD=\[redacted\] psql -h db\.internal -U archon$/);
});

test("basic-auth connection URL reuses scrubPgCredentials — full URL redacted, not just the password", () => {
  const result = redactSecretLikeSubstrings(
    'psql "postgresql://archon:hunter2Aa1!@db.internal:5432/archon"'
  );
  assert.equal(result.includes("hunter2Aa1!"), false);
  assert.equal(result.includes("archon:"), false);
  assert.equal(result.includes("db.internal"), false);
  assert.match(result, /postgres:\/\/\[redacted\]/);
  // The closing shell quote must survive — the URL regex must not swallow it.
  assert.ok(result.endsWith('"'));
});

test("labeled short password= field is redacted (keyword path, not the fallback)", () => {
  assert.equal(redactSecretLikeSubstrings("password=abc123"), "password=[redacted]");
});

test("labeled short token: field (colon separator) is redacted", () => {
  assert.equal(redactSecretLikeSubstrings("token: abc123"), "token: [redacted]");
});

test("Authorization header and Bearer token are still redacted (unchanged from round 1)", () => {
  assert.equal(
    redactSecretLikeSubstrings('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"'),
    'curl -H "Authorization: [redacted]"'
  );
});

test("ordinary command text with no credential shape is left alone", () => {
  assert.equal(
    redactSecretLikeSubstrings("npm run build:dist && npm test"),
    "npm run build:dist && npm test"
  );
});

// ---------------------------------------------------------------------------
// Round-2 gate finding (MEDIUM, over-redaction): the opaque-token fallback
// must NOT fire on ordinary long identifiers — file paths, task ids, script
// paths — when they are not in genuine key=value position. Pass-direction:
// each of these must survive completely intact.
// ---------------------------------------------------------------------------

test("pass-direction: a long task id standalone (no separator before it) survives intact", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  assert.equal(redactSecretLikeSubstrings(taskId), taskId);
});

test("pass-direction: a long task id after a space-separated CLI flag survives intact", () => {
  const line = "npx tsx ./src/admin.ts status --task-id auditP3ArchonWhyRepairVerification123456";
  assert.equal(redactSecretLikeSubstrings(line), line);
});

test("pass-direction: a long file path survives intact", () => {
  const filePath =
    "/home/eimi/projects/archon/.archon/work/daemon/hook-blocker-state-verification.json";
  assert.equal(redactSecretLikeSubstrings(filePath), filePath);
});

test("pass-direction: a long script path with a long subcommand survives intact", () => {
  const line = "npx tsx ./src/admin.ts record-council --task-id <id> --outcome approved_with_conditions";
  assert.equal(redactSecretLikeSubstrings(line), line);
});

test("fallback still catches a genuine unlabeled opaque token in value position", () => {
  // No recognized keyword in the key name — this is exactly the case the
  // fallback exists for: a 24+-char opaque value assigned to an unknown key.
  const result = redactSecretLikeSubstrings("SOME_CUSTOM_VAR=abcdEFGHijklMNOPqrstUVWX1234");
  assert.equal(result, "SOME_CUSTOM_VAR=[redacted]");
});

test("fallback does not fire on a bare long alnum run with no preceding separator at all", () => {
  const bare = "abcdEFGHijklMNOPqrstUVWX1234";
  assert.equal(redactSecretLikeSubstrings(bare), bare);
});

// ---------------------------------------------------------------------------
// Truncation + combined sanitizeForDisplay — unchanged behavior, re-verified
// against the new module location.
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

test("sanitizeForDisplay: redacts then truncates in one call", () => {
  const long = `PGPASSWORD=hunter2 ${"x".repeat(150)}`;
  const result = sanitizeForDisplay(long);
  assert.equal(result.includes("hunter2"), false);
  assert.ok(result.endsWith("…"));
  assert.ok(result.length <= 121);
});
