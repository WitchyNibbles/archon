/**
 * @module admin/forge
 *
 * Admin subcommand: `forge <verb>`
 *
 * Exposes Forge capabilities at the CLI layer. Two verbs in this slice:
 *
 *   forge snapshot [--out <path>] [--watch <seconds>] [--max-cycles <n>]
 *     Read-only. Builds and prints/writes the dashboard snapshot.
 *     Authority: derived_only — never writes runtime state.
 *
 *     --watch <seconds>      Re-emit the snapshot every <seconds> seconds.
 *                            No listening socket, no server.
 *     --max-cycles <n>       Stop after N total snapshot emissions (default: 60).
 *                            Graceful SIGINT also stops the loop.
 *
 *   forge critic <renderedSnapshot.json>
 *     Reads a RenderedSnapshot JSON file, validates it through
 *     RenderedSnapshotSchema, runs runAntiGenericChecker, and prints
 *     the AntiGenericReport. Exits non-zero when blocking === true.
 *
 * Dep-injected for testability: the real FS + generator are only
 * reached from forgeCommand(); unit tests supply stubs.
 * Timer functions are injected so the watch loop is deterministic in tests.
 */

import { readFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { resolveWithinRepo } from "../forge/repo-path.ts";
import {
  buildSampleSnapshot,
  buildSnapshotFromLive,
  projectLiveSnapshot,
  resolveSnapshotOutputPath,
  STDOUT_TARGET
} from "../forge/snapshot.ts";
import type { SnapshotMode } from "../forge/snapshot.ts";
import type { DashboardViewModel } from "../forge/dashboard-contract.ts";
import {
  runAntiGenericChecker,
  RenderedSnapshotSchema
} from "../forge/anti-generic-checker.ts";
import type { AntiGenericReport, RenderedSnapshot } from "../forge/anti-generic-checker.ts";
import { loadDotEnv, withClient } from "./db.ts";
import { PostgresStore } from "../store/postgres-store.ts";
import { ArchonCoreService } from "../core/service.ts";
import type {
  RunRecord,
  RunStatusSnapshot,
  RoutingRecommendationReport,
  ReviewRecord
} from "../domain/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the repository root (two levels up from src/admin/). */
const REPO_ROOT = resolve(__dirname, "..", "..");

/** Default maximum cycles for --watch when --max-cycles is not specified. */
const DEFAULT_MAX_WATCH_CYCLES = 60;

// ---------------------------------------------------------------------------
// Dep-injection interfaces (keep pure core testable with no real I/O)
// ---------------------------------------------------------------------------

/**
 * Injected live-read dependencies for the snapshot verb in live mode.
 * Kept separate from ForgeSnapshotDeps so the seam is explicit and tests
 * can assert the liveReader is or is not called depending on the mode.
 *
 * The liveReader is strictly READ-ONLY — it MUST NOT call any store write
 * methods. The caller (forgeCommand) constructs the liveReader closure using
 * read-only store/service methods only.
 */
export interface ForgeSnapshotLiveReadDeps {
  /**
   * Async function that builds a live DashboardViewModel from the runtime.
   * Called only in live mode (no --sample flag). On ANY error, the caller
   * (buildSnapshotFromLive) catches it, logs the reason, and falls back to
   * the synthetic sample. This function MUST NOT perform any store writes.
   */
  liveReader: () => Promise<DashboardViewModel>;
}

export interface ForgeSnapshotDeps {
  /** Build and return the SYNTHETIC sample snapshot (used in --sample mode and as fallback). */
  buildSnapshot: typeof buildSampleSnapshot;
  /**
   * Resolve the output path from a CLI argument (includes repo-bounds check).
   * The second arg is the repoRoot; the third arg is the snapshot mode ("live" | "sample").
   * Mode controls the default output path when arg is undefined:
   *   - "live"   → snapshot.live.json (gitignored)
   *   - "sample" → snapshot.json (committed fixture)
   */
  resolveOutputPath: (arg: string | undefined, repoRoot?: string, mode?: SnapshotMode) => string;
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
  /**
   * Injectable timer function (default: global setTimeout).
   * Used by --watch to schedule the next cycle.
   * Inject a synchronous/immediate stub in tests to avoid real sleeps.
   */
  timerFn?: ((callback: () => void, ms: number) => NodeJS.Timeout) | undefined;
  /**
   * Injectable timer-cancel function (default: global clearTimeout).
   * Used to cancel the pending timer on loop termination or SIGINT.
   */
  clearTimerFn?: ((timer: NodeJS.Timeout) => void) | undefined;
  /**
   * Live-read deps for the default (non-sample) mode.
   * When present and --sample is NOT given, the snapshot verb calls
   * buildSnapshotFromLive(deps.liveReadDeps.liveReader) instead of
   * deps.buildSnapshot(). On liveReader failure it falls back to deps.buildSnapshot().
   * When absent, the verb always uses deps.buildSnapshot() (offline/sample mode).
   */
  liveReadDeps?: ForgeSnapshotLiveReadDeps | undefined;
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
  /**
   * Optional repo root for defense-in-depth path guard. When provided, the
   * snapshot path MUST resolve within this root (symlinks resolved) before
   * the file is read. When omitted, no bounds check is performed.
   */
  repoRoot?: string | undefined;
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
            `Usage: forge snapshot [--out <path>] [--watch <seconds>] [--max-cycles <n>]\n` +
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
            `Usage: forge snapshot [--out <path>] [--watch <seconds>] [--max-cycles <n>]`
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
//
// --watch <seconds> [--max-cycles <n>] mode:
//   Re-emits the snapshot every <seconds> seconds, up to <n> total cycles.
//   Default max cycles: DEFAULT_MAX_WATCH_CYCLES (60). Stops cleanly on SIGINT.
//   No listening socket, no server — only file writes on a timer.
//   The timerFn dep is injected so tests can drive the loop without real sleeps.
// ---------------------------------------------------------------------------

/**
 * Check whether the boolean --sample flag is present in args.
 * It is a bare flag (no value), so it is not handled by parseFlag.
 */
function hasSampleFlag(args: readonly string[]): boolean {
  return args.includes("--sample");
}

/**
 * Build the snapshot for one cycle.
 *
 * In SAMPLE mode (--sample or no liveReadDeps): calls deps.buildSnapshot() synchronously.
 * In LIVE mode (default):  calls buildSnapshotFromLive with the injected liveReader.
 *   On ANY error the fallback is deps.buildSnapshot(), logged to deps.writeStderr.
 */
async function buildCycleSnapshot(
  sampleMode: boolean,
  deps: ForgeSnapshotDeps
): Promise<ReturnType<typeof buildSampleSnapshot>> {
  if (sampleMode || deps.liveReadDeps === undefined) {
    return deps.buildSnapshot();
  }
  // Live mode: buildSnapshotFromLive catches all errors and falls back.
  const { liveReader } = deps.liveReadDeps;
  return buildSnapshotFromLive(liveReader, {
    writeStderr: deps.writeStderr
  });
}

/**
 * Write one snapshot cycle: build, serialise, and write to the resolved path.
 * Called once per cycle in both single-shot and --watch mode.
 */
async function writeSnapshotOnce(
  outputPath: string,
  sampleMode: boolean,
  deps: ForgeSnapshotDeps
): Promise<void> {
  const snapshot = await buildCycleSnapshot(sampleMode, deps);
  const json = JSON.stringify(snapshot, null, 2);

  if (outputPath === STDOUT_TARGET) {
    deps.writeStdout(json + "\n");
    deps.writeStderr("forge snapshot: validated against DashboardViewModelSchema\n");
  } else {
    try {
      await deps.writeFile(outputPath, json + "\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`forge snapshot: could not write file "${outputPath}": ${msg}`);
    }
    deps.writeStderr(`forge snapshot: snapshot written to ${outputPath}\n`);
  }
}

/**
 * Collect the set of indices that are flag VALUES (the token immediately
 * following a `--flag` token, or the part after `=` in `--flag=val`).
 * These must NOT be treated as positional arguments.
 */
function flagValueIndices(args: readonly string[]): Set<number> {
  const indices = new Set<number>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a !== undefined && a.startsWith("--") && !a.includes("=")) {
      // The next token is the value (if it exists and isn't another flag).
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        indices.add(i + 1);
      }
    }
  }
  return indices;
}

export async function executeSnapshotVerb(
  args: readonly string[],
  deps: ForgeSnapshotDeps
): Promise<ForgeSnapshotResult> {
  // args is already verb-stripped (no "snapshot" at index 0).
  // parseFlag throws a clear error when --out appears without a value.
  const flagOut = parseFlag(args, "out");
  // Bare positional: the literal "-" (stdout) or a non-flag arg that is NOT
  // a flag value. A single-dash token like "-v" is a flag, not a positional
  // path — exclude it. Also exclude tokens that are values of other flags
  // (e.g. the "5" in "--watch 5" must not become the output path).
  const valueIndices = flagValueIndices(args);
  const positionalOut = args.find(
    (a, idx) => !valueIndices.has(idx) && (a === "-" || !a.startsWith("-"))
  );
  const outArg = flagOut ?? positionalOut;

  const watchRaw = parseFlag(args, "watch");
  const maxCyclesRaw = parseFlag(args, "max-cycles");

  // --sample: emit the synthetic sample to the committed path (snapshot.json).
  // Default (no --sample): live mode → snapshot.live.json (gitignored).
  const sampleMode = hasSampleFlag(args);
  const snapshotMode: SnapshotMode = sampleMode ? "sample" : "live";

  // resolveOutputPath enforces repo-bounds and .json extension before any
  // write attempt. Throws descriptively on invalid paths (path traversal, etc).
  const outputPath = deps.resolveOutputPath(outArg, undefined, snapshotMode);

  // Single-shot mode (no --watch).
  if (watchRaw === undefined) {
    await writeSnapshotOnce(outputPath, sampleMode, deps);
    return { outputPath };
  }

  // --watch mode: bounded poller, no socket, no server.
  const intervalSeconds = parsePositiveInt(watchRaw, "--watch");
  const maxCycles =
    maxCyclesRaw !== undefined
      ? parsePositiveInt(maxCyclesRaw, "--max-cycles")
      : DEFAULT_MAX_WATCH_CYCLES;

  const timerFn = deps.timerFn ?? setTimeout;
  const clearTimerFn = deps.clearTimerFn ?? clearTimeout;

  let cyclesDone = 0;
  let stopped = false;
  let pendingTimer: NodeJS.Timeout | undefined;

  // Graceful SIGINT stop.
  const onSigint = () => {
    stopped = true;
    if (pendingTimer !== undefined) {
      clearTimerFn(pendingTimer);
      pendingTimer = undefined;
    }
    deps.writeStderr("forge snapshot --watch: received SIGINT, stopping loop\n");
  };
  process.once("SIGINT", onSigint);

  // Run the bounded loop.
  try {
    while (!stopped && cyclesDone < maxCycles) {
      // Write a snapshot for this cycle.
      await writeSnapshotOnce(outputPath, sampleMode, deps);
      cyclesDone += 1;
      deps.writeStderr(
        `forge snapshot --watch: cycle ${cyclesDone}/${maxCycles} complete\n`
      );

      // If we've reached the cap, stop.
      if (cyclesDone >= maxCycles || stopped) {
        break;
      }

      // Wait for the next interval via the injected timer.
      await new Promise<void>((resolve) => {
        pendingTimer = timerFn(() => {
          pendingTimer = undefined;
          resolve();
        }, intervalSeconds * 1000);
      });
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (pendingTimer !== undefined) {
      clearTimerFn(pendingTimer);
      pendingTimer = undefined;
    }
  }

  deps.writeStderr(
    `forge snapshot --watch: loop complete after ${cyclesDone} cycle${cyclesDone !== 1 ? "s" : ""}\n`
  );

  return { outputPath };
}

/**
 * Parse a positive integer from a flag value string.
 * Throws a clear usage error on non-integer or non-positive input.
 */
function parsePositiveInt(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `forge snapshot: ${flagName} requires a positive integer, got: ${raw}`
    );
  }
  return n;
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
  snapshot [--out <path>]             Build and write the dashboard snapshot.
           [--sample]                 Emit the SYNTHETIC sample to snapshot.json
                                      (default: LIVE read → snapshot.live.json).
           [--watch <seconds>]        Re-emit on an interval (no socket, no server).
           [--max-cycles <n>]         Stop after N cycles (default: ${DEFAULT_MAX_WATCH_CYCLES}).
                                      Graceful stop: send SIGINT (Ctrl-C).
                               --out <path>  Write to a repo-relative .json path.
                               --out -       Write to stdout.
  critic <snapshot.json>       Validate a RenderedSnapshot against anti-generic
                               rules. Exits 1 when blocking violations are found.
`;

// ---------------------------------------------------------------------------
// Live reader factory — builds a liveReader closure using read-only store ops.
//
// This keeps snapshot.ts free of any DB dependency.
// The reader is STRICTLY read-only: only store.findLatestRun, service.getStatus,
// service.recommendRouting, and store.getReviews are called. No write ops.
//
// Adapter (explicit field mapping):
//   RunStatusSnapshot             → projectLiveSnapshot arg 1
//   RoutingRecommendationReport   → projectLiveSnapshot arg 2
//   ReviewRecord[]                → projectLiveSnapshot arg 3 (all tasks)
// ---------------------------------------------------------------------------

/**
 * The narrow READ-ONLY store surface the live read depends on. Declaring it as
 * an explicit structural interface (not the full PostgresStore) makes the
 * read-only property mechanically enforceable: a test can pass a spy that traps
 * EVERY method access and assert that only these read methods were ever reached.
 */
export interface LiveReadStore {
  findLatestRun(params: { workspaceSlug: string; projectSlug: string }): Promise<RunRecord | undefined>;
  getReviews(runId: string, taskId: string): Promise<readonly ReviewRecord[]>;
}

/** The narrow READ-ONLY service surface the live read depends on. */
export interface LiveReadService {
  getStatus(runId: string): Promise<RunStatusSnapshot>;
  recommendRouting(runId: string): Promise<RoutingRecommendationReport>;
}

/**
 * Pure read-orchestration for the live dashboard snapshot — separated from the
 * DB-connection wiring (loadDotEnv / withClient / PostgresStore construction)
 * so it is unit-testable WITHOUT a database and so the read-only guarantee can
 * be proven by a write-trapping spy.
 *
 * STRICTLY READ-ONLY: the `store`/`service` parameters expose only read methods
 * (`LiveReadStore`/`LiveReadService`). There is no write method in scope to call.
 */
export async function readLiveDashboard(
  store: LiveReadStore,
  service: LiveReadService,
  slugs: { workspaceSlug: string; projectSlug: string }
): Promise<DashboardViewModel> {
  const run = await store.findLatestRun(slugs);
  if (run === undefined) {
    throw new Error(
      `forge snapshot live read: no run found for workspace "${slugs.workspaceSlug}" / project "${slugs.projectSlug}"`
    );
  }

  // Fetch the read-only inputs — status + routing in parallel for performance.
  const [snapshot, routing] = await Promise.all([
    service.getStatus(run.id),
    service.recommendRouting(run.id),
  ]);

  // Fetch reviews for all tasks (read-only).
  const allReviews = (
    await Promise.all(
      snapshot.tasks.map((t) => store.getReviews(run.id, t.packet.taskId))
    )
  ).flat();

  // Project to DashboardViewModel with explicit field mapping + strip parse.
  return projectLiveSnapshot(snapshot, routing, [...allReviews]);
}

// ---------------------------------------------------------------------------
// Live reader factory — builds a liveReader closure from the read-only
// orchestration above plus the DB-connection wiring. This factory is the only
// place that constructs a real PostgresStore; readLiveDashboard stays DB-free.
// ---------------------------------------------------------------------------

function buildRealLiveReader(): () => Promise<DashboardViewModel> {
  return async () => {
    await loadDotEnv();
    return withClient(async (client) => {
      const store = new PostgresStore(client);
      const service = new ArchonCoreService(store);
      const workspaceSlug = process.env["ARCHON_WORKSPACE"] ?? "default";
      const projectSlug = process.env["ARCHON_PROJECT"] ?? "archon";
      return readLiveDashboard(store, service, { workspaceSlug, projectSlug });
    });
  };
}

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
      // Wire the real live reader — the verb uses it in live mode (no --sample flag).
      // Tests override this via deps?.snapshot.liveReadDeps.
      liveReadDeps: { liveReader: buildRealLiveReader() },
      ...deps?.snapshot
    };
    await executeSnapshotVerb(args.slice(1), snapshotDeps);
    return;
  }

  if (verb === "critic") {
    // Wire the real repo root for the defense-in-depth path guard only when no
    // caller-supplied deps override the critic configuration. When tests inject
    // deps, they are responsible for setting repoRoot if they want the guard.
    // This avoids test-path collisions where "/tmp/snap.json" (a common test
    // fixture path) would be rejected by the real REPO_ROOT guard.
    const repoRootForCritic: { repoRoot?: string } =
      deps?.critic === undefined ? { repoRoot: REPO_ROOT } : {};
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
