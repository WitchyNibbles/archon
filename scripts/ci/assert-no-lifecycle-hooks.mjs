// CI pack-install check: assert the shipped package.json has no install lifecycle hooks.
//
// Shared by the unix and windows pack-install legs of .github/workflows/ci.yml.
// A published archon must NOT run code on install (postinstall/install/preinstall)
// — the installer writes hooks/CLAUDE.md/MCP into consumers explicitly via
// `archon init`, never silently on `npm install`.
//
// Usage: node scripts/ci/assert-no-lifecycle-hooks.mjs <installed-archon-package.json>
//
// Fails (exit 1) when package.json declares a forbidden lifecycle script.

import { readFileSync } from "node:fs";

const pkgPath = process.argv[2];
if (!pkgPath) {
  console.error("usage: node scripts/ci/assert-no-lifecycle-hooks.mjs <package.json>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
// Also guard prepare (runs on git-URL installs), prepack, and postpack.
for (const h of ["postinstall", "install", "preinstall", "prepare", "prepack", "postpack"]) {
  if (pkg.scripts?.[h]) {
    console.error("FAIL: forbidden lifecycle hook: " + h);
    process.exit(1);
  }
}
console.log("OK: no lifecycle install hooks");
