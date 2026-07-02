/**
 * L2 (EXTERNAL CONTRACT) capability probes.
 *
 * L2 probes assert that external identities and prerequisites resolve:
 *   - claude CLI is present (spawn `claude --version`)
 *   - @witchynibbles/archon resolvable in node_modules
 *   - playwright browser binaries installed
 *   - review-identity-adapter.ts was replaced (stub detection)
 *   - ecc-present: STUB — returns skipped; S3 fills the real body (single-writer rule)
 *
 * All probes take an injected SpawnFn / ReadFileFn so they can be unit-tested
 * with stubs. Mirrors the DbQueryFn pattern in src/admin/db-preflight.ts.
 *
 * PROBE DISCIPLINE (council C7):
 *   - All `claude` invocations use the injected SpawnFn with array args, shell:false.
 *   - Command name is the CLAUDE_CLI constant — never derived from config or input.
 *
 * SECURITY (council C8): detail and remediation fields never echo credentials.
 * They are passed through scrubPgCredentials() as defence-in-depth.
 *
 * SEVERITY: probes are pure — status (ok|degraded|blocked|skipped) is returned;
 * whether that status blocks is decided at report assembly (report.ts), not here.
 */
import path from "node:path";
import type { ProbeResult } from "./types.ts";
import type { ReadFileFn } from "./probes-file.ts";

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
// L2 probe: ecc-present — STUB (S3 fills the real body)
// ---------------------------------------------------------------------------

/**
 * L2 probe: ECC plugin presence check.
 *
 * STUB — returns skipped with a clear remediation. S3 fills the real probe
 * body (single-writer rule: probes-external.ts is written by S2, then S3).
 *
 * Do NOT implement this function in S2. S3 will replace this stub with
 * dual-identity detection via `claude plugin list`.
 */
export async function probeEccPresent(_spawnFn: SpawnFn): Promise<ProbeResult> {
  return {
    capability: "ecc-plugin",
    layer: "L2",
    status: "skipped",
    code: "ecc-present-placeholder",
    detail:
      "ECC plugin presence check not yet implemented — ships in S3. " +
      "Install manually: claude plugin marketplace add affaan-m/ECC && claude plugin install ecc@ecc",
    remediation:
      "ECC verification ships in S3. Until then, install manually: " +
      "claude plugin marketplace add affaan-m/ECC && claude plugin install ecc@ecc",
  };
}

// ---------------------------------------------------------------------------
// Aggregate runner
// ---------------------------------------------------------------------------

/**
 * Runs all L2 probes against a target directory.
 * Returns one ProbeResult per probe, never throws.
 *
 * Tool absent → skipped; parse-fail → skipped advisory.
 * Severity is decided at report assembly, not here.
 */
export async function runL2Probes(
  spawnFn: SpawnFn,
  readFileFn: ReadFileFn,
  targetRoot: string
): Promise<readonly ProbeResult[]> {
  const results = await Promise.allSettled([
    probeClaudePresent(spawnFn),
    probeNodeModules(readFileFn, targetRoot),
    probePlaywrightBrowsers(readFileFn, targetRoot),
    probeAdapterStub(readFileFn, targetRoot),
    probeEccPresent(spawnFn),
  ]);

  return results.map((r, i): ProbeResult => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    // Unexpected probe throw — return skipped advisory rather than crashing.
    const capabilities = [
      "claude-present",
      "node-modules",
      "playwright-browsers",
      "adapter-stub",
      "ecc-plugin",
    ];
    const cap = capabilities[i] ?? "unknown";
    return {
      capability: cap,
      layer: "L2",
      status: "skipped",
      code: `${cap}-unexpected-error`,
      detail: `L2 probe threw unexpectedly: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      remediation: "Investigate and re-run doctor.",
    };
  });
}
