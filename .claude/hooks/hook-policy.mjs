import {
  classifyBashFailure,
  clearHookBlockerState,
  extractBashReferencedManagedPaths,
  extractToolCommand,
  getBashExitCode,
  isAllowedPath,
  isDestructiveCommand,
  isManagedPath,
  isReadOnlyBashCommand,
  isTaskPacketPath,
  isVerificationCommand,
  parseApplyPatchTargets,
  persistHookBlockerState,
  shouldHoldStop
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
      (target) => isManagedPath(target) && !isAllowedTaskTarget(target, context)
    );
    if (managedTarget) {
      return {
        decision: "block",
        reason: `managed control-layer file ${managedTarget} is blocked outside explicit task scope`
      };
    }
  }

  if (toolName === "Bash") {
    if (isDestructiveCommand(command)) {
      return { decision: "block", reason: "destructive shell command blocked by archon policy" };
    }

    const managedTarget = extractBashReferencedManagedPaths(command).find(
      (target) => !isAllowedPath(target, context.allowedWriteScope)
    );
    if (managedTarget && !isReadOnlyBashCommand(command)) {
      return {
        decision: "block",
        reason: `managed control-layer path ${managedTarget} is blocked outside explicit task scope`
      };
    }
  }

  if (toolName === "Write" || toolName === "Edit") {
    const filePath = payload?.tool_input?.file_path ?? "";
    if (filePath && isManagedPath(filePath) && !isAllowedTaskTarget(filePath, context)) {
      if (context.allowedWriteScope.length > 0) {
        return {
          decision: "block",
          reason: `managed control-layer file ${filePath} is blocked outside explicit task scope`
        };
      }
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

  const command = extractToolCommand(payload);
  if (!isVerificationCommand(command)) {
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
  if (!context.activeTaskId && isLikelySubstantiveInitialPrompt(prompt)) {
    return {
      decision: "block",
      reason: [
        "archon: intake required before implementation.",
        "Run /archon-intake to open the intake brief and set the active task.",
        "For trivial tasks only, include 'archon:bypass' anywhere in your message to skip intake."
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

  if ((context.activeTaskId || context.queueCurrentTaskId) && shouldHoldStop(lastAssistantMessage)) {
    return {
      continue: false,
      stopReason: `active archon task ${activeTaskId} remains in progress; continue execution or state the real blocker explicitly`
    };
  }

  return undefined;
}
