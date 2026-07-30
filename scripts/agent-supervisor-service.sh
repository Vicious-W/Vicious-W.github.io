#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_LIB="$ROOT_DIR/scripts/lib/agent-runtime.sh"
SERVICE_DIR="${AGENT_SUPERVISOR_SERVICE_DIR:-$ROOT_DIR/.agent/artifacts/supervisor/service}"
SERVICE_FILE="$SERVICE_DIR/service.env"
SUPERVISOR_STATE="$ROOT_DIR/.agent/artifacts/supervisor/state.env"
SUPERVISOR_COMMAND="${AGENT_SUPERVISOR_SERVICE_COMMAND:-$ROOT_DIR/scripts/agent-supervisor.sh}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$RUNTIME_LIB"
agent_runtime_init "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./scripts/agent-supervisor-service.sh start [supervisor options]
       ./scripts/agent-supervisor-service.sh status
       ./scripts/agent-supervisor-service.sh stop
       ./scripts/agent-supervisor-service.sh log [lines]

Runs persistent-cli supervision in a detached WSL session/process group so it
does not receive SIGHUP when the launching terminal or Agent tool call ends.
The detached process still uses agent-supervisor.sh for workflow locking,
checkpoints, quota waits and Agent orchestration.
EOF
}

service_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$SERVICE_FILE" 2>/dev/null | head -n 1
}

service_is_active() {
  local service_pid=""
  local expected_ticks=""
  local actual_ticks=""

  [[ -s "$SERVICE_FILE" ]] || return 1
  service_pid="$(service_value SERVICE_PID)"
  expected_ticks="$(service_value SERVICE_START_TICKS)"
  [[ "$service_pid" =~ ^[1-9][0-9]*$ && "$expected_ticks" =~ ^[0-9]+$ ]] || \
    return 1
  kill -0 "$service_pid" 2>/dev/null || return 1
  actual_ticks="$(agent_process_start_ticks "$service_pid")"
  [[ -n "$actual_ticks" && "$actual_ticks" == "$expected_ticks" ]]
}

write_active_service() {
  local launch_id="$1"
  local started_at="$2"
  local log_file="$3"
  local args_file="$4"
  local service_pid="$$"
  local start_ticks=""
  local state_tmp="$SERVICE_FILE.tmp"

  start_ticks="$(agent_process_start_ticks "$service_pid")"
  [[ "$start_ticks" =~ ^[0-9]+$ ]] || start_ticks=0
  mkdir -p "$SERVICE_DIR"
  {
    printf 'SERVICE_LAUNCH_ID=%s\n' "$launch_id"
    printf 'SERVICE_PID=%s\n' "$service_pid"
    printf 'SERVICE_START_TICKS=%s\n' "$start_ticks"
    printf 'SERVICE_LOG=%s\n' "${log_file#"$ROOT_DIR/"}"
    printf 'SERVICE_ARGS=%s\n' "${args_file#"$ROOT_DIR/"}"
    printf 'STARTED_AT_UTC=%s\n' "$started_at"
    printf 'DETACH_METHOD=setsid-f-nohup\n'
  } >"$state_tmp"
  mv "$state_tmp" "$SERVICE_FILE"
}

worker() {
  local launch_id="${1:-}"
  local started_at="${2:-}"
  local log_file="${3:-}"
  local args_file="${4:-}"
  shift 4

  [[ -n "$launch_id" && -n "$started_at" && -n "$log_file" && -n "$args_file" ]] || \
    exit 2
  write_active_service "$launch_id" "$started_at" "$log_file" "$args_file"
  cd "$ROOT_DIR" || exit 2
  exec "$SUPERVISOR_COMMAND" supervise "$@"
}

start_service() {
  local launch_id=""
  local started_at=""
  local log_file=""
  local args_file=""
  local persistent_mode=0
  local service_pid=""
  local observed_launch=""
  local option_index=1

  while (( option_index <= $# )); do
    if [[ "${!option_index}" == "--monitor-mode" ]]; then
      option_index=$((option_index + 1))
      [[ "$option_index" -le "$#" && "${!option_index}" == "persistent-cli" ]] || {
        printf 'Detached supervision requires --monitor-mode persistent-cli.\n' >&2
        return 2
      }
      persistent_mode=1
      break
    fi
    option_index=$((option_index + 1))
  done
  (( persistent_mode == 1 )) || {
    printf 'Detached supervision requires explicit --monitor-mode persistent-cli.\n' >&2
    return 2
  }
  [[ -x "$SUPERVISOR_COMMAND" ]] || {
    printf 'Supervisor command is unavailable: %s\n' "$SUPERVISOR_COMMAND" >&2
    return 127
  }
  command -v setsid >/dev/null 2>&1 || {
    printf 'setsid is required for detached supervision.\n' >&2
    return 127
  }
  command -v nohup >/dev/null 2>&1 || {
    printf 'nohup is required for detached supervision.\n' >&2
    return 127
  }
  if service_is_active; then
    printf 'A detached supervisor service is already active (pid %s).\n' \
      "$(service_value SERVICE_PID)" >&2
    return 2
  fi

  mkdir -p "$SERVICE_DIR"
  launch_id="supervisor-$(date -u +'%Y%m%dT%H%M%SZ')-$$"
  started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  log_file="$SERVICE_DIR/${launch_id}.log"
  args_file="$SERVICE_DIR/${launch_id}.args"
  {
    printf '%q ' "$SUPERVISOR_COMMAND" supervise "$@"
    printf '\n'
  } >"$args_file"

  nohup setsid -f "$SELF" _worker \
    "$launch_id" "$started_at" "$log_file" "$args_file" "$@" \
    >>"$log_file" 2>&1 </dev/null

  for _ in $(seq 1 50); do
    observed_launch="$(service_value SERVICE_LAUNCH_ID)"
    if [[ "$observed_launch" == "$launch_id" ]]; then
      if service_is_active; then
        service_pid="$(service_value SERVICE_PID)"
        printf 'Detached supervisor service started.\n'
        printf 'SERVICE_LAUNCH_ID=%s\n' "$launch_id"
        printf 'SERVICE_PID=%s\n' "$service_pid"
        printf 'SERVICE_LOG=%s\n' "${log_file#"$ROOT_DIR/"}"
        return 0
      fi
      break
    fi
    sleep 0.1
  done

  printf 'Detached supervisor failed to remain active; inspect %s\n' "$log_file" >&2
  tail -n 40 "$log_file" 2>/dev/null >&2 || true
  return 6
}

show_status() {
  if service_is_active; then
    printf 'SERVICE_STATUS=ACTIVE\n'
  else
    printf 'SERVICE_STATUS=INACTIVE\n'
  fi
  if [[ -s "$SERVICE_FILE" ]]; then
    cat "$SERVICE_FILE"
  fi
  if [[ -s "$SUPERVISOR_STATE" ]]; then
    printf '\n'
    cat "$SUPERVISOR_STATE"
  fi
}

stop_service() {
  local service_pid=""

  if ! service_is_active; then
    printf 'No detached supervisor service is active.\n'
    return 3
  fi
  service_pid="$(service_value SERVICE_PID)"
  kill -TERM -- "-$service_pid" 2>/dev/null || {
    printf 'Could not signal detached supervisor process group %s.\n' \
      "$service_pid" >&2
    return 4
  }
  for _ in $(seq 1 100); do
    if ! service_is_active; then
      printf 'Detached supervisor service stopped.\n'
      return 0
    fi
    sleep 0.1
  done
  printf 'Detached supervisor did not stop within 10 seconds; no KILL was sent.\n' >&2
  return 4
}

show_log() {
  local lines="${1:-120}"
  local log_path=""

  [[ "$lines" =~ ^[1-9][0-9]*$ ]] || {
    printf 'Log line count must be a positive integer.\n' >&2
    return 2
  }
  log_path="$(service_value SERVICE_LOG)"
  [[ -n "$log_path" ]] || {
    printf 'No detached supervisor log has been recorded.\n' >&2
    return 3
  }
  if [[ "$log_path" != /* ]]; then
    log_path="$ROOT_DIR/$log_path"
  fi
  [[ -f "$log_path" ]] || {
    printf 'Detached supervisor log is missing: %s\n' "$log_path" >&2
    return 3
  }
  tail -n "$lines" "$log_path"
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage >&2; exit 2; }
shift

case "$command_name" in
  start) start_service "$@" ;;
  status)
    (( $# == 0 )) || { usage >&2; exit 2; }
    show_status
    ;;
  stop)
    (( $# == 0 )) || { usage >&2; exit 2; }
    stop_service
    ;;
  log)
    (( $# <= 1 )) || { usage >&2; exit 2; }
    show_log "${1:-120}"
    ;;
  _worker) worker "$@" ;;
  --help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
