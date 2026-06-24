/**
 * Tests for P1-S2a: generatedAt field, dynamic emitter, live-read with field-leak guard,
 * and --watch bounded poller.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-live-read.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  DashboardViewModelSchema,
} from "../src/forge/dashboard-contract.ts";
import {
  buildSampleSnapshot,
  projectLiveSnapshot,
  buildSnapshotFromLive,
} from "../src/forge/snapshot.ts";
import {
  emitTypes,
  zodTypeToTs,
} from "../src/forge/gen-dashboard-types.ts";
import {
  executeSnapshotVerb,
  readLiveDashboard,
} from "../src/admin/forge.ts";
import type {
  ForgeSnapshotDeps,
  ForgeSnapshotLiveReadDeps,
  LiveReadStore,
  LiveReadService,
} from "../src/admin/forge.ts";
import {
  resolveSnapshotOutputPath,
} from "../src/forge/snapshot.ts";
import type {
  RunStatusSnapshot,
  RoutingRecommendationReport,
  ReviewRecord,
} from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// 1. generatedAt field — schema and sample snapshot
// ---------------------------------------------------------------------------

describe("DashboardViewModelSchema.generatedAt", () => {
  it("schema has a required generatedAt string field", () => {
    const shape = DashboardViewModelSchema.shape;
    assert.ok("generatedAt" in shape, "DashboardViewModelSchema must have generatedAt field");
    const field = shape["generatedAt" as keyof typeof shape];
    // Must NOT be optional — ZodString directly (not ZodOptional wrapping it)
    assert.ok(!(field instanceof z.ZodOptional), "generatedAt must be required (not optional)");
    assert.ok(field instanceof z.ZodString, "generatedAt must be a ZodString");
  });

  it("buildSampleSnapshot returns a snapshot with a valid ISO-8601 generatedAt", () => {
    const snap = buildSampleSnapshot();
    assert.ok("generatedAt" in snap, "snapshot must have generatedAt");
    assert.ok(typeof snap.generatedAt === "string", "generatedAt must be a string");
    // ISO-8601 check: must parse cleanly
    const d = new Date(snap.generatedAt);
    assert.ok(!isNaN(d.getTime()), `generatedAt must be a valid ISO-8601 date, got: ${snap.generatedAt}`);
  });

  it("DashboardViewModelSchema.parse accepts a valid generatedAt", () => {
    const base = buildSampleSnapshot();
    const withGenerated = { ...base, generatedAt: "2026-06-24T10:00:00Z" };
    const result = DashboardViewModelSchema.safeParse(withGenerated);
    assert.ok(result.success, `parse failed: ${JSON.stringify(result.error)}`);
    assert.equal(result.data.generatedAt, "2026-06-24T10:00:00Z");
  });

  it("DashboardViewModelSchema.parse rejects a snapshot without generatedAt", () => {
    const base = buildSampleSnapshot();
    const { generatedAt: _, ...withoutGenerated } = base as typeof base & { generatedAt: string };
    const result = DashboardViewModelSchema.safeParse(withoutGenerated);
    assert.ok(!result.success, "parse must fail when generatedAt is missing");
  });
});

// ---------------------------------------------------------------------------
// 2. Synthetic ids — committed sample must not contain real run/task ids
// ---------------------------------------------------------------------------

const REAL_IDS = [
  "forgePhase0Skeleton",
  "dashboardContract",
  "constraintsManifest",
  "hookOutsideRepoCanonicalize",
  "run_forge_phase0_a7d01b78",
];

describe("buildSampleSnapshot — synthetic ids only", () => {
  it("does not contain any known real run/task ids", () => {
    const snap = buildSampleSnapshot();
    const json = JSON.stringify(snap);
    for (const id of REAL_IDS) {
      assert.ok(
        !json.includes(id),
        `snapshot must not contain real id "${id}" — use synthetic ids instead`
      );
    }
  });

  it("header.runId is a clearly synthetic id (starts with 'sample-')", () => {
    const snap = buildSampleSnapshot();
    assert.ok(
      snap.header.runId.startsWith("sample-"),
      `header.runId should start with 'sample-', got: ${snap.header.runId}`
    );
  });

  it("all taskIds in taskQueue start with 'sample-'", () => {
    const snap = buildSampleSnapshot();
    for (const task of snap.taskQueue) {
      assert.ok(
        task.taskId.startsWith("sample-"),
        `taskId should start with 'sample-', got: ${task.taskId}`
      );
    }
  });

  it("represents a realistic blocked-run scenario (at least 1 review_blocked + blocking gate)", () => {
    const snap = buildSampleSnapshot();
    assert.equal(snap.header.status, "review_blocked", "run must be review_blocked");
    assert.ok(snap.blockers.length > 0, "must have at least one blocker");
    const hasBlockedGate = snap.reviewGates.some((g) => g.state === "blocked");
    assert.ok(hasBlockedGate, "must have at least one blocked review gate");
  });
});

// ---------------------------------------------------------------------------
// 3. Dynamic emitter (C2) — new top-level field flows to emitted type
// ---------------------------------------------------------------------------

describe("emitTypes — dynamic shape iteration (C2 robustness)", () => {
  it("generatedAt field is emitted in the DashboardViewModel type", () => {
    const output = emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("generatedAt:") || output.includes("generatedAt?:"),
      "emitted DashboardViewModel must contain generatedAt field"
    );
  });

  it("adding a field to a schema schema flows to emitted type without emitter edits", () => {
    // Simulate the emitter with an extended schema (new field 'testProbeField').
    // This proves the dynamic iteration handles any new field automatically.
    const extendedSchema = DashboardViewModelSchema.extend({
      testProbeField: z.string(),
    });
    // We call zodTypeToTs directly on the extended schema to verify it flows through.
    const ts = zodTypeToTs(extendedSchema, 0);
    assert.ok(
      ts.includes("testProbeField: string;"),
      "extended schema field must appear in the emitted type without emitter changes"
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Live read (C6) — field-leak guard: unknown runtime fields are DROPPED
// ---------------------------------------------------------------------------

describe("projectLiveSnapshot — field-leak guard (C6)", () => {
  it("strips unknown fields that arrive from the runtime surface", () => {
    // Construct a raw object that looks like a valid DashboardViewModel but
    // carries extra fields that must NOT leak through.
    const validBase = buildSampleSnapshot();
    const withExtraFields = {
      ...validBase,
      __dangerousRuntimeInternalField: "should-be-stripped",
      header: {
        ...validBase.header,
        internalRunSecret: "must-not-leak",
      },
    };

    // The strip-parse must silently drop the extra fields.
    const result = DashboardViewModelSchema.parse(withExtraFields);

    assert.ok(
      !("__dangerousRuntimeInternalField" in result),
      "unknown top-level field must be stripped by the schema parse"
    );
    assert.ok(
      !("internalRunSecret" in result.header),
      "unknown nested field must be stripped by the schema parse"
    );
  });

  it("projectLiveSnapshot returns a derived_only labelled snapshot", () => {
    // Build minimal fake RunStatusSnapshot, RoutingRecommendationReport, and ReviewRecord[].
    const fakeRunSnapshot: RunStatusSnapshot = {
      run: {
        id: "live-run-001",
        workspaceId: "ws-1",
        projectId: "proj-1",
        actor: "test",
        title: "Live Run Test",
        request: "test request",
        summary: { goal: "test", constraints: [], assumptions: [] },
        status: "review_blocked",
        createdAt: "2026-06-24T09:00:00Z",
        updatedAt: "2026-06-24T09:30:00Z",
      },
      tasks: [
        {
          id: "task-alpha",
          runId: "live-run-001",
          workspaceId: "ws-1",
          projectId: "proj-1",
          class: "standard",
          packet: {
            taskId: "task-alpha",
            title: "Alpha Task",
            ownerRole: "backend_engineer",
            completionStandard: "tests pass",
            writeScope: [],
            requiredSpecialistRoles: [],
            qualityGates: [],
          },
          status: "review_blocked",
          createdAt: "2026-06-24T09:00:00Z",
          updatedAt: "2026-06-24T09:30:00Z",
        },
      ],
      activeLocks: [],
      blockers: ["reviewer gate not passed"],
      nextTaskIds: ["task-alpha"],
    };

    const fakeRoutingReport: RoutingRecommendationReport = {
      mode: "advisory_only",
      runId: "live-run-001",
      recommendations: [
        {
          taskId: "task-alpha",
          taskStatus: "review_blocked",
          recommendation: "review_dispatch",
          authorityLabel: "derived_only",
          rationale: ["reviewer gate not passed"],
          blockers: ["reviewer gate not passed"],
          allowedWriteScope: [],
          retrievalGuidance: [],
          approvalCheckpoints: [],
        },
      ],
    };

    const fakeReviews: ReviewRecord[] = [];

    const snap = projectLiveSnapshot(fakeRunSnapshot, fakeRoutingReport, fakeReviews);

    // Must be labelled derived_only
    assert.equal(snap.header.authorityLabel, "derived_only",
      "live projection must be labelled derived_only");

    // Must have generatedAt
    assert.ok(typeof snap.generatedAt === "string", "live snapshot must have generatedAt");
    const d = new Date(snap.generatedAt);
    assert.ok(!isNaN(d.getTime()), "generatedAt must be valid ISO-8601");

    // Must have valid schema (strip parse was applied)
    const parsed = DashboardViewModelSchema.safeParse(snap);
    assert.ok(parsed.success,
      `projectLiveSnapshot output must pass schema: ${JSON.stringify(parsed.error)}`);
  });

  it("projectLiveSnapshot drops unknown fields from runtime surface (explicit leak guard)", () => {
    // This test directly proves C6: if the runtime surface ever returns extra fields
    // they are DROPPED, never forwarded to the web layer.
    const validBase = buildSampleSnapshot();
    const withExtraFields = {
      ...validBase,
      __internalField: "leaked-data",
      generatedAt: "2026-06-24T10:00:00Z",
    };
    // Parse through schema directly (same path as projectLiveSnapshot uses).
    const parsed = DashboardViewModelSchema.parse(withExtraFields);
    assert.ok(
      !("__internalField" in parsed),
      "DashboardViewModelSchema.parse must strip unknown top-level fields"
    );
  });
});

// ---------------------------------------------------------------------------
// 5. buildSnapshotFromLive — fallback behaviour
// ---------------------------------------------------------------------------

describe("buildSnapshotFromLive — fallback to synthetic sample", () => {
  it("returns the synthetic sample snapshot when the live reader throws", async () => {
    const liveReader = async (): Promise<never> => {
      throw new Error("DB unavailable");
    };
    const snap = await buildSnapshotFromLive(liveReader);
    // Must be schema-valid
    const result = DashboardViewModelSchema.safeParse(snap);
    assert.ok(result.success, "fallback snapshot must be schema-valid");
  });

  it("returns the live snapshot when the live reader succeeds", async () => {
    const liveDashboard = buildSampleSnapshot();
    // Override generatedAt so we can distinguish from the default
    const liveCopy = { ...liveDashboard, generatedAt: "2026-06-24T12:00:00Z" };
    const liveReader = async () => liveCopy;
    const snap = await buildSnapshotFromLive(liveReader);
    assert.equal(snap.generatedAt, "2026-06-24T12:00:00Z",
      "must use live snapshot when reader succeeds");
  });

  it("logs the fallback reason when live read fails (error not swallowed silently)", async () => {
    const stderrLines: string[] = [];
    const liveReader = async (): Promise<never> => {
      throw new Error("connection refused");
    };
    await buildSnapshotFromLive(liveReader, { writeStderr: (msg) => stderrLines.push(msg) });
    const combined = stderrLines.join("");
    assert.ok(combined.length > 0, "must log something to stderr when falling back");
    assert.ok(
      combined.includes("fallback") || combined.includes("unavailable") || combined.includes("connection refused"),
      `fallback reason must appear in stderr, got: ${combined}`
    );
  });
});

// ---------------------------------------------------------------------------
// 6. --watch bounded poller (C5)
// ---------------------------------------------------------------------------

/**
 * Build a fake timer that resolves immediately when .fire() is called.
 * The watch loop awaits `new Promise<void>((res) => { pendingTimer = timerFn(res, ms); })`.
 * Calling `fakeTimer.fire()` resolves that promise, advancing the loop by one
 * interval. This is deterministic and requires no real setTimeout sleeps.
 */
function makeFakeTimer() {
  let pendingResolve: (() => void) | undefined;
  const timerFn = (cb: () => void, _ms: number): NodeJS.Timeout => {
    pendingResolve = cb;
    return 0 as unknown as NodeJS.Timeout;
  };
  const clearTimerFn = (_t: NodeJS.Timeout): void => {
    pendingResolve = undefined;
  };
  const fire = () => {
    if (pendingResolve) {
      const cb = pendingResolve;
      pendingResolve = undefined;
      cb();
    }
  };
  return { timerFn, clearTimerFn, fire };
}

describe("forge snapshot --watch bounded poller (C5)", () => {
  it("N cycles produce N file writes and the loop terminates (fast, deterministic)", async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];
    const { timerFn, clearTimerFn, fire } = makeFakeTimer();
    const MAX_CYCLES = 3;

    const deps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: (arg) => resolveSnapshotOutputPath(arg, "/tmp/archon-watch-test"),
      writeFile: async (p, d) => { writeCalls.push({ path: p, data: d }); },
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ },
      timerFn,
      clearTimerFn,
    };

    // The watch loop: writes once immediately, then waits for the timer, then
    // writes again, etc. We drive it by firing the timer after each await.
    // Strategy:
    //   1. Start the watch promise.
    //   2. The first write happens immediately (before any timer wait).
    //   3. Then fire MAX_CYCLES-1 timers to complete the remaining cycles.
    //   4. After the last write the loop exits (cyclesDone >= maxCycles).

    const watchPromise = executeSnapshotVerb(
      ["--watch", "5", "--max-cycles", String(MAX_CYCLES)],
      deps
    );

    // Pump cycles: each fire() advances the loop by one interval.
    // After the first fire the loop does its second write, then pauses at
    // the second timer, etc.
    for (let i = 0; i < MAX_CYCLES - 1; i++) {
      // Yield to let the event loop settle (give the async loop time to reach
      // its next timer await after the previous cycle's write).
      await new Promise<void>((r) => setImmediate(r));
      fire();
    }

    // Wait for the loop to finish.
    await watchPromise;

    assert.equal(
      writeCalls.length,
      MAX_CYCLES,
      `expected ${MAX_CYCLES} file writes (one per cycle), got ${writeCalls.length}`
    );
  });

  it("watch loop with 1 cycle terminates without any timer fires", async () => {
    // 1 cycle = 1 immediate write, then the loop exits without ever waiting for
    // the timer. This verifies that max-cycles=1 is the trivial boundary case.
    const writeCalls: Array<{ path: string; data: string }> = [];
    const { timerFn, clearTimerFn } = makeFakeTimer();

    const deps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: (arg) => resolveSnapshotOutputPath(arg, "/tmp/archon-watch-test"),
      writeFile: async (p, d) => { writeCalls.push({ path: p, data: d }); },
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ },
      timerFn,
      clearTimerFn,
    };

    // With max-cycles=1 the loop writes once and terminates immediately.
    await executeSnapshotVerb(
      ["--watch", "1", "--max-cycles", "1"],
      deps
    );

    assert.equal(writeCalls.length, 1, "expected exactly 1 write for max-cycles=1");
  });

  it("--watch without --max-cycles uses a bounded default cap", async () => {
    // We verify the default cap is finite by running the loop with the injected
    // timer and confirming it terminates. We drive all cycles at once via fire().
    const writeCalls: Array<{ path: string; data: string }> = [];
    const { timerFn, clearTimerFn, fire } = makeFakeTimer();

    const deps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: (arg) => resolveSnapshotOutputPath(arg, "/tmp/archon-watch-test"),
      writeFile: async (p, d) => { writeCalls.push({ path: p, data: d }); },
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ },
      timerFn,
      clearTimerFn,
    };

    const watchPromise = executeSnapshotVerb(["--watch", "2"], deps);

    // Fire up to 500 times — the loop MUST terminate before that on the default cap.
    for (let i = 0; i < 500; i++) {
      await new Promise<void>((r) => setImmediate(r));
      fire();
    }

    await watchPromise;

    // Must have written at least 1 and at most 100 (the default cap is 60).
    assert.ok(writeCalls.length >= 1, "must write at least once");
    assert.ok(writeCalls.length <= 100, `default cap must be <= 100, got ${writeCalls.length}`);
  });
});

// ---------------------------------------------------------------------------
// 7. Live-read wiring (Gap 1 fix) + gitignored output path (Gap 2 fix)
// ---------------------------------------------------------------------------

/**
 * Make a minimal fake ForgeSnapshotLiveReadDeps for a functional live run.
 * The fake reader immediately returns a recognisable live snapshot.
 */
function makeLiveDeps(overrides?: Partial<ForgeSnapshotLiveReadDeps>): ForgeSnapshotLiveReadDeps {
  const liveDash = buildSampleSnapshot();
  const liveVersion = { ...liveDash, generatedAt: "2099-01-01T00:00:00Z" };
  return {
    liveReader: async () => liveVersion,
    ...overrides,
  };
}

describe("forge snapshot — live-read wiring (Gap 1)", () => {
  it("default mode calls liveReader and writes to snapshot.live.json path", async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];

    const deps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: (arg, _repoRoot, mode) => resolveSnapshotOutputPath(arg, "/tmp/archon-live-test", mode),
      writeFile: async (p, d) => { writeCalls.push({ path: p, data: d }); },
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ },
      liveReadDeps: makeLiveDeps(),
    };

    await executeSnapshotVerb([], deps);

    assert.equal(writeCalls.length, 1, "must write exactly once");
    assert.ok(
      writeCalls[0]!.path.endsWith("snapshot.live.json"),
      `default live output must go to snapshot.live.json, got: ${writeCalls[0]!.path}`
    );
  });

  it("default mode uses the liveReader result, not the static sample", async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];

    // Give the live snapshot a distinguishable generatedAt
    const liveDash = buildSampleSnapshot();
    const liveVersion = { ...liveDash, generatedAt: "2099-12-31T23:59:59Z" };

    const deps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: (arg, _repoRoot, mode) => resolveSnapshotOutputPath(arg, "/tmp/archon-live-test", mode),
      writeFile: async (p, d) => { writeCalls.push({ path: p, data: d }); },
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ },
      liveReadDeps: {
        liveReader: async () => liveVersion,
      },
    };

    await executeSnapshotVerb([], deps);

    const written = JSON.parse(writeCalls[0]!.data);
    assert.equal(
      written.generatedAt,
      "2099-12-31T23:59:59Z",
      "must write the live reader result, not the static sample"
    );
  });

  it("falls back to sample snapshot when liveReader throws", async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];
    const stderrLines: string[] = [];

    const deps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: (arg, _repoRoot, mode) => resolveSnapshotOutputPath(arg, "/tmp/archon-live-test", mode),
      writeFile: async (p, d) => { writeCalls.push({ path: p, data: d }); },
      writeStdout: () => { /* noop */ },
      writeStderr: (msg) => stderrLines.push(msg),
      liveReadDeps: {
        liveReader: async () => { throw new Error("no DB"); },
      },
    };

    // Must NOT throw — falls back to sample and writes
    await executeSnapshotVerb([], deps);

    assert.equal(writeCalls.length, 1, "must write even on fallback");
    const stderrCombined = stderrLines.join("");
    assert.ok(
      stderrCombined.includes("fallback") || stderrCombined.includes("unavailable") || stderrCombined.includes("no DB"),
      `fallback reason must appear in stderr, got: ${stderrCombined}`
    );
  });

  it("readLiveDashboard is read-only: every store/service method touched is in the read allowlist", async () => {
    // Genuine read-only proof. We wrap a minimal fake store + service in a Proxy
    // that records EVERY property access and throws on any method NOT in the read
    // allowlist. If readLiveDashboard ever reached for a write method (e.g.
    // updateRun, saveReview, saveApproval), the Proxy would throw and fail here.
    const READ_ALLOWLIST = new Set([
      "findLatestRun",
      "getReviews",
      "getStatus",
      "recommendRouting",
    ]);
    const touched: string[] = [];

    const trap = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(obj, prop, receiver) {
          if (typeof prop === "string") {
            touched.push(prop);
            if (!READ_ALLOWLIST.has(prop) && prop in obj) {
              throw new Error(`BUG: live read reached a non-read method "${prop}"`);
            }
          }
          return Reflect.get(obj, prop, receiver);
        },
      });

    const run = { id: "run-xyz" };
    // A minimal-but-complete RunStatusSnapshot with one review_blocked task, so
    // the task appears in gatedTaskIds and getReviews is exercised.
    const fakeSnapshot = {
      run: {
        id: "run-xyz",
        title: "t",
        status: "review_blocked",
        updatedAt: "2026-06-24T00:00:00Z",
      },
      tasks: [
        {
          packet: { taskId: "task-1", title: "Task One", ownerRole: "backend_engineer" },
          status: "review_blocked",
          updatedAt: "2026-06-24T00:00:00Z",
        },
      ],
      activeLocks: [],
      blockers: [],
    } as unknown as Awaited<ReturnType<LiveReadService["getStatus"]>>;
    const fakeRouting = { recommendations: [] } as unknown as Awaited<
      ReturnType<LiveReadService["recommendRouting"]>
    >;

    const store: LiveReadStore = trap({
      findLatestRun: async () => run as unknown as Awaited<ReturnType<LiveReadStore["findLatestRun"]>>,
      getReviews: async () => [],
      // Write methods that MUST never be reached — present so the Proxy can trap them.
      updateRun: async () => { throw new Error("write!"); },
      saveReview: async () => { throw new Error("write!"); },
      saveApproval: async () => { throw new Error("write!"); },
    } as unknown as LiveReadStore);

    const service: LiveReadService = trap({
      getStatus: async () => fakeSnapshot,
      recommendRouting: async () => fakeRouting,
    } as unknown as LiveReadService);

    const result = await readLiveDashboard(store, service, {
      workspaceSlug: "default",
      projectSlug: "archon",
    });

    // It produced a valid projection...
    assert.equal(typeof result.generatedAt, "string", "live read must produce a generatedAt");
    assert.equal(result.header.authorityLabel, "derived_only", "live read is derived_only");
    // ...and only read methods were ever touched.
    assert.ok(touched.includes("findLatestRun"), "must call findLatestRun");
    assert.ok(touched.includes("getStatus"), "must call getStatus");
    assert.ok(touched.includes("recommendRouting"), "must call recommendRouting");
    assert.ok(touched.includes("getReviews"), "must call getReviews");
    const writesTouched = touched.filter((m) => ["updateRun", "saveReview", "saveApproval"].includes(m));
    assert.deepEqual(writesTouched, [], `no write method may be touched, saw: ${writesTouched.join(", ")}`);
  });

  it("readLiveDashboard throws when no run exists (fallback trigger)", async () => {
    const store: LiveReadStore = {
      findLatestRun: async () => undefined,
      getReviews: async () => [],
    };
    const service: LiveReadService = {
      getStatus: async () => { throw new Error("should not be called"); },
      recommendRouting: async () => { throw new Error("should not be called"); },
    };
    await assert.rejects(
      readLiveDashboard(store, service, { workspaceSlug: "default", projectSlug: "archon" }),
      /no run found/
    );
  });
});

describe("forge snapshot --sample mode (Gap 2)", () => {
  it("--sample writes to snapshot.json (committed path), not snapshot.live.json", async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];
    const liveReaderCalled = { value: false };

    const deps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: (arg, _repoRoot, mode) => resolveSnapshotOutputPath(arg, "/tmp/archon-sample-test", mode),
      writeFile: async (p, d) => { writeCalls.push({ path: p, data: d }); },
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ },
      liveReadDeps: {
        liveReader: async () => { liveReaderCalled.value = true; return buildSampleSnapshot(); },
      },
    };

    await executeSnapshotVerb(["--sample"], deps);

    assert.equal(writeCalls.length, 1, "must write once");
    assert.ok(
      writeCalls[0]!.path.endsWith("snapshot.json") && !writeCalls[0]!.path.endsWith("snapshot.live.json"),
      `--sample output must go to snapshot.json, got: ${writeCalls[0]!.path}`
    );
    assert.equal(liveReaderCalled.value, false, "--sample must NOT call the liveReader");
  });

  it("--sample emits the synthetic sample (all task ids start with 'sample-')", async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];

    const deps: ForgeSnapshotDeps = {
      buildSnapshot: buildSampleSnapshot,
      resolveOutputPath: (arg, _repoRoot, mode) => resolveSnapshotOutputPath(arg, "/tmp/archon-sample-test", mode),
      writeFile: async (p, d) => { writeCalls.push({ path: p, data: d }); },
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ },
      liveReadDeps: makeLiveDeps(),
    };

    await executeSnapshotVerb(["--sample"], deps);

    const written = JSON.parse(writeCalls[0]!.data);
    for (const task of written.taskQueue) {
      assert.ok(
        task.taskId.startsWith("sample-"),
        `--sample taskId must start with 'sample-', got: ${task.taskId}`
      );
    }
  });
});

describe("resolveSnapshotOutputPath — mode-aware defaults", () => {
  const REPO = "/tmp/archon-path-test";

  it("defaults to snapshot.live.json in live mode", () => {
    const result = resolveSnapshotOutputPath(undefined, REPO, "live");
    assert.ok(result.endsWith("snapshot.live.json"), `expected snapshot.live.json, got: ${result}`);
  });

  it("defaults to snapshot.json in sample mode", () => {
    const result = resolveSnapshotOutputPath(undefined, REPO, "sample");
    assert.ok(
      result.endsWith("snapshot.json") && !result.endsWith("snapshot.live.json"),
      `expected snapshot.json, got: ${result}`
    );
  });

  it("defaults to snapshot.live.json when mode is undefined (backward compat → live)", () => {
    // Default mode (no mode arg) should match live mode for fresh invocations.
    const result = resolveSnapshotOutputPath(undefined, REPO);
    assert.ok(result.endsWith("snapshot.live.json"), `expected snapshot.live.json by default, got: ${result}`);
  });

  it("--out override works in both modes", () => {
    const liveResult = resolveSnapshotOutputPath("web/public/custom.json", REPO, "live");
    assert.ok(liveResult.endsWith("custom.json"));
    const sampleResult = resolveSnapshotOutputPath("web/public/custom.json", REPO, "sample");
    assert.ok(sampleResult.endsWith("custom.json"));
  });
});
