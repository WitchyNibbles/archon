import path from "node:path";
import { agentRoleIds, getAgentCatalogEntry, type AgentRoleId } from "./agent-catalog.ts";

export const repoLocalSkillIdPrefixes = ["archon-", "anthropic-", "superpowers-"] as const;

export function isRepoLocalSkillId(skillId: string): boolean {
  return repoLocalSkillIdPrefixes.some((prefix) => skillId.startsWith(prefix));
}

export function repoLocalSkillPathForId(skillId: string): string {
  return path.posix.join(".agents/skills", skillId, "SKILL.md");
}

export function listCatalogRepoLocalSkillPaths(input?: {
  roles?: readonly AgentRoleId[] | undefined;
}): string[] {
  const roles = input?.roles?.length ? [...input.roles] : [...agentRoleIds];
  const expectedSkillPaths = new Set<string>();

  for (const role of roles) {
    for (const skillId of getAgentCatalogEntry(role).defaultSkillIds) {
      if (!isRepoLocalSkillId(skillId)) {
        continue;
      }
      expectedSkillPaths.add(repoLocalSkillPathForId(skillId));
    }
  }

  return [...expectedSkillPaths].sort();
}
