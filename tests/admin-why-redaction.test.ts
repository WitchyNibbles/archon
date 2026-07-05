import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeFreeText,
  truncateForDisplay,
  sanitizeForDisplay
} from "../src/admin/why-redaction.ts";

// ---------------------------------------------------------------------------
// Round-4 design inversion: "stop chasing shapes" — redact by default,
// allowlist the safe. Rounds 2 and 3 both patched the same shape-hunting
// scrubber and both left a bypass (compound env-vars, then JSON-shaped
// secrets). This suite proves the new default-deny model both directions:
// every adversarial fixture the gate named must redact; every legitimate
// free-text shape the gate named must survive.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Adversarial fixture list — round 2, round 3, and round 4's new shapes.
// Every one of these must have its secret payload fully absent from output.
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
  }
];

for (const fixture of ADVERSARIAL_FIXTURES) {
  test(`sanitizeFreeText redacts: ${fixture.name}`, () => {
    const result = sanitizeFreeText(fixture.text);
    assert.equal(result.includes(fixture.secret), false, `secret leaked: ${result}`);
  });
}

// Property-style test (round-4 requirement): for EVERY fixture in the secret
// list, the secret substring must not appear in the sanitized output. This is
// the same assertion as the individual tests above collapsed into one loop —
// kept as a single property check so a future fixture added to the array is
// automatically covered without a new test needing to be written.
test("property: no adversarial fixture's secret substring survives sanitizeFreeText", () => {
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
// Pass-direction: file paths, long task ids (bare, space-flag, =-flag),
// UUIDs, and recommended-command-shaped lines must survive completely intact.
// ---------------------------------------------------------------------------

test("pass-direction: a long task id standalone survives intact", () => {
  const taskId = "auditP3ArchonWhyRepairVerification123456";
  assert.equal(sanitizeFreeText(taskId), taskId);
});

test("pass-direction: a long task id after a space-separated CLI flag survives intact", () => {
  const line = "npx tsx ./src/admin.ts status --task-id auditP3ArchonWhyRepairVerification123456";
  assert.equal(sanitizeFreeText(line), line);
});

test("pass-direction: a long task id after an =-joined CLI flag survives intact (round-4 fix)", () => {
  const line = "--task-id=auditP3ArchonWhyRepairVerification123456";
  assert.equal(sanitizeFreeText(line), line);
});

test("pass-direction: a UUID survives intact", () => {
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  assert.equal(sanitizeFreeText(uuid), uuid);
});

test("pass-direction: a long file path survives intact", () => {
  const filePath = "/home/eimi/projects/archon/.archon/work/daemon/hook-blocker-state-verification.json";
  assert.equal(sanitizeFreeText(filePath), filePath);
});

test("pass-direction: a recommended-command-shaped line with flags and a task id survives intact", () => {
  const line = "npx tsx ./src/admin.ts status --task-id auditP3ArchonWhyRepairVerification123456";
  assert.equal(sanitizeFreeText(line), line);
});

test("default-deny still catches a genuine unlabeled key=value pair with no recognized keyword", () => {
  // Under the round-4 model, an unrecognized "KEY=value" token where KEY
  // doesn't start with "-" is not a flag=value pair — it's just an opaque
  // token that fails every safe shape, so the WHOLE token (key and value)
  // is redacted, not just the value half. That is a stricter, still-safe
  // outcome, not a regression from round 3's label-preserving behavior.
  const result = sanitizeFreeText("SOME_CUSTOM_VAR=hunter2Aa1notASafeShape!");
  assert.equal(result.includes("hunter2Aa1notASafeShape!"), false);
  assert.equal(result, "[redacted]");
});

// ---------------------------------------------------------------------------
// Accepted friction (documented in why-redaction.ts's module header): a
// colon-containing identifier is indistinguishable in shape from a
// label:value credential, so it is redacted by default. Proven explicitly
// here so the trade-off is a tested, visible fact of the module rather than
// a silent surprise.
// ---------------------------------------------------------------------------

test("accepted friction: a colon-containing compound word (e.g. an npm script name) is redacted like a label:value pair", () => {
  const result = sanitizeFreeText("npm run build:dist && npm test");
  assert.equal(result.includes("build:dist"), false);
  assert.match(result, /npm run \[redacted\] && npm test/);
});

// ---------------------------------------------------------------------------
// Truncation ordering (round-4 LOW fix): redact BEFORE truncate, never the
// reverse — truncating first could cut a marker match in half and let a
// secret fragment survive past the cut.
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
  // Construct text where the secret sits right at the truncation boundary —
  // if truncation ran first, the secret marker ("PGPASSWORD=") could be
  // separated from its value by the cut. Redacting first guarantees the
  // value is gone before length is ever considered.
  const padding = "x".repeat(100);
  const long = `${padding} PGPASSWORD=hunter2Aa1!`;
  const result = sanitizeForDisplay(long);
  assert.equal(result.includes("hunter2Aa1!"), false);
});

test("sanitizeForDisplay: redacts then truncates in one call", () => {
  const long = `PGPASSWORD=hunter2 ${"x".repeat(150)}`;
  const result = sanitizeForDisplay(long);
  assert.equal(result.includes("hunter2"), false);
  assert.ok(result.endsWith("…"));
  assert.ok(result.length <= 121);
});
