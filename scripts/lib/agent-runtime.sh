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
AGENT_SESSION_FILE=""
AGENT_SESSION_ID=""
AGENT_SESSION_MODE="new"
AGENT_SESSION_GENERATION=1
AGENT_SESSION_ROTATED_FROM=""

agent_runtime_init() {
  AGENT_RUNTIME_ROOT="$1"
}

agent_safe_slug() {
  printf '%s' "$1" | tr -c '[:alnum:]_.-' '_'
}

agent_new_uuid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    sed -n '1p' /proc/sys/kernel/random/uuid
    return
  fi
  printf '%08x-%04x-4%03x-a%03x-%012x\n' \
    "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$((RANDOM * RANDOM))"
}

agent_session_value() {
  local file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | head -n 1
}

agent_prepare_role_session() {
  local task_id="$1"
  local role="$2"
  local executor="$3"
  local model="$4"
  local effort="$5"
  local session_dir="$AGENT_RUNTIME_ROOT/.agent/artifacts/sessions"
  local task_slug role_slug
  local stored_id stored_task stored_role stored_executor stored_model stored_effort
  local stored_status stored_generation

  task_slug="$(agent_safe_slug "$task_id")"
  role_slug="$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]')"
  AGENT_SESSION_FILE="$session_dir/${task_slug}-${role_slug}.env"
  mkdir -p "$session_dir"

  stored_id="$(agent_session_value "$AGENT_SESSION_FILE" SESSION_ID)"
  stored_task="$(agent_session_value "$AGENT_SESSION_FILE" TASK_ID)"
  stored_role="$(agent_session_value "$AGENT_SESSION_FILE" ROLE)"
  stored_executor="$(agent_session_value "$AGENT_SESSION_FILE" EXECUTOR)"
  stored_model="$(agent_session_value "$AGENT_SESSION_FILE" MODEL)"
  stored_effort="$(agent_session_value "$AGENT_SESSION_FILE" EFFORT)"
  stored_status="$(agent_session_value "$AGENT_SESSION_FILE" STATUS)"
  stored_generation="$(agent_session_value "$AGENT_SESSION_FILE" GENERATION)"
  [[ "$stored_generation" =~ ^[1-9][0-9]*$ ]] || stored_generation=1

  if [[ -n "$stored_id" && "$stored_task" == "$task_id" && \
        "$stored_role" == "$role" && "$stored_executor" == "$executor" && \
        "$stored_model" == "$model" && "$stored_effort" == "$effort" && \
        "$stored_status" == "ACTIVE" ]]; then
    AGENT_SESSION_ID="$stored_id"
    AGENT_SESSION_MODE="resume"
    AGENT_SESSION_GENERATION="$stored_generation"
    AGENT_SESSION_ROTATED_FROM=""
    return 0
  fi

  AGENT_SESSION_MODE="new"
  AGENT_SESSION_GENERATION=1
  AGENT_SESSION_ROTATED_FROM=""
  if [[ -n "$stored_id" && "$stored_task" == "$task_id" && \
        "$stored_role" == "$role" && "$stored_executor" == "$executor" && \
        "$stored_model" == "$model" && "$stored_effort" == "$effort" && \
        "$stored_status" == "ROTATE_REQUIRED" ]]; then
    AGENT_SESSION_GENERATION=$((stored_generation + 1))
    AGENT_SESSION_ROTATED_FROM="$stored_id"
  fi
  if [[ "$executor" == "claude" ]]; then
    AGENT_SESSION_ID="$(agent_new_uuid)"
  else
    AGENT_SESSION_ID=""
  fi
  {
    printf 'TASK_ID=%s\n' "$task_id"
    printf 'ROLE=%s\n' "$role"
    printf 'EXECUTOR=%s\n' "$executor"
    printf 'MODEL=%s\n' "$model"
    printf 'EFFORT=%s\n' "$effort"
    printf 'GENERATION=%s\n' "$AGENT_SESSION_GENERATION"
    if [[ -n "$AGENT_SESSION_ROTATED_FROM" ]]; then
      printf 'PREVIOUS_SESSION_ID=%s\n' "$AGENT_SESSION_ROTATED_FROM"
    fi
    printf 'SESSION_ID=%s\n' "$AGENT_SESSION_ID"
    printf 'STATUS=PENDING\n'
    printf 'UPDATED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >"$AGENT_SESSION_FILE"
}

agent_finalize_role_session() {
  local executor="$1"
  local events_file="$2"
  local run_status="$3"
  local detected_id=""
  local session_tmp="${AGENT_SESSION_FILE}.tmp"
  local telemetry_script="$AGENT_RUNTIME_ROOT/scripts/lib/agent-telemetry.mjs"
  local reusable=0

  if [[ -s "$events_file" && -x "$telemetry_script" ]]; then
    detected_id="$(node "$telemetry_script" session "$executor" "$events_file" 2>/dev/null)"
  fi
  if [[ -n "$detected_id" ]]; then
    AGENT_SESSION_ID="$detected_id"
    case "$run_status" in
      SUCCESS|AUTONOMY_SLICE_LIMIT|USAGE_OR_BILLING_LIMIT|TIMEOUT)
        reusable=1
        ;;
    esac
  fi

  # Never mark a merely preallocated ID active. Authentication, model and
  # startup failures may occur before the executor persists a resumable
  # conversation even though Claude was given an explicit UUID.
  if [[ -z "$AGENT_SESSION_ID" ]]; then
    return 0
  fi

  while IFS= read -r line; do
    case "$line" in
      SESSION_ID=*|STATUS=*|UPDATED_AT_UTC=*|LAST_RUN_STATUS=*|LAST_CONTEXT_TOKENS=*|ROTATION_REASON=*) ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$AGENT_SESSION_FILE" >"$session_tmp"
  {
    printf 'SESSION_ID=%s\n' "$AGENT_SESSION_ID"
    if (( reusable == 1 )); then
      printf 'STATUS=ACTIVE\n'
    else
      printf 'STATUS=FAILED\n'
    fi
    printf 'LAST_RUN_STATUS=%s\n' "$run_status"
    printf 'UPDATED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >>"$session_tmp"
  mv "$session_tmp" "$AGENT_SESSION_FILE"
}

agent_mark_role_session_rotation() {
  local executor="$1"
  local usage_file="$2"
  local context_threshold="$3"
  local context_tokens=""
  local session_tmp="${AGENT_SESSION_FILE}.tmp"

  [[ "$executor" == "claude" && -s "$usage_file" && -s "$AGENT_SESSION_FILE" ]] || return 1
  context_tokens="$(
    node -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        .lastTurnCachedInputTokens;
      if (Number.isFinite(value)) process.stdout.write(String(value));
    ' "$usage_file" 2>/dev/null
  )"
  [[ "$context_tokens" =~ ^[0-9]+$ ]] || return 1
  (( context_tokens >= context_threshold )) || return 1

  while IFS= read -r line; do
    case "$line" in
      STATUS=*|UPDATED_AT_UTC=*|LAST_CONTEXT_TOKENS=*|ROTATION_REASON=*) ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$AGENT_SESSION_FILE" >"$session_tmp"
  {
    printf 'STATUS=ROTATE_REQUIRED\n'
    printf 'LAST_CONTEXT_TOKENS=%s\n' "$context_tokens"
    printf 'ROTATION_REASON=CONTEXT_GUARD\n'
    printf 'UPDATED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >>"$session_tmp"
  mv "$session_tmp" "$AGENT_SESSION_FILE"
  return 0
}

agent_force_role_session_rotation() {
  local task_id="$1"
  local role="$2"
  local reason="${3:-MONITOR_DECISION}"
  local session_dir="$AGENT_RUNTIME_ROOT/.agent/artifacts/sessions"
  local task_slug role_slug session_file session_status session_tmp

  task_slug="$(printf '%s' "$task_id" | tr -c '[:alnum:]_.-' '_')"
  role_slug="$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]')"
  session_file="$session_dir/${task_slug}-${role_slug}.env"
  [[ -s "$session_file" ]] || {
    printf 'Cannot rotate missing role session: %s\n' "$session_file" >&2
    return 2
  }
  session_status="$(agent_session_value "$session_file" STATUS)"
  if [[ "$session_status" == "ROTATE_REQUIRED" ]]; then
    return 0
  fi
  [[ "$session_status" == "ACTIVE" ]] || {
    printf 'Cannot rotate role session in status %s: %s\n' \
      "${session_status:-unknown}" "$session_file" >&2
    return 2
  }

  session_tmp="${session_file}.tmp"
  while IFS= read -r line; do
    case "$line" in
      STATUS=*|UPDATED_AT_UTC=*|ROTATION_REASON=*) ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$session_file" >"$session_tmp"
  {
    printf 'STATUS=ROTATE_REQUIRED\n'
    printf 'ROTATION_REASON=%s\n' "$reason"
    printf 'UPDATED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >>"$session_tmp"
  mv "$session_tmp" "$session_file"
}

agent_record_telemetry() {
  local executor="$1"
  local events_file="$2"
  local usage_file="$3"
  local max_agentic_turns="${4:-}"
  local max_budget_usd="${5:-}"
  local telemetry_script="$AGENT_RUNTIME_ROOT/scripts/lib/agent-telemetry.mjs"

  mkdir -p "$(dirname "$usage_file")"
  if [[ -x "$telemetry_script" ]]; then
    node "$telemetry_script" summary "$executor" "$events_file" "$usage_file" \
      2>/dev/null || printf '{"schemaVersion":1,"executor":"%s","telemetryAvailable":false}\n' \
        "$executor" >"$usage_file"
  else
    printf '{"schemaVersion":1,"executor":"%s","telemetryAvailable":false}\n' \
      "$executor" >"$usage_file"
  fi
  if [[ "$executor" == "claude" && -s "$usage_file" ]]; then
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const turns = Number(process.argv[2]);
      const budget = Number(process.argv[3]);
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      data.guard = {
        maxAgenticTurns: Number.isFinite(turns) && turns > 0 ? turns : null,
        maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
        semantics: "executor-agentic-turn-guard",
        reportedTurnsExceedNominalGuard:
          Number.isFinite(data.reportedTurns) &&
          Number.isFinite(turns) &&
          turns > 0 &&
          data.reportedTurns > turns,
        authority: "terminal-result-subtype",
      };
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    ' "$usage_file" "$max_agentic_turns" "$max_budget_usd" 2>/dev/null || true
  fi
}

agent_review_task_status() {
  local verdict="$1"
  local implementation_round="$2"
  local target_round="$3"

  [[ "$implementation_round" =~ ^[0-9]+$ && \
     "$target_round" =~ ^[0-9]+$ ]] || return 2
  case "$verdict" in
    PASS)
      if (( implementation_round < target_round )); then
        printf 'READY\n'
      else
        printf 'COMPLETE\n'
      fi
      ;;
    CHANGES_REQUIRED)
      printf 'NEEDS_CHANGES\n'
      ;;
    *)
      return 2
      ;;
  esac
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

agent_runtime_decimal_config() {
  local key="$1"
  local default_value="$2"
  local config_file="$AGENT_RUNTIME_ROOT/.agent/runtime.env"
  local value=""

  if [[ -f "$config_file" ]]; then
    value="$(sed -n "s/^${key}=//p" "$config_file" | head -n 1)"
  fi
  [[ -n "$value" ]] || value="$default_value"

  if [[ ! "$value" =~ ^[0-9]+([.][0-9]{1,4})?$ ]] || \
     ! awk -v value="$value" 'BEGIN { exit !(value > 0 && value <= 10000) }'; then
    printf 'Invalid %s=%s in %s; expected a positive decimal no greater than 10000.\n' \
      "$key" "$value" "$config_file" >&2
    return 2
  fi
  printf '%s\n' "$value"
}

agent_runtime_enum_config() {
  local key="$1"
  local default_value="$2"
  shift 2
  local config_file="$AGENT_RUNTIME_ROOT/.agent/runtime.env"
  local value=""
  local allowed=""

  if [[ -f "$config_file" ]]; then
    value="$(sed -n "s/^${key}=//p" "$config_file" | head -n 1)"
  fi
  [[ -n "$value" ]] || value="$default_value"

  for allowed in "$@"; do
    if [[ "$value" == "$allowed" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done
  printf 'Invalid %s=%s in %s; expected one of: %s.\n' \
    "$key" "$value" "$config_file" "$*" >&2
  return 2
}

agent_runtime_model_config() {
  local key="$1"
  local default_value="$2"
  local config_file="$AGENT_RUNTIME_ROOT/.agent/runtime.env"
  local value=""

  if [[ -f "$config_file" ]]; then
    value="$(sed -n "s/^${key}=//p" "$config_file" | head -n 1)"
  fi
  [[ -n "$value" ]] || value="$default_value"

  # Model aliases and full slugs used by both CLIs are deliberately limited to
  # a shell-safe token. This prevents runtime.env from becoming executable
  # configuration while still allowing names such as gpt-5.6-sol.
  if [[ ! "$value" =~ ^[[:alnum:]][[:alnum:]._:/-]{0,127}$ ]]; then
    printf 'Invalid %s=%s in %s; expected a model alias or slug.\n' \
      "$key" "$value" "$config_file" >&2
    return 2
  fi
  printf '%s\n' "$value"
}

agent_validate_executor() {
  case "$1" in
    claude|codex) ;;
    *)
      printf 'Unsupported Agent executor: %s (expected claude or codex).\n' "$1" >&2
      return 2
      ;;
  esac
}

agent_runtime_executor_config() {
  local key="$1"
  local default_value="$2"
  local config_file="$AGENT_RUNTIME_ROOT/.agent/runtime.env"
  local value=""

  if [[ -f "$config_file" ]]; then
    value="$(sed -n "s/^${key}=//p" "$config_file" | head -n 1)"
  fi
  [[ -n "$value" ]] || value="$default_value"
  agent_validate_executor "$value" || return 2
  printf '%s\n' "$value"
}

agent_validate_model() {
  local value="$1"
  if [[ ! "$value" =~ ^[[:alnum:]][[:alnum:]._:/-]{0,127}$ ]]; then
    printf 'Invalid model value: %s; expected a model alias or slug.\n' "$value" >&2
    return 2
  fi
}

agent_validate_effort() {
  local value="$1"
  case "$value" in
    low|medium|high|xhigh|max) ;;
    *)
      printf 'Invalid effort value: %s; expected low, medium, high, xhigh, or max.\n' \
        "$value" >&2
      return 2
      ;;
  esac
}

agent_runtime_effort_config() {
  local key="$1"
  local default_value="$2"
  local config_file="$AGENT_RUNTIME_ROOT/.agent/runtime.env"
  local value=""

  if [[ -f "$config_file" ]]; then
    value="$(sed -n "s/^${key}=//p" "$config_file" | head -n 1)"
  fi
  [[ -n "$value" ]] || value="$default_value"

  case "$value" in
    low|medium|high|xhigh|max) ;;
    *)
      printf 'Invalid %s=%s in %s; expected low, medium, high, xhigh, or max.\n' \
        "$key" "$value" "$config_file" >&2
      return 2
      ;;
  esac
  printf '%s\n' "$value"
}

agent_write_run_manifest() {
  local manifest_path="$1"
  local run_id="$2"
  local task_id="$3"
  local round="$4"
  local role="$5"
  local executor="$6"
  local model="$7"
  local effort="$8"
  local permission_profile="$9"
  shift 9
  local timeout_seconds="$1"
  local base_commit="$2"
  local target_commit="$3"
  local expected_output="$4"

  mkdir -p "$(dirname "$manifest_path")"
  {
    printf 'RUN_ID=%s\n' "$run_id"
    printf 'TASK_ID=%s\n' "$task_id"
    printf 'ROUND=%s\n' "$round"
    printf 'ROLE=%s\n' "$role"
    printf 'EXECUTOR=%s\n' "$executor"
    printf 'MODEL=%s\n' "$model"
    printf 'EFFORT=%s\n' "$effort"
    printf 'PERMISSION_PROFILE=%s\n' "$permission_profile"
    printf 'TIMEOUT_SECONDS=%s\n' "$timeout_seconds"
    printf 'BASE_COMMIT=%s\n' "$base_commit"
    printf 'TARGET_COMMIT=%s\n' "$target_commit"
    printf 'EXPECTED_OUTPUT=%s\n' "$expected_output"
    printf 'STARTED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >"$manifest_path"
}

agent_append_run_session() {
  local manifest_path="$1"
  local session_id="$2"
  local session_mode="$3"
  local events_path="$4"
  local usage_path="$5"

  {
    printf 'SESSION_ID=%s\n' "$session_id"
    printf 'SESSION_MODE=%s\n' "$session_mode"
    printf 'EVENTS_FILE=%s\n' "$events_path"
    printf 'USAGE_FILE=%s\n' "$usage_path"
  } >>"$manifest_path"
}

agent_append_run_limits() {
  local manifest_path="$1"
  local max_turns="$2"
  local max_budget_usd="$3"
  local context_rotate_tokens="$4"

  {
    printf 'MAX_TURNS=%s\n' "${max_turns:-NOT_APPLICABLE}"
    printf 'MAX_BUDGET_USD=%s\n' "${max_budget_usd:-NOT_APPLICABLE}"
    printf 'CONTEXT_ROTATE_TOKENS=%s\n' "${context_rotate_tokens:-NOT_APPLICABLE}"
    printf 'SESSION_GENERATION=%s\n' "$AGENT_SESSION_GENERATION"
    printf 'SESSION_ROTATED_FROM=%s\n' "$AGENT_SESSION_ROTATED_FROM"
  } >>"$manifest_path"
}

agent_finish_run_manifest() {
  local manifest_path="$1"
  local status="$2"
  local exit_code="$3"
  local stop_reason="$4"
  {
    printf 'FINISHED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'STATUS=%s\n' "$status"
    printf 'EXIT_CODE=%s\n' "$exit_code"
    printf 'STOP_REASON=%s\n' "$stop_reason"
    printf 'ELAPSED_SECONDS=%s\n' "$AGENT_RUN_ELAPSED_SECONDS"
  } >>"$manifest_path"
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

  if grep -Eiq '(error_max_turns|reached max turns|maximum (agentic )?turns|max turns[^[:cntrl:]]*(reached|exceeded)|error_max_budget_usd|max(imum)? budget[^[:cntrl:]]*(reached|exceeded)|budget[^[:cntrl:]]*limit)' "$log_file" 2>/dev/null; then
    printf 'AUTONOMY_SLICE_LIMIT\n'
  elif grep -Eiq '(monthly spend limit|usage limit|billing limit|quota (has been )?(exceeded|reached)|insufficient (credits|balance)|credit balance[^[:cntrl:]]*(low|empty|exhausted)|rate limit[^[:cntrl:]]*(exceeded|reached))' "$log_file" 2>/dev/null; then
    printf 'USAGE_OR_BILLING_LIMIT\n'
  elif grep -Eiq '(not logged in|authentication (failed|required)|unauthorized|invalid (api key|token)|token (has )?expired|oauth[^[:cntrl:]]*(failed|expired)|http[^[:cntrl:]]*401)' "$log_file" 2>/dev/null; then
    printf 'AUTHENTICATION\n'
  elif grep -Eiq '(issue with the selected model|model[^[:cntrl:]]*(does not exist|not found|not available|no access)|api_error_status[^[:cntrl:]]*404)' "$log_file" 2>/dev/null; then
    printf 'MODEL_UNAVAILABLE\n'
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
  local usage_file="${5:-}"
  local stop_dir="$AGENT_RUNTIME_ROOT/.agent/artifacts/runtime"
  local relative_log="$log_file"
  local relative_usage="$usage_file"

  mkdir -p "$stop_dir"
  if [[ "$relative_log" == "$AGENT_RUNTIME_ROOT/"* ]]; then
    relative_log="${relative_log#"$AGENT_RUNTIME_ROOT/"}"
  fi
  if [[ "$relative_usage" == "$AGENT_RUNTIME_ROOT/"* ]]; then
    relative_usage="${relative_usage#"$AGENT_RUNTIME_ROOT/"}"
  fi
  {
    printf 'STOPPED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'STAGE=%s\n' "$stage"
    printf 'STOP_REASON=%s\n' "$reason"
    printf 'EXIT_CODE=%s\n' "$exit_code"
    printf 'LOG_FILE=%s\n' "$relative_log"
    printf 'USAGE_FILE=%s\n' "$relative_usage"
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

  # Count completed supervision ticks rather than wall-clock seconds. WSL and
  # laptops can be suspended for hours; wall time jumps across that pause even
  # though the Agent did no work. A tick counter keeps the timeout tied to time
  # during which this supervisor was actually scheduled and observing the child.
  local poll_seconds=2
  local elapsed=0
  local next_heartbeat="$heartbeat_seconds"
  local log_bytes event_bytes child_exit timed_out=0 live_telemetry=""
  local telemetry_executor="${AGENT_LIVE_TELEMETRY_EXECUTOR:-}"
  local events_file="${AGENT_EVENT_FILE:-}"
  local telemetry_script="$AGENT_RUNTIME_ROOT/scripts/lib/agent-telemetry.mjs"
  AGENT_ACTIVE_GRACE_SECONDS="$grace_seconds"

  setsid "$@" </dev/null >"$log_file" 2>&1 &
  AGENT_ACTIVE_PID=$!
  AGENT_ACTIVE_PGID="$AGENT_ACTIVE_PID"

  printf '[%s] %s started (pid %s, timeout %ss).\n' \
    "$(date -u +'%H:%M:%SZ')" "$label" "$AGENT_ACTIVE_PID" "$timeout_seconds"

  while kill -0 "$AGENT_ACTIVE_PID" 2>/dev/null; do
    if (( elapsed >= timeout_seconds )); then
      timed_out=1
      printf '[%s] %s reached its %ss timeout; terminating its process group.\n' \
        "$(date -u +'%H:%M:%SZ')" "$label" "$timeout_seconds" >&2
      agent_stop_active_process
      break
    fi

    if (( elapsed >= next_heartbeat )); then
      log_bytes="$(wc -c <"$log_file" | tr -d '[:space:]')"
      printf '[%s] %s is still running (%ss elapsed, %s log bytes).\n' \
        "$(date -u +'%H:%M:%SZ')" "$label" "$elapsed" "${log_bytes:-0}"
      if [[ -n "$telemetry_executor" && -n "$events_file" && \
            -s "$events_file" && -x "$telemetry_script" ]]; then
        event_bytes="$(wc -c <"$events_file" | tr -d '[:space:]')"
        live_telemetry="$(
          node "$telemetry_script" live "$telemetry_executor" "$events_file" \
            2>/dev/null || true
        )"
        if [[ -n "$live_telemetry" ]]; then
          printf '[%s] LIVE_USAGE event_bytes=%s %s\n' \
            "$(date -u +'%H:%M:%SZ')" "${event_bytes:-0}" "$live_telemetry"
        fi
      fi
      next_heartbeat=$((elapsed + heartbeat_seconds))
    fi
    sleep "$poll_seconds"
    elapsed=$((elapsed + poll_seconds))
  done

  wait "$AGENT_ACTIVE_PID" 2>/dev/null
  child_exit=$?
  AGENT_RUN_ELAPSED_SECONDS="$elapsed"
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
