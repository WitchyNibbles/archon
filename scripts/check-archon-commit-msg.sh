#!/usr/bin/env bash

set -euo pipefail

msg_file="${1:-}"

if [[ -z "$msg_file" || ! -f "$msg_file" ]]; then
  echo "archon commit message guard requires the commit message file path" >&2
  exit 1
fi

subject="$(sed -n '1{ s/\r$//; p; }' "$msg_file")"
normalized_subject="${subject,,}"

if [[ -z "$subject" ]]; then
  echo "archon commit message guard: commit subject must not be empty" >&2
  exit 1
fi

if [[ "$subject" =~ ^Merge[[:space:]] || "$subject" =~ ^Revert[[:space:]] ]]; then
  exit 0
fi

if (( ${#subject} > 72 )); then
  echo "archon commit message guard: keep the subject at 72 characters or fewer" >&2
  exit 1
fi

if [[ "$subject" =~ \.$ ]]; then
  echo "archon commit message guard: omit the trailing period from the subject" >&2
  exit 1
fi

if [[ "$normalized_subject" =~ (^|[^a-z0-9])codex([^a-z0-9]|$) ]]; then
  echo "archon commit message guard: do not use 'codex' in the commit subject" >&2
  exit 1
fi

if ! [[ "$subject" =~ ^(feat|fix|refactor|docs|test|chore|perf|ci)(\([A-Za-z0-9._/-]+\))?!?:[[:space:]][A-Za-z0-9] ]]; then
  echo "archon commit message guard: use a brief conventional subject such as 'fix: tighten git guard'" >&2
  exit 1
fi
