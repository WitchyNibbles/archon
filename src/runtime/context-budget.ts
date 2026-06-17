// Context Budget Monitor — Phase 2 of the Archon Agentic Loop Runtime.
//
// Tracks context window usage for each agent invocation and enforces
// threshold-based state transitions (normal → warning → handoff_required →
// hard_stop).  The class is store-agnostic: callers inject a StoreLike adapter
// so unit tests can run without a real database connection.

import { EventEmitter } from "node:events";
import type { ContextSample, ContextPolicy } from "../domain/types.ts";
import type { RecordContextSampleInput } from "../store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const defaultArchonContextPolicy: Readonly<{
  handoffPct: number;
  warningPct: number;
  hardStopPct: number;
}> = {
  handoffPct: 70,
  warningPct: 60,
  hardStopPct: 80
} as const;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type ContextBudgetState =
  | "normal"
  | "warning"
  | "handoff_required"
  | "hard_stop";

// ---------------------------------------------------------------------------
// Event types (typed emitter)
// ---------------------------------------------------------------------------

export interface ContextThresholdEvent {
  invocationId: string;
  usedPercentage: number;
  previousState: ContextBudgetState;
  newState: ContextBudgetState;
  sampledAt: string;
}

// Extend EventEmitter with typed overloads
export interface ContextBudgetEmitter {
  on(event: "warning", listener: (evt: ContextThresholdEvent) => void): this;
  on(event: "handoff_required", listener: (evt: ContextThresholdEvent) => void): this;
  on(event: "hard_stop", listener: (evt: ContextThresholdEvent) => void): this;
  emit(event: "warning", evt: ContextThresholdEvent): boolean;
  emit(event: "handoff_required", evt: ContextThresholdEvent): boolean;
  emit(event: "hard_stop", evt: ContextThresholdEvent): boolean;
}

// ---------------------------------------------------------------------------
// Store adapter interface (injected; no direct DB dependency)
// ---------------------------------------------------------------------------

export interface ContextBudgetStoreLike {
  recordContextSample(data: RecordContextSampleInput): Promise<void>;
  getLatestContextSample(invocationId: string): Promise<ContextSample | undefined>;
  /** Returns true if a handoff row exists for this invocation (not yet consumed). */
  hasCommittedHandoff(invocationId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// ContextBudgetMonitor
// ---------------------------------------------------------------------------

export class ContextBudgetMonitor extends EventEmitter implements ContextBudgetEmitter {
  private readonly policy: Readonly<{
    handoffPct: number;
    warningPct: number;
    hardStopPct: number;
  }>;

  // Per-invocation state cache (in-memory; source-of-truth is the store).
  private readonly stateCache = new Map<string, ContextBudgetState>();

  private readonly store: ContextBudgetStoreLike;

  constructor(
    store: ContextBudgetStoreLike,
    policy?: Partial<{
      handoffPct: number;
      warningPct: number;
      hardStopPct: number;
    }>
  ) {
    super();
    this.store = store;
    this.policy = {
      handoffPct: policy?.handoffPct ?? defaultArchonContextPolicy.handoffPct,
      warningPct: policy?.warningPct ?? defaultArchonContextPolicy.warningPct,
      hardStopPct: policy?.hardStopPct ?? defaultArchonContextPolicy.hardStopPct
    };
  }

  // -------------------------------------------------------------------------
  // evaluate — pure state-machine helper (no I/O)
  // -------------------------------------------------------------------------

  /**
   * Compute the new ContextBudgetState for a given usedPercentage.
   *
   * Transition table (lowest threshold wins on the way up):
   *   usedPct < warningPct             → normal
   *   warningPct <= usedPct < handoffPct → warning
   *   handoffPct <= usedPct < hardStopPct → handoff_required
   *   usedPct >= hardStopPct           → hard_stop
   *
   * This is intentionally stateless so callers can compare without side effects.
   */
  evaluate(usedPercentage: number): ContextBudgetState {
    if (usedPercentage >= this.policy.hardStopPct) return "hard_stop";
    if (usedPercentage >= this.policy.handoffPct) return "handoff_required";
    if (usedPercentage >= this.policy.warningPct) return "warning";
    return "normal";
  }

  // -------------------------------------------------------------------------
  // recordSample — persist + drive state transitions
  // -------------------------------------------------------------------------

  /**
   * Record a context sample and fire threshold events if the state changed.
   *
   * Returns the new ContextBudgetState.
   */
  async recordSample(
    invocationId: string,
    runId: string,
    taskId: string,
    source: ContextSample["source"],
    usedPercentage: number,
    rawData?: Record<string, unknown>
  ): Promise<ContextBudgetState> {
    const sampledAt = new Date().toISOString();

    await this.store.recordContextSample({
      invocationId,
      runId,
      taskId,
      source,
      usedPercentage,
      sampledAt,
      raw: rawData ?? {}
    });

    const previousState = this.stateCache.get(invocationId) ?? "normal";
    const newState = this.evaluate(usedPercentage);

    if (newState !== previousState) {
      this.stateCache.set(invocationId, newState);

      const evt: ContextThresholdEvent = {
        invocationId,
        usedPercentage,
        previousState,
        newState,
        sampledAt
      };

      if (newState === "warning") this.emit("warning", evt);
      if (newState === "handoff_required") this.emit("handoff_required", evt);
      if (newState === "hard_stop") this.emit("hard_stop", evt);
    } else {
      // Update cache even when state is unchanged (initialise on first sample).
      this.stateCache.set(invocationId, newState);
    }

    return newState;
  }

  // -------------------------------------------------------------------------
  // getCurrentState — last known in-memory state
  // -------------------------------------------------------------------------

  /**
   * Return the cached state for an invocation, or "normal" if never recorded.
   * Use getStateFromStore for authoritative lookup across restarts.
   */
  getCurrentState(invocationId: string): ContextBudgetState {
    return this.stateCache.get(invocationId) ?? "normal";
  }

  // -------------------------------------------------------------------------
  // getStateFromStore — authoritative lookup via latest sample
  // -------------------------------------------------------------------------

  /**
   * Hydrate state from the latest persisted context sample.
   * Returns "normal" if no sample exists.
   */
  async getStateFromStore(invocationId: string): Promise<ContextBudgetState> {
    const sample = await this.store.getLatestContextSample(invocationId);
    if (sample === undefined || sample.usedPercentage === undefined) {
      return "normal";
    }
    const state = this.evaluate(sample.usedPercentage);
    this.stateCache.set(invocationId, state);
    return state;
  }

  // -------------------------------------------------------------------------
  // getThresholdCrossed — has handoff_required or hard_stop been observed?
  // -------------------------------------------------------------------------

  /**
   * Returns true if the persisted latest sample shows usedPercentage at or
   * above handoffPct.  Used by PreToolUse hooks and the Stop hook.
   */
  async getThresholdCrossed(invocationId: string): Promise<boolean> {
    const state = await this.getStateFromStore(invocationId);
    return state === "handoff_required" || state === "hard_stop";
  }

  // -------------------------------------------------------------------------
  // buildStatusSummary — human-readable one-liner for CLI display
  // -------------------------------------------------------------------------

  /**
   * Build a non-empty status summary string for the CLI `context-status`
   * subcommand.  Falls back to "normal" when no samples are recorded.
   */
  async buildStatusSummary(invocationId: string): Promise<string> {
    const sample = await this.store.getLatestContextSample(invocationId);

    if (sample === undefined) {
      return `invocation ${invocationId}: no context samples recorded (state=normal)`;
    }

    const usedPct = sample.usedPercentage;
    const state = usedPct !== undefined ? this.evaluate(usedPct) : "normal";
    const pctDisplay = usedPct !== undefined ? `${usedPct.toFixed(1)}%` : "unknown";

    const hasHandoff = await this.store.hasCommittedHandoff(invocationId);
    const handoffNote = hasHandoff ? " [handoff committed]" : "";

    return `invocation ${invocationId}: context ${pctDisplay} used, state=${state}${handoffNote} (sampled ${sample.sampledAt})`;
  }

  // -------------------------------------------------------------------------
  // isHandoffSafeTool — hook helper
  // -------------------------------------------------------------------------

  /**
   * Returns true for tools that may be used even when in handoff_required state.
   * Only handoff-committing operations and read-only diagnostic tools are allowed.
   */
  static isHandoffSafeTool(toolName: string): boolean {
    const safeTools = new Set([
      "mcp__archon__create_handoff",
      "mcp__archon__commit_handoff",
      "mcp__archon__record_checkpoint",
      "mcp__archon__context_status",
      "Bash",     // read-only inspection is not preventable at tool level
      "Read",
      "TodoRead"
    ]);
    return safeTools.has(toolName);
  }

  // -------------------------------------------------------------------------
  // evaluatePreToolUse — PreToolUse hook decision
  // -------------------------------------------------------------------------

  /**
   * Compute a hook decision for a PreToolUse event.
   *
   * Contract:
   *   Input:  invocationId (string), toolName (string)
   *   Output: { decision: "allow" | "deny"; reason?: string }
   *
   * "deny" is returned when:
   *   - state is handoff_required or hard_stop
   *   - the tool is NOT in the handoff-safe set
   *   - no committed handoff packet exists for this invocation
   */
  async evaluatePreToolUse(
    invocationId: string,
    toolName: string
  ): Promise<{ decision: "allow" | "deny"; reason?: string }> {
    const state = await this.getStateFromStore(invocationId);

    if (state !== "handoff_required" && state !== "hard_stop") {
      return { decision: "allow" };
    }

    if (ContextBudgetMonitor.isHandoffSafeTool(toolName)) {
      return { decision: "allow" };
    }

    const hasHandoff = await this.store.hasCommittedHandoff(invocationId);
    if (hasHandoff) {
      return { decision: "allow" };
    }

    return {
      decision: "deny",
      reason: `Context at ${state}: tool '${toolName}' blocked until a valid handoff packet is committed. Use mcp__archon__create_handoff first.`
    };
  }
}
