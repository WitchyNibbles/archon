// Audit auditP2RosterTruth: the frontmatter generator is the single procedure that
// keeps every .claude/agents/*/AGENT.md in sync with the catalog. These tests prove
// (1) it is deterministic, (2) the committed roster has ZERO drift from the catalog
// (CI turns red on drift), and (3) the shared alias->id map rejects unknown tiers.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  agentRoleIds,
  getAgentCatalogEntry,
  resolveModelAlias,
  MODEL_ALIAS_TO_ID
} from "../src/archon/agent-catalog.ts";
import {
  renderAgentFrontmatter,
  replaceFrontmatterBlock,
  agentNameFromArtifactPath
} from "../src/archon/agent-frontmatter.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shippedRoles = agentRoleIds.filter((role) => getAgentCatalogEntry(role).shipsAgentArtifact);

// ── Determinism ──

test("generator determinism: renderAgentFrontmatter is byte-identical across runs", () => {
  for (const role of shippedRoles) {
    assert.equal(renderAgentFrontmatter(role), renderAgentFrontmatter(role), `role ${role} not deterministic`);
  }
});

// ── Zero-drift: committed roster == generator output ──

test("zero-drift: every shipped AGENT.md already matches the generator output", async () => {
  const drifted: string[] = [];
  for (const role of shippedRoles) {
    const entry = getAgentCatalogEntry(role);
    const current = await readFile(path.join(repoRoot, entry.artifactPath), "utf8");
    const regenerated = replaceFrontmatterBlock(current, renderAgentFrontmatter(role));
    if (regenerated !== current) {
      drifted.push(entry.artifactPath);
    }
  }
  assert.deepEqual(
    drifted,
    [],
    `frontmatter drift — regenerate with scripts/generate-agent-frontmatter.ts:\n${drifted.join("\n")}`
  );
});

// ── Rendered frontmatter reflects catalog authority ──

test("render: emits the shared-map model id and catalog fields", () => {
  const role = "review_orchestrator" as const;
  const entry = getAgentCatalogEntry(role);
  const block = renderAgentFrontmatter(role);
  assert.match(block, new RegExp(`^model: ${MODEL_ALIAS_TO_ID[entry.model]}$`, "m"));
  assert.match(block, new RegExp(`^effort: ${entry.effort}$`, "m"));
  assert.match(block, new RegExp(`^tools: \\[${entry.tools.join(", ")}\\]$`, "m"));
  assert.match(block, new RegExp(`^name: ${agentNameFromArtifactPath(entry.artifactPath)}$`, "m"));
});

// ── replaceFrontmatterBlock preserves the body and fails loudly on malformed input ──

test("replaceFrontmatterBlock: rewrites only the frontmatter, preserves body", () => {
  const original = "---\nname: old\nmodel: x\n---\n\n# Body\n\nprose line\n";
  const next = replaceFrontmatterBlock(original, "---\nname: new\nmodel: y\n---");
  assert.equal(next, "---\nname: new\nmodel: y\n---\n\n# Body\n\nprose line\n");
});

test("replaceFrontmatterBlock: throws on content without a frontmatter block", () => {
  assert.throws(() => replaceFrontmatterBlock("# no frontmatter\n", "---\nx\n---"), /frontmatter/);
  assert.throws(() => replaceFrontmatterBlock("---\nunterminated\n", "---\nx\n---"), /terminated/);
});

// ── Alias-map validation ──

test("resolveModelAlias: resolves every known alias to its pinned id", () => {
  assert.equal(resolveModelAlias("opus"), "claude-opus-4-8");
  assert.equal(resolveModelAlias("sonnet"), "claude-sonnet-5");
  assert.equal(resolveModelAlias("haiku"), "claude-haiku-4-5-20251001");
});

test("resolveModelAlias: rejects an unknown alias", () => {
  assert.throws(() => resolveModelAlias("gpt"), /Unknown model alias/);
  // Prototype keys must not resolve as aliases.
  assert.throws(() => resolveModelAlias("toString"), /Unknown model alias/);
});
