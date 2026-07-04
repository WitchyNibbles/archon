import path from "node:path";
import {
  getAgentCatalogEntry,
  resolveModelAlias,
  type AgentRoleId
} from "./agent-catalog.ts";
import { assertScalarsSafeForRoundTrip } from "./agent-frontmatter-safety.ts";

export { assertScalarsSafeForRoundTrip } from "./agent-frontmatter-safety.ts";

// Single source of truth for AGENT.md YAML frontmatter (catalog is authority; verifier asserts drift).

/** ".claude/agents/<name>/AGENT.md" -> "<name>". Always POSIX-separated. */
export function agentNameFromArtifactPath(artifactPath: string): string {
  return path.posix.basename(path.posix.dirname(artifactPath));
}

/** Wrap as a YAML double-quoted scalar, escaping backslash and quote. */
function yamlDoubleQuoted(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** Render a YAML flow list: `[a, b]` (matches the shipped roster style). */
function yamlFlowList(items: readonly string[]): string {
  return `[${items.join(", ")}]`;
}

/** Render the `---`-delimited frontmatter block for one role. Field order matches the
 *  shipped roster so regeneration is a zero-diff no-op when files and catalog agree. */
export function renderAgentFrontmatter(role: AgentRoleId): string {
  const entry = getAgentCatalogEntry(role);
  const name = agentNameFromArtifactPath(entry.artifactPath);
  assertScalarsSafeForRoundTrip([{ field: "routerDescription", value: entry.routerDescription }], name);
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

/** Replace ONLY the leading frontmatter block of an AGENT.md, preserving the body.
 *  Throws when the file has no well-formed frontmatter block. */
export function replaceFrontmatterBlock(content: string, newBlock: string): string {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    throw new Error("AGENT.md does not start with a '---' frontmatter delimiter");
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { closeIndex = i; break; }
  }
  if (closeIndex === -1) {
    throw new Error("AGENT.md frontmatter block is not terminated by a closing '---'");
  }
  return [...newBlock.split("\n"), ...lines.slice(closeIndex + 1)].join("\n");
}
