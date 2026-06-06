#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "${ARCHON_ALLOW_MANAGED_COMMITS:-}" == "1" ]]; then
  exit 0
fi

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "archon git guard requires a git repository" >&2
  exit 1
fi

mapfile -t staged_files < <(git diff --cached --name-only --diff-filter=ACMR | sed '/^$/d')

if [[ "${#staged_files[@]}" -eq 0 ]]; then
  exit 0
fi

matches_blocked_path() {
  local staged_path="$1"
  local blocked_path="$2"

  if [[ "$blocked_path" == */ ]]; then
    [[ "$staged_path" == "$blocked_path"* ]]
    return
  fi

  [[ "$staged_path" == "$blocked_path" || "$staged_path" == "$blocked_path/"* ]]
}

fallback_blocked_paths=(
  "AGENTS.md"
  ".agents/"
  ".codex/"
  ".archon/rules/"
  ".archon/templates/"
  ".archon/review-identity-bindings.json"
  ".archon/review-identity-adapter.fixture.json"
  "archon/review-identity-adapter.ts"
  ".env.archon.example"
  "docker-compose.archon.yml"
  "scripts/check-archon-happy-path.sh"
  "scripts/check-archon-workflow.sh"
  "scripts/check-archon-workflow-live.sh"
  "scripts/check-archon-git-guard.sh"
  "scripts/check-archon-commit-msg.sh"
  "scripts/archon-setup.sh"
  "scripts/archon-setup.ps1"
  ".githooks/"
)

generated_blocked_paths=(
  ".archon/install-manifest.json"
  ".archon/install-backups/"
  ".archon/runtime/"
)

manifest_path=".archon/install-manifest.json"
blocked_paths=()

if [[ -f "$manifest_path" ]]; then
  mapfile -t blocked_paths < <(
    node --input-type=module <<'EOF_NODE'
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(".archon/install-manifest.json", "utf8"));
const files = Array.isArray(manifest.files) ? manifest.files : [];

for (const entry of files) {
  if (entry && typeof entry.target === "string") {
    console.log(entry.target.replace(/\\/g, "/"));
  }
}
EOF_NODE
  )
else
  blocked_paths=("${fallback_blocked_paths[@]}")
fi

blocked_paths+=("${generated_blocked_paths[@]}")

declare -A seen_paths=()
unique_blocked_paths=()
for blocked_path in "${blocked_paths[@]}"; do
  if [[ -n "$blocked_path" && -z "${seen_paths[$blocked_path]:-}" ]]; then
    unique_blocked_paths+=("$blocked_path")
    seen_paths["$blocked_path"]=1
  fi
done

blocked_staged_files=()
for staged_file in "${staged_files[@]}"; do
  for blocked_path in "${unique_blocked_paths[@]}"; do
    if matches_blocked_path "$staged_file" "$blocked_path"; then
      blocked_staged_files+=("$staged_file")
      break
    fi
  done
done

if [[ "${#blocked_staged_files[@]}" -eq 0 ]]; then
  exit 0
fi

echo "archon git guard blocked managed control-layer files in this commit:" >&2
for blocked_file in "${blocked_staged_files[@]}"; do
  echo "  - $blocked_file" >&2
done
echo >&2
echo "Use the git operator for normal product commits." >&2
echo "If this commit intentionally maintains the archon overlay, rerun with:" >&2
echo "  ARCHON_ALLOW_MANAGED_COMMITS=1 git commit ..." >&2
exit 1
