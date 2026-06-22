import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Direct test of the extracted leaf module (daemon split). Importing from the module
// path (not the daemon.ts re-export) locks the module boundary so a future split that
// breaks the leaf cannot hide behind the re-export.
import {
  convertSupportedCronScheduleToRrule,
  convertSupportedCronScheduleToSystemdOnCalendar,
  buildAppAutomationPrompt,
  detectGitAutomationExecutionEnvironment
} from "../src/daemon/automation-schedule.ts";

test("convertSupportedCronScheduleToRrule maps supported schedules, throws otherwise", () => {
  assert.equal(convertSupportedCronScheduleToRrule("*/30 * * * *"), "FREQ=MINUTELY;INTERVAL=30");
  assert.equal(convertSupportedCronScheduleToRrule("0 * * * *"), "FREQ=HOURLY;INTERVAL=1");
  assert.throws(() => convertSupportedCronScheduleToRrule("5 4 * * *"), /unsupported cron schedule/);
});

test("convertSupportedCronScheduleToSystemdOnCalendar maps supported, undefined otherwise", () => {
  assert.equal(convertSupportedCronScheduleToSystemdOnCalendar("*/30 * * * *"), "*-*-* *:0/30:00");
  assert.equal(convertSupportedCronScheduleToSystemdOnCalendar("0 * * * *"), "hourly");
  assert.equal(convertSupportedCronScheduleToSystemdOnCalendar("5 4 * * *"), undefined);
});

test("buildAppAutomationPrompt includes envelope fields and next actions", () => {
  const prompt = buildAppAutomationPrompt({
    envelope: {
      continuationIntent: "defer_fresh_run",
      targetMode: "fresh_run",
      targetId: "task-x",
      source: "progress_proof",
      summary: "do the thing",
      nextActions: ["a", "b"],
      workspaceSlug: "ws",
      projectSlug: "pj",
      activeRunId: "run-1",
      activeTaskId: "task-1"
    },
    cwd: "/repo"
  });
  assert.match(prompt, /workspace ws project pj/);
  assert.match(prompt, /Active task: task-1/);
  assert.match(prompt, /Next actions: a; b/);
  assert.doesNotMatch(prompt, /Compact continuation context/);
});

test("buildAppAutomationPrompt appends continuation context when present", () => {
  const prompt = buildAppAutomationPrompt({
    envelope: {
      continuationIntent: "defer_same_thread",
      targetMode: "same_thread",
      targetId: "t",
      source: "checkpoint",
      summary: "s",
      nextActions: [],
      workspaceSlug: "w",
      projectSlug: "p",
      activeRunId: "r",
      activeTaskId: "a"
    },
    cwd: "/repo",
    continuationContext: "PRIOR-CONTEXT-MARKER"
  });
  assert.match(prompt, /Compact continuation context from prior handoff/);
  assert.match(prompt, /PRIOR-CONTEXT-MARKER/);
});

test("detectGitAutomationExecutionEnvironment: worktree when .git present, local otherwise", async () => {
  assert.equal(await detectGitAutomationExecutionEnvironment(process.cwd()), "worktree");
  const empty = await mkdtemp(path.join(tmpdir(), "archon-no-git-"));
  assert.equal(await detectGitAutomationExecutionEnvironment(empty), "local");
});
