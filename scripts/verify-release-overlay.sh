#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "tests"
npm test

echo "repo-local package checks"
npm run check:quality

echo "review identity"
npm run verify:review-identity

echo "release overlay checks passed"
