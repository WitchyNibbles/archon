import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  agentCatalogEntries,
  agentRoleIds,
  type AgentCatalogEntry,
  type AgentRoleId,
  getAgentCatalogEntry
} from "./agent-catalog.ts";
import { listCatalogRepoLocalSkillPaths } from "./repo-local-skill-surface.ts";

export interface AgentArtifactVerificationResult {
  ok: boolean;
  missingArtifacts: string[];
  unexpectedArtifacts: string[];
  metadataMismatches: string[];
}

// Audit agents-F3: the catalog models a tier alias (`opus`/`sonnet`/`haiku`); the
// shipped AGENT.md frontmatter pins a concrete model id. This map is the current,
// intentional pin per tier — every shipping agent uses exactly one id per tier
// (frontmatter census: opus→claude-opus-4-8, sonnet→claude-sonnet-4-6,
// haiku→claude-haiku-4-5-20251001). It exists so the verifier catches UNINTENDED
// drift; a deliberate tier upgrade (e.g. sonnet→claude-sonnet-5) updates this map.
const MODEL_ALIAS_TO_ID: Readonly<Record<AgentCatalogEntry["model"], string>> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001"
};

interface AgentFrontmatter {
  model?: string;
  effort?: string;
  skills?: string[];
}

// Minimal, dependency-free YAML frontmatter parser for AGENT.md files. It reads
// the leading `---`-delimited block and extracts the scalar `model`/`effort`
// fields and the `skills:` flow list (`[a, b, c]`). Returns undefined when there
// is no well-formed frontmatter block.
export function parseAgentFrontmatter(content: string): AgentFrontmatter | undefined {
  if (!content.startsWith("---")) {
    return undefined;
  }
  // The block ends at the first line that is exactly `---` after the opener.
  const lines = content.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return undefined;
  }

  const result: AgentFrontmatter = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line === undefined || !line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "model") {
      result.model = stripYamlScalar(value);
    } else if (key === "effort") {
      result.effort = stripYamlScalar(value);
    } else if (key === "skills") {
      result.skills = parseYamlFlowList(value);
    }
  }
  return result;
}

function stripYamlScalar(value: string): string {
  return value.replace(/^['"]/, "").replace(/['"]$/, "").trim();
}

function parseYamlFlowList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return trimmed.length > 0 ? [stripYamlScalar(trimmed)] : [];
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((entry) => stripYamlScalar(entry.trim()))
    .filter((entry) => entry.length > 0);
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export interface CatalogRepoLocalSkillVerificationResult {
  ok: boolean;
  missingSkillFiles: string[];
}

export async function verifyAgentCatalogArtifacts(input: {
  repoRoot: string;
  roles?: readonly AgentRoleId[] | undefined;
}): Promise<AgentArtifactVerificationResult> {
  const roles = input.roles?.length ? [...input.roles] : [...agentRoleIds];
  const expectedArtifactPaths = roles
    .filter((role) => getAgentCatalogEntry(role).shipsAgentArtifact)
    .map((role) => getAgentCatalogEntry(role).artifactPath)
    .sort();

  // Archon agents are in .claude/agents/<name>/AGENT.md
  const agentsRoot = path.join(input.repoRoot, ".claude", "agents");
  let actualFiles: string[] = [];
  try {
    const entries = await readdir(agentsRoot, { withFileTypes: true });
    const agentDirs = entries.filter((entry) => entry.isDirectory());
    actualFiles = agentDirs
      .map((dir) => path.posix.join(".claude/agents", dir.name, "AGENT.md"))
      .sort();
  } catch {
    actualFiles = [];
  }

  const expectedSet = new Set<string>(expectedArtifactPaths);
  const actualSet = new Set<string>(actualFiles);
  const missingArtifacts = expectedArtifactPaths.filter((artifactPath) => !actualSet.has(artifactPath));
  const unexpectedArtifacts = actualFiles.filter((artifactPath) => !expectedSet.has(artifactPath));

  const metadataMismatches: string[] = [];
  for (const role of roles) {
    const entry = getAgentCatalogEntry(role);
    if (!entry.shipsAgentArtifact || !actualSet.has(entry.artifactPath)) {
      continue;
    }

    // Audit agents-F1/F2: parse the AGENT.md YAML frontmatter and assert the
    // structural fields the catalog authoritatively models — model (tier alias →
    // pinned id), effort, and the skills list — against the catalog. On mismatch
    // the catalog is the authority (agents-audit §4). Two fields are intentionally
    // NOT asserted here:
    //   - description: the AGENT.md description is the richer, router-facing trigger
    //     text and diverges from the catalog's terse internal label for EVERY agent;
    //     forcing equality would regress trigger quality (a roster-wide description
    //     reconciliation is out of this task's scope).
    //   - tools: the catalog has no `tools` field, so there is no catalog authority
    //     to check against (AGENT.md is currently the sole source for tools).
    try {
      const content = await readFile(path.join(input.repoRoot, entry.artifactPath), "utf8");
      const frontmatter = parseAgentFrontmatter(content);
      if (!frontmatter) {
        metadataMismatches.push(
          `${entry.artifactPath}: expected YAML frontmatter, got malformed content`
        );
      } else {
        const expectedModel = MODEL_ALIAS_TO_ID[entry.model];
        if (frontmatter.model !== expectedModel) {
          metadataMismatches.push(
            `${entry.artifactPath}: model '${frontmatter.model ?? "(missing)"}' does not match catalog '${entry.model}' (${expectedModel})`
          );
        }
        if (frontmatter.effort !== entry.effort) {
          metadataMismatches.push(
            `${entry.artifactPath}: effort '${frontmatter.effort ?? "(missing)"}' does not match catalog '${entry.effort}'`
          );
        }
        const frontmatterSkills = frontmatter.skills ?? [];
        const catalogSkills = [...entry.defaultSkillIds];
        if (!setsEqual(frontmatterSkills, catalogSkills)) {
          metadataMismatches.push(
            `${entry.artifactPath}: skills [${frontmatterSkills.join(", ")}] do not match catalog [${catalogSkills.join(", ")}]`
          );
        }
      }
    } catch {
      // File couldn't be read — already captured as missing
    }
  }

  return {
    ok: missingArtifacts.length === 0 && unexpectedArtifacts.length === 0 && metadataMismatches.length === 0,
    missingArtifacts,
    unexpectedArtifacts,
    metadataMismatches
  };
}

export function listCatalogAgentArtifactPaths(input?: {
  roles?: readonly AgentRoleId[] | undefined;
}): string[] {
  const roles = input?.roles?.length ? [...input.roles] : [...agentRoleIds];
  return roles
    .filter((role) => getAgentCatalogEntry(role).shipsAgentArtifact)
    .map((role) => getAgentCatalogEntry(role).artifactPath)
    .sort();
}

export function listCatalogAgentRoles(): AgentRoleId[] {
  return [...agentRoleIds];
}

export function listCatalogShippedAgentEntries(): typeof agentCatalogEntries {
  return agentCatalogEntries.filter((entry) => entry.shipsAgentArtifact);
}

export async function verifyCatalogRepoLocalSkills(input: {
  repoRoot: string;
  roles?: readonly AgentRoleId[] | undefined;
}): Promise<CatalogRepoLocalSkillVerificationResult> {
  const expectedSkillFiles = listCatalogRepoLocalSkillPaths({ roles: input.roles });
  const missingSkillFiles: string[] = [];

  for (const relativePath of expectedSkillFiles) {
    try {
      await readFile(path.join(input.repoRoot, relativePath), "utf8");
    } catch {
      missingSkillFiles.push(relativePath);
    }
  }

  return {
    ok: missingSkillFiles.length === 0,
    missingSkillFiles
  };
}
