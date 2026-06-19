import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkflowProofSeedResolver,
  executeDoctorRepairCommandFromArgs,
  executeSeedWorkflowProofCommandFromArgs,
  executeStatusCommandFromArgs,
  executeWorkflowProofCommandFromArgs
} from "../src/admin.ts";
import { ArchonCoreService } from "../src/core/service.ts";
import type { RuntimeProjectRegistrationRecord, TaskPacketInput } from "../src/domain/types.ts";
import { MemoryStore } from "../src/store/memory-store.ts";

function taskPacket(overrides: Partial<TaskPacketInput> = {}): TaskPacketInput {
  return {
    taskId: overrides.taskId ?? "task-1",
    title: overrides.title ?? "Workflow integrity task",
    ownerRole: overrides.ownerRole ?? "planner",
    completionStandard: overrides.completionStandard ?? "specialist_verified",
    requiredSpecialistRoles:
      overrides.requiredSpecialistRoles ??
      [((overrides.ownerRole ?? "planner") as TaskPacketInput["requiredSpecialistRoles"][number])],
    qualityGates: overrides.qualityGates ?? ["product_acceptance"],
    goal: overrides.goal ?? "Keep workflow state authoritative",
    inputs: overrides.inputs ?? ["intake brief"],
    outputs: overrides.outputs ?? ["task packet"],
    dependencies: overrides.dependencies ?? [],
    allowedWriteScope: overrides.allowedWriteScope ?? [".archon/work/tasks"],
    outOfScope: overrides.outOfScope ?? ["production deploys"],
    acceptanceCriteria: overrides.acceptanceCriteria ?? ["workflow state remains trustworthy"],
    verificationSteps: overrides.verificationSteps ?? ["run integrity regression tests"],
    uiSurface: overrides.uiSurface,
    playwrightRequired: overrides.playwrightRequired,
    requiredReviews: overrides.requiredReviews ?? ["reviewer", "security_reviewer", "qa_engineer"],
    securityChecks: overrides.securityChecks ?? ["ensure write scope is narrow"],
    antiPatterns: overrides.antiPatterns ?? ["manual runtime mutation without proof"],
    rollbackNotes: overrides.rollbackNotes ?? "remove the test fixture",
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
        label: "integrity regression reasoning",
        hypothesis: "the workflow must fail closed under interruption and contradiction",
        alternatives: ["allow drift and rely on operators to notice later"],
        evidenceRefs: ["tests/workflow-integrity.test.ts"],
        verificationRefs: ["verification-1"],
        traceRef: "test://workflow-integrity-task",
        outcome: "supported",
        summary: "the fixture encodes fail-closed workflow expectations"
      }
    ],
    reasoningVerifications: overrides.reasoningVerifications ?? [
      {
        id: "verification-1",
        kind: "critic_review",
        ref: "test://workflow-integrity-task",
        status: "passed",
        summary: "the fixture includes explicit critic verification"
      }
    ],
    reasoningVerdict: overrides.reasoningVerdict ?? {
      status: "supported",
      summary: "the integrity fixture is strict-complete",
      supportingAttemptIds: ["attempt-1"],
      blockingIssues: []
    },
    reasoningQuality: overrides.reasoningQuality ?? {
      claim: "the integrity fixture captures adversarial workflow scenarios",
      facts: ["runtime authority and local exports can drift"],
      assumptions: ["operators need deterministic repair behavior"],
      hypotheses: ["the runtime should fail safe and surface contradictions"],
      evidenceRefs: ["tests/workflow-integrity.test.ts"],
      counterEvidence: [],
      openQuestions: [],
      verificationPlan: ["node --experimental-strip-types --test tests/workflow-integrity.test.ts"],
      fallbacks: ["expand the suite with more interruption points"],
      budgets: { researchSteps: 1, debugSteps: 1, reviewPasses: 1, toolRetries: 1 },
      confidence: "medium",
      decision: "supported"
    }
  };
}

function runtimeRegistration(overrides: Partial<RuntimeProjectRegistrationRecord> = {}): RuntimeProjectRegistrationRecord {
  return {
    projectId: overrides.projectId ?? "project:team:archon",
    workspaceId: overrides.workspaceId ?? "workspace:team",
    repoPath: overrides.repoPath ?? "/repo/archon",
    runtimeProfile: overrides.runtimeProfile ?? "local-docker",
    dataRoot: overrides.dataRoot ?? "/tmp/archon-runtime",
    qdrantUrl: overrides.qdrantUrl ?? "http://127.0.0.1:6333",
    qdrantCollection: overrides.qdrantCollection ?? "archon-memory",
    installManifestPath: overrides.installManifestPath ?? ".archon/install-manifest.json",
    manifest: overrides.manifest ?? { version: 1 },
    provenance: overrides.provenance ?? { authority: "runtime_authoritative" },
    createdAt: overrides.createdAt ?? "2026-05-10T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-10T00:00:00.000Z"
  };
}

test("workflow integrity: proof seeding failure cleans up lock-bearing partial state", async () => {
  const store = new MemoryStore();
  const service = new ArchonCoreService(store);
  const reviewFailure = new Error("review persistence exploded");
  await store.ensureProjectContext({
    workspaceSlug: "team",
    projectSlug: "archon"
  });

  await assert.rejects(
    () =>
      executeSeedWorkflowProofCommandFromArgs(["--workspace-slug", "team", "--project-slug", "archon", "--task-id", "task-proof"], {
        env: process.env,
        intakeRequest(input) {
          return service.intakeRequest(input);
        },
        getProjectContext(params) {
          return store.getProjectContext(params);
        },
        getProjectRuntimeState(projectId) {
          return store.getProjectRuntimeState(projectId);
        },
        saveProjectRuntimeState(state) {
          return store.saveProjectRuntimeState(state);
        },
        createTaskGraph(runId, tasks) {
          return service.createTaskGraph(runId, tasks);
        },
        claimTask(runId, taskId, actor) {
          return service.claimTask(runId, taskId, actor);
        },
        submitHandoff(runId, taskId, handoff) {
          return service.submitHandoff(runId, taskId, handoff);
        },
        async recordReview() {
          throw reviewFailure;
        },
        failTask(runId, taskId, reason) {
          return service.failTask(runId, taskId, reason);
        },
        getStatusSnapshot(runId) {
          return service.getStatus(runId);
        },
        getReviews(runId, taskId) {
          return store.getReviews(runId, taskId);
        },
        getApprovals(runId, taskId) {
          return store.getApprovals(runId, taskId);
        }
      }),
    reviewFailure
  );

  const latestRun = await store.findLatestRun({ workspaceSlug: "team", projectSlug: "archon" });
  assert.ok(latestRun);
  const snapshot = await service.getStatus(latestRun.id);
  const seededTask = snapshot.tasks.find((task) => task.packet.taskId === "task-proof");
  assert.ok(seededTask);
  assert.notEqual(seededTask.status, "review_blocked");
  assert.deepEqual(snapshot.activeLocks, []);
  const projectContext = await store.getProjectContext({ workspaceSlug: "team", projectSlug: "archon" });
  assert.ok(projectContext);
  const runtimeState = await store.getProjectRuntimeState(projectContext.project.id);
  assert.equal(runtimeState?.activeTaskId, undefined);
  assert.equal(runtimeState?.metadata?.seedFailure?.taskId, "task-proof");
  assert.match(String(runtimeState?.metadata?.seedFailure?.reason ?? ""), /review persistence exploded/i);

  const report = await executeStatusCommandFromArgs(["--run-id", latestRun.id], {
    env: process.env,
    getStatusSnapshot(runId) {
      return service.getStatus(runId);
    },
    getProjectRuntimeState(projectId) {
      return store.getProjectRuntimeState(projectId);
    }
  });
  assert.equal(report.integrity.runtimeState?.seedFailure?.taskId, "task-proof");
  assert.match(String(report.integrity.runtimeState?.seedFailure?.reason ?? ""), /review persistence exploded/i);
});

test("workflow integrity: status surfaces contradictory local completion claims over runtime authority", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "archon-integrity-status-"));
  const store = new MemoryStore();
  const service = new ArchonCoreService(store);

  try {
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Contradiction drift",
      request: "Expose local completion claims that outrun runtime proof."
    });
    await service.createTaskGraph(run.id, [taskPacket({ taskId: "task-owner", allowedWriteScope: ["src/runtime"] })]);
    await service.claimTask(run.id, "task-owner", "planner");

    const context = await store.getProjectContext({ workspaceSlug: "team", projectSlug: "archon" });
    assert.ok(context);
    await store.saveProjectRuntimeState({
      projectId: context.project.id,
      workspaceId: context.workspace.id,
      activeRunId: run.id,
      activeTaskId: "task-owner",
      taskQueue: {
        project_status: "in_progress",
        current_task_id: "task-owner",
        tasks: []
      },
      productState: { status: "in_progress", items: [] },
      lastVerifiedRunId: undefined,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await mkdir(path.join(directory, ".archon", "work"), { recursive: true });
    await writeFile(path.join(directory, ".archon", "ACTIVE"), "workflow=archon\nstate=complete\n", "utf8");
    await writeFile(
      path.join(directory, ".archon", "work", "task-queue.json"),
      `${JSON.stringify({ project_status: "complete", current_task_id: null, tasks: [] }, null, 2)}\n`,
      "utf8"
    );

    const report = await executeStatusCommandFromArgs(["--run-id", run.id], {
      cwd: directory,
      env: process.env,
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      }
    });

    assert.equal(report.integrity.status, "contradicted");
    assert.equal(report.integrity.runtimeState?.lastVerifiedRunId, null);
    assert.match(report.integrity.contradictions.join(" | "), /local exports claim complete/i);
    assert.match(report.integrity.contradictions.join(" | "), /runtime run status is in_progress/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow integrity: doctor repair safely resyncs contradictory local exports from runtime state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "archon-integrity-repair-"));
  const store = new MemoryStore();
  const service = new ArchonCoreService(store);

  try {
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Repair drift",
      request: "Resync exports from runtime authority."
    });
    await service.createTaskGraph(run.id, [taskPacket({ taskId: "task-owner", allowedWriteScope: ["src/runtime"] })]);
    await service.claimTask(run.id, "task-owner", "planner");

    const context = await store.getProjectContext({ workspaceSlug: "team", projectSlug: "archon" });
    assert.ok(context);
    await mkdir(path.join(directory, ".archon", "work"), { recursive: true });
    await mkdir(path.join(directory, "runtime-root"), { recursive: true });
    await writeFile(path.join(directory, ".archon", "ACTIVE"), "workflow=archon\nstate=complete\n", "utf8");
    await writeFile(
      path.join(directory, ".archon", "work", "task-queue.json"),
      `${JSON.stringify({ project_status: "complete", current_task_id: null, tasks: [] }, null, 2)}\n`,
      "utf8"
    );
    await store.saveProjectRuntimeRegistration(
      runtimeRegistration({
        projectId: context.project.id,
        workspaceId: context.workspace.id,
        repoPath: directory,
        dataRoot: path.join(directory, "runtime-root")
      })
    );

    const existingRuntimeState = await store.getProjectRuntimeState(context.project.id);
    assert.ok(existingRuntimeState);
    await store.saveProjectRuntimeState({
      ...existingRuntimeState,
      lastVerifiedRunId: undefined,
      metadata: {
        ...(existingRuntimeState.metadata ?? {}),
        seedFailure: {
          runId: run.id,
          taskId: "task-owner",
          reason: "synthetic persisted seed failure",
          failedAt: "2026-05-31T10:00:00.000Z",
          recoveryState: "requires_reproof"
        }
      },
      updatedAt: new Date().toISOString()
    });

    const result = await executeDoctorRepairCommandFromArgs(["--repair"], {
      cwd: directory,
      env: {
        ...process.env,
        ARCHON_WORKSPACE_SLUG: "team",
        ARCHON_PROJECT_SLUG: "archon"
      },
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      async findProjectContext(workspaceSlug, projectSlug) {
        return store.getProjectContext({ workspaceSlug, projectSlug });
      },
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      applyRecovery(runId, actionIds, staleAfterHours) {
        return service.applyRecovery(runId, actionIds, { staleAfterHours });
      },
      getProjectRuntimeRegistration(projectId) {
        return store.getProjectRuntimeRegistration(projectId);
      },
      inspectReviewIdentity: async () => ({
        authorityLabel: "derived_only" as const,
        adapterConfigured: true,
        adapterExists: true,
        availableBackends: [],
        bindingsPresent: true,
        bindingsPath: path.join(directory, ".archon/review-identity-bindings.json"),
        bindingsUseShippedTemplate: false,
        liveTrustReady: true,
        notes: []
      }),
      inspectQdrant: async () => ({
        ok: true,
        summary: "qdrant reachable"
      })
    });

    const activeExport = await readFile(path.join(directory, ".archon", "ACTIVE"), "utf8");
    const queueExport = JSON.parse(
      await readFile(path.join(directory, ".archon", "work", "task-queue.json"), "utf8")
    ) as { project_status?: string; current_task_id?: string | null };
    const repairedRuntimeState = await store.getProjectRuntimeState(context.project.id);

    assert.equal(result.ok, true);
    assert.equal(result.executionReady, true);
    assert.equal(result.repair.status, "repaired");
    assert.ok(
      result.repair.stepsApplied.includes("sync local workflow exports from runtime state after persisted seed failure")
    );
    assert.deepEqual(result.repair.integrityRepairsAttempted, [
      "sync local workflow exports from runtime state after persisted seed failure"
    ]);
    assert.deepEqual(result.repair.integrityRepairsApplied, [
      "sync local workflow exports from runtime state after persisted seed failure"
    ]);
    assert.equal(repairedRuntimeState?.metadata?.lastIntegrityRepair?.kind, "local_export_resync");
    assert.match(String(repairedRuntimeState?.metadata?.lastIntegrityRepair?.summary ?? ""), /sync local workflow exports/i);
    assert.equal(activeExport, "task_id=task-owner\nworkflow=archon\nstate=active\n");
    assert.equal(queueExport.project_status, "in_progress");
    assert.equal(queueExport.current_task_id, "task-owner");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow integrity: doctor repair recreates missing local exports from persisted seed failure residue", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "archon-integrity-repair-seed-residue-"));
  const store = new MemoryStore();
  const service = new ArchonCoreService(store);

  try {
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Repair seed residue",
      request: "Recreate local exports from authoritative persisted seed failure residue."
    });
    await service.createTaskGraph(run.id, [taskPacket({ taskId: "task-owner", allowedWriteScope: ["src/runtime"] })]);
    await service.claimTask(run.id, "task-owner", "planner");
    await service.failTask(run.id, "task-owner", "persisted interrupted proof seed");

    const context = await store.getProjectContext({ workspaceSlug: "team", projectSlug: "archon" });
    assert.ok(context);
    await mkdir(path.join(directory, ".archon", "work"), { recursive: true });
    await mkdir(path.join(directory, "runtime-root"), { recursive: true });
    await store.saveProjectRuntimeRegistration(
      runtimeRegistration({
        projectId: context.project.id,
        workspaceId: context.workspace.id,
        repoPath: directory,
        dataRoot: path.join(directory, "runtime-root")
      })
    );
    const result = await executeDoctorRepairCommandFromArgs(["--repair"], {
      cwd: directory,
      env: {
        ...process.env,
        ARCHON_WORKSPACE_SLUG: "team",
        ARCHON_PROJECT_SLUG: "archon"
      },
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      async findProjectContext(workspaceSlug, projectSlug) {
        return store.getProjectContext({ workspaceSlug, projectSlug });
      },
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      applyRecovery(runId, actionIds, staleAfterHours) {
        return service.applyRecovery(runId, actionIds, { staleAfterHours });
      },
      getProjectRuntimeRegistration(projectId) {
        return store.getProjectRuntimeRegistration(projectId);
      },
      inspectReviewIdentity: async () => ({
        authorityLabel: "derived_only" as const,
        adapterConfigured: true,
        adapterExists: true,
        availableBackends: [],
        bindingsPresent: true,
        bindingsPath: path.join(directory, ".archon/review-identity-bindings.json"),
        bindingsUseShippedTemplate: false,
        liveTrustReady: true,
        notes: []
      }),
      inspectQdrant: async () => ({
        ok: true,
        summary: "qdrant reachable"
      })
    });

    const activeExport = await readFile(path.join(directory, ".archon", "ACTIVE"), "utf8");
    const queueExport = JSON.parse(
      await readFile(path.join(directory, ".archon", "work", "task-queue.json"), "utf8")
    ) as { project_status?: string; current_task_id?: string | null };
    const runtimeState = await store.getProjectRuntimeState(context.project.id);

    assert.equal(result.ok, true);
    assert.equal(result.executionReady, true);
    assert.equal(result.repair.status, "repaired");
    assert.ok(
      result.repair.stepsApplied.includes("sync local workflow exports from runtime state after persisted seed failure")
    );
    assert.deepEqual(result.repair.integrityRepairsAttempted, [
      "sync local workflow exports from runtime state after persisted seed failure"
    ]);
    assert.deepEqual(result.repair.integrityRepairsApplied, [
      "sync local workflow exports from runtime state after persisted seed failure"
    ]);
    assert.equal(runtimeState?.metadata?.lastIntegrityRepair?.kind, "local_export_resync");
    assert.match(String(runtimeState?.metadata?.lastIntegrityRepair?.summary ?? ""), /sync local workflow exports/i);
    assert.equal(activeExport, "workflow=archon\nstate=idle\n");
    assert.equal(queueExport.project_status, "ready");
    assert.equal(queueExport.current_task_id, null);
    assert.equal(queueExport.project_status, runtimeState?.taskQueue.project_status);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow integrity: doctor repair clears stale persisted seed failure metadata after authoritative proof", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "archon-integrity-clear-stale-seed-failure-"));
  const store = new MemoryStore();
  const service = new ArchonCoreService(store);

  try {
    const run = await service.intakeRequest({
      workspaceSlug: "team",
      projectSlug: "archon",
      actor: "ceo",
      title: "Clear stale residue",
      request: "Clear stale persisted seed-failure metadata after authoritative proof exists."
    });
    await service.createTaskGraph(run.id, [taskPacket({ taskId: "task-proof", allowedWriteScope: ["src/runtime"] })]);
    await service.claimTask(run.id, "task-proof", "planner");

    const context = await store.getProjectContext({ workspaceSlug: "team", projectSlug: "archon" });
    assert.ok(context);
    await mkdir(path.join(directory, ".archon", "work"), { recursive: true });
    await mkdir(path.join(directory, "runtime-root"), { recursive: true });
    await store.saveProjectRuntimeRegistration(
      runtimeRegistration({
        projectId: context.project.id,
        workspaceId: context.workspace.id,
        repoPath: directory,
        dataRoot: path.join(directory, "runtime-root")
      })
    );

    const existingRuntimeState = await store.getProjectRuntimeState(context.project.id);
    assert.ok(existingRuntimeState);
    await store.saveProjectRuntimeState({
      ...existingRuntimeState,
      activeRunId: run.id,
      activeTaskId: undefined,
      taskQueue: {
        project_status: "done",
        current_task_id: null,
        tasks: []
      },
      productState: { status: "done", items: [] },
      lastVerifiedRunId: run.id,
      metadata: {
        ...(existingRuntimeState.metadata ?? {}),
        seedFailure: {
          runId: run.id,
          taskId: "task-proof",
          reason: "stale residue after proof",
          failedAt: "2026-05-31T10:00:00.000Z",
          recoveryState: "stale_metadata"
        }
      },
      updatedAt: new Date().toISOString()
    });

    const before = await executeStatusCommandFromArgs(["--run-id", run.id], {
      cwd: directory,
      env: process.env,
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      }
    });
    assert.equal(before.integrity.status, "contradicted");
    assert.equal(before.integrity.runtimeState?.seedFailure?.recoveryState, "stale_metadata");

    const result = await executeDoctorRepairCommandFromArgs(["--repair"], {
      cwd: directory,
      env: {
        ...process.env,
        ARCHON_WORKSPACE_SLUG: "team",
        ARCHON_PROJECT_SLUG: "archon"
      },
      findLatestRun(workspaceSlug, projectSlug) {
        return store.findLatestRun({ workspaceSlug, projectSlug });
      },
      async findProjectContext(workspaceSlug, projectSlug) {
        return store.getProjectContext({ workspaceSlug, projectSlug });
      },
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getExecutionPlan(runId, staleAfterHours) {
        return service.getExecutionPlan(runId, { staleAfterHours });
      },
      applyRecovery(runId, actionIds, staleAfterHours) {
        return service.applyRecovery(runId, actionIds, { staleAfterHours });
      },
      getProjectRuntimeRegistration(projectId) {
        return store.getProjectRuntimeRegistration(projectId);
      },
      inspectReviewIdentity: async () => ({
        authorityLabel: "derived_only" as const,
        adapterConfigured: true,
        adapterExists: true,
        availableBackends: [],
        bindingsPresent: true,
        bindingsPath: path.join(directory, ".archon/review-identity-bindings.json"),
        bindingsUseShippedTemplate: false,
        liveTrustReady: true,
        notes: []
      }),
      inspectQdrant: async () => ({
        ok: true,
        summary: "qdrant reachable"
      })
    });

    const repairedRuntimeState = await store.getProjectRuntimeState(context.project.id);
    assert.equal(result.repair.status, "repaired");
    assert.ok(
      result.repair.stepsApplied.includes("clear stale persisted seed failure metadata after authoritative proof")
    );
    assert.deepEqual(result.repair.integrityRepairsAttempted, [
      "reconcile authoritative runtime task state",
      "clear stale persisted seed failure metadata after authoritative proof"
    ]);
    assert.deepEqual(result.repair.integrityRepairsApplied, [
      "reconcile authoritative runtime task state",
      "clear stale persisted seed failure metadata after authoritative proof"
    ]);
    assert.equal(repairedRuntimeState?.metadata?.seedFailure, undefined);
    assert.equal(repairedRuntimeState?.metadata?.lastIntegrityRepair?.kind, "runtime_metadata_cleanup");
    assert.match(
      String(repairedRuntimeState?.metadata?.lastIntegrityRepair?.summary ?? ""),
      /cleared stale persisted seed failure metadata/i
    );

    const after = await executeStatusCommandFromArgs(["--run-id", run.id], {
      cwd: directory,
      env: process.env,
      getStatusSnapshot(runId) {
        return service.getStatus(runId);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      }
    });
    assert.notEqual(after.integrity.status, "contradicted");
    assert.equal(after.integrity.runtimeState?.seedFailure, undefined);
    assert.equal(after.integrity.runtimeState?.lastIntegrityRepair?.kind, "runtime_metadata_cleanup");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow integrity: orphan-lock recovery releases the owning lock across runs", async () => {
  const store = new MemoryStore();
  const service = new ArchonCoreService(store);

  const orphanRun = await service.intakeRequest({
    workspaceSlug: "team",
    projectSlug: "archon",
    actor: "ceo",
    title: "Leave stale lock",
    request: "Create an orphaned write-scope lock."
  });
  await service.createTaskGraph(orphanRun.id, [taskPacket({ taskId: "task-owner", allowedWriteScope: [".archon/work"] })]);
  await service.claimTask(orphanRun.id, "task-owner", "planner");

  const activeLocksBefore = await store.getActiveLocks(orphanRun.projectId);
  assert.equal(activeLocksBefore.length, 1);

  const currentRun = await service.intakeRequest({
    workspaceSlug: "team",
    projectSlug: "archon",
    actor: "ceo",
    title: "Recover stale lock",
    request: "Inspect and recover cross-run orphan locks."
  });
  await service.createTaskGraph(currentRun.id, [taskPacket({ taskId: "recovery", allowedWriteScope: ["docs/plans"] })]);

  const inspection = await service.inspectRecovery(currentRun.id, { staleAfterHours: 1 });
  const orphanAction = inspection.actions.find((action) => action.kind === "release_orphan_lock");
  assert.ok(orphanAction);

  await service.applyRecovery(currentRun.id, [orphanAction.id], { staleAfterHours: 1 });

  const activeLocksAfter = await store.getActiveLocks(orphanRun.projectId);
  assert.deepEqual(activeLocksAfter, []);
});

// ---- seeded provenance tests ----

function buildSeedHarness() {
  const store = new MemoryStore();
  const seededService = new ArchonCoreService(store, {
    resolveReviewActionContext: createWorkflowProofSeedResolver(),
    reviewSource: "seed"
  });
  return { store, seededService };
}

async function runSuccessfulSeed(
  store: MemoryStore,
  seededService: ArchonCoreService,
  taskId: string
): Promise<{ runId: string }> {
  await store.ensureProjectContext({ workspaceSlug: "team", projectSlug: "archon" });
  const result = await executeSeedWorkflowProofCommandFromArgs(
    ["--workspace-slug", "team", "--project-slug", "archon", "--task-id", taskId],
    {
      env: process.env,
      intakeRequest(input) {
        return seededService.intakeRequest(input);
      },
      getProjectContext(params) {
        return store.getProjectContext(params);
      },
      getProjectRuntimeState(projectId) {
        return store.getProjectRuntimeState(projectId);
      },
      saveProjectRuntimeState(state) {
        return store.saveProjectRuntimeState(state);
      },
      createTaskGraph(runId, tasks) {
        return seededService.createTaskGraph(runId, tasks);
      },
      claimTask(runId, tid, actor) {
        return seededService.claimTask(runId, tid, actor);
      },
      submitHandoff(runId, tid, handoff) {
        return seededService.submitHandoff(runId, tid, handoff);
      },
      recordReview(runId, tid, actor, review) {
        return seededService.recordReview(runId, tid, actor, review);
      },
      failTask(runId, tid, reason) {
        return seededService.failTask(runId, tid, reason);
      },
      getStatusSnapshot(runId) {
        return seededService.getStatus(runId);
      },
      getReviews(runId, tid) {
        return store.getReviews(runId, tid);
      },
      getApprovals(runId, tid) {
        return store.getApprovals(runId, tid);
      }
    }
  );
  return { runId: result.runId };
}

test("workflow integrity: seed flow records reviews with source seed", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-seed-assurance");

  const reviews = await store.getReviews(runId, "task-seed-assurance");
  assert.ok(reviews.length > 0, "expected at least one recorded review");
  for (const review of reviews) {
    assert.equal(review.source, "seed", `review for ${review.reviewerRole} should carry seed provenance`);
  }
});

test("workflow integrity: seed flow records approvals with source seed", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-seed-approval-assurance");

  const approvals = await store.getApprovals(runId, "task-seed-approval-assurance");
  assert.ok(approvals.length > 0, "expected at least one recorded approval");
  for (const approval of approvals) {
    assert.equal(approval.source, "seed", `approval should carry seed provenance`);
  }
});

test("workflow integrity: seed command succeeds end-to-end (allow_seed_failure_recovery)", async () => {
  const { store, seededService } = buildSeedHarness();
  const result = await runSuccessfulSeed(store, seededService, "task-seed-e2e");
  assert.ok(result.runId, "seed should return a runId");

  const snapshot = await seededService.getStatus(result.runId);
  const proofTask = snapshot.tasks.find((t) => t.packet.taskId === "task-seed-e2e");
  assert.ok(proofTask, "seeded task should appear in snapshot");
  assert.equal(proofTask.status, "approved", "seeded task should reach approved status");
});

test("workflow integrity: standalone workflow-proof in default mode rejects seeded reviews", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-proof-reject");

  await assert.rejects(
    () =>
      executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-proof-reject"], {
        env: process.env,
        getStatusSnapshot(id) {
          return seededService.getStatus(id);
        },
        getReviews(id, tid) {
          return store.getReviews(id, tid);
        },
        getApprovals(id, tid) {
          return store.getApprovals(id, tid);
        }
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      assert.match(err.message, /required review provenance is not orchestrator-written/i);
      return true;
    }
  );
});

test("workflow integrity: standalone workflow-proof in default mode rejects seeded approval", async () => {
  // Use a full seeded run (reviews + approval both seeded).
  // The review provenance gate fires first; once reviews are authenticated the approval gate fires.
  // Here we confirm the combined seeded case is rejected via the review gate.
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-approval-gate");

  const approvals = await store.getApprovals(runId, "task-approval-gate");
  assert.ok(
    approvals.some((a) => a.source === "seed"),
    "at least one approval should carry seed provenance"
  );

  await assert.rejects(
    () =>
      executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-approval-gate"], {
        env: process.env,
        getStatusSnapshot(id) {
          return seededService.getStatus(id);
        },
        getReviews(id, tid) {
          return store.getReviews(id, tid);
        },
        getApprovals(id, tid) {
          return store.getApprovals(id, tid);
        }
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      // The review provenance gate fires before the approval gate.
      assert.match(
        err.message,
        /provenance is not orchestrator-written|must be orchestrator-written approved/i
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// AC11: handoff presence check in workflow-proof
// ---------------------------------------------------------------------------

test("workflow integrity: AC11 — proof passes when no managed invocations exist (getAgentHandoffCheck not provided)", async () => {
  // Without getAgentHandoffCheck, the AC11 check is simply skipped (opt-in gate).
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ac11-no-hook");

  // Should not throw: no getAgentHandoffCheck provided
  await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ac11-no-hook"], {
    env: process.env,
    integrityCheckMode: "allow_seed_failure_recovery",
    getStatusSnapshot(id) {
      return seededService.getStatus(id);
    },
    getReviews(id, tid) {
      return store.getReviews(id, tid);
    },
    getApprovals(id, tid) {
      return store.getApprovals(id, tid);
    }
    // getAgentHandoffCheck deliberately omitted
  });
});

test("workflow integrity: AC11 — proof passes when no invocations exist for the task", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ac11-no-invocations");

  // Should not throw: hasInvocations=false → check skipped
  await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ac11-no-invocations"], {
    env: process.env,
    integrityCheckMode: "allow_seed_failure_recovery",
    getStatusSnapshot(id) {
      return seededService.getStatus(id);
    },
    getReviews(id, tid) {
      return store.getReviews(id, tid);
    },
    getApprovals(id, tid) {
      return store.getApprovals(id, tid);
    },
    getAgentHandoffCheck(_taskId) {
      return Promise.resolve({ hasInvocations: false, hasContextThreshold: false, hasHandoff: false });
    }
  });
});

test("workflow integrity: AC11 — proof passes when threshold crossed and handoff committed", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ac11-handoff-present");

  // Should not throw: threshold crossed AND handoff committed
  await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ac11-handoff-present"], {
    env: process.env,
    integrityCheckMode: "allow_seed_failure_recovery",
    getStatusSnapshot(id) {
      return seededService.getStatus(id);
    },
    getReviews(id, tid) {
      return store.getReviews(id, tid);
    },
    getApprovals(id, tid) {
      return store.getApprovals(id, tid);
    },
    getAgentHandoffCheck(_taskId) {
      return Promise.resolve({ hasInvocations: true, hasContextThreshold: true, hasHandoff: true });
    }
  });
});

test("workflow integrity: AC11 — proof fails when threshold crossed and no handoff committed", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ac11-missing-handoff");

  await assert.rejects(
    () =>
      executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ac11-missing-handoff"], {
        env: process.env,
        integrityCheckMode: "allow_seed_failure_recovery",
        getStatusSnapshot(id) {
          return seededService.getStatus(id);
        },
        getReviews(id, tid) {
          return store.getReviews(id, tid);
        },
        getApprovals(id, tid) {
          return store.getApprovals(id, tid);
        },
        getAgentHandoffCheck(_taskId) {
          return Promise.resolve({ hasInvocations: true, hasContextThreshold: true, hasHandoff: false });
        }
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      assert.match(err.message, /AC11/i);
      assert.match(err.message, /handoff/i);
      return true;
    }
  );
});

test("workflow integrity: AC11 — proof passes when threshold NOT crossed (no handoff needed)", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ac11-below-threshold");

  // Should not throw: threshold not crossed → no handoff required
  await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ac11-below-threshold"], {
    env: process.env,
    integrityCheckMode: "allow_seed_failure_recovery",
    getStatusSnapshot(id) {
      return seededService.getStatus(id);
    },
    getReviews(id, tid) {
      return store.getReviews(id, tid);
    },
    getApprovals(id, tid) {
      return store.getApprovals(id, tid);
    },
    getAgentHandoffCheck(_taskId) {
      return Promise.resolve({ hasInvocations: true, hasContextThreshold: false, hasHandoff: false });
    }
  });
});

// ---------------------------------------------------------------------------
// SDD §18.3: review independence — implementer ≠ reviewer; subagent cannot
// approve its parent. Enforced in workflow-proof via getReviewIndependenceCheck.
// ---------------------------------------------------------------------------

test("workflow integrity: §18.3 — proof passes when the independence check is not provided (opt-in gate)", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ind-no-hook");

  await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ind-no-hook"], {
    env: process.env,
    integrityCheckMode: "allow_seed_failure_recovery",
    getStatusSnapshot(id) {
      return seededService.getStatus(id);
    },
    getReviews(id, tid) {
      return store.getReviews(id, tid);
    },
    getApprovals(id, tid) {
      return store.getApprovals(id, tid);
    }
    // getReviewIndependenceCheck deliberately omitted
  });
});

test("workflow integrity: §18.3 — proof passes when no managed invocations exist (hasInvocations=false)", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ind-no-invocations");

  await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ind-no-invocations"], {
    env: process.env,
    integrityCheckMode: "allow_seed_failure_recovery",
    getStatusSnapshot(id) {
      return seededService.getStatus(id);
    },
    getReviews(id, tid) {
      return store.getReviews(id, tid);
    },
    getApprovals(id, tid) {
      return store.getApprovals(id, tid);
    },
    getReviewIndependenceCheck(_taskId) {
      return Promise.resolve({
        hasInvocations: false,
        implementerRoles: [],
        subagentReviewerRoles: []
      });
    }
  });
});

test("workflow integrity: §18.3 — proof passes when implementer role does not overlap any review gate", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ind-independent");

  await executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ind-independent"], {
    env: process.env,
    integrityCheckMode: "allow_seed_failure_recovery",
    getStatusSnapshot(id) {
      return seededService.getStatus(id);
    },
    getReviews(id, tid) {
      return store.getReviews(id, tid);
    },
    getApprovals(id, tid) {
      return store.getApprovals(id, tid);
    },
    getReviewIndependenceCheck(_taskId) {
      return Promise.resolve({
        hasInvocations: true,
        implementerRoles: ["backend_engineer"],
        subagentReviewerRoles: []
      });
    }
  });
});

test("workflow integrity: §18.3 — proof fails when an implementing role also satisfied a required review gate", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ind-role-overlap");

  await assert.rejects(
    () =>
      executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ind-role-overlap"], {
        env: process.env,
        integrityCheckMode: "allow_seed_failure_recovery",
        getStatusSnapshot(id) {
          return seededService.getStatus(id);
        },
        getReviews(id, tid) {
          return store.getReviews(id, tid);
        },
        getApprovals(id, tid) {
          return store.getApprovals(id, tid);
        },
        getReviewIndependenceCheck(_taskId) {
          // The seeded task requires reviewer/security_reviewer/qa_engineer gates;
          // here the implementing specialist owner WAS the reviewer → not independent.
          return Promise.resolve({
            hasInvocations: true,
            implementerRoles: ["reviewer"],
            subagentReviewerRoles: []
          });
        }
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      assert.match(err.message, /18\.3|independen/i);
      assert.match(err.message, /reviewer/);
      return true;
    }
  );
});

test("workflow integrity: §18.3 — proof fails and names the specific overlapping role among several implementers", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ind-multi-role");

  await assert.rejects(
    () =>
      executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ind-multi-role"], {
        env: process.env,
        integrityCheckMode: "allow_seed_failure_recovery",
        getStatusSnapshot(id) {
          return seededService.getStatus(id);
        },
        getReviews(id, tid) {
          return store.getReviews(id, tid);
        },
        getApprovals(id, tid) {
          return store.getApprovals(id, tid);
        },
        getReviewIndependenceCheck(_taskId) {
          // Two implementing roles; only qa_engineer overlaps a required gate.
          return Promise.resolve({
            hasInvocations: true,
            implementerRoles: ["backend_engineer", "qa_engineer"],
            subagentReviewerRoles: []
          });
        }
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      assert.match(err.message, /qa_engineer/);
      assert.doesNotMatch(err.message, /backend_engineer/);
      return true;
    }
  );
});

test("workflow integrity: §18.3 — proof fails when a reviewer invocation is a subagent of the implementer", async () => {
  const { store, seededService } = buildSeedHarness();
  const { runId } = await runSuccessfulSeed(store, seededService, "task-ind-subagent");

  await assert.rejects(
    () =>
      executeWorkflowProofCommandFromArgs(["--run-id", runId, "--task-id", "task-ind-subagent"], {
        env: process.env,
        integrityCheckMode: "allow_seed_failure_recovery",
        getStatusSnapshot(id) {
          return seededService.getStatus(id);
        },
        getReviews(id, tid) {
          return store.getReviews(id, tid);
        },
        getApprovals(id, tid) {
          return store.getApprovals(id, tid);
        },
        getReviewIndependenceCheck(_taskId) {
          // reviewer invocation descends from the implementing invocation → subagent approving parent
          return Promise.resolve({
            hasInvocations: true,
            implementerRoles: ["backend_engineer"],
            subagentReviewerRoles: ["reviewer"]
          });
        }
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      assert.match(err.message, /18\.3|independen|subagent/i);
      return true;
    }
  );
});
