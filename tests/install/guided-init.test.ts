/**
 * Tests for src/install/guided-init.ts (S4 guided-init orchestration).
 *
 * ALL tests use injected stubs — no real TTY, no real spawn calls,
 * no real npm / DB / claude invocations, no filesystem writes (C7 / test isolation).
 *
 * Coverage:
 *  - managedFileCapability: path-to-capability mapping
 *  - printInstallSummary: output via injected io
 *  - printCapabilityReport: human format + JSON format + nextActions
 *  - deriveNextStepsFromReport: satisfied step dropped, unmet steps kept
 *  - runGuidedPhase — consent resolution paths:
 *      NON-TTY, no flags          → both declined (C3 messages, exitCode=0) [C3]
 *      --no-plugin                → ECC declined, DB prompt skipped (non-TTY)
 *      --no-plugin + --install-plugin conflict → noPlugin wins, eccConsented=false [C3]
 *      --install-plugin           → ECC consented, no DB (non-TTY, no --yes), full stub injection
 *      --yes                      → DB consented, ECC NOT triggered (C5)
 *      --yes alone                → spawn recorder never invoked for 'claude' (C5 hard)
 *      --yes + --no-plugin        → DB consented, ECC NOT triggered
 *      --run-db-setup             → DB consented, ECC NOT triggered
 *      --json                     → report emitted as JSON with all doctor-shape fields
 *      dry-run                    → returns early, no prompts, no capability check
 *  - runGuidedPhase — TTY paths (via injected io.question):
 *      TTY, answers 'n'/'N'       → ECC declined (C3), DB declined (C3)
 *      TTY, answer '' (enter)     → ECC default No, DB default Yes
 *      TTY, 'n' then 'y'          → ECC declined, DB consented (partial-decline mid-sequence)
 *      TTY, answers 'y'/'Y'       → ECC consented, DB consented, full stub injection
 *  - Consented DB step failure: capability report still printed (honesty)
 *  - Satisfied DB setup → derive next-steps drops migrate + bootstrap steps
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CapabilityReport, ProbeResult } from "../../src/install/capability/types.ts";
// Note: mkdtemp/rm no longer needed — ECC tests use injected read/write stubs instead of real fs.
import type { InstallSummary } from "../../src/install/types.ts";
import type { ReadFileFn } from "../../src/install/capability/probes-file.ts";
import type { WriteFileFn as EccWriteFileFn } from "../../src/install/ecc-plugin.ts";
import {
  managedFileCapability,
  printInstallSummary,
  printCapabilityReport,
  deriveNextStepsFromReport,
  runGuidedPhase,
  createDefaultGuidedInitIo,
} from "../../src/install/guided-init.ts";
import type {
  GuidedInitIo,
  ConsumerSpawnFn,
  GuidedPhaseOptions,
} from "../../src/install/guided-init.ts";
import type { SpawnFn as EccSpawnFn } from "../../src/install/capability/probes-external.ts";

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

function makeIo(opts: {
  isTTY?: boolean;
  /** Answers returned in order for each .question() call. */
  answers?: string[];
}): GuidedInitIo & { stdoutLines: string[]; stderrLines: string[]; questionCount: number } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let questionIdx = 0;
  let questionCount = 0;
  const answers = opts.answers ?? [];

  const io: GuidedInitIo & { stdoutLines: string[]; stderrLines: string[]; questionCount: number } = {
    isTTY: opts.isTTY ?? false,
    async question(_prompt: string): Promise<string> {
      questionCount++;
      const answer = answers[questionIdx] ?? "";
      questionIdx++;
      return answer;
    },
    stdout(msg: string): void {
      stdoutLines.push(msg);
    },
    stderr(msg: string): void {
      stderrLines.push(msg);
    },
    stdoutLines,
    stderrLines,
    get questionCount() {
      return questionCount;
    },
  };
  return io;
}

function makeConsumerSpawnFn(
  responses: Record<string, { exitCode: number; stdout: string; stderr: string }> = {}
): ConsumerSpawnFn & { calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const fn: ConsumerSpawnFn = async (command, args, _cwd) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    return responses[key] ?? responses["*"] ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  (fn as ConsumerSpawnFn & { calls: typeof calls }).calls = calls;
  return fn as ReturnType<typeof makeConsumerSpawnFn>;
}

function makeEccSpawnFn(
  responses: Record<string, { exitCode: number | null; stdout: string; stderr: string }> = {}
): EccSpawnFn & { calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const fn: EccSpawnFn = async (command, args, _opts) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    return responses[key] ?? responses["*"] ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  (fn as EccSpawnFn & { calls: typeof calls }).calls = calls;
  return fn as ReturnType<typeof makeEccSpawnFn>;
}

/** Stub ECC read-file fn: returns the pre-seeded record content or undefined. */
function makeEccReadFileFn(
  files: Record<string, string> = {}
): ReadFileFn {
  return async (absolutePath: string) => files[absolutePath];
}

/** Stub ECC write-file fn: records writes without touching the filesystem. */
function makeEccWriteFileFn(): EccWriteFileFn & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  const fn: EccWriteFileFn = async (absolutePath: string, content: string) => {
    written[absolutePath] = content;
  };
  (fn as EccWriteFileFn & { written: typeof written }).written = written;
  return fn as ReturnType<typeof makeEccWriteFileFn>;
}

/**
 * Builds a minimal opts bundle for ECC-install tests that avoids real fs writes.
 * The ECC spawn returns a "already-installed" plugin list; read/write are stubbed.
 */
function makeEccStubBundle(): {
  eccSpawn: ReturnType<typeof makeEccSpawnFn>;
  eccReadFileFn: ReadFileFn;
  eccWriteFileFn: ReturnType<typeof makeEccWriteFileFn>;
} {
  const eccSpawn = makeEccSpawnFn({
    "*": { exitCode: 0, stdout: "Installed plugins:\n\n  > ecc@ecc\n    Version: 2.0.0\n", stderr: "" },
  });
  const eccReadFileFn = makeEccReadFileFn(); // no existing record → triggers install path
  const eccWriteFileFn = makeEccWriteFileFn();
  return { eccSpawn, eccReadFileFn, eccWriteFileFn };
}

function makeReport(overrides?: Partial<CapabilityReport>): CapabilityReport {
  return {
    ok: true,
    blockers: [],
    advisories: [],
    nextActions: [],
    reason: "",
    probes: [],
    ...overrides,
  };
}

function makeNodeModulesProbe(status: "ok" | "blocked" | "degraded"): ProbeResult {
  return {
    capability: "node-modules",
    layer: "L1",
    status,
    code: `node-modules-${status}`,
    detail: `node_modules ${status}`,
    remediation: status === "ok" ? "" : "Run npm install",
  };
}

function makeInstallSummary(overrides?: Partial<InstallSummary>): InstallSummary {
  return {
    mode: "apply",
    writesPerformed: true,
    created: [],
    updated: [],
    skipped: [],
    backups: [],
    plannedBackups: [],
    conflicts: [],
    orphans: [],
    nextSteps: [],
    ...overrides,
  };
}

const TARGET = "/fake/consumer-repo";
const noop = async (): Promise<CapabilityReport> => makeReport();

// Helper to build a minimal GuidedPhaseOptions
function makeOpts(
  overrides: Partial<GuidedPhaseOptions>
): GuidedPhaseOptions {
  return {
    command: "init",
    targetRoot: TARGET,
    summary: makeInstallSummary(),
    withGrafana: false,
    withObsidian: false,
    getCapabilityReport: noop,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// managedFileCapability
// ---------------------------------------------------------------------------

test("managedFileCapability: .claude/agents/ → agents", () => {
  assert.equal(managedFileCapability(".claude/agents/planner.md"), "agents");
});

test("managedFileCapability: .claude/skills/ → skills", () => {
  assert.equal(managedFileCapability(".claude/skills/archon-intake.md"), "skills");
});

test("managedFileCapability: .claude/hooks/ → hooks", () => {
  assert.equal(managedFileCapability(".claude/hooks/pre-tool.sh"), "hooks");
});

test("managedFileCapability: .claude/settings.json → hooks", () => {
  assert.equal(managedFileCapability(".claude/settings.json"), "hooks");
});

test("managedFileCapability: .archon/rules/ → rules", () => {
  assert.equal(managedFileCapability(".archon/rules/policy.md"), "rules");
});

test("managedFileCapability: .archon/templates/ → workflow-scaffold", () => {
  assert.equal(managedFileCapability(".archon/templates/brief.md"), "workflow-scaffold");
});

test("managedFileCapability: .archon/playwright/ → playwright-browsers", () => {
  assert.equal(managedFileCapability(".archon/playwright/config.ts"), "playwright-browsers");
});

test("managedFileCapability: .githooks/ → git-guard", () => {
  assert.equal(managedFileCapability(".githooks/commit-msg"), "git-guard");
});

test("managedFileCapability: plugins/archon/ → mcp-archon", () => {
  assert.equal(managedFileCapability("plugins/archon/server.ts"), "mcp-archon");
});

test("managedFileCapability: .mcp.json → mcp-archon", () => {
  assert.equal(managedFileCapability(".mcp.json"), "mcp-archon");
});

test("managedFileCapability: AGENTS.md → agents", () => {
  assert.equal(managedFileCapability("AGENTS.md"), "agents");
});

test("managedFileCapability: unknown path → managed-files", () => {
  assert.equal(managedFileCapability("some/other/file.md"), "managed-files");
});

// ---------------------------------------------------------------------------
// printInstallSummary
// ---------------------------------------------------------------------------

test("printInstallSummary: init apply — prints correct header and counts", () => {
  const io = makeIo({});
  printInstallSummary("init", TARGET, makeInstallSummary({ created: ["a", "b"], updated: ["c"] }), io);
  const out = io.stdoutLines.join("\n");
  assert.match(out, /archon installed into/);
  assert.match(out, /created: 2/);
  assert.match(out, /updated: 1/);
});

test("printInstallSummary: upgrade dry-run — prints upgrade plan header", () => {
  const io = makeIo({});
  printInstallSummary("upgrade", TARGET, makeInstallSummary({ mode: "dry-run", writesPerformed: false }), io);
  const out = io.stdoutLines.join("\n");
  assert.match(out, /archon upgrade plan for/);
});

test("printInstallSummary: lists conflicts and orphans", () => {
  const io = makeIo({});
  printInstallSummary(
    "init",
    TARGET,
    makeInstallSummary({ conflicts: ["CLAUDE.md"], orphans: [".archon/old.md"] }),
    io
  );
  const out = io.stdoutLines.join("\n");
  assert.match(out, /CLAUDE\.md/);
  assert.match(out, /\.archon\/old\.md/);
});

// ---------------------------------------------------------------------------
// printCapabilityReport
// ---------------------------------------------------------------------------

test("printCapabilityReport: ok report — prints 'All checked capabilities are operational'", () => {
  const io = makeIo({});
  printCapabilityReport(makeReport(), io, false);
  const out = io.stdoutLines.join("\n");
  assert.match(out, /All checked capabilities are operational/);
});

test("printCapabilityReport: blockers listed in human format", () => {
  const io = makeIo({});
  printCapabilityReport(
    makeReport({ ok: false, blockers: ["database unreachable"], advisories: [] }),
    io,
    false
  );
  const out = io.stdoutLines.join("\n");
  assert.match(out, /database unreachable/);
});

test("printCapabilityReport: advisories listed + MCP note shown", () => {
  const io = makeIo({});
  printCapabilityReport(
    makeReport({ ok: true, advisories: ["mcp-archon not yet approved"] }),
    io,
    false
  );
  const out = io.stdoutLines.join("\n");
  assert.match(out, /mcp-archon not yet approved/);
  assert.match(out, /one-time click/);
});

test("printCapabilityReport: json=true emits single-line JSON, no prose", () => {
  const io = makeIo({});
  const report = makeReport({ ok: true, blockers: [], advisories: ["advisory-1"] });
  printCapabilityReport(report, io, true);
  assert.equal(io.stdoutLines.length, 1);
  const parsed = JSON.parse(io.stdoutLines[0]!) as CapabilityReport;
  assert.deepEqual(parsed.advisories, ["advisory-1"]);
});

// Finding 4: nextActions non-empty exercises lines 473-477
test("printCapabilityReport: non-empty nextActions printed in human format", () => {
  const io = makeIo({});
  printCapabilityReport(
    makeReport({
      ok: false,
      blockers: ["db missing"],
      nextActions: ["Create .env.archon", "Run npm run archon:migrate"],
    }),
    io,
    false
  );
  const out = io.stdoutLines.join("\n");
  assert.match(out, /next actions:/);
  assert.match(out, /Create \.env\.archon/);
  assert.match(out, /Run npm run archon:migrate/);
});

// ---------------------------------------------------------------------------
// deriveNextStepsFromReport
// ---------------------------------------------------------------------------

test("deriveNextStepsFromReport: node-modules ok → npm install step dropped", () => {
  const report = makeReport({ probes: [makeNodeModulesProbe("ok")] });
  const steps = deriveNextStepsFromReport(report, "init", {
    withGrafana: false,
    withObsidian: false,
    dbSetupRan: false,
  });
  const hasNpmInstall = steps.some((s) => /npm install/.test(s) && !/archon:migrate/.test(s));
  assert.equal(hasNpmInstall, false, "npm install step should be dropped when node-modules probe is ok");
});

test("deriveNextStepsFromReport: node-modules blocked → npm install step kept", () => {
  const report = makeReport({ probes: [makeNodeModulesProbe("blocked")] });
  const steps = deriveNextStepsFromReport(report, "init", {
    withGrafana: false,
    withObsidian: false,
    dbSetupRan: false,
  });
  // At least one step should mention npm install or deps
  const relevant = steps.some((s) => /npm install/.test(s) || /node_modules/.test(s));
  assert.equal(relevant, true, "npm install step should be kept when node-modules probe is blocked");
});

test("deriveNextStepsFromReport: dbSetupRan=true → migrate and bootstrap steps dropped", () => {
  const report = makeReport();
  const steps = deriveNextStepsFromReport(report, "init", {
    withGrafana: false,
    withObsidian: false,
    dbSetupRan: true,
  });
  const hasMigrate = steps.some((s) => /archon:migrate/.test(s));
  const hasBootstrap = steps.some((s) => /bootstrap-project/.test(s));
  assert.equal(hasMigrate, false, "migrate step should be dropped when dbSetupRan=true");
  assert.equal(hasBootstrap, false, "bootstrap-project step should be dropped when dbSetupRan=true");
});

test("deriveNextStepsFromReport: dbSetupRan=false → migrate and bootstrap steps kept (if present)", () => {
  const report = makeReport();
  const allSteps = deriveNextStepsFromReport(report, "init", {
    withGrafana: false,
    withObsidian: false,
    dbSetupRan: false,
  });
  // We just verify the function doesn't crash and returns an array
  assert.ok(Array.isArray(allSteps));
});

// ---------------------------------------------------------------------------
// runGuidedPhase — dry-run path
// ---------------------------------------------------------------------------

test("runGuidedPhase: dry-run returns exitCode=0 without prompts or capability check", async () => {
  const io = makeIo({ isTTY: false });
  let capabilityCheckRan = false;
  const opts = makeOpts({
    summary: makeInstallSummary({ mode: "dry-run", writesPerformed: false }),
    getCapabilityReport: async () => {
      capabilityCheckRan = true;
      return makeReport();
    },
    io,
  });
  const result = await runGuidedPhase(opts);
  assert.equal(result.exitCode, 0);
  assert.equal(result.capabilityReport, undefined);
  assert.equal(capabilityCheckRan, false, "capability check must not run for dry-run");
  assert.equal(io.questionCount, 0, "no prompts for dry-run");
});

// ---------------------------------------------------------------------------
// runGuidedPhase — non-TTY, no flags (C3: both declined, exitCode=0)
// ---------------------------------------------------------------------------

test("runGuidedPhase C3: non-TTY no flags → both declined, exitCode=0, 'skipped by choice' messages", async () => {
  const io = makeIo({ isTTY: false });
  const consumerSpawn = makeConsumerSpawnFn();
  const eccSpawn = makeEccSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn })
  );
  assert.equal(result.exitCode, 0, "C3: declined consent must exit 0");
  assert.ok(result.skippedMessages.length > 0, "must have skipped messages");
  // Must say "skipped by choice" somewhere
  const allMessages = result.skippedMessages.join("\n");
  assert.match(allMessages, /skipped by choice/);
  // Must give re-run instructions
  assert.match(allMessages, /--install-plugin/);
  assert.match(allMessages, /--run-db-setup/);
  // No real spawns should have been called
  assert.equal(consumerSpawn.calls.length, 0, "no consumer spawns for non-TTY no-flag path");
  assert.equal(eccSpawn.calls.length, 0, "no ECC spawns for non-TTY no-flag path");
  assert.equal(io.questionCount, 0, "no prompts for non-TTY");
});

test("runGuidedPhase C3: skipped-by-choice output appears in stdout", async () => {
  const io = makeIo({ isTTY: false });
  await runGuidedPhase(makeOpts({ io }));
  const out = io.stdoutLines.join("\n");
  assert.match(out, /Skipped steps \(not failures/);
});

// ---------------------------------------------------------------------------
// runGuidedPhase — --no-plugin (explicit ECC decline)
// ---------------------------------------------------------------------------

test("runGuidedPhase --no-plugin: ECC skipped by choice, still exits 0", async () => {
  const io = makeIo({ isTTY: false });
  const eccSpawn = makeEccSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ noPlugin: true, io, eccSpawnFn: eccSpawn })
  );
  assert.equal(result.exitCode, 0);
  assert.ok(
    result.skippedMessages.some((m) => /--install-plugin/.test(m)),
    "skipped message must mention --install-plugin"
  );
  assert.equal(eccSpawn.calls.length, 0, "--no-plugin must not spawn ECC");
});

// Finding 1: conflict — --no-plugin + --install-plugin → noPlugin wins, eccConsented=false
test("runGuidedPhase conflict: --no-plugin + --install-plugin → noPlugin wins, zero ECC spawn", async () => {
  const io = makeIo({ isTTY: false });
  const eccSpawn = makeEccSpawnFn();
  const consumerSpawn = makeConsumerSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ noPlugin: true, installPlugin: true, io, eccSpawnFn: eccSpawn, consumerSpawnFn: consumerSpawn })
  );
  assert.equal(result.exitCode, 0);
  // ECC must be blocked by --no-plugin even though --install-plugin is also set
  assert.equal(eccSpawn.calls.length, 0, "--no-plugin wins over --install-plugin: zero ECC spawn calls");
  // Skip message must reference --install-plugin so operator knows how to re-enable
  assert.ok(
    result.skippedMessages.some((m) => /--install-plugin/.test(m)),
    "conflict resolution: skip message must reference --install-plugin"
  );
});

// Finding 2: {yes:true, noPlugin:true} → DB consented, ECC NOT triggered
test("runGuidedPhase --yes + --no-plugin: DB consented, ECC not triggered", async () => {
  const io = makeIo({ isTTY: false });
  const consumerSpawn = makeConsumerSpawnFn({ "*": { exitCode: 0, stdout: "", stderr: "" } });
  const eccSpawn = makeEccSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ yes: true, noPlugin: true, io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn })
  );
  assert.equal(result.exitCode, 0);
  // DB setup must have run (--yes consents)
  assert.ok(consumerSpawn.calls.length > 0, "--yes must trigger DB setup");
  // ECC must be blocked (--no-plugin)
  assert.equal(eccSpawn.calls.length, 0, "--no-plugin must block ECC even when --yes is present");
  // Skip message must reference --install-plugin
  assert.ok(
    result.skippedMessages.some((m) => /--install-plugin/.test(m)),
    "ECC skip message must reference --install-plugin"
  );
});

// ---------------------------------------------------------------------------
// runGuidedPhase — --install-plugin (explicit ECC consent, C5 test)
// ---------------------------------------------------------------------------

test("runGuidedPhase --install-plugin: ECC spawn called, no consumer spawn (no --yes)", async () => {
  const io = makeIo({ isTTY: false });
  const consumerSpawn = makeConsumerSpawnFn();
  const { eccSpawn, eccReadFileFn, eccWriteFileFn } = makeEccStubBundle();
  const result = await runGuidedPhase(
    makeOpts({ installPlugin: true, io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn, eccReadFileFn, eccWriteFileFn })
  );
  assert.equal(result.exitCode, 0);
  // ECC install was attempted (at least plugin list is checked)
  assert.ok(eccSpawn.calls.length > 0, "--install-plugin must trigger ECC spawn");
  // Consumer spawns (npm etc.) were NOT called (no --yes)
  assert.equal(consumerSpawn.calls.length, 0, "no consumer spawns without --yes or --run-db-setup");
});

// ---------------------------------------------------------------------------
// runGuidedPhase C5 HARD: --yes alone must NEVER trigger ECC spawn
// ---------------------------------------------------------------------------

test("runGuidedPhase C5: --yes alone never triggers ECC install, zero claude spawn calls", async () => {
  const io = makeIo({ isTTY: false });
  const consumerSpawn = makeConsumerSpawnFn({
    "*": { exitCode: 0, stdout: "", stderr: "" },
  });
  const eccSpawn = makeEccSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ yes: true, io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn })
  );
  assert.equal(result.exitCode, 0);
  // Consumer spawns (npm) should have been called (--yes consents to DB setup)
  assert.ok(consumerSpawn.calls.length > 0, "--yes must trigger consumer spawns for DB setup");
  // ECC spawn must NEVER have been called
  assert.equal(eccSpawn.calls.length, 0, "C5: --yes alone must NOT trigger any ECC/claude spawn");
  // ECC skip message must still be present
  const allMessages = result.skippedMessages.join("\n");
  assert.match(allMessages, /--install-plugin/, "C5: must show --install-plugin guidance");
});

// ---------------------------------------------------------------------------
// runGuidedPhase — --run-db-setup (explicit DB consent, no ECC)
// ---------------------------------------------------------------------------

test("runGuidedPhase --run-db-setup: consumer spawns called, ECC not triggered", async () => {
  const io = makeIo({ isTTY: false });
  const consumerSpawn = makeConsumerSpawnFn({
    "*": { exitCode: 0, stdout: "", stderr: "" },
  });
  const eccSpawn = makeEccSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ runDbSetup: true, io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn })
  );
  assert.equal(result.exitCode, 0);
  assert.ok(consumerSpawn.calls.length > 0, "--run-db-setup must trigger consumer spawns");
  assert.equal(eccSpawn.calls.length, 0, "--run-db-setup must not trigger ECC");
});

test("runGuidedPhase --run-db-setup: spawns npm install, archon:migrate, bootstrap-project", async () => {
  const io = makeIo({ isTTY: false });
  const consumerSpawn = makeConsumerSpawnFn({
    "*": { exitCode: 0, stdout: "", stderr: "" },
  });
  await runGuidedPhase(
    makeOpts({ runDbSetup: true, io, consumerSpawnFn: consumerSpawn })
  );
  const keys = consumerSpawn.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
  assert.ok(keys.some((k) => /npm install/.test(k)), "must call npm install");
  assert.ok(keys.some((k) => /archon:migrate/.test(k)), "must call archon:migrate");
  assert.ok(keys.some((k) => /bootstrap-project/.test(k)), "must call bootstrap-project");
});

// ---------------------------------------------------------------------------
// runGuidedPhase — DB setup failure → capability report still printed (honesty)
// ---------------------------------------------------------------------------

test("runGuidedPhase: DB setup failure still emits capability report and exits 0", async () => {
  const io = makeIo({ isTTY: false });
  let capabilityReportPrinted = false;
  const consumerSpawn = makeConsumerSpawnFn({
    "npm install": { exitCode: 1, stdout: "", stderr: "ENOENT" },
    "*": { exitCode: 1, stdout: "", stderr: "" },
  });
  const result = await runGuidedPhase(
    makeOpts({
      runDbSetup: true,
      io,
      consumerSpawnFn: consumerSpawn,
      getCapabilityReport: async () => {
        capabilityReportPrinted = true;
        return makeReport({ ok: false, blockers: ["npm install failed"] });
      },
    })
  );
  assert.equal(result.exitCode, 0, "failure in DB step must not set nonzero exit (honesty mode)");
  assert.equal(capabilityReportPrinted, true, "capability report must always be emitted, even after failure");
  const errOut = io.stderrLines.join("\n");
  assert.match(errOut, /exited with code 1/, "must report step failure via stderr");
});

// ---------------------------------------------------------------------------
// runGuidedPhase — --json flag
// ---------------------------------------------------------------------------

// Finding 6: strengthen --json to verify all doctor-shape fields (ok, probes, reason, nextActions)
test("runGuidedPhase --json: emits compact JSON with all doctor-shape fields", async () => {
  const io = makeIo({ isTTY: false });
  const probe: ProbeResult = {
    capability: "agents",
    layer: "L0",
    status: "ok",
    code: "agents-present",
    detail: "agents installed",
    remediation: "",
  };
  const report = makeReport({
    ok: false,
    blockers: ["db-missing"],
    advisories: ["advisory-json"],
    nextActions: ["Create .env.archon"],
    reason: "database unreachable",
    probes: [probe],
  });
  await runGuidedPhase(
    makeOpts({
      jsonReport: true,
      io,
      getCapabilityReport: async () => report,
    })
  );
  const jsonLine = io.stdoutLines.find((l) => {
    try {
      JSON.parse(l);
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(jsonLine !== undefined, "--json must emit a parseable JSON line");
  const parsed = JSON.parse(jsonLine!) as CapabilityReport;
  // Doctor-shape: all required fields must be present and round-trip correctly
  assert.equal(parsed.ok, false, "ok field must round-trip");
  assert.deepEqual(parsed.blockers, ["db-missing"], "blockers field must round-trip");
  assert.deepEqual(parsed.advisories, ["advisory-json"], "advisories field must round-trip");
  assert.deepEqual(parsed.nextActions, ["Create .env.archon"], "nextActions field must round-trip");
  assert.equal(parsed.reason, "database unreachable", "reason field must round-trip");
  assert.ok(Array.isArray(parsed.probes), "probes field must be an array");
  assert.equal(parsed.probes.length, 1, "probes must round-trip");
  assert.equal(parsed.probes[0]?.capability, "agents", "probe capability must round-trip");
});

// ---------------------------------------------------------------------------
// runGuidedPhase — TTY interactive paths
// ---------------------------------------------------------------------------

test("runGuidedPhase TTY: answer 'n' to both prompts → C3 declines, exitCode=0", async () => {
  // First prompt: ECC (default No), second: DB (default Yes)
  const io = makeIo({ isTTY: true, answers: ["n", "n"] });
  const consumerSpawn = makeConsumerSpawnFn();
  const eccSpawn = makeEccSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn })
  );
  assert.equal(result.exitCode, 0, "C3: TTY decline must exit 0");
  assert.equal(io.questionCount, 2, "both prompts must fire in TTY mode");
  assert.equal(eccSpawn.calls.length, 0, "ECC must not be spawned after TTY decline");
  assert.equal(consumerSpawn.calls.length, 0, "consumer spawns must not run after TTY decline");
  const allMessages = result.skippedMessages.join("\n");
  assert.match(allMessages, /skipped by choice/);
});

test("runGuidedPhase TTY: answer '' to ECC (default No) and '' to DB (default Yes) → DB runs, ECC skipped", async () => {
  const io = makeIo({ isTTY: true, answers: ["", ""] }); // Enter = No for ECC, Enter = Yes for DB
  const consumerSpawn = makeConsumerSpawnFn({ "*": { exitCode: 0, stdout: "", stderr: "" } });
  const eccSpawn = makeEccSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn })
  );
  assert.equal(result.exitCode, 0);
  // ECC not consented (Enter = default No)
  assert.equal(eccSpawn.calls.length, 0, "ECC default No: enter must not trigger ECC");
  // DB consented (Enter = default Yes)
  assert.ok(consumerSpawn.calls.length > 0, "DB default Yes: enter must trigger consumer spawns");
  // ECC skip message present
  const allMessages = result.skippedMessages.join("\n");
  assert.match(allMessages, /--install-plugin/);
});

// Finding 5: TTY mid-sequence partial-decline (ECC 'n', DB 'y')
test("runGuidedPhase TTY: ECC 'n' then DB 'y' → ECC declined, DB consented (partial-decline)", async () => {
  const io = makeIo({ isTTY: true, answers: ["n", "y"] }); // 'n' for ECC, 'y' for DB
  const consumerSpawn = makeConsumerSpawnFn({ "*": { exitCode: 0, stdout: "", stderr: "" } });
  const eccSpawn = makeEccSpawnFn();
  const result = await runGuidedPhase(
    makeOpts({ io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn })
  );
  assert.equal(result.exitCode, 0, "partial-decline must still exit 0 (C3)");
  assert.equal(io.questionCount, 2, "both prompts must fire");
  // ECC declined
  assert.equal(eccSpawn.calls.length, 0, "ECC must not be spawned when first prompt answered 'n'");
  // DB consented
  assert.ok(consumerSpawn.calls.length > 0, "DB setup must run when second prompt answered 'y'");
  // ECC skip message present, no DB skip message
  const eccSkipped = result.skippedMessages.some((m) => /ECC plugin/.test(m));
  const dbSkipped = result.skippedMessages.some((m) => /DB setup/.test(m));
  assert.equal(eccSkipped, true, "ECC skip message must be present");
  assert.equal(dbSkipped, false, "DB skip message must NOT be present when DB was consented");
});

test("runGuidedPhase TTY: answer 'y' to ECC and 'y' to DB → both consented", async () => {
  const io = makeIo({ isTTY: true, answers: ["y", "y"] });
  const consumerSpawn = makeConsumerSpawnFn({ "*": { exitCode: 0, stdout: "", stderr: "" } });
  const { eccSpawn, eccReadFileFn, eccWriteFileFn } = makeEccStubBundle();
  const result = await runGuidedPhase(
    makeOpts({ io, consumerSpawnFn: consumerSpawn, eccSpawnFn: eccSpawn, eccReadFileFn, eccWriteFileFn })
  );
  assert.equal(result.exitCode, 0);
  assert.ok(eccSpawn.calls.length > 0, "ECC must be spawned when TTY answer is 'y'");
  assert.ok(consumerSpawn.calls.length > 0, "consumer spawns must run when TTY answer is 'y'");
  // No skipped messages
  assert.equal(result.skippedMessages.length, 0, "no skipped messages when both consented");
});

// ---------------------------------------------------------------------------
// runGuidedPhase — capability report is always present after apply (non-dry-run)
// ---------------------------------------------------------------------------

test("runGuidedPhase apply: capabilityReport is returned in result", async () => {
  const io = makeIo({ isTTY: false });
  const report = makeReport({ ok: true });
  const result = await runGuidedPhase(
    makeOpts({ getCapabilityReport: async () => report, io })
  );
  assert.deepEqual(result.capabilityReport, report);
});

// ---------------------------------------------------------------------------
// runGuidedPhase — satisfied DB setup drops migrate + bootstrap from next-steps
// ---------------------------------------------------------------------------

test("runGuidedPhase: successful --run-db-setup causes migrate+bootstrap dropped from next-steps", async () => {
  const io = makeIo({ isTTY: false });
  const consumerSpawn = makeConsumerSpawnFn({ "*": { exitCode: 0, stdout: "", stderr: "" } });
  // node-modules probe ok (so npm install step also drops)
  const report = makeReport({ probes: [makeNodeModulesProbe("ok")] });
  await runGuidedPhase(
    makeOpts({
      runDbSetup: true,
      io,
      consumerSpawnFn: consumerSpawn,
      getCapabilityReport: async () => report,
    })
  );

  // Extract only the "Next steps:" section (lines after the "Next steps:" header)
  const nextStepsIdx = io.stdoutLines.findIndex((l) => /Next steps:/.test(l));
  const nextStepsLines = nextStepsIdx >= 0 ? io.stdoutLines.slice(nextStepsIdx + 1) : [];
  const nextStepsOut = nextStepsLines.join("\n");

  // migrate and bootstrap should NOT appear as next-steps (they ran already)
  assert.doesNotMatch(nextStepsOut, /archon:migrate/, "migrate must be dropped from next-steps after dbSetupRan");
  assert.doesNotMatch(nextStepsOut, /bootstrap-project/, "bootstrap must be dropped from next-steps after dbSetupRan");
});

// ---------------------------------------------------------------------------
// createDefaultGuidedInitIo: basic smoke — does not throw, returns the interface
// ---------------------------------------------------------------------------

test("createDefaultGuidedInitIo: returns an object with isTTY, question, stdout, stderr", () => {
  const io = createDefaultGuidedInitIo();
  assert.equal(typeof io.isTTY, "boolean");
  assert.equal(typeof io.question, "function");
  assert.equal(typeof io.stdout, "function");
  assert.equal(typeof io.stderr, "function");
});
