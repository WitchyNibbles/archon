// Daemon split (by concern, 6d): the turn/prompt concern — reading the daemon's
// persisted metadata (session id, last-prompt fingerprint, stagnation), parsing a
// worker turn's JSON message, building the worker prompt (full vs delta), running a
// Codex/Claude CLI turn and parsing its stream-json output, computing the progress
// key, persisting a turn checkpoint, and the prompt/continuation formatting helpers.
//
// Behavior-preserving move from daemon.ts. withDaemonLock and the daemon loop stay in
// daemon.ts; the only back-reference here is the type-only ExecuteDaemonCommandOptions
// (erased at compile time), so no runtime import cycle is introduced.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { buildDirectiveProgressFingerprint } from "../workflow.ts";
import type { EnvShape } from "../workflow.ts";
import type {
  CheckpointRecord,
  ProjectRuntimeStateRecord,
  RunExecutionPlan,
  RunStatusSnapshot,
  TaskPacketInput
} from "../domain/types.ts";
import type { ExecuteDaemonCommandOptions } from "../daemon.ts";


export interface RunCodexTurnInput {
  claudeBin: string;
  cwd: string;
  env: EnvShape;
  prompt: string;
  sessionId?: string | undefined;
}


export interface RunCodexTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface RunCodexTurnResult {
  sessionId?: string | undefined;
  finalMessage?: string | undefined;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Token usage from the `result` event of the stream-json output. Undefined when
   * the event was absent or its usage block was missing or malformed. */
  usage?: RunCodexTurnUsage | undefined;
}


export type DaemonPromptMode = "full" | "delta";


export type DaemonPromptContinuationAction =
  | { kind: "run_workflow_proof"; taskId: string }
  | { kind: "resolve_blocking_gap"; gapId: string; targetId: string }
  | {
      kind: "resume_target";
      targetId: string;
      source?: "blocking_gap" | "progress_proof" | "checkpoint";
      sourceId?: string | undefined;
    };


export type DaemonPromptDirective =
  | RunExecutionPlan["directive"]
  | {
      kind: "continue_analysis";
      targetId: string;
      actions: DaemonPromptContinuationAction[];
    }
  | {
      kind: "dispatch_owner";
      rationale: string[];
    };


export interface ParsedDaemonTurnMessage {
  summary: string;
  status: "completed" | "blocked" | "needs_review" | "needs_followup";
  blockers: string[];
  checkpoint?: {
    evidenceRefs: string[];
    nextActions: string[];
    activeTargets: string[];
    openGaps: string[];
    compressedContextSummary?: string | undefined;
    compressedContextRef?: string | undefined;
    compressedContextSourceRefs: string[];
  } | undefined;
  scopeRequest?: {
    blockedPaths: string[];
    requestedWriteScope: string[];
    reason?: string | undefined;
  } | undefined;
}


export interface DaemonStagnationMetadata {
  runId: string;
  taskId: string;
  directiveKind: RunExecutionPlan["directive"]["kind"];
  progressKey: string;
  count: number;
  updatedAt: string;
  lastStatus?: ParsedDaemonTurnMessage["status"] | undefined;
  lastSummary?: string | undefined;
  lastBlockers?: string[] | undefined;
}


export interface DaemonPromptMetadata {
  taskId?: string | undefined;
  packetFingerprint?: string | undefined;
}


export function readDaemonSessionId(metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined): string | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const sessionId = (candidate as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : undefined;
}


export function readDaemonPromptMetadata(
  metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined
): DaemonPromptMetadata | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const taskId =
    typeof record.lastPromptTaskId === "string" && record.lastPromptTaskId.trim().length > 0
      ? record.lastPromptTaskId.trim()
      : undefined;
  const packetFingerprint =
    typeof record.lastPromptPacketFingerprint === "string" && record.lastPromptPacketFingerprint.trim().length > 0
      ? record.lastPromptPacketFingerprint.trim()
      : undefined;

  if (!taskId && !packetFingerprint) {
    return undefined;
  }

  return {
    taskId,
    packetFingerprint
  };
}


export function readDaemonStagnationMetadata(
  metadata: ProjectRuntimeStateRecord["metadata"] | Record<string, unknown> | undefined
): DaemonStagnationMetadata | undefined {
  const candidate = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).archonDaemon
    : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const stagnation = (candidate as Record<string, unknown>).stagnation;
  if (!stagnation || typeof stagnation !== "object" || Array.isArray(stagnation)) {
    return undefined;
  }

  const record = stagnation as Record<string, unknown>;
  const runId = typeof record.runId === "string" && record.runId.trim().length > 0 ? record.runId.trim() : undefined;
  const taskId = typeof record.taskId === "string" && record.taskId.trim().length > 0 ? record.taskId.trim() : undefined;
  const directiveKind =
    record.directiveKind === "complete" ||
    record.directiveKind === "dispatch_owner" ||
    record.directiveKind === "dispatch_reviews" ||
    record.directiveKind === "apply_recovery" ||
    record.directiveKind === "dispatch_subagents" ||
    record.directiveKind === "rebuild_inventory" ||
    record.directiveKind === "trace_runtime" ||
    record.directiveKind === "checkpoint" ||
    record.directiveKind === "replan_migration" ||
    record.directiveKind === "continue_analysis" ||
    record.directiveKind === "blocked"
      ? record.directiveKind
      : undefined;
  const progressKey =
    typeof record.progressKey === "string" && record.progressKey.trim().length > 0 ? record.progressKey.trim() : undefined;
  const count = typeof record.count === "number" && Number.isInteger(record.count) && record.count > 0 ? record.count : undefined;
  if (!runId || !taskId || !directiveKind || !progressKey || !count) {
    return undefined;
  }

  const status =
    record.lastStatus === "completed" ||
    record.lastStatus === "blocked" ||
    record.lastStatus === "needs_review" ||
    record.lastStatus === "needs_followup"
      ? record.lastStatus
      : undefined;

  return {
    runId,
    taskId,
    directiveKind,
    progressKey,
    count,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    lastStatus: status,
    lastSummary: typeof record.lastSummary === "string" ? record.lastSummary : undefined,
    lastBlockers: Array.isArray(record.lastBlockers)
      ? record.lastBlockers.filter((value): value is string => typeof value === "string")
      : undefined
  };
}


export function parseDaemonTurnMessage(message: string | undefined): ParsedDaemonTurnMessage | undefined {
  if (!message) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : undefined;
    const status =
      parsed.status === "completed" ||
      parsed.status === "blocked" ||
      parsed.status === "needs_review" ||
      parsed.status === "needs_followup"
        ? parsed.status
        : undefined;
    const blockers = Array.isArray(parsed.blockers)
      ? parsed.blockers.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const scopeRequestCandidate =
      parsed.scope_request && typeof parsed.scope_request === "object" && !Array.isArray(parsed.scope_request)
        ? (parsed.scope_request as Record<string, unknown>)
        : undefined;
    const blockedPaths = Array.isArray(scopeRequestCandidate?.blocked_paths)
      ? scopeRequestCandidate.blocked_paths.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const requestedWriteScope = Array.isArray(scopeRequestCandidate?.requested_write_scope)
      ? scopeRequestCandidate.requested_write_scope.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointCandidate =
      parsed.checkpoint && typeof parsed.checkpoint === "object" && !Array.isArray(parsed.checkpoint)
        ? (parsed.checkpoint as Record<string, unknown>)
        : undefined;
    const checkpointEvidenceRefs = Array.isArray(checkpointCandidate?.evidence_refs)
      ? checkpointCandidate.evidence_refs.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointNextActions = Array.isArray(checkpointCandidate?.next_actions)
      ? checkpointCandidate.next_actions.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointActiveTargets = Array.isArray(checkpointCandidate?.active_targets)
      ? checkpointCandidate.active_targets.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointOpenGaps = Array.isArray(checkpointCandidate?.open_gaps)
      ? checkpointCandidate.open_gaps.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpointCompressedContextSourceRefs = Array.isArray(checkpointCandidate?.compressed_context_source_refs)
      ? checkpointCandidate.compressed_context_source_refs.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const checkpoint =
      checkpointCandidate && checkpointEvidenceRefs.length > 0
        ? {
            evidenceRefs: checkpointEvidenceRefs,
            nextActions: checkpointNextActions,
            activeTargets: checkpointActiveTargets,
            openGaps: checkpointOpenGaps,
            compressedContextSummary:
              typeof checkpointCandidate.compressed_context_summary === "string" &&
                checkpointCandidate.compressed_context_summary.trim().length > 0
                ? checkpointCandidate.compressed_context_summary.trim()
                : undefined,
            compressedContextRef:
              typeof checkpointCandidate.compressed_context_ref === "string" &&
                checkpointCandidate.compressed_context_ref.trim().length > 0
                ? checkpointCandidate.compressed_context_ref.trim()
                : undefined,
            compressedContextSourceRefs: checkpointCompressedContextSourceRefs
          }
        : undefined;
    const scopeRequest =
      blockedPaths.length > 0 || requestedWriteScope.length > 0
        ? {
            blockedPaths,
            requestedWriteScope,
            reason:
              typeof scopeRequestCandidate?.reason === "string" && scopeRequestCandidate.reason.trim().length > 0
                ? scopeRequestCandidate.reason.trim()
                : undefined
          }
        : undefined;

    if (!summary || !status) {
      return undefined;
    }

    return {
      summary,
      status,
      blockers,
      checkpoint,
      scopeRequest
    };
  } catch {
    return undefined;
  }
}


export function buildDaemonProgressKey(input: {
  runtimeState: ProjectRuntimeStateRecord | undefined;
  snapshot: RunStatusSnapshot;
  directive: RunExecutionPlan["directive"];
  activeTaskId: string;
}): string {
  const activeTask = input.snapshot.tasks.find((task) => task.packet.taskId === input.activeTaskId);
  return JSON.stringify({
    runtimeActiveRunId: input.runtimeState?.activeRunId ?? null,
    runtimeActiveTaskId: input.runtimeState?.activeTaskId ?? null,
    runStatus: input.snapshot.run.status,
    activeTaskStatus: activeTask?.status ?? null,
    activeTaskUpdatedAt: activeTask?.updatedAt ?? null,
    autonomousUpdatedAt: input.snapshot.autonomousExecution?.state.updatedAt ?? null,
    lastCheckpointId: input.snapshot.autonomousExecution?.state.lastCheckpointId ?? null,
    lastProgressProofId: input.snapshot.autonomousExecution?.state.lastProgressProofId ?? null,
    directive: buildDirectiveProgressFingerprint(input.directive)
  });
}


export async function persistDaemonTurnCheckpoint(input: {
  runId: string;
  taskId: string;
  snapshot: RunStatusSnapshot;
  message: ParsedDaemonTurnMessage | undefined;
  checkpointRun?: ExecuteDaemonCommandOptions["checkpointRun"];
  now: () => Date;
}): Promise<string | undefined> {
  if (
    !input.message?.checkpoint ||
    !input.checkpointRun ||
    (input.message.status !== "needs_followup" && input.message.status !== "needs_review")
  ) {
    return undefined;
  }

  const createdAt = input.now().toISOString();
  const checkpointId = `cp-daemon-${input.taskId}-${createdAt.replace(/[:.]/g, "-")}`;
  const phase: CheckpointRecord["phase"] = input.snapshot.autonomousExecution?.state.phase ?? "implementation";
  const checkpoint = input.message.checkpoint;

  await input.checkpointRun(
    input.runId,
    {
      checkpointId,
      phase,
      activeTargets: [...checkpoint.activeTargets],
      recentEvidenceRefs: [...checkpoint.evidenceRefs],
      openGaps: [...checkpoint.openGaps],
      nextActions:
        checkpoint.nextActions.length > 0 ? [...checkpoint.nextActions] : [`continue ${input.taskId}`],
      compressedContextRef: checkpoint.compressedContextRef,
      compressedContextSummary: checkpoint.compressedContextSummary ?? input.message.summary,
      compressedContextSourceRefs:
        checkpoint.compressedContextSourceRefs.length > 0
          ? [...checkpoint.compressedContextSourceRefs]
          : [...checkpoint.evidenceRefs],
      createdAt
    },
    {
      authorityLabel: "runtime_authoritative"
    }
  );

  return checkpointId;
}


export function daemonMessageHasScopeConflict(message: ParsedDaemonTurnMessage | undefined): boolean {
  if (!message) {
    return false;
  }

  const combined = [message.summary, ...message.blockers].join("\n");
  return /\bout of scope\b|\bwrite scope\b|\bscope mismatch\b|\boutside the allowed scope\b/i.test(combined);
}


export function parseClaudeStreamJsonOutput(
  stdout: string,
  initialSessionId?: string | undefined
): { sessionId: string | undefined; finalMessage: string | undefined; usage: RunCodexTurnUsage | undefined } {
  let sessionId = initialSessionId;
  let finalMessage: string | undefined;
  let usage: RunCodexTurnUsage | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Fail closed: skip unparseable lines rather than throwing
      continue;
    }

    const eventType = event.type;
    if (eventType === "system") {
      if (typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
    } else if (eventType === "assistant") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
              finalMessage = b.text.trim();
            }
          }
        }
      }
    } else if (eventType === "result") {
      if (typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
      if (typeof event.result === "string" && event.result.trim().length > 0) {
        finalMessage = event.result.trim();
      }
      // Extract usage block — fail-closed: missing/malformed → undefined, never throw
      if (event.usage !== null && typeof event.usage === "object" && !Array.isArray(event.usage)) {
        const u = event.usage as Record<string, unknown>;
        const toInt = (v: unknown): number =>
          typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
        usage = {
          inputTokens: toInt(u.input_tokens),
          outputTokens: toInt(u.output_tokens),
          cacheReadTokens: toInt(u.cache_read_input_tokens),
          cacheCreationTokens: toInt(u.cache_creation_input_tokens)
        };
      }
    }
    // Unknown event types are intentionally ignored to stay forward-compatible
  }
  return { sessionId, finalMessage, usage };
}


export async function runCodexTurnViaCli(input: RunCodexTurnInput): Promise<RunCodexTurnResult> {
  const args = input.sessionId
    ? ["--resume", input.sessionId, "-p", input.prompt, "--output-format", "stream-json"]
    : ["-p", input.prompt, "--output-format", "stream-json"];

  const child = spawn(input.claudeBin, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const reason = stderr.trim() || stdout.trim() || `claude -p exited with code ${exitCode}`;
    throw new Error(`claude -p failed: ${reason}`);
  }

  const { sessionId, finalMessage, usage } = parseClaudeStreamJsonOutput(stdout, input.sessionId);
  return { sessionId, finalMessage, stdout, stderr, exitCode, usage };
}


export function buildDaemonTaskPacketFingerprint(packet: TaskPacketInput | undefined): string | undefined {
  if (!packet) {
    return undefined;
  }

  const fingerprintSource = {
    taskId: packet.taskId,
    goal: packet.goal ?? null,
    allowedWriteScope: packet.allowedWriteScope ?? [],
    acceptanceCriteria: packet.acceptanceCriteria ?? [],
    verificationSteps: packet.verificationSteps ?? [],
    requiredReviews: packet.requiredReviews ?? []
  };

  return createHash("sha256").update(JSON.stringify(fingerprintSource)).digest("hex");
}


export function determineDaemonPromptMode(input: {
  sessionId?: string | undefined;
  previousTaskId?: string | undefined;
  previousPacketFingerprint?: string | undefined;
  taskId: string;
  packetFingerprint?: string | undefined;
}): DaemonPromptMode {
  if (!input.sessionId || !input.packetFingerprint) {
    return "full";
  }

  if (
    input.previousTaskId === input.taskId &&
    input.previousPacketFingerprint === input.packetFingerprint
  ) {
    return "delta";
  }

  return "full";
}


export function buildDaemonTaskPrompt(input: {
  promptMode: DaemonPromptMode;
  directive: DaemonPromptDirective;
  taskId: string;
  packet?: TaskPacketInput | undefined;
  operatorNotes?: string | undefined;
  compressedContextSummary?: string | undefined;
  compressedContextRef?: string | undefined;
}): string {
  const packet = input.packet;
  const baseLines = [
    input.promptMode === "delta"
      ? "Continue the active archon worker session for the current task."
      : "Operate as the active archon worker for the current task.",
    `Active task: ${input.taskId}`,
    `Directive: ${input.directive.kind}`,
    packet?.goal ? `Goal: ${packet.goal}` : undefined,
    packet?.allowedWriteScope?.length ? `Allowed write scope: ${packet.allowedWriteScope.join(", ")}` : undefined
  ];

  const detailLines =
    input.promptMode === "full"
      ? [
          packet?.acceptanceCriteria?.length
            ? `Acceptance criteria: ${packet.acceptanceCriteria.join(" | ")}`
            : undefined,
          packet?.verificationSteps?.length
            ? `Verification steps: ${packet.verificationSteps.join(" | ")}`
            : undefined,
          packet?.requiredReviews?.length
            ? `Required reviews: ${packet.requiredReviews.join(", ")}`
            : undefined
        ]
      : [
          "Previously bootstrapped task requirements remain in force unless explicitly updated below.",
          input.compressedContextSummary
            ? `Compressed context: ${input.compressedContextSummary}`
            : undefined,
          input.compressedContextRef ? `Compressed context ref: ${input.compressedContextRef}` : undefined
        ];

  const guidanceLines = [
    "Follow the repository CLAUDE.md and the archon workflow.",
    "Use runtime-backed archon commands when they are needed for proof, status, or advancement.",
    "Scale, latency, or item volume are not blockers by themselves when the task can be chunked and resumed.",
    "If you make tractable progress without finishing, return status needs_followup and include checkpoint.evidence_refs plus a compressed checkpoint summary so the daemon can persist progress and continue.",
    input.promptMode === "delta"
      ? "If scope blocks the next required edit, stop immediately and return the minimum safe scope_request delta."
      : "If a required edit falls outside the allowed write scope, stop immediately, name the exact blocked paths, and include a scope_request with blocked_paths, requested_write_scope, and a short reason describing the minimum safe scope expansion.",
    "Do not spend another turn repeating the same blocked attempt when runtime state has not changed.",
    "Complete the task if possible; otherwise stop at the real blocker and state it explicitly.",
    input.operatorNotes ? `Operator notes: ${input.operatorNotes}` : undefined,
    input.directive.kind === "continue_analysis"
      ? `Autonomous target: ${input.directive.targetId}. Typed continuation actions: ${input.directive.actions.map(formatContinuationAction).join(" | ")}`
      : undefined,
    input.directive.kind === "dispatch_owner"
      ? `Owner rationale: ${input.directive.rationale.join(" | ")}`
      : undefined
  ];

  const lines = [...baseLines, ...detailLines, ...guidanceLines].filter(
    (value): value is string => Boolean(value)
  );

  return lines.join("\n");
}


export function formatContinuationAction(action: DaemonPromptContinuationAction): string {
  if (action.kind === "run_workflow_proof") {
    return `run_workflow_proof(${action.taskId})`;
  }
  if (action.kind === "resolve_blocking_gap") {
    return `resolve_blocking_gap(${action.gapId} -> ${action.targetId})`;
  }
  return `resume_target(${action.targetId})`;
}
