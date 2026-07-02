/**
 * L1 (CONFIG-PARSE) capability probes.
 *
 * L1 probes assert that the installed config files parse correctly and contain
 * the expected shape. They catch the entire #140 class: a probe asserting
 * "archon MCP server is present in .mcp.json" fails the instant the fragment
 * lands in the wrong file.
 *
 * All probes take an injected ReadFileFn (same interface as probes-file.ts)
 * so they can be unit-tested without touching the filesystem.
 *
 * SECURITY (council C8): All detail and remediation strings that may derive
 * from database connection strings MUST be scrubbed with scrubPgCredentials()
 * before being stored in the ProbeResult. This obligation is met at every
 * db-related probe call site in this file.
 */
import path from "node:path";
import { scrubPgCredentials, validateDatabaseUrl } from "../../admin/db-error-scrub.ts";
import type { ProbeResult } from "./types.ts";
import type { ReadFileFn } from "./probes-file.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Reads and parses a JSON file. Returns undefined if file does not exist.
 * Throws a typed error if the file exists but cannot be parsed.
 */
async function readJson(
  readFn: ReadFileFn,
  absolutePath: string
): Promise<Record<string, unknown> | undefined> {
  const raw = await readFn(absolutePath);
  if (raw === undefined) {
    return undefined;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Minimal .env.archon parser: extracts a single key=value line.
 * Handles quoted values (double or single) and inline # comments.
 * Returns undefined if the key is not present.
 */
function extractEnvValue(content: string, key: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const lineKey = trimmed.slice(0, eqIdx).replace(/^export\s+/, "").trim();
    if (lineKey !== key) {
      continue;
    }
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip inline comments (not inside quotes)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      value = value.replace(/\s+#.*$/, "").trim();
    } else if (value.startsWith('"')) {
      const m = value.match(/^"((?:\\.|[^"])*)"(?:\s+#.*)?$/);
      value = m ? (m[1] ?? "") : value;
    } else {
      const m = value.match(/^'([^']*)'(?:\s+#.*)?$/);
      value = m ? (m[1] ?? "") : value;
    }
    return value || undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// L1 probes
// ---------------------------------------------------------------------------

/**
 * L1 probe: asserts .mcp.json parses and contains mcpServers.archon.
 *
 * This probe directly catches the #140 class: if the installer writes the
 * archon MCP server fragment to the wrong file (e.g. .claude/settings.json),
 * .mcp.json will not have mcpServers.archon and this probe returns blocked.
 */
export async function probeMcpJsonArchon(
  readFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  const mcpPath = path.join(targetRoot, ".mcp.json");
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = await readJson(readFn, mcpPath);
  } catch {
    return {
      capability: "mcp-archon",
      layer: "L1",
      status: "blocked",
      code: "mcp-archon-parse-error",
      detail: ".mcp.json exists but could not be parsed as JSON.",
      remediation: "Run 'archon upgrade --apply' to restore .mcp.json.",
    };
  }

  if (parsed === undefined) {
    return {
      capability: "mcp-archon",
      layer: "L1",
      status: "blocked",
      code: "mcp-archon-file-missing",
      detail: ".mcp.json is missing — archon MCP server cannot be registered.",
      remediation: "Run 'archon init --apply' or 'archon upgrade --apply' to create .mcp.json.",
    };
  }

  const mcpServers = parsed.mcpServers;
  if (
    !mcpServers ||
    typeof mcpServers !== "object" ||
    Array.isArray(mcpServers)
  ) {
    return {
      capability: "mcp-archon",
      layer: "L1",
      status: "blocked",
      code: "mcp-archon-no-servers",
      detail: ".mcp.json exists but has no mcpServers object.",
      remediation: "Run 'archon upgrade --apply' to merge the archon MCP server entry.",
    };
  }

  const servers = mcpServers as Record<string, unknown>;
  if (!servers.archon) {
    return {
      capability: "mcp-archon",
      layer: "L1",
      status: "blocked",
      code: "mcp-archon-absent",
      detail: ".mcp.json does not contain mcpServers.archon — archon MCP server is not registered.",
      remediation: "Run 'archon upgrade --apply' to merge the archon MCP server entry into .mcp.json.",
    };
  }

  return {
    capability: "mcp-archon",
    layer: "L1",
    status: "ok",
    code: "mcp-archon-present",
    detail: "mcpServers.archon is registered in .mcp.json.",
    remediation: "",
  };
}

/**
 * L1 probe: asserts .mcp.json parses and contains mcpServers.playwright.
 */
export async function probeMcpJsonPlaywright(
  readFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  const mcpPath = path.join(targetRoot, ".mcp.json");
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = await readJson(readFn, mcpPath);
  } catch {
    return {
      capability: "mcp-playwright",
      layer: "L1",
      status: "blocked",
      code: "mcp-playwright-parse-error",
      detail: ".mcp.json exists but could not be parsed as JSON.",
      remediation: "Run 'archon upgrade --apply' to restore .mcp.json.",
    };
  }

  if (parsed === undefined) {
    return {
      capability: "mcp-playwright",
      layer: "L1",
      status: "blocked",
      code: "mcp-playwright-file-missing",
      detail: ".mcp.json is missing — playwright MCP server cannot be registered.",
      remediation: "Run 'archon init --apply' or 'archon upgrade --apply' to create .mcp.json.",
    };
  }

  const mcpServers = parsed.mcpServers;
  if (
    !mcpServers ||
    typeof mcpServers !== "object" ||
    Array.isArray(mcpServers)
  ) {
    return {
      capability: "mcp-playwright",
      layer: "L1",
      status: "blocked",
      code: "mcp-playwright-no-servers",
      detail: ".mcp.json exists but has no mcpServers object.",
      remediation: "Run 'archon upgrade --apply' to merge the playwright MCP server entry.",
    };
  }

  const servers = mcpServers as Record<string, unknown>;
  if (!servers.playwright) {
    return {
      capability: "mcp-playwright",
      layer: "L1",
      status: "blocked",
      code: "mcp-playwright-absent",
      detail:
        ".mcp.json does not contain mcpServers.playwright — playwright MCP server is not registered.",
      remediation:
        "Run 'archon upgrade --apply' to merge the playwright MCP server entry into .mcp.json.",
    };
  }

  return {
    capability: "mcp-playwright",
    layer: "L1",
    status: "ok",
    code: "mcp-playwright-present",
    detail: "mcpServers.playwright is registered in .mcp.json.",
    remediation: "",
  };
}

/** Required hook types in .claude/settings.json. */
const REQUIRED_HOOK_TYPES = ["PreToolUse", "PostToolUse", "Stop"] as const;

/**
 * L1 probe: asserts .claude/settings.json parses and contains the required
 * archon hook types (PreToolUse, PostToolUse, Stop).
 */
export async function probeSettingsHooks(
  readFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  const settingsPath = path.join(targetRoot, ".claude", "settings.json");
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = await readJson(readFn, settingsPath);
  } catch {
    return {
      capability: "hooks",
      layer: "L1",
      status: "blocked",
      code: "hooks-settings-parse-error",
      detail: ".claude/settings.json exists but could not be parsed as JSON.",
      remediation: "Run 'archon upgrade --apply' to restore .claude/settings.json.",
    };
  }

  if (parsed === undefined) {
    return {
      capability: "hooks",
      layer: "L1",
      status: "blocked",
      code: "hooks-settings-missing",
      detail: ".claude/settings.json is missing — archon hooks are not configured.",
      remediation: "Run 'archon init --apply' or 'archon upgrade --apply' to write settings.",
    };
  }

  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return {
      capability: "hooks",
      layer: "L1",
      status: "blocked",
      code: "hooks-config-absent",
      detail: ".claude/settings.json does not contain a hooks configuration.",
      remediation: "Run 'archon upgrade --apply' to merge the required hook configuration.",
    };
  }

  const hooksObj = hooks as Record<string, unknown>;
  const missingKeys = REQUIRED_HOOK_TYPES.filter((k) => !hooksObj[k]);

  if (missingKeys.length > 0) {
    return {
      capability: "hooks",
      layer: "L1",
      status: "blocked",
      code: "hooks-incomplete",
      detail: `Missing hook types in .claude/settings.json: ${missingKeys.join(", ")}.`,
      remediation:
        "Run 'archon upgrade --apply' to merge the required hook configuration into .claude/settings.json.",
    };
  }

  return {
    capability: "hooks",
    layer: "L1",
    status: "ok",
    code: "hooks-ok",
    detail: `Required hook types present in .claude/settings.json (${REQUIRED_HOOK_TYPES.join(", ")}).`,
    remediation: "",
  };
}

/** Required archon scripts that must exist in package.json. */
const REQUIRED_GIT_GUARD_SCRIPTS = [
  "archon:setup:git-guard",
  "archon:verify:git-guard",
] as const;

/**
 * L1 probe: asserts package.json contains archon git-guard scripts.
 */
export async function probePackageGitGuardScripts(
  readFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  const pkgPath = path.join(targetRoot, "package.json");
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = await readJson(readFn, pkgPath);
  } catch {
    return {
      capability: "git-guard",
      layer: "L1",
      status: "blocked",
      code: "git-guard-pkg-parse-error",
      detail: "package.json exists but could not be parsed as JSON.",
      remediation: "Fix package.json syntax and run 'archon upgrade --apply'.",
    };
  }

  if (parsed === undefined) {
    return {
      capability: "git-guard",
      layer: "L1",
      status: "blocked",
      code: "git-guard-pkg-missing",
      detail: "package.json is missing — archon git-guard scripts cannot be verified.",
      remediation: "Create a package.json and run 'archon init --apply'.",
    };
  }

  const scripts =
    parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? (parsed.scripts as Record<string, unknown>)
      : {};

  const missingScripts = REQUIRED_GIT_GUARD_SCRIPTS.filter((s) => typeof scripts[s] !== "string");

  if (missingScripts.length > 0) {
    return {
      capability: "git-guard",
      layer: "L1",
      status: "blocked",
      code: "git-guard-scripts-absent",
      detail: `package.json is missing archon git-guard scripts: ${missingScripts.join(", ")}.`,
      remediation: "Run 'archon upgrade --apply' to wire the missing git-guard scripts in package.json.",
    };
  }

  return {
    capability: "git-guard",
    layer: "L1",
    status: "ok",
    code: "git-guard-scripts-ok",
    detail: `Archon git-guard scripts present in package.json (${REQUIRED_GIT_GUARD_SCRIPTS.join(", ")}).`,
    remediation: "",
  };
}

/**
 * L1 probe: asserts package.json contains the archon:migrate script (doctor / DB).
 */
export async function probePackageMigrateScript(
  readFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  const pkgPath = path.join(targetRoot, "package.json");
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = await readJson(readFn, pkgPath);
  } catch {
    return {
      capability: "doctor",
      layer: "L1",
      status: "blocked",
      code: "doctor-pkg-parse-error",
      detail: "package.json exists but could not be parsed as JSON.",
      remediation: "Fix package.json syntax and run 'archon upgrade --apply'.",
    };
  }

  if (parsed === undefined) {
    return {
      capability: "doctor",
      layer: "L1",
      status: "blocked",
      code: "doctor-pkg-missing",
      detail: "package.json is missing — archon:migrate script cannot be verified.",
      remediation: "Create a package.json and run 'archon init --apply'.",
    };
  }

  const scripts =
    parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? (parsed.scripts as Record<string, unknown>)
      : {};

  if (typeof scripts["archon:migrate"] !== "string") {
    return {
      capability: "doctor",
      layer: "L1",
      status: "blocked",
      code: "doctor-migrate-script-absent",
      detail: "package.json is missing the archon:migrate script.",
      remediation: "Run 'archon upgrade --apply' to wire the archon:migrate script in package.json.",
    };
  }

  return {
    capability: "doctor",
    layer: "L1",
    status: "ok",
    code: "doctor-migrate-script-ok",
    detail: "archon:migrate script is present in package.json.",
    remediation: "",
  };
}

/**
 * L1 probe: asserts .env.archon contains ARCHON_CORE_DATABASE_URL and that the
 * URL is syntactically valid as a postgres:// URL.
 *
 * SECURITY (C8): detail and remediation fields never echo the URL value.
 * They are additionally scrubbed through scrubPgCredentials() as defence-in-depth.
 */
export async function probeDatabaseUrl(
  readFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  const envPath = path.join(targetRoot, ".env.archon");
  const raw = await readFn(envPath);

  if (raw === undefined) {
    return {
      capability: "db-migrations",
      layer: "L1",
      status: "blocked",
      code: "db-url-env-missing",
      detail: scrubPgCredentials(".env.archon is missing — ARCHON_CORE_DATABASE_URL is not set."),
      remediation: scrubPgCredentials(
        "Create .env.archon and set ARCHON_CORE_DATABASE_URL=postgres://user:password@host:port/dbname"
      ),
    };
  }

  const dbUrl = extractEnvValue(raw, "ARCHON_CORE_DATABASE_URL");

  if (!dbUrl) {
    return {
      capability: "db-migrations",
      layer: "L1",
      status: "blocked",
      code: "db-url-absent",
      detail: scrubPgCredentials(
        ".env.archon exists but does not contain ARCHON_CORE_DATABASE_URL."
      ),
      remediation: scrubPgCredentials(
        "Add ARCHON_CORE_DATABASE_URL=postgres://user:password@host:port/dbname to .env.archon, then run 'npm run archon:migrate'."
      ),
    };
  }

  const parsed = validateDatabaseUrl(dbUrl);
  if (!parsed.valid) {
    return {
      capability: "db-migrations",
      layer: "L1",
      status: "blocked",
      code: "db-url-invalid",
      detail: scrubPgCredentials(
        `ARCHON_CORE_DATABASE_URL in .env.archon is not a valid postgres:// URL: ${parsed.guidance}`
      ),
      remediation: scrubPgCredentials(
        "Fix ARCHON_CORE_DATABASE_URL in .env.archon — ensure it is in the form " +
          "postgres://user:password@host:port/dbname and percent-encode special characters."
      ),
    };
  }

  return {
    capability: "db-migrations",
    layer: "L1",
    status: "ok",
    code: "db-url-valid",
    detail: "ARCHON_CORE_DATABASE_URL is present in .env.archon and syntactically valid.",
    remediation: "",
  };
}

/**
 * Runs all L1 probes against a target directory.
 * Returns one ProbeResult per probe, never throws.
 */
export async function runL1Probes(
  readFn: ReadFileFn,
  targetRoot: string
): Promise<readonly ProbeResult[]> {
  return Promise.all([
    probeMcpJsonArchon(readFn, targetRoot),
    probeMcpJsonPlaywright(readFn, targetRoot),
    probeSettingsHooks(readFn, targetRoot),
    probePackageGitGuardScripts(readFn, targetRoot),
    probePackageMigrateScript(readFn, targetRoot),
    probeDatabaseUrl(readFn, targetRoot),
  ]);
}
