/**
 * @module admin/forge
 *
 * Admin subcommand: `forge <verb>`
 *
 * Exposes Forge capabilities at the CLI layer. Two verbs in this slice:
 *
 *   forge snapshot [--out <path>]
 *     Read-only. Builds and prints/writes the dashboard snapshot.
 *     Authority: derived_only — never writes runtime state.
 *
 *   forge critic <renderedSnapshot.json>
 *     Reads a RenderedSnapshot JSON file, validates it through
 *     RenderedSnapshotSchema, runs runAntiGenericChecker, and prints
 *     the AntiGenericReport. Exits non-zero when blocking === true.
 *
 * Dep-injected for testability: the real FS + generator are only
 * reached from forgeCommand(); unit tests supply stubs.
 */

import { readFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
import {
  buildSampleSnapshot,
  resolveSnapshotOutputPath,
  STDOUT_TARGET
} from "../forge/snapshot.ts";
import {
  runAntiGenericChecker,
  RenderedSnapshotSchema
} from "../forge/anti-generic-checker.ts";
import type { AntiGenericReport, RenderedSnapshot } from "../forge/anti-generic-checker.ts";

// ---------------------------------------------------------------------------
// Dep-injection interfaces (keep pure core testable with no real I/O)
// ---------------------------------------------------------------------------

export interface ForgeSnapshotDeps {
  /** Build and return a valid dashboard snapshot object. */
  buildSnapshot: typeof buildSampleSnapshot;
  /** Resolve the output path from a CLI argument (includes repo-bounds check). */
  resolveOutputPath: typeof resolveSnapshotOutputPath;
  /**
   * Write snapshot JSON to a file path.
   * Only called when outputPath !== STDOUT_TARGET.
   * Injected so unit tests can assert the call without touching the real FS.
   */
  writeFile: (path: string, data: string) => Promise<void>;
  /** Write the snapshot JSON to stdout (used when outputPath === STDOUT_TARGET). */
  writeStdout: (data: string) => void;
  /** Write a human-readable summary to stderr. */
  writeStderr: (data: string) => void;
}

export interface ForgeCriticDeps {
  /** Read a file and return its contents as a string. */
  readFile: (path: string) => Promise<string>;
  /** Run the anti-generic checker on a validated snapshot. */
  runChecker: typeof runAntiGenericChecker;
  /** Write the report JSON to stdout. */
  writeStdout: (data: string) => void;
  /** Write the human summary to stderr. */
  writeStderr: (data: string) => void;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ForgeSnapshotResult {
  outputPath: string;
}

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

/**
 * Look up a named flag value from an args array.
 *
 * Throws a clear usage error when `--flag` appears as the last token or is
 * immediately followed by another flag (no value provided).
 */
function parseFlag(args: readonly string[], flag: string): string | undefined {
  const prefixed = `--${flag}`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === prefixed) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(
          `forge snapshot: --${flag} requires a value but none was provided.\n` +
            `Usage: forge snapshot [--out <path>]\n` +
            `       Use --out - for stdout.`
        );
      }
      return next;
    }
    if (args[i]?.startsWith(`${prefixed}=`)) {
      const value = args[i]!.slice(prefixed.length + 1);
      if (value === "") {
        throw new Error(
          `forge snapshot: --${flag}= requires a non-empty value.\n` +
            `Usage: forge snapshot [--out <path>]`
        );
      }
      return value;
    }
  }
  return undefined;
}

export interface ParsedForgeArgs {
  verb: string | undefined;
  /** For `snapshot`: the --out path argument (undefined → default file). */
  outArg: string | undefined;
  /** For `critic`: the positional file path argument. */
  snapshotPath: string | undefined;
}

/** Pure arg-parse — no I/O side effects. */
export function parseForgeArgs(args: readonly string[]): ParsedForgeArgs {
  const verb = args[0];
  return {
    verb,
    outArg: parseFlag(args, "out"),
    // For critic, the positional file path is args[1] (after the verb).
    snapshotPath: args[1]
  };
}

// ---------------------------------------------------------------------------
// snapshot verb — READ-ONLY (derived_only authority).
//
// IMPORTANT: this verb NEVER writes runtime state (no store, no DB).
// The only FS write is to a JSON output file under the repo root, via the
// injected `deps.writeFile` dep, guarded by `resolveSnapshotOutputPath`
// (which enforces repo-bounds + .json extension before any write occurs).
// ---------------------------------------------------------------------------

export async function executeSnapshotVerb(
  args: readonly string[],
  deps: ForgeSnapshotDeps
): Promise<ForgeSnapshotResult> {
  // args is already verb-stripped (no "snapshot" at index 0).
  // parseFlag throws a clear error when --out appears without a value.
  const flagOut = parseFlag(args, "out");
  // Bare positional: the literal "-" (stdout) or a non-flag arg. A single-dash
  // token like "-v" is a flag, not a positional path — exclude it so it surfaces
  // as an unknown-flag/usage error rather than a misleading ".json required".
  const positionalOut = args.find((a) => a === "-" || !a.startsWith("-"));
  const outArg = flagOut ?? positionalOut;

  // resolveOutputPath enforces repo-bounds and .json extension before any
  // write attempt. Throws descriptively on invalid paths (path traversal, etc).
  const outputPath = deps.resolveOutputPath(outArg);
  const snapshot = deps.buildSnapshot();
  const json = JSON.stringify(snapshot, null, 2);

  if (outputPath === STDOUT_TARGET) {
    deps.writeStdout(json + "\n");
    deps.writeStderr("forge snapshot: validated against DashboardViewModelSchema\n");
  } else {
    // Write the file via the injected dep (real FS in production; spy in tests).
    // Surface FS failures (e.g. EACCES) with a prefixed, readable message —
    // consistent with how executeCriticVerb wraps readFile errors.
    try {
      await deps.writeFile(outputPath, json + "\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`forge snapshot: could not write file "${outputPath}": ${msg}`);
    }
    deps.writeStderr(`forge snapshot: snapshot written to ${outputPath}\n`);
  }

  return { outputPath };
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

  // Run the checker — pure and synchronous.
  const report = deps.runChecker(snapshot);

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
  snapshot [--out <path>]      Build and print/write the dashboard snapshot.
                               --out <path>  Write to a repo-relative .json path.
                               --out -       Write to stdout (default when no --out).
  critic <snapshot.json>       Validate a RenderedSnapshot against anti-generic
                               rules. Exits 1 when blocking violations are found.
`;

// ---------------------------------------------------------------------------
// Public entry point — called from admin.ts dispatch chain
// ---------------------------------------------------------------------------

export async function forgeCommand(
  args: readonly string[],
  deps?: {
    snapshot?: Partial<ForgeSnapshotDeps>;
    critic?: Partial<ForgeCriticDeps>;
  }
): Promise<void> {
  const { verb } = parseForgeArgs(args);

  if (verb === "snapshot") {
    const snapshotDeps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: resolveSnapshotOutputPath,
      writeFile: (path, data) => fsWriteFile(path, data, "utf8"),
      writeStdout: (data) => process.stdout.write(data),
      writeStderr: (data) => process.stderr.write(data),
      ...deps?.snapshot
    };
    await executeSnapshotVerb(args.slice(1), snapshotDeps);
    return;
  }

  if (verb === "critic") {
    const criticDeps: ForgeCriticDeps = {
      readFile: (path) => readFile(path, "utf8"),
      runChecker: runAntiGenericChecker,
      writeStdout: (data) => process.stdout.write(data),
      writeStderr: (data) => process.stderr.write(data),
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
