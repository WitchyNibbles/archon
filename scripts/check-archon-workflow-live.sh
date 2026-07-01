#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
requested_task_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      [[ $# -ge 2 ]] || { printf 'missing value for %s\n' "$1" >&2; exit 2; }
      repo_root="$2"
      shift 2
      ;;
    --task-id)
      [[ $# -ge 2 ]] || { printf 'missing value for %s\n' "$1" >&2; exit 2; }
      requested_task_id="$2"
      shift 2
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

resolve_archon_cli() {
  # Branch 1 — archon DEV repo (this repo's own src/ is present).
  # Keeps --experimental-strip-types; test/dev cycle stays on TS sources.
  local source_cli="$repo_root/src/admin/archon.ts"
  if [[ -f "$source_cli" ]]; then
    printf '%s\n' "$source_cli"
    return
  fi

  # Branch 2 — consumer / installed (archon is in node_modules).
  # Resolve the compiled bin — no --experimental-strip-types needed.
  # dist/cli/archon-bin.js is guaranteed to exist in any P1+ published package.
  local installed_bin="$repo_root/node_modules/archon/dist/cli/archon-bin.js"
  if [[ -f "$installed_bin" ]]; then
    printf '%s\n' "$installed_bin"
    return
  fi

  # Branch 3 — file: dependency (linked local package).
  # Prefer compiled bin if it exists; fall back to TS source for linked dev packages.
  local package_json="$repo_root/package.json"
  if [[ ! -f "$package_json" ]]; then
    printf 'missing package.json for archon CLI resolution: %s\n' "${package_json#"$repo_root"/}" >&2
    exit 1
  fi

  local resolved_cli=""
  resolved_cli="$(
    node --input-type=module - "$package_json" "$repo_root" <<'EOF'
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const packageJsonPath = process.argv[2];
const repoRoot = process.argv[3];
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const dependency =
  packageJson.devDependencies?.archon ??
  packageJson.dependencies?.archon ??
  packageJson.optionalDependencies?.archon;

if (typeof dependency !== "string" || !dependency.startsWith("file:")) {
  process.exit(0);
}

const rawPath = dependency.slice("file:".length);
const resolvedRoot = path.resolve(repoRoot, rawPath);

// Prefer the compiled bin over the TS source for file: dependencies too.
const binPath = path.join(resolvedRoot, "dist", "cli", "archon-bin.js");
if (existsSync(binPath)) {
  process.stdout.write(`${binPath}\n`);
  process.exit(0);
}
const srcPath = path.join(resolvedRoot, "src", "admin", "archon.ts");
if (existsSync(srcPath)) {
  process.stdout.write(`${srcPath}\n`);
}
EOF
  )"

  if [[ -n "$resolved_cli" && -f "$resolved_cli" ]]; then
    printf '%s\n' "$resolved_cli"
    return
  fi

  printf 'unable to resolve archon CLI for runtime workflow proof from %s\n' "$repo_root" >&2
  exit 1
}

# Invoke the resolved archon CLI with the correct node flags.
# Compiled .js bin: plain "node" (no strip-types flag needed).
# TS source (.ts): "node --experimental-strip-types" (dev / archon-own-repo path).
run_archon_cli() {
  if [[ "$archon_cli" == *.ts ]]; then
    node --experimental-strip-types "$archon_cli" "$@"
  else
    node "$archon_cli" "$@"
  fi
}

if [[ -z "$requested_task_id" ]]; then
  active_file="$repo_root/.archon/ACTIVE"
  [[ -f "$active_file" ]] || {
    printf 'missing active workflow file: %s\n' "${active_file#"$repo_root"/}" >&2
    exit 1
  }

  active_state="$(awk -F= '$1 == "state" { print $2; exit }' "$active_file")"
  active_state="${active_state%$'\r'}"
  requested_task_id="$(awk -F= '$1 == "task_id" { print $2; exit }' "$active_file")"
  requested_task_id="${requested_task_id%$'\r'}"

  if [[ "$active_state" == "idle" && -z "$requested_task_id" ]]; then
    printf '%s\n' '{"status":"idle","message":"archon workflow is idle; no active task to verify. Pass --task-id <task-id> to verify a specific task explicitly."}'
    exit 0
  fi

  [[ -n "$requested_task_id" ]] || {
    printf 'active workflow file lacks task_id: %s\n' "${active_file#"$repo_root"/}" >&2
    exit 1
  }
fi

archon_cli="$(resolve_archon_cli)"
workflow_proof_json="$(
  run_archon_cli workflow-proof --task-id "$requested_task_id" --run-id latest --format json
)"

proof_run_id="$(
  node --input-type=module - "$workflow_proof_json" <<'EOF'
const payload = JSON.parse(process.argv[2]);
if (typeof payload?.runId === "string" && payload.runId.length > 0) {
  process.stdout.write(`${payload.runId}\n`);
}
EOF
)"

if [[ -n "$proof_run_id" ]]; then
  status_json="$(
    run_archon_cli status --run-id "$proof_run_id" --format json
  )"
  node --input-type=module - "$status_json" <<'EOF'
const payload = JSON.parse(process.argv[2]);
const integrity = payload?.integrity;

if (!integrity || typeof integrity !== "object") {
  process.exit(0);
}

const contradictions = Array.isArray(integrity.contradictions)
  ? integrity.contradictions.filter((item) => typeof item === "string" && item.length > 0)
  : [];

if (integrity.status === "contradicted" || contradictions.length > 0) {
  const summary = contradictions.length > 0 ? contradictions.join("; ") : "runtime integrity is contradicted";
  process.stderr.write(`live workflow integrity contradicted after authoritative proof: ${summary}\n`);
  process.exit(1);
}

const seedFailure = integrity.runtimeState?.seedFailure;
if (seedFailure?.recoveryState === "stale_metadata") {
  process.stderr.write(
    `live workflow integrity contradicted after authoritative proof: stale persisted seed failure metadata for ${seedFailure.taskId ?? "unknown task"}\n`
  );
  process.exit(1);
}
EOF
fi

# EXPLICIT RESIDUAL: scripts/check-archon-workflow.ts is a consumer-local file
# (copied by the installer into the consuming repo's scripts/ directory — it is
# NOT part of node_modules/archon/).  It runs via --experimental-strip-types
# because it is a TypeScript file that lives in the consumer's own tree.
# This is intentional and does NOT reproduce the P1 bug (which was invoking
# archon's OWN src from node_modules via strip-types).
# Node 23.6+ does not require the flag; Node 22 consumers need it.
# Follow-up owner: infra_engineer — migrate if archon bin ever exposes a
# compiled path for this check, or when Node 22 LTS is dropped.
node --experimental-strip-types "$repo_root/scripts/check-archon-workflow.ts" --live --external-review-authority --repo-root "$repo_root" --task-id "$requested_task_id"
