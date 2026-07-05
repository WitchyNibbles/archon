import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

const managedPathPrefixes = ["CLAUDE.md", ".claude/", ".archon/memory/", ".archon/work/tasks/", ".archon/work/reviews/", ".archon/work/daemon/"];
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
  /\bnode\s+(?:--experimental-strip-types\s+)?scripts\/check-/,
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
  // NOTE: the bare `/>/` redirect pattern was removed (audit F4). A raw `>` match
  // fired on quoted strings that merely contained the character (e.g.
  // `grep -n "a > b" .claude/x`), producing false-positive managed-path blocks.
  // Real, unquoted output redirects are now detected quote-aware by
  // segmentHasWriteRedirect() below.
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
  /\bgit\s+(?:apply|checkout|restore|clean|rm|mv)\b/,
  // Audit F3: write-action variants that the older name-only patterns missed.
  // `find` is a WRITE when it carries an action flag; it stays read-only only
  // without one (handled by readOnlyCommandSegmentPatterns). `sort -o`/`--output`
  // and `dd of=` write to their output-file operands.
  /\bfind\b[\s\S]*?\s-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprintf)\b/,
  /\bsort\b[^\n]*\s(?:-o|--output)(?:[=\s]|$)/,
  /\bdd\b[^\n]*\bof=/,
  // Review finding F3: `eval "<payload>"` and `sh -c`/`bash -c`/`zsh -c`… run an
  // opaque string. Because the payload lives inside a quoted span it is invisible
  // to write-target extraction and (formerly) the managed-path scan, so it could
  // smuggle a managed-path write (`eval "find .claude -delete"`). Treat these
  // shell-string evaluators as write-like so the command fails closed rather than
  // being classified read-only. Matched against the MASKED segment, so the word
  // `eval` appearing INSIDE another command's quoted argument does not trip it.
  /\beval\b/,
  /\b(?:ba|z|k|da|c)?sh\s+-c\b/
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

// Review finding L1 (reviewer): NOT exported. The only supported way to clear a
// blocker is clearHookBlockerStateForCommand, which enforces the fingerprint /
// verification-kind scoping (audit F10 + review finding F5). An unconditional
// exported clear would let a future caller erase a blocker without that check,
// silently defeating the repair-loop honesty invariant.
function clearHookBlockerState(repoRootPath) {
  try {
    rmSync(hookBlockerStatePath(repoRootPath), { force: true });
  } catch {
    // ignore hook cleanup failures
  }
}

// Audit F10 + review finding F5: clear the recorded hook-blocker state only when
// the succeeding (exit-0) command is meaningfully the one that unblocks it:
//   - its fingerprint matches the recorded blocked command (re-ran it, it passed), OR
//   - it is a verification command AND the recorded blocker was ITSELF a
//     verification failure (a passing test/typecheck clears a failed test/typecheck).
// A verification pass must NOT clear an UNRELATED non-verification blocker (e.g. a
// `connection_refused` on `docker compose up`): that was F5 — verification
// clearing was applied to any recorded blocker regardless of its kind. An
// unrelated exit-0 command (an incidental `ls`) never clears anything. When no
// blocker is recorded there is nothing to clear.
export function clearHookBlockerStateForCommand(repoRootPath, command, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(hookBlockerStatePath(repoRootPath), "utf8"));
  } catch {
    return; // no recorded blocker (or unreadable) — nothing to clear
  }
  const recordedFingerprint =
    parsed && typeof parsed.commandFingerprint === "string" ? parsed.commandFingerprint : undefined;
  const matchesFingerprint =
    recordedFingerprint !== undefined && recordedFingerprint === buildCommandFingerprint(command);
  const recordedCommand = parsed && typeof parsed.command === "string" ? parsed.command : "";
  const recordedWasVerification = isVerificationCommand(recordedCommand);
  const verificationClears = options.isVerification === true && recordedWasVerification;
  if (matchesFingerprint || verificationClears) {
    clearHookBlockerState(repoRootPath);
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
          active_run_id,
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
    const activeRunId =
      typeof row.active_run_id === "string" && row.active_run_id.trim().length > 0
        ? row.active_run_id.trim()
        : undefined;

    // Finding 5 fix: read the active task's write scope from the authoritative
    // runtime task record, not from the on-disk markdown packet (which a worker
    // could edit to widen its own scope). `undefined` means "not found" so the
    // caller falls back to markdown; an array (even empty) is authoritative.
    let allowedWriteScope;
    let councilOutcome;
    let reviewFloorEffective;
    if (activeRunId && activeTaskId) {
      try {
        const taskRow = await client.query(
          `select allowed_write_scope, payload->>'councilOutcome' as council_outcome
           from tasks
           where run_id = $1 and task_key = $2
           limit 1`,
          [activeRunId, activeTaskId]
        );
        const row2 = taskRow.rows[0];
        if (row2 && Array.isArray(row2.allowed_write_scope)) {
          allowedWriteScope = row2.allowed_write_scope
            .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
            .map((entry) => entry.trim());
        }
        // #14 fix: council outcome from the authoritative runtime task record.
        if (row2 && typeof row2.council_outcome === "string" && row2.council_outcome.trim().length > 0) {
          councilOutcome = row2.council_outcome.trim();
        }
      } catch {
        // leave fields undefined so the caller falls back to markdown
      }

      // Option B (slice 5): the runtime is the authority for the effective review
      // floor. A review_floor_reductions row means the orchestrator approved this
      // task under a reduced floor (e.g. [reviewer]); the Stop hook must honor that
      // instead of demanding the full trio from the markdown. NO row → undefined →
      // the caller falls back to the full trio (the conservative offline-can't-reduce
      // invariant: a reduction is only ever honored when a durable provenance row
      // exists). effective_floor is orchestrator-written, like allowed_write_scope.
      try {
        const floorRow = await client.query(
          // Security C2 (defense-in-depth): only an ORCHESTRATOR-recorded floor
          // reduction may lower the Stop-hook review floor — a non-orchestrator
          // row must never reduce required reviews. Mirrors the reconciler-layer
          // filter (src/core/closure-reconciler.ts) and the store query.
          `select effective_floor
             from review_floor_reductions
            where run_id = $1 and task_id = $2
              and source = 'orchestrator'
            order by decided_at desc
            limit 1`,
          [activeRunId, activeTaskId]
        );
        const fr = floorRow.rows[0];
        if (fr && Array.isArray(fr.effective_floor)) {
          const floor = fr.effective_floor
            .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
            .map((entry) => entry.trim());
          if (floor.length > 0) {
            reviewFloorEffective = floor;
          }
        }
      } catch {
        // leave undefined so the caller falls back to the full trio
      }
    }

    return {
      activeRunId,
      activeTaskId,
      queueCurrentTaskId,
      allowedWriteScope,
      councilOutcome,
      reviewFloorEffective,
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

// Query orchestrator review records from the DB for a given task.
// Returns array of {role, outcome, source} rows where source='orchestrator'.
// Creates its own pg connection. Falls back silently if DB is unavailable.
//
// Two-authorities fix: when a runId is known, restrict to reviews for that run (or
// run-agnostic Stop-hook reviews with run_id IS NULL), so a stale passed review from
// a DIFFERENT run can no longer satisfy the Stop-hook gate while workflow-proof would
// reject it. This narrows the divergence between the two review authorities.
// Pure, testable builder for the Stop-hook orchestrator-review query.
// When a runId is known the query is strictly run-scoped (`run_id = $2`) — there is
// NO `run_id is null` escape hatch, because a null-run review row (written by the
// `save-review` path) would otherwise satisfy the gate for every run forever, which a
// stray review could exploit. Run-agnostic (task-only) lookup is used only when no
// run id is available (offline / legacy state).
export function buildOrchestratorReviewQuery(taskId, runId) {
  if (typeof runId === "string" && runId.trim().length > 0) {
    return {
      sql: `select reviewer_role as role, state as outcome, source
             from reviews
             where task_id = $1 and source = 'orchestrator' and run_id = $2
             order by created_at asc`,
      params: [taskId, runId.trim()]
    };
  }
  return {
    sql: `select reviewer_role as role, state as outcome, source
             from reviews
             where task_id = $1 and source = 'orchestrator'
             order by created_at asc`,
    params: [taskId]
  };
}

async function queryOrchestratorReviews(resolvedRepoRoot, taskId, runId) {
  const dotEnv = parseDotEnv(
    await readTextIfExists(path.join(resolvedRepoRoot, ".env"))
  );
  const connectionString =
    process.env.ARCHON_CORE_DATABASE_URL || dotEnv.ARCHON_CORE_DATABASE_URL;

  if (!connectionString || !taskId) {
    return [];
  }

  let client;
  try {
    const pgModule = await import("pg");
    const Client = pgModule.Client ?? pgModule.default?.Client;
    if (!Client) {
      return [];
    }

    client = new Client({ connectionString });
    await client.connect();

    const { sql, params } = buildOrchestratorReviewQuery(taskId, runId);
    const result = await client.query(sql, params);

    return result.rows.map((row) => ({
      role: typeof row.role === "string" ? row.role : "",
      outcome: typeof row.outcome === "string" ? row.outcome : "",
      source: "orchestrator"
    }));
  } catch {
    // DB query failed — return empty so caller falls back to markdown check
    return [];
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

// Build review context from markdown files (offline fallback).
async function loadMarkdownReviewContext(resolvedRepoRoot, taskId, requiredRoles) {
  const missingReviews = [];
  const invalidReviews = [];
  for (const role of requiredRoles) {
    const relPath = reviewArtifactPath(taskId, role);
    const content = await readTextIfExists(path.join(resolvedRepoRoot, relPath));
    if (content === undefined) {
      missingReviews.push(relPath);
    } else {
      const validation = validateReviewArtifact(content, taskId, role);
      if (!validation.valid) {
        invalidReviews.push(`${relPath} (${validation.reason})`);
      }
    }
  }
  return { missingReviews, invalidReviews };
}

// Build review context from DB orchestrator records.
// source='self' records are ignored — only source='orchestrator' is trusted.
// Returns null if no orchestrator records exist, so caller can decide to fall back.
async function loadDbReviewContext(resolvedRepoRoot, taskId, requiredRoles, runId) {
  const rows = await queryOrchestratorReviews(resolvedRepoRoot, taskId, runId);

  // If DB returned nothing (offline or no records), return null to signal fallback
  if (rows.length === 0) {
    return null;
  }

  const passedRoles = new Set(
    rows.filter((r) => r.outcome === "passed").map((r) => r.role)
  );
  const failedRoles = rows
    .filter((r) => r.outcome === "failed" || r.outcome === "blocked")
    .map((r) => r.role);

  const missingReviews = requiredRoles.filter(
    (role) => !passedRoles.has(role) && !failedRoles.includes(role)
  );

  // Map failed roles to the same path-like format for UI consistency
  const invalidReviews = failedRoles
    .filter((role) => requiredRoles.includes(role))
    .map((role) => `${reviewArtifactPath(taskId, role)} (orchestrator review outcome: failed)`);

  return { missingReviews, invalidReviews };
}

// Audit F1: decide which source the Stop review gate trusts. Pure and fully
// testable (no DB). CLAUDE.md declares review_artifact_trust=runtime_records_only,
// so when the runtime is CONNECTED the orchestrator DB rows are the ONLY trusted
// source — with NO packet-level opt-out:
//   - orchestrator rows present  -> use them (kind: "db").
//   - zero orchestrator rows     -> reviews are MISSING (kind: "missing"); a
//     worker-written markdown file must NOT satisfy the gate. The message names
//     review-orchestrator as the required path.
// Review finding F1 (HIGH): the earlier `review_exports=runtime_optional` packet
// escape hatch was a self-review bypass — task packets are worker-writable, so a
// worker whose scope covers `.archon/work` could edit its own packet to opt into
// the markdown fallback and then satisfy the gate with a self-written review. The
// connected path therefore accepts no opt-out at all. (`review_exports` retains
// its CLAUDE.md meaning for the SCOPE gate — a runtime-authoritative task need not
// hold export write scope — but it never selects the review-gate source here; any
// extra option passed in is ignored by construction.)
// When the runtime is genuinely unreachable (not connected — the documented
// offline boundary), the markdown fallback applies unchanged (kind: "markdown").
export function resolveReviewGateSource({
  runtimeConnected,
  dbReviewContext,
  requiredRoles,
  taskId
}) {
  if (runtimeConnected) {
    if (dbReviewContext) {
      return { kind: "db", context: dbReviewContext };
    }
    const roles = Array.isArray(requiredRoles) ? requiredRoles : [];
    return {
      kind: "missing",
      context: {
        missingReviews: roles.map(
          (role) =>
            `${reviewArtifactPath(taskId, role)} (no orchestrator review recorded — run the review-orchestrator; runtime is connected and review_artifact_trust=runtime_records_only, so a self-written markdown review does not satisfy the gate)`
        ),
        invalidReviews: []
      }
    };
  }
  // Runtime genuinely unreachable (offline) — documented markdown fallback.
  return { kind: "markdown" };
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

  // Finding 5 fix: the runtime task record is the authority for write scope when
  // the runtime is connected; the markdown packet is only the offline fallback.
  // This also lets an active task created purely in the runtime (no packet file
  // on disk yet) carry its scope, instead of silently getting an empty scope.
  const markdownScope = taskMarkdown ? parseAllowedWriteScopeSection(taskMarkdown) : [];
  context.allowedWriteScope = resolveActiveWriteScope({
    runtimeConnected: context.runtimeConnected,
    runtimeScope: runtimeContext?.allowedWriteScope,
    markdownScope
  });

  if (!taskMarkdown) {
    return context;
  }

  context.allowedTaskHandoffScope = parseAllowedTaskHandoffScopeSection(taskMarkdown);
  context.continuationIntent = parseContinuationIntentSection(taskMarkdown);
  context.hookBlockerState = await readHookBlockerState(
    resolvedRepoRoot,
    context.activeTaskId,
    context.queueCurrentTaskId
  );

  // Option B (slice 5): when the runtime is connected AND it recorded a review-floor
  // reduction for this task, that effective_floor is authoritative (orchestrator-
  // written) — honor it over the markdown trio. Offline, or with no provenance row,
  // fall back to the markdown floor (which defaults to the full trio): a reduction is
  // never honored without a durable runtime row (offline-can't-reduce invariant).
  const requiredRoles =
    context.runtimeConnected && Array.isArray(runtimeContext?.reviewFloorEffective)
      ? runtimeContext.reviewFloorEffective
      : parseRequiredReviews(taskMarkdown);
  context.requiredReviews = requiredRoles;
  context.missingReviews = [];
  context.invalidReviews = [];

  if (requiredRoles.length > 0) {
    // Audit F1 / review finding F1: when the runtime is CONNECTED, orchestrator DB
    // rows are the ONLY trusted review source. Zero rows = MISSING reviews (fail
    // closed) with NO packet-level opt-out — task packets are worker-writable, so a
    // packet flag could self-authorize the bypass. Worker-writable markdown is
    // trusted only when the runtime is genuinely offline. See resolveReviewGateSource.
    let dbReviewContext = null;
    if (context.runtimeConnected) {
      dbReviewContext = await loadDbReviewContext(
        resolvedRepoRoot,
        context.activeTaskId,
        requiredRoles,
        runtimeContext?.activeRunId
      );
    }
    const source = resolveReviewGateSource({
      runtimeConnected: context.runtimeConnected,
      dbReviewContext,
      requiredRoles,
      taskId: context.activeTaskId
    });
    const reviewContext =
      source.kind === "markdown"
        ? await loadMarkdownReviewContext(resolvedRepoRoot, context.activeTaskId, requiredRoles)
        : source.context;
    context.missingReviews = reviewContext.missingReviews;
    context.invalidReviews = reviewContext.invalidReviews;
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
  // #14 fix: when the runtime is connected, the council outcome is authoritative from
  // the runtime task record (orchestrator-written), not from the markdown a worker can
  // edit. Markdown is honored only offline.
  context.councilOutcome = resolveCouncilOutcome({
    runtimeConnected: context.runtimeConnected,
    runtimeOutcome: runtimeContext?.councilOutcome,
    markdownOutcome: councilInfo.outcome
  });

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

// Decide the enforced write scope for the active task.
//
// Finding 5 fix: when the runtime is connected it is the authority for the
// active task's allowed write scope. The markdown packet on disk (which a worker
// could edit) is only a fallback for the offline case. This prevents a worker
// from widening its own write scope by editing its own task packet markdown.
//
// `runtimeScope === undefined` means the runtime did not provide a scope (task
// row missing or query failed) — fall back to markdown. An explicit array
// (including an empty array) is authoritative and is never widened by markdown.
export function resolveActiveWriteScope({ runtimeConnected, runtimeScope, markdownScope }) {
  const md = Array.isArray(markdownScope) ? markdownScope : [];
  if (runtimeConnected && Array.isArray(runtimeScope)) {
    return runtimeScope;
  }
  return md;
}

// Claude Code tool calls pass absolute file_path values; scope entries are relative.
// Canonicalize against the repo root so path comparisons work correctly regardless
// of how Claude Code formats the path. path.resolve collapses double-slashes and
// dot-dot traversals BEFORE the prefix strip, so crafted paths like
// "/repo//.claude/agents/x.md" or "/repo/../repo/CLAUDE.md" yield a clean
// repo-relative result (".claude/agents/x.md", "CLAUDE.md") that the managed-path
// and scope gates can match — closing the double-slash gate-bypass that the old
// naive prefix strip left open. Paths that resolve outside the repo are returned
// as their canonical absolute path (still leading "/"), preserving the
// outside-repo signal callers rely on.
export function toRelativePath(filePath, repoRoot) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return filePath;
  }
  if (typeof repoRoot === "string" && repoRoot.length > 0) {
    const root = repoRoot.endsWith(path.sep) ? repoRoot.slice(0, -1) : repoRoot;
    const canonical = path.resolve(root, filePath);
    if (canonical === root) {
      return "";
    }
    const prefix = root + path.sep;
    if (canonical.startsWith(prefix)) {
      return canonical.slice(prefix.length);
    }
    return canonical;
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

// ---------------------------------------------------------------------------
// Shell word-concatenation resolver (audit auditP3Stewards, security HIGH,
// round 2)
//
// Bash builds ONE token by concatenating adjacent quoted and unquoted
// fragments with NO separating whitespace: `p""sql`, `pg''_dump`, and
// `p\s\q\l` (unquoted backslash-escapes) all resolve to the literal words
// `psql` / `pg_dump` / `psql` at execution time. The per-character masking
// used elsewhere in this file (maskQuotedSpans) BLANKS quoted spans to
// spaces specifically so word-pattern checks don't misfire on inert DATA
// mentioned inside a quoted argument (e.g. `grep -n "a > b" file` must not
// look like a write redirect) — but that same blanking is what let
// `p""sql` slip past a `\bpsql\b` check: the inserted spaces split what bash
// treats as ONE token into two non-matching fragments. Security round 2
// caught this as a real bypass.
//
// This resolver performs actual bash quote-removal instead of blanking:
// quoted content (single- or double-quoted, with correct nesting — a `'`
// encountered while inside a `"..."` span is just a literal character, never
// a nested quote toggle) is emitted literally with the quote delimiters
// stripped, and unquoted backslash-escapes are resolved to their literal
// character too (the same adjacency-hiding trick, closed the same way). Real
// (unquoted) whitespace is preserved, so two genuinely distinct words
// separated by an actual space (`echo "p" "sql"`) remain distinct — only
// adjacency-based concatenation is collapsed.
//
// Used ONLY by consumers that need the true executed WORD content (the
// direct DB-client gate below, and isDestructiveCommand) — NOT by the
// read-only/write-like keyword classifiers or the write-redirect scan, which
// intentionally rely on maskQuotedSpans' blanking to avoid false-positiving
// on inert quoted data (e.g. a literal `>` inside a quoted argument must stay
// inert). Swapping those to word-resolution would leak quoted special
// characters into contexts that assume "quoted means inert" — a deliberate,
// separate scope boundary for this fix, not an oversight.
export function resolveShellWordConcatenation(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  let out = "";
  let quote = null; // "'" or '"' when inside a quoted span
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null; // closing delimiter — contents already emitted, drop the quote char itself
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        // Double-quote backslash-escape: emit the escaped character literally.
        out += text[i + 1];
        i++;
        continue;
      }
      // Literal content inside quotes, including a foreign quote char (e.g. a
      // "'" encountered while quote === '"' is just a plain character here).
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch; // opening delimiter — emit nothing, contents follow literally
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      // Unquoted backslash-escape (e.g. p\s\q\l): emit the escaped character
      // literally — the same adjacency-hiding trick as split-quotes.
      out += text[i + 1];
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Direct DB-client invocation gate (audit auditP3Stewards, security HIGH)
//
// runtime-medic's repair-authority boundary ("sanctioned admin CLI only, never
// direct DB writes") was prose-only: the Bash gate had zero awareness of
// DB-client processes, so a raw `psql "$ARCHON_CORE_DATABASE_URL" -c "UPDATE
// reviews ..."` bypassed the review-identity adapter completely undetected —
// and since ARCHON_CORE_DATABASE_URL is routinely in-session for the
// sanctioned admin commands too, this was reachable by any agent, not only
// runtime-medic.
//
// DECISION (documented, not a perfect boundary): block EVERY direct
// invocation of psql / pgcli / pg_dump / pg_restore, and the cheap `node -e
// "require('pg')..."` / `npx -e ...` one-liner shape, regardless of read vs
// write intent. Sniffing the SQL statement for read/write is fragile
// (multi-statement bodies, `\i file.sql`, a script-wrapped `-c`, …) and misses
// the point anyway: the sanctioned admin CLI (`npx tsx ./src/admin.ts
// <command>`) is the ONLY route runtime-medic's contract permits for ANY DB
// interaction — read or write — so a blanket block is the simpler AND more
// defensible policy, not a narrower "block writes only" carve-out. The
// sanctioned admin CLI never invokes any of these client binaries and never
// contains a bare `require('pg')`/`from 'pg'` reference in the Bash-visible
// command string (it imports the 'pg' package internally in TypeScript
// source, not from the shell command line), so it is never caught here.
//
// DETECTION RULE (round 2, position-based — resolves the round-2 false
// positive/negative tension): resolve word-concatenation (above), split into
// top-level pipeline segments, and check whether the FIRST resolved word of
// each segment is exactly one of psql/pgcli/pg_dump/pg_restore. Checking the
// FIRST word only (rather than "the word anywhere in the segment") is what
// keeps `grep -n "psql" foo.sh` / `grep -n psql foo.sh` (psql is grep's
// ARGUMENT, not the executed program) from false-positiving, while still
// catching a real invocation regardless of how it's quoted or split. Scanned
// on the same three surfaces extractBashReferencedManagedPaths already scans
// for managed-path writes: (1) each top-level pipeline segment; (2)
// executable heredoc bodies (`bash <<EOF` / `psql ...` / `EOF`) — a heredoc
// body's own first line is itself a first-word check; (3) `eval`/`sh -c`/
// `bash -c` string payloads, same reasoning.
//
// Bypass: a task packet that genuinely needs direct DB access adds the
// literal marker `db_direct` to its `## Allowed write scope` section —
// mirrors how a managed control-layer PATH is explicitly granted today
// (isManagedPathAllowed), just with a non-path token instead of a path.
//
// ACCEPTED LIMITATIONS (stated, not hidden — this is friction/telemetry
// hardening per the layered-defense stance, not a complete boundary):
//   1. Wrapper-prefixed invocations (`docker exec <container> psql`, `sudo
//      psql`, `env FOO=bar psql`, …) are NOT parsed — the wrapper word is
//      checked, not the word after it. Parsing wrapper argument shapes
//      correctly (docker exec/run take a variable number of flags before the
//      container/image name) is out of scope for this fix; the first-word
//      rule is the simpler, more defensible policy and matches every case
//      the finding named. Round-1 self-added coverage for this shape has
//      been removed accordingly (see tests/hook-policy.test.ts).
//   2. Interpreter-mediated DB access (python + psycopg2, ruby + the `pg`
//      gem, perl + DBI, …) is NOT detected by this gate at all — an
//      interpreter that builds the connection dynamically or imports a
//      driver under a different invocation shape keeps the token out of the
//      Bash-visible command string entirely. Recorded decision (converts
//      this from a silent gap into an owned one, per the MEDIUM finding):
//      control scope for THIS gate = direct client binaries
//      (psql/pgcli/pg_dump/pg_restore) + the Node/npx `require('pg')`
//      one-liner shape only. Interpreter-mediated access remains covered
//      solely by the layered defense already in place — runtime-authoritative
//      records, the review-identity adapter, and review-orchestrator's
//      gate-write monopoly — not by this Bash-command gate.
//      Owner: security_reviewer. Recorded: 2026-07-05 (audit auditP3Stewards,
//      security round 2, finding 3). Re-triage if a real interpreter-mediated
//      bypass is observed in practice.
const directDbClientWords = new Set(["psql", "pgcli", "pg_dump", "pg_restore"]);
// Checked on the RESOLVED (word-concatenation-collapsed) text, not masked —
// the quoted `'pg'`/`"pg"` string is itself the signal for a require()/import
// of the 'pg' package, and resolveShellWordConcatenation correctly preserves
// it literally even when nested inside an outer bash-quoted argument (a `'`
// encountered while already inside a `"..."` span is a plain character, not a
// second quote toggle) — see the resolver's own doc comment above.
const nodeInlineEvalFlagPattern = /\b(?:node|npx)\b[^\n]*\s(?:-e|-p|--eval|--print)\b/;
const pgPackageReferencePattern = /require\(\s*['"]pg['"]\s*\)|from\s+['"]pg['"]/;

// First resolved word of a single pipeline segment — the program bash would
// actually exec for that segment. Empty string if the segment resolves to
// nothing (e.g. blank after redirect-stripping).
function firstResolvedWord(segment) {
  const resolved = resolveShellWordConcatenation(segment).trim();
  if (!resolved) {
    return "";
  }
  const match = /^\S+/.exec(resolved);
  return match ? match[0] : "";
}

function textLooksLikeDirectDbClientInvocation(text) {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  const segments = splitBashSegments(text)
    .map((segment) => stripIoDiscardRedirects(segment).trim())
    .filter(Boolean);
  if (segments.some((segment) => directDbClientWords.has(firstResolvedWord(segment)))) {
    return true;
  }
  const resolvedWhole = resolveShellWordConcatenation(text);
  return nodeInlineEvalFlagPattern.test(resolvedWhole) && pgPackageReferencePattern.test(resolvedWhole);
}

export function isDirectDbClientInvocation(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return false;
  }
  if (textLooksLikeDirectDbClientInvocation(stripHeredocBodies(command))) {
    return true;
  }
  for (const body of extractExecutableHeredocBodies(command)) {
    if (textLooksLikeDirectDbClientInvocation(body)) {
      return true;
    }
  }
  for (const payload of extractShellStringPayloads(command)) {
    if (textLooksLikeDirectDbClientInvocation(payload)) {
      return true;
    }
  }
  return false;
}

// The `db_direct` scope marker is a non-path token in `## Allowed write
// scope` (parallel to a managed control-layer PATH grant) — its literal
// presence, not path-matching, opts a task into direct DB access for this gate.
export function hasDbDirectScopeGrant(allowedWriteScope) {
  return (
    Array.isArray(allowedWriteScope) &&
    allowedWriteScope.some((scope) => typeof scope === "string" && scope.trim() === "db_direct")
  );
}

export function isTaskPacketPath(relativePath) {
  const normalized = normalizePath(relativePath);
  return normalized.startsWith(".archon/work/tasks/task-") && normalized.endsWith(".md");
}
// Handoff artifact paths are files the agent must be able to write during context-guard
// enforcement (handoff_required / hard_stop) to complete the handoff protocol.
// These are exempt from the managed-path gate and the task write-scope gate so the agent
// is never deadlocked when it needs to commit a handoff.
//
// Canonical set (must stay in sync with src/mcp/handoff-tools.ts and
// src/runtime/interactive-stop-hook.ts):
//   .archon/work/context-guard.json         — enforcement sidecar written by the hook
//   .archon/work/daemon/continuation-context.txt       — continuation prompt for next session
//   .archon/work/daemon/interactive-resume-request.json — interactive respawn trigger
const HANDOFF_ARTIFACT_PATHS = new Set([
  '.archon/work/context-guard.json',
  '.archon/work/daemon/continuation-context.txt',
  '.archon/work/daemon/interactive-resume-request.json'
]);

export function isHandoffArtifactPath(relativePath) {
  return HANDOFF_ARTIFACT_PATHS.has(normalizePath(relativePath));
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

// Touched-path evidence ledger (R3/R4) — records files an active task actually
// modified, providing path-touch metadata for handoff packets and review
// evidence (§14.1 PostToolUse). Append-only JSONL, deduplicated per path.
function touchedPathsLedgerPath(repoRootPath) {
  return path.join(repoRootPath, ".archon", "work", "touched-paths.jsonl");
}

export function persistTouchedPath(repoRootPath, taskId, filePath) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return;
  }
  const relative = toRelativePath(filePath, repoRootPath);
  const ledgerPath = touchedPathsLedgerPath(repoRootPath);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  // Skip if this (task, path) pair was already the most recent record for the
  // path — avoids unbounded duplicate lines on repeated edits to one file.
  try {
    const existing = readFileSync(ledgerPath, "utf8").trim().split("\n");
    for (let i = existing.length - 1; i >= 0; i -= 1) {
      if (!existing[i]) continue;
      try {
        const parsed = JSON.parse(existing[i]);
        if (parsed && parsed.path === relative && parsed.taskId === taskId) {
          return;
        }
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    // no ledger yet
  }
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({ taskId: taskId ?? null, path: relative, touchedAt: new Date().toISOString() })}\n`,
    "utf8"
  );
}

export function readTouchedPaths(repoRootPath, taskId) {
  try {
    const lines = readFileSync(touchedPathsLedgerPath(repoRootPath), "utf8").trim().split("\n");
    const paths = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.path === "string" && (taskId === undefined || parsed.taskId === taskId)) {
          paths.push(parsed.path);
        }
      } catch {
        // ignore malformed line
      }
    }
    return [...new Set(paths)];
  } catch {
    return [];
  }
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

// #10 fix: a verification command joined to other commands with a shell control
// operator can mask a real failure or inject a fake test summary into stdout while
// still exiting 0 (e.g. `npm test || echo "# fail 0"`, `npm test | cat`,
// `npm test; echo "# tests 1"`). Such a command must never mint a verification cert;
// the operator must run the verify command standalone for it to count.
export function commandHasShellChaining(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return false;
  }
  let s = stripHeredocBodies(command);
  // Drop quoted strings so operators inside string literals are not counted.
  s = s.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "");
  // Drop fd/file redirects so `2>&1`, `>out`, `<in` are not mistaken for operators.
  // The filename charclass excludes shell metacharacters so an operator immediately
  // adjacent to a redirect target (e.g. `>>log&&echo`) is NOT swallowed into the
  // filename (security: that would hide the `&&`).
  s = s.replace(/\d*>&\d+/g, "").replace(/\d*>>?\s*[^\s|&;<>]+/g, "").replace(/<\s*[^\s|&;<>]+/g, "");
  // Any shell separator means the verify command is not the sole determinant of the
  // exit code / stdout. Newlines and carriage returns separate commands in a bash
  // script body just like `;`, so they count too (security: a multi-line body can
  // run the real test then echo a forged TAP summary).
  return /(\|\||&&|;|\||&|\n|\r)/.test(s);
}

// #14 fix: the council outcome must come from the authoritative runtime when it is
// connected, NOT from the on-disk task packet markdown a worker can edit. `undefined`
// runtime outcome means "no orchestrator-recorded outcome" → not approved. Markdown is
// only honored offline (documented boundary).
export function resolveCouncilOutcome({ runtimeConnected, runtimeOutcome, markdownOutcome }) {
  if (runtimeConnected) {
    return typeof runtimeOutcome === "string" && runtimeOutcome.trim().length > 0
      ? runtimeOutcome.trim()
      : undefined;
  }
  return markdownOutcome;
}

export function qualifiesForVerificationCert(command, output) {
  if (typeof command !== "string" || !isVerificationCommand(command)) {
    return false;
  }

  // Disqualify version/help/init invocations — they prove nothing.
  if (verificationNoopPatterns.some((p) => p.test(command))) {
    return false;
  }

  // #10 fix: reject shell-chained verification commands — they can mask failure
  // or inject a forged summary while exiting 0.
  if (commandHasShellChaining(command)) {
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

  // bash/node scripts/check-* and archon:verify: no output requirement (fail loudly on their own)
  if (
    /\bbash\s+scripts\/check-/.test(command) ||
    /\bnode\s+(?:--experimental-strip-types\s+)?scripts\/check-/.test(command) ||
    /\barchon:verify\b/.test(command)
  ) {
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

// Review finding F1 (HIGH): the `review_exports=runtime_optional` packet-flag
// parser was REMOVED. Because task packets are worker-writable, any packet flag
// that the connected-runtime review gate consults is a self-review bypass. The
// gate now trusts orchestrator DB rows only (see resolveReviewGateSource); the
// `review_exports` key keeps its CLAUDE.md meaning for the write-SCOPE gate but
// is never read by the review-gate path. A tripwire test
// (tests/audit-p0-gate-integrity.test.ts) fails if any such parser reappears in
// hook code.

export const verificationExemptTaskClasses = ["docs_only", "state_sync", "memory_curation", "scaffold_only"];

// ---------------------------------------------------------------------------
// Option B (slice 5): offline-capable port of the review-floor predicate.
//
// These mirror src/domain/task-class.ts (OPT_OUT_TASK_CLASSES, scopeIsReviewSafe,
// REVIEW_FLOOR_DENY_PREFIXES). They exist so tests/review-floor-parity.test.ts can
// assert the .mjs and .ts predicates agree on the full class×scope matrix — any
// drift is a test failure. The Stop hook does NOT use these to perform an offline
// reduction: a reduction is only ever honored when the runtime recorded a durable
// review_floor_reductions row (offline-can't-reduce invariant). They are the
// anti-drift mirror, not an offline reduction path.
// ---------------------------------------------------------------------------

export const OPT_OUT_TASK_CLASSES = ["docs_only", "state_sync", "memory_curation", "scaffold_only"];

// Must equal the de-duplicated control-layer roots + DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS
// from src/domain/task-class.ts. The parity test asserts this equality.
export const REVIEW_FLOOR_DENY_PREFIXES = [
  ".archon/rules",
  ".archon/memory",
  ".archon/ACTIVE",
  "CLAUDE.md",
  "AGENTS.md",
  ".claude",
  ".codex",
  "README.md",
  "docs",
  ".agents/skills"
];

export function isOptOutClass(cls) {
  return OPT_OUT_TASK_CLASSES.includes(cls);
}

// Port of normalizeScopeEntryForFloor in src/domain/task-class.ts. Returns the
// canonical slash-form path, or null when the entry is suspicious (deny-by-default).
function normalizeScopeEntryForFloor(raw) {
  if (typeof raw !== "string" || raw.includes("\0")) {
    return null;
  }
  let value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  value = value.normalize("NFKC");
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (value.includes("\0") || value.includes("\\")) {
    return null;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return null;
    }
  }
  value = value.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (value.length === 0) {
    return null;
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("*")) {
      return null;
    }
  }
  return segments.join("/");
}

function entryMatchesDenyPrefix(normalized) {
  return REVIEW_FLOOR_DENY_PREFIXES.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`) ||
      prefix.startsWith(`${normalized}/`)
  );
}

// Port of scopeIsReviewSafe in src/domain/task-class.ts. Deny-by-default.
export function scopeIsReviewSafe(scope) {
  if (!Array.isArray(scope) || scope.length === 0) {
    return false;
  }
  for (const rawEntry of scope) {
    const normalized = normalizeScopeEntryForFloor(rawEntry);
    if (normalized === null || entryMatchesDenyPrefix(normalized)) {
      return false;
    }
  }
  return true;
}

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
    return passed === normalized;
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
  // Audit F4: quote-aware split so a separator inside a quoted argument does not
  // fragment the command.
  const segments = splitBashSegments(stripped).map((s) => s.trim()).filter(Boolean);
  const results = new Set();

  for (const seg of segments) {
    // Clean io-discard redirects (2>&1, 2>/dev/null) so they don't interfere
    const clean = seg
      .replace(/\s+\d*>\/dev\/null\b/g, "")
      .replace(/\s+\d*>&\d+\b/g, "")
      .trim();
    // Audit F4: masked view with quoted spans blanked. Operator-embedded-in-string
    // cases (a `>` or `of=`/`-o` that lives INSIDE a quoted argument of an
    // unrelated command) are detected here so they are NOT treated as writes. The
    // live 2026-07-04 repro was an `init-task` whose quoted `--goal` contained
    // `dd of=` and `>` and was wrongly blocked as a write.
    const masked = maskQuotedSpans(clean);

    // > path or >> path (not fd>&N which were already stripped).
    // DETECT the redirect operator on MASKED text so a `>` living inside a quoted
    // argument (`grep "a > b"`) is not a redirect. Exclude => (arrow) via the
    // =-lookbehind and >= (comparison) via the =-lookahead. Then CAPTURE the target
    // from the aligned `clean` text (maskQuotedSpans is length-preserving, so
    // indices match) with a quote-aware token pattern — review finding M2's class:
    // a QUOTED redirect target (`> ".claude/y"`) must still be captured, not
    // dropped because masking blanked it.
    const redirectOp = /(?<![=])>>?(?!=)/g;
    for (const m of masked.matchAll(redirectOp)) {
      const after = clean.slice(m.index + m[0].length);
      const tok = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|<>()$`]+))/.exec(after);
      if (tok) {
        addTarget(stripQuotes(tok[1] ?? tok[2] ?? tok[3]), repoRoot, results);
      }
    }

    // Audit F3 + review finding M2: `dd ... of=<target>` writes to <target>.
    // Two-step (matching every other extractor here): DETECT the `of=` operand on
    // the masked view so an `of=` living inside an unrelated quoted argument is
    // ignored, then CAPTURE the path from the original `clean` text so a QUOTED
    // target (`of="path with space"`) is not dropped. The clean pattern accepts a
    // double-, single-, or unquoted operand.
    if (/\bdd\b[^\n]*?\bof=/.test(masked)) {
      const ddClean = /\bdd\b[^\n]*?\bof=(?:"([^"]*)"|'([^']*)'|([^\s;&|<>()$`]+))/.exec(clean);
      if (ddClean) {
        addTarget(stripQuotes(ddClean[1] ?? ddClean[2] ?? ddClean[3]), repoRoot, results);
      }
    }

    // Audit F3 + review finding M2: `sort -o <target>` / `sort --output <target>`
    // (also `-o=`/`--output=`). Same two-step: detect on masked, capture the
    // (possibly quoted) path from clean.
    if (/\bsort\b[^\n]*?\s(?:-o|--output)[=\s]/.test(masked)) {
      const sortClean = /\bsort\b[^\n]*?\s(?:-o|--output)[=\s]+(?:"([^"]*)"|'([^']*)'|([^\s;&|<>()$`]+))/.exec(
        clean
      );
      if (sortClean) {
        addTarget(stripQuotes(sortClean[1] ?? sortClean[2] ?? sortClean[3]), repoRoot, results);
      }
    }

    // Audit F3: `find <paths...> ... <action-flag>` (-delete/-exec/…) writes to
    // the files matched under its search roots. Gate on the masked text (so a
    // quoted `find`/flag is ignored) but capture the search-root paths from the
    // original `clean` so quoted paths survive. Paths precede the first predicate.
    if (
      /\bfind\b/.test(masked) &&
      /\s-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprintf)\b/.test(masked)
    ) {
      const findMatch = /\bfind\s+(.+)$/.exec(clean);
      if (findMatch) {
        for (const part of tokenize(findMatch[1])) {
          if (part.startsWith("-")) break; // stop at the first flag/predicate
          addTarget(stripQuotes(part), repoRoot, results);
        }
      }
    }

    // tee [-a] path [path ...] — gate on masked so a quoted `tee` is ignored;
    // capture args from `clean` so quoted targets survive.
    const teeMatch = /\btee\b/.test(masked) ? /\btee\s+(?:-a\s+)?(.+)$/.exec(clean) : null;
    if (teeMatch) {
      // Quote-aware tokenization so a quoted target with an internal space stays
      // one path (audit F4). Skip flags like -a.
      for (const part of tokenize(teeMatch[1].trim())) {
        if (part.startsWith("-")) continue;
        addTarget(stripQuotes(part), repoRoot, results);
      }
    }

    // sed -i[suffix] 's/a/b/' path  — take the last non-flag token that isn't the script
    const sedMatch = /\bsed\s+-i/.test(masked) ? /\bsed\s+-i\S*\s+(.+)$/.exec(clean) : null;
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
    const touchMatch = /\btouch\b/.test(masked) ? /\btouch\s+(.+)$/.exec(clean) : null;
    if (touchMatch) {
      for (const part of tokenize(touchMatch[1])) {
        if (part.startsWith("-")) continue;
        addTarget(stripQuotes(part), repoRoot, results);
      }
    }

    // mkdir [-p] path [path ...]
    const mkdirMatch = /\bmkdir\b/.test(masked) ? /\bmkdir\s+(.+)$/.exec(clean) : null;
    if (mkdirMatch) {
      for (const part of tokenize(mkdirMatch[1])) {
        if (part.startsWith("-")) continue;
        addTarget(stripQuotes(part), repoRoot, results);
      }
    }

    // cp src dest  — only the LAST arg is the write target
    const cpMatch = /\bcp\b/.test(masked) ? /\bcp\s+(?:-\S+\s+)*(.+)$/.exec(clean) : null;
    if (cpMatch) {
      const tokens = tokenize(cpMatch[1]).filter((t) => !t.startsWith("-"));
      if (tokens.length >= 2) {
        addTarget(stripQuotes(tokens[tokens.length - 1]), repoRoot, results);
      }
    }

    // mv src dest — only the LAST arg is the write target
    const mvMatch = /\bmv\b/.test(masked) ? /\bmv\s+(?:-\S+\s+)*(.+)$/.exec(clean) : null;
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

// Resolved (not masked) before matching — mirrors the fix applied to the
// direct DB-client gate above (audit auditP3Stewards, security round 2,
// finding 1): this function tests raw `command` text with zero masking, so
// `g""it reset --hard` (or `r\m -rf` / any other adjacency-split phrase)
// defeated the same /\bword\b/ pattern shape the same way. Resolving first
// collapses the split fragments back into the literal word bash would
// actually execute, closing the identical evasion class here.
export function isDestructiveCommand(command) {
  const resolved = resolveShellWordConcatenation(typeof command === "string" ? command : "");
  return destructiveCommandPatterns.some((pattern) => pattern.test(resolved));
}

export function isVerificationCommand(command) {
  return verificationCommandPatterns.some((pattern) => pattern.test(command));
}

// Scan a block of already-prepared text for managed-path prefixes. A prefix
// matches only when it is NOT a suffix of an absolute path from outside the repo
// (preceding char "/" is skipped, e.g. ~/.claude/... or /some/path/.claude/...).
function scanTextForManagedPrefixes(scanned) {
  const matches = [];
  for (const prefix of managedPathPrefixes) {
    const plainPrefix = prefix.replace(/\/$/, "");
    const candidates = [prefix, plainPrefix];
    let found = false;
    for (const candidate of candidates) {
      let idx = scanned.indexOf(candidate);
      while (idx !== -1) {
        const preceding = idx > 0 ? scanned[idx - 1] : "";
        if (preceding !== "/") {
          found = true;
          break;
        }
        idx = scanned.indexOf(candidate, idx + 1);
      }
      if (found) break;
    }
    if (found) {
      matches.push(plainPrefix);
    }
  }
  return matches;
}

// SEC-HEREDOC-BYPASS: decide whether a heredoc body will be EXECUTED rather than
// treated as data. The real execution vectors all put an INTERPRETER TOKEN on the
// opener line — directly (`python3 <<EOF`), after a pipe (`cat <<EOF | python3`,
// whose opener line includes the trailing `| python3`), or inside a command
// substitution (`eval "$(python3 <<EOF`). Matching the interpreter token alone is
// therefore both sufficient and precise: a bare pipe or `$(` is NOT treated as
// executable, so `cat <<EOF | tee f` and `"$(cat <<EOF)"` (data captured, not run)
// stay data sinks and their managed-path mentions remain non-matches.
function heredocOpenerIsExecutable(openerLine) {
  if (typeof openerLine !== "string") return false;
  // awk/gawk EXECUTE the heredoc as a program only with `-f -` (read program
  // from stdin). A bare `awk <<EOF` or `awk '{...}' <<EOF` consumes the heredoc
  // as DATA records, so it stays a data sink (avoids over-triggering).
  if (/\b(?:awk|gawk)\b/.test(openerLine) && /-f\s*-(?:\s|$)/.test(openerLine)) {
    return true;
  }
  return /\b(?:python|python2|python3|node|nodejs|deno|bun|ruby|perl|php|bash|sh|zsh|ksh|dash|eval|source|xargs|lua|tclsh|julia|Rscript|swift|osascript)\b/.test(
    openerLine
  );
}

// Return the bodies of EXECUTABLE heredocs only. The opener line is reconstructed
// from the text BEFORE `<<` and the text AFTER the delimiter word on the same
// line, so a trailing `| python3` (e.g. `cat <<EOF | python3`) is still seen.
function extractExecutableHeredocBodies(command) {
  if (typeof command !== "string") return [];
  const bodies = [];
  const collect = (re) => {
    let match;
    while ((match = re.exec(command)) !== null) {
      const openerLine = `${match[2] ?? ""} ${match[4] ?? ""}`;
      if (heredocOpenerIsExecutable(openerLine)) {
        bodies.push(match[5] ?? "");
      }
    }
  };
  // Plain `<<WORD`: bash requires the closing delimiter at column 0. Use a STRICT
  // `\n\3` anchor — a tab-indented `\tWORD` line inside the body is NOT a closer,
  // so an attacker cannot plant a fake closer to truncate the scanned body early.
  // The closer is a LOOKAHEAD (`(?=\n|$)`) so the trailing newline is NOT consumed
  // — otherwise a SECOND consecutive heredoc's opener would lose the `\n` its
  // `(^|\n)` anchor needs, and its body would be silently skipped.
  collect(/(^|\n)([^\n]*?)<<['"`]?(\w+)['"`]?([^\n]*)\n([\s\S]*?)\n\3[ \t]*(?=\n|$)/g);
  // `<<-WORD`: bash allows the closing delimiter to be preceded by TABS only.
  collect(/(^|\n)([^\n]*?)<<-['"`]?(\w+)['"`]?([^\n]*)\n([\s\S]*?)\n\t*\3[ \t]*(?=\n|$)/g);
  return bodies;
}

export function extractBashReferencedManagedPaths(command, repoRoot) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }

  // Normalize ABSOLUTE in-repo paths to repo-relative form before scanning, so a
  // write to `<repoRoot>/.claude/x` is caught (the `/`-preceded skip in
  // scanTextForManagedPrefixes would otherwise treat it like an outside-repo
  // path). Out-of-repo absolutes (e.g. ~/.claude, /etc/...) keep their leading
  // slash and stay correctly skipped — they are outside archon's jurisdiction.
  const normalized =
    typeof repoRoot === "string" && repoRoot.length > 0
      ? command.split(`${repoRoot.replace(/\/+$/, "")}/`).join("")
      : command;

  // Scan A: strip ALL heredoc bodies, then quoted strings, then scan. This
  // detects managed redirect targets OUTSIDE heredoc bodies (e.g.
  // `cat > .claude/x <<EOF`) while ignoring managed paths that appear only
  // inside grep/sed patterns, quoted arguments, or data heredocs.
  let scanned = stripHeredocBodies(normalized);
  scanned = scanned
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
  const matches = scanTextForManagedPrefixes(scanned);

  // Scan B (SEC-HEREDOC-BYPASS): scan EXECUTABLE heredoc bodies RAW — without
  // quote stripping, because the write target is a quoted string argument (e.g.
  // `open('.claude/x','w')`). Data-sink heredoc bodies are excluded by
  // extractExecutableHeredocBodies, preserving the doc/data-mention exemption.
  for (const body of extractExecutableHeredocBodies(normalized)) {
    for (const hit of scanTextForManagedPrefixes(body)) {
      matches.push(hit);
    }
  }

  // Scan C (review finding F3): `eval "<payload>"` / `sh -c '<payload>'` /
  // `bash -c …` run an opaque string that Scan A's quote-stripping would hide.
  // The payload is executed code, so scan it RAW (like an executable heredoc
  // body) — a managed-path write smuggled inside (`eval "cat > .claude/x"`) is
  // then caught. Only the string ARGUMENT of a shell-string evaluator is scanned,
  // so a managed path merely mentioned inside an unrelated command's quoted
  // argument is not affected.
  for (const payload of extractShellStringPayloads(normalized)) {
    for (const hit of scanTextForManagedPrefixes(payload)) {
      matches.push(hit);
    }
  }

  return [...new Set(matches)];
}

// Review finding F3: return the string payloads passed to shell-string evaluators
// (`eval`, `sh -c`, `bash -c`, `zsh -c`, …). These strings are executed as code,
// so their contents must be scanned for managed-path writes rather than treated
// as inert quoted arguments. Captures single- and double-quoted payloads.
function extractShellStringPayloads(command) {
  if (typeof command !== "string") return [];
  const payloads = [];
  const patterns = [
    /\beval\s+(?:"([^"]*)"|'([^']*)')/g,
    /\b(?:ba|z|k|da|c)?sh\s+-c\s+(?:"([^"]*)"|'([^']*)')/g
  ];
  for (const pattern of patterns) {
    for (const m of command.matchAll(pattern)) {
      const payload = m[1] ?? m[2];
      if (typeof payload === "string" && payload.length > 0) {
        payloads.push(payload);
      }
    }
  }
  return payloads;
}

function stripHeredocBodies(command) {
  if (typeof command !== "string") return command;
  // Remove heredoc body content so that words like tee or > inside a heredoc
  // do not trigger write-like detection. Handles <<WORD, <<'WORD', <<"WORD",
  // <<`WORD`, and <<-WORD variants. The opener and structure are kept; only the
  // body lines and closing delimiter are removed.
  // Two disjoint passes that respect bash closing-delimiter semantics:
  //  - plain `<<WORD`: STRICT column-0 closer (`\n\1`). A tab-indented `\tWORD`
  //    line inside the body is body content, not a closer — so it cannot truncate
  //    the strip early and leak the tail into the managed-path scan.
  //  - `<<-WORD`: the closer may be preceded by TABS only (`\n\t*\1`).
  return command
    .replace(/<<['"`]?(\w+)['"`]?[^\n]*\n[\s\S]*?\n\1[ \t]*(?:\n|$)/g, "<<STRIPPED\n")
    .replace(/<<-['"`]?(\w+)['"`]?[^\n]*\n[\s\S]*?\n\t*\1[ \t]*(?:\n|$)/g, "<<-STRIPPED\n");
}

// Strip fd>/dev/null and fd>&N redirects from a single segment before write-like
// classification. These discard output and are not writes to any real file.
function stripIoDiscardRedirects(segment) {
  return segment
    .replace(/\s+\d*>\/dev\/null\b/g, "")
    .replace(/\s+\d*>&\d+\b/g, "");
}

// Audit F4: quote-aware segment splitter. Splits a shell command into top-level
// segments on UNQUOTED separators (`;`, `|`, `||`, `&&`). Single quotes, double
// quotes, and backslash escapes are respected so a separator character inside a
// quoted string (e.g. `grep 'a|b' .claude/x`) does not split the command — which
// previously produced a stray non-read-only fragment and a false-positive block.
function splitBashSegments(command) {
  if (typeof command !== "string") {
    return [];
  }
  const segments = [];
  let current = "";
  let quote = null; // "'" or '"' when inside a quoted span
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      // Inside double quotes a backslash escapes the next char; inside single
      // quotes a backslash is literal (bash semantics).
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[i + 1];
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") {
        i++;
      }
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      i++;
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

// Audit F4: replace every quoted span (and its delimiters) in a segment with
// spaces, so write-like patterns and redirect detection only ever see UNQUOTED
// text. A `>` / `tee` / `touch` that appears only inside a quoted argument of an
// unrelated command must not trigger write classification.
function maskQuotedSpans(str) {
  if (typeof str !== "string") {
    return "";
  }
  let out = "";
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < str.length) {
        out += "  ";
        i++;
        continue;
      }
      out += " ";
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
      continue;
    }
    if (ch === "\\" && i + 1 < str.length) {
      out += ch + str[i + 1];
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// Audit F4: true when the segment contains a real output redirection (`>` / `>>`)
// OUTSIDE any quoted span. Quoted `>` (e.g. `grep 'a > b'`), arrow/comparison
// tokens (`=>`, `>=`), and already-stripped io-discard redirects (2>&1,
// 2>/dev/null) are NOT redirections.
function segmentHasWriteRedirect(segment) {
  if (typeof segment !== "string") {
    return false;
  }
  const masked = maskQuotedSpans(stripIoDiscardRedirects(segment));
  return /(?<![=<>])>>?(?!=)/.test(masked);
}

export function isReadOnlyBashCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return false;
  }

  const normalized = stripHeredocBodies(command);
  // Audit F4: quote-aware split so separators inside quoted arguments do not
  // create stray non-read-only fragments.
  const segments = splitBashSegments(normalized)
    .map((segment) => stripIoDiscardRedirects(segment).trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  return segments.every((segment) => {
    // A real (unquoted) output redirect makes the segment a write.
    if (segmentHasWriteRedirect(segment)) {
      return false;
    }
    // Audit F4: evaluate write-like and read-only name patterns against the
    // quote-masked segment so a write-command word (tee/touch/…) inside a quoted
    // argument of a read-only command does not misclassify it.
    const masked = maskQuotedSpans(segment);
    if (writeLikeCommandSegmentPatterns.some((pattern) => pattern.test(masked))) {
      return false;
    }

    return readOnlyCommandSegmentPatterns.some((pattern) => pattern.test(masked));
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
