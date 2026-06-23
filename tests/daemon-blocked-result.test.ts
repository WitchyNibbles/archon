// Tests for createDaemonBlockedResult (daemon split 6m).
//
// The factory returns a DaemonBlockedResultBuilder that must:
//   1. Write the operator handoff file via writeDaemonOperatorHandoff
//   2. Include the current session id from getSessionId() (live, not snapshot)
//   3. Return a DaemonCommandResult with status "blocked" and the correct shape
//   4. Spread input.nextActions and input.detailFiles defensively
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDaemonBlockedResult } from "../src/daemon/blocked-result.ts";
import type { DaemonCycleRecord } from "../src/daemon.ts";

async function makeTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `archon-test-blocked-result-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("createDaemonBlockedResult", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await makeTmpDir();
  });

  it("returns a function (DaemonBlockedResultBuilder)", () => {
    const cycles: DaemonCycleRecord[] = [];
    const builder = createDaemonBlockedResult({
      cwd: tmpDir,
      workspaceSlug: "ws",
      projectSlug: "proj",
      getSessionId: () => undefined,
      now: () => new Date("2024-01-01T00:00:00.000Z"),
      cycles
    });
    assert.equal(typeof builder, "function");
  });

  it("writes operator handoff file and returns blocked result", async () => {
    const cwd = await makeTmpDir();
    const cycles: DaemonCycleRecord[] = [];
    const sessionId: string | undefined = "sess-abc";
    const now = () => new Date("2024-06-01T12:00:00.000Z");

    const builder = createDaemonBlockedResult({
      cwd,
      workspaceSlug: "test-ws",
      projectSlug: "test-proj",
      getSessionId: () => sessionId,
      now,
      cycles
    });

    const result = await builder({
      blockerKind: "runtime_preflight",
      reason: "preflight check failed",
      cycle: 1,
      activeRunId: "run-1",
      activeTaskId: "task-1"
    });

    // Verify handoff file was written
    const handoffPath = path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json");
    const raw = await readFile(handoffPath, "utf8");
    const handoff = JSON.parse(raw);
    assert.equal(handoff.state, "blocked");
    assert.equal(handoff.blockerKind, "runtime_preflight");
    assert.equal(handoff.reason, "preflight check failed");
    assert.equal(handoff.workspaceSlug, "test-ws");
    assert.equal(handoff.projectSlug, "test-proj");
    assert.equal(handoff.activeRunId, "run-1");
    assert.equal(handoff.activeTaskId, "task-1");
    assert.equal(handoff.sessionId, "sess-abc");
    assert.equal(handoff.cycle, 1);
    assert.equal(handoff.updatedAt, "2024-06-01T12:00:00.000Z");

    // Verify returned result shape
    assert.equal(result.authorityLabel, "derived_only");
    assert.equal(result.workspaceSlug, "test-ws");
    assert.equal(result.projectSlug, "test-proj");
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "preflight check failed");
    assert.equal(result.activeRunId, "run-1");
    assert.equal(result.activeTaskId, "task-1");
    assert.equal(result.sessionId, "sess-abc");
    assert.equal(result.cycles, cycles);

    await rm(cwd, { recursive: true, force: true });
  });

  it("reads getSessionId() live at call time — not as a captured snapshot", async () => {
    const cwd = await makeTmpDir();
    const cycles: DaemonCycleRecord[] = [];
    let sessionId: string | undefined = "initial-session";

    const builder = createDaemonBlockedResult({
      cwd,
      workspaceSlug: "ws",
      projectSlug: "proj",
      getSessionId: () => sessionId,
      now: () => new Date("2024-01-01T00:00:00.000Z"),
      cycles
    });

    // Mutate the session id BEFORE calling the builder
    sessionId = "updated-session";

    const result = await builder({
      blockerKind: "missing_active_runtime",
      reason: "no active runtime",
      cycle: 2,
      activeRunId: null,
      activeTaskId: null
    });

    // Both handoff and result must see the updated session id
    const handoffPath = path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json");
    const raw = await readFile(handoffPath, "utf8");
    const handoff = JSON.parse(raw);
    assert.equal(handoff.sessionId, "updated-session");
    assert.equal(result.sessionId, "updated-session");

    await rm(cwd, { recursive: true, force: true });
  });

  it("spreads nextActions and detailFiles defensively", async () => {
    const cwd = await makeTmpDir();
    const cycles: DaemonCycleRecord[] = [];

    const builder = createDaemonBlockedResult({
      cwd,
      workspaceSlug: "ws",
      projectSlug: "proj",
      getSessionId: () => undefined,
      now: () => new Date("2024-01-01T00:00:00.000Z"),
      cycles
    });

    const nextActions = ["action-1", "action-2"];
    const detailFiles = { continuationStatus: "/path/to/status.json" };

    await builder({
      blockerKind: "review_queue",
      reason: "review blocked",
      cycle: 3,
      activeRunId: "run-x",
      activeTaskId: "task-x",
      nextActions,
      detailFiles
    });

    const handoffPath = path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json");
    const raw = await readFile(handoffPath, "utf8");
    const handoff = JSON.parse(raw);

    // nextActions must be a new array (spread), not the same reference
    assert.deepEqual(handoff.nextActions, ["action-1", "action-2"]);
    assert.deepEqual(handoff.detailFiles, { continuationStatus: "/path/to/status.json" });

    await rm(cwd, { recursive: true, force: true });
  });

  it("falls back to empty nextActions and detailFiles when omitted", async () => {
    const cwd = await makeTmpDir();
    const cycles: DaemonCycleRecord[] = [];

    const builder = createDaemonBlockedResult({
      cwd,
      workspaceSlug: "ws",
      projectSlug: "proj",
      getSessionId: () => undefined,
      now: () => new Date("2024-01-01T00:00:00.000Z"),
      cycles
    });

    await builder({
      blockerKind: "runtime_blocked",
      reason: "blocked",
      cycle: 4,
      activeRunId: "run-y",
      activeTaskId: "task-y"
    });

    const handoffPath = path.join(cwd, ".archon", "work", "daemon", "operator-handoff.json");
    const raw = await readFile(handoffPath, "utf8");
    const handoff = JSON.parse(raw);

    assert.deepEqual(handoff.nextActions, []);
    assert.deepEqual(handoff.detailFiles, {});

    await rm(cwd, { recursive: true, force: true });
  });

  it("carries cycles by reference — result.cycles is the same array", async () => {
    const cwd = await makeTmpDir();
    const cycles: DaemonCycleRecord[] = [];

    const builder = createDaemonBlockedResult({
      cwd,
      workspaceSlug: "ws",
      projectSlug: "proj",
      getSessionId: () => undefined,
      now: () => new Date("2024-01-01T00:00:00.000Z"),
      cycles
    });

    const result = await builder({
      blockerKind: "recovery_required",
      reason: "needs recovery",
      cycle: 5,
      activeRunId: null,
      activeTaskId: null
    });

    // result.cycles must be the SAME reference — not a copy
    assert.equal(result.cycles, cycles);

    await rm(cwd, { recursive: true, force: true });
  });
});
