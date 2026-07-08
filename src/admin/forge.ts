/**
 * @module admin/forge
 *
 * Admin subcommand: `forge <verb>`
 *
 * Exposes Forge capabilities at the CLI layer.
 *
 *   forge critic <renderedSnapshot.json>
 *     Reads a RenderedSnapshot JSON file, validates it through
 *     RenderedSnapshotSchema, runs runAntiGenericChecker, and prints
 *     the AntiGenericReport. Exits non-zero when blocking === true.
 *
 * Dep-injected for testability: unit tests supply stubs for the real FS.
 *
 * NOTE: the former `forge snapshot` verb (and its live-dashboard-read
 * plumbing) was removed alongside the web/ Forge dashboard test harness —
 * it existed solely to feed that GUI. `forge critic` is genuine Forge
 * capability (the anti-generic quality gate) and has no dependency on any
 * GUI; it survives standalone.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { resolveWithinRepo } from "../forge/repo-path.ts";
import {
  runAntiGenericChecker,
  RenderedSnapshotSchema
} from "../forge/anti-generic-checker.ts";
import type { AntiGenericReport, RenderedSnapshot } from "../forge/anti-generic-checker.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the repository root (two levels up from src/admin/). */
const REPO_ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Dep-injection interfaces (keep pure core testable with no real I/O)
// ---------------------------------------------------------------------------

export interface ForgeCriticDeps {
  /** Read a file and return its contents as a string. */
  readFile: (path: string) => Promise<string>;
  /** Run the anti-generic checker on a validated snapshot. */
  runChecker: typeof runAntiGenericChecker;
  /** Write the report JSON to stdout. */
  writeStdout: (data: string) => void;
  /** Write the human summary to stderr. */
  writeStderr: (data: string) => void;
  /**
   * Optional repo root for defense-in-depth path guard. When provided, the
   * snapshot path MUST resolve within this root (symlinks resolved) before
   * the file is read. When omitted, no bounds check is performed.
   */
  repoRoot?: string | undefined;
  /**
   * Asset ids whose deterministic asset-QA status is `passed`. Threaded into
   * the checker so a council-approved AG-018 `data-ag018-allow` marker is
   * honored when running `forge critic` against a snapshot that contains an
   * exempted illustration. Omitted/empty → AG-018 fails closed (no exemption).
   * There is no built-in manifest source: the one committed asset manifest
   * (`web/src/assets/asset-manifest.json`) belonged to the removed Forge web/
   * dashboard test harness. A caller that still needs the exemption supplies
   * this set explicitly via deps.
   */
  qaPassedAssetIds?: ReadonlySet<string> | undefined;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ForgeCriticResult {
  report: AntiGenericReport;
  /** True iff any violation has severity hard_fail. */
  blocking: boolean;
  /**
   * The exit code that forgeCommand should propagate (1 when blocking, 0 otherwise).
   * executeCriticVerb does NOT mutate process.exitCode — the caller (forgeCommand)
   * does, based on this field. This keeps the function side-effect-free in tests.
   */
  exitCode: 0 | 1;
}

// ---------------------------------------------------------------------------
// Arg-parse helpers
// ---------------------------------------------------------------------------

export interface ParsedForgeArgs {
  verb: string | undefined;
  /** For `critic`: the positional file path argument. */
  snapshotPath: string | undefined;
}

/** Pure arg-parse — no I/O side effects. */
export function parseForgeArgs(args: readonly string[]): ParsedForgeArgs {
  const verb = args[0];
  return {
    verb,
    // For critic, the positional file path is args[1] (after the verb).
    snapshotPath: args[1]
  };
}

// ---------------------------------------------------------------------------
// critic verb
// ---------------------------------------------------------------------------

/**
 * Format a Zod parse error into a readable multi-line message.
 * Never exposes raw Zod internals or stack traces.
 */
function formatZodError(err: unknown): string {
  if (
    err !== null &&
    typeof err === "object" &&
    "errors" in err &&
    Array.isArray((err as { errors: unknown }).errors)
  ) {
    const issues = (err as { errors: Array<{ path: unknown[]; message: string }> }).errors;
    const lines = issues.slice(0, 10).map(
      (issue) => `  - ${issue.path.length > 0 ? issue.path.join(".") + ": " : ""}${issue.message}`
    );
    return `Schema validation failed (${issues.length} issue${issues.length !== 1 ? "s" : ""}):\n${lines.join("\n")}`;
  }
  return "Schema validation failed (unknown error)";
}

/**
 * Execute the `critic` verb.
 *
 * Does NOT mutate process.exitCode — returns `exitCode: 0 | 1` instead.
 * The caller (forgeCommand) sets process.exitCode from the return value.
 * This keeps the function deterministic and side-effect-free in unit tests.
 */
export async function executeCriticVerb(
  args: readonly string[],
  deps: ForgeCriticDeps
): Promise<ForgeCriticResult> {
  // args is already verb-stripped (no "critic" at index 0).
  // The positional snapshot path is at index 0.
  const snapshotPath = args[0];

  if (!snapshotPath) {
    throw new Error(
      "forge critic: missing <renderedSnapshot.json> argument\n" +
        "Usage: forge critic <renderedSnapshot.json>"
    );
  }

  // Defense-in-depth: guard snapshot path before reading (symlinks resolved).
  // Only runs when deps.repoRoot is supplied by the caller.
  if (deps.repoRoot !== undefined) {
    try {
      resolveWithinRepo(snapshotPath, { repoRoot: deps.repoRoot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `forge critic: snapshot path "${snapshotPath}" is outside the repository root: ${msg}`
      );
    }
  }

  // Read the file — surface errors with a readable prefix.
  let raw: string;
  try {
    raw = await deps.readFile(snapshotPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`forge critic: could not read file "${snapshotPath}": ${msg}`);
  }

  // Parse JSON — fail clearly on malformed input.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`forge critic: "${snapshotPath}" is not valid JSON: ${msg}`);
  }

  // Validate through the Zod schema — format errors readably (no raw Zod stack).
  let snapshot: RenderedSnapshot;
  try {
    snapshot = RenderedSnapshotSchema.parse(parsed);
  } catch (err) {
    const detail = formatZodError(err);
    throw new Error(`forge critic: "${snapshotPath}" failed schema validation.\n${detail}`);
  }

  // Run the checker — pure and synchronous. Thread the QA-passed asset ids so a
  // council-approved AG-018 allow-marker is honored (fail closed when absent).
  const report = deps.runChecker(snapshot, { qaPassedAssetIds: deps.qaPassedAssetIds });

  // Output: JSON to stdout, human summary to stderr.
  deps.writeStdout(JSON.stringify(report, null, 2) + "\n");
  const violationCount = report.violations.length;
  const hardFailCount = report.violations.filter((v) => v.severity === "hard_fail").length;
  deps.writeStderr(
    `forge critic: ${violationCount} violation${violationCount !== 1 ? "s" : ""} ` +
      `(${hardFailCount} hard_fail), blocking=${report.blocking}\n`
  );

  return { report, blocking: report.blocking, exitCode: report.blocking ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Usage string
// ---------------------------------------------------------------------------

const USAGE = `Usage: forge <verb> [options]

Verbs:
  critic <snapshot.json>       Validate a RenderedSnapshot against anti-generic
                               rules. Exits 1 when blocking violations are found.
`;

// ---------------------------------------------------------------------------
// Public entry point — called from admin.ts dispatch chain
// ---------------------------------------------------------------------------

export async function forgeCommand(
  args: readonly string[],
  deps?: {
    critic?: Partial<ForgeCriticDeps>;
  }
): Promise<void> {
  const { verb } = parseForgeArgs(args);

  if (verb === "critic") {
    // Wire the real repo root for the defense-in-depth path guard only when no
    // caller-supplied deps override the critic configuration. When tests inject
    // deps, they are responsible for setting repoRoot if they want the guard.
    // This avoids test-path collisions where "/tmp/snap.json" (a common test
    // fixture path) would be rejected by the real REPO_ROOT guard.
    const repoRootForCritic: { repoRoot?: string } =
      deps?.critic === undefined ? { repoRoot: REPO_ROOT } : {};
    // No default qaPassedAssetIds source: the one committed manifest lived under
    // the removed Forge web/ dashboard. AG-018 fails closed unless a caller
    // supplies deps.critic.qaPassedAssetIds explicitly.
    const criticDeps: ForgeCriticDeps = {
      readFile: (path) => readFile(path, "utf8"),
      runChecker: runAntiGenericChecker,
      writeStdout: (data) => process.stdout.write(data),
      writeStderr: (data) => process.stderr.write(data),
      ...repoRootForCritic,
      ...deps?.critic
    };
    const result = await executeCriticVerb(args.slice(1), criticDeps);
    // Set the process exit code from the returned value — the function itself
    // is side-effect-free so tests can assert on result.exitCode without
    // fighting global state.
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
    return;
  }

  // Unknown or missing verb — clear usage error.
  if (verb === undefined) {
    throw new Error(`forge: verb required.\n\n${USAGE}`);
  }
  throw new Error(`forge: unknown verb "${verb}".\n\n${USAGE}`);
}
