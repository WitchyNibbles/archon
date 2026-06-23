// Tests for createDaemonRuntimeReconcile (daemon split 6m).
//
// The factory returns a (cycle: number) => Promise<...> function that must:
//   1. Call reconcileRuntimeState (injected) in preview mode first
//   2. Return undefined when runtimeStateChanged is false OR repairAction is not
//      in the allowed set
//   3. Call reconcileRuntimeState again with --apply when shouldApply is true
//   4. Push a cycle record using getSessionId() live (not a snapshot)
//   5. Return the applied ReconcileRuntimeStateCommandResult
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDaemonRuntimeReconcile } from "../src/daemon/runtime-reconcile.ts";
import type { ReconcileRuntimeStateFn } from "../src/daemon/runtime-reconcile.ts";
import type { DaemonCycleRecord } from "../src/daemon.ts";
import type { ReconcileRuntimeStateCommandResult } from "../src/runtime.ts";

// Minimal stub for ExecuteReconcileRuntimeStateCommandOptions — the factory
// only forwards it to reconcileRuntimeState, which is fully injected here.
const fakeOptions = {} as Parameters<ReconcileRuntimeStateFn>[1];

function makePreviewResult(
  overrides: Partial<ReconcileRuntimeStateCommandResult> = {}
): ReconcileRuntimeStateCommandResult {
  return {
    runtimeStateChanged: false,
    repairAction: "none",
    activeRunId: null,
    activeTaskId: null,
    executionPlanDirectiveKind: undefined,
    reason: "no change needed",
    ...overrides
  };
}

describe("createDaemonRuntimeReconcile", () => {
  it("returns a function", () => {
    const cycles: DaemonCycleRecord[] = [];
    const fn = createDaemonRuntimeReconcile({
      workspaceSlug: "ws",
      projectSlug: "proj",
      staleAfterHours: 24,
      options: fakeOptions,
      cycles,
      getSessionId: () => undefined,
      reconcileRuntimeState: async () => ({ format: "json", result: makePreviewResult() })
    });
    assert.equal(typeof fn, "function");
  });

  it("returns undefined when runtimeStateChanged is false", async () => {
    const cycles: DaemonCycleRecord[] = [];
    let callCount = 0;

    const fn = createDaemonRuntimeReconcile({
      workspaceSlug: "ws",
      projectSlug: "proj",
      staleAfterHours: 24,
      options: fakeOptions,
      cycles,
      getSessionId: () => undefined,
      reconcileRuntimeState: async () => {
        callCount++;
        return { format: "json" as const, result: makePreviewResult({ runtimeStateChanged: false, repairAction: "none" }) };
      }
    });

    const result = await fn(1);
    assert.equal(result, undefined);
    // Only the preview call should have been made
    assert.equal(callCount, 1);
    assert.equal(cycles.length, 0);
  });

  it("returns undefined when repairAction is not in the allowed set", async () => {
    const cycles: DaemonCycleRecord[] = [];
    let callCount = 0;

    const fn = createDaemonRuntimeReconcile({
      workspaceSlug: "ws",
      projectSlug: "proj",
      staleAfterHours: 24,
      options: fakeOptions,
      cycles,
      getSessionId: () => undefined,
      reconcileRuntimeState: async () => {
        callCount++;
        return {
          format: "json" as const,
          result: makePreviewResult({
            runtimeStateChanged: true,
            // "none" is NOT in the allowed apply set
            repairAction: "none"
          })
        };
      }
    });

    const result = await fn(1);
    assert.equal(result, undefined);
    assert.equal(callCount, 1);
    assert.equal(cycles.length, 0);
  });

  it("applies and pushes cycle when rebuild_missing_runtime_state is warranted", async () => {
    const cycles: DaemonCycleRecord[] = [];
    const callArgs: Array<readonly string[]> = [];
    const sessionId = "sess-xyz";

    const applyResult = makePreviewResult({
      runtimeStateChanged: true,
      repairAction: "rebuild_missing_runtime_state",
      activeRunId: "run-apply",
      activeTaskId: "task-apply",
      executionPlanDirectiveKind: "run_codex_owner",
      reason: "runtime state was missing"
    });

    const reconcileRuntimeState: ReconcileRuntimeStateFn = async (args) => {
      callArgs.push(args);
      const isApply = args.includes("--apply");
      return { format: "json" as const, result: isApply ? applyResult : makePreviewResult({ runtimeStateChanged: true, repairAction: "rebuild_missing_runtime_state" }) };
    };

    const fn = createDaemonRuntimeReconcile({
      workspaceSlug: "my-ws",
      projectSlug: "my-proj",
      staleAfterHours: 48,
      options: fakeOptions,
      cycles,
      getSessionId: () => sessionId,
      reconcileRuntimeState
    });

    const result = await fn(3);

    // Must have been called twice (preview + apply)
    assert.equal(callArgs.length, 2);

    // Preview call: no --apply flag
    assert.ok(!callArgs[0].includes("--apply"));
    assert.ok(callArgs[0].includes("--workspace-slug"));
    assert.ok(callArgs[0].includes("my-ws"));
    assert.ok(callArgs[0].includes("--project-slug"));
    assert.ok(callArgs[0].includes("my-proj"));
    assert.ok(callArgs[0].includes("--stale-after-hours"));
    assert.ok(callArgs[0].includes("48"));

    // Apply call: has --apply flag
    assert.ok(callArgs[1].includes("--apply"));

    // Cycle record pushed
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].cycle, 3);
    assert.equal(cycles[0].action, "reconcile_runtime_state");
    assert.equal(cycles[0].runId, "run-apply");
    assert.equal(cycles[0].taskId, "task-apply");
    assert.equal(cycles[0].sessionId, "sess-xyz");
    assert.equal(cycles[0].directiveKind, "run_codex_owner");
    assert.match(cycles[0].summary, /rebuild_missing_runtime_state/);

    // Returns the applied result
    assert.equal(result, applyResult);
  });

  it("applies when sync_active_task_to_in_progress is warranted", async () => {
    const cycles: DaemonCycleRecord[] = [];

    const applyResult = makePreviewResult({
      runtimeStateChanged: true,
      repairAction: "sync_active_task_to_in_progress",
      activeRunId: "run-b",
      activeTaskId: "task-b",
      reason: "task was not in_progress"
    });

    const fn = createDaemonRuntimeReconcile({
      workspaceSlug: "ws",
      projectSlug: "proj",
      staleAfterHours: 24,
      options: fakeOptions,
      cycles,
      getSessionId: () => undefined,
      reconcileRuntimeState: async (args) => {
        const isApply = args.includes("--apply");
        return { format: "json" as const, result: isApply ? applyResult : makePreviewResult({ runtimeStateChanged: true, repairAction: "sync_active_task_to_in_progress" }) };
      }
    });

    const result = await fn(5);
    assert.equal(result, applyResult);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].action, "reconcile_runtime_state");
  });

  it("applies when activate_owner_dispatch_target is warranted", async () => {
    const cycles: DaemonCycleRecord[] = [];

    const applyResult = makePreviewResult({
      runtimeStateChanged: true,
      repairAction: "activate_owner_dispatch_target",
      activeRunId: "run-c",
      activeTaskId: "task-c",
      reason: "dispatch target activated"
    });

    const fn = createDaemonRuntimeReconcile({
      workspaceSlug: "ws",
      projectSlug: "proj",
      staleAfterHours: 24,
      options: fakeOptions,
      cycles,
      getSessionId: () => undefined,
      reconcileRuntimeState: async (args) => {
        const isApply = args.includes("--apply");
        return { format: "json" as const, result: isApply ? applyResult : makePreviewResult({ runtimeStateChanged: true, repairAction: "activate_owner_dispatch_target" }) };
      }
    });

    const result = await fn(7);
    assert.equal(result, applyResult);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].action, "reconcile_runtime_state");
  });

  it("uses activeRunId ?? 'none' when activeRunId is null", async () => {
    const cycles: DaemonCycleRecord[] = [];

    const applyResult = makePreviewResult({
      runtimeStateChanged: true,
      repairAction: "rebuild_missing_runtime_state",
      activeRunId: null,
      activeTaskId: null,
      reason: "missing"
    });

    const fn = createDaemonRuntimeReconcile({
      workspaceSlug: "ws",
      projectSlug: "proj",
      staleAfterHours: 24,
      options: fakeOptions,
      cycles,
      getSessionId: () => undefined,
      reconcileRuntimeState: async (args) => {
        const isApply = args.includes("--apply");
        return { format: "json" as const, result: isApply ? applyResult : makePreviewResult({ runtimeStateChanged: true, repairAction: "rebuild_missing_runtime_state" }) };
      }
    });

    await fn(2);
    assert.equal(cycles[0].runId, "none");
    assert.equal(cycles[0].taskId, null);
  });

  it("reads getSessionId() live at push time — not as a captured snapshot", async () => {
    const cycles: DaemonCycleRecord[] = [];
    let sessionId: string | undefined = "initial";

    const applyResult = makePreviewResult({
      runtimeStateChanged: true,
      repairAction: "rebuild_missing_runtime_state",
      activeRunId: "run-d",
      activeTaskId: "task-d",
      reason: "missing"
    });

    const fn = createDaemonRuntimeReconcile({
      workspaceSlug: "ws",
      projectSlug: "proj",
      staleAfterHours: 24,
      options: fakeOptions,
      cycles,
      getSessionId: () => sessionId,
      reconcileRuntimeState: async (args) => {
        // Simulate session id change mid-run (between preview and apply)
        sessionId = "updated";
        const isApply = args.includes("--apply");
        return { format: "json" as const, result: isApply ? applyResult : makePreviewResult({ runtimeStateChanged: true, repairAction: "rebuild_missing_runtime_state" }) };
      }
    });

    await fn(9);
    // The cycle record must see "updated" (the value at push time)
    assert.equal(cycles[0].sessionId, "updated");
  });
});
