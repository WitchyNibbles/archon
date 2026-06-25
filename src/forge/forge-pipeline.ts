/**
 * Frontend Forge — staged pipeline materialisation (P1-S5).
 *
 * buildForgePipelinePackets → TaskPacketInput[15], deterministic, pure, validateTaskPacket-clean.
 * buildForgeRepairPacket → mid-run repair task via appendTasks (PS-5: NOT in static set).
 * No engine changes; visual_critic carries C1 NON-WAIVABLE anti-generic gate.
 *
 * The per-stage TaskPacketInput builders live in ./forge-pipeline-stages.ts (split out to keep
 * each module under the 800-line project limit). This module owns the public contract: input
 * schema, stage-id constants, the ordered pipeline builder, and the mid-run repair builder.
 *
 * @module forge-pipeline
 */

import { z } from "zod";
import type { TaskPacketInput } from "../domain/types.ts";
import {
  buildPacket,
  stageIntentBrief,
  stageTasteCalibration,
  stageDesignDirections,
  stageDirectionApproval,
  stageDesignSystemTokens,
  stageAssetPlan,
  stageAssetGeneration,
  stageAssetManifestReconcile,
  stageAssetQa,
  stageFrontendSpec,
  stageImplementation,
  stageBrowserQa,
  stageA11yPerf,
  stageVisualCritic,
  stageFinalHandoff,
} from "./forge-pipeline-stages.ts";

/** Quality gate used for the C1 NON-WAIVABLE anti-generic check (re-exported for consumers). */
export { VISUAL_CRITIC_C1_GATE } from "./forge-pipeline-stages.ts";

// ---------------------------------------------------------------------------
// Input schema + type
// ---------------------------------------------------------------------------

/** Valid UI surfaces for a forge build target. */
const forgeSurfaces = ["none", "visual_change", "interactive_flow"] as const;

/**
 * A repo-relative path with no traversal — rejects leading `/`, a Windows drive
 * prefix, and any `..` segment. The materialised packets embed `outputDir` into
 * `allowedWriteScope` / `inputs` / `outputs`, so confining it here is
 * defence-in-depth even though this builder never touches the filesystem.
 */
const repoRelativePath = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .refine(
      (p) => !/^([/\\]|[A-Za-z]:)/.test(p) && !/(^|[/\\])\.\.([/\\]|$)/.test(p),
      `${label} must be a repo-relative path (no leading '/' or drive prefix, no '..' segments)`,
    );

export const ForgeBuildRequestSchema = z.object({
  /** Human description of the UI or feature being forged. */
  targetDescription: z.string().min(1, "targetDescription must not be empty"),
  /** UI surface class for the implementation stage. */
  surface: z.enum(forgeSurfaces),
  /** Repo-relative path to the output directory for generated assets and code. */
  outputDir: repoRelativePath("outputDir"),
});

export type ForgeBuildRequest = z.infer<typeof ForgeBuildRequestSchema>;

// ---------------------------------------------------------------------------
// Stage ID constants
// ---------------------------------------------------------------------------

/** Canonical ordered stage IDs for the forge pipeline (§4 flow). */
export const FORGE_STAGE_IDS = [
  "forge_intent_brief",
  "forge_taste_calibration",
  "forge_design_directions",
  "forge_direction_approval",
  "forge_design_system_tokens",
  "forge_asset_plan",
  "forge_asset_generation",
  "forge_asset_manifest_reconcile",
  "forge_asset_qa",
  "forge_frontend_spec",
  "forge_implementation",
  "forge_browser_qa",
  "forge_a11y_perf",
  "forge_visual_critic",
  "forge_final_handoff",
] as const;

export type ForgeStageId = (typeof FORGE_STAGE_IDS)[number];

// ---------------------------------------------------------------------------
// Pipeline builder
// ---------------------------------------------------------------------------

/**
 * Build the full static forge pipeline (15 packets). Deterministic and pure.
 * Every packet passes validateTaskPacket. Linear DAG — each stage depends on the prior.
 */
export function buildForgePipelinePackets(request: ForgeBuildRequest): TaskPacketInput[] {
  const parsed = ForgeBuildRequestSchema.parse(request);
  return [
    stageIntentBrief(parsed),
    stageTasteCalibration(parsed),
    stageDesignDirections(parsed),
    stageDirectionApproval(parsed),
    stageDesignSystemTokens(parsed),
    stageAssetPlan(parsed),
    stageAssetGeneration(parsed),
    stageAssetManifestReconcile(parsed),
    stageAssetQa(parsed),
    stageFrontendSpec(parsed),
    stageImplementation(parsed),
    stageBrowserQa(parsed),
    stageA11yPerf(parsed),
    stageVisualCritic(parsed),
    stageFinalHandoff(parsed),
  ];
}

// ---------------------------------------------------------------------------
// Repair packet (PS-5 — NOT in static set)
// ---------------------------------------------------------------------------

/** Upper bound on repair-note length — operator/critic text embedded in packet metadata. */
const MAX_REPAIR_NOTES_LENGTH = 4000;

export const ForgeRepairOptsSchema = z.object({
  /** taskId of the visual_critic stage that triggered the repair. */
  visualCriticTaskId: z.string().min(1, "visualCriticTaskId must not be empty"),
  /** Human-readable summary of what the visual critic found (length-capped). */
  repairNotes: z
    .string()
    .min(1, "repairNotes must not be empty")
    .max(MAX_REPAIR_NOTES_LENGTH, `repairNotes must be <= ${MAX_REPAIR_NOTES_LENGTH} chars`),
});

export type ForgeRepairOpts = z.infer<typeof ForgeRepairOptsSchema>;

/**
 * Build the mid-run repair task packet for injection via appendTasks.
 *
 * PS-5: this packet is NOT part of the static create-time template.
 * Call appendTasks(runId, [buildForgeRepairPacket(request, opts)]) when the
 * visual_critic stage returns rework.
 *
 * @param request Original forge build request.
 * @param opts Includes visualCriticTaskId and repair summary.
 * @returns A TaskPacketInput that passes validateTaskPacket with dep on visual_critic.
 */
export function buildForgeRepairPacket(
  request: ForgeBuildRequest,
  opts: ForgeRepairOpts,
): TaskPacketInput {
  const parsed = ForgeBuildRequestSchema.parse(request);
  const parsedOpts = ForgeRepairOptsSchema.parse(opts);
  return buildPacket({
    taskId: "forge_repair",
    title: "Forge — Visual Critique Repair (Mid-Run)",
    ownerRole: "frontend_designer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["frontend_designer"],
    qualityGates: ["product_acceptance", "regression_safety_required"],
    goal:
      `Repair the implementation of "${parsed.targetDescription}" following visual_critic rework verdict. ` +
      `Critique notes: ${parsedOpts.repairNotes}. ` +
      "Address all findings from anti-generic-checker.ts, generic-copy-checker.ts, and visual-critique.ts. " +
      "After repair, the forge_visual_critic stage must be re-evaluated.",
    inputs: [
      `${parsed.outputDir}/visual-critique-report.md`,
      `${parsed.outputDir}/ (implementation to repair)`,
      "src/forge/anti-generic-checker.ts",
      "src/forge/generic-copy-checker.ts",
      "src/forge/visual-critique.ts",
    ],
    outputs: [
      `${parsed.outputDir}/ (repaired implementation)`,
      `${parsed.outputDir}/repair-plan.md`,
    ],
    dependency: parsedOpts.visualCriticTaskId,
    allowedWriteScope: [parsed.outputDir, "tests/"],
    outOfScope: ["Re-running visual critique — happens in forge_visual_critic after this stage"],
    acceptanceCriteria: [
      "All rework items from visual-critique-report.md are addressed",
      "anti-generic-checker.ts passes on the repaired implementation",
      "generic-copy-checker.ts passes on all repaired copy",
      "repair-plan.md documents each finding and how it was resolved",
    ],
    verificationSteps: [
      "Run anti-generic-checker.ts — must return pass",
      "Run generic-copy-checker.ts — must return pass",
      "Review repair-plan.md confirms all findings are closed",
    ],
    extraSecurityChecks: [
      "Repair must not introduce new security issues while fixing visual critique findings",
    ],
    extraAntiPatterns: [
      "Claiming repair complete without re-running anti-generic-checker",
      "Introducing new hardcoded values while repairing generic-copy findings",
    ],
    rollbackNotes: "Revert repair changes and revisit visual-critique-report.md findings.",
    handoffFormat:
      "Caveman: findings addressed, anti-generic recheck result, ready for visual_critic re-evaluation",
  });
}
