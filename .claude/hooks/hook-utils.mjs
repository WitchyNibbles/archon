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
  /^git\s+show\b/,
  /^(?:grep|egrep|fgrep)\b/,
  /^awk\b/,
  /^diff\b/,
  /^stat\b/,
  /^file\b/,
  /^which\b/,
  /^jq\b/,
  /^sort\b/,
  /^uniq\b/,
  /^cut\b/,
  /^tr\b/,
  /^git\s+log\b/,
  /^git\s+diff\b/,
  /^git\s+status\b/,
  /^git\s+rev-parse\b/,
  /^git\s+ls-files\b/,
  /^git\s+blame\b/,
  /^git\s+remote(?:\s+-v|\s*$)/,
  /^git\s+branch\s+--show-current\b/
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

export function normalizeToolOutput(value) {
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
      return { activeTaskId: undefined, queueCurrentTaskId: undefined, runtimeConnected: false };
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
      queueCurrentTaskId,
      runtimeConnected: true
    };
  } catch {
    // Env vars were present but connection failed — signal configured-but-offline.
    return { activeTaskId: undefined, queueCurrentTaskId: undefined, runtimeConnected: false };
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
    authorityMismatches: [],
    requiredReviews: [],
    missingReviews: [],
    invalidReviews: [],
    verificationRequired: true,
    verificationOptOutRejected: false,
    taskClass: undefined,
    requiredVerifications: [],
    verificationCert: undefined,
    runtimeConfigured: false,
    runtimeConnected: false,
    councilRequired: false,
    councilOutcome: undefined
  };
  const runtimeContext = await readRuntimeAuthorityContext(resolvedRepoRoot);
  context.runtimeConfigured = runtimeContext !== undefined;
  context.runtimeConnected = runtimeContext?.runtimeConnected === true;
  let activeFileTaskId;
  let activeFileState;
  let queueHasAuthoritativePointer = false;

  if (runtimeContext?.runtimeConnected === true) {
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
          const taskEntry = Array.isArray(parsed.tasks)
            ? parsed.tasks.find((t) => t && typeof t === "object" && t.id === currentTaskId.trim())
            : undefined;
          const taskIsComplete =
            taskEntry && (taskEntry.status === "complete" || taskEntry.status === "done");
          context.queueCurrentTaskId = taskIsComplete ? null : currentTaskId.trim();
        } else if (currentTaskId === null) {
          context.queueCurrentTaskId = null;
        }
      }
    } catch {
      // ignore invalid queue exports inside hook context
    }
  }

  if (queueHasAuthoritativePointer) {
    if (!runtimeContext?.runtimeConnected) {
      context.activeTaskId =
        typeof context.queueCurrentTaskId === "string" ? context.queueCurrentTaskId : undefined;
    }
  } else if (activeFileTaskId && activeFileState !== "complete" && activeFileState !== "done") {
    if (!runtimeContext?.runtimeConnected) {
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

  const requiredRoles = parseRequiredReviews(taskMarkdown);
  context.requiredReviews = requiredRoles;
  context.missingReviews = [];
  context.invalidReviews = [];
  for (const role of requiredRoles) {
    const relPath = reviewArtifactPath(context.activeTaskId, role);
    const content = await readTextIfExists(path.join(resolvedRepoRoot, relPath));
    if (content === undefined) {
      context.missingReviews.push(relPath);
    } else {
      const validation = validateReviewArtifact(content, context.activeTaskId, role);
      if (!validation.valid) {
        context.invalidReviews.push(`${relPath} (${validation.reason})`);
      }
    }
  }

  const parsedVerificationRequired = parseVerificationRequired(taskMarkdown);
  const parsedTaskClass = parseTaskClass(taskMarkdown);
  context.taskClass = parsedTaskClass;
  if (parsedVerificationRequired === false && !verificationExemptTaskClasses.includes(parsedTaskClass)) {
    context.verificationRequired = true;
    context.verificationOptOutRejected = true;
  } else {
    context.verificationRequired = parsedVerificationRequired;
    context.verificationOptOutRejected = false;
  }
  context.requiredVerifications = parseRequiredVerifications(taskMarkdown);
  context.verificationCert = readVerificationCert(resolvedRepoRoot, context.activeTaskId);

  const councilInfo = parseCouncilReview(taskMarkdown);
  const qualityGates = parseMarkdownListSection(taskMarkdown, "## Quality gates");
  const hasCouncilGate = qualityGates.some((g) => g.trim() === "council_review_required");
  context.councilRequired =
    councilInfo.required === "true" || hasCouncilGate;
  context.councilOutcome = councilInfo.outcome;

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

const DEFAULT_REVIEW_ROLES = ["reviewer", "security_reviewer", "qa_engineer"];
const VALID_ROLE_PATTERN = /^[a-z][a-z0-9_-]*$/;

export function parseRequiredReviews(markdown) {
  const fromReviews = parseMarkdownListSection(markdown, "## Required reviews").map((v) => v.trim());
  const fromSpecialist = parseMarkdownListSection(markdown, "## Required specialist roles").map((v) => v.trim());

  // Merge and deduplicate
  const merged = [...new Set([...fromReviews, ...fromSpecialist])];

  // Keep only valid role identifiers (drops prose sentences from template instructional text)
  const valid = merged.filter((entry) => VALID_ROLE_PATTERN.test(entry));

  // Explicit opt-out: if any entry is exactly "none", return empty
  if (valid.some((entry) => entry === "none")) {
    return [];
  }

  // If no valid roles found (sections absent or prose-only), return the default trio
  if (valid.length === 0) {
    return DEFAULT_REVIEW_ROLES;
  }

  return valid;
}

export function reviewArtifactPath(taskId, role) {
  return `.archon/work/reviews/review-${taskId}-${role}.md`;
}

// Claude Code tool calls pass absolute file_path values; scope entries are relative.
// Strip the repo root prefix so path comparisons work correctly regardless of how
// Claude Code formats the path.
export function toRelativePath(filePath, repoRoot) {
  if (typeof filePath !== "string" || !filePath.startsWith("/")) {
    return filePath;
  }
  if (typeof repoRoot === "string" && repoRoot.length > 0) {
    const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
    if (filePath.startsWith(prefix)) {
      return filePath.slice(prefix.length);
    }
  }
  return filePath;
}

function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isManagedPath(relativePath) {
  const normalized = normalizePath(relativePath);
  return managedPathPrefixes.some((prefix) => {
    const normalizedPrefix = normalizePath(prefix);
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
  });
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

// Returns true for any write target that requires an active task.
// Bootstrap paths (needed to create a task packet) are always exempt.
export function isSubstantiveWriteTarget(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    return false;
  }
  const normalized = normalizePath(relativePath);
  if (normalized === ".archon/ACTIVE") return false;
  if (normalized === ".archon/work/task-queue.json") return false;
  if (normalized === ".archon/work/product-state.md") return false;
  if (isTaskPacketPath(normalized)) return false;
  return true;
}

function verificationCertPath(repoRootPath, taskId) {
  return path.join(repoRootPath, ".archon", "work", "daemon", `verification-cert-${taskId}.json`);
}

export function persistVerificationCert(repoRootPath, taskId, command) {
  const certPath = verificationCertPath(repoRootPath, taskId);
  mkdirSync(path.dirname(certPath), { recursive: true });
  let existing = { version: 1, taskId, passedCommands: [] };
  try {
    const raw = readFileSync(certPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.passedCommands)) {
      existing = parsed;
    }
  } catch {
    // start fresh
  }
  existing.passedCommands.push({
    command: typeof command === "string" ? command : "",
    passedAt: new Date().toISOString()
  });
  writeFileSync(certPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

export function readVerificationCert(repoRootPath, taskId) {
  try {
    const raw = readFileSync(verificationCertPath(repoRootPath, taskId), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.passedCommands) &&
      parsed.passedCommands.length > 0
    ) {
      return parsed;
    }
  } catch {
    // no cert
  }
  return undefined;
}

// Patterns that disqualify a command from minting a cert even if it matches
// verificationCommandPatterns (version/help/init invocations prove nothing).
const verificationNoopPatterns = [
  /\s--version\b/,
  /\s--help\b/,
  /(?:^|\s)-h\b(?![\w-])/,
  /\btsc\s+--init\b/
];

export function qualifiesForVerificationCert(command, output) {
  if (typeof command !== "string" || !isVerificationCommand(command)) {
    return false;
  }

  // Disqualify version/help/init invocations — they prove nothing.
  if (verificationNoopPatterns.some((p) => p.test(command))) {
    return false;
  }

  const text = typeof output === "string" ? output : "";

  // node test runner: npm test, npm run test, node ... --test, check:quality
  if (
    /\bnpm\s+(run\s+)?(test|check:[^\s]+)\b/.test(command) ||
    /\bnode\b.*\s--test\b/.test(command)
  ) {
    // TAP summary: "# tests N" with N >= 1 AND "# fail 0"
    const tapTests = /^# tests (\d+)/m.exec(text);
    const tapFail = /^# fail (\d+)/m.exec(text);
    if (tapTests && parseInt(tapTests[1], 10) >= 1 && tapFail && parseInt(tapFail[1], 10) === 0) {
      return true;
    }
    // mocha-style: "N passing" with N >= 1
    const mocha = /(\d+) passing/.exec(text);
    if (mocha && parseInt(mocha[1], 10) >= 1) {
      return true;
    }
    return false;
  }

  // vitest
  if (/\bvitest\b/.test(command)) {
    const m = /(\d+) passed/.exec(text);
    return !!(m && parseInt(m[1], 10) >= 1);
  }

  // pytest / python -m pytest
  if (/\bpytest\b/.test(command) || /\bpython\s+-m\s+pytest\b/.test(command)) {
    const m = /(\d+) passed/.exec(text);
    return !!(m && parseInt(m[1], 10) >= 1);
  }

  // go test
  if (/\bgo\s+test\b/.test(command)) {
    return /^ok\s/m.test(text);
  }

  // cargo test
  if (/\bcargo\s+test\b/.test(command)) {
    const m = /test result: ok\. (\d+) passed/.exec(text);
    return !!(m && parseInt(m[1], 10) >= 1);
  }

  // tsc (typecheck): success is silence — no output requirement
  if (/\btsc\b/.test(command)) {
    return true;
  }

  // bash scripts/check-* and archon:verify: no output requirement (fail loudly on their own)
  if (/\bbash\s+scripts\/check-/.test(command) || /\barchon:verify\b/.test(command)) {
    return true;
  }

  // Unknown verification command — fail closed
  return false;
}

export function parseVerificationRequired(markdown) {
  const lines = parseMarkdownListSection(markdown, "## Verification required");
  if (lines.length === 0) {
    return true;
  }
  const value = lines[0].trim().toLowerCase();
  return value !== "false" && value !== "no" && value !== "skip";
}

export const verificationExemptTaskClasses = ["docs_only", "state_sync", "memory_curation", "scaffold_only"];

export function parseTaskClass(markdown) {
  const lines = parseMarkdownListSection(markdown, "## Task class");
  if (lines.length === 0) {
    return undefined;
  }
  return lines[0].replace(/`/g, "").trim().toLowerCase() || undefined;
}

export function parseRequiredVerifications(markdown) {
  return parseMarkdownListSection(markdown, "## Required verifications")
    .map((v) => v.trim())
    .filter(Boolean);
}

const VERDICT_REGEX = /\b(?:status|verdict|outcome)\b[^a-z0-9\n]{0,5}(?:passed|pass|approved)\b/i;

export function validateReviewArtifact(content, taskId, role) {
  if (typeof content !== "string" || content.trim().length < 200) {
    return { valid: false, reason: "review artifact too short to be a real review" };
  }
  if (!content.includes(taskId)) {
    return { valid: false, reason: `does not reference task ${taskId}` };
  }
  if (!content.includes(role)) {
    return { valid: false, reason: `does not reference role ${role}` };
  }
  if (!VERDICT_REGEX.test(content)) {
    return { valid: false, reason: "missing a passed/approved status line" };
  }
  return { valid: true };
}

const COUNCIL_REQUIRED_TOKENS = new Set(["true", "false", "inherited"]);
const COUNCIL_OUTCOME_TOKENS = new Set([
  "pending",
  "approved",
  "approved_with_conditions",
  "rework_required",
  "exception_granted",
  "rejected",
  "inherited"
]);

export function parseCouncilReview(markdown) {
  const lines = markdown.split(/\r?\n/);

  // Find the ## Council review section
  const councilStart = lines.findIndex((line) => line.trim() === "## Council review");
  if (councilStart === -1) {
    return { required: undefined, outcome: undefined };
  }

  // Find end of council section (next ## heading)
  let councilEnd = lines.length;
  for (let i = councilStart + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("## ") && !lines[i].trim().startsWith("### ")) {
      councilEnd = i;
      break;
    }
  }

  const councilLines = lines.slice(councilStart, councilEnd);

  let required;
  let outcome;

  // Parse ### Required sub-section
  const requiredIdx = councilLines.findIndex((line) => line.trim() === "### Required");
  if (requiredIdx !== -1) {
    for (let i = requiredIdx + 1; i < councilLines.length; i++) {
      const line = councilLines[i].trim();
      if (line.startsWith("### ")) break;
      if (line.length === 0) continue;
      const normalized = line.replace(/`/g, "").replace(/^[*-]\s*/, "").trim().toLowerCase();
      if (COUNCIL_REQUIRED_TOKENS.has(normalized)) {
        required = normalized;
        break;
      }
    }
  }

  // Parse ### Outcome sub-section
  const outcomeIdx = councilLines.findIndex((line) => line.trim() === "### Outcome");
  if (outcomeIdx !== -1) {
    for (let i = outcomeIdx + 1; i < councilLines.length; i++) {
      const line = councilLines[i].trim();
      if (line.startsWith("### ")) break;
      if (line.length === 0) continue;
      const normalized = line.replace(/`/g, "").replace(/^[*-]\s*/, "").trim().toLowerCase();
      if (COUNCIL_OUTCOME_TOKENS.has(normalized)) {
        outcome = normalized;
        break;
      }
    }
  }

  return { required, outcome };
}

export function isVerificationSatisfied(requiredCommand, passedCommands) {
  if (!Array.isArray(passedCommands) || passedCommands.length === 0) {
    return false;
  }
  const normalized = requiredCommand.trim().toLowerCase();
  return passedCommands.some((entry) => {
    const passed = (typeof entry.command === "string" ? entry.command : "").trim().toLowerCase();
    return passed.includes(normalized) || normalized.includes(passed);
  });
}

export function appendBypassLogEntry(repoRootPath, prompt) {
  const logPath = path.join(repoRootPath, ".archon", "work", "daemon", "bypass-log.json");
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    let entries = [];
    try {
      const raw = readFileSync(logPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // file does not exist yet or is invalid — start fresh
    }
    entries.push({
      timestamp: new Date().toISOString(),
      promptExcerpt: typeof prompt === "string" ? prompt.slice(0, 200) : ""
    });
    writeFileSync(logPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  } catch {
    // bypass logging is advisory — never let it break the hook
  }
}

// Best-effort extraction of file paths a bash command writes to.
// Handles: > path, >> path, tee [-a] path, sed -i path, touch path, mkdir path,
// cp src dest, mv src dest, and cat > path <<EOF (covered by > rule).
// Drops: /dev/*, /tmp/*, paths outside repo root, $VARs, process substitutions, empty strings.
// Returns deduped array of repo-relative paths.
export function extractBashWriteTargets(command, repoRoot) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }

  const stripped = stripHeredocBodies(command);
  const segments = stripped.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
  const results = new Set();

  for (const seg of segments) {
    // Clean io-discard redirects (2>&1, 2>/dev/null) so they don't interfere
    const clean = seg
      .replace(/\s+\d*>\/dev\/null\b/g, "")
      .replace(/\s+\d*>&\d+\b/g, "")
      .trim();

    // > path or >> path (not fd>&N which were already stripped)
    // Match > or >> followed by a path that is not /dev/* or $VAR or process substitution
    const redirectPattern = /(?:>>?)\s*([^\s;&|<>()$`][^\s;&|<>()$`]*)/g;
    for (const m of clean.matchAll(redirectPattern)) {
      const p = stripQuotes(m[1]);
      addTarget(p, repoRoot, results);
    }

    // tee [-a] path [path ...]
    const teeMatch = /\btee\s+(?:-a\s+)?(.+)$/.exec(clean);
    if (teeMatch) {
      const parts = teeMatch[1].trim().split(/\s+/);
      // Skip flags like -a
      for (const part of parts) {
        if (part.startsWith("-")) continue;
        const p = stripQuotes(part);
        addTarget(p, repoRoot, results);
      }
    }

    // sed -i[suffix] 's/a/b/' path  — take the last non-flag token that isn't the script
    const sedMatch = /\bsed\s+-i\S*\s+(.+)$/.exec(clean);
    if (sedMatch) {
      const tokens = tokenize(sedMatch[1]);
      // Skip sed script (starts with s/ or 's/ or is quoted expression, or looks like a sed expr)
      // The path is the LAST token that looks like a filesystem path, not a sed expression
      const pathTokens = tokens.filter((t) => {
        const u = stripQuotes(t);
        // Drop sed expressions: start with s/, y/, d, p, etc.
        if (/^[sydigqQ]/.test(u) && (u.includes("/") ? u.split("/").length >= 3 : false)) return false;
        // Drop flags that start with -
        if (u.startsWith("-")) return false;
        return true;
      });
      // Take only the last token as the path (sed operates on file args after the script)
      if (pathTokens.length >= 2) {
        // First token is the script expression, rest are paths
        for (let i = 1; i < pathTokens.length; i++) {
          addTarget(stripQuotes(pathTokens[i]), repoRoot, results);
        }
      } else if (pathTokens.length === 1) {
        addTarget(stripQuotes(pathTokens[0]), repoRoot, results);
      }
    }

    // touch path [path ...]
    const touchMatch = /\btouch\s+(.+)$/.exec(clean);
    if (touchMatch) {
      for (const part of tokenize(touchMatch[1])) {
        if (part.startsWith("-")) continue;
        addTarget(stripQuotes(part), repoRoot, results);
      }
    }

    // mkdir [-p] path [path ...]
    const mkdirMatch = /\bmkdir\s+(.+)$/.exec(clean);
    if (mkdirMatch) {
      for (const part of tokenize(mkdirMatch[1])) {
        if (part.startsWith("-")) continue;
        addTarget(stripQuotes(part), repoRoot, results);
      }
    }

    // cp src dest  — only the LAST arg is the write target
    const cpMatch = /\bcp\s+(?:-\S+\s+)*(.+)$/.exec(clean);
    if (cpMatch) {
      const tokens = tokenize(cpMatch[1]).filter((t) => !t.startsWith("-"));
      if (tokens.length >= 2) {
        addTarget(stripQuotes(tokens[tokens.length - 1]), repoRoot, results);
      }
    }

    // mv src dest — only the LAST arg is the write target
    const mvMatch = /\bmv\s+(?:-\S+\s+)*(.+)$/.exec(clean);
    if (mvMatch) {
      const tokens = tokenize(mvMatch[1]).filter((t) => !t.startsWith("-"));
      if (tokens.length >= 2) {
        addTarget(stripQuotes(tokens[tokens.length - 1]), repoRoot, results);
      }
    }
  }

  return [...results];
}

function stripQuotes(s) {
  if (typeof s !== "string") return "";
  return s.replace(/^['"]|['"]$/g, "");
}

function tokenize(str) {
  if (typeof str !== "string") return [];
  return str.match(/(?:'[^']*'|"[^"]*"|\S+)/g) ?? [];
}

function addTarget(raw, repoRoot, set) {
  if (!raw || raw.startsWith("$") || raw.startsWith("(") || raw.startsWith(">")) return;
  if (raw === "/dev/null" || raw.startsWith("/dev/") || raw.startsWith("/tmp/")) return;
  // Drop process substitutions and bash variables
  if (/^\$[\w{(]/.test(raw)) return;

  let resolved;
  if (raw.startsWith("/")) {
    // Absolute path — must be inside repo root to be tracked
    if (typeof repoRoot === "string" && repoRoot.length > 0) {
      const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
      if (!raw.startsWith(prefix)) return;
      resolved = raw.slice(prefix.length);
    } else {
      return;
    }
  } else {
    resolved = raw;
  }

  const normalized = normalizePath(resolved);
  if (!normalized || normalized.length === 0) return;
  set.add(normalized);
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

function stripHeredocBodies(command) {
  if (typeof command !== "string") return command;
  // Remove heredoc body content so that words like tee or > inside a heredoc
  // do not trigger write-like detection. Handles <<WORD, <<'WORD', <<"WORD",
  // <<`WORD`, and <<-WORD variants. The opener and structure are kept; only the
  // body lines and closing delimiter are removed.
  return command.replace(
    /<<-?['"`]?(\w+)['"`]?[^\n]*\n[\s\S]*?\n\1[ \t]*(?:\n|$)/g,
    "<<STRIPPED\n"
  );
}

// Strip fd>/dev/null and fd>&N redirects from a single segment before write-like
// classification. These discard output and are not writes to any real file.
function stripIoDiscardRedirects(segment) {
  return segment
    .replace(/\s+\d*>\/dev\/null\b/g, "")
    .replace(/\s+\d*>&\d+\b/g, "");
}

export function isReadOnlyBashCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return false;
  }

  const normalized = stripHeredocBodies(command);
  const segments = normalized
    .split(/\&\&|\|\||[|;]/)
    .map((segment) => stripIoDiscardRedirects(segment).trim())
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
