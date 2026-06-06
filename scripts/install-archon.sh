#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [[ $# -ne 1 ]]; then
  echo "usage: bash scripts/install-archon.sh /path/to/project" >&2
  exit 1
fi

node --experimental-strip-types src/install/cli.ts --target "$1"
