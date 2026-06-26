// Phase 4 (ahrP4InteractiveWatcher): interactive Stop-hook handler.
//
// This module is the Stop-hook entrypoint for a hand-driven `claude` session.
// When the context threshold is crossed, it:
//   1. Ensures a committed handoff exists (else recoverCrashedInvocation).
//   2. Claims the respawn lease for "interactive" (INFRA-C1).
//   3. Writes a FRESH-RUN resume-request via atomic temp+rename (INFRA-C3).
//      NOT a --resume call — interactive continuation starts a fresh process.
//
// Security invariants:
//   - promptPath is validated before use (no "..", no shell metacharacters,
//     must be relative and under .archon/work/daemon/).
//   - Stale resume-requests are ARCHIVED not silently deleted.
//   - observe mode: never writes a resume-request (opt-in enforcement).
//   - Lease must be claimed before writing; losing racers return no_action.
//
// I/O contract (handleInteractiveStop):
//   Input:  InteractiveStopHookDeps
//   Output: InteractiveStopResult
//   Side effects:
//     - May call recoverCrashedInvocation on the store
//     - Writes resume-request file atomically
//     - Claims respawn lease

import { mkdir, rename, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import type { ClaimResult } from "./respawn-lease.ts";
import type { HandoffRecord } from "../store/agent-runtime-store.ts";

// ---------------------------------------------------------------------------
// ResumeRequest schema (INFRA-C3 / SEC-HIGH-2)
// ---------------------------------------------------------------------------

export interface ResumeRequest {
  schemaVersion: 1;
  /** Must be "fresh_run" — never "--resume" for interactive respawn. */
  mode: "fresh_run";
  runId: string;
  taskId: string;
  /**
   * Relative path to the continuation prompt file.
   * Must be under .archon/work/daemon/ and contain no ".." or shell metacharacters.
   */
  promptPath: string;
  createdAt: string;
  /** Never set for fresh_run; explicitly absent to enforce the invariant. */
  resumeSessionId?: undefined;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  reason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Hook action result
// ---------------------------------------------------------------------------

export type InteractiveStopAction =
  | "resume_request_written"
  | "no_action";

export interface InteractiveStopResult {
  action: InteractiveStopAction;
  reason?: string | undefined;
  resumeRequestPath?: string | undefined;
}

// ---------------------------------------------------------------------------
// Injectable dependencies (test-friendly)
// ---------------------------------------------------------------------------

export interface InteractiveStopHookDeps {
  invocationId: string;
  runId: string;
  taskId: string;
  role: string;
  cwd: string;
  /**
   * Mode: "enforce" writes the resume-request; "observe" does not (opt-in).
   * Defaults to "enforce" when absent.
   */
  mode?: "enforce" | "observe" | undefined;
  /** Returns true if the context threshold has been crossed. */
  getThresholdCrossed(invocationId: string): Promise<boolean>;
  /** Returns the latest committed handoff for the run+task, or undefined. */
  getLatestHandoff(runId: string, taskId: string): Promise<HandoffRecord | undefined>;
  /** Returns true if the invocation has committed a handoff. */
  hasCommittedHandoff(invocationId: string): Promise<boolean>;
  /** Synthesize a crash-recovery handoff when none exists. */
  recoverCrashedInvocation(invocationId: string): Promise<HandoffRecord>;
  /** Build the continuation prompt string from a handoff record. */
  buildContinuationPrompt(record: HandoffRecord): string;
  /**
   * Write the resume-request atomically (temp+rename) and return the
   * relative path. Defaults to writeResumeRequestAtomically when absent.
   *
   * BLOCKING-4: `promptContent` is the actual text to write to the prompt file.
   */
  writeResumeRequest?(cwd: string, request: ResumeRequest, promptContent: string): Promise<string>;
  /** Claim the respawn lease for this runId. */
  claimLease(runId: string, owner: "interactive"): Promise<ClaimResult>;
}

// ---------------------------------------------------------------------------
// Shell metacharacter / path-safety validation (INFRA-C3 / SEC-HIGH-2)
// ---------------------------------------------------------------------------

// Characters that are dangerous in shell argument construction.
// The watcher reconstructs the command as a safe arg array — never eval —
// but we reject bad paths at write time so the watcher never even sees them.
const SHELL_METACHARS = /[;&|`$<>!\\'"""()[\]{}*?~\s]/;

const REQUIRED_PATH_PREFIX = ".archon/work/daemon/";

/**
 * Validate a ResumeRequest for schema correctness, path safety, and freshness.
 *
 * I/O contract:
 *   Input:  ResumeRequest (untrusted IPC payload), options { maxAgeSeconds, now? }
 *   Output: ValidationResult { valid, reason? }
 *   Side effects: none
 */
export function validateResumeRequest(
  req: ResumeRequest,
  options: { maxAgeSeconds: number; now?: Date | undefined }
): ValidationResult {
  const now = options.now ?? new Date();

  // Schema check
  if (!req || typeof req !== "object") {
    return { valid: false, reason: "request is not an object" };
  }
  if (req.schemaVersion !== 1) {
    return { valid: false, reason: `invalid schemaVersion: ${String(req.schemaVersion)}` };
  }
  if (req.mode !== "fresh_run") {
    return { valid: false, reason: `invalid mode: ${String(req.mode)} (must be fresh_run)` };
  }
  if (typeof req.runId !== "string" || !req.runId) {
    return { valid: false, reason: "missing or empty runId" };
  }
  if (typeof req.taskId !== "string" || !req.taskId) {
    return { valid: false, reason: "missing or empty taskId" };
  }
  if (typeof req.promptPath !== "string" || !req.promptPath) {
    return { valid: false, reason: "missing or empty promptPath" };
  }
  if (typeof req.createdAt !== "string" || !req.createdAt) {
    return { valid: false, reason: "missing or empty createdAt" };
  }

  const p = req.promptPath;

  // Absolute path check (must be relative)
  if (path.isAbsolute(p)) {
    return { valid: false, reason: `promptPath must be relative, got absolute: ${p}` };
  }

  // Path traversal check
  if (p.includes("..")) {
    return { valid: false, reason: `promptPath contains path traversal (..): ${p}` };
  }

  // Shell metacharacter check
  if (SHELL_METACHARS.test(p)) {
    return { valid: false, reason: `promptPath contains shell metacharacters: ${p}` };
  }

  // Must be under the expected prefix
  const normalized = p.replace(/\\/g, "/");
  if (!normalized.startsWith(REQUIRED_PATH_PREFIX)) {
    return {
      valid: false,
      reason: `promptPath must be under ${REQUIRED_PATH_PREFIX}, got: ${p}`
    };
  }

  // Freshness check
  const createdAtMs = new Date(req.createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return { valid: false, reason: `invalid createdAt: ${req.createdAt}` };
  }
  const ageSeconds = (now.getTime() - createdAtMs) / 1000;
  if (ageSeconds > options.maxAgeSeconds) {
    return {
      valid: false,
      reason: `resume-request is stale: age ${ageSeconds.toFixed(0)}s > max ${options.maxAgeSeconds}s`
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// writeResumeRequestAtomically — INFRA-C3
// ---------------------------------------------------------------------------

const RESUME_REQUEST_FILENAME = "interactive-resume-request.json";
const CONTINUATION_PROMPT_FILENAME = "continuation-context.txt";

/**
 * Write the resume-request JSON and the continuation prompt file via atomic
 * temp-file + rename (INFRA-C3). The rename is atomic on POSIX systems,
 * preventing a watcher from reading a partially-written file.
 *
 * BLOCKING-4 fix: accepts `promptContent` (the actual text to write to the
 * prompt file) rather than inferring it from `request.promptPath` (which is a
 * path string, not content). Previously this function wrote the path string as
 * the file content, silently producing a no-op prompt.
 *
 * I/O contract:
 *   Input:  cwd, request, promptContent (string — the continuation bundle text)
 *   Output: relative path to the written resume-request JSON
 *   Side effects: writes two files under .archon/work/daemon/
 */
export async function writeResumeRequestAtomically(
  cwd: string,
  request: ResumeRequest,
  promptContent: string
): Promise<string> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  await mkdir(daemonDir, { recursive: true });

  // Write the prompt CONTENT (the continuation bundle) first, atomically.
  // This is the text the fresh claude session will receive as its prompt.
  const promptFullPath = path.join(cwd, request.promptPath);
  const promptTmp = `${promptFullPath}.tmp.${Date.now()}`;
  await writeFile(promptTmp, promptContent, "utf8");
  await rename(promptTmp, promptFullPath);

  // Write the resume-request JSON last (watcher polls for this file).
  const requestPath = path.join(daemonDir, RESUME_REQUEST_FILENAME);
  const requestTmp = `${requestPath}.tmp.${Date.now()}`;
  await writeFile(requestTmp, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  await rename(requestTmp, requestPath);

  return path.join(".archon", "work", "daemon", RESUME_REQUEST_FILENAME);
}

// ---------------------------------------------------------------------------
// archiveResumeRequest — stale/rejected requests archived not deleted
// ---------------------------------------------------------------------------

/**
 * Move a stale or rejected resume-request to the rejected-resume-requests/
 * archive directory under .archon/work/daemon/. Not deleted silently.
 *
 * I/O contract:
 *   Input:  requestPath (absolute), cwd
 *   Output: void
 *   Side effects: moves file to archive dir
 */
export async function archiveResumeRequest(
  requestPath: string,
  cwd: string
): Promise<void> {
  const daemonDir = path.join(cwd, ".archon", "work", "daemon");
  const archiveDir = path.join(daemonDir, "rejected-resume-requests");
  await mkdir(archiveDir, { recursive: true });

  const basename = path.basename(requestPath);
  const timestamp = Date.now();
  const archivePath = path.join(archiveDir, `${timestamp}-${basename}`);

  await cp(requestPath, archivePath);
  // Remove original only after successful archive copy.
  const { rm } = await import("node:fs/promises");
  await rm(requestPath, { force: true });
}

// ---------------------------------------------------------------------------
// handleInteractiveStop — main Stop-hook handler
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_PATH = `.archon/work/daemon/${CONTINUATION_PROMPT_FILENAME}`;

/**
 * Handle the Stop event for an interactive `claude` session.
 *
 * Flow:
 *   1. Check mode — observe mode returns no_action immediately.
 *   2. Check threshold — if not crossed, return no_action.
 *   3. Claim the respawn lease for "interactive" — if denied (daemon owns it),
 *      return no_action so the daemon can relaunch this run.
 *   4. Ensure a committed handoff — recoverCrashedInvocation if absent.
 *   5. Write continuation prompt + resume-request atomically (INFRA-C3).
 *   6. Return resume_request_written.
 *
 * I/O contract:
 *   Input:  InteractiveStopHookDeps
 *   Output: InteractiveStopResult
 *   Side effects: see module header
 */
export async function handleInteractiveStop(
  deps: InteractiveStopHookDeps
): Promise<InteractiveStopResult> {
  // Observe mode: never write a resume-request (opt-in enforcement).
  const mode = deps.mode ?? "enforce";
  if (mode === "observe") {
    return { action: "no_action", reason: "observe_mode" };
  }

  // Check if the context threshold was crossed.
  const thresholdCrossed = await deps.getThresholdCrossed(deps.invocationId);
  if (!thresholdCrossed) {
    return { action: "no_action", reason: "threshold_not_crossed" };
  }

  // Claim the respawn lease for "interactive". If daemon already owns it,
  // do not spawn — the daemon will handle the relaunch.
  const leaseResult = await deps.claimLease(deps.runId, "interactive");
  if (!leaseResult.granted) {
    return { action: "no_action", reason: "lease_denied" };
  }

  // Ensure a committed handoff exists.
  const hasHandoff = await deps.hasCommittedHandoff(deps.invocationId);
  let handoffRecord: HandoffRecord | undefined;

  if (!hasHandoff) {
    // No handoff committed: synthesize a crash-recovery packet.
    handoffRecord = await deps.recoverCrashedInvocation(deps.invocationId);
  } else {
    handoffRecord = await deps.getLatestHandoff(deps.runId, deps.taskId);
  }

  if (handoffRecord === undefined) {
    // Should not happen: recoverCrashedInvocation guarantees a record.
    return { action: "no_action", reason: "handoff_unavailable" };
  }

  // Build the continuation prompt (content fields are sanitized by controller).
  const continuationPrompt = deps.buildContinuationPrompt(handoffRecord);

  // Compose the resume-request (fresh_run only).
  const request: ResumeRequest = {
    schemaVersion: 1,
    mode: "fresh_run",
    runId: deps.runId,
    taskId: deps.taskId,
    promptPath: DEFAULT_PROMPT_PATH,
    createdAt: new Date().toISOString()
  };

  // Write atomically (INFRA-C3). Use injected writer when provided (tests),
  // else write prompt + request via writeResumeRequestAtomically.
  //
  // BLOCKING-4 fix: pass `promptContent` (the built continuation text) to the
  // writer. Previously the production path wrote the prompt separately and then
  // called writeResumeRequestAtomically which overwrote it with the path string.
  // Now there is exactly ONE write of the prompt file, carrying the correct text.
  const promptContent = `${continuationPrompt.trim()}\n`;
  let resumeRequestPath: string;
  if (deps.writeResumeRequest !== undefined) {
    // Test/injection path: delegate entirely to the provided writer.
    resumeRequestPath = await deps.writeResumeRequest(deps.cwd, request, promptContent);
  } else {
    // Production path: writeResumeRequestAtomically writes both files atomically.
    resumeRequestPath = await writeResumeRequestAtomically(deps.cwd, request, promptContent);
  }

  return {
    action: "resume_request_written",
    resumeRequestPath
  };
}
