// Coverage gap follow-up (audit auditDebt202607 §3.6 / F8, gate round 2):
//
// 1. src/daemon.ts:498 — withDaemonLock's EEXIST contention catch branch had zero
//    test coverage. Covers: a second lock attempt while the first is held rejects
//    with the clean contention error, AND a non-EEXIST writeFile failure is
//    re-thrown as-is (not swallowed, not re-wrapped).
// 2. src/daemon/supervisor-actions.ts:290 — writeSupervisorReviewAction had zero
//    tests while its sibling writeSupervisorOperatorContinuationAction is
//    exercised indirectly via daemon-supervisor.test.ts. Adds the happy-path test,
//    matching the sibling's coverage pattern (real tmp dir, JSON round-trip,
//    returned relative path).

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withDaemonLock } from "../src/daemon.ts";
import { writeSupervisorReviewAction } from "../src/daemon/supervisor-actions.ts";

test("withDaemonLock: second attempt while the lock is held rejects with a clean contention error", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-daemon-lock-"));

  // First caller acquires the lock and holds it open (does not resolve fn yet).
  let releaseFirst: (() => void) | undefined;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstLockPromise = withDaemonLock(cwd, async () => {
    await firstHeld;
    return "first-done";
  });

  // Give the first writeFile a moment to land before the contending attempt.
  await new Promise((resolve) => setTimeout(resolve, 20));

  await assert.rejects(
    () => withDaemonLock(cwd, async () => "should-not-run"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /archon daemon lock already exists/);
      assert.match(error.message, /daemon\.lock/);
      return true;
    }
  );

  releaseFirst?.();
  assert.equal(await firstLockPromise, "first-done");

  await rm(cwd, { recursive: true, force: true });
});

test("withDaemonLock: a non-EEXIST write failure is re-thrown as-is, not swallowed or re-wrapped", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-daemon-lock-"));
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });
  // Note: opening the lock path with O_CREAT|O_EXCL ("wx") against a path that
  // already exists (even as a directory) fails with EEXIST regardless of type —
  // so a pre-existing daemon.lock directory does NOT reach the non-EEXIST branch.
  // To exercise `throw error;` we need writeFile itself to fail with something
  // else: strip write permission from daemonDir so O_CREAT fails with EACCES.
  await chmod(daemonDir, 0o555);

  try {
    await assert.rejects(
      () => withDaemonLock(cwd, async () => "unreachable"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // Re-thrown verbatim: must NOT be the contention message from the EEXIST branch.
        assert.doesNotMatch(error.message, /archon daemon lock already exists/);
        assert.equal((error as NodeJS.ErrnoException).code, "EACCES");
        return true;
      }
    );
  } finally {
    // Restore write permission before cleanup so rm(recursive) can remove the tree.
    await chmod(daemonDir, 0o755);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("withDaemonLock: releases the lock on success so a subsequent acquisition succeeds", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-daemon-lock-"));

  const first = await withDaemonLock(cwd, async () => "ok-1");
  assert.equal(first, "ok-1");

  // Lock file must be gone after a clean release; a fresh acquisition succeeds.
  const second = await withDaemonLock(cwd, async () => "ok-2");
  assert.equal(second, "ok-2");

  await rm(cwd, { recursive: true, force: true });
});

test("writeSupervisorReviewAction: happy path writes a passed-review action file and returns its relative path", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-supervisor-review-action-"));
  const reviewInputDir = path.join(cwd, ".archon", "review-actions");

  const relativePath = await writeSupervisorReviewAction({
    cwd,
    reviewInputDir,
    runId: "run-1",
    taskId: "task-1",
    reviewRole: "reviewer",
    actor: "local-supervisor",
    cycle: 1,
    nowValue: "2026-07-05T00:00:00.000Z"
  });

  assert.match(relativePath, /^\.archon[/\\]review-actions[/\\]supervisor-01-run-1-task-1-reviewer-/);

  const written = JSON.parse(await readFile(path.join(cwd, relativePath), "utf8")) as {
    runId: string;
    taskId: string;
    actor: string;
    review: { reviewerRole: string; state: string; severity: string; findings: unknown[] };
    authContext?: unknown;
    supervisor: { kind: string; generatedAt: string };
  };

  assert.equal(written.runId, "run-1");
  assert.equal(written.taskId, "task-1");
  assert.equal(written.actor, "local-supervisor");
  assert.deepEqual(written.review, {
    reviewerRole: "reviewer",
    state: "passed",
    severity: "low",
    findings: []
  });
  assert.equal(written.authContext, undefined, "authContext must be omitted when not provided");
  assert.equal(written.supervisor.kind, "local_supervisor");
  assert.equal(written.supervisor.generatedAt, "2026-07-05T00:00:00.000Z");

  await rm(cwd, { recursive: true, force: true });
});

test("writeSupervisorReviewAction: creates reviewInputDir when absent and includes authContext when provided", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-supervisor-review-action-"));
  const reviewInputDir = path.join(cwd, ".archon", "review-actions");

  // Precondition: directory does not exist yet.
  await assert.rejects(() => readFile(reviewInputDir, "utf8"));

  const relativePath = await writeSupervisorReviewAction({
    cwd,
    reviewInputDir,
    runId: "run-2",
    taskId: "task-2",
    reviewRole: "security_reviewer",
    actor: "local-supervisor",
    authContext: { provider: "github", subject: "octocat", verified: true },
    cycle: 3,
    nowValue: "2026-07-05T01:02:03.000Z"
  });

  const written = JSON.parse(await readFile(path.join(cwd, relativePath), "utf8")) as {
    authContext?: { provider: string; subject: string; verified: boolean };
  };
  assert.deepEqual(written.authContext, { provider: "github", subject: "octocat", verified: true });

  await rm(cwd, { recursive: true, force: true });
});
