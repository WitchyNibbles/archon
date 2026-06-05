import {
  type ArtifactKind,
  type ApprovalDecision,
  type GateReviewRole,
  type LockRecord,
  type MarkdownArtifactRecord,
  type MemoryEntryRecord,
  type RetrievalMetadata,
  type RetrievalRole,
  type ReviewRecord,
  type SearchMemoryFreshness,
  type SearchMemoryMetadata,
  type SearchMemoryResult,
  type TaskPacketInput,
  type TaskRecord,
  type WorkflowDocumentRecord
} from "../domain/types.ts";
import { getAgentCatalogEntry } from "../archon/agent-catalog.ts";
import {
  canReviewRecordSatisfyGate,
  effectiveRequiredReviews,
  normalizeRetrievalMetadata
} from "../domain/contracts.ts";
import { assessFreshness } from "../runtime/freshness-gate.ts";

export const SEARCH_MEMORY_STALE_AFTER_DAYS = 90;

function pathOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function hasOverlappingWriteScope(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => pathOverlap(leftPath, rightPath)));
}

export function findTaskDependencies(task: TaskPacketInput, allTasks: readonly TaskRecord[]): TaskRecord[] {
  const taskIds = new Set(task.dependencies);
  return allTasks.filter((candidate) => taskIds.has(candidate.packet.taskId));
}

export function findBlockingReasonsForTask(
  task: TaskRecord,
  allTasks: readonly TaskRecord[],
  activeLocks: readonly LockRecord[]
): string[] {
  const blockers: string[] = [];

  for (const dependency of findTaskDependencies(task.packet, allTasks)) {
    if (!["approved", "done"].includes(dependency.status)) {
      blockers.push(`dependency ${dependency.packet.taskId} is ${dependency.status}`);
    }
  }

  const lockConflict = activeLocks.find(
    (lock) =>
      lock.taskId !== task.packet.taskId &&
      lock.status === "active" &&
      hasOverlappingWriteScope(lock.scopePaths, task.packet.allowedWriteScope)
  );

  if (lockConflict) {
    blockers.push(`write scope locked by ${lockConflict.taskId}`);
  }

  return blockers;
}

export function evaluateReviewDecision(
  task: TaskRecord,
  reviews: readonly ReviewRecord[]
): { decision: ApprovalDecision; blockers: string[] } {
  const blockers: string[] = [];

  for (const requiredReview of effectiveRequiredReviews(task.packet.requiredReviews)) {
    const matchingReviews = reviews.filter((review) => review.reviewerRole === requiredReview);
    if (matchingReviews.length === 0) {
      blockers.push(`missing required review: ${requiredReview}`);
      continue;
    }

    const latestReview = matchingReviews.at(-1)!;
    if (canReviewRecordSatisfyGate(latestReview)) {
      continue;
    }

    if (latestReview.identityAssurance !== "authenticated") {
      blockers.push(`required review provenance unauthenticated: ${requiredReview}`);
      continue;
    }

    if (latestReview.state === "waived" && !latestReview.waiverReason) {
      blockers.push(`waived review missing reason: ${requiredReview}`);
      continue;
    }

    if (latestReview.state === "waived") {
      blockers.push(`required review waiver unauthorized: ${requiredReview}`);
      continue;
    }

    blockers.push(`required review not passed: ${requiredReview} is ${latestReview.state}`);
  }

  return {
    decision: blockers.length > 0 ? "blocked" : "approved",
    blockers
  };
}

export function collectUnsatisfiedReviewRoles(
  task: TaskRecord,
  reviews: readonly ReviewRecord[]
): GateReviewRole[] {
  const missing: GateReviewRole[] = [];

  for (const requiredReview of effectiveRequiredReviews(task.packet.requiredReviews)) {
    const matchingReviews = reviews.filter((review) => review.reviewerRole === requiredReview);
    if (matchingReviews.length === 0) {
      missing.push(requiredReview);
      continue;
    }

    const latestReview = matchingReviews.at(-1)!;
    if (!canReviewRecordSatisfyGate(latestReview)) {
      missing.push(requiredReview);
    }
  }

  return missing;
}

export function getRoleRetrievalGuidance(role: RetrievalRole): string[] {
  return [...getAgentCatalogEntry(role).retrievalGuidance];
}

type SearchableText = Pick<MemoryEntryRecord, "content" | "title" | "scope">;

export function scoreSearchableResult(
  entry: SearchableText,
  query: string,
  sameProject: boolean
): number {
  const normalizedQuery = query.trim().toLowerCase();
  const queryTerms = tokenizeSearchText(query);
  const titleTerms = new Set(tokenizeSearchText(entry.title));
  const contentTerms = new Set(tokenizeSearchText(entry.content));

  const titlePhraseBoost = normalizedQuery.length > 0 && entry.title.toLowerCase().includes(normalizedQuery) ? 6 : 0;
  const contentPhraseBoost = normalizedQuery.length > 0 && entry.content.toLowerCase().includes(normalizedQuery) ? 3 : 0;
  const titleCoverageBoost = scoreTermCoverage(titleTerms, queryTerms, 6);
  const contentCoverageBoost = scoreTermCoverage(contentTerms, queryTerms, 3);
  const projectBias = sameProject ? 4 : entry.scope === "global" ? 1 : 0;

  return titlePhraseBoost + contentPhraseBoost + titleCoverageBoost + contentCoverageBoost + projectBias;
}

export function compareMemorySearchResults(
  left: Pick<SearchMemoryResult, "id" | "title" | "score" | "projectSlug" | "freshness" | "authority">,
  right: Pick<SearchMemoryResult, "id" | "title" | "score" | "projectSlug" | "freshness" | "authority">
): number {
  const leftAuthority = left.projectSlug ? 1 : 0;
  const rightAuthority = right.projectSlug ? 1 : 0;
  if (leftAuthority !== rightAuthority) {
    return rightAuthority - leftAuthority;
  }

  const leftFreshnessRank = compareableFreshnessRank(left.freshness.status);
  const rightFreshnessRank = compareableFreshnessRank(right.freshness.status);
  if (leftFreshnessRank !== rightFreshnessRank) {
    return rightFreshnessRank - leftFreshnessRank;
  }

  if (left.score !== right.score) {
    return right.score - left.score;
  }

  const leftSourceRank = left.authority.source === "shared_backend_memory" || left.authority.source === "runtime_document" ? 1 : 0;
  const rightSourceRank = right.authority.source === "shared_backend_memory" || right.authority.source === "runtime_document" ? 1 : 0;
  if (leftSourceRank !== rightSourceRank) {
    return rightSourceRank - leftSourceRank;
  }

  const titleComparison = left.title.localeCompare(right.title);
  if (titleComparison !== 0) {
    return titleComparison;
  }

  return left.id.localeCompare(right.id);
}

export function scoreMemoryResult(
  entry: Pick<MemoryEntryRecord, "content" | "title" | "scope">,
  query: string,
  sameProject: boolean
): number {
  return scoreSearchableResult(entry, query, sameProject);
}

export function canRoleAccessRetrievalMetadata(
  metadata: RetrievalMetadata | undefined,
  requesterRole: RetrievalRole
): boolean {
  return normalizeRetrievalMetadata(metadata).retrievalRoles.includes(requesterRole);
}

export function canRoleAccessSearchResult(result: SearchMemoryResult, requesterRole: RetrievalRole): boolean {
  return result.metadata.allowedRoles.includes(requesterRole);
}

export function buildMemorySearchResult(
  entry: Pick<
    MemoryEntryRecord,
    | "id"
    | "title"
    | "content"
    | "scope"
    | "entryType"
    | "actor"
    | "reviewer"
    | "runId"
    | "taskId"
    | "sourcePath"
    | "sourceAnchor"
    | "metadata"
    | "createdAt"
  >,
  query: string,
  sameProject: boolean,
  projectSlug?: string | undefined,
  now: string = new Date().toISOString()
): SearchMemoryResult {
  const exposeSensitiveProvenance = sameProject;
  const normalizedMetadata = normalizeRetrievalMetadata(entry.metadata);
  const freshness = buildSearchMemoryFreshness(
    entry.createdAt,
    now,
    normalizedMetadata.staleAfterDays ?? SEARCH_MEMORY_STALE_AFTER_DAYS
  );

  return {
    id: entry.id,
    title: entry.title,
    content: entry.content,
    scope: entry.scope,
    projectSlug,
    score: scoreSearchableResult(entry, query, sameProject) + freshnessScoreAdjustment(freshness.status),
    authority: {
      source: "shared_backend_memory",
      precedence: "retrieval_hint",
      scope: entry.scope,
      reviewedBy: exposeSensitiveProvenance ? entry.reviewer : undefined,
      authorityLevel: normalizedMetadata.authorityLevel ?? "reviewed_memory",
      allowedRoles: [...normalizedMetadata.retrievalRoles]
    },
    freshness,
    citation: {
      kind: "memory_entry",
      memoryId: entry.id,
      label: entry.title,
      sourcePath: exposeSensitiveProvenance ? entry.sourcePath : undefined,
      sourceAnchor: exposeSensitiveProvenance ? entry.sourceAnchor : undefined,
      canonicalRef: buildCanonicalCitationRef(
        entry.id,
        exposeSensitiveProvenance ? entry.sourcePath : undefined,
        exposeSensitiveProvenance ? entry.sourceAnchor : undefined
      ),
      runId: exposeSensitiveProvenance ? entry.runId : undefined,
      taskId: exposeSensitiveProvenance ? entry.taskId : undefined
    },
    provenance: {
      entryType: entry.entryType,
      actor: exposeSensitiveProvenance ? entry.actor : undefined,
      reviewer: exposeSensitiveProvenance ? entry.reviewer : undefined,
      runId: exposeSensitiveProvenance ? entry.runId : undefined,
      taskId: exposeSensitiveProvenance ? entry.taskId : undefined,
      createdAt: entry.createdAt
    },
    metadata: buildSearchMemoryMetadata(normalizedMetadata, freshness.staleAfterDays),
    conflict: {
      detected: false,
      relatedIds: []
    }
  };
}

export function buildArtifactSearchResult(
  artifact: Pick<
    MarkdownArtifactRecord,
    "id" | "title" | "content" | "sourcePath" | "sourceAnchor" | "createdAt" | "kind" | "metadata" | "runId"
  >,
  query: string,
  projectSlug: string,
  now: string = new Date().toISOString()
): SearchMemoryResult {
  const normalizedMetadata = normalizeRetrievalMetadata(artifact.metadata);
  const freshness = buildSearchMemoryFreshness(
    artifact.createdAt,
    now,
    normalizedMetadata.staleAfterDays ?? SEARCH_MEMORY_STALE_AFTER_DAYS
  );

  return {
    id: artifact.id,
    title: artifact.title,
    content: artifact.content,
    scope: "project",
    projectSlug,
    score: scoreSearchableResult({ ...artifact, scope: "project" }, query, true) + freshnessScoreAdjustment(freshness.status),
    authority: {
      source: "repo_artifact",
      precedence: "repo_context",
      scope: "project",
      authorityLevel: normalizedMetadata.authorityLevel ?? "repo_context",
      allowedRoles: [...normalizedMetadata.retrievalRoles]
    },
    freshness,
    citation: {
      kind: "artifact",
      artifactId: artifact.id,
      label: artifact.title,
      sourcePath: artifact.sourcePath,
      sourceAnchor: artifact.sourceAnchor,
      canonicalRef: buildArtifactCanonicalCitationRef(artifact.id, artifact.sourcePath, artifact.sourceAnchor),
      runId: artifact.runId
    },
    provenance: {
      artifactKind: artifact.kind as ArtifactKind,
      runId: artifact.runId,
      createdAt: artifact.createdAt
    },
    metadata: buildSearchMemoryMetadata(normalizedMetadata, freshness.staleAfterDays),
    conflict: {
      detected: false,
      relatedIds: []
    }
  };
}

export function buildWorkflowDocumentSearchResult(
  document: Pick<WorkflowDocumentRecord, "id" | "title" | "body" | "kind" | "metadata" | "createdAt" | "runId" | "taskId">,
  query: string,
  projectSlug: string,
  now: string = new Date().toISOString()
): SearchMemoryResult {
  const normalizedMetadata = normalizeRetrievalMetadata({
    authorityLevel: "operational_context",
    ...document.metadata
  });
  const freshness = buildSearchMemoryFreshness(
    document.createdAt,
    now,
    normalizedMetadata.staleAfterDays ?? SEARCH_MEMORY_STALE_AFTER_DAYS
  );

  return {
    id: document.id,
    title: document.title,
    content: document.body,
    scope: "project",
    projectSlug,
    score:
      scoreSearchableResult(
        {
          title: document.title,
          content: document.body,
          scope: "project"
        },
        query,
        true
      ) + freshnessScoreAdjustment(freshness.status),
    authority: {
      source: "runtime_document",
      precedence: "runtime_context",
      scope: "project",
      authorityLevel: normalizedMetadata.authorityLevel ?? "operational_context",
      allowedRoles: [...normalizedMetadata.retrievalRoles]
    },
    freshness,
    citation: {
      kind: "workflow_document",
      documentId: document.id,
      label: document.title,
      canonicalRef: `workflow://document/${document.kind}/${document.id}`,
      runId: document.runId,
      taskId: document.taskId
    },
    provenance: {
      artifactKind: "workflow_document",
      runId: document.runId,
      taskId: document.taskId,
      createdAt: document.createdAt
    },
    metadata: buildSearchMemoryMetadata(normalizedMetadata, freshness.staleAfterDays),
    conflict: {
      detected: false,
      relatedIds: []
    }
  };
}

function buildCanonicalCitationRef(
  memoryId: string,
  sourcePath?: string | undefined,
  sourceAnchor?: string | undefined
): string {
  if (sourcePath) {
    return sourceAnchor ? `${sourcePath}#${sourceAnchor}` : sourcePath;
  }

  return sourceAnchor ? `memory://entry/${memoryId}#${sourceAnchor}` : `memory://entry/${memoryId}`;
}

function buildArtifactCanonicalCitationRef(
  artifactId: string,
  sourcePath: string,
  sourceAnchor?: string | undefined
): string {
  return sourceAnchor ? `${sourcePath}#${sourceAnchor}` : sourcePath || `artifact://entry/${artifactId}`;
}

function tokenizeSearchText(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

function scoreTermCoverage(haystackTerms: ReadonlySet<string>, queryTerms: readonly string[], weight: number): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  let hits = 0;
  for (const term of queryTerms) {
    if (haystackTerms.has(term)) {
      hits += 1;
    }
  }

  return (hits / queryTerms.length) * weight;
}

function buildSearchMemoryMetadata(
  metadata: ReturnType<typeof normalizeRetrievalMetadata>,
  staleAfterDays: number
): SearchMemoryMetadata {
  return {
    allowedRoles: [...metadata.retrievalRoles],
    tags: [...metadata.tags],
    reviewedAt: metadata.reviewedAt,
    staleAfterDays,
    supersededBy: [...metadata.supersededBy],
    contradicts: [...metadata.contradicts]
  };
}

function buildSearchMemoryFreshness(createdAt: string, now: string, staleAfterDays: number): SearchMemoryFreshness {
  const decision = assessFreshness(
    {
      createdAt,
      maxAgeDays: staleAfterDays
    },
    now
  );

  if (decision.status === "fresh" || decision.status === "stale") {
    return {
      status: decision.status,
      createdAt,
      ageDays: decision.ageDays,
      staleAfterDays
    };
  }

  if (decision.status === "future_timestamp") {
    return {
      status: "future_timestamp",
      createdAt,
      staleAfterDays
    };
  }

  return {
    status: "invalid_timestamp",
    createdAt,
    staleAfterDays
  };
}

function freshnessScoreAdjustment(status: SearchMemoryFreshness["status"]): number {
  if (status === "invalid_timestamp" || status === "future_timestamp") {
    return -2;
  }

  return 0;
}

function compareableFreshnessRank(status: SearchMemoryFreshness["status"]): number {
  if (status === "invalid_timestamp" || status === "future_timestamp") {
    return 0;
  }

  return 1;
}
