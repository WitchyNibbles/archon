/**
 * Tests for the archon config validator (src/config/validate.ts).
 *
 * Required coverage:
 *  (a) A fully-valid env object parses cleanly and defaults are applied.
 *  (b) A missing required var (declared via `required` option) names that var.
 *  (c) MULTIPLE missing required vars are ALL named in ONE aggregated error.
 *  (d) Invalid values (bad URL, non-numeric percentage, bad hex key) are caught
 *      with actionable messages.
 *  (e) Optional vars fall back to their documented defaults when absent.
 *  (f) .env.example sync: every schema key that has a non-trivial default or
 *      format constraint is documented in .env.example.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateArchonConfig } from "../src/config/validate.ts";
import { archonConfigSchema } from "../src/config/schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid env with the most common vars set to legal values. */
const VALID_ENV: Record<string, string> = {
  ARCHON_CORE_DATABASE_URL: "postgresql://archon:secret@127.0.0.1:5432/archon",
  ARCHON_WORKSPACE_SLUG: "acme",
  ARCHON_PROJECT_SLUG: "my-project",
};

// ---------------------------------------------------------------------------
// (a) Fully-valid env parses cleanly
// ---------------------------------------------------------------------------

test("(a) fully-valid env object parses and returns ok:true with a config", () => {
  const result = validateArchonConfig(VALID_ENV);
  assert.ok(result.ok, `Expected ok:true but got errors: ${!result.ok ? result.errors.join(", ") : ""}`);
  if (!result.ok) return;

  assert.equal(result.config.ARCHON_CORE_DATABASE_URL, VALID_ENV.ARCHON_CORE_DATABASE_URL);
  assert.equal(result.config.ARCHON_WORKSPACE_SLUG, "acme");
  assert.equal(result.config.ARCHON_PROJECT_SLUG, "my-project");
});

test("(a) postgres:// scheme (without ql) is also accepted", () => {
  const result = validateArchonConfig({
    ARCHON_CORE_DATABASE_URL: "postgres://user:pass@host:5432/db",
  });
  assert.ok(result.ok, `Unexpected errors: ${!result.ok ? result.errors.join(", ") : ""}`);
});

test("(a) completely empty env parses cleanly — all vars are optional at schema level", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok, `Unexpected errors: ${!result.ok ? result.errors.join(", ") : ""}`);
});

// ---------------------------------------------------------------------------
// (b) A missing required var is named in the error
// ---------------------------------------------------------------------------

test("(b) missing required var names that var in the error list", () => {
  // DB URL is absent; the `required` option declares it mandatory for this caller.
  const result = validateArchonConfig(
    {},
    { required: ["ARCHON_CORE_DATABASE_URL"] }
  );
  assert.ok(!result.ok, "Expected validation to fail");
  if (result.ok) return;

  const allErrors = result.errors.join("\n");
  assert.ok(
    allErrors.includes("ARCHON_CORE_DATABASE_URL"),
    `Expected ARCHON_CORE_DATABASE_URL in errors. Got:\n${allErrors}`
  );
});

test("(b) required project slug — error names it when absent", () => {
  const result = validateArchonConfig(
    { ARCHON_CORE_DATABASE_URL: "postgresql://u:p@h:5432/db" },
    { required: ["ARCHON_PROJECT_SLUG"] }
  );
  assert.ok(!result.ok);
  if (result.ok) return;

  assert.ok(result.errors.join("\n").includes("ARCHON_PROJECT_SLUG"));
});

// ---------------------------------------------------------------------------
// (c) Multiple missing required vars are ALL named in one aggregated error
// ---------------------------------------------------------------------------

test("(c) multiple missing required vars are ALL named in the aggregated error", () => {
  const result = validateArchonConfig(
    {},
    { required: ["ARCHON_CORE_DATABASE_URL", "ARCHON_PROJECT_SLUG"] }
  );
  assert.ok(!result.ok, "Expected validation to fail");
  if (result.ok) return;

  const allErrors = result.errors.join("\n");
  assert.ok(
    allErrors.includes("ARCHON_CORE_DATABASE_URL"),
    `Expected ARCHON_CORE_DATABASE_URL in aggregated errors. Got:\n${allErrors}`
  );
  assert.ok(
    allErrors.includes("ARCHON_PROJECT_SLUG"),
    `Expected ARCHON_PROJECT_SLUG in aggregated errors. Got:\n${allErrors}`
  );
  // The `message` field must also contain both
  assert.ok(result.message.includes("ARCHON_CORE_DATABASE_URL"));
  assert.ok(result.message.includes("ARCHON_PROJECT_SLUG"));
});

test("(c) three missing required vars are all named in one pass", () => {
  const result = validateArchonConfig(
    {},
    {
      required: [
        "ARCHON_CORE_DATABASE_URL",
        "ARCHON_PROJECT_SLUG",
        "ARCHON_WORKSPACE_SLUG",
      ],
    }
  );
  // ARCHON_WORKSPACE_SLUG has a schema-level default of "default", so it will
  // be present after parsing even without being in the raw env.  But
  // ARCHON_CORE_DATABASE_URL and ARCHON_PROJECT_SLUG have no default.
  assert.ok(!result.ok);
  if (result.ok) return;

  const allErrors = result.errors.join("\n");
  assert.ok(allErrors.includes("ARCHON_CORE_DATABASE_URL"), allErrors);
  assert.ok(allErrors.includes("ARCHON_PROJECT_SLUG"), allErrors);
});

// ---------------------------------------------------------------------------
// (d) Invalid values are caught with actionable messages
// ---------------------------------------------------------------------------

test("(d) malformed database URL is rejected with an actionable message", () => {
  const result = validateArchonConfig({
    ARCHON_CORE_DATABASE_URL: "not-a-url-at-all",
  });
  assert.ok(!result.ok);
  if (result.ok) return;

  const allErrors = result.errors.join("\n");
  assert.ok(
    allErrors.includes("ARCHON_CORE_DATABASE_URL"),
    `Expected field name in error. Got:\n${allErrors}`
  );
});

test("(d) http:// database URL is rejected (not a postgres scheme)", () => {
  const result = validateArchonConfig({
    ARCHON_CORE_DATABASE_URL: "http://example.com/db",
  });
  assert.ok(!result.ok);
  if (result.ok) return;

  assert.ok(result.errors.join("\n").includes("ARCHON_CORE_DATABASE_URL"));
});

test("(d) non-numeric ARCHON_CONTEXT_WARNING_PCT is caught", () => {
  const result = validateArchonConfig({
    ARCHON_CONTEXT_WARNING_PCT: "ninety",
  });
  assert.ok(!result.ok);
  if (result.ok) return;

  assert.ok(result.errors.join("\n").includes("ARCHON_CONTEXT_WARNING_PCT"));
});

test("(d) out-of-range ARCHON_CONTEXT_HANDOFF_PCT (>100) is caught", () => {
  const result = validateArchonConfig({
    ARCHON_CONTEXT_HANDOFF_PCT: "150",
  });
  assert.ok(!result.ok);
  if (result.ok) return;

  assert.ok(result.errors.join("\n").includes("ARCHON_CONTEXT_HANDOFF_PCT"));
});

test("(d) invalid ARCHON_SECRETS_BACKEND enum value is caught", () => {
  const result = validateArchonConfig({
    ARCHON_SECRETS_BACKEND: "vault",
  });
  assert.ok(!result.ok);
  if (result.ok) return;

  assert.ok(result.errors.join("\n").includes("ARCHON_SECRETS_BACKEND"));
});

test("(d) malformed ARCHON_SECRETS_MASTER_KEY (not 64 hex chars) is caught", () => {
  const result = validateArchonConfig({
    ARCHON_SECRETS_MASTER_KEY: "tooshort",
  });
  assert.ok(!result.ok);
  if (result.ok) return;

  const allErrors = result.errors.join("\n");
  assert.ok(allErrors.includes("ARCHON_SECRETS_MASTER_KEY"), allErrors);
  assert.ok(
    allErrors.toLowerCase().includes("hex") ||
    allErrors.toLowerCase().includes("64"),
    `Expected hex/length hint in: ${allErrors}`
  );
});

test("(d) invalid ARCHON_MCP_PORT (non-integer string) is caught", () => {
  const result = validateArchonConfig({
    ARCHON_MCP_PORT: "not-a-port",
  });
  assert.ok(!result.ok);
  if (result.ok) return;

  assert.ok(result.errors.join("\n").includes("ARCHON_MCP_PORT"));
});

test("(d) multiple invalid values are ALL reported in one result", () => {
  const result = validateArchonConfig({
    ARCHON_CORE_DATABASE_URL: "mysql://bad-scheme",
    ARCHON_CONTEXT_WARNING_PCT: "abc",
    ARCHON_SECRETS_BACKEND: "wrong",
  });
  assert.ok(!result.ok);
  if (result.ok) return;

  const allErrors = result.errors.join("\n");
  assert.ok(allErrors.includes("ARCHON_CORE_DATABASE_URL"), allErrors);
  assert.ok(allErrors.includes("ARCHON_CONTEXT_WARNING_PCT"), allErrors);
  assert.ok(allErrors.includes("ARCHON_SECRETS_BACKEND"), allErrors);
  // Must be multiple distinct error entries, not one concatenated string
  assert.ok(result.errors.length >= 3, `Expected >=3 error entries, got ${result.errors.length}`);
});

// ---------------------------------------------------------------------------
// (e) Optional vars fall back to documented defaults
// ---------------------------------------------------------------------------

test("(e) ARCHON_WORKSPACE_SLUG defaults to 'default' when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_WORKSPACE_SLUG, "default");
});

test("(e) ARCHON_CONTEXT_WARNING_PCT defaults to 60 when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_CONTEXT_WARNING_PCT, 60);
});

test("(e) ARCHON_CONTEXT_HANDOFF_PCT defaults to 70 when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_CONTEXT_HANDOFF_PCT, 70);
});

test("(e) ARCHON_CONTEXT_HARD_STOP_PCT defaults to 80 when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_CONTEXT_HARD_STOP_PCT, 80);
});

test("(e) ARCHON_MAX_RESPAWNS_PER_TASK defaults to 8 when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_MAX_RESPAWNS_PER_TASK, 8);
});

test("(e) ARCHON_CONTEXT_MONITOR defaults to 'enforce' when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_CONTEXT_MONITOR, "enforce");
});

test("(e) ARCHON_MCP_PORT defaults to 3000 when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_MCP_PORT, 3000);
});

test("(e) ARCHON_UI_PORT defaults to 3001 when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_UI_PORT, 3001);
});

test("(e) ARCHON_SECRETS_BACKEND defaults to 'encrypted_file' when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_SECRETS_BACKEND, "encrypted_file");
});

test("(e) ARCHON_SUBAGENTS defaults to 'enabled' when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_SUBAGENTS, "enabled");
});

test("(e) ARCHON_GRAFANA_TIMEOUT_MS defaults to 15000 when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_GRAFANA_TIMEOUT_MS, 15000);
});

test("(e) ARCHON_EMBEDDING_MODEL defaults to archon-local-hash-1536 when absent", () => {
  const result = validateArchonConfig({});
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_EMBEDDING_MODEL, "archon-local-hash-1536");
});

test("(e) empty-string env vars are treated as absent (default applied)", () => {
  const result = validateArchonConfig({
    ARCHON_WORKSPACE_SLUG: "",
    ARCHON_CONTEXT_WARNING_PCT: "",
    ARCHON_MCP_PORT: "",
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_WORKSPACE_SLUG, "default");
  assert.equal(result.config.ARCHON_CONTEXT_WARNING_PCT, 60);
  assert.equal(result.config.ARCHON_MCP_PORT, 3000);
});

// ---------------------------------------------------------------------------
// (f) .env.example sync: required-core vars are documented
// ---------------------------------------------------------------------------

test("(f) .env.example documents every REQUIRED schema key", () => {
  const examplePath = path.join(repoRoot, ".env.example");
  const example = readFileSync(examplePath, "utf8");

  // These are the vars that must appear in the REQUIRED section of .env.example.
  // They are the minimum set that operators must know about to run archon.
  const requiredInExample: ReadonlyArray<string> = [
    "ARCHON_CORE_DATABASE_URL",
    "ARCHON_WORKSPACE_SLUG",
    "ARCHON_PROJECT_SLUG",
  ];

  for (const key of requiredInExample) {
    assert.ok(
      example.includes(key),
      `.env.example must document ${key} (schema key missing from file)`
    );
  }
});

test("(f) no schema key is completely undocumented in .env.example", () => {
  const examplePath = path.join(repoRoot, ".env.example");
  const example = readFileSync(examplePath, "utf8");

  // Extract all keys the schema knows about.
  const schemaKeys = Object.keys(archonConfigSchema.shape) as string[];

  // Advanced / internal keys that are intentionally undocumented in .env.example
  // because they are set by scripts or daemon automation.
  const exempted = new Set([
    "ARCHON_FORCE_CLI_ENTRYPOINT",
    "ARCHON_ALLOW_MANAGED_COMMITS",
    "ARCHON_CLAUDE_APP_AUTOMATION",
    "ARCHON_CLAUDE_APP_STANDALONE_AUTOMATION",
    "ARCHON_CLAUDE_APP_THREAD_AUTOMATION",
    "ARCHON_CLAUDE_CLI_SCHEDULER",
    "ARCHON_AUTO_REFRESH_REPO_CONTEXT",
    "ARCHON_AUTO_REFRESH_RETRIEVAL",
    "ARCHON_RETRIEVAL_REFRESH_MODE",
    "ARCHON_SUPERVISOR_REVIEWER_ACTOR",
    "ARCHON_SUPERVISOR_QA_ENGINEER_ACTOR",
    "ARCHON_SUPERVISOR_SECURITY_REVIEWER_ACTOR",
    "ARCHON_DAEMON_SUPERVISOR_HISTORY_SCOPE",
    "ARCHON_SUPERVISOR_HISTORY_RETENTION",
    "ARCHON_REPO_MARKDOWN_ROOT",
    "ARCHON_REPO_MARKDOWN_INCLUDE",
    "ARCHON_REVIEW_INPUT_DIR",
    "ARCHON_OPERATOR_ACTION_DIR",
    "ARCHON_PLAYWRIGHT_INSTALL_DEPS",
    "ARCHON_PLAYWRIGHT_NPX_BIN",
    "ARCHON_SUPERVISOR_OPERATOR_NOTES",
    // Path overrides set by installer / scripts, not operators
    "ARCHON_INSTALL_MANIFEST_PATH",
    // Embedding tuning knobs set by scripts
    "ARCHON_EMBEDDING_JOB_LIMIT",
    // Review-identity internals (implementation detail)
    "ARCHON_REVIEW_IDENTITY_BACKEND",
    // Claude app automation (set by daemon/scripts only)
    "ARCHON_CLAUDE_BIN",
  ]);

  const missing: string[] = [];
  for (const key of schemaKeys) {
    if (!exempted.has(key) && !example.includes(key)) {
      missing.push(key);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `.env.example is missing schema keys: ${missing.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("valid 64-char hex ARCHON_SECRETS_MASTER_KEY passes", () => {
  const key = "a".repeat(64);
  const result = validateArchonConfig({ ARCHON_SECRETS_MASTER_KEY: key });
  assert.ok(result.ok, `Unexpected errors: ${!result.ok ? result.errors.join(", ") : ""}`);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_SECRETS_MASTER_KEY, key);
});

test("ARCHON_SECRETS_MASTER_KEY with non-hex chars is rejected", () => {
  const result = validateArchonConfig({
    ARCHON_SECRETS_MASTER_KEY: "g".repeat(64), // g is not a hex char
  });
  assert.ok(!result.ok);
});

test("ARCHON_GRAFANA_URL accepts a valid https:// URL", () => {
  const result = validateArchonConfig({
    ARCHON_GRAFANA_URL: "https://grafana.example.com",
  });
  assert.ok(result.ok, `Unexpected errors: ${!result.ok ? result.errors.join(", ") : ""}`);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_GRAFANA_URL, "https://grafana.example.com");
});

test("ARCHON_GRAFANA_URL with empty string treats it as absent (undefined)", () => {
  const result = validateArchonConfig({ ARCHON_GRAFANA_URL: "" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_GRAFANA_URL, undefined);
});

test("numeric percentage env vars accept string numbers", () => {
  const result = validateArchonConfig({
    ARCHON_CONTEXT_WARNING_PCT: "55",
    ARCHON_CONTEXT_HANDOFF_PCT: "65",
    ARCHON_CONTEXT_HARD_STOP_PCT: "75",
  });
  assert.ok(result.ok, `Unexpected errors: ${!result.ok ? result.errors.join(", ") : ""}`);
  if (!result.ok) return;
  assert.equal(result.config.ARCHON_CONTEXT_WARNING_PCT, 55);
  assert.equal(result.config.ARCHON_CONTEXT_HANDOFF_PCT, 65);
  assert.equal(result.config.ARCHON_CONTEXT_HARD_STOP_PCT, 75);
});

test("ARCHON_RUNTIME_MODE rejects an unknown value", () => {
  const result = validateArchonConfig({ ARCHON_RUNTIME_MODE: "local" });
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.errors.join("\n").includes("ARCHON_RUNTIME_MODE"));
});
