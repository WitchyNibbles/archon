// Daemon split (by concern, 6c): the supervisor's leaf helpers — pure builders, the
// review-queue-status reader, review-actor binding parsing, trusted review-auth
// resolution, and the two action-file writers. Extracted verbatim from supervisor.ts
// to keep that file under the 800-line cap; the command orchestrator
// (executeSupervisorCommandFromArgs) stays in supervisor.ts and imports these.
//
// Runtime leaf: no back-references to daemon.ts or supervisor.ts.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectCommandFlagValues } from "../cli-flags.ts";
import type { EnvShape } from "../workflow.ts";
import { isGateReviewRole } from "../domain/contracts.ts";
import type { ReviewRecord } from "../domain/types.ts";
import {
  bindingsUsePlaceholderContent,
  isRepoTemplateReviewIdentityPath,
  resolveRequiredReviewIdentityFilePath
} from "../review.ts";
import { loadReviewIdentityBindings } from "../core/review-context.ts";


export function buildSupervisorOperatorNotes(input: {
  targetId: string;
  summary: string;
  nextActions: readonly string[];
  override?: string | undefined;
}): string {
  if (input.override?.trim()) {
    return input.override.trim();
  }

  const lines = [`Local supervisor authorized advisory continuation for ${input.targetId}.`];
  if (input.summary.trim()) {
    lines.push(`Reason: ${input.summary.trim()}`);
  }
  if (input.nextActions.length > 0) {
    lines.push(`Context: ${input.nextActions.join(" | ")}`);
  }
  return lines.join(" ");
}


export async function writeSupervisorOperatorContinuationAction(input: {
  cwd: string;
  operatorActionDir: string;
  runId: string;
  taskId: string;
  targetId: string;
  source: "blocking_gap" | "progress_proof" | "checkpoint";
  sourceId?: string | undefined;
  operatorNotes: string;
  cycle: number;
  nowValue: string;
}): Promise<string> {
  await mkdir(input.operatorActionDir, { recursive: true });
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTimestamp = input.nowValue.replace(/[^0-9A-Za-z]/g, "");
  const fileName = `supervisor-${String(input.cycle).padStart(2, "0")}-${safeRunId}-${safeTaskId}-${safeTimestamp}.json`;
  const filePath = path.join(input.operatorActionDir, fileName);
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        runId: input.runId,
        taskId: input.taskId,
        blockerKind: "operator_required_continuation",
        action: {
          kind: "continue_with_analysis",
          targetId: input.targetId,
          source: input.source,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          operatorNotes: input.operatorNotes
        },
        supervisor: {
          kind: "local_supervisor",
          generatedAt: input.nowValue
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path.relative(input.cwd, filePath) || path.basename(filePath);
}


export interface DaemonReviewQueueStatusObservation {
  authorityLabel: "derived_only";
  state: "processed" | "blocked" | "failed" | "invalid";
  reviewInputDir?: string | undefined;
  reason: string;
  expectedReviewTargets: string[];
  queuedFiles: string[];
  consumedFiles: string[];
  failedFiles: { file: string; error: string }[];
  staleFiles: { file: string; reason: string }[];
  updatedAt?: string | undefined;
}


export async function readDaemonReviewQueueStatus(
  cwd: string
): Promise<DaemonReviewQueueStatusObservation | undefined> {
  const statusPath = path.join(cwd, ".archon", "work", "daemon", "review-queue-status.json");
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state =
      parsed.state === "processed" || parsed.state === "blocked" || parsed.state === "failed"
        ? parsed.state
        : "invalid";
    const reviewInputDir = typeof parsed.reviewInputDir === "string" ? parsed.reviewInputDir : undefined;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason
        : "daemon review queue status is missing a valid reason";
    const expectedReviewTargets = Array.isArray(parsed.expectedReviewTargets)
      ? parsed.expectedReviewTargets.filter((value): value is string => typeof value === "string")
      : [];
    const queuedFiles = Array.isArray(parsed.queuedFiles)
      ? parsed.queuedFiles.filter((value): value is string => typeof value === "string")
      : [];
    const consumedFiles = Array.isArray(parsed.consumedFiles)
      ? parsed.consumedFiles.filter((value): value is string => typeof value === "string")
      : [];
    const failedFiles = Array.isArray(parsed.failedFiles)
      ? parsed.failedFiles.flatMap((value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  file: typeof (value as { file?: unknown }).file === "string" ? (value as { file: string }).file : "unknown",
                  error:
                    typeof (value as { error?: unknown }).error === "string"
                      ? (value as { error: string }).error
                      : "unknown"
                }
              ]
            : []
        )
      : [];
    const staleFiles = Array.isArray(parsed.staleFiles)
      ? parsed.staleFiles.flatMap((value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  file: typeof (value as { file?: unknown }).file === "string" ? (value as { file: string }).file : "unknown",
                  reason:
                    typeof (value as { reason?: unknown }).reason === "string"
                      ? (value as { reason: string }).reason
                      : "unknown"
                }
              ]
            : []
        )
      : [];
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;

    return {
      authorityLabel: "derived_only",
      state,
      reviewInputDir,
      reason,
      expectedReviewTargets,
      queuedFiles,
      consumedFiles,
      failedFiles,
      staleFiles,
      updatedAt
    };
  } catch (error) {
    return {
      authorityLabel: "derived_only",
      state: "invalid",
      reason: `failed to parse daemon review queue status: ${error instanceof Error ? error.message : String(error)}`,
      expectedReviewTargets: [],
      queuedFiles: [],
      consumedFiles: [],
      failedFiles: [],
      staleFiles: [],
      updatedAt: undefined
    };
  }
}


export function parseSupervisorReviewActorBindings(
  args: readonly string[],
  env: EnvShape
): Partial<Record<ReviewRecord["reviewerRole"], string>> {
  const bindings: Partial<Record<ReviewRecord["reviewerRole"], string>> = {};
  const mappingArgs = collectCommandFlagValues(args, "--review-actor");
  for (const mapping of mappingArgs) {
    const separatorIndex = mapping.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === mapping.length - 1) {
      throw new Error(`Invalid --review-actor value: ${mapping}`);
    }
    const role = mapping.slice(0, separatorIndex).trim();
    const actor = mapping.slice(separatorIndex + 1).trim();
    if (!isGateReviewRole(role)) {
      throw new Error(`Invalid review role in --review-actor: ${role}`);
    }
    if (!actor) {
      throw new Error(`Invalid empty actor in --review-actor: ${mapping}`);
    }
    bindings[role] = actor;
  }

  const envBindings: Array<[ReviewRecord["reviewerRole"], string | undefined]> = [
    ["reviewer", env.ARCHON_SUPERVISOR_REVIEWER_ACTOR],
    ["security_reviewer", env.ARCHON_SUPERVISOR_SECURITY_REVIEWER_ACTOR],
    ["qa_engineer", env.ARCHON_SUPERVISOR_QA_ENGINEER_ACTOR]
  ];
  for (const [role, actor] of envBindings) {
    if (!bindings[role] && actor?.trim()) {
      bindings[role] = actor.trim();
    }
  }

  return bindings;
}


export async function resolveSupervisorReviewAuthContext(input: {
  cwd: string;
  env: EnvShape;
  actor: string;
}): Promise<{ provider: string; subject: string; verified: true } | undefined> {
  let bindingsPath: string;
  try {
    bindingsPath = await resolveRequiredReviewIdentityFilePath({
      envVarName: "ARCHON_REVIEW_IDENTITY_BINDINGS",
      envVarValue: input.env.ARCHON_REVIEW_IDENTITY_BINDINGS,
      liveRelativePath: ".archon/review-identity-bindings.json",
      cwd: input.cwd
    });
  } catch {
    return undefined;
  }

  if (isRepoTemplateReviewIdentityPath(bindingsPath)) {
    return undefined;
  }

  if (await bindingsUsePlaceholderContent(bindingsPath)) {
    return undefined;
  }

  const bindings = await loadReviewIdentityBindings(bindingsPath);
  const matches = bindings.bindings
    .filter((binding) => binding.actors.some((actorBinding) => actorBinding.actor === input.actor))
    .map((binding) => ({
      provider: binding.principal.provider,
      subject: binding.principal.subject
    }))
    .filter(
      (binding, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.provider === binding.provider && candidate.subject === binding.subject
        ) === index
    );

  if (matches.length !== 1) {
    return undefined;
  }

  return {
    provider: matches[0]!.provider,
    subject: matches[0]!.subject,
    verified: true
  };
}


export async function writeSupervisorReviewAction(input: {
  cwd: string;
  reviewInputDir: string;
  runId: string;
  taskId: string;
  reviewRole: ReviewRecord["reviewerRole"];
  actor: string;
  authContext?: { provider: string; subject: string; verified: true } | undefined;
  cycle: number;
  nowValue: string;
}): Promise<string> {
  await mkdir(input.reviewInputDir, { recursive: true });
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeTimestamp = input.nowValue.replace(/[^0-9A-Za-z]/g, "");
  const fileName = `supervisor-${String(input.cycle).padStart(2, "0")}-${safeRunId}-${safeTaskId}-${input.reviewRole}-${safeTimestamp}.json`;
  const filePath = path.join(input.reviewInputDir, fileName);
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        runId: input.runId,
        taskId: input.taskId,
        actor: input.actor,
        review: {
          reviewerRole: input.reviewRole,
          state: "passed",
          severity: "low",
          findings: []
        },
        ...(input.authContext ? { authContext: input.authContext } : {}),
        supervisor: {
          kind: "local_supervisor",
          generatedAt: input.nowValue
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path.relative(input.cwd, filePath) || path.basename(filePath);
}
