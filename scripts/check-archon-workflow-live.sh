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
  local source_cli="$repo_root/src/admin/archon.ts"
  if [[ -f "$source_cli" ]]; then
    printf '%s\n' "$source_cli"
    return
  fi

  local installed_cli="$repo_root/node_modules/archon/src/admin/archon.ts"
  if [[ -f "$installed_cli" ]]; then
    printf '%s\n' "$installed_cli"
    return
  fi

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
const cliPath = path.join(resolvedRoot, "src", "admin", "archon.ts");

if (existsSync(cliPath)) {
  process.stdout.write(`${cliPath}\n`);
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
  node --experimental-strip-types "$archon_cli" workflow-proof --task-id "$requested_task_id" --run-id latest --format json
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
    node --experimental-strip-types "$archon_cli" status --run-id "$proof_run_id" --format json
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

node --experimental-strip-types "$repo_root/scripts/check-archon-workflow.ts" --live --external-review-authority --repo-root "$repo_root" --task-id "$requested_task_id"
