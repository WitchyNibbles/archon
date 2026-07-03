/**
 * Consumer repair module — S5.
 *
 * Detects and heals the "hexchange class" of pre-P1 / stale consumer repos:
 *   - missing .mcp.json (detected; created by managed-file upgrade pass)
 *   - stale archon-managed mcpServers in .claude/settings.json (backed up + stripped)
 *   - missing .archon/install-manifest.json (detected; backfilled by upgrade pass)
 *   - stuck .archon/runtime/migration-report.json status "planned" (backed up + updated)
 *   - legacy workflow .sh scripts (detected; requires human migration to .ts form)
 *
 * All repairs are idempotent: re-running executeRepairs on an already-healed repo
 * converges to zero writes and zero backups.
 *
 * C12: every mutating op on a pre-existing consumer file routes through a
 * timestamped backup (`.archon/install-backups/<ts>/<rel-path>`) before any write.
 * Backup paths are recorded in the returned RepairReport.
 *
 * All file-system effects are injected via RepairFns so tests run without
 * touching the real filesystem.
 */
import path from "node:path";
import {
  cp as fsCp,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes a single stale archon-managed entry in .claude/settings.json mcpServers. */
export interface StaleSettingsMcpEntry {
  readonly serverName: string;
  readonly reason: string;
}

/**
 * A discriminated union of repair actions that detectRepairNeeds may return.
 * Each kind maps to a specific detection + optional repair step.
 */
export type RepairAction =
  | { readonly kind: "missing-mcp-json" }
  | {
      readonly kind: "stale-settings-mcp-entries";
      readonly staleEntries: readonly StaleSettingsMcpEntry[];
    }
  | { readonly kind: "missing-manifest" }
  | { readonly kind: "stuck-migration-report"; readonly currentStatus: string }
  | { readonly kind: "legacy-workflow-scripts"; readonly scriptPaths: readonly string[] };

export type RepairActionKind = RepairAction["kind"];

/** Description of a single action that executeRepairs actually applied. */
export interface RepairedAction {
  readonly kind: RepairActionKind;
  readonly description: string;
  /** C12: relative path of backup file created before the mutation, or undefined for new-file creation. */
  readonly backupPath: string | undefined;
}

/**
 * Summary of what detectRepairNeeds + executeRepairs found and did.
 *
 * - `detected`: all actions returned by detectRepairNeeds
 * - `repaired`: actions that executeRepairs applied (with C12 backup evidence)
 * - `notAutoRepaired`: detected but NOT handled by consumer-repair.ts
 *     (either handled by the upgrade managed-file pass or require human action)
 * - `backupPaths`: all C12 backup file paths, for verification
 * - `skillRefAdvisoryActive`: true when the consumer likely has stale
 *     everything-claude-code:* skill refs; operator should run --migrate-skill-refs (S6)
 */
export interface RepairReport {
  readonly detected: readonly RepairAction[];
  readonly repaired: readonly RepairedAction[];
  readonly notAutoRepaired: readonly string[];
  readonly backupPaths: readonly string[];
  readonly skillRefAdvisoryActive: boolean;
}

/**
 * Injectable file-system effects for consumer repair.
 * All paths passed to these functions are absolute.
 *
 * - readFile: returns content string, or undefined if file is absent (never throws for ENOENT).
 * - writeFile: creates parent dirs + writes content; throws on real I/O failure.
 * - copyFile: copies src → dest (dest's parent dir must already exist OR ensureDir called first).
 * - ensureDir: creates the directory (and parents) if it doesn't exist; no-op if exists.
 */
export interface RepairFns {
  readonly readFile: (absolutePath: string) => Promise<string | undefined>;
  readonly writeFile: (absolutePath: string, content: string) => Promise<void>;
  readonly copyFile: (src: string, dest: string) => Promise<void>;
  readonly ensureDir: (absolutePath: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Archon-managed MCP server names.
 * Entries for these names in .claude/settings.json mcpServers are stale when
 * they contain OLD patterns (pre-@witchynibbles/archon paths, @latest, --yes).
 * Correct location after #140: .mcp.json.
 */
const ARCHON_MANAGED_SERVER_NAMES: ReadonlySet<string> = new Set([
  "archon",
  "grafana",
  "playwright",
  "playwright_vision",
  "obsidian",
]);

/** Relative paths within the consumer repo root. */
const MCP_JSON_REL = ".mcp.json";
const SETTINGS_JSON_REL = ".claude/settings.json";
const INSTALL_MANIFEST_REL = ".archon/install-manifest.json";
const MIGRATION_REPORT_REL = ".archon/runtime/migration-report.json";
const LEGACY_WORKFLOW_SH_REL = "scripts/check-archon-workflow.sh";
const BACKUP_ROOT_REL = ".archon/install-backups";

// ---------------------------------------------------------------------------
// Stale entry detection helpers
// ---------------------------------------------------------------------------

function extractStringArgs(entry: unknown): string[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const args = (entry as Record<string, unknown>).args;
  if (!Array.isArray(args)) return [];
  return args.filter((a): a is string => typeof a === "string");
}

/**
 * Returns a human-readable reason string if the entry is a stale archon-managed
 * MCP server config, or undefined if it is unknown / already current.
 *
 * Stale markers:
 *   - "node_modules/archon/src/" in any arg (pre-@witchynibbles/archon path)
 *   - "@latest" substring in any arg (unpinned; disallowed post-#140)
 *   - "--yes" as a standalone arg (auto-confirm; disallowed post-#140)
 */
function getStaleReason(serverName: string, entry: unknown): string | undefined {
  if (!ARCHON_MANAGED_SERVER_NAMES.has(serverName)) return undefined;

  const args = extractStringArgs(entry);
  const reasons: string[] = [];

  if (args.some((a) => a.includes("node_modules/archon/src/"))) {
    reasons.push("unscoped node_modules/archon/src path (pre-@witchynibbles/archon)");
  }
  if (args.some((a) => a.includes("@latest"))) {
    reasons.push("@latest form (unpinned, disallowed)");
  }
  if (args.includes("--yes")) {
    reasons.push("--yes flag (auto-confirm, disallowed)");
  }

  return reasons.length > 0 ? reasons.join("; ") : undefined;
}

function detectStaleMcpEntries(settingsJson: string): StaleSettingsMcpEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return [];

  const staleEntries: StaleSettingsMcpEntry[] = [];
  for (const [serverName, entry] of Object.entries(
    mcpServers as Record<string, unknown>
  )) {
    const reason = getStaleReason(serverName, entry);
    if (reason) {
      staleEntries.push({ serverName, reason });
    }
  }
  return staleEntries;
}

// ---------------------------------------------------------------------------
// detectRepairNeeds
// ---------------------------------------------------------------------------

/**
 * Reads the consumer repo and returns the list of repair actions needed.
 * READ-ONLY — never writes. Safe to call multiple times on the same repo.
 *
 * @param targetRoot Absolute path to the consumer repo root.
 * @param readFn Injected file reader — returns undefined when the file is absent.
 *               Receives absolute paths.
 */
export async function detectRepairNeeds(
  targetRoot: string,
  readFn: (absolutePath: string) => Promise<string | undefined>
): Promise<readonly RepairAction[]> {
  const actions: RepairAction[] = [];

  // 1. .mcp.json presence
  const mcpJson = await readFn(path.join(targetRoot, MCP_JSON_REL));
  if (mcpJson === undefined) {
    actions.push({ kind: "missing-mcp-json" });
  }

  // 2. Stale archon-managed mcpServers in .claude/settings.json
  const settingsJson = await readFn(path.join(targetRoot, SETTINGS_JSON_REL));
  if (settingsJson !== undefined) {
    const staleEntries = detectStaleMcpEntries(settingsJson);
    if (staleEntries.length > 0) {
      actions.push({ kind: "stale-settings-mcp-entries", staleEntries });
    }
  }

  // 3. Missing install manifest
  const manifest = await readFn(path.join(targetRoot, INSTALL_MANIFEST_REL));
  if (manifest === undefined) {
    actions.push({ kind: "missing-manifest" });
  }

  // 4. Stuck migration-report (status "planned")
  const migrationReport = await readFn(path.join(targetRoot, MIGRATION_REPORT_REL));
  if (migrationReport !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(migrationReport);
    } catch {
      parsed = undefined;
    }
    const status =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).status
        : undefined;
    if (typeof status === "string" && status === "planned") {
      actions.push({ kind: "stuck-migration-report", currentStatus: status });
    }
  }

  // 5. Legacy workflow .sh script
  const legacySh = await readFn(path.join(targetRoot, LEGACY_WORKFLOW_SH_REL));
  if (legacySh !== undefined) {
    actions.push({
      kind: "legacy-workflow-scripts",
      scriptPaths: [LEGACY_WORKFLOW_SH_REL],
    });
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Backup helper — C12
// ---------------------------------------------------------------------------

/**
 * C12: copies the existing consumer file to a timestamped backup directory
 * BEFORE any mutation. Returns the relative backup path for the RepairReport.
 *
 * Backup layout: `.archon/install-backups/<timestamp>/<relPath>`
 * Mirrors the existing convention in cli.ts `backupExistingFile`.
 */
async function backupFile(
  targetRoot: string,
  relPath: string,
  timestamp: string,
  fns: RepairFns
): Promise<string> {
  const backupRelPath = `${BACKUP_ROOT_REL}/${timestamp}/${relPath}`;
  const backupAbsPath = path.join(targetRoot, backupRelPath);
  const srcAbsPath = path.join(targetRoot, relPath);
  await fns.ensureDir(path.dirname(backupAbsPath));
  await fns.copyFile(srcAbsPath, backupAbsPath);
  return backupRelPath;
}

// ---------------------------------------------------------------------------
// Repair: stale settings.json mcpServers
// ---------------------------------------------------------------------------

/**
 * Strips stale archon-managed entries from .claude/settings.json mcpServers,
 * leaving user-managed entries (e.g. gitnexus) untouched.
 *
 * If mcpServers becomes empty after stripping, the key is removed entirely.
 * Returns the updated JSON string, or the original on parse failure (safe no-op).
 */
export function stripStaleMcpEntriesFromSettings(
  settingsJson: string,
  staleNames: ReadonlySet<string>
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(settingsJson) as Record<string, unknown>;
  } catch {
    return settingsJson;
  }

  const mcpServers = parsed.mcpServers;
  if (
    !mcpServers ||
    typeof mcpServers !== "object" ||
    Array.isArray(mcpServers)
  ) {
    return settingsJson;
  }

  const retained: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!staleNames.has(k)) {
      retained[k] = v;
    }
  }

  let updated: Record<string, unknown>;
  if (Object.keys(retained).length === 0) {
    const { mcpServers: _removed, ...rest } = parsed;
    updated = rest;
  } else {
    updated = { ...parsed, mcpServers: retained };
  }

  return `${JSON.stringify(updated, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Repair: stuck migration-report
// ---------------------------------------------------------------------------

/**
 * Advances migration-report.json from status "planned" to "upgrade-applied",
 * preserving all other fields.
 *
 * Honest semantics: status "upgrade-applied" reflects that an upgrade was run.
 * The writeRuntimeMigrationArtifacts call later in the upgrade flow may
 * overwrite this with the authoritative post-upgrade report (also "upgrade-applied").
 *
 * Returns the updated JSON string, or the original on parse failure.
 */
export function advanceMigrationReportStatus(
  existingContent: string,
  upgradedAt: string
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingContent);
  } catch {
    return existingContent;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return existingContent;
  }

  const updated = {
    ...(parsed as Record<string, unknown>),
    status: "upgrade-applied",
    upgradedAt,
  };

  return `${JSON.stringify(updated, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// executeRepairs
// ---------------------------------------------------------------------------

/**
 * Applies the repair actions returned by detectRepairNeeds.
 *
 * Repairs applied here (C12 backup before every mutation):
 *   - stale-settings-mcp-entries → backup .claude/settings.json → strip stale entries
 *   - stuck-migration-report → backup migration-report.json → advance to "upgrade-applied"
 *
 * NOT auto-repaired (see notAutoRepaired in the returned report):
 *   - missing-mcp-json → created by the managed-file upgrade pass
 *   - missing-manifest → backfilled by loadInstallManifestOrBackfill in the upgrade pass
 *   - legacy-workflow-scripts → requires human migration to .ts form
 *
 * All applied repairs are idempotent: re-running with the same detected actions
 * on an already-healed repo produces zero writes and zero backups.
 *
 * @param targetRoot Absolute path to the consumer repo root.
 * @param actions Actions returned by detectRepairNeeds.
 * @param timestamp ISO timestamp string used for backup directory naming.
 * @param fns Injected file-system effects; use createDefaultRepairFns() in production.
 */
export async function executeRepairs(
  targetRoot: string,
  actions: readonly RepairAction[],
  timestamp: string,
  fns: RepairFns
): Promise<RepairReport> {
  const repaired: RepairedAction[] = [];
  const notAutoRepaired: string[] = [];
  const backupPaths: string[] = [];

  // Detect skill-ref advisory: active when stale settings entries are present
  // (pre-P1 consumer likely also has everything-claude-code:* skill refs in AGENT.md files)
  const hasStaleSettings = actions.some(
    (a) => a.kind === "stale-settings-mcp-entries"
  );
  const skillRefAdvisoryActive = hasStaleSettings;

  for (const action of actions) {
    switch (action.kind) {
      case "stale-settings-mcp-entries": {
        // C12: backup BEFORE any write
        const settingsAbsPath = path.join(targetRoot, SETTINGS_JSON_REL);
        const existing = await fns.readFile(settingsAbsPath);
        if (existing === undefined) {
          // File was removed between detect and repair — nothing to strip
          notAutoRepaired.push(
            "stale-settings-mcp-entries: .claude/settings.json not found at repair time (skipped)"
          );
          break;
        }

        const staleNames = new Set(
          action.staleEntries.map((e) => e.serverName)
        );

        // Verify there is still something to strip (idempotency guard)
        const stillStale = detectStaleMcpEntries(existing);
        const stillNamed = stillStale.filter((e) => staleNames.has(e.serverName));
        if (stillNamed.length === 0) {
          // Already clean — no backup, no write
          break;
        }

        const backupPath = await backupFile(
          targetRoot,
          SETTINGS_JSON_REL,
          timestamp,
          fns
        );
        backupPaths.push(backupPath);

        const stripped = stripStaleMcpEntriesFromSettings(existing, staleNames);
        await fns.writeFile(settingsAbsPath, stripped);

        repaired.push({
          kind: "stale-settings-mcp-entries",
          description: `Stripped ${stillNamed.length} stale archon-managed mcpServers entries from ${SETTINGS_JSON_REL} (${stillNamed.map((e) => e.serverName).join(", ")}). Backup: ${backupPath}`,
          backupPath,
        });
        break;
      }

      case "stuck-migration-report": {
        // C12: backup BEFORE any write
        const reportAbsPath = path.join(targetRoot, MIGRATION_REPORT_REL);
        const existing = await fns.readFile(reportAbsPath);
        if (existing === undefined) {
          notAutoRepaired.push(
            "stuck-migration-report: migration-report.json not found at repair time (skipped)"
          );
          break;
        }

        // Idempotency guard: only advance if still "planned"
        let currentStatus: unknown;
        try {
          const p = JSON.parse(existing) as Record<string, unknown>;
          currentStatus = p.status;
        } catch {
          currentStatus = undefined;
        }
        if (currentStatus !== "planned") {
          // Already advanced — skip
          break;
        }

        const backupPath = await backupFile(
          targetRoot,
          MIGRATION_REPORT_REL,
          timestamp,
          fns
        );
        backupPaths.push(backupPath);

        const updated = advanceMigrationReportStatus(existing, timestamp);
        await fns.writeFile(reportAbsPath, updated);

        repaired.push({
          kind: "stuck-migration-report",
          description: `Advanced migration-report.json status from "planned" to "upgrade-applied". Backup: ${backupPath}`,
          backupPath,
        });
        break;
      }

      case "missing-mcp-json":
        notAutoRepaired.push(
          "missing-mcp-json: .mcp.json will be created by the managed-file upgrade pass"
        );
        break;

      case "missing-manifest":
        notAutoRepaired.push(
          "missing-manifest: .archon/install-manifest.json will be backfilled by the upgrade pass"
        );
        break;

      case "legacy-workflow-scripts":
        notAutoRepaired.push(
          `legacy-workflow-scripts: ${action.scriptPaths.join(", ")} — migrate to scripts/check-archon-workflow.ts (TypeScript form); see archon documentation`
        );
        break;

      default: {
        const _exhaustive: never = action;
        break;
      }
    }
  }

  return {
    detected: actions,
    repaired,
    notAutoRepaired,
    backupPaths,
    skillRefAdvisoryActive,
  };
}

// ---------------------------------------------------------------------------
// Default production implementations of RepairFns
// ---------------------------------------------------------------------------

/**
 * Creates the default RepairFns backed by the real Node.js fs APIs.
 * Use in production (cli.ts upgrade path).
 * Use injected stubs in tests.
 */
export function createDefaultRepairFns(): RepairFns {
  return {
    async readFile(absolutePath: string): Promise<string | undefined> {
      try {
        return await fsReadFile(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },
    async writeFile(absolutePath: string, content: string): Promise<void> {
      await fsMkdir(path.dirname(absolutePath), { recursive: true });
      await fsWriteFile(absolutePath, content, "utf8");
    },
    async copyFile(src: string, dest: string): Promise<void> {
      await fsCp(src, dest);
    },
    async ensureDir(absolutePath: string): Promise<void> {
      await fsMkdir(absolutePath, { recursive: true });
    },
  };
}
