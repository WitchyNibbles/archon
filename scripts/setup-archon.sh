#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
  echo "created .env from .env.example"
fi

is_safe_env_key() {
  [[ "$1" =~ ^ARCHON_[A-Z0-9_]+$ ]]
}

trim_leading_whitespace() {
  local value="$1"
  while [[ "$value" == [[:space:]]* ]]; do
    value="${value#?}"
  done
  printf '%s' "$value"
}

trim_trailing_whitespace() {
  local value="$1"
  while [[ "$value" == *[[:space:]] ]]; do
    value="${value%?}"
  done
  printf '%s' "$value"
}

strip_unquoted_comment() {
  local input="$1"
  local output=""
  local previous=""
  local i ch

  for ((i = 0; i < ${#input}; i++)); do
    ch="${input:i:1}"
    if [[ "$ch" == "#" && ( -z "$output" || "$previous" =~ [[:space:]] ) ]]; then
      break
    fi
    output+="$ch"
    previous="$ch"
  done

  output="$(trim_trailing_whitespace "$output")"
  printf '%s' "$output"
}

unescape_double_quoted_value() {
  local value="$1"
  value="${value//\\\\/\\}"
  value="${value//\\\"/\"}"
  value="${value//\\n/$'\n'}"
  value="${value//\\r/$'\r'}"
  value="${value//\\t/$'\t'}"
  value="${value//\\$/\$}"
  printf '%s' "$value"
}

extract_double_quoted_inner() {
  local input="$1"
  local output=""
  local escaped=0
  local i ch

  for ((i = 1; i < ${#input}; i++)); do
    ch="${input:i:1}"
    if [[ $escaped -eq 1 ]]; then
      output+="\\$ch"
      escaped=0
      continue
    fi

    if [[ "$ch" == "\\" ]]; then
      escaped=1
      continue
    fi

    if [[ "$ch" == '"' ]]; then
      break
    fi

    output+="$ch"
  done

  printf '%s' "$output"
}

load_env_file() {
  local env_file="$1"
  local line key raw_value value

  if [[ ! -f "$env_file" ]]; then
    return 0
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi

    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      raw_value="${BASH_REMATCH[3]}"
      if ! is_safe_env_key "$key"; then
        continue
      fi

      if [[ -n "${!key+x}" ]]; then
        continue
      fi

      value="$(trim_leading_whitespace "$raw_value")"

      if [[ "${value:0:1}" == '"' ]]; then
        value="$(extract_double_quoted_inner "$value")"
        value="$(unescape_double_quoted_value "$value")"
      elif [[ "${value:0:1}" == "'" ]]; then
        value="${value:1}"
        if [[ "$value" == *"'"* ]]; then
          value="${value%%"'"*}"
        fi
      else
        value="$(strip_unquoted_comment "$value")"
      fi

      printf -v "$key" '%s' "$value"
      export "$key"
    fi
  done < "$env_file"
}

resolve_npm_script() {
  local preferred="$1"
  local fallback="$2"

  node --input-type=module - "$preferred" "$fallback" <<'EOF'
import { readFileSync } from "node:fs";

const [, , preferred, fallback] = process.argv;
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const scripts =
  packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : undefined;

if (scripts && typeof scripts[preferred] === "string") {
  process.stdout.write(preferred);
  process.exit(0);
}

if (scripts && typeof scripts[fallback] === "string") {
  process.stdout.write(fallback);
  process.exit(0);
}

console.error(`missing npm script aliases: ${preferred} or ${fallback}`);
process.exit(1);
EOF
}

run_archon_npm_script() {
  local script_name
  script_name="$(resolve_npm_script "$1" "$2")"
  npm run "$script_name"
}

has_npm_script() {
  resolve_npm_script "$1" "$2" >/dev/null 2>&1
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

normalize_runtime_mode() {
  local candidate="${1:-auto}"
  case "${candidate,,}" in
    ""|auto)
      printf 'auto\n'
      ;;
    docker|native|managed)
      printf '%s\n' "${candidate,,}"
      ;;
    *)
      fail "invalid ARCHON_RUNTIME_MODE: ${candidate}"
      ;;
  esac
}

derive_runtime_mode_from_profile() {
  local candidate="${1:-}"
  case "${candidate,,}" in
    local-docker)
      printf 'docker\n'
      ;;
    local-native)
      printf 'native\n'
      ;;
    managed)
      printf 'managed\n'
      ;;
    *)
      printf '\n'
      ;;
  esac
}

runtime_profile_for_mode() {
  case "$1" in
    docker)
      printf 'local-docker\n'
      ;;
    native)
      printf 'local-native\n'
      ;;
    managed)
      printf 'managed\n'
      ;;
    *)
      fail "unsupported runtime mode: $1"
      ;;
  esac
}

docker_runtime_available() {
  command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1
}

resolve_runtime_mode() {
  local requested_mode="$1"
  if [[ "$requested_mode" != "auto" ]]; then
    printf '%s\n' "$requested_mode"
    return
  fi

  local profile_mode
  profile_mode="$(derive_runtime_mode_from_profile "${ARCHON_RUNTIME_PROFILE:-}")"
  if [[ "$profile_mode" == "managed" || "$profile_mode" == "native" ]]; then
    printf '%s\n' "$profile_mode"
    return
  fi

  if docker_runtime_available; then
    printf 'docker\n'
    return
  fi

  if [[ "$(uname -s)" == "Linux" ]]; then
    printf 'native\n'
    return
  fi

  fail "docker runtime is unavailable and native fallback is only supported on Linux; set ARCHON_RUNTIME_MODE=managed or install Docker"
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  command -v sudo >/dev/null 2>&1 || fail "sudo is required for native runtime setup"
  sudo --non-interactive "$@"
}

run_as_postgres() {
  if command -v sudo >/dev/null 2>&1; then
    sudo -u postgres "$@"
    return
  fi

  command -v runuser >/dev/null 2>&1 || fail "sudo or runuser is required for PostgreSQL administration"
  runuser -u postgres -- "$@"
}

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1
}

apt_available() {
  command -v apt-get >/dev/null 2>&1 && command -v apt-cache >/dev/null 2>&1
}

apt_search_first_package() {
  local pattern="$1"
  apt-cache search "$pattern" 2>/dev/null | awk 'NF > 0 { print $1; exit }'
}

sql_escape_literal() {
  printf '%s' "$1" | sed "s/'/''/g"
}

load_env_file ./.env

if [[ -z "${ARCHON_PROJECT_REPO_PATH:-}" || "${ARCHON_PROJECT_REPO_PATH}" == "/absolute/path/to/repo" ]]; then
  export ARCHON_PROJECT_REPO_PATH="$REPO_ROOT"
fi

if [[ -z "${ARCHON_PROJECT_SLUG:-}" ]]; then
  export ARCHON_PROJECT_SLUG="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
fi

if [[ -z "${ARCHON_PROJECT_NAME:-}" ]]; then
  export ARCHON_PROJECT_NAME="${ARCHON_PROJECT_SLUG}"
fi

if [[ -z "${ARCHON_WORKSPACE_SLUG:-}" ]]; then
  export ARCHON_WORKSPACE_SLUG="default"
fi

if [[ -z "${ARCHON_WORKSPACE_NAME:-}" ]]; then
  export ARCHON_WORKSPACE_NAME="Default Workspace"
fi

if [[ -z "${ARCHON_DOCKER_CONTAINER_NAME:-}" ]]; then
  export ARCHON_DOCKER_CONTAINER_NAME="archon-postgres-${ARCHON_PROJECT_SLUG}"
fi

if [[ -z "${ARCHON_RUNTIME_DATA_ROOT:-}" ]]; then
  export ARCHON_RUNTIME_DATA_ROOT="$HOME/.local/share/archon/${ARCHON_PROJECT_SLUG}"
fi

if [[ -z "${ARCHON_POSTGRES_PORT:-}" ]]; then
  export ARCHON_POSTGRES_PORT="5432"
fi

if [[ -z "${ARCHON_POSTGRES_PASSWORD:-}" || "${ARCHON_POSTGRES_PASSWORD}" == "archon" ]]; then
  fail "ARCHON_POSTGRES_PASSWORD must be set to a non-default local password before setup continues"
fi

if [[ -z "${ARCHON_CORE_DATABASE_URL:-}" ]]; then
  export ARCHON_CORE_DATABASE_URL="postgres://${ARCHON_POSTGRES_USER:-archon}:${ARCHON_POSTGRES_PASSWORD}@127.0.0.1:${ARCHON_POSTGRES_PORT}/${ARCHON_POSTGRES_DB:-archon}"
fi

wait_for_container_health() {
  local container_name="$1"
  local label="$2"

  echo "waiting for ${label} to become healthy"
  for _ in {1..60}; do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$container_name" 2>/dev/null || true)" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "${label} did not become healthy" >&2
  docker logs "$container_name" --tail 100 >&2 || true
  exit 1
}


wait_for_postgres_native() {
  echo "waiting for PostgreSQL to accept local connections"
  for _ in {1..60}; do
    if run_as_postgres pg_isready -q >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  fail "postgresql did not become ready"
}

ensure_native_linux_support() {
  [[ "$(uname -s)" == "Linux" ]] || fail "native runtime mode is only supported on Linux and WSL"
  systemd_available || fail "native runtime mode requires systemd; on WSL enable systemd or use ARCHON_RUNTIME_MODE=managed"
  [[ "${ARCHON_POSTGRES_PORT}" == "5432" ]] || fail "native runtime mode currently supports ARCHON_POSTGRES_PORT=5432 only"
}

ensure_native_postgres_tools() {
  if command -v psql >/dev/null 2>&1 && command -v pg_isready >/dev/null 2>&1; then
    return
  fi

  apt_available || fail "native runtime mode requires PostgreSQL client tools or apt-get support"
  run_privileged apt-get update
  run_privileged apt-get install -y postgresql postgresql-contrib postgresql-client
}


ensure_native_pgvector_available() {
  local available
  available="$(run_as_postgres psql -Atqc "select 1 from pg_available_extensions where name = 'vector'" postgres 2>/dev/null || true)"
  if [[ "$available" == "1" ]]; then
    return
  fi

  apt_available || fail "native runtime mode requires pgvector to be installed for PostgreSQL"
  local package_name
  package_name="$(apt_search_first_package 'pgvector')"
  [[ -n "$package_name" ]] || fail "native runtime mode could not find a pgvector package; install pgvector locally before rerunning setup"
  run_privileged apt-get update
  run_privileged apt-get install -y "$package_name"
}

ensure_native_postgres_database() {
  local escaped_user escaped_db escaped_password role_exists db_exists
  escaped_user="$(sql_escape_literal "${ARCHON_POSTGRES_USER:-archon}")"
  escaped_db="$(sql_escape_literal "${ARCHON_POSTGRES_DB:-archon}")"
  escaped_password="$(sql_escape_literal "${ARCHON_POSTGRES_PASSWORD}")"

  role_exists="$(run_as_postgres psql -Atqc "select 1 from pg_roles where rolname = '${escaped_user}'" postgres 2>/dev/null || true)"
  if [[ "$role_exists" != "1" ]]; then
    run_as_postgres psql -v ON_ERROR_STOP=1 -c "create role \"${ARCHON_POSTGRES_USER:-archon}\" with login password '${escaped_password}'" postgres
  else
    run_as_postgres psql -v ON_ERROR_STOP=1 -c "alter role \"${ARCHON_POSTGRES_USER:-archon}\" with login password '${escaped_password}'" postgres
  fi

  db_exists="$(run_as_postgres psql -Atqc "select 1 from pg_database where datname = '${escaped_db}'" postgres 2>/dev/null || true)"
  if [[ "$db_exists" != "1" ]]; then
    run_as_postgres psql -v ON_ERROR_STOP=1 -c "create database \"${ARCHON_POSTGRES_DB:-archon}\" owner \"${ARCHON_POSTGRES_USER:-archon}\"" postgres
  fi

  run_as_postgres psql -v ON_ERROR_STOP=1 -d "${ARCHON_POSTGRES_DB:-archon}" -c "create extension if not exists vector"
}


setup_docker_runtime() {
  docker_runtime_available || fail "docker runtime mode selected but Docker is not available; use ARCHON_RUNTIME_MODE=native or managed instead"
  docker compose up -d archon-postgres

  wait_for_container_health "${ARCHON_DOCKER_CONTAINER_NAME}" "archon-postgres"
}

setup_native_runtime() {
  ensure_native_linux_support
  ensure_native_postgres_tools

  run_privileged systemctl enable --now postgresql
  wait_for_postgres_native
  ensure_native_pgvector_available
  ensure_native_postgres_database
}

setup_managed_runtime() {
  :
}

requested_runtime_mode="$(normalize_runtime_mode "${ARCHON_RUNTIME_MODE:-auto}")"
runtime_mode="$(resolve_runtime_mode "$requested_runtime_mode")"
export ARCHON_RUNTIME_MODE="$runtime_mode"
export ARCHON_RUNTIME_PROFILE="$(runtime_profile_for_mode "$runtime_mode")"

case "$runtime_mode" in
  docker)
    setup_docker_runtime
    ;;
  native)
    setup_native_runtime
    ;;
  managed)
    setup_managed_runtime
    ;;
  *)
    fail "unsupported runtime mode: $runtime_mode"
    ;;
esac

if [[ ! -d node_modules ]]; then
  npm install
fi

if [[ -f .archon/install-manifest.json ]] && git rev-parse --show-toplevel >/dev/null 2>&1; then
  npm run archon:setup:git-guard
fi

if has_npm_script "archon:setup:playwright" "setup:playwright"; then
  npm run archon:setup:playwright
fi

run_archon_npm_script "archon:migrate" "migrate"
run_archon_npm_script "archon:bootstrap" "bootstrap"
if [[ -f .archon/work/task-queue.json ]]; then
  npm run archon:repair-task-queue
fi
npm run archon:refresh-repo-context
npm run archon:refresh-retrieval:fast
run_archon_npm_script "archon:verify:setup" "verify:setup"
if has_npm_script "archon:verify:playwright" "verify:playwright"; then
  npm run archon:verify:playwright
fi

ensure_graphify_installed() {
  if command -v graphify >/dev/null 2>&1; then
    return 0
  fi

  echo "graphify not found; installing graphifyy..."
  if command -v uv >/dev/null 2>&1; then
    uv tool install graphifyy
    export PATH="$HOME/.local/bin:$PATH"
  elif command -v pip3 >/dev/null 2>&1; then
    pip3 install --user graphifyy
    export PATH="$HOME/.local/bin:$PATH"
  elif command -v pip >/dev/null 2>&1; then
    pip install --user graphifyy
    export PATH="$HOME/.local/bin:$PATH"
  else
    echo "warning: graphify could not be installed (no uv or pip found)" >&2
    echo "run 'uv tool install graphifyy' manually, then 'npm run archon:graphify:build'" >&2
    return 1
  fi
}

run_graphify_initial_build() {
  if ! command -v graphify >/dev/null 2>&1; then
    echo "graphify not available; skipping initial graph build"
    return
  fi

  if [[ -f graphify-out/graph.json ]]; then
    echo "graphify graph already exists; skipping initial build"
    return
  fi

  echo "running graphify initial build (this may take a few minutes)..."
  if ! graphify . --wiki; then
    echo ""
    echo "graphify initial build did not complete; run 'npm run archon:graphify:build' when LLM credentials are available"
  fi
}

ensure_graphify_installed
run_graphify_initial_build

echo ""
echo "archon local setup complete"
echo "runtime mode: ${ARCHON_RUNTIME_MODE}"
echo "workspace: ${ARCHON_WORKSPACE_SLUG:-default}"
echo "project: ${ARCHON_PROJECT_SLUG:-unknown}"
echo "database: configured"
echo "playwright: configured"
