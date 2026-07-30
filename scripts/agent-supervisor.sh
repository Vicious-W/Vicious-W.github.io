#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
ARTIFACT_DIR="$AGENT_DIR/artifacts/supervisor"
STATE_FILE="$ARTIFACT_DIR/state.env"
EVENT_LOG="$ARTIFACT_DIR/events.log"
ACTION_REQUEST_FILE="$ARTIFACT_DIR/action-request.env"
ACTION_RESPONSE_FILE="$ARTIFACT_DIR/action-response.env"
USAGE_LEDGER_FILE="$ARTIFACT_DIR/usage-ledger.json"
STOP_FILE="$AGENT_DIR/artifacts/runtime/last-stop.env"
LOCK_DIR="$AGENT_DIR/.supervisor.lock"
RUNTIME_LIB="$ROOT_DIR/scripts/lib/agent-runtime.sh"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$RUNTIME_LIB"
agent_runtime_init "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./scripts/agent-supervisor.sh supervise [options]
       ./scripts/agent-supervisor.sh status
       ./scripts/agent-supervisor.sh action ACTION [EVENT_ID]

Runs one complete multi-window Agent run. The supervisor invokes the
bounded parent cycle, saves safe recovery checkpoints on usage limits, waits
without an AI process, and resumes at the interrupted role.

Role options:
  --implementer claude|codex
  --implementer-model MODEL
  --implementer-effort LEVEL
  --reviewer claude|codex
  --reviewer-model MODEL
  --reviewer-effort LEVEL
  --monitor claude|codex
  --monitor-model MODEL
  --monitor-effort LEVEL
  --monitor-mode attached|persistent-cli
                         attached: the visible GENERAL conversation owns this
                         foreground process; persistent-cli: start/resume one
                         task-scoped read-only CLI GENERAL at event boundaries.
  --rounds N             Additional rounds requested now (default 1). One
                         round is exactly one IMPLEMENTER invocation.
  --max-rounds N         Deprecated alias for --rounds.

Recovery options:
  --start-stage ROLE     Start at implementer or reviewer; default implementer.
  --review-base COMMIT   Exact comparison base for a REVIEWER recovery.
  --start-at DATE        Wait before the first cycle attempt; accepted by `date -d`.
                         Also becomes the fixed quota-window anchor by default.
  --quota-anchor DATE    Fixed quota reset anchor; defaults to --start-at.
  --resume-at DATE       Absolute first quota-resume time accepted by `date -d`.
  --quota-wait-seconds N Subsequent quota wait; default runtime.env value.
  --max-quota-resumes N  Hard recovery limit.

Attached GENERAL supervision actions:
  CONTINUE_NOW            Resume the interrupted role in the same context.
  ROTATE_AND_CONTINUE     Compact to a new role-session generation, then resume.
  WAIT_FOR_QUOTA          Wait for the configured quota window.
  STOP_OWNER              Stop safely and return control to the owner.
EOF
}

state_write() {
  local status="$1"
  local stage="$2"
  local attempt="$3"
  local resumes="$4"
  local resume_at="$5"
  local last_exit="$6"
  local last_reason="$7"
  local tmp="$STATE_FILE.tmp"

  mkdir -p "$ARTIFACT_DIR"
  {
    printf 'SUPERVISOR_STATUS=%s\n' "$status"
    printf 'TASK_ID=%s\n' "$(sed -n 's/^ACTIVE_TASK_ID=//p' "$AGENT_DIR/state.env" | head -n 1)"
    printf 'CURRENT_STAGE=%s\n' "$stage"
    printf 'CURRENT_ATTEMPT=%s\n' "$attempt"
    printf 'QUOTA_RESUMES=%s\n' "$resumes"
    printf 'AUTONOMY_SLICES=%s\n' "${slice_resumes:-0}"
    printf 'RESUME_AT=%s\n' "$resume_at"
    printf 'LAST_EXIT_CODE=%s\n' "$last_exit"
    printf 'LAST_STOP_REASON=%s\n' "$last_reason"
    printf 'IMPLEMENTER=%s/%s/%s\n' "$implementer_agent" "$implementer_model" "$implementer_effort"
    printf 'REVIEWER=%s/%s/%s\n' "$reviewer_agent" "$reviewer_model" "$reviewer_effort"
    printf 'GENERAL_SUPERVISOR=%s/%s/%s\n' "$monitor_agent" "$monitor_model" "$monitor_effort"
    printf 'SUPERVISION_MODE=%s\n' "$monitor_mode"
    printf 'LAST_SUPERVISION_ACTION=%s\n' "${last_monitor_action:-}"
    # v5 state readers may still consume these compatibility keys.
    printf 'MONITOR=%s/%s/%s\n' "$monitor_agent" "$monitor_model" "$monitor_effort"
    printf 'MONITOR_MODE=%s\n' "$monitor_mode"
    printf 'REQUESTED_ROUNDS=%s\n' "${max_rounds:-1}"
    printf 'TARGET_ROUND=%s\n' "${target_round:-}"
    printf 'PENDING_ACTION_ID=%s\n' "${pending_action_id:-}"
    printf 'LAST_MONITOR_ACTION=%s\n' "${last_monitor_action:-}"
    printf 'LAST_USAGE_FILE=%s\n' "${last_usage_file:-}"
    printf 'USAGE_LEDGER=%s\n' "${USAGE_LEDGER_FILE#"$ROOT_DIR/"}"
    printf 'REVIEW_BASE=%s\n' "${review_base:-}"
    printf 'UPDATED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >"$tmp"
  mv "$tmp" "$STATE_FILE"
}

event_record() {
  mkdir -p "$ARTIFACT_DIR"
  printf '%s\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$EVENT_LOG"
}

refresh_cycle_summary() {
  local cycle_exit="${1:-}"
  local summary_command="${AGENT_SUPERVISOR_SUMMARY_COMMAND:-$ROOT_DIR/scripts/generate-cycle-summary.sh}"
  "$summary_command" "$cycle_exit" >/dev/null 2>&1 || true
}

stop_value() {
  sed -n "s/^${1}=//p" "$STOP_FILE" 2>/dev/null | head -n 1
}

usage_reset_epoch() {
  local usage_path="${1:-}"
  local usage_absolute=""

  [[ -n "$usage_path" ]] || return 1
  if [[ "$usage_path" == /* ]]; then
    usage_absolute="$usage_path"
  else
    usage_absolute="$ROOT_DIR/$usage_path"
  fi
  [[ -s "$usage_absolute" ]] || return 1
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = Number(data.rateLimitResetsAt);
    if (!Number.isInteger(value) || value <= 0) process.exit(1);
    process.stdout.write(String(value));
  ' "$usage_absolute" 2>/dev/null
}

is_protected_recovery_path() {
  case "$1" in
    README.md|PROJECT_SPEC.md|AGENT_PROTOCOL.md|REVIEW_CONTRACT.md|AGENTS.md|CLAUDE.md|.gitignore) return 0 ;;
    docs/*|references/*|.vscode/*|.agent/roles/*) return 0 ;;
    .claude/*|.codex/*) return 0 ;;
    .agent/implementation-report.md|.agent/artifacts/*) return 1 ;;
    .agent/*) return 0 ;;
    scripts/*) return 0 ;;
    *) return 1 ;;
  esac
}

create_recovery_checkpoint() {
  local stage="$1"
  local attempt="$2"
  local dirty_status=""
  local violation=0
  local validation_status="PASS"

  if [[ "${AGENT_SUPERVISOR_SKIP_RECOVERY:-0}" == "1" ]]; then
    event_record "supervisor test mode: recovery checkpoint skipped"
    return 0
  fi

  dirty_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
  if [[ -z "$dirty_status" ]]; then
    event_record "quota recovery: no tracked workspace changes to checkpoint"
    return 0
  fi
  if [[ "$stage" != "IMPLEMENTER" ]]; then
    printf 'Unexpected dirty workspace after %s quota stop.\n' "$stage" >&2
    return 4
  fi
  if ! git -C "$ROOT_DIR" diff --cached --quiet; then
    printf 'Recovery refused: Agent left staged changes.\n' >&2
    return 4
  fi

  while IFS= read -r -d '' changed_path; do
    [[ -n "$changed_path" ]] || continue
    if is_protected_recovery_path "$changed_path"; then
      printf 'Recovery refused: protected path changed: %s\n' "$changed_path" >&2
      violation=1
    fi
  done < <(
    git -C "$ROOT_DIR" diff --name-only -z --
    git -C "$ROOT_DIR" ls-files --others --exclude-standard -z
  )
  (( violation == 0 )) || return 4

  if ! "$ROOT_DIR/scripts/run-validation.sh"; then
    validation_status="FAIL"
  fi
  if ! git -C "$ROOT_DIR" diff --check; then
    printf 'Recovery refused: diff contains whitespace errors.\n' >&2
    return 4
  fi

  git -C "$ROOT_DIR" add --all || return 4
  git -C "$ROOT_DIR" \
    -c core.hooksPath=/dev/null \
    -c commit.gpgSign=false \
    commit -m "agent: recovery checkpoint ${stage,,} attempt $attempt" \
    >"$ARTIFACT_DIR/recovery-attempt-${attempt}.log" 2>&1 || return 4
  event_record "created recovery checkpoint $(git -C "$ROOT_DIR" rev-parse --short=12 HEAD), validation=$validation_status"
  printf 'Recovery checkpoint created (validation %s): %s\n' \
    "$validation_status" "$(git -C "$ROOT_DIR" rev-parse HEAD)"
}

wait_until_epoch() {
  local target_epoch="$1"
  local heartbeat="$2"
  local wait_state="${3:-WAITING}"
  local now remaining wait_seconds next_heartbeat

  if [[ "${AGENT_SUPERVISOR_NO_SLEEP:-0}" == "1" ]]; then
    printf 'Supervisor test mode: quota wait skipped.\n'
    return 0
  fi

  next_heartbeat="$(date +%s)"
  while true; do
    now="$(date +%s)"
    remaining=$((target_epoch - now))
    (( remaining > 0 )) || break
    if (( now >= next_heartbeat )); then
      printf '[%s] %s: %ss remaining; no work Agent is running.\n' \
        "$(date -u +'%H:%M:%SZ')" "$wait_state" "$remaining"
      next_heartbeat=$((now + heartbeat))
    fi
    wait_seconds=60
    (( remaining < wait_seconds )) && wait_seconds="$remaining"
    sleep "$wait_seconds"
  done
}

submit_monitor_action() {
  local action="$1"
  local requested_event_id="${2:-}"
  local active_event_id=""
  local supervisor_status=""
  local state_event_id=""
  local response_tmp="${ACTION_RESPONSE_FILE}.tmp"

  case "$action" in
    CONTINUE_NOW|ROTATE_AND_CONTINUE|WAIT_FOR_QUOTA|STOP_OWNER) ;;
    *)
      printf 'Invalid GENERAL supervision action: %s\n' "$action" >&2
      return 2
      ;;
  esac
  [[ -s "$ACTION_REQUEST_FILE" ]] || {
    printf 'No attached GENERAL supervision action is currently pending.\n' >&2
    return 2
  }
  active_event_id="$(
    sed -n 's/^EVENT_ID=//p' "$ACTION_REQUEST_FILE" | head -n 1
  )"
  [[ -n "$active_event_id" ]] || {
    printf 'Pending GENERAL supervision request has no event ID.\n' >&2
    return 2
  }
  supervisor_status="$(
    sed -n 's/^SUPERVISOR_STATUS=//p' "$STATE_FILE" 2>/dev/null | head -n 1
  )"
  state_event_id="$(
    sed -n 's/^PENDING_ACTION_ID=//p' "$STATE_FILE" 2>/dev/null | head -n 1
  )"
  if [[ "$supervisor_status" != "AWAITING_MONITOR_ACTION" || \
        "$state_event_id" != "$active_event_id" ]]; then
    printf 'GENERAL supervision action request is stale or supervisor is not waiting.\n' >&2
    return 2
  fi
  if [[ -n "$requested_event_id" && "$requested_event_id" != "$active_event_id" ]]; then
    printf 'GENERAL supervision action event mismatch: expected %s, got %s.\n' \
      "$active_event_id" "$requested_event_id" >&2
    return 2
  fi
  {
    printf 'EVENT_ID=%s\n' "$active_event_id"
    printf 'ACTION=%s\n' "$action"
    printf 'SUBMITTED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >"$response_tmp"
  mv "$response_tmp" "$ACTION_RESPONSE_FILE"
  printf 'Submitted GENERAL supervision action %s for event %s.\n' \
    "$action" "$active_event_id"
}

record_stop_usage() {
  local stage="$1"
  local attempt_number="$2"
  local reason="$3"
  local usage_relative usage_absolute

  last_usage_file="$(stop_value USAGE_FILE)"
  [[ -n "$last_usage_file" ]] || return 0
  if [[ "$last_usage_file" == /* ]]; then
    usage_absolute="$last_usage_file"
  else
    usage_absolute="$ROOT_DIR/$last_usage_file"
  fi
  [[ -s "$usage_absolute" ]] || return 0
  sync_usage_ledger || return 2
  usage_relative="${usage_absolute#"$ROOT_DIR/"}"
  last_usage_file="$usage_relative"
  event_record "usage synced: stage=$stage attempt=$attempt_number reason=$reason file=$last_usage_file"
  printf '[%s] WINDOW_USAGE %s\n' \
    "$(date -u +'%H:%M:%SZ')" \
    "$(node "$ROOT_DIR/scripts/lib/agent-usage-ledger.mjs" summary \
      "$USAGE_LEDGER_FILE" 2>/dev/null || true)"
}

sync_usage_ledger() {
  node "$ROOT_DIR/scripts/lib/agent-usage-ledger.mjs" sync \
    "$USAGE_LEDGER_FILE" "$AGENT_DIR/artifacts/runs" "$ROOT_DIR" \
    "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}

dispatch_monitor_event() {
  local event="$1"
  local stage="$2"
  local event_exit="$3"
  local related_log="${4:-}"
  local monitor_output=""

  MONITOR_DECISION=""

  if [[ "$monitor_mode" == "attached" ]]; then
    event_record "attached GENERAL handoff: event=$event stage=$stage exit=$event_exit"
    printf '[%s] ATTACHED_MONITOR_EVENT: %s/%s (exit %s).\n' \
      "$(date -u +'%H:%M:%SZ')" "$stage" "$event" "$event_exit"
    return 0
  fi
  if [[ "${AGENT_SUPERVISOR_MONITOR_ON_ERROR:-1}" != "1" ]]; then
    return 0
  fi
  if ! monitor_output="$(
    "$monitor_command" \
      --event "$event" --stage "$stage" --exit-code "$event_exit" \
      --log-file "$related_log" \
      --agent "$monitor_agent" --model "$monitor_model" --effort "$monitor_effort"
  )"; then
    printf '%s\n' "$monitor_output"
    return 1
  fi
  printf '%s\n' "$monitor_output"
  MONITOR_DECISION="$(
    printf '%s\n' "$monitor_output" |
      sed -n 's/^MONITOR_ACTION: //p' |
      tail -n 1
  )"
}

request_monitor_action() {
  local event="$1"
  local stage="$2"
  local event_exit="$3"
  local related_log="${4:-}"
  local can_continue="$5"
  local request_tmp="${ACTION_REQUEST_FILE}.tmp"
  local response_event response_action now deadline next_heartbeat

  MONITOR_ACTION_FAILURE_REASON="MONITOR_ACTION_FAILED"
  pending_action_id="${event}-${stage}-${attempt}-$(date +%s%N)"
  {
    printf 'EVENT_ID=%s\n' "$pending_action_id"
    printf 'EVENT=%s\n' "$event"
    printf 'STAGE=%s\n' "$stage"
    printf 'ATTEMPT=%s\n' "$attempt"
    printf 'CAN_CONTINUE=%s\n' "$can_continue"
    printf 'USAGE_FILE=%s\n' "${last_usage_file:-}"
    printf 'USAGE_LEDGER=%s\n' "${USAGE_LEDGER_FILE#"$ROOT_DIR/"}"
    printf 'REQUESTED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >"$request_tmp"
  mv "$request_tmp" "$ACTION_REQUEST_FILE"
  rm -f -- "$ACTION_RESPONSE_FILE"
  state_write AWAITING_MONITOR_ACTION "$stage" "$attempt" "$quota_resumes" \
    "" "$event_exit" "$event"
  refresh_cycle_summary "$event_exit"

  if [[ "$monitor_mode" == "persistent-cli" ]]; then
    if ! dispatch_monitor_event "$event" "$stage" "$event_exit" "$related_log"; then
      return 1
    fi
    case "$MONITOR_DECISION" in
      CONTINUE_NOW|ROTATE_AND_CONTINUE|WAIT_FOR_QUOTA|STOP_OWNER) ;;
      CONTROL_REPAIR_REQUIRED) MONITOR_DECISION=STOP_OWNER ;;
      *)
        printf 'Persistent GENERAL supervisor returned no valid action: %s\n' \
          "${MONITOR_DECISION:-missing}" >&2
        return 1
        ;;
    esac
  elif [[ -n "${AGENT_SUPERVISOR_ATTACHED_ACTION:-}" ]]; then
    MONITOR_DECISION="$AGENT_SUPERVISOR_ATTACHED_ACTION"
  else
    printf '\nGENERAL supervision decision required; no work Agent is running.\n'
    printf '  Event ID: %s\n' "$pending_action_id"
    printf '  Stage: %s\n' "$stage"
    printf '  Usage: %s\n' "${last_usage_file:-unavailable}"
    printf '  Ledger: %s\n' "${USAGE_LEDGER_FILE#"$ROOT_DIR/"}"
    printf 'Submit from this attached GENERAL conversation:\n'
    printf '  ./scripts/agent-cycle.sh supervisor-action ACTION %s\n' \
      "$pending_action_id"
    deadline=$(( $(date +%s) + monitor_action_timeout ))
    next_heartbeat=0
    while true; do
      now="$(date +%s)"
      if (( now >= deadline )); then
        printf 'Timed out waiting for attached GENERAL action.\n' >&2
        return 1
      fi
      if [[ -s "$ACTION_RESPONSE_FILE" ]]; then
        response_event="$(
          sed -n 's/^EVENT_ID=//p' "$ACTION_RESPONSE_FILE" | head -n 1
        )"
        response_action="$(
          sed -n 's/^ACTION=//p' "$ACTION_RESPONSE_FILE" | head -n 1
        )"
        if [[ "$response_event" == "$pending_action_id" ]]; then
          MONITOR_DECISION="$response_action"
          break
        fi
      fi
      if (( now >= next_heartbeat )); then
        printf '[%s] AWAITING_MONITOR_ACTION: %ss remaining; no work Agent is running.\n' \
          "$(date -u +'%H:%M:%SZ')" "$((deadline - now))"
        next_heartbeat=$((now + supervisor_heartbeat))
      fi
      sleep 2
    done
  fi

  case "$MONITOR_DECISION" in
    CONTINUE_NOW|ROTATE_AND_CONTINUE)
      if [[ "$can_continue" != "YES" ]]; then
        printf 'Continuation denied after reaching the per-window slice limit.\n' >&2
        MONITOR_ACTION_FAILURE_REASON="MAX_AUTONOMY_SLICES"
        return 1
      fi
      ;;
    WAIT_FOR_QUOTA|STOP_OWNER) ;;
    *)
      printf 'Invalid GENERAL supervision decision: %s\n' "${MONITOR_DECISION:-missing}" >&2
      return 1
      ;;
  esac
  last_monitor_action="$MONITOR_DECISION"
  event_record "GENERAL supervision action $MONITOR_DECISION for $pending_action_id"
  rm -f -- "$ACTION_REQUEST_FILE" "$ACTION_RESPONSE_FILE"
  pending_action_id=""
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage >&2; exit 2; }
shift

if [[ "$command_name" == "status" ]]; then
  if [[ -s "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  else
    printf 'SUPERVISOR_STATUS=NOT_STARTED\n'
  fi
  exit 0
fi
if [[ "$command_name" == "action" ]]; then
  (( $# >= 1 && $# <= 2 )) || { usage >&2; exit 2; }
  submit_monitor_action "$1" "${2:-}"
  exit $?
fi
if [[ "$command_name" != "supervise" ]]; then
  usage >&2
  exit 2
fi

implementer_agent="$(agent_runtime_executor_config IMPLEMENTER_AGENT claude)" || exit 2
implementer_model="$(agent_runtime_model_config IMPLEMENTER_MODEL sonnet)" || exit 2
implementer_effort="$(agent_runtime_effort_config IMPLEMENTER_EFFORT high)" || exit 2
reviewer_agent="$(agent_runtime_executor_config REVIEWER_AGENT codex)" || exit 2
reviewer_model="$(agent_runtime_model_config REVIEWER_MODEL gpt-5.6-sol)" || exit 2
reviewer_effort="$(agent_runtime_effort_config REVIEWER_EFFORT high)" || exit 2
monitor_agent="$(agent_runtime_executor_config MONITOR_AGENT codex)" || exit 2
monitor_model="$(agent_runtime_model_config MONITOR_MODEL gpt-5.6-terra)" || exit 2
monitor_effort="$(agent_runtime_effort_config MONITOR_EFFORT medium)" || exit 2
monitor_mode="$(
  agent_runtime_enum_config MONITOR_MODE attached attached persistent-cli
)" || exit 2
quota_wait="$(agent_runtime_config QUOTA_WAIT_SECONDS 18000 60 604800)" || exit 2
max_resumes="$(agent_runtime_config MAX_QUOTA_RESUMES 6 1 100)" || exit 2
supervisor_heartbeat="$(agent_runtime_config SUPERVISOR_HEARTBEAT_SECONDS 300 30 3600)" || exit 2
max_autonomy_slices="$(
  agent_runtime_config MAX_AUTONOMY_SLICES_PER_WINDOW 4 1 100
)" || exit 2
monitor_action_timeout="$(
  agent_runtime_config MONITOR_ACTION_TIMEOUT_SECONDS 7200 60 86400
)" || exit 2
max_rounds="$(sed -n 's/^DEFAULT_ROUNDS=//p' "$AGENT_DIR/state.env" | head -n 1)"
[[ "$max_rounds" =~ ^[1-9][0-9]*$ ]] || max_rounds=1
first_resume_at=""
start_at=""
quota_anchor_at=""
start_stage="implementer"
review_base=""

while (( $# > 0 )); do
  case "$1" in
    --implementer) implementer_agent="${2:-}"; shift 2 ;;
    --implementer-model) implementer_model="${2:-}"; shift 2 ;;
    --implementer-effort) implementer_effort="${2:-}"; shift 2 ;;
    --reviewer) reviewer_agent="${2:-}"; shift 2 ;;
    --reviewer-model) reviewer_model="${2:-}"; shift 2 ;;
    --reviewer-effort) reviewer_effort="${2:-}"; shift 2 ;;
    --monitor) monitor_agent="${2:-}"; shift 2 ;;
    --monitor-model) monitor_model="${2:-}"; shift 2 ;;
    --monitor-effort) monitor_effort="${2:-}"; shift 2 ;;
    --monitor-mode) monitor_mode="${2:-}"; shift 2 ;;
    --rounds|--max-rounds) max_rounds="${2:-}"; shift 2 ;;
    --start-stage) start_stage="${2:-}"; shift 2 ;;
    --review-base) review_base="${2:-}"; shift 2 ;;
    --start-at) start_at="${2:-}"; shift 2 ;;
    --quota-anchor) quota_anchor_at="${2:-}"; shift 2 ;;
    --resume-at) first_resume_at="${2:-}"; shift 2 ;;
    --quota-wait-seconds) quota_wait="${2:-}"; shift 2 ;;
    --max-quota-resumes) max_resumes="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown supervisor option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

agent_validate_executor "$implementer_agent" || exit 2
agent_validate_model "$implementer_model" || exit 2
agent_validate_effort "$implementer_effort" || exit 2
agent_validate_executor "$reviewer_agent" || exit 2
agent_validate_model "$reviewer_model" || exit 2
agent_validate_effort "$reviewer_effort" || exit 2
agent_validate_executor "$monitor_agent" || exit 2
agent_validate_model "$monitor_model" || exit 2
agent_validate_effort "$monitor_effort" || exit 2
case "$monitor_mode" in
  attached|persistent-cli) ;;
  *) printf 'Invalid --monitor-mode: %s\n' "$monitor_mode" >&2; exit 2 ;;
esac
[[ "$quota_wait" =~ ^[0-9]+$ && "$quota_wait" -ge 60 ]] || { printf 'Invalid quota wait.\n' >&2; exit 2; }
[[ "$max_resumes" =~ ^[1-9][0-9]*$ ]] || { printf 'Invalid max resumes.\n' >&2; exit 2; }
[[ "$max_rounds" =~ ^[1-9][0-9]*$ ]] || { printf 'Invalid requested rounds.\n' >&2; exit 2; }
case "$start_stage" in
  implementer|reviewer) ;;
  *) printf 'Invalid --start-stage: %s\n' "$start_stage" >&2; exit 2 ;;
esac
if [[ -n "$review_base" ]]; then
  if [[ "$start_stage" != "reviewer" ]]; then
    printf '%s\n' '--review-base requires --start-stage reviewer.' >&2
    exit 2
  fi
  review_base="$(
    git -C "$ROOT_DIR" rev-parse --verify "$review_base^{commit}" 2>/dev/null
  )" || { printf 'Invalid --review-base commit.\n' >&2; exit 2; }
fi

first_resume_epoch=""
start_epoch=""
if [[ -n "$start_at" ]]; then
  start_epoch="$(date -d "$start_at" +%s 2>/dev/null)" || {
    printf 'Invalid --start-at value: %s\n' "$start_at" >&2
    exit 2
  }
fi
quota_anchor_epoch=""
if [[ -n "$quota_anchor_at" ]]; then
  quota_anchor_epoch="$(date -d "$quota_anchor_at" +%s 2>/dev/null)" || {
    printf 'Invalid --quota-anchor value: %s\n' "$quota_anchor_at" >&2
    exit 2
  }
elif [[ -n "$start_epoch" ]]; then
  quota_anchor_epoch="$start_epoch"
fi
if [[ -n "$first_resume_at" ]]; then
  first_resume_epoch="$(date -d "$first_resume_at" +%s 2>/dev/null)" || {
    printf 'Invalid --resume-at value: %s\n' "$first_resume_at" >&2
    exit 2
  }
fi

if ! agent_acquire_lock "$LOCK_DIR" 'multi-window supervisor'; then
  exit 2
fi
cleanup() {
  local supervisor_exit=$?
  trap - EXIT
  agent_release_lock "$LOCK_DIR" || true
  exit "$supervisor_exit"
}
trap cleanup EXIT
handle_signal() {
  local signal_exit="$1"
  local signal_name="$2"
  state_write STOPPED "${next_stage:-UNKNOWN}" "${attempt:-0}" \
    "${quota_resumes:-0}" "" "$signal_exit" "SIGNAL_$signal_name"
  event_record "supervisor interrupted by $signal_name"
  refresh_cycle_summary "$signal_exit"
  exit "$signal_exit"
}
trap 'handle_signal 130 INT' INT
trap 'handle_signal 143 TERM' TERM
trap 'handle_signal 129 HUP' HUP

if [[ "${AGENT_SUPERVISOR_ALLOW_DIRTY_TEST:-0}" != "1" && \
      -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]]; then
  printf 'Supervisor requires a clean worktree at launch.\n' >&2
  exit 2
fi

cycle_command="${AGENT_SUPERVISOR_CYCLE_COMMAND:-$ROOT_DIR/scripts/agent-cycle.sh}"
[[ -x "$cycle_command" ]] || { printf 'Cycle command is not executable: %s\n' "$cycle_command" >&2; exit 127; }
monitor_command="${AGENT_SUPERVISOR_MONITOR_COMMAND:-$ROOT_DIR/scripts/run-monitor.sh}"
if [[ "$monitor_mode" == "persistent-cli" && ! -x "$monitor_command" ]]; then
  printf 'Monitor command is not executable: %s\n' "$monitor_command" >&2
  exit 127
fi
cycle_args=(
  cycle
  --implementer "$implementer_agent"
  --implementer-model "$implementer_model"
  --implementer-effort "$implementer_effort"
  --reviewer "$reviewer_agent"
  --reviewer-model "$reviewer_model"
  --reviewer-effort "$reviewer_effort"
  --max-rounds "$max_rounds"
)
supervisor_start_round="$(
  sed -n 's/^CURRENT_ROUND=//p' "$AGENT_DIR/state.env" | head -n 1
)"
[[ "$supervisor_start_round" =~ ^[0-9]+$ ]] || supervisor_start_round=0
target_round=$((supervisor_start_round + max_rounds))
cycle_args+=(--target-round "$target_round")

attempt=0
quota_resumes=0
slice_resumes=0
pending_action_id=""
last_monitor_action=""
last_usage_file=""
next_stage="$start_stage"
rm -f -- "$ACTION_REQUEST_FILE" "$ACTION_RESPONSE_FILE"
node "$ROOT_DIR/scripts/lib/agent-usage-ledger.mjs" init \
  "$USAGE_LEDGER_FILE" \
  "$(sed -n 's/^ACTIVE_TASK_ID=//p' "$AGENT_DIR/state.env" | head -n 1)" \
  "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" || exit 2
state_write INITIALIZING "$next_stage" "$attempt" "$quota_resumes" "" "" SUPERVISOR_START
event_record "supervisor started"

if [[ "$monitor_mode" == "persistent-cli" && \
      "${AGENT_SUPERVISOR_MONITOR_ON_ERROR:-1}" == "1" ]]; then
  if ! dispatch_monitor_event SUPERVISOR_START "$next_stage" 0 ""; then
    state_write STOPPED GENERAL 0 "$quota_resumes" "" 6 MONITOR_START_FAILED
    event_record "persistent CLI GENERAL supervisor failed to initialize"
    refresh_cycle_summary 6
    exit 6
  fi
fi

if [[ -n "$start_epoch" && "$start_epoch" -gt "$(date +%s)" ]]; then
  start_iso="$(date -u -d "@$start_epoch" +'%Y-%m-%dT%H:%M:%SZ')"
  state_write SCHEDULED "$next_stage" "$attempt" "$quota_resumes" \
    "$start_iso" "" INITIAL_START
  event_record "initial cycle scheduled for $start_iso"
  wait_until_epoch "$start_epoch" "$supervisor_heartbeat" SCHEDULED
fi

while true; do
  attempt=$((attempt + 1))
  state_write RUNNING "$next_stage" "$attempt" "$quota_resumes" "" "" ""
  printf '\n=== Supervisor attempt %s; start stage %s ===\n' "$attempt" "$next_stage"

  rm -f -- "$STOP_FILE"
  cycle_attempt_args=("${cycle_args[@]}" --start-stage "$next_stage")
  if [[ "$next_stage" == "reviewer" && -n "$review_base" ]]; then
    cycle_attempt_args+=(--review-base "$review_base")
  fi
  "$cycle_command" "${cycle_attempt_args[@]}"
  cycle_exit=$?
  sync_usage_ledger || {
    state_write STOPPED "$next_stage" "$attempt" "$quota_resumes" "" \
      4 USAGE_LEDGER_FAILED
    refresh_cycle_summary 4
    exit 4
  }
  if (( cycle_exit == 0 )); then
    state_write COMPLETE COMPLETE "$attempt" "$quota_resumes" "" 0 SUCCESS
    event_record "supervisor completed"
    refresh_cycle_summary 0
    printf 'Supervised Agent run completed at implementation target %s.\n' \
      "$target_round"
    exit 0
  fi

  if (( cycle_exit == 3 )) && [[ ! -s "$STOP_FILE" ]]; then
    state_write STOPPED COMPLETE "$attempt" "$quota_resumes" "" \
      "$cycle_exit" OBSOLETE_ROUND_GUARD
    event_record "supervisor reached an obsolete absolute round guard"
    refresh_cycle_summary "$cycle_exit"
    printf 'Supervised Agent run reached an obsolete round guard (%s).\n' \
      "$target_round"
    exit 3
  fi

  stop_reason="$(stop_value STOP_REASON)"
  stop_stage="$(stop_value STAGE)"
  [[ -n "$stop_stage" ]] || stop_stage="UNKNOWN"
  [[ -n "$stop_reason" ]] || stop_reason="UNCLASSIFIED"
  event_record "attempt $attempt stopped: stage=$stop_stage reason=$stop_reason exit=$cycle_exit"

  if [[ "$stop_reason" == "USAGE_OR_BILLING_LIMIT" || \
        "$stop_reason" == "AUTONOMY_SLICE_LIMIT" ]]; then
    record_stop_usage "$stop_stage" "$attempt" "$stop_reason" || true
    if ! create_recovery_checkpoint "$stop_stage" "$attempt"; then
      state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
        "$cycle_exit" UNSAFE_RECOVERY
      dispatch_monitor_event \
        UNSAFE_RECOVERY "$stop_stage" "$cycle_exit" "$(stop_value LOG_FILE)" || true
      refresh_cycle_summary "$cycle_exit"
      exit 4
    fi

    resume_stage="${stop_stage,,}"
    case "$resume_stage" in
      implementer|reviewer) ;;
      *) resume_stage="implementer" ;;
    esac
    if [[ "$resume_stage" == "reviewer" ]]; then
      stopped_review_base="$(stop_value BASE_COMMIT)"
      if [[ -n "$stopped_review_base" ]]; then
        review_base="$(
          git -C "$ROOT_DIR" rev-parse --verify "$stopped_review_base^{commit}" 2>/dev/null
        )" || {
          state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
            "$cycle_exit" INVALID_REVIEW_BASE
          refresh_cycle_summary "$cycle_exit"
          printf 'Reviewer stop recorded an invalid base commit.\n' >&2
          exit 4
        }
      fi
    else
      review_base=""
    fi

    if [[ "$stop_reason" == "AUTONOMY_SLICE_LIMIT" ]]; then
      slice_resumes=$((slice_resumes + 1))
      can_continue=YES
      if (( slice_resumes >= max_autonomy_slices )); then
        can_continue=NO
      fi
      if ! request_monitor_action \
        "$stop_reason" "$stop_stage" "$cycle_exit" "$(stop_value LOG_FILE)" \
        "$can_continue"; then
        rm -f -- "$ACTION_REQUEST_FILE" "$ACTION_RESPONSE_FILE"
        pending_action_id=""
        state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
          6 "${MONITOR_ACTION_FAILURE_REASON:-MONITOR_ACTION_FAILED}"
        refresh_cycle_summary 6
        exit 6
      fi
      case "$MONITOR_DECISION" in
        CONTINUE_NOW)
          next_stage="$resume_stage"
          state_write RESUMING "$resume_stage" "$attempt" "$quota_resumes" \
            "" 0 MONITOR_CONTINUE
          continue
          ;;
        ROTATE_AND_CONTINUE)
          if ! agent_force_role_session_rotation \
            "$(sed -n 's/^ACTIVE_TASK_ID=//p' "$AGENT_DIR/state.env" | head -n 1)" \
            "$stop_stage" MONITOR_CONTEXT_EFFICIENCY; then
            state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
              4 SESSION_ROTATION_FAILED
            refresh_cycle_summary 4
            exit 4
          fi
          next_stage="$resume_stage"
          state_write RESUMING "$resume_stage" "$attempt" "$quota_resumes" \
            "" 0 MONITOR_ROTATE_AND_CONTINUE
          continue
          ;;
        STOP_OWNER)
          state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
            3 MONITOR_STOP_OWNER
          refresh_cycle_summary 3
          exit 3
          ;;
        WAIT_FOR_QUOTA) ;;
      esac
      waiting_status="WAITING_FOR_BUDGET_WINDOW"
      wait_label="GENERAL-selected quota window after budget/turn guard"
    else
      waiting_status="WAITING_FOR_QUOTA"
      wait_label="actual quota"
      dispatch_monitor_event \
        "$stop_reason" "$stop_stage" "$cycle_exit" "$(stop_value LOG_FILE)" || true
    fi

    if (( quota_resumes >= max_resumes )); then
      state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
        "$cycle_exit" MAX_QUOTA_RESUMES
      refresh_cycle_summary "$cycle_exit"
      printf 'Maximum quota resumes reached (%s).\n' "$max_resumes" >&2
      exit 3
    fi
    quota_resumes=$((quota_resumes + 1))
    now_epoch="$(date +%s)"
    telemetry_resume_epoch="$(usage_reset_epoch "$last_usage_file" || true)"
    if [[ -n "$first_resume_epoch" && "$first_resume_epoch" -gt "$now_epoch" ]]; then
      resume_epoch="$first_resume_epoch"
      first_resume_epoch=""
      event_record "using explicit first quota-resume time $resume_epoch"
    elif [[ "$telemetry_resume_epoch" =~ ^[1-9][0-9]*$ ]] && \
         (( telemetry_resume_epoch > now_epoch )); then
      resume_epoch="$telemetry_resume_epoch"
      event_record "using executor-reported quota reset $resume_epoch"
    elif [[ -n "$quota_anchor_epoch" ]]; then
      if (( now_epoch < quota_anchor_epoch )); then
        resume_epoch="$quota_anchor_epoch"
      else
        elapsed_since_anchor=$((now_epoch - quota_anchor_epoch))
        resume_epoch=$(( \
          quota_anchor_epoch + \
          ((elapsed_since_anchor / quota_wait) + 1) * quota_wait \
        ))
      fi
    else
      resume_epoch=$((now_epoch + quota_wait))
    fi
    resume_iso="$(date -u -d "@$resume_epoch" +'%Y-%m-%dT%H:%M:%SZ')"
    state_write "$waiting_status" "$stop_stage" "$attempt" "$quota_resumes" \
      "$resume_iso" "$cycle_exit" "$stop_reason"
    event_record "waiting after $wait_label until $resume_iso"
    refresh_cycle_summary "$cycle_exit"
    wait_until_epoch "$resume_epoch" "$supervisor_heartbeat" "$waiting_status"
    if [[ "$monitor_mode" == "persistent-cli" ]]; then
      dispatch_monitor_event WINDOW_RESUME "$resume_stage" 0 "" || {
        state_write STOPPED GENERAL "$attempt" "$quota_resumes" "" \
          6 MONITOR_RESUME_FAILED
        refresh_cycle_summary 6
        exit 6
      }
    fi
    slice_resumes=0
    next_stage="$resume_stage"
    continue
  fi

  state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
    "$cycle_exit" "$stop_reason"
  dispatch_monitor_event \
    "$stop_reason" "$stop_stage" "$cycle_exit" "$(stop_value LOG_FILE)" || true
  refresh_cycle_summary "$cycle_exit"
  printf 'Supervisor stopped on non-recoverable event: %s/%s\n' \
    "$stop_stage" "$stop_reason" >&2
  exit "$cycle_exit"
done
