// Audit agents-F1/F2: the agent-artifact drift verifier must perform REAL
// frontmatter verification (not a `startsWith("---")` stub) and fail CI when any
// AGENT.md's model/effort/skills disagree with the catalog authority.
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
import { getAgentCatalogEntry } from "../src/archon/agent-catalog.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("drift detection: mismatched skills list is reported", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "archon-drift-"));
  try {
    await seedAgent(
      dir,
      "backend_engineer",
      "---\ndescription: x\nmodel: claude-sonnet-4-6\neffort: high\nskills: [archon-execution]\n---\n# Backend Engineer\n"
    );
    const result = await verifyAgentCatalogArtifacts({ repoRoot: dir, roles: ["backend_engineer"] });
    assert.equal(result.ok, false);
    assert.equal(result.metadataMismatches.length, 1);
    assert.match(result.metadataMismatches[0], /skills/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drift detection: mismatched model id is reported", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "archon-drift-"));
  try {
    const entry = getAgentCatalogEntry("backend_engineer");
    await seedAgent(
      dir,
      "backend_engineer",
      `---\ndescription: x\nmodel: claude-sonnet-4-5\neffort: high\nskills: [${entry.defaultSkillIds.join(", ")}]\n---\n# Backend Engineer\n`
    );
    const result = await verifyAgentCatalogArtifacts({ repoRoot: dir, roles: ["backend_engineer"] });
    assert.equal(result.ok, false);
    assert.match(result.metadataMismatches.join("\n"), /model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drift detection: mismatched effort is reported", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "archon-drift-"));
  try {
    const entry = getAgentCatalogEntry("backend_engineer");
    await seedAgent(
      dir,
      "backend_engineer",
      `---\ndescription: x\nmodel: claude-sonnet-4-6\neffort: low\nskills: [${entry.defaultSkillIds.join(", ")}]\n---\n# Backend Engineer\n`
    );
    const result = await verifyAgentCatalogArtifacts({ repoRoot: dir, roles: ["backend_engineer"] });
    assert.equal(result.ok, false);
    assert.match(result.metadataMismatches.join("\n"), /effort/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drift detection: malformed content (no frontmatter) is reported", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "archon-drift-"));
  try {
    await seedAgent(dir, "backend_engineer", "# Backend Engineer\nno frontmatter here\n");
    const result = await verifyAgentCatalogArtifacts({ repoRoot: dir, roles: ["backend_engineer"] });
    assert.equal(result.ok, false);
    assert.match(result.metadataMismatches.join("\n"), /frontmatter/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── parseAgentFrontmatter unit coverage ──

test("parseAgentFrontmatter: extracts model, effort, and skills flow list", () => {
  const fm = parseAgentFrontmatter(
    "---\nname: x\ndescription: \"d\"\nmodel: claude-opus-4-8\neffort: high\ntools: [Read, Bash]\nskills: [a, b, ecc:c]\n---\n# body\n"
  );
  assert.ok(fm);
  assert.equal(fm.model, "claude-opus-4-8");
  assert.equal(fm.effort, "high");
  assert.deepEqual(fm.skills, ["a", "b", "ecc:c"]);
});

test("parseAgentFrontmatter: returns undefined without a frontmatter block", () => {
  assert.equal(parseAgentFrontmatter("# just a heading\n"), undefined);
  assert.equal(parseAgentFrontmatter("---\nmodel: x\n"), undefined); // unterminated
});

test("parseAgentFrontmatter: empty skills list parses to []", () => {
  const fm = parseAgentFrontmatter("---\nmodel: claude-sonnet-4-6\neffort: high\nskills: []\n---\n");
  assert.ok(fm);
  assert.deepEqual(fm.skills, []);
});
