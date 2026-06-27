/**
 * TDD tests for the `archon autonomous-enable` operator command.
 *
 * RED phase: all tests must fail until src/admin/autonomous-enable.ts and the
 * `disableAutonomousExecution` service method are implemented.
 *
 * Coverage:
 * 1. parseAutonomousEnableArgs — pure flag parser, no DB
 * 2. buildAutonomousEnableResult / buildAutonomousDisableResult — pure output builders
 * 3. Service integration — configureAutonomousExecution sets enabled=true
 * 4. Service integration — disableAutonomousExecution sets enabled=false, preserves state
 * 5. getExecutionPlan contract — disabled => blocked directive; enabled => not blocked
 * 6. adminCommands registration — "autonomous-enable" in the set
 */

import test from "node:test";
import assert from "node:assert/strict";

// ────────────────────────────────────────────────────────────────────────────
// 1. Pure flag parser
// ────────────────────────────────────────────────────────────────────────────

const { parseAutonomousEnableArgs } = await import("../src/admin/autonomous-enable.ts");

test("parseAutonomousEnableArgs: enable with explicit run-id", () => {
  const result = parseAutonomousEnableArgs(["--run-id", "abc-123"]);
  assert.equal(result.runId, "abc-123");
  assert.equal(result.disable, false);
  assert.equal(result.profile, undefined);
  assert.equal(result.phase, undefined);
  assert.equal(result.format, "json");
});

test("parseAutonomousEnableArgs: disable flag", () => {
  const result = parseAutonomousEnableArgs(["--run-id", "abc-123", "--disable"]);
  assert.equal(result.disable, true);
});

test("parseAutonomousEnableArgs: profile and phase flags", () => {
  const result = parseAutonomousEnableArgs([
    "--run-id", "abc-123",
    "--profile", "standard_delivery",
    "--phase", "risk_analysis"
  ]);
  assert.equal(result.profile, "standard_delivery");
  assert.equal(result.phase, "risk_analysis");
});

test("parseAutonomousEnableArgs: format text", () => {
  const result = parseAutonomousEnableArgs(["--run-id", "r1", "--format", "text"]);
  assert.equal(result.format, "text");
});

test("parseAutonomousEnableArgs: format json default when omitted", () => {
  const result = parseAutonomousEnableArgs(["--run-id", "r1"]);
  assert.equal(result.format, "json");
});

test("parseAutonomousEnableArgs: invalid format throws", () => {
  assert.throws(
    () => parseAutonomousEnableArgs(["--run-id", "r1", "--format", "csv"]),
    /invalid.*format/i
  );
});

test("parseAutonomousEnableArgs: no run-id returns undefined", () => {
  const result = parseAutonomousEnableArgs([]);
  assert.equal(result.runId, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Pure output builders
// ────────────────────────────────────────────────────────────────────────────

const { buildAutonomousEnableOutput, buildAutonomousDisableOutput } =
  await import("../src/admin/autonomous-enable.ts");

test("buildAutonomousEnableOutput: enabled=true in result", () => {
  const state = {
    enabled: true,
    profile: "standard_delivery" as const,
    phase: "discovery" as const,
    updatedAt: "2026-06-27T00:00:00.000Z",
    coverageItems: [],
    gaps: [],
    checkpoints: [],
    progressProofs: [],
    pendingInvestigations: [],
    executionEpoch: 1
  };
  const output = buildAutonomousEnableOutput("run-1", state);
  assert.equal(output.enabled, true);
  assert.equal(output.runId, "run-1");
  assert.equal(output.profile, "standard_delivery");
  assert.equal(output.phase, "discovery");
  assert.ok(output.hint.includes("daemon"), "hint must mention daemon");
});

test("buildAutonomousDisableOutput: enabled=false in result", () => {
  const state = {
    enabled: false,
    profile: "standard_delivery" as const,
    phase: "discovery" as const,
    updatedAt: "2026-06-27T00:00:00.000Z",
    coverageItems: [],
    gaps: [],
    checkpoints: [],
    progressProofs: [],
    pendingInvestigations: [],
    executionEpoch: 1
  };
  const output = buildAutonomousDisableOutput("run-1", state);
  assert.equal(output.enabled, false);
  assert.equal(output.runId, "run-1");
  // Profile and phase are preserved when disabling
  assert.equal(output.profile, "standard_delivery");
});

// ────────────────────────────────────────────────────────────────────────────
// 3 & 4. Service integration via in-memory stub
// ────────────────────────────────────────────────────────────────────────────

import { ArchonCoreService } from "../src/core/service.ts";
import { MemoryStore } from "../src/store/memory-store.ts";

function makeService(): { service: ArchonCoreService } {
  const store = new MemoryStore();
  const service = new ArchonCoreService(store);
  return { service };
}

async function seedRun(service: ArchonCoreService): Promise<string> {
  const run = await service.intakeRequest({
    workspaceSlug: "ws-test",
    projectSlug: "proj-test",
    actor: "operator",
    title: "autonomous-enable test run",
    request: "enable autonomous execution"
  });
  return run.id;
}

test("service.configureAutonomousExecution: sets enabled=true with defaults", async () => {
  const { service } = makeService();
  const runId = await seedRun(service);

  const state = await service.configureAutonomousExecution(runId, {});

  assert.equal(state.enabled, true);
  assert.equal(state.profile, "standard_delivery");
  assert.equal(state.phase, "discovery");
});

test("service.configureAutonomousExecution: respects explicit profile and phase", async () => {
  const { service } = makeService();
  const runId = await seedRun(service);

  const state = await service.configureAutonomousExecution(runId, {
    profile: "standard_delivery",
    phase: "risk_analysis"
  });

  assert.equal(state.enabled, true);
  assert.equal(state.phase, "risk_analysis");
});

test("service.disableAutonomousExecution: sets enabled=false, preserves profile and phase", async () => {
  const { service } = makeService();
  const runId = await seedRun(service);

  await service.configureAutonomousExecution(runId, {
    profile: "standard_delivery",
    phase: "risk_analysis"
  });

  const disabled = await service.disableAutonomousExecution(runId);

  assert.equal(disabled.enabled, false);
  assert.equal(disabled.profile, "standard_delivery");
  assert.equal(disabled.phase, "risk_analysis");
});

test("service.disableAutonomousExecution: preserves coverageItems", async () => {
  const { service } = makeService();
  const runId = await seedRun(service);

  await service.configureAutonomousExecution(runId, {});
  await service.upsertCoverageItems(runId, [
    {
      id: "item-1",
      category: "module",
      state: "covered",
      criticality: "high",
      sources: ["src/foo.ts"],
      evidenceRefs: ["handoff:h1"]
    }
  ]);

  const disabled = await service.disableAutonomousExecution(runId);

  assert.equal(disabled.coverageItems.length, 1);
  assert.equal(disabled.coverageItems[0]?.id, "item-1");
});

// ────────────────────────────────────────────────────────────────────────────
// 5. getExecutionPlan contract — enabled gate
// ────────────────────────────────────────────────────────────────────────────

test("getExecutionPlan: autonomousExecution is undefined when disabled", async () => {
  const { service } = makeService();
  const runId = await seedRun(service);

  await service.configureAutonomousExecution(runId, {});
  await service.disableAutonomousExecution(runId);

  const plan = await service.getExecutionPlan(runId);

  // autonomousExecution must be absent/undefined when disabled
  assert.equal(plan.autonomousExecution, undefined);
});

test("getExecutionPlan: autonomousExecution present when enabled", async () => {
  const { service } = makeService();
  const runId = await seedRun(service);

  await service.configureAutonomousExecution(runId, {});

  const plan = await service.getExecutionPlan(runId);

  assert.notEqual(plan.autonomousExecution, undefined);
  assert.equal(plan.autonomousExecution?.state.enabled, true);
});

// ────────────────────────────────────────────────────────────────────────────
// 6. adminCommands registration
// ────────────────────────────────────────────────────────────────────────────

// Import the archon.ts module to inspect the adminCommands Set.
// The set is not exported, so we detect the command via the usage text which
// lists all commands. If "autonomous-enable" is missing from the set the CLI
// will throw "Unknown archon command" at runtime — we verify both surfaces.

test("archon CLI: autonomous-enable is listed in usage output", async () => {
  // We can't import the internal Set directly, but we CAN verify registration
  // indirectly by checking that the printUsage output mentions the command.
  // This is the same approach used by the archon.ts module routing: unknown
  // commands throw, known commands dispatch. We mock the dispatch check here
  // by inspecting the source text.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { resolve, dirname } = await import("node:path");
  const src = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/admin/archon.ts"),
    "utf8"
  );
  assert.ok(
    src.includes('"autonomous-enable"'),
    'archon.ts must include "autonomous-enable" in adminCommands'
  );
});

test("admin.ts: autonomous-enable dispatcher is wired", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { resolve, dirname } = await import("node:path");
  const src = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/admin.ts"),
    "utf8"
  );
  assert.ok(
    src.includes("autonomous-enable"),
    'admin.ts must wire the "autonomous-enable" command dispatch'
  );
});
