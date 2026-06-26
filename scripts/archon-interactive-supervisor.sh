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
#   - resume-request ATOMICALLY mv'd to process-local name BEFORE validation
#     (TOCTOU prevention: concurrent supervisor cannot swap file post-read).
#   - promptPath validated: no "..", no shell metacharacters, relative only,
#     must be under .archon/work/daemon/.
#   - runId and taskId validated: ^[A-Za-z0-9_-]+$ whitelist before path use.
#   - claude command built as a safe argument array with -- separator;
#     never eval/exec a stored command string.
#   - Python date parsing uses ARGV (sys.argv[1]), never string interpolation
#     into -c "..." (prevents code injection via crafted timestamps).
#   - Stale/rejected requests archived under
#     .archon/work/daemon/rejected-resume-requests/ (not silently deleted).
#   - Daemon-owned lease (respawn-lease-<runId>.lock owner=daemon) = 0 relaunches.
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
  # Copy then remove original (preserve the original if the copy fails).
  # Use an explicit if rather than `cp && rm || true` (SC2015: A && B || C is
  # not if-then-else — C can run even when A succeeds); under `set -e` the if
  # condition failing does not abort, so a failed copy leaves the original intact.
  if cp "${req_path}" "${dst}"; then
    rm -f "${req_path}" || true
  fi
  log_info "archived to ${dst}"
}

# ---------------------------------------------------------------------------
# Parse resume-request JSON via a single python3 call (efficiency + safety)
# Outputs: "run_id|task_id|prompt_path|created_at|schema_version|mode"
# Returns 1 if python3 or parsing fails.
# All values passed via sys.argv (NEVER string-interpolated into -c "...").
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

# Parse lock file JSON. Outputs: "owner|run_id|claimed_at"
# lock_path is passed as sys.argv[1] — never interpolated into -c.
parse_lock() {
  local lock_path="$1"
  python3 - "${lock_path}" <<'PYEOF'
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

# Compute seconds since an ISO-8601 timestamp.
# BLOCKING-1 fix: timestamp is passed as sys.argv[1] (not interpolated into
# python3 -c "...${var}..." which allows code injection via crafted values).
iso_age_seconds() {
  local iso_ts="$1"
  python3 - "${iso_ts}" <<'PYEOF'
import datetime, sys
try:
    dt = datetime.datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(int((now - dt).total_seconds()))
except Exception:
    print(999999)
PYEOF
}

# ---------------------------------------------------------------------------
# runId / taskId charset validation (MED-2 / non-blocking 6)
# Accepts only ^[A-Za-z0-9_-]+$ — rejects empty or values with other chars.
# ---------------------------------------------------------------------------

validate_id_charset() {
  local id="$1"
  local label="$2"
  if [ -z "${id}" ]; then
    log_error "${label} is empty"
    return 1
  fi
  # Strip safe chars; if anything remains the id is unsafe.
  local stripped
  stripped="$(printf '%s' "${id}" | tr -d 'A-Za-z0-9_-')"
  if [ -n "${stripped}" ]; then
    log_error "${label} contains unsafe characters: ${id}"
    return 1
  fi
}

# Sanitize an id for use in a file path (mirrors Node's sanitizeIdForPath).
sanitize_id_for_path() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_'
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
  run_id="$(printf '%s' "${parsed}" | cut -d'|' -f1)"
  task_id="$(printf '%s' "${parsed}" | cut -d'|' -f2)"
  prompt_path="$(printf '%s' "${parsed}" | cut -d'|' -f3)"
  created_at="$(printf '%s' "${parsed}" | cut -d'|' -f4)"
  schema_version="$(printf '%s' "${parsed}" | cut -d'|' -f5)"
  mode="$(printf '%s' "${parsed}" | cut -d'|' -f6)"

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

  # runId / taskId charset validation (MED-2) — before any path construction.
  if ! validate_id_charset "${run_id}" "runId"; then
    return 1
  fi
  if ! validate_id_charset "${task_id}" "taskId"; then
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

  # Freshness check — BLOCKING-1 fix: iso_age_seconds passes created_at via
  # sys.argv[1], never interpolated into python3 -c "...${created_at}...".
  local age_seconds
  age_seconds="$(iso_age_seconds "${created_at}")"
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
# Lease check — returns 0 if watcher may proceed, 1 if daemon owns the lease.
#
# BLOCKING-2 fix: checks the UNIFIED file-lock path
#   .archon/work/daemon/respawn-lease-<sanitizedRunId>.lock
# (same path that Node's makeFileLockLeaseStore writes via O_CREAT|O_EXCL).
# Also checks the legacy respawn-lease.json for backward compatibility.
# ---------------------------------------------------------------------------

check_lease() {
  local target_run_id="$1"
  local safe_run_id
  safe_run_id="$(sanitize_id_for_path "${target_run_id}")"

  # Primary: unified file-lock path (matches Node makeFileLockLeaseStore).
  local lock_path="${DAEMON_DIR}/respawn-lease-${safe_run_id}.lock"
  # Legacy fallback: old single-file lease.
  local legacy_path="${DAEMON_DIR}/respawn-lease.json"

  _check_lease_file "${lock_path}" "${target_run_id}" && \
  _check_lease_file "${legacy_path}" "${target_run_id}"
}

# Returns 0 if watcher may proceed (no blocking daemon claim in this file).
# Returns 1 if a fresh daemon lease is found for target_run_id.
_check_lease_file() {
  local lease_file="$1"
  local target_run_id="$2"

  if [ ! -f "${lease_file}" ]; then
    return 0
  fi

  local parsed owner lease_run_id claimed_at
  if ! parsed="$(parse_lock "${lease_file}")"; then
    # Cannot parse lease — treat as stale, allow watcher to proceed.
    return 0
  fi

  owner="$(printf '%s' "${parsed}" | cut -d'|' -f1)"
  lease_run_id="$(printf '%s' "${parsed}" | cut -d'|' -f2)"
  claimed_at="$(printf '%s' "${parsed}" | cut -d'|' -f3)"

  # INFRA-C1 / SEC-HIGH (BLOCKING-3): validate owner is a known enum value
  # BEFORE using it in any comparison.  A crafted owner value containing '|'
  # could shift field positions; an unexpected value should never be trusted.
  if [ "${owner}" != "daemon" ] && [ "${owner}" != "interactive" ]; then
    log_error "_check_lease_file: unrecognised owner field '${owner}' in ${lease_file}; treating lock as corrupt — watcher may proceed"
    return 0
  fi

  # Different run — not our concern.
  if [ "${lease_run_id}" != "${target_run_id}" ]; then
    return 0
  fi

  # Check staleness — claimed_at passed via ARGV (iso_age_seconds).
  if [ -n "${claimed_at}" ]; then
    local age_seconds
    age_seconds="$(iso_age_seconds "${claimed_at}")"
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

# Claim watcher lease via atomic noclobber create (bash O_CREAT|O_EXCL).
# Uses the same unified lock path that Node reads.
# INFRA-C1 / SEC-HIGH: use bash noclobber (set -C) which maps to O_CREAT|O_EXCL.
# mv-based rename is NOT exclusive (overwrites existing files).  noclobber fails
# with EEXIST when the lock file already exists — exactly one concurrent caller wins.
# Returns 0 on success, 1 if the lock is already held (daemon or another watcher).
claim_watcher_lease() {
  local target_run_id="$1"
  local safe_run_id
  safe_run_id="$(sanitize_id_for_path "${target_run_id}")"
  local lock_path="${DAEMON_DIR}/respawn-lease-${safe_run_id}.lock"

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local content
  content="$(printf '{"runId":"%s","owner":"interactive","claimedAt":"%s"}' "${target_run_id}" "${ts}")"

  mkdir -p "${DAEMON_DIR}"

  # O_CREAT|O_EXCL via bash noclobber: exactly one concurrent caller succeeds.
  # On EEXIST the subshell writes to stderr which is suppressed; we return 1.
  if ( set -C; printf '%s\n' "${content}" > "${lock_path}" ) 2>/dev/null; then
    return 0
  fi

  # Lock already exists — may be daemon or a concurrent watcher.
  # Re-read the current owner and log; caller decides how to proceed.
  local cur_owner=""
  if [ -f "${lock_path}" ]; then
    local parsed
    if parsed="$(parse_lock "${lock_path}" 2>/dev/null)"; then
      cur_owner="$(printf '%s' "${parsed}" | cut -d'|' -f1)"
    fi
  fi
  log_info "claim_watcher_lease: lock already held (owner=${cur_owner:-unknown}); no-op"
  return 1
}

# ---------------------------------------------------------------------------
# Main relaunch loop
# ---------------------------------------------------------------------------

respawn_count=0

log_info "started (max_respawns=${ARCHON_SUPERVISOR_MAX_RESPAWNS}, max_age=${ARCHON_RESUME_REQUEST_MAX_AGE_SECONDS}s, cwd=${ARCHON_CWD})"

while true; do
  # No resume-request: normal exit.
  if [ ! -f "${RESUME_REQUEST_PATH}" ]; then
    log_info "no resume-request found; exiting"
    exit 0
  fi

  # BLOCKING-5 fix: TOCTOU prevention.
  # Atomically mv the resume-request to a process-local name BEFORE any
  # validation or content reading. After the mv, no concurrent supervisor can
  # observe or swap the file — exactly one process consumes it.
  local_request="${RESUME_REQUEST_PATH}.proc.$$"
  if ! mv "${RESUME_REQUEST_PATH}" "${local_request}" 2>/dev/null; then
    # Another process already consumed it (mv failed = file gone).
    log_info "resume-request already consumed by another process; exiting"
    exit 0
  fi

  # Validate the process-local copy.
  if ! validate_resume_request "${local_request}"; then
    archive_request "${local_request}"
    log_info "invalid/stale request archived; exiting"
    exit 1
  fi

  run_id="${VREQ_RUN_ID}"
  task_id="${VREQ_TASK_ID}"
  prompt_path="${VREQ_PROMPT_PATH}"

  log_info "resume-request: run=${run_id} task=${task_id} prompt=${prompt_path}"

  # Lease check (using the validated, safe run_id).
  if ! check_lease "${run_id}"; then
    archive_request "${local_request}"
    log_info "daemon owns lease; exiting without relaunch"
    exit 0
  fi

  # Budget check
  if [ "${respawn_count}" -ge "${ARCHON_SUPERVISOR_MAX_RESPAWNS}" ]; then
    log_error "max respawns (${ARCHON_SUPERVISOR_MAX_RESPAWNS}) reached; exiting"
    exit 1
  fi

  # Claim watcher lease (before spawning).
  # claim_watcher_lease returns 1 when the lock is already held (daemon or concurrent
  # watcher won the race).  In that case do not relaunch — archive and exit cleanly.
  if ! claim_watcher_lease "${run_id}"; then
    archive_request "${local_request}"
    log_info "could not claim watcher lease for run ${run_id}; another process holds it — exiting"
    exit 0
  fi

  # The local_request is already consumed (mv'd away from the shared path).
  # Remove it now to prevent reuse on restart.
  rm -f "${local_request}"

  respawn_count=$(( respawn_count + 1 ))
  log_info "relaunch ${respawn_count}/${ARCHON_SUPERVISOR_MAX_RESPAWNS}: run=${run_id}"

  # Validate prompt file exists.
  prompt_full="${ARCHON_CWD}/${prompt_path}"
  if [ ! -f "${prompt_full}" ]; then
    log_error "continuation prompt file not found: ${prompt_full}"
    exit 1
  fi

  # Launch claude as a SAFE ARGUMENT ARRAY — never eval/exec a stored command.
  # fresh_run only: -p flag, no --resume (INFRA-C3/SEC-HIGH-2).
  # Non-blocking 7 fix: use -- separator so prompt content starting with "--"
  # is not parsed as a flag by claude.
  "${ARCHON_CLAUDE_BIN}" -p -- "$(cat "${prompt_full}")" || true

  log_info "session ended; checking for next resume-request"
  sleep 1
done
