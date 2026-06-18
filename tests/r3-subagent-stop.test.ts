// Tests for R3: SubagentStop capture hook.
//
// Covers the pure record/selection helpers and the real hook spawn writing the
// audit trail. DB attachment is best-effort and skipped in the fixture (no .env),
// so these tests focus on the always-on audit path and safe attribution logic.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs hook module without types
import { buildSubagentStopRecord, selectSubtaskForStop } from "../.claude/hooks/hook-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(repoRoot, ".claude", "hooks", "archon-subagent-stop.mjs");

describe("buildSubagentStopRecord", () => {
  it("captures transcript path, session id, and subagent type", () => {
    const rec = buildSubagentStopRecord(
      {
        session_id: "sess-1",
        transcript_path: "/tmp/transcript.jsonl",
        agent_type: "codebase_scout",
        stop_hook_active: true
      },
      "2026-06-18T00:00:00.000Z"
    );
    assert.strictEqual(rec.stoppedAt, "2026-06-18T00:00:00.000Z");
    assert.strictEqual(rec.sessionId, "sess-1");
    assert.strictEqual(rec.transcriptPath, "/tmp/transcript.jsonl");
    assert.strictEqual(rec.subagentType, "codebase_scout");
    assert.strictEqual(rec.stopHookActive, true);
  });

  it("tolerates a missing/sparse payload", () => {
    const rec = buildSubagentStopRecord({}, "2026-06-18T00:00:00.000Z");
    assert.strictEqual(rec.sessionId, undefined);
    assert.strictEqual(rec.transcriptPath, undefined);
    assert.strictEqual(rec.stopHookActive, false);
  });
});

describe("selectSubtaskForStop", () => {
  it("returns the id when exactly one pending un-resulted subtask exists", () => {
    const id = selectSubtaskForStop([
      { id: "s1", status: "completed", resultPacket: { ok: true } },
      { id: "s2", status: "running", resultPacket: undefined }
    ]);
    assert.strictEqual(id, "s2");
  });

  it("returns undefined when multiple pending subtasks exist (ambiguous)", () => {
    const id = selectSubtaskForStop([
      { id: "s2", status: "running", resultPacket: undefined },
      { id: "s3", status: "created", resultPacket: undefined }
    ]);
    assert.strictEqual(id, undefined);
  });

  it("returns undefined when none are pending", () => {
    const id = selectSubtaskForStop([{ id: "s1", status: "completed", resultPacket: { ok: true } }]);
    assert.strictEqual(id, undefined);
  });

  it("treats a non-array input as no match", () => {
    assert.strictEqual(selectSubtaskForStop(undefined), undefined);
  });
});

describe("archon-subagent-stop.mjs integration", () => {
  it("appends an audit record to .archon/work/subagent-stops.jsonl", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r3-"));
    try {
      const payload = {
        workspace: { current_dir: dir },
        session_id: "sess-int",
        transcript_path: "/tmp/t.jsonl",
        agent_type: "test_writer"
      };
      const result = spawnSync(process.execPath, [hook], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000
      });
      assert.strictEqual(result.status, 0, `hook must exit 0, stderr: ${result.stderr}`);

      const auditPath = path.join(dir, ".archon", "work", "subagent-stops.jsonl");
      assert.ok(fs.existsSync(auditPath), "audit file should exist");
      const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
      assert.strictEqual(lines.length, 1);
      const rec = JSON.parse(lines[0]);
      assert.strictEqual(rec.sessionId, "sess-int");
      assert.strictEqual(rec.transcriptPath, "/tmp/t.jsonl");
      assert.strictEqual(rec.subagentType, "test_writer");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("settings.json wires the SubagentStop hook", () => {
  const settings = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ".claude", "settings.json"), "utf8")
  );
  assert.ok(Array.isArray(settings.hooks.SubagentStop), "SubagentStop must be configured");
  const cmd = settings.hooks.SubagentStop[0].hooks[0].command;
  assert.match(cmd, /archon-subagent-stop\.mjs/);
});
