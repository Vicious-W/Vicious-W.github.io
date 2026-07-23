#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
STATE_FILE="$AGENT_DIR/state.env"
RUNTIME_FILE="$AGENT_DIR/runtime.env"
STOP_FILE="$AGENT_DIR/artifacts/runtime/last-stop.env"
OUTPUT_DIR="$AGENT_DIR/artifacts/cycle"
OUTPUT_FILE="$OUTPUT_DIR/latest-summary.md"
HISTORY_DIR="$OUTPUT_DIR/history"
CYCLE_EXIT="${1:-}"

state_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$STATE_FILE" 2>/dev/null | head -n 1
}

runtime_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$RUNTIME_FILE" 2>/dev/null | head -n 1
}

stop_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$STOP_FILE" 2>/dev/null | head -n 1
}

report_change_titles() {
  awk '
    $0 == "## Changes made" { active = 1; next }
    active && /^## / { exit }
    active && /^### / {
      line = $0
      sub(/^### /, "", line)
      sub(/^[^:]+: /, "", line)
      print line
    }
  ' "$1"
}

report_findings() {
  awk '
    /^## (Blocker|Major|Minor|Suggestions)$/ {
      section = $2
      next
    }
    /^## / { section = "" }
    section != "" && /^### / {
      line = $0
      sub(/^### /, "", line)
      printf "%s\t%s\n", section, line
    }
  ' "$1"
}

join_changed_files() {
  git -C "$ROOT_DIR" diff-tree --no-commit-id --name-only -r "$1" |
    awk 'BEGIN { first = 1 } {
      if (!first) printf ", "
      printf "%s", $0
      first = 0
    } END { print "" }'
}

mkdir -p "$OUTPUT_DIR" "$HISTORY_DIR"
summary_tmp="$(mktemp /tmp/agent-cycle-summary.XXXXXX)"
report_tmp="$(mktemp /tmp/agent-cycle-report.XXXXXX)"
cleanup() {
  rm -f -- "$summary_tmp" "$report_tmp"
}
trap cleanup EXIT

task_id="$(state_value ACTIVE_TASK_ID)"
task_slug="$(printf '%s' "${task_id:-unknown}" | tr -c '[:alnum:]_.-' '_')"
task_status="$(state_value ACTIVE_TASK_STATUS)"
current_round="$(state_value CURRENT_ROUND)"
max_rounds="$(state_value MAX_ROUNDS)"
last_verdict="$(state_value LAST_REVIEW_VERDICT)"
[[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
[[ "$max_rounds" =~ ^[1-9][0-9]*$ ]] || max_rounds=3

round_one_commit="$(
  git -C "$ROOT_DIR" log -n 1 --format='%H' \
    --grep='^agent: implementation round 1$' HEAD 2>/dev/null
)"
if [[ -n "$round_one_commit" ]] && \
   cycle_base="$(git -C "$ROOT_DIR" rev-parse "$round_one_commit^" 2>/dev/null)"; then
  :
else
  cycle_base="$(git -C "$ROOT_DIR" rev-parse HEAD)"
fi

declare -A implementation_commits=()
declare -A review_commits=()
while IFS=$'\t' read -r commit subject; do
  if [[ "$subject" =~ ^agent:\ implementation\ round\ ([0-9]+)$ ]]; then
    implementation_commits["${BASH_REMATCH[1]}"]="$commit"
  elif [[ "$subject" =~ ^agent:\ codex\ review\ round\ ([0-9]+)$ ]]; then
    review_commits["${BASH_REMATCH[1]}"]="$commit"
  fi
done < <(
  git -C "$ROOT_DIR" log --reverse --format='%H%x09%s' \
    "$cycle_base..HEAD" 2>/dev/null
)

stop_stage="$(stop_value STAGE)"
stop_reason="$(stop_value STOP_REASON)"
stop_exit="$(stop_value EXIT_CODE)"
stop_time="$(stop_value STOPPED_AT_UTC)"
display_rounds="$current_round"
if [[ "$stop_stage" == "CLAUDE" ]] && (( current_round < max_rounds )); then
  display_rounds=$((current_round + 1))
fi
(( display_rounds > 0 )) || display_rounds=1
(( display_rounds <= max_rounds )) || display_rounds="$max_rounds"

{
  printf '# Agent cycle summary\n\n'
  printf -- '- Generated: `%s`\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- Task: `%s`\n' "${task_id:-unknown}"
  printf -- '- Status: `%s`\n' "${task_status:-unknown}"
  printf -- '- Completed reviews: `%s/%s`\n' "$current_round" "$max_rounds"
  printf -- '- Latest verdict: `%s`\n' "${last_verdict:-NOT_REVIEWED}"
  printf -- '- Cycle base: `%s`\n' "$cycle_base"
  if [[ -n "$CYCLE_EXIT" ]]; then
    printf -- '- Parent exit code: `%s`\n' "$CYCLE_EXIT"
  fi
  if [[ -n "$stop_reason" ]]; then
    printf -- '- Latest stop: `%s / %s / exit %s` at `%s`\n' \
      "${stop_stage:-unknown}" "$stop_reason" "${stop_exit:-unknown}" "${stop_time:-unknown}"
  fi
  printf -- '- Model policy: Claude `%s` / `%s`; Codex `%s` / `%s`\n' \
    "$(runtime_value CLAUDE_MODEL)" "$(runtime_value CLAUDE_EFFORT)" \
    "$(runtime_value CODEX_MODEL)" "$(runtime_value CODEX_REASONING_EFFORT)"
  printf '\n'

  for ((round = 1; round <= display_rounds; round++)); do
    printf '## Round %s\n\n' "$round"
    implementation_commit="${implementation_commits[$round]:-}"
    review_commit="${review_commits[$round]:-}"

    printf '### Claude implementation\n\n'
    if [[ -n "$implementation_commit" ]] && \
       git -C "$ROOT_DIR" show "$implementation_commit:.agent/implementation-report.md" \
         >"$report_tmp" 2>/dev/null; then
      printf -- '- Commit: `%s`\n' "$implementation_commit"
      printf -- '- Files: %s\n' "$(join_changed_files "$implementation_commit")"
      printf -- '- Main changes:\n'
      change_count=0
      while IFS= read -r change_title; do
        [[ -n "$change_title" ]] || continue
        printf '  - %s\n' "$change_title"
        change_count=$((change_count + 1))
      done < <(report_change_titles "$report_tmp")
      if (( change_count == 0 )); then
        printf '  - See the implementation report stored in this commit.\n'
      fi
      validation="$(
        sed -n 's/^- Unified validation: //p' "$report_tmp" | tail -n 1
      )"
      [[ -n "$validation" ]] && printf -- '- Validation: %s\n' "$validation"
      printf -- '- Details: `git show %s:.agent/implementation-report.md`\n' \
        "$implementation_commit"
    elif [[ "$stop_stage" == "CLAUDE" && "$round" == "$((current_round + 1))" ]]; then
      printf -- '- Result: interrupted before a valid implementation checkpoint.\n'
      printf -- '- Stop: `%s` (exit `%s`)\n' "${stop_reason:-unknown}" "${stop_exit:-unknown}"
      dirty_status="$(git -C "$ROOT_DIR" status --short)"
      if [[ -n "$dirty_status" ]]; then
        printf -- '- Preserved uncommitted paths:\n\n```text\n%s\n```\n' "$dirty_status"
      else
        printf -- '- No uncommitted paths remain in the working tree.\n'
      fi
      recovery_stash="$(
        git -C "$ROOT_DIR" stash list --format='%gd%x09%s' |
          awk -F '\t' -v round="$round" \
            '$2 ~ ("interrupted Claude implementation round " round) { print $1; exit }'
      )"
      if [[ -n "$recovery_stash" ]]; then
        printf -- '- Recoverable partial work: `%s`.\n' "$recovery_stash"
      fi
      printf -- '- Raw log: `.agent/artifacts/implementation/claude-round-%s.log`\n' "$round"
    else
      printf -- '- Not run or no valid checkpoint was created.\n'
    fi
    printf '\n'

    printf '### Codex review\n\n'
    if [[ -n "$review_commit" ]] && \
       git -C "$ROOT_DIR" show "$review_commit:.agent/latest-review.md" \
         >"$report_tmp" 2>/dev/null; then
      verdict="$(sed -n 's/^VERDICT: //p' "$report_tmp" | head -n 1)"
      reviewed_commit="$(
        sed -n 's/^- Reviewed commit: //p' "$report_tmp" | head -n 1
      )"
      printf -- '- Review commit: `%s`\n' "$review_commit"
      printf -- '- Reviewed implementation: `%s`\n' "${reviewed_commit:-unknown}"
      printf -- '- Verdict: `%s`\n' "${verdict:-unknown}"
      finding_count=0
      while IFS=$'\t' read -r severity finding_title; do
        [[ -n "$finding_title" ]] || continue
        if (( finding_count == 0 )); then
          printf -- '- Findings:\n'
        fi
        printf '  - **%s** — %s\n' "$severity" "$finding_title"
        finding_count=$((finding_count + 1))
      done < <(report_findings "$report_tmp")
      if (( finding_count == 0 )); then
        printf -- '- Findings: none.\n'
      fi
      printf -- '- Details: `git show %s:.agent/latest-review.md`\n' "$review_commit"
    else
      printf -- '- Not run.\n'
    fi
    printf '\n'
  done

  printf '## What to do next\n\n'
  if [[ "$task_status" == "COMPLETE" && "$last_verdict" == "PASS" ]]; then
    printf -- '- The automatic cycle passed. The owner can now evaluate subjective look and feel.\n'
  elif (( current_round >= max_rounds )); then
    printf -- '- The round limit was reached. Read the latest findings and make a product/technical decision before starting a new cycle.\n'
  elif [[ -n "$stop_reason" ]]; then
    printf -- '- Resolve the external or safety stop `%s`, then inspect the working tree before resuming.\n' "$stop_reason"
  else
    printf -- '- Continue from the latest Codex findings.\n'
  fi
  printf -- '- Full status: `./scripts/agent-cycle.sh status`\n'
  printf -- '- Regenerate this report: `./scripts/agent-cycle.sh summary`\n'
} >"$summary_tmp"

install -m 0644 "$summary_tmp" "$OUTPUT_FILE"
history_file="$HISTORY_DIR/$(date -u +'%Y-%m-%dT%H%M%SZ')_${task_slug}.md"
if [[ ! -e "$history_file" ]]; then
  install -m 0644 "$summary_tmp" "$history_file"
fi

printf '%s\n' "$OUTPUT_FILE"
