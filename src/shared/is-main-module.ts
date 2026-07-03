/**
 * isMainModule — portable ESM entrypoint guard.
 *
 * Replaces fragile `process.argv[1].endsWith("src/mcp/server.ts")` patterns
 * that break when the file is transpiled to dist/*.js.
 *
 * Algorithm: compare realpathSync(process.argv[1]) against
 * realpathSync(fileURLToPath(importMetaUrl)).  Both sides are resolved through
 * symlinks so the comparison works whether the file is run directly or via a
 * symlinked bin entry.
 *
 * Usage in callers:
 *   import { isMainModule } from "../shared/is-main-module.ts";
 *   if (isMainModule(import.meta.url)) { startServer().catch(...); }
 *
 * Returns false (never throws) when:
 *   - process.argv[1] is absent or falsy
 *   - importMetaUrl is not a valid file:// URL
 *   - realpathSync fails (e.g. file does not exist on disk yet)
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

export function isMainModule(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    const argv1Real = realpathSync(process.argv[1]);
    const selfReal = realpathSync(fileURLToPath(importMetaUrl));
    return argv1Real === selfReal;
  } catch {
    return false;
  }
}
