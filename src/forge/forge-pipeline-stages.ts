/**
 * Frontend Forge — staged pipeline stage definitions (P1-S5, companion to forge-pipeline.ts).
 *
 * Each `stage*` function returns a fully-populated, validateTaskPacket-clean TaskPacketInput
 * for one §4 pipeline stage. `buildPacket` is the shared packet helper (also used by the
 * mid-run repair packet in forge-pipeline.ts). Pure and deterministic — no I/O.
 *
 * Split out of forge-pipeline.ts to keep each module under the 800-line project limit.
 *
 * @module forge-pipeline-stages
 */

import type {
  TaskPacketInput,
  GateReviewRole,
  QualityGate,
  RetrievalRole,
  UiSurface,
} from "../domain/types.ts";
import type { ForgeBuildRequest } from "./forge-pipeline.ts";

/** Quality gate used for the C1 NON-WAIVABLE anti-generic check. */
export const VISUAL_CRITIC_C1_GATE: QualityGate = "product_acceptance";

// -- Shared constants --------------------------------------------------------

const ALL_GATE_REVIEWS: readonly GateReviewRole[] = ["reviewer", "qa_engineer", "security_reviewer"];

const BASE_SECURITY_CHECKS = [
  "No secrets or credentials in forge artefacts",
  "All user-provided inputs validated via Zod before processing",
  "No arbitrary shell-out or file-write from pipeline builder",
] as const;

const BASE_ANTI_PATTERNS = [
  "God-prompt single stage (roadmap §4 forbids — keep stages discrete)",
  "Conditional create-time task presence (PS-5 violation)",
  "Silent error swallowing — throw explicitly",
  "Mutation of input objects — return new copies",
] as const;

// -- Base packet helper -------------------------------------------------------

export interface StageSpec {
  taskId: string;
  title: string;
  ownerRole: RetrievalRole;
  completionStandard: TaskPacketInput["completionStandard"];
  requiredSpecialistRoles: RetrievalRole[];
  qualityGates: QualityGate[];
  goal: string;
  inputs: string[];
  outputs: string[];
  dependency: string | null;
  allowedWriteScope: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  verificationSteps: string[];
  extraSecurityChecks?: string[];
  extraAntiPatterns?: string[];
  rollbackNotes: string;
  handoffFormat: string;
  uiSurface?: UiSurface;
  playwrightRequired?: boolean;
}

export function buildPacket(spec: StageSpec): TaskPacketInput {
  return {
    taskId: spec.taskId,
    title: spec.title,
    ownerRole: spec.ownerRole,
    completionStandard: spec.completionStandard,
    requiredSpecialistRoles: spec.requiredSpecialistRoles,
    qualityGates: spec.qualityGates,
    goal: spec.goal,
    inputs: spec.inputs,
    outputs: spec.outputs,
    dependencies: spec.dependency !== null ? [spec.dependency] : [],
    allowedWriteScope: spec.allowedWriteScope,
    outOfScope: spec.outOfScope,
    acceptanceCriteria: spec.acceptanceCriteria,
    verificationSteps: spec.verificationSteps,
    requiredReviews: [...ALL_GATE_REVIEWS],
    securityChecks: spec.extraSecurityChecks
      ? [...BASE_SECURITY_CHECKS, ...spec.extraSecurityChecks]
      : [...BASE_SECURITY_CHECKS],
    antiPatterns: spec.extraAntiPatterns
      ? [...BASE_ANTI_PATTERNS, ...spec.extraAntiPatterns]
      : [...BASE_ANTI_PATTERNS],
    rollbackNotes: spec.rollbackNotes,
    handoffFormat: spec.handoffFormat,
    ...(spec.uiSurface !== undefined ? { uiSurface: spec.uiSurface } : {}),
    ...(spec.playwrightRequired !== undefined ? { playwrightRequired: spec.playwrightRequired } : {}),
  };
}

// -- Stage definitions -------------------------------------------------------

export function stageIntentBrief(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_intent_brief",
    title: "Forge — Intent Brief",
    ownerRole: "planner",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["planner"],
    qualityGates: ["product_acceptance"],
    goal:
      `Produce a structured intent brief for the forge target: "${req.targetDescription}". ` +
      "Define surface, scope, success criteria, and constraints. " +
      "This document is the source of truth for all downstream stages.",
    inputs: ["User forge request", "Existing product-state.md"],
    outputs: [`${req.outputDir}/forge-intent-brief.md`],
    dependency: null,
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Asset generation", "Code implementation", "Visual critique"],
    acceptanceCriteria: [
      "Intent brief is a non-empty structured document",
      "Surface, outputDir, and success criteria are explicitly stated",
      "All known constraints and risks are enumerated",
    ],
    verificationSteps: [
      "Read forge-intent-brief.md and confirm all required sections present",
      "Confirm surface matches the forge request input",
    ],
    rollbackNotes: "Delete forge-intent-brief.md and re-run intake.",
    handoffFormat: "Caveman: brief path, key decisions, surface, open questions",
  });
}

export function stageTasteCalibration(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_taste_calibration",
    title: "Forge — Taste Calibration",
    ownerRole: "frontend_designer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["frontend_designer"],
    qualityGates: ["product_acceptance"],
    goal:
      `Calibrate visual taste for "${req.targetDescription}". ` +
      "Gather reference examples and typographic/colour preferences from " +
      "frontend-inspiration-sources.md. Produce a taste-calibration artefact.",
    inputs: [
      `${req.outputDir}/forge-intent-brief.md`,
      ".archon/rules/frontend-inspiration-sources.md",
    ],
    outputs: [`${req.outputDir}/taste-calibration.md`],
    dependency: "forge_intent_brief",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Direction generation", "Asset production"],
    acceptanceCriteria: [
      "taste-calibration.md exists with reference examples",
      "Typography and colour preferences are documented",
      "Aesthetic constraints are explicit and actionable",
    ],
    verificationSteps: [
      "Read taste-calibration.md; confirm reference examples and constraints present",
    ],
    extraAntiPatterns: ["Accepting design direction without documented taste constraints"],
    rollbackNotes: "Delete taste-calibration.md and repeat calibration step.",
    handoffFormat: "Caveman: aesthetic direction, key constraints, reference URLs",
  });
}

export function stageDesignDirections(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_design_directions",
    title: "Forge — Design Directions",
    ownerRole: "frontend_designer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["frontend_designer"],
    qualityGates: ["product_acceptance", "tdd_required"],
    goal:
      `Generate ≥2 divergent design directions for "${req.targetDescription}" using ` +
      "direction-divergence.ts (council #2). Each direction must be genuinely distinct " +
      "in layout, colour system, and typographic hierarchy. Run the divergence checker " +
      "to confirm ≥2 directions pass the threshold before handing off.",
    inputs: [
      `${req.outputDir}/taste-calibration.md`,
      "src/forge/direction-divergence.ts",
      "src/forge/design-direction-contract.ts",
    ],
    outputs: [
      `${req.outputDir}/design-directions.json`,
      "Direction divergence checker output",
    ],
    dependency: "forge_taste_calibration",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Direction approval", "Token generation"],
    acceptanceCriteria: [
      "≥2 DesignDirection objects produced and pass direction-divergence.ts check",
      "Each direction has a unique colour system and layout approach",
      "direction-divergence.ts reports divergent: true for each pair checked",
    ],
    verificationSteps: [
      "Run direction-divergence.ts against design-directions.json",
      "Confirm ≥2 directions in output and divergence check passes",
    ],
    extraAntiPatterns: ["Producing only a single direction or near-identical variants"],
    rollbackNotes: "Delete design-directions.json and regenerate with more divergence.",
    handoffFormat: "Caveman: direction count, divergence result, direction summaries",
  });
}

export function stageDirectionApproval(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_direction_approval",
    title: "Forge — Direction Approval (Operator Gate)",
    ownerRole: "planner",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["planner"],
    qualityGates: ["product_acceptance"],
    goal:
      `Operator/human approval gate for design directions for "${req.targetDescription}". ` +
      "Present the ≥2 divergent directions to the operator and record the approved selection. " +
      "This is a mandatory human stop before investing in token generation.",
    inputs: [
      `${req.outputDir}/design-directions.json`,
      "Operator decision (required)",
    ],
    outputs: [`${req.outputDir}/direction-approval.md`],
    dependency: "forge_design_directions",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Token generation", "Asset production — must wait for operator decision"],
    acceptanceCriteria: [
      "direction-approval.md records which direction was selected",
      "Operator confirmation is explicitly documented",
    ],
    verificationSteps: [
      "Read direction-approval.md; confirm selected direction ID and operator sign-off",
    ],
    extraAntiPatterns: ["Auto-selecting a direction without operator input"],
    rollbackNotes: "Delete direction-approval.md and re-present directions to operator.",
    handoffFormat: "Caveman: selected direction ID, approval notes",
  });
}

export function stageDesignSystemTokens(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_design_system_tokens",
    title: "Forge — Design-System Token Override",
    ownerRole: "frontend_designer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["frontend_designer"],
    qualityGates: ["product_acceptance", "frontend_acceptance"],
    goal:
      `Generate design-system token overrides for the approved direction for "${req.targetDescription}". ` +
      "Use design-system-validator.ts (council #4/D1 pre-codegen guardrail) to validate all " +
      "token overrides. Only tokens that pass the validator are accepted.",
    inputs: [
      `${req.outputDir}/direction-approval.md`,
      `${req.outputDir}/design-directions.json`,
      "src/forge/design-system-validator.ts",
      "src/forge/design-system-contract.ts",
    ],
    outputs: [
      `${req.outputDir}/design-system-tokens.json`,
      "design-system-validator.ts validation report",
    ],
    dependency: "forge_direction_approval",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Asset production", "Code generation"],
    acceptanceCriteria: [
      "design-system-tokens.json passes design-system-validator.ts with no errors",
      "Token overrides are scoped to the approved direction",
    ],
    verificationSteps: [
      "Run design-system-validator.ts against design-system-tokens.json",
      "Confirm zero validator errors",
    ],
    extraAntiPatterns: ["Skipping design-system-validator.ts pre-codegen check"],
    rollbackNotes: "Delete design-system-tokens.json and regenerate from approved direction.",
    handoffFormat: "Caveman: token file path, validator result, any override warnings",
  });
}

export function stageAssetPlan(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_asset_plan",
    title: "Forge — Asset Plan",
    ownerRole: "backend_engineer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["backend_engineer"],
    qualityGates: ["product_acceptance"],
    goal:
      `Produce the AssetContract[] for "${req.targetDescription}" using asset-contract.ts. ` +
      "Enumerate all required assets (type, placement, format, outputPath, altText) " +
      "in a machine-readable contract that drives generation and QA downstream.",
    inputs: [
      `${req.outputDir}/design-system-tokens.json`,
      "src/forge/asset-contract.ts",
    ],
    outputs: [`${req.outputDir}/asset-contract.json`],
    dependency: "forge_design_system_tokens",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Asset generation", "Asset QA"],
    acceptanceCriteria: [
      "asset-contract.json is a valid AssetContract[] with at least one entry",
      "Every asset entry has id, assetType, outputPath, altText, and preferredFormat",
    ],
    verificationSteps: [
      "Parse asset-contract.json against AssetContract schema",
      "Confirm all required fields present for each entry",
    ],
    extraSecurityChecks: ["Output paths must be within the designated outputDir — no path traversal"],
    extraAntiPatterns: ["Producing asset contracts with missing altText (accessibility violation)"],
    rollbackNotes: "Delete asset-contract.json and regenerate from token state.",
    handoffFormat: "Caveman: asset count, types, any constraint warnings",
  });
}

export function stageAssetGeneration(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_asset_generation",
    title: "Forge — Asset Generation",
    ownerRole: "backend_engineer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["backend_engineer"],
    qualityGates: ["product_acceptance"],
    goal:
      `Generate all assets declared in the AssetContract for "${req.targetDescription}" ` +
      "using asset-provider.ts (D2 provider, bypass-flag gated). " +
      "Each asset must be written to its declared outputPath.",
    inputs: [`${req.outputDir}/asset-contract.json`, "src/forge/asset-provider.ts"],
    outputs: [`${req.outputDir}/assets/ (generated files per contract)`],
    dependency: "forge_asset_plan",
    allowedWriteScope: [req.outputDir, `${req.outputDir}/assets`],
    outOfScope: ["Asset QA", "Manifest reconciliation"],
    acceptanceCriteria: [
      "All assets declared in asset-contract.json are generated at their outputPath",
      "No generation errors; all provider responses are success",
    ],
    verificationSteps: [
      "Verify each outputPath from asset-contract.json exists on disk",
      "Confirm no provider error records in generation log",
    ],
    extraSecurityChecks: [
      "asset-provider.ts bypass flag must be explicitly set; not silently skipped",
      "Generated files must not embed executable content (no <script> in SVGs)",
    ],
    extraAntiPatterns: ["Silently skipping generation for assets that fail — throw loudly"],
    rollbackNotes: "Delete generated files in assets/ and re-run generation from contract.",
    handoffFormat: "Caveman: generated count, any failures, file paths",
  });
}

export function stageAssetManifestReconcile(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_asset_manifest_reconcile",
    title: "Forge — Asset Manifest Reconciliation",
    ownerRole: "backend_engineer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["backend_engineer"],
    qualityGates: ["product_acceptance"],
    goal:
      `Reconcile generated assets against the AssetContract for "${req.targetDescription}" ` +
      "using asset-manifest.ts. Produce a manifest that records each asset's actual path, " +
      "format, and hash, and flags any discrepancies between contract and generated output.",
    inputs: [
      `${req.outputDir}/asset-contract.json`,
      `${req.outputDir}/assets/`,
      "src/forge/asset-manifest.ts",
    ],
    outputs: [`${req.outputDir}/asset-manifest.json`],
    dependency: "forge_asset_generation",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Asset QA pass/fail decisions — handled in next stage"],
    acceptanceCriteria: [
      "asset-manifest.json lists all assets with status (present/missing)",
      "No contract entry is silently absent from the manifest",
    ],
    verificationSteps: [
      "Parse asset-manifest.json and confirm all contract IDs are accounted for",
      "Confirm no missing assets are unmarked",
    ],
    extraSecurityChecks: ["Manifest must not include paths outside the outputDir"],
    extraAntiPatterns: ["Silently dropping missing assets from the manifest"],
    rollbackNotes: "Delete asset-manifest.json and re-reconcile from contract + generated files.",
    handoffFormat: "Caveman: manifest path, present/missing counts, discrepancies",
  });
}

export function stageAssetQa(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_asset_qa",
    title: "Forge — Asset QA",
    ownerRole: "qa_engineer",
    completionStandard: "specialist_verified",
    requiredSpecialistRoles: ["qa_engineer"],
    qualityGates: ["product_acceptance", "regression_safety_required"],
    goal:
      `Run asset-qa.ts against all assets in the manifest for "${req.targetDescription}". ` +
      "Every asset must pass mechanical QA (format, altText, no XSS vectors). " +
      "Any failing asset blocks this stage; no silent passes.",
    inputs: [
      `${req.outputDir}/asset-manifest.json`,
      `${req.outputDir}/assets/`,
      "src/forge/asset-qa.ts",
    ],
    outputs: [`${req.outputDir}/asset-qa-report.json`],
    dependency: "forge_asset_manifest_reconcile",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Asset regeneration — re-run generation stage if QA fails"],
    acceptanceCriteria: [
      "asset-qa-report.json shows pass: true for every asset",
      "No QA-fail findings present for any mechanical check",
      "Security checks (no <script>, no on* events) all pass",
    ],
    verificationSteps: [
      "Run asset-qa.ts against each asset in the manifest",
      "Confirm asset-qa-report.json reports overall pass",
    ],
    extraSecurityChecks: [
      "Reject SVGs with <script> or on* event attributes (asset-qa.ts QA-004/QA-006)",
    ],
    extraAntiPatterns: ["Marking assets as passing QA without running asset-qa.ts mechanically"],
    rollbackNotes: "Delete asset-qa-report.json and re-run after fixing failing assets.",
    handoffFormat: "Caveman: pass/fail per asset, any security findings",
  });
}

export function stageFrontendSpec(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_frontend_spec",
    title: "Forge — Frontend Specification",
    ownerRole: "frontend_designer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["frontend_designer"],
    qualityGates: ["product_acceptance", "frontend_acceptance"],
    goal:
      `Produce the frontend specification for "${req.targetDescription}" from the approved ` +
      "design direction, design-system tokens, and QA-passed assets. " +
      "The spec must be unambiguous and directly consumable by the implementation stage.",
    inputs: [
      `${req.outputDir}/direction-approval.md`,
      `${req.outputDir}/design-system-tokens.json`,
      `${req.outputDir}/asset-qa-report.json`,
    ],
    outputs: [`${req.outputDir}/frontend-spec.md`],
    dependency: "forge_asset_qa",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Code implementation", "Browser QA"],
    acceptanceCriteria: [
      "frontend-spec.md documents all component structure, token usage, and asset placements",
      "Spec is unambiguous — implementation can proceed without further design decisions",
    ],
    verificationSteps: [
      "Read frontend-spec.md and confirm component structure, token refs, and asset placements",
    ],
    extraAntiPatterns: ["Leaving design decisions open for the implementation stage to resolve"],
    rollbackNotes: "Delete frontend-spec.md and regenerate from latest tokens + assets.",
    handoffFormat: "Caveman: spec path, component count, any open decisions flagged",
  });
}

export function stageImplementation(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_implementation",
    title: "Forge — Frontend Implementation",
    ownerRole: "frontend_designer",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["frontend_designer"],
    qualityGates: ["product_acceptance", "frontend_acceptance", "tdd_required"],
    goal:
      `Implement the frontend for "${req.targetDescription}" strictly from the frontend-spec. ` +
      "Apply design-system tokens, wire QA-passed assets, and ship working components. " +
      "Write component tests alongside implementation.",
    inputs: [
      `${req.outputDir}/frontend-spec.md`,
      `${req.outputDir}/design-system-tokens.json`,
      `${req.outputDir}/assets/`,
    ],
    outputs: [`${req.outputDir}/ (implemented components)`, "tests/ (component tests)"],
    dependency: "forge_frontend_spec",
    allowedWriteScope: [req.outputDir, "tests/"],
    outOfScope: ["Browser QA", "A11y / performance analysis"],
    acceptanceCriteria: [
      "All components from the frontend-spec are implemented",
      "Design-system tokens are applied — no hardcoded values",
      "Component tests pass",
    ],
    verificationSteps: [
      "npm test (component tests pass)",
      "Visual spot-check against frontend-spec",
    ],
    extraSecurityChecks: [
      "No hardcoded credentials or API keys in generated code",
      "User inputs sanitised at all entry points",
    ],
    extraAntiPatterns: ["Hardcoded colours or spacing — use design-system tokens only"],
    rollbackNotes: "Revert outputDir implementation files to prior commit.",
    handoffFormat: "Caveman: components implemented, test pass/fail, token compliance",
    uiSurface: req.surface === "none" ? "visual_change" : req.surface,
  });
}

export function stageBrowserQa(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_browser_qa",
    title: "Forge — Browser QA (Playwright)",
    ownerRole: "qa_engineer",
    completionStandard: "specialist_verified",
    requiredSpecialistRoles: ["qa_engineer"],
    qualityGates: ["product_acceptance", "e2e_required"],
    goal:
      `Run Playwright E2E tests for the implemented frontend of "${req.targetDescription}". ` +
      "Verify critical user flows, interactive states, and regression safety " +
      "before a11y/perf analysis.",
    inputs: [
      `${req.outputDir}/ (implemented components)`,
      `${req.outputDir}/frontend-spec.md`,
    ],
    outputs: [`${req.outputDir}/browser-qa-report.md`, "Playwright test results"],
    dependency: "forge_implementation",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["A11y / performance analysis — handled in next stage"],
    acceptanceCriteria: [
      "All Playwright tests pass",
      "No critical user flow regressions detected",
      "browser-qa-report.md records pass/fail per scenario",
    ],
    verificationSteps: [
      "npx playwright test (full suite passes)",
      "Review browser-qa-report.md for any failures",
    ],
    extraSecurityChecks: ["Playwright tests must not store credentials in test fixtures"],
    extraAntiPatterns: ["Skipping E2E tests with a manual check only"],
    rollbackNotes: "Revert implementation changes and re-run browser QA after fixes.",
    handoffFormat: "Caveman: test pass/fail counts, any regressions, report path",
    uiSurface: "interactive_flow",
    playwrightRequired: true,
  });
}

export function stageA11yPerf(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_a11y_perf",
    title: "Forge — Accessibility and Performance Analysis",
    ownerRole: "accessibility_engineer",
    completionStandard: "specialist_verified",
    requiredSpecialistRoles: ["accessibility_engineer", "performance_engineer"],
    qualityGates: ["accessibility_acceptance", "performance_check_required"],
    goal:
      `Run accessibility and performance analysis for "${req.targetDescription}". ` +
      "Accessibility: WCAG contrast checks via wcag-contrast.ts, keyboard navigation, " +
      "ARIA correctness. Performance: measure render time, bundle size, query cost. " +
      "Both specialists must produce evidence before this stage can close.",
    inputs: [
      `${req.outputDir}/ (implemented components)`,
      "src/forge/wcag-contrast.ts",
      "Performance profiling tooling",
    ],
    outputs: [`${req.outputDir}/a11y-report.md`, `${req.outputDir}/perf-report.md`],
    dependency: "forge_browser_qa",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Visual critique — handled in visual_critic stage"],
    acceptanceCriteria: [
      "WCAG contrast ratios pass for all text/background combinations",
      "Keyboard navigation verified for all interactive elements",
      "Performance metrics meet baseline thresholds",
      "Both accessibility_engineer and performance_engineer evidence records present",
    ],
    verificationSteps: [
      "Run wcag-contrast.ts and confirm zero contrast failures",
      "Performance profiling output shows render time within threshold",
    ],
    extraSecurityChecks: ["Performance testing must not expose sensitive timing data externally"],
    extraAntiPatterns: ["Passing a11y_perf without specialist evidence from both roles"],
    rollbackNotes: "Fix a11y or performance issues in implementation and re-run.",
    handoffFormat: "Caveman: a11y findings, contrast results, perf metrics, pass/fail",
  });
}

export function stageVisualCritic(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_visual_critic",
    title: "Forge — Visual Critique + C1 Anti-Generic Gate (NON-WAIVABLE)",
    ownerRole: "reviewer",
    completionStandard: "specialist_verified",
    requiredSpecialistRoles: ["reviewer"],
    qualityGates: [VISUAL_CRITIC_C1_GATE, "regression_safety_required"],
    goal:
      `Run the C1 NON-WAIVABLE anti-generic gate for "${req.targetDescription}" using ` +
      "anti-generic-checker.ts, generic-copy-checker.ts, and visual-critique.ts. " +
      "The anti-generic gate CANNOT be waived — if it fails, a repair task must be " +
      "injected via appendTasks (buildForgeRepairPacket) and this stage stays blocked. " +
      "Only when BOTH the anti-generic gate AND the visual critique pass may this stage close.",
    inputs: [
      `${req.outputDir}/ (implemented components)`,
      "src/forge/anti-generic-checker.ts (C1 NON-WAIVABLE)",
      "src/forge/generic-copy-checker.ts",
      "src/forge/visual-critique.ts",
    ],
    outputs: [
      `${req.outputDir}/visual-critique-report.md`,
      "Anti-generic gate verdict (pass|rework)",
    ],
    dependency: "forge_a11y_perf",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Implementing repairs — injected via buildForgeRepairPacket + appendTasks"],
    acceptanceCriteria: [
      "anti-generic-checker.ts returns pass — C1 gate is NON-WAIVABLE and must never be bypassed",
      "generic-copy-checker.ts returns pass — no generic copy",
      "visual-critique.ts aggregate verdict is pass",
      "visual-critique-report.md documents all findings",
    ],
    verificationSteps: [
      "Run anti-generic-checker.ts — must return pass",
      "Run generic-copy-checker.ts against all copy — must return pass",
      "Run visual-critique.ts — confirm aggregate verdict is pass",
      "Read visual-critique-report.md — confirm zero rework items",
    ],
    extraSecurityChecks: [
      "anti-generic-checker.ts result must not be bypassed under any circumstance (C1 non-waivable)",
    ],
    extraAntiPatterns: [
      "Waiving or bypassing the C1 anti-generic gate — explicitly forbidden",
      "Closing this stage when anti-generic-checker returns rework",
    ],
    rollbackNotes:
      "If C1 fails, inject buildForgeRepairPacket via appendTasks; restart after repair.",
    handoffFormat:
      "Caveman: anti-generic verdict, copy verdict, visual critique verdict, report path",
  });
}

export function stageFinalHandoff(req: ForgeBuildRequest): TaskPacketInput {
  return buildPacket({
    taskId: "forge_final_handoff",
    title: "Forge — Final Handoff",
    ownerRole: "planner",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: ["planner"],
    qualityGates: ["product_acceptance", "release_readiness_required"],
    goal:
      `Complete the forge run for "${req.targetDescription}". ` +
      "Produce a final handoff document summarising what was built, " +
      "linking all artefacts, recording gate evidence, and confirming production-readiness.",
    inputs: [
      `${req.outputDir}/visual-critique-report.md`,
      `${req.outputDir}/a11y-report.md`,
      `${req.outputDir}/perf-report.md`,
      "All prior stage outputs",
    ],
    outputs: [`${req.outputDir}/forge-handoff.md`],
    dependency: "forge_visual_critic",
    allowedWriteScope: [req.outputDir],
    outOfScope: ["Post-release monitoring — separate operational concern"],
    acceptanceCriteria: [
      "forge-handoff.md exists and references all stage outputs",
      "All required gates (visual critique, a11y, perf, browser QA) confirmed passed",
      "Release readiness evidence recorded",
    ],
    verificationSteps: [
      "Read forge-handoff.md and confirm all sections present",
      "Confirm gate evidence is cited for visual_critic, a11y_perf, and browser_qa",
    ],
    extraSecurityChecks: ["Final handoff must not include any secrets or credentials"],
    extraAntiPatterns: ["Claiming forge complete without release_readiness_required evidence"],
    rollbackNotes: "Delete forge-handoff.md; resolve open gate failures; re-run this stage.",
    handoffFormat: "Caveman: artefact paths, gate evidence links, outstanding issues (must be empty)",
  });
}
