/**
 * Alias + dispatcher-wiring coverage for the closureLoop paper cuts
 * (audit auditDebt202607):
 *   - reconcile-runtime-state accepts --confirm as an alias for --apply.
 *   - the `archon` dispatcher (src/admin/archon.ts) routes `init-task`, so the
 *     hook unblock hint `npm run archon -- init-task …` actually works.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { executeReconcileRuntimeStateCommandFromArgs } from "../src/runtime.ts";
import type { ProjectRecord, WorkspaceRecord } from "../src/domain/types.ts";

const WORKSPACE: WorkspaceRecord = { id: "ws", slug: "test-ws", name: "WS", createdAt: "t" };
const PROJECT: ProjectRecord = { id: "proj", workspaceId: "ws", slug: "test-proj", name: "P", createdAt: "t" };

function baseReconcileDeps(cwd: string) {
  const unused = () => {
    throw new Error("dependency should not be called on the no-run early-return path");
  };
  return {
    cwd,
    env: { ARCHON_WORKSPACE_SLUG: "test-ws", ARCHON_PROJECT_SLUG: "test-proj" },
    getProjectContext: async () => ({ workspace: WORKSPACE, project: PROJECT }),
    getProjectRuntimeState: async () => undefined,
    saveProjectRuntimeState: async () => {},
    findLatestRun: async () => undefined,
    getStatusSnapshot: unused as never,
    getExecutionPlan: unused as never,
    applyRecovery: unused as never
  };
}

test("reconcile-runtime-state: --confirm is accepted as an alias for --apply", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "archon-reconcile-alias-"));
  try {
    const { result } = await executeReconcileRuntimeStateCommandFromArgs(["--confirm"], baseReconcileDeps(tmp));
    assert.equal(result.mode, "applied", "--confirm must trigger the mutate (applied) mode");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("reconcile-runtime-state: --apply still means applied (no regression)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "archon-reconcile-apply-"));
  try {
    const { result } = await executeReconcileRuntimeStateCommandFromArgs(["--apply"], baseReconcileDeps(tmp));
    assert.equal(result.mode, "applied");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("reconcile-runtime-state: no mutate flag stays a dry_run", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "archon-reconcile-dry-"));
  try {
    const { result } = await executeReconcileRuntimeStateCommandFromArgs([], baseReconcileDeps(tmp));
    assert.equal(result.mode, "dry_run");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("archon dispatcher: init-task is registered so `archon init-task` routes to admin.ts", async () => {
  const src = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/admin/archon.ts"),
    "utf8"
  );
  assert.ok(src.includes('"init-task"'), 'archon.ts must include "init-task" in adminCommands');
});
