#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: claude.sh <IMPLEMENTER|REVIEWER|MONITOR> <model> <effort> <prompt-file> <output-file>

Runs one Claude Code process using the permission profile for the assigned role.
For REVIEWER or MONITOR, output-file receives the final Markdown report.
EOF
}

if (( $# != 5 )); then
  usage >&2
  exit 2
fi

role="$1"
model="$2"
effort="$3"
prompt_file="$4"
output_file="$5"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ ! -s "$prompt_file" ]]; then
  printf 'Prompt file is missing or empty: %s\n' "$prompt_file" >&2
  exit 2
fi

prompt_text="$(<"$prompt_file")"
session_id="${AGENT_SESSION_ID:-}"
session_mode="${AGENT_SESSION_MODE:-$([[ "$role" == "MONITOR" ]] && printf ephemeral || printf new)}"
event_file="${AGENT_EVENT_FILE:-$([[ "$role" == "MONITOR" ]] && printf '%s.events.json' "$output_file")}"
telemetry_script="$root_dir/scripts/lib/agent-telemetry.mjs"
max_turns="${AGENT_CLAUDE_MAX_TURNS:-}"
max_budget_usd="${AGENT_CLAUDE_MAX_BUDGET_USD:-}"

if [[ -z "$event_file" ]]; then
  printf 'AGENT_EVENT_FILE is required for persistent Claude runs.\n' >&2
  exit 2
fi
mkdir -p "$(dirname "$event_file")"

limit_args=()
if [[ -n "$max_turns" ]]; then
  [[ "$max_turns" =~ ^[1-9][0-9]*$ ]] || {
    printf 'AGENT_CLAUDE_MAX_TURNS must be a positive integer.\n' >&2
    exit 2
  }
  limit_args+=(--max-turns "$max_turns")
fi
if [[ -n "$max_budget_usd" ]]; then
  [[ "$max_budget_usd" =~ ^[0-9]+([.][0-9]{1,4})?$ ]] || {
    printf 'AGENT_CLAUDE_MAX_BUDGET_USD must be a positive decimal.\n' >&2
    exit 2
  }
  limit_args+=(--max-budget-usd "$max_budget_usd")
fi

session_args=()
case "$session_mode" in
  new)
    [[ -n "$session_id" ]] || {
      printf 'A new Claude session requires AGENT_SESSION_ID.\n' >&2
      exit 2
    }
    session_args=(--session-id "$session_id")
    ;;
  resume)
    [[ -n "$session_id" ]] || {
      printf 'A resumed Claude session requires AGENT_SESSION_ID.\n' >&2
      exit 2
    }
    session_args=(--resume "$session_id")
    ;;
  ephemeral)
    [[ "$role" == "MONITOR" ]] || {
      printf 'Ephemeral Claude sessions are reserved for MONITOR.\n' >&2
      exit 2
    }
    session_args=(--no-session-persistence)
    ;;
  *)
    printf 'Invalid AGENT_SESSION_MODE: %s\n' "$session_mode" >&2
    exit 2
    ;;
esac

run_claude() {
  local permission_tools="$1"
  local denied_tools="$2"

  claude --print \
    --model "$model" \
    --effort "$effort" \
    --permission-mode dontAsk \
    --exclude-dynamic-system-prompt-sections \
    --prompt-suggestions false \
    --output-format json \
    "${limit_args[@]}" \
    "${session_args[@]}" \
    --allowedTools "$permission_tools" \
    --disallowedTools "$denied_tools" \
    -- "$prompt_text" >"$event_file"
}

emit_final() {
  if [[ "$output_file" == "-" ]]; then
    node "$telemetry_script" final claude "$event_file"
  else
    node "$telemetry_script" final claude "$event_file" "$output_file"
  fi
}

case "$role" in
  IMPLEMENTER)
    if run_claude \
      "Read(./**),Write(./**),Edit(./**),Glob,Grep,Bash(./scripts/run-validation.sh),Bash(npm run *),Bash(npm test),Bash(npm install *),Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git rev-parse *),Bash(git ls-files *),Bash(rg *),Bash(find *),Bash(sed *),Bash(ls *),Bash(curl http://localhost:*),Bash(curl http://127.0.0.1:*),WebSearch,WebFetch,mcp__playwright__*" \
      "NotebookEdit,Bash(git add *),Bash(git commit *),Bash(git push *),Bash(git reset *),Bash(git clean *),Bash(git checkout *),Bash(git switch *),Bash(git rebase *),Bash(git rm *),Bash(rm -rf *),Bash(sudo *),Bash(env),Bash(printenv *),Task,Agent"; then
      emit_final
    else
      claude_exit=$?
      [[ -s "$event_file" ]] && sed -n '1,80p' "$event_file"
      exit "$claude_exit"
    fi
    ;;
  REVIEWER|MONITOR)
    if [[ "$output_file" == "-" ]]; then
      printf 'Claude %s requires a report output file.\n' "$role" >&2
      exit 2
    fi
    if run_claude \
      "Read(./**),Glob,Grep,Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git rev-parse *),Bash(git ls-files *),Bash(rg *),Bash(find *),Bash(sed *),Bash(ls *),Bash(curl http://localhost:*),Bash(curl http://127.0.0.1:*),WebSearch,WebFetch,mcp__playwright__*" \
      "Write,Edit,NotebookEdit,Bash(npm install *),Bash(git add *),Bash(git commit *),Bash(git push *),Bash(git reset *),Bash(git clean *),Bash(git checkout *),Bash(git switch *),Bash(git rebase *),Bash(git rm *),Bash(rm *),Bash(sudo *),Bash(env),Bash(printenv *),Task,Agent"; then
      emit_final
    else
      claude_exit=$?
      [[ -s "$event_file" ]] && sed -n '1,80p' "$event_file"
      exit "$claude_exit"
    fi
    ;;
  *)
    printf 'Unsupported Claude role: %s\n' "$role" >&2
    exit 2
    ;;
esac
