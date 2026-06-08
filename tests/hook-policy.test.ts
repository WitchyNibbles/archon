import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "hooks"
);

// Dynamic import because hook files are .mjs ESM modules
const {
  isManagedPath,
  isManagedPathAllowed,
  isManagedPrefixPartiallyAllowed,
  isAllowedPath,
  isReadOnlyBashCommand,
  isSubstantiveWriteTarget,
  appendBypassLogEntry,
  parseRequiredReviews,
  reviewArtifactPath,
  toRelativePath
} = await import(`${hooksDir}/hook-utils.mjs`);
const { evaluatePreToolUse, evaluatePermissionRequest, evaluateStop, evaluateSessionStart } = await import(
  `${hooksDir}/hook-policy.mjs`
);

// ─── helpers ────────────────────────────────────────────────────────────────

function emptyContext() {
  return {
    repoRoot: "/repo",
    activeTaskId: undefined,
    allowedWriteScope: [],
    allowedTaskHandoffScope: [],
    continuationIntent: undefined,
    hookBlockerState: undefined,
    queueCurrentTaskId: undefined,
    authorityMismatches: [],
    requiredReviews: [],
    missingReviews: [],
    runtimeConfigured: false,
    runtimeConnected: false
  };
}

function contextWithScope(...paths: string[]) {
  return { ...emptyContext(), activeTaskId: "task-1", allowedWriteScope: paths };
}

function writePayload(filePath: string) {
  return { tool_name: "Write", tool_input: { file_path: filePath } };
}

function editPayload(filePath: string) {
  return { tool_name: "Edit", tool_input: { file_path: filePath } };
}

function bashPayload(command: string) {
  return { tool_name: "Bash", tool_input: { command } };
}

// ─── isManagedPath ───────────────────────────────────────────────────────────

test("isManagedPath: CLAUDE.md is managed", () => {
  assert.equal(isManagedPath("CLAUDE.md"), true);
});

test("isManagedPath: .claude/ prefix is managed", () => {
  assert.equal(isManagedPath(".claude/hooks/hook-policy.mjs"), true);
  assert.equal(isManagedPath(".claude/skills/archon-intake/SKILL.md"), true);
  assert.equal(isManagedPath(".claude/settings.json"), true);
});

test("isManagedPath: .archon/memory/ is managed", () => {
  assert.equal(isManagedPath(".archon/memory/README.md"), true);
});

test("isManagedPath: .archon/work/ and src/ are NOT managed", () => {
  assert.equal(isManagedPath(".archon/work/tasks/task-foo.md"), false);
  assert.equal(isManagedPath(".archon/ACTIVE"), false);
  assert.equal(isManagedPath("src/index.ts"), false);
  assert.equal(isManagedPath("tests/foo.test.ts"), false);
});

// ─── isManagedPathAllowed ────────────────────────────────────────────────────

test("isManagedPathAllowed: denies when scope is empty", () => {
  assert.equal(isManagedPathAllowed("CLAUDE.md", []), false);
  assert.equal(isManagedPathAllowed(".claude/hooks/hook-policy.mjs", []), false);
  assert.equal(isManagedPathAllowed(".archon/memory/README.md", []), false);
});

test("isManagedPathAllowed: denies when scope is non-empty but does not include the path", () => {
  assert.equal(
    isManagedPathAllowed("CLAUDE.md", [".claude/hooks/hook-policy.mjs"]),
    false
  );
});

test("isManagedPathAllowed: allows when scope explicitly includes the path", () => {
  assert.equal(
    isManagedPathAllowed(".claude/hooks/hook-policy.mjs", [".claude/hooks/hook-policy.mjs"]),
    true
  );
});

test("isManagedPathAllowed: allows when scope includes parent directory", () => {
  assert.equal(
    isManagedPathAllowed(".claude/hooks/hook-policy.mjs", [".claude/hooks"]),
    true
  );
  assert.equal(
    isManagedPathAllowed(".claude/skills/archon-intake/SKILL.md", [".claude/skills/archon-intake"]),
    true
  );
});

// ─── isManagedPrefixPartiallyAllowed ────────────────────────────────────────

test("isManagedPrefixPartiallyAllowed: denies when scope is empty", () => {
  assert.equal(isManagedPrefixPartiallyAllowed(".claude", []), false);
});

test("isManagedPrefixPartiallyAllowed: allows when scope has a child of the prefix", () => {
  assert.equal(isManagedPrefixPartiallyAllowed(".claude", [".claude/hooks"]), true);
  assert.equal(isManagedPrefixPartiallyAllowed(".claude", [".claude/skills/archon-intake"]), true);
});

test("isManagedPrefixPartiallyAllowed: allows when scope exactly matches the prefix", () => {
  assert.equal(isManagedPrefixPartiallyAllowed(".claude", [".claude"]), true);
});

test("isManagedPrefixPartiallyAllowed: denies when scope has an unrelated path", () => {
  assert.equal(isManagedPrefixPartiallyAllowed(".claude", ["src", "tests"]), false);
  assert.equal(isManagedPrefixPartiallyAllowed("CLAUDE.md", [".claude/hooks"]), false);
});

// ─── isAllowedPath: existing behaviour preserved ─────────────────────────────

test("isAllowedPath: still returns true when scope is empty (non-managed behaviour unchanged)", () => {
  assert.equal(isAllowedPath("src/index.ts", []), true);
  assert.equal(isAllowedPath("tests/foo.test.ts", []), true);
});

// ─── evaluatePreToolUse: Write/Edit on managed paths ─────────────────────────

test("Write to CLAUDE.md with no active task is blocked", () => {
  const result = evaluatePreToolUse(writePayload("CLAUDE.md"), emptyContext());
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

test("Write to .claude/ with no active task is blocked", () => {
  const result = evaluatePreToolUse(
    writePayload(".claude/skills/archon-intake/SKILL.md"),
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "block");
});

test("Edit to .archon/memory/ with no active task is blocked", () => {
  const result = evaluatePreToolUse(
    editPayload(".archon/memory/README.md"),
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "block");
});

test("Write to .claude/ with active task that declares that path in scope is allowed", () => {
  const ctx = contextWithScope(".claude/skills/archon-intake/SKILL.md");
  const result = evaluatePreToolUse(
    writePayload(".claude/skills/archon-intake/SKILL.md"),
    ctx
  );
  assert.equal(result, undefined, "should not block when path is in scope");
});

test("Write to .claude/ with active task but path NOT in scope is blocked", () => {
  const ctx = contextWithScope(".claude/hooks/hook-policy.mjs");
  const result = evaluatePreToolUse(
    writePayload(".claude/skills/archon-intake/SKILL.md"),
    ctx
  );
  assert.ok(result);
  assert.equal(result.decision, "block");
});

test("Write to src/index.ts with no active task is blocked by no-task write gate", () => {
  const result = evaluatePreToolUse(writePayload("src/index.ts"), emptyContext());
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
  assert.match(result.reason, /\.archon\/work\/tasks\//i);
});

test("Write to .archon/work/tasks/task-foo.md with no active task is NOT blocked", () => {
  const result = evaluatePreToolUse(
    writePayload(".archon/work/tasks/task-foo.md"),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "block");
});

// ─── evaluatePreToolUse: Bash referencing managed paths ──────────────────────

test("Bash write command referencing .claude/ with no active task is blocked", () => {
  const result = evaluatePreToolUse(
    bashPayload("cp config.json .claude/settings.json"),
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

test("Bash write command referencing .claude/ with active task declaring that path is allowed", () => {
  const ctx = contextWithScope(".claude/hooks");
  const result = evaluatePreToolUse(
    bashPayload("cp config.json .claude/hooks/new.mjs"),
    ctx
  );
  // No block from managed-path guard (may have additionalContext from Agent guard)
  assert.ok(result === undefined || result.decision !== "block");
});

test("Bash read-only command referencing .claude/ with no active task is allowed", () => {
  const result = evaluatePreToolUse(
    bashPayload("cat .claude/settings.json"),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "block");
});

test("Bash write command referencing CLAUDE.md with no active task is blocked", () => {
  const result = evaluatePreToolUse(
    bashPayload("echo '# bad' > CLAUDE.md"),
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "block");
});

// ─── evaluatePermissionRequest: Bash referencing managed paths ───────────────

test("PermissionRequest: Bash referencing .claude/ with no task is denied", () => {
  const result = evaluatePermissionRequest(
    bashPayload("cp file.json .claude/settings.json"),
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "deny");
});

test("PermissionRequest: Bash referencing .claude/ with task in scope is not denied by managed guard", () => {
  const ctx = contextWithScope(".claude/hooks");
  const result = evaluatePermissionRequest(
    bashPayload("cp file.mjs .claude/hooks/new.mjs"),
    ctx
  );
  assert.ok(result === undefined || result.decision !== "deny");
});

test("PermissionRequest: read-only Bash referencing .claude/ with no task is not denied", () => {
  const result = evaluatePermissionRequest(
    bashPayload("cat .claude/settings.json"),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "deny");
});

// ─── isSubstantiveWriteTarget ────────────────────────────────────────────────

test("isSubstantiveWriteTarget: .archon/ACTIVE is NOT substantive (bootstrap exempt)", () => {
  assert.equal(isSubstantiveWriteTarget(".archon/ACTIVE"), false);
});

test("isSubstantiveWriteTarget: .archon/work/task-queue.json is NOT substantive (bootstrap exempt)", () => {
  assert.equal(isSubstantiveWriteTarget(".archon/work/task-queue.json"), false);
});

test("isSubstantiveWriteTarget: .archon/work/product-state.md is NOT substantive (bootstrap exempt)", () => {
  assert.equal(isSubstantiveWriteTarget(".archon/work/product-state.md"), false);
});

test("isSubstantiveWriteTarget: task packet path is NOT substantive (bootstrap exempt)", () => {
  assert.equal(isSubstantiveWriteTarget(".archon/work/tasks/task-p2-write-gate.md"), false);
  assert.equal(isSubstantiveWriteTarget(".archon/work/tasks/task-any-id.md"), false);
});

test("isSubstantiveWriteTarget: src/ and tests/ paths are substantive", () => {
  assert.equal(isSubstantiveWriteTarget("src/index.ts"), true);
  assert.equal(isSubstantiveWriteTarget("tests/hook-policy.test.ts"), true);
  assert.equal(isSubstantiveWriteTarget("src/admin.ts"), true);
});

test("isSubstantiveWriteTarget: .archon/work/reviews/ is substantive (requires active task)", () => {
  assert.equal(isSubstantiveWriteTarget(".archon/work/reviews/review-p2-reviewer.md"), true);
});

test("isSubstantiveWriteTarget: empty or non-string returns false", () => {
  assert.equal(isSubstantiveWriteTarget(""), false);
  assert.equal(isSubstantiveWriteTarget("   "), false);
});

// ─── evaluatePreToolUse: no-task write gate ──────────────────────────────────

test("Edit to tests/foo.test.ts with no active task is blocked by no-task write gate", () => {
  const result = evaluatePreToolUse(editPayload("tests/foo.test.ts"), emptyContext());
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("Write to .archon/ACTIVE with no active task is NOT blocked (bootstrap exempt)", () => {
  const result = evaluatePreToolUse(writePayload(".archon/ACTIVE"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block");
});

test("Write to .archon/work/task-queue.json with no active task is NOT blocked (bootstrap exempt)", () => {
  const result = evaluatePreToolUse(writePayload(".archon/work/task-queue.json"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block");
});

test("Write to .archon/work/product-state.md with no active task is NOT blocked (bootstrap exempt)", () => {
  const result = evaluatePreToolUse(writePayload(".archon/work/product-state.md"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block");
});

test("Write to src/index.ts WITH active task is allowed", () => {
  const ctx = contextWithScope("src/index.ts");
  const result = evaluatePreToolUse(writePayload("src/index.ts"), ctx);
  assert.ok(result === undefined || result.decision !== "block");
});

test("Write to src/ with active task but any scope is allowed (no scope restriction for non-managed)", () => {
  const ctx = { ...emptyContext(), activeTaskId: "task-1" };
  const result = evaluatePreToolUse(writePayload("src/foo.ts"), ctx);
  assert.ok(result === undefined || result.decision !== "block");
});

test("no-task gate block reason is actionable (names bootstrap path to unblock)", () => {
  const result = evaluatePreToolUse(writePayload("src/index.ts"), emptyContext());
  assert.ok(result?.reason);
  assert.match(result.reason, /\.archon\/work\/tasks\//i);
  assert.match(result.reason, /\.archon\/ACTIVE/i);
});

// DAC condition 3: archon:bypass must NOT bypass the PreToolUse write gate
test("no-task gate fires regardless of bypass-like context in PreToolUse payload", () => {
  // The PreToolUse payload has no prompt field — archon:bypass cannot appear here.
  // Verify the gate fires on a normal write payload (no bypass mechanism exists at this layer).
  const result = evaluatePreToolUse(writePayload("src/index.ts"), emptyContext());
  assert.ok(result, "gate must fire");
  assert.equal(result.decision, "block");
});

// ─── Phase 5: appendBypassLogEntry ───────────────────────────────────────────

import os from "node:os";
import fs from "node:fs";

test("appendBypassLogEntry: creates bypass log with first entry", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-bypass-test-"));
  try {
    appendBypassLogEntry(tmpDir, "archon:bypass do something");
    const logPath = path.join(tmpDir, ".archon", "work", "daemon", "bypass-log.json");
    const entries = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.equal(entries.length, 1);
    assert.match(entries[0].promptExcerpt, /archon:bypass/);
    assert.ok(typeof entries[0].timestamp === "string");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("appendBypassLogEntry: appends entries on successive calls", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-bypass-test-"));
  try {
    appendBypassLogEntry(tmpDir, "archon:bypass first");
    appendBypassLogEntry(tmpDir, "archon:bypass second");
    const logPath = path.join(tmpDir, ".archon", "work", "daemon", "bypass-log.json");
    const entries = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.equal(entries.length, 2);
    assert.match(entries[1].promptExcerpt, /second/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("appendBypassLogEntry: truncates long prompts to 200 chars", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-bypass-test-"));
  try {
    const longPrompt = "archon:bypass " + "x".repeat(500);
    appendBypassLogEntry(tmpDir, longPrompt);
    const logPath = path.join(tmpDir, ".archon", "work", "daemon", "bypass-log.json");
    const entries = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.ok(entries[0].promptExcerpt.length <= 200);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Phase 3: parseRequiredReviews + reviewArtifactPath ─────────────────────

test("parseRequiredReviews: extracts role names from ## Required reviews section", () => {
  const md = `# Task\n\n## Required reviews\n\n- \`reviewer\`\n- \`qa_engineer\`\n- \`security_reviewer\`\n\n## Next section\n`;
  const roles = parseRequiredReviews(md);
  assert.deepEqual(roles, ["reviewer", "qa_engineer", "security_reviewer"]);
});

test("parseRequiredReviews: returns empty array when section is absent", () => {
  const md = `# Task\n\n## Allowed write scope\n\n- src/\n`;
  assert.deepEqual(parseRequiredReviews(md), []);
});

test("reviewArtifactPath: returns correct relative path for task + role", () => {
  assert.equal(
    reviewArtifactPath("p2-write-gate", "reviewer"),
    ".archon/work/reviews/review-p2-write-gate-reviewer.md"
  );
  assert.equal(
    reviewArtifactPath("p3-review-gate-stop", "qa_engineer"),
    ".archon/work/reviews/review-p3-review-gate-stop-qa_engineer.md"
  );
});

// ─── Phase 3: evaluateStop review existence gate ─────────────────────────────

function stopPayload(lastAssistantMessage = "") {
  return { last_assistant_message: lastAssistantMessage, stop_hook_active: false };
}

test("evaluateStop: no active task — review gate does not fire", () => {
  const ctx = { ...emptyContext(), missingReviews: [".archon/work/reviews/review-x-reviewer.md"] };
  // No activeTaskId — review gate must not hold stop
  const result = evaluateStop(stopPayload("scoped task is complete; external workflow/runtime closure"), ctx);
  assert.ok(result === undefined || result.continue !== false);
});

test("evaluateStop: active task, all reviews present — stop proceeds (review gate silent)", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p3-review-gate-stop",
    requiredReviews: ["reviewer", "qa_engineer"],
    missingReviews: []
  };
  const result = evaluateStop(stopPayload("scoped task is complete; external workflow/runtime closure"), ctx);
  // Review gate must not hold stop — missingReviews is empty
  const heldByReviewGate =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("missing required review files");
  assert.ok(!heldByReviewGate, "review gate must not fire when all reviews are present");
});

// Use a completion-signal message so shouldHoldStop returns false and the review gate fires.
const COMPLETION_MSG = "scoped task is complete; external workflow/runtime closure";

test("evaluateStop: active task, one review missing + completion signal — stop held by review gate", () => {
  const missingPath = ".archon/work/reviews/review-p3-review-gate-stop-security_reviewer.md";
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p3-review-gate-stop",
    requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"],
    missingReviews: [missingPath]
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.match(result.stopReason, /missing required review files/i);
  assert.ok(result.stopReason.includes(missingPath), "stop reason must name the missing file");
});

test("evaluateStop: active task, all reviews missing + completion signal — stop held naming all missing files", () => {
  const missing = [
    ".archon/work/reviews/review-p3-reviewer.md",
    ".archon/work/reviews/review-p3-qa_engineer.md",
    ".archon/work/reviews/review-p3-security_reviewer.md"
  ];
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p3",
    requiredReviews: ["reviewer", "qa_engineer", "security_reviewer"],
    missingReviews: missing
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result);
  assert.equal(result.continue, false);
  for (const p of missing) {
    assert.ok(result.stopReason.includes(p), `stop reason must name missing file: ${p}`);
  }
});

// ─── Phase 6: stop hook hardening — review gate fires only at completion ─────

test("Phase 6: mid-task (empty message) + missing reviews → shouldHoldStop drives, review gate silent", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p6",
    requiredReviews: ["reviewer"],
    missingReviews: [".archon/work/reviews/review-p6-reviewer.md"]
  };
  // Empty message → shouldHoldStop returns true → review gate must NOT fire
  const result = evaluateStop(stopPayload(""), ctx);
  assert.ok(result, "expected stop to be held by shouldHoldStop");
  assert.equal(result.continue, false);
  // Must be driven by shouldHoldStop (task in progress), not by review gate
  assert.ok(
    !result.stopReason.includes("missing required review files"),
    "review gate must not fire mid-task"
  );
});

test("Phase 6: completion signal + missing reviews → review gate holds", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p6",
    requiredReviews: ["reviewer"],
    missingReviews: [".archon/work/reviews/review-p6-reviewer.md"]
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result);
  assert.equal(result.continue, false);
  assert.match(result.stopReason, /missing required review files/i);
});

test("Phase 6: completion signal + all reviews present → stop allowed", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p6",
    requiredReviews: ["reviewer"],
    missingReviews: []
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByReviewGate =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("missing required review files");
  assert.ok(!heldByReviewGate, "review gate must not fire when reviews are present");
});

// ─── toRelativePath ──────────────────────────────────────────────────────────

test("toRelativePath: strips repo root prefix from absolute path", () => {
  assert.equal(
    toRelativePath("/home/user/project/src/index.ts", "/home/user/project"),
    "src/index.ts"
  );
});

test("toRelativePath: leaves relative paths unchanged", () => {
  assert.equal(toRelativePath("src/index.ts", "/home/user/project"), "src/index.ts");
});

test("toRelativePath: handles repo root with trailing slash", () => {
  assert.equal(
    toRelativePath("/home/user/project/tests/foo.ts", "/home/user/project/"),
    "tests/foo.ts"
  );
});

test("toRelativePath: returns original if not under repo root", () => {
  assert.equal(
    toRelativePath("/other/path/file.ts", "/home/user/project"),
    "/other/path/file.ts"
  );
});

// ─── Phase 4: task-scope write gate ─────────────────────────────────────────

test("Write to in-scope file with active task is allowed", () => {
  const ctx = contextWithScope("src/foo.ts");
  const result = evaluatePreToolUse(writePayload("src/foo.ts"), ctx);
  assert.ok(result === undefined || result.decision !== "block");
});

test("Write to out-of-scope file with active task and non-empty scope is blocked", () => {
  const ctx = contextWithScope("src/foo.ts");
  const result = evaluatePreToolUse(writePayload("src/bar.ts"), ctx);
  assert.ok(result, "expected a block");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /outside active task/i);
  assert.match(result.reason, /src\/foo\.ts/);
});

test("Write to any file with active task and empty scope is allowed (task does not restrict)", () => {
  const ctx = { ...emptyContext(), activeTaskId: "task-1" };
  const result = evaluatePreToolUse(writePayload("src/anything.ts"), ctx);
  assert.ok(result === undefined || result.decision !== "block");
});

test("Edit to out-of-scope file with active task and non-empty scope is blocked", () => {
  const ctx = contextWithScope("src/foo.ts");
  const result = evaluatePreToolUse(editPayload("src/other.ts"), ctx);
  assert.ok(result);
  assert.equal(result.decision, "block");
});

test("scope gate block reason names the allowed scope entries", () => {
  const ctx = contextWithScope("src/foo.ts", "src/bar.ts");
  const result = evaluatePreToolUse(writePayload("src/baz.ts"), ctx);
  assert.ok(result?.reason);
  assert.match(result.reason, /src\/foo\.ts/);
});

// Phase 4 with absolute paths (simulating real Claude Code hook payloads)

function writePayloadAbsolute(filePath: string) {
  return { tool_name: "Write", tool_input: { file_path: `/repo/${filePath}` } };
}

function ctxWithAbsoluteRoot(...scope: string[]) {
  return {
    ...emptyContext(),
    repoRoot: "/repo",
    activeTaskId: "task-1",
    allowedWriteScope: scope
  };
}

test("Phase 4 + toRelativePath: absolute path in scope is allowed", () => {
  const ctx = ctxWithAbsoluteRoot("src/foo.ts");
  const result = evaluatePreToolUse(writePayloadAbsolute("src/foo.ts"), ctx);
  assert.ok(result === undefined || result.decision !== "block");
});

test("Phase 4 + toRelativePath: absolute path out of scope is blocked", () => {
  const ctx = ctxWithAbsoluteRoot("src/foo.ts");
  const result = evaluatePreToolUse(writePayloadAbsolute("src/bar.ts"), ctx);
  assert.ok(result, "expected a block");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /outside active task/i);
});

test("scope entry with trailing slash matches files in that directory", () => {
  // .archon/work/reviews/ (with trailing slash) must match review files inside it
  const ctx = contextWithScope(".archon/work/reviews/");
  const result = evaluatePreToolUse(
    writePayload(".archon/work/reviews/review-p4-reviewer.md"),
    ctx
  );
  assert.ok(result === undefined || result.decision !== "block");
});

// ─── Phase 7: isReadOnlyBashCommand heredoc false-positive fix ───────────────

test("isReadOnlyBashCommand: tee in heredoc body is not write-like", () => {
  // ls is read-only; echo with heredoc containing tee should not flag as write
  const command = "ls .claude/ && echo \"$(cat <<'EOF'\ntee output here\nEOF\n)\"";
  assert.equal(isReadOnlyBashCommand(command), true);
});

test("isReadOnlyBashCommand: > in heredoc body is not a redirect", () => {
  const command = "ls .claude/ && echo \"$(cat <<'EOF'\nsome > output\nEOF\n)\"";
  assert.equal(isReadOnlyBashCommand(command), true);
});

test("isReadOnlyBashCommand: multi-line heredoc body with multiple write-like words", () => {
  const command = "cat .claude/settings.json && echo \"$(cat <<'EOF'\ntee\nmv\nmkdir\nEOF\n)\"";
  assert.equal(isReadOnlyBashCommand(command), true);
});

test("isReadOnlyBashCommand: tee OUTSIDE heredoc is still write-like", () => {
  assert.equal(isReadOnlyBashCommand("cat .claude/settings.json | tee /tmp/out"), false);
});

test("isReadOnlyBashCommand: > redirect outside heredoc is still write-like", () => {
  assert.equal(isReadOnlyBashCommand("cat .claude/settings.json > /tmp/out"), false);
});

test("isReadOnlyBashCommand: git commit is not read-only even with heredoc body stripping", () => {
  // git commit is not in readOnlyCommandSegmentPatterns regardless of heredoc content
  const command = "git commit -m \"$(cat <<'EOF'\ntee info\nEOF\n)\"";
  assert.equal(isReadOnlyBashCommand(command), false);
});

test("isReadOnlyBashCommand: heredoc with dash-stripped variant <<-WORD", () => {
  const command = "ls .claude/ && cat <<-EOF\n\ttee output\nEOF";
  assert.equal(isReadOnlyBashCommand(command), true);
});

// ─── Phase 8: runtime health — session-start and stop gate ───────────────────

function sessionStartPayload(source?: string) {
  return source ? { source } : {};
}

test("Phase 8 evaluateSessionStart: configured+offline runtime → additionalContext includes runtime offline warning", () => {
  const ctx = { ...emptyContext(), runtimeConfigured: true, runtimeConnected: false };
  const result = evaluateSessionStart(sessionStartPayload(), ctx);
  assert.ok(result, "expected additionalContext to be returned");
  assert.ok(
    typeof result.additionalContext === "string" && result.additionalContext.includes("archon runtime offline"),
    `expected "archon runtime offline" in additionalContext, got: ${result?.additionalContext}`
  );
});

test("Phase 8 evaluateSessionStart: runtime not configured → no runtime warning", () => {
  const ctx = { ...emptyContext(), runtimeConfigured: false, runtimeConnected: false };
  const result = evaluateSessionStart(sessionStartPayload(), ctx);
  const hasRuntimeWarning =
    typeof result?.additionalContext === "string" && result.additionalContext.includes("archon runtime offline");
  assert.ok(!hasRuntimeWarning, "must not warn when runtime is not configured");
});

test("Phase 8 evaluateSessionStart: configured+connected runtime → no runtime warning", () => {
  const ctx = { ...emptyContext(), runtimeConfigured: true, runtimeConnected: true };
  const result = evaluateSessionStart(sessionStartPayload(), ctx);
  const hasRuntimeWarning =
    typeof result?.additionalContext === "string" && result.additionalContext.includes("archon runtime offline");
  assert.ok(!hasRuntimeWarning, "must not warn when runtime is connected");
});

test("Phase 8 evaluateStop: completion signal + configured+offline + active task → held by runtime gate", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p8-runtime-activation",
    runtimeConfigured: true,
    runtimeConnected: false,
    missingReviews: []
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(
    typeof result.stopReason === "string" && result.stopReason.includes("archon runtime is offline"),
    `expected runtime gate message, got: ${result?.stopReason}`
  );
});

test("Phase 8 evaluateStop: mid-task (empty message) + configured+offline + active task → NOT held by runtime gate", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p8-runtime-activation",
    runtimeConfigured: true,
    runtimeConnected: false,
    missingReviews: []
  };
  // Empty message → shouldHoldStop returns true → taskShouldHold is true → runtime gate must NOT fire
  const result = evaluateStop(stopPayload(""), ctx);
  const heldByRuntimeGate =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("archon runtime is offline");
  assert.ok(!heldByRuntimeGate, "runtime gate must not fire mid-task");
});

test("Phase 8 evaluateStop: completion + runtime not configured → not held by runtime gate", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "p8-runtime-activation",
    runtimeConfigured: false,
    runtimeConnected: false,
    missingReviews: []
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByRuntimeGate =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("archon runtime is offline");
  assert.ok(!heldByRuntimeGate, "runtime gate must not fire when runtime is not configured");
});

test("Phase 8 evaluateStop: configured+offline + NO active task → stop not held by runtime gate", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: undefined,
    queueCurrentTaskId: undefined,
    runtimeConfigured: true,
    runtimeConnected: false,
    missingReviews: []
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByRuntimeGate =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("archon runtime is offline");
  assert.ok(!heldByRuntimeGate, "runtime gate must not fire when no active task");
});

// ─── Cleanup-1: isReadOnlyBashCommand io-discard redirect fix ─────────────────

test("isReadOnlyBashCommand: ls with 2>/dev/null is read-only", () => {
  assert.equal(isReadOnlyBashCommand("ls .claude/hooks/ 2>/dev/null"), true);
});

test("isReadOnlyBashCommand: ls chained with && and 2>/dev/null on each segment is read-only", () => {
  const command = "ls .claude/hooks/ 2>/dev/null && ls src/ 2>/dev/null";
  assert.equal(isReadOnlyBashCommand(command), true);
});

test("isReadOnlyBashCommand: cat with 2>/dev/null is read-only", () => {
  assert.equal(isReadOnlyBashCommand("cat .archon/ACTIVE 2>/dev/null"), true);
});

test("isReadOnlyBashCommand: find with 2>&1 is read-only", () => {
  assert.equal(isReadOnlyBashCommand("find .claude -name '*.mjs' 2>&1"), true);
});

test("isReadOnlyBashCommand: redirect to a real file path is still write-like", () => {
  assert.equal(isReadOnlyBashCommand("cat .archon/ACTIVE > /tmp/out.txt"), false);
});

test("isReadOnlyBashCommand: tee after a pipe is still write-like even with 2>/dev/null", () => {
  assert.equal(isReadOnlyBashCommand("cat .claude/settings.json 2>/dev/null | tee /tmp/out"), false);
});
