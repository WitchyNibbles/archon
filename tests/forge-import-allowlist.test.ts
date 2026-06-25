/**
 * CC-15 second-layer guard — forge import ALLOWLIST.
 *
 * The eslint `no-restricted-imports` rule for `src/forge/**` is a DENYLIST: it enumerates the
 * sibling `src/` zones that must not be imported. A denylist cannot catch a NEW top-level
 * `src/<foo>/` directory added in the future. This test is the complete second layer: it parses
 * every static import/export-from specifier in `src/forge/**` and asserts each resolves ONLY to
 * the allowed set — `src/forge/**`, `src/domain/**`, `zod`, or a `node:` built-in. Any other
 * import (current or future) fails here, keeping the shipped package surface self-contained
 * (CC-14/CC-15/X-1) for cross-repo consumers.
 *
 * Scope note: this guard covers STATIC `import`/`export ... from` specifiers (and side-effect
 * `import "x"`). Dynamic `import()` expressions have no `from` clause and are NOT scanned — this is
 * a deliberate, currently-moot gap (zero dynamic imports exist in `src/forge/`). If dynamic imports
 * are ever introduced here, extend `extractImportSpecifiers` to cover them.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-import-allowlist.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forgeDir = path.join(repoRoot, "src", "forge");
const domainDir = path.join(repoRoot, "src", "domain");

/** Recursively list all .ts files under a directory. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract every import/export-from specifier. Anchored to a line-starting `import`/`export`
 * (multi-line import lists allowed) and the `[^;'"]` class stops the match before any string
 * literal, so a `from "x"` appearing INSIDE a string/goal literal is never mistaken for an import.
 */
function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // import|export [type] {...}|* as x|name from "x";  (covers single- and multi-line)
  const fromRe = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s+["']([^"']+)["']/gm;
  // side-effect import: import "x";
  const sideEffectRe = /^\s*import\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source)) !== null) specs.push(m[1]!);
  while ((m = sideEffectRe.exec(source)) !== null) specs.push(m[1]!);
  return specs;
}

/** True when a specifier is in the forge allowlist, resolved relative to `fileDir`. */
function isAllowed(spec: string, fileDir: string): boolean {
  // node: built-ins and the single permitted runtime dep.
  if (spec === "zod" || spec.startsWith("node:")) return true;
  // Bare (non-relative, non-node) specifiers are disallowed — forge ships with zero deps but zod.
  if (!spec.startsWith(".")) return false;
  // Relative: resolve and require it to land under src/forge or src/domain.
  const resolved = path.resolve(fileDir, spec);
  return (
    resolved === forgeDir ||
    resolved.startsWith(forgeDir + path.sep) ||
    resolved === domainDir ||
    resolved.startsWith(domainDir + path.sep)
  );
}

describe("CC-15 forge import allowlist (src/forge/** stays self-contained)", () => {
  const files = listTsFiles(forgeDir);

  it("finds forge source files to scan", () => {
    assert.ok(files.length > 0, "expected at least one src/forge/*.ts file");
  });

  it("every src/forge import resolves only to {src/forge, src/domain, zod, node:*}", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      const fileDir = path.dirname(file);
      for (const spec of extractImportSpecifiers(source)) {
        if (!isAllowed(spec, fileDir)) {
          violations.push(`${path.relative(repoRoot, file)} → "${spec}"`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Forbidden src/forge imports (outside src/forge|src/domain|zod|node:):\n${violations.join("\n")}`
    );
  });

  it("the allowlist check actually rejects a service-coupled import (non-vacuous)", () => {
    // Probe: a forge file importing src/core must be classified as NOT allowed.
    assert.equal(isAllowed("../core/service.ts", forgeDir), false);
    assert.equal(isAllowed("../store/postgres/tasks.ts", forgeDir), false);
    assert.equal(isAllowed("../../web/src/app.tsx", forgeDir), false);
    // And the genuinely-allowed cases pass.
    assert.equal(isAllowed("./constraints-manifest.ts", forgeDir), true);
    assert.equal(isAllowed("../domain/types.ts", forgeDir), true);
    assert.equal(isAllowed("zod", forgeDir), true);
    assert.equal(isAllowed("node:crypto", forgeDir), true);
  });
});
