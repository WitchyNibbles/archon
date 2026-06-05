import {
  architectureDecisionStatuses,
  duplicateFamilyMemberKinds,
  migrationConsistencyClasses,
  migrationStrategies,
  parityRequirementStatuses,
  understandingMapKinds
} from "../domain/types.ts";
import type {
  AnalysisPhase,
  ArchitectureDecisionRecord,
  ArchitectureDecisionStatus,
  AutonomousExecutionSnapshot,
  AutonomousExecutionState,
  CheckpointRecord,
  ComprehensionSummary,
  ContinuationAction,
  CoverageGapRecord,
  CoverageManifestRecord,
  CoverageSummary,
  CoverageItemRecord,
  DuplicateFamilyMemberKind,
  DuplicateFamilyRecord,
  ExternalEvalRecord,
  MigrationConsistencyClass,
  MigrationLedgerEntryRecord,
  MigrationStrategy,
  ParityRequirementRecord,
  ParityRequirementStatus,
  PhaseReadinessRecord,
  ProgressProofRecord,
  RuntimeTraceRecord,
  RunProfile,
  SensitiveActionControlRecord,
  TaskRecord,
  UnderstandingMapKind,
  UnderstandingMapRecord
} from "../domain/types.ts";
import { buildRuntimeTraceRegistry } from "./runtime-trace-registry.ts";

export interface AutonomousNextTarget {
  targetId: string;
  source: "blocking_gap" | "progress_proof" | "checkpoint";
  rationale: string[];
  actions: ContinuationAction[];
  nextActions: string[];
}

const fullyAnalyzedStates = new Set(["fully_analyzed", "validated", "migrated", "deprecated"]);
const validatedStates = new Set(["validated", "migrated", "deprecated"]);
const tracedStates = new Set(["validated", "migrated"]);
const autonomousQualityGates = new Set([
  "coverage_ledger_required",
  "progress_proof_required",
  "checkpoint_resume_required",
  "memory_compaction_required"
]);
const gapSeverityWeight = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
} as const;
const rewriteCriticalPhases = new Set<AnalysisPhase>([
  "modernization_strategy",
  "migration_sequencing",
  "final_verification",
  "done"
]);
const phaseSequence: readonly AnalysisPhase[] = [
  "discovery",
  "inventory",
  "dependency_mapping",
  "runtime_tracing",
  "subsystem_classification",
  "risk_analysis",
  "modernization_strategy",
  "migration_sequencing",
  "implementation",
  "validation",
  "regression_detection",
  "final_verification",
  "blocked",
  "done"
];
const fallbackPhaseByPhase: Partial<Record<AnalysisPhase, AnalysisPhase>> = {
  inventory: "discovery",
  dependency_mapping: "inventory",
  runtime_tracing: "dependency_mapping",
  subsystem_classification: "runtime_tracing",
  risk_analysis: "subsystem_classification",
  modernization_strategy: "runtime_tracing",
  migration_sequencing: "modernization_strategy",
  implementation: "migration_sequencing",
  validation: "implementation",
  regression_detection: "validation",
  final_verification: "regression_detection",
  done: "final_verification"
};
const requiredUnderstandingKindsByProfile: Record<RunProfile, readonly UnderstandingMapKind[]> = {
  standard_delivery: [
    "repo_map",
    "subsystems",
    "route_map",
    "integration_map",
    "config_coupling",
    "runtime_side_effects"
  ],
  legacy_rewrite: [
    "repo_map",
    "subsystems",
    "route_map",
    "model_map",
    "integration_map",
    "authz_map",
    "config_coupling",
    "runtime_side_effects"
  ],
  modernization_program: [
    "repo_map",
    "subsystems",
    "route_map",
    "model_map",
    "integration_map",
    "authz_map",
    "config_coupling",
    "runtime_side_effects",
    "domain_map",
    "symbol_graph",
    "call_graph",
    "dependency_graph",
    "invariant_ledger",
    "duplicate_families",
    "architecture_decisions",
    "migration_ledger",
    "parity_matrix"
  ],
  debug_heavy: ["repo_map", "subsystems", "route_map", "runtime_side_effects"]
};

function profileHasBroadRewriteScope(profile: RunProfile): boolean {
  return profile === "legacy_rewrite" || profile === "modernization_program";
}

function profileRequiresModernizationArtifacts(profile: RunProfile): boolean {
  return profile === "modernization_program";
}

function isFiniteMetric(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasNonEmptyStrings(values: readonly string[] | undefined): boolean {
  return Array.isArray(values) && values.some((value) => value.trim().length > 0);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return roundMetric(numerator / denominator);
}

function clampMetric(value: number): number {
  return roundMetric(Math.max(0, Math.min(1, value)));
}

function phaseIndex(phase: AnalysisPhase): number {
  return phaseSequence.indexOf(phase);
}

function nextPhaseFor(currentPhase: AnalysisPhase): AnalysisPhase | undefined {
  const index = phaseIndex(currentPhase);
  if (index < 0 || index >= phaseSequence.length - 1) {
    return undefined;
  }

  for (let candidateIndex = index + 1; candidateIndex < phaseSequence.length; candidateIndex += 1) {
    const candidate = phaseSequence[candidateIndex];
    if (candidate !== "blocked") {
      return candidate;
    }
  }

  return undefined;
}

function latestCheckpointRecord(checkpoints: readonly CheckpointRecord[]): CheckpointRecord | undefined {
  return [...checkpoints].sort((left, right) => {
    const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
    if (createdAtOrder !== 0) {
      return createdAtOrder;
    }
    return right.checkpointId.localeCompare(left.checkpointId);
  })[0];
}

function checkpointResumeTarget(checkpoint: CheckpointRecord | undefined): string | undefined {
  const activeTarget = checkpoint?.activeTargets.find((target) => target.trim().length > 0)?.trim();
  return activeTarget || undefined;
}

function progressProofResumeTarget(proof: ProgressProofRecord | undefined): string | undefined {
  const explicitTarget = proof?.nextTarget.trim();
  return explicitTarget || undefined;
}

export function isCheckpointStale(
  state: AutonomousExecutionState,
  checkpoint: CheckpointRecord | undefined
): boolean {
  if (!checkpoint) {
    return false;
  }

  if (
    typeof checkpoint.executionEpoch === "number" &&
    checkpoint.executionEpoch < state.executionEpoch
  ) {
    return true;
  }

  const checkpointPhaseIndex = phaseIndex(checkpoint.phase);
  const statePhaseIndex = phaseIndex(state.phase);
  return checkpointPhaseIndex >= 0 && statePhaseIndex >= 0 && checkpointPhaseIndex < statePhaseIndex;
}

function thresholdFallbackForProfile(profile: RunProfile, key: keyof CoverageManifestRecord["thresholds"]): number {
  switch (key) {
    case "inventoryCompleteness":
      return profileHasBroadRewriteScope(profile) ? 1 : 0.5;
    case "businessRuleCoverage":
      return profile === "modernization_program" ? 0.9 : profile === "legacy_rewrite" ? 0.8 : 0.3;
    case "maxContradictionGapCount":
      return profileHasBroadRewriteScope(profile) ? 0 : 1;
    case "maxOpenBlockers":
      return 0;
    case "criticalItemCoverage":
      return profile === "modernization_program" ? 0.9 : 0.8;
    case "criticalItemValidation":
      return profile === "modernization_program" ? 0.75 : 0.6;
    case "callsiteCoverage":
      return profile === "modernization_program" ? 0.9 : 0.85;
    case "runtimeTraceCoverage":
      return profile === "modernization_program" ? 0.85 : 0.75;
  }
}

function thresholdValue(
  manifest: CoverageManifestRecord | undefined,
  key: keyof CoverageManifestRecord["thresholds"],
  fallback: number
): number {
  return manifest?.thresholds[key] ?? fallback;
}

function collectCriticalItems(items: readonly CoverageItemRecord[]): CoverageItemRecord[] {
  return items.filter((item) => item.criticality === "high" || item.criticality === "critical");
}

function validateRatioMetric(label: string, value: number | undefined, errors: string[]): void {
  if (!isFiniteMetric(value) || value < 0 || value > 1) {
    errors.push(`${label} must be a finite number between 0 and 1`);
  }
}

function validateCountMetric(label: string, value: number | undefined, errors: string[]): void {
  if (!isFiniteMetric(value) || value < 0 || !Number.isInteger(value)) {
    errors.push(`${label} must be a non-negative integer`);
  }
}

export function validateCoverageManifestRecord(manifest: CoverageManifestRecord): string[] {
  const errors: string[] = [];

  if (!Array.isArray(manifest.requiredCategories) || manifest.requiredCategories.length === 0) {
    errors.push("requiredCategories must contain at least one category");
  }

  validateRatioMetric("thresholds.criticalItemCoverage", manifest.thresholds.criticalItemCoverage, errors);
  validateRatioMetric(
    "thresholds.criticalItemValidation",
    manifest.thresholds.criticalItemValidation,
    errors
  );
  validateRatioMetric("thresholds.callsiteCoverage", manifest.thresholds.callsiteCoverage, errors);
  validateRatioMetric("thresholds.runtimeTraceCoverage", manifest.thresholds.runtimeTraceCoverage, errors);
  if (manifest.thresholds.inventoryCompleteness !== undefined) {
    validateRatioMetric("thresholds.inventoryCompleteness", manifest.thresholds.inventoryCompleteness, errors);
  }
  if (manifest.thresholds.businessRuleCoverage !== undefined) {
    validateRatioMetric("thresholds.businessRuleCoverage", manifest.thresholds.businessRuleCoverage, errors);
  }
  if (manifest.thresholds.maxContradictionGapCount !== undefined) {
    validateCountMetric(
      "thresholds.maxContradictionGapCount",
      manifest.thresholds.maxContradictionGapCount,
      errors
    );
  }
  if (manifest.thresholds.maxOpenBlockers !== undefined) {
    validateCountMetric("thresholds.maxOpenBlockers", manifest.thresholds.maxOpenBlockers, errors);
  }

  return errors;
}

export function validateCoverageItemRecord(item: CoverageItemRecord): string[] {
  const errors: string[] = [];

  if (!hasNonEmptyStrings(item.sources)) {
    errors.push(`coverage item ${item.id} must include at least one source`);
  }

  if (!hasNonEmptyStrings(item.evidenceRefs)) {
    errors.push(`coverage item ${item.id} must include at least one evidenceRef`);
  }

  if (
    isFiniteMetric(item.callsiteCount) &&
    isFiniteMetric(item.callsitesAnalyzed) &&
    item.callsitesAnalyzed > item.callsiteCount
  ) {
    errors.push(`coverage item ${item.id} callsitesAnalyzed cannot exceed callsiteCount`);
  }

  if (item.state === "validated" && !hasNonEmptyStrings(item.verificationRefs)) {
    errors.push(`validated coverage item ${item.id} must include verificationRefs`);
  }

  if (item.confidence !== undefined) {
    validateRatioMetric(`coverage item ${item.id} confidence`, item.confidence, errors);
  }

  if (item.gapScore !== undefined) {
    validateRatioMetric(`coverage item ${item.id} gapScore`, item.gapScore, errors);
  }

  return errors;
}

export function isGapBlocking(gap: CoverageGapRecord): boolean {
  return gap.status === "open" && (gap.blocking || gap.severity === "critical");
}

export function validateCoverageGapRecord(gap: CoverageGapRecord): string[] {
  const errors: string[] = [];

  if (gap.targetId.trim().length === 0) {
    errors.push(`gap ${gap.id} must include a targetId`);
  }

  if (!hasNonEmptyStrings(gap.evidenceRefs)) {
    errors.push(`gap ${gap.id} must include evidenceRefs`);
  }

  if (gap.createdBy.trim().length === 0) {
    errors.push(`gap ${gap.id} must include createdBy`);
  }

  if (gap.status === "open" && !hasNonEmptyStrings(gap.suggestedNextActions)) {
    errors.push(`open gap ${gap.id} must include suggestedNextActions`);
  }

  return errors;
}

export function hasMeaningfulProgressDelta(proof: ProgressProofRecord): boolean {
  const hasCoverageDelta = Object.values(proof.coverageDelta).some(
    (value) => typeof value === "number" && Number.isFinite(value) && value !== 0
  );
  const hasGapDelta =
    (typeof proof.blockingGapDelta?.closed === "number" && proof.blockingGapDelta.closed !== 0) ||
    (typeof proof.blockingGapDelta?.opened === "number" && proof.blockingGapDelta.opened !== 0);

  return hasCoverageDelta || hasGapDelta;
}

export function validateProgressProofRecord(proof: ProgressProofRecord): string[] {
  const errors: string[] = [];
  const nextTarget = proof.nextTarget.trim();
  const whyNext = (proof.whyNext ?? "").trim();

  if (!Number.isInteger(proof.cycle) || proof.cycle <= 0) {
    errors.push(`progress proof ${proof.proofId} cycle must be a positive integer`);
  }

  if (!hasNonEmptyStrings(proof.evidenceRefs)) {
    errors.push(`progress proof ${proof.proofId} must include evidenceRefs`);
  }

  if (nextTarget.length > 0 && whyNext.length === 0) {
    errors.push(`progress proof ${proof.proofId} must include whyNext`);
  }

  if (!hasMeaningfulProgressDelta(proof)) {
    errors.push(`progress proof ${proof.proofId} must record a measurable delta`);
  }

  return errors;
}

export function validateUnderstandingMapRecord(map: UnderstandingMapRecord): string[] {
  const errors: string[] = [];

  if (!understandingMapKinds.includes(map.kind as UnderstandingMapKind)) {
    errors.push(`understanding map ${map.kind} has an unsupported kind`);
  }

  validateCountMetric(`understanding map ${map.kind} itemCount`, map.itemCount, errors);

  if (map.analyzedCount !== undefined) {
    validateCountMetric(`understanding map ${map.kind} analyzedCount`, map.analyzedCount, errors);
    if (isFiniteMetric(map.analyzedCount) && isFiniteMetric(map.itemCount) && map.analyzedCount > map.itemCount) {
      errors.push(`understanding map ${map.kind} analyzedCount cannot exceed itemCount`);
    }
  }

  if (!hasNonEmptyStrings(map.sourceRefs)) {
    errors.push(`understanding map ${map.kind} must include sourceRefs`);
  }

  if (!hasNonEmptyStrings(map.evidenceRefs)) {
    errors.push(`understanding map ${map.kind} must include evidenceRefs`);
  }

  return errors;
}

export function validateRuntimeTraceRecord(trace: RuntimeTraceRecord): string[] {
  const errors: string[] = [];

  if (trace.traceId.trim().length === 0) {
    errors.push("runtime trace must include traceId");
  }

  if (trace.targetId.trim().length === 0) {
    errors.push(`runtime trace ${trace.traceId} must include targetId`);
  }

  if (!hasNonEmptyStrings(trace.evidenceRefs)) {
    errors.push(`runtime trace ${trace.traceId} must include evidenceRefs`);
  }

  if (trace.risky && !hasNonEmptyStrings(trace.sideEffects)) {
    errors.push(`runtime trace ${trace.traceId} must include sideEffects for risky flows`);
  }

  return errors;
}

export function validateDuplicateFamilyRecord(record: DuplicateFamilyRecord): string[] {
  const errors: string[] = [];

  if (record.familyId.trim().length === 0) {
    errors.push("duplicate family must include familyId");
  }

  if (record.capability.trim().length === 0) {
    errors.push(`duplicate family ${record.familyId} must include capability`);
  }

  if (!Array.isArray(record.members) || record.members.length === 0) {
    errors.push(`duplicate family ${record.familyId} must include at least one member`);
  } else {
    const memberIds = new Set<string>();
    for (const member of record.members) {
      if (member.itemId.trim().length === 0) {
        errors.push(`duplicate family ${record.familyId} has a member without itemId`);
        continue;
      }
      if (memberIds.has(member.itemId)) {
        errors.push(`duplicate family ${record.familyId} contains duplicate member ${member.itemId}`);
      }
      memberIds.add(member.itemId);
      if (!duplicateFamilyMemberKinds.includes(member.kind as DuplicateFamilyMemberKind)) {
        errors.push(
          `duplicate family ${record.familyId} member ${member.itemId} has unsupported kind ${String(member.kind)}`
        );
      }
    }
  }

  if (!hasNonEmptyStrings(record.evidenceRefs)) {
    errors.push(`duplicate family ${record.familyId} must include evidenceRefs`);
  }

  if (record.centralizationCandidate?.trim() && !hasNonEmptyStrings(record.parityRequirements)) {
    errors.push(
      `duplicate family ${record.familyId} must include parityRequirements when a centralizationCandidate is present`
    );
  }

  return errors;
}

export function validateArchitectureDecisionRecord(record: ArchitectureDecisionRecord): string[] {
  const errors: string[] = [];

  if (record.decisionId.trim().length === 0) {
    errors.push("architecture decision must include decisionId");
  }

  if (record.title.trim().length === 0) {
    errors.push(`architecture decision ${record.decisionId} must include title`);
  }

  if (!architectureDecisionStatuses.includes(record.status as ArchitectureDecisionStatus)) {
    errors.push(
      `architecture decision ${record.decisionId} has unsupported status ${String(record.status)}`
    );
  }

  if (!hasNonEmptyStrings(record.options)) {
    errors.push(`architecture decision ${record.decisionId} must include options`);
  }

  if (record.chosenOption.trim().length === 0) {
    errors.push(`architecture decision ${record.decisionId} must include chosenOption`);
  }

  if (!hasNonEmptyStrings(record.boundedContexts)) {
    errors.push(`architecture decision ${record.decisionId} must include boundedContexts`);
  }

  if (!hasNonEmptyStrings(record.consistencyNeeds)) {
    errors.push(`architecture decision ${record.decisionId} must include consistencyNeeds`);
  }

  if (!hasNonEmptyStrings(record.rationale)) {
    errors.push(`architecture decision ${record.decisionId} must include rationale`);
  }

  if (!hasNonEmptyStrings(record.evidenceRefs)) {
    errors.push(`architecture decision ${record.decisionId} must include evidenceRefs`);
  }

  return errors;
}

export function validateMigrationLedgerEntryRecord(record: MigrationLedgerEntryRecord): string[] {
  const errors: string[] = [];

  if (record.entryId.trim().length === 0) {
    errors.push("migration ledger entry must include entryId");
  }

  if (record.boundedContext.trim().length === 0) {
    errors.push(`migration ledger entry ${record.entryId} must include boundedContext`);
  }

  if (!hasNonEmptyStrings(record.sourceModels)) {
    errors.push(`migration ledger entry ${record.entryId} must include sourceModels`);
  }

  if (!hasNonEmptyStrings(record.targetModels)) {
    errors.push(`migration ledger entry ${record.entryId} must include targetModels`);
  }

  if (!migrationStrategies.includes(record.strategy as MigrationStrategy)) {
    errors.push(
      `migration ledger entry ${record.entryId} has unsupported strategy ${String(record.strategy)}`
    );
  }

  if (!migrationConsistencyClasses.includes(record.consistencyClass as MigrationConsistencyClass)) {
    errors.push(
      `migration ledger entry ${record.entryId} has unsupported consistencyClass ${String(record.consistencyClass)}`
    );
  }

  if (record.ownership.trim().length === 0) {
    errors.push(`migration ledger entry ${record.entryId} must include ownership`);
  }

  if (!hasNonEmptyStrings(record.rolloutSteps)) {
    errors.push(`migration ledger entry ${record.entryId} must include rolloutSteps`);
  }

  if (!hasNonEmptyStrings(record.rollbackPlan)) {
    errors.push(`migration ledger entry ${record.entryId} must include rollbackPlan`);
  }

  if (!hasNonEmptyStrings(record.evidenceRefs)) {
    errors.push(`migration ledger entry ${record.entryId} must include evidenceRefs`);
  }

  return errors;
}

export function validateParityRequirementRecord(record: ParityRequirementRecord): string[] {
  const errors: string[] = [];

  if (record.requirementId.trim().length === 0) {
    errors.push("parity requirement must include requirementId");
  }

  if (record.capability.trim().length === 0) {
    errors.push(`parity requirement ${record.requirementId} must include capability`);
  }

  if (!parityRequirementStatuses.includes(record.status as ParityRequirementStatus)) {
    errors.push(
      `parity requirement ${record.requirementId} has unsupported status ${String(record.status)}`
    );
  }

  if (!hasNonEmptyStrings(record.legacyRefs)) {
    errors.push(`parity requirement ${record.requirementId} must include legacyRefs`);
  }

  if (!hasNonEmptyStrings(record.targetRefs)) {
    errors.push(`parity requirement ${record.requirementId} must include targetRefs`);
  }

  if (!hasNonEmptyStrings(record.acceptanceChecks)) {
    errors.push(`parity requirement ${record.requirementId} must include acceptanceChecks`);
  }

  if (!hasNonEmptyStrings(record.evidenceRefs)) {
    errors.push(`parity requirement ${record.requirementId} must include evidenceRefs`);
  }

  return errors;
}

export function validateExternalEvalRecord(record: ExternalEvalRecord): string[] {
  const errors: string[] = [];

  if (record.evalId.trim().length === 0) {
    errors.push("external eval must include evalId");
  }

  if (record.label.trim().length === 0) {
    errors.push(`external eval ${record.evalId} must include label`);
  }

  if (record.harness.trim().length === 0) {
    errors.push(`external eval ${record.evalId} must include harness`);
  }

  if (record.artifactRef.trim().length === 0) {
    errors.push(`external eval ${record.evalId} must include artifactRef`);
  }

  if (!hasNonEmptyStrings(record.evidenceRefs)) {
    errors.push(`external eval ${record.evalId} must include evidenceRefs`);
  }

  return errors;
}

export function validateSensitiveActionControlRecord(record: SensitiveActionControlRecord): string[] {
  const errors: string[] = [];

  if (record.controlId.trim().length === 0) {
    errors.push("sensitive action control must include controlId");
  }

  if (record.summary.trim().length === 0) {
    errors.push(`sensitive action control ${record.controlId} must include summary`);
  }

  if (!hasNonEmptyStrings(record.evidenceRefs)) {
    errors.push(`sensitive action control ${record.controlId} must include evidenceRefs`);
  }

  return errors;
}

export function runRequiresAutonomousExecution(tasks: readonly TaskRecord[]): boolean {
  return tasks.some((task) => task.packet.qualityGates.some((gate) => autonomousQualityGates.has(gate)));
}

export function createAutonomousExecutionState(input: {
  now: string;
  profile?: AutonomousExecutionState["profile"] | undefined;
  manifest?: CoverageManifestRecord | undefined;
  phase?: AnalysisPhase | undefined;
}): AutonomousExecutionState {
  return {
    enabled: true,
    profile: input.profile ?? "standard_delivery",
    phase: input.phase ?? "discovery",
    manifest: input.manifest,
    coverageItems: [],
    gaps: [],
    checkpoints: [],
    progressProofs: [],
    understandingMaps: [],
    runtimeTraces: [],
    duplicateFamilies: [],
    architectureDecisions: [],
    migrationLedger: [],
    parityMatrix: [],
    externalEvals: [],
    sensitiveActionControls: [],
    pendingInvestigations: [],
    executionEpoch: 1,
    updatedAt: input.now
  };
}

export function computeCoverageSummary(state: AutonomousExecutionState): CoverageSummary {
  const criticalItems = collectCriticalItems(state.coverageItems);
  const tracedItems = criticalItems.filter(
    (item) => item.runtimeTraced === true || tracedStates.has(item.state)
  );
  const fullyAnalyzedCritical = criticalItems.filter((item) => fullyAnalyzedStates.has(item.state));
  const validatedCritical = criticalItems.filter((item) => validatedStates.has(item.state));
  const callsiteEligibleItems = criticalItems.filter((item) => (item.callsiteCount ?? 0) > 0);
  const totalCallsites = callsiteEligibleItems.reduce(
    (sum, item) => sum + Math.max(0, item.callsiteCount ?? 0),
    0
  );
  const analyzedCallsites = callsiteEligibleItems.reduce(
    (sum, item) => sum + Math.max(0, Math.min(item.callsitesAnalyzed ?? 0, item.callsiteCount ?? 0)),
    0
  );
  const openGaps = state.gaps.filter((gap) => gap.status === "open");
  const blockingGaps = openGaps.filter((gap) => isGapBlocking(gap));

  return {
    totalItems: state.coverageItems.length,
    discoveredItems: state.coverageItems.filter((item) => item.state === "discovered").length,
    partiallyAnalyzedItems: state.coverageItems.filter((item) => item.state === "partially_analyzed").length,
    fullyAnalyzedItems: state.coverageItems.filter((item) => item.state === "fully_analyzed").length,
    validatedItems: state.coverageItems.filter((item) => item.state === "validated").length,
    migratedItems: state.coverageItems.filter((item) => item.state === "migrated").length,
    blockedItems: state.coverageItems.filter((item) => item.state === "blocked").length,
    criticalItemCoverage: ratio(fullyAnalyzedCritical.length, criticalItems.length),
    criticalItemValidation: ratio(validatedCritical.length, criticalItems.length),
    callsiteCoverage: ratio(analyzedCallsites, totalCallsites),
    runtimeTraceCoverage: ratio(tracedItems.length, criticalItems.length),
    openGapCount: openGaps.length,
    blockingGapCount: blockingGaps.length
  };
}

function requiredUnderstandingKinds(profile: RunProfile): UnderstandingMapKind[] {
  return [...requiredUnderstandingKindsByProfile[profile]];
}

export function computeComprehensionSummary(
  state: AutonomousExecutionState,
  coverageSummary: CoverageSummary
): ComprehensionSummary {
  const understandingMaps = state.understandingMaps ?? [];
  const traceRegistry = buildRuntimeTraceRegistry(state);
  const runtimeTraces = state.runtimeTraces ?? [];
  const duplicateFamilies = state.duplicateFamilies ?? [];
  const architectureDecisions = state.architectureDecisions ?? [];
  const migrationLedger = state.migrationLedger ?? [];
  const parityMatrix = state.parityMatrix ?? [];
  const requiredKinds = requiredUnderstandingKinds(state.profile);
  const presentKinds = [
    ...new Set(
      understandingMaps
        .map((map) => map.kind)
        .filter((kind): kind is UnderstandingMapKind =>
          understandingMapKinds.includes(kind as UnderstandingMapKind)
        )
    )
  ].sort();
  const missingKinds = requiredKinds.filter((kind) => !presentKinds.includes(kind));
  const inventoryCompleteness = ratio(requiredKinds.length - missingKinds.length, requiredKinds.length);
  const criticalItems = collectCriticalItems(state.coverageItems);
  const businessRuleCoverage = ratio(
    criticalItems.filter((item) => hasNonEmptyStrings(item.businessRules) || hasNonEmptyStrings(item.invariants)).length,
    criticalItems.length
  );
  const duplicateFamilyCount = duplicateFamilies.length;
  const duplicateFamilyMemberCount = duplicateFamilies.reduce(
    (sum, family) => sum + family.members.length,
    0
  );
  const centralizationCandidateCount = duplicateFamilies.filter(
    (family) => (family.centralizationCandidate?.trim().length ?? 0) > 0
  ).length;
  const architectureDecisionCount = architectureDecisions.length;
  const migrationLedgerCount = migrationLedger.length;
  const parityRequirementCount = parityMatrix.length;
  const contradictionGapCount = state.gaps.filter(
    (gap) => gap.status === "open" && gap.kind === "contradicting_evidence"
  ).length;
  const openInventoryGaps = state.gaps.filter(
    (gap) => gap.status === "open" && gap.kind === "missing_inventory"
  );
  const openBlockerCount = coverageSummary.blockingGapCount;
  const riskyTraceCount = traceRegistry.riskyTraceCount;
  const missingEvidence: string[] = [];
  const readinessScope = profileHasBroadRewriteScope(state.profile) ? "broad" : "profile_limited";
  const profileLimitations: string[] = [];
  const inventoryThreshold = thresholdValue(
    state.manifest,
    "inventoryCompleteness",
    thresholdFallbackForProfile(state.profile, "inventoryCompleteness")
  );
  const businessRuleThreshold = thresholdValue(
    state.manifest,
    "businessRuleCoverage",
    thresholdFallbackForProfile(state.profile, "businessRuleCoverage")
  );
  const runtimeTraceThreshold = thresholdValue(
    state.manifest,
    "runtimeTraceCoverage",
    thresholdFallbackForProfile(state.profile, "runtimeTraceCoverage")
  );
  const maxContradictionGapCount = thresholdValue(
    state.manifest,
    "maxContradictionGapCount",
    thresholdFallbackForProfile(state.profile, "maxContradictionGapCount")
  );
  const maxOpenBlockers = thresholdValue(
    state.manifest,
    "maxOpenBlockers",
    thresholdFallbackForProfile(state.profile, "maxOpenBlockers")
  );

  if (inventoryCompleteness < inventoryThreshold) {
    missingEvidence.push(
      `inventory completeness ${inventoryCompleteness} is below threshold ${inventoryThreshold}`
    );
  }

  for (const kind of missingKinds) {
    missingEvidence.push(
      profileRequiresModernizationArtifacts(state.profile)
        ? `modernization artifact missing: ${kind}`
        : `understanding map missing: ${kind}`
    );
  }

  if (businessRuleCoverage < businessRuleThreshold) {
    missingEvidence.push(
      `business rule or invariant coverage ${businessRuleCoverage} is below threshold ${businessRuleThreshold}`
    );
  }

  if (coverageSummary.runtimeTraceCoverage < runtimeTraceThreshold) {
    missingEvidence.push(
      `runtime trace coverage ${coverageSummary.runtimeTraceCoverage} is below threshold ${runtimeTraceThreshold}`
    );
  }

  if (riskyTraceCount === 0 && runtimeTraceThreshold > 0) {
    missingEvidence.push("risky runtime traces are missing from the trace registry");
  }

  for (const targetId of traceRegistry.riskyTargetsMissingTrace) {
    missingEvidence.push(`runtime trace missing for risky target: ${targetId}`);
  }

  if (traceRegistry.openMissingTraceGapIds.length > 0) {
    missingEvidence.push(
      `open runtime trace gaps: ${traceRegistry.openMissingTraceGapIds.join(", ")}`
    );
  }

  if (contradictionGapCount > maxContradictionGapCount) {
    missingEvidence.push(
      `contradiction gap count ${contradictionGapCount} exceeds threshold ${maxContradictionGapCount}`
    );
  }

  if (openBlockerCount > maxOpenBlockers) {
    missingEvidence.push(`open blocker count ${openBlockerCount} exceeds threshold ${maxOpenBlockers}`);
  }

  if (
    profileHasBroadRewriteScope(state.profile) &&
    (state.phase === "modernization_strategy" || state.phase === "migration_sequencing")
  ) {
    for (const gap of openInventoryGaps) {
      missingEvidence.push(`inventory gap open: ${gap.description}`);
    }
  }

  if (readinessScope === "profile_limited") {
    profileLimitations.push(
      `profile ${state.profile} is task-scoped and does not establish broad rewrite readiness`
    );
    missingEvidence.push(...profileLimitations);
  }

  const rewriteReadiness =
    missingEvidence.length === 0
      ? "ready"
      : missingEvidence.every((evidence) => profileLimitations.includes(evidence))
        ? "profile_limited"
        : "blocked";

  return {
    inventoryCompleteness,
    businessRuleCoverage,
    duplicateFamilyCount,
    duplicateFamilyMemberCount,
    centralizationCandidateCount,
    architectureDecisionCount,
    migrationLedgerCount,
    parityRequirementCount,
    contradictionGapCount,
    openBlockerCount,
    requiredUnderstandingKinds: requiredKinds,
    presentUnderstandingKinds: presentKinds,
    missingUnderstandingKinds: missingKinds,
    requiredArtifactKinds: requiredKinds,
    presentArtifactKinds: presentKinds,
    missingArtifactKinds: missingKinds,
    runtimeTraceCount: runtimeTraces.length,
    readinessScope,
    rewriteReadiness,
    profileLimitations,
    missingEvidence
  };
}

export function computePhaseReadiness(
  state: AutonomousExecutionState,
  summary: CoverageSummary,
  comprehensionSummary: ComprehensionSummary
): PhaseReadinessRecord {
  const reasons: string[] = [];
  const latestCheckpoint = latestCheckpointRecord(state.checkpoints);
  const staleCheckpoint = isCheckpointStale(state, latestCheckpoint);

  if (!state.manifest) {
    reasons.push("coverage manifest missing");
  }

  if (state.phase === "modernization_strategy" || state.phase === "migration_sequencing" || state.phase === "final_verification" || state.phase === "done") {
    const criticalCoverageThreshold = thresholdValue(state.manifest, "criticalItemCoverage", 0.8);
    const criticalValidationThreshold = thresholdValue(state.manifest, "criticalItemValidation", 0.6);
    const callsiteThreshold = thresholdValue(state.manifest, "callsiteCoverage", 0.85);
    const runtimeTraceThreshold = thresholdValue(state.manifest, "runtimeTraceCoverage", 0.75);

    if (summary.criticalItemCoverage < criticalCoverageThreshold) {
      reasons.push(
        `critical item coverage ${summary.criticalItemCoverage} is below threshold ${criticalCoverageThreshold}`
      );
    }

    if (summary.criticalItemValidation < criticalValidationThreshold) {
      reasons.push(
        `critical item validation ${summary.criticalItemValidation} is below threshold ${criticalValidationThreshold}`
      );
    }

    if (summary.callsiteCoverage < callsiteThreshold) {
      reasons.push(`callsite coverage ${summary.callsiteCoverage} is below threshold ${callsiteThreshold}`);
    }

    if (
      (state.phase === "migration_sequencing" || state.phase === "final_verification" || state.phase === "done") &&
      summary.runtimeTraceCoverage < runtimeTraceThreshold
    ) {
      reasons.push(
        `runtime trace coverage ${summary.runtimeTraceCoverage} is below threshold ${runtimeTraceThreshold}`
      );
    }
  }

  if ((state.phase === "final_verification" || state.phase === "done") && state.progressProofs.length === 0) {
    reasons.push("final verification requires at least one progress proof");
  }

  if ((state.phase === "final_verification" || state.phase === "done") && state.checkpoints.length === 0) {
    reasons.push("final verification requires at least one checkpoint");
  }

  if (staleCheckpoint && latestCheckpoint) {
    reasons.push(
      `latest checkpoint ${latestCheckpoint.checkpointId} is stale for execution epoch ${state.executionEpoch}`
    );
  }

  if (state.retryBudgetRemaining !== undefined && state.retryBudgetRemaining <= 0) {
    reasons.push("retry budget exhausted for the current autonomous phase");
  }

  if (summary.blockingGapCount > 0) {
    reasons.push(`blocking gaps remain open: ${summary.blockingGapCount}`);
  }

  if (profileHasBroadRewriteScope(state.profile) && rewriteCriticalPhases.has(state.phase)) {
    reasons.push(...comprehensionSummary.missingEvidence);
  }

  const blockerKind =
    reasons.length === 0
      ? "none"
      : state.retryBudgetRemaining !== undefined && state.retryBudgetRemaining <= 0
        ? "retry_budget_exhausted"
        : staleCheckpoint
          ? "stale_checkpoint"
          : comprehensionSummary.contradictionGapCount > 0
            ? "contradiction_loop"
            : summary.blockingGapCount > 0
              ? "blocking_gap"
              : "missing_evidence";
  const nextPhase = reasons.length === 0 ? nextPhaseFor(state.phase) : undefined;
  const fallbackPhase =
    reasons.length > 0 && blockerKind !== "retry_budget_exhausted"
      ? fallbackPhaseByPhase[state.phase]
      : undefined;
  const transition =
    reasons.length === 0
      ? state.phase === "done"
        ? "complete"
        : nextPhase
          ? "advance"
          : "hold"
      : fallbackPhase
        ? "fallback"
        : "hold";
  const continuationPenalty =
    (reasons.length > 0 ? 0.25 : 0) +
    Math.min(summary.blockingGapCount * 0.2, 0.4) +
    (staleCheckpoint ? 0.15 : 0) +
    (state.retryBudgetRemaining !== undefined && state.retryBudgetRemaining <= 0 ? 0.2 : 0) +
    ((state.phase === "final_verification" || state.phase === "done") && state.progressProofs.length === 0 ? 0.1 : 0);

  return {
    phase: state.phase,
    status: reasons.length === 0 ? "ready" : "blocked",
    reasons,
    transition,
    blockerKind,
    nextPhase,
    fallbackPhase,
    continuationScore: clampMetric(1 - continuationPenalty),
    latestCheckpointId: latestCheckpoint?.checkpointId,
    staleCheckpoint,
    executionEpoch: state.executionEpoch,
    retryBudgetRemaining: state.retryBudgetRemaining
  };
}

export function buildAutonomousExecutionSnapshot(
  state: AutonomousExecutionState
): AutonomousExecutionSnapshot {
  const coverageSummary = computeCoverageSummary(state);
  const comprehensionSummary = computeComprehensionSummary(state, coverageSummary);
  return {
    state,
    coverageSummary,
    comprehensionSummary,
    phaseReadiness: computePhaseReadiness(state, coverageSummary, comprehensionSummary),
    blockingGaps: state.gaps.filter((gap) => isGapBlocking(gap))
  };
}

export function collectAutonomousExecutionBlockers(
  state: AutonomousExecutionState,
  tasks: readonly TaskRecord[]
): string[] {
  const snapshot = buildAutonomousExecutionSnapshot(state);
  const blockers = [...snapshot.phaseReadiness.reasons];
  const taskQualityGates = new Set(tasks.flatMap((task) => task.packet.qualityGates));

  if (taskQualityGates.has("coverage_ledger_required")) {
    if (!state.manifest) {
      blockers.push("coverage ledger required but no manifest is recorded");
    } else {
      const manifestErrors = validateCoverageManifestRecord(state.manifest);
      if (manifestErrors.length > 0) {
        blockers.push(`coverage manifest is invalid: ${manifestErrors.join("; ")}`);
      }
    }
  }

  if (
    taskQualityGates.has("progress_proof_required") &&
    !state.progressProofs.some((proof) => validateProgressProofRecord(proof).length === 0)
  ) {
    blockers.push("progress proof required but none is valid");
  }

  if (taskQualityGates.has("checkpoint_resume_required") && state.checkpoints.length === 0) {
    blockers.push("checkpoint/resume required but no checkpoint is recorded");
  }

  if (taskQualityGates.has("memory_compaction_required")) {
    const latestCheckpoint = state.checkpoints[state.checkpoints.length - 1];
    if (!latestCheckpoint?.compressedContextRef) {
      blockers.push("memory compaction required but the latest checkpoint lacks compressed context");
    } else if (!latestCheckpoint.compressedContextSummary?.trim()) {
      blockers.push("memory compaction required but the latest checkpoint lacks compressed context summary");
    } else if (!hasNonEmptyStrings(latestCheckpoint.compressedContextSourceRefs)) {
      blockers.push("memory compaction required but the latest checkpoint lacks compressed context provenance");
    }
  }

  if (
    profileHasBroadRewriteScope(state.profile) &&
    rewriteCriticalPhases.has(state.phase) &&
    snapshot.comprehensionSummary?.rewriteReadiness === "blocked"
  ) {
    blockers.push("rewrite recommendation blocked: critical repo-understanding threshold not met");
  }

  return [...new Set(blockers)];
}

export function mergeCoverageItems(
  existing: readonly CoverageItemRecord[],
  updates: readonly CoverageItemRecord[]
): CoverageItemRecord[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of updates) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function mergeCoverageGaps(
  existing: readonly CoverageGapRecord[],
  updates: readonly CoverageGapRecord[]
): CoverageGapRecord[] {
  const byId = new Map(existing.map((gap) => [gap.id, gap]));
  for (const gap of updates) {
    byId.set(gap.id, gap);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function mergeUnderstandingMaps(
  existing: readonly UnderstandingMapRecord[],
  updates: readonly UnderstandingMapRecord[]
): UnderstandingMapRecord[] {
  const byKind = new Map(existing.map((map) => [map.kind, map]));
  for (const map of updates) {
    byKind.set(map.kind, map);
  }
  return [...byKind.values()].sort((left, right) => left.kind.localeCompare(right.kind));
}

export function mergeRuntimeTraces(
  existing: readonly RuntimeTraceRecord[],
  updates: readonly RuntimeTraceRecord[]
): RuntimeTraceRecord[] {
  const byId = new Map(existing.map((trace) => [trace.traceId, trace]));
  for (const trace of updates) {
    byId.set(trace.traceId, trace);
  }
  return [...byId.values()].sort((left, right) => left.traceId.localeCompare(right.traceId));
}

export function mergeDuplicateFamilies(
  existing: readonly DuplicateFamilyRecord[],
  updates: readonly DuplicateFamilyRecord[]
): DuplicateFamilyRecord[] {
  const byId = new Map(existing.map((record) => [record.familyId, record]));
  for (const record of updates) {
    byId.set(record.familyId, record);
  }
  return [...byId.values()].sort((left, right) => left.familyId.localeCompare(right.familyId));
}

export function mergeArchitectureDecisions(
  existing: readonly ArchitectureDecisionRecord[],
  updates: readonly ArchitectureDecisionRecord[]
): ArchitectureDecisionRecord[] {
  const byId = new Map(existing.map((record) => [record.decisionId, record]));
  for (const record of updates) {
    byId.set(record.decisionId, record);
  }
  return [...byId.values()].sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}

export function mergeMigrationLedgerEntries(
  existing: readonly MigrationLedgerEntryRecord[],
  updates: readonly MigrationLedgerEntryRecord[]
): MigrationLedgerEntryRecord[] {
  const byId = new Map(existing.map((record) => [record.entryId, record]));
  for (const record of updates) {
    byId.set(record.entryId, record);
  }
  return [...byId.values()].sort((left, right) => left.entryId.localeCompare(right.entryId));
}

export function mergeParityRequirements(
  existing: readonly ParityRequirementRecord[],
  updates: readonly ParityRequirementRecord[]
): ParityRequirementRecord[] {
  const byId = new Map(existing.map((record) => [record.requirementId, record]));
  for (const record of updates) {
    byId.set(record.requirementId, record);
  }
  return [...byId.values()].sort((left, right) =>
    left.requirementId.localeCompare(right.requirementId)
  );
}

export function mergeExternalEvalRecords(
  existing: readonly ExternalEvalRecord[],
  updates: readonly ExternalEvalRecord[]
): ExternalEvalRecord[] {
  const byId = new Map(existing.map((record) => [record.evalId, record]));
  for (const record of updates) {
    byId.set(record.evalId, record);
  }
  return [...byId.values()].sort((left, right) => left.evalId.localeCompare(right.evalId));
}

export function mergeSensitiveActionControls(
  existing: readonly SensitiveActionControlRecord[],
  updates: readonly SensitiveActionControlRecord[]
): SensitiveActionControlRecord[] {
  const byId = new Map(existing.map((record) => [record.controlId, record]));
  for (const record of updates) {
    byId.set(record.controlId, record);
  }
  return [...byId.values()].sort((left, right) => left.controlId.localeCompare(right.controlId));
}

function extractWorkflowProofTaskId(targetId: string, nextActions: readonly string[]): string | undefined {
  const normalizedTargetId = targetId.trim();
  if (!normalizedTargetId.startsWith("task:")) {
    return undefined;
  }

  const joinedActions = nextActions.join(" ").trim();
  if (!/\bworkflow-proof\b/i.test(joinedActions)) {
    return undefined;
  }

  const taskId = normalizedTargetId.slice("task:".length).trim();
  return taskId.length > 0 ? taskId : undefined;
}

export function selectAutonomousNextTarget(
  state: AutonomousExecutionState
): AutonomousNextTarget | undefined {
  const blockingGap = [...state.gaps]
    .filter((gap) => isGapBlocking(gap))
    .sort((left, right) => {
      const severityOrder = gapSeverityWeight[right.severity] - gapSeverityWeight[left.severity];
      if (severityOrder !== 0) {
        return severityOrder;
      }
      return left.id.localeCompare(right.id);
    })[0];

  if (blockingGap) {
    const nextActions =
      blockingGap.suggestedNextActions.length > 0
        ? [...blockingGap.suggestedNextActions]
        : [`resolve ${blockingGap.id}`];
    const workflowProofTaskId = extractWorkflowProofTaskId(blockingGap.targetId, nextActions);
    const actions: ContinuationAction[] = workflowProofTaskId
      ? [{ kind: "run_workflow_proof", taskId: workflowProofTaskId }]
      : [{ kind: "resolve_blocking_gap", gapId: blockingGap.id, targetId: blockingGap.targetId }];

    return {
      targetId: blockingGap.targetId,
      source: "blocking_gap",
      rationale: [
        `blocking gap ${blockingGap.id} remains open`,
        blockingGap.description
      ],
      actions,
      nextActions
    };
  }

  const latestCheckpoint = [...state.checkpoints]
    .sort((left, right) => {
      const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
      if (createdAtOrder !== 0) {
        return createdAtOrder;
      }
      return right.checkpointId.localeCompare(left.checkpointId);
    })
    .find((checkpoint) => !isCheckpointStale(state, checkpoint));
  const checkpointTarget = checkpointResumeTarget(latestCheckpoint);
  if (latestCheckpoint && checkpointTarget) {
    const nextActions =
      latestCheckpoint.nextActions.length > 0
        ? [...latestCheckpoint.nextActions]
        : [`resume at ${checkpointTarget}`];
    const workflowProofTaskId = extractWorkflowProofTaskId(checkpointTarget, nextActions);
    const actions: ContinuationAction[] = workflowProofTaskId
      ? [{ kind: "run_workflow_proof", taskId: workflowProofTaskId }]
      : [
          {
            kind: "resume_target",
            targetId: checkpointTarget,
            source: "checkpoint",
            sourceId: latestCheckpoint.checkpointId
          }
        ];

    return {
      targetId: checkpointTarget,
      source: "checkpoint",
      rationale: [
        `latest checkpoint ${latestCheckpoint.checkpointId} still lists an active target`
      ],
      actions,
      nextActions
    };
  }

  const latestProgressProof = [...state.progressProofs]
    .sort((left, right) => {
      const cycleOrder = right.cycle - left.cycle;
      if (cycleOrder !== 0) {
        return cycleOrder;
      }
      return right.createdAt.localeCompare(left.createdAt);
    })
    .find((proof) => validateProgressProofRecord(proof).length === 0);
  const progressProofTarget = progressProofResumeTarget(latestProgressProof);
  if (latestProgressProof && progressProofTarget) {
    const nextActions = latestProgressProof.whyNext?.trim()
      ? [latestProgressProof.whyNext.trim()]
      : [`continue at ${progressProofTarget}`];
    const workflowProofTaskId = extractWorkflowProofTaskId(progressProofTarget, nextActions);
    const actions: ContinuationAction[] = workflowProofTaskId
      ? [{ kind: "run_workflow_proof", taskId: workflowProofTaskId }]
      : [
          {
            kind: "resume_target",
            targetId: progressProofTarget,
            source: "progress_proof",
            sourceId: latestProgressProof.proofId
          }
        ];

    return {
      targetId: progressProofTarget,
      source: "progress_proof",
      rationale: [
        `latest progress proof ${latestProgressProof.proofId} selected the next target`,
        ...(latestProgressProof.whyNext ? [latestProgressProof.whyNext] : [])
      ],
      actions,
      nextActions
    };
  }

  return undefined;
}
