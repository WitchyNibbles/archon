#!/usr/bin/env bash
# install-archon.sh — thin shim that delegates to the compiled archon bin.
#
# This script works in two contexts:
#   (a) Inside the archon source repo (dev): REPO_ROOT/dist/cli/archon-bin.js
#       must exist.  Run 'npm run build:dist' first if it does not.
#   (b) Installed in a consumer project as node_modules/@witchynibbles/archon/scripts/:
#       the package always ships dist/**, so the bin is always present.
#
# The shim invokes the compiled bin only — no TypeScript source flags needed.
# All installer flags (--target, --with-grafana, --with-obsidian, …) are
# passed through unchanged to the compiled CLI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ $# -lt 1 ]]; then
  printf 'usage: bash scripts/install-archon.sh /path/to/project [--with-grafana] [--with-obsidian]\n' >&2
  exit 1
fi

BIN="$REPO_ROOT/dist/cli/archon-bin.js"

if [[ ! -f "$BIN" ]]; then
  printf 'error: compiled bin not found at %s\n' "$BIN" >&2
  printf '  (run "npm run build:dist" in the archon repo and then retry)\n' >&2
  exit 1
fi

exec node "$BIN" init --apply --target "$1" "${@:2}"
