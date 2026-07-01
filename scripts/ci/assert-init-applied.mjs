// CI pack-install check: assert `archon init --apply` (run from the compiled bin)
// produced the expected consumer install output and did NOT invoke docker.
//
// Shared verbatim by the unix and windows pack-install legs of
// .github/workflows/ci.yml so the assertions live in ONE place — and so no
// inline heredoc / PowerShell here-string is embedded in the YAML `run:` block
// (a column-0 heredoc/here-string terminator breaks the YAML scalar; this is the
// pattern the workflow repair deliberately eliminated).
//
// Usage: node scripts/ci/assert-init-applied.mjs <target-package.json> <docker-sentinel>
//
// Fails (exit 1) when the target package.json is missing the archon devDependency
// or the archon:migrate script, or when the docker sentinel exists (init invoked
// the stubbed docker, which it must not).

import { existsSync, readFileSync } from "node:fs";

const pkgPath = process.argv[2];
const dockerSentinel = process.argv[3];
if (!pkgPath || !dockerSentinel) {
  console.error("usage: node scripts/ci/assert-init-applied.mjs <package.json> <docker-sentinel>");
  process.exit(2);
}

let failed = false;
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

if (!pkg.devDependencies?.archon) {
  console.error("FAIL: init --apply did not write devDependencies.archon");
  failed = true;
}
if (pkg.scripts?.["archon:migrate"] !== "archon migrate") {
  console.error("FAIL: init --apply did not wire the archon:migrate script");
  failed = true;
}
if (existsSync(dockerSentinel)) {
  console.error("FAIL: init --apply invoked docker — it must not");
  failed = true;
}

if (failed) process.exit(1);
console.log("OK: init --apply wrote devDependencies.archon, archon scripts, and did not invoke docker");
