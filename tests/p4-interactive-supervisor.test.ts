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

    // The call must not contain --resume (fresh_run only)
    assert.ok(
      !callLines[0]!.includes("--resume"),
      `claude call must not use --resume: ${callLines[0]}`
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

    // Write a pre-existing daemon lease file to simulate daemon owning the run
    const leaseFile = path.join(tmpDir, ".archon", "work", "daemon", "respawn-lease.json");
    await writeFile(leaseFile, JSON.stringify({
      runId: "run-daemon-owns",
      owner: "daemon",
      claimedAt: new Date().toISOString()
    }), "utf8");

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
});
