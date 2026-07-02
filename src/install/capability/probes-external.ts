/**
 * L2 (EXTERNAL CONTRACT) capability probes.
 *
 * L2 probes assert that external identities and prerequisites resolve:
 *   - claude CLI is present (spawn `claude --version`)
 *   - @witchynibbles/archon resolvable in node_modules
 *   - playwright browser binaries installed
 *   - review-identity-adapter.ts was replaced (stub detection)
 *   - ecc-present: ECC plugin installed and identity in accepted set (dual-identity)
 *   - skill-ref-namespace: consumer AGENT.md skill-ref prefix matches installed ECC namespace (C1)
 *
 * All probes take an injected SpawnFn / ReadFileFn so they can be unit-tested
 * with stubs. Mirrors the DbQueryFn pattern in src/admin/db-preflight.ts.
 *
 * PROBE DISCIPLINE (council C7):
 *   - All `claude` invocations use the injected SpawnFn with array args, shell:false.
 *   - Command name is the CLAUDE_CLI constant — never derived from config or input.
 *   - Plugin names are imported from ecc-plugin.ts as hardcoded package constants.
 *
 * SECURITY (council C8): detail and remediation fields never echo credentials.
 * They are passed through scrubPgCredentials() as defence-in-depth.
 *
 * SEVERITY: probes are pure — status (ok|degraded|blocked|skipped) is returned;
 * whether that status blocks is decided at report assembly (report.ts), not here.
 *
 * SKILL-REF PROBE (council C1): read-only scan of consumer AGENT.md files.
 * This probe NEVER rewrites files — S6 owns the codemod write path.
 */
import path from "node:path";
import { readdir } from "node:fs/promises";
import type { ProbeResult } from "./types.ts";
import type { ReadFileFn } from "./probes-file.ts";
import {
  parsePluginList,
  isAcceptedEccIdentity,
  isLegacyEccIdentity,
  ECC_CANONICAL_IDENTITY,
  ECC_MARKETPLACE_SOURCE,
  ECC_CANONICAL_SKILL_PREFIX,
  ECC_LEGACY_SKILL_PREFIX,
} from "../ecc-plugin.ts";

// ---------------------------------------------------------------------------
// Injectable spawn interface (council C7)
// ---------------------------------------------------------------------------

/**
 * Injectable spawn function. All external process invocations in L2/L3 probes
 * use this interface so tests can stub without spawning real processes.
 *
 * Implementation MUST use spawn with shell:false (C7).
 * args is an array — never shell-interpolated.
 * stdin, when provided, is written to the child's stdin pipe and the pipe
 * is then closed. When absent, stdin is set to "ignore" (/dev/null).
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  stdin?: string
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Package constants (council C7: names are hardcoded, never config-derived)
// ---------------------------------------------------------------------------

/** Hardcoded claude CLI binary name. Never derived from config or arguments. */
const CLAUDE_CLI = "claude";

/** Canonical package name for the archon npm package. */
const ARCHON_PACKAGE = "@witchynibbles/archon";

// ---------------------------------------------------------------------------
// Stub text for adapter-stub detection
// ---------------------------------------------------------------------------

/**
 * The distinctive error message thrown by the shipped stub default export
 * in archon/review-identity-adapter.ts. If a consumer's adapter still throws
 * this exact message, the stub has NOT been replaced.
 */
const ADAPTER_STUB_SENTINEL =
  "Implement archon/review-identity-adapter.ts with your authenticated principal lookup";

// ---------------------------------------------------------------------------
// L2 probe: claude CLI present (C7 compliance: CLAUDE_CLI constant, array args)
// ---------------------------------------------------------------------------

/**
 * L2 probe: asserts the `claude` CLI is executable on this machine.
 *
 * Spawns `claude --version` with shell:false.
 * Tool absent (ENOENT / spawn failure) → skipped (not crashed).
 * Exit non-zero → degraded.
 * Exit 0 → ok.
 */
export async function probeClaudePresent(spawnFn: SpawnFn): Promise<ProbeResult> {
  let result: { exitCode: number | null; stdout: string; stderr: string };
  try {
    result = await spawnFn(CLAUDE_CLI, ["--version"]);
  } catch (err) {
    // Tool absent (ENOENT) or spawn failure → skipped
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAbsent =
      /ENOENT|command not found|not found/i.test(errMsg) ||
      /spawn/i.test(errMsg);
    if (isAbsent) {
      return {
        capability: "claude-present",
        layer: "L2",
        status: "skipped",
        code: "claude-absent",
        detail: "claude CLI not found on PATH — cannot run L2/L3 CLI probes.",
        remediation:
          "Install the claude CLI: https://claude.ai/download — then re-run doctor.",
      };
    }
    return {
      capability: "claude-present",
      layer: "L2",
      status: "skipped",
      code: "claude-spawn-error",
      detail: `Failed to spawn claude CLI: ${errMsg}`,
      remediation:
        "Verify the claude CLI is installed and accessible on PATH, then re-run doctor.",
    };
  }

  if (result.exitCode !== 0) {
    return {
      capability: "claude-present",
      layer: "L2",
      status: "degraded",
      code: "claude-nonzero",
      detail: `claude --version exited ${String(result.exitCode)}.`,
      remediation:
        "Check the claude CLI installation — re-install if needed: https://claude.ai/download",
    };
  }

  const versionLine = result.stdout.trim().split("\n")[0] ?? "";
  return {
    capability: "claude-present",
    layer: "L2",
    status: "ok",
    code: "claude-present-ok",
    detail: `claude CLI is present (${versionLine || "version unknown"}).`,
    remediation: "",
  };
}

// ---------------------------------------------------------------------------
// L2 probe: @witchynibbles/archon resolvable in node_modules
// ---------------------------------------------------------------------------

/**
 * L2 probe: asserts node_modules/@witchynibbles/archon is installed in the
 * target consumer repo (i.e. `npm install` has been run).
 *
 * Checks for the existence of node_modules/@witchynibbles/archon/package.json.
 * Uses the injected readFileFn to stay testable.
 */
export async function probeNodeModules(
  readFileFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  const pkgPath = path.join(
    targetRoot,
    "node_modules",
    ARCHON_PACKAGE,
    "package.json"
  );

  let content: string | undefined;
  try {
    content = await readFileFn(pkgPath);
  } catch {
    content = undefined;
  }

  if (content === undefined) {
    return {
      capability: "node-modules",
      layer: "L2",
      status: "blocked",
      code: "node-modules-absent",
      detail: `node_modules/${ARCHON_PACKAGE} not found — npm install has not been run.`,
      remediation: "Run 'npm install' in the consumer repository root.",
    };
  }

  // Parse to extract version for a helpful detail message
  let version = "unknown";
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;
    if (typeof pkg.version === "string") {
      version = pkg.version;
    }
  } catch {
    // ignore parse error — package exists, that's what matters
  }

  return {
    capability: "node-modules",
    layer: "L2",
    status: "ok",
    code: "node-modules-ok",
    detail: `${ARCHON_PACKAGE}@${version} is installed in node_modules.`,
    remediation: "",
  };
}

// ---------------------------------------------------------------------------
// L2 probe: playwright browser binaries installed
// ---------------------------------------------------------------------------

/**
 * L2 probe: asserts playwright browser binaries are installed.
 *
 * Checks for the ms-playwright cache directory in the user home (~/.cache/ms-playwright).
 * Uses readFileFn to read a sentinel file. If the cache is absent → blocked.
 *
 * Note: We check ~/.cache/ms-playwright existence rather than spawning
 * playwright because the binary is in node_modules and may not be on PATH.
 * The sentinel is the BROWSERS_JSON file (browsers.json) that playwright
 * writes when browsers are installed.
 */
export async function probePlaywrightBrowsers(
  readFileFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  // First check: is playwright listed as a dependency in the target's package.json?
  const pkgPath = path.join(targetRoot, "package.json");
  let hasPwDep = false;
  try {
    const pkgRaw = await readFileFn(pkgPath);
    if (pkgRaw !== undefined) {
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      const allDeps: Record<string, unknown> = {
        ...(typeof pkg.dependencies === "object" && pkg.dependencies !== null
          ? (pkg.dependencies as Record<string, unknown>)
          : {}),
        ...(typeof pkg.devDependencies === "object" && pkg.devDependencies !== null
          ? (pkg.devDependencies as Record<string, unknown>)
          : {}),
      };
      hasPwDep = Boolean(allDeps["@playwright/test"] ?? allDeps["playwright"]);
    }
  } catch {
    // ignore
  }

  if (!hasPwDep) {
    // If playwright is not a dependency, this probe is not applicable — skip it.
    return {
      capability: "playwright-browsers",
      layer: "L2",
      status: "skipped",
      code: "playwright-not-a-dependency",
      detail: "playwright is not listed as a dependency — browser check skipped.",
      remediation: "",
    };
  }

  // Check node_modules/playwright exists
  const pwPkgPath = path.join(targetRoot, "node_modules", "playwright", "package.json");
  let pwContent: string | undefined;
  try {
    pwContent = await readFileFn(pwPkgPath);
  } catch {
    pwContent = undefined;
  }

  if (pwContent === undefined) {
    return {
      capability: "playwright-browsers",
      layer: "L2",
      status: "blocked",
      code: "playwright-not-installed",
      detail:
        "playwright package not found in node_modules — npm install has not been run.",
      remediation: "Run 'npm install', then 'npm run archon:setup:playwright'.",
    };
  }

  // Check ms-playwright cache for installed browsers.
  // The cache lives at ~/.cache/ms-playwright on Linux.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const msPlaywrightCache = home
    ? path.join(home, ".cache", "ms-playwright")
    : "";

  if (!msPlaywrightCache) {
    return {
      capability: "playwright-browsers",
      layer: "L2",
      status: "skipped",
      code: "playwright-home-unknown",
      detail: "Cannot determine HOME directory — playwright browser cache check skipped.",
      remediation: "Set HOME and run 'npm run archon:setup:playwright'.",
    };
  }

  // Try reading a sentinel from the cache directory. We use the presence of
  // any file inside ~/.cache/ms-playwright/ as the installed signal.
  // (The exact path varies by playwright version; the directory itself is stable.)
  const sentinelPath = path.join(msPlaywrightCache, ".links");
  let sentinel: string | undefined;
  try {
    sentinel = await readFileFn(sentinelPath);
  } catch {
    sentinel = undefined;
  }

  if (sentinel === undefined) {
    // Try an alternative: does the cache directory exist at all?
    // We can probe this by reading a directory index file if present.
    return {
      capability: "playwright-browsers",
      layer: "L2",
      status: "blocked",
      code: "playwright-browsers-absent",
      detail:
        "Playwright browser binaries are not installed (no ms-playwright cache found).",
      remediation: "Run 'npm run archon:setup:playwright' to install Playwright browsers.",
    };
  }

  return {
    capability: "playwright-browsers",
    layer: "L2",
    status: "ok",
    code: "playwright-browsers-ok",
    detail: "Playwright browser cache found — browsers appear to be installed.",
    remediation: "",
  };
}

// ---------------------------------------------------------------------------
// L2 probe: review-identity-adapter stub detection (council C9)
// ---------------------------------------------------------------------------

/**
 * L2 probe: asserts the seeded review-identity-adapter.ts has been replaced.
 *
 * Reads archon/review-identity-adapter.ts from the target root and checks
 * whether the default export still throws the stub sentinel message.
 * If the stub is still present → degraded (not blocked, since the adapter
 * is optional until review gates are used).
 *
 * Council C9: remediation text MUST state that the probe only confirms the
 * stub was replaced, NOT that the implementation is correct.
 */
export async function probeAdapterStub(
  readFileFn: ReadFileFn,
  targetRoot: string
): Promise<ProbeResult> {
  const adapterPath = path.join(targetRoot, "archon", "review-identity-adapter.ts");
  let content: string | undefined;
  try {
    content = await readFileFn(adapterPath);
  } catch {
    content = undefined;
  }

  if (content === undefined) {
    return {
      capability: "adapter-stub",
      layer: "L2",
      status: "skipped",
      code: "adapter-stub-file-absent",
      detail:
        "archon/review-identity-adapter.ts not found — run 'archon init' to seed the file.",
      remediation:
        "Run 'archon init --apply' to seed archon/review-identity-adapter.ts, then implement it.",
    };
  }

  if (content.includes(ADAPTER_STUB_SENTINEL)) {
    return {
      capability: "adapter-stub",
      layer: "L2",
      status: "degraded",
      code: "adapter-stub-unimplemented",
      detail:
        "archon/review-identity-adapter.ts still contains the shipped throwing stub — " +
        "review gate evidence cannot be trusted.",
      // C9: remediation text states the assurance boundary explicitly.
      remediation:
        "Implement archon/review-identity-adapter.ts with your authenticated principal lookup. " +
        "IMPORTANT: this probe only confirms the stub was replaced, NOT that the implementation " +
        "is correct — verify against your auth system before trusting review gate evidence.",
    };
  }

  return {
    capability: "adapter-stub",
    layer: "L2",
    status: "ok",
    code: "adapter-stub-replaced",
    detail: "archon/review-identity-adapter.ts has been customised (stub sentinel absent).",
    // C9 reminder: still state the boundary in the ok detail.
    remediation: "",
  };
}

// ---------------------------------------------------------------------------
// L2 probe: ecc-present — dual-identity detection (council C1, C7)
// ---------------------------------------------------------------------------

/**
 * L2 probe: ECC plugin presence check with dual-identity acceptance.
 *
 * Spawns `claude plugin list` via injected spawnFn (C7: array args, shell:false).
 * Accepted identities: canonical "ecc@ecc" OR legacy "everything-claude-code@*".
 * Either counts as "present"; legacy additionally raises a migration advisory.
 *
 * CLI absent → skipped (never crash).
 * Plugin absent → blocked with exact install remediation.
 * Canonical → ok.
 * Legacy → ok with migration advisory code (status ok, advisory code).
 *
 * Plugin/server names are hardcoded constants imported from ecc-plugin.ts (C7).
 */
export async function probeEccPresent(spawnFn: SpawnFn): Promise<ProbeResult> {
  let result: { exitCode: number | null; stdout: string; stderr: string };
  try {
    // C7: CLAUDE_CLI constant, array args, shell:false via injected spawnFn
    result = await spawnFn(CLAUDE_CLI, ["plugin", "list"]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAbsent = /ENOENT|command not found|not found/i.test(errMsg);
    return {
      capability: "ecc-plugin",
      layer: "L2",
      status: "skipped",
      code: isAbsent ? "ecc-claude-absent" : "ecc-plugin-list-spawn-error",
      detail: isAbsent
        ? "claude CLI not found — cannot check ECC plugin state."
        : `Failed to spawn 'claude plugin list': ${errMsg}`,
      remediation: isAbsent
        ? "Install the claude CLI: https://claude.ai/download — then re-run doctor."
        : "Verify the claude CLI is installed and accessible on PATH, then re-run doctor.",
    };
  }

  if (result.exitCode !== 0) {
    return {
      capability: "ecc-plugin",
      layer: "L2",
      status: "skipped",
      code: "ecc-plugin-list-nonzero",
      detail: `'claude plugin list' exited ${String(result.exitCode)}.`,
      remediation: "Check the claude CLI installation and re-run doctor.",
    };
  }

  const plugins = parsePluginList(result.stdout);
  const eccPlugin = plugins.find((p) => isAcceptedEccIdentity(p.identity));

  if (eccPlugin === undefined) {
    return {
      capability: "ecc-plugin",
      layer: "L2",
      status: "blocked",
      code: "ecc-plugin-absent",
      detail:
        "ECC plugin is not installed. No accepted ECC identity found in 'claude plugin list'.",
      remediation:
        `Run 'archon init --apply --install-plugin' or install manually: ` +
        `claude plugin marketplace add ${ECC_MARKETPLACE_SOURCE} && ` +
        `claude plugin install ${ECC_CANONICAL_IDENTITY}`,
    };
  }

  // Drift check: is the installed identity the expected canonical one?
  if (isLegacyEccIdentity(eccPlugin.identity)) {
    // Legacy is accepted-as-present but warrants a migration advisory.
    return {
      capability: "ecc-plugin",
      layer: "L2",
      status: "ok",
      code: "ecc-plugin-legacy-present",
      detail:
        `ECC plugin present as legacy identity: ${eccPlugin.identity} v${eccPlugin.version}. ` +
        `Canonical identity is ${ECC_CANONICAL_IDENTITY} — migration advisory applies.`,
      remediation:
        `Legacy ECC identity '${eccPlugin.identity}' detected. Canonical is '${ECC_CANONICAL_IDENTITY}'. ` +
        `To migrate: reinstall with 'archon init --apply --install-plugin'.`,
    };
  }

  return {
    capability: "ecc-plugin",
    layer: "L2",
    status: "ok",
    code: "ecc-plugin-present",
    detail: `ECC plugin present: ${eccPlugin.identity} v${eccPlugin.version}.`,
    remediation: "",
  };
}

// ---------------------------------------------------------------------------
// L2 probe: skill-ref-namespace mismatch (council C1)
// ---------------------------------------------------------------------------

/**
 * Injectable function that returns all agent markdown file paths under
 * .claude/agents/ in the consumer repo (recursive directory walk).
 * Returns empty array if the directory does not exist — never throws.
 */
export type FindAgentFilesFn = (targetRoot: string) => Promise<readonly string[]>;

/**
 * Creates a real FindAgentFilesFn backed by node:fs/promises readdir.
 * Walks .claude/agents/ recursively; returns all .md file absolute paths.
 * Returns empty array on missing directory or permission errors.
 */
export function createFindAgentFilesFn(): FindAgentFilesFn {
  async function walk(dir: string): Promise<string[]> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await walk(fullPath);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
    return results;
  }

  return async (targetRoot: string) => {
    const agentsDir = path.join(targetRoot, ".claude", "agents");
    return walk(agentsDir);
  };
}

/**
 * Resolves the installed ECC skill-ref namespace ("ecc:" or "everything-claude-code:")
 * from the probeEccPresent result code.
 *
 * Returns undefined when ECC is not installed or the state is unknown (skipped/blocked
 * with a non-identity code).
 */
function resolveEccNamespaceFromProbeCode(
  code: string
): typeof ECC_CANONICAL_SKILL_PREFIX | typeof ECC_LEGACY_SKILL_PREFIX | undefined {
  if (code === "ecc-plugin-present") {
    return ECC_CANONICAL_SKILL_PREFIX;
  }
  if (code === "ecc-plugin-legacy-present") {
    return ECC_LEGACY_SKILL_PREFIX;
  }
  return undefined;
}

/**
 * L2 probe: skill-ref namespace mismatch detection (council C1).
 *
 * Reads consumer .claude/agents/**\/*.md files (READ-ONLY, never rewrites).
 * Extracts ECC skill-ref prefixes (everything-claude-code: or ecc:).
 * Compares against the installed ECC plugin namespace.
 *
 * Mismatch direction matters:
 *   - Canonical installed + legacy refs: skills will not resolve.
 *   - Legacy installed + canonical refs: skills will not resolve.
 *   - Either installed + matching refs: ok.
 *   - ECC not installed + refs found: degraded (unresolvable).
 *   - No agent files / no refs: skipped.
 *
 * This probe NEVER rewrites files — S6 owns the codemod write path.
 *
 * @param installedEccNamespace - Derived from probeEccPresent's result code
 *   via resolveEccNamespaceFromProbeCode. Pass undefined when ECC is not installed.
 */
export async function probeSkillRefNamespace(
  findAgentFilesFn: FindAgentFilesFn,
  readFileFn: ReadFileFn,
  targetRoot: string,
  installedEccNamespace:
    | typeof ECC_CANONICAL_SKILL_PREFIX
    | typeof ECC_LEGACY_SKILL_PREFIX
    | undefined
): Promise<ProbeResult> {
  let agentFiles: readonly string[];
  try {
    agentFiles = await findAgentFilesFn(targetRoot);
  } catch {
    agentFiles = [];
  }

  if (agentFiles.length === 0) {
    return {
      capability: "skill-ref-namespace",
      layer: "L2",
      status: "skipped",
      code: "skill-ref-no-agent-files",
      detail: "No agent files found under .claude/agents/ — skill-ref namespace check skipped.",
      remediation: "Run 'archon init --apply' to install agent files.",
    };
  }

  let canonicalRefCount = 0;
  let legacyRefCount = 0;
  let filesScanned = 0;

  for (const filePath of agentFiles) {
    let content: string | undefined;
    try {
      content = await readFileFn(filePath);
    } catch {
      content = undefined;
    }
    if (!content) {
      continue;
    }
    filesScanned += 1;
    if (content.includes(ECC_CANONICAL_SKILL_PREFIX)) {
      canonicalRefCount += 1;
    }
    if (content.includes(ECC_LEGACY_SKILL_PREFIX)) {
      legacyRefCount += 1;
    }
  }

  if (canonicalRefCount === 0 && legacyRefCount === 0) {
    return {
      capability: "skill-ref-namespace",
      layer: "L2",
      status: "skipped",
      code: "skill-ref-no-ecc-refs",
      detail: `Scanned ${String(filesScanned)} agent file(s) — no ECC skill refs found.`,
      remediation: "",
    };
  }

  // ECC not installed — any refs are unresolvable
  if (installedEccNamespace === undefined) {
    const totalRefs = canonicalRefCount + legacyRefCount;
    return {
      capability: "skill-ref-namespace",
      layer: "L2",
      status: "degraded",
      code: "skill-ref-ecc-not-installed",
      detail:
        `${String(totalRefs)} agent file(s) contain ECC skill refs but ECC plugin is not installed — ` +
        `skill refs will not resolve.`,
      remediation:
        `Install ECC: 'archon init --apply --install-plugin'. ` +
        `${String(canonicalRefCount)} file(s) use '${ECC_CANONICAL_SKILL_PREFIX}' refs, ` +
        `${String(legacyRefCount)} file(s) use '${ECC_LEGACY_SKILL_PREFIX}' refs.`,
    };
  }

  const installedIsCanonical = installedEccNamespace === ECC_CANONICAL_SKILL_PREFIX;
  const mismatchCount = installedIsCanonical ? legacyRefCount : canonicalRefCount;
  const mismatchPrefix = installedIsCanonical ? ECC_LEGACY_SKILL_PREFIX : ECC_CANONICAL_SKILL_PREFIX;
  const correctPrefix = installedEccNamespace;

  if (mismatchCount === 0) {
    return {
      capability: "skill-ref-namespace",
      layer: "L2",
      status: "ok",
      code: "skill-ref-namespace-match",
      detail:
        `ECC skill refs match the installed plugin namespace ('${installedEccNamespace}') ` +
        `across ${String(filesScanned)} scanned agent file(s).`,
      remediation: "",
    };
  }

  return {
    capability: "skill-ref-namespace",
    layer: "L2",
    status: "degraded",
    code: "skill-ref-namespace-mismatch",
    detail:
      `${String(mismatchCount)} agent file(s) use '${mismatchPrefix}' skill refs but the installed ` +
      `ECC plugin exposes the '${correctPrefix}' namespace — these skill refs will not resolve.`,
    remediation:
      `Run 'archon upgrade --apply --migrate-skill-refs' to rewrite skill refs ` +
      `from '${mismatchPrefix}' to '${correctPrefix}'. ` +
      `(This probe is read-only — no files were modified. S6 codemod owns the rewrite.)`,
  };
}

// ---------------------------------------------------------------------------
// Aggregate runner
// ---------------------------------------------------------------------------

/**
 * Runs all L2 probes against a target directory.
 * Returns one ProbeResult per probe (6 total), never throws.
 *
 * Probe order: ecc-plugin (first, others may depend on its result),
 * then independent probes in parallel, then skill-ref-namespace last
 * (depends on ecc-plugin result to determine expected namespace).
 *
 * Tool absent → skipped; parse-fail → skipped advisory.
 * Severity is decided at report assembly, not here.
 *
 * @param findAgentFilesFn - Injectable file finder for .claude/agents/ walk (C1).
 *   Use createFindAgentFilesFn() in production; stub in tests.
 */
export async function runL2Probes(
  spawnFn: SpawnFn,
  readFileFn: ReadFileFn,
  findAgentFilesFn: FindAgentFilesFn,
  targetRoot: string
): Promise<readonly ProbeResult[]> {
  // Run ECC probe first so skill-ref probe can use its result
  const [eccSettled, ...independentSettled] = await Promise.allSettled([
    probeEccPresent(spawnFn),
    probeClaudePresent(spawnFn),
    probeNodeModules(readFileFn, targetRoot),
    probePlaywrightBrowsers(readFileFn, targetRoot),
    probeAdapterStub(readFileFn, targetRoot),
  ]);

  // Determine installed ECC namespace from ECC probe result
  const eccResult = eccSettled?.status === "fulfilled" ? eccSettled.value : undefined;
  const installedEccNamespace =
    eccResult !== undefined
      ? resolveEccNamespaceFromProbeCode(eccResult.code)
      : undefined;

  // Run skill-ref probe sequenced after ECC (C1: depends on installed namespace)
  const [skillRefSettled] = await Promise.allSettled([
    probeSkillRefNamespace(findAgentFilesFn, readFileFn, targetRoot, installedEccNamespace),
  ]);

  const allSettled = [eccSettled, ...independentSettled, skillRefSettled];
  const capabilityNames = [
    "ecc-plugin",
    "claude-present",
    "node-modules",
    "playwright-browsers",
    "adapter-stub",
    "skill-ref-namespace",
  ];

  return (allSettled as PromiseSettledResult<ProbeResult>[]).map((r, i): ProbeResult => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    const cap = capabilityNames[i] ?? "unknown";
    return {
      capability: cap,
      layer: "L2",
      status: "skipped",
      code: `${cap}-unexpected-error`,
      detail: `L2 probe threw unexpectedly: ${
        r.reason instanceof Error ? r.reason.message : String(r.reason)
      }`,
      remediation: "Investigate and re-run doctor.",
    };
  });
}
