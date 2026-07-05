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
  toRelativePath,
  parseVerificationRequired,
  parseRequiredVerifications,
  isVerificationSatisfied,
  persistVerificationCert,
  readVerificationCert,
  qualifiesForVerificationCert,
  parseTaskClass,
  verificationExemptTaskClasses,
  readActiveTaskContext,
  extractBashWriteTargets,
  validateReviewArtifact,
  parseCouncilReview,
  isHandoffArtifactPath,
  isDirectDbClientInvocation,
  hasDbDirectScopeGrant,
  isDestructiveCommand,
  resolveShellWordConcatenation
} = await import(`${hooksDir}/hook-utils.mjs`);
const {
  evaluatePreToolUse,
  evaluatePermissionRequest,
  evaluateStop,
  evaluateSessionStart,
  evaluatePostToolUse
} = await import(`${hooksDir}/hook-policy.mjs`);

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
    invalidReviews: [],
    verificationRequired: true,
    verificationOptOutRejected: false,
    requiredVerifications: [],
    verificationCert: undefined,
    runtimeConfigured: false,
    runtimeConnected: false,
    councilRequired: false,
    councilOutcome: undefined
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

test("isManagedPath: .archon/ACTIVE and src/ are NOT managed", () => {
  assert.equal(isManagedPath(".archon/ACTIVE"), false);
  assert.equal(isManagedPath("src/index.ts"), false);
  assert.equal(isManagedPath("tests/foo.test.ts"), false);
});

test("isManagedPath: .archon/work/tasks/ is managed", () => {
  assert.equal(isManagedPath(".archon/work/tasks/task-foo.md"), true);
  assert.equal(isManagedPath(".archon/work/tasks/task-abc-123.md"), true);
});

test("isManagedPath: .archon/work/reviews/ is managed", () => {
  assert.equal(isManagedPath(".archon/work/reviews/review-foo.md"), true);
});

test("isManagedPath: .archon/work/daemon/ is managed", () => {
  assert.equal(isManagedPath(".archon/work/daemon/foo.json"), true);
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
  // Finding 1 fix: the unblock instruction must name the sanctioned cold-start
  // command, not the previously-impossible manual task-packet write.
  assert.match(result.reason, /init-task/i);
});

test("Write to .archon/work/tasks/task-foo.md with no active task is blocked (managed path)", () => {
  const result = evaluatePreToolUse(
    writePayload(".archon/work/tasks/task-foo.md"),
    emptyContext()
  );
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

test("Write to .archon/work/tasks/task-foo.md with active task in scope is allowed", () => {
  const ctx = contextWithScope(".archon/work/tasks");
  const result = evaluatePreToolUse(
    writePayload(".archon/work/tasks/task-foo.md"),
    ctx
  );
  assert.ok(result === undefined || result.decision !== "block");
});

test("Write to .archon/work/reviews/review-foo.md with no active task is blocked (managed path)", () => {
  const result = evaluatePreToolUse(
    writePayload(".archon/work/reviews/review-foo.md"),
    emptyContext()
  );
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

test("Write to .archon/work/daemon/foo.json with no active task is blocked (managed path)", () => {
  const result = evaluatePreToolUse(
    writePayload(".archon/work/daemon/foo.json"),
    emptyContext()
  );
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
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

// ─── isDirectDbClientInvocation / hasDbDirectScopeGrant ──────────────────────
// Audit auditP3Stewards HIGH (security): runtime-medic's "sanctioned admin CLI
// only, never direct DB writes" boundary was prose-only. These tests prove
// both directions: the named bypass shape is blocked, and the sanctioned admin
// CLI (and ordinary read-only commands that merely mention "psql" as text)
// pass through unaffected.

test("isDirectDbClientInvocation: raw psql UPDATE is detected", () => {
  assert.equal(
    isDirectDbClientInvocation('psql "$ARCHON_CORE_DATABASE_URL" -c "UPDATE reviews SET outcome=1"'),
    true
  );
});

test("isDirectDbClientInvocation: psql --version and read-only psql -c \"SELECT 1\" are ALSO detected (documented decision: block psql entirely, not just writes)", () => {
  assert.equal(isDirectDbClientInvocation("psql --version"), true);
  assert.equal(isDirectDbClientInvocation('psql -U archon -d archon -tAc "select 1;"'), true);
});

test("isDirectDbClientInvocation: pg_dump, pg_restore, and pgcli are detected", () => {
  assert.equal(isDirectDbClientInvocation("pg_dump -U archon archon > backup.sql"), true);
  assert.equal(isDirectDbClientInvocation("pg_restore -U archon -d archon backup.dump"), true);
  assert.equal(isDirectDbClientInvocation('pgcli "$ARCHON_CORE_DATABASE_URL"'), true);
});

// Security round 2 (finding 1): the detection rule moved from "the word
// appears anywhere in the segment" to "the FIRST resolved word of the
// segment IS the word" — this is what resolves the quote-splitting false
// negative below without reintroducing a false positive on `grep -n "psql"
// file` (psql is grep's ARGUMENT there, not the executed program). One
// documented, accepted consequence: a wrapper-prefixed invocation like
// `docker exec archon-postgres psql ...` is no longer caught, because the
// first resolved word of that segment is `docker`, not `psql` — this is a
// disclosed scope trim (see the "ACCEPTED LIMITATIONS" doc comment on
// isDirectDbClientInvocation in hook-utils.mjs), not a regression: it was
// never a shape any finding required, and it was only ever caught by the
// old, broader (and, per this finding, exploitable) "anywhere in segment"
// rule.
test("isDirectDbClientInvocation: wrapper-prefixed invocation (docker exec ... psql) is NOT caught by the first-word rule (documented scope trim, security round 2)", () => {
  assert.equal(
    isDirectDbClientInvocation('docker exec archon-postgres psql -U archon -d archon -tAc "select 1;"'),
    false
  );
});

test("isDirectDbClientInvocation: quote-split evasion (p\"\"sql / pg''_dump) is detected (security round 2, HIGH)", () => {
  assert.equal(
    isDirectDbClientInvocation('p""sql "$ARCHON_CORE_DATABASE_URL" -c "UPDATE reviews SET outcome=1"'),
    true
  );
  assert.equal(isDirectDbClientInvocation("pg''_dump -U archon archon > backup.sql"), true);
});

test("isDirectDbClientInvocation: legitimate quoted fragments that do NOT form a client word still pass (security round 2, HIGH)", () => {
  // Two separate shell ARGUMENTS ("p" and "sql"), not one concatenated word —
  // there is real whitespace between them, so this must not resolve to "psql".
  assert.equal(isDirectDbClientInvocation('echo "p" "sql"'), false);
  // A single quoted argument containing the literal text p"sql is DATA being
  // searched for, not an invocation of a client binary named psql.
  assert.equal(isDirectDbClientInvocation("grep 'p\"sql' foo.sh"), false);
});

test("isDirectDbClientInvocation: psql piped as the second stage of a pipeline is detected", () => {
  assert.equal(isDirectDbClientInvocation('cat query.sql | psql "$ARCHON_CORE_DATABASE_URL"'), true);
});

test("isDirectDbClientInvocation: psql wrapped in eval/bash -c is detected", () => {
  assert.equal(isDirectDbClientInvocation("eval \"psql -c 'select 1'\""), true);
  assert.equal(isDirectDbClientInvocation('bash -c "psql -c \'select 1\'"'), true);
});

test("isDirectDbClientInvocation: psql inside an executable heredoc body is detected", () => {
  assert.equal(
    isDirectDbClientInvocation('bash <<EOF\npsql -c "select 1"\nEOF'),
    true
  );
});

test("isDirectDbClientInvocation: node/npx one-liner requiring 'pg' is detected", () => {
  assert.equal(isDirectDbClientInvocation("node -e \"require('pg').Client\""), true);
  assert.equal(isDirectDbClientInvocation('npx -e "import { Client } from \'pg\'"'), true);
});

test("isDirectDbClientInvocation: sanctioned admin CLI commands are NEVER detected", () => {
  assert.equal(isDirectDbClientInvocation("npx tsx ./src/admin.ts status --run-id latest"), false);
  assert.equal(
    isDirectDbClientInvocation(
      "ARCHON_CORE_DATABASE_URL=postgresql://x npx tsx src/admin.ts init-task --id foo"
    ),
    false
  );
  assert.equal(
    isDirectDbClientInvocation("node --experimental-strip-types src/admin.ts recover --run-id latest"),
    false
  );
  assert.equal(isDirectDbClientInvocation("npx tsx src/admin.ts reconcile-runtime-state --apply"), false);
});

test("isDirectDbClientInvocation: a mere TEXT MENTION of psql (not an invocation) is NOT detected", () => {
  assert.equal(isDirectDbClientInvocation('grep -n "psql" .claude/hooks/hook-utils.mjs'), false);
  assert.equal(isDirectDbClientInvocation("cat migration.sql"), false);
  assert.equal(isDirectDbClientInvocation('echo "run psql to inspect the db"'), false);
});

test("isDirectDbClientInvocation: node -e with no 'pg' reference is NOT detected", () => {
  assert.equal(isDirectDbClientInvocation('node -e "console.log(1)"'), false);
});

test("isDirectDbClientInvocation: ordinary non-DB commands are NOT detected", () => {
  assert.equal(isDirectDbClientInvocation("npm test"), false);
  assert.equal(isDirectDbClientInvocation("npm run build:dist && npm test"), false);
  assert.equal(isDirectDbClientInvocation("npx tsc --noEmit"), false);
});

test("hasDbDirectScopeGrant: true only when the literal `db_direct` marker is present", () => {
  assert.equal(hasDbDirectScopeGrant(["db_direct"]), true);
  assert.equal(hasDbDirectScopeGrant(["src/archon", "db_direct", "tests"]), true);
  assert.equal(hasDbDirectScopeGrant([]), false);
  assert.equal(hasDbDirectScopeGrant(["src/archon"]), false);
  assert.equal(hasDbDirectScopeGrant(undefined), false);
});

// ─── resolveShellWordConcatenation / isDestructiveCommand (security round 2) ─
// Finding 1 required the tokenization-layer fix to be mirrored into
// isDestructiveCommand, since it shares the identical pre-existing flaw
// (tested against raw, unmasked command text with zero quote-awareness).

test("resolveShellWordConcatenation: collapses adjacent quote fragments and unquoted backslash-escapes into one literal word", () => {
  assert.equal(resolveShellWordConcatenation('p""sql'), "psql");
  assert.equal(resolveShellWordConcatenation("pg''_dump"), "pg_dump");
  assert.equal(resolveShellWordConcatenation("p\\s\\q\\l"), "psql");
});

test("resolveShellWordConcatenation: preserves real whitespace between distinct words", () => {
  assert.equal(resolveShellWordConcatenation('"p" "sql"'), "p sql");
});

test("resolveShellWordConcatenation: a foreign quote character nested inside an outer quoted span survives as a literal character (does not toggle quoting)", () => {
  // The inner single-quotes around 'pg' must remain literal apostrophes once
  // the outer double-quotes are resolved, so pgPackageReferencePattern can
  // still match require('pg') in the resolved text.
  assert.equal(resolveShellWordConcatenation('"require(\'pg\').Client"'), "require('pg').Client");
});

test("isDestructiveCommand: quote-split evasion of a destructive phrase is detected (security round 2, mirrored fix)", () => {
  assert.equal(isDestructiveCommand('g""it reset --hard'), true);
});

test("isDestructiveCommand: the plain phrase is still detected after the mirrored fix", () => {
  assert.equal(isDestructiveCommand("git reset --hard HEAD~1"), true);
  assert.equal(isDestructiveCommand("some-other-command --flag value"), false);
});

test("evaluatePreToolUse: raw psql UPDATE with no active task is blocked", () => {
  const result = evaluatePreToolUse(
    bashPayload('psql "$ARCHON_CORE_DATABASE_URL" -c "UPDATE reviews SET outcome=1"'),
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "block");
  assert.match(result.reason, /direct database-client invocation/i);
});

test("evaluatePreToolUse: sanctioned admin CLI command is NOT blocked by the DB-direct gate", () => {
  const result = evaluatePreToolUse(
    bashPayload("npx tsx ./src/admin.ts status --run-id latest"),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "block");
});

test("evaluatePreToolUse: psql is allowed when the task packet grants `db_direct` scope", () => {
  const ctx = contextWithScope("db_direct");
  const result = evaluatePreToolUse(bashPayload('psql -c "select 1"'), ctx);
  assert.ok(result === undefined || result.decision !== "block");
});

test("evaluatePreToolUse: an unrelated grant (e.g. src/archon) does NOT satisfy the db_direct gate", () => {
  const ctx = contextWithScope("src/archon");
  const result = evaluatePreToolUse(bashPayload('psql -c "select 1"'), ctx);
  assert.ok(result);
  assert.equal(result.decision, "block");
});

test("evaluatePreToolUse: read-only grep for the word psql is NOT blocked (normal workflow preserved)", () => {
  const result = evaluatePreToolUse(
    bashPayload('grep -rn "psql" .claude/hooks/hook-utils.mjs'),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "block");
});

test("evaluatePermissionRequest: raw psql UPDATE approval request with no task is denied", () => {
  const result = evaluatePermissionRequest(
    bashPayload('psql "$ARCHON_CORE_DATABASE_URL" -c "UPDATE reviews SET outcome=1"'),
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "deny");
  assert.match(result.reason, /direct database-client invocation/i);
});

test("evaluatePermissionRequest: psql approval request is allowed with `db_direct` scope granted", () => {
  const ctx = contextWithScope("db_direct");
  const result = evaluatePermissionRequest(bashPayload('psql -c "select 1"'), ctx);
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

test("no-task gate block reason is actionable (names sanctioned cold-start command)", () => {
  const result = evaluatePreToolUse(writePayload("src/index.ts"), emptyContext());
  assert.ok(result?.reason);
  // Finding 1 fix: the actionable unblock path is the runtime cold-start command
  // or pointing .archon/ACTIVE at an existing task — not a manual managed-path write.
  assert.match(result.reason, /init-task/i);
  assert.match(result.reason, /\.archon\/ACTIVE/i);
});

// ─── .archon/skills/** whitelist ─────────────────────────────────────────────

test("Write to .archon/skills/SKILL.md with no active task is NOT blocked (skills whitelisted)", () => {
  const result = evaluatePreToolUse(writePayload(".archon/skills/typescript-build/SKILL.md"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block");
});

test("Write to .archon/skills/README.md with no active task is NOT blocked (skills whitelisted)", () => {
  const result = evaluatePreToolUse(writePayload(".archon/skills/README.md"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block");
});

test("Edit to .archon/skills/deploy/SKILL.md with no active task is NOT blocked (skills whitelisted)", () => {
  const result = evaluatePreToolUse(editPayload(".archon/skills/deploy/staging-deploy/SKILL.md"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block");
});

test("Write to .archon/skills/ is NOT blocked even when a task with narrow scope is active", () => {
  const ctx = contextWithScope("src/index.ts");
  const result = evaluatePreToolUse(writePayload(".archon/skills/build/SKILL.md"), ctx);
  assert.ok(result === undefined || result.decision !== "block");
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

test("parseRequiredReviews: returns default trio when section is absent", () => {
  const md = `# Task\n\n## Allowed write scope\n\n- src/\n`;
  assert.deepEqual(parseRequiredReviews(md), ["reviewer", "security_reviewer", "qa_engineer"]);
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

test("toRelativePath: collapses double-slash in absolute in-repo path", () => {
  // Crafted double-slash path must canonicalize to a clean repo-relative path
  // (no leading slash) so the managed-path and scope gates can match it.
  assert.equal(
    toRelativePath("/home/user/project//.claude/agents/x.md", "/home/user/project"),
    ".claude/agents/x.md"
  );
});

test("toRelativePath: collapses dot-dot traversal that resolves in-repo", () => {
  assert.equal(
    toRelativePath("/home/user/project/../project/CLAUDE.md", "/home/user/project"),
    "CLAUDE.md"
  );
});

test("toRelativePath: dot-dot escaping the repo returns canonical absolute path", () => {
  assert.equal(
    toRelativePath("/home/user/project/../other/file.ts", "/home/user/project"),
    "/home/user/other/file.ts"
  );
});

test("toRelativePath: repo root itself normalizes to empty string", () => {
  assert.equal(toRelativePath("/home/user/project", "/home/user/project"), "");
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

// ─── Verification cert: pure function tests ──────────────────────────────────

test("parseVerificationRequired: absent section → required by default", () => {
  assert.equal(parseVerificationRequired("## Some other section\n- item\n"), true);
});

test("parseVerificationRequired: false → not required", () => {
  assert.equal(parseVerificationRequired("## Verification required\n\n`false`\n"), false);
  assert.equal(parseVerificationRequired("## Verification required\n\nfalse\n"), false);
});

test("parseVerificationRequired: no/skip → not required", () => {
  assert.equal(parseVerificationRequired("## Verification required\n\nno\n"), false);
  assert.equal(parseVerificationRequired("## Verification required\n\nskip\n"), false);
});

test("parseVerificationRequired: true or any other value → required", () => {
  assert.equal(parseVerificationRequired("## Verification required\n\ntrue\n"), true);
  assert.equal(parseVerificationRequired("## Verification required\n\nyes\n"), true);
});

test("parseRequiredVerifications: empty section → empty array", () => {
  assert.deepEqual(parseRequiredVerifications("## Something else\n"), []);
});

test("parseRequiredVerifications: lists commands", () => {
  const md = "## Required verifications\n\n- npm run test\n- bash scripts/check.sh\n";
  assert.deepEqual(parseRequiredVerifications(md), ["npm run test", "bash scripts/check.sh"]);
});

test("isVerificationSatisfied: empty passed commands → false", () => {
  assert.equal(isVerificationSatisfied("npm run test", []), false);
});

test("isVerificationSatisfied: exact match → true", () => {
  assert.equal(isVerificationSatisfied("npm run test", [{ command: "npm run test", passedAt: "t" }]), true);
});

test("isVerificationSatisfied: passed command with extra flags does NOT satisfy required (exact match enforced)", () => {
  assert.equal(
    isVerificationSatisfied("npm run test", [{ command: "npm run test -- --coverage 2>&1 | tail -50", passedAt: "t" }]),
    false
  );
});

test("isVerificationSatisfied: short prefix command does NOT satisfy longer required (exact match enforced)", () => {
  // 'npm' alone must not satisfy 'npm test' — closes the substring exploit
  assert.equal(
    isVerificationSatisfied("npm test", [{ command: "npm", passedAt: "t" }]),
    false
  );
});

test("isVerificationSatisfied: exact match on short canonical form → true", () => {
  assert.equal(
    isVerificationSatisfied("npm test", [{ command: "npm test", passedAt: "t" }]),
    true
  );
});

test("isVerificationSatisfied: unrelated command → false", () => {
  assert.equal(
    isVerificationSatisfied("npm run test", [{ command: "bash scripts/check.sh", passedAt: "t" }]),
    false
  );
});

// ─── Verification cert: file I/O tests ───────────────────────────────────────

test("persistVerificationCert + readVerificationCert: roundtrip", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-test-"));
  try {
    persistVerificationCert(tmpDir, "task-1", "npm run test");
    const cert = readVerificationCert(tmpDir, "task-1");
    assert.ok(cert, "cert should exist after writing");
    assert.equal(cert.taskId, "task-1");
    assert.equal(cert.passedCommands.length, 1);
    assert.equal(cert.passedCommands[0].command, "npm run test");
    assert.ok(typeof cert.passedCommands[0].passedAt === "string");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("persistVerificationCert: appends entries on subsequent calls", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-test-"));
  try {
    persistVerificationCert(tmpDir, "task-1", "npm run test");
    persistVerificationCert(tmpDir, "task-1", "bash scripts/check.sh");
    const cert = readVerificationCert(tmpDir, "task-1");
    assert.equal(cert.passedCommands.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readVerificationCert: missing cert → undefined", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-test-"));
  try {
    assert.equal(readVerificationCert(tmpDir, "no-such-task"), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── evaluatePostToolUse: cert written on passing verification ────────────────

function bashSuccessPayload(command: string) {
  return { tool_name: "Bash", tool_input: { command }, tool_response: { exitCode: 0 } };
}

test("evaluatePostToolUse: passing verification command writes cert", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-test-"));
  try {
    const ctx = { ...emptyContext(), repoRoot: tmpDir, activeTaskId: "task-cert" };
    // Provide TAP output with passing tests so qualifiesForVerificationCert returns true
    const payload = { tool_name: "Bash", tool_input: { command: "npm run test" }, tool_response: { exitCode: 0, stdout: "# tests 5\n# pass 5\n# fail 0\n" } };
    evaluatePostToolUse(payload, ctx);
    const cert = readVerificationCert(tmpDir, "task-cert");
    assert.ok(cert, "cert should be written after passing verification");
    assert.equal(cert.passedCommands[0].command, "npm run test");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("evaluatePostToolUse: passing non-verification bash does NOT write cert", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-test-"));
  try {
    const ctx = { ...emptyContext(), repoRoot: tmpDir, activeTaskId: "task-cert" };
    evaluatePostToolUse(bashSuccessPayload("ls src/"), ctx);
    assert.equal(readVerificationCert(tmpDir, "task-cert"), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("evaluatePostToolUse: passing verification with no active task does NOT write cert", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-test-"));
  try {
    const ctx = { ...emptyContext(), repoRoot: tmpDir, activeTaskId: undefined };
    evaluatePostToolUse(bashSuccessPayload("npm run test"), ctx);
    assert.equal(readVerificationCert(tmpDir, "task-no-active"), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── evaluateStop: verification cert gate ────────────────────────────────────

const CERT_PRESENT = { passedCommands: [{ command: "npm run test", passedAt: "2026-01-01T00:00:00.000Z" }] };

test("evaluateStop: no active task → verification gate does not fire", () => {
  const ctx = { ...emptyContext(), verificationRequired: true };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByVerification =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("verification evidence");
  assert.ok(!heldByVerification, "verification gate must not fire when no active task");
});

test("evaluateStop: active task + cert present → verification gate silent", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-1",
    missingReviews: [],
    verificationRequired: true,
    verificationCert: CERT_PRESENT
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByVerification =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("verification evidence");
  assert.ok(!heldByVerification, "verification gate must not fire when cert is present");
});

test("evaluateStop: active task + no cert → stop held with actionable message", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-1",
    missingReviews: [],
    verificationRequired: true,
    verificationCert: undefined
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(result.stopReason.includes("verification evidence"), `unexpected stopReason: ${result.stopReason}`);
  assert.ok(result.stopReason.includes("task-1"), "stopReason should name the task");
});

test("evaluateStop: verification required: false → gate does not fire even without cert", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-1",
    missingReviews: [],
    verificationRequired: false,
    verificationCert: undefined
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByVerification =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("verification evidence");
  assert.ok(!heldByVerification, "verification gate must not fire when verificationRequired is false");
});

test("evaluateStop: required verifications all satisfied → gate silent", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-1",
    missingReviews: [],
    verificationRequired: true,
    requiredVerifications: ["npm run test"],
    verificationCert: CERT_PRESENT
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByVerification =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("verification evidence");
  assert.ok(!heldByVerification, "verification gate must not fire when all required verifications are satisfied");
});

test("evaluateStop: required verification missing → stop held naming missing command", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-1",
    missingReviews: [],
    verificationRequired: true,
    requiredVerifications: ["npm run test", "node --experimental-strip-types scripts/check-archon-workflow.ts"],
    verificationCert: CERT_PRESENT
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(
    result.stopReason.includes("node --experimental-strip-types scripts/check-archon-workflow.ts"),
    `stopReason should name missing command: ${result.stopReason}`
  );
});

test("evaluateStop: mid-task message + no cert → shouldHoldStop fires, verification gate silent", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-1",
    missingReviews: [],
    verificationRequired: true,
    verificationCert: undefined
  };
  // Empty message → shouldHoldStop returns true → taskShouldHold → verification gate must NOT drive
  const result = evaluateStop(stopPayload(""), ctx);
  assert.ok(result, "expected stop to be held by shouldHoldStop");
  // Must not be the verification gate message
  assert.ok(
    !result.stopReason.includes("verification evidence"),
    "mid-task pause must be held by shouldHoldStop, not verification gate"
  );
});

// ─── GAP-4: isReadOnlyBashCommand extended patterns ──────────────────────────

test("isReadOnlyBashCommand: grep is read-only", () => {
  assert.equal(isReadOnlyBashCommand(`grep -rn "x" .claude/hooks/`), true);
});

test("isReadOnlyBashCommand: awk is read-only", () => {
  assert.equal(isReadOnlyBashCommand(`awk '{print $1}' CLAUDE.md`), true);
});

test("isReadOnlyBashCommand: diff is read-only", () => {
  assert.equal(isReadOnlyBashCommand("diff a.txt b.txt"), true);
});

test("isReadOnlyBashCommand: git log is read-only", () => {
  assert.equal(isReadOnlyBashCommand("git log --oneline -5"), true);
});

test("isReadOnlyBashCommand: git diff is read-only", () => {
  assert.equal(isReadOnlyBashCommand("git diff HEAD~1 -- .claude/settings.json"), true);
});

test("isReadOnlyBashCommand: git status is read-only", () => {
  assert.equal(isReadOnlyBashCommand("git status"), true);
});

test("isReadOnlyBashCommand: git rev-parse is read-only", () => {
  assert.equal(isReadOnlyBashCommand("git rev-parse HEAD"), true);
});

test("isReadOnlyBashCommand: git remote -v is read-only", () => {
  assert.equal(isReadOnlyBashCommand("git remote -v"), true);
});

test("isReadOnlyBashCommand: grep with redirect > is write-like", () => {
  assert.equal(isReadOnlyBashCommand("grep x file > out.txt"), false);
});

test("isReadOnlyBashCommand: sed -i is write-like", () => {
  assert.equal(isReadOnlyBashCommand("sed -i 's/a/b/' .claude/settings.json"), false);
});

// ─── GAP-4: read-only managed-path Bash is allowed without a task ────────────

test("evaluatePermissionRequest: read-only grep on managed path with empty scope is not denied", () => {
  const result = evaluatePermissionRequest(
    bashPayload(`grep -n "foo" .claude/hooks/hook-utils.mjs`),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "deny", "read-only grep on managed path must not be denied");
});

test("evaluatePreToolUse: read-only grep on managed path with empty scope is allowed", () => {
  const result = evaluatePreToolUse(
    bashPayload(`grep -n "foo" .claude/hooks/hook-utils.mjs`),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "block", "read-only grep on managed path must not be blocked");
});

// ─── GAP-4: MultiEdit and NotebookEdit gates ─────────────────────────────────

function multiEditPayload(filePath: string) {
  return { tool_name: "MultiEdit", tool_input: { file_path: filePath } };
}

function notebookEditPayload(notebookPath: string) {
  return { tool_name: "NotebookEdit", tool_input: { notebook_path: notebookPath } };
}

test("evaluatePreToolUse: MultiEdit targeting CLAUDE.md with empty scope is blocked (managed path)", () => {
  const result = evaluatePreToolUse(multiEditPayload("CLAUDE.md"), emptyContext());
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

test("evaluatePreToolUse: NotebookEdit with no active task is blocked by no-task substantive write gate", () => {
  const result = evaluatePreToolUse(notebookEditPayload("notebooks/analysis.ipynb"), emptyContext());
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("evaluatePreToolUse: MultiEdit outside non-empty allowedWriteScope is blocked", () => {
  const ctx = contextWithScope("src/foo.ts");
  const result = evaluatePreToolUse(multiEditPayload("src/bar.ts"), ctx);
  assert.ok(result, "expected a block response");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /outside active task/i);
});

test("evaluatePreToolUse: MultiEdit inside allowedWriteScope is allowed", () => {
  const ctx = contextWithScope("src/foo.ts");
  const result = evaluatePreToolUse(multiEditPayload("src/foo.ts"), ctx);
  assert.ok(result === undefined || result.decision !== "block", "MultiEdit inside scope must be allowed");
});

// ─── GAP-7: parseRequiredReviews extended behavior ───────────────────────────

test("parseRequiredReviews: specialist-roles heading is parsed", () => {
  const md = `# Task\n\n## Required specialist roles\n\n- \`reviewer\`\n- \`qa_engineer\`\n`;
  const roles = parseRequiredReviews(md);
  assert.ok(roles.includes("reviewer"), "must include reviewer");
  assert.ok(roles.includes("qa_engineer"), "must include qa_engineer");
});

test("parseRequiredReviews: both headings are merged and deduped", () => {
  const md = `# Task\n\n## Required reviews\n\n- \`reviewer\`\n- \`qa_engineer\`\n\n## Required specialist roles\n\n- \`qa_engineer\`\n- \`security_reviewer\`\n`;
  const roles = parseRequiredReviews(md);
  assert.deepEqual(roles.sort(), ["qa_engineer", "reviewer", "security_reviewer"].sort());
});

test("parseRequiredReviews: explicit none returns empty array", () => {
  const md = `# Task\n\n## Required reviews\n\n- none\n`;
  assert.deepEqual(parseRequiredReviews(md), []);
});

test("parseRequiredReviews: none in specialist roles also returns empty array", () => {
  const md = `# Task\n\n## Required specialist roles\n\n- none\n`;
  assert.deepEqual(parseRequiredReviews(md), []);
});

test("parseRequiredReviews: prose-only section returns default trio", () => {
  const md = `# Task\n\n## Required specialist roles\n\nList the roles required to review this task.\n`;
  const roles = parseRequiredReviews(md);
  assert.deepEqual(roles.sort(), ["qa_engineer", "reviewer", "security_reviewer"].sort());
});

// ─── GAP-1: qualifiesForVerificationCert ────────────────────────────────────

test("GAP-1: tsc --version exit 0 does NOT qualify for cert", () => {
  assert.equal(qualifiesForVerificationCert("tsc --version", "TypeScript 5.4.0"), false);
});

test("GAP-1: npm test exit 0 with 0 tests does NOT qualify for cert", () => {
  const output = "# tests 0\n# pass 0\n# fail 0\n";
  assert.equal(qualifiesForVerificationCert("npm test", output), false);
});

test("GAP-1: npm test exit 0 with 190 tests and fail 0 DOES qualify for cert", () => {
  const output = "# tests 190\n# pass 190\n# fail 0\n";
  assert.equal(qualifiesForVerificationCert("npm test", output), true);
});

test("GAP-1: npx vitest run with 12 passed DOES qualify for cert", () => {
  const output = "12 passed (15)\n";
  assert.equal(qualifiesForVerificationCert("npx vitest run", output), true);
});

test("GAP-1: vitest with 0 passed does NOT qualify for cert", () => {
  const output = "0 passed (1)\n";
  assert.equal(qualifiesForVerificationCert("vitest", output), false);
});

test("GAP-1: go test ./... with ok line DOES qualify for cert", () => {
  const output = "ok  example.com/pkg  0.5s\n";
  assert.equal(qualifiesForVerificationCert("go test ./...", output), true);
});

test("GAP-1: go test ./... with empty output does NOT qualify for cert", () => {
  assert.equal(qualifiesForVerificationCert("go test ./...", ""), false);
});

test("GAP-1: tsc --noEmit exit 0 with empty output DOES qualify for cert (typecheck silence is success)", () => {
  assert.equal(qualifiesForVerificationCert("tsc --noEmit", ""), true);
});

test("GAP-1: node --experimental-strip-types scripts/check-archon-workflow.ts exit 0 DOES qualify for cert", () => {
  assert.equal(
    qualifiesForVerificationCert("node --experimental-strip-types scripts/check-archon-workflow.ts", ""),
    true
  );
});

test("GAP-1: bash scripts/check-archon-happy-path.sh exit 0 DOES qualify for cert", () => {
  assert.equal(qualifiesForVerificationCert("bash scripts/check-archon-happy-path.sh", ""), true);
});

// ─── GAP-1: evaluatePostToolUse cert-minting with output evidence ─────────────

function bashSuccessWithOutput(command: string, stdout: string) {
  return { tool_name: "Bash", tool_input: { command }, tool_response: { exitCode: 0, stdout } };
}

test("GAP-1 evaluatePostToolUse: tsc --version exit 0 does NOT write cert", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-gap1-"));
  try {
    const ctx = { ...emptyContext(), repoRoot: tmpDir, activeTaskId: "task-gap1" };
    evaluatePostToolUse(bashSuccessWithOutput("tsc --version", "TypeScript 5.4.0"), ctx);
    assert.equal(readVerificationCert(tmpDir, "task-gap1"), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-1 evaluatePostToolUse: npm test with 0 tests does NOT write cert", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-gap1-"));
  try {
    const ctx = { ...emptyContext(), repoRoot: tmpDir, activeTaskId: "task-gap1" };
    evaluatePostToolUse(bashSuccessWithOutput("npm test", "# tests 0\n# pass 0\n# fail 0\n"), ctx);
    assert.equal(readVerificationCert(tmpDir, "task-gap1"), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-1 evaluatePostToolUse: npm test with 190 tests writes cert", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-gap1-"));
  try {
    const ctx = { ...emptyContext(), repoRoot: tmpDir, activeTaskId: "task-gap1" };
    evaluatePostToolUse(bashSuccessWithOutput("npm test", "# tests 190\n# pass 190\n# fail 0\n"), ctx);
    const cert = readVerificationCert(tmpDir, "task-gap1");
    assert.ok(cert, "cert should be written");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-1 evaluatePostToolUse: failed verification command still triggers repair-loop block", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-cert-gap1-"));
  try {
    const payload = { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exitCode: 1, stderr: "failed" } };
    const ctx = { ...emptyContext(), repoRoot: tmpDir, activeTaskId: "task-gap1" };
    const result = evaluatePostToolUse(payload, ctx);
    assert.ok(result, "expected a decision from failed verification");
    assert.equal(result.decision, "block");
    assert.match(result.reason, /repair loop/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── GAP-9: verificationOptOutRejected ──────────────────────────────────────

test("GAP-9 parseTaskClass: returns undefined when section absent", () => {
  assert.equal(parseTaskClass("## Some section\n\n- item\n"), undefined);
});

test("GAP-9 parseTaskClass: returns value from ## Task class section", () => {
  assert.equal(parseTaskClass("## Task class\n\nfeature\n"), "feature");
  assert.equal(parseTaskClass("## Task class\n\n`docs_only`\n"), "docs_only");
});

test("GAP-9 verificationExemptTaskClasses contains the four exempt classes", () => {
  assert.ok(verificationExemptTaskClasses.includes("docs_only"));
  assert.ok(verificationExemptTaskClasses.includes("state_sync"));
  assert.ok(verificationExemptTaskClasses.includes("memory_curation"));
  assert.ok(verificationExemptTaskClasses.includes("scaffold_only"));
  assert.ok(!verificationExemptTaskClasses.includes("feature"));
  assert.ok(!verificationExemptTaskClasses.includes("bugfix"));
});

test("GAP-9 readActiveTaskContext: verification required false + no task class → forced true, rejected flag set", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap9-"));
  try {
    const taskId = "gap9-test";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = `# Task\n\n## Task ID\n\n\`${taskId}\`\n\n## Verification required\n\nfalse\n\n## Allowed write scope\n\n- src/\n`;
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.verificationRequired, true, "should be forced to true");
    assert.equal(ctx.verificationOptOutRejected, true, "rejected flag should be set");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-9 readActiveTaskContext: verification required false + docs_only task class → allowed (false)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap9-"));
  try {
    const taskId = "gap9-docs";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = `# Task\n\n## Task ID\n\n\`${taskId}\`\n\n## Task class\n\ndocs_only\n\n## Verification required\n\nfalse\n\n## Allowed write scope\n\n- src/\n`;
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.verificationRequired, false, "docs_only should be allowed to opt out");
    assert.equal(ctx.verificationOptOutRejected, false, "rejected flag should not be set");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-9 readActiveTaskContext: verification required false + feature task class → forced true + rejected", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap9-"));
  try {
    const taskId = "gap9-feature";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = `# Task\n\n## Task ID\n\n\`${taskId}\`\n\n## Task class\n\nfeature\n\n## Verification required\n\nfalse\n\n## Allowed write scope\n\n- src/\n`;
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.verificationRequired, true, "feature should be forced to true");
    assert.equal(ctx.verificationOptOutRejected, true, "rejected flag should be set");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-9 evaluateStop: stopReason mentions ignored opt-out when rejected flag is set", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap9",
    missingReviews: [],
    verificationRequired: true,
    verificationOptOutRejected: true,
    taskClass: "feature",
    verificationCert: undefined
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(
    result.stopReason.includes("Verification required: false"),
    `stopReason should mention the ignored opt-out: ${result.stopReason}`
  );
  assert.ok(
    result.stopReason.includes("docs_only"),
    `stopReason should name exempt task classes: ${result.stopReason}`
  );
  assert.ok(
    result.stopReason.includes('"feature"'),
    `stopReason should name the actual task class: ${result.stopReason}`
  );
});

// ─── GAP-3: extractBashWriteTargets unit tests ────────────────────────────────

test("GAP-3 extractBashWriteTargets: > redirect to src file", () => {
  const targets = extractBashWriteTargets('echo "x" > src/foo.ts', "/repo");
  assert.ok(targets.includes("src/foo.ts"), `expected src/foo.ts in ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: >> append redirect", () => {
  const targets = extractBashWriteTargets("printf 'y' >> tests/a.test.ts", "/repo");
  assert.ok(targets.includes("tests/a.test.ts"), `expected tests/a.test.ts in ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: tee target", () => {
  const targets = extractBashWriteTargets("cat src/foo.ts | tee src/file.ts", "/repo");
  assert.ok(targets.includes("src/file.ts"), `expected src/file.ts in ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: tee -a target", () => {
  const targets = extractBashWriteTargets("cat data | tee -a logs/out.log", "/repo");
  assert.ok(targets.includes("logs/out.log"), `expected logs/out.log in ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: sed -i target", () => {
  const targets = extractBashWriteTargets("sed -i 's/a/b/' src/admin.ts", "/repo");
  assert.ok(targets.includes("src/admin.ts"), `expected src/admin.ts in ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: touch paths", () => {
  const targets = extractBashWriteTargets("touch src/new.ts tests/new.test.ts", "/repo");
  assert.ok(targets.includes("src/new.ts"), `expected src/new.ts in ${JSON.stringify(targets)}`);
  assert.ok(targets.includes("tests/new.test.ts"), `expected tests/new.test.ts in ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: mkdir -p path", () => {
  const targets = extractBashWriteTargets("mkdir -p src/utils", "/repo");
  assert.ok(targets.includes("src/utils"), `expected src/utils in ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: cp — only dest tracked", () => {
  const targets = extractBashWriteTargets("cp src/foo.ts src/bar.ts", "/repo");
  assert.ok(targets.includes("src/bar.ts"), `expected src/bar.ts in ${JSON.stringify(targets)}`);
  assert.ok(!targets.includes("src/foo.ts"), "source of cp must not be a write target");
});

test("GAP-3 extractBashWriteTargets: mv — only dest tracked", () => {
  const targets = extractBashWriteTargets("mv src/old.ts src/new.ts", "/repo");
  assert.ok(targets.includes("src/new.ts"), `expected src/new.ts in ${JSON.stringify(targets)}`);
  assert.ok(!targets.includes("src/old.ts"), "source of mv must not be a write target");
});

test("GAP-3 extractBashWriteTargets: drops /dev/null", () => {
  const targets = extractBashWriteTargets("ls > /dev/null", "/repo");
  assert.deepEqual(targets, [], `expected no targets, got ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: drops /tmp/ paths", () => {
  const targets = extractBashWriteTargets("node script.js > /tmp/out.txt", "/repo");
  assert.deepEqual(targets, [], `expected no targets, got ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: drops $VAR targets", () => {
  const targets = extractBashWriteTargets("echo x > $OUTPUT_FILE", "/repo");
  assert.deepEqual(targets, [], `expected no targets for $VAR, got ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: drops absolute paths outside repo root", () => {
  const targets = extractBashWriteTargets("echo x > /other/path/file.ts", "/repo");
  assert.deepEqual(targets, [], `expected no targets for absolute outside repo, got ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: resolves absolute path inside repo root to relative", () => {
  const targets = extractBashWriteTargets("echo x > /repo/src/foo.ts", "/repo");
  assert.ok(targets.includes("src/foo.ts"), `expected src/foo.ts in ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: deduplicates repeated targets", () => {
  const targets = extractBashWriteTargets("echo a > src/foo.ts && echo b > src/foo.ts", "/repo");
  assert.equal(targets.filter((t) => t === "src/foo.ts").length, 1, "must deduplicate");
});

test("GAP-3 extractBashWriteTargets: npm install has no write targets", () => {
  const targets = extractBashWriteTargets("npm install", "/repo");
  assert.deepEqual(targets, [], `expected no targets for npm install, got ${JSON.stringify(targets)}`);
});

test("GAP-3 extractBashWriteTargets: echo hello has no write targets", () => {
  const targets = extractBashWriteTargets("echo hello", "/repo");
  assert.deepEqual(targets, [], `expected no targets for echo hello, got ${JSON.stringify(targets)}`);
});

// ─── GAP-3: evaluatePreToolUse Bash write-escape-hatch gate ──────────────────

test("GAP-3 evaluatePreToolUse: echo > src/foo.ts with no active task is blocked", () => {
  const result = evaluatePreToolUse(bashPayload('echo "x" > src/foo.ts'), emptyContext());
  assert.ok(result, "expected a block");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
  assert.ok(result.reason.includes("src/foo.ts"), `reason should name the offending path: ${result.reason}`);
});

test("GAP-3 evaluatePreToolUse: printf >> tests/a.test.ts with no active task is blocked", () => {
  const result = evaluatePreToolUse(bashPayload("printf 'y' >> tests/a.test.ts"), emptyContext());
  assert.ok(result, "expected a block");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("GAP-3 evaluatePreToolUse: tee src/file.ts with no active task is blocked", () => {
  const result = evaluatePreToolUse(bashPayload("cat data | tee src/file.ts"), emptyContext());
  assert.ok(result, "expected a block");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("GAP-3 evaluatePreToolUse: sed -i on src/admin.ts with no active task is blocked", () => {
  const result = evaluatePreToolUse(bashPayload("sed -i 's/a/b/' src/admin.ts"), emptyContext());
  assert.ok(result, "expected a block");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("GAP-3 evaluatePreToolUse: heredoc cat > docs/x.md with no active task is blocked", () => {
  const cmd = "cat > docs/x.md <<EOF\nhello world\nEOF";
  const result = evaluatePreToolUse(bashPayload(cmd), emptyContext());
  assert.ok(result, "expected a block");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("GAP-3 evaluatePreToolUse: npm install with no active task is NOT blocked (no explicit write target)", () => {
  const result = evaluatePreToolUse(bashPayload("npm install"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block", "npm install must not be blocked");
});

test("GAP-3 evaluatePreToolUse: echo hello with no active task is NOT blocked", () => {
  const result = evaluatePreToolUse(bashPayload("echo hello"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block", "echo hello must not be blocked");
});

test("GAP-3 evaluatePreToolUse: redirect to /tmp is NOT blocked", () => {
  const result = evaluatePreToolUse(bashPayload("node script.js > /tmp/out.txt"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block", "redirect to /tmp must not be blocked");
});

test("GAP-3 evaluatePreToolUse: redirect to /dev/null is NOT blocked", () => {
  const result = evaluatePreToolUse(bashPayload("ls > /dev/null"), emptyContext());
  assert.ok(result === undefined || result.decision !== "block", "redirect to /dev/null must not be blocked");
});

test("GAP-3 evaluatePreToolUse: echo x > .archon/ACTIVE is NOT blocked (bootstrap-exempt)", () => {
  const result = evaluatePreToolUse(bashPayload("echo x > .archon/ACTIVE"), emptyContext());
  // .archon/ACTIVE is not a substantive write target so should not be blocked by no-task gate
  assert.ok(result === undefined || result.decision !== "block", ".archon/ACTIVE must be bootstrap-exempt in bash gate");
});

test("GAP-3 evaluatePreToolUse: echo x > .archon/work/tasks/task-foo.md is blocked (managed path guard)", () => {
  // .archon/work/tasks/ is now a managed path — bash write is blocked without active task scope
  const result = evaluatePreToolUse(bashPayload("echo x > .archon/work/tasks/task-foo.md"), emptyContext());
  assert.ok(result, "expected a block");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

test("GAP-3 evaluatePreToolUse: active task scope — in-scope bash write is allowed", () => {
  const ctx = { ...emptyContext(), activeTaskId: "task-1", allowedWriteScope: ["src"] };
  const result = evaluatePreToolUse(bashPayload("echo x > src/ok.ts"), ctx);
  assert.ok(result === undefined || result.decision !== "block", "in-scope bash write must be allowed");
});

test("GAP-3 evaluatePreToolUse: active task scope — out-of-scope bash write is blocked", () => {
  const ctx = { ...emptyContext(), activeTaskId: "task-1", allowedWriteScope: ["src"] };
  const result = evaluatePreToolUse(bashPayload("echo x > tests/out.ts"), ctx);
  assert.ok(result, "expected a block for out-of-scope bash write");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /outside active task/i);
});

test("GAP-3 evaluatePreToolUse: active task scope — .archon/skills/ write is NOT blocked (skills exemption)", () => {
  const ctx = { ...emptyContext(), activeTaskId: "task-1", allowedWriteScope: ["src"] };
  const result = evaluatePreToolUse(bashPayload("echo x > .archon/skills/foo/SKILL.md"), ctx);
  assert.ok(result === undefined || result.decision !== "block", ".archon/skills/ must be exempt in bash scope gate");
});

// ─── GAP-5: Stop-hook hold/release hardening tests ───────────────────────────

// Helper: a cert with a passing npm test command
const PASSING_CERT = { passedCommands: [{ command: "npm run test", passedAt: "2026-01-01T00:00:00.000Z" }] };

// Context that satisfies ALL gates (reviews, runtime, verification) with docs_only class
// so the verification gate is skipped cleanly.
function allGatesSatisfiedContext() {
  return {
    ...emptyContext(),
    activeTaskId: "task-gap5",
    missingReviews: [],
    runtimeConfigured: false,
    runtimeConnected: false,
    verificationRequired: false,
    verificationCert: PASSING_CERT,
    taskClass: "docs_only",
    verificationOptOutRejected: false,
    requiredVerifications: []
  };
}

test("GAP-5: hookBlockerState present + stopHookActive true + missing review → stop still held by review gate", () => {
  const blocker = {
    activeTaskId: "task-gap5",
    summary: "some bash failed",
    blockerKind: "generic_nonzero_bash"
  };
  const ctx = {
    ...allGatesSatisfiedContext(),
    hookBlockerState: blocker,
    missingReviews: [".archon/work/reviews/review-task-gap5-reviewer.md"]
  };
  const payload = { last_assistant_message: COMPLETION_MSG, stop_hook_active: true };
  const result = evaluateStop(payload, ctx);
  assert.ok(result, "expected stop to be held by review gate even when stopHookActive is true");
  assert.equal(result.continue, false);
  assert.ok(
    result.stopReason.includes("missing required review files"),
    `expected review gate message, got: ${result?.stopReason}`
  );
});

test("GAP-5: hookBlockerState present + stopHookActive true + all gates satisfied → released", () => {
  const blocker = {
    activeTaskId: "task-gap5",
    summary: "some bash failed",
    blockerKind: "generic_nonzero_bash"
  };
  const ctx = {
    ...allGatesSatisfiedContext(),
    hookBlockerState: blocker
  };
  const payload = { last_assistant_message: COMPLETION_MSG, stop_hook_active: true };
  const result = evaluateStop(payload, ctx);
  assert.ok(result === undefined, `expected released (undefined), got: ${JSON.stringify(result)}`);
});

test("GAP-5: authorityMismatches present + stopHookActive false → held with mismatch stopReason", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap5",
    authorityMismatches: [{ kind: "active_file_conflicts_with_queue", activeFileTaskId: "task-gap5", queueCurrentTaskId: "task-other" }],
    missingReviews: []
  };
  const payload = { last_assistant_message: COMPLETION_MSG, stop_hook_active: false };
  const result = evaluateStop(payload, ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(
    result.stopReason.includes("authority mismatch"),
    `expected mismatch message, got: ${result?.stopReason}`
  );
  assert.ok(
    result.stopReason.includes("active_file_conflicts_with_queue"),
    `mismatch message should name the kind: ${result?.stopReason}`
  );
});

test("GAP-5: authorityMismatches + stopHookActive true + missing reviews → review gate fires", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap5",
    authorityMismatches: [{ kind: "active_file_conflicts_with_queue", activeFileTaskId: "task-gap5", queueCurrentTaskId: "task-other" }],
    requiredReviews: ["reviewer"],
    missingReviews: [".archon/work/reviews/review-task-gap5-reviewer.md"]
  };
  const payload = { last_assistant_message: COMPLETION_MSG, stop_hook_active: true };
  const result = evaluateStop(payload, ctx);
  assert.ok(result, "expected stop to be held by review gate even with stopHookActive true and mismatches");
  assert.equal(result.continue, false);
  assert.ok(
    result.stopReason.includes("missing required review files"),
    `expected review gate message (not mismatch message), got: ${result?.stopReason}`
  );
  assert.ok(
    !result.stopReason.includes("authority mismatch"),
    `stopReason must not be the mismatch message on second stop, got: ${result?.stopReason}`
  );
});

test("GAP-5: authorityMismatches + stopHookActive true + all gates satisfied → released", () => {
  const ctx = {
    ...allGatesSatisfiedContext(),
    authorityMismatches: [{ kind: "active_file_conflicts_with_queue", activeFileTaskId: "task-gap5", queueCurrentTaskId: "task-other" }]
  };
  const payload = { last_assistant_message: COMPLETION_MSG, stop_hook_active: true };
  const result = evaluateStop(payload, ctx);
  assert.ok(result === undefined, `expected released (undefined) when all gates satisfied, got: ${JSON.stringify(result)}`);
});

test("GAP-5: first stop with hookBlockerState still held with blocker summary", () => {
  const blocker = {
    activeTaskId: "task-gap5",
    summary: "node: command not found",
    blockerKind: "command_not_found"
  };
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap5",
    hookBlockerState: blocker,
    missingReviews: []
  };
  const payload = { last_assistant_message: COMPLETION_MSG, stop_hook_active: false };
  const result = evaluateStop(payload, ctx);
  assert.ok(result, "expected stop to be held on first call");
  assert.equal(result.continue, false);
  assert.ok(
    result.stopReason.includes("node: command not found"),
    `stopReason should be the blocker summary: ${result?.stopReason}`
  );
});

// ─── GAP-6: validateReviewArtifact unit tests ─────────────────────────────────

const REALISTIC_REVIEW = (taskId: string, role: string) =>
  `# Review — ${taskId} — ${role}\n\n## Reviewer role\n\n\`${role}\`\n\n## Task ID\n\n\`${taskId}\`\n\n## Findings\n\nNo blocking issues found. The implementation is correct and test coverage is adequate.\nAll edge cases are handled properly. The code follows the established patterns.\nSecurity review passed with no findings. Performance is acceptable.\n\n**Status: passed**\n\n## Actor\n\n\`${role}\` — scoped task self-review\n`;

test("GAP-6 validateReviewArtifact: empty file → invalid (too short)", () => {
  const result = validateReviewArtifact("", "task-x", "reviewer");
  assert.equal(result.valid, false);
  assert.match(result.reason, /too short/i);
});

test("GAP-6 validateReviewArtifact: short file → invalid (too short)", () => {
  const result = validateReviewArtifact("task-x reviewer Status: passed", "task-x", "reviewer");
  assert.equal(result.valid, false);
  assert.match(result.reason, /too short/i);
});

test("GAP-6 validateReviewArtifact: long but missing task id → invalid", () => {
  const content = "# Review\n\nreviewer " + "x".repeat(250) + "\n\n**Status: passed**\n";
  const result = validateReviewArtifact(content, "task-missing-id", "reviewer");
  assert.equal(result.valid, false);
  assert.match(result.reason, /does not reference task/i);
});

test("GAP-6 validateReviewArtifact: long, has task id but missing role → invalid", () => {
  const content = "# Review — task-x\n\n" + "x".repeat(250) + "\n\n**Status: passed**\n";
  const result = validateReviewArtifact(content, "task-x", "qa_engineer");
  assert.equal(result.valid, false);
  assert.match(result.reason, /does not reference role/i);
});

test("GAP-6 validateReviewArtifact: has task id + role but no status line → invalid", () => {
  const content = "# Review — task-x — reviewer\n\nreviewer task-x " + "x".repeat(250) + "\n";
  const result = validateReviewArtifact(content, "task-x", "reviewer");
  assert.equal(result.valid, false);
  assert.match(result.reason, /missing a passed\/approved status line/i);
});

test("GAP-6 validateReviewArtifact: realistic artifact with **Status: passed** → valid", () => {
  const content = REALISTIC_REVIEW("task-x", "reviewer");
  const result = validateReviewArtifact(content, "task-x", "reviewer");
  assert.equal(result.valid, true);
  assert.equal(result.reason, undefined);
});

test("GAP-6 validateReviewArtifact: verdict approved → valid", () => {
  const content = "# Review — task-y — security_reviewer\n\nsecurity_reviewer task-y " + "x".repeat(200) + "\n\n**Verdict: approved**\n";
  const result = validateReviewArtifact(content, "task-y", "security_reviewer");
  assert.equal(result.valid, true);
});

test("GAP-6 validateReviewArtifact: outcome = pass → valid", () => {
  const content = "# Review — task-z — qa_engineer\n\nqa_engineer task-z " + "x".repeat(200) + "\n\noutcome: pass\n";
  const result = validateReviewArtifact(content, "task-z", "qa_engineer");
  assert.equal(result.valid, true);
});

// ─── GAP-6: readActiveTaskContext invalidReviews ──────────────────────────────

test("GAP-6 readActiveTaskContext: all valid reviews → invalidReviews empty", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap6-"));
  try {
    const taskId = "gap6-valid";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "reviews"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = `# Task\n\n## Task ID\n\n\`${taskId}\`\n\n## Required reviews\n\n- reviewer\n- qa_engineer\n\n## Allowed write scope\n\n- src/\n`;
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    // Write valid review files
    for (const role of ["reviewer", "qa_engineer"]) {
      fs.writeFileSync(
        path.join(tmpDir, ".archon", "work", "reviews", `review-${taskId}-${role}.md`),
        REALISTIC_REVIEW(taskId, role)
      );
    }
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.deepEqual(ctx.invalidReviews, [], `invalidReviews should be empty, got: ${JSON.stringify(ctx.invalidReviews)}`);
    assert.deepEqual(ctx.missingReviews, [], "missingReviews should be empty");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-6 readActiveTaskContext: empty review file → invalidReviews populated", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap6-"));
  try {
    const taskId = "gap6-empty";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "reviews"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = `# Task\n\n## Task ID\n\n\`${taskId}\`\n\n## Required reviews\n\n- reviewer\n\n## Allowed write scope\n\n- src/\n`;
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    // Write empty review file
    fs.writeFileSync(
      path.join(tmpDir, ".archon", "work", "reviews", `review-${taskId}-reviewer.md`),
      ""
    );
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.invalidReviews.length, 1, "should have one invalid review");
    assert.ok(ctx.invalidReviews[0].includes(".archon/work/reviews/"), "should name the file path");
    assert.ok(ctx.invalidReviews[0].includes("too short"), "should give reason");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-6 readActiveTaskContext: review missing task id → invalidReviews populated", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap6-"));
  try {
    const taskId = "gap6-no-taskid";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "reviews"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = `# Task\n\n## Task ID\n\n\`${taskId}\`\n\n## Required reviews\n\n- reviewer\n\n## Allowed write scope\n\n- src/\n`;
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    // Review without the task id
    const badContent = "# Review\n\nreviewer " + "x".repeat(250) + "\n\n**Status: passed**\n";
    fs.writeFileSync(
      path.join(tmpDir, ".archon", "work", "reviews", `review-${taskId}-reviewer.md`),
      badContent
    );
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.invalidReviews.length, 1);
    assert.ok(ctx.invalidReviews[0].includes("does not reference task"), "should give task-id reason");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-6 readActiveTaskContext: review missing status line → invalidReviews populated", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap6-"));
  try {
    const taskId = "gap6-no-status";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "reviews"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = `# Task\n\n## Task ID\n\n\`${taskId}\`\n\n## Required reviews\n\n- reviewer\n\n## Allowed write scope\n\n- src/\n`;
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    // Review without status line
    const badContent = `# Review — ${taskId} — reviewer\n\nreviewer ${taskId} ` + "x".repeat(200) + "\n";
    fs.writeFileSync(
      path.join(tmpDir, ".archon", "work", "reviews", `review-${taskId}-reviewer.md`),
      badContent
    );
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.invalidReviews.length, 1);
    assert.ok(ctx.invalidReviews[0].includes("missing a passed/approved status line"), "should give status-line reason");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── GAP-6: evaluateStop invalid reviews gate ────────────────────────────────

test("GAP-6 evaluateStop: completion signal + invalidReviews → stop held naming file and reason", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap6",
    missingReviews: [],
    invalidReviews: [".archon/work/reviews/review-task-gap6-reviewer.md (missing a passed/approved status line)"]
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(result.stopReason.includes("fail content validation"), `stopReason: ${result.stopReason}`);
  assert.ok(result.stopReason.includes(".archon/work/reviews/review-task-gap6-reviewer.md"), "should name the file");
  assert.ok(result.stopReason.includes("missing a passed/approved status line"), "should name the reason");
});

test("GAP-6 evaluateStop: no active task + invalidReviews → gate does not fire", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: undefined,
    missingReviews: [],
    invalidReviews: [".archon/work/reviews/review-task-gap6-reviewer.md (too short)"]
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByInvalid =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("fail content validation");
  assert.ok(!heldByInvalid, "invalid reviews gate must not fire without an active task");
});

test("GAP-6 evaluateStop: mid-task + invalidReviews → shouldHoldStop drives, not invalid-reviews gate", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap6",
    missingReviews: [],
    invalidReviews: [".archon/work/reviews/review-task-gap6-reviewer.md (too short)"]
  };
  // Empty message → shouldHoldStop → review content gate must NOT fire
  const result = evaluateStop(stopPayload(""), ctx);
  assert.ok(result, "expected stop to be held by shouldHoldStop");
  assert.ok(
    !result.stopReason.includes("fail content validation"),
    "invalid reviews gate must not fire mid-task"
  );
});

test("GAP-6 evaluateStop: all reviews valid → invalidReviews gate silent", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap6",
    missingReviews: [],
    invalidReviews: []
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByInvalid =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("fail content validation");
  assert.ok(!heldByInvalid, "invalid reviews gate must be silent when invalidReviews is empty");
});

// ─── GAP-8: parseCouncilReview unit tests ────────────────────────────────────

function councilSection(required: string, outcome: string) {
  return `## Council review\n\nSome prose.\n\n### Required\n\n\`${required}\`\n\n### Trigger rationale\n\nSome rationale.\n\n### Outcome\n\n\`${outcome}\`\n\n## Next section\n`;
}

test("GAP-8 parseCouncilReview: parses required=true and outcome=approved", () => {
  const result = parseCouncilReview(councilSection("true", "approved"));
  assert.equal(result.required, "true");
  assert.equal(result.outcome, "approved");
});

test("GAP-8 parseCouncilReview: parses required=false and outcome=pending", () => {
  const result = parseCouncilReview(councilSection("false", "pending"));
  assert.equal(result.required, "false");
  assert.equal(result.outcome, "pending");
});

test("GAP-8 parseCouncilReview: parses required=inherited and outcome=inherited", () => {
  const result = parseCouncilReview(councilSection("inherited", "inherited"));
  assert.equal(result.required, "inherited");
  assert.equal(result.outcome, "inherited");
});

test("GAP-8 parseCouncilReview: returns undefined fields when section absent", () => {
  const result = parseCouncilReview("## Some other section\n\n- item\n");
  assert.equal(result.required, undefined);
  assert.equal(result.outcome, undefined);
});

test("GAP-8 parseCouncilReview: ignores instructional prose in Required sub-section", () => {
  const md = `## Council review\n\n### Required\n\ntrue | false | inherited\n\n### Outcome\n\napproved\n\n## Next\n`;
  const result = parseCouncilReview(md);
  // "true | false | inherited" is instructional — not a known token; should be ignored
  assert.equal(result.required, undefined);
  assert.equal(result.outcome, "approved");
});

test("GAP-8 parseCouncilReview: ignores instructional prose in Outcome sub-section", () => {
  const md = `## Council review\n\n### Required\n\ntrue\n\n### Outcome\n\npending | approved | approved_with_conditions | rework_required | exception_granted | rejected | inherited\n\n## Next\n`;
  const result = parseCouncilReview(md);
  assert.equal(result.required, "true");
  // The compound "pending | approved | ..." is not a known single token; should be ignored
  assert.equal(result.outcome, undefined);
});

test("GAP-8 parseCouncilReview: quality-gates council_review_required forces councilRequired true", async () => {
  // This tests the readActiveTaskContext integration; we test the quality-gate detection separately here
  const md = `## Quality gates\n\n- council_review_required\n\n## Council review\n\n### Required\n\nfalse\n\n### Outcome\n\napproved\n\n## Next\n`;
  // parseCouncilReview itself only parses the section; the quality-gate logic is in readActiveTaskContext
  // Test that the section parser correctly returns false for Required
  const result = parseCouncilReview(md);
  assert.equal(result.required, "false");
  assert.equal(result.outcome, "approved");
});

test("GAP-8 parseCouncilReview: backtick-wrapped values are accepted", () => {
  const md = `## Council review\n\n### Required\n\n\`true\`\n\n### Outcome\n\n\`approved_with_conditions\`\n\n## Next\n`;
  const result = parseCouncilReview(md);
  assert.equal(result.required, "true");
  assert.equal(result.outcome, "approved_with_conditions");
});

// ─── GAP-8: readActiveTaskContext council fields ──────────────────────────────

test("GAP-8 readActiveTaskContext: council required=true + outcome=approved → councilRequired true, councilOutcome approved", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap8-"));
  try {
    const taskId = "gap8-approved";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = [
      `# Task`,
      ``,
      `## Task ID`,
      ``,
      `\`${taskId}\``,
      ``,
      `## Required reviews`,
      ``,
      `- none`,
      ``,
      `## Council review`,
      ``,
      `### Required`,
      ``,
      `\`true\``,
      ``,
      `### Outcome`,
      ``,
      `\`approved\``,
      ``,
      `## Allowed write scope`,
      ``,
      `- src/`,
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.councilRequired, true, "councilRequired should be true");
    assert.equal(ctx.councilOutcome, "approved", "councilOutcome should be approved");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-8 readActiveTaskContext: quality-gates council_review_required → councilRequired true", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap8-"));
  try {
    const taskId = "gap8-gate";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = [
      `# Task`,
      ``,
      `## Task ID`,
      ``,
      `\`${taskId}\``,
      ``,
      `## Required reviews`,
      ``,
      `- none`,
      ``,
      `## Quality gates`,
      ``,
      `- council_review_required`,
      ``,
      `## Council review`,
      ``,
      `### Required`,
      ``,
      `\`false\``,
      ``,
      `### Outcome`,
      ``,
      `\`approved\``,
      ``,
      `## Allowed write scope`,
      ``,
      `- src/`,
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.councilRequired, true, "quality gate forces councilRequired true");
    assert.equal(ctx.councilOutcome, "approved");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GAP-8 readActiveTaskContext: council section absent → councilRequired false", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap8-"));
  try {
    const taskId = "gap8-absent";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = `# Task\n\n## Task ID\n\n\`${taskId}\`\n\n## Required reviews\n\n- none\n\n## Allowed write scope\n\n- src/\n`;
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.councilRequired, false, "should default to false when no council section");
    assert.equal(ctx.councilOutcome, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Mirror of the live active packet: audit-hardening declares Required=true Outcome=approved
test("GAP-8 readActiveTaskContext: audit-hardening-like packet (required=true, outcome=approved) → councilRequired true, outcome satisfied", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-gap8-"));
  try {
    const taskId = "audit-hardening-mirror";
    fs.mkdirSync(path.join(tmpDir, ".archon", "work", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archon", "ACTIVE"), `task_id=${taskId}\nstate=active\n`);
    const taskMd = [
      `# Task Packet — ${taskId}`,
      ``,
      `## Task ID`,
      ``,
      `\`${taskId}\``,
      ``,
      `## Required reviews`,
      ``,
      `- none`,
      ``,
      `## Quality gates`,
      ``,
      `- regression_safety_required`,
      `- council_review_required`,
      ``,
      `## Council review`,
      ``,
      `### Required`,
      ``,
      `\`true\``,
      ``,
      `### Trigger rationale`,
      ``,
      `Architecture-significant change, mandated by operator after audit.`,
      ``,
      `### Dissent owner`,
      ``,
      `security_reviewer`,
      ``,
      `### Outcome`,
      ``,
      `\`approved\``,
      ``,
      `### Exception expiry`,
      ``,
      `none`,
      ``,
      `## Allowed write scope`,
      ``,
      `- src/`,
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, ".archon", "work", "tasks", `task-${taskId}.md`), taskMd);
    const ctx = await readActiveTaskContext({ repoRoot: tmpDir });
    assert.equal(ctx.councilRequired, true, "should be required");
    assert.equal(ctx.councilOutcome, "approved", "outcome should be approved");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── GAP-8: evaluateStop council gate ────────────────────────────────────────

test("GAP-8 evaluateStop: councilRequired true + outcome pending → stop held", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    councilRequired: true,
    councilOutcome: "pending"
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(result.stopReason.includes("Design and Architecture Council review"), `stopReason: ${result.stopReason}`);
  assert.ok(result.stopReason.includes('"pending"'), `stopReason should name the outcome: ${result.stopReason}`);
});

test("GAP-8 evaluateStop: councilRequired true + outcome undefined → stop held", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    councilRequired: true,
    councilOutcome: undefined
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(result.stopReason.includes("Design and Architecture Council review"));
  assert.ok(result.stopReason.includes('"unset"'), `should say unset: ${result.stopReason}`);
});

test("GAP-8 evaluateStop: councilRequired true + outcome rework_required → stop held", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    councilRequired: true,
    councilOutcome: "rework_required"
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  assert.ok(result, "expected stop to be held");
  assert.equal(result.continue, false);
  assert.ok(result.stopReason.includes("Design and Architecture Council review"));
});

test("GAP-8 evaluateStop: councilRequired true + outcome approved → gate silent (falls through)", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    councilRequired: true,
    councilOutcome: "approved",
    verificationRequired: false
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByCouncil =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("Design and Architecture Council review");
  assert.ok(!heldByCouncil, "council gate must be silent when outcome is approved");
});

test("GAP-8 evaluateStop: councilRequired true + outcome approved_with_conditions → gate silent", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    councilRequired: true,
    councilOutcome: "approved_with_conditions",
    verificationRequired: false
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByCouncil =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("Design and Architecture Council review");
  assert.ok(!heldByCouncil, "approved_with_conditions is approved-class");
});

test("GAP-8 evaluateStop: councilRequired true + outcome exception_granted → gate silent", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    councilRequired: true,
    councilOutcome: "exception_granted",
    verificationRequired: false
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByCouncil =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("Design and Architecture Council review");
  assert.ok(!heldByCouncil, "exception_granted is approved-class");
});

test("GAP-8 evaluateStop: councilRequired true + outcome inherited → gate silent", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    councilRequired: true,
    councilOutcome: "inherited",
    verificationRequired: false
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByCouncil =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("Design and Architecture Council review");
  assert.ok(!heldByCouncil, "inherited is approved-class");
});

test("GAP-8 evaluateStop: councilRequired false → gate silent regardless of outcome", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    councilRequired: false,
    councilOutcome: "pending",
    verificationRequired: false
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByCouncil =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("Design and Architecture Council review");
  assert.ok(!heldByCouncil, "council gate must not fire when councilRequired is false");
});

test("GAP-8 evaluateStop: no active task + councilRequired true → gate does not fire", () => {
  const ctx = {
    ...emptyContext(),
    activeTaskId: undefined,
    missingReviews: [],
    invalidReviews: [],
    councilRequired: true,
    councilOutcome: "pending"
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByCouncil =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("Design and Architecture Council review");
  assert.ok(!heldByCouncil, "council gate must not fire without an active task");
});

test("GAP-8 evaluateStop: existing emptyContext contexts (no councilRequired) still pass through", () => {
  // Existing tests use emptyContext() which has no councilRequired field;
  // ensure missing/undefined councilRequired does not trigger the gate
  const ctx = {
    ...emptyContext(),
    activeTaskId: "task-gap8",
    missingReviews: [],
    invalidReviews: [],
    verificationRequired: false
    // no councilRequired set
  };
  const result = evaluateStop(stopPayload(COMPLETION_MSG), ctx);
  const heldByCouncil =
    result !== undefined &&
    result.continue === false &&
    typeof result.stopReason === "string" &&
    result.stopReason.includes("Design and Architecture Council review");
  assert.ok(!heldByCouncil, "missing councilRequired must not trigger gate");
});

// ─── FIX2: extractBashWriteTargets arrow-function and comparison false-positive fixes ───

test("FIX2 extractBashWriteTargets: arrow function => is not a redirect", () => {
  const targets = extractBashWriteTargets("node -e 'arr.forEach(x => console.log(x))'", "/repo");
  assert.deepEqual(targets, [], `expected empty, got ${JSON.stringify(targets)}`);
});

test("FIX2 extractBashWriteTargets: process.stdout.write is not a redirect", () => {
  const targets = extractBashWriteTargets("node -e 'process.stdout.write(\"x\")'", "/repo");
  assert.deepEqual(targets, [], `expected empty, got ${JSON.stringify(targets)}`);
});

test("FIX2 extractBashWriteTargets: real > redirect is still detected", () => {
  const targets = extractBashWriteTargets("echo x > out.txt", "/repo");
  assert.ok(targets.includes("out.txt"), `expected out.txt in ${JSON.stringify(targets)}`);
});

test("FIX2 extractBashWriteTargets: >= comparison is not a redirect", () => {
  const targets = extractBashWriteTargets('echo "x >= 1"', "/repo");
  assert.deepEqual(targets, [], `expected empty for comparison, got ${JSON.stringify(targets)}`);
});

test("FIX2 extractBashWriteTargets: => in quoted arg is not a redirect", () => {
  const targets = extractBashWriteTargets('echo "x => y"', "/repo");
  assert.deepEqual(targets, [], `expected empty for arrow in quotes, got ${JSON.stringify(targets)}`);
});

// ─── FIX2: evaluatePreToolUse Write to absolute path outside repo is not blocked by scope gate ───

test("FIX2 evaluatePreToolUse: Write to /tmp/foo.txt with active task and narrow scope is NOT blocked", () => {
  const ctx = {
    ...emptyContext(),
    repoRoot: "/repo",
    activeTaskId: "task-1",
    allowedWriteScope: ["src"]
  };
  const result = evaluatePreToolUse({ tool_name: "Write", tool_input: { file_path: "/tmp/foo.txt" } }, ctx);
  assert.ok(result === undefined || result.decision !== "block", "absolute path outside repo must not be blocked by scope gate");
});

// ─── FIX2: evaluatePreToolUse Bash with redirect to absolute outside repo is NOT blocked ───

test("FIX2 evaluatePreToolUse: echo x > /tmp/foo.txt with active task and narrow scope is NOT blocked", () => {
  const ctx = {
    ...emptyContext(),
    repoRoot: "/repo",
    activeTaskId: "task-1",
    allowedWriteScope: ["src"]
  };
  const result = evaluatePreToolUse(bashPayload("echo x > /tmp/foo.txt"), ctx);
  assert.ok(result === undefined || result.decision !== "block", "bash redirect to outside-repo absolute must not be blocked by scope gate");
});

// ─── hookScopeNarrowing Fix 1: no-task gate must NOT block outside-repo writes ──

test("Fix1: Write to /tmp/z.txt with NO active task is NOT blocked (outside repo)", () => {
  // No task active; the path is not inside the repo root. The no-task write gate
  // must not fire for paths outside the repo. The scope gate also must not fire.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "/tmp/z.txt" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `Write to /tmp outside repo with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("Fix1: Write to /home/eimi/.claude/projects/x/memory/y.md with NO active task is NOT blocked (outside repo)", () => {
  // Global Claude project memory is outside the repo root — archon must not own it.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "/home/eimi/.claude/projects/x/memory/y.md" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `Write to global .claude/projects outside repo with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("Fix1: Write to repo-relative src/index.ts with NO active task is STILL blocked (in-repo)", () => {
  // In-repo write must still be blocked by the no-task gate even after fix.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(writePayload("src/index.ts"), ctx);
  assert.ok(result, "expected a block for in-repo write with no task");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("Fix1: Write to .claude/settings.json with NO active task is STILL blocked (managed path)", () => {
  // Managed control-layer path — blocked by managed-path gate before no-task gate.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(writePayload(".claude/settings.json"), ctx);
  assert.ok(result, "expected a block for managed path write with no task");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

test("Fix1: Write to /repo/src/foo.ts (absolute, inside repo) with NO active task is STILL blocked", () => {
  // Absolute path inside the repo root strips to src/foo.ts → in-repo → still blocked.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "/repo/src/foo.ts" } },
    ctx
  );
  assert.ok(result, "expected a block for absolute-inside-repo write with no task");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("Fix1: Edit to /tmp/scratch.ts with NO active task is NOT blocked (outside repo)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "Edit", tool_input: { file_path: "/tmp/scratch.ts" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `Edit to /tmp with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

// ─── hookScopeNarrowing Fix 2: extractBashReferencedManagedPaths must not over-match ──

// Import extractBashReferencedManagedPaths — it is exported from hook-utils.mjs
const { extractBashReferencedManagedPaths } = await import(`${hooksDir}/hook-utils.mjs`);

test("Fix2 extractBashReferencedManagedPaths: grep pattern .claude in single-quoted string is NOT flagged", () => {
  // grep -rn '\.claude' . — the path appears only inside a single-quoted argument
  const matches = extractBashReferencedManagedPaths("grep -rn '\\.claude' .");
  assert.deepEqual(matches, [], `expected no matches for grep pattern in single-quoted arg, got: ${JSON.stringify(matches)}`);
});

test("Fix2 extractBashReferencedManagedPaths: grep pattern claude in double-quoted string is NOT flagged", () => {
  // grep -rn "claude|managed" . — mentions "claude" only inside a quoted string
  const matches = extractBashReferencedManagedPaths('grep -rn "claude|managed" .');
  assert.deepEqual(matches, [], `expected no matches for grep pattern in double-quoted arg, got: ${JSON.stringify(matches)}`);
});

test("Fix2 extractBashReferencedManagedPaths: reference to ~/.claude/ (absolute outside repo) is NOT flagged", () => {
  // cp ~/.claude/settings.json /tmp/backup.json — source is outside the repo.
  // The managed path appears as a suffix of an absolute path (preceded by "/").
  const matches = extractBashReferencedManagedPaths("cp ~/.claude/settings.json /tmp/backup.json");
  assert.deepEqual(matches, [], `expected no matches for ~/.claude/ reference, got: ${JSON.stringify(matches)}`);
});

test("Fix2 extractBashReferencedManagedPaths: ls .claude/agents (unquoted, repo-relative) IS flagged", () => {
  // ls .claude/agents — unquoted repo-relative managed path; should still be flagged
  const matches = extractBashReferencedManagedPaths("ls .claude/agents");
  assert.ok(matches.includes(".claude"), `expected .claude to be flagged, got: ${JSON.stringify(matches)}`);
});

test("Fix2 extractBashReferencedManagedPaths: echo x > .claude/settings.json IS flagged", () => {
  // Write redirect to in-repo managed path — must still be flagged
  const matches = extractBashReferencedManagedPaths("echo x > .claude/settings.json");
  assert.ok(matches.includes(".claude"), `expected .claude to be flagged for write redirect, got: ${JSON.stringify(matches)}`);
});

test("Fix2 extractBashReferencedManagedPaths: CLAUDE.md in double-quoted string is NOT flagged", () => {
  // grep -rn "CLAUDE.md" . — managed path appears only inside double-quoted pattern
  const matches = extractBashReferencedManagedPaths('grep -rn "CLAUDE.md" .');
  assert.deepEqual(matches, [], `expected no matches for CLAUDE.md in double-quoted pattern, got: ${JSON.stringify(matches)}`);
});

test("Fix2 extractBashReferencedManagedPaths: unquoted CLAUDE.md IS flagged", () => {
  // cat CLAUDE.md — unquoted reference; still flagged
  const matches = extractBashReferencedManagedPaths("cat CLAUDE.md");
  assert.ok(matches.includes("CLAUDE.md"), `expected CLAUDE.md to be flagged, got: ${JSON.stringify(matches)}`);
});

test("Fix2 evaluatePreToolUse: grep referencing .claude in quoted pattern with no active task is NOT blocked", () => {
  // The quoted grep pattern should not trigger the managed-path gate
  const result = evaluatePreToolUse(
    bashPayload("grep -rn '\\.claude' ."),
    emptyContext()
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `grep .claude in quoted pattern with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("Fix2 evaluatePreToolUse: ls .claude/agents && echo done with no active task is NOT blocked (read-only compound)", () => {
  // ls .claude/agents is read-only; echo is read-only. isReadOnlyBashCommand must return true
  // for the compound command. extractBashReferencedManagedPaths flags .claude, but since the
  // whole command is read-only, the managed-path gate must not fire.
  const result = evaluatePreToolUse(
    bashPayload("ls .claude/agents && echo done"),
    emptyContext()
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `read-only ls .claude/agents && echo done with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("Fix2 evaluatePreToolUse: echo x > .claude/settings.json with no active task is STILL blocked", () => {
  // Actual write to .claude/ — must still be blocked
  const result = evaluatePreToolUse(
    bashPayload("echo x > .claude/settings.json"),
    emptyContext()
  );
  assert.ok(result, "expected a block for write to .claude/");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

test("Fix2 evaluatePreToolUse: cp ~/.claude/settings.json /tmp/backup.json with no active task is NOT blocked", () => {
  // Source is outside-repo absolute path; destination is /tmp/. Neither is in-repo managed.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    bashPayload("cp ~/.claude/settings.json /tmp/backup.json"),
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `cp from ~/.claude/ to /tmp/ with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("Fix2 evaluatePreToolUse: .archon/memory/ write without scope is STILL blocked (managed path)", () => {
  // In-repo managed path — must still be blocked regardless of new fixes
  const result = evaluatePreToolUse(
    writePayload(".archon/memory/facts.md"),
    emptyContext()
  );
  assert.ok(result, "expected a block for .archon/memory/ write with no scope");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /requires an active archon task/i);
});

// ─── hookOutsideRepoCanonicalize: double-slash bypass closed ─────────────────

test("canonicalize: Write to /repo//src/foo.ts (double-slash) with NO active task is BLOCKED (in-repo)", () => {
  // Crafted double-slash path that the old startsWith("/") heuristic misclassified
  // as outside-repo. After canonicalization via path.resolve it resolves to
  // /repo/src/foo.ts → inside repo → must be gated by the no-task write gate.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "/repo//src/foo.ts" } },
    ctx
  );
  assert.ok(result, "double-slash crafted in-repo write must be blocked without a task");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("canonicalize: Edit to /repo//src/foo.ts (double-slash) with NO active task is BLOCKED (in-repo)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "Edit", tool_input: { file_path: "/repo//src/foo.ts" } },
    ctx
  );
  assert.ok(result, "double-slash crafted in-repo Edit must be blocked without a task");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("canonicalize: MultiEdit to /repo//src/foo.ts (double-slash) with NO active task is BLOCKED (in-repo)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "MultiEdit", tool_input: { file_path: "/repo//src/foo.ts" } },
    ctx
  );
  assert.ok(result, "double-slash crafted in-repo MultiEdit must be blocked without a task");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("canonicalize: NotebookEdit to /repo//notebooks/a.ipynb (double-slash) with NO active task is BLOCKED (in-repo)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo//notebooks/a.ipynb" } },
    ctx
  );
  assert.ok(result, "double-slash crafted in-repo NotebookEdit must be blocked without a task");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("canonicalize: Write to /repo//src/foo.ts with active task + narrow scope is BLOCKED by scope gate (in-repo)", () => {
  // The double-slash path resolves to an in-repo write; scope gate must apply.
  const ctx = { ...emptyContext(), repoRoot: "/repo", activeTaskId: "task-1", allowedWriteScope: ["tests"] };
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "/repo//src/foo.ts" } },
    ctx
  );
  assert.ok(result, "double-slash in-repo write must be blocked by scope gate");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /outside active task/i);
});

test("canonicalize: Write to /repo/../repo/.claude/agents/x.md (dot-dot bypass) with NO active task is BLOCKED (in-repo)", () => {
  // Path traversal that resolves to inside the repo — must be treated as in-repo.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "/repo/../repo/.claude/agents/x.md" } },
    ctx
  );
  assert.ok(result, "dot-dot traversal to in-repo managed path must be blocked");
  assert.equal(result.decision, "block");
});

test("canonicalize: Write to /repo/../repo/src/foo.ts (dot-dot) with active task + narrow scope is BLOCKED by scope gate (in-repo)", () => {
  // Dot-dot traversal resolving to a non-managed in-repo path must still hit the
  // scope gate (not the managed-path early-exit). Asserts the canonical in-repo
  // classification feeds the active-task scope gate, not just the no-task gate.
  const ctx = { ...emptyContext(), repoRoot: "/repo", activeTaskId: "task-1", allowedWriteScope: ["tests"] };
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "/repo/../repo/src/foo.ts" } },
    ctx
  );
  assert.ok(result, "dot-dot in-repo write must be blocked by scope gate");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /outside active task/i);
});

test("canonicalize: Write to /repo//.claude/agents/x.md (double-slash) hits the MANAGED-PATH gate", () => {
  // Before the toRelativePath canonicalization fix, the double-slash left filePath
  // as "/.claude/agents/x.md" (leading slash), so isManagedPath missed it and the
  // managed-path gate was bypassed (the no-task gate caught it with a generic
  // reason). Now the path normalizes to ".claude/agents/x.md" and the dedicated
  // managed-path gate fires with its specific reason — even with an active task
  // whose scope does NOT cover the control layer.
  const ctx = { ...emptyContext(), repoRoot: "/repo", activeTaskId: "task-1", allowedWriteScope: ["src"] };
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "/repo//.claude/agents/x.md" } },
    ctx
  );
  assert.ok(result, "double-slash crafted managed path must hit the managed-path gate");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /managed control-layer file/i);
  assert.match(result.reason, /\.claude\/agents\/x\.md/);
});

// ─── hookOutsideRepoCanonicalize: #20 coverage gap — MultiEdit/NotebookEdit outside-repo ──

test("canonicalize: MultiEdit to /tmp/z.txt with NO active task is NOT blocked (outside repo)", () => {
  // Outside-repo MultiEdit — the no-task gate must be skipped for paths outside repoRoot.
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "MultiEdit", tool_input: { file_path: "/tmp/z.txt" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `MultiEdit to /tmp with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("canonicalize: NotebookEdit to /tmp/scratch.ipynb with NO active task is NOT blocked (outside repo)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "NotebookEdit", tool_input: { notebook_path: "/tmp/scratch.ipynb" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `NotebookEdit to /tmp with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("canonicalize: MultiEdit to /home/eimi/.claude/projects/x/memory/y.md with NO active task is NOT blocked (outside repo)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "MultiEdit", tool_input: { file_path: "/home/eimi/.claude/projects/x/memory/y.md" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `MultiEdit to global .claude/projects outside repo with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("canonicalize: NotebookEdit to /home/eimi/.claude/projects/x/memory/y.md with NO active task is NOT blocked (outside repo)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "NotebookEdit", tool_input: { notebook_path: "/home/eimi/.claude/projects/x/memory/y.md" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `NotebookEdit to global .claude/projects outside repo with no task must NOT be blocked; got: ${JSON.stringify(result)}`
  );
});

test("canonicalize: MultiEdit to /tmp/z.txt with active task + narrow scope is NOT blocked by scope gate (outside repo)", () => {
  // Outside-repo path: scope gate must be skipped even when a task is active with narrow scope.
  const ctx = { ...emptyContext(), repoRoot: "/repo", activeTaskId: "task-1", allowedWriteScope: ["src"] };
  const result = evaluatePreToolUse(
    { tool_name: "MultiEdit", tool_input: { file_path: "/tmp/z.txt" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `MultiEdit to /tmp with active task + narrow scope must NOT be blocked by scope gate; got: ${JSON.stringify(result)}`
  );
});

test("canonicalize: NotebookEdit to /tmp/scratch.ipynb with active task + narrow scope is NOT blocked by scope gate (outside repo)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo", activeTaskId: "task-1", allowedWriteScope: ["src"] };
  const result = evaluatePreToolUse(
    { tool_name: "NotebookEdit", tool_input: { notebook_path: "/tmp/scratch.ipynb" } },
    ctx
  );
  assert.ok(
    result === undefined || result.decision !== "block",
    `NotebookEdit to /tmp with active task + narrow scope must NOT be blocked by scope gate; got: ${JSON.stringify(result)}`
  );
});

test("canonicalize: MultiEdit to src/foo.ts (in-repo) with NO active task is STILL blocked (no-task gate)", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo" };
  const result = evaluatePreToolUse(
    { tool_name: "MultiEdit", tool_input: { file_path: "src/foo.ts" } },
    ctx
  );
  assert.ok(result, "MultiEdit to in-repo path with no task must be blocked");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /no active archon task/i);
});

test("canonicalize: NotebookEdit to notebooks/a.ipynb (in-repo) with active task + narrow scope is BLOCKED by scope gate", () => {
  const ctx = { ...emptyContext(), repoRoot: "/repo", activeTaskId: "task-1", allowedWriteScope: ["src"] };
  const result = evaluatePreToolUse(
    { tool_name: "NotebookEdit", tool_input: { notebook_path: "notebooks/a.ipynb" } },
    ctx
  );
  assert.ok(result, "NotebookEdit to out-of-scope in-repo path must be blocked by scope gate");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /outside active task/i);
});

// ─── F1: context-guard handoff-safe tool list ─────────────────────────────────
// These tests assert that evaluatePreToolUse allows MCP handoff tools when the
// context-guard state is handoff_required or hard_stop, closing the deadlock where
// the agent was told to commit a handoff but was simultaneously blocked from doing so.
//
// The guard state is injected via a temp file written to a fresh tmpDir each test
// so the tests are isolated and do not require a running DB.

import * as fsSync from "node:fs";

function writeTmpGuardState(tmpDir: string, state: string): void {
  const guardDir = `${tmpDir}/.archon/work`;
  fsSync.mkdirSync(guardDir, { recursive: true });
  fsSync.writeFileSync(
    `${guardDir}/context-guard.json`,
    JSON.stringify({ invocationId: "test-inv", state, contextPct: 75, updatedAt: new Date().toISOString() }),
    "utf8"
  );
}

function ctxWithGuard(tmpDir: string) {
  return { ...emptyContext(), repoRoot: tmpDir };
}

function mcpToolPayload(toolName: string) {
  return { tool_name: toolName, tool_input: {} };
}

test("F1: handoff_required state ALLOWS archon_handoff_commit (bare name)", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(mcpToolPayload("archon_handoff_commit"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `archon_handoff_commit must not be blocked in handoff_required; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: handoff_required state ALLOWS mcp__archon__archon_handoff_commit (prefixed name)", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(mcpToolPayload("mcp__archon__archon_handoff_commit"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `mcp__archon__archon_handoff_commit must not be blocked in handoff_required; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: handoff_required state ALLOWS archon_handoff_prepare", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(mcpToolPayload("archon_handoff_prepare"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `archon_handoff_prepare must not be blocked in handoff_required; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: handoff_required state ALLOWS mcp__archon__archon_handoff_prepare", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(mcpToolPayload("mcp__archon__archon_handoff_prepare"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `mcp__archon__archon_handoff_prepare must not be blocked; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: handoff_required state ALLOWS archon_context_sample", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(mcpToolPayload("archon_context_sample"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `archon_context_sample must not be blocked; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: handoff_required state ALLOWS archon_next_action", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(mcpToolPayload("archon_next_action"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `archon_next_action must not be blocked; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: handoff_required state ALLOWS TodoWrite", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(mcpToolPayload("TodoWrite"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `TodoWrite must not be blocked in handoff_required; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: handoff_required state ALLOWS TodoRead", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(mcpToolPayload("TodoRead"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `TodoRead must not be blocked in handoff_required; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: hard_stop state BLOCKS generic Write tool", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "hard_stop");
    const result = evaluatePreToolUse(
      { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
      { ...ctxWithGuard(tmpDir), activeTaskId: "task-1", allowedWriteScope: ["src"] }
    );
    assert.ok(result?.decision === "block",
      `Write must be blocked in hard_stop; got: ${JSON.stringify(result)}`);
    assert.match(result.reason, /hard.stop/i);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: hard_stop state BLOCKS generic Bash tool", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "hard_stop");
    const result = evaluatePreToolUse(
      { tool_name: "Bash", tool_input: { command: "npm run build" } },
      ctxWithGuard(tmpDir)
    );
    assert.ok(result?.decision === "block",
      `Bash must be blocked in hard_stop; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: hard_stop state ALLOWS mcp__archon__archon_handoff_commit", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "hard_stop");
    const result = evaluatePreToolUse(mcpToolPayload("mcp__archon__archon_handoff_commit"), ctxWithGuard(tmpDir));
    assert.ok(result === undefined || result.decision !== "block",
      `mcp__archon__archon_handoff_commit must not be blocked in hard_stop; got: ${JSON.stringify(result)}`);
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("F1: F3 block message is actionable — names archon_handoff_commit and npx archon continue-session", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-guard-"));
  try {
    writeTmpGuardState(tmpDir, "handoff_required");
    const result = evaluatePreToolUse(
      { tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } },
      ctxWithGuard(tmpDir)
    );
    assert.ok(result?.decision === "block", "Edit must be blocked in handoff_required");
    assert.ok(
      result.reason.includes("archon_handoff_commit"),
      `block message must mention archon_handoff_commit; got: ${result.reason}`
    );
    assert.ok(
      result.reason.includes("continue-session"),
      `block message must mention continue-session; got: ${result.reason}`
    );
  } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
});

// ─── F1 parity: MCP handoff tools must be safe in BOTH hook and canonical ──────
//
// The hook's isHandoffSafeTool and the canonical ContextBudgetMonitor.isHandoffSafeTool
// serve related but distinct purposes and their diagnostic-tool sets intentionally differ:
//
//   - Hook: excludes Bash from the safe-set. Over the context threshold the hook blocks
//     Bash tool calls to prevent runaway work. Bash is NOT in the hook's safe-set by design.
//   - Canonical (context-budget.ts): includes Bash in diagnosticTools so that the agent
//     runtime itself can run diagnostic commands when approaching the budget limit.
//
// Invariant: the MCP handoff-completing tools (bare name + mcp__archon__ prefix) MUST be
// allowed by both the hook and the canonical. Bash intentionally excluded from this parity
// assertion.

// Import the canonical isHandoffSafeTool from context-budget.ts via tsx
// to assert parity on the MCP-handoff subset between hook and runtime.
import { ContextBudgetMonitor } from "../src/runtime/context-budget.ts";

const MCP_HANDOFF_TOOLS = [
  "archon_handoff_prepare",
  "archon_handoff_commit",
  "archon_context_sample",
  "archon_next_action",
  "mcp__archon__archon_handoff_prepare",
  "mcp__archon__archon_handoff_commit",
  "mcp__archon__archon_context_sample",
  "mcp__archon__archon_next_action"
];

// Canonical side: each MCP handoff tool must be allowed by ContextBudgetMonitor.
for (const toolName of MCP_HANDOFF_TOOLS) {
  test(`F1 parity: canonical isHandoffSafeTool allows ${toolName}`, () => {
    assert.equal(
      ContextBudgetMonitor.isHandoffSafeTool(toolName),
      true,
      `canonical isHandoffSafeTool must allow ${toolName}`
    );
  });
}

// Hook side: each MCP handoff tool must not be blocked by the hook in handoff_required
// state. Bash is intentionally excluded — the hook is stricter than the canonical for Bash.
for (const toolName of MCP_HANDOFF_TOOLS) {
  test(`F1 parity: hook allows ${toolName} in handoff_required state`, () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archon-parity-"));
    try {
      writeTmpGuardState(tmpDir, "handoff_required");
      const result = evaluatePreToolUse(mcpToolPayload(toolName), ctxWithGuard(tmpDir));
      assert.ok(
        result === undefined || result.decision !== "block",
        `hook must allow ${toolName} in handoff_required; got: ${JSON.stringify(result)}`
      );
    } finally { fsSync.rmSync(tmpDir, { recursive: true, force: true }); }
  });
}

// ─── F2: isHandoffArtifactPath helper ──────────────────────────────────────────

test("F2: isHandoffArtifactPath: context-guard.json is a handoff artifact path", () => {
  assert.equal(isHandoffArtifactPath(".archon/work/context-guard.json"), true);
});

test("F2: isHandoffArtifactPath: daemon/continuation-context.txt is a handoff artifact path", () => {
  assert.equal(isHandoffArtifactPath(".archon/work/daemon/continuation-context.txt"), true);
});

test("F2: isHandoffArtifactPath: daemon/interactive-resume-request.json is a handoff artifact path", () => {
  assert.equal(isHandoffArtifactPath(".archon/work/daemon/interactive-resume-request.json"), true);
});

test("F2: isHandoffArtifactPath: other daemon/ files are NOT handoff artifact paths", () => {
  assert.equal(isHandoffArtifactPath(".archon/work/daemon/hook-blocker-state.json"), false);
  assert.equal(isHandoffArtifactPath(".archon/work/daemon/bypass-log.json"), false);
});

test("F2: isHandoffArtifactPath: src/ paths are NOT handoff artifact paths", () => {
  assert.equal(isHandoffArtifactPath("src/foo.ts"), false);
});

test("F2: Write to context-guard.json is NOT blocked by managed-path gate (handoff artifact exemption)", () => {
  // The managed-path gate must not block writes to handoff artifact paths, even without task scope,
  // because the agent needs to write these paths during the handoff process.
  const result = evaluatePreToolUse(
    writePayload(".archon/work/context-guard.json"),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "block",
    `Write to context-guard.json must not be blocked by managed-path gate; got: ${JSON.stringify(result)}`);
});

test("F2: Write to daemon/continuation-context.txt is NOT blocked by managed-path gate", () => {
  const result = evaluatePreToolUse(
    writePayload(".archon/work/daemon/continuation-context.txt"),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "block",
    `Write to continuation-context.txt must not be blocked; got: ${JSON.stringify(result)}`);
});

test("F2: Write to daemon/interactive-resume-request.json is NOT blocked by managed-path gate", () => {
  const result = evaluatePreToolUse(
    writePayload(".archon/work/daemon/interactive-resume-request.json"),
    emptyContext()
  );
  assert.ok(result === undefined || result.decision !== "block",
    `Write to interactive-resume-request.json must not be blocked; got: ${JSON.stringify(result)}`);
});
