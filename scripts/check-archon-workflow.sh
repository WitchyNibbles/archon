#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
requested_task_id=""
live_mode=0
external_review_authority=0

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
    --live)
      live_mode=1
      shift
      ;;
    --external-review-authority)
      external_review_authority=1
      shift
      ;;
    *)
      if [[ "$1" == -* ]]; then
        printf 'unknown option: %s\n' "$1" >&2
        exit 2
      fi
      repo_root="$1"
      shift
      ;;
  esac
done

fail() {
  printf 'archon workflow check failed: %s\n' "$1" >&2
  exit 1
}

validate_task_id() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "task_id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$: ${value}"
}

if [[ -n "$requested_task_id" ]]; then
  validate_task_id "$requested_task_id"
fi

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "missing file: ${path#"$repo_root"/}"
}

require_grep() {
  local pattern="$1"
  local path="$2"
  grep -Fq "$pattern" "$path" || fail "missing required text in ${path#"$repo_root"/}: $pattern"
}

validate_coverage_manifest_artifact() {
  local path="$1"
  node --input-type=module - "$path" <<'EOF'
import fs from "node:fs";

const [artifactPath] = process.argv.slice(2);
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const errors = [];

if (!Array.isArray(artifact.required_categories) || artifact.required_categories.length === 0) {
  errors.push("required_categories must contain at least one category");
}

for (const key of [
  "critical_item_coverage",
  "critical_item_validation",
  "callsite_coverage",
  "runtime_trace_coverage"
]) {
  const value = artifact.thresholds?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`thresholds.${key} must be a finite number between 0 and 1`);
  }
}

if (errors.length > 0) {
  console.error(`archon workflow check failed: invalid coverage manifest artifact ${artifactPath}: ${errors.join("; ")}`);
  process.exit(1);
}
EOF
}

validate_coverage_ledger_artifacts() {
  local manifest_path="$1"
  local items_path="$2"
  local gaps_path="$3"
  local dependency_graph_path="$4"
  local traces_path="$5"

  node --input-type=module - \
    "$manifest_path" \
    "$items_path" \
    "$gaps_path" \
    "$dependency_graph_path" \
    "$traces_path" <<'EOF'
import fs from "node:fs";

const [manifestPath, itemsPath, gapsPath, dependencyGraphPath, tracesPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const items = JSON.parse(fs.readFileSync(itemsPath, "utf8"));
const gaps = JSON.parse(fs.readFileSync(gapsPath, "utf8"));
const dependencyGraph = JSON.parse(fs.readFileSync(dependencyGraphPath, "utf8"));
const traces = JSON.parse(fs.readFileSync(tracesPath, "utf8"));
const errors = [];

if (!Array.isArray(manifest.required_categories) || manifest.required_categories.length === 0) {
  errors.push("required_categories must contain at least one category");
}

for (const key of [
  "critical_item_coverage",
  "critical_item_validation",
  "callsite_coverage",
  "runtime_trace_coverage"
]) {
  const value = manifest.thresholds?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`thresholds.${key} must be a finite number between 0 and 1`);
  }
}

if (!Array.isArray(items)) {
  errors.push("coverage items artifact must be an array");
}

if (!Array.isArray(gaps)) {
  errors.push("coverage gaps artifact must be an array");
}

if (!Array.isArray(traces)) {
  errors.push("coverage traces artifact must be an array");
}

if (!dependencyGraph || typeof dependencyGraph !== "object") {
  errors.push("coverage dependency graph artifact must be an object");
}

if (Array.isArray(items)) {
  const itemIds = new Set();
  const presentCategories = new Set();
  for (const item of items) {
    if (itemIds.has(item.id)) {
      errors.push(`duplicate coverage item id ${item.id}`);
    }
    itemIds.add(item.id);
    presentCategories.add(item.category);

    if (!Array.isArray(item.sources) || item.sources.length === 0) {
      errors.push(`coverage item ${item.id} must include at least one source`);
    }
    if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length === 0) {
      errors.push(`coverage item ${item.id} must include at least one evidenceRef`);
    }
    if (
      Number.isFinite(item.callsite_count) &&
      Number.isFinite(item.callsites_analyzed) &&
      item.callsites_analyzed > item.callsite_count
    ) {
      errors.push(`coverage item ${item.id} callsitesAnalyzed cannot exceed callsiteCount`);
    }
    if (item.state === "validated" && (!Array.isArray(item.verification_refs) || item.verification_refs.length === 0)) {
      errors.push(`validated coverage item ${item.id} must include verificationRefs`);
    }
  }

  for (const category of manifest.required_categories ?? []) {
    if (!presentCategories.has(category)) {
      errors.push(`coverage items artifact is missing required category ${category}`);
    }
  }

  if (!dependencyGraph || typeof dependencyGraph !== "object") {
    // handled above
  } else {
    if (typeof dependencyGraph.generated_at !== "string" || dependencyGraph.generated_at.trim().length === 0) {
      errors.push("coverage dependency graph artifact must include generated_at");
    }
    if (!Array.isArray(dependencyGraph.nodes)) {
      errors.push("coverage dependency graph artifact must include nodes");
    }
    if (!Array.isArray(dependencyGraph.edges)) {
      errors.push("coverage dependency graph artifact must include edges");
    }

    if (Array.isArray(dependencyGraph.nodes) && Array.isArray(dependencyGraph.edges)) {
      const nodeIds = new Set();
      for (const node of dependencyGraph.nodes) {
        if (typeof node.id !== "string" || node.id.trim().length === 0) {
          errors.push("coverage dependency graph node must include id");
          continue;
        }
        if (nodeIds.has(node.id)) {
          errors.push(`duplicate coverage dependency graph node ${node.id}`);
          continue;
        }
        nodeIds.add(node.id);
      }

      for (const item of items) {
        if (!nodeIds.has(item.id)) {
          errors.push(`coverage dependency graph is missing node for coverage item ${item.id}`);
        }
      }

      for (const edge of dependencyGraph.edges) {
        if (typeof edge.from !== "string" || edge.from.trim().length === 0) {
          errors.push("coverage dependency graph edge must include from");
          continue;
        }
        if (typeof edge.to !== "string" || edge.to.trim().length === 0) {
          errors.push("coverage dependency graph edge must include to");
          continue;
        }
        if (edge.kind !== "depends_on") {
          errors.push(`coverage dependency graph edge ${edge.from}->${edge.to} has unsupported kind ${String(edge.kind)}`);
        }
        if (!nodeIds.has(edge.from)) {
          errors.push(`coverage dependency graph edge references unknown from node ${edge.from}`);
        }
        if (!nodeIds.has(edge.to)) {
          errors.push(`coverage dependency graph edge references unknown to node ${edge.to}`);
        }
      }
    }
  }
}

if (Array.isArray(gaps)) {
  for (const gap of gaps) {
    if (typeof gap.target_id !== "string" || gap.target_id.trim().length === 0) {
      errors.push(`gap ${gap.id} must include a targetId`);
    }
    if (!Array.isArray(gap.evidence_refs) || gap.evidence_refs.length === 0) {
      errors.push(`gap ${gap.id} must include evidenceRefs`);
    }
    if (typeof gap.created_by !== "string" || gap.created_by.trim().length === 0) {
      errors.push(`gap ${gap.id} must include createdBy`);
    }
    if (gap.status === "open" && (!Array.isArray(gap.suggested_next_actions) || gap.suggested_next_actions.length === 0)) {
      errors.push(`open gap ${gap.id} must include suggestedNextActions`);
    }
  }
}

if (Array.isArray(traces)) {
  for (const trace of traces) {
    if (typeof trace.trace_id !== "string" || trace.trace_id.trim().length === 0) {
      errors.push("runtime trace must include traceId");
    }
    if (typeof trace.target_id !== "string" || trace.target_id.trim().length === 0) {
      errors.push(`runtime trace ${trace.trace_id} must include targetId`);
    }
    if (!Array.isArray(trace.side_effects)) {
      errors.push(`runtime trace ${trace.trace_id} must include sideEffects`);
    }
    if (!Array.isArray(trace.evidence_refs) || trace.evidence_refs.length === 0) {
      errors.push(`runtime trace ${trace.trace_id} must include evidenceRefs`);
    }
    if (typeof trace.created_at !== "string" || trace.created_at.trim().length === 0) {
      errors.push(`runtime trace ${trace.trace_id} must include createdAt`);
    }
  }
}

if (errors.length > 0) {
  console.error(`archon workflow check failed: invalid coverage ledger artifact ${manifestPath}: ${errors.join("; ")}`);
  process.exit(1);
}
EOF
}

validate_progress_proof_artifact() {
  local path="$1"
  node --input-type=module - "$path" <<'EOF'
import fs from "node:fs";

const [artifactPath] = process.argv.slice(2);
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const errors = [];
const hasCoverageDelta = Object.values(artifact.coverage_delta ?? {}).some(
  (value) => typeof value === "number" && Number.isFinite(value) && value !== 0
);
const hasGapDelta =
  (typeof artifact.blocking_gap_delta?.closed === "number" && artifact.blocking_gap_delta.closed !== 0) ||
  (typeof artifact.blocking_gap_delta?.opened === "number" && artifact.blocking_gap_delta.opened !== 0);

if (!Number.isInteger(artifact.cycle) || artifact.cycle <= 0) {
  errors.push("cycle must be a positive integer");
}

if (!Array.isArray(artifact.evidence_refs) || artifact.evidence_refs.length === 0) {
  errors.push("evidence_refs must contain at least one entry");
}

if (typeof artifact.next_target !== "string" || artifact.next_target.trim().length === 0) {
  errors.push("next_target must be non-empty");
}

if (typeof artifact.why_next !== "string" || artifact.why_next.trim().length === 0) {
  errors.push("why_next must be non-empty");
}

if (!hasCoverageDelta && !hasGapDelta) {
  errors.push("progress proof must record a measurable delta");
}

if (errors.length > 0) {
  console.error(`archon workflow check failed: invalid progress proof artifact ${artifactPath}: ${errors.join("; ")}`);
  process.exit(1);
}
EOF
}

require_heading() {
  local heading="$1"
  local path="$2"
  grep -Fq "$heading" "$path" || fail "missing heading ${heading} in ${path#"$repo_root"/}"
}

require_allowed_value() {
  local value="$1"
  local path="$2"
  shift 2
  local allowed
  for allowed in "$@"; do
    if [[ "$value" == "$allowed" ]]; then
      return
    fi
  done

  fail "unexpected value in ${path#"$repo_root"/}: ${value}"
}

require_nonempty_section_block() {
  local heading="$1"
  local path="$2"
  local block
  block="$(extract_section_block "$heading" "$path")"
  [[ -n "$(normalize_value "$block")" ]] || fail "missing section content ${heading} in ${path#"$repo_root"/}"
}

require_runtime_proof_reference() {
  local block="$1"
  local path="$2"
  local heading="$3"

  printf '%s\n' "$block" |
    grep -Eq '^[[:space:]-]*Runtime proof:[[:space:]]*[^[:space:]<].*$' ||
    fail "specialist_verified runtime_verified summaries must cite Runtime proof in ${heading} of ${path#"$repo_root"/}"
}

load_supported_quality_gates() {
  local rules_path="$repo_root/.archon/rules/task-quality-matrix.md"
  [[ -f "$rules_path" ]] || fail "missing quality gate rules: ${rules_path#"$repo_root"/}"
  awk '
    /^### `/ {
      line=$0
      gsub(/^### `/, "", line)
      gsub(/`$/, "", line)
      print line
    }
  ' "$rules_path"
}

extract_list_items() {
  local heading="$1"
  local path="$2"
  extract_section_block "$heading" "$path" |
    awk '
      {
        line=$0
        gsub(/\r/, "", line)
        gsub(/`/, "", line)
        sub(/^[[:space:]-]+/, "", line)
        sub(/[[:space:]]+$/, "", line)
        if (line != "" && line !~ /^### /) {
          print line
        }
      }
    '
}

extract_section_value() {
  local heading="$1"
  local path="$2"
  awk -v heading="$heading" '
    $0 == heading { in_section=1; next }
    in_section && /^## / { exit }
    in_section && NF {
      gsub(/\r/, "", $0)
      print
      exit
    }
  ' "$path"
}

extract_section_block() {
  local heading="$1"
  local path="$2"
  awk -v heading="$heading" '
    $0 == heading { in_section=1; next }
    in_section && /^## / { exit }
    in_section {
      gsub(/\r/, "", $0)
      print
    }
  ' "$path"
}

normalize_value() {
  printf '%s' "$1" | tr -d '\r' | sed -e 's/`//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

extract_section_key_value() {
  local heading="$1"
  local key="$2"
  local path="$3"
  extract_section_block "$heading" "$path" |
    awk -F= -v key="$key" '
      {
        line=$0
        gsub(/\r/, "", line)
        if (line == "" || line ~ /^[[:space:]]*#/) {
          next
        }
        current_key=$1
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", current_key)
        if (current_key == key) {
          sub(/^[^=]*=/, "", line)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
          print line
          exit
        }
      }
    '
}

require_artifact_ref_path() {
  local key="$1"
  local value="$2"
  local path="$3"
  local expected_prefix=""

  case "$key" in
    brief)
      expected_prefix=".archon/work/briefs/"
      ;;
    plan)
      expected_prefix=".archon/work/plans/"
      ;;
    task)
      expected_prefix=".archon/work/tasks/"
      ;;
    reviewer|qa_engineer|security_reviewer)
      expected_prefix=".archon/work/reviews/"
      ;;
    *)
      fail "unsupported workflow artifact ref key ${key} in ${path#"$repo_root"/}"
      ;;
  esac

  [[ "$value" != /* ]] || fail "workflow artifact ref ${key} must be repo-relative in ${path#"$repo_root"/}"
  [[ "$value" != *".."* ]] || fail "workflow artifact ref ${key} must not contain .. in ${path#"$repo_root"/}"
  [[ "$value" == "$expected_prefix"* ]] ||
    fail "workflow artifact ref ${key} must stay under ${expected_prefix} in ${path#"$repo_root"/}"
}

section_mentions_value() {
  local heading="$1"
  local needle="$2"
  local path="$3"
  extract_section_block "$heading" "$path" | grep -Fq "$needle"
}

require_artifact_override_reference() {
  local label="$1"
  local value="$2"
  local path="$3"

  if section_mentions_value "## Inputs" "$value" "$path"; then
    return
  fi

  if section_mentions_value "## Dependencies" "$value" "$path"; then
    return
  fi

  fail "${label} must also be listed in ## Inputs or ## Dependencies in ${path#"$repo_root"/}: ${value}"
}

extract_marked_block() {
  local start_marker="$1"
  local end_marker="$2"
  local path="$3"
  awk -v start_marker="$start_marker" -v end_marker="$end_marker" '
    index($0, start_marker) { in_block=1; next }
    index($0, end_marker) { exit }
    in_block { print }
  ' "$path"
}

extract_contract_value() {
  local key="$1"
  local path="$2"
  extract_marked_block \
    '<!-- archon-workflow-contract:start -->' \
    '<!-- archon-workflow-contract:end -->' \
    "$path" |
    awk -F= -v key="$key" '
      {
        line=$0
        gsub(/\r/, "", line)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
        if (line == "" || line ~ /^#/) {
          next
        }

        current_key=$1
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", current_key)
        if (current_key == key) {
          sub(/^[^=]*=/, "", line)
          print line
          exit
        }
      }
    '
}

require_section_equals() {
  local heading="$1"
  local expected="$2"
  local path="$3"
  local raw
  raw="$(extract_section_value "$heading" "$path")"
  [[ -n "$raw" ]] || fail "missing section value ${heading} in ${path#"$repo_root"/}"
  [[ "$(normalize_value "$raw")" == "$expected" ]] || fail "unexpected value for ${heading} in ${path#"$repo_root"/}: expected ${expected}"
}

require_contract_equals() {
  local key="$1"
  local expected="$2"
  local path="$3"
  local raw
  raw="$(extract_contract_value "$key" "$path")"
  [[ -n "$raw" ]] || fail "missing workflow contract key ${key} in ${path#"$repo_root"/}"
  [[ "$(normalize_value "$raw")" == "$expected" ]] || fail "unexpected workflow contract value for ${key} in ${path#"$repo_root"/}: expected ${expected}"
}

extract_review_file() {
  local review_base="$1"
  local short_role="$2"
  local full_role="$3"
  local short_path="$repo_root/.archon/work/reviews/review-${review_base}-${short_role}.md"
  local full_path="$repo_root/.archon/work/reviews/review-${review_base}-${full_role}.md"

  if [[ "$short_role" == "$full_role" ]]; then
    [[ -f "$short_path" ]] || fail "missing review file for ${full_role}: expected ${short_path#"$repo_root"/}"
    printf '%s\n' "$short_path"
    return
  fi

  if [[ -f "$short_path" && -f "$full_path" ]]; then
    fail "duplicate review files for ${full_role}: ${short_path#"$repo_root"/} and ${full_path#"$repo_root"/}"
  fi

  if [[ -f "$short_path" ]]; then
    printf '%s\n' "$short_path"
    return
  fi

  if [[ -f "$full_path" ]]; then
    printf '%s\n' "$full_path"
    return
  fi

  fail "missing review file for ${full_role}: expected ${short_path#"$repo_root"/} or ${full_path#"$repo_root"/}"
}

resolve_review_file() {
  local explicit_rel="$1"
  local review_base="$2"
  local short_role="$3"
  local full_role="$4"

  if [[ -n "$explicit_rel" ]]; then
    local explicit_path="$repo_root/$explicit_rel"
    if [[ -f "$explicit_path" ]]; then
      printf '%s\n' "$explicit_path"
      return
    fi
    if [[ "$review_export_policy" == "runtime_optional" ]]; then
      printf '\n'
      return
    fi
    fail "missing review file for ${full_role}: expected ${explicit_rel}"
  fi

  local short_path="$repo_root/.archon/work/reviews/review-${review_base}-${short_role}.md"
  local full_path="$repo_root/.archon/work/reviews/review-${review_base}-${full_role}.md"

  if [[ "$short_role" == "$full_role" ]]; then
    if [[ -f "$short_path" ]]; then
      printf '%s\n' "$short_path"
      return
    fi
    if [[ "$review_export_policy" == "runtime_optional" ]]; then
      printf '\n'
      return
    fi
    fail "missing review file for ${full_role}: expected ${short_path#"$repo_root"/}"
  fi

  if [[ -f "$short_path" && -f "$full_path" ]]; then
    fail "duplicate review files for ${full_role}: ${short_path#"$repo_root"/} and ${full_path#"$repo_root"/}"
  fi

  if [[ -f "$short_path" ]]; then
    printf '%s\n' "$short_path"
    return
  fi

  if [[ -f "$full_path" ]]; then
    printf '%s\n' "$full_path"
    return
  fi

  if [[ "$review_export_policy" == "runtime_optional" ]]; then
    printf '\n'
    return
  fi

  fail "missing review file for ${full_role}: expected ${short_path#"$repo_root"/} or ${full_path#"$repo_root"/}"
}

active_file="$repo_root/.archon/ACTIVE"
agents_file="$repo_root/AGENTS.md"
config_file="$repo_root/.codex/config.toml"
brief_template="$repo_root/.archon/templates/intake-brief.md"
task_template="$repo_root/.archon/templates/task-packet.md"
review_template="$repo_root/.archon/templates/review-gate.md"
coverage_manifest_template="$repo_root/.archon/templates/coverage-manifest.json"
checkpoint_template="$repo_root/.archon/templates/checkpoint-summary.md"
progress_proof_template="$repo_root/.archon/templates/progress-proof.json"

require_file "$active_file"
require_file "$agents_file"
require_file "$config_file"
require_file "$brief_template"
require_file "$task_template"
require_file "$review_template"
require_file "$coverage_manifest_template"
require_file "$checkpoint_template"
require_file "$progress_proof_template"

contract_mode="legacy"
if grep -Fq 'workflow_runtime=postgres' "$agents_file"; then
  contract_mode="runtime"
fi

mapfile -t active_lines < "$active_file"
active_lines=("${active_lines[@]%$'\r'}")
declare -A active_fields=()
for line in "${active_lines[@]}"; do
  [[ -n "$line" ]] || continue
  [[ "$line" == *=* ]] || fail "unexpected .archon/ACTIVE content"
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    task_id|workflow|state)
      ;;
    *)
      fail "unexpected key ${key} in .archon/ACTIVE"
      ;;
  esac
  [[ -z "${active_fields[$key]+x}" ]] || fail "duplicate ${key} in .archon/ACTIVE"
  active_fields["$key"]="$value"
done

[[ "${active_fields[workflow]-}" == "archon" ]] || fail "workflow must be archon in .archon/ACTIVE"

active_state="${active_fields[state]-}"
[[ -n "$active_state" ]] || fail "missing state in .archon/ACTIVE"
case "$active_state" in
  active|idle|complete)
    ;;
  *)
    fail "state must be active, idle, or complete in .archon/ACTIVE"
    ;;
esac

exported_task_id="${active_fields[task_id]-}"
if [[ -n "$exported_task_id" ]]; then
  validate_task_id "$exported_task_id"
fi

if [[ "$active_state" == "active" ]]; then
  [[ -n "$exported_task_id" ]] || fail "missing task_id in .archon/ACTIVE"
  task_id="$exported_task_id"
  if [[ -n "$requested_task_id" && "$requested_task_id" != "$task_id" ]]; then
    fail "requested task id ${requested_task_id} does not match active task ${task_id}"
  fi
else
  if [[ -n "$requested_task_id" ]]; then
    task_id="$requested_task_id"
  elif [[ -n "$exported_task_id" ]]; then
    task_id="$exported_task_id"
  else
    fail "non-active .archon/ACTIVE requires --task-id"
  fi
fi

require_contract_equals "workflow" "archon" "$agents_file"
require_contract_equals "required_review_roles" "reviewer,qa_engineer,security_reviewer" "$agents_file"
require_contract_equals "release_candidate_quality_gate" "release_readiness_required" "$agents_file"
require_contract_equals "local_live_check" "bash scripts/check-archon-workflow-live.sh [--task-id <task-id>]" "$agents_file"

if [[ "$contract_mode" == "legacy" ]]; then
  require_contract_equals "active_file" ".archon/ACTIVE" "$agents_file"
  require_contract_equals "brief_file" ".archon/work/briefs/brief-<task-id>.md" "$agents_file"
  require_contract_equals "plan_file" ".archon/work/plans/plan-<task-id>.md" "$agents_file"
  require_contract_equals "task_file" ".archon/work/tasks/task-<task-id>.md" "$agents_file"
  require_contract_equals "review_file" ".archon/work/reviews/review-<task-id>-<role>.md" "$agents_file"
  require_contract_equals "brief_template" ".archon/templates/intake-brief.md" "$agents_file"
  require_contract_equals "task_template" ".archon/templates/task-packet.md" "$agents_file"
  require_contract_equals "review_template" ".archon/templates/review-gate.md" "$agents_file"
  require_contract_equals "review_aliases" "reviewer:reviewer;qa_engineer:qa|qa_engineer;security_reviewer:security|security_reviewer" "$agents_file"
  require_contract_equals "workflow_check" "bash scripts/check-archon-workflow.sh --task-id <task-id>" "$agents_file"
  require_contract_equals "workflow_check_scope" "artifact_contract_only" "$agents_file"
  require_contract_equals "review_artifact_trust" "manager_summary_evidence_only" "$agents_file"
  require_contract_equals "ci_scope" "artifact_contract_regression_fixtures_only" "$agents_file"
else
  require_contract_equals "workflow_runtime" "postgres" "$agents_file"
  require_contract_equals "active_run_pointer" "project_runtime_state.active_run_id" "$agents_file"
  require_contract_equals "active_task_pointer" "project_runtime_state.active_task_id" "$agents_file"
  require_contract_equals "workflow_documents" "workflow_documents" "$agents_file"
  require_contract_equals "task_queue" "project_runtime_state.task_queue" "$agents_file"
  require_contract_equals "product_state" "project_runtime_state.product_state" "$agents_file"
  require_contract_equals "review_authority" "runtime_authenticated_only" "$agents_file"
  require_contract_equals "workflow_check_scope" "runtime_authority_only" "$agents_file"
  require_contract_equals "review_artifact_trust" "runtime_records_only" "$agents_file"
  require_contract_equals "ci_scope" "runtime_contract_and_export_regressions" "$agents_file"
fi
require_grep 'AGENTS.md' "$config_file"
require_grep '.agents.md' "$config_file"

require_section_equals "## Task ID" "<task-id>" "$brief_template"
require_heading "## Success Criteria" "$brief_template"
require_heading "## Stop Go" "$brief_template"
require_section_equals "## Stop Go" "go | needs_review | stop" "$brief_template"

require_section_equals "## Task ID" "<task-id>" "$task_template"
require_section_equals "## Owner role" "<owner-role>" "$task_template"
require_section_equals "## Completion standard" "artifact_complete | specialist_verified" "$task_template"
require_heading "## Required specialist roles" "$task_template"
require_heading "## Quality gates" "$task_template"
require_heading "## Acceptance criteria" "$task_template"
require_heading "## Verification steps" "$task_template"
require_heading "## Required reviews" "$task_template"
require_heading "## Reasoning quality" "$task_template"
require_heading "## Reasoning policy" "$task_template"
require_heading "## Reasoning attempts" "$task_template"
require_heading "## Coverage impact" "$task_template"
require_heading "## Touched ledger items" "$task_template"
require_heading "## Required runtime traces" "$task_template"
require_heading "## Progress proof" "$task_template"
require_heading "## Interrupt checkpoint policy" "$task_template"
require_grep '`reviewer`' "$task_template"
require_grep '`qa_engineer`' "$task_template"
require_grep '`security_reviewer`' "$task_template"
require_heading "## Rollback notes" "$task_template"

require_section_equals "## Task ID" "<task-id>" "$review_template"
require_section_equals "## Reviewer role" "reviewer | qa_engineer | security_reviewer" "$review_template"
require_section_equals "## Actor" "<recorded-actor-id>" "$review_template"
require_section_equals "## Actor role" "reviewer | qa_engineer | security_reviewer | planner | solution_architect" "$review_template"
require_section_equals "## Provenance status" "summary_only | runtime_verified | legacy_backfill" "$review_template"
require_section_equals "## Review state" "pending | passed | blocked | waived" "$review_template"
require_section_equals "## Severity" "low | medium | high | critical" "$review_template"
require_heading "## Specialist execution evidence" "$review_template"
require_heading "## Quality gate evidence" "$review_template"
require_heading "## Reasoning quality findings" "$review_template"
require_heading "## Verification evidence" "$review_template"
require_section_equals "## Waiver authority" "none | manager | security_exception" "$review_template"
require_section_equals "## Decision" "approved | blocked | waived" "$review_template"
require_heading "## Source handoff" "$review_template"

artifact_task_id="$task_id"
brief_rel=".archon/work/briefs/brief-${artifact_task_id}.md"
plan_rel=".archon/work/plans/plan-${artifact_task_id}.md"
task_rel=".archon/work/tasks/task-${artifact_task_id}.md"
task_file="$repo_root/$task_rel"
reviewer_rel=""
qa_engineer_rel=""
security_reviewer_rel=""
review_export_policy="required"

if [[ -f "$repo_root/$plan_rel" ]]; then
  require_section_equals "## Task ID" "$task_id" "$repo_root/$plan_rel"
elif [[ -f "$task_file" ]]; then
  require_section_equals "## Task ID" "$task_id" "$task_file"
else
  fail "missing current plan or task artifact for ${task_id}"
fi

task_completion_standard="artifact_complete"
if [[ -f "$task_file" ]]; then
  require_section_equals "## Task ID" "$task_id" "$task_file"
  task_completion_standard="$(normalize_value "$(extract_section_value "## Completion standard" "$task_file")")"
  require_allowed_value "$task_completion_standard" "$task_file" "artifact_complete" "specialist_verified"

  if grep -Fq "## Workflow artifact refs" "$task_file"; then
    for key in brief plan task reviewer qa_engineer security_reviewer; do
      value="$(normalize_value "$(extract_section_key_value "## Workflow artifact refs" "$key" "$task_file")")"
      [[ -n "$value" ]] || continue
      require_artifact_ref_path "$key" "$value" "$task_file"
      case "$key" in
        brief)
          brief_rel="$value"
          ;;
        plan)
          plan_rel="$value"
          ;;
        task)
          [[ "$value" == "$task_rel" ]] ||
            fail "workflow artifact ref task must match current task artifact in ${task_file#"$repo_root"/}: ${task_rel}"
          ;;
        reviewer)
          reviewer_rel="$value"
          ;;
        qa_engineer)
          qa_engineer_rel="$value"
          ;;
        security_reviewer)
          security_reviewer_rel="$value"
          ;;
      esac
    done

    review_export_policy="$(normalize_value "$(extract_section_key_value "## Workflow artifact refs" "review_exports" "$task_file")")"
    if [[ -z "$review_export_policy" ]]; then
      review_export_policy="required"
    fi
    require_allowed_value "$review_export_policy" "$task_file" "required" "runtime_optional"
    if [[ "$review_export_policy" == "runtime_optional" && "$contract_mode" != "runtime" ]]; then
      fail "review_exports=runtime_optional requires runtime workflow contract in ${task_file#"$repo_root"/}"
    fi
  fi

  if [[ "$task_completion_standard" == "specialist_verified" ]]; then
    specialist_roles_block="$(extract_section_block "## Required specialist roles" "$task_file")"
    quality_gates_block="$(extract_section_block "## Quality gates" "$task_file")"
    [[ -n "$(normalize_value "$specialist_roles_block")" ]] || fail "missing required specialist roles in ${task_file#"$repo_root"/}"
    [[ -n "$(normalize_value "$quality_gates_block")" ]] || fail "missing quality gates in ${task_file#"$repo_root"/}"
  fi
fi

brief_file="$repo_root/$brief_rel"
plan_file="$repo_root/$plan_rel"

require_file "$brief_file"
brief_section_task_id="$(normalize_value "$(extract_section_value "## Task ID" "$brief_file")")"
[[ -n "$brief_section_task_id" ]] || fail "missing section value ## Task ID in ${brief_file#"$repo_root"/}"
validate_task_id "$brief_section_task_id"
if [[ "$brief_rel" == ".archon/work/briefs/brief-${artifact_task_id}.md" ]]; then
  [[ "$brief_section_task_id" == "$task_id" ]] ||
    fail "unexpected value for ## Task ID in ${brief_file#"$repo_root"/}: expected ${task_id}"
else
  [[ -f "$task_file" ]] || fail "workflow brief override requires current task artifact for ${task_id}"
  require_artifact_override_reference "workflow brief ref" "$brief_rel" "$task_file"
fi

if [[ -f "$plan_file" ]]; then
  plan_section_task_id="$(normalize_value "$(extract_section_value "## Task ID" "$plan_file")")"
  [[ -n "$plan_section_task_id" ]] || fail "missing section value ## Task ID in ${plan_file#"$repo_root"/}"
  validate_task_id "$plan_section_task_id"
  if [[ "$plan_rel" == ".archon/work/plans/plan-${artifact_task_id}.md" ]]; then
    [[ "$plan_section_task_id" == "$task_id" ]] ||
      fail "unexpected value for ## Task ID in ${plan_file#"$repo_root"/}: expected ${task_id}"
  else
    [[ -f "$task_file" ]] || fail "workflow plan override requires current task artifact for ${task_id}"
    require_artifact_override_reference "workflow plan ref" "$plan_rel" "$task_file"
  fi
fi

if [[ "$live_mode" -eq 1 ]]; then
  [[ -f "$task_file" ]] || fail "live workflow requires current task artifact for ${task_id}"

  for heading in \
    "## Owner role" \
    "## Completion standard" \
    "## Required specialist roles" \
    "## Quality gates" \
    "## Reasoning quality" \
    "## Goal" \
    "## Inputs" \
    "## Dependencies" \
    "## Outputs" \
    "## Coverage impact" \
    "## Touched ledger items" \
    "## Required runtime traces" \
    "## Progress proof" \
    "## Interrupt checkpoint policy" \
    "## Workflow artifact refs" \
    "## Allowed write scope" \
    "## Out of scope" \
    "## Assumptions" \
    "## Acceptance criteria" \
    "## Verification steps" \
    "## Required reviews" \
    "## Security checks" \
    "## Retrieval guidance" \
    "## Anti-patterns to avoid" \
    "## Rollback notes" \
    "## Handoff format"; do
    require_heading "$heading" "$task_file"
  done

  require_heading "### Approved assumptions" "$task_file"
  require_heading "### Blocked assumptions" "$task_file"
  require_heading "### Claim" "$task_file"
  require_heading "### Facts" "$task_file"
  require_heading "### Assumptions" "$task_file"
  require_heading "### Hypotheses and alternatives" "$task_file"
  require_heading "### Evidence refs" "$task_file"
  require_heading "### Counter-evidence" "$task_file"
  require_heading "### Confidence" "$task_file"
  require_heading "### Open questions" "$task_file"
  require_heading "### Verification plan" "$task_file"
  require_heading "### Research and debug budgets" "$task_file"

  reasoning_mode="legacy"
  if grep -Fq "## Reasoning policy" "$task_file"; then
    reasoning_mode_raw="$(extract_section_value "### Mode" "$task_file")"
    if [[ -n "$reasoning_mode_raw" ]]; then
      reasoning_mode="$(normalize_value "$reasoning_mode_raw")"
      require_allowed_value "$reasoning_mode" "$task_file" "legacy" "dual" "strict"
    fi
  fi

  if [[ "$reasoning_mode" != "legacy" ]]; then
    require_heading "## Reasoning policy" "$task_file"
    require_heading "### Mode" "$task_file"
    require_heading "### Requirements" "$task_file"
    require_heading "### Max attempts" "$task_file"
    require_heading "## Reasoning attempts" "$task_file"
    require_heading "### Attempt records" "$task_file"
    require_heading "### Verification records" "$task_file"
    require_heading "### Verdict" "$task_file"
    require_nonempty_section_block "### Mode" "$task_file"
    require_nonempty_section_block "### Requirements" "$task_file"
    require_nonempty_section_block "### Max attempts" "$task_file"
  fi

  if [[ "$reasoning_mode" == "strict" ]]; then
    require_nonempty_section_block "### Attempt records" "$task_file"
    require_nonempty_section_block "### Verification records" "$task_file"
    require_nonempty_section_block "### Verdict" "$task_file"
  fi

  for heading in \
    "## Required specialist roles" \
    "## Quality gates" \
    "## Goal" \
    "## Inputs" \
    "## Dependencies" \
    "## Outputs" \
    "## Coverage impact" \
    "## Touched ledger items" \
    "## Required runtime traces" \
    "## Progress proof" \
    "## Interrupt checkpoint policy" \
    "## Workflow artifact refs" \
    "## Allowed write scope" \
    "## Out of scope" \
    "## Acceptance criteria" \
    "## Verification steps" \
    "## Required reviews" \
    "## Security checks" \
    "## Retrieval guidance" \
    "## Anti-patterns to avoid" \
    "## Rollback notes" \
    "## Handoff format"; do
    require_nonempty_section_block "$heading" "$task_file"
  done

  for heading in \
    "### Claim" \
    "### Facts" \
    "### Assumptions" \
    "### Hypotheses and alternatives" \
    "### Evidence refs" \
    "### Counter-evidence" \
    "### Confidence" \
    "### Verification plan" \
    "### Research and debug budgets"; do
    require_nonempty_section_block "$heading" "$task_file"
  done

  required_reviews_block="$(extract_section_block "## Required reviews" "$task_file")"
  printf '%s\n' "$required_reviews_block" | grep -Fq 'reviewer' || fail "missing reviewer required review in ${task_file#"$repo_root"/}"
  printf '%s\n' "$required_reviews_block" | grep -Fq 'qa_engineer' || fail "missing qa_engineer required review in ${task_file#"$repo_root"/}"
  printf '%s\n' "$required_reviews_block" | grep -Fq 'security_reviewer' || fail "missing security_reviewer required review in ${task_file#"$repo_root"/}"

  mapfile -t supported_quality_gates < <(load_supported_quality_gates)
  declare -A supported_quality_gate_map=()
  for gate in "${supported_quality_gates[@]}"; do
    supported_quality_gate_map["$gate"]=1
  done

  mapfile -t live_quality_gates < <(extract_list_items "## Quality gates" "$task_file")
  [[ "${#live_quality_gates[@]}" -gt 0 ]] || fail "missing live quality gates in ${task_file#"$repo_root"/}"
  for gate in "${live_quality_gates[@]}"; do
    [[ -n "${supported_quality_gate_map[$gate]:-}" ]] || fail "unsupported quality gate in ${task_file#"$repo_root"/}: $gate"
  done
fi

if [[ -f "$task_file" ]]; then
  mapfile -t task_quality_gates < <(extract_list_items "## Quality gates" "$task_file")
  task_reasoning_mode="legacy"
  task_ui_surface="none"
  task_playwright_required="false"
  if grep -Fq "## Reasoning policy" "$task_file"; then
    task_reasoning_mode_raw="$(extract_section_value "### Mode" "$task_file")"
    if [[ -n "$task_reasoning_mode_raw" ]]; then
      task_reasoning_mode="$(normalize_value "$task_reasoning_mode_raw")"
      require_allowed_value "$task_reasoning_mode" "$task_file" "legacy" "dual" "strict"
    fi
  fi

  if [[ "$task_completion_standard" == "specialist_verified" ]]; then
    has_reasoning_strict_gate=0
    has_stronger_artifact_gate=0

    for gate in "${task_quality_gates[@]}"; do
      case "$gate" in
        reasoning_strict_required)
          has_reasoning_strict_gate=1
          ;;
        coverage_ledger_required|progress_proof_required|checkpoint_resume_required|memory_compaction_required)
          has_stronger_artifact_gate=1
          ;;
      esac
    done

    [[ "$has_reasoning_strict_gate" -eq 1 ]] ||
      fail "specialist_verified work requires reasoning_strict_required quality gate in ${task_file#"$repo_root"/}"
    [[ "$task_reasoning_mode" == "strict" ]] ||
      fail "specialist_verified work requires strict reasoning mode in ${task_file#"$repo_root"/}"
    [[ "$has_stronger_artifact_gate" -eq 1 ]] ||
      fail "specialist_verified work requires at least one stronger artifact gate (coverage_ledger_required, progress_proof_required, checkpoint_resume_required, or memory_compaction_required) in ${task_file#"$repo_root"/}"
  fi

  if grep -Fq "## UI surface" "$task_file"; then
    task_ui_surface="$(normalize_value "$(extract_section_value "## UI surface" "$task_file")")"
    require_allowed_value "$task_ui_surface" "$task_file" "none" "visual_change" "interactive_flow"
  fi

  if grep -Fq "## Playwright requirement" "$task_file"; then
    task_playwright_required="$(normalize_value "$(extract_section_value "## Playwright requirement" "$task_file")")"
    require_allowed_value "$task_playwright_required" "$task_file" "true" "false"
  fi

  if [[ "$task_ui_surface" == "visual_change" || "$task_ui_surface" == "interactive_flow" ]]; then
    [[ "$task_playwright_required" == "true" ]] ||
      fail "ui surface ${task_ui_surface} must require Playwright in ${task_file#"$repo_root"/}"
  fi

  if printf '%s\n' "${task_quality_gates[@]}" | grep -Fxq "council_review_required"; then
    require_heading "## Council review" "$task_file"
    require_heading "### Required" "$task_file"
    require_heading "### Trigger rationale" "$task_file"
    require_heading "### Decision packet" "$task_file"
    require_heading "### Council members" "$task_file"
    require_heading "### Dissent owner" "$task_file"
    require_heading "### Outcome" "$task_file"
    require_heading "### Exception expiry" "$task_file"

    council_required="$(normalize_value "$(extract_section_value "### Required" "$task_file")")"
    council_outcome="$(normalize_value "$(extract_section_value "### Outcome" "$task_file")")"
    council_dissent_owner="$(normalize_value "$(extract_section_value "### Dissent owner" "$task_file")")"
    council_packet_block="$(extract_section_block "### Decision packet" "$task_file")"
    council_members_block="$(extract_section_block "### Council members" "$task_file")"
    council_trigger_block="$(extract_section_block "### Trigger rationale" "$task_file")"

    require_allowed_value "$council_required" "$task_file" "true" "false" "inherited"
    require_allowed_value "$council_outcome" "$task_file" "pending" "approved" "approved_with_conditions" "rework_required" "exception_granted" "rejected" "inherited"
    [[ -n "$council_dissent_owner" ]] || fail "council_review_required tasks must name a dissent owner in ${task_file#"$repo_root"/}"
    [[ -n "$(normalize_value "$council_packet_block")" ]] || fail "council_review_required tasks must cite a decision packet in ${task_file#"$repo_root"/}"
    [[ -n "$(normalize_value "$council_members_block")" ]] || fail "council_review_required tasks must list council members in ${task_file#"$repo_root"/}"
    [[ -n "$(normalize_value "$council_trigger_block")" ]] || fail "council_review_required tasks must record trigger rationale in ${task_file#"$repo_root"/}"
  fi

  coverage_manifest_file="$repo_root/.archon/work/coverage/coverage-${artifact_task_id}.json"
  coverage_items_file="$repo_root/.archon/work/coverage/items-${artifact_task_id}.json"
  coverage_gaps_file="$repo_root/.archon/work/coverage/gaps-${artifact_task_id}.json"
  coverage_dependency_graph_file="$repo_root/.archon/work/coverage/dependency-graph-${artifact_task_id}.json"
  coverage_traces_file="$repo_root/.archon/work/coverage/traces-${artifact_task_id}.json"
  progress_proof_file="$repo_root/.archon/work/proofs/progress-${artifact_task_id}.json"
  checkpoint_file="$repo_root/.archon/work/checkpoints/checkpoint-${artifact_task_id}.md"

  for gate in "${task_quality_gates[@]}"; do
    case "$gate" in
      coverage_ledger_required)
        require_file "$coverage_manifest_file"
        require_file "$coverage_items_file"
        require_file "$coverage_gaps_file"
        require_file "$coverage_dependency_graph_file"
        require_file "$coverage_traces_file"
        validate_coverage_ledger_artifacts \
          "$coverage_manifest_file" \
          "$coverage_items_file" \
          "$coverage_gaps_file" \
          "$coverage_dependency_graph_file" \
          "$coverage_traces_file"
        ;;
      progress_proof_required)
        require_file "$progress_proof_file"
        validate_progress_proof_artifact "$progress_proof_file"
        ;;
      checkpoint_resume_required)
        require_file "$checkpoint_file"
        ;;
      memory_compaction_required)
        require_file "$checkpoint_file"
        require_grep 'memory://' "$checkpoint_file"
        ;;
    esac
  done
fi

queue_file="$repo_root/.archon/work/task-queue.json"
if [[ -f "$queue_file" ]]; then
  node --input-type=module - "$queue_file" "$task_id" "$active_state" <<'EOF'
import fs from "node:fs";

const [queuePath, taskId, activeState] = process.argv.slice(2);
const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
const currentTaskId = queue.current_task_id ?? null;

const target = tasks.find((task) => task?.id === taskId);
if (!target) {
  console.error(`archon workflow check failed: task queue is missing current task "${taskId}"`);
  process.exit(1);
}

if (activeState === "active" && currentTaskId !== taskId) {
  console.error(
    `archon workflow check failed: task queue current_task_id "${String(currentTaskId)}" does not match active task "${taskId}"`
  );
  process.exit(1);
}

for (const task of tasks) {
  if (!task || typeof task !== "object") {
    console.error("archon workflow check failed: task queue contains a non-object task entry");
    process.exit(1);
  }

  if (task.class === "docs_only") {
    continue;
  }

  for (const [field, label] of [
    ["acceptance_criteria", "acceptance criterion"],
    ["verification", "verification step"],
    ["evidence", "evidence reference"]
  ]) {
    const items = Array.isArray(task[field]) ? task[field] : [];
    const normalized = items
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (normalized.length === 0) {
      console.error(
        `archon workflow check failed: task queue task "${task.id}" must include at least one ${label}`
      );
      process.exit(1);
    }
  }
}
EOF
fi

roles=("reviewer" "qa" "security")

for role in "${roles[@]}"; do
  case "$role" in
    reviewer)
      expected_role="reviewer"
      review_file="$(resolve_review_file "$reviewer_rel" "$artifact_task_id" "reviewer" "reviewer")"
      ;;
    qa)
      expected_role="qa_engineer"
      review_file="$(resolve_review_file "$qa_engineer_rel" "$artifact_task_id" "qa" "qa_engineer")"
      ;;
    security)
      expected_role="security_reviewer"
      review_file="$(resolve_review_file "$security_reviewer_rel" "$artifact_task_id" "security" "security_reviewer")"
      ;;
  esac

  if [[ -z "$review_file" ]]; then
    continue
  fi

  require_section_equals "## Task ID" "$task_id" "$review_file"
  require_section_equals "## Reviewer role" "$expected_role" "$review_file"
  actor="$(normalize_value "$(extract_section_value "## Actor" "$review_file")")"
  actor_role="$(normalize_value "$(extract_section_value "## Actor role" "$review_file")")"
  provenance_status="$(normalize_value "$(extract_section_value "## Provenance status" "$review_file")")"
  review_state="$(normalize_value "$(extract_section_value "## Review state" "$review_file")")"
  decision="$(normalize_value "$(extract_section_value "## Decision" "$review_file")")"
  severity="$(normalize_value "$(extract_section_value "## Severity" "$review_file")")"
  waiver_authority="$(normalize_value "$(extract_section_value "## Waiver authority" "$review_file")")"
  waiver_reason="$(extract_section_value "## Waiver reason" "$review_file")"

  [[ -n "$actor" ]] || fail "missing actor in ${review_file#"$repo_root"/}"
  [[ -n "$actor_role" ]] || fail "missing actor role in ${review_file#"$repo_root"/}"
  require_allowed_value "$provenance_status" "$review_file" "summary_only" "runtime_verified" "legacy_backfill"
  if [[ "$external_review_authority" -eq 1 ]]; then
    require_allowed_value "$review_state" "$review_file" "pending" "passed" "blocked" "waived"
    require_allowed_value "$decision" "$review_file" "approved" "blocked" "waived"
  else
    require_allowed_value "$review_state" "$review_file" "passed" "waived"
    require_allowed_value "$decision" "$review_file" "approved" "waived"
  fi
  require_allowed_value "$severity" "$review_file" "low" "medium" "high" "critical"
  require_allowed_value "$waiver_authority" "$review_file" "none" "manager" "security_exception"

  if [[ "$live_mode" -eq 1 && "$external_review_authority" -eq 0 && "$provenance_status" != "runtime_verified" ]]; then
    fail "live workflow requires runtime_verified provenance for satisfying review ${expected_role} in ${review_file#"$repo_root"/}"
  fi

  if [[ "$expected_role" == "security_reviewer" && "$review_state" == "passed" && "$decision" == "approved" ]]; then
    case "$severity" in
      high|critical)
        fail "passed security review summaries must use low or medium severity, not ${severity} in ${review_file#"$repo_root"/}"
        ;;
    esac
  fi

  if [[ "$task_completion_standard" == "specialist_verified" && "$external_review_authority" -eq 0 && "$provenance_status" != "runtime_verified" ]]; then
    fail "specialist_verified work requires runtime_verified review provenance in ${review_file#"$repo_root"/}"
  fi

  if [[ "$external_review_authority" -eq 1 ]]; then
    :
  elif [[ "$review_state" == "passed" && "$decision" == "approved" ]]; then
    [[ "$actor_role" == "$expected_role" ]] || fail "passed review summary must record actor role ${expected_role} in ${review_file#"$repo_root"/}"
    [[ "$waiver_authority" == "none" ]] || fail "passed review summary must use waiver authority none in ${review_file#"$repo_root"/}"
    if [[ "$expected_role" == "security_reviewer" && ( "$severity" == "high" || "$severity" == "critical" ) ]]; then
      fail "unresolved ${severity} security findings block completion in ${review_file#"$repo_root"/}"
    fi
  elif [[ "$review_state" == "waived" && "$decision" == "waived" ]]; then
    case "$expected_role" in
      reviewer|qa_engineer)
        [[ "$actor_role" == "planner" || "$actor_role" == "solution_architect" ]] || fail "waived ${expected_role} review summary must record planner or solution_architect actor role in ${review_file#"$repo_root"/}"
        [[ "$waiver_authority" == "manager" ]] || fail "waived ${expected_role} review summary must use manager waiver authority in ${review_file#"$repo_root"/}"
        ;;
      security_reviewer)
        [[ "$actor_role" == "security_reviewer" ]] || fail "waived security review summary must record security_reviewer actor role in ${review_file#"$repo_root"/}"
        [[ "$waiver_authority" == "security_exception" ]] || fail "waived security review summary must use security_exception authority in ${review_file#"$repo_root"/}"
        ;;
    esac
    [[ -n "$waiver_reason" && "$(normalize_value "$waiver_reason")" != "None." && "$(normalize_value "$waiver_reason")" != "None" ]] || fail "waived review lacks waiver reason in ${review_file#"$repo_root"/}"
  else
    fail "unexpected gate outcome in ${review_file#"$repo_root"/}: state=${review_state} decision=${decision}"
  fi

  findings="$(extract_section_value "## Findings" "$review_file")"
  residual_risk="$(extract_section_value "## Residual risk" "$review_file")"
  specialist_execution_evidence="$(extract_section_value "## Specialist execution evidence" "$review_file")"
  quality_gate_evidence="$(extract_section_value "## Quality gate evidence" "$review_file")"
  verification_evidence="$(extract_section_value "## Verification evidence" "$review_file")"
  verification_evidence_block="$(extract_section_block "## Verification evidence" "$review_file")"
  [[ -n "$findings" ]] || fail "missing findings in ${review_file#"$repo_root"/}"
  [[ -n "$residual_risk" ]] || fail "missing residual risk in ${review_file#"$repo_root"/}"
  if [[ "$task_completion_standard" == "specialist_verified" ]]; then
    [[ -n "$specialist_execution_evidence" ]] || fail "missing specialist execution evidence in ${review_file#"$repo_root"/}"
    [[ -n "$quality_gate_evidence" ]] || fail "missing quality gate evidence in ${review_file#"$repo_root"/}"
  fi
  [[ -n "$verification_evidence" ]] || fail "missing verification evidence in ${review_file#"$repo_root"/}"
  source_handoff="$(extract_section_value "## Source handoff" "$review_file")"
  source_handoff_block="$(extract_section_block "## Source handoff" "$review_file")"
  [[ -n "$source_handoff" ]] || fail "missing source handoff in ${review_file#"$repo_root"/}"
  if [[ "$live_mode" -eq 1 && "$external_review_authority" -eq 0 ]]; then
    require_runtime_proof_reference "$verification_evidence_block" "$review_file" "## Verification evidence"
    require_runtime_proof_reference "$source_handoff_block" "$review_file" "## Source handoff"
  fi
  if [[ "$task_completion_standard" == "specialist_verified" && "$provenance_status" == "runtime_verified" ]]; then
    require_runtime_proof_reference "$verification_evidence_block" "$review_file" "## Verification evidence"
    require_runtime_proof_reference "$source_handoff_block" "$review_file" "## Source handoff"
  fi
done

if [[ -f "$task_file" ]]; then
  if [[ "$task_playwright_required" == "true" ]]; then
    qa_review_file="$(resolve_review_file "$qa_engineer_rel" "$artifact_task_id" "qa" "qa_engineer")"
    [[ -n "$qa_review_file" ]] || fail "playwright-required task is missing qa review export for ${artifact_task_id}"
    qa_verification_block="$(extract_section_block "## Verification evidence" "$qa_review_file")"
    qa_source_handoff_block="$(extract_section_block "## Source handoff" "$qa_review_file")"
    if ! printf '%s\n%s\n' "$qa_verification_block" "$qa_source_handoff_block" | grep -Eqi 'playwright'; then
      fail "playwright-required task must cite Playwright evidence in qa review export ${qa_review_file#"$repo_root"/}"
    fi
  fi

  if printf '%s\n' "${task_quality_gates[@]}" | grep -Fxq "release_readiness_required"; then
    release_readiness_evidence_found=0
    for role in "${roles[@]}"; do
      case "$role" in
        reviewer)
          review_file="$(resolve_review_file "$reviewer_rel" "$artifact_task_id" "reviewer" "reviewer")"
          ;;
        qa)
          review_file="$(resolve_review_file "$qa_engineer_rel" "$artifact_task_id" "qa" "qa_engineer")"
          ;;
        security)
          review_file="$(resolve_review_file "$security_reviewer_rel" "$artifact_task_id" "security" "security_reviewer")"
          ;;
      esac

      if [[ -z "$review_file" ]]; then
        continue
      fi

      quality_gate_block="$(extract_section_block "## Quality gate evidence" "$review_file")"
      if printf '%s\n' "$quality_gate_block" | grep -Eqi 'release[-_ ]readiness|release overlay|setup replay|rollout'; then
        release_readiness_evidence_found=1
        break
      fi
    done

    if [[ "$release_readiness_evidence_found" -eq 0 ]]; then
      for heading in "## Verification steps" "## Good-path checks" "## Progress proof"; do
        evidence_block="$(extract_section_block "$heading" "$task_file")"
        if printf '%s\n' "$evidence_block" | grep -Eqi 'release[-_ ]readiness|release overlay|setup replay|rollout'; then
          release_readiness_evidence_found=1
          break
        fi
      done
    fi

    [[ "$release_readiness_evidence_found" -eq 1 ]] ||
      fail "release_readiness_required tasks must cite release-readiness evidence in review summaries or task verification artifacts"
  fi
fi

printf 'archon workflow artifact check passed for %s\n' "$task_id"
