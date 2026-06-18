// Tests for R4: PostToolUse touched-path evidence ledger.
//
// Covers the persist/read helpers (dedup + relative-path normalization) and the
// real post-tool hook recording a touched path for a successful edit under an
// active task.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs hook module without types
import { persistTouchedPath, readTouchedPaths } from "../.claude/hooks/hook-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const postToolHook = path.join(repoRoot, ".claude", "hooks", "archon-post-tool.mjs");

describe("persistTouchedPath / readTouchedPaths", () => {
  it("records a relative path and reads it back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r4-"));
    try {
      persistTouchedPath(dir, "task-1", path.join(dir, "src", "a.ts"));
      const paths = readTouchedPaths(dir, "task-1");
      assert.deepStrictEqual(paths, ["src/a.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated edits to the same path for the same task", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r4-"));
    try {
      persistTouchedPath(dir, "task-1", path.join(dir, "src", "a.ts"));
      persistTouchedPath(dir, "task-1", path.join(dir, "src", "a.ts"));
      persistTouchedPath(dir, "task-1", path.join(dir, "src", "b.ts"));
      const ledger = fs
        .readFileSync(path.join(dir, ".archon", "work", "touched-paths.jsonl"), "utf8")
        .trim()
        .split("\n");
      assert.strictEqual(ledger.length, 2, "duplicate path should not append twice");
      assert.deepStrictEqual(readTouchedPaths(dir, "task-1").sort(), ["src/a.ts", "src/b.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores an absolute path verbatim when the file is outside the repo root", () => {
    // Documents intentional behavior: a write outside repoRoot is still recorded
    // as evidence, keyed by its absolute path (toRelativePath leaves it unchanged).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r4-"));
    try {
      const outside = "/etc/some-other-place/x.ts";
      persistTouchedPath(dir, "task-1", outside);
      const paths = readTouchedPaths(dir, "task-1");
      assert.deepStrictEqual(paths, [outside]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores empty/blank file paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r4-"));
    try {
      persistTouchedPath(dir, "task-1", "");
      assert.deepStrictEqual(readTouchedPaths(dir, "task-1"), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("archon-post-tool.mjs touched-path integration", () => {
  it("records a touched path for a successful Write under an active task", () => {
    const taskId = "r4-t1";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r4-"));
    try {
      fs.mkdirSync(path.join(dir, ".archon", "work", "tasks"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
      fs.writeFileSync(
        path.join(dir, ".archon", "work", "tasks", `task-${taskId}.md`),
        [
          `# Task Packet — ${taskId}`,
          "",
          "## Task ID",
          "",
          `\`${taskId}\``,
          "",
          "## Allowed write scope",
          "",
          "- src",
          ""
        ].join("\n")
      );

      const payload = {
        tool_name: "Write",
        tool_input: { file_path: path.join(dir, "src", "feature.ts") },
        tool_response: { isError: false },
        cwd: dir
      };
      const result = spawnSync(process.execPath, [postToolHook], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000
      });
      assert.strictEqual(result.status, 0, `hook must exit 0, stderr: ${result.stderr}`);

      const paths = readTouchedPaths(dir, taskId);
      assert.ok(paths.includes("src/feature.ts"), `expected src/feature.ts in ${JSON.stringify(paths)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not record a touched path with no active task", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r4-"));
    try {
      const payload = {
        tool_name: "Write",
        tool_input: { file_path: path.join(dir, "src", "x.ts") },
        tool_response: { isError: false },
        cwd: dir
      };
      const result = spawnSync(process.execPath, [postToolHook], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000
      });
      assert.strictEqual(result.status, 0, `hook must exit 0, stderr: ${result.stderr}`);
      assert.strictEqual(fs.existsSync(path.join(dir, ".archon", "work", "touched-paths.jsonl")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("R4 placeholder export sanity", () => {
  assert.strictEqual(typeof persistTouchedPath, "function");
  assert.strictEqual(typeof readTouchedPaths, "function");
});
