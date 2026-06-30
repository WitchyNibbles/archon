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
import { executeInitTaskCommand, initTaskCommand } from "../src/admin/init-task.ts";

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

// ---------------------------------------------------------------------------
// Test 5 (branch B4): reuse with --update-scope but an IDENTICAL scope is a
//         no-op liveness bump — scope unchanged, not flagged as preserved.
// ---------------------------------------------------------------------------

test("init-task scope-update: --update-scope with identical scope is a no-op", async () => {
  const store = new MemoryStore();
  await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin", "tests"] }));

  const result2 = await executeInitTaskCommand(
    baseOpts(store, { allowedWriteScope: ["tests", "src/admin"], updateScope: true })
  );

  assert.equal(result2.scopePreserved, false, "identical scope is never a preserve event");
  assert.deepEqual(
    result2.allowedWriteScope,
    ["src/admin", "tests"],
    "scope is unchanged and retains its persisted order"
  );

  const state = await store.getProjectRuntimeState(PROJECT_ID);
  const task = await store.getTask(state!.activeRunId!, "scoped-task");
  assert.deepEqual(task!.packet.allowedWriteScope, ["src/admin", "tests"]);
});

// ---------------------------------------------------------------------------
// Test 6: NARROWING is gated symmetrically — preserve covers both directions.
// ---------------------------------------------------------------------------

test("init-task scope-update: narrowing without --update-scope is preserved", async () => {
  const store = new MemoryStore();
  await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin", "tests"] }));

  // Request a NARROWER scope, no flag.
  const result2 = await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin"] }));

  assert.equal(result2.scopePreserved, true, "an ignored narrowing must be flagged like an ignored widening");
  assert.deepEqual(
    result2.allowedWriteScope,
    ["src/admin", "tests"],
    "existing (wider) scope is preserved when --update-scope is absent"
  );

  const state = await store.getProjectRuntimeState(PROJECT_ID);
  const task = await store.getTask(state!.activeRunId!, "scoped-task");
  assert.deepEqual(task!.packet.allowedWriteScope, ["src/admin", "tests"]);
});

test("init-task scope-update: narrowing with --update-scope applies the narrower scope", async () => {
  const store = new MemoryStore();
  await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin", "tests"] }));

  const result2 = await executeInitTaskCommand(
    baseOpts(store, { allowedWriteScope: ["src/admin"], updateScope: true })
  );

  assert.equal(result2.scopePreserved, false);
  assert.deepEqual(result2.allowedWriteScope, ["src/admin"], "scope narrowed when --update-scope is passed");

  const state = await store.getProjectRuntimeState(PROJECT_ID);
  const task = await store.getTask(state!.activeRunId!, "scoped-task");
  assert.deepEqual(task!.packet.allowedWriteScope, ["src/admin"]);
});

// ---------------------------------------------------------------------------
// Test 7: duplicate entries must not mask a genuine scope change
//         (sameScopeSet duplicate-entry regression — reviewer MEDIUM).
// ---------------------------------------------------------------------------

test("init-task scope-update: duplicate entries do not mask a real change under --update-scope", async () => {
  const store = new MemoryStore();
  // Existing scope: two DISTINCT paths.
  await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin", "tests"] }));

  // Requested scope: ["src/admin","src/admin"] — same RAW LENGTH (2) as existing
  // but a different distinct set {src/admin}. The old length-only sameScopeSet
  // returned true here and silently dropped the narrowing even with the flag.
  const result2 = await executeInitTaskCommand(
    baseOpts(store, { allowedWriteScope: ["src/admin", "src/admin"], updateScope: true })
  );

  assert.equal(result2.scopePreserved, false, "a real set change must not be masked by duplicate entries");
  const state = await store.getProjectRuntimeState(PROJECT_ID);
  const task = await store.getTask(state!.activeRunId!, "scoped-task");
  assert.ok(
    !task!.packet.allowedWriteScope.includes("tests"),
    "narrowing must be applied: 'tests' must no longer be in scope, proving the change was detected"
  );
});

// ---------------------------------------------------------------------------
// Test 8: the dangerous managed-scope guard fires on the REUSE path too — a
//         repeated call cannot smuggle a control-layer scope without the
//         explicit --allow-managed-scope opt-in (qa integration gap).
// ---------------------------------------------------------------------------

test("init-task scope-update: managed-scope guard fires on the reuse path", async () => {
  const store = new MemoryStore();
  // Establish a live task with an ordinary scope.
  await executeInitTaskCommand(baseOpts(store, { allowedWriteScope: ["src/admin"] }));

  // Reuse call requesting a control-layer scope without --allow-managed-scope.
  await assert.rejects(
    executeInitTaskCommand(
      baseOpts(store, { allowedWriteScope: [".claude"], updateScope: true })
    ),
    /control-layer scope/,
    "reuse must not bypass the managed-scope guard"
  );

  // The live task's scope must be untouched after the rejected call.
  const state = await store.getProjectRuntimeState(PROJECT_ID);
  const task = await store.getTask(state!.activeRunId!, "scoped-task");
  assert.deepEqual(task!.packet.allowedWriteScope, ["src/admin"], "scope unchanged after a rejected reuse");
});

// ---------------------------------------------------------------------------
// Test 9: CLI flag wiring — `--update-scope` parsed by initTaskCommand actually
//         reaches the reuse path (qa LOW: parsing was previously untested).
// ---------------------------------------------------------------------------

test("init-task scope-update: CLI --update-scope threads through initTaskCommand", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (msg?: unknown) => void logs.push(String(msg));
  console.warn = (msg?: unknown) => void logs.push(String(msg));

  const tmpRepo = await mkdtemp(nodePath.join(os.tmpdir(), "archon-init-cli-"));
  try {
    const store = new MemoryStore();
    const env: NodeJS.ProcessEnv = {
      ARCHON_PROJECT_SLUG: "test-proj",
      ARCHON_PROJECT_NAME: "Test Project",
      ARCHON_WORKSPACE_SLUG: "test-ws",
      ARCHON_WORKSPACE_NAME: "Test Workspace"
    };
    const deps = {
      withClient: <T>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(null),
      createStore: () => store,
      env,
      cwd: tmpRepo
    };
    const baseArgs = ["--id", "cli-task", "--owner", "backend_engineer", "--goal", "cli wiring"];
    const activeTask = async () =>
      store.getTask((await store.getProjectRuntimeState(PROJECT_ID))!.activeRunId!, "cli-task");

    // Establish the task with a narrow scope.
    await initTaskCommand([...baseArgs, "--scope", "src/admin"], deps);

    // Reuse WITHOUT --update-scope: wider scope requested → must be preserved.
    await initTaskCommand([...baseArgs, "--scope", "src/admin,tests,docs"], deps);
    assert.deepEqual((await activeTask())!.packet.allowedWriteScope, ["src/admin"], "no flag → preserved");
    assert.ok(
      logs.some((l) => l.includes("PRESERVED")),
      "CLI must warn when a differing scope was preserved"
    );

    // Reuse WITH --update-scope: the flag must thread through and widen the scope.
    await initTaskCommand([...baseArgs, "--scope", "src/admin,tests", "--update-scope"], deps);
    assert.deepEqual(
      (await activeTask())!.packet.allowedWriteScope,
      ["src/admin", "tests"],
      "--update-scope → widened"
    );
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    await rm(tmpRepo, { recursive: true, force: true });
  }
});
