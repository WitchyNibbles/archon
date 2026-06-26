#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [[ $# -lt 1 ]]; then
  echo "usage: bash scripts/install-archon.sh /path/to/project [--with-grafana] [--with-obsidian]" >&2
  exit 1
fi

node --experimental-strip-types src/install/cli.ts init --apply --target "$1" "${@:2}"
