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
const { isManagedPath, isManagedPathAllowed, isManagedPrefixPartiallyAllowed, isAllowedPath } = await import(
  `${hooksDir}/hook-utils.mjs`
);
const { evaluatePreToolUse, evaluatePermissionRequest } = await import(
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
    authorityMismatches: []
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

test("Write to src/index.ts with no active task is NOT blocked by managed-path guard", () => {
  const result = evaluatePreToolUse(writePayload("src/index.ts"), emptyContext());
  // May be undefined or have additionalContext — must not be a block
  assert.ok(result === undefined || result.decision !== "block");
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
