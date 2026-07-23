#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
ARTIFACT_DIR="$AGENT_DIR/artifacts/supervisor"
STATE_FILE="$ARTIFACT_DIR/state.env"
EVENT_LOG="$ARTIFACT_DIR/events.log"
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

Runs one complete multi-window Agent rotation. The supervisor invokes the
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

Recovery options:
  --start-at DATE        Wait before the first cycle attempt; accepted by `date -d`.
                         Also becomes the fixed quota-window anchor by default.
  --quota-anchor DATE    Fixed quota reset anchor; defaults to --start-at.
  --resume-at DATE       Absolute first quota-resume time accepted by `date -d`.
  --quota-wait-seconds N Subsequent quota wait; default runtime.env value.
  --max-quota-resumes N  Hard recovery limit.
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
    printf 'RESUME_AT=%s\n' "$resume_at"
    printf 'LAST_EXIT_CODE=%s\n' "$last_exit"
    printf 'LAST_STOP_REASON=%s\n' "$last_reason"
    printf 'IMPLEMENTER=%s/%s/%s\n' "$implementer_agent" "$implementer_model" "$implementer_effort"
    printf 'REVIEWER=%s/%s/%s\n' "$reviewer_agent" "$reviewer_model" "$reviewer_effort"
    printf 'MONITOR=%s/%s/%s\n' "$monitor_agent" "$monitor_model" "$monitor_effort"
    printf 'UPDATED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >"$tmp"
  mv "$tmp" "$STATE_FILE"
}

event_record() {
  mkdir -p "$ARTIFACT_DIR"
  printf '%s\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$EVENT_LOG"
}

stop_value() {
  sed -n "s/^${1}=//p" "$STOP_FILE" 2>/dev/null | head -n 1
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
      printf '[%s] WAITING_FOR_QUOTA: %ss remaining; no Agent is running.\n' \
        "$(date -u +'%H:%M:%SZ')" "$remaining"
      next_heartbeat=$((now + heartbeat))
    fi
    wait_seconds=60
    (( remaining < wait_seconds )) && wait_seconds="$remaining"
    sleep "$wait_seconds"
  done
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
quota_wait="$(agent_runtime_config QUOTA_WAIT_SECONDS 18000 60 604800)" || exit 2
max_resumes="$(agent_runtime_config MAX_QUOTA_RESUMES 6 1 100)" || exit 2
supervisor_heartbeat="$(agent_runtime_config SUPERVISOR_HEARTBEAT_SECONDS 300 30 3600)" || exit 2
first_resume_at=""
start_at=""
quota_anchor_at=""

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
[[ "$quota_wait" =~ ^[0-9]+$ && "$quota_wait" -ge 60 ]] || { printf 'Invalid quota wait.\n' >&2; exit 2; }
[[ "$max_resumes" =~ ^[1-9][0-9]*$ ]] || { printf 'Invalid max resumes.\n' >&2; exit 2; }

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
cycle_args=(
  cycle
  --implementer "$implementer_agent"
  --implementer-model "$implementer_model"
  --implementer-effort "$implementer_effort"
  --reviewer "$reviewer_agent"
  --reviewer-model "$reviewer_model"
  --reviewer-effort "$reviewer_effort"
)

attempt=0
quota_resumes=0
next_stage="implementer"
event_record "supervisor started"

if [[ -n "$start_epoch" && "$start_epoch" -gt "$(date +%s)" ]]; then
  start_iso="$(date -u -d "@$start_epoch" +'%Y-%m-%dT%H:%M:%SZ')"
  state_write SCHEDULED "$next_stage" "$attempt" "$quota_resumes" \
    "$start_iso" "" INITIAL_START
  event_record "initial cycle scheduled for $start_iso"
  wait_until_epoch "$start_epoch" "$supervisor_heartbeat"
fi

while true; do
  attempt=$((attempt + 1))
  state_write RUNNING "$next_stage" "$attempt" "$quota_resumes" "" "" ""
  printf '\n=== Supervisor attempt %s; start stage %s ===\n' "$attempt" "$next_stage"

  rm -f -- "$STOP_FILE"
  "$cycle_command" "${cycle_args[@]}" --start-stage "$next_stage"
  cycle_exit=$?
  if (( cycle_exit == 0 )); then
    state_write COMPLETE COMPLETE "$attempt" "$quota_resumes" "" 0 SUCCESS
    event_record "supervisor completed"
    printf 'Supervised Agent rotation completed.\n'
    exit 0
  fi

  stop_reason="$(stop_value STOP_REASON)"
  stop_stage="$(stop_value STAGE)"
  [[ -n "$stop_stage" ]] || stop_stage="UNKNOWN"
  [[ -n "$stop_reason" ]] || stop_reason="UNCLASSIFIED"
  event_record "attempt $attempt stopped: stage=$stop_stage reason=$stop_reason exit=$cycle_exit"

  if [[ "$stop_reason" == "USAGE_OR_BILLING_LIMIT" ]]; then
    if (( quota_resumes >= max_resumes )); then
      state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
        "$cycle_exit" MAX_QUOTA_RESUMES
      printf 'Maximum quota resumes reached (%s).\n' "$max_resumes" >&2
      exit 3
    fi
    if ! create_recovery_checkpoint "$stop_stage" "$attempt"; then
      state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
        "$cycle_exit" UNSAFE_RECOVERY
      if [[ "${AGENT_SUPERVISOR_MONITOR_ON_ERROR:-1}" == "1" ]]; then
        "$ROOT_DIR/scripts/run-monitor.sh" \
          --event UNSAFE_RECOVERY --stage "$stop_stage" --exit-code "$cycle_exit" \
          --log-file "$(stop_value LOG_FILE)" \
          --agent "$monitor_agent" --model "$monitor_model" --effort "$monitor_effort" || true
      fi
      exit 4
    fi

    quota_resumes=$((quota_resumes + 1))
    now_epoch="$(date +%s)"
    if [[ -n "$first_resume_epoch" && "$first_resume_epoch" -gt "$now_epoch" ]]; then
      resume_epoch="$first_resume_epoch"
      first_resume_epoch=""
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
    state_write WAITING_FOR_QUOTA "$stop_stage" "$attempt" "$quota_resumes" \
      "$resume_iso" "$cycle_exit" "$stop_reason"
    event_record "waiting for quota until $resume_iso"
    wait_until_epoch "$resume_epoch" "$supervisor_heartbeat"
    next_stage="${stop_stage,,}"
    case "$next_stage" in
      implementer|reviewer) ;;
      *) next_stage="implementer" ;;
    esac
    continue
  fi

  state_write STOPPED "$stop_stage" "$attempt" "$quota_resumes" "" \
    "$cycle_exit" "$stop_reason"
  if [[ "${AGENT_SUPERVISOR_MONITOR_ON_ERROR:-1}" == "1" ]]; then
    "$ROOT_DIR/scripts/run-monitor.sh" \
      --event "$stop_reason" --stage "$stop_stage" --exit-code "$cycle_exit" \
      --log-file "$(stop_value LOG_FILE)" \
      --agent "$monitor_agent" --model "$monitor_model" --effort "$monitor_effort" || true
  fi
  printf 'Supervisor stopped on non-recoverable event: %s/%s\n' \
    "$stop_stage" "$stop_reason" >&2
  exit "$cycle_exit"
done
