import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executeDoctorRepairCommandFromArgs,
  executeSeedModernizationProofCommandFromArgs,
  executeSeedWorkflowProofCommandFromArgs,
  executeStatusCommandFromArgs
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

test("workflow integrity: modernization proof seeding failure cleans up lock-bearing partial state", async () => {
  const store = new MemoryStore();
  const service = new ArchonCoreService(store);
  const configurationFailure = new Error("modernization configuration exploded");
  await store.ensureProjectContext({
    workspaceSlug: "team",
    projectSlug: "archon"
  });

  await assert.rejects(
    () =>
      executeSeedModernizationProofCommandFromArgs(
        ["--workspace-slug", "team", "--project-slug", "archon", "--task-id", "task-modernization"],
        {
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
            return undefined;
          },
          failTask(runId, taskId, reason) {
            return service.failTask(runId, taskId, reason);
          },
          async configureAutonomousExecution() {
            throw configurationFailure;
          },
          async upsertCoverageItems() {
            throw new Error("unexpected coverage upsert after configuration failure");
          },
          async upsertUnderstandingMaps() {
            throw new Error("unexpected understanding upsert after configuration failure");
          },
          async upsertRuntimeTraces() {
            throw new Error("unexpected trace upsert after configuration failure");
          },
          async upsertDuplicateFamilies() {
            throw new Error("unexpected duplicate-family upsert after configuration failure");
          },
          async upsertArchitectureDecisions() {
            throw new Error("unexpected architecture-decision upsert after configuration failure");
          },
          async upsertMigrationLedgerEntries() {
            throw new Error("unexpected migration-ledger upsert after configuration failure");
          },
          async upsertParityRequirements() {
            throw new Error("unexpected parity upsert after configuration failure");
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
        }
      ),
    configurationFailure
  );

  const latestRun = await store.findLatestRun({ workspaceSlug: "team", projectSlug: "archon" });
  assert.ok(latestRun);
  const snapshot = await service.getStatus(latestRun.id);
  const seededTask = snapshot.tasks.find((task) => task.packet.taskId === "task-modernization");
  assert.ok(seededTask);
  assert.notEqual(seededTask.status, "review_blocked");
  assert.deepEqual(snapshot.activeLocks, []);
  const projectContext = await store.getProjectContext({ workspaceSlug: "team", projectSlug: "archon" });
  assert.ok(projectContext);
  const runtimeState = await store.getProjectRuntimeState(projectContext.project.id);
  assert.equal(runtimeState?.activeTaskId, undefined);
  assert.equal(runtimeState?.metadata?.seedFailure?.taskId, "task-modernization");
  assert.match(String(runtimeState?.metadata?.seedFailure?.reason ?? ""), /modernization configuration exploded/i);

  const report = await executeStatusCommandFromArgs(["--run-id", latestRun.id], {
    env: process.env,
    getStatusSnapshot(runId) {
      return service.getStatus(runId);
    },
    getProjectRuntimeState(projectId) {
      return store.getProjectRuntimeState(projectId);
    }
  });
  assert.equal(report.integrity.runtimeState?.seedFailure?.taskId, "task-modernization");
  assert.match(String(report.integrity.runtimeState?.seedFailure?.reason ?? ""), /modernization configuration exploded/i);
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
