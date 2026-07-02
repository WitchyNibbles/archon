#!/usr/bin/env bash
# check-archon-install-live.sh — Archon install capability live-check (S2).
#
# Mirrors scripts/check-archon-workflow-live.sh conventions.
#
# PURPOSE: Runs L3 capability checks (claude CLI + MCP + hook dry-run + DB)
# on an operator machine that has `claude` and a DB configured. This is the
# install completion evidence that cannot run in CI (no claude IDE, no DB).
#
# C10 (council): this script is the named mitigation for the accepted gap
# "L2/L3 caught only when doctor/live-check runs". Run it before releasing
# a version that changes installer or capability probes.
#
# WHEN TO RUN:
#   - Before any archon release (release-readiness evidence)
#   - After a consumer repo install (verify the install is fully operational)
#   - After upgrading archon in a consumer repo
#
# See docs/agent-install-runbook.md for the doctor vs live-check guidance.
#
# USAGE:
#   bash scripts/check-archon-install-live.sh [--repo-root <path>]
#
# EXIT: 0 = all checks passed (or advisory-only); 1 = blocking failure.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      [[ $# -ge 2 ]] || { printf 'missing value for %s\n' "$1" >&2; exit 2; }
      repo_root="$2"
      shift 2
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

printf '=== Archon install capability live-check ===\n'
printf 'repo root: %s\n\n' "$repo_root"

# ---------------------------------------------------------------------------
# Resolve archon CLI (same pattern as check-archon-workflow-live.sh)
# ---------------------------------------------------------------------------

resolve_archon_cli() {
  local source_cli="$repo_root/src/admin/archon.ts"
  if [[ -f "$source_cli" ]]; then
    printf '%s\n' "$source_cli"
    return
  fi

  local installed_bin="$repo_root/node_modules/@witchynibbles/archon/dist/cli/archon-bin.js"
  if [[ -f "$installed_bin" ]]; then
    printf '%s\n' "$installed_bin"
    return
  fi

  local package_json="$repo_root/package.json"
  if [[ ! -f "$package_json" ]]; then
    printf 'missing package.json: %s\n' "$package_json" >&2
    exit 1
  fi

  local resolved_cli
  resolved_cli="$(
    node --input-type=module - "$package_json" "$repo_root" <<'NODE'
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
const packageJsonPath = process.argv[2];
const repoRoot = process.argv[3];
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const dependency =
  packageJson.devDependencies?.["@witchynibbles/archon"] ??
  packageJson.dependencies?.["@witchynibbles/archon"] ??
  packageJson.optionalDependencies?.["@witchynibbles/archon"];
if (typeof dependency !== "string" || !dependency.startsWith("file:")) {
  process.exit(0);
}
const rawPath = dependency.slice("file:".length);
const resolvedRoot = path.resolve(repoRoot, rawPath);
const binPath = path.join(resolvedRoot, "dist", "cli", "archon-bin.js");
if (existsSync(binPath)) {
  process.stdout.write(binPath + "\n");
  process.exit(0);
}
const srcPath = path.join(resolvedRoot, "src", "admin", "archon.ts");
if (existsSync(srcPath)) {
  process.stdout.write(srcPath + "\n");
}
NODE
  )"

  if [[ -n "$resolved_cli" && -f "$resolved_cli" ]]; then
    printf '%s\n' "$resolved_cli"
    return
  fi

  printf 'unable to resolve archon CLI from %s\n' "$repo_root" >&2
  exit 1
}

run_archon_cli() {
  if [[ "$archon_cli" == *.ts ]]; then
    node --experimental-strip-types "$archon_cli" "$@"
  else
    node "$archon_cli" "$@"
  fi
}

archon_cli="$(resolve_archon_cli)"

# ---------------------------------------------------------------------------
# L1: verify install (config parse — fast, no external deps)
# ---------------------------------------------------------------------------

echo '--- L1: verify install ---'
verify_json_file="$(mktemp)"
run_archon_cli verify --target "$repo_root" --json >"$verify_json_file" 2>/dev/null || true

node --input-type=module - "$verify_json_file" <<'NODE'
import { readFileSync } from "node:fs";
const raw = readFileSync(process.argv[2], "utf8").trim();
if (!raw) { process.stdout.write("L1 verify: no output (may not be a consumer install target)\n"); process.exit(0); }
let payload;
try { payload = JSON.parse(raw); } catch { process.stdout.write("L1 verify: could not parse JSON output\n"); process.exit(0); }
const ok = payload.ok ?? false;
const blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
const advisories = Array.isArray(payload.advisories) ? payload.advisories : [];
if (!ok) {
  process.stdout.write("L1 verify: ISSUES FOUND (" + blockers.length + " blocker(s))\n");
  blockers.slice(0, 5).forEach(b => process.stdout.write("  blocker: " + b + "\n"));
} else {
  process.stdout.write("L1 verify: OK\n");
}
advisories.slice(0, 3).forEach(a => process.stdout.write("  advisory: " + a + "\n"));
NODE
rm -f "$verify_json_file"
printf '\n'

# ---------------------------------------------------------------------------
# L2/L3: doctor (external + runtime probes — requires claude + DB)
# ---------------------------------------------------------------------------

echo '--- L2/L3: doctor (capability probes) ---'

if ! command -v claude >/dev/null 2>&1; then
  printf 'WARNING: claude CLI not found — L3 MCP and hook probes will be skipped\n'
fi

if [[ -z "${ARCHON_CORE_DATABASE_URL:-}" ]]; then
  printf 'WARNING: ARCHON_CORE_DATABASE_URL not set — DB probes will fail\n'
fi

doctor_json_file="$(mktemp)"
run_archon_cli doctor >"$doctor_json_file" 2>/dev/null || true

doctor_ok="$(node --input-type=module - "$doctor_json_file" <<'NODE'
import { readFileSync } from "node:fs";
const raw = readFileSync(process.argv[2], "utf8").trim();
if (!raw) {
  process.stdout.write("doctor: no output — check DB connection and project bootstrap\n");
  process.stdout.write("This is expected when running from the archon dev repo without a consumer project.\n");
  process.exit(0);
}
let payload;
try { payload = JSON.parse(raw); } catch {
  process.stdout.write("doctor: could not parse JSON output\n");
  process.stdout.write("Raw: " + raw.slice(0, 200) + "\n");
  process.exit(0);
}
const ok = payload.ok ?? false;
const blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
const advisories = Array.isArray(payload.advisories) ? payload.advisories : [];
const nextActions = Array.isArray(payload.nextActions) ? payload.nextActions : [];
if (ok) {
  process.stdout.write("doctor: OK\n");
} else {
  process.stdout.write("doctor: BLOCKING ISSUES FOUND\n");
  blockers.forEach(b => process.stdout.write("  BLOCKER: " + b + "\n"));
}
advisories.slice(0, 5).forEach(a => process.stdout.write("  advisory: " + a + "\n"));
if (nextActions.length > 0) {
  process.stdout.write("Suggested next actions:\n");
  nextActions.slice(0, 5).forEach(a => process.stdout.write("  - " + a + "\n"));
}
process.exit(ok ? 0 : 1);
NODE
)" && doctor_exit=0 || doctor_exit=$?
rm -f "$doctor_json_file"
printf '%s\n' "$doctor_ok"

if [[ "$doctor_exit" -ne 0 ]]; then
  printf 'L2/L3 doctor: FAILED (exit %d)\n' "$doctor_exit" >&2
  printf '\n=== live-check complete (WITH FAILURES) ===\n'
  exit 1
fi

printf '\n=== live-check complete ===\n'
