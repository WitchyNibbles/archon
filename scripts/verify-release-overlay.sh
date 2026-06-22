#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# check:quality runs `tsc --noEmit && npm test`, so it covers both typecheck and the
# full suite in one pass. (Previously this script also ran `npm test` separately,
# executing the whole suite twice per CI run.)
echo "typecheck + tests"
npm run check:quality

echo "release overlay checks passed"
