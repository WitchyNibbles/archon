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
  extractBashReferencedManagedPaths,
  resolveReviewGateSource,
  reviewArtifactPath,
  persistHookBlockerState,
  clearHookBlockerStateForCommand,
  classifyBashFailure
} = await import(`${hooksDir}/hook-utils.mjs`);
const { evaluatePostToolUse } = await import(`${hooksDir}/hook-policy.mjs`);

const repoRoot = "/repo";

// ─── W1: resolveReviewGateSource ─────────────────────────────────────────────

test("W1: connected + zero orchestrator rows => MISSING (no markdown fallback)", () => {
  const source = resolveReviewGateSource({
    runtimeConnected: true,
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
    dbReviewContext: dbContext,
    requiredRoles: ["reviewer"],
    taskId: "t1"
  });
  assert.equal(source.kind, "db");
  assert.equal(source.context, dbContext);
});

// Review finding F1 (HIGH): the connected-runtime gate accepts NO packet-level
// opt-out. Task packets are worker-writable (a task whose scope covers
// `.archon/work` can edit its own packet), so any packet flag consulted while
// connected is a self-review bypass. A stray/injected opt-out property must be
// ignored: connected + zero rows is MISSING, unconditionally.
test("W1/F1: connected + zero rows + injected packet opt-out property => still MISSING", () => {
  const source = resolveReviewGateSource({
    runtimeConnected: true,
    // A worker-controlled flag smuggled into the options object must have no effect.
    reviewExportsRuntimeOptional: true,
    dbReviewContext: null,
    requiredRoles: ["reviewer"],
    taskId: "t1"
  });
  assert.equal(source.kind, "missing");
});

test("W1: offline (runtime unreachable) => markdown fallback preserved (offline boundary)", () => {
  const source = resolveReviewGateSource({
    runtimeConnected: false,
    dbReviewContext: null,
    requiredRoles: ["reviewer", "qa_engineer", "security_reviewer"],
    taskId: "t1"
  });
  assert.equal(source.kind, "markdown");
});

test("W1: missing entries reference the canonical review artifact path per role", () => {
  const source = resolveReviewGateSource({
    runtimeConnected: true,
    dbReviewContext: null,
    requiredRoles: ["reviewer"],
    taskId: "t1"
  });
  assert.match(source.context.missingReviews[0], new RegExp(reviewArtifactPath("t1", "reviewer").replace(/[.]/g, "\\.")));
});

// ─── W1/F1: packet-flag gate bypass is structurally removed ──────────────────

// Tripwire (review finding F1): the Stop-hook gate code must contain NO packet
// review-exports flag consumption. `review_exports=runtime_optional` keeps its
// CLAUDE.md meaning (a task under runtime authority does not need export write
// scope) but must never select the review-gate source — a packet-readable
// opt-out in hook code is a self-review bypass by construction.
test("W1/F1 tripwire: hook code has no packet review-exports flag consumption", () => {
  const hookSource = fs.readFileSync(path.join(hooksDir, "hook-utils.mjs"), "utf8");
  assert.doesNotMatch(hookSource, /parseReviewExportsRuntimeOptional/);
  assert.doesNotMatch(hookSource, /reviewExportsRuntimeOptional/);
  const policySource = fs.readFileSync(path.join(hooksDir, "hook-policy.mjs"), "utf8");
  assert.doesNotMatch(policySource, /review_exports/);
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

// Review finding QA-L1: -exec target extraction was untested (only the read-only
// predicate was asserted for -exec). Cover the write-target path explicitly.
test("W2a: find with -exec extracts the search-root path as a write target", () => {
  const targets = extractBashWriteTargets("find .archon/work -type f -exec rm {} ;", repoRoot);
  assert.ok(targets.includes(".archon/work"), `expected .archon/work in ${JSON.stringify(targets)}`);
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

// Review finding M2 (MEDIUM): quoted write targets for dd/sort were detected on
// the masked view only and silently dropped. They must be captured from the
// clean text like every other write-extracting command.
test("M2: dd of=<quoted managed path> is extracted as a write target", () => {
  const targets = extractBashWriteTargets(`dd if=/dev/zero of=".archon/work/out file.img" bs=1M`, repoRoot);
  assert.ok(targets.includes(".archon/work/out file.img"), `got ${JSON.stringify(targets)}`);
});

test("M2: sort -o <quoted managed path> is extracted as a write target", () => {
  const targets = extractBashWriteTargets(`sort -o ".archon/work/out file.txt" tmp/in.txt`, repoRoot);
  assert.ok(targets.includes(".archon/work/out file.txt"), `got ${JSON.stringify(targets)}`);
});

test("M2: sort --output=<quoted managed path> is extracted as a write target", () => {
  const targets = extractBashWriteTargets(`sort --output=".archon/work/o.txt" a`, repoRoot);
  assert.ok(targets.includes(".archon/work/o.txt"), `got ${JSON.stringify(targets)}`);
});

// Review finding F3 (MEDIUM): `eval "<payload>"` hid managed-path writes inside a
// masked quoted span from both the managed-path scan and write-target extraction.
// `eval`/`sh -c`/`bash -c` must be treated conservatively as write-like so the
// gate fails closed rather than passing an opaque payload.
test("F3: eval with a managed-path destructive payload is NOT read-only", () => {
  assert.equal(isReadOnlyBashCommand(`eval "find .claude -delete"`), false);
});

test("F3: sh -c with a managed-path destructive payload is NOT read-only", () => {
  assert.equal(isReadOnlyBashCommand(`sh -c "rm .claude/x"`), false);
});

test("F3: bash -c with a managed-path destructive payload is NOT read-only", () => {
  assert.equal(isReadOnlyBashCommand(`bash -c "rm .claude/x"`), false);
});

test("F3: eval referencing a managed path is caught by the managed-path scan", () => {
  const hits = extractBashReferencedManagedPaths(`eval "cat > .claude/x"`, repoRoot);
  assert.ok(hits.some((h: string) => h.startsWith(".claude")), `got ${JSON.stringify(hits)}`);
});

test("F3: ordinary read-only commands remain read-only (no eval regression)", () => {
  assert.equal(isReadOnlyBashCommand("cat .claude/hooks/hook-utils.mjs"), true);
  assert.equal(isReadOnlyBashCommand(`grep -rn "eval" .claude/hooks/`), true);
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

// Same M2 class as dd/sort: a redirect target that is QUOTED must still be
// captured (masked detection, clean extraction). Otherwise `echo x > ".claude/y"`
// evades the write-target gate.
test("M2: redirect to a quoted managed path is extracted as a write target", () => {
  const targets = extractBashWriteTargets(`echo x > ".claude/hooks/pwned file.mjs"`, repoRoot);
  assert.ok(targets.includes(".claude/hooks/pwned file.mjs"), `got ${JSON.stringify(targets)}`);
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

test("W2c: a verification command clears a VERIFICATION blocker even if fingerprint differs", () => {
  // Legitimate case: the recorded blocker was itself a verification failure
  // (npm run test), so re-running a related verification command clears it.
  const dir = makeBlockerRepo();
  try {
    clearHookBlockerStateForCommand(dir, "npm run typecheck", { isVerification: true });
    assert.equal(blockerStateExists(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Review finding F5 (LOW): a passing verification command must NOT clear a
// blocker recorded for an UNRELATED non-verification command. Verification-based
// clearing only applies when the recorded blocker was itself a verification
// failure; otherwise only a fingerprint match clears it.
function makeNonVerificationBlockerRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-nvblocker-"));
  const failPayload = {
    tool_name: "Bash",
    tool_input: { command: "docker compose up -d" },
    tool_response: { exitCode: 1, stderr: "connection refused" }
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

test("W2c/F5: verification success does NOT clear a non-verification blocker", () => {
  const dir = makeNonVerificationBlockerRepo();
  try {
    clearHookBlockerStateForCommand(dir, "npm run test", { isVerification: true });
    assert.equal(
      blockerStateExists(dir),
      true,
      "an unrelated verification pass must not erase a non-verification blocker"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W2c/F5: the recorded non-verification command's fingerprint still clears it", () => {
  const dir = makeNonVerificationBlockerRepo();
  try {
    clearHookBlockerStateForCommand(dir, "docker compose up -d", { isVerification: false });
    assert.equal(blockerStateExists(dir), false, "re-running the blocked command clears it");
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
