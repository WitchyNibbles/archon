/**
 * RED-first regression test for closureLoop bug 2 (audit auditDebt202607):
 *
 * `sync-runtime-exports` read the stored task-queue snapshot in
 * project_runtime_state directly. After a run was sealed (run done, task done),
 * that snapshot could still say project_status: in_progress with a dangling
 * current_task_id, so the command exported stale in_progress state for a
 * finished run (live 2026-07-04: sealed run eca0047f still exported in_progress).
 *
 * Fix: derive exports from the LIVE run+task snapshot. A sealed run must export
 * project_status: done and current_task_id: null.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeSyncRuntimeExportsCommandFromArgs } from "../src/workflow.ts";
import type {
  ProjectRecord,
  ProjectRuntimeStateRecord,
  RunRecord,
  RunStatusSnapshot,
  TaskRecord,
  WorkspaceRecord
} from "../src/domain/types.ts";

const WORKSPACE: WorkspaceRecord = { id: "ws", slug: "test-ws", name: "Test WS", createdAt: "t" };
const PROJECT: ProjectRecord = {
  id: "proj",
  workspaceId: "ws",
  slug: "test-proj",
  name: "Test Proj",
  repoPath: "/tmp/fake",
  createdAt: "t"
};

function task(id: string, status: TaskRecord["status"]): TaskRecord {
  return {
    id: `uuid-${id}`,
    runId: "run-sealed",
    workspaceId: "ws",
    projectId: "proj",
    class: "prototype_slice",
    status,
    claimedBy: "manager",
    createdAt: "t",
    updatedAt: "t",
    packet: {
      taskId: id,
      title: id,
      ownerRole: "backend_engineer",
      completionStandard: "artifact_complete",
      requiredSpecialistRoles: [],
      qualityGates: [],
      goal: "g",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope: ["src"],
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews: [],
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: ""
    }
  };
}

function sealedSnapshot(): RunStatusSnapshot {
  const run: RunRecord = {
    id: "run-sealed",
    workspaceId: "ws",
    projectId: "proj",
    actor: "manager",
    title: "r",
    request: "r",
    summary: {
      goal: "g", audience: [], constraints: [], risks: [], unknowns: [], successCriteria: [],
      outOfScope: [], trustBoundaries: [], destructiveActions: [], externalIntegrations: [], stopGo: "go"
    },
    status: "done",
    createdAt: "t",
    updatedAt: "t"
  };
  return { run, tasks: [task("t1", "done")], activeLocks: [], blockers: [], nextTaskIds: [] };
}

// A deliberately STALE stored snapshot: still in_progress, current task set — the
// exact corruption the sealed run should override.
function staleRuntimeState(): ProjectRuntimeStateRecord {
  return {
    projectId: "proj",
    workspaceId: "ws",
    activeRunId: "run-sealed",
    activeTaskId: "t1",
    taskQueue: {
      project_status: "in_progress",
      current_task_id: "t1",
      tasks: [
        {
          id: "t1",
          title: "t1",
          status: "in_progress",
          class: "prototype_slice",
          depends_on: [],
          acceptance_criteria: [],
          verification: [],
          evidence: [],
          blocker: null
        }
      ]
    },
    productState: {},
    // A genuinely sealed run has been verified — required to export a done status.
    lastVerifiedRunId: "run-sealed",
    metadata: {},
    createdAt: "t",
    updatedAt: "t"
  };
}

test("sync-runtime-exports: sealed run exports done / current_task_id null from live rows", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "archon-sync-exports-"));
  try {
    const { result } = await executeSyncRuntimeExportsCommandFromArgs(["--format", "json"], {
      cwd: tmp,
      env: { ARCHON_WORKSPACE_SLUG: "test-ws", ARCHON_PROJECT_SLUG: "test-proj" },
      getProjectContext: async () => ({ workspace: WORKSPACE, project: PROJECT }),
      getProjectRuntimeState: async () => staleRuntimeState(),
      getStatusSnapshot: async () => sealedSnapshot()
    });

    assert.equal(result.queue.project_status, "done", "sealed run must export project_status: done");
    assert.equal(result.queue.current_task_id, null, "sealed run must export current_task_id: null");
    assert.equal(result.activeTaskId, null, "sealed run must export a null active task");
    assert.equal(result.queue.tasks[0]!.status, "done", "the task must export as done, not in_progress");

    // The on-disk exports must agree with the authoritative state, not the stale snapshot.
    const written = JSON.parse(await readFile(path.join(tmp, ".archon", "work", "task-queue.json"), "utf8"));
    assert.equal(written.project_status, "done");
    assert.equal(written.current_task_id, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("sync-runtime-exports: falls back to the stored snapshot when no snapshot service is wired", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "archon-sync-exports-fallback-"));
  try {
    const { result } = await executeSyncRuntimeExportsCommandFromArgs(["--format", "json"], {
      cwd: tmp,
      env: { ARCHON_WORKSPACE_SLUG: "test-ws", ARCHON_PROJECT_SLUG: "test-proj" },
      getProjectContext: async () => ({ workspace: WORKSPACE, project: PROJECT }),
      getProjectRuntimeState: async () => staleRuntimeState()
      // getStatusSnapshot intentionally omitted
    });

    // Without a live snapshot the command faithfully reflects the stored snapshot
    // (backward-compatible behavior — the authoritative path is opt-in via the dep).
    assert.equal(result.queue.project_status, "in_progress");
    assert.equal(result.activeTaskId, "t1");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
