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
  cycle [options]        IMPLEMENTER -> validate/checkpoint -> REVIEWER; repeat
                         serially until PASS or the bounded round limit.
  implement [options]    Run one IMPLEMENTER round and local checkpoint.
  validate               Run the unified configured checks.
  review [options]       Run one read-only REVIEWER round.
  status                 Show Git, task, validation, handoff and runtime state.
  summary                Print the concise report for current/recent rounds.
  archive                Archive latest-review.md if not already archived.
  supervise [options]     Run the multi-window, quota-aware outer supervisor.
  supervisor-status      Show persisted outer-supervisor state.

Cycle options:
  --implementer, --implementer-agent claude|codex
  --implementer-model MODEL
  --implementer-effort low|medium|high|xhigh|max
  --reviewer, --reviewer-agent claude|codex
  --reviewer-model MODEL
  --reviewer-effort low|medium|high|xhigh|max
  --start-stage implementer|reviewer
  --review-base COMMIT    Base for a direct REVIEWER resume; defaults to the
                          recorded owner-checkpoint base, then HEAD^.

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
    reviewer_agent="$(agent_runtime_executor_config REVIEWER_AGENT codex)" || exit 2
    reviewer_model="$(agent_runtime_model_config REVIEWER_MODEL gpt-5.6-sol)" || exit 2
    reviewer_effort="$(agent_runtime_effort_config REVIEWER_EFFORT high)" || exit 2
    next_stage="implementer"
    review_base_override=""

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
    printf '  REVIEWER:    %s / %s / %s\n' \
      "$reviewer_agent" "$reviewer_model" "$reviewer_effort"
    printf '  START STAGE: %s\n' "$next_stage"

    if ! "$ROOT_DIR/scripts/agent-preflight.sh" \
      --implementer-agent "$implementer_agent" \
      --implementer-model "$implementer_model" \
      --implementer-effort "$implementer_effort" \
      --reviewer-agent "$reviewer_agent" \
      --reviewer-model "$reviewer_model" \
      --reviewer-effort "$reviewer_effort"; then
      printf 'Automatic cycle stopped at preflight; no Agent was started.\n' >&2
      exit 6
    fi

    while true; do
      task_status="$(state_value ACTIVE_TASK_STATUS)"
      current_round="$(state_value CURRENT_ROUND)"
      max_rounds="$(state_value MAX_ROUNDS)"
      [[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
      [[ "$max_rounds" =~ ^[1-9][0-9]*$ ]] || max_rounds=3

      if [[ "$task_status" == "COMPLETE" ]]; then
        printf 'Active task already has a PASS verdict. Nothing to run.\n'
        exit 0
      fi
      if (( current_round >= max_rounds )); then
        printf 'Maximum review rounds reached (%s). Returning control to the owner.\n' \
          "$max_rounds" >&2
        exit 3
      fi

      if [[ "$next_stage" == "implementer" ]]; then
        printf '\n=== IMPLEMENTER (%s) round %s/%s ===\n' \
          "$implementer_agent" "$((current_round + 1))" "$max_rounds"
        AGENT_CYCLE_LOCK_HELD=1 "$ROOT_DIR/scripts/run-implementation.sh" \
          --agent "$implementer_agent" \
          --model "$implementer_model" \
          --effort "$implementer_effort"
        implementation_exit=$?
        if (( implementation_exit != 0 )); then
          printf 'Cycle stopped during IMPLEMENTER (exit %s).\n' "$implementation_exit" >&2
          exit "$implementation_exit"
        fi
      else
        printf '\nResuming directly at REVIEWER for the existing implementation checkpoint.\n'
      fi

      implementation_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
      if [[ "$next_stage" == "reviewer" ]]; then
        base_commit="$review_base_override"
        if [[ -z "$base_commit" ]]; then
          recorded_base="$(state_value LAST_IMPLEMENTATION_BASE_COMMIT)"
          if [[ -n "$recorded_base" ]]; then
            base_commit="$(
              git -C "$ROOT_DIR" rev-parse --verify "$recorded_base^{commit}" 2>/dev/null
            )" || base_commit=""
          fi
        fi
      else
        base_commit=""
      fi
      if [[ -z "$base_commit" ]]; then
        base_commit="$(git -C "$ROOT_DIR" rev-parse "$implementation_commit^")"
      fi
      if ! git -C "$ROOT_DIR" merge-base --is-ancestor \
        "$base_commit" "$implementation_commit"; then
        printf 'Review base is not an ancestor of the target: %s\n' "$base_commit" >&2
        exit 2
      fi

      printf '\n=== REVIEWER (%s) round %s/%s ===\n' \
        "$reviewer_agent" "$((current_round + 1))" "$max_rounds"
      AGENT_CYCLE_LOCK_HELD=1 "$ROOT_DIR/scripts/run-review.sh" \
        --agent "$reviewer_agent" \
        --model "$reviewer_model" \
        --effort "$reviewer_effort" \
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
        printf 'Automatic Agent cycle completed successfully.\n'
        exit 0
      fi
      if [[ "$verdict" != "CHANGES_REQUIRED" ]]; then
        printf 'Unknown review verdict; stopping: %s\n' "$verdict" >&2
        exit 4
      fi
      next_stage="implementer"
      review_base_override=""
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
    sed -n '1,24p' "$ROOT_DIR/.agent/runtime.env"
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
    exec "$ROOT_DIR/scripts/agent-supervisor.sh" supervise "$@"
    ;;
  supervisor-status)
    if (( $# != 0 )); then usage >&2; exit 2; fi
    exec "$ROOT_DIR/scripts/agent-supervisor.sh" status
    ;;
  *)
    printf 'Unknown command: %s\n\n' "$command_name" >&2
    usage >&2
    exit 2
    ;;
esac
