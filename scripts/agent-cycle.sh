#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT_DIR/.agent/state.env"
LOCK_DIR="$ROOT_DIR/.agent/.cycle.lock"
RUNTIME_LIB="$ROOT_DIR/scripts/lib/agent-runtime.sh"
SUMMARY_SCRIPT="$ROOT_DIR/scripts/generate-cycle-summary.sh"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$RUNTIME_LIB"
agent_runtime_init "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./scripts/agent-cycle.sh <command> [args]

Commands:
  preflight [options]    Verify configured executors, permissions and readiness;
                         never starts an Agent.
  cycle [options]        Run a bounded number of rounds. One round is one
                         completed implementation deliverable; it may contain
                         serial successor segments. Reviews occur only between
                         rounds. The final round stops after IMPLEMENTER.
  implement [options]    Run one IMPLEMENTER round and local checkpoint.
  validate               Run the unified configured checks.
  review [options]       Run one read-only REVIEWER round.
  status                 Show Git, task, validation, handoff and runtime state.
  summary                Print the concise report for current/recent rounds.
  accept                 Accept the pending final implementation without
                         REVIEWER, then create a local state checkpoint.
  archive                Archive latest-review.md if not already archived.
  supervise [options]    Run the multi-window outer supervisor. attached stays
                         in the foreground; persistent-cli detaches safely.
  supervisor-status      Show detached-service and outer-supervisor state.
  supervisor-stop        Safely stop the detached supervisor process group.
  supervisor-log [lines] Show the latest detached supervisor log.
  supervisor-action ACTION [EVENT_ID]
                         Submit an attached GENERAL supervision decision at a
                         safe boundary.

Cycle options:
  --implementer, --implementer-agent claude|codex
  --implementer-model MODEL
  --implementer-effort low|medium|high|xhigh|max
  --successor-implementer claude|codex  Supervisor-only quota successor.
  --successor-implementer-model MODEL
  --successor-implementer-effort low|medium|high|xhigh|max
  --no-implementer-successor
  --reviewer, --reviewer-agent claude|codex
  --reviewer-model MODEL
  --reviewer-effort low|medium|high|xhigh|max
  --rounds N             Number of additional rounds requested now (default 1).
                         One round is exactly one implementation.
  --max-rounds N         Deprecated alias for --rounds.
  --target-round N       Absolute implementation target used by the supervisor
                         to preserve progress across process/quota resumes.
  --start-stage implementer|reviewer
  --review-base COMMIT    Exact base for a REVIEWER process/quota resume;
                         normally read from pending-review state.
  --implementer-segment N Internal serial segment number for recovery.
  --implementer-handoff FILE
                         Internal structured predecessor handoff.

Defaults come from .agent/runtime.env. Roles are not tied to executors: the same
executor may fill both roles in separate fresh processes, and roles may be
reversed. The workflow never runs two Agents concurrently and never pushes,
deploys, resets, cleans, switches branches, rebases, or retries without a limit.
EOF
}

state_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$STATE_FILE" | head -n 1
}

commit_review_handoff() {
  local round="$1"
  local unexpected=0

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      .agent/latest-review.md|.agent/state.env|.agent/review-history/*.md) ;;
      *)
        printf 'Unexpected tracked change after read-only review: %s\n' "$path" >&2
        unexpected=1
        ;;
    esac
  done < <(git -C "$ROOT_DIR" diff --name-only)

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      .agent/review-history/*.md) ;;
      *)
        printf 'Unexpected untracked file after read-only review: %s\n' "$path" >&2
        unexpected=1
        ;;
    esac
  done < <(git -C "$ROOT_DIR" ls-files --others --exclude-standard)

  if (( unexpected != 0 )); then
    printf 'Review handoff was not committed; stopping to protect the workspace.\n' >&2
    return 4
  fi

  git -C "$ROOT_DIR" add -- .agent/latest-review.md .agent/state.env .agent/review-history
  if git -C "$ROOT_DIR" diff --cached --quiet; then
    printf 'Review produced no handoff changes to checkpoint.\n' >&2
    return 4
  fi
  git -C "$ROOT_DIR" \
    -c core.hooksPath=/dev/null \
    -c commit.gpgSign=false \
    commit -m "agent: review round $round" \
    >"$ROOT_DIR/.agent/artifacts/review/git-commit-round-${round}.log" 2>&1
}

command_name="${1:-}"
if [[ -z "$command_name" || "$command_name" == "--help" || "$command_name" == "-h" ]]; then
  usage
  [[ -n "$command_name" ]] && exit 0 || exit 2
fi
shift

case "$command_name" in
  cycle)
    implementer_agent="$(agent_runtime_executor_config IMPLEMENTER_AGENT claude)" || exit 2
    implementer_model="$(agent_runtime_model_config IMPLEMENTER_MODEL sonnet)" || exit 2
    implementer_effort="$(agent_runtime_effort_config IMPLEMENTER_EFFORT high)" || exit 2
    successor_enabled="$(
      agent_runtime_enum_config IMPLEMENTER_SUCCESSOR_ENABLED yes yes no
    )" || exit 2
    successor_agent="$(
      agent_runtime_executor_config IMPLEMENTER_SUCCESSOR_AGENT codex
    )" || exit 2
    successor_model="$(
      agent_runtime_model_config IMPLEMENTER_SUCCESSOR_MODEL gpt-5.6-sol
    )" || exit 2
    successor_effort="$(
      agent_runtime_effort_config IMPLEMENTER_SUCCESSOR_EFFORT high
    )" || exit 2
    reviewer_agent="$(agent_runtime_executor_config REVIEWER_AGENT codex)" || exit 2
    reviewer_model="$(agent_runtime_model_config REVIEWER_MODEL gpt-5.6-sol)" || exit 2
    reviewer_effort="$(agent_runtime_effort_config REVIEWER_EFFORT high)" || exit 2
    next_stage="implementer"
    review_base_override=""
    requested_rounds="1"
    target_round_override=""
    implementer_segment=1
    implementer_handoff=""

    while (( $# > 0 )); do
      case "$1" in
        --implementer|--implementer-agent)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          implementer_agent="$2"
          shift 2
          ;;
        --implementer-model)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          implementer_model="$2"
          shift 2
          ;;
        --implementer-effort)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          implementer_effort="$2"
          shift 2
          ;;
        --successor-implementer)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          successor_agent="$2"
          successor_enabled=yes
          shift 2
          ;;
        --successor-implementer-model)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          successor_model="$2"
          successor_enabled=yes
          shift 2
          ;;
        --successor-implementer-effort)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          successor_effort="$2"
          successor_enabled=yes
          shift 2
          ;;
        --no-implementer-successor)
          successor_enabled=no
          shift
          ;;
        --reviewer|--reviewer-agent)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          reviewer_agent="$2"
          shift 2
          ;;
        --reviewer-model)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          reviewer_model="$2"
          shift 2
          ;;
        --reviewer-effort)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          reviewer_effort="$2"
          shift 2
          ;;
        --rounds|--max-rounds)
          [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
          requested_rounds="$2"
          shift 2
          ;;
        --target-round)
          [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
          target_round_override="$2"
          shift 2
          ;;
        --start-stage)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          next_stage="$2"
          shift 2
          ;;
        --review-base)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          review_base_override="$2"
          shift 2
          ;;
        --implementer-segment)
          [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
          implementer_segment="$2"
          shift 2
          ;;
        --implementer-handoff)
          [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
          implementer_handoff="$2"
          shift 2
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        *)
          printf 'Unknown cycle option: %s\n\n' "$1" >&2
          usage >&2
          exit 2
          ;;
      esac
    done

    agent_validate_executor "$implementer_agent" || exit 2
    agent_validate_model "$implementer_model" || exit 2
    agent_validate_effort "$implementer_effort" || exit 2
    if [[ "$successor_enabled" == "yes" ]]; then
      agent_validate_executor "$successor_agent" || exit 2
      agent_validate_model "$successor_model" || exit 2
      agent_validate_effort "$successor_effort" || exit 2
      if [[ "$successor_agent" == "$implementer_agent" ]]; then
        printf 'Enabled successor must use a different executor from IMPLEMENTER.\n' >&2
        exit 2
      fi
    fi
    agent_validate_executor "$reviewer_agent" || exit 2
    agent_validate_model "$reviewer_model" || exit 2
    agent_validate_effort "$reviewer_effort" || exit 2
    case "$next_stage" in
      implementer|reviewer) ;;
      *)
        printf 'Invalid --start-stage: %s\n' "$next_stage" >&2
        exit 2
        ;;
    esac
    if [[ -n "$review_base_override" ]]; then
      if [[ "$next_stage" != "reviewer" ]]; then
        printf '%s\n' '--review-base requires --start-stage reviewer.' >&2
        exit 2
      fi
      review_base_override="$(
        git -C "$ROOT_DIR" rev-parse --verify "$review_base_override^{commit}" 2>/dev/null
      )" || {
        printf 'Invalid --review-base commit.\n' >&2
        exit 2
      }
    fi

    if ! agent_acquire_lock "$LOCK_DIR" 'automatic cycle'; then
      exit 2
    fi
    cycle_cleanup() {
      local cycle_exit=$?
      trap - EXIT
      if summary_path="$("$SUMMARY_SCRIPT" "$cycle_exit" 2>/dev/null)"; then
        printf '\nCycle summary: %s\n' "$summary_path"
      else
        printf '\nWarning: could not generate the cycle summary.\n' >&2
      fi
      agent_release_lock "$LOCK_DIR" || true
      exit "$cycle_exit"
    }
    trap cycle_cleanup EXIT

    printf 'Cycle configuration\n'
    printf '  IMPLEMENTER: %s / %s / %s\n' \
      "$implementer_agent" "$implementer_model" "$implementer_effort"
    if [[ "$successor_enabled" == "yes" ]]; then
      printf '  SUCCESSOR:   %s / %s / %s (supervisor quota failover)\n' \
        "$successor_agent" "$successor_model" "$successor_effort"
    else
      printf '  SUCCESSOR:   disabled\n'
    fi
    printf '  REVIEWER:    %s / %s / %s\n' \
      "$reviewer_agent" "$reviewer_model" "$reviewer_effort"
    printf '  START STAGE: %s\n' "$next_stage"
    starting_round="$(state_value CURRENT_ROUND)"
    [[ "$starting_round" =~ ^[0-9]+$ ]] || starting_round=0
    if [[ -n "$target_round_override" ]]; then
      target_round="$target_round_override"
    else
      target_round="$((starting_round + requested_rounds))"
    fi
    if (( target_round < starting_round )); then
      printf 'Target round %s is behind current round %s.\n' \
        "$target_round" "$starting_round" >&2
      exit 2
    fi
    printf '  ROUNDS NOW:  %s\n' "$requested_rounds"
    printf '  TARGET:      implementation round %s (current %s)\n' \
      "$target_round" "$starting_round"

    preflight_args=(
      --implementer-agent "$implementer_agent" \
      --implementer-model "$implementer_model" \
      --implementer-effort "$implementer_effort" \
      --reviewer-agent "$reviewer_agent" \
      --reviewer-model "$reviewer_model" \
      --reviewer-effort "$reviewer_effort"
    )
    if [[ "$successor_enabled" == "yes" ]]; then
      preflight_args+=(
        --successor-implementer "$successor_agent"
        --successor-implementer-model "$successor_model"
        --successor-implementer-effort "$successor_effort"
      )
    else
      preflight_args+=(--no-implementer-successor)
    fi
    preflight_args+=(--max-rounds "$target_round")
    if ! "$ROOT_DIR/scripts/agent-preflight.sh" "${preflight_args[@]}"; then
      printf 'Automatic cycle stopped at preflight; no Agent was started.\n' >&2
      exit 6
    fi

    mkdir -p "$ROOT_DIR/.agent/artifacts/cycle"
    {
      printf 'TASK_ID=%s\n' "$(state_value ACTIVE_TASK_ID)"
      printf 'STARTING_ROUND=%s\n' "$starting_round"
      printf 'REQUESTED_ROUNDS=%s\n' "$requested_rounds"
      printf 'TARGET_ROUND=%s\n' "$target_round"
      printf 'IMPLEMENTER_SEGMENT=%s\n' "$implementer_segment"
      printf 'IMPLEMENTER_HANDOFF=%s\n' "$implementer_handoff"
      printf 'STARTED_AT_UTC=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    } >"$ROOT_DIR/.agent/artifacts/cycle/runtime.env"

    while true; do
      task_status="$(state_value ACTIVE_TASK_STATUS)"
      current_round="$(state_value CURRENT_ROUND)"
      pending_review="$(state_value PENDING_REVIEW)"
      [[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0

      if [[ "$task_status" == "COMPLETE" ]]; then
        printf 'Active task already has a PASS verdict. Nothing to run.\n'
        exit 0
      fi

      # A pending final implementation is reviewed only when the owner requests
      # more work. This review closes the previous round and prepares the next
      # implementation; a reviewer retry lands here as well.
      if [[ "$pending_review" == "YES" || "$next_stage" == "reviewer" ]]; then
        if [[ "$pending_review" != "YES" ]]; then
          printf 'Cannot start REVIEWER: no implementation is pending review.\n' >&2
          exit 3
        fi
        implementation_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
        base_commit="$review_base_override"
        if [[ -z "$base_commit" ]]; then
          recorded_base="$(state_value PENDING_REVIEW_BASE_COMMIT)"
          [[ -n "$recorded_base" ]] || \
            recorded_base="$(state_value LAST_IMPLEMENTATION_BASE_COMMIT)"
          if [[ -n "$recorded_base" ]]; then
            base_commit="$(
              git -C "$ROOT_DIR" rev-parse --verify "$recorded_base^{commit}" 2>/dev/null
            )" || base_commit=""
          fi
        fi
        if [[ -z "$base_commit" ]]; then
          base_commit="$(git -C "$ROOT_DIR" rev-parse "$implementation_commit^")"
        fi
        if ! git -C "$ROOT_DIR" merge-base --is-ancestor \
          "$base_commit" "$implementation_commit"; then
          printf 'Review base is not an ancestor of the target: %s\n' "$base_commit" >&2
          exit 2
        fi

        printf '\n=== REVIEWER (%s) for implementation round %s ===\n' \
          "$reviewer_agent" "$current_round"
        AGENT_CYCLE_LOCK_HELD=1 "$ROOT_DIR/scripts/run-review.sh" \
          --agent "$reviewer_agent" \
          --model "$reviewer_model" \
          --effort "$reviewer_effort" \
          --max-rounds "$target_round" \
          "$implementation_commit" "$base_commit"
        review_exit=$?
        if (( review_exit != 0 )); then
          printf 'Cycle stopped during REVIEWER (exit %s).\n' "$review_exit" >&2
          exit "$review_exit"
        fi

        reviewed_round="$(state_value CURRENT_ROUND)"
        verdict="$(state_value LAST_REVIEW_VERDICT)"
        commit_review_handoff "$reviewed_round"
        handoff_exit=$?
        if (( handoff_exit != 0 )); then
          printf 'Cycle stopped while checkpointing review (exit %s).\n' "$handoff_exit" >&2
          exit "$handoff_exit"
        fi

        printf 'Review checkpoint: %s\n' "$(git -C "$ROOT_DIR" rev-parse HEAD)"
        printf 'Verdict: %s\n' "$verdict"
        if [[ "$verdict" == "PASS" ]]; then
          printf 'Review found no blocking changes; the owner-requested next implementation still runs.\n'
        elif [[ "$verdict" != "CHANGES_REQUIRED" ]]; then
          printf 'Unknown review verdict; stopping: %s\n' "$verdict" >&2
          exit 4
        fi
        next_stage="implementer"
        review_base_override=""
        current_round="$(state_value CURRENT_ROUND)"
      fi

      if (( current_round >= target_round )); then
        printf 'Requested implementation target %s is already reached.\n' \
          "$target_round"
        exit 0
      fi

      printf '\n=== IMPLEMENTER (%s) round %s, segment %s (target %s) ===\n' \
        "$implementer_agent" "$((current_round + 1))" \
        "$implementer_segment" "$target_round"
      implementation_args=(
        --agent "$implementer_agent"
        --model "$implementer_model"
        --effort "$implementer_effort"
        --max-rounds "$target_round"
        --segment "$implementer_segment"
      )
      if [[ -n "$implementer_handoff" ]]; then
        implementation_args+=(--handoff-file "$implementer_handoff")
      fi
      AGENT_CYCLE_LOCK_HELD=1 "$ROOT_DIR/scripts/run-implementation.sh" \
        "${implementation_args[@]}"
      implementation_exit=$?
      if (( implementation_exit != 0 )); then
        printf 'Cycle stopped during IMPLEMENTER (exit %s).\n' "$implementation_exit" >&2
        exit "$implementation_exit"
      fi

      current_round="$(state_value CURRENT_ROUND)"
      # A successor handoff belongs only to the interrupted round. If this
      # cycle continues into another owner-requested round, the already-active
      # runtime starts that new round as segment 1 without replaying the handoff.
      implementer_segment=1
      implementer_handoff=""
      if (( current_round >= target_round )); then
        printf 'Final requested round completed after IMPLEMENTER %s.\n' "$current_round"
        printf 'No REVIEWER was started; the owner now inspects the implementation.\n'
        exit 0
      fi
      next_stage="reviewer"
    done
    ;;
  preflight)
    exec "$ROOT_DIR/scripts/agent-preflight.sh" "$@"
    ;;
  implement)
    exec "$ROOT_DIR/scripts/run-implementation.sh" "$@"
    ;;
  validate)
    exec "$ROOT_DIR/scripts/run-validation.sh" "$@"
    ;;
  review)
    exec "$ROOT_DIR/scripts/run-review.sh" "$@"
    ;;
  status)
    if (( $# != 0 )); then usage >&2; exit 2; fi
    printf 'Git status\n'
    git -C "$ROOT_DIR" status --short --branch
    printf '\nDefault role configuration\n'
    sed -n '1,48p' "$ROOT_DIR/.agent/runtime.env"
    printf '\nAgent state\n'
    sed -n '1,160p' "$STATE_FILE"
    printf '\nActive task\n'
    sed -n '1,24p' "$ROOT_DIR/.agent/next-task.md"
    printf '\nLatest review status\n'
    grep -E '^(REVIEW_STATUS|VERDICT):' "$ROOT_DIR/.agent/latest-review.md" || \
      printf 'No status marker found.\n'
    if [[ -f "$ROOT_DIR/.agent/artifacts/validation/summary.md" ]]; then
      printf '\nLatest validation\n'
      sed -n '1,14p' "$ROOT_DIR/.agent/artifacts/validation/summary.md"
    fi
    if [[ -f "$ROOT_DIR/.agent/artifacts/runtime/last-stop.env" ]]; then
      printf '\nLatest automatic stop\n'
      sed -n '1,14p' "$ROOT_DIR/.agent/artifacts/runtime/last-stop.env"
    fi
    if [[ -f "$ROOT_DIR/.agent/artifacts/supervisor/state.env" ]]; then
      printf '\nOuter supervisor\n'
      sed -n '1,24p' "$ROOT_DIR/.agent/artifacts/supervisor/state.env"
    fi
    ;;
  summary)
    if (( $# != 0 )); then usage >&2; exit 2; fi
    summary_path="$("$SUMMARY_SCRIPT")" || exit $?
    sed -n '1,360p' "$summary_path"
    ;;
  accept)
    if (( $# != 0 )); then usage >&2; exit 2; fi
    if ! agent_acquire_lock "$LOCK_DIR" 'owner acceptance'; then
      exit 2
    fi
    accept_cleanup() {
      local accept_exit=$?
      trap - EXIT
      agent_release_lock "$LOCK_DIR" || true
      exit "$accept_exit"
    }
    trap accept_cleanup EXIT
    if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]]; then
      printf 'Owner acceptance requires a clean working tree.\n' >&2
      exit 2
    fi
    if [[ "$(state_value PENDING_REVIEW)" != "YES" || \
          "$(state_value ACTIVE_TASK_STATUS)" != "AWAITING_OWNER" ]]; then
      printf 'No final implementation is awaiting owner acceptance.\n' >&2
      exit 3
    fi
    accepted_round="$(state_value CURRENT_ROUND)"
    state_tmp="$STATE_FILE.tmp"
    while IFS= read -r state_line; do
      case "$state_line" in
        ACTIVE_TASK_STATUS=*|PENDING_REVIEW=*|PENDING_REVIEW_ROUND=*|PENDING_REVIEW_BASE_COMMIT=*|FINAL_DECISION=*) ;;
        *) printf '%s\n' "$state_line" ;;
      esac
    done <"$STATE_FILE" >"$state_tmp"
    {
      printf 'ACTIVE_TASK_STATUS=COMPLETE\n'
      printf 'PENDING_REVIEW=NO\n'
      printf 'PENDING_REVIEW_ROUND=\n'
      printf 'PENDING_REVIEW_BASE_COMMIT=\n'
      printf 'FINAL_DECISION=OWNER_ACCEPTED\n'
    } >>"$state_tmp"
    mv "$state_tmp" "$STATE_FILE"
    git -C "$ROOT_DIR" add -- .agent/state.env
    git -C "$ROOT_DIR" \
      -c core.hooksPath=/dev/null \
      -c commit.gpgSign=false \
      commit -m "agent: owner accepts implementation round $accepted_round" \
      >"$ROOT_DIR/.agent/artifacts/cycle/owner-accept-round-${accepted_round}.log" 2>&1 || {
        printf 'Could not checkpoint owner acceptance; state change was preserved.\n' >&2
        exit 4
      }
    printf 'Owner accepted implementation round %s without formal review.\n' \
      "$accepted_round"
    ;;
  archive)
    if (( $# != 0 )); then usage >&2; exit 2; fi
    latest="$ROOT_DIR/.agent/latest-review.md"
    history="$ROOT_DIR/.agent/review-history"
    if ! grep -Eq '^VERDICT: (PASS|CHANGES_REQUIRED)$' "$latest"; then
      printf 'latest-review.md is not a completed formal review.\n' >&2
      exit 2
    fi
    mkdir -p "$history"
    for existing in "$history"/*.md; do
      [[ -e "$existing" ]] || continue
      if cmp -s "$latest" "$existing"; then
        printf 'Latest review is already archived at %s\n' "$existing"
        exit 0
      fi
    done
    reviewed_commit="$(sed -n 's/^- Reviewed commit: *//p' "$latest" | head -n 1 | tr -cd '[:alnum:]')"
    [[ -n "$reviewed_commit" ]] || reviewed_commit="unknown"
    destination="$history/$(date -u +"%Y-%m-%dT%H%M%SZ")_manual_${reviewed_commit:0:12}.md"
    install -m 0644 "$latest" "$destination"
    printf 'Archived latest review at %s\n' "$destination"
    ;;
  supervise)
    supervision_mode="$(
      agent_runtime_enum_config MONITOR_MODE attached attached persistent-cli
    )" || exit 2
    supervision_mode_explicit=0
    option_index=1
    while (( option_index <= $# )); do
      if [[ "${!option_index}" == "--monitor-mode" ]]; then
        option_index=$((option_index + 1))
        [[ "$option_index" -le "$#" ]] || { usage >&2; exit 2; }
        supervision_mode="${!option_index}"
        supervision_mode_explicit=1
        break
      fi
      option_index=$((option_index + 1))
    done
    if [[ "$supervision_mode" == "persistent-cli" ]]; then
      if (( supervision_mode_explicit == 0 )); then
        exec "$ROOT_DIR/scripts/agent-supervisor-service.sh" start \
          --monitor-mode persistent-cli "$@"
      fi
      exec "$ROOT_DIR/scripts/agent-supervisor-service.sh" start "$@"
    fi
    exec "$ROOT_DIR/scripts/agent-supervisor.sh" supervise "$@"
    ;;
  supervisor-status)
    if (( $# != 0 )); then usage >&2; exit 2; fi
    exec "$ROOT_DIR/scripts/agent-supervisor-service.sh" status
    ;;
  supervisor-stop)
    if (( $# != 0 )); then usage >&2; exit 2; fi
    exec "$ROOT_DIR/scripts/agent-supervisor-service.sh" stop
    ;;
  supervisor-log)
    if (( $# > 1 )); then usage >&2; exit 2; fi
    exec "$ROOT_DIR/scripts/agent-supervisor-service.sh" log "${1:-120}"
    ;;
  supervisor-action)
    exec "$ROOT_DIR/scripts/agent-supervisor.sh" action "$@"
    ;;
  *)
    printf 'Unknown command: %s\n\n' "$command_name" >&2
    usage >&2
    exit 2
    ;;
esac
