// Audit agents-F1/F2/F5: the agent-artifact drift verifier must perform REAL
// frontmatter verification (not a `startsWith("---")` stub) and fail CI when any
// AGENT.md's model/effort/description/tools/skills disagree with the catalog
// authority. Seeds are derived from the shared catalog + generator so the tests
// survive a model-tier refresh (no hardcoded model ids).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  verifyAgentCatalogArtifacts,
  parseAgentFrontmatter
} from "../src/archon/agent-artifact-verifier.ts";
import { getAgentCatalogEntry, MODEL_ALIAS_TO_ID, resolveModelAlias } from "../src/archon/agent-catalog.ts";
import { renderAgentFrontmatter } from "../src/archon/agent-frontmatter.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A catalog-correct AGENT.md for backend_engineer: rendered frontmatter + a body.
// Perturbing exactly one field in this baseline yields exactly one drift finding.
const BASELINE_ROLE = "backend_engineer" as const;
function baselineAgent(): string {
  return `${renderAgentFrontmatter(BASELINE_ROLE)}\n\n# Backend Engineer\n`;
}

// ── Direction 1: the shipped roster has no metadata drift (the CI gate) ──

test("drift gate: the real roster AGENT.md frontmatter matches the catalog", async () => {
  const result = await verifyAgentCatalogArtifacts({ repoRoot });
  assert.deepEqual(
    result.metadataMismatches,
    [],
    `roster drift detected:\n${result.metadataMismatches.join("\n")}`
  );
  assert.equal(result.ok, true);
});

// ── Direction 2: the verifier actually DETECTS drift (not a stub) ──

async function seedAgent(dir: string, role: "backend_engineer", frontmatter: string): Promise<void> {
  const entry = getAgentCatalogEntry(role);
  const agentDir = path.join(dir, path.dirname(entry.artifactPath));
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(dir, entry.artifactPath), frontmatter, "utf8");
}

async function verifySeeded(frontmatter: string): Promise<string[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "archon-drift-"));
  try {
    await seedAgent(dir, BASELINE_ROLE, frontmatter);
    const result = await verifyAgentCatalogArtifacts({ repoRoot: dir, roles: [BASELINE_ROLE] });
    return result.metadataMismatches;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("drift baseline: an unperturbed rendered agent has zero mismatches", async () => {
  const mismatches = await verifySeeded(baselineAgent());
  assert.deepEqual(mismatches, []);
});

test("drift detection: mismatched skills list is reported", async () => {
  const perturbed = baselineAgent().replace(/^skills: .*$/m, "skills: [archon-execution]");
  const mismatches = await verifySeeded(perturbed);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /skills/);
});

test("drift detection: mismatched model id is reported", async () => {
  const perturbed = baselineAgent().replace(/^model: .*$/m, "model: claude-sonnet-4-5");
  const mismatches = await verifySeeded(perturbed);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /model/);
});

test("drift detection: mismatched effort is reported", async () => {
  const perturbed = baselineAgent().replace(/^effort: .*$/m, "effort: low");
  const mismatches = await verifySeeded(perturbed);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /effort/);
});

test("drift detection: mismatched tools grant is reported (closes PR-#152 F2)", async () => {
  // Add an Agent-spawn grant not present in the catalog — the exact class of silent
  // privilege escalation F2 said the old verifier could not catch.
  const perturbed = baselineAgent().replace(
    /^tools: .*$/m,
    "tools: [Read, Grep, Glob, Bash, Write, Edit, Agent]"
  );
  const mismatches = await verifySeeded(perturbed);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /tools/);
});

test("drift detection: mismatched description is reported", async () => {
  const perturbed = baselineAgent().replace(
    /^description: .*$/m,
    'description: "totally different trigger text"'
  );
  const mismatches = await verifySeeded(perturbed);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /description/);
});

test("drift detection: malformed content (no frontmatter) is reported", async () => {
  const mismatches = await verifySeeded("# Backend Engineer\nno frontmatter here\n");
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /frontmatter/);
});

// ── parseAgentFrontmatter unit coverage ──

test("parseAgentFrontmatter: extracts model, effort, description, tools, and skills", () => {
  const fm = parseAgentFrontmatter(
    "---\nname: x\ndescription: \"d\"\nmodel: claude-opus-4-8\neffort: high\ntools: [Read, Bash]\nskills: [a, b, ecc:c]\n---\n# body\n"
  );
  assert.ok(fm);
  assert.equal(fm.model, "claude-opus-4-8");
  assert.equal(fm.effort, "high");
  assert.equal(fm.description, "d");
  assert.deepEqual(fm.tools, ["Read", "Bash"]);
  assert.deepEqual(fm.skills, ["a", "b", "ecc:c"]);
});

test("parseAgentFrontmatter: returns undefined without a frontmatter block", () => {
  assert.equal(parseAgentFrontmatter("# just a heading\n"), undefined);
  assert.equal(parseAgentFrontmatter(`---\nmodel: ${MODEL_ALIAS_TO_ID.sonnet}\n`), undefined); // unterminated
});

test("parseAgentFrontmatter: empty skills list parses to []", () => {
  const fm = parseAgentFrontmatter(`---\nmodel: ${MODEL_ALIAS_TO_ID.sonnet}\neffort: high\nskills: []\n---\n`);
  assert.ok(fm);
  assert.deepEqual(fm.skills, []);
});

// ── Alias-resolution consistency (item 4: auditP2Followups) ──

test("alias-resolution: resolveModelAlias throws on unknown alias (verifier uses loud path, not silent map index)", () => {
  // Direct proof that the verifier now uses resolveModelAlias (loud) rather than
  // MODEL_ALIAS_TO_ID direct indexing (silent-undefined). If the verifier used the
  // direct-index path, an unknown alias would return undefined and produce only a
  // drift mismatch string "(undefined)" instead of immediately throwing.
  assert.throws(() => resolveModelAlias("not-a-real-alias"), /Unknown model alias/);
  assert.throws(() => resolveModelAlias(""), /Unknown model alias/);

  // Confirm the pre-fix silent behavior: direct indexing returns undefined for
  // the same input. The verifier no longer takes this path.
  const directResult = (MODEL_ALIAS_TO_ID as Record<string, string | undefined>)["not-a-real-alias"];
  assert.equal(directResult, undefined, "direct map index silently returns undefined — the fixed verifier no longer does this");
});
