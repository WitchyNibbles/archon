// Phase 4 (ahrP4InteractiveWatcher): unit tests for interactive-stop-hook.ts
//
// RED phase — these must fail before the handler is created.
//
// Contracts under test:
//   - threshold crossed → ensure committed handoff (else recoverCrashedInvocation)
//   - writes FRESH-run (not --resume) resume-request via existing writer family
//   - atomic temp+rename write (INFRA-C3)
//   - path-safety validation: rejects '..' and shell metacharacters in promptPath
//   - freshness gate: rejects stale requests (ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS)
//   - stale/rejected requests are ARCHIVED not silently deleted
//   - observe mode: does NOT write resume-request
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  handleInteractiveStop,
  validateResumeRequest,
  archiveResumeRequest,
  writeResumeRequestAtomically
} from "../src/runtime/interactive-stop-hook.ts";
import type {
  InteractiveStopHookDeps,
  ResumeRequest
} from "../src/runtime/interactive-stop-hook.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalHandoffRecord() {
  return {
    id: "ho_test_001",
    runId: "run-test",
    taskId: "task-test",
    fromInvocationId: "inv-001",
    fromRole: "specialist_owner",
    toRole: "specialist_owner",
    reason: "context_limit",
    status: "handoff_written",
    packet: {
      summary: "Reached context threshold, partial progress committed",
      nextActions: ["Continue from where we left off"],
      evidenceRefs: []
    },
    authorityLabel: "runtime_authoritative",
    createdAt: new Date().toISOString()
  };
}

function makeDeps(overrides: Partial<InteractiveStopHookDeps> = {}): InteractiveStopHookDeps {
  return {
    invocationId: "inv-001",
    runId: "run-test",
    taskId: "task-test",
    role: "specialist_owner",
    cwd: "/tmp/test-cwd",
    getThresholdCrossed: async () => true,
    getLatestHandoff: async () => makeMinimalHandoffRecord(),
    hasCommittedHandoff: async () => true,
    recoverCrashedInvocation: async () => makeMinimalHandoffRecord(),
    buildContinuationPrompt: () => "continuation prompt text",
    // BLOCKING-4: mock signature updated to accept promptContent
    writeResumeRequest: async (_cwd, _req, _promptContent) => ".archon/work/daemon/interactive-resume-request.json",
    claimLease: async (_runId, _owner) => ({ granted: true, runId: "run-test", owner: "interactive" }),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// handleInteractiveStop — threshold crossed + handoff present
// ---------------------------------------------------------------------------

describe("handleInteractiveStop", () => {
  it("writes resume-request when threshold is crossed and handoff is committed", async () => {
    let capturedRequest: ResumeRequest | undefined;
    let capturedPromptContent: string | undefined;
    const deps = makeDeps({
      buildContinuationPrompt: () => "the actual continuation prompt text",
      writeResumeRequest: async (_cwd, req, promptContent) => {
        capturedRequest = req;
        capturedPromptContent = promptContent;
        return ".archon/work/daemon/interactive-resume-request.json";
      }
    });

    const result = await handleInteractiveStop(deps);
    assert.equal(result.action, "resume_request_written");
    assert.ok(capturedRequest);
    assert.equal(capturedRequest.mode, "fresh_run", "must be fresh_run, NOT resume");
    assert.equal(capturedRequest.runId, "run-test");
    assert.equal(capturedRequest.taskId, "task-test");
    assert.equal(typeof capturedRequest.promptPath, "string");
    assert.ok(!capturedRequest.promptPath.includes(".."), "promptPath must not contain ..");
    // BLOCKING-4: promptContent must be the actual text, not the path string.
    assert.ok(capturedPromptContent !== undefined, "promptContent must be passed to writer");
    assert.ok(
      capturedPromptContent!.includes("the actual continuation prompt text"),
      `promptContent must contain the continuation text, got: ${capturedPromptContent}`
    );
    assert.ok(
      !capturedPromptContent!.includes(".archon/work/daemon"),
      "promptContent must NOT be the path string (BLOCKING-4)"
    );
  });

  it("calls recoverCrashedInvocation when no handoff is committed", async () => {
    let recoveryCalledWith: string | undefined;
    const deps = makeDeps({
      hasCommittedHandoff: async () => false,
      getLatestHandoff: async () => undefined,
      recoverCrashedInvocation: async (invId) => {
        recoveryCalledWith = invId;
        return makeMinimalHandoffRecord();
      }
    });

    const result = await handleInteractiveStop(deps);
    assert.equal(result.action, "resume_request_written");
    assert.equal(recoveryCalledWith, "inv-001");
  });

  it("returns no_action when threshold is NOT crossed", async () => {
    const deps = makeDeps({
      getThresholdCrossed: async () => false
    });

    const result = await handleInteractiveStop(deps);
    assert.equal(result.action, "no_action");
    assert.equal(result.reason, "threshold_not_crossed");
  });

  it("returns no_action in observe mode without writing resume-request", async () => {
    let writeCallCount = 0;
    const deps = makeDeps({
      mode: "observe",
      writeResumeRequest: async () => {
        writeCallCount++;
        return ".archon/work/daemon/interactive-resume-request.json";
      }
    });

    const result = await handleInteractiveStop(deps);
    assert.equal(result.action, "no_action");
    assert.equal(result.reason, "observe_mode");
    assert.equal(writeCallCount, 0, "observe mode must not write resume-request");
  });

  it("returns no_action when lease claim is denied", async () => {
    const deps = makeDeps({
      claimLease: async () => ({
        granted: false,
        runId: "run-test",
        currentOwner: "daemon"
      })
    });

    const result = await handleInteractiveStop(deps);
    assert.equal(result.action, "no_action");
    assert.equal(result.reason, "lease_denied");
  });

  it("does NOT write a --resume flag (fresh_run only)", async () => {
    let capturedRequest: ResumeRequest | undefined;
    const deps = makeDeps({
      writeResumeRequest: async (_cwd, req, _promptContent) => {
        capturedRequest = req;
        return ".archon/work/daemon/interactive-resume-request.json";
      }
    });

    await handleInteractiveStop(deps);
    assert.ok(capturedRequest);
    assert.equal(capturedRequest.mode, "fresh_run");
    assert.equal(capturedRequest.resumeSessionId, undefined,
      "fresh_run must NOT have a resumeSessionId");
  });
});

// ---------------------------------------------------------------------------
// validateResumeRequest — schema + freshness + path-safety (INFRA-C3/SEC-HIGH-2)
// ---------------------------------------------------------------------------

describe("validateResumeRequest", () => {
  it("accepts a valid fresh request", () => {
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: ".archon/work/daemon/continuation-context.txt",
      createdAt: new Date().toISOString()
    };
    const result = validateResumeRequest(req, { maxAgeSeconds: 300 });
    assert.equal(result.valid, true);
  });

  it("rejects promptPath containing '..'", () => {
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: ".archon/work/daemon/../../../etc/passwd",
      createdAt: new Date().toISOString()
    };
    const result = validateResumeRequest(req, { maxAgeSeconds: 300 });
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("..") || result.reason?.includes("traversal") ||
      result.reason?.includes("path"), `reason: ${result.reason}`);
  });

  it("rejects promptPath containing shell metacharacters (semicolon)", () => {
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: ".archon/work/daemon/prompt.txt; rm -rf /",
      createdAt: new Date().toISOString()
    };
    const result = validateResumeRequest(req, { maxAgeSeconds: 300 });
    assert.equal(result.valid, false);
  });

  it("rejects promptPath containing shell metacharacters (backtick)", () => {
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: ".archon/work/daemon/`evil`.txt",
      createdAt: new Date().toISOString()
    };
    const result = validateResumeRequest(req, { maxAgeSeconds: 300 });
    assert.equal(result.valid, false);
  });

  it("rejects promptPath not under .archon/work/daemon/", () => {
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: "src/runtime/evil.ts",
      createdAt: new Date().toISOString()
    };
    const result = validateResumeRequest(req, { maxAgeSeconds: 300 });
    assert.equal(result.valid, false);
  });

  it("rejects stale requests older than maxAgeSeconds", () => {
    const staleDate = new Date(Date.now() - 400_000).toISOString(); // 400s ago
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: ".archon/work/daemon/continuation-context.txt",
      createdAt: staleDate
    };
    const result = validateResumeRequest(req, { maxAgeSeconds: 300, now: new Date() });
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("stale") || result.reason?.includes("age") ||
      result.reason?.includes("expired"), `reason: ${result.reason}`);
  });

  it("accepts a request exactly at the age boundary (injected clock — non-blocking 8)", () => {
    // Non-blocking 8: use injected `now` for a fully deterministic boundary test.
    // The reference epoch is fixed; no dependency on real Date.now().
    const referenceEpoch = new Date("2025-01-01T00:05:00Z");
    const createdAt = new Date("2025-01-01T00:00:00Z").toISOString(); // exactly 300s before referenceEpoch
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: ".archon/work/daemon/continuation-context.txt",
      createdAt
    };
    // Boundary: 300s old, maxAgeSeconds=300 → valid (boundary inclusive).
    const result = validateResumeRequest(req, { maxAgeSeconds: 300, now: referenceEpoch });
    assert.equal(result.valid, true, "boundary-age request must be valid (injected clock)");
  });

  it("rejects request just past the age boundary (injected clock)", () => {
    const referenceEpoch = new Date("2025-01-01T00:05:01Z");
    const createdAt = new Date("2025-01-01T00:00:00Z").toISOString(); // 301s old
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: ".archon/work/daemon/continuation-context.txt",
      createdAt
    };
    const result = validateResumeRequest(req, { maxAgeSeconds: 300, now: referenceEpoch });
    assert.equal(result.valid, false, "1-second-past-boundary request must be invalid");
  });

  it("rejects an absolute promptPath (must be relative)", () => {
    const req: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: "/etc/passwd",
      createdAt: new Date().toISOString()
    };
    const result = validateResumeRequest(req, { maxAgeSeconds: 300 });
    assert.equal(result.valid, false);
  });

  it("rejects if schemaVersion is missing or wrong", () => {
    const req = {
      mode: "fresh_run",
      runId: "run-001",
      taskId: "task-001",
      promptPath: ".archon/work/daemon/prompt.txt",
      createdAt: new Date().toISOString()
    };
    const result = validateResumeRequest(req as unknown as ResumeRequest, { maxAgeSeconds: 300 });
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// archiveResumeRequest — stale/rejected requests archived not deleted
// ---------------------------------------------------------------------------

describe("archiveResumeRequest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await new Promise<string>((resolve, reject) => {
      const tmp = path.join(os.tmpdir(), `archon-p4-test-${Date.now()}`);
      mkdir(tmp, { recursive: true }).then(() => resolve(tmp)).catch(reject);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("moves the file to archive directory (not deletes)", async () => {
    const daemonDir = path.join(tmpDir, ".archon", "work", "daemon");
    await mkdir(daemonDir, { recursive: true });
    const requestPath = path.join(daemonDir, "interactive-resume-request.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(requestPath, JSON.stringify({ test: true }), "utf8")
    );

    await archiveResumeRequest(requestPath, tmpDir);

    // Original file must be gone
    await assert.rejects(
      () => stat(requestPath),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
      "original file should be removed after archive"
    );

    // Archive directory must exist and contain a file
    const archiveDir = path.join(daemonDir, "rejected-resume-requests");
    const archiveStat = await stat(archiveDir);
    assert.ok(archiveStat.isDirectory(), "archive directory must exist");
  });
});

// ---------------------------------------------------------------------------
// writeResumeRequestAtomically — prompt content disk readback (BLOCKING-4)
// ---------------------------------------------------------------------------

describe("writeResumeRequestAtomically — prompt content readback (BLOCKING-4)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `archon-p4-write-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes promptContent to the prompt file (not the path string)", async () => {
    const request: ResumeRequest = {
      schemaVersion: 1,
      mode: "fresh_run",
      runId: "run-disk-001",
      taskId: "task-disk-001",
      promptPath: ".archon/work/daemon/continuation-context.txt",
      createdAt: new Date().toISOString()
    };
    const expectedContent = "This is the real continuation prompt for the agent.";

    await writeResumeRequestAtomically(tmpDir, request, expectedContent);

    const promptFullPath = path.join(tmpDir, request.promptPath);
    const written = await readFile(promptFullPath, "utf8");

    assert.equal(
      written.trim(),
      expectedContent.trim(),
      "disk content must equal the promptContent argument, not the path string"
    );
    // The path string must NOT appear as file content.
    assert.ok(
      !written.includes(".archon/work/daemon"),
      "prompt file must NOT contain the path string (BLOCKING-4 regression check)"
    );
  });

  it("continuation-context.txt content equals buildContinuationPrompt(record) output", async () => {
    // Simulates the end-to-end flow: buildContinuationPrompt produces text,
    // handleInteractiveStop passes it to writeResumeRequest, disk file matches.
    const handoffRecord = {
      id: "ho_e2e_001",
      runId: "run-e2e",
      taskId: "task-e2e",
      fromInvocationId: "inv-e2e",
      fromRole: "specialist_owner",
      toRole: "specialist_owner",
      reason: "context_limit",
      status: "handoff_written",
      packet: {
        summary: "Progress made on feature X",
        nextActions: ["Complete the remaining subtask"],
        evidenceRefs: []
      },
      authorityLabel: "runtime_authoritative",
      createdAt: new Date().toISOString()
    };

    const expectedPrompt = `CONTINUATION BUNDLE\nSummary: ${handoffRecord.packet.summary}`;
    let writtenPromptContent: string | undefined;

    const deps: InteractiveStopHookDeps = {
      invocationId: "inv-e2e",
      runId: "run-e2e",
      taskId: "task-e2e",
      role: "specialist_owner",
      cwd: tmpDir,
      getThresholdCrossed: async () => true,
      getLatestHandoff: async () => handoffRecord as ReturnType<typeof makeMinimalHandoffRecord>,
      hasCommittedHandoff: async () => true,
      recoverCrashedInvocation: async () => handoffRecord as ReturnType<typeof makeMinimalHandoffRecord>,
      buildContinuationPrompt: (_rec) => expectedPrompt,
      writeResumeRequest: async (_cwd, _req, promptContent) => {
        writtenPromptContent = promptContent;
        return ".archon/work/daemon/interactive-resume-request.json";
      },
      claimLease: async () => ({ granted: true, runId: "run-e2e", owner: "interactive" })
    };

    const result = await handleInteractiveStop(deps);
    assert.equal(result.action, "resume_request_written");
    assert.ok(writtenPromptContent !== undefined, "promptContent must be passed to writer");
    assert.ok(
      writtenPromptContent!.includes(expectedPrompt),
      `written promptContent must include buildContinuationPrompt output.\nExpected to include: ${expectedPrompt}\nGot: ${writtenPromptContent}`
    );
  });
});

// ---------------------------------------------------------------------------
// handleInteractiveStop — daemon lease denial is a hard no-op (BLOCKING-3)
// ---------------------------------------------------------------------------

describe("handleInteractiveStop — daemon lease denial (BLOCKING-3)", () => {
  it("does NOT call writeResumeRequest when lease claim is denied", async () => {
    let writeCallCount = 0;
    const deps = makeDeps({
      claimLease: async () => ({
        granted: false,
        runId: "run-test",
        currentOwner: "daemon"
      }),
      writeResumeRequest: async (_cwd, _req, _promptContent) => {
        writeCallCount++;
        return ".archon/work/daemon/interactive-resume-request.json";
      }
    });

    const result = await handleInteractiveStop(deps);
    assert.equal(result.action, "no_action");
    assert.equal(result.reason, "lease_denied");
    assert.equal(writeCallCount, 0, "writer must NOT be called when lease is denied (BLOCKING-3)");
  });
});
