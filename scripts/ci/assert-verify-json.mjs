// CI pack-install check: assert `archon verify --json` output is valid JSON
// and contains required L1 probes (mcp-archon, mcp-playwright).
//
// This is the CI (compiled-bin) leg of the D-C11 BOTH harness requirement.
// The unit-test leg is in tests/install/verify-json.test.ts.
//
// Shared verbatim by the unix and windows pack-install legs of
// .github/workflows/ci.yml so the assertions live in ONE place.
//
// Usage: node scripts/ci/assert-verify-json.mjs <init-dir>
//
// Reads <init-dir>/verify-json-output.json (written by the CI step that ran
// `node "$BIN" verify --json --target "$INIT_DIR"`), asserts:
//   - report.ok is a boolean
//   - report.blockers, report.advisories, report.nextActions are arrays
//   - report.probes contains an mcp-archon probe
//   - report.probes contains an mcp-playwright probe
//
// Fails (exit 1) on any assertion failure.
// Exits 2 on bad usage or unreadable input.

import path from "node:path";
import { readFileSync } from "node:fs";

const initDir = process.argv[2];
if (!initDir) {
  console.error("usage: node scripts/ci/assert-verify-json.mjs <init-dir>");
  process.exit(2);
}

const outputPath = path.join(initDir, "verify-json-output.json");
let raw;
try {
  raw = readFileSync(outputPath, "utf8");
} catch (e) {
  console.error(
    `FAIL: could not read ${outputPath}: ${e instanceof Error ? e.message : String(e)}`
  );
  process.exit(1);
}

let report;
try {
  report = JSON.parse(raw);
} catch (e) {
  console.error(
    `FAIL: verify --json output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
  );
  process.exit(1);
}

let failed = false;

if (typeof report.ok !== "boolean") {
  console.error(`FAIL: report.ok is ${typeof report.ok}, expected boolean`);
  failed = true;
}
if (!Array.isArray(report.blockers)) {
  console.error("FAIL: report.blockers is not an array");
  failed = true;
}
if (!Array.isArray(report.advisories)) {
  console.error("FAIL: report.advisories is not an array");
  failed = true;
}
if (!Array.isArray(report.nextActions)) {
  console.error("FAIL: report.nextActions is not an array");
  failed = true;
}
if (typeof report.reason !== "string") {
  console.error("FAIL: report.reason is not a string");
  failed = true;
}

if (!Array.isArray(report.probes)) {
  console.error("FAIL: report.probes is not an array");
  failed = true;
} else {
  const capabilities = new Set(report.probes.map((p) => p?.capability));

  if (!capabilities.has("mcp-archon")) {
    console.error(
      "FAIL: report.probes does not contain an mcp-archon L1 probe — " +
        "this proves the #140 class would not be caught by the compiled bin"
    );
    failed = true;
  }
  if (!capabilities.has("mcp-playwright")) {
    console.error(
      "FAIL: report.probes does not contain an mcp-playwright L1 probe"
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log(
  `OK: verify --json report — ok=${report.ok}, probes=${report.probes?.length ?? 0}, ` +
    "mcp-archon and mcp-playwright L1 probes present"
);
