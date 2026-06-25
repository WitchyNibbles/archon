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
import {
  writeDaemonScopeExpansionRequest,
  writeDaemonContinuationContext,
  readDaemonContinuationContext,
  clearDaemonContinuationContext
} from "./state-writers.ts";
// Type-only back-reference to daemon.ts (erased at runtime — no value cycle).
import type {
  DaemonCommandResult,
  DaemonCycleRecord,
  ExecuteDaemonCommandOptions
} from "../daemon.ts";
import type { ContextBudgetMonitor } from "../runtime/context-budget.ts";
import type { ContextBudgetState } from "../runtime/context-budget.ts";
import { computeUsedPct, resolveModelContextTokens } from "../runtime/context-usage.ts";
import type { HandoffController } from "../runtime/handoff-controller.ts";
import type { ContinuationContextBuilder } from "../runtime/continuation-context.ts";

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

  // ---------------------------------------------------------------------------
  // Phase 2 (ahrP2ResetOnHandoff) — session-reset deps.
  // All optional: when absent, P2 reset logic is skipped (graceful degradation).
  // ---------------------------------------------------------------------------

  /** Controller for handoff record retrieval, recovery, and consumption.
   * Required for P2 reset; skipped when absent. */
  handoffController?: HandoffController | undefined;
  /** Builder for continuation bundles (wraps handoff packet into a prompt).
   * Required for P2 reset; skipped when absent. */
  continuationBuilder?: ContinuationContextBuilder | undefined;
  /** Role of the current invocation (e.g. "specialist_owner").
   * Used for crash-recovery packet creation; defaults to "unknown" when absent. */
  role?: string | undefined;
  /** Register the next invocation in the agentic loop store and return its ID.
   * Required for P2 reset handoff consumption; skipped when absent. */
  startNextInvocation?: (
    taskId: string,
    role: string
  ) => Promise<string>;
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

  // Phase 2 (ahrP2ResetOnHandoff): if getSessionId()===undefined AND
  // justHandedOff=true in metadata, this is a fresh respawned turn — use the
  // continuation bundle as the prompt and clear the flag.
  const archonDaemonMeta =
    projectRuntimeState?.metadata &&
    typeof projectRuntimeState.metadata === "object" &&
    !Array.isArray(projectRuntimeState.metadata)
      ? ((projectRuntimeState.metadata as Record<string, unknown>).archonDaemon as Record<string, unknown> | undefined)
      : undefined;
  const isJustHandedOff = archonDaemonMeta?.justHandedOff === true;
  const isFreshTurn = deps.getSessionId() === undefined && isJustHandedOff;

  let continuationBundle: string | undefined;
  if (isFreshTurn) {
    continuationBundle = await readDaemonContinuationContext(deps.cwd);
    if (continuationBundle !== undefined) {
      // Consume the file immediately — SEC-MED-2: deleted before the turn executes.
      await clearDaemonContinuationContext(deps.cwd);
    }
  }

  const prompt = continuationBundle ?? buildDaemonTaskPrompt({
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

  // Phase 1 (ahrP1Sampling) + Phase 2 (ahrP2ResetOnHandoff):
  //
  // In "observe" mode (default / ARCHON_CONTEXT_MONITOR unset or "observe"):
  //   - Sample fire-and-forget; any error is swallowed.
  //   - Never resets session. setSessionId from turn result as before.
  //
  // In "enforce" mode (ARCHON_CONTEXT_MONITOR=enforce):
  //   - Await recordSample; emit tagged stderr JSON on failure (non-fatal).
  //   - If resulting state is handoff_required or hard_stop, OR the current
  //     invocation already has a committed handoff → reset path.
  //   - Reset path: build continuation bundle, persist, start next invocation,
  //     consume handoff, save state with sessionId=undefined + justHandedOff=true,
  //     early return to respawn a fresh claude -p in the next loop iteration.
  //
  // ARCH-C1: gate is on process.env.ARCHON_CONTEXT_MONITOR directly — NOT on
  // monitor state — because context-budget.ts:159-161 downgrades
  // handoff_required→warning in observe mode but NOT hard_stop, so hard_stop
  // would otherwise reset in observe mode.
  const isEnforceMode = process.env.ARCHON_CONTEXT_MONITOR === "enforce";

  let sampledState: ContextBudgetState | undefined;
  if (deps.invocationId !== undefined && deps.monitor !== undefined && codexTurn.usage !== undefined) {
    const contextWindowTokens = resolveModelContextTokens(deps.env);
    const usedPct = computeUsedPct(codexTurn.usage, contextWindowTokens);
    if (usedPct !== undefined) {
      if (isEnforceMode) {
        // Await in enforce mode so we can react to the returned state and emit
        // stderr on failure (SEC-MED-2).
        try {
          sampledState = await deps.monitor.recordSample(
            deps.invocationId,
            input.activeRunId,
            input.activeTaskId,
            "sdk",
            usedPct,
            { usage: codexTurn.usage }
          );
        } catch (err: unknown) {
          // SEC-MED-2: non-fatal but tagged stderr for observability.
          process.stderr.write(
            JSON.stringify({
              tag: "archon-context-monitor",
              event: "recordSample_failure",
              invocationId: deps.invocationId,
              runId: input.activeRunId,
              taskId: input.activeTaskId,
              error: err instanceof Error ? err.message : String(err)
            }) + "\n"
          );
          // sampledState stays undefined — no reset on DB failure.
        }
      } else {
        // Observe mode: fire-and-forget (P1 contract preserved).
        deps.monitor.recordSample(
          deps.invocationId,
          input.activeRunId,
          input.activeTaskId,
          "sdk",
          usedPct,
          { usage: codexTurn.usage }
        ).catch((_err: unknown) => {
          // Intentional: sampling failure is non-fatal. Error swallowed so
          // the daemon turn result is unaffected.
        });
      }
    }
  }

  // Phase 2 reset decision (enforce mode only — ARCH-C1).
  if (
    isEnforceMode &&
    deps.handoffController !== undefined &&
    deps.continuationBuilder !== undefined &&
    deps.startNextInvocation !== undefined &&
    deps.invocationId !== undefined
  ) {
    // Check if state threshold crossed OR there is already a committed handoff.
    const stateRequiresReset =
      sampledState === "handoff_required" || sampledState === "hard_stop";

    // hasCommittedHandoff check: HandoffStoreLike does not expose this directly
    // from HandoffController, but we may have a handoff record waiting (already
    // committed by the agent). Use getLatestForTask as a proxy — if a record
    // exists AND status is handoff_written/needs_followup → committed.
    // The simpler signal: if state requires reset, we reset; OR if the store
    // has an unconsumed handoff record (committed before this sample).
    let existingHandoff = await deps.handoffController.getLatestForTask(
      input.activeRunId,
      input.activeTaskId
    );

    // Additional committed-handoff check via the store's hasCommittedHandoff if
    // available (exposed via HandoffStoreLike extension in tests).
    let committedHandoff = false;
    const storeAny = (deps.handoffController as unknown as { store?: { hasCommittedHandoff?: (id: string) => Promise<boolean> } }).store;
    if (storeAny?.hasCommittedHandoff !== undefined) {
      committedHandoff = await storeAny.hasCommittedHandoff(deps.invocationId);
    }

    const shouldReset = stateRequiresReset || committedHandoff;

    if (shouldReset) {
      // Packet quality check: if no record or summary < 10 chars or no nextActions
      // → recoverCrashedInvocation.
      const packetRaw = existingHandoff?.packet as (Record<string, unknown> | undefined);
      const summaryOk =
        typeof packetRaw?.summary === "string" && (packetRaw.summary as string).length >= 10;
      const actionsOk =
        Array.isArray(packetRaw?.nextActions) && (packetRaw.nextActions as unknown[]).length > 0;
      const packetQualityOk = existingHandoff !== undefined && summaryOk && actionsOk;

      if (!packetQualityOk) {
        // Crash-recovery path: synthesize a recovery handoff.
        const contextWindowTokens = resolveModelContextTokens(deps.env);
        const usedPct =
          codexTurn.usage !== undefined
            ? computeUsedPct(codexTurn.usage, contextWindowTokens)
            : undefined;
        const recovered = await deps.handoffController.recoverCrashedInvocation({
          invocationId: deps.invocationId,
          runId: input.activeRunId,
          taskId: input.activeTaskId,
          role: deps.role ?? "unknown",
          contextUsedPct: usedPct,
          evidenceRefs: []
        });
        existingHandoff = recovered.record;
      }

      if (existingHandoff !== undefined) {
        // Build continuation bundle — handoff content is sanitized in buildContinuationPrompt.
        // Use handoffController directly for the prompt (sanitization applied there).
        const bundle = deps.handoffController.buildContinuationPrompt(existingHandoff);

        // Persist the bundle so the fresh turn can pick it up.
        await writeDaemonContinuationContext(deps.cwd, bundle);

        // Start the next invocation record before consuming the handoff.
        const nextInvocationId = await deps.startNextInvocation(
          input.activeTaskId,
          deps.role ?? "unknown"
        );

        // Consume the handoff (links it to the next invocation).
        await deps.handoffController.consume({
          handoffId: existingHandoff.id,
          toInvocationId: nextInvocationId,
          runId: input.activeRunId,
          taskId: input.activeTaskId
        });

        // ARCH-C3: set sessionId=undefined AND justHandedOff=true in the SAME
        // saveProjectRuntimeState write. This is an early-return write — the
        // normal saveProjectRuntimeState below will NOT execute.
        deps.setSessionId(undefined);
        await deps.saveProjectRuntimeState({
          projectId: projectRuntimeState?.projectId ?? projectContext.project.id,
          workspaceId: projectRuntimeState?.workspaceId ?? projectContext.workspace.id,
          activeRunId: projectRuntimeState?.activeRunId,
          activeTaskId: projectRuntimeState?.activeTaskId,
          taskQueue: projectRuntimeState?.taskQueue ?? buildDefaultTaskQueue(),
          productState: projectRuntimeState?.productState ?? buildDefaultProductState(),
          lastVerifiedRunId: projectRuntimeState?.lastVerifiedRunId,
          metadata: {
            ...(projectRuntimeState?.metadata ?? {}),
            archonDaemon: {
              ...(archonDaemonMeta ?? {}),
              sessionId: undefined,
              justHandedOff: true,
              lastRunId: input.activeRunId,
              lastTaskId: input.activeTaskId,
              lastDirectiveKind: input.directive.kind,
              updatedAt: deps.now().toISOString()
            }
          },
          createdAt: projectRuntimeState?.createdAt ?? deps.now().toISOString(),
          updatedAt: deps.now().toISOString()
        });

        cycles.push({
          cycle,
          directiveKind: input.directive.kind,
          action: "handoff_reset",
          runId: input.activeRunId,
          taskId: input.activeTaskId,
          sessionId: null,
          summary: `Context reset: handoff ${existingHandoff.id} consumed → next invocation ${nextInvocationId}`
        });

        // Early return: the next loop iteration will spawn a fresh claude -p
        // (sessionId is now undefined, so runCodexTurn will not --resume).
        return undefined;
      }
    }
  }

  // Non-reset path: update session id from turn result (P1 contract preserved).
  deps.setSessionId(codexTurn.sessionId ?? deps.getSessionId());

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
        // Phase 2 (ahrP2ResetOnHandoff): clear justHandedOff flag after the
        // fresh continuation turn completes. The flag is consumed here.
        justHandedOff: false,
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
