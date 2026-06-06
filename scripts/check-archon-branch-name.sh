#!/usr/bin/env bash

set -euo pipefail

if [[ "${ARCHON_ALLOW_MANAGED_COMMITS:-}" == "1" ]]; then
  exit 0
fi

branch_name="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
normalized_branch_name="${branch_name,,}"

if [[ -z "$branch_name" ]]; then
  echo "archon branch guard: work on a named branch created from updated origin/main" >&2
  exit 1
fi

if [[ "$normalized_branch_name" =~ (^|/)codex($|[-/]) ]]; then
  echo "archon branch guard: do not use 'codex' in branch names" >&2
  exit 1
fi

override_prefixes=""
if [[ -f "AGENTS.md" ]]; then
  override_prefixes="$(sed -n 's/^branch_naming_override_prefixes=//p' AGENTS.md | head -n 1)"
fi

default_prefixes=(
  "feature/"
  "bugfix/"
  "hotfix/"
  "release/"
  "chore/"
  "refactor/"
  "docs/"
  "test/"
  "ci/"
  "perf/"
)

allowed_prefixes=()
if [[ -n "$override_prefixes" ]]; then
  IFS=',' read -r -a allowed_prefixes <<<"$override_prefixes"
else
  allowed_prefixes=("${default_prefixes[@]}")
fi

for prefix in "${allowed_prefixes[@]}"; do
  trimmed_prefix="$(printf '%s' "$prefix" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [[ -n "$trimmed_prefix" && "$branch_name" == "$trimmed_prefix"* ]]; then
    exit 0
  fi
done

printf 'archon branch guard: branch "%s" must start with one of: %s\n' \
  "$branch_name" \
  "$(IFS=', '; printf '%s' "${allowed_prefixes[*]}")" >&2
exit 1
