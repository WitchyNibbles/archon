// CI pack-install check: assert shipped shell scripts carry no internal-source refs.
//
// Shared by the unix and windows pack-install legs of .github/workflows/ci.yml.
// The dist/ scan (assert-dist-clean.mjs) misses .sh/.ps1 files (they are not
// compiled JS), yet these are exactly the class of bug check-archon-workflow-live.sh
// carried before P1 — a shipped script pointing at node_modules/archon/src.
//
// Usage: node scripts/ci/assert-scripts-clean.mjs <installed-archon-scripts-dir>
//
// Fails (exit 1) when a shipped .sh/.ps1 contains any of:
//   • node_modules/archon/src  — absolute installed-src path (original P1 check)
//   • experimental-strip-types src/  — install shim invoking TS source via strip-types
//     (P4: install-archon.sh/.ps1 must exec the compiled bin, not the TS source;
//      note: "strip-types scripts/..." in check-archon-*.sh is intentional and ok)

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const scriptsDir = process.argv[2];
if (!scriptsDir) {
  console.error("usage: node scripts/ci/assert-scripts-clean.mjs <scripts-dir>");
  process.exit(2);
}

const FORBIDDEN = [
  {
    pattern: /node_modules\/archon\/src/,
    label: "node_modules/archon/src",
  },
  {
    // Catch install shims that invoke TS source via strip-types.
    // "strip-types scripts/..." is intentional in check-archon-*.sh (dev dispatch);
    // "strip-types src/" is never correct in a shipped install shim.
    pattern: /experimental-strip-types\s+\S*src\//,
    label: "experimental-strip-types src/ (install shim invoking TS source)",
  },
];

let failed = false;
for (const name of readdirSync(scriptsDir)) {
  if (!name.endsWith(".sh") && !name.endsWith(".ps1")) continue;
  const content = readFileSync(path.join(scriptsDir, name), "utf8");
  for (const { pattern, label } of FORBIDDEN) {
    if (pattern.test(content)) {
      console.error(`FAIL: ${label} in scripts/${name}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("OK: no forbidden source refs in shipped scripts");
