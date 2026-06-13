/**
 * Tests for P2: real review gate pipeline.
 *
 * Covers:
 * - Stop hook: DB-configured-but-offline falls back to markdown review check
 * - Stop hook: source='orchestrator' requirement (no self-attestation)
 * - save-review CLI: argument validation (no DB required)
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

function runHook(
  hookName: string,
  payload: Record<string, unknown>,
  env?: Record<string, string>
): { status: number | null; stdout: string; stderr: string; parsed: Record<string, unknown> | null } {
  const result = spawnSync(process.execPath, [hookPath(hookName)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...env }
  });
  let parsed: Record<string, unknown> | null = null;
  if (result.stdout && result.stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    } catch {
      // leave null
    }
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", parsed };
}

function makeFixture(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-review-gate-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

function taskPacketWithReviews(taskId: string, reviews: string[]): string {
  const lines = [
    `# Task Packet — ${taskId}`,
    "",
    "## Task ID",
    "",
    `\`${taskId}\``,
    "",
    "## Task class",
    "",
    "docs_only",
    "",
    "## Council review",
    "",
    "### Outcome",
    "",
    "`approved`",
    "",
    "## Verification required",
    "",
    "false",
    "",
    "## Required reviews",
    ""
  ];
  for (const r of reviews) {
    lines.push(`- ${r}`);
  }
  lines.push("");
  return lines.join("\n");
}

const COMPLETION_MSG =
  "The scoped task is complete. This is an external workflow closure.";

// ── DB-offline fallback ───────────────────────────────────────────────────────

await test("review-gate: DB configured but offline → falls back to markdown check, holds stop when reviews missing", async () => {
  const taskId = "rg-db-offline";
  const fixture = makeFixture({
    ".archon/ACTIVE": `task_id=${taskId}\nstate=active\n`,
    [`.archon/work/tasks/task-${taskId}.md`]: taskPacketWithReviews(taskId, ["reviewer", "qa_engineer"]),
    ".env": [
      // Bad DB URL — connection will be refused immediately, triggering fallback
      "ARCHON_CORE_DATABASE_URL=postgresql://bad:bad@localhost:1/nonexistentdb",
      "ARCHON_WORKSPACE_SLUG=test-ws",
      "ARCHON_PROJECT_SLUG=test-proj"
    ].join("\n")
  });

  try {
    const payload = {
      last_assistant_message: COMPLETION_MSG,
      stop_hook_active: false,
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-stop.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    assert.ok(parsed !== null, "stdout should be non-empty JSON");
    assert.strictEqual(parsed!.continue, false, `expected stop to be held; got ${JSON.stringify(parsed)}`);
    assert.ok(
      typeof parsed!.stopReason === "string" && /review/i.test(parsed!.stopReason as string),
      `stopReason should mention reviews, got: ${parsed!.stopReason}`
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

await test("review-gate: DB offline but markdown reviews present → stop is not held by review gate", async () => {
  const taskId = "rg-md-present";
  const reviewContent = [
    `# Review — ${taskId} — reviewer`,
    "",
    `task_id: ${taskId}`,
    "role: reviewer",
    "outcome: passed",
    "findings: []"
  ].join("\n");
  const qaReviewContent = [
    `# Review — ${taskId} — qa_engineer`,
    "",
    `task_id: ${taskId}`,
    "role: qa_engineer",
    "outcome: passed",
    "findings: []"
  ].join("\n");

  const fixture = makeFixture({
    ".archon/ACTIVE": `task_id=${taskId}\nstate=active\n`,
    [`.archon/work/tasks/task-${taskId}.md`]: taskPacketWithReviews(taskId, ["reviewer", "qa_engineer"]),
    [`.archon/work/reviews/review-${taskId}-reviewer.md`]: reviewContent,
    [`.archon/work/reviews/review-${taskId}-qa_engineer.md`]: qaReviewContent
  });

  try {
    const payload = {
      last_assistant_message: COMPLETION_MSG,
      stop_hook_active: false,
      cwd: fixture
    };
    const { status, parsed } = runHook("archon-stop.mjs", payload);
    assert.strictEqual(status, 0, "hook must exit 0");
    // Not held by review gate (reviews present); may be held by other gates
    const heldByReviewGate =
      parsed !== null &&
      parsed.continue === false &&
      typeof parsed.stopReason === "string" &&
      /missing.*review|review.*missing/i.test(parsed.stopReason as string);
    assert.ok(!heldByReviewGate, `review gate must not fire when reviews are present; got: ${JSON.stringify(parsed)}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ── save-review CLI argument validation ───────────────────────────────────────

function runAdmin(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const adminPath = path.join(repoRoot, "src", "admin.ts");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", adminPath, "save-review", ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, ARCHON_CORE_DATABASE_URL: "" }
    }
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

await test("save-review CLI: missing --task-id → exits non-zero with error", () => {
  const { status, stderr } = runAdmin(["--role", "reviewer", "--outcome", "passed"]);
  assert.ok(status !== 0, `expected non-zero exit, got ${status}`);
  assert.ok(/task.id/i.test(stderr), `expected task-id error in stderr, got: ${stderr}`);
});

await test("save-review CLI: missing --role → exits non-zero with error", () => {
  const { status, stderr } = runAdmin(["--task-id", "t1", "--outcome", "passed"]);
  assert.ok(status !== 0, `expected non-zero exit, got ${status}`);
  assert.ok(/role/i.test(stderr), `expected role error in stderr, got: ${stderr}`);
});

await test("save-review CLI: invalid --outcome value → exits non-zero with error", () => {
  const { status, stderr } = runAdmin(["--task-id", "t1", "--role", "reviewer", "--outcome", "maybe"]);
  assert.ok(status !== 0, `expected non-zero exit, got ${status}`);
  assert.ok(/outcome/i.test(stderr), `expected outcome error in stderr, got: ${stderr}`);
});

await test("save-review CLI: invalid --source value → exits non-zero with error", () => {
  const { status, stderr } = runAdmin([
    "--task-id", "t1",
    "--role", "reviewer",
    "--outcome", "passed",
    "--source", "bad-source"
  ]);
  assert.ok(status !== 0, `expected non-zero exit, got ${status}`);
  assert.ok(/source/i.test(stderr), `expected source error in stderr, got: ${stderr}`);
});

await test("save-review CLI: valid args but no DB env → exits non-zero with env error", () => {
  const { status, stderr } = runAdmin([
    "--task-id", "t1",
    "--role", "reviewer",
    "--outcome", "passed",
    "--source", "orchestrator"
  ]);
  assert.ok(status !== 0, `expected non-zero exit without DB env, got ${status}`);
  assert.ok(
    /workspace_slug|project_slug|ARCHON/i.test(stderr),
    `expected env error in stderr, got: ${stderr}`
  );
});

// ── migration SQL: syntactic check ───────────────────────────────────────────

await test("review-gate: migration 016 SQL file is present and contains expected DDL", async () => {
  const { readFile } = await import("node:fs/promises");
  const migrationPath = path.join(repoRoot, "src", "sql", "migrations", "016_review_source_field.sql");
  const content = await readFile(migrationPath, "utf8");
  assert.ok(content.includes("source"), "migration should add 'source' column");
  assert.ok(content.includes("orchestrator"), "migration should reference 'orchestrator' value");
  assert.ok(/alter table reviews/i.test(content), "migration should alter reviews table");
});
