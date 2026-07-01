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
//
// Input trust (owner: infra_engineer): this is a CI-internal helper. Both args are
// hardcoded in the .github/workflows/ci.yml `run:` steps (temp paths minted in the
// same step); no external/untrusted input reaches it and its only output is a
// pass/fail exit code. A defensive basename check on the package path is applied
// below; no further path sandboxing is warranted for this CI-only surface.

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const pkgPath = process.argv[2];
const dockerSentinel = process.argv[3];
if (!pkgPath || !dockerSentinel) {
  console.error("usage: node scripts/ci/assert-init-applied.mjs <package.json> <docker-sentinel>");
  process.exit(2);
}
if (path.basename(pkgPath) !== "package.json") {
  console.error(`assert-init-applied: expected a package.json path, got ${pkgPath}`);
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
