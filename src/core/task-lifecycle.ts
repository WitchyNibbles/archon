// Task-lifecycle manager.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4).
// This is slice 2 of the ArchonCoreService decomposition. Owns the run/task
// lifecycle transitions: intake -> plan -> task graph -> append -> claim -> fail,
// plus the run-status mutators (bumpRunState/syncRunState) that the lifecycle
// drives. Every method here depends only on the injected surface below —
// `store`, `requireRun`, `requireTask`, `findTaskBlockers`, and
// `saveAutonomousExecutionState` — never on gate/review private state.
//
// ArchonCoreService holds one TaskLifecycleManager instance and delegates to it;
// the class's public API (intakeRequest/createPlan/createTaskGraph/appendTasks/
// claimTask/failTask) is unchanged. bumpRunState/syncRunState are public here
// because gate/closure/recovery methods still on ArchonCoreService (recordReview,
// submitHandoff, promoteMemory, applyRecovery) mutate run status through them.
//
// findTaskBlockers is injected rather than moved: it belongs to the gate/closure
// cluster (slice S3, which moves last), and claimTask is its only lifecycle caller.
// The shared run-status + task-queue projections (deriveRunStatus,
// buildRuntimeTaskQueue) live in ./task-queue-projection.ts so this module and
// service.ts import one copy and no import cycle forms.

import { randomUUID } from "node:crypto";
import {
  normalizeIntakeRequest,
  validatePlanInput,
  validateTaskPacket
} from "../domain/contracts.ts";
import { isOptOutClass } from "../domain/task-class.ts";
import {
  createAutonomousExecutionState,
  runRequiresAutonomousExecution
} from "../runtime/autonomous-execution.ts";
import {
  buildDefaultProductState,
  buildDefaultTaskQueue,
  timestamp
} from "./project-runtime-state.ts";
import { buildRuntimeTaskQueue, deriveRunStatus } from "./task-queue-projection.ts";
import type { TaskClass } from "../archon/task-queue.ts";
import type { ArchonStore } from "../store/types.ts";
import type {
  AutonomousExecutionState,
  IntakeRequestInput,
  LockRecord,
  PlanArtifact,
  PlanInput,
  RunRecord,
  TaskPacketInput,
  TaskRecord
} from "../domain/types.ts";

// Derive the class for a plan-created task from its quality gates.
//
// SECURITY (Option B condition 3): this MUST NEVER return an OPT_OUT_TASK_CLASSES
// value. Opt-out classes are review-floor-reducible, and qualityGates is a mutable,
// packet-author-controlled field — deriving an opt-out class from it would resurrect
// exactly the Option A hole the council rejected (a plan packet could omit quality
// gates to land in docs_only and become eligible for a single-reviewer close).
// Opt-out classification may ONLY be assigned explicitly via the validated
// init-task --class path, never derived here. The default is the non-opt-out
// prototype_slice; a defense-in-depth guard rejects any opt-out result outright.
function mapTaskPacketToQueueClass(packet: TaskPacketInput): TaskClass {
  const derived: TaskClass = packet.qualityGates.includes("release_readiness_required")
    ? "release_candidate"
    : "prototype_slice";
  // Invariant guard: a derived class can never be opt-out (review-floor-reducible).
  return isOptOutClass(derived) ? "prototype_slice" : derived;
}

export interface TaskLifecycleManagerDeps {
  store: ArchonStore;
  requireRun: (runId: string) => Promise<RunRecord>;
  requireTask: (runId: string, taskId: string) => Promise<TaskRecord>;
  findTaskBlockers: (
    task: TaskRecord,
    allTasks: readonly TaskRecord[],
    activeLocks: readonly LockRecord[]
  ) => Promise<string[]>;
  saveAutonomousExecutionState: (
    run: RunRecord,
    update: (current: AutonomousExecutionState | undefined, now: string) => AutonomousExecutionState
  ) => Promise<AutonomousExecutionState>;
}

export class TaskLifecycleManager {
  private readonly store: ArchonStore;
  private readonly requireRun: (runId: string) => Promise<RunRecord>;
  private readonly requireTask: (runId: string, taskId: string) => Promise<TaskRecord>;
  private readonly findTaskBlockers: (
    task: TaskRecord,
    allTasks: readonly TaskRecord[],
    activeLocks: readonly LockRecord[]
  ) => Promise<string[]>;
  private readonly saveAutonomousExecutionState: (
    run: RunRecord,
    update: (current: AutonomousExecutionState | undefined, now: string) => AutonomousExecutionState
  ) => Promise<AutonomousExecutionState>;

  constructor(deps: TaskLifecycleManagerDeps) {
    this.store = deps.store;
    this.requireRun = deps.requireRun;
    this.requireTask = deps.requireTask;
    this.findTaskBlockers = deps.findTaskBlockers;
    this.saveAutonomousExecutionState = deps.saveAutonomousExecutionState;
  }

  async intakeRequest(input: IntakeRequestInput): Promise<RunRecord> {
    const { workspace, project } = await this.store.ensureProjectContext(input);
    const now = timestamp();
    const run: RunRecord = {
      id: randomUUID(),
      workspaceId: workspace.id,
      projectId: project.id,
      actor: input.actor,
      title: input.title.trim(),
      request: input.request.trim(),
      summary: normalizeIntakeRequest(input),
      status: "intake",
      createdAt: now,
      updatedAt: now
    };
    await this.store.createRun(run);
    const existingState = await this.store.getProjectRuntimeState(project.id);
    await this.store.saveProjectRuntimeState({
      projectId: project.id,
      workspaceId: workspace.id,
      activeRunId: run.id,
      activeTaskId: existingState?.activeTaskId,
      taskQueue: existingState?.taskQueue ?? buildDefaultTaskQueue(),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now
    });
    return run;
  }

  async createPlan(plan: PlanInput): Promise<PlanArtifact> {
    const run = await this.requireRun(plan.runId);
    const validationErrors = validatePlanInput(plan);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid plan: ${validationErrors.join("; ")}`);
    }

    const now = timestamp();
    const artifact: PlanArtifact = {
      id: randomUUID(),
      runId: run.id,
      kind: "plan",
      title: plan.title,
      content: plan,
      createdAt: now
    };

    await this.store.savePlan(artifact);
    await this.store.saveWorkflowDocument({
      id: randomUUID(),
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      runId: run.id,
      kind: "plan",
      title: artifact.title,
      body: JSON.stringify(plan, null, 2),
      metadata: {
        source: "runtime_plan"
      },
      createdAt: now,
      updatedAt: now
    });
    await this.store.updateRun({
      ...run,
      status: "planned",
      updatedAt: now
    });
    return artifact;
  }

  async createTaskGraph(runId: string, taskPackets: TaskPacketInput[]): Promise<TaskRecord[]> {
    const run = await this.requireRun(runId);
    const knownTaskIds = new Set(taskPackets.map((packet) => packet.taskId));
    const validationErrors = taskPackets.flatMap((packet) =>
      validateTaskPacket(packet).map((error) => `${packet.taskId}: ${error}`)
    );

    for (const packet of taskPackets) {
      for (const dependency of packet.dependencies) {
        if (!knownTaskIds.has(dependency)) {
          validationErrors.push(`${packet.taskId}: unknown dependency ${dependency}`);
        }
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`Invalid task graph: ${validationErrors.join("; ")}`);
    }

    const now = timestamp();
    const tasks: TaskRecord[] = taskPackets.map((packet) => ({
      id: randomUUID(),
      runId,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      class: mapTaskPacketToQueueClass(packet),
      packet,
      status: "ready",
      createdAt: now,
      updatedAt: now
    }));

    await this.store.replaceTasks(tasks);
    for (const task of tasks) {
      await this.store.saveWorkflowDocument({
        id: randomUUID(),
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        runId: task.runId,
        taskId: task.packet.taskId,
        kind: "task_packet",
        title: task.packet.title,
        body: JSON.stringify(task.packet, null, 2),
        metadata: {
          source: "runtime_task_graph"
        },
        createdAt: now,
        updatedAt: now
      });
    }
    await this.store.updateRun({
      ...run,
      status: "decomposed",
      updatedAt: now
    });
    const existingState = await this.store.getProjectRuntimeState(run.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      activeRunId: run.id,
      activeTaskId: existingState?.activeTaskId,
      taskQueue: buildRuntimeTaskQueue("decomposed", tasks, existingState?.activeTaskId),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now
    });

    if (runRequiresAutonomousExecution(tasks)) {
      await this.saveAutonomousExecutionState(run, (current, currentNow) =>
        current ??
        createAutonomousExecutionState({
          now: currentNow
        })
      );
    }

    return tasks;
  }

  /**
   * Append new tasks to an existing run without deleting or modifying any
   * existing tasks and without changing the run status.
   *
   * Uses the same packet-to-TaskRecord mapping path as createTaskGraph
   * (mapTaskPacketToQueueClass) and rebuilds project_runtime_state.task_queue
   * over the FULL union of existing + appended tasks, identical to the
   * createTaskGraph rebuild at lines 1255-1266.
   *
   * Throws (atomically — nothing is inserted) if:
   *   - Any task_key in taskPackets already exists in the run.
   *   - Any dependency edge references a key absent from both existing run tasks
   *     and the appended batch.
   *   - The run does not exist.
   */
  async appendTasks(runId: string, taskPackets: TaskPacketInput[]): Promise<TaskRecord[]> {
    if (taskPackets.length === 0) {
      return [];
    }

    const run = await this.requireRun(runId);
    const now = timestamp();

    const newTasks: TaskRecord[] = taskPackets.map((packet) => ({
      id: randomUUID(),
      runId,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      class: mapTaskPacketToQueueClass(packet),
      packet,
      status: "ready" as const,
      createdAt: now,
      updatedAt: now
    }));

    // Delegate integrity validation + atomic insert to the store layer.
    await this.store.appendTasks(newTasks);

    // Rebuild task_queue over the FULL union of existing + appended tasks,
    // using the same path as createTaskGraph (lines 1255-1266).
    const allTasks = await this.store.getTasksByRun(runId);
    const existingState = await this.store.getProjectRuntimeState(run.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      activeRunId: run.id,
      activeTaskId: existingState?.activeTaskId,
      taskQueue: buildRuntimeTaskQueue(
        run.status,
        allTasks,
        existingState?.activeTaskId
      ),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now
    });

    return newTasks;
  }

  async claimTask(runId: string, taskId: string, actor: string): Promise<TaskRecord> {
    const task = await this.requireTask(runId, taskId);
    if (task.status !== "ready") {
      throw new Error(`Task ${taskId} must be ready before it can be claimed`);
    }

    const allTasks = await this.store.getTasksByRun(runId);
    const activeLocks = await this.store.getActiveLocks(task.projectId);
    const blockers = await this.findTaskBlockers(task, allTasks, activeLocks);

    if (blockers.length > 0) {
      throw new Error(`Task cannot be claimed: ${blockers.join("; ")}`);
    }

    const claimedTask: TaskRecord = {
      ...task,
      status: "in_progress",
      claimedBy: actor,
      updatedAt: timestamp()
    };

    await this.store.updateTask(claimedTask);
    await this.store.createLock({
      id: randomUUID(),
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      runId,
      taskId,
      scopePaths: [...task.packet.allowedWriteScope],
      status: "active",
      createdAt: timestamp()
    });
    await this.bumpRunState(runId, "in_progress");
    const existingState = await this.store.getProjectRuntimeState(task.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      activeRunId: runId,
      activeTaskId: taskId,
      taskQueue: buildRuntimeTaskQueue("in_progress", allTasks.map((candidate) =>
        candidate.packet.taskId === taskId ? claimedTask : candidate
      ), taskId),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: existingState?.metadata ?? {},
      createdAt: existingState?.createdAt ?? timestamp(),
      updatedAt: timestamp()
    });
    return claimedTask;
  }

  async failTask(runId: string, taskId: string, reason: string) {
    const task = await this.requireTask(runId, taskId);
    const failedAt = timestamp();
    const updatedTask: TaskRecord = {
      ...task,
      status: "blocked",
      claimedBy: undefined,
      updatedAt: failedAt
    };

    await this.store.releaseLocksForTask(runId, taskId, failedAt);
    await this.store.updateTask(updatedTask);

    const allTasks = await this.store.getTasksByRun(runId);
    const syncedTasks = allTasks.map((candidate) =>
      candidate.packet.taskId === taskId ? updatedTask : candidate
    );
    const nextRunStatus = deriveRunStatus(syncedTasks);
    const run = await this.requireRun(runId);
    await this.store.updateRun({
      ...run,
      status: nextRunStatus,
      updatedAt: failedAt
    });

    const existingState = await this.store.getProjectRuntimeState(task.projectId);
    await this.store.saveProjectRuntimeState({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      activeRunId: runId,
      activeTaskId: undefined,
      taskQueue: buildRuntimeTaskQueue(nextRunStatus, syncedTasks),
      productState: existingState?.productState ?? buildDefaultProductState(),
      lastVerifiedRunId: existingState?.lastVerifiedRunId,
      metadata: {
        ...(existingState?.metadata ?? {}),
        seedFailure: {
          runId,
          taskId,
          reason,
          failedAt,
          recoveryState: "requires_reproof"
        }
      },
      createdAt: existingState?.createdAt ?? failedAt,
      updatedAt: failedAt
    });
  }

  async bumpRunState(runId: string, status: RunRecord["status"]) {
    const run = await this.requireRun(runId);
    await this.store.updateRun({
      ...run,
      status,
      updatedAt: timestamp()
    });
  }

  async syncRunState(runId: string) {
    const run = await this.requireRun(runId);
    const tasks = await this.store.getTasksByRun(runId);
    await this.store.updateRun({
      ...run,
      status: deriveRunStatus(tasks),
      updatedAt: timestamp()
    });
  }
}
