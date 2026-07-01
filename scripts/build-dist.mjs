#!/usr/bin/env node
/**
 * build-dist.mjs — Spike build script for archon compiled-package approach.
 *
 * Strategy: esbuild per-file transform (no bundling) + specifier rewrite.
 *
 * Why esbuild over tsc/swc/oxc:
 *  - tsc: noEmit + allowImportingTsExtensions = cannot emit; separate build tsconfig
 *    would still reject the 604 .ts specifiers under NodeNext resolution.
 *  - swc: strips types but does NOT rewrite .ts→.js import specifiers in transform mode.
 *  - oxc: same gap; transform mode leaves specifiers alone.
 *  - esbuild transform: strips types, removes `import type`, preserves specifiers as-is,
 *    is already in devDependencies (via tsx). We post-process specifiers in one pass.
 *
 * Directory structure: src/**\/*.ts → dist/**\/*.js  (outbase=src preserved)
 * SQL assets: src/sql/**  → dist/sql/**  (copied verbatim)
 */

import * as esbuild from "../node_modules/esbuild/lib/main.js";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcDir = path.join(repoRoot, "src");
const distDir = path.join(repoRoot, "dist");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Rewrite relative `.ts` import/export specifiers to `.js` in the already-
 * transpiled JS source.  Only matches relative paths (`./…` or `../…`) so
 * that bare specifiers and the one `from "archon/src/index.ts"` template
 * string in cli.ts (code-gen text, not a live import) are left untouched.
 */
function rewriteTsSpecifiers(code) {
  // Static: from "./foo.ts" or from '../bar/baz.ts'
  let out = code.replace(
    /(from\s+['"])(\.{1,2}\/[^'"]*?)\.ts(['"]\s*;?\s*)/g,
    "$1$2.js$3",
  );
  // Dynamic runtime: await import("./foo.ts")
  out = out.replace(
    /(import\s*\(\s*['"])(\.{1,2}\/[^'"]*?)\.ts(['"]\s*\))/g,
    "$1$2.js$3",
  );
  return out;
}

// ---------------------------------------------------------------------------
// Step 1: Transpile src/**/*.ts → dist/**/*.js
// ---------------------------------------------------------------------------

let tsFiles = 0;
let errorCount = 0;

walkDir(srcDir, (filePath) => {
  if (!filePath.endsWith(".ts")) return;

  const relative = path.relative(srcDir, filePath); // e.g. admin/db.ts
  const outRelative = relative.replace(/\.ts$/, ".js");
  const outPath = path.join(distDir, outRelative);

  const source = readFileSync(filePath, "utf8");

  let transformed;
  try {
    const result = esbuild.transformSync(source, {
      loader: "ts",
      format: "esm",
      // Keep the shebang line so dist/cli/archon-bin.js stays executable
      // esbuild preserves shebangs at the top of the file by default.
    });
    transformed = result.code;
  } catch (err) {
    console.error(`ERROR transforming ${relative}:`, err.message);
    errorCount++;
    return;
  }

  const rewritten = rewriteTsSpecifiers(transformed);

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, rewritten, "utf8");
  tsFiles++;
});

console.log(`Transpiled ${tsFiles} .ts files to dist/ (${errorCount} errors)`);
if (errorCount > 0) process.exit(1);

// ---------------------------------------------------------------------------
// Step 2: Copy src/sql/** → dist/sql/**
// ---------------------------------------------------------------------------

const sqlSrc = path.join(srcDir, "sql");
const sqlDst = path.join(distDir, "sql");
let sqlFiles = 0;

walkDir(sqlSrc, (filePath) => {
  const relative = path.relative(sqlSrc, filePath);
  const outPath = path.join(sqlDst, relative);
  mkdirSync(path.dirname(outPath), { recursive: true });
  copyFileSync(filePath, outPath);
  sqlFiles++;
});

console.log(`Copied ${sqlFiles} SQL files to dist/sql/`);

// ---------------------------------------------------------------------------
// Step 3: Make the bin entry executable
// ---------------------------------------------------------------------------

const binPath = path.join(distDir, "cli", "archon-bin.js");
try {
  chmodSync(binPath, 0o755);
  console.log(`Set +x on dist/cli/archon-bin.js`);
} catch (err) {
  console.warn(`Warning: could not chmod ${binPath}: ${err.message}`);
}

console.log("build:dist complete.");
