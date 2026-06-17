import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewActionContextResolver, type AuthenticatedPrincipal, type ReviewIdentityBindings } from "../core/review-context.ts";
import { ArchonCoreService } from "../core/service.ts";
import {
  buildAutonomousExecutionSnapshot,
  selectAutonomousNextTarget
} from "../runtime/autonomous-execution.ts";
import type {
  AutonomousExecutionState,
  ReviewActionContext,
  ReviewRecord,
  TaskPacketInput,
  ContextSample
} from "../domain/types.ts";
import { MemoryStore } from "../store/memory-store.ts";
import { AgenticLoopController } from "../runtime/agentic-loop.ts";
import type { AgenticLoopStoreLike, TaskSummary } from "../runtime/agentic-loop.ts";
import { ContinuationContextBuilder } from "../runtime/continuation-context.ts";
import type { HandoffStoreLike } from "../runtime/handoff-controller.ts";
import type { HandoffRecord } from "../store/agent-runtime-store.ts";
import { SubtaskScheduler } from "../runtime/subtask-scheduler.ts";
import type { SubtaskStoreLike, ParentInvocationStoreLike, ParentInvocationRef } from "../runtime/subtask-scheduler.ts";
import { DebateController } from "../runtime/debate-controller.ts";

type OrchestrationEvalArea = "gate" | "lifecycle" | "state" | "trust";
type EvalAuthorityLabel = "derived_only";
type EvalEvidenceScope = "repo_local" | "replay_grade";

export interface OrchestrationEvalCaseResult {
  id: string;
  replayId?: string;
  area: OrchestrationEvalArea;
  passed: boolean;
  score: number;
  threshold: number;
  authorityLabel: EvalAuthorityLabel;
  evidenceScope: EvalEvidenceScope;
  details: string;
}

export interface OrchestrationEvalSummary {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  requiredPassRate: number;
  meetsThreshold: boolean;
  authorityLabel: EvalAuthorityLabel;
}

export interface OrchestrationReplayLayerSummary {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  requiredPassRate: number;
  meetsThreshold: boolean;
  authorityLabel: EvalAuthorityLabel;
  evidenceScope: "replay_grade";
  boundaryNote: string;
}

export interface OrchestrationEvalReport {
  cases: OrchestrationEvalCaseResult[];
  summary: OrchestrationEvalSummary;
  replayLayer: OrchestrationReplayLayerSummary;
}

const orchestrationRequiredPassRate = 1;

function taskPacket(overrides: Partial<TaskPacketInput> = {}): TaskPacketInput {
  return {
    taskId: overrides.taskId ?? "task-1",
    title: overrides.title ?? "Create task graph",
    ownerRole: overrides.ownerRole ?? "planner",
    completionStandard: overrides.completionStandard ?? "specialist_verified",
    requiredSpecialistRoles:
      overrides.requiredSpecialistRoles ??
      [((overrides.ownerRole ?? "planner") as TaskPacketInput["requiredSpecialistRoles"][number])],
    qualityGates: overrides.qualityGates ?? ["product_acceptance"],
    goal: overrides.goal ?? "Build task graph",
    inputs: overrides.inputs ?? ["intake brief"],
    outputs: overrides.outputs ?? ["task packets"],
    dependencies: overrides.dependencies ?? [],
    allowedWriteScope: overrides.allowedWriteScope ?? [".archon/work/tasks"],
    outOfScope: overrides.outOfScope ?? ["production deploys"],
    acceptanceCriteria: overrides.acceptanceCriteria ?? ["task packet exists"],
    verificationSteps: overrides.verificationSteps ?? ["review generated packet"],
    uiSurface: overrides.uiSurface,
    playwrightRequired: overrides.playwrightRequired,
    requiredReviews: overrides.requiredReviews ?? ["reviewer", "security_reviewer", "qa_engineer"],
    securityChecks: overrides.securityChecks ?? ["ensure write scope is narrow"],
    antiPatterns: overrides.antiPatterns ?? ["broad repo edits"],
    rollbackNotes: overrides.rollbackNotes ?? "delete the generated task packet",
    handoffFormat: overrides.handoffFormat ?? "summary + blockers + changed files",
    reasoningPolicy: overrides.reasoningPolicy ?? {
      mode: "strict",
      requireBlock: true,
      requireAttempts: true,
      requireTraceRefs: true,
      requireVerification: true,
      requireCriticVerification: true,
      maxAttempts: 3
    },
    reasoningAttempts: overrides.reasoningAttempts ?? [
      {
        id: "attempt-1",
        label: "orchestration baseline default reasoning",
        hypothesis: "the baseline task packet should remain executable under strict defaults",
        alternatives: ["downgrade mode explicitly for compatibility-only cases"],
        evidenceRefs: ["src/evals/orchestration-baseline.ts"],
        verificationRefs: ["verification-1"],
        traceRef: "eval://orchestration-baseline/task-packet",
        outcome: "supported",
        summary: "default baseline fixture includes strict reasoning evidence"
      }
    ],
    reasoningVerifications: overrides.reasoningVerifications ?? [
      {
        id: "verification-1",
        kind: "critic_review",
        ref: "eval://orchestration-baseline/task-packet",
        status: "passed",
        summary: "default baseline fixture includes critic verification"
      }
    ],
    reasoningVerdict: overrides.reasoningVerdict ?? {
      status: "supported",
      summary: "default baseline fixture is strict-complete",
      supportingAttemptIds: ["attempt-1"],
      blockingIssues: []
    },
    reasoningQuality: overrides.reasoningQuality ?? {
      claim: "the baseline fixture has enough evidence to exercise routing behavior",
      facts: ["the orchestration baseline is under test"],
      assumptions: ["task packet scope remains bounded"],
      hypotheses: ["strict-complete packets should keep the lifecycle cases green"],
      evidenceRefs: ["src/evals/orchestration-baseline.ts"],
      counterEvidence: [],
      openQuestions: [],
      verificationPlan: ["npm test"],
      fallbacks: ["make compatibility mode explicit in eval cases when needed"],
      budgets: { researchSteps: 1, debugSteps: 1, reviewPasses: 1, toolRetries: 1 },
      confidence: "medium",
      decision: "supported"
    }
  };
}

function reviewContext(
  actorRole: ReviewActionContext["actorRole"],
  overrides: Partial<ReviewActionContext> = {}
): ReviewActionContext {
  return {
    actor: overrides.actor ?? `${actorRole}-actor`,
    actorRole
  };
}

function deriveActorRole(actor: string): ReviewActionContext["actorRole"] {
  const normalized = actor.replace(/-actor$/, "").replace(/-\d+$/, "").replace(/-/g, "_");
  switch (normalized) {
    case "planner":
    case "product_strategist":
    case "solution_architect":
    case "docs_researcher":
    case "backend_engineer":
    case "frontend_designer":
    case "infra_engineer":
    case "reviewer":
    case "build_resolver":
    case "security_reviewer":
    case "qa_engineer":
      return normalized;
    case "tdd_guide":
      return "tdd-guide";
    case "e2e_runner":
      return "e2e-runner";
    case "release_readiness":
      return "release-readiness";
    case "memory_curator":
      return "memory_curator";
    default:
      return "planner";
  }
}

function createEvalService(overrides: {
  bindings?: ReviewIdentityBindings | undefined;
  principals?: Record<string, AuthenticatedPrincipal> | undefined;
  withResolver?: boolean | undefined;
} = {}) {
  const registeredContexts = new Map<string, ReviewActionContext>();
  const registeredPrincipals = new Map<string, AuthenticatedPrincipal>();
  const bindings: ReviewIdentityBindings = overrides.bindings ?? { bindings: [] };
  const store = new MemoryStore();

  function upsertBinding(actor: string, context: ReviewActionContext, principal: AuthenticatedPrincipal) {
    let principalBinding = bindings.bindings.find(
      (binding) =>
        binding.principal.provider === principal.provider && binding.principal.subject === principal.subject
    );

    if (!principalBinding) {
      principalBinding = {
        principal: {
          provider: principal.provider,
          subject: principal.subject
        },
        actors: []
      };
      bindings.bindings.push(principalBinding);
    }

    const actorBinding = principalBinding.actors.find((binding) => binding.actor === actor);
    const nextActorBinding = {
      actor,
      roles: [context.actorRole]
    };

    if (!actorBinding) {
      principalBinding.actors.push(nextActorBinding);
      return;
    }

    actorBinding.roles = nextActorBinding.roles;
  }

  const service = new ArchonCoreService(
    store,
    overrides.withResolver === false
      ? {}
      : {
          resolveReviewActionContext: createReviewActionContextResolver({
            bindings,
            resolveAuthenticatedPrincipal(input) {
              const principal = overrides.principals?.[input.actor] ??
                registeredPrincipals.get(input.actor) ?? {
                  provider: "test",
                  subject: input.actor,
                  verified: true
                };
              const context = registeredContexts.get(input.actor) ?? {
                actor: input.actor,
                actorRole: deriveActorRole(input.actor)
              };
              upsertBinding(input.actor, context, principal);
              return principal;
            }
          })
        }
  );

  return {
    service,
    store,
    registerReviewContext(
      context: ReviewActionContext,
      principal: AuthenticatedPrincipal = {
        provider: "test",
        subject: context.actor,
        verified: true
      }
    ) {
      registeredContexts.set(context.actor, context);
      registeredPrincipals.set(context.actor, principal);
      upsertBinding(context.actor, context, principal);
      return context.actor;
    }
  };
}

function mutateReviewWhere(
  store: MemoryStore,
  predicate: (review: ReviewRecord) => boolean,
  mutate: (review: ReviewRecord) => ReviewRecord
): void {
  const reviews = (store as unknown as { reviews: Map<string, ReviewRecord> }).reviews;
  const entry = [...reviews.entries()].find(([, review]) => predicate(review));

  if (!entry) {
    throw new Error("expected matching review");
  }

  const [reviewId, review] = entry;
  reviews.set(reviewId, mutate(review));
}

async function seedInProgressTask(service: ArchonCoreService, packet: TaskPacketInput) {
  const run = await service.intakeRequest({
    workspaceSlug: "team",
    projectSlug: "archon",
    actor: "ceo",
    title: "Build core",
    request: "Ship the shared orchestration backend."
  });

  await service.createTaskGraph(run.id, [packet]);
  await service.claimTask(run.id, packet.taskId, "planner");

  return { run };
}

async function submitReadyForReview(service: ArchonCoreService, runId: string, taskId: string) {
  await service.submitHandoff(runId, taskId, {
    actor: "planner",
    ownerRole: "planner",
    completionStandard: "specialist_verified",
    summary: "ready for review",
    changedFiles: ["src/core/service.ts"],
    blockers: [],
    verificationNotes: ["npm test"],
    executionEvidence: ["planner-owned handoff recorded"],
    qualityGateEvidence: ["product acceptance captured in intake artifacts"],
    contextRefs: ["brief-1"]
  });
}

function buildResult(input: Omit<OrchestrationEvalCaseResult, "authorityLabel" | "score" | "threshold" | "evidenceScope"> & {
  score?: number;
  threshold?: number;
  evidenceScope?: EvalEvidenceScope;
}): OrchestrationEvalCaseResult {
  const score = input.score ?? (input.passed ? 1 : 0);
  const threshold = input.threshold ?? 1;

  return {
    ...input,
    score,
    threshold,
    authorityLabel: "derived_only",
    evidenceScope: input.evidenceScope ?? (input.replayId ? "replay_grade" : "repo_local")
  };
}

function buildLegacyRewriteState(
  overrides: Partial<AutonomousExecutionState> = {}
): AutonomousExecutionState {
  const now = "2026-05-20T12:00:00.000Z";
  const base: AutonomousExecutionState = {
    enabled: true,
    profile: "legacy_rewrite",
    phase: "modernization_strategy",
    manifest: {
      runId: "run-legacy",
      profile: "legacy_rewrite",
      requiredCategories: ["services"],
      thresholds: {
        criticalItemCoverage: 0.8,
        criticalItemValidation: 0.6,
        callsiteCoverage: 0.85,
        runtimeTraceCoverage: 0.75,
        inventoryCompleteness: 1,
        businessRuleCoverage: 0.8,
        maxContradictionGapCount: 0,
        maxOpenBlockers: 0
      }
    },
    coverageItems: [
      {
        id: "service:rewrite-core",
        category: "services",
        state: "validated",
        criticality: "critical",
        sources: ["src/core/service.ts:1"],
        callsiteCount: 2,
        callsitesAnalyzed: 2,
        runtimeTraced: true,
        businessRules: ["preserve authenticated workflow proof authority"],
        evidenceRefs: ["src/core/service.ts:1"],
        verificationRefs: ["tests/orchestration-eval.test.ts"],
        lastUpdatedAt: now
      }
    ],
    gaps: [],
    checkpoints: [],
    progressProofs: [],
    understandingMaps: [
      "repo_map",
      "subsystems",
      "route_map",
      "model_map",
      "integration_map",
      "authz_map",
      "config_coupling",
      "runtime_side_effects"
    ].map((kind) => ({
      kind,
      itemCount: 1,
      analyzedCount: 1,
      sourceRefs: ["docs/autonomous-execution-redesign.md"],
      evidenceRefs: ["tests/orchestration-eval.test.ts"],
      updatedAt: now
    })),
    runtimeTraces: [
      {
        traceId: "trace:rewrite-core",
        targetId: "service:rewrite-core",
        kind: "side_effect",
        risky: true,
        sideEffects: ["records workflow-proof results"],
        evidenceRefs: ["tests/orchestration-eval.test.ts"],
        createdAt: now
      }
    ],
    pendingInvestigations: [],
    executionEpoch: 1,
    updatedAt: now
  };

  return {
    ...base,
    ...overrides,
    manifest: overrides.manifest ?? base.manifest,
    coverageItems: overrides.coverageItems ?? base.coverageItems,
    gaps: overrides.gaps ?? base.gaps,
    checkpoints: overrides.checkpoints ?? base.checkpoints,
    progressProofs: overrides.progressProofs ?? base.progressProofs,
    understandingMaps: overrides.understandingMaps ?? base.understandingMaps,
    runtimeTraces: overrides.runtimeTraces ?? base.runtimeTraces,
    pendingInvestigations: overrides.pendingInvestigations ?? base.pendingInvestigations
  };
}


type GeneratedAdversarialClass = "contradictory" | "stale" | "partial" | "interrupted";

interface GeneratedAdversarialCaseSpec {
  classId: GeneratedAdversarialClass;
  variantId: string;
  area: OrchestrationEvalArea;
  execute: () => Promise<{ passed: boolean; details: string }>;
}

function generatedReplayId(classId: GeneratedAdversarialClass, variantId: string): string {
  return `replay://orchestration/${classId}/${variantId}`;
}

async function runGeneratedAdversarialCases(): Promise<OrchestrationEvalCaseResult[]> {
  const specs: GeneratedAdversarialCaseSpec[] = [
    {
      classId: "contradictory",
      variantId: "fallback-over-noisy-checkpoint",
      area: "state",
      async execute() {
        const snapshot = buildAutonomousExecutionSnapshot(
          buildLegacyRewriteState({
            phase: "migration_sequencing",
            checkpoints: [
              {
                runId: "run-legacy",
                checkpointId: "cp-generated-fresh",
                authorityLabel: "runtime_authoritative",
                phase: "migration_sequencing",
                executionEpoch: 1,
                activeTargets: ["checkpoint:generated-fresh"],
                recentEvidenceRefs: ["tests/orchestration-eval.test.ts"],
                openGaps: ["gap:generated-contradiction"],
                nextActions: ["re-run migration sequencing after reconciling contradictory evidence"],
                compressedContextRef: "memory://generated/contradictory/fresh",
                createdAt: "2026-05-20T12:04:00.000Z"
              }
            ],
            gaps: [
              {
                id: "gap:generated-contradiction",
                targetId: "service:rewrite-core",
                kind: "contradicting_evidence",
                severity: "critical",
                description: "generated contradictory evidence remains unresolved",
                blocking: true,
                evidenceRefs: ["tests/orchestration-eval.test.ts"],
                createdBy: "qa_engineer",
                suggestedNextActions: ["re-run runtime tracing before sequencing"],
                status: "open"
              },
              {
                id: "gap:generated-noisy-inventory",
                targetId: "service:rewrite-core",
                kind: "missing_inventory",
                severity: "low",
                description: "generated inventory note remains open but non-authoritative for this combination",
                blocking: false,
                evidenceRefs: ["tests/orchestration-eval.test.ts"],
                createdBy: "reviewer",
                suggestedNextActions: ["document the generated inventory note"],
                status: "open"
              }
            ]
          })
        );

        return {
          passed:
            snapshot.phaseReadiness.blockerKind === "contradiction_loop" &&
            snapshot.phaseReadiness.transition === "fallback" &&
            snapshot.phaseReadiness.fallbackPhase === "modernization_strategy",
          details:
            `blocker=${snapshot.phaseReadiness.blockerKind} transition=${snapshot.phaseReadiness.transition ?? "none"} fallback=${snapshot.phaseReadiness.fallbackPhase ?? "none"}`
        };
      }
    },
    {
      classId: "stale",
      variantId: "checkpoint-still-blocks-with-progress-proof",
      area: "state",
      async execute() {
        const snapshot = buildAutonomousExecutionSnapshot(
          buildLegacyRewriteState({
            profile: "standard_delivery",
            phase: "validation",
            checkpoints: [
              {
                runId: "run-standard",
                checkpointId: "cp-generated-stale",
                authorityLabel: "runtime_authoritative",
                phase: "inventory",
                executionEpoch: 1,
                activeTargets: ["checkpoint:generated-stale"],
                recentEvidenceRefs: ["tests/orchestration-eval.test.ts"],
                openGaps: [],
                nextActions: ["resume from generated stale checkpoint"],
                compressedContextRef: "memory://generated/stale/checkpoint",
                createdAt: "2026-05-20T11:00:00.000Z"
              }
            ],
            progressProofs: [
              {
                cycle: 1,
                proofId: "proof-generated-stale",
                phaseBefore: "risk_analysis",
                phaseAfter: "validation",
                evidenceRefs: ["tests/orchestration-eval.test.ts"],
                coverageDelta: { validated: 1 },
                blockingGapDelta: { closed: 0, opened: 0 },
                nextTarget: "task:generated-proof-target",
                whyNext: "generated progress proof still points at a follow-up target",
                createdAt: "2026-05-20T11:30:00.000Z"
              }
            ],
            understandingMaps: [],
            runtimeTraces: [],
            executionEpoch: 4
          })
        );

        return {
          passed:
            snapshot.phaseReadiness.blockerKind === "stale_checkpoint" &&
            snapshot.phaseReadiness.staleCheckpoint === true,
          details:
            `blocker=${snapshot.phaseReadiness.blockerKind} stale=${snapshot.phaseReadiness.staleCheckpoint === true ? "yes" : "no"} latest=${snapshot.phaseReadiness.latestCheckpointId ?? "none"}`
        };
      }
    },
    {
      classId: "partial",
      variantId: "review-dispatch-overrides-autonomous-continuation",
      area: "gate",
      async execute() {
        const { service } = createEvalService();
        const run = await service.intakeRequest({
          workspaceSlug: "team",
          projectSlug: "archon",
          actor: "ceo",
          title: "Generated partial review case",
          request: "Do not continue autonomously before the remaining reviews pass."
        });

        await service.createTaskGraph(run.id, [
          taskPacket({
            taskId: "rewrite",
            qualityGates: [
              "product_acceptance",
              "coverage_ledger_required",
              "progress_proof_required",
              "checkpoint_resume_required"
            ]
          })
        ]);
        await service.claimTask(run.id, "rewrite", "planner");
        await submitReadyForReview(service, run.id, "rewrite");
        await service.recordReview(run.id, "rewrite", reviewContext("reviewer").actor, {
          reviewerRole: "reviewer",
          state: "passed",
          severity: "low",
          findings: []
        });
        await service.configureAutonomousExecution(run.id, {
          profile: "legacy_rewrite",
          phase: "runtime_tracing",
          manifest: {
            runId: run.id,
            profile: "legacy_rewrite",
            requiredCategories: ["services"],
            thresholds: {
              criticalItemCoverage: 0.8,
              criticalItemValidation: 0.6,
              callsiteCoverage: 0.85,
              runtimeTraceCoverage: 0.75
            }
          }
        });
        await service.upsertCoverageItems(run.id, [
          {
            id: "service:workflow-proof",
            category: "services",
            state: "validated",
            criticality: "critical",
            sources: ["src/core/service.ts:1"],
            callsiteCount: 1,
            callsitesAnalyzed: 1,
            runtimeTraced: true,
            evidenceRefs: ["src/core/service.ts:1"],
            verificationRefs: ["tests/orchestration-eval.test.ts"],
            lastUpdatedAt: "2026-05-20T12:00:00.000Z"
          }
        ]);
        await service.upsertCoverageGaps(run.id, [
          {
            id: "gap:generated-workflow-proof",
            targetId: "task:workflow-proof",
            kind: "missing_validation",
            severity: "high",
            description: "generated workflow proof still needs to run",
            blocking: true,
            evidenceRefs: ["tests/orchestration-eval.test.ts"],
            createdBy: "qa_engineer",
            suggestedNextActions: ["run generated workflow proof after authenticated reviews"],
            status: "open"
          }
        ]);
        await service.recordProgressProof(run.id, {
          cycle: 1,
          proofId: "proof-generated-partial",
          phaseBefore: "validation",
          phaseAfter: "runtime_tracing",
          evidenceRefs: ["tests/orchestration-eval.test.ts"],
          coverageDelta: { validated: 1 },
          blockingGapDelta: { closed: 0, opened: 1 },
          nextTarget: "task:workflow-proof",
          whyNext: "generated workflow proof remains the next target",
          createdAt: "2026-05-20T12:01:00.000Z"
        });
        await service.checkpointRun(run.id, {
          checkpointId: "cp-generated-partial",
          phase: "final_verification",
          activeTargets: ["task:workflow-proof"],
          recentEvidenceRefs: ["tests/orchestration-eval.test.ts"],
          openGaps: ["gap:generated-workflow-proof"],
          nextActions: ["run generated workflow proof after authenticated reviews"],
          compressedContextRef: "memory://generated/partial/checkpoint",
          createdAt: "2026-05-20T12:02:00.000Z"
        });

        const plan = await service.getExecutionPlan(run.id);
        const reviewTargets =
          plan.directive.kind === "dispatch_reviews"
            ? plan.directive.recommendations.map((recommendation) => recommendation.targetReviewRole ?? "none")
            : [];

        return {
          passed:
            plan.directive.kind === "dispatch_reviews" &&
            reviewTargets.includes("security_reviewer") &&
            reviewTargets.includes("qa_engineer"),
          details:
            `directive=${plan.directive.kind} reviews=${reviewTargets.join(",") || "none"}`
        };
      }
    },
    {
      classId: "interrupted",
      variantId: "fresh-checkpoint-keeps-continuation-target",
      area: "lifecycle",
      async execute() {
        const { service } = createEvalService();
        const run = await service.intakeRequest({
          workspaceSlug: "team",
          projectSlug: "archon",
          actor: "ceo",
          title: "Generated interrupted trace case",
          request: "Prefer runtime tracing over a fresh checkpoint when risky traces are still missing."
        });

        await service.createTaskGraph(run.id, [
          taskPacket({
            taskId: "rewrite",
            qualityGates: [
              "product_acceptance",
              "coverage_ledger_required",
              "progress_proof_required",
              "checkpoint_resume_required"
            ]
          })
        ]);
        await service.claimTask(run.id, "rewrite", "planner");
        await submitReadyForReview(service, run.id, "rewrite");
        await service.recordReview(run.id, "rewrite", reviewContext("reviewer").actor, {
          reviewerRole: "reviewer",
          state: "passed",
          severity: "low",
          findings: []
        });
        await service.recordReview(run.id, "rewrite", reviewContext("security_reviewer").actor, {
          reviewerRole: "security_reviewer",
          state: "passed",
          severity: "low",
          findings: []
        });
        await service.recordReview(run.id, "rewrite", reviewContext("qa_engineer").actor, {
          reviewerRole: "qa_engineer",
          state: "passed",
          severity: "low",
          findings: []
        });
        await service.configureAutonomousExecution(run.id, {
          profile: "legacy_rewrite",
          phase: "runtime_tracing",
          manifest: {
            runId: run.id,
            profile: "legacy_rewrite",
            requiredCategories: ["services"],
            thresholds: {
              criticalItemCoverage: 0.8,
              criticalItemValidation: 0.6,
              callsiteCoverage: 0.85,
              runtimeTraceCoverage: 0.75
            }
          }
        });
        await service.upsertCoverageItems(run.id, [
          {
            id: "service:generated-runtime-gap",
            category: "services",
            state: "validated",
            criticality: "critical",
            sources: ["src/core/service.ts:1"],
            callsiteCount: 1,
            callsitesAnalyzed: 1,
            evidenceRefs: ["src/core/service.ts:1"],
            verificationRefs: ["tests/orchestration-eval.test.ts"],
            lastUpdatedAt: "2026-05-20T12:00:00.000Z"
          }
        ]);
        await service.upsertCoverageGaps(run.id, [
          {
            id: "gap:generated-runtime-gap",
            targetId: "service:generated-runtime-gap",
            kind: "missing_runtime_trace",
            severity: "high",
            description: "generated risky runtime trace is still missing",
            blocking: true,
            evidenceRefs: ["tests/orchestration-eval.test.ts"],
            createdBy: "qa_engineer",
            suggestedNextActions: ["record generated runtime trace"],
            status: "open"
          }
        ]);
        await service.recordProgressProof(run.id, {
          cycle: 1,
          proofId: "proof-generated-interrupted",
          phaseBefore: "validation",
          phaseAfter: "runtime_tracing",
          evidenceRefs: ["tests/orchestration-eval.test.ts"],
          coverageDelta: { validated: 1 },
          blockingGapDelta: { closed: 0, opened: 1 },
          nextTarget: "checkpoint:generated-fresh",
          whyNext: "generated checkpoint exists but risky trace evidence is still missing",
          createdAt: "2026-05-20T12:03:00.000Z"
        });
        await service.checkpointRun(run.id, {
          checkpointId: "cp-generated-fresh",
          phase: "runtime_tracing",
          activeTargets: ["checkpoint:generated-fresh"],
          recentEvidenceRefs: ["tests/orchestration-eval.test.ts"],
          openGaps: ["gap:generated-runtime-gap"],
          nextActions: ["resume from generated fresh checkpoint"],
          compressedContextRef: "memory://generated/interrupted/checkpoint",
          createdAt: "2026-05-20T12:04:00.000Z"
        });

        const plan = await service.getExecutionPlan(run.id);

        return {
          passed: plan.directive.kind === "continue_analysis",
          details:
            plan.directive.kind === "continue_analysis"
              ? `directive=${plan.directive.kind} target=${plan.directive.targetId} source=${plan.directive.source}`
              : `directive=${plan.directive.kind}`
        };
      }
    }
  ];

  const results: OrchestrationEvalCaseResult[] = [];
  for (const spec of specs) {
    const outcome = await spec.execute();
    const replayId = generatedReplayId(spec.classId, spec.variantId);
    results.push(
      buildResult({
        id: `generated:${spec.classId}:${spec.variantId}`,
        replayId,
        area: spec.area,
        passed: outcome.passed,
        details: `replay=${replayId} ${outcome.details}`
      })
    );
  }

  return results;
}

export async function runOrchestrationBaseline(): Promise<OrchestrationEvalReport> {
  const cases: OrchestrationEvalCaseResult[] = [];

  {
    const { service } = createEvalService();
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Build core",
      request: "Ship the shared orchestration backend."
    });

    let message = "invalid task graph accepted";
    try {
      await service.createTaskGraph(run.id, [
        taskPacket({
          taskId: "invalid-task",
          requiredReviews: ["reviewer", "security_reviewer"]
        })
      ]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    cases.push(
      buildResult({
        id: "task_packet_contract_rejected",
        area: "gate",
        passed: message.includes("missing required review gate: qa_engineer"),
        details: message
      })
    );
  }

  {
    const { service } = createEvalService();
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Build core",
      request: "Ship the shared orchestration backend."
    });

    await service.createTaskGraph(run.id, [
      taskPacket({ taskId: "plan" }),
      taskPacket({
        taskId: "build",
        dependencies: ["plan"],
        allowedWriteScope: ["src/store"],
        ownerRole: "backend_engineer",
        requiredSpecialistRoles: ["backend_engineer"]
      })
    ]);

    const initialStatus = await service.resumeRun(run.id);
    await service.claimTask(run.id, "plan", "planner");
    await submitReadyForReview(service, run.id, "plan");
    await service.recordReview(run.id, "plan", reviewContext("reviewer").actor, {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await service.recordReview(run.id, "plan", reviewContext("security_reviewer").actor, {
      reviewerRole: "security_reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await service.recordReview(run.id, "plan", reviewContext("qa_engineer").actor, {
      reviewerRole: "qa_engineer",
      state: "passed",
      severity: "low",
      findings: []
    });
    const finalStatus = await service.resumeRun(run.id);

    cases.push(
      buildResult({
        id: "dependency_ready_set_progresses",
        area: "lifecycle",
        passed:
          initialStatus.nextTaskIds.length === 1 &&
          initialStatus.nextTaskIds[0] === "plan" &&
          finalStatus.nextTaskIds.includes("build"),
        details: `initial=${initialStatus.nextTaskIds.join(",")} final=${finalStatus.nextTaskIds.join(",")}`
      })
    );

    const routingReport = await service.recommendRouting(run.id);
    const ownerRecommendation = routingReport.recommendations.find((entry) => entry.taskId === "build");
    cases.push(
      buildResult({
        id: "routing_advisory_owner_dispatch",
        area: "lifecycle",
        passed:
          routingReport.mode === "advisory_only" &&
          ownerRecommendation?.recommendation === "owner_dispatch" &&
          ownerRecommendation.targetRole === "backend_engineer",
        details: `mode=${routingReport.mode} route=${ownerRecommendation?.recommendation ?? "none"} target=${ownerRecommendation?.targetRole ?? "none"}`
      })
    );
  }

  {
    const { service } = createEvalService();
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Build core",
      request: "Ship the shared orchestration backend."
    });

    await service.createTaskGraph(run.id, [
      taskPacket({ taskId: "task-1", allowedWriteScope: ["src/core"] }),
      taskPacket({ taskId: "task-2", allowedWriteScope: ["src/core/service"] })
    ]);

    await service.claimTask(run.id, "task-1", "planner");
    let message = "second claim unexpectedly succeeded";
    try {
      await service.claimTask(run.id, "task-2", "backend_engineer");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    cases.push(
      buildResult({
        id: "overlapping_write_scope_locked",
        area: "state",
        passed: message.includes("write scope locked"),
        details: message
      })
    );
  }

  {
    const { service } = createEvalService();
    const { run } = await seedInProgressTask(service, taskPacket());
    await submitReadyForReview(service, run.id, "task-1");

    const reviewResult = await service.recordReview(run.id, "task-1", reviewContext("reviewer").actor, {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });

    cases.push(
      buildResult({
        id: "partial_reviews_keep_task_blocked",
        area: "gate",
        passed:
          reviewResult.task.status === "review_blocked" &&
          reviewResult.blockers.some((blocker) => blocker.includes("missing required review: security_reviewer")) &&
          reviewResult.blockers.some((blocker) => blocker.includes("missing required review: qa_engineer")),
        details: `status=${reviewResult.task.status} blockers=${reviewResult.blockers.join(" | ")}`
      })
    );
  }

  {
    const { service, store } = createEvalService();
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Build core",
      request: "Ship the shared orchestration backend."
    });

    await service.createTaskGraph(run.id, [
      taskPacket({ taskId: "plan" }),
      taskPacket({
        taskId: "build",
        dependencies: ["plan"],
        allowedWriteScope: ["src/store"]
      })
    ]);
    await service.claimTask(run.id, "plan", "planner");
    await submitReadyForReview(service, run.id, "plan");
    await service.recordReview(run.id, "plan", reviewContext("reviewer").actor, {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await service.recordReview(run.id, "plan", reviewContext("security_reviewer").actor, {
      reviewerRole: "security_reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await service.recordReview(run.id, "plan", reviewContext("qa_engineer").actor, {
      reviewerRole: "qa_engineer",
      state: "passed",
      severity: "low",
      findings: []
    });

    mutateReviewWhere(
      store,
      (review) => review.runId === run.id && review.taskId === "plan" && review.reviewerRole === "qa_engineer",
      (review) => ({
        ...review,
        source: "self"
      })
    );

    const status = await service.resumeRun(run.id);
    const blockingLine = status.blockers.find((blocker) => blocker.includes("dependency plan has stale approval"));

    cases.push(
      buildResult({
        id: "stale_approved_dependency_reblocked",
        area: "gate",
        passed: status.nextTaskIds.length === 0 && blockingLine !== undefined,
        details: `next=${status.nextTaskIds.join(",")} blocker=${blockingLine ?? "none"}`
      })
    );
  }

  {
    const { service } = createEvalService({ withResolver: false });
    const { run } = await seedInProgressTask(service, taskPacket());
    await submitReadyForReview(service, run.id, "task-1");

    let message = "spoofed review unexpectedly accepted";
    try {
      await service.recordReview(run.id, "task-1", "security-reviewer-1", {
        reviewerRole: "security_reviewer",
        state: "passed",
        severity: "low",
        findings: []
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    cases.push(
      buildResult({
        id: "caller_asserted_review_authority_rejected",
        area: "trust",
        passed: message.includes("trusted review action context resolver"),
        details: message
      })
    );
  }

  {
    const bindings: ReviewIdentityBindings = {
      bindings: [
        {
          principal: {
            provider: "github",
            subject: "alice"
          },
          actors: [
            {
              actor: "alice-reviewer",
              roles: ["reviewer"]
            }
          ]
        }
      ]
    };
    const store = new MemoryStore();
    const service = new ArchonCoreService(store, {
      resolveReviewActionContext: createReviewActionContextResolver({
        bindings,
        resolveAuthenticatedPrincipal() {
          return {
            provider: "github",
            subject: "mallory",
            verified: true
          };
        }
      })
    });
    const { run } = await seedInProgressTask(service, taskPacket());
    await submitReadyForReview(service, run.id, "task-1");

    let message = "unbound principal unexpectedly accepted";
    try {
      await service.recordReview(run.id, "task-1", "alice-reviewer", {
        reviewerRole: "reviewer",
        state: "passed",
        severity: "low",
        findings: []
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    cases.push(
      buildResult({
        id: "unbound_principal_rejected",
        area: "trust",
        passed: message.includes("No review identity binding for github:mallory"),
        details: message
      })
    );
  }

  {
    const snapshot = buildAutonomousExecutionSnapshot(
      buildLegacyRewriteState({
        gaps: [
          {
            id: "gap:contradiction",
            targetId: "service:rewrite-core",
            kind: "contradicting_evidence",
            severity: "critical",
            description: "rewrite traces and business-rule extraction still disagree",
            blocking: true,
            evidenceRefs: ["tests/orchestration-eval.test.ts"],
            createdBy: "qa_engineer",
            suggestedNextActions: ["reopen runtime tracing before modernization strategy"],
            status: "open"
          }
        ]
      })
    );

    cases.push(
      buildResult({
        id: "contradiction_loop_forces_backward_transition",
        area: "state",
        passed:
          snapshot.phaseReadiness.status === "blocked" &&
          snapshot.phaseReadiness.blockerKind === "contradiction_loop" &&
          snapshot.phaseReadiness.transition === "fallback" &&
          snapshot.phaseReadiness.fallbackPhase === "runtime_tracing",
        details: `status=${snapshot.phaseReadiness.status} blocker=${snapshot.phaseReadiness.blockerKind} fallback=${snapshot.phaseReadiness.fallbackPhase ?? "none"}`
      })
    );
  }

  {
    const state = buildLegacyRewriteState({
      profile: "standard_delivery",
      phase: "validation",
      checkpoints: [
        {
          runId: "run-standard",
          checkpointId: "cp-stale",
          authorityLabel: "runtime_authoritative",
          phase: "inventory",
          executionEpoch: 1,
          activeTargets: ["checkpoint:stale"],
          recentEvidenceRefs: ["tests/orchestration-eval.test.ts"],
          openGaps: [],
          nextActions: ["resume from stale checkpoint"],
          compressedContextRef: "memory://cp-stale",
          createdAt: "2026-05-20T11:00:00.000Z"
        }
      ],
      understandingMaps: [],
      runtimeTraces: [],
      executionEpoch: 3
    });
    const snapshot = buildAutonomousExecutionSnapshot(state);
    const nextTarget = selectAutonomousNextTarget(state);

    cases.push(
      buildResult({
        id: "stale_checkpoint_does_not_override_continuation",
        area: "state",
        passed:
          nextTarget === undefined &&
          snapshot.phaseReadiness.blockerKind === "stale_checkpoint" &&
          snapshot.phaseReadiness.staleCheckpoint === true,
        details: `target=${nextTarget?.targetId ?? "none"} blocker=${snapshot.phaseReadiness.blockerKind} stale=${snapshot.phaseReadiness.staleCheckpoint === true ? "yes" : "no"}`
      })
    );
  }

  {
    const snapshot = buildAutonomousExecutionSnapshot(
      buildLegacyRewriteState({
        profile: "standard_delivery",
        phase: "validation",
        checkpoints: [
          {
            runId: "run-standard",
            checkpointId: "cp-fresh",
            authorityLabel: "runtime_authoritative",
            phase: "validation",
            executionEpoch: 2,
            activeTargets: ["checkpoint:fresh"],
            recentEvidenceRefs: ["tests/orchestration-eval.test.ts"],
            openGaps: [],
            nextActions: ["resume from the fresh checkpoint"],
            compressedContextRef: "memory://cp-fresh",
            createdAt: "2026-05-20T12:05:00.000Z"
          }
        ],
        understandingMaps: [],
        runtimeTraces: [],
        executionEpoch: 2
      })
    );
    const nextTarget = selectAutonomousNextTarget(snapshot.state);

    cases.push(
      buildResult({
        id: "fresh_checkpoint_preserves_interrupted_resume",
        area: "state",
        passed:
          snapshot.phaseReadiness.status === "ready" &&
          nextTarget?.source === "checkpoint" &&
          nextTarget.targetId === "checkpoint:fresh",
        details: `status=${snapshot.phaseReadiness.status} source=${nextTarget?.source ?? "none"} target=${nextTarget?.targetId ?? "none"}`
      })
    );
  }

  {
    const snapshot = buildAutonomousExecutionSnapshot(
      buildLegacyRewriteState({
        profile: "standard_delivery",
        phase: "validation",
        checkpoints: [],
        understandingMaps: [],
        runtimeTraces: [],
        retryBudgetRemaining: 0
      })
    );

    cases.push(
      buildResult({
        id: "retry_budget_exhaustion_blocks_readiness",
        area: "gate",
        passed:
          snapshot.phaseReadiness.status === "blocked" &&
          snapshot.phaseReadiness.blockerKind === "retry_budget_exhausted" &&
          snapshot.phaseReadiness.transition === "hold",
        details: `status=${snapshot.phaseReadiness.status} blocker=${snapshot.phaseReadiness.blockerKind} transition=${snapshot.phaseReadiness.transition ?? "none"}`
      })
    );
  }

  {
    const { service } = createEvalService();
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Backlog still open",
      request: "Do not mark the run complete while queued work remains."
    });

    await service.createTaskGraph(run.id, [
      taskPacket({ taskId: "plan" }),
      taskPacket({
        taskId: "build",
        dependencies: ["plan"],
        ownerRole: "backend_engineer",
        requiredSpecialistRoles: ["backend_engineer"],
        allowedWriteScope: ["src/core"]
      })
    ]);
    await service.configureAutonomousExecution(run.id, {
      profile: "legacy_rewrite",
      phase: "done"
    });

    const plan = await service.getExecutionPlan(run.id);

    cases.push(
      buildResult({
        id: "backlog_not_exhausted_false_completion_rejected",
        area: "lifecycle",
        passed: plan.directive.kind === "dispatch_owner",
        details: `directive=${plan.directive.kind}`
      })
    );
  }

  {
    const { service } = createEvalService();
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Autonomous continuation",
      request: "Keep moving from authoritative runtime evidence."
    });

    await service.createTaskGraph(run.id, [
      taskPacket({
        taskId: "rewrite",
        qualityGates: [
          "product_acceptance",
          "coverage_ledger_required",
          "progress_proof_required",
          "checkpoint_resume_required"
        ]
      })
    ]);
    await service.claimTask(run.id, "rewrite", "planner");
    await submitReadyForReview(service, run.id, "rewrite");
    await service.recordReview(run.id, "rewrite", reviewContext("reviewer").actor, {
      reviewerRole: "reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await service.recordReview(run.id, "rewrite", reviewContext("security_reviewer").actor, {
      reviewerRole: "security_reviewer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await service.recordReview(run.id, "rewrite", reviewContext("qa_engineer").actor, {
      reviewerRole: "qa_engineer",
      state: "passed",
      severity: "low",
      findings: []
    });
    await service.configureAutonomousExecution(run.id, {
      profile: "legacy_rewrite",
      phase: "final_verification",
      manifest: {
        runId: run.id,
        profile: "legacy_rewrite",
        requiredCategories: ["services"],
        thresholds: {
          criticalItemCoverage: 0.8,
          criticalItemValidation: 0.6,
          callsiteCoverage: 0.85,
          runtimeTraceCoverage: 0.75
        }
      }
    });
    await service.upsertCoverageItems(run.id, [
      {
        id: "service:workflow-proof",
        category: "services",
        state: "validated",
        criticality: "critical",
        sources: ["src/core/service.ts:1"],
        callsiteCount: 1,
        callsitesAnalyzed: 1,
        runtimeTraced: true,
        evidenceRefs: ["src/core/service.ts:1"],
        verificationRefs: ["tests/orchestration-eval.test.ts"],
        lastUpdatedAt: "2026-05-20T12:00:00.000Z"
      }
    ]);
    await service.upsertCoverageGaps(run.id, [
      {
        id: "gap:workflow-proof",
        targetId: "task:workflow-proof",
        kind: "missing_validation",
        severity: "high",
        description: "workflow proof still needs to run",
        blocking: true,
        evidenceRefs: ["tests/orchestration-eval.test.ts"],
        createdBy: "qa_engineer",
        suggestedNextActions: ["run workflow-proof after authenticated reviews"],
        status: "open"
      }
    ]);
    await service.recordProgressProof(run.id, {
      cycle: 1,
      proofId: "proof-1",
      phaseBefore: "validation",
      phaseAfter: "final_verification",
      evidenceRefs: ["tests/orchestration-eval.test.ts"],
      coverageDelta: { validated: 1 },
      blockingGapDelta: { closed: 0, opened: 1 },
      nextTarget: "task:workflow-proof",
      whyNext: "authenticated workflow proof remains the next target",
      createdAt: "2026-05-20T12:01:00.000Z"
    });
    await service.checkpointRun(run.id, {
      checkpointId: "cp-1",
      phase: "final_verification",
      activeTargets: ["task:workflow-proof"],
      recentEvidenceRefs: ["tests/orchestration-eval.test.ts"],
      openGaps: ["gap:workflow-proof"],
      nextActions: ["run workflow-proof after authenticated reviews"],
      compressedContextRef: "memory://cp-1",
      createdAt: "2026-05-20T12:02:00.000Z"
    });

    const plan = await service.getExecutionPlan(run.id);

    cases.push(
      buildResult({
        id: "terminal_tasks_with_autonomous_target_continue_analysis",
        area: "lifecycle",
        passed:
          plan.directive.kind === "continue_analysis" &&
          plan.directive.targetId === "task:workflow-proof",
        details:
          plan.directive.kind === "continue_analysis"
            ? `directive=${plan.directive.kind} target=${plan.directive.targetId} source=${plan.directive.source}`
            : `directive=${plan.directive.kind}`
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 6 eval group 1: context handoff baseline
  // Feed a fake context sample at 72% → LoopAction must be "handoff_required".
  // ---------------------------------------------------------------------------
  {
    const runId = "eval-run-ctx-handoff";
    const taskId = "eval-task-ctx-handoff";

    // Minimal in-memory mock of AgenticLoopStoreLike — no DB required.
    const contextSamples = new Map<string, { usedPercentage: number; sampledAt: string }>();
    const handoffFlags = new Map<string, boolean>();

    const mockLoopStore: AgenticLoopStoreLike = {
      async recordContextSample(data) {
        contextSamples.set(data.invocationId, {
          usedPercentage: data.usedPercentage ?? 0,
          sampledAt: data.sampledAt ?? new Date().toISOString()
        });
      },
      async getLatestContextSample(invocationId) {
        const s = contextSamples.get(invocationId);
        if (s === undefined) return undefined;
        return {
          invocationId,
          runId,
          taskId,
          source: "sdk" as const,
          usedPercentage: s.usedPercentage,
          sampledAt: s.sampledAt,
          raw: {}
        } satisfies ContextSample;
      },
      async hasCommittedHandoff(invocationId) {
        return handoffFlags.get(invocationId) ?? false;
      },
      async getNextTask() { return null; },
      async createInvocation(data) { return `inv-${data.taskId}`; },
      async updateInvocationStatus() { /* no-op */ },
      async getInvocationStatus() { return undefined; },
      async getActiveTask() { return null; },
      async getActiveInvocation() { return null; },
      async countPendingHandoffs() { return 0; }
    };

    const controller = new AgenticLoopController(mockLoopStore, { runId });
    const action = await controller.onContextSample("inv-eval-1", 72);

    cases.push(
      buildResult({
        id: "phase6_context_handoff_baseline",
        area: "gate",
        passed: action === "handoff_required",
        details: `onContextSample(72%) returned: ${action}`
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 6 eval group 2: continuation after handoff
  // Simulate a committed handoff → build continuation bundle → verify prompt
  // contains summary and next_actions.
  // ---------------------------------------------------------------------------
  {
    const runId = "eval-run-continuation";
    const taskId = "eval-task-continuation";

    const fakeHandoffRecord: HandoffRecord = {
      id: "handoff-eval-123",
      runId,
      taskId,
      fromInvocationId: "inv-from",
      toInvocationId: undefined,
      fromRole: "backend_engineer",
      toRole: "backend_engineer",
      reason: "context_threshold_70",
      status: "in_progress",
      contextUsedPct: 72,
      authorityLabel: "runtime_authoritative",
      createdAt: new Date().toISOString(),
      consumedAt: undefined,
      packet: {
        schemaVersion: 1,
        handoffId: "handoff-eval-123",
        runId,
        taskId,
        fromInvocationId: "inv-from",
        fromRole: "backend_engineer",
        toRole: "backend_engineer",
        reason: "context_threshold_70",
        contextUsedPct: 72,
        status: "in_progress",
        summary: "Completed initial scaffolding of the runtime module",
        scope: { allowedWriteScope: ["src/runtime/"], touchedPaths: ["src/runtime/agentic-loop.ts"] },
        decisions: [],
        openQuestions: [],
        evidenceRefs: ["tests/phase6-agentic-loop.test.ts"],
        nextActions: ["run npm test", "fix any tsc errors"],
        risks: [],
        createdAt: new Date().toISOString()
      }
    };

    const mockHandoffStore: HandoffStoreLike = {
      async createHandoff(data) {
        return { ...fakeHandoffRecord, id: data.id };
      },
      async getLatestUnconsumedHandoff() {
        return fakeHandoffRecord;
      },
      async markHandoffConsumed() { /* no-op */ },
      async updateAgentInvocationStatus() { /* no-op */ }
    };

    const builder = new ContinuationContextBuilder(mockHandoffStore);
    const bundle = await builder.buildBundle({ runId, taskId, role: "backend_engineer" });

    const hasSummary = bundle.continuationPrompt.includes("Completed initial scaffolding");
    const hasNextActions = bundle.nextActions.length > 0 && bundle.nextActions[0] === "run npm test";

    cases.push(
      buildResult({
        id: "phase6_continuation_after_handoff",
        area: "lifecycle",
        passed: hasSummary && hasNextActions,
        details: `hasSummary=${hasSummary} hasNextActions=${hasNextActions} nextActions=${JSON.stringify(bundle.nextActions)}`
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 6 eval group 3: subagent spawn denied beyond depth
  // depth=3 parent → childDepth=4 > maxChildDepth=2 → SpawnOutcome.ok=false
  // ---------------------------------------------------------------------------
  {
    const parentId = "inv-parent-depth3";
    const taskId = "eval-task-depth";
    const runId = "eval-run-depth";

    const parentRef: ParentInvocationRef = {
      status: "running",
      taskId,
      runId,
      allowedWriteScope: ["src/"],
      depth: 3,
      spawnPolicy: {
        canSpawnSubagents: true,
        allowedSubagentTypes: ["codebase_scout"],
        maxChildDepth: 2,
        maxConcurrentChildren: 3,
        maxTotalChildrenPerTask: 10
      }
    };

    const mockInvocationStore: ParentInvocationStoreLike = {
      async getInvocation(id) {
        return id === parentId ? parentRef : undefined;
      }
    };

    const mockSubtaskStore: SubtaskStoreLike = {
      async createSubtask(data) {
        return {
          id: data.id,
          runId: data.runId,
          taskId: data.taskId,
          parentInvocationId: data.parentInvocationId,
          subagentType: data.subagentType,
          title: data.title,
          prompt: data.prompt,
          allowedTools: data.allowedTools,
          allowedWriteScope: data.allowedWriteScope,
          status: data.status,
          createdAt: new Date().toISOString()
        };
      },
      async updateSubtaskResult() { /* no-op */ },
      async listSubtasksForTask() { return []; }
    };

    const scheduler = new SubtaskScheduler(mockSubtaskStore, mockInvocationStore);
    const outcome = await scheduler.requestSubtask(parentId, {
      subagentType: "codebase_scout",
      title: "scout",
      prompt: "analyze codebase",
      allowedTools: ["Read"],
      allowedWriteScope: [],
      maxTurns: 10,
      stopCondition: "when done"
    });

    const denied = !outcome.ok;
    const hasDepthMessage = !outcome.ok && outcome.reason.toLowerCase().includes("depth");

    cases.push(
      buildResult({
        id: "phase6_subagent_spawn_denied_beyond_depth",
        area: "gate",
        passed: denied && hasDepthMessage,
        details: `ok=${outcome.ok} reason=${outcome.ok ? "n/a" : outcome.reason}`
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 6 eval group 4: debate skipped for trivial trigger
  // shouldDebate({ kind: "trivial_edit" }) must return false.
  // ---------------------------------------------------------------------------
  {
    const mockDebateStore = {
      async createDebateSession() { throw new Error("should not be called"); },
      async addDebateArgument() { throw new Error("should not be called"); },
      async updateDebateDecision() { throw new Error("should not be called"); }
    };

    const debateController = new DebateController(mockDebateStore);
    const result = debateController.shouldDebate({ kind: "trivial_edit" });

    cases.push(
      buildResult({
        id: "phase6_debate_skipped_for_trivial_trigger",
        area: "gate",
        passed: result === false,
        details: `shouldDebate("trivial_edit") = ${result}`
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 6 eval group 5: debate required for architecture trigger
  // shouldDebate({ kind: "architecture_significant" }) must return true.
  // ---------------------------------------------------------------------------
  {
    const mockDebateStore = {
      async createDebateSession() { throw new Error("should not be called"); },
      async addDebateArgument() { throw new Error("should not be called"); },
      async updateDebateDecision() { throw new Error("should not be called"); }
    };

    const debateController = new DebateController(mockDebateStore);
    const result = debateController.shouldDebate({ kind: "architecture_significant" });

    cases.push(
      buildResult({
        id: "phase6_debate_required_for_architecture_trigger",
        area: "gate",
        passed: result === true,
        details: `shouldDebate("architecture_significant") = ${result}`
      })
    );
  }

  cases.push(...(await runGeneratedAdversarialCases()));

  const passedCases = cases.filter((testCase) => testCase.passed).length;
  const totalCases = cases.length;
  const failedCases = totalCases - passedCases;
  const passRate = totalCases === 0 ? 0 : passedCases / totalCases;
  const replayCases = cases.filter((testCase) => testCase.evidenceScope === "replay_grade");
  const replayPassedCases = replayCases.filter((testCase) => testCase.passed).length;
  const replayTotalCases = replayCases.length;
  const replayFailedCases = replayTotalCases - replayPassedCases;
  const replayPassRate = replayTotalCases === 0 ? 0 : replayPassedCases / replayTotalCases;

  return {
    cases,
    summary: {
      totalCases,
      passedCases,
      failedCases,
      passRate,
      requiredPassRate: orchestrationRequiredPassRate,
      meetsThreshold: passRate >= orchestrationRequiredPassRate,
      authorityLabel: "derived_only"
    },
    replayLayer: {
      totalCases: replayTotalCases,
      passedCases: replayPassedCases,
      failedCases: replayFailedCases,
      passRate: replayPassRate,
      requiredPassRate: orchestrationRequiredPassRate,
      meetsThreshold: replayPassRate >= orchestrationRequiredPassRate,
      authorityLabel: "derived_only",
      evidenceScope: "replay_grade",
      boundaryNote:
        "Replay-grade cases exercise broader multi-step degradation scenarios and should be read as stronger repo-local evidence, not external certification."
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runOrchestrationBaseline()
    .then((report) => {
      console.log(JSON.stringify(report));
      if (!report.summary.meetsThreshold) {
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
