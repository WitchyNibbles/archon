import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyBashFailure,
  clearHookBlockerState,
  extractBashReferencedManagedPaths,
  extractBashWriteTargets,
  extractToolCommand,
  getBashExitCode,
  isAllowedPath,
  isDestructiveCommand,
  isManagedPath,
  isManagedPathAllowed,
  isManagedPrefixPartiallyAllowed,
  isReadOnlyBashCommand,
  isSubstantiveWriteTarget,
  isTaskPacketPath,
  isVerificationCommand,
  isVerificationSatisfied,
  normalizeToolOutput,
  parseApplyPatchTargets,
  persistHookBlockerState,
  persistTouchedPath,
  persistVerificationCert,
  qualifiesForVerificationCert,
  reviewArtifactPath,
  shouldHoldStop,
  toRelativePath,
  validateReviewArtifact,
  isHandoffArtifactPath
} from "./hook-utils.mjs";

// Claude Code PreToolUse output: {decision: "block", reason: "..."} or {decision: "allow"}
// Claude Code Stop output: {continue: false, stopReason: "..."}
// additionalContext: injected into assistant context as a hint (non-blocking)

function isLikelySubstantiveInitialPrompt(prompt) {
  const normalized = typeof prompt === "string" ? prompt.trim() : "";
  if (normalized.length < 24) {
    return false;
  }

  // Bypass phrase: let the user escape the gate for trivial tasks
  if (normalized.includes("archon:bypass")) {
    return false;
  }

  if (
    /^(what|why|how|when|where|which|who|show|list)\b/i.test(normalized) &&
    !/\b(build|create|implement|design|fix|refactor|migrate|workflow|feature|system|api)\b/i.test(normalized)
  ) {
    return false;
  }

  if (
    /\b(build|create|implement|add|fix|refactor|rewrite|design|redesign|update|change|migrate|integrate|set up|setup|remove|replace|improve|optimize|ship|scaffold)\b/i.test(
      normalized
    )
  ) {
    return true;
  }

  return (
    /\b(i want|we need|need to|let'?s)\b/i.test(normalized) &&
    /\b(feature|workflow|system|app|page|dashboard|api|cli|integration|auth|repo|repository|installer|tool|agent|archon)\b/i.test(
      normalized
    )
  );
}

function isAllowedTaskTarget(target, context) {
  if (isAllowedPath(target, context.allowedWriteScope)) {
    return true;
  }

  return (
    isTaskPacketPath(target) &&
    Array.isArray(context.allowedTaskHandoffScope) &&
    context.allowedTaskHandoffScope.some((scope) => target === scope)
  );
}

// Resolves the write-target file path for tools that modify files.
// Returns the raw path string (may be absolute) or empty string for non-write tools.
// Callers must pass the result through toRelativePath before comparisons.
function resolveWriteTargetPath(toolName, payload) {
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return payload?.tool_input?.file_path ?? "";
  }
  if (toolName === "NotebookEdit") {
    return payload?.tool_input?.notebook_path ?? "";
  }
  return "";
}

// Tools that are safe to call regardless of context-guard state.
// Read, Bash (read-only checks), and internal archon state updates are
// always allowed so the agent can diagnose and recover without deadlocking.
//
// IMPORTANT: this set MUST be kept in sync with ContextBudgetMonitor.isHandoffSafeTool
// in src/runtime/context-budget.ts. When adding MCP tools to the handoff protocol,
// update both files. The parity test in tests/hook-policy.test.ts asserts agreement.
function isHandoffSafeTool(toolName) {
  // Read-only / coordination tools that are always safe.
  const diagnosticTools = new Set(["Read", "LS", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "TodoRead"]);
  if (diagnosticTools.has(toolName)) {
    return true;
  }

  // Handoff-completing MCP tools. These MUST match the names registered by the
  // MCP server (src/mcp/handoff-tools.ts). Accept both the bare tool name and
  // the fully-qualified mcp__archon__<name> form the host may pass to PreToolUse.
  const bare = toolName.startsWith("mcp__archon__")
    ? toolName.slice("mcp__archon__".length)
    : toolName;
  const handoffSafeMcpTools = new Set([
    "archon_handoff_prepare",
    "archon_handoff_commit",
    "archon_context_sample",
    "archon_next_action"
  ]);
  return handoffSafeMcpTools.has(bare);
}

// Read and parse the context-guard sidecar file.
// Returns undefined when the file is absent, unreadable, or malformed.
// Shape: { invocationId, state, contextPct, updatedAt }
function readContextGuardState(repoRoot) {
  try {
    const guardPath = path.join(repoRoot, ".archon", "work", "context-guard.json");
    const raw = readFileSync(guardPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.state === "string"
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function evaluatePermissionRequest(payload, context) {
  const command = extractToolCommand(payload);

  if (isDestructiveCommand(command)) {
    return { decision: "deny", reason: "destructive approval request blocked by archon policy" };
  }

  const managedTarget = extractBashReferencedManagedPaths(command).find(
    (target) => !isManagedPrefixPartiallyAllowed(target, context.allowedWriteScope)
  );
  if (managedTarget && !isReadOnlyBashCommand(command)) {
    return {
      decision: "deny",
      reason: `approval request for managed control-layer path ${managedTarget} is blocked outside explicit task scope`
    };
  }

  return undefined;
}

export function evaluatePreToolUse(payload, context) {
  const toolName = payload?.tool_name;
  const command = extractToolCommand(payload);

  // Context-guard enforcement: when the ContextBudgetMonitor has written a
  // hard_stop or handoff_required state, block non-safe tools so the agent
  // cannot continue substantive work past the context threshold.
  //
  // Bypass path: ARCHON_HANDOFF_ENFORCEMENT=warn emits advisory only;
  //              ARCHON_HANDOFF_ENFORCEMENT=off disables the check entirely.
  const handoffEnforcement = process.env.ARCHON_HANDOFF_ENFORCEMENT ?? "block";
  if (handoffEnforcement !== "off" && !isHandoffSafeTool(toolName)) {
    const guardState = readContextGuardState(context.repoRoot);
    if (guardState) {
      if (guardState.state === "hard_stop") {
        const msg = `context budget hard stop (${guardState.contextPct ?? "?"}% used): call archon_handoff_commit (now permitted) to commit a handoff, then stop. The successor session can be started with: npx archon continue-session`;
        if (handoffEnforcement === "warn") {
          // advisory only — do not block
        } else {
          return { decision: "block", reason: msg };
        }
      } else if (guardState.state === "handoff_required") {
        const msg = `context budget handoff required (${guardState.contextPct ?? "?"}% used): call archon_handoff_commit (now permitted — context-guard allows it) to commit a handoff, then stop. The successor session can continue with: npx archon continue-session`;
        if (handoffEnforcement === "warn") {
          return { additionalContext: msg };
        } else {
          return { decision: "block", reason: msg };
        }
      }
    }
  }

  if (toolName === "Agent") {
    if (context.allowedWriteScope.length > 0) {
      return {
        additionalContext: `spawning subagent while write scope is active (${context.allowedWriteScope.join(", ")}); ensure the subagent prompt does not exceed this scope`
      };
    }
    return undefined;
  }

  if (toolName === "apply_patch") {
    const targets = parseApplyPatchTargets(command);
    const outOfScope = targets.find((target) => !isAllowedTaskTarget(target, context));
    if (outOfScope && context.allowedWriteScope.length > 0) {
      const detail = isTaskPacketPath(outOfScope)
        ? `successor task packet ${outOfScope} is not listed in the active archon task handoff scope`
        : `apply_patch target ${outOfScope} is outside the active archon task write scope`;
      return { decision: "block", reason: detail };
    }

    const managedTarget = targets.find(
      (target) => isManagedPath(target) && !isManagedPathAllowed(target, context.allowedWriteScope)
    );
    if (managedTarget) {
      return {
        decision: "block",
        reason: `managed control-layer file ${managedTarget} requires an active archon task with explicit write scope`
      };
    }
  }

  if (toolName === "Bash") {
    if (isDestructiveCommand(command)) {
      return { decision: "block", reason: "destructive shell command blocked by archon policy" };
    }

    const managedTarget = extractBashReferencedManagedPaths(command).find(
      (target) => !isManagedPrefixPartiallyAllowed(target, context.allowedWriteScope)
    );
    if (managedTarget && !isReadOnlyBashCommand(command)) {
      return {
        decision: "block",
        reason: `managed control-layer path ${managedTarget} requires an active archon task with explicit write scope`
      };
    }

    // Bash write-escape-hatch gate: extract explicit write targets from the command
    // and apply the same no-task and task-scope gates as Write/Edit.
    const bashWriteTargets = extractBashWriteTargets(command, context.repoRoot);
    if (bashWriteTargets.length > 0) {
      // No-task gate: block substantive writes when no task is active.
      if (!context.activeTaskId) {
        const offending = bashWriteTargets.find((target) => isSubstantiveWriteTarget(target));
        if (offending) {
          return {
            decision: "block",
            reason: `write to ${offending} blocked (detected from bash write) — no active archon task. To unblock: register an initiative via \`npm run archon -- init-task --id <id> --title "<title>" --scope <comma,paths>\` (or point .archon/ACTIVE at an existing task), then retry.`
          };
        }
      }
      // Task-scope gate: block writes to paths outside the declared write scope.
      if (context.activeTaskId && context.allowedWriteScope.length > 0) {
        const outOfScope = bashWriteTargets.find((target) => {
          // .archon/skills/ is always exempt
          if (target === ".archon/skills" || target.startsWith(".archon/skills/")) return false;
          return !isAllowedTaskTarget(target, context);
        });
        if (outOfScope) {
          const scopeSummary = context.allowedWriteScope.slice(0, 5).join(", ");
          const truncated = context.allowedWriteScope.length > 5 ? ` (and ${context.allowedWriteScope.length - 5} more)` : "";
          return {
            decision: "block",
            reason: `write to ${outOfScope} is outside active task ${context.activeTaskId} write scope. Allowed: ${scopeSummary}${truncated}. Expand the task packet's ## Allowed write scope to include this path if it is needed.`
          };
        }
      }
    }
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const rawFilePath = resolveWriteTargetPath(toolName, payload);
    // Normalize to relative path — Claude Code may pass absolute paths.
    const filePath = toRelativePath(rawFilePath, context.repoRoot);
    // F2: Handoff artifact paths are exempt from the managed-path gate so the agent
    // can write them even under context-guard enforcement (handoff_required/hard_stop).
    // These files are part of the handoff protocol, not general control-layer files.
    if (filePath && isHandoffArtifactPath(filePath)) {
      return undefined;
    }
    if (filePath && isManagedPath(filePath) && !isManagedPathAllowed(filePath, context.allowedWriteScope)) {
      return {
        decision: "block",
        reason: `managed control-layer file ${filePath} requires an active archon task with explicit write scope`
      };
    }
    // .archon/skills/** is always writable — repo-local skill accumulation does not require an active task.
    if (filePath && (filePath === ".archon/skills" || filePath.startsWith(".archon/skills/"))) {
      return undefined;
    }
    // Outside-repo detection: toRelativePath canonicalizes via path.resolve, so an
    // in-repo target (including crafted double-slash or dot-dot paths that resolve
    // inside the repo) becomes a clean repo-relative path with no leading "/", while
    // a target outside repoRoot is returned as its canonical absolute path (leading
    // "/"). The leading-slash test therefore reflects true jurisdiction. Such
    // outside-repo paths are legitimately outside archon's control (e.g.
    // ~/.claude/projects/…, /tmp/foo.txt) and are exempt from both write gates.
    // Compute ONCE here so both the no-task gate and the task-scope gate can use it.
    const filePathIsOutsideRepo = typeof filePath === "string" && filePath.startsWith("/");
    // No-task write gate: block substantive writes when no task is active.
    // archon:bypass does NOT apply here — it only affects the UserPromptSubmit advisory.
    // Outside-repo paths are exempt — archon does not own files outside the repo root.
    if (filePath && !context.activeTaskId && !filePathIsOutsideRepo && isSubstantiveWriteTarget(filePath)) {
      return {
        decision: "block",
        reason: `write to ${filePath} blocked — no active archon task. To unblock: register an initiative via \`npm run archon -- init-task --id <id> --title "<title>" --scope <comma,paths>\` (or point .archon/ACTIVE at an existing task), then retry.`
      };
    }
    // Task-scope gate: when a task is active and declares a non-empty write scope,
    // block writes to files outside that scope.
    // Skip the scope gate for absolute paths that are outside the repo root — those
    // are legitimately outside archon's jurisdiction (e.g. /tmp/foo.txt).
    if (
      filePath &&
      context.activeTaskId &&
      context.allowedWriteScope.length > 0 &&
      !filePathIsOutsideRepo &&
      !isAllowedTaskTarget(filePath, context)
    ) {
      const scopeSummary = context.allowedWriteScope.slice(0, 5).join(", ");
      const truncated = context.allowedWriteScope.length > 5 ? ` (and ${context.allowedWriteScope.length - 5} more)` : "";
      return {
        decision: "block",
        reason: `write to ${filePath} is outside active task ${context.activeTaskId} write scope. Allowed: ${scopeSummary}${truncated}. Expand the task packet's ## Allowed write scope to include this path if it is needed.`
      };
    }
  }

  return undefined;
}

export function evaluatePostToolUse(payload, context) {
  const toolName = payload?.tool_name;

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const isError = payload?.tool_response?.isError === true;
    if (isError && context.activeTaskId) {
      const filePath = resolveWriteTargetPath(toolName, payload) || "unknown";
      return {
        additionalContext: `Write/Edit failed for ${filePath}; verify file state before claiming the change complete`
      };
    }
    // Record path-touch metadata for successful edits so handoff packets and
    // review gates have evidence of what the task actually changed (§14.1).
    if (!isError && context.activeTaskId && context.repoRoot) {
      const filePath = resolveWriteTargetPath(toolName, payload);
      if (filePath) {
        persistTouchedPath(context.repoRoot, context.activeTaskId, filePath);
      }
    }
    return undefined;
  }

  if (toolName !== "Bash") {
    return undefined;
  }

  const exitCode = getBashExitCode(payload?.tool_response);
  if (typeof exitCode !== "number") {
    return undefined;
  }

  if (exitCode === 0) {
    clearHookBlockerState(context.repoRoot);
    const command = extractToolCommand(payload);
    const toolResponse = payload?.tool_response ?? {};
    const combinedOutput = [
      normalizeToolOutput(toolResponse.stdout),
      normalizeToolOutput(toolResponse.stderr)
    ]
      .filter(Boolean)
      .join("\n");
    if (qualifiesForVerificationCert(command, combinedOutput) && context.activeTaskId && context.repoRoot) {
      persistVerificationCert(context.repoRoot, context.activeTaskId, command);
    }
    return undefined;
  }

  const classification = classifyBashFailure(payload);
  if (classification && context.repoRoot && context.activeTaskId) {
    persistHookBlockerState(context.repoRoot, {
      activeTaskId: context.activeTaskId,
      queueCurrentTaskId: context.queueCurrentTaskId,
      turnId: typeof payload?.turn_id === "string" ? payload.turn_id : undefined,
      toolName: classification.toolName,
      command: classification.command,
      commandFingerprint: classification.commandFingerprint,
      exitCode: classification.exitCode,
      blockerKind: classification.blockerKind,
      summary: classification.summary,
      details: classification.details,
      recordedAt: new Date().toISOString()
    });
  }

  const failedCommand = extractToolCommand(payload);
  if (!isVerificationCommand(failedCommand)) {
    return undefined;
  }

  const taskLabel = context.activeTaskId ? ` for active task ${context.activeTaskId}` : "";
  return {
    decision: "block",
    reason: `verification command failed${taskLabel}; enter the archon repair loop before claiming completion`
  };
}

export function evaluateSessionStart(payload, context) {
  const lines = [];
  if (context.runtimeConfigured && !context.runtimeConnected) {
    lines.push("archon runtime offline: postgres is configured but unreachable; falling back to local .archon/ACTIVE");
  }
  if (context.activeTaskId) {
    lines.push(`archon active task: ${context.activeTaskId}`);
  }
  if (context.queueCurrentTaskId && context.queueCurrentTaskId !== context.activeTaskId) {
    lines.push(`archon queue current task: ${context.queueCurrentTaskId}`);
  }
  if (context.allowedWriteScope.length > 0) {
    lines.push(`allowed write scope: ${context.allowedWriteScope.join(", ")}`);
  }
  if (Array.isArray(context.allowedTaskHandoffScope) && context.allowedTaskHandoffScope.length > 0) {
    lines.push(`allowed successor task scope: ${context.allowedTaskHandoffScope.join(", ")}`);
  }
  if (Array.isArray(context.authorityMismatches) && context.authorityMismatches.length > 0) {
    lines.push(`authority mismatch: ${context.authorityMismatches.map((entry) => entry.kind).join(", ")}`);
  }
  if (payload?.source === "resume" && lines.length > 0) {
    lines.push("this is a resumed session; prefer continuing from the active archon task and queue state");
  }

  if (lines.length === 0) {
    return undefined;
  }

  return { additionalContext: lines.join("; ") };
}

export function evaluateUserPromptSubmit(payload, context) {
  const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";

  // Don't gate skill invocations — the user is already routing through a skill
  const isSkillInvocation = /^\/archon-\S/.test(prompt.trim());

  if (!context.activeTaskId && isLikelySubstantiveInitialPrompt(prompt) && !isSkillInvocation) {
    return {
      additionalContext: [
        "archon: substantive request detected without an active task.",
        "Automatically invoke /archon-intake with the user's full request before any planning or implementation.",
        "Do not ask the user to run intake manually — invoke it yourself now."
      ].join(" ")
    };
  }

  const lines = [];
  if (context.activeTaskId) {
    lines.push(`active archon task: ${context.activeTaskId}`);
  }
  if (context.allowedWriteScope.length > 0) {
    lines.push(`keep edits within: ${context.allowedWriteScope.join(", ")}`);
  }
  if (Array.isArray(context.authorityMismatches) && context.authorityMismatches.length > 0) {
    lines.push(`authority mismatch present: ${context.authorityMismatches.map((entry) => entry.kind).join(", ")}`);
  }

  if (lines.length === 0) {
    return undefined;
  }

  return { additionalContext: lines.join("; ") };
}

export function evaluateStop(payload, context) {
  const lastAssistantMessage =
    typeof payload?.last_assistant_message === "string" ? payload.last_assistant_message : "";
  const stopHookActive = payload?.stop_hook_active === true;

  // Authority-mismatch gate: corrupted state should not silently release every gate.
  // When mismatches exist and this is the first stop call (!stopHookActive), hold with an
  // actionable message. When stopHookActive is true the first-stop hold is skipped, but we
  // must still fall through to review/runtime/verification gates — they must never be
  // releasable by a repeated stop alone. This mirrors the hookBlockerState pattern.
  if (Array.isArray(context.authorityMismatches) && context.authorityMismatches.length > 0) {
    if (!stopHookActive) {
      const kinds = context.authorityMismatches.map((m) => m.kind).join(", ");
      return {
        continue: false,
        stopReason: `archon task state authority mismatch (${kinds}): reconcile .archon/ACTIVE with .archon/work/task-queue.json before the session closes`
      };
    }
    // stopHookActive is true: the repeated mismatch hold itself is skipped, but we must
    // still fall through to review/runtime/verification gates — they must never be
    // releasable by a repeated stop alone.
  }

  if (context.continuationIntent === "defer_same_thread" || context.continuationIntent === "defer_fresh_run") {
    return undefined;
  }

  if (context.continuationIntent === "blocked_external") {
    return undefined;
  }

  const hookBlockerState =
    context.hookBlockerState && typeof context.hookBlockerState === "object" ? context.hookBlockerState : undefined;
  const activeTaskId = context.activeTaskId ?? context.queueCurrentTaskId;
  if (hookBlockerState && activeTaskId && hookBlockerState.activeTaskId === activeTaskId) {
    if (!stopHookActive) {
      // First stop: hold with the blocker summary so the user knows the task failed.
      return {
        continue: false,
        stopReason: hookBlockerState.summary
      };
    }
    // stopHookActive is true: the repeated blocker hold itself is skipped, but we must
    // still fall through to review/runtime/verification gates — they must never be
    // releasable by a repeated stop alone.
  }

  // NOTE on shouldHoldStop trust model:
  // shouldHoldStop affects only the soft "in progress" hold below (taskShouldHold).
  // Hard gates (review files, runtime offline, verification certs) are checked
  // unconditionally when shouldHoldStop returns false. Prose patterns in the assistant
  // message can release the soft hold but CANNOT bypass hard gates.
  const taskShouldHold =
    (context.activeTaskId || context.queueCurrentTaskId) && shouldHoldStop(lastAssistantMessage);

  // Review existence gate fires only when Claude signals completion (shouldHoldStop is false)
  // but required review files are absent. Mid-task pauses are handled by taskShouldHold below.
  if (
    !taskShouldHold &&
    context.activeTaskId &&
    Array.isArray(context.missingReviews) &&
    context.missingReviews.length > 0
  ) {
    const missing = context.missingReviews.join(", ");
    return {
      continue: false,
      stopReason: `task ${context.activeTaskId} is missing required review files: ${missing}. Write each missing review file to pass the review gate before the session closes.`
    };
  }

  // Review content validation gate: review files exist but fail content checks.
  if (
    !taskShouldHold &&
    context.activeTaskId &&
    Array.isArray(context.invalidReviews) &&
    context.invalidReviews.length > 0
  ) {
    const list = context.invalidReviews.join(", ");
    return {
      continue: false,
      stopReason: `task ${context.activeTaskId} has review files that fail content validation: ${list}. Each review must reference the task id and role and contain a passed/approved status line.`
    };
  }

  if (
    !taskShouldHold &&
    context.runtimeConfigured &&
    !context.runtimeConnected &&
    (context.activeTaskId || context.queueCurrentTaskId)
  ) {
    const taskId = context.activeTaskId ?? context.queueCurrentTaskId;
    return {
      continue: false,
      stopReason: `archon runtime is offline: postgres is configured but unreachable. Task ${taskId} cannot be marked complete without runtime confirmation. Restore postgres connectivity and retry, or remove ARCHON_CORE_DATABASE_URL from .env to fall back to local state only.`
    };
  }

  // Council review gate: task packet declares council required and outcome is not approved-class.
  // This is a pre-implementation planning gate and fires before the verification cert gate so that
  // missing council approval is the first actionable signal when both gates are unmet.
  const APPROVED_COUNCIL_OUTCOMES = new Set(["approved", "approved_with_conditions", "exception_granted", "inherited"]);
  if (
    !taskShouldHold &&
    context.activeTaskId &&
    context.councilRequired === true &&
    !APPROVED_COUNCIL_OUTCOMES.has(context.councilOutcome)
  ) {
    const outcomeLabel = typeof context.councilOutcome === "string" && context.councilOutcome ? context.councilOutcome : "unset";
    return {
      continue: false,
      stopReason: `task ${context.activeTaskId} requires Design and Architecture Council review but the task packet council outcome is "${outcomeLabel}"; record an approved-class outcome in the ## Council review section before the session closes`
    };
  }

  // Verification cert gate: require at least one passing verification before session closes.
  // Fires only when Claude signals completion, reviews pass, runtime is reachable, and council is approved.
  // Opt-out via ## Verification required: false in the task packet.
  if (!taskShouldHold && context.activeTaskId && context.verificationRequired !== false) {
    const passedCommands = context.verificationCert?.passedCommands ?? [];
    if (
      Array.isArray(context.requiredVerifications) &&
      context.requiredVerifications.length > 0
    ) {
      const missing = context.requiredVerifications.filter(
        (req) => !isVerificationSatisfied(req, passedCommands)
      );
      if (missing.length > 0) {
        return {
          continue: false,
          stopReason: `task ${context.activeTaskId} is missing required verification evidence for: ${missing.join(", ")}. Run these commands and ensure they pass before the session closes.`
        };
      }
    } else if (passedCommands.length === 0) {
      let stopReason = `task ${context.activeTaskId} has no passing verification evidence. Run: npm run test  OR  bash scripts/check-archon-workflow.sh --task-id ${context.activeTaskId}`;
      if (context.verificationOptOutRejected === true) {
        const taskClassLabel = typeof context.taskClass === "string" && context.taskClass ? context.taskClass : "unset";
        stopReason += ` (note: "## Verification required: false" was ignored — opt-out is only honored for task classes: docs_only, state_sync, memory_curation, scaffold_only; this task class is "${taskClassLabel}")`;
      }
      return {
        continue: false,
        stopReason
      };
    }
  }

  if (taskShouldHold) {
    return {
      continue: false,
      stopReason: `active archon task ${activeTaskId} remains in progress; continue execution or state the real blocker explicitly`
    };
  }

  return undefined;
}


// ---------------------------------------------------------------------------
// Statusline context observer (R1)
//
// Claude Code's statusline event is the only interactive surface that exposes
// context_window.used_percentage. Without it nothing records context usage in an
// interactive session, so context-guard.json never reaches handoff_required and
// the PreToolUse 70% enforcement never fires. These helpers compute the budget
// state from a statusline payload and produce the guard update + display line.
// ---------------------------------------------------------------------------

function readContextPct(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : fallback;
}

// Mirror of defaultArchonContextPolicy thresholds (src/runtime/context-budget.ts).
export function resolveStatuslineThresholds(env = process.env) {
  return {
    warningPct: readContextPct(env, "ARCHON_CONTEXT_WARNING_PCT", 60),
    handoffPct: readContextPct(env, "ARCHON_CONTEXT_HANDOFF_PCT", 70),
    hardStopPct: readContextPct(env, "ARCHON_CONTEXT_HARD_STOP_PCT", 80)
  };
}

export function evaluateContextBudgetState(usedPct, thresholds) {
  if (usedPct >= thresholds.hardStopPct) return "hard_stop";
  if (usedPct >= thresholds.handoffPct) return "handoff_required";
  if (usedPct >= thresholds.warningPct) return "warning";
  return "normal";
}

// Pull used_percentage out of a statusline payload, tolerating shape variation.
export function extractUsedPercentage(payload) {
  const cw = payload?.context_window;
  const candidates = [
    cw?.used_percentage,
    payload?.used_percentage,
    payload?.context?.used_percentage
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? Number.parseFloat(candidate) : candidate;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.min(100, value));
    }
  }
  return undefined;
}

/**
 * Compute the guard update and display line for a statusline tick.
 *
 * Returns `{ guard, line }` where `guard` is the object to persist to
 * context-guard.json (or undefined to leave the existing guard untouched) and
 * `line` is the status string to print (always a string).
 *
 * Rules:
 *   - No observable context %: leave guard untouched, render a neutral line.
 *   - Existing state "handoff_written": do not overwrite (handoff already
 *     committed for this invocation); only refresh the displayed percentage.
 *   - ARCHON_CONTEXT_MONITOR=observe: downgrade handoff_required -> warning so
 *     the observer records data without blocking (mirrors ContextBudgetMonitor).
 *   - Invocation id: reuse the active guard's invocation id; otherwise fall back
 *     to the session id, otherwise the literal "interactive" so enforcement
 *     still applies to unmanaged interactive sessions (FR-6).
 */
export function computeStatuslineGuardUpdate(payload, existingGuard, env = process.env) {
  const usedPct = extractUsedPercentage(payload);
  if (usedPct === undefined) {
    return { guard: undefined, line: "archon ctx —" };
  }

  const rounded = Math.round(usedPct * 10) / 10;
  const existingState =
    existingGuard && typeof existingGuard.state === "string" ? existingGuard.state : undefined;

  // Once a handoff has been committed for the active invocation, don't clobber
  // the committed state — just refresh the displayed percentage.
  if (existingState === "handoff_written") {
    return {
      guard: { ...existingGuard, contextPct: rounded, updatedAt: new Date().toISOString() },
      line: `archon ctx ${rounded}% handoff_written`
    };
  }

  const thresholds = resolveStatuslineThresholds(env);
  let state = evaluateContextBudgetState(usedPct, thresholds);

  if (env?.ARCHON_CONTEXT_MONITOR === "observe" && state === "handoff_required") {
    state = "warning";
  }

  const invocationId =
    (existingGuard && typeof existingGuard.invocationId === "string" && existingGuard.invocationId) ||
    (typeof payload?.session_id === "string" && payload.session_id) ||
    "interactive";

  const guard = {
    invocationId,
    state,
    contextPct: rounded,
    source: "statusline",
    updatedAt: new Date().toISOString()
  };

  return { guard, line: `archon ctx ${rounded}% ${state}` };
}


// ---------------------------------------------------------------------------
// SubagentStop capture (R3)
//
// Claude Code fires SubagentStop when an Agent-tool subagent finishes. This is
// the safety net that records the child's transcript and status even when the
// parent never called archon_subtask_result, so subagent work is auditable as a
// runtime record (§14.1, FR-16).
// ---------------------------------------------------------------------------

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Build a durable audit record for a SubagentStop event from the hook payload.
 * Pure: no I/O. Always returns an object with a `stoppedAt` timestamp.
 */
export function buildSubagentStopRecord(payload, nowIso = new Date().toISOString()) {
  return {
    stoppedAt: nowIso,
    sessionId: firstString(payload?.session_id, payload?.sessionId),
    transcriptPath: firstString(
      payload?.transcript_path,
      payload?.transcriptPath,
      payload?.subagent?.transcript_path
    ),
    subagentType: firstString(
      payload?.agent_type,
      payload?.subagent_type,
      payload?.subagent?.type,
      payload?.subagent?.name
    ),
    stopHookActive: payload?.stop_hook_active === true
  };
}

/**
 * Decide whether a single pending subtask can be safely attributed to this
 * SubagentStop event. Returns the subtask id when exactly one pending,
 * un-resulted subtask exists; otherwise undefined (avoid mis-attribution when
 * the mapping is ambiguous).
 */
export function selectSubtaskForStop(subtasks) {
  if (!Array.isArray(subtasks)) return undefined;
  const pending = subtasks.filter(
    (subtask) =>
      subtask &&
      subtask.status !== "completed" &&
      subtask.status !== "failed" &&
      (subtask.resultPacket === undefined || subtask.resultPacket === null)
  );
  return pending.length === 1 ? pending[0].id : undefined;
}
