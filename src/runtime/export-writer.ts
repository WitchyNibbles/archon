// Single TypeScript-side writer for the Archon live-state export surface:
// every write to `.archon/work/**` and `.archon/ACTIVE` that originates in
// Node/TypeScript code routes through this module.
//
// WHY THIS EXISTS (audit auditDebt202607 §3.6 / F8)
// The export surface was previously multi-writer: workflow export paths, the
// daemon state-writers, the init-task packet writer, the install scaffold
// commands, and daemon review-queue archiving each called `writeFile` directly
// with ad-hoc `mkdir` + non-atomic overwrite. That left four problems: (1) a
// crash mid-write could leave a torn task-queue.json or ACTIVE that the next
// reader parses as corrupt; (2) there was no single place to add telemetry or
// enforce the path boundary; (3) reconciliation was reactive rather than
// structural; (4) the path guard, when it existed, was a bare substring check
// with no rooted resolution, so a path landing in a SIBLING project's
// `.archon/work/` (e.g. via a misconfigured root or a crafted relative
// segment) could still pass. This module makes the write atomic (temp file +
// rename), resolves every candidate path against an EXPLICIT root before
// checking containment, verifies the real (symlink-resolved) location also
// stays inside the surface, surfaces a consistent error type, and gives
// future telemetry exactly one seam.
//
// PATH CONTRACT (root-explicit containment — audit follow-up finding 1)
// Every entry point takes `root` (the repo/consumer-repo root the export
// surface is rooted at) as an explicit parameter and resolves the candidate
// path against it with `path.resolve(root, targetPath)`. Node's `path.resolve`
// already discards `root` when `targetPath` is itself absolute — callers that
// pass an absolute path (most call sites, which built it via `path.join(cwd,
// ...)`) get that path back verbatim, normalized. The containment check then
// compares the RESOLVED target against `path.resolve(root, ".archon", "work")`
// / `path.resolve(root, ".archon", "ACTIVE")` computed from the SAME explicit
// root — never a substring match on the string form. This is what closes the
// cross-root escape: a target that merely CONTAINS the substring
// "/.archon/work/" but sits under a different root's tree (e.g.
// `/other-project/.archon/work/evil.json` while `root` is `/repo`) fails the
// prefix+separator check because it does not start with `/repo/.archon/work/`.
//
// SYMLINK CONTRACT (audit follow-up finding 6)
// The string-level containment check above happens before any I/O and cannot
// see symlinks. `assertRealPathContainment` additionally resolves the nearest
// EXISTING ancestor directory of both the target and `root` itself via
// `fs.realpath`, reconstructs the effective real path by joining the
// (necessarily non-existent, and therefore not-yet-a-symlink) remaining
// suffix, and checks that the target's REAL location still lives inside the
// REAL root. The check is against `root`, not against `.archon/work`'s own
// realpath — a symlinked `work` directory always "contains" writes made
// through it by construction, so comparing against its own resolved target
// would never catch anything; comparing against the real repo root does. This
// blocks a symlinked `.archon/work` itself, or a symlinked subdirectory under
// it (e.g. `.archon/work/daemon` -> `/tmp/evil`), from silently redirecting a
// write outside the intended tree, while still permitting a symlink that
// stays within the real root (e.g. `.archon/work/daemon` ->
// `.archon/work/real-daemon`).
//
// ATOMICITY CONTRACT
// Each write lands in a sibling temp file in the SAME directory as the target
// (so the final rename is same-filesystem and therefore atomic on POSIX), then
// `rename()`s over the target. A reader either sees the complete previous
// contents or the complete new contents — never a partial write. Callers that
// only want to write when the bytes changed pass `{ ifChanged: true }` to
// preserve the previous `writeFileIfChanged` no-op-on-identical behavior.
//
// ERROR CONTRACT
// Every failure from `writeArchonExport` / `removeArchonExport` /
// `moveIntoArchonExport` is wrapped in `ArchonExportWriteError` (message +
// `targetPath` + `cause`). The original Node error (with its `.code`, e.g.
// `ENOENT`/`EACCES`) is preserved on `.cause`, not swallowed, but no caller in
// this codebase inspects `.code` on the direct result of these functions —
// verified by grep across every migrated call site (workflow.ts,
// daemon/state-writers.ts, admin/init-task.ts, daemon/review-queue.ts,
// install/cli.ts) before this change shipped. If a future caller needs the
// underlying errno, read `(error.cause as NodeJS.ErrnoException)?.code`.
//
// HOOK / EXTERNAL-INTERCHANGE BOUNDARY (intentional exceptions)
// The `.claude/hooks/*.mjs` files are dependency-free and run under Node without
// a build step; they CANNOT import this TypeScript module. A few TypeScript
// writers also stay outside this module by design — each is a distinct
// contract that atomic overwrite-rename would break or that deliberately
// targets a location outside `.archon/work`:
//   - `.claude/hooks/*.mjs`               (dependency-free guard/blocker sidecars)
//   - src/runtime/respawn-lease.ts        (link()/rename() compare-and-swap lock
//                                          files — overwrite-rename would break
//                                          the mutual-exclusion contract)
//   - src/daemon.ts `withDaemonLock`      (`.archon/work/daemon/daemon.lock`,
//                                          written with `flag: "wx"` for
//                                          O_CREAT|O_EXCL exclusivity — the
//                                          SAME rationale as respawn-lease;
//                                          routing an exclusive lock through an
//                                          always-succeeds rename would defeat
//                                          the lock)
//   - src/daemon/supervisor-actions.ts    (`writeSupervisorOperatorContinuationAction`
//                                          / `writeSupervisorReviewAction` — write
//                                          into `operatorActionDir` / `reviewInputDir`,
//                                          which default to `.archon/operator-actions`
//                                          / `.archon/review-actions` — SIBLINGS of
//                                          `.archon/work`, not inside it — and are
//                                          explicitly operator-configurable to an
//                                          arbitrary external directory via
//                                          `--operator-action-dir`/`ARCHON_OPERATOR_ACTION_DIR`
//                                          and `--review-input-dir`/`ARCHON_REVIEW_INPUT_DIR`.
//                                          This is a deliberate external-interchange
//                                          contract with an operator-side tool, not
//                                          part of the `.archon/work` export surface,
//                                          so routing it through this module's path
//                                          guard would reject legitimate external
//                                          configurations by design.
//   - src/runtime/interactive-stop-hook.ts (already implements its own tmp+rename
//                                          atomic write plus a bespoke cp/archive
//                                          handoff protocol)
//   - src/runtime/interactive-parachute.ts / src/mcp/handoff-tools.ts
//                                          (synchronous context-guard.json
//                                          sidecars consumed by the PreCompact
//                                          `.mjs` hook — kept sync to match the
//                                          hook read contract)
// These exceptions are documented in the migration inventory; adding a new
// direct `.archon/work` writer elsewhere in TypeScript is a review finding —
// route it through this module instead.

import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Error thrown for any failure inside the export writer. Carries the target. */
export class ArchonExportWriteError extends Error {
  readonly targetPath: string;

  constructor(message: string, targetPath: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArchonExportWriteError";
    this.targetPath = targetPath;
  }
}

/** Telemetry event emitted after a successful export write. */
export interface ArchonExportWriteEvent {
  readonly targetPath: string;
  /** `true` when bytes were written, `false` when an `ifChanged` write was a no-op. */
  readonly written: boolean;
  readonly byteLength: number;
}

type ExportWriteListener = (event: ArchonExportWriteEvent) => void;

// Single telemetry seam. Left as a settable listener (not a hard dependency) so
// the writer stays usable in tests and CLI paths with zero wiring. A future
// observability layer registers one listener here rather than instrumenting
// every call site.
let exportWriteListener: ExportWriteListener | undefined;

/** Register (or clear, with `undefined`) the export-write telemetry listener. */
export function setArchonExportWriteListener(listener: ExportWriteListener | undefined): void {
  exportWriteListener = listener;
}

function emitExportWrite(event: ArchonExportWriteEvent): void {
  if (!exportWriteListener) {
    return;
  }
  try {
    exportWriteListener(event);
  } catch {
    // Telemetry must never break a write. Swallow listener faults deliberately.
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

/**
 * Resolve `targetPath` against the EXPLICIT `root` and assert it lands inside
 * the Archon export surface: either the `root/.archon/ACTIVE` pointer or a
 * file under `root/.archon/work/`. Containment is computed as a rooted
 * prefix+separator comparison against boundaries derived from `root` — never
 * a substring match on the raw string — so a path that merely contains the
 * text `.archon/work/` while living under a different tree is rejected.
 *
 * @returns The resolved absolute target path (equal to `targetPath` itself
 *   when it was already absolute — `path.resolve` discards `root` in that case).
 */
export function resolveArchonExportPath(root: string, targetPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  const workRoot = path.resolve(resolvedRoot, ".archon", "work");
  const activePath = path.resolve(resolvedRoot, ".archon", "ACTIVE");

  const isActive = resolvedTarget === activePath;
  const isWorkFile = resolvedTarget === workRoot || resolvedTarget.startsWith(`${workRoot}${path.sep}`);
  if (!isActive && !isWorkFile) {
    throw new ArchonExportWriteError(
      `Refusing to write outside the Archon export surface rooted at ${resolvedRoot} ` +
        `(expected ${workRoot}${path.sep}** or ${activePath}): ${resolvedTarget}`,
      resolvedTarget
    );
  }
  return resolvedTarget;
}

/**
 * Walk up from `candidate` to the nearest EXISTING ancestor, `realpath` it, and
 * return that real ancestor plus the (necessarily non-existent) relative
 * suffix below it. Used to compute an effective real path for a target that
 * may not exist yet, without racing a `realpath` call against a missing file.
 */
async function nearestExistingRealAncestor(candidate: string): Promise<{ realAncestor: string; suffix: string }> {
  const suffixParts: string[] = [];
  let cursor = candidate;
  while (true) {
    try {
      const real = await realpath(cursor);
      return { realAncestor: real, suffix: path.join(...suffixParts) };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        // Reached the filesystem root without finding an existing ancestor —
        // treat the original candidate as its own (non-existent) real path.
        return { realAncestor: candidate, suffix: "" };
      }
      suffixParts.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function effectiveRealPath(candidate: string): Promise<string> {
  const { realAncestor, suffix } = await nearestExistingRealAncestor(candidate);
  return suffix ? path.join(realAncestor, suffix) : realAncestor;
}

/**
 * Symlink-safe companion to `resolveArchonExportPath`: re-derives containment
 * using `fs.realpath` on the nearest existing ancestor of both the target and
 * the repo `root` itself, so a symlinked `.archon/work` (or a symlinked
 * subdirectory beneath it) that would otherwise redirect the write outside the
 * real repo tree is caught before any write happens.
 *
 * Deliberately checks against the REAL root, not the real `.archon/work`
 * boundary: computing the boundary from `.archon/work`'s own realpath would be
 * circular — a symlinked `work` directory always "contains" writes made
 * through it, by definition, even when it points somewhere else entirely. The
 * only check that actually detects the escape is "does the write's real,
 * on-disk location still live inside the real repo root."
 */
async function assertRealPathContainment(root: string, resolvedTarget: string): Promise<void> {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await effectiveRealPath(path.resolve(root));
    realTarget = await effectiveRealPath(resolvedTarget);
  } catch (error) {
    throw new ArchonExportWriteError(
      `Failed to resolve real path while checking export-surface containment: ${resolvedTarget}`,
      resolvedTarget,
      { cause: error }
    );
  }

  const isContained = realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`);
  if (!isContained) {
    throw new ArchonExportWriteError(
      `Refusing to write — real (symlink-resolved) path escapes the repo root: ` +
        `${resolvedTarget} -> ${realTarget} (root: ${realRoot})`,
      resolvedTarget
    );
  }
}

let tempCounter = 0;

function buildTempPath(targetPath: string): string {
  // Same directory as the target so the final rename is same-filesystem (atomic
  // on POSIX). pid + monotonic counter + random keep concurrent writers from
  // colliding on the staging file.
  tempCounter += 1;
  const unique = `${process.pid}.${Date.now()}.${tempCounter}.${Math.random().toString(36).slice(2, 8)}`;
  return `${targetPath}.${unique}.tmp`;
}

/**
 * Atomically write `content` to an Archon export path.
 *
 * @param root         Explicit root the export surface is rooted at (the repo
 *   or consumer-repo root — never inferred from the target path itself).
 * @param targetPath   Absolute or root-relative path under `.archon/work/` or
 *   the `.archon/ACTIVE` pointer.
 * @param content      Full file contents (UTF-8). This is an overwrite, not an append.
 * @param options.ifChanged When true, read the existing file first and skip the
 *   write (returning `false`) if the bytes are identical — preserving the prior
 *   `writeFileIfChanged` semantics.
 * @returns `true` when bytes were written, `false` when an `ifChanged` write was skipped.
 * @throws {ArchonExportWriteError} on any filesystem failure or path-boundary
 *   violation, with the resolved target attached. The original Node error is
 *   preserved on `.cause`.
 */
export async function writeArchonExport(
  root: string,
  targetPath: string,
  content: string,
  options?: { ifChanged?: boolean }
): Promise<boolean> {
  const resolvedTarget = resolveArchonExportPath(root, targetPath);
  await assertRealPathContainment(root, resolvedTarget);

  if (options?.ifChanged) {
    try {
      const existing = await readFile(resolvedTarget, "utf8");
      if (existing === content) {
        emitExportWrite({ targetPath: resolvedTarget, written: false, byteLength: Buffer.byteLength(content) });
        return false;
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new ArchonExportWriteError(
          `Failed to read existing export before ifChanged write: ${resolvedTarget}`,
          resolvedTarget,
          { cause: error }
        );
      }
    }
  }

  const dir = path.dirname(resolvedTarget);
  const tempPath = buildTempPath(resolvedTarget);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, resolvedTarget);
  } catch (error) {
    // Best-effort cleanup of the staging file; never mask the original failure.
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ArchonExportWriteError(`Failed to write Archon export: ${resolvedTarget}`, resolvedTarget, {
      cause: error
    });
  }

  emitExportWrite({ targetPath: resolvedTarget, written: true, byteLength: Buffer.byteLength(content) });
  return true;
}

/**
 * Remove an Archon export file (idempotent — no error if absent). Routes deletes
 * of the export surface through the same guarded module as writes so the "single
 * owner" invariant covers removal too (used by daemon clear-state helpers).
 */
export async function removeArchonExport(root: string, targetPath: string): Promise<void> {
  const resolvedTarget = resolveArchonExportPath(root, targetPath);
  await assertRealPathContainment(root, resolvedTarget);
  try {
    await rm(resolvedTarget, { force: true });
  } catch (error) {
    throw new ArchonExportWriteError(`Failed to remove Archon export: ${resolvedTarget}`, resolvedTarget, {
      cause: error
    });
  }
}

/**
 * Move an existing file INTO the Archon export surface (e.g. archiving a
 * consumed/failed/stale review-queue entry from an external inbox directory
 * into `.archon/work/daemon/<archive-subdir>/`). Only the DESTINATION is
 * required to be inside the export surface and is guarded (path-resolved,
 * containment-checked, symlink-checked) exactly like `writeArchonExport`; the
 * source is whatever inbox path the caller already validated elsewhere (it may
 * legitimately live outside `.archon/work`, e.g. an operator-configured
 * external review-input directory). Uses `rename`, which is already atomic on
 * a single filesystem — no temp-file staging is needed for a pure move.
 */
export async function moveIntoArchonExport(root: string, fromPath: string, toTargetPath: string): Promise<void> {
  const resolvedTarget = resolveArchonExportPath(root, toTargetPath);
  await assertRealPathContainment(root, resolvedTarget);
  try {
    await mkdir(path.dirname(resolvedTarget), { recursive: true });
    await rename(fromPath, resolvedTarget);
  } catch (error) {
    throw new ArchonExportWriteError(
      `Failed to move into Archon export: ${fromPath} -> ${resolvedTarget}`,
      resolvedTarget,
      { cause: error }
    );
  }
}
