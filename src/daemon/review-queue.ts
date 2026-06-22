// Daemon split (by concern): review-queue / operator-action-queue state — reading
// queued review and operator-action inputs, archiving consumed/failed/stale entries,
// and matching operator continuation actions. Leaf module (no deps back into
// daemon.ts). Behavior-preserving move from daemon.ts.
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectCommandFlagValues, resolveCommandFlag } from "../workflow.ts";
import { normalizeRecordReviewCommandInput } from "../review.ts";
import type { ContinueAnalysisDirectiveClassification } from "../admin/autonomous-summary.ts";
import type { EnvShape } from "../workflow.ts";
import type { RecordReviewCommandInput } from "../review.ts";
import type { RunExecutionPlan } from "../domain/types.ts";

export async function readLoopReviewCommandInputs(
  args: readonly string[],
  options: {
    cwd?: string | undefined;
  } = {}
): Promise<readonly RecordReviewCommandInput[]> {
  const cwd = options.cwd ?? process.cwd();
  const inputArgs = collectCommandFlagValues(args, "--review-input");

  return Promise.all(
    inputArgs.map(async (inputArg) => {
      const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(cwd, inputArg);
      return normalizeRecordReviewCommandInput(await readFile(inputPath, "utf8"));
    })
  );
}


export interface DaemonReviewQueueEntry {
  filePath: string;
  command: RecordReviewCommandInput;
}


export interface FailedDaemonReviewQueueEntry {
  filePath: string;
  error: string;
}


export interface StaleDaemonReviewQueueEntry {
  filePath: string;
  reason: string;
}


export interface OperatorContinuationActionCommand {
  runId: string;
  taskId: string;
  blockerKind: "operator_required_continuation";
  action: {
    kind: "continue_with_analysis";
    targetId: string;
    source?: "blocking_gap" | "progress_proof" | "checkpoint" | undefined;
    sourceId?: string | undefined;
    operatorNotes: string;
  };
}


export interface DaemonOperatorActionQueueEntry {
  filePath: string;
  command: OperatorContinuationActionCommand;
}


export interface FailedDaemonOperatorActionQueueEntry {
  filePath: string;
  error: string;
}


export function resolveDaemonReviewInputDir(args: readonly string[], options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicit = resolveCommandFlag(args, "--review-input-dir") ?? env.ARCHON_REVIEW_INPUT_DIR;
  const candidate = explicit ?? path.join(".archon", "review-actions");
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}


export function resolveDaemonOperatorActionDir(args: readonly string[], options: {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
} = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicit = resolveCommandFlag(args, "--operator-action-dir") ?? env.ARCHON_OPERATOR_ACTION_DIR;
  const candidate = explicit ?? path.join(".archon", "operator-actions");
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}


export function normalizeOperatorContinuationActionCommand(raw: string): OperatorContinuationActionCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`operator action input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("operator action input must be a JSON object");
  }

  const candidate = parsed as Record<string, unknown>;
  const runId = typeof candidate.runId === "string" && candidate.runId.trim().length > 0 ? candidate.runId.trim() : undefined;
  const taskId = typeof candidate.taskId === "string" && candidate.taskId.trim().length > 0 ? candidate.taskId.trim() : undefined;
  if (!runId) {
    throw new Error("operator action runId is required");
  }
  if (!taskId) {
    throw new Error("operator action taskId is required");
  }
  if (candidate.blockerKind !== "operator_required_continuation") {
    throw new Error("operator action blockerKind must be operator_required_continuation");
  }
  const action = candidate.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("operator action payload is required");
  }
  const actionCandidate = action as Record<string, unknown>;
  if (actionCandidate.kind !== "continue_with_analysis") {
    throw new Error("operator action kind must be continue_with_analysis");
  }
  const targetId =
    typeof actionCandidate.targetId === "string" && actionCandidate.targetId.trim().length > 0
      ? actionCandidate.targetId.trim()
      : undefined;
  const source =
    actionCandidate.source === "blocking_gap" ||
    actionCandidate.source === "progress_proof" ||
    actionCandidate.source === "checkpoint"
      ? actionCandidate.source
      : undefined;
  const sourceId =
    typeof actionCandidate.sourceId === "string" && actionCandidate.sourceId.trim().length > 0
      ? actionCandidate.sourceId.trim()
      : undefined;
  const operatorNotes =
    typeof actionCandidate.operatorNotes === "string" && actionCandidate.operatorNotes.trim().length > 0
      ? actionCandidate.operatorNotes.trim()
      : undefined;
  if (!targetId) {
    throw new Error("operator action action.targetId is required");
  }
  if (!operatorNotes) {
    throw new Error("operator action action.operatorNotes is required");
  }

  return {
    runId,
    taskId,
    blockerKind: "operator_required_continuation",
    action: {
      kind: "continue_with_analysis",
      targetId,
      source,
      sourceId,
      operatorNotes
    }
  };
}


export async function readDaemonReviewQueueState(reviewInputDir: string): Promise<{
  entries: DaemonReviewQueueEntry[];
  failedEntries: FailedDaemonReviewQueueEntry[];
}> {
  let entries: string[] = [];
  try {
    entries = await readdir(reviewInputDir);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { entries: [], failedEntries: [] };
    }
    throw error;
  }

  const queueEntries: DaemonReviewQueueEntry[] = [];
  const failedEntries: FailedDaemonReviewQueueEntry[] = [];

  for (const entry of entries.filter((candidate) => candidate.endsWith(".json")).sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(reviewInputDir, entry);
    try {
      queueEntries.push({
        filePath,
        command: normalizeRecordReviewCommandInput(await readFile(filePath, "utf8"))
      });
    } catch (error) {
      failedEntries.push({
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    entries: queueEntries,
    failedEntries
  };
}


export async function readDaemonOperatorActionQueueState(operatorActionDir: string): Promise<{
  entries: DaemonOperatorActionQueueEntry[];
  failedEntries: FailedDaemonOperatorActionQueueEntry[];
}> {
  let entries: string[] = [];
  try {
    entries = await readdir(operatorActionDir);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { entries: [], failedEntries: [] };
    }
    throw error;
  }

  const queueEntries: DaemonOperatorActionQueueEntry[] = [];
  const failedEntries: FailedDaemonOperatorActionQueueEntry[] = [];

  for (const entry of entries.filter((candidate) => candidate.endsWith(".json")).sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(operatorActionDir, entry);
    try {
      queueEntries.push({
        filePath,
        command: normalizeOperatorContinuationActionCommand(await readFile(filePath, "utf8"))
      });
    } catch (error) {
      failedEntries.push({
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    entries: queueEntries,
    failedEntries
  };
}


export async function archiveConsumedDaemonReviewQueueEntries(
  consumedEntries: readonly DaemonReviewQueueEntry[],
  cwd: string
): Promise<void> {
  if (consumedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "processed-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of consumedEntries) {
    const archivedPath = path.join(archiveDir, path.basename(entry.filePath));
    await rename(entry.filePath, archivedPath);
  }
}


export async function archiveConsumedDaemonOperatorActionQueueEntries(
  consumedEntries: readonly DaemonOperatorActionQueueEntry[],
  cwd: string
): Promise<void> {
  if (consumedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "processed-operator-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of consumedEntries) {
    const archivedPath = path.join(archiveDir, path.basename(entry.filePath));
    await rename(entry.filePath, archivedPath);
  }
}


export async function archiveFailedDaemonReviewQueueEntries(
  failedEntries: readonly FailedDaemonReviewQueueEntry[],
  cwd: string,
  nowValue: string
): Promise<void> {
  if (failedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "failed-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of failedEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.error.json`),
      `${JSON.stringify(
        {
          file: baseName,
          error: entry.error,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}


export async function archiveFailedDaemonOperatorActionQueueEntries(
  failedEntries: readonly FailedDaemonOperatorActionQueueEntry[],
  cwd: string,
  nowValue: string
): Promise<void> {
  if (failedEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "failed-operator-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of failedEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.error.json`),
      `${JSON.stringify(
        {
          file: baseName,
          error: entry.error,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}


export function matchesDaemonOperatorContinuationAction(input: {
  entry: DaemonOperatorActionQueueEntry;
  runId: string;
  taskId: string;
  directive: Extract<RunExecutionPlan["directive"], { kind: "continue_analysis" }>;
  classification: ContinueAnalysisDirectiveClassification;
}): boolean {
  if (
    input.entry.command.runId !== input.runId ||
    input.entry.command.taskId !== input.taskId ||
    input.entry.command.blockerKind !== "operator_required_continuation"
  ) {
    return false;
  }

  if (input.entry.command.action.targetId !== input.directive.targetId) {
    return false;
  }

  if (input.entry.command.action.source && input.entry.command.action.source !== input.directive.source) {
    return false;
  }

  const expectedSourceId =
    input.classification.action?.kind === "resume_target" ? input.classification.action.sourceId : undefined;
  if ((input.entry.command.action.sourceId ?? undefined) !== (expectedSourceId ?? undefined)) {
    return false;
  }

  return true;
}


export async function archiveStaleDaemonReviewQueueEntries(
  staleEntries: readonly StaleDaemonReviewQueueEntry[],
  cwd: string,
  nowValue: string,
  expectedReviewTargets: readonly string[]
): Promise<void> {
  if (staleEntries.length === 0) {
    return;
  }

  const archiveDir = path.join(cwd, ".archon", "work", "daemon", "stale-review-actions");
  await mkdir(archiveDir, { recursive: true });

  for (const entry of staleEntries) {
    const baseName = path.basename(entry.filePath);
    const archivedPath = path.join(archiveDir, baseName);
    await rename(entry.filePath, archivedPath);
    await writeFile(
      path.join(archiveDir, `${baseName}.reason.json`),
      `${JSON.stringify(
        {
          file: baseName,
          reason: entry.reason,
          expectedReviewTargets,
          archivedAt: nowValue
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}
