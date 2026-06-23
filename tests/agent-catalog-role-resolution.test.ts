import test from "node:test";
import assert from "node:assert/strict";

import {
  getAgentCatalogEntry,
  normalizeAgentRoleId,
  type AgentRoleId
} from "../src/archon/agent-catalog.ts";
import { getRoleRetrievalGuidance } from "../src/core/policy.ts";

// Regression: task packets and `.claude/agents/` files name roles with hyphens
// (e.g. "agent-runtime-engineer"), but the agent catalog keys with underscores
// ("agent_runtime_engineer"). Before the fix, getAgentCatalogEntry returned
// `undefined` for the hyphenated form and every caller crashed deep with an
// opaque "Cannot read properties of undefined (reading 'retrievalGuidance')",
// taking out status/report/coverage/gaps/checkpoint/getExecutionPlan and the
// Forge dashboard data source.

test("normalizeAgentRoleId resolves the canonical underscore form unchanged", () => {
  assert.equal(normalizeAgentRoleId("agent_runtime_engineer"), "agent_runtime_engineer");
  assert.equal(normalizeAgentRoleId("reviewer"), "reviewer");
});

test("normalizeAgentRoleId normalizes hyphenated role ids to the catalog key", () => {
  assert.equal(normalizeAgentRoleId("agent-runtime-engineer"), "agent_runtime_engineer");
  assert.equal(normalizeAgentRoleId("security-reviewer"), "security_reviewer");
});

test("normalizeAgentRoleId returns undefined for genuinely unknown roles", () => {
  assert.equal(normalizeAgentRoleId("totally-unknown-role"), undefined);
  assert.equal(normalizeAgentRoleId(""), undefined);
});

test("normalizeAgentRoleId trims surrounding whitespace before resolving", () => {
  assert.equal(normalizeAgentRoleId("  reviewer  "), "reviewer");
  assert.equal(normalizeAgentRoleId("\tagent-runtime-engineer\n"), "agent_runtime_engineer");
  assert.equal(normalizeAgentRoleId("   "), undefined);
});

test("normalizeAgentRoleId returns undefined for non-string input", () => {
  assert.equal(normalizeAgentRoleId(undefined), undefined);
  assert.equal(normalizeAgentRoleId(null), undefined);
  assert.equal(normalizeAgentRoleId(42), undefined);
  assert.equal(normalizeAgentRoleId({}), undefined);
});

test("normalizeAgentRoleId does not resolve inherited Object.prototype keys", () => {
  // `in` against the catalog object would match these; own-key membership must not.
  assert.equal(normalizeAgentRoleId("__proto__"), undefined);
  assert.equal(normalizeAgentRoleId("constructor"), undefined);
  assert.equal(normalizeAgentRoleId("toString"), undefined);
  assert.equal(normalizeAgentRoleId("hasOwnProperty"), undefined);
});

test("getAgentCatalogEntry throws for inherited Object.prototype keys", () => {
  assert.throws(() => getAgentCatalogEntry("__proto__" as AgentRoleId), /__proto__/);
  assert.throws(() => getAgentCatalogEntry("constructor" as AgentRoleId), /constructor/);
});

test("getAgentCatalogEntry resolves a hyphenated owner role to the same entry as the underscore key", () => {
  const canonical = getAgentCatalogEntry("agent_runtime_engineer");
  const hyphenated = getAgentCatalogEntry("agent-runtime-engineer" as AgentRoleId);
  assert.equal(hyphenated, canonical);
  assert.ok(Array.isArray(hyphenated.retrievalGuidance));
});

test("getAgentCatalogEntry throws a descriptive error for genuinely unknown roles", () => {
  assert.throws(
    () => getAgentCatalogEntry("totally-unknown-role" as AgentRoleId),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /totally-unknown-role/);
      assert.match(error.message, /role/i);
      return true;
    }
  );
});

test("getRoleRetrievalGuidance no longer crashes on a hyphenated role id", () => {
  const guidance = getRoleRetrievalGuidance("agent-runtime-engineer" as AgentRoleId);
  assert.deepEqual(guidance, getRoleRetrievalGuidance("agent_runtime_engineer"));
  assert.ok(guidance.length > 0);
});
