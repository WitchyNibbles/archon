import {
  classifyBashFailure,
  clearHookBlockerState,
  extractBashReferencedManagedPaths,
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
  parseApplyPatchTargets,
  persistHookBlockerState,
  persistVerificationCert,
  reviewArtifactPath,
  shouldHoldStop,
  toRelativePath
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
  }

  if (toolName === "Write" || toolName === "Edit") {
    const rawFilePath = payload?.tool_input?.file_path ?? "";
    // Normalize to relative path — Claude Code may pass absolute paths.
    const filePath = toRelativePath(rawFilePath, context.repoRoot);
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
    // No-task write gate: block substantive writes when no task is active.
    // archon:bypass does NOT apply here — it only affects the UserPromptSubmit advisory.
    if (filePath && !context.activeTaskId && isSubstantiveWriteTarget(filePath)) {
      return {
        decision: "block",
        reason: `write to ${filePath} blocked — no active archon task. To unblock: create a task packet at .archon/work/tasks/task-<id>.md, set .archon/ACTIVE to task_id=<id> and state=active, then retry.`
      };
    }
    // Task-scope gate: when a task is active and declares a non-empty write scope,
    // block writes to files outside that scope.
    if (
      filePath &&
      context.activeTaskId &&
      context.allowedWriteScope.length > 0 &&
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

  if (toolName === "Write" || toolName === "Edit") {
    const isError = payload?.tool_response?.isError === true;
    if (isError && context.activeTaskId) {
      const filePath = payload?.tool_input?.file_path ?? "unknown";
      return {
        additionalContext: `Write/Edit failed for ${filePath}; verify file state before claiming the change complete`
      };
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
    if (isVerificationCommand(command) && context.activeTaskId && context.repoRoot) {
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

  if (Array.isArray(context.authorityMismatches) && context.authorityMismatches.length > 0) {
    return undefined;
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
    if (stopHookActive) {
      return undefined;
    }

    return {
      continue: false,
      stopReason: hookBlockerState.summary
    };
  }

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

  // Verification cert gate: require at least one passing verification before session closes.
  // Fires only when Claude signals completion, reviews pass, and runtime is reachable.
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
      return {
        continue: false,
        stopReason: `task ${context.activeTaskId} has no passing verification evidence. Run: npm run test  OR  bash scripts/check-archon-workflow.sh --task-id ${context.activeTaskId}`
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
