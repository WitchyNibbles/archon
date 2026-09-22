#!/usr/bin/env bash
# The blocking gate: lint, types, and every test that needs no model and no
# quota. Tests marked `live` are excluded here and are proven separately by
# scripts/live_smoke.py and scripts/native_smoke.py; scripts/package_smoke.py
# proves the distribution and spends nothing. Extra arguments go to pytest.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
uv run --locked ruff check src tests scripts
uv run --locked mypy
uv run --locked pytest -m 'not live' "$@"
