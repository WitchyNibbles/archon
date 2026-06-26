import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import { parseActiveFile, buildClaudeInvocation } from "../src/admin/continue-session.ts";

// ─── parseActiveFile ─────────────────────────────────────────────────────────

test("parseActiveFile: extracts task_id and run_id", () => {
  const content = "workflow=archon\ntask_id=my-task\nrun_id=run-123\nstate=active\n";
  const result = parseActiveFile(content);
  assert.equal(result.taskId, "my-task");
  assert.equal(result.runId, "run-123");
});

test("parseActiveFile: returns undefined for missing fields", () => {
  const result = parseActiveFile("workflow=archon\nstate=active\n");
  assert.equal(result.taskId, undefined);
  assert.equal(result.runId, undefined);
});

test("parseActiveFile: handles CRLF line endings", () => {
  const content = "task_id=my-task\r\nrun_id=run-456\r\n";
  const result = parseActiveFile(content);
  assert.equal(result.taskId, "my-task");
  assert.equal(result.runId, "run-456");
});

test("parseActiveFile: returns only task_id when run_id absent", () => {
  const result = parseActiveFile("task_id=ahrP4InteractiveWatcher\nstate=active\n");
  assert.equal(result.taskId, "ahrP4InteractiveWatcher");
  assert.equal(result.runId, undefined);
});

test("parseActiveFile: ignores empty lines and comments", () => {
  const content = "\n# comment\ntask_id=t1\n\n";
  const result = parseActiveFile(content);
  assert.equal(result.taskId, "t1");
});

// ─── buildClaudeInvocation ───────────────────────────────────────────────────

test("buildClaudeInvocation: wraps prompt in claude --print call", () => {
  const invocation = buildClaudeInvocation("Continue from here.");
  assert.equal(invocation, "claude --print 'Continue from here.'");
});

test("buildClaudeInvocation: escapes single quotes in prompt", () => {
  const invocation = buildClaudeInvocation("It's a test.");
  // Single-quote escaping: ' becomes '\''
  assert.equal(invocation, "claude --print 'It'\\''s a test.'");
});

test("buildClaudeInvocation: handles multiline prompt", () => {
  const prompt = "Line 1\nLine 2";
  const invocation = buildClaudeInvocation(prompt);
  assert.ok(invocation.startsWith("claude --print '"), "must start with claude --print");
  assert.ok(invocation.includes("Line 1"), "must include prompt content");
  assert.ok(invocation.includes("Line 2"), "must include prompt content");
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("continueSessionCommand: no active task → prints clear message and exits 1", () => {
  // Exercise the no-handoff branch of continueSessionCommand. When no .archon/ACTIVE
  // exists and no --task-id flag is provided, the command must print a clear "nothing to
  // continue" message and exit with code 1, without touching the DB.
  // Run in a fresh temp dir so there is no .archon/ACTIVE to pick up.
  const tmpDir = fs.mkdtempSync(os.tmpdir() + "/archon-cs-test-");
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", path.join(repoRoot, "src/admin.ts"), "continue-session"],
      { cwd: tmpDir, encoding: "utf8", timeout: 10_000 }
    );
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.ok(
      output.includes("no active task"),
      `expected "no active task" in output; got: ${output}`
    );
    assert.ok(
      output.includes("archon_handoff_commit"),
      `expected "archon_handoff_commit" in output; got: ${output}`
    );
    assert.equal(result.status, 1, "exit code must be 1 when no task is found");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
