// Daemon split (loop-monolith decomposition, 6h): the codex-turn runner, lifted
// out of executeDaemonCommandFromArgs.
//
// runDaemonCodexTurn used to be a ~200-line nested closure inside the daemon
// loop. It is now a module-level function taking per-cycle inputs plus an
// explicit dependency bag. The loop keeps a thin wrapper closure that supplies
// the deps, so both call sites (the operator-continuation handler and the
// fallthrough turn) stay unchanged and behavior-preserving.
//
// The subtle trap: this function READS and WRITES the loop's latestSessionId
// (codexTurn.sessionId feeds back into the next turn for session continuity).
// Pass-by-value would silently break that continuity, so the loop's session id
// is threaded as a holder/ref via `getSessionId` (live read) + `setSessionId`
// (live write) — never a captured snapshot.
import type { ProjectRuntimeStateRecord, RunExecutionPlan } from "../domain/types.ts";
import { buildDefaultProductState, buildDefaultTaskQueue } from "../workflow.ts";
import type { EnvShape } from "../workflow.ts";
import type { ReconcileRuntimeStateCommandResult } from "../runtime.ts";
import {
  buildDaemonProgressKey,
  buildDaemonTaskPacketFingerprint,
  buildDaemonTaskPrompt,
  determineDaemonPromptMode,
  parseDaemonTurnMessage,
  persistDaemonTurnCheckpoint,
  readDaemonPromptMetadata,
  readDaemonStagnationMetadata
} from "./turn-prompt.ts";
import type { RunCodexTurnInput, RunCodexTurnResult } from "./turn-prompt.ts";
import {
  computeDaemonStagnantTurnCount,
  evaluateDaemonNoProgressOutcome
} from "./turn-analysis.ts";
import { writeDaemonScopeExpansionRequest } from "./state-writers.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type {
  DaemonCommandResult,
  DaemonCycleRecord,
  ExecuteDaemonCommandOptions
} from "../daemon.ts";
import type { ContextBudgetMonitor } from "../runtime/context-budget.ts";
import { computeUsedPct, resolveModelContextTokens } from "../runtime/context-usage.ts";

/**
 * Input to the loop's blockedResult builder. Single source of truth shared by
 * the codex-turn runner and the operator-continuation handler.
 */
export interface DaemonBlockedResultInput {
  blockerKind:
    | "bootstrapping"
    | "runtime_preflight"
    | "missing_active_runtime"
    | "review_queue"
    | "review_execution_unsupported"
    | "operator_required_continuation"
    | "workflow_proof_failure"
    | "scope_expansion_required"
    | "runtime_blocked"
    | "recovery_required"
    | "runtime_task_missing"
    | "active_task_mismatch"
    | "uncommitted_deliverables";
  reason: string;
  cycle: number;
  activeRunId: string | null;
  activeTaskId: string | null;
  directiveKind?: RunExecutionPlan["directive"]["kind"] | undefined;
  nextActions?: string[] | undefined;
  detailFiles?:
    | {
        continuationStatus?: string | undefined;
        reviewQueueStatus?: string | undefined;
        scopeExpansionRequest?: string | undefined;
        // operator-continuation spreads this in when an automation envelope is
        // written; the runtime sink (writeDaemonOperatorHandoff) accepts it.
        automationEnvelope?: string | undefined;
      }
    | undefined;
}

export type DaemonBlockedResultBuilder = (
  input: DaemonBlockedResultInput
) => Promise<DaemonCommandResult>;

export type DaemonCodexTurnRunner = (input: DaemonCodexTurnInput) => Promise<DaemonCommandResult | undefined>;

/** Project context resolved by the loop for the active cycle. */
export type DaemonProjectContext = NonNullable<
  Awaited<ReturnType<ExecuteDaemonCommandOptions["getProjectContext"]>>
>;

export interface DaemonCodexTurnInput {
  directive: RunExecutionPlan["directive"];
  summaryAction: "run_codex_owner" | "run_codex_analysis";
  activeRunId: string;
  activeTaskId: string;
  operatorNotes?: string | undefined;
}

/** Per-cycle plus per-invocation dependencies the runner needs from the loop. */
export interface DaemonCodexTurnDeps {
  /** The loop's current cycle number. */
  cycle: number;
  /** Project context resolved for this cycle. */
  projectContext: DaemonProjectContext;
  /** Runtime state read at the top of this cycle (pre-turn snapshot). */
  projectRuntimeState: ProjectRuntimeStateRecord | undefined;
  /** Reconcile callback (closes over the loop's cycle accumulator). */
  attemptRuntimeReconcile: (cycle: number) => Promise<ReconcileRuntimeStateCommandResult | undefined>;
  /** The loop's cycle accumulator; mutated by push (ref-safe). */
  cycles: DaemonCycleRecord[];
  blockedResult: DaemonBlockedResultBuilder;
  /** Live read of the loop's latestSessionId (holder/ref, not a snapshot). */
  getSessionId: () => string | undefined;
  /** Live write of the loop's latestSessionId so session continuity survives. */
  setSessionId: (sessionId: string | undefined) => void;
  claudeBin: string;
  cwd: string;
  env: EnvShape;
  now: () => Date;
  staleAfterHours: number;
  runCodexTurn: (input: RunCodexTurnInput) => Promise<RunCodexTurnResult>;
  getStatusSnapshot: ExecuteDaemonCommandOptions["getStatusSnapshot"];
  getProjectRuntimeState: ExecuteDaemonCommandOptions["getProjectRuntimeState"];
  getExecutionPlan: ExecuteDaemonCommandOptions["getExecutionPlan"];
  saveProjectRuntimeState: ExecuteDaemonCommandOptions["saveProjectRuntimeState"];
  // Optional: when absent, persistDaemonTurnCheckpoint no-ops (no checkpoint).
  checkpointRun?: ExecuteDaemonCommandOptions["checkpointRun"];
  /** Invocation ID for this codex turn (from AgenticLoopController.startInvocation).
   * When absent, context sampling is skipped (graceful degradation). */
  invocationId?: string | undefined;
  /** Context budget monitor. When absent or when invocationId is absent,
   * sampling is skipped — observe-only, never throws. */
  monitor?: ContextBudgetMonitor | undefined;
}

/**
 * Runs a single codex turn for the active task: builds the prompt, invokes the
 * codex CLI, persists the turn checkpoint, recomputes progress/stagnation, and
 * writes the refreshed runtime state. Returns a blocked result when the turn
 * cannot proceed or stalls, or `undefined` when the loop should continue.
 */
export async function runDaemonCodexTurn(
  input: DaemonCodexTurnInput,
  deps: DaemonCodexTurnDeps
): Promise<DaemonCommandResult | undefined> {
  const { cycle, projectContext, projectRuntimeState, cycles } = deps;

  const snapshot = await deps.getStatusSnapshot(input.activeRunId);
  const taskRecord = snapshot.tasks.find((task) => task.packet.taskId === input.activeTaskId);
  if (!taskRecord) {
    const reconciled = await deps.attemptRuntimeReconcile(cycle);
    if (reconciled?.runtimeStateChanged) {
      return undefined;
    }
    cycles.push({
      cycle,
      directiveKind: input.directive.kind,
      action: "blocked",
      runId: input.activeRunId,
      taskId: input.activeTaskId,
      sessionId: deps.getSessionId() ?? null,
      summary: "active runtime task is missing from the run snapshot"
    });

    return deps.blockedResult({
      blockerKind: "runtime_task_missing",
      reason: "active runtime task is missing from the run snapshot",
      cycle,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      directiveKind: input.directive.kind,
      nextActions: [
        "inspect `npm run archon:status -- --format json` to confirm the runtime task snapshot",
        "run `npm run archon:reconcile` to repair safe runtime/local task drift before retrying the daemon"
      ]
    });
  }
  const beforeProgressKey = buildDaemonProgressKey({
    runtimeState: projectRuntimeState,
    snapshot,
    directive: input.directive,
    activeTaskId: input.activeTaskId
  });
  const promptMetadata = readDaemonPromptMetadata(projectRuntimeState?.metadata);
  const packetFingerprint = buildDaemonTaskPacketFingerprint(taskRecord.packet);
  const promptMode = determineDaemonPromptMode({
    sessionId: deps.getSessionId(),
    previousTaskId: promptMetadata?.taskId,
    previousPacketFingerprint: promptMetadata?.packetFingerprint,
    taskId: input.activeTaskId,
    packetFingerprint
  });
  const latestCheckpoint = snapshot.autonomousExecution?.state.checkpoints.at(-1);

  const prompt = buildDaemonTaskPrompt({
    promptMode,
    directive: input.directive,
    taskId: input.activeTaskId,
    packet: taskRecord.packet,
    operatorNotes: input.operatorNotes,
    compressedContextSummary:
      promptMode === "delta"
        ? latestCheckpoint?.compressedContextSummary
        : undefined,
    compressedContextRef:
      promptMode === "delta"
        ? latestCheckpoint?.compressedContextRef
        : undefined
  });
  const codexTurn = await deps.runCodexTurn({
    claudeBin: deps.claudeBin,
    cwd: deps.cwd,
    env: deps.env,
    prompt,
    sessionId: deps.getSessionId()
  });

  deps.setSessionId(codexTurn.sessionId ?? deps.getSessionId());

  // Phase 1 (ahrP1Sampling): sample context usage from the turn's token report.
  // Observe-only — never throws, never resets/respawns. Sampling is best-effort:
  // missing invocationId, missing monitor, missing usage, or zero window → skip.
  if (deps.invocationId !== undefined && deps.monitor !== undefined && codexTurn.usage !== undefined) {
    const contextWindowTokens = resolveModelContextTokens(deps.env);
    const usedPct = computeUsedPct(codexTurn.usage, contextWindowTokens);
    if (usedPct !== undefined) {
      // Fire-and-forget with best-effort error suppression: a DB write failure
      // must not abort the turn that the operator is waiting for.
      deps.monitor.recordSample(
        deps.invocationId,
        input.activeRunId,
        input.activeTaskId,
        "sdk",
        usedPct,
        { usage: codexTurn.usage }
      ).catch((_err: unknown) => {
        // Intentional: sampling failure is non-fatal. The error is swallowed so
        // the daemon turn result is unaffected. In production, the ContextBudget-
        // Monitor's caller (archon-stop hook) will detect the missing sample and
        // degrade gracefully.
      });
    }
  }

  const parsedTurnMessage = parseDaemonTurnMessage(codexTurn.finalMessage);
  await persistDaemonTurnCheckpoint({
    runId: input.activeRunId,
    taskId: input.activeTaskId,
    snapshot,
    message: parsedTurnMessage,
    checkpointRun: deps.checkpointRun,
    now: deps.now
  });
  const refreshedProjectRuntimeState = await deps.getProjectRuntimeState(projectContext.project.id);
  const refreshedSnapshot = await deps.getStatusSnapshot(input.activeRunId);
  const refreshedPlan = await deps.getExecutionPlan(input.activeRunId, deps.staleAfterHours);
  const afterProgressKey = buildDaemonProgressKey({
    runtimeState: refreshedProjectRuntimeState,
    snapshot: refreshedSnapshot,
    directive: refreshedPlan.directive,
    activeTaskId: input.activeTaskId
  });
  const noProgress = beforeProgressKey === afterProgressKey;
  const priorStagnation = readDaemonStagnationMetadata(projectRuntimeState?.metadata);
  const stagnantTurnCount = computeDaemonStagnantTurnCount({
    noProgress,
    priorStagnation,
    runId: input.activeRunId,
    taskId: input.activeTaskId,
    directiveKind: input.directive.kind,
    progressKey: beforeProgressKey
  });
  await deps.saveProjectRuntimeState({
    projectId: refreshedProjectRuntimeState?.projectId ?? projectRuntimeState?.projectId ?? projectContext.project.id,
    workspaceId: refreshedProjectRuntimeState?.workspaceId ?? projectRuntimeState?.workspaceId ?? projectContext.workspace.id,
    activeRunId: refreshedProjectRuntimeState?.activeRunId,
    activeTaskId: refreshedProjectRuntimeState?.activeTaskId,
    taskQueue: refreshedProjectRuntimeState?.taskQueue ?? projectRuntimeState?.taskQueue ?? buildDefaultTaskQueue(),
    productState: refreshedProjectRuntimeState?.productState ?? projectRuntimeState?.productState ?? buildDefaultProductState(),
    lastVerifiedRunId: refreshedProjectRuntimeState?.lastVerifiedRunId ?? projectRuntimeState?.lastVerifiedRunId,
    metadata: {
      ...(refreshedProjectRuntimeState?.metadata ?? projectRuntimeState?.metadata ?? {}),
      archonDaemon: {
        sessionId: deps.getSessionId(),
        lastRunId: input.activeRunId,
        lastTaskId: input.activeTaskId,
        lastDirectiveKind: input.directive.kind,
        lastPromptTaskId: input.activeTaskId,
        lastPromptPacketFingerprint: packetFingerprint,
        lastPromptMode: promptMode,
        ...(noProgress
          ? {
              stagnation: {
                runId: input.activeRunId,
                taskId: input.activeTaskId,
                directiveKind: input.directive.kind,
                progressKey: beforeProgressKey,
                count: stagnantTurnCount,
                updatedAt: deps.now().toISOString(),
                lastStatus: parsedTurnMessage?.status,
                lastSummary: parsedTurnMessage?.summary,
                lastBlockers: parsedTurnMessage?.blockers
              }
            }
          : {}),
        updatedAt: deps.now().toISOString()
      }
    },
    createdAt: refreshedProjectRuntimeState?.createdAt ?? projectRuntimeState?.createdAt ?? deps.now().toISOString(),
    updatedAt: deps.now().toISOString()
  });

  cycles.push({
    cycle,
    directiveKind: input.directive.kind,
    action: input.summaryAction,
    runId: input.activeRunId,
    taskId: input.activeTaskId,
    sessionId: deps.getSessionId() ?? null,
    summary: parsedTurnMessage?.summary || codexTurn.finalMessage?.slice(0, 160) || "codex turn executed"
  });

  const noProgressOutcome = evaluateDaemonNoProgressOutcome({
    noProgress,
    parsedTurnMessage,
    stagnantTurnCount,
    activeTaskId: input.activeTaskId
  });
  if (noProgressOutcome.shouldBlock) {
    let scopeExpansionRequestPath: string | undefined;
    if (noProgressOutcome.scopeExpansion) {
      scopeExpansionRequestPath = await writeDaemonScopeExpansionRequest(deps.cwd, {
        runId: input.activeRunId,
        taskId: input.activeTaskId,
        directiveKind: input.directive.kind,
        blockedPaths: noProgressOutcome.scopeExpansion.blockedPaths,
        requestedWriteScope: noProgressOutcome.scopeExpansion.requestedWriteScope,
        reason: noProgressOutcome.scopeExpansion.reason,
        updatedAt: deps.now().toISOString()
      });
    }
    cycles.push({
      cycle,
      directiveKind: input.directive.kind,
      action: noProgressOutcome.cycleAction,
      runId: input.activeRunId,
      taskId: input.activeTaskId,
      sessionId: deps.getSessionId() ?? null,
      summary: noProgressOutcome.reason
    });

    return deps.blockedResult({
      blockerKind: noProgressOutcome.blockerKind,
      reason: noProgressOutcome.reason,
      cycle,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      directiveKind: input.directive.kind,
      nextActions: noProgressOutcome.nextActions,
      detailFiles: scopeExpansionRequestPath
        ? {
            scopeExpansionRequest: scopeExpansionRequestPath
          }
        : undefined
    });
  }

  return undefined;
}
