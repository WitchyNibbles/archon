/**
 * Next-steps derivation for archon install commands.
 *
 * Extracted from cli.ts to keep that file under the 800-line limit and so
 * next-steps logic is independently testable.
 *
 * Evidence B (design §1a): init next-steps previously omitted the three
 * essential DB setup steps. They are included here.
 */
import type { InstallMode } from "./types.ts";

export interface BuildNextStepsOptions {
  readonly withGrafana: boolean;
  readonly withObsidian: boolean;
}

/**
 * Returns the ordered list of next-steps messages for init/upgrade commands.
 *
 * Command × mode matrix:
 *   upgrade dry-run  — review, resolve conflicts, re-run apply, then verify.
 *   upgrade apply    — review backups, verify, resolve orphans.
 *   init dry-run     — review, re-run apply, install deps, set up env, migrate.
 *   init apply       — install deps, set up env, run migrate + bootstrap.
 */
export function buildNextSteps(
  command: "init" | "upgrade",
  mode: InstallMode,
  options: BuildNextStepsOptions
): string[] {
  if (command === "upgrade") {
    if (mode === "dry-run") {
      return [
        "Review the planned upgrade changes, conflicts, and orphans.",
        "Resolve any conflicts before applying the upgrade.",
        "Rerun in apply mode to write the planned managed-file updates.",
        "Run verify after the upgrade to confirm the managed surface is clean.",
        options.withGrafana
          ? "If you want Grafana-backed logs, set ARCHON_GRAFANA_URL plus auth in .env.archon, then use the grafana MCP tools from Codex."
          : "Optional: rerun upgrade with --with-grafana to install the Grafana MCP server wiring for log-backed debugging and research.",
        options.withObsidian
          ? "After apply, set ARCHON_OBSIDIAN_VAULT_PATH and DEVGOD_OBSIDIAN_ENABLED=true in .env.archon to enable Obsidian export and mcpvault tools."
          : "Optional: rerun upgrade with --with-obsidian to install mcpvault MCP wiring for Obsidian knowledge-base integration.",
        "After apply, run npm run archon:setup:git-guard and npm run archon:verify:git-guard.",
      ];
    }

    return [
      "Review any backups under .archon/install-backups/ if you changed managed files locally.",
      "Run verify to confirm the managed surface is clean.",
      options.withGrafana
        ? "Fill in ARCHON_GRAFANA_URL plus auth and datasource settings in .env.archon before using Grafana-backed log tools."
        : "Optional: rerun upgrade with --with-grafana to install the Grafana MCP server wiring for log-backed debugging and research.",
      options.withObsidian
        ? "Set ARCHON_OBSIDIAN_VAULT_PATH and DEVGOD_OBSIDIAN_ENABLED=true in .env.archon before using the Obsidian export and mcpvault tools."
        : "Optional: rerun upgrade with --with-obsidian to install mcpvault MCP wiring for Obsidian knowledge-base integration.",
      "Run npm run archon:setup:git-guard and npm run archon:verify:git-guard.",
      "Resolve any reported orphans manually if the current package no longer manages them.",
    ];
  }

  // init
  if (mode === "dry-run") {
    return [
      "Review the planned file changes.",
      "Rerun in apply mode to write changes.",
      "After apply, run npm install in the target project.",
      "After npm install, copy .env.archon.example to .env.archon and set ARCHON_CORE_DATABASE_URL.",
      "After apply, run npm run archon:setup:git-guard and npm run archon:verify:git-guard.",
      "If you want the shipped local runtime bootstrap path, run npm run archon:setup:local.",
      options.withGrafana
        ? "If you want Grafana-backed logs, set ARCHON_GRAFANA_URL plus auth and datasource settings in .env.archon after apply."
        : "Optional: rerun init with --with-grafana to add Grafana MCP wiring for log-backed debugging and research.",
      options.withObsidian
        ? "If you want Obsidian export and mcpvault, set ARCHON_OBSIDIAN_VAULT_PATH and DEVGOD_OBSIDIAN_ENABLED=true in .env.archon after apply."
        : "Optional: rerun init with --with-obsidian to add mcpvault MCP wiring for Obsidian knowledge-base integration.",
      "Implement archon/review-identity-adapter.ts before trusting review actions or running npm run archon:record-review.",
    ];
  }

  // init apply
  return [
    "cd into the target project.",
    "Run npm install.",
    "Copy .env.archon.example to .env.archon and set ARCHON_CORE_DATABASE_URL=postgres://user:password@host:port/dbname.",
    "Run npm run archon:migrate to apply database migrations.",
    "Run npx archon bootstrap-project to register the project in the archon runtime.",
    "Run npm run archon:setup:git-guard and npm run archon:verify:git-guard.",
    "If you want the shipped local runtime bootstrap path, run npm run archon:setup:local.",
    options.withGrafana
      ? "Fill in ARCHON_GRAFANA_URL plus auth and datasource settings in .env.archon before using the Grafana MCP tools."
      : "Optional: rerun init with --with-grafana to add Grafana MCP wiring for log-backed debugging and research.",
    options.withObsidian
      ? "Set ARCHON_OBSIDIAN_VAULT_PATH and DEVGOD_OBSIDIAN_ENABLED=true in .env.archon to use Obsidian export and mcpvault knowledge-base tools."
      : "Optional: rerun init with --with-obsidian to add mcpvault MCP wiring for Obsidian knowledge-base integration.",
    "Implement archon/review-identity-adapter.ts, run npm run archon:verify:review-identity, then use npm run archon:record-review for live review actions.",
  ];
}
