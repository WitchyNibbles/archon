/**
 * TDD tests for init-task explicit scope-widening on the reuse path
 * (initTaskExplicitScope — the #118 advisory).
 *
 * Problem: on the idempotent reuse path, executeInitTaskCommand silently
 * REPLACED an existing in-progress task's allowedWriteScope with whatever scope
 * the new call supplied. A repeated init-task call could therefore widen (or
 * narrow) the control-layer write scope of a live task without any explicit
 * operator intent — a quiet privilege change.
 *
 * Fix: on reuse, PRESERVE the existing scope by default. Only overwrite it when
 * the caller passes --update-scope (options.updateScope === true). The reuse
 * call still bumps updatedAt (liveness) and never creates duplicate rows.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory-store.ts";
import { executeInitTaskCommand } from "../src/admin/init-task.ts";

function baseOpts(
  store: MemoryStore,
  overrides: Partial<Parameters<typeof executeInitTaskCommand>[0]> = {}
): Parameters<typeof executeInitTaskCommand>[0] {
  return {
    store,
    workspaceSlug: "test-ws",
    workspaceName: "Test Workspace",
    projectSlug: "test-proj",
    projectName: "Test Project",
    repoPath: "/dev/null/fake-repo",
    id: "scoped-task",
    title: "Scoped Task",
    ownerRole: "backend_engineer",
    goal: "Test goal.",
    allowedWriteScope: ["src/admin"],
    writePacketMarkdown: false,
    ...overrides
  };
}

const PROJECT_ID = "project:test-ws:test-proj";

// ---------------------------------------------------------------------------
// Test 1: reuse WITHOUT --update-scope preserves the existing scope even when
//         the new call supplies a wider scope.
// ---------------------------------------------------------------------------

test("init-task scope-update: reuse without --update-scope preserves existing scope", async () => {
  const store = new MemoryStore();

  // First call establishes a narrow scope.
  const result1 = await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin"] }));
  assert.deepEqual(result1.allowedWriteScope, ["src/admin"]);

  // Second call supplies a WIDER scope but does NOT pass updateScope.
  // (A dangerous scope like `.claude` is rejected outright by the managed-scope
  // guard even before this preserve logic — covered separately; here we use an
  // ordinary wider scope to isolate the preserve-by-default behavior.)
  const result2 = await executeInitTaskCommand(
    baseOpts(store, { allowedWriteScope: ["src/admin", "tests", "docs"] })
  );

  // Same run reused.
  assert.equal(result2.runId, result1.runId, "must reuse the same run");

  // Scope must NOT have widened.
  assert.deepEqual(
    result2.allowedWriteScope,
    ["src/admin"],
    "existing scope must be preserved when --update-scope is not passed"
  );
  assert.equal(result2.scopePreserved, true, "scopePreserved must flag the ignored widening request");

  // The persisted task record must still carry the narrow scope.
  const state = await store.getProjectRuntimeState(PROJECT_ID);
  const task = await store.getTask(state!.activeRunId!, "scoped-task");
  assert.deepEqual(
    task!.packet.allowedWriteScope,
    ["src/admin"],
    "store record scope must be unchanged"
  );
});

// ---------------------------------------------------------------------------
// Test 2: reuse WITH --update-scope applies the new (wider) scope.
// ---------------------------------------------------------------------------

test("init-task scope-update: reuse with --update-scope applies the new scope", async () => {
  const store = new MemoryStore();

  await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin"] }));

  const result2 = await executeInitTaskCommand(
    baseOpts(store, { allowedWriteScope: ["src/admin", "tests"], updateScope: true })
  );

  assert.deepEqual(
    result2.allowedWriteScope,
    ["src/admin", "tests"],
    "scope must be widened when --update-scope is passed"
  );
  assert.equal(result2.scopePreserved, false, "scopePreserved must be false when the update is applied");

  const state = await store.getProjectRuntimeState(PROJECT_ID);
  const task = await store.getTask(state!.activeRunId!, "scoped-task");
  assert.deepEqual(task!.packet.allowedWriteScope, ["src/admin", "tests"]);
});

// ---------------------------------------------------------------------------
// Test 3: reuse with --update-scope but an identical scope is not a "preserved"
//         event (nothing to widen) — scopePreserved stays false.
// ---------------------------------------------------------------------------

test("init-task scope-update: identical scope on reuse is never flagged as preserved", async () => {
  const store = new MemoryStore();

  await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin", "tests"] }));

  // No updateScope flag, but the requested scope equals the existing one.
  const result2 = await executeInitTaskCommand(
    baseOpts(store, { allowedWriteScope: ["tests", "src/admin"] }) // same set, different order
  );

  assert.equal(
    result2.scopePreserved,
    false,
    "identical scope (order-insensitive) must not be flagged as a preserved widening"
  );
  assert.deepEqual(
    result2.allowedWriteScope,
    ["src/admin", "tests"],
    "scope is unchanged and retains its persisted order"
  );
});

// ---------------------------------------------------------------------------
// Test 4: a fresh cycle is never a "preserved" event.
// ---------------------------------------------------------------------------

test("init-task scope-update: fresh cycle reports scopePreserved=false", async () => {
  const store = new MemoryStore();
  const result = await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin"] }));
  assert.equal(result.scopePreserved, false, "fresh cycle is not a reuse-preserve event");
});
