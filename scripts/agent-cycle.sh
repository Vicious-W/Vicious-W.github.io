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
  preflight              Verify permissions/auth/MCP/checkpoint readiness only;
                         never starts either Agent.
  cycle                  Claude implement -> validate -> commit -> Codex review;
                         repeat serially until PASS or the three-round limit.
  implement              Run one Claude implementation round and local checkpoint.
  validate               Run the unified configured checks.
  review [target base]   Run one read-only Codex review.
  status                 Show Git, task, validation, and handoff state.
  summary                Generate and print a concise report of all rounds in
                         the current/recent task cycle.
  archive                Archive latest-review.md if not already archived.

The automatic cycle never runs both Agents concurrently and never pushes,
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
    commit -m "agent: codex review round $round" \
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
    if (( $# != 0 )); then
      usage >&2
      exit 2
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

    if ! "$ROOT_DIR/scripts/agent-preflight.sh"; then
      printf 'Automatic cycle stopped at preflight; neither Agent was started.\n' >&2
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
        printf 'Maximum review rounds reached (%s). Returning control to the project owner.\n' "$max_rounds" >&2
        exit 3
      fi

      printf '\n=== Claude implementation round %s/%s ===\n' "$((current_round + 1))" "$max_rounds"
      AGENT_CYCLE_LOCK_HELD=1 "$ROOT_DIR/scripts/run-implementation.sh"
      implementation_exit=$?
      if (( implementation_exit != 0 )); then
        printf 'Automatic cycle stopped during Claude implementation (exit %s).\n' "$implementation_exit" >&2
        exit "$implementation_exit"
      fi

      implementation_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
      base_commit="$(git -C "$ROOT_DIR" rev-parse "$implementation_commit^")"

      printf '\n=== Codex review round %s/%s ===\n' "$((current_round + 1))" "$max_rounds"
      AGENT_CYCLE_LOCK_HELD=1 "$ROOT_DIR/scripts/run-review.sh" "$implementation_commit" "$base_commit"
      review_exit=$?
      if (( review_exit != 0 )); then
        printf 'Automatic cycle stopped during Codex review (exit %s).\n' "$review_exit" >&2
        exit "$review_exit"
      fi

      reviewed_round="$(state_value CURRENT_ROUND)"
      verdict="$(state_value LAST_REVIEW_VERDICT)"
      commit_review_handoff "$reviewed_round"
      handoff_exit=$?
      if (( handoff_exit != 0 )); then
        printf 'Automatic cycle stopped while checkpointing the review (exit %s).\n' "$handoff_exit" >&2
        exit "$handoff_exit"
      fi

      review_checkpoint="$(git -C "$ROOT_DIR" rev-parse HEAD)"
      printf 'Review checkpoint: %s\n' "$review_checkpoint"
      printf 'Verdict: %s\n' "$verdict"

      if [[ "$verdict" == "PASS" ]]; then
        printf 'Automatic Agent cycle completed successfully.\n'
        exit 0
      fi
      if [[ "$verdict" != "CHANGES_REQUIRED" ]]; then
        printf 'Unknown review verdict; stopping: %s\n' "$verdict" >&2
        exit 4
      fi
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
    if (( $# != 0 )); then
      usage >&2
      exit 2
    fi
    printf 'Git status\n'
    git -C "$ROOT_DIR" status --short --branch
    printf '\nAgent state\n'
    sed -n '1,140p' "$STATE_FILE"
    printf '\nActive task\n'
    sed -n '1,24p' "$ROOT_DIR/.agent/next-task.md"
    printf '\nLatest review status\n'
    grep -E '^(REVIEW_STATUS|VERDICT):' "$ROOT_DIR/.agent/latest-review.md" || printf 'No status marker found.\n'
    if [[ -f "$ROOT_DIR/.agent/artifacts/validation/summary.md" ]]; then
      printf '\nLatest validation\n'
      sed -n '1,14p' "$ROOT_DIR/.agent/artifacts/validation/summary.md"
    fi
    if [[ -f "$ROOT_DIR/.agent/artifacts/runtime/last-stop.env" ]]; then
      printf '\nLatest automatic stop\n'
      sed -n '1,12p' "$ROOT_DIR/.agent/artifacts/runtime/last-stop.env"
    fi
    if [[ -f "$ROOT_DIR/.agent/artifacts/cycle/latest-summary.md" ]]; then
      printf '\nLatest cycle summary\n'
      printf '%s\n' '.agent/artifacts/cycle/latest-summary.md'
    fi
    ;;
  summary)
    if (( $# != 0 )); then
      usage >&2
      exit 2
    fi
    summary_path="$("$SUMMARY_SCRIPT")" || exit $?
    sed -n '1,320p' "$summary_path"
    ;;
  archive)
    if (( $# != 0 )); then
      usage >&2
      exit 2
    fi
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
  *)
    printf 'Unknown command: %s\n\n' "$command_name" >&2
    usage >&2
    exit 2
    ;;
esac
