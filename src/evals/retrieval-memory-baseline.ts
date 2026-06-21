import { SEARCH_MEMORY_STALE_AFTER_DAYS } from "../core/policy.ts";
import { createReviewActionContextResolver } from "../core/review-context.ts";
import type { ResolveReviewActionContext } from "../core/review-context.ts";
import { ArchonCoreService } from "../core/service.ts";
import type { MemoryEntryRecord } from "../domain/types.ts";
import { MemoryStore } from "../store/memory-store.ts";

/**
 * Trusted seed resolver for memory promotion in eval / local-seed contexts.
 *
 * Accepts the "memory_curator" and "memory_curator@example.com" actors and
 * binds them to the "reviewer" role via the archon-local-seed provider.
 * Must never be used in production.
 */
function createMemoryPromotionSeedResolver(): ResolveReviewActionContext {
  return createReviewActionContextResolver({
    bindings: {
      bindings: [
        {
          principal: { provider: "archon-local-seed", subject: "memory_curator" },
          actors: [{ actor: "memory_curator", roles: ["reviewer"] }]
        },
        {
          principal: { provider: "archon-local-seed", subject: "memory_curator@example.com" },
          actors: [{ actor: "memory_curator@example.com", roles: ["reviewer"] }]
        }
      ]
    },
    async resolveAuthenticatedPrincipal(input) {
      return {
        provider: "archon-local-seed",
        subject: input.actor,
        verified: true
      };
    }
  });
}

export interface RetrievalEvalCaseResult {
  id: string;
  goal: "recall_precision" | "provenance" | "citation" | "redaction" | "freshness" | "conflict";
  passed: boolean;
  details: string;
}

export interface RetrievalEvalSummary {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
}

export interface RetrievalEvalReport {
  cases: RetrievalEvalCaseResult[];
  summary: RetrievalEvalSummary;
}

export function mutateMemoryEntryWhere(
  store: MemoryStore,
  predicate: (entry: MemoryEntryRecord) => boolean,
  mutate: (entry: MemoryEntryRecord) => MemoryEntryRecord
): void {
  const memoryEntries = (store as unknown as { memoryEntries: Map<string, MemoryEntryRecord> }).memoryEntries;
  const entry = [...memoryEntries.values()].find(predicate);

  if (!entry) {
    throw new Error("expected matching memory entry");
  }

  const nextEntry = mutate(entry);
  memoryEntries.set(nextEntry.id, nextEntry);
}

export async function runRetrievalMemoryBaseline(): Promise<RetrievalEvalReport> {
  const cases: RetrievalEvalCaseResult[] = [];
  const store = new MemoryStore();
  const service = new ArchonCoreService(store, {
    resolveReviewActionContext: createMemoryPromotionSeedResolver(),
    reviewSource: "seed"
  });

  const projectRun = await service.intakeRequest({
    workspaceSlug: "team",
    projectSlug: "archon",
    actor: "ceo",
    title: "Build core",
    request: "Ship the shared orchestration backend."
  });

  await service.promoteMemory(projectRun.id, {
    scope: "project",
    entryType: "decision",
    title: "Incident playbook",
    content: "release recoveries and rollback notes",
    sourceRunId: projectRun.id,
    sourceTaskId: "task-incident",
    reviewer: "memory_curator",
    actor: "memory_curator"
  });

  await store.replaceMarkdownArtifacts({
    workspaceId: projectRun.workspaceId,
    projectId: projectRun.projectId,
    runId: projectRun.id,
    artifacts: [
      {
        id: "artifact-incident-playbook",
        workspaceId: projectRun.workspaceId,
        projectId: projectRun.projectId,
        runId: projectRun.id,
        kind: "markdown_chunk",
        title: "Incident Playbook",
        content: "Rollback checklist for release recoveries. Verify retrieval citations reference the source markdown path.",
        sourcePath: "docs/runbook.md",
        sourceAnchor: "incident-playbook",
        metadata: {
          chunkIndex: 0
        },
        createdAt: new Date().toISOString()
      }
    ]
  });

  await service.promoteMemory(projectRun.id, {
    scope: "project",
    entryType: "decision",
    title: "Unprovenanced note",
    content: "missing reviewer should block",
    sourceRunId: projectRun.id,
    sourceTaskId: "task-unprovenanced",
    reviewer: "memory_curator",
    actor: "memory_curator"
  });

  mutateMemoryEntryWhere(store, (entry) => entry.title === "Unprovenanced note", (entry) => ({
    ...entry,
    reviewer: ""
  }));

  await service.promoteMemory(projectRun.id, {
    scope: "global",
    entryType: "pattern",
    title: "Global onboarding",
    content: "shared onboarding blueprint",
    sourceRunId: projectRun.id,
    sourceTaskId: "task-global",
    reviewer: "memory_curator@example.com",
    actor: "memory_curator@example.com"
  });

  await service.promoteMemory(projectRun.id, {
    scope: "project",
    entryType: "lesson",
    title: "Security review exception",
    content: "private auth bypass triage flow",
    sourceRunId: projectRun.id,
    sourceTaskId: "task-security-exception",
    reviewer: "memory_curator",
    actor: "memory_curator",
    metadata: {
      retrievalRoles: ["security_reviewer"],
      tags: ["security", "incident"]
    }
  });

  await service.promoteMemory(projectRun.id, {
    scope: "project",
    entryType: "lesson",
    title: "Legacy deploy playbook",
    content: "legacy deploy recoveries and rollback notes",
    sourceRunId: projectRun.id,
    sourceTaskId: "task-legacy",
    reviewer: "memory_curator",
    actor: "memory_curator"
  });

  mutateMemoryEntryWhere(store, (entry) => entry.title === "Legacy deploy playbook", (entry) => ({
    ...entry,
    createdAt: "2000-01-01T00:00:00.000Z"
  }));

  await service.promoteMemory(projectRun.id, {
    scope: "project",
    entryType: "decision",
    title: "Adopt pgvector retrieval",
    content: "pgvector retrieval should be enabled for memory search",
    sourceRunId: projectRun.id,
    sourceTaskId: "task-conflict-enable",
    reviewer: "memory_curator",
    actor: "memory_curator"
  });

  await service.promoteMemory(projectRun.id, {
    scope: "project",
    entryType: "decision",
    title: "Delay pgvector retrieval",
    content: "pgvector retrieval should stay disabled until backfill passes",
    sourceRunId: projectRun.id,
    sourceTaskId: "task-conflict-delay",
    reviewer: "memory_curator",
    actor: "memory_curator"
  });

  const recallResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "incident playbook"
  });
  const recallTop = recallResults[0];
  cases.push({
    id: "project_recall_precision",
    goal: "recall_precision",
    passed: recallTop?.title === "Incident playbook",
    details: `top=${recallTop?.title ?? "none"} score=${recallTop?.score ?? "none"} status=${recallTop?.freshness.status ?? "none"}`
  });

  cases.push({
    id: "project_provenance_present",
    goal: "provenance",
    passed:
      recallTop?.authority.reviewedBy === "memory_curator" &&
      recallTop?.citation.runId === projectRun.id &&
      recallTop?.provenance.taskId === "task-incident",
    details: `reviewedBy=${recallTop?.authority.reviewedBy ?? "none"} runId=${recallTop?.citation.runId ?? "none"} taskId=${recallTop?.provenance.taskId ?? "none"}`
  });

  cases.push({
    id: "project_citation_present",
    goal: "citation",
    passed:
      recallTop?.citation.kind === "memory_entry" &&
      recallTop?.citation.memoryId !== undefined &&
      recallTop?.citation.label === "Incident playbook" &&
      recallTop?.citation.taskId === "task-incident",
    details: `kind=${recallTop?.citation.kind ?? "none"} memoryId=${recallTop?.citation.memoryId ?? "none"} label=${recallTop?.citation.label ?? "none"}`
  });

  const markdownResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "source markdown path"
  });
  const markdownTop = markdownResults[0];
  cases.push({
    id: "repo_markdown_context_present",
    goal: "citation",
    passed:
      markdownTop?.authority.source === "repo_artifact" &&
      markdownTop?.citation.kind === "artifact" &&
      markdownTop?.citation.sourcePath === "docs/runbook.md" &&
      markdownTop?.citation.canonicalRef === "docs/runbook.md#incident-playbook",
    details: `source=${markdownTop?.authority.source ?? "none"} kind=${markdownTop?.citation.kind ?? "none"} ref=${markdownTop?.citation.canonicalRef ?? "none"}`
  });

  const redactionResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "shared onboarding",
    includeGlobal: true
  });
  const redactionTop = redactionResults.find((result) => result.scope === "global");
  cases.push({
    id: "global_redaction",
    goal: "redaction",
    passed:
      redactionTop?.scope === "global" &&
      redactionTop.authority.reviewedBy === undefined &&
      redactionTop.citation.runId === undefined &&
      redactionTop.provenance.actor === undefined,
    details: `scope=${redactionTop?.scope ?? "none"} reviewedBy=${redactionTop?.authority.reviewedBy ?? "redacted"} citationRunId=${redactionTop?.citation.runId ?? "redacted"}`
  });

  const hiddenRestrictedResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "private auth bypass triage flow"
  });
  const visibleRestrictedResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "private auth bypass triage flow",
    requesterRole: "security_reviewer"
  });
  cases.push({
    id: "role_filtered_retrieval",
    goal: "redaction",
    passed:
      hiddenRestrictedResults.every((result) => result.title !== "Security review exception") &&
      visibleRestrictedResults.some(
        (result) =>
          result.title === "Security review exception" &&
          result.metadata.allowedRoles.includes("security_reviewer") &&
          !result.metadata.allowedRoles.includes("planner")
      ),
    details: `planner=${hiddenRestrictedResults.map((result) => result.title).join(" | ") || "none"} security=${visibleRestrictedResults
      .map((result) => result.title)
      .join(" | ") || "none"}`
  });

  const freshnessResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "incident playbook"
  });
  const freshnessResult = freshnessResults[0];
  cases.push({
    id: "freshness_fresh_status",
    goal: "freshness",
    passed:
      freshnessResult?.freshness.status === "fresh" &&
      freshnessResult?.freshness.createdAt === freshnessResult?.provenance.createdAt &&
      (freshnessResult?.freshness.ageDays ?? -1) >= 0,
    details: `status=${freshnessResult?.freshness.status ?? "none"} ageDays=${freshnessResult?.freshness.ageDays ?? "none"}`
  });

  const staleResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "legacy deploy playbook"
  });
  const staleTop = staleResults[0];
  cases.push({
    id: "freshness_stale_status",
    goal: "freshness",
    passed:
      staleTop?.title === "Legacy deploy playbook" &&
      staleTop.freshness.status === "stale" &&
      staleTop.freshness.staleAfterDays === SEARCH_MEMORY_STALE_AFTER_DAYS &&
      (staleTop.freshness.ageDays ?? 0) > SEARCH_MEMORY_STALE_AFTER_DAYS,
    details: `status=${staleTop?.freshness.status ?? "none"} ageDays=${staleTop?.freshness.ageDays ?? "none"} staleAfterDays=${staleTop?.freshness.staleAfterDays ?? "none"}`
  });

  const conflictResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "pgvector retrieval"
  });
  const conflictTopTitles = conflictResults.slice(0, 2).map((result) => result.title).sort();
  cases.push({
    id: "conflict_candidates_visible",
    goal: "conflict",
    passed:
      conflictTopTitles.length === 2 &&
      conflictResults
        .slice(0, 2)
        .every((result) => result.conflict.detected && result.conflict.relatedIds.length === 1) &&
      conflictTopTitles[0] === "Adopt pgvector retrieval" &&
      conflictTopTitles[1] === "Delay pgvector retrieval",
    details: `top2=${conflictTopTitles.join(" | ")} conflictFlags=${conflictResults
      .slice(0, 2)
      .map((result) => result.conflict.detected)
      .join(",")}`
  });

  const unprovenancedResults = await service.searchMemory({
    workspaceSlug: "team",
    projectSlug: "archon",
    query: "unprovenanced note"
  });
  cases.push({
    id: "unprovenanced_blocked",
    goal: "provenance",
    passed: unprovenancedResults.every((result) => result.title !== "Unprovenanced note"),
    details: `titles=${unprovenancedResults.map((result) => result.title).join(" | ")}`
  });

  const passedCases = cases.filter((testCase) => testCase.passed).length;
  const failedCases = cases.length - passedCases;

  return {
    cases,
    summary: {
      totalCases: cases.length,
      passedCases,
      failedCases,
      passRate: cases.length === 0 ? 1 : passedCases / cases.length
    }
  };
}
