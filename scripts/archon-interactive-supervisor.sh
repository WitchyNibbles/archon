#!/usr/bin/env bash
# archon-interactive-supervisor.sh — Phase 4 (ahrP4InteractiveWatcher)
#
# External supervisor for an interactive `claude` session.
# Relaunches a fresh claude -p when the session crosses the context threshold
# and the Stop hook has written a resume-request.
#
# Usage:
#   bash scripts/archon-interactive-supervisor.sh [--help]
#
# Environment variables:
#   ARCHON_CWD                              working directory (default: cwd)
#   ARCHON_CLAUDE_BIN                       claude binary (default: claude)
#   ARCHON_SUPERVISOR_MAX_RESPAWNS          max relaunch attempts (default: 8)
#   ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS   stale-request threshold (default: 300)
#
# Exit codes:
#   0  normal exit (no resume-request, or handled + done)
#   1  error (stale request archived, daemon-owned lease, etc.)
#
# Operator wiring (.claude/settings.json Stop hook):
#
#   "hooks": {
#     "Stop": [{
#       "matcher": "",
#       "hooks": [{
#         "type": "command",
#         "command": "node /path/to/src/runtime/interactive-stop-hook-cli.js"
#       }]
#     }]
#   }
#
#   Run the supervisor in the background before your first claude session:
#
#     bash scripts/archon-interactive-supervisor.sh &
#     SUPER_PID=$!
#     claude ...           # Stop hook writes resume-request on context threshold
#     wait "${SUPER_PID}"
#
# SECURITY (INFRA-C3 / SEC-HIGH-2):
#   - promptPath validated: no "..", no shell metacharacters, relative only,
#     must be under .archon/work/daemon/.
#   - claude command built as a safe argument array — never eval/exec a
#     stored shellCommand string.
#   - Stale/rejected requests archived under
#     .archon/work/daemon/rejected-resume-requests/ (not silently deleted).
#   - Daemon-owned lease (respawn-lease.json owner=daemon) = zero relaunches.
#   - Max-respawns guard prevents infinite continuation loops.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ARCHON_CWD="${ARCHON_CWD:-$(pwd)}"
ARCHON_CLAUDE_BIN="${ARCHON_CLAUDE_BIN:-claude}"
ARCHON_SUPERVISOR_MAX_RESPAWNS="${ARCHON_SUPERVISOR_MAX_RESPAWNS:-8}"
ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS="${ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS:-300}"

DAEMON_DIR="${ARCHON_CWD}/.archon/work/daemon"
RESUME_REQUEST_PATH="${DAEMON_DIR}/interactive-resume-request.json"
LEASE_PATH="${DAEMON_DIR}/respawn-lease.json"
ARCHIVE_DIR="${DAEMON_DIR}/rejected-resume-requests"

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '/^# archon-interactive-supervisor/,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_info() {
  printf '[archon-supervisor] %s\n' "$*" >&2
}

log_error() {
  printf '[archon-supervisor][ERROR] %s\n' "$*" >&2
}

# ---------------------------------------------------------------------------
# Archive stale/rejected requests (not silently deleted)
# ---------------------------------------------------------------------------

archive_request() {
  local req_path="$1"
  mkdir -p "${ARCHIVE_DIR}"
  local ts
  ts="$(date +%s)"
  local bname
  bname="$(basename "${req_path}")"
  local dst="${ARCHIVE_DIR}/${ts}-${bname}"
  # Copy then remove original (preserve on copy failure)
  cp "${req_path}" "${dst}" && rm -f "${req_path}" || true
  log_info "archived to ${dst}"
}

# ---------------------------------------------------------------------------
# Parse resume-request JSON via a single python3 call (efficiency + safety)
# Outputs: "run_id|task_id|prompt_path|created_at|schema_version|mode"
# Returns 1 if python3 or parsing fails.
# ---------------------------------------------------------------------------

parse_resume_request() {
  local json_path="$1"
  python3 - "${json_path}" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    fields = [
        str(d.get("runId", "")),
        str(d.get("taskId", "")),
        str(d.get("promptPath", "")),
        str(d.get("createdAt", "")),
        str(d.get("schemaVersion", "")),
        str(d.get("mode", ""))
    ]
    print("|".join(fields))
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
}

# Parse lease JSON. Outputs: "owner|run_id|claimed_at"
parse_lease() {
  local lease_path="$1"
  python3 - "${lease_path}" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    print("|".join([
        str(d.get("owner", "")),
        str(d.get("runId", "")),
        str(d.get("claimedAt", ""))
    ]))
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
}

# ---------------------------------------------------------------------------
# Validate resume-request (schema + path-safety + freshness)
# Sets VREQ_RUN_ID, VREQ_TASK_ID, VREQ_PROMPT_PATH on success.
# Returns 0 if valid, 1 otherwise.
# ---------------------------------------------------------------------------

VREQ_RUN_ID=""
VREQ_TASK_ID=""
VREQ_PROMPT_PATH=""

validate_resume_request() {
  local req_path="$1"

  local parsed
  if ! parsed="$(parse_resume_request "${req_path}")"; then
    log_error "failed to parse resume-request JSON"
    return 1
  fi

  local run_id task_id prompt_path created_at schema_version mode
  run_id="$(echo "${parsed}" | cut -d'|' -f1)"
  task_id="$(echo "${parsed}" | cut -d'|' -f2)"
  prompt_path="$(echo "${parsed}" | cut -d'|' -f3)"
  created_at="$(echo "${parsed}" | cut -d'|' -f4)"
  schema_version="$(echo "${parsed}" | cut -d'|' -f5)"
  mode="$(echo "${parsed}" | cut -d'|' -f6)"

  # Schema check
  if [ "${schema_version}" != "1" ]; then
    log_error "invalid schemaVersion: ${schema_version}"
    return 1
  fi
  if [ "${mode}" != "fresh_run" ]; then
    log_error "invalid mode: ${mode} (expected fresh_run)"
    return 1
  fi
  if [ -z "${run_id}" ] || [ -z "${task_id}" ] || [ -z "${prompt_path}" ] || [ -z "${created_at}" ]; then
    log_error "resume-request missing required fields"
    return 1
  fi

  # Absolute path check (must be relative) — INFRA-C3/SEC-HIGH-2
  case "${prompt_path}" in
    /*)
      log_error "promptPath must be relative, got: ${prompt_path}"
      return 1
      ;;
  esac

  # Path traversal check
  case "${prompt_path}" in
    *..*)
      log_error "promptPath contains path traversal (..): ${prompt_path}"
      return 1
      ;;
  esac

  # Shell metacharacter check — strip allowed chars and check if anything remains.
  # Allowed: alphanumeric, forward-slash, underscore, hyphen, dot.
  # Uses tr to delete safe chars; if result is non-empty, path has unsafe chars.
  local stripped
  stripped="$(printf '%s' "${prompt_path}" | tr -d 'a-zA-Z0-9/_.-')"
  if [ -n "${stripped}" ]; then
    log_error "promptPath contains unsafe characters: ${prompt_path}"
    return 1
  fi

  # Must be under the required prefix
  case "${prompt_path}" in
    .archon/work/daemon/*)
      ;;
    *)
      log_error "promptPath must be under .archon/work/daemon/: ${prompt_path}"
      return 1
      ;;
  esac

  # Freshness check
  local now_epoch created_epoch age_seconds
  now_epoch="$(date +%s)"
  created_epoch="$(python3 -c "
import datetime, sys
try:
    dt = datetime.datetime.fromisoformat('${created_at}'.replace('Z', '+00:00'))
    print(int(dt.timestamp()))
except Exception as e:
    print(0)
" 2>/dev/null || echo 0)"
  age_seconds=$(( now_epoch - created_epoch ))
  if [ "${age_seconds}" -gt "${ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS}" ]; then
    log_error "resume-request is stale: age ${age_seconds}s > max ${ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS}s"
    return 1
  fi

  VREQ_RUN_ID="${run_id}"
  VREQ_TASK_ID="${task_id}"
  VREQ_PROMPT_PATH="${prompt_path}"
  return 0
}

# ---------------------------------------------------------------------------
# Lease check — returns 0 if watcher may proceed, 1 if daemon owns the lease
# ---------------------------------------------------------------------------

check_lease() {
  local target_run_id="$1"

  if [ ! -f "${LEASE_PATH}" ]; then
    return 0
  fi

  local parsed owner lease_run_id claimed_at
  if ! parsed="$(parse_lease "${LEASE_PATH}")"; then
    # Cannot parse lease — treat as stale, allow watcher to proceed
    return 0
  fi

  owner="$(echo "${parsed}" | cut -d'|' -f1)"
  lease_run_id="$(echo "${parsed}" | cut -d'|' -f2)"
  claimed_at="$(echo "${parsed}" | cut -d'|' -f3)"

  # Different run — not our concern
  if [ "${lease_run_id}" != "${target_run_id}" ]; then
    return 0
  fi

  # Check staleness
  if [ -n "${claimed_at}" ]; then
    local now_epoch claimed_epoch age_seconds
    now_epoch="$(date +%s)"
    claimed_epoch="$(python3 -c "
import datetime, sys
try:
    dt = datetime.datetime.fromisoformat('${claimed_at}'.replace('Z', '+00:00'))
    print(int(dt.timestamp()))
except:
    print(0)
" 2>/dev/null || echo 0)"
    age_seconds=$(( now_epoch - claimed_epoch ))
    if [ "${age_seconds}" -gt "${ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS}" ]; then
      log_info "daemon lease stale (${age_seconds}s); watcher may proceed"
      return 0
    fi
  fi

  if [ "${owner}" = "daemon" ]; then
    log_info "daemon owns lease for run ${target_run_id}; watcher no-op"
    return 1
  fi

  return 0
}

# Write watcher lease claim (atomic write)
claim_watcher_lease() {
  local target_run_id="$1"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local tmp="${LEASE_PATH}.tmp.$$"
  printf '{"runId":"%s","owner":"interactive","claimedAt":"%s"}\n' "${target_run_id}" "${ts}" > "${tmp}"
  mv "${tmp}" "${LEASE_PATH}"
}

# ---------------------------------------------------------------------------
# Main relaunch loop
# ---------------------------------------------------------------------------

respawn_count=0

log_info "started (max_respawns=${ARCHON_SUPERVISOR_MAX_RESPAWNS}, max_age=${ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS}s, cwd=${ARCHON_CWD})"

while true; do
  # No resume-request: normal exit
  if [ ! -f "${RESUME_REQUEST_PATH}" ]; then
    log_info "no resume-request found; exiting"
    exit 0
  fi

  # Validate
  if ! validate_resume_request "${RESUME_REQUEST_PATH}"; then
    archive_request "${RESUME_REQUEST_PATH}"
    log_info "invalid/stale request archived; exiting"
    exit 1
  fi

  run_id="${VREQ_RUN_ID}"
  task_id="${VREQ_TASK_ID}"
  prompt_path="${VREQ_PROMPT_PATH}"

  log_info "resume-request: run=${run_id} task=${task_id} prompt=${prompt_path}"

  # Lease check
  if ! check_lease "${run_id}"; then
    archive_request "${RESUME_REQUEST_PATH}"
    log_info "daemon owns lease; exiting without relaunch"
    exit 0
  fi

  # Budget check
  if [ "${respawn_count}" -ge "${ARCHON_SUPERVISOR_MAX_RESPAWNS}" ]; then
    log_error "max respawns (${ARCHON_SUPERVISOR_MAX_RESPAWNS}) reached; exiting"
    exit 1
  fi

  # Claim watcher lease (before spawning)
  claim_watcher_lease "${run_id}"

  # Consume the request before spawning (prevents double-spawn on crash)
  rm -f "${RESUME_REQUEST_PATH}"

  respawn_count=$(( respawn_count + 1 ))
  log_info "relaunch ${respawn_count}/${ARCHON_SUPERVISOR_MAX_RESPAWNS}: run=${run_id}"

  # Validate prompt file exists
  prompt_full="${ARCHON_CWD}/${prompt_path}"
  if [ ! -f "${prompt_full}" ]; then
    log_error "continuation prompt file not found: ${prompt_full}"
    exit 1
  fi

  # Launch claude as a SAFE ARGUMENT ARRAY — never eval/exec a stored command string.
  # fresh_run only: -p flag, no --resume (INFRA-C3/SEC-HIGH-2).
  "${ARCHON_CLAUDE_BIN}" -p "$(cat "${prompt_full}")" || true

  log_info "session ended; checking for next resume-request"
  sleep 1
done
