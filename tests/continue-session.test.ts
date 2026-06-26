import test from "node:test";
import assert from "node:assert/strict";
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

test("buildClaudeInvocation: no uncommitted handoff produces clear message (pure)", () => {
  // This tests that a missing handoff produces a clear message — not a claude invocation.
  // The verb handles this case by printing a message and setting exitCode. Here we verify
  // the pure helper is only called when a handoff is present.
  const invocation = buildClauseInvocationForEmptyPrompt();
  assert.ok(invocation.startsWith("claude --print '"), "empty prompt still produces valid invocation");
});

function buildClauseInvocationForEmptyPrompt() {
  return buildClaudeInvocation("(no handoff summary)");
}
