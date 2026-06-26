// Phase 4 (ahrP4InteractiveWatcher): integration test for
// scripts/archon-interactive-supervisor.sh
//
// RED phase — these must fail before the script is created.
//
// Contract:
//   - With a valid fresh resume-request and NO pre-existing daemon lease:
//     exactly 1 claude relaunch, then clean exit.
//   - With a daemon-owned lease pre-set: 0 relaunches (watcher no-ops).
//   - Script is shellcheck-clean (tested by shellcheck child process).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "..",
  "scripts",
  "archon-interactive-supervisor.sh"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((fs) => fs.stat(p));
    return true;
  } catch {
    return false;
  }
}

function runScript(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 5000
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `archon-p4-sup-${Date.now()}`);
  await mkdir(path.join(tmpDir, ".archon", "work", "daemon"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// shellcheck test — MUST be first so script existence is confirmed early
// ---------------------------------------------------------------------------

describe("scripts/archon-interactive-supervisor.sh", () => {
  it("passes shellcheck (no issues)", async () => {
    // If the script doesn't exist, shellcheck will fail with exit 1 → test fails (RED).
    const result = await runScript(["--help"], {}, 3000).catch(() => ({
      exitCode: 127,
      stdout: "",
      stderr: "bash: cannot find script"
    }));

    // First check shellcheck separately.
    const scResult = await new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
      const sc = spawn("shellcheck", [SCRIPT_PATH], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      sc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      sc.on("close", (code) => resolve({ exitCode: code, stderr }));
      sc.on("error", () => resolve({ exitCode: null, stderr: "shellcheck not found" }));
    });

    if (scResult.exitCode === null) {
      // shellcheck not installed — skip but don't fail the suite
      return;
    }

    assert.equal(
      scResult.exitCode,
      0,
      `shellcheck found issues:\n${scResult.stderr}`
    );
    void result; // suppress unused var lint
  });

  // -----------------------------------------------------------------------
  // Exactly-one-relaunch test
  // -----------------------------------------------------------------------

  it("relaunches claude exactly once when a valid resume-request exists and no daemon lease", async () => {
    // Write a valid resume-request
    const promptPath = ".archon/work/daemon/continuation-context.txt";
    await writeFile(
      path.join(tmpDir, ".archon", "work", "daemon", "continuation-context.txt"),
      "continuation prompt content",
      "utf8"
    );
    const request = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-supervisor-test",
      taskId: "task-supervisor-test",
      promptPath,
      createdAt: new Date().toISOString()
    };
    const requestPath = path.join(tmpDir, ".archon", "work", "daemon", "interactive-resume-request.json");
    await writeFile(requestPath, JSON.stringify(request), "utf8");

    // Write a stub "claude" that just exits 0 and records it was called
    const claudeCallLog = path.join(tmpDir, "claude-calls.log");
    const stubClaude = path.join(tmpDir, "claude");
    await writeFile(
      stubClaude,
      `#!/bin/bash\necho "claude called: $*" >> ${claudeCallLog}\nexit 0\n`,
      { mode: 0o755 }
    );

    // Run the supervisor with the stub claude
    const result = await runScript([], {
      ARCHON_CWD: tmpDir,
      ARCHON_CLAUDE_BIN: stubClaude,
      ARCHON_SUPERVISOR_MAX_RESPAWNS: "1",
      ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS: "300"
    }, 8000);

    // Should have exited cleanly (0 or 1 — not hung)
    assert.ok(
      result.exitCode === 0 || result.exitCode === 1,
      `unexpected exit code ${result.exitCode}: ${result.stderr}`
    );

    // Claude must have been called exactly once
    let callLog = "";
    try {
      callLog = await readFile(claudeCallLog, "utf8");
    } catch {
      callLog = "";
    }
    const callLines = callLog.trim().split("\n").filter(Boolean);
    assert.equal(callLines.length, 1, `expected 1 claude call, got ${callLines.length}: ${callLog}`);

    // The call must not contain --resume (fresh_run only).
    assert.ok(
      !callLines[0]!.includes("--resume"),
      `claude call must not use --resume: ${callLines[0]}`
    );

    // Non-blocking 7: the call must include -- to prevent prompt "--" being parsed as flags.
    assert.ok(
      callLines[0]!.includes(" -- "),
      `claude call must include -- separator (non-blocking 7): ${callLines[0]}`
    );
  });

  // -----------------------------------------------------------------------
  // Zero-relaunch test (daemon lease pre-set)
  // -----------------------------------------------------------------------

  it("does NOT relaunch when daemon-owned lease is set (respawnOwner=daemon)", async () => {
    // Write a resume-request
    const promptPath = ".archon/work/daemon/continuation-context.txt";
    await writeFile(
      path.join(tmpDir, ".archon", "work", "daemon", "continuation-context.txt"),
      "continuation prompt content",
      "utf8"
    );
    const request = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-daemon-owns",
      taskId: "task-daemon-owns",
      promptPath,
      createdAt: new Date().toISOString()
    };
    await writeFile(
      path.join(tmpDir, ".archon", "work", "daemon", "interactive-resume-request.json"),
      JSON.stringify(request),
      "utf8"
    );

    // Write a pre-existing daemon lease in the UNIFIED file-lock path
    // (matches makeFileLockLeaseStore path: respawn-lease-<sanitizedRunId>.lock).
    // BLOCKING-2: both Node and bash now contend on this same file.
    const leaseFile = path.join(tmpDir, ".archon", "work", "daemon", "respawn-lease-run-daemon-owns.lock");
    await writeFile(leaseFile, JSON.stringify({
      runId: "run-daemon-owns",
      owner: "daemon",
      claimedAt: new Date().toISOString()
    }) + "\n", "utf8");

    const claudeCallLog = path.join(tmpDir, "claude-calls.log");
    const stubClaude = path.join(tmpDir, "claude");
    await writeFile(
      stubClaude,
      `#!/bin/bash\necho "claude called" >> ${claudeCallLog}\nexit 0\n`,
      { mode: 0o755 }
    );

    const result = await runScript([], {
      ARCHON_CWD: tmpDir,
      ARCHON_CLAUDE_BIN: stubClaude,
      ARCHON_SUPERVISOR_MAX_RESPAWNS: "1",
      ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS: "300"
    }, 8000);

    assert.ok(
      result.exitCode !== null,
      `script must exit (not hang): ${result.stderr}`
    );

    // Claude must NOT have been called
    const claudeWasCalled = await fileExists(claudeCallLog);
    assert.equal(claudeWasCalled, false, "claude must not be called when daemon owns the lease");
  });

  // -----------------------------------------------------------------------
  // TOCTOU test (BLOCKING-5): two concurrent supervisors race one request
  // → exactly one consumes it (the other exits cleanly with 0 calls).
  // -----------------------------------------------------------------------

  it("TOCTOU: exactly 1 of 2 concurrent supervisors consumes the resume-request (BLOCKING-5)", async () => {
    const promptPath = ".archon/work/daemon/continuation-context.txt";
    await writeFile(
      path.join(tmpDir, ".archon", "work", "daemon", "continuation-context.txt"),
      "toctou test prompt",
      "utf8"
    );
    const request = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-toctou-test",
      taskId: "task-toctou-test",
      promptPath,
      createdAt: new Date().toISOString()
    };
    await writeFile(
      path.join(tmpDir, ".archon", "work", "daemon", "interactive-resume-request.json"),
      JSON.stringify(request),
      "utf8"
    );

    const claudeCallLog = path.join(tmpDir, "claude-calls-toctou.log");
    const stubClaude = path.join(tmpDir, "claude-toctou");
    await writeFile(
      stubClaude,
      `#!/bin/bash\necho "called" >> ${claudeCallLog}\nexit 0\n`,
      { mode: 0o755 }
    );

    const env = {
      ARCHON_CWD: tmpDir,
      ARCHON_CLAUDE_BIN: stubClaude,
      ARCHON_SUPERVISOR_MAX_RESPAWNS: "1",
      ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS: "300"
    };

    // Run both supervisors concurrently (race condition).
    const [r1, r2] = await Promise.all([
      runScript([], env, 10_000),
      runScript([], env, 10_000)
    ]);

    // Both must exit (not hang).
    assert.ok(r1.exitCode !== null, `supervisor 1 must exit: ${r1.stderr}`);
    assert.ok(r2.exitCode !== null, `supervisor 2 must exit: ${r2.stderr}`);

    // Exactly 1 claude call across both supervisors.
    let callLog = "";
    try { callLog = await readFile(claudeCallLog, "utf8"); } catch { callLog = ""; }
    const callLines = callLog.trim().split("\n").filter(Boolean);
    assert.equal(
      callLines.length,
      1,
      `exactly 1 claude call expected across concurrent supervisors, got ${callLines.length}: ${callLog}`
    );
  });

  // -----------------------------------------------------------------------
  // Python injection test (BLOCKING-1): malicious createdAt value must not
  // execute any code — the iso_age_seconds helper passes the value via
  // sys.argv[1], not string-interpolated into -c "...".
  // -----------------------------------------------------------------------

  it("Python injection: malicious createdAt value causes no side effects (BLOCKING-1)", async () => {
    const injectionMarker = path.join(tmpDir, "pwn-marker.txt");
    // Craft a createdAt that would execute code if interpolated into python3 -c "...${created_at}...".
    // With the ARGV-based fix, this is parsed as a literal ISO string (and will produce an
    // age parse failure → returns 999999 → request is "stale" → archived, not executed).
    const maliciousCreatedAt = `'); import os; os.system("touch ${injectionMarker}"); x='`;

    const request = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-inject-test",
      taskId: "task-inject-test",
      promptPath: ".archon/work/daemon/continuation-context.txt",
      createdAt: maliciousCreatedAt
    };
    await writeFile(
      path.join(tmpDir, ".archon", "work", "daemon", "continuation-context.txt"),
      "prompt",
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, ".archon", "work", "daemon", "interactive-resume-request.json"),
      JSON.stringify(request),
      "utf8"
    );

    const stubClaude = path.join(tmpDir, "claude-inject");
    await writeFile(stubClaude, `#!/bin/bash\nexit 0\n`, { mode: 0o755 });

    await runScript([], {
      ARCHON_CWD: tmpDir,
      ARCHON_CLAUDE_BIN: stubClaude,
      ARCHON_SUPERVISOR_MAX_RESPAWNS: "1",
      ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS: "300"
    }, 5000);

    // The injection marker must NOT exist — no code execution occurred.
    const injected = await fileExists(injectionMarker);
    assert.equal(injected, false, "Python injection via createdAt must be prevented (BLOCKING-1)");
  });
});
