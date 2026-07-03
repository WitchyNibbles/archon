/**
 * S6: Skill-ref codemod for consumer AGENT.md files.
 *
 * Migrates stale ECC skill-ref prefixes in consumer .claude/agents/**\/*.md files
 * to match the installed ECC plugin namespace — both directions:
 *
 *   - Legacy installed  (everything-claude-code:*): rewrites ecc:*  → everything-claude-code:*
 *   - Canonical installed (ecc:*):                  rewrites everything-claude-code:* → ecc:*
 *
 * Council compliance:
 *   C1: Codemod runs ONLY under explicit --migrate-skill-refs flag (never silent).
 *       Dry-run preview is the DEFAULT; actual writes require `apply: true`.
 *       Backup created before every write; second apply on already-migrated files = zero changes.
 *   C12: Timestamped backup written BEFORE any file mutation — same convention as consumer-repair.ts.
 *
 * TOKEN PATTERN (authoritative definition):
 *   A "skill-ref token" is a match of:
 *     /(?<![A-Za-z0-9_])(ecc:|everything-claude-code:)([A-Za-z0-9][A-Za-z0-9_-]*)/g
 *
 *   Only the prefix portion (group 1) is rewritten; the skill name (group 2) is preserved verbatim.
 *
 *   Examples:
 *     "ecc:web-search"           → matched (skill-ref)
 *     "everything-claude-code:web-search" → matched (skill-ref)
 *     "ecc:"                     → NOT matched (no skill name following the colon)
 *     "necc:something"           → NOT matched (lookbehind: preceded by 'n')
 *     "https://necc:foo"         → NOT matched (preceded by 'c')
 *     "- ecc:web-search"         → matched (preceded by space, not alnum/underscore)
 *     "`ecc:web-search`"         → matched (preceded by backtick, not alnum/underscore)
 *     "`ecc:`"                   → NOT matched (no skill name after colon)
 *
 * All effects (file read/write/copy/mkdir) are injected so tests run without touching
 * the real filesystem.
 *
 * Direction is determined solely by the installed plugin namespace — never by flags.
 */
import path from "node:path";
import {
  cp as fsCp,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import type { SpawnFn, FindAgentFilesFn } from "./capability/probes-external.ts";
import type { ReadFileFn } from "./capability/probes-file.ts";
import {
  ECC_CANONICAL_SKILL_PREFIX,
  ECC_LEGACY_SKILL_PREFIX,
} from "./ecc-plugin.ts";
import { probeEccPresent } from "./capability/probes-external.ts";

// ---------------------------------------------------------------------------
// Token pattern (see module doc for authoritative definition)
// ---------------------------------------------------------------------------

/**
 * Regex matching a skill-ref token.
 * Group 1: the prefix ("ecc:" or "everything-claude-code:")
 * Group 2: the skill name (one or more alphanumeric/hyphen/underscore chars)
 *
 * Negative lookbehind ensures the prefix is not part of a larger identifier
 * (e.g. "necc:" or "thecc:" would NOT match), not a URL path segment
 * (e.g. "https://x.test/ecc:web-search" would NOT match), and not a
 * dotted/domain-like context (e.g. "docs.ecc:thing" would NOT match).
 *
 * This regex is used by planSkillRefMigration to count tokens per file and
 * by rewriteContent to perform the actual substitution.
 */
const SKILL_REF_REGEX =
  /(?<![A-Za-z0-9_/.])(ecc:|everything-claude-code:)([A-Za-z0-9][A-Za-z0-9_-]*)/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Installed namespace resolution result from detectInstalledNamespace. */
export type InstalledNamespaceResult =
  | {
      readonly found: true;
      readonly namespace:
        | typeof ECC_CANONICAL_SKILL_PREFIX
        | typeof ECC_LEGACY_SKILL_PREFIX;
    }
  | {
      readonly found: false;
      readonly reason: string;
    };

/** Per-file plan: describes what would be rewritten in a single agent file. */
export interface SkillRefFilePlan {
  /** Absolute path to the agent file. */
  readonly absolutePath: string;
  /** Path relative to targetRoot. */
  readonly relPath: string;
  /** Number of skill-ref token replacements planned in this file. */
  readonly count: number;
  /** Rewrite direction for this file. */
  readonly direction: "legacy-to-canonical" | "canonical-to-legacy";
  /** The prefix being replaced (the wrong one). */
  readonly fromPrefix: string;
  /** The prefix to write (the correct one, matching installed namespace). */
  readonly toPrefix: string;
}

/** Migration plan: aggregate over all agent files. */
export interface SkillRefMigrationPlan {
  /** Absolute path to the target consumer repo root. */
  readonly targetRoot: string;
  /** The installed ECC namespace (the correct prefix). */
  readonly installedNamespace: string;
  /** The wrong prefix that will be replaced. */
  readonly wrongPrefix: string;
  /** Files that need rewriting (count > 0). */
  readonly files: readonly SkillRefFilePlan[];
  /** Total number of token replacements across all files. */
  readonly totalReplacements: number;
}

/** Result of executeSkillRefMigration. */
export interface SkillRefMigrationResult {
  /** true = preview only; false = writes applied. */
  readonly dryRun: boolean;
  /** The plan that was (or would have been) executed. */
  readonly plan: SkillRefMigrationPlan;
  /** Relative paths of files that were actually written (empty on dry-run). */
  readonly appliedFiles: readonly string[];
  /** Backup paths created (C12). Empty on dry-run. */
  readonly backupPaths: readonly string[];
  /** Per-file errors during the apply phase. */
  readonly errors: readonly { readonly path: string; readonly error: string }[];
  /** false when any apply error occurred. */
  readonly ok: boolean;
}

/**
 * Injectable file-system effects for the codemod.
 * All paths are absolute. Mirrors consumer-repair.ts RepairFns.
 */
export interface CodemodFns {
  readonly readFile: (absolutePath: string) => Promise<string | undefined>;
  readonly writeFile: (absolutePath: string, content: string) => Promise<void>;
  readonly copyFile: (src: string, dest: string) => Promise<void>;
  readonly ensureDir: (absolutePath: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// detectInstalledNamespace — derives the ECC namespace via S3 probe machinery
// ---------------------------------------------------------------------------

/**
 * Detects the installed ECC plugin namespace by running the probeEccPresent probe.
 *
 * Returns { found: true, namespace } when ECC is installed with a known identity.
 * Returns { found: false, reason } when:
 *   - claude CLI is absent (ENOENT / spawn failure → skipped probe)
 *   - ECC plugin is not installed (blocked probe)
 *   - Any other non-identity probe outcome
 *
 * The direction of the codemod is determined by the returned namespace.
 * Direction is NEVER derived from CLI flags — only from the installed plugin state.
 *
 * Council C7: all claude invocations go through the injected SpawnFn (shell:false).
 */
export async function detectInstalledNamespace(
  spawnFn: SpawnFn
): Promise<InstalledNamespaceResult> {
  const result = await probeEccPresent(spawnFn);

  if (result.code === "ecc-plugin-present") {
    return { found: true, namespace: ECC_CANONICAL_SKILL_PREFIX };
  }
  if (result.code === "ecc-plugin-legacy-present") {
    return { found: true, namespace: ECC_LEGACY_SKILL_PREFIX };
  }

  // claude absent, plugin absent, list error, or any other non-identity code
  return { found: false, reason: result.detail };
}

// ---------------------------------------------------------------------------
// Content rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrites a single file's content, replacing all occurrences of `fromPrefix`
 * in skill-ref token positions with `toPrefix`.
 *
 * Only the prefix portion of each match is replaced; the skill name is preserved.
 *
 * @returns { rewritten: string; count: number } — new content and number of replacements.
 *   Returns { rewritten: original, count: 0 } when no replacements needed.
 */
export function rewriteContent(
  original: string,
  fromPrefix: string,
  toPrefix: string
): { readonly rewritten: string; readonly count: number } {
  let count = 0;

  // Reset lastIndex before use (global regex is stateful)
  SKILL_REF_REGEX.lastIndex = 0;

  const rewritten = original.replace(SKILL_REF_REGEX, (_match, prefix, skillName) => {
    if (prefix === fromPrefix) {
      count += 1;
      return `${toPrefix}${skillName as string}`;
    }
    // prefix is the other namespace — leave it alone
    return _match;
  });

  return { rewritten, count };
}

/**
 * Counts how many skill-ref tokens in `content` use `targetPrefix`.
 * Used by planSkillRefMigration without performing any writes.
 */
export function countPrefixOccurrences(content: string, targetPrefix: string): number {
  SKILL_REF_REGEX.lastIndex = 0;
  let count = 0;
  for (const m of content.matchAll(SKILL_REF_REGEX)) {
    if (m[1] === targetPrefix) {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// planSkillRefMigration — read-only scan
// ---------------------------------------------------------------------------

/**
 * Scans consumer agent files under .claude/agents/**\/*.md and builds a
 * migration plan listing every file that has the wrong prefix.
 *
 * READ-ONLY — never writes. Safe to call multiple times.
 *
 * @param targetRoot  Absolute path to the consumer repo root.
 * @param installedNamespace  The ECC prefix matching the installed plugin.
 * @param findAgentFilesFn  Injectable directory walker (reuses S3 createFindAgentFilesFn).
 * @param readFileFn  Injectable file reader.
 * @returns A migration plan. files is empty when no mismatches found.
 */
export async function planSkillRefMigration(
  targetRoot: string,
  installedNamespace:
    | typeof ECC_CANONICAL_SKILL_PREFIX
    | typeof ECC_LEGACY_SKILL_PREFIX,
  findAgentFilesFn: FindAgentFilesFn,
  readFileFn: ReadFileFn
): Promise<SkillRefMigrationPlan> {
  const wrongPrefix =
    installedNamespace === ECC_CANONICAL_SKILL_PREFIX
      ? ECC_LEGACY_SKILL_PREFIX
      : ECC_CANONICAL_SKILL_PREFIX;

  const direction: SkillRefFilePlan["direction"] =
    installedNamespace === ECC_CANONICAL_SKILL_PREFIX
      ? "legacy-to-canonical"
      : "canonical-to-legacy";

  let agentFiles: readonly string[];
  try {
    agentFiles = await findAgentFilesFn(targetRoot);
  } catch {
    agentFiles = [];
  }

  const files: SkillRefFilePlan[] = [];
  let totalReplacements = 0;

  for (const absolutePath of agentFiles) {
    // Security boundary: compute relPath first and reject any path that resolves
    // outside targetRoot. path.relative returns a ".." prefix when absolutePath
    // is not under targetRoot; an absolute relPath would indicate a bug in the
    // FindAgentFilesFn injection. Both cases are skipped — never read, never planned.
    const relPath = path.relative(targetRoot, absolutePath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      continue;
    }

    let content: string | undefined;
    try {
      content = await readFileFn(absolutePath);
    } catch {
      content = undefined;
    }
    if (!content) {
      continue;
    }

    const count = countPrefixOccurrences(content, wrongPrefix);
    if (count === 0) {
      continue;
    }

    files.push({
      absolutePath,
      relPath,
      count,
      direction,
      fromPrefix: wrongPrefix,
      toPrefix: installedNamespace,
    });
    totalReplacements += count;
  }

  return {
    targetRoot,
    installedNamespace,
    wrongPrefix,
    files,
    totalReplacements,
  };
}

// ---------------------------------------------------------------------------
// Backup helper — C12 (mirrors consumer-repair.ts backupFile)
// ---------------------------------------------------------------------------

const BACKUP_ROOT_REL = ".archon/install-backups";

/**
 * C12: copies the existing file to a timestamped backup directory BEFORE
 * any mutation. Returns the relative backup path.
 *
 * Backup layout: `.archon/install-backups/<timestamp>/<relPath>`
 * Mirrors the convention in consumer-repair.ts backupFile.
 */
async function backupFile(
  targetRoot: string,
  relPath: string,
  timestamp: string,
  fns: CodemodFns
): Promise<string> {
  const backupRelPath = `${BACKUP_ROOT_REL}/${timestamp}/${relPath}`;
  const backupAbsPath = path.join(targetRoot, backupRelPath);
  const srcAbsPath = path.join(targetRoot, relPath);

  // Security assertion (C12 defense-in-depth): the resolved backup destination
  // must stay within targetRoot/.archon/install-backups/. A relPath containing
  // path-traversal sequences (../../) could escape the backup root otherwise.
  const backupRoot = path.resolve(targetRoot, BACKUP_ROOT_REL);
  const resolvedBackupAbs = path.resolve(backupAbsPath);
  if (
    resolvedBackupAbs !== backupRoot &&
    !resolvedBackupAbs.startsWith(backupRoot + path.sep)
  ) {
    throw new Error(
      `[skill-ref-codemod] Backup destination '${resolvedBackupAbs}' is outside ` +
        `the allowed backup root '${backupRoot}' — path traversal rejected.`
    );
  }

  await fns.ensureDir(path.dirname(backupAbsPath));
  await fns.copyFile(srcAbsPath, backupAbsPath);
  return backupRelPath;
}

// ---------------------------------------------------------------------------
// executeSkillRefMigration — the codemod write path
// ---------------------------------------------------------------------------

/**
 * Executes (or previews) a skill-ref migration based on a pre-computed plan.
 *
 * DEFAULT: dryRun=true (preview only — prints plan, no writes).
 * APPLY:   dryRun=false — backs up each file (C12) then rewrites it.
 *
 * Idempotency: after a successful apply, planSkillRefMigration returns
 * totalReplacements=0 for the same files. A second executeSkillRefMigration
 * with the same plan (re-scanned) will have zero files and zero writes.
 *
 * Per-file error isolation: errors in one file do not prevent other files
 * from being processed. All errors are collected in the returned result.
 *
 * @param plan      The plan returned by planSkillRefMigration.
 * @param dryRun    When true (default), no writes occur.
 * @param timestamp ISO timestamp string for backup directory naming.
 * @param fns       Injected file-system effects (fns.readFile re-reads current
 *                  content at apply time for idempotency safety).
 */
export async function executeSkillRefMigration(
  plan: SkillRefMigrationPlan,
  dryRun: boolean,
  timestamp: string,
  fns: CodemodFns
): Promise<SkillRefMigrationResult> {
  if (dryRun || plan.files.length === 0) {
    // Dry-run: no writes, no backups
    return {
      dryRun,
      plan,
      appliedFiles: [],
      backupPaths: [],
      errors: [],
      ok: true,
    };
  }

  const appliedFiles: string[] = [];
  const backupPaths: string[] = [];
  const errors: { path: string; error: string }[] = [];

  for (const filePlan of plan.files) {
    try {
      // Re-read current content at apply time for idempotency safety
      const currentContent = await fns.readFile(filePlan.absolutePath);
      if (currentContent === undefined) {
        errors.push({
          path: filePlan.relPath,
          error: "File disappeared between plan and apply — skipped.",
        });
        continue;
      }

      // Idempotency guard: re-count to see if still needed
      const stillNeedsRewrite = countPrefixOccurrences(currentContent, filePlan.fromPrefix);
      if (stillNeedsRewrite === 0) {
        // Already migrated on a previous apply — skip silently
        continue;
      }

      // C12: backup BEFORE any write
      const backupRelPath = await backupFile(
        plan.targetRoot,
        filePlan.relPath,
        timestamp,
        fns
      );
      backupPaths.push(backupRelPath);

      // Rewrite
      const { rewritten } = rewriteContent(
        currentContent,
        filePlan.fromPrefix,
        filePlan.toPrefix
      );
      await fns.writeFile(filePlan.absolutePath, rewritten);
      appliedFiles.push(filePlan.relPath);
    } catch (err) {
      errors.push({
        path: filePlan.relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    dryRun: false,
    plan,
    appliedFiles,
    backupPaths,
    errors,
    ok: errors.length === 0,
  };
}

// ---------------------------------------------------------------------------
// printMigrationPreview / printMigrationResult — human-readable output
// ---------------------------------------------------------------------------

/**
 * Prints the dry-run preview to stdout.
 * Called by cli.ts when --migrate-skill-refs is present without --apply.
 */
export function printMigrationPreview(
  plan: SkillRefMigrationPlan,
  log: (msg: string) => void = console.log
): void {
  if (plan.files.length === 0) {
    log(
      `[skill-ref-codemod] No skill-ref mismatches found. ` +
        `All agent files already use the '${plan.installedNamespace}' namespace ` +
        `(or have no ECC skill refs).`
    );
    return;
  }

  const direction =
    plan.installedNamespace === ECC_CANONICAL_SKILL_PREFIX
      ? "legacy → canonical"
      : "canonical → legacy";

  log(
    `[skill-ref-codemod] PREVIEW (dry-run): ${String(plan.files.length)} file(s) ` +
      `would be rewritten (${String(plan.totalReplacements)} token(s), ` +
      `'${plan.wrongPrefix}' → '${plan.installedNamespace}', ${direction}):`
  );
  for (const f of plan.files) {
    log(`  ${f.relPath}  (${String(f.count)} replacement(s))`);
  }
  log(
    `[skill-ref-codemod] Re-run with --apply to perform the rewrite ` +
      `(each file backed up to .archon/install-backups/<ts>/<relpath> before write).`
  );
}

/**
 * Prints the apply result to stdout.
 * Called by cli.ts after executeSkillRefMigration completes.
 */
export function printMigrationResult(
  result: SkillRefMigrationResult,
  log: (msg: string) => void = console.log
): void {
  if (result.appliedFiles.length === 0 && result.errors.length === 0) {
    log(
      `[skill-ref-codemod] No changes applied — all agent files already use ` +
        `the '${result.plan.installedNamespace}' namespace (idempotent re-run).`
    );
    return;
  }

  if (result.appliedFiles.length > 0) {
    log(
      `[skill-ref-codemod] Applied: ${String(result.appliedFiles.length)} file(s) rewritten ` +
        `('${result.plan.wrongPrefix}' → '${result.plan.installedNamespace}').`
    );
    for (const f of result.appliedFiles) {
      log(`  ${f}`);
    }
    log(
      `[skill-ref-codemod] Backups created (${String(result.backupPaths.length)}):` +
        ` ${result.backupPaths.join(", ")}`
    );
  }

  if (result.errors.length > 0) {
    log(
      `[skill-ref-codemod] ERRORS (${String(result.errors.length)} file(s) failed):`
    );
    for (const e of result.errors) {
      log(`  ${e.path}: ${e.error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Default production implementations
// ---------------------------------------------------------------------------

/**
 * Creates the default CodemodFns backed by the real Node.js fs APIs.
 * Use in production (cli.ts); use injected stubs in tests.
 */
export function createDefaultCodemodFns(): CodemodFns {
  return {
    async readFile(absolutePath: string): Promise<string | undefined> {
      try {
        return await fsReadFile(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },
    async writeFile(absolutePath: string, content: string): Promise<void> {
      await fsMkdir(path.dirname(absolutePath), { recursive: true });
      await fsWriteFile(absolutePath, content, "utf8");
    },
    async copyFile(src: string, dest: string): Promise<void> {
      await fsCp(src, dest);
    },
    async ensureDir(absolutePath: string): Promise<void> {
      await fsMkdir(absolutePath, { recursive: true });
    },
  };
}
