// Shared project-runtime-state primitives.
//
// Extracted from core/service.ts (audit F5 / architecture-runtime-debt §3.4) so
// that both ArchonCoreService and the extracted AutonomousExecutionStore module
// depend on ONE copy of these helpers rather than importing across each other
// (which would create a service.ts <-> autonomous-execution-store.ts import
// cycle). Keep this module dependency-light: pure primitives only, no store.

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
