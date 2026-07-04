// Shared project-runtime-state primitives.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4) so
// that both ArchonCoreService and the extracted store modules (autonomous-execution
// store, task-lifecycle manager) depend on ONE copy of these helpers rather than
// importing across each other (which would create service.ts <-> module import
// cycles). Keep this module dependency-light: pure primitives only, no store.
//
// The run-status + task-queue projections (deriveRunStatus, buildRuntimeTaskQueue)
// live in a sibling module — ./task-queue-projection.ts — not here, so this file's
// max-lines ratchet stays put; both share the same cycle-break rationale.

import type { TaskQueue } from "../archon/task-queue.ts";
import type { AutonomousExecutionState, ProjectRuntimeMetadata } from "../domain/types.ts";

export function timestamp(): string {
  return new Date().toISOString();
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function buildDefaultTaskQueue(): TaskQueue {
  return {
    project_status: "idle",
    current_task_id: null,
    tasks: []
  };
}

export function buildDefaultProductState(): Record<string, unknown> {
  return {
    status: "idle",
    items: []
  };
}

export function asProjectRuntimeMetadata(
  metadata: ProjectRuntimeMetadata | Record<string, unknown> | undefined
): ProjectRuntimeMetadata {
  return { ...(metadata ?? {}) };
}

export function readAutonomousExecutionState(
  metadata: ProjectRuntimeMetadata | Record<string, unknown> | undefined
): AutonomousExecutionState | undefined {
  const candidate = (metadata as ProjectRuntimeMetadata | undefined)?.autonomousExecution;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  return {
    ...candidate,
    understandingMaps: candidate.understandingMaps ?? [],
    runtimeTraces: candidate.runtimeTraces ?? [],
    duplicateFamilies: candidate.duplicateFamilies ?? [],
    architectureDecisions: candidate.architectureDecisions ?? [],
    migrationLedger: candidate.migrationLedger ?? [],
    parityMatrix: candidate.parityMatrix ?? [],
    externalEvals: candidate.externalEvals ?? [],
    sensitiveActionControls: candidate.sensitiveActionControls ?? []
  };
}
