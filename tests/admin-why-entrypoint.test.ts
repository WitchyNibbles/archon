import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emit, runWhyDiagnosis, type RunWhyDiagnosisDeps } from "../src/admin/why.ts";
import type { RunStatusSnapshot, TaskRecord } from "../src/domain/types.ts";

// Audit F9 review (QA finding): whyCommand entrypoint coverage. `runWhyDiagnosis`
// is the withClient-independent orchestration core extracted specifically so
// this is testable without a real database — it exercises the same wiring
// `whyCommand` uses (status assembly, snapshot capture, runtime-state fetch,
// collector call, diagnosis) end to end, plus the no-run healthy fallback and
// error-propagation paths that only live at this boundary.

function taskRecord(taskId: string, status: TaskRecord["status"]): TaskRecord {
  return {
    id: `id-${taskId}`,
    runId: "run-1",
    workspaceId: "workspace:w",
    projectId: "project:w:p",
    class: "delivery",
    status,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    packet: {
      taskId,
      title: taskId,
      ownerRole: "backend_engineer",
      completionStandard: "production_ready",
      requiredSpecialistRoles: [],
      qualityGates: [],
      goal: "g",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope: [],
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews: ["reviewer", "security_reviewer", "qa_engineer"],
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: ""
    } as TaskRecord["packet"]
  };
}

function snapshot(tasks: TaskRecord[]): RunStatusSnapshot {
  return {
    run: {
      id: "run-1",
      workspaceId: "workspace:w",
      projectId: "project:w:p",
      actor: "orchestrator",
      title: "t",
      request: "r",
      summary: { goal: "g", constraints: [], risks: [], successCriteria: [] } as RunStatusSnapshot["run"]["summary"],
      status: "in_progress",
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z"
    },
    tasks,
    activeLocks: [],
    blockers: [],
    nextTaskIds: []
  };
}

function neverCalled(name: string) {
  return async (...args: unknown[]): Promise<never> => {
    throw new Error(`${name} should not have been called (args: ${JSON.stringify(args)})`);
  };
}

function baseDeps(overrides: Partial<RunWhyDiagnosisDeps> = {}, cwd: string): RunWhyDiagnosisDeps {
  return {
    cwd,
    now: "2026-07-05T00:00:00.000Z",
    env: {},
    findLatestRun: neverCalled("findLatestRun") as RunWhyDiagnosisDeps["findLatestRun"],
    getStatusSnapshot: neverCalled("getStatusSnapshot") as RunWhyDiagnosisDeps["getStatusSnapshot"],
    getProjectRuntimeState: async () => undefined,
    getExecutionPlan: neverCalled("getExecutionPlan") as RunWhyDiagnosisDeps["getExecutionPlan"],
    getReviews: async () => [],
    getApprovals: async () => [],
    getReviewFloorReductions: async () => [],
    readLeaseOwner: async () => undefined,
    respawnBudget: 8,
    getOrphanInputs: async () => ({ tasks: [], reviewCounts: [], approvalCounts: [] }),
    readContextGuard: async () => undefined,
    readHookBlocker: async () => undefined,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// emit() — the --json vs human output selection.
// ---------------------------------------------------------------------------

test("emit: --json true calls console.log with JSON.stringify(diagnosis)", () => {
  const diagnosis = { authorityLabel: "derived_only" as const, now: "t", scope: {}, stuck: false, causes: [] };
  const calls: unknown[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => calls.push(args);
  try {
    emit(diagnosis, true);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(calls, [[JSON.stringify(diagnosis)]]);
});

test("emit: --json false writes the human-readable render to stdout", () => {
  const diagnosis = { authorityLabel: "derived_only" as const, now: "t", scope: {}, stuck: false, causes: [] };
  const writes: unknown[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown) => {
    writes.push(chunk);
    return true;
  };
  try {
    emit(diagnosis, false);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(writes.length, 1);
  assert.match(String(writes[0]), /Nothing is stuck/);
});

// ---------------------------------------------------------------------------
// runWhyDiagnosis — no-run healthy fallback (both trigger phrasings).
// ---------------------------------------------------------------------------

test("runWhyDiagnosis: findLatestRun resolves nothing → healthy no-run diagnosis, not an error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "archon-why-entry-"));
  try {
    const deps = baseDeps(
      {
        env: { ARCHON_WORKSPACE_SLUG: "w", ARCHON_PROJECT_SLUG: "p" },
        findLatestRun: async () => undefined
      },
      cwd
    );
    const diagnosis = await runWhyDiagnosis(["--run-id", "latest"], deps);
    assert.equal(diagnosis.stuck, false);
    assert.match(diagnosis.healthy!.summaryLines[0]!, /No active run/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runWhyDiagnosis: no --run-id and no workspace/project → healthy no-run diagnosis (findLatestRun never called)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "archon-why-entry-"));
  try {
    const deps = baseDeps({ env: {} }, cwd);
    const diagnosis = await runWhyDiagnosis([], deps);
    assert.equal(diagnosis.stuck, false);
    assert.match(diagnosis.healthy!.summaryLines[0]!, /No active run/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runWhyDiagnosis — full wiring: proves the withClient-independent core
// correctly threads a real stuck scenario (a blocked task) through status
// assembly → collector → ranker, end to end.
// ---------------------------------------------------------------------------

test("runWhyDiagnosis: full wiring surfaces a blocked task as a stuck diagnosis", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "archon-why-entry-"));
  try {
    const runSnapshot = snapshot([taskRecord("t1", "blocked")]);
    const deps = baseDeps(
      {
        env: { ARCHON_WORKSPACE_SLUG: "w", ARCHON_PROJECT_SLUG: "p" },
        findLatestRun: async () => ({ id: "run-1" }),
        getStatusSnapshot: async (runId: string) => {
          assert.equal(runId, "run-1");
          return runSnapshot;
        },
        getExecutionPlan: async (runId: string) => ({
          mode: "runtime_authoritative",
          runId,
          runStatus: "in_progress",
          directive: { kind: "blocked", rationale: [], blockers: [] }
        })
      },
      cwd
    );

    const diagnosis = await runWhyDiagnosis([], deps);
    assert.equal(diagnosis.stuck, true);
    const blockedCause = diagnosis.causes.find((c) => c.id === "task_blocked");
    assert.ok(blockedCause, "expected the blocked task to surface as a task_blocked cause");
    assert.deepEqual(blockedCause!.evidence.values.tasks, ["t1"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runWhyDiagnosis — unrelated errors are NOT swallowed as "healthy".
// ---------------------------------------------------------------------------

test("runWhyDiagnosis: an unrelated thrown error propagates rather than being treated as no-run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "archon-why-entry-"));
  try {
    const deps = baseDeps(
      {
        env: { ARCHON_WORKSPACE_SLUG: "w", ARCHON_PROJECT_SLUG: "p" },
        findLatestRun: async () => {
          throw new Error("connection refused");
        }
      },
      cwd
    );
    await assert.rejects(() => runWhyDiagnosis(["--run-id", "latest"], deps), /connection refused/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
