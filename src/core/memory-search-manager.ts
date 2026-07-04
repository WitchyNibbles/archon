// Memory-promotion, memory-search, and runtime-trace-registry manager.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4).
// This is slice 4 of the ArchonCoreService decomposition and owns the memory/
// search cluster (plan seam S6): promoteMemory, searchMemory, and
// getRuntimeTraceRegistry.
//
// TRUST BOUNDARY (unchanged by the extraction): promoteMemory still requires a
// sealed, WeakSet-registered TrustedReviewActionContext from the injected
// resolver — the P0 trust gate (isTrustedReviewActionContext) is enforced HERE,
// not bypassed. authorityLevel on the stored entry is always "reviewed_memory"
// regardless of caller input, and reviewer/actor always come from the resolver
// context, never from the caller. recordReview (still on ArchonCoreService) binds
// its distillation hook to the class delegate `promoteMemory`, so the same gate
// runs on the autonomous distillation path.
//
// CLOSURE WIRING: getRuntimeTraceRegistry depends on `getStatus`, injected as
// `(runId) => this.statusPlanner.getStatus(runId)` by the owning class. Its exact
// error semantics are preserved — it reads `snapshot.autonomousExecution?.state`
// and throws "runtime trace registry requires autonomous execution state" when
// that guarded field is undefined (the guard lives in StatusExecutionPlanner.
// getStatus; see the ENABLED-GATING NOTE there). No import cycle forms: this
// module imports only leaf helpers (contracts, policy, project-runtime-state,
// search-memory-results, review-context, runtime-trace-registry) and domain
// types — never service.ts or status-execution-planner.ts.

import { randomUUID } from "node:crypto";
import {
  normalizeRetrievalMetadata,
  normalizeSearchInput,
  validateMemoryPromotion
} from "../domain/contracts.ts";
import { canRoleAccessSearchResult } from "./policy.ts";
import { timestamp } from "./project-runtime-state.ts";
import { annotateConflictSignals, isProvenancedSearchResult } from "./search-memory-results.ts";
import { isTrustedReviewActionContext } from "./review-context.ts";
import type { ResolveReviewActionContext } from "./review-context.ts";
import { buildRuntimeTraceRegistry } from "../runtime/runtime-trace-registry.ts";
import type { ArchonStore } from "../store/types.ts";
import type {
  MemoryPromotionInput,
  RunRecord,
  RunStatusSnapshot,
  RuntimeTraceRegistrySummary,
  SearchMemoryInput,
  SearchMemoryResult
} from "../domain/types.ts";

export interface MemorySearchManagerDeps {
  store: ArchonStore;
  requireRun: (runId: string) => Promise<RunRecord>;
  getStatus: (runId: string) => Promise<RunStatusSnapshot>;
  bumpRunState: (runId: string, status: RunRecord["status"]) => Promise<unknown>;
  resolveReviewActionContext?: ResolveReviewActionContext | undefined;
}

export class MemorySearchManager {
  private readonly store: ArchonStore;
  private readonly requireRun: (runId: string) => Promise<RunRecord>;
  private readonly getStatus: (runId: string) => Promise<RunStatusSnapshot>;
  private readonly bumpRunState: (runId: string, status: RunRecord["status"]) => Promise<unknown>;
  private readonly resolveReviewActionContext?: ResolveReviewActionContext | undefined;

  constructor(deps: MemorySearchManagerDeps) {
    this.store = deps.store;
    this.requireRun = deps.requireRun;
    this.getStatus = deps.getStatus;
    this.bumpRunState = deps.bumpRunState;
    this.resolveReviewActionContext = deps.resolveReviewActionContext;
  }

  async promoteMemory(runId: string, input: MemoryPromotionInput) {
    if (!this.resolveReviewActionContext) {
      throw new Error("promoteMemory requires a trusted promotion context resolver");
    }

    const run = await this.requireRun(runId);
    const errors = validateMemoryPromotion(input);
    if (errors.length > 0) {
      throw new Error(`Memory promotion rejected: ${errors.join("; ")}`);
    }

    let context;
    try {
      context = await this.resolveReviewActionContext({
        runId,
        taskId: input.sourceTaskId ?? "",
        actor: input.actor,
        reviewerRole: "reviewer",
        reviewState: "passed"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Memory promotion rejected: invalid promotion context: ${message}`);
    }

    // FINDING 1: mirror recordReview's trust gate — the resolver must return a
    // WeakSet-registered TrustedReviewActionContext.  A plain unsealed object
    // returned by a malicious or misconfigured resolver must be rejected here.
    if (!isTrustedReviewActionContext(context)) {
      throw new Error(
        "Memory promotion rejected: promotion context must be a sealed trusted review action context"
      );
    }

    const createdAt = timestamp();
    // FINDING 2: authorityLevel is always "reviewed_memory" for promoted
    // memory entries regardless of caller input — strip any caller-supplied
    // value before passing through normalizeRetrievalMetadata.
    const { authorityLevel: _discardedAuthorityLevel, ...callerMetadata } = input.metadata ?? {};
    const metadata = normalizeRetrievalMetadata({
      ...callerMetadata,
      reviewedAt: callerMetadata.reviewedAt ?? createdAt,
      authorityLevel: "reviewed_memory"
    });

    const entry = {
      id: randomUUID(),
      workspaceId: run.workspaceId,
      projectId: input.scope === "project" ? run.projectId : undefined,
      runId,
      taskId: input.sourceTaskId,
      scope: input.scope,
      entryType: input.entryType,
      title: input.title,
      content: input.content,
      // NON-BLOCKING (by design): input.reviewer and input.actor are silently
      // discarded here — the stored values always come from the trusted resolver
      // context.  Callers should not rely on those input fields being stored.
      // Follow-up: mistake-pattern-ledger.md tracks this as a pattern to
      // address in a future MemoryPromotionInput type revision.
      reviewer: context.actor,
      actor: context.actor,
      status: "approved" as const,
      metadata,
      createdAt
    };

    await this.store.saveMemoryEntry(entry);
    await this.bumpRunState(runId, "memorized");
    return entry;
  }

  async searchMemory(input: SearchMemoryInput): Promise<SearchMemoryResult[]> {
    const normalized = normalizeSearchInput(input);
    const results = await this.store.searchMemory({
      workspaceSlug: normalized.workspaceSlug,
      projectSlug: normalized.projectSlug,
      query: normalized.query,
      limit: normalized.limit,
      includeGlobal: normalized.includeGlobal,
      queryEmbedding: normalized.queryEmbedding,
      embeddingModel: normalized.embeddingModel,
      requesterRole: normalized.requesterRole
    });

    return annotateConflictSignals(
      results
        .filter((result) => canRoleAccessSearchResult(result, normalized.requesterRole))
        .filter(isProvenancedSearchResult)
    );
  }

  async getRuntimeTraceRegistry(runId: string): Promise<RuntimeTraceRegistrySummary> {
    const snapshot = await this.getStatus(runId);
    const state = snapshot.autonomousExecution?.state;
    if (!state) {
      throw new Error("runtime trace registry requires autonomous execution state");
    }

    return buildRuntimeTraceRegistry(state);
  }
}
