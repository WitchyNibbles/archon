import path from "node:path";
import {
  getAgentCatalogEntry,
  resolveModelAlias,
  type AgentRoleId
} from "./agent-catalog.ts";

// Single source of truth for the AGENT.md YAML frontmatter block. The catalog is
// the authority; scripts/generate-agent-frontmatter.ts renders these blocks into
// each .claude/agents/*/AGENT.md and agent-artifact-verifier.ts asserts the shipped
// blocks match. Deterministic: identical catalog input -> byte-identical output.

/** ".claude/agents/<name>/AGENT.md" -> "<name>". Always POSIX-separated in the catalog. */
export function agentNameFromArtifactPath(artifactPath: string): string {
  return path.posix.basename(path.posix.dirname(artifactPath));
}

/** Wrap a scalar as a YAML double-quoted string, escaping backslash and quote. */
function yamlDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** Render a YAML flow list: ["a", "b"] -> `[a, b]` (matches the shipped roster style). */
function yamlFlowList(items: readonly string[]): string {
  return `[${items.join(", ")}]`;
}

/**
 * Render the exact `---`-delimited YAML frontmatter block for one agent role from
 * its catalog entry. Field order (name, description, model, effort, tools, skills)
 * matches the shipped roster so regeneration is a zero-diff no-op when the catalog
 * and files already agree.
 */
export function renderAgentFrontmatter(role: AgentRoleId): string {
  const entry = getAgentCatalogEntry(role);
  const name = agentNameFromArtifactPath(entry.artifactPath);
  return [
    "---",
    `name: ${name}`,
    `description: ${yamlDoubleQuoted(entry.routerDescription)}`,
    `model: ${resolveModelAlias(entry.model)}`,
    `effort: ${entry.effort}`,
    `tools: ${yamlFlowList(entry.tools)}`,
    `skills: ${yamlFlowList(entry.defaultSkillIds)}`,
    "---"
  ].join("\n");
}

/**
 * Replace ONLY the leading `---`-delimited frontmatter block of an AGENT.md,
 * leaving the body prose byte-for-byte untouched. Throws when the content has no
 * well-formed frontmatter block so a malformed file fails loudly instead of being
 * silently rewritten.
 */
export function replaceFrontmatterBlock(content: string, newBlock: string): string {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    throw new Error("AGENT.md does not start with a '---' frontmatter delimiter");
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    throw new Error("AGENT.md frontmatter block is not terminated by a closing '---'");
  }
  const body = lines.slice(closeIndex + 1);
  return [...newBlock.split("\n"), ...body].join("\n");
}
