import { agentCatalog } from "./catalog-data.ts";

export { agentCatalog };

export type AgentRoleClass = "manager" | "delivery" | "quality" | "knowledge" | "domain_specialist";
export type AgentRoleAvailability = "core_required" | "core_optional" | "domain_optional";

// Audit agents-F3/F5: the tier-alias -> pinned-model-id map is the SINGLE source
// of truth for which concrete model id each tier resolves to. It lives here (the
// catalog module) so the frontmatter generator (scripts/generate-agent-frontmatter.ts)
// and the drift verifier (agent-artifact-verifier.ts) share ONE mapping — never a
// second copy.
//
// RUNBOOK (audit F6 / #152): a deliberate tier upgrade (e.g. sonnet ->
// claude-sonnet-5) is performed by editing the one alias line below AND
// regenerating the roster frontmatter in the SAME change:
//   1. edit the alias -> id line here
//   2. run: node --experimental-strip-types scripts/generate-agent-frontmatter.ts
//   3. commit the regenerated .claude/agents/*/AGENT.md alongside this file
// The zero-drift test then re-passes because the files and the map moved together.
// Do NOT repin an AGENT.md by hand — the generator is the procedure, and the
// verifier fails CI loudly for every agent on a tier whose map and files disagree.
export const MODEL_ALIAS_TO_ID = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001"
} as const;

/** Tier alias keyed off the shared map; adding a tier to the map widens this type. */
export type ModelAlias = keyof typeof MODEL_ALIAS_TO_ID;

/**
 * Resolve a model tier alias to its pinned concrete model id, validating the
 * alias at runtime against the shared map. Throws on an unknown alias so a
 * loosely-typed / `as`-cast caller cannot silently resolve an unmapped tier.
 */
export function resolveModelAlias(alias: string): string {
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIAS_TO_ID, alias)) {
    return MODEL_ALIAS_TO_ID[alias as ModelAlias];
  }
  throw new Error(
    `Unknown model alias "${alias}": not in MODEL_ALIAS_TO_ID (known: ${Object.keys(MODEL_ALIAS_TO_ID).join(", ")}).`
  );
}

export interface AgentCatalogEntry {
  label: string;
  description: string;
  /** Rich, router-facing trigger description shipped as the AGENT.md `description:` frontmatter. */
  routerDescription: string;
  class: AgentRoleClass;
  availability: AgentRoleAvailability;
  shipsAgentArtifact: boolean;
  artifactPath: string;
  model: ModelAlias;
  effort: "high" | "medium" | "low";
  /** Tool grants shipped as the AGENT.md `tools:` frontmatter (the intended grant set). */
  tools: readonly string[];
  canOwnTasks: boolean;
  canSatisfySpecialistRequirement: boolean;
  defaultSkillIds: readonly string[];
  retrievalGuidance: readonly string[];
}

// ---------------------------------------------------------------------------
// Phase 4: Specialist Subagent extensions
// ---------------------------------------------------------------------------

export interface AgentContextPolicyRef {
  /** Percentage at which the agent should request a handoff. */
  handoffPct: 70;
  /** Percentage at which the agent should emit a context warning. */
  warningPct: 60;
  /** Percentage at which the agent must stop immediately. */
  hardStopPct: 80;
}

export type AllowedWriteScopeMode = "read_only" | "explicit" | "inherited_subset";

export interface SubagentSpecialty {
  /** Unique identifier for this specialty within the parent agent. */
  id: string;
  /** Short human-readable label. */
  label: string;
  /** What this subagent specialty does. */
  description: string;
  /** Model alias to use when spawning. */
  defaultModel: ModelAlias;
  /** Effort level to apply when spawning. */
  defaultEffort: "high" | "medium" | "low";
  /** Tool names the subagent may call. */
  allowedTools: readonly string[];
  /** Tool names the subagent may never call (optional). */
  disallowedTools?: readonly string[] | undefined;
  /** Write scope mode: read_only means no writes; explicit means explicit list; inherited_subset means subset of parent. */
  allowedWriteScopeMode: AllowedWriteScopeMode;
  /** Maximum turns before the subagent must return a result packet. */
  maxTurns: number;
  /** JSON Schema describing the expected output packet (informational). */
  outputSchema: string;
}

export interface AgentSpawnPolicy {
  canSpawnSubagents: boolean;
  allowedSubagentTypes: readonly string[];
  maxChildDepth: number;
  maxConcurrentChildren: number;
  maxTotalChildrenPerTask: number;
  requiresWorktreeIsolation?: boolean | undefined;
}

/** V2 extends AgentCatalogEntry with optional Phase 4 fields. */
export interface AgentCatalogEntryV2 extends AgentCatalogEntry {
  contextPolicy?: AgentContextPolicyRef | undefined;
  spawnPolicy?: AgentSpawnPolicy | undefined;
  subagentSpecialties?: readonly SubagentSpecialty[] | undefined;
}

/**
 * Default spawn policy applied to agents that can spawn subagents.
 * Child depth limit of 2, max 3 concurrent children, max 8 total per task.
 */
export const defaultArchonSpawnPolicy: AgentSpawnPolicy = {
  canSpawnSubagents: true,
  allowedSubagentTypes: [],
  maxChildDepth: 2,
  maxConcurrentChildren: 3,
  maxTotalChildrenPerTask: 8
} as const;

export type AgentRoleId = keyof typeof agentCatalog;

export const agentRoleIds = Object.freeze(Object.keys(agentCatalog) as AgentRoleId[]);

export const agentCatalogEntries = Object.freeze(
  agentRoleIds.map((id) => ({
    id,
    ...agentCatalog[id]
  }))
);

// Role ids reach the runtime from loosely-typed sources: task packets authored
// by hand, `.claude/agents/` filenames, and `as`-cast owner roles. Those sources
// spell roles with hyphens ("agent-runtime-engineer") while the catalog keys with
// underscores ("agent_runtime_engineer"). Resolve a raw role string to a canonical
// catalog key, applying hyphen->underscore normalization. Returns `undefined` for
// genuinely unknown roles so callers can decide how to reject.
// Own-key membership set. Using `in` against the object would also match
// inherited keys ("__proto__", "constructor", "toString", ...), which would
// resolve to Object.prototype members cast as catalog entries. Match only the
// catalog's own role ids.
const agentRoleIdSet: ReadonlySet<string> = new Set(agentRoleIds);

export function normalizeAgentRoleId(raw: unknown): AgentRoleId | undefined {
  // `raw` is typed `unknown` on purpose: the loosely-typed/`as`-cast runtime
  // callers this function exists to defend can pass non-string values.
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (agentRoleIdSet.has(trimmed)) {
    return trimmed as AgentRoleId;
  }
  const underscored = trimmed.replace(/-/g, "_");
  if (agentRoleIdSet.has(underscored)) {
    return underscored as AgentRoleId;
  }
  return undefined;
}

export function getAgentCatalogEntry(role: AgentRoleId): (typeof agentCatalog)[AgentRoleId] {
  // The declared parameter type is AgentRoleId, but loosely-typed/`as`-cast
  // callers can pass a hyphenated or otherwise non-canonical value at runtime.
  // Normalize first, and fail loud with a diagnostic message instead of returning
  // `undefined` and letting callers crash on a deep property access.
  const normalized = normalizeAgentRoleId(role);
  if (!normalized) {
    throw new Error(
      `Unknown agent catalog role "${String(role)}": no catalog entry resolves for this role id (after hyphen/underscore normalization). Known roles: ${agentRoleIds.join(", ")}.`
    );
  }
  return agentCatalog[normalized];
}
