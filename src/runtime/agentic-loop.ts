// Agentic Loop Controller — Phase 6 of the Archon Agentic Loop Runtime.
//
// A state machine coordinator for the agent lifecycle.  This class does NOT
// invoke Claude; callers and tests drive it by feeding events.  It coordinates
// context budget monitoring, handoff state, and cycle safety stops.
//
// All public methods return new objects; no in-place mutation.

import { ContextBudgetMonitor, defaultArchonContextPolicy } from "./context-budget.ts";
import type { ContextBudgetState, ContextBudgetStoreLike } from "./context-budget.ts";
import type { ContextPolicy } from "../domain/types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal summary of a task that the loop can act on. */
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
}

/**
 * The action the loop should take after a context sample.
 *
 * - "continue"          — still within safe operating range
 * - "warn"              — approaching limit; surface warning
 * - "handoff_required"  — cross handoff threshold; agent must commit handoff
 * - "hard_stop"         — cross hard-stop; deny all non-safe tool calls
 */
export type LoopAction = "continue" | "warn" | "handoff_required" | "hard_stop";

/** Snapshot of the current loop state returned by getLoopStatus(). */
export interface LoopStatus {
  runId: string;
  activeTask: TaskSummary | null;
  activeInvocation: string | null;
  contextState: ContextBudgetState;
  handoffsPending: number;
  cycleCount: number;
}

// ---------------------------------------------------------------------------
// LoopConfig
// ---------------------------------------------------------------------------

export interface LoopConfig {
  /** Run identifier this loop controls. */
  runId: string;
  /** Context thresholds; defaults to defaultArchonContextPolicy when omitted. */
  contextPolicy?: Partial<Pick<ContextPolicy, "handoffPct" | "warningPct" | "hardStopPct">>;
  /** Safety ceiling on total loop cycles.  Throws when exceeded. */
  maxCycles?: number;
}

// ---------------------------------------------------------------------------
// AgenticLoopStoreLike — injected store adapter (no direct DB dependency)
// ---------------------------------------------------------------------------

export interface AgenticLoopStoreLike extends ContextBudgetStoreLike {
  /**
   * Return the next task that is ready to execute for this run, or null when
   * no unblocked tasks remain.
   */
  getNextTask(runId: string): Promise<TaskSummary | null>;

  /**
   * Create an invocation record with status "running".
   * Returns the new invocationId.
   */
  createInvocation(data: {
    runId: string;
    taskId: string;
    role: string;
    startedAt: string;
  }): Promise<string>;

  /**
   * Update the status of an existing invocation record.
   */
  updateInvocationStatus(
    invocationId: string,
    status: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Return the current status string of an invocation, or undefined if unknown.
   */
  getInvocationStatus(invocationId: string): Promise<string | undefined>;

  /**
   * Return the currently active task for a run, or null if none.
   * The loop uses this for getLoopStatus().
   */
  getActiveTask(runId: string): Promise<TaskSummary | null>;

  /**
   * Return the currently active invocation ID for a run, or null if none.
   */
  getActiveInvocation(runId: string): Promise<string | null>;

  /**
   * Count pending (uncommitted) handoffs for a run.
   */
  countPendingHandoffs(runId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// AgenticLoopController
// ---------------------------------------------------------------------------

export class AgenticLoopController {
  private readonly store: AgenticLoopStoreLike;
  private readonly config: Readonly<Required<LoopConfig>>;
  private readonly contextMonitor: ContextBudgetMonitor;

  // Per-run cycle counters (in-memory; reset across process restarts).
  private readonly cycleCounts = new Map<string, number>();

  // Per-invocation latest context state (in-memory cache).
  private readonly contextStateCache = new Map<string, ContextBudgetState>();

  constructor(store: AgenticLoopStoreLike, config: LoopConfig) {
    this.store = store;
    this.config = {
      runId: config.runId,
      contextPolicy: config.contextPolicy ?? {},
      maxCycles: config.maxCycles ?? 1000
    };

    const policy = {
      handoffPct: config.contextPolicy?.handoffPct ?? defaultArchonContextPolicy.handoffPct,
      warningPct: config.contextPolicy?.warningPct ?? defaultArchonContextPolicy.warningPct,
      hardStopPct: config.contextPolicy?.hardStopPct ?? defaultArchonContextPolicy.hardStopPct
    };

    this.contextMonitor = new ContextBudgetMonitor(store, policy);
  }

  // ---------------------------------------------------------------------------
  // selectNextTask — return next unblocked task, or null
  // ---------------------------------------------------------------------------

  /**
   * Return the next task ready to execute for this loop's run, or null when the
   * queue is exhausted or all remaining tasks are blocked.
   *
   * I/O contract:
   *   Input:  none (uses config.runId)
   *   Output: TaskSummary | null
   *   Side effects: none
   */
  async selectNextTask(): Promise<TaskSummary | null> {
    return this.store.getNextTask(this.config.runId);
  }

  // ---------------------------------------------------------------------------
  // startInvocation — create and register an invocation with "running" status
  // ---------------------------------------------------------------------------

  /**
   * Create a new invocation record for the given task and role, increment the
   * cycle counter, and return the new invocationId.
   *
   * Throws if maxCycles has been reached to prevent infinite loops.
   *
   * I/O contract:
   *   Input:  taskId (string), role (string)
   *   Output: invocationId (string)
   *   Side effects:
   *     - INSERT into invocations with status="running"
   *     - increments cycle count for config.runId
   */
  async startInvocation(taskId: string, role: string): Promise<string> {
    const runId = this.config.runId;
    const currentCycles = this.cycleCounts.get(runId) ?? 0;

    if (currentCycles >= this.config.maxCycles) {
      throw new Error(
        `agentic_loop: maxCycles (${this.config.maxCycles}) reached for run '${runId}'; ` +
          `loop safety stop triggered.`
      );
    }

    const invocationId = await this.store.createInvocation({
      runId,
      taskId,
      role,
      startedAt: new Date().toISOString()
    });

    this.cycleCounts.set(runId, currentCycles + 1);

    return invocationId;
  }

  // ---------------------------------------------------------------------------
  // onContextSample — evaluate context usage and return LoopAction
  // ---------------------------------------------------------------------------

  /**
   * Record a context usage sample and return the action the loop should take.
   *
   * Maps ContextBudgetState → LoopAction:
   *   normal           → "continue"
   *   warning          → "warn"
   *   handoff_required → "handoff_required"
   *   hard_stop        → "hard_stop"
   *
   * I/O contract:
   *   Input:  invocationId (string), usedPct (number 0-100)
   *   Output: LoopAction
   *   Side effects:
   *     - persists context sample via store
   *     - updates in-memory context state cache
   */
  async onContextSample(invocationId: string, usedPct: number): Promise<LoopAction> {
    const runId = this.config.runId;

    // Derive taskId from the store for the sample record.  We use a sentinel
    // value when the invocation is not found so we don't throw — the monitor
    // still records and transitions correctly.
    const taskId = runId;

    const newState = await this.contextMonitor.recordSample(
      invocationId,
      runId,
      taskId,
      "sdk",
      usedPct
    );

    this.contextStateCache.set(invocationId, newState);

    return stateToLoopAction(newState);
  }

  // ---------------------------------------------------------------------------
  // onTaskComplete — mark invocation and task as completed
  // ---------------------------------------------------------------------------

  /**
   * Transition the given invocation to "completed" status.
   *
   * I/O contract:
   *   Input:  invocationId (string), taskId (string)
   *   Output: void
   *   Side effects:
   *     - UPDATE invocation status → "completed"
   */
  async onTaskComplete(invocationId: string, taskId: string): Promise<void> {
    await this.store.updateInvocationStatus(invocationId, "completed", {
      completedTaskId: taskId,
      completedAt: new Date().toISOString()
    });
  }

  // ---------------------------------------------------------------------------
  // getLoopStatus — return current snapshot of loop state
  // ---------------------------------------------------------------------------

  /**
   * Return a LoopStatus snapshot for the given runId.
   *
   * I/O contract:
   *   Input:  runId (string)
   *   Output: LoopStatus (immutable snapshot)
   *   Side effects: none
   */
  async getLoopStatus(runId: string): Promise<LoopStatus> {
    const [activeTask, activeInvocation, handoffsPending] = await Promise.all([
      this.store.getActiveTask(runId),
      this.store.getActiveInvocation(runId),
      this.store.countPendingHandoffs(runId)
    ]);

    let contextState: ContextBudgetState = "normal";
    if (activeInvocation !== null) {
      const cached = this.contextStateCache.get(activeInvocation);
      if (cached !== undefined) {
        contextState = cached;
      } else {
        contextState = await this.contextMonitor.getStateFromStore(activeInvocation);
      }
    }

    const cycleCount = this.cycleCounts.get(runId) ?? 0;

    return Object.freeze({
      runId,
      activeTask,
      activeInvocation,
      contextState,
      handoffsPending,
      cycleCount
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stateToLoopAction(state: ContextBudgetState): LoopAction {
  switch (state) {
    case "normal":
      return "continue";
    case "warning":
      return "warn";
    case "handoff_required":
      return "handoff_required";
    case "hard_stop":
      return "hard_stop";
    default: {
      // Exhaustive check — TypeScript will error if ContextBudgetState gains a new member.
      const _exhaustive: never = state;
      throw new Error(`agentic_loop: unknown ContextBudgetState '${String(_exhaustive)}'`);
    }
  }
}
