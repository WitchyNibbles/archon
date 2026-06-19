// SubtaskScheduler — Phase 4 of the Archon Agentic Loop Runtime.
//
// Validates and tracks subagent spawn requests from parent agent invocations.
// Enforces spawn-policy limits (depth, concurrency, total) and write-scope
// containment before allowing a subtask to be created.
//
// Design rules (TDD §11, §12, §18, §20, §21):
//   - Parent must exist and be in "running" status.
//   - Requested subagent type must be in the parent's allowedSubagentTypes.
//   - Child depth must not exceed policy.maxChildDepth.
//   - Concurrent children must not exceed policy.maxConcurrentChildren.
//   - Total children for the task must not exceed policy.maxTotalChildrenPerTask.
//   - Child write scope must be a subset of parent write scope.
//   - Result packets are validated against SubagentResultPacketV1Schema.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { SubagentResultPacketV1Schema } from "../domain/handoff-schemas.ts";
import type { AgentSpawnPolicy } from "../archon/agent-catalog.ts";
import type { Subtask } from "../domain/types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Specification for a subtask spawn request from a parent invocation. */
export interface SubtaskSpec {
  /** The catalog specialty ID (e.g., "codebase_scout", "test_writer"). */
  subagentType: string;
  /** Short human-readable title for this subtask. */
  title: string;
  /** Full prompt to send to the subagent. */
  prompt: string;
  /** MCP tool names the child may call. */
  allowedTools: readonly string[];
  /** Filesystem scope the child may write to. Empty means read-only. */
  allowedWriteScope: readonly string[];
  /** Maximum turns before the subagent must return a result packet. */
  maxTurns: number;
  /** Condition string describing when the subagent should stop. */
  stopCondition: string;
}

export interface SpawnResult {
  ok: true;
  subtask: Subtask;
}

export interface SpawnError {
  ok: false;
  reason: string;
}

export type SpawnOutcome = SpawnResult | SpawnError;

export interface RecordResultOutcome {
  ok: true;
}

export interface RecordResultError {
  ok: false;
  reason: string;
}

export type RecordResultResult = RecordResultOutcome | RecordResultError;

// ---------------------------------------------------------------------------
// Store surface the scheduler needs (injected for testability)
// ---------------------------------------------------------------------------

export interface SubtaskStoreLike {
  /** Create a new subtask record; returns the created record. */
  createSubtask(data: {
    id: string;
    runId: string;
    taskId: string;
    parentInvocationId: string;
    subagentType: string;
    title: string;
    prompt: string;
    allowedTools: string[];
    allowedWriteScope: string[];
    status: string;
  }): Promise<Subtask>;

  /** Persist the result packet and set terminal status. */
  updateSubtaskResult(id: string, resultPacket: Record<string, unknown>, status: string): Promise<void>;

  /** Retrieve all subtasks for a given task. */
  listSubtasksForTask(taskId: string): Promise<Subtask[]>;
}

// ---------------------------------------------------------------------------
// Parent invocation surface (minimal, for policy checks)
// ---------------------------------------------------------------------------

export interface ParentInvocationRef {
  /** The invocation's current status — must be "running" for spawning to be allowed. */
  status: string;
  /** The task this invocation belongs to. */
  taskId: string;
  /** The run this invocation belongs to. */
  runId: string;
  /** The parent's allowed write scope paths. */
  allowedWriteScope: readonly string[];
  /** Depth of this invocation in the spawn tree (0 = root). */
  depth: number;
  /** Spawn policy governing what this invocation can spawn. */
  spawnPolicy: AgentSpawnPolicy;
  /**
   * True if this invocation has already crossed the context handoff threshold.
   * SDD §20.2 / TDD §8.2: a parent that crossed the threshold must commit a
   * handoff, not fan out into new subagents. Defaults to false when omitted.
   */
  contextThresholdCrossed?: boolean;
}

export interface ParentInvocationStoreLike {
  /** Retrieve a parent invocation by ID. Returns undefined if not found. */
  getInvocation(invocationId: string): Promise<ParentInvocationRef | undefined>;
}

// ---------------------------------------------------------------------------
// SubtaskScheduler
// ---------------------------------------------------------------------------

export class SubtaskScheduler {
  private readonly subtaskStore: SubtaskStoreLike;
  private readonly invocationStore: ParentInvocationStoreLike;

  constructor(subtaskStore: SubtaskStoreLike, invocationStore: ParentInvocationStoreLike) {
    this.subtaskStore = subtaskStore;
    this.invocationStore = invocationStore;
  }

  // -------------------------------------------------------------------------
  // requestSubtask
  // -------------------------------------------------------------------------

  /**
   * Validate and create a new subtask for the given parent invocation.
   *
   * Validation gates (in order):
   *   1. Parent invocation must exist and be "running".
   *   2. subagentType must be in parent spawnPolicy.allowedSubagentTypes.
   *   3. Child depth (parent.depth + 1) must not exceed policy.maxChildDepth.
   *   4. Current pending/running children must not exceed policy.maxConcurrentChildren.
   *   5. Total children for the task must not exceed policy.maxTotalChildrenPerTask.
   *   6. Child allowedWriteScope must be a subset of parent allowedWriteScope (unless parent scope is empty = read-only applies).
   */
  async requestSubtask(parentInvocationId: string, spec: SubtaskSpec): Promise<SpawnOutcome> {
    // ARCHON_SUBAGENTS=disabled → reject all spawn requests immediately (rollout stage 4)
    if (process.env.ARCHON_SUBAGENTS === "disabled") {
      return { ok: false, reason: "Subagent spawning is disabled (ARCHON_SUBAGENTS=disabled)." };
    }

    const parent = await this.invocationStore.getInvocation(parentInvocationId);

    if (parent === undefined) {
      return { ok: false, reason: `Parent invocation '${parentInvocationId}' not found.` };
    }

    if (parent.status !== "running") {
      return {
        ok: false,
        reason: `Parent invocation '${parentInvocationId}' is not running (status: ${parent.status}).`
      };
    }

    // Gate 1b (SDD §20.2 / TDD §8.2): once the parent crosses the context
    // handoff threshold it must commit a handoff, not spawn more subagents.
    // The PreToolUse hook also blocks the Agent/Task tool after the threshold;
    // this is the runtime-level invariant so the scheduler fails closed even
    // when invoked outside the hook path.
    if (parent.contextThresholdCrossed === true) {
      return {
        ok: false,
        reason:
          `Parent invocation '${parentInvocationId}' has crossed the context handoff threshold; ` +
          `commit a handoff packet before spawning subagents.`
      };
    }

    // Gate 2: subagent type allowed
    const policy = parent.spawnPolicy;
    if (!policy.allowedSubagentTypes.includes(spec.subagentType)) {
      return {
        ok: false,
        reason:
          `Subagent type '${spec.subagentType}' is not in the parent's allowedSubagentTypes ` +
          `[${policy.allowedSubagentTypes.join(", ")}].`
      };
    }

    // Gate 3: depth limit
    const childDepth = parent.depth + 1;
    if (childDepth > policy.maxChildDepth) {
      return {
        ok: false,
        reason:
          `Child depth ${childDepth} exceeds maxChildDepth ${policy.maxChildDepth}.`
      };
    }

    // Gate 4 + 5: concurrency and total — read existing subtasks for this task
    const existingSubtasks = await this.subtaskStore.listSubtasksForTask(parent.taskId);
    const pendingOrRunning = existingSubtasks.filter(
      (s) => s.status === "pending" || s.status === "running"
    );
    if (pendingOrRunning.length >= policy.maxConcurrentChildren) {
      return {
        ok: false,
        reason:
          `Concurrent child limit reached (${pendingOrRunning.length} / ${policy.maxConcurrentChildren}).`
      };
    }

    if (existingSubtasks.length >= policy.maxTotalChildrenPerTask) {
      return {
        ok: false,
        reason:
          `Total child limit for task reached (${existingSubtasks.length} / ${policy.maxTotalChildrenPerTask}).`
      };
    }

    // Gate 6: write scope containment
    const scopeError = this.checkWriteScopeContainment(
      spec.allowedWriteScope,
      parent.allowedWriteScope
    );
    if (scopeError !== undefined) {
      return { ok: false, reason: scopeError };
    }

    // All gates passed — create the subtask
    const subtaskId = `subtask_${randomUUID()}`;
    const subtask = await this.subtaskStore.createSubtask({
      id: subtaskId,
      runId: parent.runId,
      taskId: parent.taskId,
      parentInvocationId,
      subagentType: spec.subagentType,
      title: spec.title,
      prompt: spec.prompt,
      allowedTools: [...spec.allowedTools],
      allowedWriteScope: [...spec.allowedWriteScope],
      status: "pending"
    });

    return { ok: true, subtask };
  }

  // -------------------------------------------------------------------------
  // recordResult
  // -------------------------------------------------------------------------

  /**
   * Validate and persist a subagent result packet.
   *
   * Validates the packet against SubagentResultPacketV1Schema before storing.
   */
  async recordResult(
    subtaskId: string,
    rawPacket: Record<string, unknown>
  ): Promise<RecordResultResult> {
    const parsed = SubagentResultPacketV1Schema.safeParse(rawPacket);
    if (!parsed.success) {
      const messages = parsed.error.issues
        .map((issue) => `[${issue.path.join(".")}] ${issue.message}`)
        .join("; ");
      return { ok: false, reason: `Result packet validation failed — ${messages}` };
    }

    const packet = parsed.data;
    await this.subtaskStore.updateSubtaskResult(subtaskId, rawPacket, packet.status);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // getPendingSubtasks
  // -------------------------------------------------------------------------

  /** Returns all subtasks for the given task that are in "pending" status. */
  async getPendingSubtasks(taskId: string): Promise<readonly Subtask[]> {
    const all = await this.subtaskStore.listSubtasksForTask(taskId);
    return all.filter((s) => s.status === "pending");
  }

  // -------------------------------------------------------------------------
  // getSubtaskDepth
  // -------------------------------------------------------------------------

  /**
   * Returns the spawn depth that a child of this invocation would have.
   * Returns undefined if the invocation is not found.
   */
  async getSubtaskDepth(parentInvocationId: string): Promise<number | undefined> {
    const parent = await this.invocationStore.getInvocation(parentInvocationId);
    if (parent === undefined) return undefined;
    return parent.depth + 1;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Checks that every path in childScope is contained within parentScope.
   * Returns an error string if containment fails, undefined if OK.
   *
   * If parentScope is empty, no writes are permitted (read-only parent).
   * If childScope is empty, no writes are requested — always allowed.
   */
  private checkWriteScopeContainment(
    childScope: readonly string[],
    parentScope: readonly string[]
  ): string | undefined {
    if (childScope.length === 0) return undefined;

    if (parentScope.length === 0) {
      return (
        `Child requests write scope [${childScope.join(", ")}] but parent has no write scope ` +
        `(read-only parent).`
      );
    }

    const violations: string[] = [];
    for (const childPath of childScope) {
      const covered = parentScope.some((parentPath) =>
        this.pathCoveredBy(childPath, parentPath)
      );
      if (!covered) {
        violations.push(childPath);
      }
    }

    if (violations.length > 0) {
      return (
        `Child write scope [${violations.join(", ")}] exceeds parent write scope ` +
        `[${parentScope.join(", ")}].`
      );
    }

    return undefined;
  }

  /**
   * Returns true if childPath is covered by parentPath.
   * Coverage rules:
   *   - Both paths are normalized via path.posix.normalize() first.
   *   - Any path that contains ".." after normalization is rejected (returns false).
   *   - parentPath "." covers everything.
   *   - Exact match always covers.
   *   - parentPath ending in "/**" covers any childPath under the prefix directory.
   *   - parentPath ending in "/*" covers direct children only (no nested slashes).
   *   - Bare directory parentPath covers any childPath that starts with parentPath + "/".
   */
  private pathCoveredBy(childPath: string, parentPath: string): boolean {
    const normalizedChild = path.posix.normalize(childPath);
    const normalizedParent = path.posix.normalize(parentPath);

    // Reject path traversal after normalization
    if (normalizedChild.includes("..") || normalizedParent.includes("..")) return false;

    if (normalizedParent === "." || normalizedParent === normalizedChild) return true;

    if (normalizedParent.endsWith("/**")) {
      // removes "**", keeps trailing "/"  e.g. "src/**" → "src/"
      const prefix = normalizedParent.slice(0, -2);
      return normalizedChild.startsWith(prefix);
    }

    if (normalizedParent.endsWith("/*")) {
      // removes "*", keeps trailing "/"  e.g. "src/*" → "src/"
      const prefix = normalizedParent.slice(0, -1);
      const remainder = normalizedChild.slice(prefix.length);
      return normalizedChild.startsWith(prefix) && remainder.length > 0 && !remainder.includes("/");
    }

    // Exact directory match — child must be directly under parent/
    const dirPrefix = normalizedParent.endsWith("/") ? normalizedParent : normalizedParent + "/";
    return normalizedChild.startsWith(dirPrefix);
  }
}
