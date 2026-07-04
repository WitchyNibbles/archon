// Audit auditDebt202607 P0 gate-integrity regression suite.
// W1: Stop-hook review fallback (arch F1) — connected runtime + zero orchestrator
//     rows must mean MISSING reviews, not worker-writable markdown fallback.
// W2: Bash-gate classification (arch F3/F4/F10) — false negatives blocked, false
//     positives allowed, blocker clearing scoped to the recorded fingerprint.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const hooksDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude", "hooks");

const {
  isReadOnlyBashCommand,
  extractBashWriteTargets,
  resolveReviewGateSource,
  parseReviewExportsRuntimeOptional,
  reviewArtifactPath,
  persistHookBlockerState,
  clearHookBlockerStateForCommand,
  classifyBashFailure
} = await import(`${hooksDir}/hook-utils.mjs`);
const { evaluatePostToolUse } = await import(`${hooksDir}/hook-policy.mjs`);

const repoRoot = "/repo";

// ─── W1: resolveReviewGateSource ─────────────────────────────────────────────

test("W1: connected + zero orchestrator rows + strict packet => MISSING (no markdown fallback)", () => {
  const source = resolveReviewGateSource({
    runtimeConnected: true,
    reviewExportsRuntimeOptional: false,
    dbReviewContext: null, // loadDbReviewContext returns null on zero rows
    requiredRoles: ["reviewer", "qa_engineer", "security_reviewer"],
    taskId: "t1"
  });
  assert.equal(source.kind, "missing");
  assert.equal(source.context.missingReviews.length, 3);
  // The gate message must name review-orchestrator as the required path.
  for (const entry of source.context.missingReviews) {
    assert.match(entry, /review-orchestrator/);
    assert.match(entry, /runtime_records_only/);
  }
  assert.deepEqual(source.context.invalidReviews, []);
});

test("W1: connected + orchestrator rows present => DB context is authoritative", () => {
  const dbContext = { missingReviews: [], invalidReviews: [] };
  const source = resolveReviewGateSource({
    runtimeConnected: true,
    reviewExportsRuntimeOptional: false,
    dbReviewContext: dbContext,
    requiredRoles: ["reviewer"],
    taskId: "t1"
  });
  assert.equal(source.kind, "db");
  assert.equal(source.context, dbContext);
});

test("W1: connected + zero rows + review_exports=runtime_optional => markdown fallback allowed", () => {
  const source = resolveReviewGateSource({
    runtimeConnected: true,
    reviewExportsRuntimeOptional: true,
    dbReviewContext: null,
    requiredRoles: ["reviewer"],
    taskId: "t1"
  });
  assert.equal(source.kind, "markdown");
});

test("W1: offline (runtime unreachable) => markdown fallback preserved (offline boundary)", () => {
  const source = resolveReviewGateSource({
    runtimeConnected: false,
    reviewExportsRuntimeOptional: false,
    dbReviewContext: null,
    requiredRoles: ["reviewer", "qa_engineer", "security_reviewer"],
    taskId: "t1"
  });
  assert.equal(source.kind, "markdown");
});

test("W1: missing entries reference the canonical review artifact path per role", () => {
  const source = resolveReviewGateSource({
    runtimeConnected: true,
    reviewExportsRuntimeOptional: false,
    dbReviewContext: null,
    requiredRoles: ["reviewer"],
    taskId: "t1"
  });
  assert.match(source.context.missingReviews[0], new RegExp(reviewArtifactPath("t1", "reviewer").replace(/[.]/g, "\\.")));
});

// ─── W1: parseReviewExportsRuntimeOptional ───────────────────────────────────

test("W1 packet flag: review_exports=runtime_optional => true", () => {
  assert.equal(parseReviewExportsRuntimeOptional("## Workflow artifact refs\n\nreview_exports=runtime_optional\n"), true);
});

test("W1 packet flag: review_exports=required => false", () => {
  assert.equal(parseReviewExportsRuntimeOptional("review_exports=required\n"), false);
});

test("W1 packet flag: absent => false (strict default)", () => {
  assert.equal(parseReviewExportsRuntimeOptional("# Task Packet\n\n## Goal\nDo work.\n"), false);
});

test("W1 packet flag: prose mention does NOT trigger", () => {
  assert.equal(
    parseReviewExportsRuntimeOptional("The task may declare `review_exports=runtime_optional` when appropriate.\n"),
    false
  );
});

test("W1 packet flag: list-item + backtick wrapped runtime_optional => true", () => {
  assert.equal(parseReviewExportsRuntimeOptional("- `review_exports=runtime_optional`\n"), true);
});

test("W1 packet flag: template placeholder 'required | runtime_optional' => false (safe default)", () => {
  assert.equal(parseReviewExportsRuntimeOptional("review_exports=required | runtime_optional\n"), false);
});

// ─── W2a: false negatives — write-action detection ───────────────────────────

test("W2a: find with -delete on managed path is NOT read-only", () => {
  assert.equal(isReadOnlyBashCommand("find .claude/hooks -name '*.mjs' -delete"), false);
});

test("W2a: find with -delete extracts the search-root path as a write target", () => {
  const targets = extractBashWriteTargets("find .claude/hooks -name '*.mjs' -delete", repoRoot);
  assert.ok(targets.includes(".claude/hooks"), `expected .claude/hooks in ${JSON.stringify(targets)}`);
});

test("W2a: find with -exec is NOT read-only", () => {
  assert.equal(isReadOnlyBashCommand("find .claude -type f -exec rm {} ;"), false);
});

test("W2a: find WITHOUT an action flag stays read-only", () => {
  assert.equal(isReadOnlyBashCommand("find .claude/hooks -name '*.mjs' -type f"), true);
});

test("W2a: plain find with no action flags extracts no write targets", () => {
  assert.deepEqual(extractBashWriteTargets("find .claude/hooks -name '*.mjs'", repoRoot), []);
});

test("W2a: sort -o <target> is NOT read-only", () => {
  assert.equal(isReadOnlyBashCommand("sort -o .claude/out.txt tmp/in.txt"), false);
});

test("W2a: sort -o extracts the output file as a write target", () => {
  const targets = extractBashWriteTargets("sort -o .archon/work/out.txt tmp/in.txt", repoRoot);
  assert.ok(targets.includes(".archon/work/out.txt"), `got ${JSON.stringify(targets)}`);
});

test("W2a: sort WITHOUT -o stays read-only", () => {
  assert.equal(isReadOnlyBashCommand("sort tmp/in.txt"), true);
});

test("W2a: dd of=<target> extracts the output operand as a write target", () => {
  const targets = extractBashWriteTargets("dd of=.archon/work/x.img bs=1M count=1", repoRoot);
  assert.ok(targets.includes(".archon/work/x.img"), `got ${JSON.stringify(targets)}`);
});

test("W2a: dd of=<managed> is NOT read-only", () => {
  assert.equal(isReadOnlyBashCommand("dd of=.claude/x.img bs=1M"), false);
});

// ─── W2b: false positives — quote-aware classification ───────────────────────

test("W2b: grep with quoted alternation/arrow is read-only (audit repro)", () => {
  assert.equal(isReadOnlyBashCommand(`grep -n "export | =>" .claude/hooks/x.mjs`), true);
});

test("W2b: grep with escaped quoted alternation is read-only (audit repro)", () => {
  assert.equal(isReadOnlyBashCommand(`grep -n "export \\| =>" .claude/hooks/x.mjs`), true);
});

test("W2b: grep with quoted single-quote alternation is read-only (audit repro)", () => {
  assert.equal(isReadOnlyBashCommand(`grep 'a|b' .claude/hooks/x.mjs`), true);
});

test("W2b: grep with a quoted redirect char is read-only", () => {
  assert.equal(isReadOnlyBashCommand(`grep -n "a > b" .claude/hooks/x.mjs`), true);
});

test("W2b: quoted write-command word (touch) inside grep is read-only", () => {
  assert.equal(isReadOnlyBashCommand(`grep -n "touch me" .claude/hooks/x.mjs`), true);
});

test("W2b: quoted arg containing dd of= and > yields NO write targets (live init-task repro)", () => {
  const cmd = `npm run archon -- init-task --id x --goal "writes dd of=y and pipes > z"`;
  assert.deepEqual(extractBashWriteTargets(cmd, repoRoot), []);
});

test("W2b: a quoted managed path with a quoted redirect does not register as a write target", () => {
  assert.deepEqual(extractBashWriteTargets(`grep -n "x > .claude/y" .claude/hooks/z.mjs`, repoRoot), []);
});

// ── W2b: real writes still detected (no regression) ──

test("W2b: real unquoted redirect is still write-like and extracted", () => {
  assert.equal(isReadOnlyBashCommand("cat a.txt > .claude/x"), false);
  const targets = extractBashWriteTargets("cat a.txt > .claude/x", repoRoot);
  assert.ok(targets.includes(".claude/x"));
});

test("W2b: real tee with a quoted target path is still extracted", () => {
  const targets = extractBashWriteTargets(`echo hi | tee ".claude/out file.txt"`, repoRoot);
  assert.ok(targets.includes(".claude/out file.txt"), `got ${JSON.stringify(targets)}`);
});

test("W2b: three audited read-only grep shapes all pass", () => {
  assert.equal(isReadOnlyBashCommand(`grep -rn "x" .claude/hooks/`), true);
  assert.equal(isReadOnlyBashCommand(`grep -n "export \\| =>" .claude/hooks/x.mjs`), true);
  assert.equal(isReadOnlyBashCommand(`grep 'a|b' .claude/hooks/x.mjs`), true);
});

// ─── W2c: fingerprint-scoped blocker clearing ────────────────────────────────

function makeBlockerRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-blocker-"));
  const failPayload = {
    tool_name: "Bash",
    tool_input: { command: "npm run test" },
    tool_response: { exitCode: 1, stderr: "1 test failed" }
  };
  const classification = classifyBashFailure(failPayload);
  persistHookBlockerState(dir, {
    activeTaskId: "t1",
    queueCurrentTaskId: "t1",
    toolName: classification.toolName,
    command: classification.command,
    commandFingerprint: classification.commandFingerprint,
    exitCode: classification.exitCode,
    blockerKind: classification.blockerKind,
    summary: classification.summary,
    details: classification.details,
    recordedAt: new Date().toISOString()
  });
  return dir;
}

function blockerStateExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".archon", "work", "daemon", "hook-blocker-state.json"));
}

test("W2c: unrelated exit-0 command does NOT clear the recorded blocker", () => {
  const dir = makeBlockerRepo();
  try {
    assert.equal(blockerStateExists(dir), true);
    clearHookBlockerStateForCommand(dir, "ls -la", { isVerification: false });
    assert.equal(blockerStateExists(dir), true, "unrelated command must not clear the blocker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W2c: matching command fingerprint clears the blocker", () => {
  const dir = makeBlockerRepo();
  try {
    clearHookBlockerStateForCommand(dir, "npm run test", { isVerification: true });
    assert.equal(blockerStateExists(dir), false, "the same command succeeding must clear the blocker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W2c: a verification command clears the blocker even if fingerprint differs", () => {
  const dir = makeBlockerRepo();
  try {
    clearHookBlockerStateForCommand(dir, "npm run typecheck", { isVerification: true });
    assert.equal(blockerStateExists(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W2c: clearHookBlockerStateForCommand with no recorded blocker is a no-op", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-noblocker-"));
  try {
    clearHookBlockerStateForCommand(dir, "ls", { isVerification: false });
    assert.equal(blockerStateExists(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W2c: evaluatePostToolUse keeps the blocker on unrelated success, clears on re-run", () => {
  const dir = makeBlockerRepo();
  try {
    const ctx = { repoRoot: dir, activeTaskId: "t1", queueCurrentTaskId: "t1" };
    evaluatePostToolUse(
      { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { exitCode: 0 } },
      ctx
    );
    assert.equal(blockerStateExists(dir), true, "unrelated success must not clear the blocker");
    evaluatePostToolUse(
      { tool_name: "Bash", tool_input: { command: "npm run test" }, tool_response: { exitCode: 0 } },
      ctx
    );
    assert.equal(blockerStateExists(dir), false, "the recorded command succeeding clears the blocker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
