// Tests for R1: automatic context observer via the statusline hook.
//
// Before this fix, nothing recorded context usage in interactive sessions, so
// context-guard.json never reached handoff_required and the PreToolUse 70%
// enforcement never fired. These tests cover:
//   - the pure budget-state evaluation + guard-update logic (hook-policy.mjs)
//   - the statusline script writing the guard file from a real spawn
//   - settings.json wiring the statusline command

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs hook module without types
import {
  evaluateContextBudgetState,
  computeStatuslineGuardUpdate,
  extractUsedPercentage,
  resolveStatuslineThresholds
} from "../.claude/hooks/hook-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statuslineHook = path.join(repoRoot, ".claude", "hooks", "archon-statusline.mjs");

const thresholds = resolveStatuslineThresholds({});

// ---------------------------------------------------------------------------
// evaluateContextBudgetState
// ---------------------------------------------------------------------------

describe("evaluateContextBudgetState", () => {
  it("returns normal below the warning threshold", () => {
    assert.strictEqual(evaluateContextBudgetState(59.9, thresholds), "normal");
  });
  it("returns warning at 60%", () => {
    assert.strictEqual(evaluateContextBudgetState(60, thresholds), "warning");
  });
  it("returns warning at 69.9%", () => {
    assert.strictEqual(evaluateContextBudgetState(69.9, thresholds), "warning");
  });
  it("returns handoff_required at exactly 70%", () => {
    assert.strictEqual(evaluateContextBudgetState(70, thresholds), "handoff_required");
  });
  it("returns hard_stop at 80%", () => {
    assert.strictEqual(evaluateContextBudgetState(80, thresholds), "hard_stop");
  });
});

// ---------------------------------------------------------------------------
// extractUsedPercentage
// ---------------------------------------------------------------------------

describe("extractUsedPercentage", () => {
  it("reads context_window.used_percentage", () => {
    assert.strictEqual(extractUsedPercentage({ context_window: { used_percentage: 72 } }), 72);
  });
  it("clamps to 0..100", () => {
    assert.strictEqual(extractUsedPercentage({ context_window: { used_percentage: 140 } }), 100);
  });
  it("returns undefined when absent", () => {
    assert.strictEqual(extractUsedPercentage({ session_id: "abc" }), undefined);
  });
});

// ---------------------------------------------------------------------------
// computeStatuslineGuardUpdate
// ---------------------------------------------------------------------------

describe("computeStatuslineGuardUpdate", () => {
  it("writes handoff_required guard at 72% with the session id as invocation", () => {
    const { guard, line } = computeStatuslineGuardUpdate(
      { context_window: { used_percentage: 72 }, session_id: "sess-1" },
      undefined,
      {}
    );
    assert.ok(guard);
    assert.strictEqual(guard.state, "handoff_required");
    assert.strictEqual(guard.invocationId, "sess-1");
    assert.strictEqual(guard.contextPct, 72);
    assert.strictEqual(guard.source, "statusline");
    assert.match(line, /handoff_required/);
  });

  it("falls back to 'interactive' invocation id when no session id is present", () => {
    const { guard } = computeStatuslineGuardUpdate(
      { context_window: { used_percentage: 85 } },
      undefined,
      {}
    );
    assert.ok(guard);
    assert.strictEqual(guard.invocationId, "interactive");
    assert.strictEqual(guard.state, "hard_stop");
  });

  it("preserves the existing invocation id from the guard", () => {
    const { guard } = computeStatuslineGuardUpdate(
      { context_window: { used_percentage: 72 }, session_id: "sess-x" },
      { invocationId: "ainv_managed_1", state: "warning" },
      {}
    );
    assert.strictEqual(guard.invocationId, "ainv_managed_1");
  });

  it("does not overwrite a handoff_written guard — only refreshes the percentage", () => {
    const { guard, line } = computeStatuslineGuardUpdate(
      { context_window: { used_percentage: 73 } },
      { invocationId: "ainv_1", state: "handoff_written", contextPct: 71 },
      {}
    );
    assert.strictEqual(guard.state, "handoff_written");
    assert.strictEqual(guard.contextPct, 73);
    assert.match(line, /handoff_written/);
  });

  it("observe mode downgrades handoff_required to warning", () => {
    const { guard } = computeStatuslineGuardUpdate(
      { context_window: { used_percentage: 72 }, session_id: "s" },
      undefined,
      { ARCHON_CONTEXT_MONITOR: "observe" }
    );
    assert.strictEqual(guard.state, "warning");
  });

  it("observe mode does NOT downgrade hard_stop", () => {
    const { guard } = computeStatuslineGuardUpdate(
      { context_window: { used_percentage: 85 }, session_id: "s" },
      undefined,
      { ARCHON_CONTEXT_MONITOR: "observe" }
    );
    assert.strictEqual(guard.state, "hard_stop");
  });

  it("leaves the guard untouched when no context percentage is observable", () => {
    const { guard, line } = computeStatuslineGuardUpdate({ session_id: "s" }, undefined, {});
    assert.strictEqual(guard, undefined);
    assert.strictEqual(line, "archon ctx —");
  });
});

// ---------------------------------------------------------------------------
// Integration: real statusline spawn writes the guard file
// ---------------------------------------------------------------------------

describe("archon-statusline.mjs integration", () => {
  it("writes a handoff_required guard to the payload's workspace dir at 72%", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r1-"));
    try {
      const payload = {
        workspace: { current_dir: dir },
        session_id: "sess-int",
        context_window: { used_percentage: 72 }
      };
      const result = spawnSync(process.execPath, [statuslineHook], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000
      });
      assert.strictEqual(result.status, 0, `hook must exit 0, stderr: ${result.stderr}`);
      assert.match(result.stdout, /handoff_required/);

      const guardPath = path.join(dir, ".archon", "work", "context-guard.json");
      const guard = JSON.parse(fs.readFileSync(guardPath, "utf8"));
      assert.strictEqual(guard.state, "handoff_required");
      assert.strictEqual(guard.invocationId, "sess-int");
      assert.strictEqual(guard.source, "statusline");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not crash and writes no guard when context usage is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-r1-"));
    try {
      const result = spawnSync(process.execPath, [statuslineHook], {
        input: JSON.stringify({ workspace: { current_dir: dir }, session_id: "s" }),
        encoding: "utf8",
        timeout: 10_000
      });
      assert.strictEqual(result.status, 0, `hook must exit 0, stderr: ${result.stderr}`);
      const guardPath = path.join(dir, ".archon", "work", "context-guard.json");
      assert.strictEqual(fs.existsSync(guardPath), false, "no guard should be written without context usage");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// settings.json wiring
// ---------------------------------------------------------------------------

test("settings.json wires the statusline command", () => {
  const settings = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ".claude", "settings.json"), "utf8")
  );
  assert.ok(settings.statusLine, "statusLine must be configured");
  assert.strictEqual(settings.statusLine.type, "command");
  assert.match(settings.statusLine.command, /archon-statusline\.mjs/);
});
