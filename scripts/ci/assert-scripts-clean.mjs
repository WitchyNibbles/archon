// CI pack-install check: assert shipped shell scripts carry no internal-source refs.
//
// Shared by the unix and windows pack-install legs of .github/workflows/ci.yml.
// The dist/ scan (assert-dist-clean.mjs) misses .sh/.ps1 files (they are not
// compiled JS), yet these are exactly the class of bug check-archon-workflow-live.sh
// carried before P1 — a shipped script pointing at node_modules/archon/src.
//
// Usage: node scripts/ci/assert-scripts-clean.mjs <installed-archon-scripts-dir>
//
// Fails (exit 1) when a shipped .sh/.ps1 references node_modules/archon/src.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const scriptsDir = process.argv[2];
if (!scriptsDir) {
  console.error("usage: node scripts/ci/assert-scripts-clean.mjs <scripts-dir>");
  process.exit(2);
}

let failed = false;
for (const name of readdirSync(scriptsDir)) {
  if (!name.endsWith(".sh") && !name.endsWith(".ps1")) continue;
  const content = readFileSync(path.join(scriptsDir, name), "utf8");
  if (/node_modules\/archon\/src/.test(content)) {
    console.error("FAIL: node_modules/archon/src in scripts/" + name);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("OK: no node_modules/archon/src in shipped scripts");
