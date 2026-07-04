// Single TypeScript-side writer for the Archon live-state export surface:
// every write to `.archon/work/**` and `.archon/ACTIVE` that originates in
// Node/TypeScript code routes through this module.
//
// WHY THIS EXISTS (audit auditDebt202607 §3.6 / F8)
// The export surface was previously multi-writer: workflow export paths, the
// daemon state-writers, the init-task packet writer, and admin commands each
// called `writeFile` directly with ad-hoc `mkdir` + non-atomic overwrite. That
// left three problems: (1) a crash mid-write could leave a torn task-queue.json
// or ACTIVE that the next reader parses as corrupt; (2) there was no single
// place to add telemetry or enforce the path boundary; (3) reconciliation was
// reactive rather than structural. This module makes the write atomic
// (temp file + rename), surfaces a consistent error type, and gives future
// telemetry exactly one seam.
//
// ATOMICITY CONTRACT
// Each write lands in a sibling temp file in the SAME directory as the target
// (so the final rename is same-filesystem and therefore atomic on POSIX), then
// `rename()`s over the target. A reader either sees the complete previous
// contents or the complete new contents — never a partial write. Callers that
// only want to write when the bytes changed pass `{ ifChanged: true }` to
// preserve the previous `writeFileIfChanged` no-op-on-identical behavior.
//
// HOOK BOUNDARY (intentional exception)
// The `.claude/hooks/*.mjs` files are dependency-free and run under Node without
// a build step; they CANNOT import this TypeScript module. Hook-side writers of
// `.archon/work/**` guard/blocker sidecars therefore remain outside this writer
// by design. Current hook-side / hook-contract writers that do NOT route here:
//   - `.claude/hooks/*.mjs`               (dependency-free guard/blocker sidecars)
//   - src/runtime/respawn-lease.ts        (link()/rename() compare-and-swap lock
//                                          files — overwrite-rename would break
//                                          the mutual-exclusion contract)
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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

const ARCHON_DIR = ".archon";
const WORK_DIR_SEGMENT = `${path.sep}${ARCHON_DIR}${path.sep}work${path.sep}`;
const ACTIVE_SUFFIX = `${path.sep}${ARCHON_DIR}${path.sep}ACTIVE`;

/**
 * Assert that `absolutePath` targets the Archon live-state export surface:
 * either the `.archon/ACTIVE` pointer or a file under `.archon/work/`. This is
 * defence in depth — it keeps the "single writer for the export surface"
 * invariant honest and blocks a caller from accidentally routing an unrelated
 * (or traversal) path through the atomic writer.
 */
export function assertArchonExportPath(absolutePath: string): void {
  const normalized = path.normalize(absolutePath);
  const isActive = normalized.endsWith(ACTIVE_SUFFIX);
  const isWorkFile = normalized.includes(WORK_DIR_SEGMENT);
  if (!isActive && !isWorkFile) {
    throw new ArchonExportWriteError(
      `Refusing to write outside the Archon export surface (.archon/work/** or .archon/ACTIVE): ${absolutePath}`,
      absolutePath
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
 * @param absolutePath Absolute path under `.archon/work/` or the `.archon/ACTIVE` pointer.
 * @param content      Full file contents (UTF-8). This is an overwrite, not an append.
 * @param options.ifChanged When true, read the existing file first and skip the
 *   write (returning `false`) if the bytes are identical — preserving the prior
 *   `writeFileIfChanged` semantics.
 * @returns `true` when bytes were written, `false` when an `ifChanged` write was skipped.
 * @throws {ArchonExportWriteError} on any filesystem failure, with the target attached.
 */
export async function writeArchonExport(
  absolutePath: string,
  content: string,
  options?: { ifChanged?: boolean }
): Promise<boolean> {
  assertArchonExportPath(absolutePath);

  if (options?.ifChanged) {
    try {
      const existing = await readFile(absolutePath, "utf8");
      if (existing === content) {
        emitExportWrite({ targetPath: absolutePath, written: false, byteLength: Buffer.byteLength(content) });
        return false;
      }
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") {
        throw new ArchonExportWriteError(
          `Failed to read existing export before ifChanged write: ${absolutePath}`,
          absolutePath,
          { cause: error }
        );
      }
    }
  }

  const dir = path.dirname(absolutePath);
  const tempPath = buildTempPath(absolutePath);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, absolutePath);
  } catch (error) {
    // Best-effort cleanup of the staging file; never mask the original failure.
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ArchonExportWriteError(
      `Failed to write Archon export: ${absolutePath}`,
      absolutePath,
      { cause: error }
    );
  }

  emitExportWrite({ targetPath: absolutePath, written: true, byteLength: Buffer.byteLength(content) });
  return true;
}

/**
 * Convenience wrapper that resolves a repo-relative path (e.g. `.archon/work/task-queue.json`
 * or `.archon/ACTIVE`) against `cwd` before the atomic write.
 */
export async function writeArchonExportRelative(
  cwd: string,
  relativePath: string,
  content: string,
  options?: { ifChanged?: boolean }
): Promise<boolean> {
  return writeArchonExport(path.resolve(cwd, relativePath), content, options);
}

/**
 * Remove an Archon export file (idempotent — no error if absent). Routes deletes
 * of the export surface through the same guarded module as writes so the "single
 * owner" invariant covers removal too (used by daemon clear-state helpers).
 */
export async function removeArchonExport(absolutePath: string): Promise<void> {
  assertArchonExportPath(absolutePath);
  try {
    await rm(absolutePath, { force: true });
  } catch (error) {
    throw new ArchonExportWriteError(
      `Failed to remove Archon export: ${absolutePath}`,
      absolutePath,
      { cause: error }
    );
  }
}
