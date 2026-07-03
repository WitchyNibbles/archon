/**
 * Tests for src/install/skill-ref-codemod.ts (S6 skill-ref codemod).
 *
 * ALL tests use injected stubs — no real filesystem I/O, no ~/.claude access,
 * no real claude CLI spawned. Fixtures are built in-memory using Map<abs, content>.
 *
 * Coverage:
 *   - rewriteContent: legacy→canonical direction, content unchanged for non-matching
 *   - rewriteContent: canonical→legacy direction
 *   - rewriteContent: token boundary — lookbehind prevents false positives
 *   - rewriteContent: tokens in prose/code fences with no skill name — untouched
 *   - rewriteContent: both prefixes in same file — only wrong one replaced
 *   - countPrefixOccurrences: counts only the target prefix
 *   - planSkillRefMigration: files with wrong prefix are included; matching files excluded
 *   - planSkillRefMigration: no agent files → empty plan
 *   - planSkillRefMigration: no ECC refs → empty plan
 *   - planSkillRefMigration: direction derived from installedNamespace
 *   - executeSkillRefMigration: dry-run default → zero writes, zero backups
 *   - executeSkillRefMigration: apply → backup created BEFORE write (C12 sequence)
 *   - executeSkillRefMigration: apply → content correctly rewritten
 *   - executeSkillRefMigration: idempotency — second apply on already-migrated file → zero changes
 *   - executeSkillRefMigration: disappeared file between plan+apply → error recorded, others proceed
 *   - detectInstalledNamespace: canonical ECC probe code → canonical prefix
 *   - detectInstalledNamespace: legacy ECC probe code → legacy prefix
 *   - detectInstalledNamespace: claude absent (ENOENT) → found: false with reason
 *   - detectInstalledNamespace: plugin absent → found: false with reason
 *   - count reporting: totalReplacements matches sum of per-file counts
 *   - parseCliArgs: --migrate-skill-refs flag parsed correctly on init/upgrade
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  rewriteContent,
  countPrefixOccurrences,
  planSkillRefMigration,
  executeSkillRefMigration,
  detectInstalledNamespace,
  printMigrationPreview,
  printMigrationResult,
} from "../../src/install/skill-ref-codemod.ts";
import type {
  CodemodFns,
  SkillRefMigrationPlan,
} from "../../src/install/skill-ref-codemod.ts";
import type { SpawnFn, FindAgentFilesFn } from "../../src/install/capability/probes-external.ts";
import { ECC_CANONICAL_SKILL_PREFIX, ECC_LEGACY_SKILL_PREFIX } from "../../src/install/ecc-plugin.ts";
import { parseCliArgs } from "../../src/install/cli.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TARGET_ROOT = "/fake/consumer";

/** Creates a fake ReadFileFn from a Map of absolutePath → content. */
function makeReadFileFn(
  fs: ReadonlyMap<string, string>
): (absolutePath: string) => Promise<string | undefined> {
  return async (absolutePath: string) => fs.get(absolutePath);
}

/** Creates a fake FindAgentFilesFn returning a fixed list of paths. */
function makeFindAgentFilesFn(files: readonly string[]): FindAgentFilesFn {
  return async (_targetRoot: string) => files;
}

/**
 * Creates a CodemodFns with injected in-memory storage.
 * writeLog records (absolutePath, content) pairs in the order they are called.
 * copyLog records (src, dest) pairs in the order they are called.
 * The returned `vfs` map starts as a copy of `initial` and is mutated by writeFile.
 */
function makeCodemodFns(initial: Map<string, string> = new Map()): {
  fns: CodemodFns;
  vfs: Map<string, string>;
  writeLog: Array<{ path: string; content: string; calledAt: number }>;
  copyLog: Array<{ src: string; dest: string; calledAt: number }>;
} {
  const vfs = new Map(initial);
  const writeLog: Array<{ path: string; content: string; calledAt: number }> = [];
  const copyLog: Array<{ src: string; dest: string; calledAt: number }> = [];
  let callOrder = 0;

  const fns: CodemodFns = {
    async readFile(absolutePath: string): Promise<string | undefined> {
      return vfs.get(absolutePath);
    },
    async writeFile(absolutePath: string, content: string): Promise<void> {
      writeLog.push({ path: absolutePath, content, calledAt: callOrder++ });
      vfs.set(absolutePath, content);
    },
    async copyFile(src: string, dest: string): Promise<void> {
      copyLog.push({ src, dest, calledAt: callOrder++ });
      const content = vfs.get(src);
      if (content !== undefined) {
        vfs.set(dest, content);
      }
    },
    async ensureDir(_absolutePath: string): Promise<void> {
      // no-op in tests
    },
  };

  return { fns, vfs, writeLog, copyLog };
}

/** Creates a SpawnFn that mimics claude plugin list output for a given identity. */
function makeSpawnFnPluginList(
  identity: "canonical" | "legacy" | "absent" | "enoent"
): SpawnFn {
  return async (_command: string, _args: readonly string[]) => {
    if (identity === "enoent") {
      throw new Error("ENOENT spawn error");
    }
    if (identity === "absent") {
      // plugin list returns ok but no ECC plugin
      return { exitCode: 0, stdout: "Installed plugins:\n\n", stderr: "" };
    }

    const pluginLine =
      identity === "canonical"
        ? "  ❯ ecc@ecc\n    Version: 2.0.0\n    Scope: user\n    Status: ✔ enabled\n"
        : "  ❯ everything-claude-code@everything-claude-code\n    Version: 1.8.0\n    Scope: user\n    Status: ✔ enabled\n";

    return {
      exitCode: 0,
      stdout: `Installed plugins:\n\n${pluginLine}`,
      stderr: "",
    };
  };
}

// ---------------------------------------------------------------------------
// rewriteContent: correct prefix replacement
// ---------------------------------------------------------------------------

test("rewriteContent: legacy→canonical rewrites legacy prefix, preserves skill name", () => {
  const original = "Use ecc:web-search for web lookup and ecc:run-js for code.";
  const { rewritten, count } = rewriteContent(
    original,
    ECC_LEGACY_SKILL_PREFIX,
    ECC_CANONICAL_SKILL_PREFIX
  );
  // No legacy prefix in original → nothing rewritten
  assert.strictEqual(count, 0);
  assert.strictEqual(rewritten, original);
});

test("rewriteContent: legacy prefix replaced with canonical", () => {
  const original =
    `Use ${ECC_LEGACY_SKILL_PREFIX}web-search for lookup.\n` +
    `Also ${ECC_LEGACY_SKILL_PREFIX}run-js for code.`;
  const { rewritten, count } = rewriteContent(
    original,
    ECC_LEGACY_SKILL_PREFIX,
    ECC_CANONICAL_SKILL_PREFIX
  );
  assert.strictEqual(count, 2);
  assert.ok(rewritten.includes(`${ECC_CANONICAL_SKILL_PREFIX}web-search`));
  assert.ok(rewritten.includes(`${ECC_CANONICAL_SKILL_PREFIX}run-js`));
  assert.ok(!rewritten.includes(ECC_LEGACY_SKILL_PREFIX));
});

test("rewriteContent: canonical→legacy direction", () => {
  const original =
    `Call ${ECC_CANONICAL_SKILL_PREFIX}web-search and ${ECC_CANONICAL_SKILL_PREFIX}file-manager.`;
  const { rewritten, count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 2);
  assert.ok(rewritten.includes(`${ECC_LEGACY_SKILL_PREFIX}web-search`));
  assert.ok(rewritten.includes(`${ECC_LEGACY_SKILL_PREFIX}file-manager`));
  assert.ok(!rewritten.includes(ECC_CANONICAL_SKILL_PREFIX));
});

// ---------------------------------------------------------------------------
// rewriteContent: token boundary / non-skill-ref cases UNTOUCHED
// ---------------------------------------------------------------------------

test("rewriteContent: prefix with no skill name is NOT matched", () => {
  // "ecc:" alone (trailing space, no identifier after colon) → not a skill-ref
  const original = `The ecc: namespace handles external calls.`;
  const { count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,  // from canonical
    ECC_LEGACY_SKILL_PREFIX
  );
  // "ecc:" followed by a space → skill name regex [A-Za-z0-9][A-Za-z0-9_-]* won't match
  assert.strictEqual(count, 0);
});

test("rewriteContent: lookbehind prevents matching prefix inside longer identifier", () => {
  // "necc:something" should NOT be matched (preceded by 'n')
  const original = "necc:something is not a skill ref.";
  const { count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 0);
});

test("rewriteContent: URL path segments are NOT rewritten (C1: only skill-ref tokens)", () => {
  // A "/" before the prefix marks a URL path segment, not a skill ref
  const original =
    "See https://example.test/ecc:web-search and https://x.test/docs/everything-claude-code:run-js for details.";
  const { rewritten, count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 0);
  assert.strictEqual(rewritten, original);
});

test("rewriteContent: dotted/domain-like contexts are NOT rewritten", () => {
  // A "." before the prefix marks a dotted identifier/domain, not a skill ref
  const original = "The docs.ecc:thing form is a domain-style token, not a skill ref.";
  const { rewritten, count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 0);
  assert.strictEqual(rewritten, original);
});

test("rewriteContent: real skill refs still rewritten after boundary tightening", () => {
  // Sanity: space-, start-of-line-, backtick-, and paren-preceded refs all still match
  const original =
    `ecc:at-line-start plus (ecc:in-parens) and \`ecc:in-backticks\` and ecc:after-space.`;
  const { count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 4);
});

test("rewriteContent: prefix preceded by alphanumeric is NOT matched", () => {
  // "Xecc:skill" should NOT be matched (lookbehind: preceded by 'X')
  const original = "Xecc:skill-name and Yecc:other";
  const { count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 0);
});

test("rewriteContent: prefix preceded by underscore is NOT matched", () => {
  const original = "some_ecc:skill is not a standalone ref";
  const { count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 0);
});

test("rewriteContent: skill-ref in backtick code span IS matched (it is a skill-ref)", () => {
  // "`ecc:web-search`" — preceded by backtick, which is NOT [A-Za-z0-9_] → matched
  const original = "Invoke `ecc:web-search` to search.";
  const { count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 1);
});

test("rewriteContent: skill-ref in backtick code span with no skill name is NOT matched", () => {
  // "`ecc:`" alone — no identifier after colon
  const original = "The `ecc:` namespace is used by the plugin.";
  const { count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 0);
});

test("rewriteContent: file with both prefixes — only the fromPrefix is replaced", () => {
  // File has both ecc: (canonical) and everything-claude-code: (legacy) refs
  // When migrating from canonical to legacy, only ecc: is replaced
  const original =
    `${ECC_CANONICAL_SKILL_PREFIX}web-search\n` +
    `${ECC_LEGACY_SKILL_PREFIX}run-js\n`;
  const { rewritten, count } = rewriteContent(
    original,
    ECC_CANONICAL_SKILL_PREFIX,
    ECC_LEGACY_SKILL_PREFIX
  );
  assert.strictEqual(count, 1); // only the canonical one
  assert.ok(rewritten.includes(`${ECC_LEGACY_SKILL_PREFIX}web-search`));
  // The pre-existing legacy ref is preserved as-is
  assert.ok(rewritten.includes(`${ECC_LEGACY_SKILL_PREFIX}run-js`));
  assert.ok(!rewritten.includes(`${ECC_CANONICAL_SKILL_PREFIX}web-search`));
});

// ---------------------------------------------------------------------------
// countPrefixOccurrences
// ---------------------------------------------------------------------------

test("countPrefixOccurrences: counts only the target prefix", () => {
  const content =
    `${ECC_CANONICAL_SKILL_PREFIX}web-search ` +
    `${ECC_LEGACY_SKILL_PREFIX}run-js ` +
    `${ECC_CANONICAL_SKILL_PREFIX}file-manager`;
  assert.strictEqual(
    countPrefixOccurrences(content, ECC_CANONICAL_SKILL_PREFIX),
    2
  );
  assert.strictEqual(
    countPrefixOccurrences(content, ECC_LEGACY_SKILL_PREFIX),
    1
  );
});

test("countPrefixOccurrences: returns 0 for absent prefix", () => {
  const content = `${ECC_CANONICAL_SKILL_PREFIX}web-search`;
  assert.strictEqual(countPrefixOccurrences(content, ECC_LEGACY_SKILL_PREFIX), 0);
});

// ---------------------------------------------------------------------------
// planSkillRefMigration
// ---------------------------------------------------------------------------

test("planSkillRefMigration: files with wrong prefix are included", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/backend.md`;
  const content =
    `# Backend Agent\n\nUse ${ECC_LEGACY_SKILL_PREFIX}web-search for lookups.\n`;

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,  // installed is canonical → wrong is legacy
    makeFindAgentFilesFn([agentFile]),
    makeReadFileFn(new Map([[agentFile, content]]))
  );

  assert.strictEqual(plan.files.length, 1);
  assert.strictEqual(plan.files[0]!.count, 1);
  assert.strictEqual(plan.files[0]!.direction, "legacy-to-canonical");
  assert.strictEqual(plan.files[0]!.fromPrefix, ECC_LEGACY_SKILL_PREFIX);
  assert.strictEqual(plan.files[0]!.toPrefix, ECC_CANONICAL_SKILL_PREFIX);
  assert.strictEqual(plan.totalReplacements, 1);
  assert.strictEqual(plan.installedNamespace, ECC_CANONICAL_SKILL_PREFIX);
  assert.strictEqual(plan.wrongPrefix, ECC_LEGACY_SKILL_PREFIX);
});

test("planSkillRefMigration: files with correct prefix are excluded (no changes needed)", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/backend.md`;
  const content = `Use ${ECC_CANONICAL_SKILL_PREFIX}web-search.`;

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([agentFile]),
    makeReadFileFn(new Map([[agentFile, content]]))
  );

  assert.strictEqual(plan.files.length, 0);
  assert.strictEqual(plan.totalReplacements, 0);
});

test("planSkillRefMigration: no agent files → empty plan", async () => {
  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([]),
    makeReadFileFn(new Map())
  );

  assert.strictEqual(plan.files.length, 0);
  assert.strictEqual(plan.totalReplacements, 0);
});

test("planSkillRefMigration: no ECC refs at all → empty plan", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/backend.md`;
  const content = "# Backend Agent\n\nThis agent does not use ECC skills.\n";

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([agentFile]),
    makeReadFileFn(new Map([[agentFile, content]]))
  );

  assert.strictEqual(plan.files.length, 0);
  assert.strictEqual(plan.totalReplacements, 0);
});

test("planSkillRefMigration: canonical→legacy direction", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/planner.md`;
  const content = `Call ${ECC_CANONICAL_SKILL_PREFIX}web-search.`;

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_LEGACY_SKILL_PREFIX,  // installed is legacy → wrong is canonical
    makeFindAgentFilesFn([agentFile]),
    makeReadFileFn(new Map([[agentFile, content]]))
  );

  assert.strictEqual(plan.files.length, 1);
  assert.strictEqual(plan.files[0]!.direction, "canonical-to-legacy");
  assert.strictEqual(plan.files[0]!.fromPrefix, ECC_CANONICAL_SKILL_PREFIX);
  assert.strictEqual(plan.files[0]!.toPrefix, ECC_LEGACY_SKILL_PREFIX);
});

test("planSkillRefMigration: multiple files, count reporting accuracy", async () => {
  const file1 = `${TARGET_ROOT}/.claude/agents/a.md`;
  const file2 = `${TARGET_ROOT}/.claude/agents/b.md`;
  const file3 = `${TARGET_ROOT}/.claude/agents/c.md`;

  const fs = new Map([
    [file1, `${ECC_LEGACY_SKILL_PREFIX}web-search ${ECC_LEGACY_SKILL_PREFIX}run-js`],  // 2 wrong
    [file2, `${ECC_CANONICAL_SKILL_PREFIX}web-search`],  // 0 wrong (correct namespace)
    [file3, `${ECC_LEGACY_SKILL_PREFIX}file-manager`],   // 1 wrong
  ]);

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([file1, file2, file3]),
    makeReadFileFn(fs)
  );

  assert.strictEqual(plan.files.length, 2); // file2 excluded
  assert.strictEqual(plan.totalReplacements, 3); // 2 + 1
  const planByRel = Object.fromEntries(plan.files.map(f => [f.relPath, f.count]));
  assert.strictEqual(planByRel[".claude/agents/a.md"], 2);
  assert.strictEqual(planByRel[".claude/agents/c.md"], 1);
});

// ---------------------------------------------------------------------------
// executeSkillRefMigration: dry-run default
// ---------------------------------------------------------------------------

test("executeSkillRefMigration: dry-run → zero writes, zero backups", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/backend.md`;
  const content = `${ECC_LEGACY_SKILL_PREFIX}web-search`;
  const vfs = new Map([[agentFile, content]]);
  const { fns, writeLog, copyLog } = makeCodemodFns(vfs);

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([agentFile]),
    makeReadFileFn(vfs)
  );

  const result = await executeSkillRefMigration(
    plan,
    true,   // dryRun
    "2026-07-03T00-00-00-000Z",
    fns
  );

  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.appliedFiles.length, 0);
  assert.strictEqual(result.backupPaths.length, 0);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(writeLog.length, 0);
  assert.strictEqual(copyLog.length, 0);
});

// ---------------------------------------------------------------------------
// executeSkillRefMigration: apply path — C12 backup before write
// ---------------------------------------------------------------------------

test("executeSkillRefMigration: apply — backup is created BEFORE write (C12 sequence)", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/backend.md`;
  const content = `${ECC_LEGACY_SKILL_PREFIX}web-search`;
  const vfs = new Map([[agentFile, content]]);
  const { fns, writeLog, copyLog } = makeCodemodFns(vfs);
  const ts = "2026-07-03T00-00-00-000Z";

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([agentFile]),
    makeReadFileFn(new Map([[agentFile, content]]))
  );

  const result = await executeSkillRefMigration(
    plan,
    false,  // apply
    ts,
    fns
  );

  assert.strictEqual(result.dryRun, false);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.appliedFiles.length, 1);
  assert.strictEqual(result.backupPaths.length, 1);

  // C12: backup copy MUST be called before the write
  assert.strictEqual(copyLog.length, 1);
  assert.strictEqual(writeLog.length, 1);
  const backupCallOrder = copyLog[0]!.calledAt;
  const writeCallOrder = writeLog[0]!.calledAt;
  assert.ok(
    backupCallOrder < writeCallOrder,
    `backup (order ${String(backupCallOrder)}) must precede write (order ${String(writeCallOrder)})`
  );

  // Backup path follows .archon/install-backups/<ts>/<relpath> convention
  assert.ok(result.backupPaths[0]!.includes(".archon/install-backups"));
  assert.ok(result.backupPaths[0]!.includes(ts));
  assert.ok(result.backupPaths[0]!.includes(".claude/agents/backend.md"));
});

test("executeSkillRefMigration: apply — content is correctly rewritten", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/backend.md`;
  const original = `# Agent\n\nCall ${ECC_LEGACY_SKILL_PREFIX}web-search and ${ECC_LEGACY_SKILL_PREFIX}run-js.\n`;
  const vfs = new Map([[agentFile, original]]);
  const { fns, vfs: resultVfs } = makeCodemodFns(vfs);

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([agentFile]),
    makeReadFileFn(new Map([[agentFile, original]]))
  );

  await executeSkillRefMigration(
    plan,
    false,
    "2026-07-03T00-00-00-000Z",
    fns
  );

  const afterContent = resultVfs.get(agentFile);
  assert.ok(afterContent !== undefined);
  assert.ok(afterContent!.includes(`${ECC_CANONICAL_SKILL_PREFIX}web-search`));
  assert.ok(afterContent!.includes(`${ECC_CANONICAL_SKILL_PREFIX}run-js`));
  assert.ok(!afterContent!.includes(ECC_LEGACY_SKILL_PREFIX));
});

// ---------------------------------------------------------------------------
// executeSkillRefMigration: idempotency
// ---------------------------------------------------------------------------

test("executeSkillRefMigration: idempotency — second apply on already-migrated file → zero changes", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/backend.md`;
  const original = `${ECC_LEGACY_SKILL_PREFIX}web-search`;
  const alreadyMigrated = `${ECC_CANONICAL_SKILL_PREFIX}web-search`;

  // Plan was computed from original content
  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([agentFile]),
    makeReadFileFn(new Map([[agentFile, original]]))
  );

  assert.strictEqual(plan.totalReplacements, 1);

  // But at apply time, the file already has the migrated content
  const vfs = new Map([[agentFile, alreadyMigrated]]);
  const { fns, writeLog, copyLog } = makeCodemodFns(vfs);

  const result = await executeSkillRefMigration(
    plan,
    false,
    "2026-07-03T00-00-00-000Z",
    fns
  );

  // Idempotency guard: already migrated → no writes, no backups
  assert.strictEqual(result.appliedFiles.length, 0);
  assert.strictEqual(result.backupPaths.length, 0);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(writeLog.length, 0);
  assert.strictEqual(copyLog.length, 0);
});

// ---------------------------------------------------------------------------
// executeSkillRefMigration: disappeared file
// ---------------------------------------------------------------------------

test("executeSkillRefMigration: file disappeared between plan and apply → error recorded, other files proceed", async () => {
  const file1 = `${TARGET_ROOT}/.claude/agents/a.md`;
  const file2 = `${TARGET_ROOT}/.claude/agents/b.md`;
  const content1 = `${ECC_LEGACY_SKILL_PREFIX}web-search`;
  const content2 = `${ECC_LEGACY_SKILL_PREFIX}run-js`;

  // Plan sees both files
  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([file1, file2]),
    makeReadFileFn(new Map([[file1, content1], [file2, content2]]))
  );

  assert.strictEqual(plan.files.length, 2);

  // At apply time, file1 has disappeared
  const vfsAtApply = new Map([[file2, content2]]);
  const { fns, writeLog } = makeCodemodFns(vfsAtApply);

  const result = await executeSkillRefMigration(
    plan,
    false,
    "2026-07-03T00-00-00-000Z",
    fns
  );

  // file1 error recorded
  assert.strictEqual(result.errors.length, 1);
  assert.ok(result.errors[0]!.path.includes("a.md"));
  assert.ok(false === result.ok);

  // file2 still processed
  assert.strictEqual(result.appliedFiles.length, 1);
  assert.ok(result.appliedFiles[0]!.includes("b.md"));
  assert.strictEqual(writeLog.length, 1);
});

// ---------------------------------------------------------------------------
// detectInstalledNamespace
// ---------------------------------------------------------------------------

test("detectInstalledNamespace: canonical ECC installed → canonical prefix", async () => {
  const spawnFn = makeSpawnFnPluginList("canonical");
  const result = await detectInstalledNamespace(spawnFn);
  assert.strictEqual(result.found, true);
  if (result.found) {
    assert.strictEqual(result.namespace, ECC_CANONICAL_SKILL_PREFIX);
  }
});

test("detectInstalledNamespace: legacy ECC installed → legacy prefix", async () => {
  const spawnFn = makeSpawnFnPluginList("legacy");
  const result = await detectInstalledNamespace(spawnFn);
  assert.strictEqual(result.found, true);
  if (result.found) {
    assert.strictEqual(result.namespace, ECC_LEGACY_SKILL_PREFIX);
  }
});

test("detectInstalledNamespace: claude absent (ENOENT) → found: false, clean message, no crash", async () => {
  const spawnFn = makeSpawnFnPluginList("enoent");
  // Must not throw
  const result = await detectInstalledNamespace(spawnFn);
  assert.strictEqual(result.found, false);
  if (!result.found) {
    // Reason is a non-empty string (human readable)
    assert.ok(typeof result.reason === "string");
    assert.ok(result.reason.length > 0);
  }
});

test("detectInstalledNamespace: plugin absent → found: false with reason", async () => {
  const spawnFn = makeSpawnFnPluginList("absent");
  const result = await detectInstalledNamespace(spawnFn);
  assert.strictEqual(result.found, false);
  if (!result.found) {
    assert.ok(typeof result.reason === "string");
    assert.ok(result.reason.length > 0);
  }
});

// ---------------------------------------------------------------------------
// printMigrationPreview / printMigrationResult (smoke tests — no crash)
// ---------------------------------------------------------------------------

test("printMigrationPreview: empty plan → no-op message logged", () => {
  const plan: SkillRefMigrationPlan = {
    targetRoot: TARGET_ROOT,
    installedNamespace: ECC_CANONICAL_SKILL_PREFIX,
    wrongPrefix: ECC_LEGACY_SKILL_PREFIX,
    files: [],
    totalReplacements: 0,
  };
  const lines: string[] = [];
  printMigrationPreview(plan, (msg) => lines.push(msg));
  assert.ok(lines.length > 0);
  assert.ok(lines[0]!.includes("No skill-ref mismatches found"));
});

test("printMigrationPreview: plan with files → lists files and counts", () => {
  const plan: SkillRefMigrationPlan = {
    targetRoot: TARGET_ROOT,
    installedNamespace: ECC_CANONICAL_SKILL_PREFIX,
    wrongPrefix: ECC_LEGACY_SKILL_PREFIX,
    files: [
      {
        absolutePath: `${TARGET_ROOT}/.claude/agents/a.md`,
        relPath: ".claude/agents/a.md",
        count: 3,
        direction: "legacy-to-canonical",
        fromPrefix: ECC_LEGACY_SKILL_PREFIX,
        toPrefix: ECC_CANONICAL_SKILL_PREFIX,
      },
    ],
    totalReplacements: 3,
  };
  const lines: string[] = [];
  printMigrationPreview(plan, (msg) => lines.push(msg));
  assert.ok(lines.some(l => l.includes("3")));
  assert.ok(lines.some(l => l.includes(".claude/agents/a.md")));
});

test("printMigrationResult: empty appliedFiles → idempotent message", () => {
  const plan: SkillRefMigrationPlan = {
    targetRoot: TARGET_ROOT,
    installedNamespace: ECC_CANONICAL_SKILL_PREFIX,
    wrongPrefix: ECC_LEGACY_SKILL_PREFIX,
    files: [],
    totalReplacements: 0,
  };
  const lines: string[] = [];
  printMigrationResult(
    { dryRun: false, plan, appliedFiles: [], backupPaths: [], errors: [], ok: true },
    (msg) => lines.push(msg)
  );
  assert.ok(lines.some(l => l.includes("idempotent")));
});

// ---------------------------------------------------------------------------
// parseCliArgs: --migrate-skill-refs wiring
// ---------------------------------------------------------------------------

test("parseCliArgs: --migrate-skill-refs set on upgrade --apply", () => {
  const parsed = parseCliArgs([
    "upgrade", "--apply", "--migrate-skill-refs", "/some/target",
  ]);
  assert.strictEqual(parsed.command, "upgrade");
  assert.strictEqual((parsed as { dryRun: boolean; migrateSkillRefs?: boolean }).dryRun, false);
  assert.strictEqual((parsed as { migrateSkillRefs?: boolean }).migrateSkillRefs, true);
});

test("parseCliArgs: --migrate-skill-refs set on upgrade --dry-run", () => {
  const parsed = parseCliArgs([
    "upgrade", "--dry-run", "--migrate-skill-refs", "/some/target",
  ]);
  assert.strictEqual(parsed.command, "upgrade");
  assert.strictEqual((parsed as { dryRun: boolean }).dryRun, true);
  assert.strictEqual((parsed as { migrateSkillRefs?: boolean }).migrateSkillRefs, true);
});

test("parseCliArgs: --migrate-skill-refs set on init --apply", () => {
  const parsed = parseCliArgs([
    "init", "--apply", "--migrate-skill-refs", "/some/target",
  ]);
  assert.strictEqual(parsed.command, "init");
  assert.strictEqual((parsed as { migrateSkillRefs?: boolean }).migrateSkillRefs, true);
});

test("parseCliArgs: without --migrate-skill-refs, flag is absent", () => {
  const parsed = parseCliArgs(["upgrade", "--apply", "/some/target"]);
  assert.strictEqual(
    (parsed as { migrateSkillRefs?: boolean }).migrateSkillRefs,
    undefined
  );
});

// ---------------------------------------------------------------------------
// Item B4: explicit boundary token tests (B4)
// ---------------------------------------------------------------------------

test("rewriteContent: newline-preceded ref (mid-string) is matched", () => {
  // "\necc:x" — newline is not [A-Za-z0-9_/.]  → lookbehind passes → matched
  const original = `# Header\n${ECC_LEGACY_SKILL_PREFIX}tool-name`;
  const { rewritten, count } = rewriteContent(
    original,
    ECC_LEGACY_SKILL_PREFIX,
    ECC_CANONICAL_SKILL_PREFIX
  );
  assert.strictEqual(count, 1);
  assert.ok(rewritten.includes(`${ECC_CANONICAL_SKILL_PREFIX}tool-name`));
});

test("rewriteContent: paren-preceded ref is matched", () => {
  // "(ecc:x" — paren is not [A-Za-z0-9_/.]  → lookbehind passes → matched
  const original = `(${ECC_LEGACY_SKILL_PREFIX}tool-name)`;
  const { rewritten, count } = rewriteContent(
    original,
    ECC_LEGACY_SKILL_PREFIX,
    ECC_CANONICAL_SKILL_PREFIX
  );
  assert.strictEqual(count, 1);
  assert.ok(rewritten.includes(`${ECC_CANONICAL_SKILL_PREFIX}tool-name`));
});

test("rewriteContent: bracket-preceded ref is matched", () => {
  // "[ecc:x" — bracket is not [A-Za-z0-9_/.]  → lookbehind passes → matched
  const original = `[${ECC_LEGACY_SKILL_PREFIX}tool-name]`;
  const { rewritten, count } = rewriteContent(
    original,
    ECC_LEGACY_SKILL_PREFIX,
    ECC_CANONICAL_SKILL_PREFIX
  );
  assert.strictEqual(count, 1);
  assert.ok(rewritten.includes(`${ECC_CANONICAL_SKILL_PREFIX}tool-name`));
});

test("rewriteContent: ref at EOF with no trailing newline is matched and rewritten", () => {
  // No trailing newline — regex must still match end-of-string
  const original = `Call ${ECC_LEGACY_SKILL_PREFIX}tool-name`;
  const { rewritten, count } = rewriteContent(
    original,
    ECC_LEGACY_SKILL_PREFIX,
    ECC_CANONICAL_SKILL_PREFIX
  );
  assert.strictEqual(count, 1);
  assert.ok(rewritten.endsWith(`${ECC_CANONICAL_SKILL_PREFIX}tool-name`));
  assert.ok(!rewritten.endsWith("\n"));
});

// ---------------------------------------------------------------------------
// Item B5: two-cycle e2e idempotency
// ---------------------------------------------------------------------------

test("two-cycle e2e idempotency: plan→apply→plan again → second plan totalReplacements === 0, second execute writes nothing", async () => {
  const agentFile = `${TARGET_ROOT}/.claude/agents/agent.md`;
  const original =
    `# Agent\n\n` +
    `Use ${ECC_LEGACY_SKILL_PREFIX}web-search and ${ECC_LEGACY_SKILL_PREFIX}run-js.\n`;

  // Shared vfs — fns.writeFile mutates it; liveReadFn reads the same map.
  const { fns, vfs } = makeCodemodFns(new Map([[agentFile, original]]));
  const findFn = makeFindAgentFilesFn([agentFile]);
  const liveReadFn = (p: string): Promise<string | undefined> =>
    Promise.resolve(vfs.get(p));
  const ts = "2026-07-03T00-00-00-000Z";

  // --- First cycle ---
  const plan1 = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    findFn,
    liveReadFn
  );
  assert.strictEqual(plan1.totalReplacements, 2, "first plan must find 2 replacements");

  const result1 = await executeSkillRefMigration(plan1, false, ts, fns);
  assert.ok(result1.ok);
  assert.strictEqual(result1.appliedFiles.length, 1, "first apply must write one file");

  // --- Second cycle on the same (now-migrated) vfs ---
  const plan2 = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    findFn,
    liveReadFn
  );
  assert.strictEqual(plan2.totalReplacements, 0, "second plan must be empty after apply");
  assert.strictEqual(plan2.files.length, 0, "second plan must have no files");

  const result2 = await executeSkillRefMigration(plan2, false, ts, fns);
  assert.strictEqual(result2.appliedFiles.length, 0, "second execute must write nothing");
  assert.strictEqual(result2.backupPaths.length, 0, "second execute must create no backups");
  assert.ok(result2.ok);
});

// ---------------------------------------------------------------------------
// Item A3: path boundary / traversal guard
// ---------------------------------------------------------------------------

test("planSkillRefMigration: absolute path outside targetRoot → excluded, readFn never called", async () => {
  // /etc/passwd-style path — completely outside TARGET_ROOT
  const escapePath = "/etc/passwd";

  const readCalls: string[] = [];
  const trackingReadFn = async (p: string): Promise<string | undefined> => {
    readCalls.push(p);
    // Return content that WOULD match to confirm the guard fires before any read
    return `Use ${ECC_LEGACY_SKILL_PREFIX}web-search.`;
  };

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([escapePath]),
    trackingReadFn
  );

  assert.strictEqual(plan.files.length, 0, "out-of-root absolute path must not appear in plan");
  assert.strictEqual(plan.totalReplacements, 0);
  assert.strictEqual(readCalls.length, 0, "readFn must never be called for out-of-root path");
});

test("planSkillRefMigration: relative traversal path outside targetRoot → excluded, readFn never called", async () => {
  // Path using ../.. to escape targetRoot
  const traversalPath = `${TARGET_ROOT}/../etc/shadow`;

  const readCalls: string[] = [];
  const trackingReadFn = async (p: string): Promise<string | undefined> => {
    readCalls.push(p);
    return `Use ${ECC_LEGACY_SKILL_PREFIX}web-search.`;
  };

  const plan = await planSkillRefMigration(
    TARGET_ROOT,
    ECC_CANONICAL_SKILL_PREFIX,
    makeFindAgentFilesFn([traversalPath]),
    trackingReadFn
  );

  assert.strictEqual(plan.files.length, 0, "traversal path must not appear in plan");
  assert.strictEqual(plan.totalReplacements, 0);
  assert.strictEqual(readCalls.length, 0, "readFn must never be called for traversal path");
});

test("executeSkillRefMigration: backup path outside backup root throws — error recorded, no write or copy", async () => {
  // Craft a plan with a relPath that would escape .archon/install-backups/ via traversal.
  // This tests the defense-in-depth assertion in backupFile.
  const badRelPath = "../../../etc/passwd";
  const fakeAbsPath = TARGET_ROOT + "/" + badRelPath;

  const plan: SkillRefMigrationPlan = {
    targetRoot: TARGET_ROOT,
    installedNamespace: ECC_CANONICAL_SKILL_PREFIX,
    wrongPrefix: ECC_LEGACY_SKILL_PREFIX,
    files: [
      {
        absolutePath: fakeAbsPath,
        relPath: badRelPath,
        count: 1,
        direction: "legacy-to-canonical",
        fromPrefix: ECC_LEGACY_SKILL_PREFIX,
        toPrefix: ECC_CANONICAL_SKILL_PREFIX,
      },
    ],
    totalReplacements: 1,
  };

  const vfs = new Map([[fakeAbsPath, `${ECC_LEGACY_SKILL_PREFIX}web-search`]]);
  const { fns, writeLog, copyLog } = makeCodemodFns(vfs);

  const result = await executeSkillRefMigration(plan, false, "2026-07-03T00-00-00-000Z", fns);

  // Backup assertion must throw → error collected, no writes or copies
  assert.strictEqual(result.errors.length, 1, "one per-file error must be recorded");
  assert.ok(
    result.errors[0]!.error.toLowerCase().includes("outside") ||
      result.errors[0]!.error.toLowerCase().includes("traversal"),
    `error message must describe the boundary violation, got: ${result.errors[0]!.error}`
  );
  assert.strictEqual(writeLog.length, 0, "no file writes must occur after boundary rejection");
  assert.strictEqual(copyLog.length, 0, "no copies must occur after boundary rejection");
  assert.strictEqual(result.ok, false);
});
