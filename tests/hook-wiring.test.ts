/**
 * Integration tests for real hook wiring.
 *
 * Each test spawns the actual .claude/hooks/*.mjs entry script via spawnSync,
 * passes a JSON payload on stdin (with cwd: fixtureDir), and asserts on stdout.
 * Fixtures are isolated temp dirs — no .env, so no postgres attempt is made.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = path.join(repoRoot, ".claude", "hooks");

function hookPath(name: string): string {
  return path.join(hooksDir, name);
}

/** Spawn a hook script with the given payload on stdin, return parsed stdout or null. */
function runHook(
  hookName: string,
  payload: Record<string, unknown>
): { status: number | null; stdout: string; stderr: string; parsed: Record<string, unknown> | null } {
  const result = spawnSync(process.execPath, [hookPath(hookName)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000
  });
  let parsed: Record<string, unknown> | null = null;
  if (result.stdout && result.stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    } catch {
      // leave null — test can check stdout directly
    }
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", parsed };
}

/** Create a temp fixture dir, write optional files, return the dir path. */
function makeFixture(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-hook-wiring-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

/** Build a minimal task packet with a write scope. */
function taskPacket(opts: {
  taskId: string;
  writeScope?: string[];
  requiredReviews?: string[];
  verificationRequired?: string;
  taskClass?: string;
  councilOutcome?: string;
  continuationIntent?: string;
}): string {
  const lines: string[] = [`# Task Packet — ${opts.taskId}`, ""];
  lines.push("## Task ID", "", `\`${opts.taskId}\``, "");
  if (opts.taskClass) {
    lines.push("## Task class", "", opts.taskClass, "");
  }
  if (opts.councilOutcome) {
    lines.push("## Council review", "", "### Outcome", "", `\`${opts.councilOutcome}\``, "");
  }
  if (opts.continuationIntent) {
    lines.push("## Continuation intent", "", opts.continuationIntent, "");
  }
  if (opts.writeScope && opts.writeScope.length > 0) {
    lines.push("## Allowed write scope", "");
    for (const s of opts.writeScope) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }
  if (opts.requiredReviews !== undefined) {
    lines.push("## Required reviews", "");
    if (opts.requiredReviews.length === 0) {
      lines.push("- none");
    } else {
      for (const r of opts.requiredReviews) {
        lines.push(`- ${r}`);
      }
    }
    lines.push("");
  }
  if (opts.verificationRequired !== undefined) {
    lines.push("## Verification required", "", opts.verificationRequired, "");
  }
  return lines.join("\n");
}

// ─── Case 1: no active task, Write to src/x.ts → blocked ────────────────────

test("hook-wiring: pre-tool, no active task, Write to src/x.ts → blocked with no active archon task reason", () => {
  const fixture = makeFixture();
  try {
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: path.join(fixture, "src", "x.ts") },
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-pre-tool.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    assert.ok(parsed !== null, "stdout should be non-empty JSON");
    assert.strictEqual(parsed!.decision, "block", `expected decision=block, got: ${JSON.stringify(parsed)}`);
    assert.ok(
      typeof parsed!.reason === "string" && /no active archon task/i.test(parsed!.reason as string),
      `reason should mention 'no active archon task', got: ${parsed!.reason}`
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ─── Case 2: no active task, Write to .archon/work/tasks/task-foo.md → allowed ─

test("hook-wiring: pre-tool, no active task, Write to .archon/work/tasks/task-foo.md → not blocked", () => {
  const fixture = makeFixture();
  try {
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: path.join(fixture, ".archon", "work", "tasks", "task-foo.md") },
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-pre-tool.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    // No block: either empty stdout (no decision) or decision !== "block"
    const isBlocked = parsed !== null && parsed.decision === "block";
    assert.ok(!isBlocked, `task-packet write should not be blocked, got: ${JSON.stringify(parsed)}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ─── Case 3a: active task with src scope, Write to src/ok.ts → allowed ────────

test("hook-wiring: pre-tool, active task with src scope, Write to src/ok.ts → allowed", () => {
  const taskId = "t1";
  const fixture = makeFixture({
    ".archon/ACTIVE": `task_id=${taskId}\nstate=active\n`,
    [`.archon/work/tasks/task-${taskId}.md`]: taskPacket({ taskId, writeScope: ["src"] })
  });
  try {
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: path.join(fixture, "src", "ok.ts") },
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-pre-tool.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    const isBlocked = parsed !== null && parsed.decision === "block";
    assert.ok(!isBlocked, `write within scope should be allowed, got: ${JSON.stringify(parsed)}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ─── Case 3b: active task with src scope, Write to docs/out.md → blocked ──────

test("hook-wiring: pre-tool, active task with src scope, Write to docs/out.md → blocked (out of scope)", () => {
  const taskId = "t1";
  const fixture = makeFixture({
    ".archon/ACTIVE": `task_id=${taskId}\nstate=active\n`,
    [`.archon/work/tasks/task-${taskId}.md`]: taskPacket({ taskId, writeScope: ["src"] })
  });
  try {
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: path.join(fixture, "docs", "out.md") },
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-pre-tool.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    assert.ok(parsed !== null, "stdout should be non-empty JSON");
    assert.strictEqual(parsed!.decision, "block", `expected block for out-of-scope path, got: ${JSON.stringify(parsed)}`);
    assert.ok(
      typeof parsed!.reason === "string" && /outside|scope/i.test(parsed!.reason as string),
      `reason should mention scope, got: ${parsed!.reason}`
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ─── Case 4: Bash grep on managed path with empty scope → allowed (read-only) ─

test("hook-wiring: pre-tool, Bash grep on managed path → allowed (read-only, no block)", () => {
  const fixture = makeFixture();
  try {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "grep -n x .claude/hooks/hook-utils.mjs" },
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-pre-tool.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    const isBlocked = parsed !== null && parsed.decision === "block";
    assert.ok(!isBlocked, `read-only grep should not be blocked, got: ${JSON.stringify(parsed)}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ─── Case 5: Bash rm -rf / → blocked (destructive) ───────────────────────────

test("hook-wiring: pre-tool, Bash rm -rf / → blocked (destructive command)", () => {
  const fixture = makeFixture();
  try {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-pre-tool.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    assert.ok(parsed !== null, "stdout should be non-empty JSON");
    assert.strictEqual(parsed!.decision, "block", `expected block for destructive command, got: ${JSON.stringify(parsed)}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ─── Case 6: stop hook, active task, completion message, missing reviews → blocked ─

test("hook-wiring: stop, active task with reviews required and none present → continue: false naming missing reviews", () => {
  const taskId = "stop-t1";
  // docs_only task class + verification required: false to skip cert gate
  // council outcome approved to skip council gate
  // required reviews: reviewer, qa_engineer (so missingReviews will be non-empty)
  const fixture = makeFixture({
    ".archon/ACTIVE": `task_id=${taskId}\nstate=active\n`,
    [`.archon/work/tasks/task-${taskId}.md`]: taskPacket({
      taskId,
      taskClass: "docs_only",
      verificationRequired: "false",
      councilOutcome: "approved",
      requiredReviews: ["reviewer", "qa_engineer"]
    })
  });
  try {
    // Use a completion message that makes shouldHoldStop return false.
    // "scoped task is complete" matches completionMessagePatterns;
    // "external workflow closure" matches externalClosureCausePatterns.
    // Together they make shouldHoldStop return false (taskShouldHold = false),
    // so the reviews gate fires.
    const lastAssistantMessage =
      "The scoped task is complete. This is an external workflow closure.";
    const payload = {
      last_assistant_message: lastAssistantMessage,
      stop_hook_active: false,
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-stop.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    assert.ok(parsed !== null, "stdout should be non-empty JSON");
    assert.strictEqual(parsed!.continue, false, `expected continue: false, got: ${JSON.stringify(parsed)}`);
    assert.ok(
      typeof parsed!.stopReason === "string" &&
        /review/i.test(parsed!.stopReason as string),
      `stopReason should mention reviews, got: ${parsed!.stopReason}`
    );
    // Should name at least one missing review file
    assert.ok(
      (parsed!.stopReason as string).includes("reviewer") ||
        (parsed!.stopReason as string).includes(".archon/work/reviews/"),
      `stopReason should name missing review file, got: ${parsed!.stopReason}`
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ─── Case 7: session-start with no state → empty stdout, exit 0 ───────────────

test("hook-wiring: session-start with no .archon state → empty stdout, exit 0 (no crash)", () => {
  const fixture = makeFixture();
  try {
    const payload = { cwd: fixture };
    const { status, stdout, stderr } = runHook("archon-session-start.mjs", payload);
    assert.strictEqual(status, 0, `hook must exit 0, stderr: ${stderr}`);
    // No active task, no runtime configured → evaluateSessionStart returns undefined → no output
    assert.strictEqual(stdout.trim(), "", `expected empty stdout for empty fixture, got: ${stdout}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
