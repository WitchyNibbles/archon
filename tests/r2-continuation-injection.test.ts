// Tests for R2: continuation bundle injection into the resume prompt.
//
// Before this fix, loopCommand built the continuation bundle and discarded it,
// so the next claude -p resume never received runtime-authoritative context
// (AC5/FR-11). These tests confirm:
//   - buildAppAutomationPrompt renders an injected continuationContext block
//   - buildAppAutomationPrompt omits the block when no context is supplied
//   - the continuation-context sidecar round-trips (write -> read -> clear)

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAppAutomationPrompt,
  writeDaemonContinuationContext,
  readDaemonContinuationContext,
  clearDaemonContinuationContext
} from "../src/daemon.ts";

const baseEnvelope = {
  continuationIntent: "defer_fresh_run" as const,
  targetMode: "fresh_run" as const,
  targetId: "review:authenticated",
  source: "progress_proof" as const,
  summary: "Implemented store methods. Tests remain.",
  nextActions: ["run npm test", "run workflow proof"],
  workspaceSlug: "ws",
  projectSlug: "proj",
  activeRunId: "run-1",
  activeTaskId: "task-1"
};

describe("buildAppAutomationPrompt continuation injection", () => {
  it("renders the continuation context block when supplied", () => {
    const prompt = buildAppAutomationPrompt({
      envelope: baseEnvelope,
      cwd: "/repo",
      continuationContext:
        "Operate as `backend_engineer`.\nDecisions already made:\n- handoffs are runtime-authoritative."
    });
    assert.match(prompt, /Compact continuation context from prior handoff/);
    assert.match(prompt, /handoffs are runtime-authoritative/);
    assert.match(prompt, /Operate as `backend_engineer`/);
  });

  it("omits the continuation block when no context is supplied", () => {
    const prompt = buildAppAutomationPrompt({ envelope: baseEnvelope, cwd: "/repo" });
    assert.doesNotMatch(prompt, /Compact continuation context from prior handoff/);
  });

  it("omits the block when context is whitespace-only", () => {
    const prompt = buildAppAutomationPrompt({
      envelope: baseEnvelope,
      cwd: "/repo",
      continuationContext: "   \n  "
    });
    assert.doesNotMatch(prompt, /Compact continuation context from prior handoff/);
  });
});

describe("continuation-context sidecar round-trip", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes, reads, and clears the persisted bundle", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "archon-r2-"));
    const relPath = await writeDaemonContinuationContext(dir, "compact bundle body");
    assert.strictEqual(relPath, ".archon/work/daemon/continuation-context.txt");

    const readBack = await readDaemonContinuationContext(dir);
    assert.strictEqual(readBack, "compact bundle body");

    await clearDaemonContinuationContext(dir);
    const afterClear = await readDaemonContinuationContext(dir);
    assert.strictEqual(afterClear, undefined);
  });

  it("returns undefined when the sidecar does not exist", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "archon-r2-"));
    const result = await readDaemonContinuationContext(dir);
    assert.strictEqual(result, undefined);
  });
});
