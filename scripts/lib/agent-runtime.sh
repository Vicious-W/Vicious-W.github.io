#!/usr/bin/env bash

# Shared subprocess supervision for the neutral Agent wrappers. This file is
# sourced by run-implementation.sh, run-review.sh, and the runtime smoke test.

AGENT_RUNTIME_ROOT=""
AGENT_ACTIVE_PID=""
AGENT_ACTIVE_PGID=""
AGENT_ACTIVE_GRACE_SECONDS=15
AGENT_RUN_EXIT=0
AGENT_RUN_REASON="NOT_RUN"
AGENT_RUN_ELAPSED_SECONDS=0
AGENT_NPM_CACHE_DIR=""

agent_runtime_init() {
  AGENT_RUNTIME_ROOT="$1"
}

agent_runtime_prepare_npm_cache() {
  local cache_base=""

  if [[ -n "${XDG_CACHE_HOME:-}" ]]; then
    cache_base="$XDG_CACHE_HOME"
  elif [[ -n "${HOME:-}" ]]; then
    cache_base="$HOME/.cache"
  else
    cache_base="$AGENT_RUNTIME_ROOT/.npm-cache"
  fi

  AGENT_NPM_CACHE_DIR="${AGENT_NPM_CACHE_DIR:-$cache_base/ms-playwright/npm-agent-cache}"
  if ! mkdir -p "$AGENT_NPM_CACHE_DIR"; then
    printf 'Cannot create the dedicated Agent npm cache: %s\n' "$AGENT_NPM_CACHE_DIR" >&2
    return 2
  fi
  if [[ ! -w "$AGENT_NPM_CACHE_DIR" ]]; then
    printf 'Dedicated Agent npm cache is not writable: %s\n' "$AGENT_NPM_CACHE_DIR" >&2
    return 2
  fi
  export NPM_CONFIG_CACHE="$AGENT_NPM_CACHE_DIR"
}

agent_runtime_config() {
  local key="$1"
  local default_value="$2"
  local minimum="$3"
  local maximum="$4"
  local config_file="$AGENT_RUNTIME_ROOT/.agent/runtime.env"
  local value=""

  if [[ -f "$config_file" ]]; then
    value="$(sed -n "s/^${key}=//p" "$config_file" | head -n 1)"
  fi
  [[ -n "$value" ]] || value="$default_value"

  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < minimum || value > maximum )); then
    printf 'Invalid %s=%s in %s; expected an integer from %s to %s.\n' \
      "$key" "$value" "$config_file" "$minimum" "$maximum" >&2
    return 2
  fi
  printf '%s\n' "$value"
}

agent_process_start_ticks() {
  local pid="$1"
  if [[ -r "/proc/$pid/stat" ]]; then
    awk '{print $22}' "/proc/$pid/stat" 2>/dev/null
  fi
}

agent_lock_is_active() {
  local lock_dir="$1"
  local owner_pid=""
  local owner_start=""
  local current_start=""

  owner_pid="$(sed -n '1p' "$lock_dir/pid" 2>/dev/null)"
  owner_start="$(sed -n '1p' "$lock_dir/start_ticks" 2>/dev/null)"
  [[ "$owner_pid" =~ ^[1-9][0-9]*$ && "$owner_start" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$owner_pid" 2>/dev/null || return 1
  current_start="$(agent_process_start_ticks "$owner_pid")"
  [[ -n "$current_start" && "$current_start" == "$owner_start" ]]
}

agent_write_lock_metadata() {
  local lock_dir="$1"
  local label="$2"
  local start_ticks=""

  start_ticks="$(agent_process_start_ticks "$$")"
  [[ "$start_ticks" =~ ^[0-9]+$ ]] || start_ticks=0
  printf '%s\n' "$$" >"$lock_dir/pid"
  printf '%s\n' "$start_ticks" >"$lock_dir/start_ticks"
  printf '%s\n' "$label" >"$lock_dir/command"
  printf '%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" >"$lock_dir/started_at_utc"
}

agent_acquire_lock() {
  local lock_dir="$1"
  local label="$2"

  if mkdir "$lock_dir" 2>/dev/null; then
    agent_write_lock_metadata "$lock_dir" "$label"
    return 0
  fi

  # A just-created lock may not have its metadata files yet. Give its owner one
  # short chance to finish the atomic-directory-plus-metadata acquisition.
  if [[ ! -s "$lock_dir/pid" ]]; then
    sleep 1
  fi
  if agent_lock_is_active "$lock_dir"; then
    printf 'Another Agent workflow is active (pid %s, %s): %s\n' \
      "$(sed -n '1p' "$lock_dir/pid")" \
      "$(sed -n '1p' "$lock_dir/command" 2>/dev/null)" "$lock_dir" >&2
    return 2
  fi

  printf 'Reclaiming stale Agent workflow lock: %s\n' "$lock_dir" >&2
  rm -f -- "$lock_dir/pid" "$lock_dir/start_ticks" \
    "$lock_dir/command" "$lock_dir/started_at_utc"
  if ! rmdir "$lock_dir" 2>/dev/null || ! mkdir "$lock_dir" 2>/dev/null; then
    printf 'Could not safely reclaim Agent workflow lock: %s\n' "$lock_dir" >&2
    return 2
  fi
  agent_write_lock_metadata "$lock_dir" "$label"
}

agent_release_lock() {
  local lock_dir="$1"
  local owner_pid=""

  [[ -d "$lock_dir" ]] || return 0
  owner_pid="$(sed -n '1p' "$lock_dir/pid" 2>/dev/null)"
  if [[ -n "$owner_pid" && "$owner_pid" != "$$" ]]; then
    printf 'Refusing to release a lock owned by pid %s: %s\n' "$owner_pid" "$lock_dir" >&2
    return 2
  fi
  rm -f -- "$lock_dir/pid" "$lock_dir/start_ticks" \
    "$lock_dir/command" "$lock_dir/started_at_utc"
  rmdir "$lock_dir" 2>/dev/null || true
}

agent_classify_log() {
  local log_file="$1"

  if grep -Eiq '(not logged in|authentication (failed|required)|unauthorized|invalid (api key|token)|token (has )?expired|oauth[^[:cntrl:]]*(failed|expired)|http[^[:cntrl:]]*401)' "$log_file" 2>/dev/null; then
    printf 'AUTHENTICATION\n'
  elif grep -Eiq '(permission denied|approval (is )?required|requires approval|not allowed by (policy|permission)|denied by (policy|sandbox)|sandbox[^[:cntrl:]]*(denied|violation)|tool use[^[:cntrl:]]*denied|operation not permitted)' "$log_file" 2>/dev/null; then
    printf 'PERMISSION\n'
  elif grep -Eiq '((mcp|playwright)[^[:cntrl:]]*(failed|error|unavailable|unhealthy|disconnected|could not connect)|browser[^[:cntrl:]]*(not installed|failed to launch))' "$log_file" 2>/dev/null; then
    printf 'MCP_OR_BROWSER\n'
  else
    printf 'CHILD_PROCESS_ERROR\n'
  fi
}

agent_record_stop() {
  local stage="$1"
  local reason="$2"
  local exit_code="$3"
  local log_file="$4"
  local stop_dir="$AGENT_RUNTIME_ROOT/.agent/artifacts/runtime"
  local relative_log="$log_file"

  mkdir -p "$stop_dir"
  if [[ "$relative_log" == "$AGENT_RUNTIME_ROOT/"* ]]; then
    relative_log="${relative_log#"$AGENT_RUNTIME_ROOT/"}"
  fi
  {
    printf 'STOPPED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'STAGE=%s\n' "$stage"
    printf 'STOP_REASON=%s\n' "$reason"
    printf 'EXIT_CODE=%s\n' "$exit_code"
    printf 'LOG_FILE=%s\n' "$relative_log"
  } >"$stop_dir/last-stop.env"
}

agent_clear_stop() {
  local stop_file="$AGENT_RUNTIME_ROOT/.agent/artifacts/runtime/last-stop.env"
  if [[ -f "$stop_file" ]]; then
    rm -f -- "$stop_file"
  fi
}

agent_stop_active_process() {
  local waited=0

  [[ -n "$AGENT_ACTIVE_PID" ]] || return 0
  if ! kill -0 "$AGENT_ACTIVE_PID" 2>/dev/null; then
    AGENT_ACTIVE_PID=""
    AGENT_ACTIVE_PGID=""
    return 0
  fi

  if [[ -n "$AGENT_ACTIVE_PGID" ]]; then
    kill -TERM -- "-$AGENT_ACTIVE_PGID" 2>/dev/null || true
  else
    kill -TERM "$AGENT_ACTIVE_PID" 2>/dev/null || true
  fi

  while kill -0 "$AGENT_ACTIVE_PID" 2>/dev/null && (( waited < AGENT_ACTIVE_GRACE_SECONDS )); do
    sleep 1
    waited=$((waited + 1))
  done

  if kill -0 "$AGENT_ACTIVE_PID" 2>/dev/null; then
    if [[ -n "$AGENT_ACTIVE_PGID" ]]; then
      kill -KILL -- "-$AGENT_ACTIVE_PGID" 2>/dev/null || true
    else
      kill -KILL "$AGENT_ACTIVE_PID" 2>/dev/null || true
    fi
  fi
}

run_agent_process() {
  local label="$1"
  local timeout_seconds="$2"
  local heartbeat_seconds="$3"
  local grace_seconds="$4"
  local log_file="$5"
  shift 5
  if [[ "${1:-}" != "--" ]]; then
    printf 'run_agent_process requires -- before the child command.\n' >&2
    return 2
  fi
  shift
  if (( $# == 0 )); then
    printf 'run_agent_process received no child command.\n' >&2
    return 2
  fi

  mkdir -p "$(dirname "$log_file")"
  : >"$log_file"

  local started_at now elapsed next_heartbeat log_bytes child_exit timed_out=0
  started_at="$(date +%s)"
  next_heartbeat=$((started_at + heartbeat_seconds))
  AGENT_ACTIVE_GRACE_SECONDS="$grace_seconds"

  setsid "$@" </dev/null >"$log_file" 2>&1 &
  AGENT_ACTIVE_PID=$!
  AGENT_ACTIVE_PGID="$AGENT_ACTIVE_PID"

  printf '[%s] %s started (pid %s, timeout %ss).\n' \
    "$(date -u +'%H:%M:%SZ')" "$label" "$AGENT_ACTIVE_PID" "$timeout_seconds"

  while kill -0 "$AGENT_ACTIVE_PID" 2>/dev/null; do
    now="$(date +%s)"
    elapsed=$((now - started_at))

    if (( elapsed >= timeout_seconds )); then
      timed_out=1
      printf '[%s] %s reached its %ss timeout; terminating its process group.\n' \
        "$(date -u +'%H:%M:%SZ')" "$label" "$timeout_seconds" >&2
      agent_stop_active_process
      break
    fi

    if (( now >= next_heartbeat )); then
      log_bytes="$(wc -c <"$log_file" | tr -d '[:space:]')"
      printf '[%s] %s is still running (%ss elapsed, %s log bytes).\n' \
        "$(date -u +'%H:%M:%SZ')" "$label" "$elapsed" "${log_bytes:-0}"
      next_heartbeat=$((now + heartbeat_seconds))
    fi
    sleep 2
  done

  wait "$AGENT_ACTIVE_PID" 2>/dev/null
  child_exit=$?
  now="$(date +%s)"
  AGENT_RUN_ELAPSED_SECONDS=$((now - started_at))
  AGENT_ACTIVE_PID=""
  AGENT_ACTIVE_PGID=""

  if (( timed_out == 1 )); then
    AGENT_RUN_EXIT=124
    AGENT_RUN_REASON="TIMEOUT"
  else
    AGENT_RUN_EXIT="$child_exit"
    if (( child_exit == 0 )); then
      AGENT_RUN_REASON="SUCCESS"
    else
      AGENT_RUN_REASON="$(agent_classify_log "$log_file")"
    fi
  fi

  printf '[%s] %s finished after %ss (exit %s, reason %s).\n' \
    "$(date -u +'%H:%M:%SZ')" "$label" "$AGENT_RUN_ELAPSED_SECONDS" \
    "$AGENT_RUN_EXIT" "$AGENT_RUN_REASON"
  return "$AGENT_RUN_EXIT"
}
