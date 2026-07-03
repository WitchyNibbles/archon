/**
 * Guided init orchestration for archon install (S4).
 *
 * Owns:
 *   - Interactive consent prompts (TTY only, node:readline, no new deps)
 *   - Flag resolution (--yes, --install-plugin, --run-db-setup, --no-plugin, --json)
 *   - Consented step execution (npm install, archon migrate, archon bootstrap-project)
 *   - Post-install capability report (human text + optional JSON)
 *   - Report-derived next-steps (drops satisfied steps)
 *   - Install summary printing (extracted from cli.ts)
 *   - managedFileCapability mapping (extracted from cli.ts)
 *   - runEccInstallFromCli (extracted from cli.ts; re-exported via cli.ts for compat)
 *
 * Council conditions enforced here:
 *   C3: Default-No for ECC; DB/project step has recommended-path framing.
 *       Declined consent recorded as "skipped by choice — re-run with <flag> to complete".
 *       NEVER causes a failure / nonzero exit.
 *   C5: --yes accepts ONLY consumer-repo consents (npm/db). Never implies --install-plugin.
 *       eccConsented is NEVER derived from the yes flag — enforced in resolveConsent.
 *   C7: ECC CLI invocations use injected SpawnFn, array args, shell:false, hardcoded constants.
 *
 * Callers: cli.ts main() for init/upgrade --apply.
 * Dry-run paths: remain in cli.ts; runGuidedPhase returns early for dry-run.
 */
import { createInterface } from "node:readline";
import { spawn as nodeSpawn } from "node:child_process";
import {
  runConsentedEccInstall,
  createDefaultEccSpawnFn,
  createDefaultEccReadFileFn,
  createDefaultEccWriteFileFn,
} from "./ecc-plugin.ts";
import type { EccInstallResult, WriteFileFn as EccWriteFileFn } from "./ecc-plugin.ts";
import type { SpawnFn as EccSpawnFn } from "./capability/probes-external.ts";
import type { ReadFileFn as EccReadFileFn } from "./capability/probes-file.ts";
import type { CapabilityReport } from "./capability/types.ts";
import type { InstallSummary } from "./types.ts";
import type { RepairReport } from "./consumer-repair.ts";
import { buildNextSteps } from "./next-steps.ts";

// ---------------------------------------------------------------------------
// Injectable I/O interface (enables test isolation without a real TTY)
// ---------------------------------------------------------------------------

/**
 * Injectable I/O interface for guided-init prompts and output.
 * Production: backed by node:readline + process.stdout/stderr.
 * Tests: stub with preset answers + captured output arrays.
 */
export interface GuidedInitIo {
  /** True when stdin is a real TTY. When false, all prompts are skipped. */
  readonly isTTY: boolean;
  /** Ask the user a yes/no question; return their raw answer string. */
  question(prompt: string): Promise<string>;
  /** Print a message to stdout (non-error output). */
  stdout(msg: string): void;
  /** Print a message to stderr (error / warning output). */
  stderr(msg: string): void;
}

/** Creates the default GuidedInitIo backed by node:readline and process stdio. */
export function createDefaultGuidedInitIo(): GuidedInitIo {
  return {
    get isTTY(): boolean {
      return Boolean(process.stdin.isTTY);
    },
    question(prompt: string): Promise<string> {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    },
    stdout(msg: string): void {
      console.log(msg);
    },
    stderr(msg: string): void {
      console.error(msg);
    },
  };
}

// ---------------------------------------------------------------------------
// Injectable spawn for consumer-local commands (npm, npx)
// ---------------------------------------------------------------------------

/**
 * Injectable spawn function for consumer-local steps.
 * All calls use array args + shell:false (C7 discipline).
 * In production: streams child output to the parent process stdio.
 * In tests: stub returns preset exitCode / stdout / stderr.
 */
export type ConsumerSpawnFn = (
  command: string,
  args: readonly string[],
  cwd: string
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/** Creates the default ConsumerSpawnFn; streams child output live to the terminal. */
export function createDefaultConsumerSpawnFn(): ConsumerSpawnFn {
  return (command, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = nodeSpawn(command, [...args], {
        shell: false,
        cwd,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        resolve({ exitCode: code, stdout: "", stderr: "" });
      });
    });
}

// ---------------------------------------------------------------------------
// managedFileCapability — maps a target path to a capability name
// ---------------------------------------------------------------------------

/**
 * Maps a managed file's target path to the appropriate capability name from the registry.
 *
 * Extracted from cli.ts (S4 extraction) so both the verify command (cli.ts) and the
 * post-install capability check (guided-init.ts) share the same mapping logic.
 * cli.ts re-exports this function for backward compatibility with existing tests that
 * import it from "../../src/install/cli.ts".
 */
export function managedFileCapability(targetPath: string): string {
  if (targetPath.startsWith(".claude/agents/")) return "agents";
  if (targetPath.startsWith(".claude/skills/")) return "skills";
  if (targetPath.startsWith(".claude/hooks/") || targetPath === ".claude/settings.json") return "hooks";
  if (targetPath.startsWith(".archon/rules/")) return "rules";
  if (targetPath.startsWith(".archon/templates/")) return "workflow-scaffold";
  if (targetPath.startsWith(".archon/playwright/")) return "playwright-browsers";
  if (targetPath.startsWith(".githooks/")) return "git-guard";
  if (targetPath.startsWith("plugins/archon/")) return "mcp-archon";
  if (targetPath === ".mcp.json") return "mcp-archon";
  if (targetPath === "AGENTS.md") return "agents";
  return "managed-files";
}

// ---------------------------------------------------------------------------
// Install summary printer (extracted from cli.ts)
// ---------------------------------------------------------------------------

/**
 * Prints the install summary for init or upgrade commands.
 * Extracted from cli.ts (S4) so runGuidedPhase owns all post-install output.
 * cli.ts calls runGuidedPhase which calls this internally.
 */
export function printInstallSummary(
  command: "init" | "upgrade",
  targetRoot: string,
  summary: InstallSummary,
  io: GuidedInitIo
): void {
  if (command === "upgrade") {
    io.stdout(
      summary.mode === "dry-run"
        ? `archon upgrade plan for ${targetRoot}`
        : `archon upgraded ${targetRoot}`
    );
  } else {
    io.stdout(
      summary.mode === "dry-run"
        ? `archon dry run for ${targetRoot}`
        : `archon installed into ${targetRoot}`
    );
  }

  io.stdout(`mode: ${summary.mode}`);
  io.stdout(`created: ${summary.created.length}`);
  io.stdout(`updated: ${summary.updated.length}`);
  io.stdout(`skipped: ${summary.skipped.length}`);
  io.stdout(`conflicts: ${summary.conflicts.length}`);
  io.stdout(`orphans: ${summary.orphans.length}`);
  io.stdout(`backups created: ${summary.backups.length}`);
  io.stdout(`backups planned: ${summary.plannedBackups.length}`);
  io.stdout(`writes performed: ${summary.writesPerformed ? "yes" : "no"}`);

  if (summary.conflicts.length > 0) {
    io.stdout("Conflicts:");
    for (const filePath of summary.conflicts) {
      io.stdout(`- ${filePath}`);
    }
  }

  if (summary.orphans.length > 0) {
    io.stdout("Orphans:");
    for (const filePath of summary.orphans) {
      io.stdout(`- ${filePath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// runEccInstallFromCli — consented ECC install for CLI flag-driven path
// ---------------------------------------------------------------------------

/**
 * Runs the consented ECC plugin install for the CLI flag-driven path.
 *
 * Extracted from cli.ts (S4 extraction).
 * cli.ts re-exports this for backward compatibility with tests that import from cli.ts.
 *
 * Council C5: only called under explicit --install-plugin or interactive consent.
 *             NEVER called when only --yes is provided.
 * Council C7: uses EccSpawnFn — array args, hardcoded constants, shell:false.
 * Council C6: prints installed version; uses io.stderr on needs-confirmation or failure.
 * Council C13: idempotent — safe to run repeatedly.
 *
 * The spawnFnOverride parameter allows tests to inject a spawn stub without
 * triggering real CLI invocations (MEDIUM-5 coverage).
 */
export async function runEccInstallFromCli(
  targetRoot: string,
  confirmEccMajor: boolean,
  io: GuidedInitIo,
  spawnFnOverride?: EccSpawnFn,
  readFileFnOverride?: EccReadFileFn,
  writeFileFnOverride?: EccWriteFileFn
): Promise<void> {
  const spawnFn = spawnFnOverride ?? createDefaultEccSpawnFn();
  const readFileFn = readFileFnOverride ?? createDefaultEccReadFileFn();
  const writeFileFn = writeFileFnOverride ?? createDefaultEccWriteFileFn();

  const result: EccInstallResult = await runConsentedEccInstall(
    spawnFn,
    readFileFn,
    writeFileFn,
    targetRoot,
    { confirmMajorBump: confirmEccMajor }
  );

  if (result.status === "installed") {
    io.stdout(`ECC plugin installed: ${result.record.identity} v${result.record.version}`);
  } else if (result.status === "already-installed") {
    io.stdout(`ECC plugin already installed: ${result.record.identity} v${result.record.version}`);
  } else if (result.status === "needs-confirmation") {
    io.stderr(
      `ECC plugin major version bump detected: installed=${result.installedVersion}, ` +
      `recorded=${result.recordedVersion}. ` +
      `Re-run with --confirm-ecc-major to proceed.`
    );
  } else {
    // status === "failed"
    io.stderr(`ECC plugin install failed: ${result.error}`);
  }
}

// ---------------------------------------------------------------------------
// Consent resolution (C3, C5)
// ---------------------------------------------------------------------------

/** Result of resolving consent from flags and optional TTY prompts. */
interface ConsentResolution {
  /** ECC plugin install consented (--install-plugin explicit or TTY yes). C5: never from --yes. */
  readonly eccConsented: boolean;
  /** npm+migrate+bootstrap consented (--run-db-setup, --yes, or TTY yes). */
  readonly dbSetupConsented: boolean;
  /**
   * C3: non-empty when ECC was declined/skipped.
   * Format: "skipped by choice — re-run with --install-plugin to complete".
   */
  readonly eccSkipReason: string;
  /**
   * C3: non-empty when DB setup was declined/skipped.
   * Format: "skipped by choice — re-run with --run-db-setup (or --yes) to complete".
   */
  readonly dbSkipReason: string;
}

async function resolveConsent(opts: {
  isTTY: boolean;
  installPlugin: boolean | undefined;
  noPlugin: boolean | undefined;
  yes: boolean | undefined;
  runDbSetup: boolean | undefined;
  io: GuidedInitIo;
}): Promise<ConsentResolution> {
  const { isTTY, installPlugin, noPlugin, yes, runDbSetup, io } = opts;

  // --- ECC consent -----------------------------------------------------------
  // C5 INVARIANT: eccConsented is NEVER set when only --yes is provided.
  // ~/.claude writes require explicit --install-plugin or interactive TTY consent.
  let eccConsented = false;
  let eccSkipReason = "";

  if (noPlugin === true) {
    // Explicit decline: suppress prompt, record skip reason (C3)
    eccSkipReason = "skipped by choice — re-run with --install-plugin to complete";
  } else if (installPlugin === true) {
    // Explicit consent via --install-plugin flag
    eccConsented = true;
  } else if (isTTY) {
    // Interactive prompt (C3: default No — user must affirmatively opt in)
    const answer = await io.question(
      "\nInstall ECC plugin now? (writes to ~/.claude, user-global)\n" +
      "  Runs: claude plugin marketplace add affaan-m/ECC\n" +
      "        claude plugin install ecc@ecc\n" +
      "[y/N]: "
    );
    if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
      eccConsented = true;
    } else {
      eccSkipReason = "skipped by choice — re-run with --install-plugin to complete";
    }
  } else {
    // Non-TTY, no flag: apply default No (C3)
    eccSkipReason = "skipped by choice — re-run with --install-plugin to complete";
  }

  // --- DB / bootstrap consent -----------------------------------------------
  // C3: recommended-path framing; --yes and --run-db-setup both grant consent.
  let dbSetupConsented = false;
  let dbSkipReason = "";

  if (runDbSetup === true || yes === true) {
    // Explicit consent via flag
    dbSetupConsented = true;
  } else if (isTTY) {
    // Interactive prompt (recommended Yes)
    const answer = await io.question(
      "\nRun npm install, DB migrate, and bootstrap-project now? (recommended)\n" +
      "  Installs deps, applies migrations, registers project in archon runtime.\n" +
      "[Y/n]: "
    );
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "" || trimmed === "y" || trimmed === "yes") {
      dbSetupConsented = true;
    } else {
      dbSkipReason =
        "skipped by choice — re-run with --run-db-setup (or --yes) to complete";
    }
  } else {
    // Non-TTY, no flag: default No (C3)
    dbSkipReason =
      "skipped by choice — re-run with --run-db-setup (or --yes) to complete";
  }

  return { eccConsented, dbSetupConsented, eccSkipReason, dbSkipReason };
}

// ---------------------------------------------------------------------------
// Consented DB setup steps
// ---------------------------------------------------------------------------

/** Result of a single DB setup step. */
interface DbSetupStepResult {
  readonly step: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** Aggregate result of the consented DB setup sequence. */
export interface DbSetupResult {
  readonly steps: readonly DbSetupStepResult[];
  readonly allOk: boolean;
}

/**
 * Runs the three consented DB setup steps in sequence:
 *   1. npm install
 *   2. npm run archon:migrate  (only if npm install succeeded)
 *   3. npx archon bootstrap-project  (only if npm install succeeded)
 *
 * A failure in any step is reported via io.stderr with remediation guidance,
 * but DOES NOT abort the overall guided phase — the capability report is
 * still printed after this (honest partial state per C3).
 */
async function runConsentedDbSetup(
  spawnFn: ConsumerSpawnFn,
  targetRoot: string,
  io: GuidedInitIo
): Promise<DbSetupResult> {
  /**
   * Runs one step immutably: returns a DbSetupStepResult without mutating any array.
   * Callers accumulate results via spread/concat (immutable style).
   */
  const runStep = async (
    label: string,
    command: string,
    args: readonly string[]
  ): Promise<DbSetupStepResult> => {
    io.stdout(`\n  Running: ${command} ${args.join(" ")}`);
    try {
      const result = await spawnFn(command, args, targetRoot);
      if (result.exitCode !== 0) {
        const errMsg = `${label} exited with code ${String(result.exitCode)}.`;
        io.stderr(`  Error: ${errMsg}`);
        io.stderr(`  Remediation: run '${command} ${args.join(" ")}' manually in the project directory.`);
        return { step: label, ok: false, error: errMsg };
      }
      return { step: label, ok: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      io.stderr(`  Failed to spawn ${command}: ${errMsg}`);
      io.stderr(`  Remediation: run '${command} ${args.join(" ")}' manually in the project directory.`);
      return { step: label, ok: false, error: errMsg };
    }
  };

  // Step 1: npm install (must succeed before further steps that need node_modules).
  const npmResult = await runStep("npm install", "npm", ["install"]);

  if (npmResult.ok) {
    // Steps 2 and 3 run in sequence — bootstrap reads the migrations applied in step 2.
    const migrateResult = await runStep("npm run archon:migrate", "npm", ["run", "archon:migrate"]);
    const bootstrapResult = await runStep("npx archon bootstrap-project", "npx", ["archon", "bootstrap-project"]);
    const steps: readonly DbSetupStepResult[] = [npmResult, migrateResult, bootstrapResult];
    return { steps, allOk: steps.every((s) => s.ok) };
  }

  // npm install failed — record downstream steps as skipped without running them.
  const steps: readonly DbSetupStepResult[] = [
    npmResult,
    { step: "npm run archon:migrate", ok: false, error: "Skipped: npm install did not succeed." },
    { step: "npx archon bootstrap-project", ok: false, error: "Skipped: npm install did not succeed." },
  ];
  return { steps, allOk: false };
}

// ---------------------------------------------------------------------------
// Capability report printing
// ---------------------------------------------------------------------------

/**
 * Prints the capability report in human-readable format (or JSON if json=true).
 *
 * Human format:
 *   ok: one-liner "All capabilities operational."
 *   degraded: lists advisories + MCP one-time IDE approval note
 *   blocked: lists blockers + exact remediation
 *
 * JSON format: emits report as compact JSON on a single line (parseable by scripts).
 */
export function printCapabilityReport(
  report: CapabilityReport,
  io: GuidedInitIo,
  json: boolean
): void {
  if (json) {
    io.stdout(JSON.stringify(report));
    return;
  }

  io.stdout("\nPost-install capability check:");
  io.stdout(`  status: ${report.ok ? "ok" : "issues detected"}`);

  if (report.blockers.length > 0) {
    io.stdout(`  blockers (${report.blockers.length}):`);
    for (const b of report.blockers) {
      io.stdout(`    - ${b}`);
    }
  }

  if (report.advisories.length > 0) {
    io.stdout(`  advisories (${report.advisories.length}):`);
    for (const a of report.advisories) {
      io.stdout(`    - ${a}`);
    }
    // MCP one-time IDE approval note (always shown when there are advisories)
    io.stdout(
      "  Note: MCP server approval requires a one-time click in the IDE — " +
      "open Claude Code, navigate to MCP settings, and approve the archon MCP server."
    );
  }

  if (report.nextActions.length > 0) {
    io.stdout("  next actions:");
    for (const action of report.nextActions) {
      io.stdout(`    - ${action}`);
    }
  }

  if (report.ok && report.advisories.length === 0) {
    io.stdout("  All checked capabilities are operational.");
  }
}

// ---------------------------------------------------------------------------
// Report-derived next-steps (C3: drop satisfied steps; keep unmet ones)
// ---------------------------------------------------------------------------

/**
 * Returns true if the capability with the given name has status "ok" in the report.
 * Used to filter out next-steps that are already satisfied.
 */
function isCapabilityOk(report: CapabilityReport, capability: string): boolean {
  return report.probes.some((p) => p.capability === capability && p.status === "ok");
}

/**
 * Derives the next-steps list from the actual capability report.
 *
 * Starts from buildNextSteps (the full list for command × mode), then drops steps
 * that are provably satisfied based on the report probes:
 *   - node-modules probe ok → drop "Run npm install" step
 *   - dbSetupRan=true → drop migrate + bootstrap steps (we already ran them)
 *
 * "Drop satisfied" means the user doesn't need to re-do what's already done.
 * Unmet steps (probe blocked/degraded/skipped) are always kept.
 */
export function deriveNextStepsFromReport(
  report: CapabilityReport,
  command: "init" | "upgrade",
  opts: {
    readonly withGrafana: boolean;
    readonly withObsidian: boolean;
    /** True when DB setup ran and all steps succeeded. */
    readonly dbSetupRan: boolean;
  }
): string[] {
  const allSteps = buildNextSteps(command, "apply", {
    withGrafana: opts.withGrafana,
    withObsidian: opts.withObsidian,
  });

  const nodeModulesOk = isCapabilityOk(report, "node-modules");

  return allSteps.filter((step) => {
    // Drop "Run npm install" if node_modules probe says it's already done
    if (nodeModulesOk && /npm install/.test(step) && !/archon:migrate/.test(step)) {
      return false;
    }
    // Drop migrate + bootstrap if DB setup ran successfully
    if (opts.dbSetupRan && /archon:migrate/.test(step)) {
      return false;
    }
    if (opts.dbSetupRan && /bootstrap-project/.test(step)) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Guided phase options and result
// ---------------------------------------------------------------------------

/** Async function that runs the post-install capability check and returns the report. */
export type PostInstallReportFn = () => Promise<CapabilityReport>;

/** Options for runGuidedPhase. */
export interface GuidedPhaseOptions {
  /** "init" or "upgrade". */
  readonly command: "init" | "upgrade";
  /** Absolute path to the consumer repo root. */
  readonly targetRoot: string;
  /** Result from the file install step. */
  readonly summary: InstallSummary;
  readonly withGrafana: boolean;
  readonly withObsidian: boolean;

  // --- Flags (from parseInstallCommand) ---

  /**
   * --yes: accept all CONSUMER-REPO consents (npm/db steps).
   * C5: NEVER implies --install-plugin. Must NOT trigger ECC install.
   */
  readonly yes?: boolean;
  /**
   * --install-plugin: explicit consent for ECC plugin install (writes ~/.claude).
   * C5: this is the ONLY flag that triggers ECC; --yes does not.
   */
  readonly installPlugin?: boolean;
  /**
   * --no-plugin: explicitly decline ECC install (suppresses the TTY prompt).
   * Takes precedence over --install-plugin when both are present.
   */
  readonly noPlugin?: boolean;
  /**
   * --run-db-setup: explicit consent for npm install + migrate + bootstrap.
   * Equivalent to --yes for the DB setup step (more explicit).
   */
  readonly runDbSetup?: boolean;
  /**
   * --confirm-ecc-major: bypasses the ECC major-version confirmation gate.
   * Only relevant when installPlugin is true.
   */
  readonly confirmEccMajor?: boolean;
  /**
   * --json: emit capability report as compact JSON to stdout.
   * Human text report is suppressed when json=true.
   */
  readonly jsonReport?: boolean;

  // --- S5 consumer repair report ---
  /**
   * Optional repair report from consumer-repair.ts (S5).
   * When present, runGuidedPhase prints it after the install summary so
   * operators see what was healed before the capability check runs.
   */
  readonly repairReport?: RepairReport;

  // --- Injected capability report source ---
  /**
   * Async function that runs L0+L1+L2 probes and returns the CapabilityReport.
   * Injected by cli.ts; stub in tests.
   */
  readonly getCapabilityReport: PostInstallReportFn;

  // --- Injectables for testing (omit in production) ---
  readonly io?: GuidedInitIo;
  readonly consumerSpawnFn?: ConsumerSpawnFn;
  readonly eccSpawnFn?: EccSpawnFn;
  /** Optional injected read-file fn for ECC plugin record (avoids real fs in tests). */
  readonly eccReadFileFn?: EccReadFileFn;
  /** Optional injected write-file fn for ECC plugin record (avoids real fs in tests). */
  readonly eccWriteFileFn?: EccWriteFileFn;
}

/** Result returned by runGuidedPhase. */
export interface GuidedPhaseResult {
  /** 0 on success or C3 consent decline. Conflicts may set non-zero upstream. */
  readonly exitCode: number;
  /**
   * C3 "skipped by choice" messages for each consent point that was declined.
   * Never empty when at least one consent was declined.
   */
  readonly skippedMessages: string[];
  /** The capability report from the post-install check. undefined if dry-run. */
  readonly capabilityReport: CapabilityReport | undefined;
}

// ---------------------------------------------------------------------------
// printRepairReport — S5 consumer repair report
// ---------------------------------------------------------------------------

/**
 * Prints the S5 consumer repair report after the install summary.
 * Exported for tests; called by runGuidedPhase when repairReport is present.
 */
export function printRepairReport(report: RepairReport, io: GuidedInitIo): void {
  io.stdout("\nConsumer repair (S5):");
  io.stdout(`  detected: ${report.detected.length} issue(s)`);

  if (report.repaired.length > 0) {
    io.stdout("  repaired:");
    for (const r of report.repaired) {
      io.stdout(`    - ${r.description}`);
    }
  }

  if (report.notAutoRepaired.length > 0) {
    io.stdout("  pending (handled by upgrade pass or requires action):");
    for (const note of report.notAutoRepaired) {
      io.stdout(`    - ${note}`);
    }
  }

  if (report.backupPaths.length > 0) {
    io.stdout("  C12 backups:");
    for (const bp of report.backupPaths) {
      io.stdout(`    - ${bp}`);
    }
  }

  if (report.skillRefAdvisoryActive) {
    io.stdout(
      "  Advisory: consumer AGENT.md files may contain stale everything-claude-code:* skill refs" +
        " (inferred from stale settings.json entries; run archon verify for a full AGENT.md scan)." +
        " Run archon upgrade --migrate-skill-refs (S6) to migrate them."
    );
  }
}

// ---------------------------------------------------------------------------
// runGuidedPhase — main export
// ---------------------------------------------------------------------------

/**
 * Orchestrates the guided portion of an init/upgrade --apply command:
 *   1. Prints the install summary.
 *   2. Returns early for dry-run (no consent, no capability check).
 *   3. Resolves consent (prompts if TTY, flags if non-interactive).
 *   4. Runs ECC install if consented (C5: only under --install-plugin or TTY yes).
 *   5. Runs DB setup steps if consented (npm install, migrate, bootstrap).
 *   6. Prints C3 "skipped by choice" messages for declined consent.
 *   7. Runs post-install capability check via getCapabilityReport().
 *   8. Prints capability report (human text or JSON).
 *   9. Prints report-derived next-steps (drops satisfied steps).
 *
 * Council compliance:
 *   C3: declined consent → skippedMessages populated; exitCode=0; never failure.
 *   C5: eccConsented is NEVER derived from opts.yes.
 */
export async function runGuidedPhase(opts: GuidedPhaseOptions): Promise<GuidedPhaseResult> {
  const io = opts.io ?? createDefaultGuidedInitIo();
  const consumerSpawnFn = opts.consumerSpawnFn ?? createDefaultConsumerSpawnFn();

  // Step 1: Print install summary (extracted from cli.ts)
  printInstallSummary(opts.command, opts.targetRoot, opts.summary, io);

  // Step 1b: Print S5 consumer repair report (upgrade only; omitted when empty)
  if (opts.repairReport && opts.repairReport.detected.length > 0) {
    printRepairReport(opts.repairReport, io);
  }

  // Step 2: Return early for dry-run (next-steps from buildNextSteps, no prompts)
  if (opts.summary.mode === "dry-run") {
    io.stdout("Next steps:");
    const nextSteps = buildNextSteps(opts.command, "dry-run", {
      withGrafana: opts.withGrafana,
      withObsidian: opts.withObsidian,
    });
    for (const [i, step] of nextSteps.entries()) {
      io.stdout(`${i + 1}. ${step}`);
    }
    return { exitCode: 0, skippedMessages: [], capabilityReport: undefined };
  }

  // Step 3: Resolve consent from flags + optional TTY prompts
  const consent = await resolveConsent({
    isTTY: io.isTTY,
    installPlugin: opts.installPlugin,
    noPlugin: opts.noPlugin,
    yes: opts.yes,
    runDbSetup: opts.runDbSetup,
    io,
  });

  const skippedMessages: string[] = [];

  // Step 4: ECC install (C5: only when eccConsented — NEVER from --yes alone)
  if (consent.eccConsented) {
    io.stdout("\nInstalling ECC plugin...");
    await runEccInstallFromCli(
      opts.targetRoot,
      opts.confirmEccMajor ?? false,
      io,
      opts.eccSpawnFn,
      opts.eccReadFileFn,
      opts.eccWriteFileFn
    );
  } else if (consent.eccSkipReason) {
    skippedMessages.push(`ECC plugin install: ${consent.eccSkipReason}`);
  }

  // Step 5: DB setup steps (consented by --yes, --run-db-setup, or TTY yes)
  let dbSetupResult: DbSetupResult | undefined;
  if (consent.dbSetupConsented) {
    io.stdout("\nRunning DB setup steps...");
    dbSetupResult = await runConsentedDbSetup(consumerSpawnFn, opts.targetRoot, io);
    if (!dbSetupResult.allOk) {
      io.stderr(
        "\nSome DB setup steps failed — see above for remediation.\n" +
        "The capability report below reflects the current (partial) state."
      );
    }
  } else if (consent.dbSkipReason) {
    skippedMessages.push(`DB setup (npm install + migrate + bootstrap): ${consent.dbSkipReason}`);
  }

  // Step 6: Print C3 "skipped by choice" messages (never a failure)
  if (skippedMessages.length > 0) {
    io.stdout("\nSkipped steps (not failures — re-run to complete):");
    for (const msg of skippedMessages) {
      io.stdout(`  - ${msg}`);
    }
  }

  // Step 7: Post-install capability check
  io.stdout("\nRunning post-install capability check...");
  const report = await opts.getCapabilityReport();

  // Step 8: Print report
  printCapabilityReport(report, io, opts.jsonReport ?? false);

  // Step 9: Report-derived next-steps (drop satisfied steps)
  const dbSetupRan = consent.dbSetupConsented && (dbSetupResult?.allOk ?? false);
  const nextSteps = deriveNextStepsFromReport(report, opts.command, {
    withGrafana: opts.withGrafana,
    withObsidian: opts.withObsidian,
    dbSetupRan,
  });

  if (nextSteps.length > 0) {
    io.stdout("\nNext steps:");
    for (const [i, step] of nextSteps.entries()) {
      io.stdout(`${i + 1}. ${step}`);
    }
  }

  return { exitCode: 0, skippedMessages, capabilityReport: report };
}
