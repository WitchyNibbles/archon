import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSupervisorOperatorNotes,
  executeSupervisorCommandFromArgs,
  formatSupervisorCommandResult,
  formatSupervisorHistoryCommandResult,
  parseSupervisorReviewActorBindings,
  resolveDaemonSupervisorHistoryReadOptions,
  resolveSupervisorHistoryRetentionLimit,
  writeDaemonContinuationStatus,
  writeDaemonOperatorHandoff,
  readDaemonSupervisorStatus,
  readDaemonSupervisorHistory
} from "../src/daemon.ts";
import type {
  DaemonCommandResult,
  ExecuteSupervisorCommandOptions,
  SupervisorCommandResult
} from "../src/daemon.ts";
import type { EnvShape } from "../src/workflow.ts";

// The supervisor was decoupled from the daemon loop in split 6a (the loop is injected
// via runDaemonCommand) and moved to its own module in 6b. These tests exercise it in
// isolation with a fake loop and a temp cwd — no Postgres, no real Claude turns.

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "archon-supervisor-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function blockedDaemonResult(reason: string): DaemonCommandResult {
  return {
    authorityLabel: "derived_only",
    workspaceSlug: "ws",
    projectSlug: "proj",
    status: "blocked",
    reason,
    activeRunId: "run-1",
    activeTaskId: "task-1",
    sessionId: "sess-1",
    cycles: []
  };
}

function completedDaemonResult(): DaemonCommandResult {
  return {
    authorityLabel: "derived_only",
    workspaceSlug: "ws",
    projectSlug: "proj",
    status: "completed",
    reason: "all tasks complete",
    activeRunId: "run-1",
    activeTaskId: null,
    sessionId: "sess-1",
    cycles: []
  };
}

const baseEnv: EnvShape = {
  ARCHON_WORKSPACE_SLUG: "ws",
  ARCHON_PROJECT_SLUG: "proj"
} as EnvShape;

function baseOptions(
  cwd: string,
  runDaemonCommand: ExecuteSupervisorCommandOptions["runDaemonCommand"],
  env: EnvShape = baseEnv
): ExecuteSupervisorCommandOptions {
  return {
    cwd,
    env,
    runDaemonCommand,
    now: () => new Date("2026-06-22T12:00:00.000Z"),
    // The loop is faked, so the live-loop dependencies are never invoked.
    getProjectRuntimeState: async () => undefined
  } as unknown as ExecuteSupervisorCommandOptions;
}

test("executeSupervisorCommandFromArgs short-circuits when the loop completes", async () => {
  await withTempCwd(async (cwd) => {
    let calls = 0;
    const { result } = await executeSupervisorCommandFromArgs(
      [],
      baseOptions(cwd, async () => {
        calls += 1;
        return { format: "json", result: completedDaemonResult() };
      })
    );
    assert.equal(calls, 1);
    assert.equal(result.status, "completed");
    assert.equal(result.actions.length, 0);
    assert.equal(result.daemonRuns.length, 1);

    // status + history are persisted on every finalize
    const status = await readDaemonSupervisorStatus(cwd, { scope: "all", limit: 0 });
    assert.equal(status?.state, "completed");
    const history = await readDaemonSupervisorHistory(cwd, { limit: 5, scope: "all" });
    assert.equal(history.entries.length, 1);
  });
});

test("executeSupervisorCommandFromArgs blocks with handoff_missing when the loop blocks without a handoff", async () => {
  await withTempCwd(async (cwd) => {
    const { result } = await executeSupervisorCommandFromArgs(
      [],
      baseOptions(cwd, async () => ({ format: "json", result: blockedDaemonResult("blocked, no handoff") }))
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.actions.length, 0);
    const status = await readDaemonSupervisorStatus(cwd, { scope: "all", limit: 0 });
    assert.equal(status?.blockerKind, "handoff_missing");
  });
});

test("executeSupervisorCommandFromArgs enqueues a trusted operator continuation action", async () => {
  await withTempCwd(async (cwd) => {
    // Seed the daemon handoff + continuation status the supervisor derives its action from.
    await writeDaemonOperatorHandoff(cwd, {
      state: "blocked",
      blockerKind: "operator_required_continuation",
      reason: "operator continuation required",
      workspaceSlug: "ws",
      projectSlug: "proj",
      activeRunId: "run-1",
      activeTaskId: "task-1",
      sessionId: "sess-1",
      cycle: 1,
      directiveKind: "continue_analysis",
      nextActions: ["review the blocking gap"],
      detailFiles: {},
      updatedAt: "2026-06-22T11:59:00.000Z"
    });
    await writeDaemonContinuationStatus(cwd, {
      state: "blocked",
      directiveKind: "continue_analysis",
      executionMode: "operator_required",
      targetId: "gap-1",
      source: "blocking_gap",
      summary: "resolve the blocking coverage gap",
      nextActions: ["inspect gap-1"],
      blockers: ["coverage gap gap-1 is open"],
      updatedAt: "2026-06-22T11:59:00.000Z"
    });

    let calls = 0;
    const { result } = await executeSupervisorCommandFromArgs(
      [],
      // Cycle 1 blocks (action enqueued); cycle 2 reports complete so the loop terminates.
      baseOptions(cwd, async () => {
        calls += 1;
        return calls === 1
          ? { format: "json", result: blockedDaemonResult("operator continuation required") }
          : { format: "json", result: completedDaemonResult() };
      })
    );

    assert.equal(calls, 2);
    assert.equal(result.status, "completed");
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]?.action, "enqueue_operator_continuation");
    assert.equal(result.actions[0]?.targetId, "gap-1");

    // The operator-action file is materialized on disk.
    const actionFile = path.join(cwd, result.actions[0]!.filePath);
    const parsed = JSON.parse(await readFile(actionFile, "utf8")) as {
      blockerKind: string;
      action: { kind: string; targetId: string };
    };
    assert.equal(parsed.blockerKind, "operator_required_continuation");
    assert.equal(parsed.action.kind, "continue_with_analysis");
    assert.equal(parsed.action.targetId, "gap-1");
  });
});

test("executeSupervisorCommandFromArgs finalizes on the first blocked result with no handoff even under a multi-cycle budget", async () => {
  await withTempCwd(async (cwd) => {
    // With a budget of 2 but no operator handoff seeded, the first blocked result is
    // terminal (handoff_missing) — the loop does not iterate to a second daemon run.
    let calls = 0;
    const { result } = await executeSupervisorCommandFromArgs(
      ["--max-supervisor-cycles", "2"],
      baseOptions(cwd, async () => {
        calls += 1;
        return { format: "json", result: blockedDaemonResult("blocked") };
      })
    );
    assert.equal(result.status, "blocked");
    assert.equal(calls, 1);
    assert.equal(result.daemonRuns.length, 1);
  });
});

test("executeSupervisorCommandFromArgs rejects an invalid --max-supervisor-cycles", async () => {
  await withTempCwd(async (cwd) => {
    await assert.rejects(
      executeSupervisorCommandFromArgs(
        ["--max-supervisor-cycles", "0"],
        baseOptions(cwd, async () => ({ format: "json", result: completedDaemonResult() }))
      ),
      /Invalid --max-supervisor-cycles/
    );
  });
});

test("parseSupervisorReviewActorBindings reads flags and env, and rejects bad input", () => {
  const fromFlags = parseSupervisorReviewActorBindings(
    ["--review-actor", "reviewer=alice", "--review-actor", "qa_engineer=bob"],
    {} as EnvShape
  );
  assert.equal(fromFlags.reviewer, "alice");
  assert.equal(fromFlags.qa_engineer, "bob");

  const fromEnv = parseSupervisorReviewActorBindings([], {
    ARCHON_SUPERVISOR_REVIEWER_ACTOR: "carol"
  } as EnvShape);
  assert.equal(fromEnv.reviewer, "carol");

  // Flags take precedence over env for the same role.
  const merged = parseSupervisorReviewActorBindings(["--review-actor", "reviewer=dave"], {
    ARCHON_SUPERVISOR_REVIEWER_ACTOR: "carol"
  } as EnvShape);
  assert.equal(merged.reviewer, "dave");

  assert.throws(() => parseSupervisorReviewActorBindings(["--review-actor", "bogus"], {} as EnvShape), /Invalid --review-actor/);
  assert.throws(
    () => parseSupervisorReviewActorBindings(["--review-actor", "not_a_role=x"], {} as EnvShape),
    /Invalid review role/
  );
});

test("resolveDaemonSupervisorHistoryReadOptions resolves defaults and validates", () => {
  const def = resolveDaemonSupervisorHistoryReadOptions([], undefined, "run-99");
  assert.deepEqual(def, { limit: 5, scope: "run", runId: "run-99" });

  const all = resolveDaemonSupervisorHistoryReadOptions(
    ["--daemon-supervisor-history-scope", "all", "--daemon-supervisor-history-limit", "10"],
    undefined,
    "run-99"
  );
  assert.equal(all.scope, "all");
  assert.equal(all.limit, 10);
  assert.equal(all.runId, undefined);

  assert.throws(
    () => resolveDaemonSupervisorHistoryReadOptions(["--daemon-supervisor-history-limit", "abc"], undefined, "r"),
    /Invalid --daemon-supervisor-history-limit/
  );
  assert.throws(
    () => resolveDaemonSupervisorHistoryReadOptions(["--daemon-supervisor-history-scope", "weird"], undefined, "r"),
    /Invalid --daemon-supervisor-history-scope/
  );
});

test("resolveSupervisorHistoryRetentionLimit resolves and validates", () => {
  assert.equal(resolveSupervisorHistoryRetentionLimit([], undefined), 200);
  assert.equal(resolveSupervisorHistoryRetentionLimit(["--supervisor-history-retention", "50"], undefined), 50);
  assert.throws(
    () => resolveSupervisorHistoryRetentionLimit(["--supervisor-history-retention", "0"], undefined),
    /Invalid --supervisor-history-retention/
  );
});

test("buildSupervisorOperatorNotes honors an override and otherwise composes context", () => {
  assert.equal(
    buildSupervisorOperatorNotes({ targetId: "t", summary: "s", nextActions: [], override: "  custom  " }),
    "custom"
  );
  const composed = buildSupervisorOperatorNotes({
    targetId: "gap-1",
    summary: "resolve gap",
    nextActions: ["step a", "step b"]
  });
  assert.match(composed, /Local supervisor authorized advisory continuation for gap-1\./);
  assert.match(composed, /Reason: resolve gap/);
  assert.match(composed, /Context: step a \| step b/);
});

test("formatSupervisorCommandResult renders status, actions, and daemon runs", () => {
  const result: SupervisorCommandResult = {
    authorityLabel: "derived_only",
    workspaceSlug: "ws",
    projectSlug: "proj",
    status: "completed",
    reason: "done",
    activeRunId: "run-1",
    activeTaskId: "task-1",
    sessionId: "sess-1",
    daemonRuns: [completedDaemonResult()],
    actions: [
      {
        cycle: 1,
        action: "enqueue_operator_continuation",
        targetId: "gap-1",
        filePath: "x.json",
        summary: "queued"
      }
    ]
  };
  const text = formatSupervisorCommandResult(result);
  assert.match(text, /status: completed/);
  assert.match(text, /actions:/);
  assert.match(text, /action=enqueue_operator_continuation target=gap-1/);
  assert.match(text, /daemon-runs:/);
});

test("formatSupervisorHistoryCommandResult renders entries and the empty case", () => {
  const empty = formatSupervisorHistoryCommandResult({
    authorityLabel: "derived_only",
    historyPath: "h.jsonl",
    scope: "all",
    retainedCount: 0,
    filteredCount: 0,
    returnedCount: 0,
    truncated: false,
    entries: []
  });
  assert.match(empty, /entries: none/);
});
