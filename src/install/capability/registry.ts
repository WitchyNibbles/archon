/**
 * Capability registry — declarative source of truth for what constitutes
 * "fullest capabilities" (council C4).
 *
 * Each entry declares the capability name and which probe layers apply.
 * S1 ships L0/L1 probes. S2/S3 fill in L2/L3 probe bodies.
 *
 * A test in tests/install/capability-engine.test.ts asserts that every entry
 * in C4_INVENTORY appears in CAPABILITY_REGISTRY, making "fullest" falsifiable.
 */
import type { ProbeLayer } from "./types.ts";

/** Declarative capability registry entry. */
export interface CapabilityEntry {
  readonly capability: string;
  readonly description: string;
  readonly layers: readonly ProbeLayer[];
}

/**
 * Full capability registry.
 * One entry per capability; layers declare which probe tiers apply.
 * Advisory-only capabilities (L2/L3 only) never block in verify context.
 */
export const CAPABILITY_REGISTRY: readonly CapabilityEntry[] = [
  {
    capability: "agents",
    description: "Agent catalog managed files (AGENTS.md, .claude/agents/) present and unmodified",
    layers: ["L0"],
  },
  {
    capability: "skills",
    description: "Repo-local skill surface (.claude/skills/archon-*) managed files present",
    layers: ["L0"],
  },
  {
    capability: "rules",
    description: "Archon rules (.archon/rules/) managed files present and unmodified",
    layers: ["L0"],
  },
  {
    capability: "hooks",
    description:
      "Archon hook scripts (.claude/hooks/) present and wired in .claude/settings.json (PreToolUse, PostToolUse, Stop)",
    layers: ["L0", "L1"],
  },
  {
    capability: "mcp-archon",
    description: "Archon MCP server registered in .mcp.json with mcpServers.archon key",
    layers: ["L0", "L1"],
  },
  {
    capability: "mcp-playwright",
    description: "Playwright MCP server registered in .mcp.json with mcpServers.playwright key",
    layers: ["L0", "L1"],
  },
  {
    capability: "ecc-plugin",
    description:
      "Everything-Claude-Code plugin installed and identity recognised (S2/S3: L2 external probe — skipped until S2 ships)",
    layers: ["L2"],
  },
  {
    capability: "db-migrations",
    description:
      "ARCHON_CORE_DATABASE_URL present in .env.archon and syntactically valid as a postgres:// URL",
    layers: ["L1"],
  },
  {
    capability: "git-guard",
    description:
      "Git guard scripts wired in package.json (archon:setup:git-guard, archon:verify:git-guard)",
    layers: ["L0", "L1"],
  },
  {
    capability: "playwright-browsers",
    description:
      "Playwright browser binaries installed (S2: L2 external probe — skipped until S2 ships)",
    layers: ["L2"],
  },
  {
    capability: "doctor",
    description:
      "archon:migrate script present in package.json; DB preflight operational (L3 via doctor — S2)",
    layers: ["L1", "L3"],
  },
  {
    capability: "workflow-scaffold",
    description: "Archon workflow scaffold template files (.archon/templates/) present",
    layers: ["L0"],
  },
];

/**
 * Minimum capability inventory required by council C4 ("fullest capabilities").
 * Tests assert CAPABILITY_REGISTRY covers every entry in this set.
 *
 * Invariant: C4_INVENTORY ⊆ CAPABILITY_REGISTRY.map(e => e.capability)
 */
export const C4_INVENTORY: readonly string[] = [
  "agents",
  "skills",
  "rules",
  "hooks",
  "mcp-archon",
  "mcp-playwright",
  "ecc-plugin",
  "db-migrations",
  "git-guard",
  "playwright-browsers",
  "doctor",
  "workflow-scaffold",
];
