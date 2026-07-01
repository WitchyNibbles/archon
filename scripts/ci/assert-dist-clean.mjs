// CI pack-install check: assert the installed dist/ tree is clean.
//
// Shared by the unix and windows pack-install legs of .github/workflows/ci.yml
// so the rule lives in ONE place (previously duplicated inline as a bash heredoc
// AND a PowerShell here-string — the here-string broke the workflow YAML because
// its column-0 closing delimiter is incompatible with an indented `run: |` block).
//
// Usage: node scripts/ci/assert-dist-clean.mjs <installed-archon-dist-dir>
//
// Fails (exit 1) when a shipped .js file contains:
//   1. "--experimental-strip-types" adjacent to "node_modules" — the specific bug
//      pattern P1 fixed (installer writing old-form scripts that invoke archon via
//      node --experimental-strip-types pointing at installed source). Plain string
//      literals in usage messages / consumer-local .ts templates are fine.
//   2. a relative ".ts" import specifier — confirms the esbuild rewrite ran.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/ci/assert-dist-clean.mjs <dist-dir>");
  process.exit(2);
}

const files = walk(target);
// Matches strip-types combined with node_modules — the original bug pattern.
const stripTypesNodeModules = /--experimental-strip-types[^'"\n]*node_modules/;
// Matches relative .ts import specifiers (the build rewrite must have removed these).
const tsDotImport = /from ['"]\..*\.ts['"]/m;

let failed = false;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (stripTypesNodeModules.test(src)) {
    console.error("FAIL: --experimental-strip-types+node_modules in " + f);
    failed = true;
  }
  if (tsDotImport.test(src)) {
    console.error("FAIL: .ts import specifier in " + f);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("OK: dist tree is clean (" + files.length + " .js files checked)");
