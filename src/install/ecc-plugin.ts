/**
 * ECC plugin management for archon install.
 *
 * Owns the package-level ECC identity contract:
 *   - Hardcoded identity constants (council C7)
 *   - Plugin list parser (shared with probes-external.ts)
 *   - Identity acceptance and legacy detection
 *   - Version record I/O (.archon/ecc-plugin-record.json)
 *   - Consented install automation (idempotent, ~/.claude writes only under consent)
 *
 * Council compliance:
 *   C5: ~/.claude writes ONLY via runConsentedEccInstall; NEVER triggered by --yes alone.
 *       The caller (cli.ts main()) only calls this when installPlugin flag is explicitly set.
 *   C6: Installed ECC identity+version recorded in consumer .archon/ecc-plugin-record.json;
 *       major version bump detected and returns needs-confirmation state requiring re-run
 *       with --confirm-ecc-major.  Version shown after install via the returned record.
 *   C7: ALL claude CLI invocations use injected SpawnFn with array args, shell:false.
 *       Plugin and marketplace names are HARDCODED package constants; never derived from
 *       config, CLI arguments, or user input.
 *   C13: Consented install is idempotent; repeated runs detect already-installed state
 *        and skip actual CLI calls.
 */
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { SpawnFn } from "./capability/probes-external.ts";
import type { ReadFileFn } from "./capability/probes-file.ts";

// ---------------------------------------------------------------------------
// Injectable types
// ---------------------------------------------------------------------------

/** Injectable function to write a file (used to record ECC install state). */
export type WriteFileFn = (absolutePath: string, content: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Package constants (council C7: HARDCODED, never config/targetArg-derived)
// ---------------------------------------------------------------------------

/**
 * GitHub repo hosting the canonical ECC marketplace.json.
 * Used in: claude plugin marketplace add <ECC_MARKETPLACE_SOURCE>
 * HARDCODED — never derived from config or CLI arguments.
 */
export const ECC_MARKETPLACE_SOURCE = "affaan-m/ECC";

/**
 * Canonical plugin name as defined in affaan-m/ECC marketplace.json.
 * HARDCODED — never derived from config or CLI arguments.
 */
export const ECC_CANONICAL_PLUGIN_NAME = "ecc";

/**
 * Canonical marketplace name registered via `claude plugin marketplace add`.
 * HARDCODED — never derived from config or CLI arguments.
 */
export const ECC_CANONICAL_MARKETPLACE = "ecc";

/**
 * Canonical install identity: <plugin-name>@<marketplace-name>.
 * Used in: claude plugin install <ECC_CANONICAL_IDENTITY>
 * HARDCODED — never derived from config or CLI arguments.
 */
export const ECC_CANONICAL_IDENTITY = `${ECC_CANONICAL_PLUGIN_NAME}@${ECC_CANONICAL_MARKETPLACE}`;

/**
 * Legacy plugin name (repository renamed affaan-m/everything-claude-code → affaan-m/ECC).
 * Existing installs still show this identity. Accepted as "present" but raises a
 * migration advisory directing operators to reinstall with canonical identity.
 */
export const ECC_LEGACY_PLUGIN_NAME = "everything-claude-code";

/**
 * Skill-ref namespace prefix used in consumer AGENT.md files for canonical ECC skills.
 * Skills installed as ecc@ecc expose the "ecc:" namespace.
 */
export const ECC_CANONICAL_SKILL_PREFIX = `${ECC_CANONICAL_PLUGIN_NAME}:`;

/**
 * Skill-ref namespace prefix used in consumer AGENT.md files for legacy ECC skills.
 * Skills installed as everything-claude-code@* expose the "everything-claude-code:" namespace.
 */
export const ECC_LEGACY_SKILL_PREFIX = `${ECC_LEGACY_PLUGIN_NAME}:`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single installed plugin parsed from `claude plugin list` stdout. */
export interface InstalledPlugin {
  readonly identity: string;     // "<name>@<marketplace>"
  readonly name: string;
  readonly marketplace: string;
  readonly version: string;
  readonly enabled: boolean;
}

/** Recorded ECC install state written to .archon/ecc-plugin-record.json. */
export interface EccPluginRecord {
  /** Plugin identity as reported by `claude plugin list`, e.g. "ecc@ecc". */
  readonly identity: string;
  /** Plugin version as reported by `claude plugin list`, e.g. "2.0.0". */
  readonly version: string;
  /** ISO 8601 timestamp when this record was written. */
  readonly installedAt: string;
}

/** Possible outcomes of runConsentedEccInstall. */
export type EccInstallResult =
  | { readonly status: "installed"; readonly record: EccPluginRecord }
  | { readonly status: "already-installed"; readonly record: EccPluginRecord }
  | {
      readonly status: "needs-confirmation";
      readonly reason: "major-bump";
      /** The version already installed on this machine. */
      readonly installedVersion: string;
      /** The version previously recorded in .archon/ecc-plugin-record.json. */
      readonly recordedVersion: string;
    }
  | { readonly status: "failed"; readonly error: string };

// ---------------------------------------------------------------------------
// Plugin list parsing
// ---------------------------------------------------------------------------

/**
 * Parses `claude plugin list` stdout into a list of installed plugins.
 *
 * Real output format (captured 2026-07-02, see tests/install/fixtures/claude-plugin-list.txt):
 *   Installed plugins:
 *
 *     ❯ everything-claude-code@everything-claude-code
 *       Version: 1.8.0
 *       Scope: user
 *       Status: ✔ enabled
 *
 * Returns an empty array on empty/null input or parse failure — never throws.
 * Parses state machine-style to be robust to extra fields or whitespace.
 */
export function parsePluginList(stdout: string): readonly InstalledPlugin[] {
  const plugins: InstalledPlugin[] = [];
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return plugins;
  }

  const lines = stdout.split("\n");
  let currentName: string | undefined;
  let currentMarketplace: string | undefined;
  let currentVersion: string | undefined;
  let currentEnabled: boolean | undefined;

  const flushPlugin = () => {
    if (currentName !== undefined && currentMarketplace !== undefined) {
      plugins.push({
        identity: `${currentName}@${currentMarketplace}`,
        name: currentName,
        marketplace: currentMarketplace,
        version: currentVersion ?? "unknown",
        enabled: currentEnabled ?? true,
      });
    }
    currentName = undefined;
    currentMarketplace = undefined;
    currentVersion = undefined;
    currentEnabled = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Plugin header line: "❯ <name>@<marketplace>" or "❯ <name>@<marketplace>"
    if (trimmed.startsWith("❯ ") || trimmed.startsWith("❯ ")) {
      flushPlugin();
      const rest = trimmed.slice(2).trim();
      const atIdx = rest.indexOf("@");
      if (atIdx > 0) {
        currentName = rest.slice(0, atIdx);
        currentMarketplace = rest.slice(atIdx + 1);
      }
      continue;
    }

    // Version field: "Version: <ver>"
    const versionMatch = /^Version:\s+(.+)$/.exec(trimmed);
    if (versionMatch !== null) {
      currentVersion = versionMatch[1]?.trim();
      continue;
    }

    // Status field: "Status: ✔ enabled" or "Status: ✘ disabled"
    const statusMatch = /^Status:\s+(.+)$/.exec(trimmed);
    if (statusMatch !== null) {
      currentEnabled = (statusMatch[1]?.trim() ?? "").includes("enabled");
      continue;
    }
  }

  flushPlugin();
  return plugins;
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the plugin identity is in the accepted ECC identity set.
 * Canonical: exactly "ecc@ecc".
 * Legacy: anything starting with "everything-claude-code@".
 *
 * Both count as ECC "present" for capability probing.
 * Legacy additionally raises a migration advisory.
 */
export function isAcceptedEccIdentity(identity: string): boolean {
  return (
    identity === ECC_CANONICAL_IDENTITY ||
    identity.startsWith(`${ECC_LEGACY_PLUGIN_NAME}@`)
  );
}

/**
 * Returns true if the identity is a legacy ECC identity (migration advisory warranted).
 * Legacy = accepted (so "present") but NOT the canonical identity.
 */
export function isLegacyEccIdentity(identity: string): boolean {
  return (
    identity !== ECC_CANONICAL_IDENTITY &&
    identity.startsWith(`${ECC_LEGACY_PLUGIN_NAME}@`)
  );
}

// ---------------------------------------------------------------------------
// Version record I/O (C6)
// ---------------------------------------------------------------------------

/** Relative path to the ECC plugin version record in the consumer repo. */
export const ECC_PLUGIN_RECORD_RELATIVE_PATH = ".archon/ecc-plugin-record.json";

/**
 * Reads the ECC plugin record from the consumer's .archon/ecc-plugin-record.json.
 * Returns undefined if the file is absent, unreadable, or malformed.
 * Never throws.
 */
export async function readEccPluginRecord(
  readFileFn: ReadFileFn,
  targetRoot: string
): Promise<EccPluginRecord | undefined> {
  const absolutePath = path.join(targetRoot, ECC_PLUGIN_RECORD_RELATIVE_PATH);
  let content: string | undefined;
  try {
    content = await readFileFn(absolutePath);
  } catch {
    return undefined;
  }
  if (!content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return undefined;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.identity === "string" &&
      typeof candidate.version === "string" &&
      typeof candidate.installedAt === "string"
    ) {
      return {
        identity: candidate.identity,
        version: candidate.version,
        installedAt: candidate.installedAt,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the ECC plugin record to .archon/ecc-plugin-record.json.
 * The provided writeFileFn must create parent directories if needed.
 */
export async function writeEccPluginRecord(
  writeFileFn: WriteFileFn,
  targetRoot: string,
  record: EccPluginRecord
): Promise<void> {
  const absolutePath = path.join(targetRoot, ECC_PLUGIN_RECORD_RELATIVE_PATH);
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await writeFileFn(absolutePath, content);
}

// ---------------------------------------------------------------------------
// Major version bump detection (C6)
// ---------------------------------------------------------------------------

/**
 * Returns true if newVersion's major component is strictly higher than recordedVersion's.
 * Returns false if either version string is unparseable (conservative — no false-positive blocks).
 */
export function checkMajorVersionBump(recordedVersion: string, newVersion: string): boolean {
  const recordedMajor = parseInt(recordedVersion.split(".")[0] ?? "", 10);
  const newMajor = parseInt(newVersion.split(".")[0] ?? "", 10);
  if (isNaN(recordedMajor) || isNaN(newMajor)) {
    return false;
  }
  return newMajor > recordedMajor;
}

// ---------------------------------------------------------------------------
// Default injectable implementations (for use by cli.ts and runtime.ts)
// ---------------------------------------------------------------------------

/**
 * Creates a SpawnFn backed by node:child_process spawn with shell:false.
 * Council C7: shell=false ensures no shell injection; caller provides array args.
 */
export function createDefaultEccSpawnFn(): SpawnFn {
  return (command, args, stdinData) =>
    new Promise((resolve, reject) => {
      const child = nodeSpawn(command, [...args], {
        shell: false,
        stdio: stdinData !== undefined
          ? ["pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("exit", (code) => { resolve({ exitCode: code, stdout, stderr }); });
      if (stdinData !== undefined && child.stdin) {
        child.stdin.write(stdinData, "utf8");
        child.stdin.end();
      }
    });
}

/** Creates a ReadFileFn backed by node:fs/promises. Returns undefined on missing files. */
export function createDefaultEccReadFileFn(): ReadFileFn {
  return async (absolutePath: string) => {
    try {
      return await readFile(absolutePath, "utf8");
    } catch {
      return undefined;
    }
  };
}

/**
 * Creates a WriteFileFn backed by node:fs/promises.
 * Creates parent directories recursively before writing.
 */
export function createDefaultEccWriteFileFn(): WriteFileFn {
  return async (absolutePath: string, content: string) => {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  };
}

// ---------------------------------------------------------------------------
// Consented install (C5, C6, C7, C13)
// ---------------------------------------------------------------------------

/**
 * The claude CLI binary name — hardcoded package constant (C7).
 * Never derived from config or CLI arguments.
 */
const CLAUDE_CLI = "claude";

/**
 * Spawns `claude plugin list` and returns the raw stdout.
 * Returns undefined on spawn failure, missing CLI, or non-zero exit.
 */
async function spawnPluginList(spawnFn: SpawnFn): Promise<string | undefined> {
  try {
    // C7: array args, hardcoded command constant
    const result = await spawnFn(CLAUDE_CLI, ["plugin", "list"]);
    if (result.exitCode !== 0) {
      return undefined;
    }
    return result.stdout;
  } catch {
    return undefined;
  }
}

/**
 * Runs the consented ECC plugin install automation.
 *
 * INVARIANT (C5): This function MUST only be called under explicit --install-plugin
 * or interactive consent. NEVER called when only --yes is provided. The cli.ts
 * main() function enforces this by checking parsedArgs.installPlugin.
 *
 * Install sequence (all CLI calls: array args, hardcoded constants, shell:false via spawnFn — C7):
 *   1. Spawn `claude plugin list` → check if ECC already installed (idempotency, C13)
 *   2. If already installed with an accepted identity: check major version bump (C6),
 *      update version record, return already-installed.
 *   3. Spawn `claude plugin marketplace add affaan-m/ECC` (idempotent — already-present ok)
 *   4. Spawn `claude plugin install ecc@ecc`
 *   5. Spawn `claude plugin list` again to capture actual installed version (C6)
 *   6. Write .archon/ecc-plugin-record.json with {identity, version, installedAt} (C6)
 *
 * @param confirmMajorBump - When true, bypasses the major-version confirmation gate.
 *   Set this when the caller has received --confirm-ecc-major from the user.
 */
export async function runConsentedEccInstall(
  spawnFn: SpawnFn,
  readFileFn: ReadFileFn,
  writeFileFn: WriteFileFn,
  targetRoot: string,
  opts?: { readonly confirmMajorBump?: boolean }
): Promise<EccInstallResult> {
  // Check existing recorded version (C6)
  const existingRecord = await readEccPluginRecord(readFileFn, targetRoot);

  // Step 1: Get current install state via plugin list (C7: array args, hardcoded command)
  const listOutput = await spawnPluginList(spawnFn);
  const plugins = listOutput !== undefined ? parsePluginList(listOutput) : [];
  const eccPlugin = plugins.find((p) => isAcceptedEccIdentity(p.identity));

  if (eccPlugin !== undefined) {
    // Already installed. C6: check for major version bump.
    if (
      existingRecord !== undefined &&
      checkMajorVersionBump(existingRecord.version, eccPlugin.version) &&
      !(opts?.confirmMajorBump ?? false)
    ) {
      return {
        status: "needs-confirmation",
        reason: "major-bump",
        installedVersion: eccPlugin.version,
        recordedVersion: existingRecord.version,
      };
    }

    // C6: Write / refresh version record. Preserve original installedAt if re-running.
    const record: EccPluginRecord = {
      identity: eccPlugin.identity,
      version: eccPlugin.version,
      installedAt: existingRecord?.installedAt ?? new Date().toISOString(),
    };
    await writeEccPluginRecord(writeFileFn, targetRoot, record);
    return { status: "already-installed", record };
  }

  // Step 3: marketplace add (C7: ECC_MARKETPLACE_SOURCE constant, array args, shell:false)
  // Non-zero exit may mean "already registered" — we proceed to install regardless.
  try {
    await spawnFn(CLAUDE_CLI, ["plugin", "marketplace", "add", ECC_MARKETPLACE_SOURCE]);
  } catch (err) {
    return {
      status: "failed",
      error: `Failed to spawn 'claude plugin marketplace add ${ECC_MARKETPLACE_SOURCE}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Step 4: plugin install (C7: ECC_CANONICAL_IDENTITY constant, array args, shell:false)
  let installResult: { exitCode: number | null; stdout: string; stderr: string };
  try {
    installResult = await spawnFn(CLAUDE_CLI, ["plugin", "install", ECC_CANONICAL_IDENTITY]);
  } catch (err) {
    return {
      status: "failed",
      error: `Failed to spawn 'claude plugin install ${ECC_CANONICAL_IDENTITY}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (installResult.exitCode !== 0) {
    return {
      status: "failed",
      error:
        `'claude plugin install ${ECC_CANONICAL_IDENTITY}' exited ${String(installResult.exitCode)}: ` +
        installResult.stderr.slice(0, 200),
    };
  }

  // Step 5: Re-read plugin list for actual installed version (C6)
  const postListOutput = await spawnPluginList(spawnFn);
  const postPlugins = postListOutput !== undefined ? parsePluginList(postListOutput) : [];
  const installedEcc = postPlugins.find((p) => isAcceptedEccIdentity(p.identity));

  // C6: Record identity + version + timestamp
  const record: EccPluginRecord = {
    identity: installedEcc?.identity ?? ECC_CANONICAL_IDENTITY,
    version: installedEcc?.version ?? "unknown",
    installedAt: new Date().toISOString(),
  };
  await writeEccPluginRecord(writeFileFn, targetRoot, record);

  return { status: "installed", record };
}
