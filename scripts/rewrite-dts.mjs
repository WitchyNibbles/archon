#!/usr/bin/env node
/**
 * rewrite-dts.mjs — post-process TypeScript declaration files (.d.ts) emitted
 * by tsc to rewrite relative `.ts` import/export specifiers to `.js`.
 *
 * TypeScript 5.7 will add --rewriteRelativeImportExtensions for this, but
 * TypeScript 5.6 (our current toolchain) leaves specifiers unchanged in
 * declaration output when allowImportingTsExtensions is set.  Without the
 * rewrite, consumers importing from the published package would see d.ts files
 * that point at .ts paths that do not exist in the tarball.
 *
 * This script mirrors the same regex logic already used in build-dist.mjs for
 * compiled .js files.  It runs immediately after `tsc -p scripts/tsconfig.build-types.json`
 * as part of the `build:types` script.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

/** Recurse a directory, calling cb(filePath) for each file. */
function walkDir(dir, cb) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, cb);
    } else {
      cb(full);
    }
  }
}

/**
 * Rewrite relative `.ts` import/export specifiers to `.js` in a .d.ts file.
 * Handles both `from "..."` and `export * from "..."` forms.  Only rewrites
 * relative specifiers (starting with `./` or `../`) so package imports are
 * left untouched.
 */
function rewriteDtsSpecifiers(code) {
  // from './foo.ts' / from "../bar/baz.ts"
  let out = code.replace(
    /(from\s+['"])(\.{1,2}\/[^'"]*?)\.ts(['"]\s*;?\s*)/g,
    "$1$2.js$3",
  );
  // import type { … } from './foo.ts'  (already covered above, but guard again)
  // re-export via `export * from "./foo.ts"`  (covered)
  return out;
}

let dtsCount = 0;
let rewriteCount = 0;

walkDir(distDir, (filePath) => {
  if (!filePath.endsWith(".d.ts")) return;
  dtsCount++;

  const original = readFileSync(filePath, "utf8");
  const rewritten = rewriteDtsSpecifiers(original);

  if (rewritten !== original) {
    writeFileSync(filePath, rewritten, "utf8");
    rewriteCount++;
  }
});

console.log(`Rewrote .ts specifiers in ${rewriteCount}/${dtsCount} .d.ts files.`);
