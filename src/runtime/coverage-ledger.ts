import type {
  ArchitectureDecisionRecord,
  AutonomousExecutionState,
  CoverageGapRecord,
  DuplicateFamilyMemberRecord,
  CoverageItemRecord,
  CoverageManifestRecord,
  DuplicateFamilyRecord,
  MigrationLedgerEntryRecord,
  ParityRequirementRecord,
  RuntimeTraceRecord,
  UnderstandingMapRecord
} from "../domain/types.ts";
import {
  validateArchitectureDecisionRecord,
  validateDuplicateFamilyRecord,
  validateCoverageGapRecord,
  validateCoverageItemRecord,
  validateCoverageManifestRecord,
  validateMigrationLedgerEntryRecord,
  validateParityRequirementRecord,
  validateRuntimeTraceRecord,
  validateUnderstandingMapRecord
} from "./autonomous-execution.ts";

export interface CoverageManifestArtifact {
  run_id: string;
  profile: CoverageManifestRecord["profile"];
  required_categories: CoverageManifestRecord["requiredCategories"];
  thresholds: {
    critical_item_coverage?: number | undefined;
    critical_item_validation?: number | undefined;
    callsite_coverage?: number | undefined;
    runtime_trace_coverage?: number | undefined;
    inventory_completeness?: number | undefined;
    business_rule_coverage?: number | undefined;
    max_contradiction_gap_count?: number | undefined;
    max_open_blockers?: number | undefined;
  };
}

export interface CoverageItemArtifact {
  id: string;
  category: CoverageItemRecord["category"];
  state: CoverageItemRecord["state"];
  criticality: CoverageItemRecord["criticality"];
  owner_agent?: string | undefined;
  sources: string[];
  entry_points?: string[] | undefined;
  dependencies?: string[] | undefined;
  dependents?: string[] | undefined;
  callsite_count?: number | undefined;
  callsites_analyzed?: number | undefined;
  runtime_traced?: boolean | undefined;
  behavior_summary?: string | undefined;
  invariants?: string[] | undefined;
  business_rules?: string[] | undefined;
  side_effects?: string[] | undefined;
  open_questions?: string[] | undefined;
  evidence_refs: string[];
  verification_refs?: string[] | undefined;
  confidence?: number | undefined;
  gap_score?: number | undefined;
  last_updated_at: string;
}

export interface CoverageGapArtifact {
  id: string;
  target_id: string;
  kind: CoverageGapRecord["kind"];
  severity: CoverageGapRecord["severity"];
  description: string;
  blocking: boolean;
  evidence_refs: string[];
  created_by: string;
  suggested_next_actions: string[];
  status: CoverageGapRecord["status"];
}

export interface CoverageTraceArtifact {
  trace_id: string;
  target_id: string;
  kind: RuntimeTraceRecord["kind"];
  risky: boolean;
  side_effects: string[];
  evidence_refs: string[];
  created_at: string;
}

export interface UnderstandingMapArtifact {
  kind: UnderstandingMapRecord["kind"];
  item_count: number;
  analyzed_count?: number | undefined;
  source_refs: string[];
  evidence_refs: string[];
  updated_at: string;
}

export interface CoverageInvariantArtifact {
  target_id: string;
  invariants: string[];
  business_rules: string[];
  evidence_refs: string[];
  verification_refs?: string[] | undefined;
  last_updated_at: string;
}

export interface CoverageDuplicateFamilyMemberArtifact {
  item_id: string;
  kind: DuplicateFamilyRecord["members"][number]["kind"];
  role?: string | undefined;
  notes?: string | undefined;
}

export interface CoverageDuplicateFamilyArtifact {
  family_id: string;
  capability: string;
  members: CoverageDuplicateFamilyMemberArtifact[];
  shared_abstraction?: string | undefined;
  intentional_variants: string[];
  accidental_divergences: string[];
  centralization_candidate?: string | undefined;
  parity_requirements: string[];
  evidence_refs: string[];
  verification_refs?: string[] | undefined;
  last_updated_at: string;
}

export interface CoverageArchitectureDecisionArtifact {
  decision_id: string;
  title: string;
  status: ArchitectureDecisionRecord["status"];
  options: string[];
  chosen_option: string;
  bounded_contexts: string[];
  consistency_needs: string[];
  rationale: string[];
  evidence_refs: string[];
  verification_refs?: string[] | undefined;
  last_updated_at: string;
}

export interface CoverageMigrationLedgerArtifact {
  entry_id: string;
  bounded_context: string;
  source_models: string[];
  target_models: string[];
  strategy: MigrationLedgerEntryRecord["strategy"];
  consistency_class: MigrationLedgerEntryRecord["consistencyClass"];
  ownership: string;
  rollout_steps: string[];
  rollback_plan: string[];
  evidence_refs: string[];
  verification_refs?: string[] | undefined;
  last_updated_at: string;
}

export interface CoverageParityRequirementArtifact {
  requirement_id: string;
  capability: string;
  status: ParityRequirementRecord["status"];
  legacy_refs: string[];
  target_refs: string[];
  acceptance_checks: string[];
  evidence_refs: string[];
  verification_refs?: string[] | undefined;
  last_updated_at: string;
}

export interface CoverageDependencyGraphNodeArtifact {
  id: string;
  source: "coverage_item" | "referenced_only";
  category?: CoverageItemRecord["category"] | undefined;
  state?: CoverageItemRecord["state"] | undefined;
  criticality?: CoverageItemRecord["criticality"] | undefined;
  sources?: string[] | undefined;
}

export interface CoverageDependencyGraphEdgeArtifact {
  from: string;
  to: string;
  kind: "depends_on";
}

export interface CoverageDependencyGraphArtifact {
  generated_at: string;
  nodes: CoverageDependencyGraphNodeArtifact[];
  edges: CoverageDependencyGraphEdgeArtifact[];
}

export interface CoverageLedgerArtifacts {
  manifest: CoverageManifestArtifact;
  items: CoverageItemArtifact[];
  gaps: CoverageGapArtifact[];
  understanding_maps: UnderstandingMapArtifact[];
  invariants: CoverageInvariantArtifact[];
  duplicate_families: CoverageDuplicateFamilyArtifact[];
  architecture_decisions: CoverageArchitectureDecisionArtifact[];
  migration_ledger: CoverageMigrationLedgerArtifact[];
  parity_matrix: CoverageParityRequirementArtifact[];
  dependency_graph: CoverageDependencyGraphArtifact;
  traces: CoverageTraceArtifact[];
}

function toManifestArtifact(manifest: CoverageManifestRecord): CoverageManifestArtifact {
  return {
    run_id: manifest.runId,
    profile: manifest.profile,
    required_categories: [...manifest.requiredCategories],
    thresholds: {
      critical_item_coverage: manifest.thresholds.criticalItemCoverage,
      critical_item_validation: manifest.thresholds.criticalItemValidation,
      callsite_coverage: manifest.thresholds.callsiteCoverage,
      runtime_trace_coverage: manifest.thresholds.runtimeTraceCoverage,
      inventory_completeness: manifest.thresholds.inventoryCompleteness,
      business_rule_coverage: manifest.thresholds.businessRuleCoverage,
      max_contradiction_gap_count: manifest.thresholds.maxContradictionGapCount,
      max_open_blockers: manifest.thresholds.maxOpenBlockers
    }
  };
}

function toCoverageItemArtifact(item: CoverageItemRecord): CoverageItemArtifact {
  return {
    id: item.id,
    category: item.category,
    state: item.state,
    criticality: item.criticality,
    owner_agent: item.ownerAgent,
    sources: [...item.sources],
    entry_points: item.entryPoints ? [...item.entryPoints] : undefined,
    dependencies: item.dependencies ? [...item.dependencies] : undefined,
    dependents: item.dependents ? [...item.dependents] : undefined,
    callsite_count: item.callsiteCount,
    callsites_analyzed: item.callsitesAnalyzed,
    runtime_traced: item.runtimeTraced,
    behavior_summary: item.behaviorSummary,
    invariants: item.invariants ? [...item.invariants] : undefined,
    business_rules: item.businessRules ? [...item.businessRules] : undefined,
    side_effects: item.sideEffects ? [...item.sideEffects] : undefined,
    open_questions: item.openQuestions ? [...item.openQuestions] : undefined,
    evidence_refs: [...item.evidenceRefs],
    verification_refs: item.verificationRefs ? [...item.verificationRefs] : undefined,
    confidence: item.confidence,
    gap_score: item.gapScore,
    last_updated_at: item.lastUpdatedAt
  };
}

function toCoverageInvariantArtifact(item: CoverageItemRecord): CoverageInvariantArtifact {
  return {
    target_id: item.id,
    invariants: [...(item.invariants ?? [])],
    business_rules: [...(item.businessRules ?? [])],
    evidence_refs: [...item.evidenceRefs],
    verification_refs: item.verificationRefs ? [...item.verificationRefs] : undefined,
    last_updated_at: item.lastUpdatedAt
  };
}

function toCoverageDuplicateFamilyArtifact(record: DuplicateFamilyRecord): CoverageDuplicateFamilyArtifact {
  return {
    family_id: record.familyId,
    capability: record.capability,
    members: record.members.map((member) => ({
      item_id: member.itemId,
      kind: member.kind,
      role: member.role,
      notes: member.notes
    })),
    shared_abstraction: record.sharedAbstraction,
    intentional_variants: [...record.intentionalVariants],
    accidental_divergences: [...record.accidentalDivergences],
    centralization_candidate: record.centralizationCandidate,
    parity_requirements: [...record.parityRequirements],
    evidence_refs: [...record.evidenceRefs],
    verification_refs: record.verificationRefs ? [...record.verificationRefs] : undefined,
    last_updated_at: record.lastUpdatedAt
  };
}

function toCoverageArchitectureDecisionArtifact(
  record: ArchitectureDecisionRecord
): CoverageArchitectureDecisionArtifact {
  return {
    decision_id: record.decisionId,
    title: record.title,
    status: record.status,
    options: [...record.options],
    chosen_option: record.chosenOption,
    bounded_contexts: [...record.boundedContexts],
    consistency_needs: [...record.consistencyNeeds],
    rationale: [...record.rationale],
    evidence_refs: [...record.evidenceRefs],
    verification_refs: record.verificationRefs ? [...record.verificationRefs] : undefined,
    last_updated_at: record.lastUpdatedAt
  };
}

function toCoverageMigrationLedgerArtifact(
  record: MigrationLedgerEntryRecord
): CoverageMigrationLedgerArtifact {
  return {
    entry_id: record.entryId,
    bounded_context: record.boundedContext,
    source_models: [...record.sourceModels],
    target_models: [...record.targetModels],
    strategy: record.strategy,
    consistency_class: record.consistencyClass,
    ownership: record.ownership,
    rollout_steps: [...record.rolloutSteps],
    rollback_plan: [...record.rollbackPlan],
    evidence_refs: [...record.evidenceRefs],
    verification_refs: record.verificationRefs ? [...record.verificationRefs] : undefined,
    last_updated_at: record.lastUpdatedAt
  };
}

function toCoverageParityRequirementArtifact(
  record: ParityRequirementRecord
): CoverageParityRequirementArtifact {
  return {
    requirement_id: record.requirementId,
    capability: record.capability,
    status: record.status,
    legacy_refs: [...record.legacyRefs],
    target_refs: [...record.targetRefs],
    acceptance_checks: [...record.acceptanceChecks],
    evidence_refs: [...record.evidenceRefs],
    verification_refs: record.verificationRefs ? [...record.verificationRefs] : undefined,
    last_updated_at: record.lastUpdatedAt
  };
}

function toCoverageGapArtifact(gap: CoverageGapRecord): CoverageGapArtifact {
  return {
    id: gap.id,
    target_id: gap.targetId,
    kind: gap.kind,
    severity: gap.severity,
    description: gap.description,
    blocking: gap.blocking,
    evidence_refs: [...gap.evidenceRefs],
    created_by: gap.createdBy,
    suggested_next_actions: [...gap.suggestedNextActions],
    status: gap.status
  };
}

function toCoverageTraceArtifact(trace: RuntimeTraceRecord): CoverageTraceArtifact {
  return {
    trace_id: trace.traceId,
    target_id: trace.targetId,
    kind: trace.kind,
    risky: trace.risky,
    side_effects: [...trace.sideEffects],
    evidence_refs: [...trace.evidenceRefs],
    created_at: trace.createdAt
  };
}

function toUnderstandingMapArtifact(map: UnderstandingMapRecord): UnderstandingMapArtifact {
  return {
    kind: map.kind,
    item_count: map.itemCount,
    analyzed_count: map.analyzedCount,
    source_refs: [...map.sourceRefs],
    evidence_refs: [...map.evidenceRefs],
    updated_at: map.updatedAt
  };
}

function fromManifestArtifact(artifact: CoverageManifestArtifact): CoverageManifestRecord {
  return {
    runId: artifact.run_id,
    profile: artifact.profile,
    requiredCategories: [...artifact.required_categories],
    thresholds: {
      criticalItemCoverage: artifact.thresholds.critical_item_coverage,
      criticalItemValidation: artifact.thresholds.critical_item_validation,
      callsiteCoverage: artifact.thresholds.callsite_coverage,
      runtimeTraceCoverage: artifact.thresholds.runtime_trace_coverage,
      inventoryCompleteness: artifact.thresholds.inventory_completeness,
      businessRuleCoverage: artifact.thresholds.business_rule_coverage,
      maxContradictionGapCount: artifact.thresholds.max_contradiction_gap_count,
      maxOpenBlockers: artifact.thresholds.max_open_blockers
    }
  };
}

function fromCoverageItemArtifact(artifact: CoverageItemArtifact): CoverageItemRecord {
  return {
    id: artifact.id,
    category: artifact.category,
    state: artifact.state,
    criticality: artifact.criticality,
    ownerAgent: artifact.owner_agent,
    sources: [...artifact.sources],
    entryPoints: artifact.entry_points ? [...artifact.entry_points] : undefined,
    dependencies: artifact.dependencies ? [...artifact.dependencies] : undefined,
    dependents: artifact.dependents ? [...artifact.dependents] : undefined,
    callsiteCount: artifact.callsite_count,
    callsitesAnalyzed: artifact.callsites_analyzed,
    runtimeTraced: artifact.runtime_traced,
    behaviorSummary: artifact.behavior_summary,
    invariants: artifact.invariants ? [...artifact.invariants] : undefined,
    businessRules: artifact.business_rules ? [...artifact.business_rules] : undefined,
    sideEffects: artifact.side_effects ? [...artifact.side_effects] : undefined,
    openQuestions: artifact.open_questions ? [...artifact.open_questions] : undefined,
    evidenceRefs: [...artifact.evidence_refs],
    verificationRefs: artifact.verification_refs ? [...artifact.verification_refs] : undefined,
    confidence: artifact.confidence,
    gapScore: artifact.gap_score,
    lastUpdatedAt: artifact.last_updated_at
  };
}

function fromCoverageGapArtifact(artifact: CoverageGapArtifact): CoverageGapRecord {
  return {
    id: artifact.id,
    targetId: artifact.target_id,
    kind: artifact.kind,
    severity: artifact.severity,
    description: artifact.description,
    blocking: artifact.blocking,
    evidenceRefs: [...artifact.evidence_refs],
    createdBy: artifact.created_by,
    suggestedNextActions: [...artifact.suggested_next_actions],
    status: artifact.status
  };
}

function fromCoverageTraceArtifact(artifact: CoverageTraceArtifact): RuntimeTraceRecord {
  return {
    traceId: artifact.trace_id,
    targetId: artifact.target_id,
    kind: artifact.kind,
    risky: artifact.risky,
    sideEffects: [...artifact.side_effects],
    evidenceRefs: [...artifact.evidence_refs],
    createdAt: artifact.created_at
  };
}

function fromUnderstandingMapArtifact(artifact: UnderstandingMapArtifact): UnderstandingMapRecord {
  return {
    kind: artifact.kind,
    itemCount: artifact.item_count,
    analyzedCount: artifact.analyzed_count,
    sourceRefs: [...artifact.source_refs],
    evidenceRefs: [...artifact.evidence_refs],
    updatedAt: artifact.updated_at
  };
}

export function buildCoverageDependencyGraphArtifact(
  items: readonly CoverageItemRecord[],
  generatedAt: string
): CoverageDependencyGraphArtifact {
  const nodes = new Map<string, CoverageDependencyGraphNodeArtifact>();
  const edges = new Map<string, CoverageDependencyGraphEdgeArtifact>();

  for (const item of items) {
    nodes.set(item.id, {
      id: item.id,
      source: "coverage_item",
      category: item.category,
      state: item.state,
      criticality: item.criticality,
      sources: [...item.sources]
    });
  }

  const ensureReferencedNode = (id: string) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        source: "referenced_only"
      });
    }
  };

  for (const item of items) {
    for (const dependency of item.dependencies ?? []) {
      ensureReferencedNode(dependency);
      edges.set(`${item.id}->${dependency}`, {
        from: item.id,
        to: dependency,
        kind: "depends_on"
      });
    }

    for (const dependent of item.dependents ?? []) {
      ensureReferencedNode(dependent);
      edges.set(`${dependent}->${item.id}`, {
        from: dependent,
        to: item.id,
        kind: "depends_on"
      });
    }
  }

  return {
    generated_at: generatedAt,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort(
      (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
    )
  };
}

export function buildCoverageLedgerArtifacts(
  state: AutonomousExecutionState,
  options: {
    generatedAt?: string | undefined;
  } = {}
): CoverageLedgerArtifacts {
  if (!state.manifest) {
    throw new Error("coverage ledger export requires an autonomous execution manifest");
  }

  const generatedAt = options.generatedAt ?? state.updatedAt;
  return {
    manifest: toManifestArtifact(state.manifest),
    items: state.coverageItems.map(toCoverageItemArtifact),
    gaps: state.gaps.map(toCoverageGapArtifact),
    understanding_maps: (state.understandingMaps ?? []).map(toUnderstandingMapArtifact),
    invariants: state.coverageItems
      .filter((item) => (item.invariants?.length ?? 0) > 0 || (item.businessRules?.length ?? 0) > 0)
      .map(toCoverageInvariantArtifact),
    duplicate_families: (state.duplicateFamilies ?? []).map(toCoverageDuplicateFamilyArtifact),
    architecture_decisions: (state.architectureDecisions ?? []).map(toCoverageArchitectureDecisionArtifact),
    migration_ledger: (state.migrationLedger ?? []).map(toCoverageMigrationLedgerArtifact),
    parity_matrix: (state.parityMatrix ?? []).map(toCoverageParityRequirementArtifact),
    dependency_graph: buildCoverageDependencyGraphArtifact(state.coverageItems, generatedAt),
    traces: (state.runtimeTraces ?? []).map(toCoverageTraceArtifact)
  };
}

export function validateCoverageManifestArtifact(artifact: CoverageManifestArtifact): string[] {
  return validateCoverageManifestRecord(fromManifestArtifact(artifact));
}

export function validateCoverageItemsArtifact(artifacts: readonly CoverageItemArtifact[]): string[] {
  if (!Array.isArray(artifacts)) {
    return ["coverage items artifact must be an array"];
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id)) {
      errors.push(`duplicate coverage item id ${artifact.id}`);
    }
    ids.add(artifact.id);
    errors.push(...validateCoverageItemRecord(fromCoverageItemArtifact(artifact)));
  }
  return errors;
}

export function validateCoverageGapsArtifact(artifacts: readonly CoverageGapArtifact[]): string[] {
  if (!Array.isArray(artifacts)) {
    return ["coverage gaps artifact must be an array"];
  }

  return artifacts.flatMap((artifact) => validateCoverageGapRecord(fromCoverageGapArtifact(artifact)));
}

export function validateCoverageTracesArtifact(artifacts: readonly CoverageTraceArtifact[]): string[] {
  if (!Array.isArray(artifacts)) {
    return ["coverage traces artifact must be an array"];
  }

  return artifacts.flatMap((artifact) => validateRuntimeTraceRecord(fromCoverageTraceArtifact(artifact)));
}

export function validateUnderstandingMapsArtifact(artifacts: readonly UnderstandingMapArtifact[]): string[] {
  if (!Array.isArray(artifacts)) {
    return ["understanding maps artifact must be an array"];
  }

  return artifacts.flatMap((artifact) => validateUnderstandingMapRecord(fromUnderstandingMapArtifact(artifact)));
}

export function validateCoverageInvariantsArtifact(artifacts: readonly CoverageInvariantArtifact[]): string[] {
  if (!Array.isArray(artifacts)) {
    return ["coverage invariants artifact must be an array"];
  }

  const errors: string[] = [];
  for (const artifact of artifacts) {
    if (typeof artifact.target_id !== "string" || artifact.target_id.trim().length === 0) {
      errors.push("coverage invariants artifact entry must include target_id");
      continue;
    }
    if (!Array.isArray(artifact.invariants) || !Array.isArray(artifact.business_rules)) {
      errors.push(`coverage invariants artifact ${artifact.target_id} must include invariants and business_rules arrays`);
      continue;
    }
    if (artifact.invariants.length === 0 && artifact.business_rules.length === 0) {
      errors.push(`coverage invariants artifact ${artifact.target_id} must include at least one invariant or business rule`);
    }
    if (!Array.isArray(artifact.evidence_refs) || artifact.evidence_refs.length === 0) {
      errors.push(`coverage invariants artifact ${artifact.target_id} must include evidence_refs`);
    }
  }

  return errors;
}

export function validateCoverageDuplicateFamiliesArtifact(
  artifacts: readonly CoverageDuplicateFamilyArtifact[]
): string[] {
  if (!Array.isArray(artifacts)) {
    return ["coverage duplicate families artifact must be an array"];
  }

  const errors: string[] = [];
  const familyIds = new Set<string>();
  for (const artifact of artifacts) {
    if (typeof artifact.family_id !== "string" || artifact.family_id.trim().length === 0) {
      errors.push("coverage duplicate family artifact entry must include family_id");
      continue;
    }
    if (familyIds.has(artifact.family_id)) {
      errors.push(`duplicate coverage duplicate family id ${artifact.family_id}`);
      continue;
    }
    familyIds.add(artifact.family_id);
    errors.push(
      ...validateDuplicateFamilyRecord({
        familyId: artifact.family_id,
        capability: artifact.capability,
        members: artifact.members.map((member: CoverageDuplicateFamilyMemberArtifact): DuplicateFamilyMemberRecord => ({
          itemId: member.item_id,
          kind: member.kind,
          role: member.role,
          notes: member.notes
        })),
        sharedAbstraction: artifact.shared_abstraction,
        intentionalVariants: [...artifact.intentional_variants],
        accidentalDivergences: [...artifact.accidental_divergences],
        centralizationCandidate: artifact.centralization_candidate,
        parityRequirements: [...artifact.parity_requirements],
        evidenceRefs: [...artifact.evidence_refs],
        verificationRefs: artifact.verification_refs ? [...artifact.verification_refs] : undefined,
        lastUpdatedAt: artifact.last_updated_at
      })
    );
  }

  return errors;
}

export function validateCoverageArchitectureDecisionsArtifact(
  artifacts: readonly CoverageArchitectureDecisionArtifact[]
): string[] {
  if (!Array.isArray(artifacts)) {
    return ["coverage architecture decisions artifact must be an array"];
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (typeof artifact.decision_id !== "string" || artifact.decision_id.trim().length === 0) {
      errors.push("coverage architecture decision artifact entry must include decision_id");
      continue;
    }
    if (ids.has(artifact.decision_id)) {
      errors.push(`duplicate coverage architecture decision id ${artifact.decision_id}`);
      continue;
    }
    ids.add(artifact.decision_id);
    errors.push(
      ...validateArchitectureDecisionRecord({
        decisionId: artifact.decision_id,
        title: artifact.title,
        status: artifact.status,
        options: [...artifact.options],
        chosenOption: artifact.chosen_option,
        boundedContexts: [...artifact.bounded_contexts],
        consistencyNeeds: [...artifact.consistency_needs],
        rationale: [...artifact.rationale],
        evidenceRefs: [...artifact.evidence_refs],
        verificationRefs: artifact.verification_refs ? [...artifact.verification_refs] : undefined,
        lastUpdatedAt: artifact.last_updated_at
      })
    );
  }

  return errors;
}

export function validateCoverageMigrationLedgerArtifact(
  artifacts: readonly CoverageMigrationLedgerArtifact[]
): string[] {
  if (!Array.isArray(artifacts)) {
    return ["coverage migration ledger artifact must be an array"];
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (typeof artifact.entry_id !== "string" || artifact.entry_id.trim().length === 0) {
      errors.push("coverage migration ledger artifact entry must include entry_id");
      continue;
    }
    if (ids.has(artifact.entry_id)) {
      errors.push(`duplicate coverage migration ledger id ${artifact.entry_id}`);
      continue;
    }
    ids.add(artifact.entry_id);
    errors.push(
      ...validateMigrationLedgerEntryRecord({
        entryId: artifact.entry_id,
        boundedContext: artifact.bounded_context,
        sourceModels: [...artifact.source_models],
        targetModels: [...artifact.target_models],
        strategy: artifact.strategy,
        consistencyClass: artifact.consistency_class,
        ownership: artifact.ownership,
        rolloutSteps: [...artifact.rollout_steps],
        rollbackPlan: [...artifact.rollback_plan],
        evidenceRefs: [...artifact.evidence_refs],
        verificationRefs: artifact.verification_refs ? [...artifact.verification_refs] : undefined,
        lastUpdatedAt: artifact.last_updated_at
      })
    );
  }

  return errors;
}

export function validateCoverageParityMatrixArtifact(
  artifacts: readonly CoverageParityRequirementArtifact[]
): string[] {
  if (!Array.isArray(artifacts)) {
    return ["coverage parity matrix artifact must be an array"];
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (typeof artifact.requirement_id !== "string" || artifact.requirement_id.trim().length === 0) {
      errors.push("coverage parity requirement artifact entry must include requirement_id");
      continue;
    }
    if (ids.has(artifact.requirement_id)) {
      errors.push(`duplicate coverage parity requirement id ${artifact.requirement_id}`);
      continue;
    }
    ids.add(artifact.requirement_id);
    errors.push(
      ...validateParityRequirementRecord({
        requirementId: artifact.requirement_id,
        capability: artifact.capability,
        status: artifact.status,
        legacyRefs: [...artifact.legacy_refs],
        targetRefs: [...artifact.target_refs],
        acceptanceChecks: [...artifact.acceptance_checks],
        evidenceRefs: [...artifact.evidence_refs],
        verificationRefs: artifact.verification_refs ? [...artifact.verification_refs] : undefined,
        lastUpdatedAt: artifact.last_updated_at
      })
    );
  }

  return errors;
}

export function validateCoverageDependencyGraphArtifact(
  artifact: CoverageDependencyGraphArtifact,
  items: readonly CoverageItemArtifact[]
): string[] {
  const errors: string[] = [];

  if (!artifact || typeof artifact !== "object") {
    return ["coverage dependency graph artifact must be an object"];
  }

  if (typeof artifact.generated_at !== "string" || artifact.generated_at.trim().length === 0) {
    errors.push("coverage dependency graph artifact must include generated_at");
  }

  if (!Array.isArray(artifact.nodes)) {
    errors.push("coverage dependency graph artifact must include nodes");
  }

  if (!Array.isArray(artifact.edges)) {
    errors.push("coverage dependency graph artifact must include edges");
  }

  if (errors.length > 0) {
    return errors;
  }

  const nodeIds = new Set<string>();
  for (const node of artifact.nodes) {
    if (typeof node.id !== "string" || node.id.trim().length === 0) {
      errors.push("coverage dependency graph node must include id");
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push(`duplicate coverage dependency graph node ${node.id}`);
      continue;
    }
    nodeIds.add(node.id);
  }

  for (const item of items) {
    if (!nodeIds.has(item.id)) {
      errors.push(`coverage dependency graph is missing node for coverage item ${item.id}`);
    }
  }

  for (const edge of artifact.edges) {
    if (typeof edge.from !== "string" || edge.from.trim().length === 0) {
      errors.push("coverage dependency graph edge must include from");
      continue;
    }
    if (typeof edge.to !== "string" || edge.to.trim().length === 0) {
      errors.push("coverage dependency graph edge must include to");
      continue;
    }
    if (edge.kind !== "depends_on") {
      errors.push(`coverage dependency graph edge ${edge.from}->${edge.to} has unsupported kind ${String(edge.kind)}`);
    }
    if (!nodeIds.has(edge.from)) {
      errors.push(`coverage dependency graph edge references unknown from node ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`coverage dependency graph edge references unknown to node ${edge.to}`);
    }
  }

  return errors;
}

export function validateCoverageLedgerArtifacts(artifacts: CoverageLedgerArtifacts): string[] {
  const errors = [
    ...validateCoverageManifestArtifact(artifacts.manifest),
    ...validateCoverageItemsArtifact(artifacts.items),
    ...validateCoverageGapsArtifact(artifacts.gaps),
    ...validateUnderstandingMapsArtifact(artifacts.understanding_maps),
    ...validateCoverageInvariantsArtifact(artifacts.invariants),
    ...validateCoverageDuplicateFamiliesArtifact(artifacts.duplicate_families),
    ...validateCoverageArchitectureDecisionsArtifact(artifacts.architecture_decisions),
    ...validateCoverageMigrationLedgerArtifact(artifacts.migration_ledger),
    ...validateCoverageParityMatrixArtifact(artifacts.parity_matrix),
    ...validateCoverageTracesArtifact(artifacts.traces),
    ...validateCoverageDependencyGraphArtifact(artifacts.dependency_graph, artifacts.items)
  ];

  const requiredCategories = new Set(artifacts.manifest.required_categories);
  const presentCategories = new Set(artifacts.items.map((item) => item.category));
  for (const category of requiredCategories) {
    if (!presentCategories.has(category)) {
      errors.push(`coverage items artifact is missing required category ${category}`);
    }
  }

  return errors;
}
