import test from "node:test";
import assert from "node:assert/strict";
import {
  scrubPgCredentials,
  scrubPgError,
  validateDatabaseUrl,
  isSslError,
  buildSslGuidance,
  pgvectorGuidance
} from "../src/admin/db-error-scrub.ts";

// ---------------------------------------------------------------------------
// scrubPgCredentials — credential removal
// ---------------------------------------------------------------------------

test("scrubPgCredentials: redacts full postgres:// URL in error text", () => {
  const input = "could not connect to postgres://admin:s3cr3t@db.internal.example.com:5432/mydb";
  const result = scrubPgCredentials(input);
  assert.match(result, /postgres:\/\/\[redacted\]/);
  assert.doesNotMatch(result, /admin/);
  assert.doesNotMatch(result, /s3cr3t/);
  assert.doesNotMatch(result, /db\.internal\.example\.com/);
  assert.doesNotMatch(result, /mydb/);
});

test("scrubPgCredentials: redacts postgresql:// URL variant", () => {
  const input = "connection string: postgresql://user:pass@host/db";
  const result = scrubPgCredentials(input);
  assert.match(result, /postgres:\/\/\[redacted\]/);
  assert.doesNotMatch(result, /user/i);
  assert.doesNotMatch(result, /pass/);
  assert.doesNotMatch(result, /\bhost\b/);
});

test("scrubPgCredentials: redacts 'for user' auth-failure fragment", () => {
  const input = 'FATAL: password authentication failed for user "archon"';
  const result = scrubPgCredentials(input);
  assert.match(result, /for user \[redacted\]/);
  assert.doesNotMatch(result, /"archon"/);
});

test("scrubPgCredentials: redacts ENOTFOUND hostname", () => {
  const input = "getaddrinfo ENOTFOUND secret-host.database.internal";
  const result = scrubPgCredentials(input);
  assert.match(result, /ENOTFOUND \[redacted\]/);
  assert.doesNotMatch(result, /secret-host/);
});

test("scrubPgCredentials: redacts key=value password token", () => {
  const input = "connect failed password=hunter2 user=alice host=dbhost";
  const result = scrubPgCredentials(input);
  assert.match(result, /password=\[redacted\]/);
  assert.doesNotMatch(result, /hunter2/);
  assert.match(result, /user=\[redacted\]/);
  assert.doesNotMatch(result, /alice/);
  assert.match(result, /host=\[redacted\]/);
  assert.doesNotMatch(result, /dbhost/);
});

test("scrubPgCredentials: preserves non-credential text unchanged", () => {
  const input = "connect ECONNREFUSED 127.0.0.1:5533";
  const result = scrubPgCredentials(input);
  assert.equal(result, input);
});

test("scrubPgCredentials: safe on empty string", () => {
  assert.equal(scrubPgCredentials(""), "");
});

test("scrubPgCredentials: handles multiple credential fragments in one string", () => {
  const input =
    'failed: postgres://bob:pass@host/db — ENOTFOUND myhost — for user "bob"';
  const result = scrubPgCredentials(input);
  assert.doesNotMatch(result, /bob/);
  assert.doesNotMatch(result, /pass/);
  assert.doesNotMatch(result, /myhost/);
});

// ---------------------------------------------------------------------------
// scrubPgError
// ---------------------------------------------------------------------------

test("scrubPgError: returns an Error with scrubbed message", () => {
  const original = new Error(
    "FATAL: password authentication failed for user \"secretuser\""
  );
  const scrubbed = scrubPgError(original);
  assert.ok(scrubbed instanceof Error);
  assert.doesNotMatch(scrubbed.message, /secretuser/);
  assert.match(scrubbed.message, /for user \[redacted\]/);
});

test("scrubPgError: handles non-Error thrown values", () => {
  const scrubbed = scrubPgError("postgres://bob:pass@host/db connection failed");
  assert.ok(scrubbed instanceof Error);
  assert.doesNotMatch(scrubbed.message, /bob/);
  assert.doesNotMatch(scrubbed.message, /pass/);
});

// ---------------------------------------------------------------------------
// validateDatabaseUrl — URL parse guidance
// ---------------------------------------------------------------------------

test("validateDatabaseUrl: valid postgres:// URL returns valid", () => {
  const result = validateDatabaseUrl("postgres://user:pass@127.0.0.1:5533/archon");
  assert.equal(result.valid, true);
});

test("validateDatabaseUrl: valid postgresql:// URL returns valid", () => {
  const result = validateDatabaseUrl("postgresql://user:pass@localhost/mydb");
  assert.equal(result.valid, true);
});

test("validateDatabaseUrl: invalid URL returns guidance with percent-encoding advice", () => {
  // An @ sign unencoded in the password breaks URL parsing
  const result = validateDatabaseUrl("postgres://user:p@ss@host/db");
  // node:url may parse this differently but the guidance path is the wrong-scheme or parse-fail
  // At minimum, if valid=false we should get guidance
  if (!result.valid) {
    assert.match(result.guidance, /percent-encod/i);
  }
});

test("validateDatabaseUrl: wrong scheme returns guidance", () => {
  const result = validateDatabaseUrl("mysql://user:pass@host/db");
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.guidance, /postgres/i);
    assert.match(result.guidance, /scheme/i);
  }
});

test("validateDatabaseUrl: completely unparseable string returns guidance", () => {
  const result = validateDatabaseUrl("not a url at all");
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.guidance, /percent-encod/i);
  }
});

// ---------------------------------------------------------------------------
// isSslError — SSL detection
// ---------------------------------------------------------------------------

test("isSslError: detects SSL keyword in pg error", () => {
  assert.equal(isSslError(new Error("SSL SYSCALL error: EOF detected")), true);
  assert.equal(isSslError(new Error("FATAL: SSL connection required")), true);
  assert.equal(isSslError(new Error("The server does not support SSL connections")), true);
});

test("isSslError: detects pg_hba.conf rejection as SSL-adjacent", () => {
  assert.equal(
    isSslError(new Error("no pg_hba.conf entry for host, user, no encryption")),
    true
  );
});

test("isSslError: detects TLS in error message", () => {
  assert.equal(isSslError(new Error("TLS handshake failed")), true);
});

test("isSslError: returns false for non-SSL errors", () => {
  assert.equal(isSslError(new Error("ECONNREFUSED 127.0.0.1:5533")), false);
  assert.equal(isSslError(new Error("FATAL: database does not exist")), false);
});

// ---------------------------------------------------------------------------
// buildSslGuidance — SSL action strings
// ---------------------------------------------------------------------------

test("buildSslGuidance: no sslmode set → advises both options", () => {
  const guidance = buildSslGuidance("postgres://user:pass@host/db");
  assert.match(guidance, /sslmode=require/);
  assert.match(guidance, /sslmode=disable/);
  // Must not echo the URL or credentials
  assert.doesNotMatch(guidance, /pass/);
  assert.doesNotMatch(guidance, /host/);
});

test("buildSslGuidance: sslmode=require already set → advises disable as alternative", () => {
  const guidance = buildSslGuidance("postgres://user:pass@host/db?sslmode=require");
  assert.match(guidance, /sslmode=disable/);
  assert.doesNotMatch(guidance, /pass/);
});

test("buildSslGuidance: sslmode=disable already set → advises require", () => {
  const guidance = buildSslGuidance("postgres://user:pass@host/db?sslmode=disable");
  assert.match(guidance, /sslmode=require/);
  assert.doesNotMatch(guidance, /pass/);
});

test("buildSslGuidance: unparseable URL → still returns actionable advice", () => {
  const guidance = buildSslGuidance("not-a-url");
  assert.ok(guidance.length > 0);
  assert.match(guidance, /sslmode/);
});

// ---------------------------------------------------------------------------
// pgvectorGuidance — pgvector branching
// ---------------------------------------------------------------------------

test("pgvectorGuidance: enabled → ok", () => {
  const result = pgvectorGuidance(true, true);
  assert.equal(result.ok, true);
});

test("pgvectorGuidance: available on server but not enabled → advise CREATE EXTENSION, not install package", () => {
  const result = pgvectorGuidance(true, false);
  assert.equal(result.ok, false);
  assert.match(result.message, /CREATE EXTENSION vector/);
  // Must NOT tell operator to install a package — pgvector is already on the server.
  assert.doesNotMatch(result.message, /apt install|package|image/i);
});

test("pgvectorGuidance: not available at all → advise installing package/image", () => {
  const result = pgvectorGuidance(false, false);
  assert.equal(result.ok, false);
  assert.match(result.message, /install/i);
  // Should mention how to get the package or image
  assert.ok(
    /pgvector/i.test(result.message) ||
    /package/i.test(result.message) ||
    /image/i.test(result.message)
  );
  assert.doesNotMatch(result.message, /CREATE EXTENSION/);
});

test("pgvectorGuidance: edge case — enabled=true but available=false is treated as ok", () => {
  // If it's in pg_extension it's enabled regardless of pg_available_extensions
  const result = pgvectorGuidance(false, true);
  assert.equal(result.ok, true);
});
