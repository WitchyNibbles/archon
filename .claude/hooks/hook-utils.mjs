import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

const managedPathPrefixes = ["CLAUDE.md", ".claude/", ".archon/memory/"];
const destructiveCommandPatterns = [
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\brm\s+-rf\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/
];
const verificationCommandPatterns = [
  /\bnpm\s+(run\s+)?(test|typecheck|check:[^\s]+)\b/,
  /\bvitest\b/,
  /\bpytest\b/,
  /\bpython\s+-m\s+pytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\btsc\b/,
  /\bnode\b.*\s--test\b/,
  /\bbash\s+scripts\/check-/,
  /\barchon:verify\b/
];
const readOnlyCommandSegmentPatterns = [
  /^(?:pwd|true|:)\b/,
  /^(?:cat|nl|wc|head|tail|ls|find|rg)\b/,
  /^sed\s+-n\b/,
  /^(?:echo|printf)\b/,
  /^git\s+show\b/
];
const writeLikeCommandSegmentPatterns = [
  />/,
  /\btee\b/,
  /\btouch\b/,
  /\bmkdir\b/,
  /\bcp\b/,
  /\bmv\b/,
  /\binstall\b/,
  /\bsed\s+-i\b/,
  /\bperl\b[^\n]*\s-i\b/,
  /\bpython(?:3)?\b[^\n]*\s-c\b/,
  /\bnode\b[^\n]*\s-e\b/,
  /\bgit\s+(?:apply|checkout|restore|clean|rm|mv)\b/
];
const blockerMessagePatterns = [
  /need user input/i,
  /requires user input/i,
  /waiting for user/i,
  /waiting for approval/i,
  /blocked on approval/i,
  /cannot continue without/i
];
const transientModelCapacityPatterns = [
  /\bhigh usage\b/i,
  /\bheavy traffic\b/i,
  /\btraffic is high\b/i,
  /\brate limit(?:ed|ing)?\b/i,
  /\btoo many requests\b/i
];
const modelSwitchPromptPatterns = [
  /\bselect another model\b/i,
  /\bchoose another model\b/i,
  /\btry another model\b/i,
  /\bswitch(?:ing)? to another model\b/i
];
const explicitBlockerVerbPatterns = [
  /\bblocked\b/i,
  /cannot continue/i,
  /\bcan't continue\b/i,
  /unable to continue/i,
  /\bout of scope\b/i,
  /outside explicit task scope/i,
  /outside the active archon task write scope/i
];
const explicitExternalWaitBlockerVerbPatterns = [
  /\breal blocker\b/i,
  /\bremaining blocker\b/i,
  /cannot be completed yet/i,
  /cannot be completed until/i,
  /cannot complete until/i
];
const explicitArchonBlockerCausePatterns = [
  /\bwrite scope\b/i,
  /\bmanaged control-layer\b/i,
  /\bactive archon task\b/i,
  /\bexplicit task scope\b/i,
  /\bqueue state\b/i,
  /\btask state\b/i,
  /\bstate mismatch\b/i,
  /\bcurrent_task_id\b/i,
  /\.archon\/ACTIVE\b/i,
  /\bpermission denied\b/i,
  /\bwrite scope locked\b/i,
  /\bout of scope\b/i
];
const explicitExternalWaitCausePatterns = [
  /\bexternal elapsed time\b/i,
  /\bobserved hours?\b/i,
  /\bwaiting interval\b/i,
  /\bwaiting period\b/i,
  /\bobservation (?:period|window)\b/i,
  /\bvalidation window\b/i,
  /\buntil time passes\b/i,
  /\btime must pass\b/i
];
const completionMessagePatterns = [
  /\bno blocker remains\b/i,
  /\bscoped task is complete\b/i,
  /\bnothing left to execute within the active task scope\b/i,
  /\bnothing left to execute within the task scope\b/i
];
const externalClosureCausePatterns = [
  /\bexternal workflow\/runtime closure\b/i,
  /\bexternal runtime\/workflow closure\b/i,
  /\bexternal workflow closure\b/i,
  /\bexternal runtime closure\b/i
];
const continuationIntentValues = new Set([
  "continue_now",
  "defer_same_thread",
  "defer_fresh_run",
  "blocked_external",
  "unknown"
]);
const hookBlockerKinds = new Set([
  "command_not_found",
  "environment_missing",
  "runtime_preflight",
  "connection_refused",
  "permission_denied",
  "generic_nonzero_bash"
]);

export async function readHookPayload() {
  let content = "";
  try {
    content = readFileSync(0, "utf8");
  } catch {
    content = "";
  }

  if (content.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function readJsonIfExists(filePath) {
  const raw = await readTextIfExists(filePath);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function hookBlockerStatePath(resolvedRepoRoot) {
  return path.join(resolvedRepoRoot, ".archon", "work", "daemon", "hook-blocker-state.json");
}

function firstNonEmptyLine(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function normalizeToolOutput(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join("\n");
  }

  return "";
}

function buildCommandFingerprint(command) {
  return createHash("sha1").update(typeof command === "string" ? command : "").digest("hex");
}

export function classifyBashFailure(payload) {
  const toolResponse =
    payload?.tool_response && typeof payload.tool_response === "object" && !Array.isArray(payload.tool_response)
      ? payload.tool_response
      : {};
  const exitCode = getBashExitCode(toolResponse);
  if (typeof exitCode !== "number" || exitCode === 0) {
    return undefined;
  }

  const command = extractToolCommand(payload);
  const stdout = normalizeToolOutput(toolResponse.stdout);
  const stderr = normalizeToolOutput(toolResponse.stderr);
  const combined = `${stderr}\n${stdout}`.trim();

  let blockerKind = "generic_nonzero_bash";
  if (/\b(command not found|not found|enoent|no such file or directory)\b/i.test(combined)) {
    blockerKind = "command_not_found";
  } else if (/\b(runtime execution preflight failed|runtime preflight)\b/i.test(combined)) {
    blockerKind = "runtime_preflight";
  } else if (/\b(connection refused|econnrefused|daemon unavailable)\b/i.test(combined)) {
    blockerKind = "connection_refused";
  } else if (/\b(permission denied|eacces)\b/i.test(combined)) {
    blockerKind = "permission_denied";
  } else if (
    /\bdocker\b/i.test(command) &&
    /\b(unavailable|missing|not installed|cannot connect)\b/i.test(combined)
  ) {
    blockerKind = "environment_missing";
  } else if (/\b(environment missing|missing dependency|required dependency)\b/i.test(combined)) {
    blockerKind = "environment_missing";
  }

  const summary =
    firstNonEmptyLine(stderr) ??
    firstNonEmptyLine(stdout) ??
    `bash command failed with exit code ${exitCode}`;

  return {
    toolName: "Bash",
    command,
    commandFingerprint: buildCommandFingerprint(command),
    exitCode,
    blockerKind,
    summary,
    details: combined
  };
}

export function persistHookBlockerState(repoRootPath, input) {
  const targetPath = hookBlockerStatePath(repoRootPath);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    `${JSON.stringify(
      {
        version: 1,
        activeTaskId: input.activeTaskId,
        queueCurrentTaskId: input.queueCurrentTaskId,
        turnId: input.turnId,
        toolName: input.toolName,
        command: input.command,
        commandFingerprint: input.commandFingerprint,
        exitCode: input.exitCode,
        blockerKind: input.blockerKind,
        summary: input.summary,
        details: input.details,
        recordedAt: input.recordedAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

export function clearHookBlockerState(repoRootPath) {
  try {
    rmSync(hookBlockerStatePath(repoRootPath), { force: true });
  } catch {
    // ignore hook cleanup failures
  }
}

async function readHookBlockerState(resolvedRepoRoot, activeTaskId, queueCurrentTaskId) {
  const parsed = await readJsonIfExists(hookBlockerStatePath(resolvedRepoRoot));
  if (!parsed) {
    return undefined;
  }

  const blockerKind =
    typeof parsed.blockerKind === "string" && hookBlockerKinds.has(parsed.blockerKind)
      ? parsed.blockerKind
      : undefined;
  const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary : undefined;
  const recordTaskId =
    typeof parsed.activeTaskId === "string" && parsed.activeTaskId.trim().length > 0
      ? parsed.activeTaskId.trim()
      : undefined;
  const effectiveTaskId = activeTaskId ?? (typeof queueCurrentTaskId === "string" ? queueCurrentTaskId : undefined);

  if (!blockerKind || !summary || !recordTaskId || !effectiveTaskId || recordTaskId !== effectiveTaskId) {
    return undefined;
  }

  return {
    version: 1,
    activeTaskId: recordTaskId,
    queueCurrentTaskId:
      typeof parsed.queueCurrentTaskId === "string" && parsed.queueCurrentTaskId.trim().length > 0
        ? parsed.queueCurrentTaskId.trim()
        : undefined,
    turnId: typeof parsed.turnId === "string" ? parsed.turnId : undefined,
    toolName: "Bash",
    command: typeof parsed.command === "string" ? parsed.command : "",
    commandFingerprint:
      typeof parsed.commandFingerprint === "string" && parsed.commandFingerprint.trim().length > 0
        ? parsed.commandFingerprint
        : buildCommandFingerprint(typeof parsed.command === "string" ? parsed.command : ""),
    exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : undefined,
    blockerKind,
    summary,
    details: typeof parsed.details === "string" ? parsed.details : "",
    recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : undefined
  };
}

function parseDotEnv(content) {
  const values = {};
  if (typeof content !== "string" || content.trim().length === 0) {
    return values;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      values[key] = value;
    }
  }

  return values;
}

async function readRuntimeAuthorityContext(resolvedRepoRoot) {
  const dotEnv = parseDotEnv(
    await readTextIfExists(path.join(resolvedRepoRoot, ".env"))
  );
  const connectionString =
    process.env.ARCHON_CORE_DATABASE_URL || dotEnv.ARCHON_CORE_DATABASE_URL;
  const workspaceSlug =
    process.env.ARCHON_WORKSPACE_SLUG || dotEnv.ARCHON_WORKSPACE_SLUG;
  const projectSlug =
    process.env.ARCHON_PROJECT_SLUG || dotEnv.ARCHON_PROJECT_SLUG;

  if (!connectionString || !workspaceSlug || !projectSlug) {
    return undefined;
  }

  let client;
  try {
    const pgModule = await import("pg");
    const Client = pgModule.Client ?? pgModule.default?.Client;
    if (!Client) {
      return undefined;
    }

    client = new Client({ connectionString });
    await client.connect();
    const projectId = `project:${workspaceSlug}:${projectSlug}`;
    const result = await client.query(
      `
        select
          active_task_id,
          task_queue->>'current_task_id' as current_task_id
        from project_runtime_state
        where project_id = $1
        limit 1
      `,
      [projectId]
    );

    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    const activeTaskId =
      typeof row.active_task_id === "string" && row.active_task_id.trim().length > 0
        ? row.active_task_id.trim()
        : undefined;
    const queueCurrentTaskId =
      row.current_task_id === null
        ? null
        : typeof row.current_task_id === "string" && row.current_task_id.trim().length > 0
          ? row.current_task_id.trim()
          : undefined;

    return {
      activeTaskId,
      queueCurrentTaskId
    };
  } catch {
    return undefined;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore runtime cleanup failures inside hook context
      }
    }
  }
}

export async function readActiveTaskContext(options = {}) {
  const resolvedRepoRoot =
    options && typeof options.repoRoot === "string" && options.repoRoot.trim().length > 0
      ? path.resolve(options.repoRoot)
      : repoRoot;
  const activePath = path.join(resolvedRepoRoot, ".archon", "ACTIVE");
  const activeContent = await readTextIfExists(activePath);
  const context = {
    repoRoot: resolvedRepoRoot,
    activeTaskId: undefined,
    allowedWriteScope: [],
    allowedTaskHandoffScope: [],
    continuationIntent: undefined,
    hookBlockerState: undefined,
    queueCurrentTaskId: undefined,
    authorityMismatches: []
  };
  const runtimeContext = await readRuntimeAuthorityContext(resolvedRepoRoot);
  let activeFileTaskId;
  let activeFileState;
  let queueHasAuthoritativePointer = false;

  if (runtimeContext) {
    context.queueCurrentTaskId = runtimeContext.queueCurrentTaskId;
    context.activeTaskId =
      runtimeContext.activeTaskId ??
      (typeof runtimeContext.queueCurrentTaskId === "string"
        ? runtimeContext.queueCurrentTaskId
        : undefined);
  }

  if (activeContent) {
    for (const rawLine of activeContent.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("task_id=")) {
        const taskId = line.slice("task_id=".length).trim();
        if (taskId) {
          activeFileTaskId = taskId;
        }
      }
      if (line.startsWith("state=")) {
        const state = line.slice("state=".length).trim();
        if (state) {
          activeFileState = state;
        }
      }
    }
  }

  const queueContent = await readTextIfExists(
    path.join(resolvedRepoRoot, ".archon", "work", "task-queue.json")
  );
  if (queueContent) {
    try {
      const parsed = JSON.parse(queueContent);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.prototype.hasOwnProperty.call(parsed, "current_task_id")
      ) {
        queueHasAuthoritativePointer = true;
        const currentTaskId = parsed.current_task_id;
        if (typeof currentTaskId === "string" && currentTaskId.trim().length > 0) {
          context.queueCurrentTaskId = currentTaskId.trim();
        } else if (currentTaskId === null) {
          context.queueCurrentTaskId = null;
        }
      }
    } catch {
      // ignore invalid queue exports inside hook context
    }
  }

  if (queueHasAuthoritativePointer) {
    if (runtimeContext === undefined) {
      context.activeTaskId =
        typeof context.queueCurrentTaskId === "string" ? context.queueCurrentTaskId : undefined;
    }
  } else if (activeFileTaskId && activeFileState !== "complete" && activeFileState !== "done") {
    if (runtimeContext === undefined) {
      context.activeTaskId = activeFileTaskId;
    }
  }

  if (
    activeFileTaskId &&
    activeFileState === "active" &&
    queueHasAuthoritativePointer &&
    context.queueCurrentTaskId !== undefined &&
    activeFileTaskId !== context.queueCurrentTaskId
  ) {
    context.authorityMismatches.push({
      kind: "active_file_conflicts_with_queue",
      activeFileTaskId,
      queueCurrentTaskId: context.queueCurrentTaskId
    });
  }

  if (
    runtimeContext &&
    runtimeContext.activeTaskId !== undefined &&
    runtimeContext.queueCurrentTaskId !== undefined &&
    runtimeContext.activeTaskId !== runtimeContext.queueCurrentTaskId
  ) {
    context.authorityMismatches.push({
      kind: "runtime_conflicts_with_queue",
      runtimeActiveTaskId: runtimeContext.activeTaskId,
      queueCurrentTaskId: runtimeContext.queueCurrentTaskId
    });
  }

  if (!context.activeTaskId) {
    return context;
  }

  const taskMarkdown = await readTextIfExists(
    path.join(resolvedRepoRoot, ".archon", "work", "tasks", `task-${context.activeTaskId}.md`)
  );
  if (!taskMarkdown) {
    return context;
  }

  context.allowedWriteScope = parseAllowedWriteScopeSection(taskMarkdown);
  context.allowedTaskHandoffScope = parseAllowedTaskHandoffScopeSection(taskMarkdown);
  context.continuationIntent = parseContinuationIntentSection(taskMarkdown);
  context.hookBlockerState = await readHookBlockerState(
    resolvedRepoRoot,
    context.activeTaskId,
    context.queueCurrentTaskId
  );
  return context;
}

function parseMarkdownListSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) {
    return [];
  }

  const values = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("## ")) {
      break;
    }
    if (line === "" || line.startsWith("### ")) {
      continue;
    }

    const normalized = line
      .replace(/`/g, "")
      .replace(/^[*-]\s*/, "")
      .trim();

    if (normalized) {
      values.push(normalized);
    }
  }

  return values;
}

function parseAllowedWriteScopeSection(markdown) {
  return parseMarkdownListSection(markdown, "## Allowed write scope").flatMap((value) =>
    value
      .split(/\s*,\s*|\s*;\s*|\s+\band\b\s+/i)
      .map((entry) => entry.trim().replace(/^and\s+/i, "").replace(/[.:;]+$/g, ""))
      .filter(Boolean)
  );
}

function parseAllowedTaskHandoffScopeSection(markdown) {
  return parseMarkdownListSection(markdown, "## Allowed successor task scope").flatMap((value) =>
    value
      .split(/\s*,\s*|\s*;\s*|\s+\band\b\s+/i)
      .map((entry) => entry.trim().replace(/^and\s+/i, "").replace(/[.:;]+$/g, ""))
      .filter(Boolean)
  );
}

function parseContinuationIntentSection(markdown) {
  const [value] = parseMarkdownListSection(markdown, "## Continuation intent");
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().replace(/`/g, "");
  return continuationIntentValues.has(normalized) ? normalized : undefined;
}

function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isManagedPath(relativePath) {
  const normalized = normalizePath(relativePath);
  return managedPathPrefixes.some((prefix) =>
    normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix)
  );
}

export function isAllowedPath(relativePath, allowedWriteScope) {
  if (!Array.isArray(allowedWriteScope) || allowedWriteScope.length === 0) {
    return true;
  }

  const normalized = normalizePath(relativePath);
  return allowedWriteScope.some((scope) => {
    const normalizedScope = normalizePath(scope);
    return (
      normalized === normalizedScope ||
      normalized.startsWith(`${normalizedScope}/`) ||
      normalizedScope === "."
    );
  });
}

// Managed paths always require explicit scope — empty scope means no access.
// Unlike isAllowedPath, this never grants access by default.
// Use for Write/Edit where the exact target path is known.
export function isManagedPathAllowed(relativePath, allowedWriteScope) {
  if (!Array.isArray(allowedWriteScope) || allowedWriteScope.length === 0) {
    return false;
  }
  return isAllowedPath(relativePath, allowedWriteScope);
}

// For Bash commands we can only detect the managed prefix (e.g. ".claude"), not
// the specific target path. Allow if any scope entry overlaps with that prefix.
export function isManagedPrefixPartiallyAllowed(managedPrefix, allowedWriteScope) {
  if (!Array.isArray(allowedWriteScope) || allowedWriteScope.length === 0) {
    return false;
  }
  const normalized = normalizePath(managedPrefix);
  return allowedWriteScope.some((scope) => {
    const normalizedScope = normalizePath(scope);
    return (
      normalizedScope === normalized ||
      normalizedScope.startsWith(`${normalized}/`) ||
      normalized.startsWith(`${normalizedScope}/`) ||
      normalizedScope === "."
    );
  });
}

export function isTaskPacketPath(relativePath) {
  const normalized = normalizePath(relativePath);
  return normalized.startsWith(".archon/work/tasks/task-") && normalized.endsWith(".md");
}

export function parseApplyPatchTargets(command) {
  if (typeof command !== "string") {
    return [];
  }

  const targets = [];
  const pattern = /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
  for (const match of command.matchAll(pattern)) {
    const target = (match[1] ?? match[2] ?? "").trim();
    if (target) {
      targets.push(normalizePath(target));
    }
  }
  return [...new Set(targets)];
}

export function extractToolCommand(payload) {
  const toolInput = payload?.tool_input;
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    const command = toolInput.command;
    if (typeof command === "string") {
      return command;
    }
  }
  return "";
}

export function isDestructiveCommand(command) {
  return destructiveCommandPatterns.some((pattern) => pattern.test(command));
}

export function isVerificationCommand(command) {
  return verificationCommandPatterns.some((pattern) => pattern.test(command));
}

export function extractBashReferencedManagedPaths(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }

  const matches = [];
  for (const prefix of managedPathPrefixes) {
    const plainPrefix = prefix.replace(/\/$/, "");
    if (command.includes(prefix) || command.includes(plainPrefix)) {
      matches.push(plainPrefix);
    }
  }
  return [...new Set(matches)];
}

export function isReadOnlyBashCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return false;
  }

  const segments = command
    .split(/\&\&|\|\||[|;]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  return segments.every((segment) => {
    if (writeLikeCommandSegmentPatterns.some((pattern) => pattern.test(segment))) {
      return false;
    }

    return readOnlyCommandSegmentPatterns.some((pattern) => pattern.test(segment));
  });
}

export function getBashExitCode(toolResponse) {
  if (!toolResponse || typeof toolResponse !== "object" || Array.isArray(toolResponse)) {
    return undefined;
  }

  for (const key of ["exitCode", "exit_code", "code", "status"]) {
    const value = toolResponse[key];
    if (typeof value === "number") {
      return value;
    }
  }

  return undefined;
}

export function shouldHoldStop(lastAssistantMessage) {
  if (typeof lastAssistantMessage !== "string" || lastAssistantMessage.trim().length === 0) {
    return true;
  }

  const hasTransientModelCapacitySignal = transientModelCapacityPatterns.some((pattern) =>
    pattern.test(lastAssistantMessage)
  );
  const hasModelSwitchPrompt = modelSwitchPromptPatterns.some((pattern) =>
    pattern.test(lastAssistantMessage)
  );
  if (hasTransientModelCapacitySignal && hasModelSwitchPrompt) {
    return true;
  }

  if (blockerMessagePatterns.some((pattern) => pattern.test(lastAssistantMessage))) {
    return false;
  }

  const hasExplicitCompletionMessage = completionMessagePatterns.some((pattern) =>
    pattern.test(lastAssistantMessage)
  );
  const hasExternalClosureCause = externalClosureCausePatterns.some((pattern) =>
    pattern.test(lastAssistantMessage)
  );
  if (hasExplicitCompletionMessage && hasExternalClosureCause) {
    return false;
  }

  const hasExplicitBlockerVerb = explicitBlockerVerbPatterns.some((pattern) =>
    pattern.test(lastAssistantMessage)
  );
  const hasExplicitArchonBlockerCause = explicitArchonBlockerCausePatterns.some((pattern) =>
    pattern.test(lastAssistantMessage)
  );
  const hasExplicitExternalWaitBlockerVerb = explicitExternalWaitBlockerVerbPatterns.some((pattern) =>
    pattern.test(lastAssistantMessage)
  );
  const hasExplicitExternalWaitCause = explicitExternalWaitCausePatterns.some((pattern) =>
    pattern.test(lastAssistantMessage)
  );

  if (hasExplicitExternalWaitBlockerVerb && hasExplicitExternalWaitCause) {
    return false;
  }

  return !(hasExplicitBlockerVerb && hasExplicitArchonBlockerCause);
}
