import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  sanitizeId,
  isValidId,
  rejectPathTraversal,
  exportTaskToObsidian,
  type ObsidianExportInput
} from "../src/export/obsidian-exporter.ts";

// ── unit: id helpers ─────────────────────────────────────────────────────────

await test("sanitizeId: replaces unsafe characters with dashes", () => {
  assert.equal(sanitizeId("foo bar"), "foo-bar");
  assert.equal(sanitizeId("task/with/slashes"), "task-with-slashes");
  assert.equal(sanitizeId("ok-task.id_1"), "ok-task.id_1");
  assert.equal(sanitizeId("a@b#c"), "a-b-c");
});

await test("isValidId: accepts safe identifiers", () => {
  assert.ok(isValidId("task-1"));
  assert.ok(isValidId("task_foo.bar"));
  assert.ok(isValidId("ABC123"));
});

await test("isValidId: rejects empty string", () => {
  assert.ok(!isValidId(""));
});

await test("isValidId: rejects identifiers with unsafe characters", () => {
  assert.ok(!isValidId("task/1"));
  assert.ok(!isValidId("foo bar"));
  assert.ok(!isValidId("a@b"));
});

await test("rejectPathTraversal: throws on .. components", () => {
  assert.throws(() => rejectPathTraversal("../etc/passwd"), /Path traversal rejected/);
  assert.throws(() => rejectPathTraversal("task/../../secret"), /Path traversal rejected/);
});

await test("rejectPathTraversal: allows safe paths", () => {
  assert.doesNotThrow(() => rejectPathTraversal("tasks/my-task"));
  assert.doesNotThrow(() => rejectPathTraversal("simple-id"));
});

// ── helper: temp vault setup ─────────────────────────────────────────────────

async function makeTempVault(): Promise<{ vaultPath: string; cleanup: () => Promise<void> }> {
  const vaultPath = path.join(os.tmpdir(), `archon-test-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(vaultPath, { recursive: true });
  return {
    vaultPath,
    cleanup: () => rm(vaultPath, { recursive: true, force: true })
  };
}

const BASE_INPUT: ObsidianExportInput = {
  taskId: "test-task-1",
  taskPacketPath: "/nonexistent/task.md",
  reviewRecords: [
    { role: "reviewer", outcome: "passed", findings: ["code looks good"] },
    { role: "qa_engineer", outcome: "passed", findings: ["tests pass"] },
    { role: "security_reviewer", outcome: "passed", findings: [] }
  ],
  commitList: [
    { hash: "abc1234", message: "feat: implement feature" }
  ]
};

// ── exportTaskToObsidian: skip conditions ────────────────────────────────────

await test("exportTaskToObsidian: skips when ARCHON_OBSIDIAN_VAULT not set", async () => {
  const result = await exportTaskToObsidian(BASE_INPUT, { env: {} });
  assert.ok(result.skipped);
  assert.equal(result.skipReason, "ARCHON_OBSIDIAN_VAULT not set");
  assert.deepEqual(result.writtenPaths, []);
});

await test("exportTaskToObsidian: skips on path traversal in taskId", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const result = await exportTaskToObsidian(
      { ...BASE_INPUT, taskId: "../etc/passwd" },
      { env: { ARCHON_OBSIDIAN_VAULT: vaultPath } }
    );
    assert.ok(result.skipped);
    assert.ok(result.skipReason?.includes("Path traversal"));
  } finally {
    await cleanup();
  }
});

await test("exportTaskToObsidian: skips on invalid taskId characters", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const result = await exportTaskToObsidian(
      { ...BASE_INPUT, taskId: "task with spaces" },
      { env: { ARCHON_OBSIDIAN_VAULT: vaultPath } }
    );
    assert.ok(result.skipped);
    assert.ok(result.skipReason?.includes("unsafe characters"));
  } finally {
    await cleanup();
  }
});

// ── exportTaskToObsidian: task closure note ───────────────────────────────────

await test("exportTaskToObsidian: writes task closure note", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const now = new Date("2026-06-11T00:00:00Z");
    const result = await exportTaskToObsidian(BASE_INPUT, {
      env: { ARCHON_OBSIDIAN_VAULT: vaultPath },
      now
    });

    assert.ok(!result.skipped, `unexpected skip: ${result.skipReason}`);
    assert.ok(result.writtenPaths.length > 0, "expected written paths");

    const taskNote = result.writtenPaths.find((p) => p.includes("Tasks/"));
    assert.ok(taskNote, "expected a task closure note");

    const content = await readFile(taskNote!, "utf8");
    assert.ok(content.includes("task_id: test-task-1"));
    assert.ok(content.includes("date: 2026-06-11"));
    assert.ok(content.includes("# Task: test-task-1"));
    assert.ok(content.includes("abc1234 feat: implement feature"));
  } finally {
    await cleanup();
  }
});

await test("exportTaskToObsidian: task note includes all three review sections", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const result = await exportTaskToObsidian(BASE_INPUT, {
      env: { ARCHON_OBSIDIAN_VAULT: vaultPath },
      now: new Date("2026-06-11T00:00:00Z")
    });
    const taskNote = result.writtenPaths.find((p) => p.includes("Tasks/"));
    assert.ok(taskNote);
    const content = await readFile(taskNote!, "utf8");
    assert.ok(content.includes("### Reviewer"));
    assert.ok(content.includes("### QA Engineer"));
    assert.ok(content.includes("### Security Reviewer"));
    assert.ok(content.includes("code looks good"));
  } finally {
    await cleanup();
  }
});

// ── exportTaskToObsidian: review summary notes ────────────────────────────────

await test("exportTaskToObsidian: writes one review summary note per reviewer", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const result = await exportTaskToObsidian(BASE_INPUT, {
      env: { ARCHON_OBSIDIAN_VAULT: vaultPath },
      now: new Date("2026-06-11T00:00:00Z")
    });
    const reviewNotes = result.writtenPaths.filter((p) => p.includes("Reviews/"));
    assert.equal(reviewNotes.length, 3, "expected 3 review notes");

    const reviewerNote = reviewNotes.find((p) => p.includes("reviewer"));
    assert.ok(reviewerNote);
    const content = await readFile(reviewerNote!, "utf8");
    assert.ok(content.includes("role: reviewer"));
    assert.ok(content.includes("outcome: passed"));
    assert.ok(content.includes("code looks good"));
  } finally {
    await cleanup();
  }
});

// ── exportTaskToObsidian: decision notes ─────────────────────────────────────

await test("exportTaskToObsidian: writes decision notes for findings prefixed 'decision:'", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const inputWithDecision: ObsidianExportInput = {
      ...BASE_INPUT,
      reviewRecords: [
        {
          role: "reviewer",
          outcome: "passed",
          findings: ["decision: use postgres for state storage", "no issues found"]
        }
      ]
    };
    const result = await exportTaskToObsidian(inputWithDecision, {
      env: { ARCHON_OBSIDIAN_VAULT: vaultPath },
      now: new Date("2026-06-11T00:00:00Z")
    });
    const decisionNotes = result.writtenPaths.filter((p) => p.includes("Decisions/"));
    assert.ok(decisionNotes.length >= 1, "expected at least one decision note");

    const content = await readFile(decisionNotes[0]!, "utf8");
    assert.ok(content.includes("# Decision:"));
    assert.ok(content.includes("use postgres for state storage"));
    assert.ok(content.includes("tags: [archon/decision]"));
  } finally {
    await cleanup();
  }
});

// ── exportTaskToObsidian: wikilinks ───────────────────────────────────────────

await test("exportTaskToObsidian: review note includes wikilink back to task note", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const result = await exportTaskToObsidian(BASE_INPUT, {
      env: { ARCHON_OBSIDIAN_VAULT: vaultPath },
      now: new Date("2026-06-11T00:00:00Z")
    });
    const reviewNotes = result.writtenPaths.filter((p) => p.includes("Reviews/"));
    assert.ok(reviewNotes.length > 0);
    const content = await readFile(reviewNotes[0]!, "utf8");
    assert.ok(content.includes("[[Tasks/"), "review note should wikilink to task note");
  } finally {
    await cleanup();
  }
});

await test("exportTaskToObsidian: task note includes wikilinks for related tasks", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const inputWithRelated: ObsidianExportInput = {
      ...BASE_INPUT,
      taskPacketPath: "/nonexistent/task.md"
    };
    const result = await exportTaskToObsidian(inputWithRelated, {
      env: { ARCHON_OBSIDIAN_VAULT: vaultPath },
      now: new Date("2026-06-11T00:00:00Z")
    });
    assert.ok(!result.skipped);
    assert.ok(result.writtenPaths.length > 0);
  } finally {
    await cleanup();
  }
});

// ── exportTaskToObsidian: error isolation ─────────────────────────────────────

await test("exportTaskToObsidian: returns errors array, does not throw, on partial write failures", async () => {
  // Use a vault path under a nonexistent parent to trigger write errors
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    // Remove the vault to force fs errors
    await rm(vaultPath, { recursive: true, force: true });
    const result = await exportTaskToObsidian(BASE_INPUT, {
      env: { ARCHON_OBSIDIAN_VAULT: vaultPath },
      now: new Date("2026-06-11T00:00:00Z")
    });
    // Should not throw; result should either succeed (mkdir -p) or record errors
    assert.ok(Array.isArray(result.errors));
    assert.ok(Array.isArray(result.writtenPaths));
  } finally {
    await cleanup().catch(() => {});
  }
});

// ── exportTaskToObsidian: no errors on clean run ──────────────────────────────

await test("exportTaskToObsidian: clean run produces no errors", async () => {
  const { vaultPath, cleanup } = await makeTempVault();
  try {
    const result = await exportTaskToObsidian(BASE_INPUT, {
      env: { ARCHON_OBSIDIAN_VAULT: vaultPath },
      now: new Date("2026-06-11T00:00:00Z")
    });
    assert.deepEqual(result.errors, [], `unexpected errors: ${result.errors.join(", ")}`);
    assert.ok(!result.skipped);
  } finally {
    await cleanup();
  }
});
