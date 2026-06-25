/**
 * Tests for src/forge/forge-pipeline.ts
 *
 * TDD: tests written before implementation.
 *
 * Verifies:
 *   1. Every packet produced by buildForgePipelinePackets passes validateTaskPacket
 *   2. DAG validity: no dangling deps, no cycles, topological order matches §4
 *   3. visual_critic stage carries the C1 NON-WAIVABLE anti-generic gate
 *   4. Static pipeline set contains NO repair task (PS-5)
 *   5. buildForgeRepairPacket passes validateTaskPacket; dep points at visual_critic
 *   6. Round-trip through ArchonCoreService.createTaskGraph materialises all stages
 *   7. ForgeBuildRequestSchema validates required input fields
 *
 * Run with: node --experimental-strip-types --test tests/forge-pipeline.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateTaskPacket } from "../src/domain/contracts.ts";
import { MemoryStore } from "../src/store/memory-store.ts";
import { ArchonCoreService } from "../src/core/service.ts";
import {
  buildForgePipelinePackets,
  buildForgeRepairPacket,
  ForgeBuildRequestSchema,
  FORGE_STAGE_IDS,
  VISUAL_CRITIC_C1_GATE,
} from "../src/forge/forge-pipeline.ts";
import type { ForgeBuildRequest } from "../src/forge/forge-pipeline.ts";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const TEST_REQUEST: ForgeBuildRequest = {
  targetDescription: "Run-status dashboard showing active forge runs",
  surface: "visual_change",
  outputDir: "web/src/dashboard",
};

// ---------------------------------------------------------------------------
// 1. Schema validation
// ---------------------------------------------------------------------------

describe("ForgeBuildRequestSchema — input validation", () => {
  it("parses a valid request without throwing", () => {
    const result = ForgeBuildRequestSchema.safeParse(TEST_REQUEST);
    assert.ok(result.success, `Zod parse failed: ${JSON.stringify((result as { error: unknown }).error)}`);
  });

  it("rejects an empty targetDescription", () => {
    const result = ForgeBuildRequestSchema.safeParse({ ...TEST_REQUEST, targetDescription: "" });
    assert.ok(!result.success, "empty targetDescription must be rejected");
  });

  it("rejects an invalid surface", () => {
    const result = ForgeBuildRequestSchema.safeParse({ ...TEST_REQUEST, surface: "invalid_surface" });
    assert.ok(!result.success, "invalid surface must be rejected");
  });

  it("rejects an empty outputDir", () => {
    const result = ForgeBuildRequestSchema.safeParse({ ...TEST_REQUEST, outputDir: "" });
    assert.ok(!result.success, "empty outputDir must be rejected");
  });

  it("rejects an outputDir with '..' traversal segments", () => {
    for (const outputDir of ["../escape", "web/../../etc", "a/../../b", ".."]) {
      const result = ForgeBuildRequestSchema.safeParse({ ...TEST_REQUEST, outputDir });
      assert.ok(!result.success, `traversal outputDir '${outputDir}' must be rejected`);
    }
  });

  it("rejects an absolute or drive-prefixed outputDir", () => {
    for (const outputDir of ["/abs/path", "\\\\unc", "C:/win", "c:\\win"]) {
      const result = ForgeBuildRequestSchema.safeParse({ ...TEST_REQUEST, outputDir });
      assert.ok(!result.success, `absolute outputDir '${outputDir}' must be rejected`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every packet passes validateTaskPacket
// ---------------------------------------------------------------------------

describe("buildForgePipelinePackets — all packets valid", () => {
  it("returns 15 packets", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    assert.equal(packets.length, 15, `Expected 15 packets, got ${packets.length}`);
  });

  it("every packet passes validateTaskPacket with zero errors", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const allErrors: string[] = [];
    for (const packet of packets) {
      const errors = validateTaskPacket(packet);
      for (const err of errors) {
        allErrors.push(`[${packet.taskId}] ${err}`);
      }
    }
    assert.deepEqual(
      allErrors,
      [],
      `validateTaskPacket errors:\n${allErrors.join("\n")}`
    );
  });

  it("all taskIds match the canonical FORGE_STAGE_IDS constant", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const ids = packets.map((p) => p.taskId);
    assert.deepEqual(ids, FORGE_STAGE_IDS);
  });
});

// ---------------------------------------------------------------------------
// 3. DAG validity
// ---------------------------------------------------------------------------

describe("buildForgePipelinePackets — DAG invariants", () => {
  it("every dependency references a known stage taskId", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const knownIds = new Set(packets.map((p) => p.taskId));
    const dangling: string[] = [];
    for (const packet of packets) {
      for (const dep of packet.dependencies) {
        if (!knownIds.has(dep)) {
          dangling.push(`${packet.taskId} depends on unknown '${dep}'`);
        }
      }
    }
    assert.deepEqual(dangling, [], `Dangling deps:\n${dangling.join("\n")}`);
  });

  it("dependency graph is acyclic (linear chain — each stage depends only on the prior)", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    // Build adjacency (taskId → deps).
    const depMap = new Map<string, string[]>(packets.map((p) => [p.taskId, p.dependencies]));

    // Topological sort via Kahn's algorithm.
    // in-degree = number of dependencies a node has (predecessors that must come first).
    const inDegree = new Map<string, number>();
    for (const id of depMap.keys()) inDegree.set(id, 0);
    for (const [id, deps] of depMap) {
      // Each dependency is a predecessor of id — so id's in-degree grows.
      inDegree.set(id, deps.length);
    }
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited++;
      // Find all nodes that list id as a dependency and reduce their in-degree.
      for (const [node, deps] of depMap) {
        if (deps.includes(id)) {
          const deg = (inDegree.get(node) ?? 0) - 1;
          inDegree.set(node, deg);
          if (deg === 0) queue.push(node);
        }
      }
    }
    assert.equal(visited, packets.length, "cycle detected — Kahn did not visit all nodes");
  });

  it("topological order follows §4 flow (intent_brief first, final_handoff last)", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const ids = packets.map((p) => p.taskId);
    assert.equal(ids[0], "forge_intent_brief", `first stage must be forge_intent_brief, got ${ids[0]}`);
    assert.equal(ids[ids.length - 1], "forge_final_handoff", `last stage must be forge_final_handoff, got ${ids[ids.length - 1]}`);
  });

  it("each stage (after the first) depends on the immediately preceding stage", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    for (let i = 1; i < packets.length; i++) {
      const cur = packets[i]!;
      const prev = packets[i - 1]!;
      assert.ok(
        cur.dependencies.includes(prev.taskId),
        `Stage '${cur.taskId}' at index ${i} must depend on '${prev.taskId}' but deps are: ${JSON.stringify(cur.dependencies)}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. visual_critic C1 non-waivable gate
// ---------------------------------------------------------------------------

describe("buildForgePipelinePackets — visual_critic C1 gate", () => {
  it("visual_critic packet carries the C1 anti-generic quality gate", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const critic = packets.find((p) => p.taskId === "forge_visual_critic");
    assert.ok(critic, "forge_visual_critic packet must be present");
    assert.ok(
      critic!.qualityGates.includes(VISUAL_CRITIC_C1_GATE),
      `forge_visual_critic must include C1 gate '${VISUAL_CRITIC_C1_GATE}', got: ${JSON.stringify(critic!.qualityGates)}`
    );
  });

  it("visual_critic goal references anti-generic-checker and visual-critique", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const critic = packets.find((p) => p.taskId === "forge_visual_critic")!;
    assert.ok(
      critic.goal.toLowerCase().includes("anti-generic"),
      "goal must reference anti-generic checker"
    );
    assert.ok(
      critic.goal.toLowerCase().includes("visual-critique") || critic.goal.toLowerCase().includes("visual critique"),
      "goal must reference visual-critique"
    );
  });

  it("visual_critic acceptanceCriteria declares the gate non-waivable", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const critic = packets.find((p) => p.taskId === "forge_visual_critic")!;
    const criteriaText = critic.acceptanceCriteria.join(" ").toLowerCase();
    assert.ok(
      criteriaText.includes("non-waivable"),
      "visual_critic acceptanceCriteria must declare the C1 gate non-waivable"
    );
  });

  it("visual_critic references generic-copy-checker in goal or verificationSteps", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const critic = packets.find((p) => p.taskId === "forge_visual_critic")!;
    const combined = [...critic.verificationSteps, critic.goal].join(" ").toLowerCase();
    assert.ok(
      combined.includes("generic-copy") || combined.includes("generic copy"),
      "visual_critic must reference generic-copy-checker"
    );
  });
});

// ---------------------------------------------------------------------------
// 5. a11y_perf specialist requirements
// ---------------------------------------------------------------------------

describe("buildForgePipelinePackets — a11y_perf stage", () => {
  it("a11y_perf requires accessibility_engineer and performance_engineer as specialist roles", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const a11y = packets.find((p) => p.taskId === "forge_a11y_perf");
    assert.ok(a11y, "forge_a11y_perf packet must be present");
    assert.ok(
      a11y!.requiredSpecialistRoles.includes("accessibility_engineer"),
      "a11y_perf must require accessibility_engineer"
    );
    assert.ok(
      a11y!.requiredSpecialistRoles.includes("performance_engineer"),
      "a11y_perf must require performance_engineer"
    );
  });

  it("a11y_perf qualityGates include accessibility_acceptance and performance_check_required", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const a11y = packets.find((p) => p.taskId === "forge_a11y_perf")!;
    assert.ok(
      a11y.qualityGates.includes("accessibility_acceptance"),
      "a11y_perf must include accessibility_acceptance quality gate"
    );
    assert.ok(
      a11y.qualityGates.includes("performance_check_required"),
      "a11y_perf must include performance_check_required quality gate"
    );
  });
});

// ---------------------------------------------------------------------------
// 6. implementation and browser_qa surface/playwright
// ---------------------------------------------------------------------------

describe("buildForgePipelinePackets — implementation and browser_qa", () => {
  it("implementation stage has uiSurface set", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const impl = packets.find((p) => p.taskId === "forge_implementation");
    assert.ok(impl, "forge_implementation packet must be present");
    assert.ok(impl!.uiSurface !== undefined, "implementation must declare uiSurface");
  });

  it("browser_qa has playwrightRequired: true with uiSurface interactive_flow", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const bqa = packets.find((p) => p.taskId === "forge_browser_qa");
    assert.ok(bqa, "forge_browser_qa packet must be present");
    assert.equal(bqa!.playwrightRequired, true, "browser_qa must have playwrightRequired: true");
    assert.equal(bqa!.uiSurface, "interactive_flow", "browser_qa must have uiSurface: interactive_flow");
  });

  it("browser_qa carries the e2e_required quality gate", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const bqa = packets.find((p) => p.taskId === "forge_browser_qa");
    assert.ok(bqa, "forge_browser_qa packet must be present");
    assert.ok(
      bqa!.qualityGates.includes("e2e_required"),
      "browser_qa must carry the e2e_required quality gate"
    );
  });

  it("implementation remaps surface 'none' to a 'visual_change' uiSurface", () => {
    const packets = buildForgePipelinePackets({ ...TEST_REQUEST, surface: "none" });
    const impl = packets.find((p) => p.taskId === "forge_implementation");
    assert.ok(impl, "forge_implementation packet must be present");
    assert.equal(
      impl!.uiSurface,
      "visual_change",
      "surface 'none' must remap to a 'visual_change' implementation uiSurface"
    );
  });
});

// ---------------------------------------------------------------------------
// 7. PS-5 proof — no repair task in static set
// ---------------------------------------------------------------------------

describe("PS-5 — repair task NOT in static pipeline", () => {
  it("static packet set contains no task with 'repair' in its taskId", () => {
    const packets = buildForgePipelinePackets(TEST_REQUEST);
    const repairTasks = packets.filter((p) => p.taskId.toLowerCase().includes("repair"));
    assert.equal(
      repairTasks.length,
      0,
      `Static set must have no repair tasks, found: ${repairTasks.map((p) => p.taskId).join(", ")}`
    );
  });
});

// ---------------------------------------------------------------------------
// 8. buildForgeRepairPacket
// ---------------------------------------------------------------------------

describe("buildForgeRepairPacket — valid and correct dep", () => {
  it("passes validateTaskPacket with zero errors", () => {
    const packet = buildForgeRepairPacket(TEST_REQUEST, {
      visualCriticTaskId: "forge_visual_critic",
      repairNotes: "C1 gate failed — anti-generic violations detected",
    });
    const errors = validateTaskPacket(packet);
    assert.deepEqual(
      errors,
      [],
      `buildForgeRepairPacket has validation errors:\n${errors.join("\n")}`
    );
  });

  it("repair packet dependency points at the visual_critic stage", () => {
    const packet = buildForgeRepairPacket(TEST_REQUEST, {
      visualCriticTaskId: "forge_visual_critic",
      repairNotes: "rework required",
    });
    assert.ok(
      packet.dependencies.includes("forge_visual_critic"),
      `repair packet must depend on forge_visual_critic; got: ${JSON.stringify(packet.dependencies)}`
    );
  });

  it("repair taskId contains 'repair'", () => {
    const packet = buildForgeRepairPacket(TEST_REQUEST, {
      visualCriticTaskId: "forge_visual_critic",
      repairNotes: "rework",
    });
    assert.ok(
      packet.taskId.toLowerCase().includes("repair"),
      `repair packet taskId must include 'repair'; got: ${packet.taskId}`
    );
  });

  it("repair packet is dangling-dep-free against supplied existing key set", () => {
    const packet = buildForgeRepairPacket(TEST_REQUEST, {
      visualCriticTaskId: "forge_visual_critic",
      repairNotes: "rework",
    });
    // Simulate the existing task keys in a run (the full pipeline was already materialised).
    const existingKeys = new Set(FORGE_STAGE_IDS);
    const dangling = packet.dependencies.filter((dep) => !existingKeys.has(dep));
    assert.deepEqual(
      dangling,
      [],
      `repair packet has dangling deps against existing key set: ${dangling.join(", ")}`
    );
  });

  it("rejects empty or over-long repairNotes and empty visualCriticTaskId", () => {
    // RegExp matchers assert the SPECIFIC Zod field error (a bare string second arg
    // would be treated as a failure label and let any thrown error pass).
    assert.throws(
      () => buildForgeRepairPacket(TEST_REQUEST, { visualCriticTaskId: "forge_visual_critic", repairNotes: "" }),
      /repairNotes/
    );
    assert.throws(
      () =>
        buildForgeRepairPacket(TEST_REQUEST, {
          visualCriticTaskId: "forge_visual_critic",
          repairNotes: "x".repeat(4001),
        }),
      /repairNotes/
    );
    assert.throws(
      () => buildForgeRepairPacket(TEST_REQUEST, { visualCriticTaskId: "", repairNotes: "rework" }),
      /visualCriticTaskId/
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Round-trip: createTaskGraph materialises all 15 stages
// ---------------------------------------------------------------------------

describe("round-trip through ArchonCoreService.createTaskGraph", () => {
  it("materialises all 15 forge stages as ready tasks with no validation error", async () => {
    const store = new MemoryStore();
    const service = new ArchonCoreService(store);

    // Boot a minimal run.
    const run = await service.intakeRequest({
      workspaceSlug: "forge-test",
      projectSlug: "forge-proj",
      actor: "planner",
      title: `Forge pipeline test ${randomUUID()}`,
      request: "Test forge pipeline materialisation",
    });

    const packets = buildForgePipelinePackets(TEST_REQUEST);

    // createTaskGraph calls validateTaskPacket internally — if it throws, the test fails.
    await service.createTaskGraph(run.id, packets);

    const tasks = await store.getTasksByRun(run.id);
    assert.equal(tasks.length, 15, `Expected 15 tasks, got ${tasks.length}`);

    // All tasks start in ready status.
    const nonReady = tasks.filter((t) => t.status !== "ready");
    assert.equal(
      nonReady.length,
      0,
      `All tasks must start as ready; non-ready: ${nonReady.map((t) => `${t.packet.taskId}:${t.status}`).join(", ")}`
    );
  });
});
