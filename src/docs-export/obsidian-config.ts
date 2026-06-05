import { access } from "node:fs/promises";
import path from "node:path";
import type { ObsidianExportConfig } from "./models.ts";
import { validateTimezone } from "./date-resolver.ts";

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function sanitizeFolderConfig(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

export function resolveObsidianConfig(
  env: NodeJS.ProcessEnv,
  options: {
    cwd?: string | undefined;
    projectSlug: string;
  }
): ObsidianExportConfig {
  const defaultProject = env.ARCHON_OBSIDIAN_DEFAULT_PROJECT?.trim() || env.ARCHON_PROJECT_NAME?.trim() || options.projectSlug;
  const timezone = validateTimezone(env.ARCHON_OBSIDIAN_TIMEZONE?.trim() || "Europe/Madrid");
  const vaultPath = env.ARCHON_OBSIDIAN_VAULT_PATH?.trim();

  return {
    enabled: parseBooleanFlag(env.DEVGOD_OBSIDIAN_ENABLED, false),
    vaultPath: vaultPath ? path.resolve(options.cwd ?? process.cwd(), vaultPath) : undefined,
    defaultProject,
    dailyFolder: sanitizeFolderConfig(env.DEVGOD_OBSIDIAN_DAILY_FOLDER ?? "Devgod/Daily", "Devgod/Daily"),
    docsFolder: sanitizeFolderConfig(env.DEVGOD_OBSIDIAN_DOCS_FOLDER ?? "Devgod/Docs", "Devgod/Docs"),
    adrFolder: sanitizeFolderConfig(env.DEVGOD_OBSIDIAN_ADR_FOLDER ?? "Devgod/ADR", "Devgod/ADR"),
    timezone
  };
}

export async function validateObsidianConfig(config: ObsidianExportConfig): Promise<void> {
  if (!config.enabled) {
    throw new Error("Obsidian export is disabled. Set DEVGOD_OBSIDIAN_ENABLED=true to enable it.");
  }

  if (!config.vaultPath) {
    throw new Error("Obsidian vault path is not configured. Set ARCHON_OBSIDIAN_VAULT_PATH first.");
  }

  try {
    await access(config.vaultPath);
  } catch {
    throw new Error(`Configured Obsidian vault path does not exist: ${config.vaultPath}`);
  }
}
