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

if [[ -z "$requested_task_id" ]]; then
  active_file="$repo_root/.archon/ACTIVE"
  [[ -f "$active_file" ]] || {
    printf 'missing active workflow file: %s\n' "${active_file#"$repo_root"/}" >&2
    printf 'pass --task-id <fixture-task-id> for synthetic install fixtures\n' >&2
    exit 1
  }

  requested_task_id="$(awk -F= '$1 == "task_id" { print $2; exit }' "$active_file")"
  requested_task_id="${requested_task_id%$'\r'}"
  [[ -n "$requested_task_id" ]] || {
    printf 'active workflow file lacks task_id: %s\n' "${active_file#"$repo_root"/}" >&2
    exit 1
  }
fi

brief_file="$repo_root/.archon/work/briefs/brief-${requested_task_id}.md"
task_file="$repo_root/.archon/work/tasks/task-${requested_task_id}.md"
review_dir="$repo_root/.archon/work/reviews"
active_file="$repo_root/.archon/ACTIVE"

require_file() {
  local file_path="$1"
  [[ -f "$file_path" ]] || {
    printf 'missing required fixture file: %s\n' "${file_path#"$repo_root"/}" >&2
    exit 1
  }
}

require_contains() {
  local file_path="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file_path"; then
    printf 'fixture check failed: expected %s in %s\n' "$expected" "${file_path#"$repo_root"/}" >&2
    exit 1
  fi
}

printf 'synthetic fixture check\n'
[[ "$requested_task_id" == fixture-* ]] || {
  printf 'happy-path fixture task ids must start with fixture-: %s\n' "$requested_task_id" >&2
  exit 1
}

require_file "$brief_file"
require_file "$task_file"
require_contains "$brief_file" "Synthetic install-proof only"
require_contains "$task_file" "fixture remains synthetic and non-authoritative"

if [[ -f "$active_file" ]] && grep -Fq "task_id=$requested_task_id" "$active_file"; then
  printf 'synthetic fixture must not become the active workflow task: %s\n' "${active_file#"$repo_root"/}" >&2
  exit 1
fi

for role in reviewer qa_engineer security_reviewer; do
  review_file="$review_dir/review-${requested_task_id}-${role}.md"
  require_file "$review_file"
  require_contains "$review_file" '`summary_only`'
  require_contains "$review_file" '`blocked`'
  require_contains "$review_file" 'Synthetic install fixture only'
  if grep -Fq 'Runtime proof:' "$review_file"; then
    printf 'synthetic fixture review must not claim runtime proof: %s\n' "${review_file#"$repo_root"/}" >&2
    exit 1
  fi
done

bindings_file="$repo_root/.archon/review-identity-bindings.json"
adapter_file="$repo_root/archon/review-identity-adapter.ts"
workflow_export_file="$repo_root/scripts/check-archon-workflow.sh"
package_file="$repo_root/package.json"
playwright_config_file="$repo_root/.archon/playwright/mcp.json"
playwright_vision_config_file="$repo_root/.archon/playwright/mcp.vision.json"

[[ -f "$bindings_file" ]] || {
  printf 'bad review identity bindings export: missing %s\n' "${bindings_file#"$repo_root"/}" >&2
  exit 1
}
require_contains "$bindings_file" 'replace-with-authenticated-user-id'

[[ -f "$adapter_file" ]] || {
  printf 'missing review identity adapter scaffold: %s\n' "${adapter_file#"$repo_root"/}" >&2
  exit 1
}
require_contains "$adapter_file" 'Implement archon/review-identity-adapter.ts'

[[ -f "$workflow_export_file" ]] || {
  printf 'stale install export missing: %s\n' "${workflow_export_file#"$repo_root"/}" >&2
  exit 1
}

[[ -f "$playwright_config_file" ]] || {
  printf 'missing Playwright MCP config export: %s\n' "${playwright_config_file#"$repo_root"/}" >&2
  exit 1
}

[[ -f "$playwright_vision_config_file" ]] || {
  printf 'missing Playwright vision MCP config export: %s\n' "${playwright_vision_config_file#"$repo_root"/}" >&2
  exit 1
}

require_contains "$package_file" 'archon:check:happy-path'
if ! grep -Fq 'archon:verify:setup' "$package_file"; then
  printf 'incomplete archon setup: package.json lacks archon:verify:setup\n' >&2
  exit 1
fi
if ! grep -Fq 'archon:setup:playwright' "$package_file"; then
  printf 'incomplete archon setup: package.json lacks archon:setup:playwright\n' >&2
  exit 1
fi
if ! grep -Fq 'archon:verify:playwright' "$package_file"; then
  printf 'incomplete archon setup: package.json lacks archon:verify:playwright\n' >&2
  exit 1
fi

printf 'retrieval advisory smoke (derived, non-authoritative)\n'
retrieval_eval="$repo_root/src/evals/retrieval-memory-baseline.ts"
if [[ ! -f "$retrieval_eval" ]]; then
  printf 'derived retrieval baseline skipped: eval surface unavailable at %s\n' "${retrieval_eval#"$repo_root"/}"
  printf 'archon happy-path checks passed\n'
  exit 0
fi

(
  cd "$repo_root"
  node --experimental-strip-types --input-type=module <<'EOF'
import process from "node:process";
import { runRetrievalMemoryBaseline } from "./src/evals/retrieval-memory-baseline.ts";

const report = await runRetrievalMemoryBaseline();
const { failedCases, passedCases, totalCases } = report.summary;

if (failedCases !== 0) {
  console.error(
    `derived retrieval baseline failed: ${failedCases}/${totalCases} cases failed`
  );
  process.exit(1);
}

console.log(
  `derived retrieval baseline passed: ${passedCases}/${totalCases} cases passed`
);
EOF
)

printf 'archon happy-path checks passed\n'
