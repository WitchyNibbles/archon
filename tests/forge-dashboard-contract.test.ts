/**
 * Tests for src/forge/dashboard-contract.ts and src/forge/constraints-manifest.ts
 *
 * Verifies:
 *   1. The Zod contract parses a representative real-ish status payload
 *   2. The constraints manifest validates against its own schema
 *   3. Every constraint has a unique id
 *
 * Run with: node --experimental-strip-types --test tests/forge-dashboard-contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DashboardViewModelSchema,
  RunHeaderViewModelSchema,
  BlockerViewModelSchema,
  TaskQueueEntryViewModelSchema,
  ReviewGateViewModelSchema,
  RunPulseViewModelSchema
} from "../src/forge/dashboard-contract.ts";
import type { DashboardViewModel } from "../src/forge/dashboard-contract.ts";
import {
  CONSTRAINTS_MANIFEST,
  ConstraintsManifestSchema
} from "../src/forge/constraints-manifest.ts";

// ---------------------------------------------------------------------------
// Fixture — representative real-ish status payload
// Shapes are pinned to the real runtime types in src/domain/types.ts.
// ---------------------------------------------------------------------------

const representativeRun: DashboardViewModel = {
  generatedAt: "2026-06-23T10:00:00.000Z",
  header: {
    runId: "run-abc-001",
    title: "Frontend Forge Phase-0",
    status: "review_blocked",
    authorityLabel: "runtime_authoritative",
    updatedAt: "2026-06-23T10:00:00.000Z"
  },
  blockers: [
    {
      id: "blk-001",
      kind: "review_missing",
      reason: "reviewer review required but no trusted review record found",
      nextActions: ["dispatch reviewer agent", "run workflow-proof after review"],
      taskId: "forgePhase0Skeleton"
    },
    {
      id: "blk-002",
      kind: "review_missing",
      reason: "security_reviewer review required but no trusted review record found",
      nextActions: ["dispatch security_reviewer agent"],
      taskId: "forgePhase0Skeleton"
    }
  ],
  taskQueue: [
    {
      taskId: "forgePhase0Skeleton",
      title: "Frontend Forge Phase-0: freeze data contract and constraints manifest",
      status: "review_blocked",
      ownerRole: "backend_engineer",
      routingRecommendation: "review_dispatch",
      blockers: [
        "reviewer review required but no trusted review record found",
        "security_reviewer review required but no trusted review record found"
      ],
      updatedAt: "2026-06-23T10:00:00.000Z"
    }
  ],
  reviewGates: [
    {
      role: "reviewer",
      state: "pending",
      taskId: "forgePhase0Skeleton"
    },
    {
      role: "security_reviewer",
      state: "pending",
      taskId: "forgePhase0Skeleton"
    },
    {
      role: "qa_engineer",
      state: "pending",
      taskId: "forgePhase0Skeleton"
    }
  ],
  pulse: {
    pulseState: "blocked",
    activeLockCount: 0,
    lockedTaskIds: []
  }
};

// ---------------------------------------------------------------------------
// Dashboard contract tests
// ---------------------------------------------------------------------------

describe("dashboard-contract Zod schemas", () => {
  it("RunHeaderViewModelSchema parses a valid run header", () => {
    const result = RunHeaderViewModelSchema.safeParse(representativeRun.header);
    assert.equal(result.success, true, `parse failed: ${JSON.stringify("error" in result ? result.error : null)}`);
  });

  it("RunHeaderViewModelSchema rejects unknown status", () => {
    const bad = { ...representativeRun.header, status: "flying" };
    const result = RunHeaderViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("RunHeaderViewModelSchema rejects unknown authorityLabel", () => {
    const bad = { ...representativeRun.header, authorityLabel: "trusted_oracle" };
    const result = RunHeaderViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("BlockerViewModelSchema parses each blocker", () => {
    for (const blocker of representativeRun.blockers) {
      const result = BlockerViewModelSchema.safeParse(blocker);
      assert.equal(result.success, true, `blocker ${blocker.id} parse failed`);
    }
  });

  it("BlockerViewModelSchema rejects unknown kind", () => {
    const bad = { ...representativeRun.blockers[0], kind: "vibes_off" };
    const result = BlockerViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("TaskQueueEntryViewModelSchema parses each task entry", () => {
    for (const entry of representativeRun.taskQueue) {
      const result = TaskQueueEntryViewModelSchema.safeParse(entry);
      assert.equal(result.success, true, `task ${entry.taskId} parse failed`);
    }
  });

  it("TaskQueueEntryViewModelSchema rejects unknown status", () => {
    const bad = { ...representativeRun.taskQueue[0], status: "limbo" };
    const result = TaskQueueEntryViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("TaskQueueEntryViewModelSchema rejects unknown routingRecommendation", () => {
    const bad = { ...representativeRun.taskQueue[0], routingRecommendation: "yolo_dispatch" };
    const result = TaskQueueEntryViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("ReviewGateViewModelSchema parses each gate", () => {
    for (const gate of representativeRun.reviewGates) {
      const result = ReviewGateViewModelSchema.safeParse(gate);
      assert.equal(result.success, true, `gate ${gate.role}/${gate.taskId} parse failed`);
    }
  });

  it("ReviewGateViewModelSchema rejects unknown role", () => {
    const bad = { ...representativeRun.reviewGates[0], role: "vibe_checker" };
    const result = ReviewGateViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("ReviewGateViewModelSchema rejects unknown state", () => {
    const bad = { ...representativeRun.reviewGates[0], state: "unknown_state" };
    const result = ReviewGateViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("RunPulseViewModelSchema parses the pulse", () => {
    const result = RunPulseViewModelSchema.safeParse(representativeRun.pulse);
    assert.equal(result.success, true);
  });

  it("RunPulseViewModelSchema rejects unknown pulseState", () => {
    const bad = { ...representativeRun.pulse, pulseState: "transcendent" };
    const result = RunPulseViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("DashboardViewModelSchema parses the full representative payload", () => {
    const result = DashboardViewModelSchema.safeParse(representativeRun);
    assert.equal(result.success, true, `full dashboard parse failed: ${JSON.stringify("error" in result ? result.error : null)}`);
  });

  it("DashboardViewModelSchema allows empty blockers (no-blocker state)", () => {
    const noBlockers: DashboardViewModel = {
      ...representativeRun,
      header: { ...representativeRun.header, status: "in_progress" },
      blockers: [],
      pulse: { pulseState: "running", activeLockCount: 1, lockedTaskIds: ["forgePhase0Skeleton"] }
    };
    const result = DashboardViewModelSchema.safeParse(noBlockers);
    assert.equal(result.success, true);
  });

  it("DashboardViewModelSchema allows complete run (done status, no blockers)", () => {
    const doneRun: DashboardViewModel = {
      ...representativeRun,
      header: { ...representativeRun.header, status: "done" },
      blockers: [],
      taskQueue: [{ ...representativeRun.taskQueue[0]!, status: "done", blockers: [], routingRecommendation: undefined }],
      reviewGates: [],
      pulse: { pulseState: "complete", activeLockCount: 0, lockedTaskIds: [] }
    };
    const result = DashboardViewModelSchema.safeParse(doneRun);
    assert.equal(result.success, true);
  });

  it("DashboardViewModelSchema rejects missing required field (header.runId)", () => {
    const bad = {
      ...representativeRun,
      header: { ...representativeRun.header, runId: undefined }
    };
    const result = DashboardViewModelSchema.safeParse(bad);
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// Constraints manifest tests
// ---------------------------------------------------------------------------

describe("constraints-manifest", () => {
  it("validates against its own Zod schema", () => {
    const result = ConstraintsManifestSchema.safeParse(CONSTRAINTS_MANIFEST);
    assert.equal(
      result.success,
      true,
      `manifest schema validation failed: ${JSON.stringify("error" in result ? result.error.errors : null, null, 2)}`
    );
  });

  it("has version = 2", () => {
    assert.equal(CONSTRAINTS_MANIFEST.version, 2);
  });

  it("exposes a statusTextColors variant for every statusColors key", () => {
    const statusKeys = Object.keys(CONSTRAINTS_MANIFEST.identity.statusColors).sort();
    const textKeys = Object.keys(CONSTRAINTS_MANIFEST.identity.statusTextColors).sort();
    assert.deepEqual(textKeys, statusKeys, "statusTextColors must map 1:1 to statusColors");
  });

  it("every antiGenericRule has a unique id matching AG-NNN", () => {
    const ids = CONSTRAINTS_MANIFEST.antiGenericRules.map((r) => r.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, `duplicate antiGenericRule ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`);
    for (const id of ids) {
      assert.match(id, /^AG-\d{3}$/, `id ${id} does not match AG-NNN pattern`);
    }
  });

  it("every nonNegotiablePrinciple has a unique id matching NNP-NNN", () => {
    const ids = CONSTRAINTS_MANIFEST.nonNegotiablePrinciples.map((p) => p.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, `duplicate nonNegotiablePrinciple ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`);
    for (const id of ids) {
      assert.match(id, /^NNP-\d{3}$/, `id ${id} does not match NNP-NNN pattern`);
    }
  });

  it("has exactly four nonNegotiablePrinciples (required by frontend-taste skill)", () => {
    assert.equal(CONSTRAINTS_MANIFEST.nonNegotiablePrinciples.length, 4);
  });

  it("identity.darkBase is #0A0A0A (source: visual-standards --surface-base)", () => {
    assert.equal(CONSTRAINTS_MANIFEST.identity.darkBase, "#0A0A0A");
  });

  it("identity.accent.base is #6366F1 (source: visual-standards --accent)", () => {
    assert.equal(CONSTRAINTS_MANIFEST.identity.accent.base, "#6366F1");
  });

  it("identity.spacingBaseGridPx is 8", () => {
    assert.equal(CONSTRAINTS_MANIFEST.identity.spacingBaseGridPx, 8);
  });

  it("identity.radiusCap.maxDataSurfacePx is 6 (source: visual-standards --radius-lg)", () => {
    assert.equal(CONSTRAINTS_MANIFEST.identity.radiusCap.maxDataSurfacePx, 6);
  });

  it("identity.radiusCap.absoluteMaxPx is 8", () => {
    assert.equal(CONSTRAINTS_MANIFEST.identity.radiusCap.absoluteMaxPx, 8);
  });

  it("identity.motion.maxDurationMs is 200", () => {
    assert.equal(CONSTRAINTS_MANIFEST.identity.motion.maxDurationMs, 200);
  });

  it("all antiGenericRules have severity = hard_fail or warning", () => {
    for (const rule of CONSTRAINTS_MANIFEST.antiGenericRules) {
      assert.ok(
        rule.severity === "hard_fail" || rule.severity === "warning",
        `rule ${rule.id} has invalid severity ${rule.severity}`
      );
    }
  });

  it("benchmarks include Vercel, Linear, Raycast (source: frontend-taste reference table)", () => {
    const tools = CONSTRAINTS_MANIFEST.benchmarks.map((b) => b.tool);
    assert.ok(tools.includes("Vercel"), "Vercel benchmark missing");
    assert.ok(tools.includes("Linear"), "Linear benchmark missing");
    assert.ok(tools.includes("Raycast"), "Raycast benchmark missing");
  });

  it("AG-002 (single accent) has severity hard_fail", () => {
    const rule = CONSTRAINTS_MANIFEST.antiGenericRules.find((r) => r.id === "AG-002");
    assert.ok(rule, "AG-002 not found");
    assert.equal(rule.severity, "hard_fail");
  });

  it("AG-012 (no generic 3-card soup) has severity hard_fail", () => {
    const rule = CONSTRAINTS_MANIFEST.antiGenericRules.find((r) => r.id === "AG-012");
    assert.ok(rule, "AG-012 not found");
    assert.equal(rule.severity, "hard_fail");
  });

  it("AG-011 (no glassmorphism without purpose) has severity hard_fail", () => {
    const rule = CONSTRAINTS_MANIFEST.antiGenericRules.find((r) => r.id === "AG-011");
    assert.ok(rule, "AG-011 not found");
    assert.equal(rule.severity, "hard_fail");
  });

  it("identity.typefaces.mono is Geist Mono", () => {
    assert.equal(CONSTRAINTS_MANIFEST.identity.typefaces.mono, "Geist Mono");
  });

  it("identity.spacingTokens contains --space-2 = 8px (8px base unit)", () => {
    const token = CONSTRAINTS_MANIFEST.identity.spacingTokens.find((t) => t.name === "--space-2");
    assert.ok(token, "--space-2 not found");
    assert.equal(token.value, "8px");
  });
});
