#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: codex.sh <GENERAL|IMPLEMENTER|REVIEWER> <model> <effort> <prompt-file> <output-file>

Runs one Codex process using the sandbox profile for the assigned role.
For GENERAL or REVIEWER, output-file receives the final Markdown report.
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
session_mode="${AGENT_SESSION_MODE:-$([[ "$role" == "GENERAL" ]] && printf ephemeral || printf new)}"
event_file="${AGENT_EVENT_FILE:-$([[ "$role" == "GENERAL" ]] && printf '%s.events.jsonl' "$output_file")}"

if [[ -z "$event_file" ]]; then
  printf 'AGENT_EVENT_FILE is required for persistent Codex runs.\n' >&2
  exit 2
fi
mkdir -p "$(dirname "$event_file")"

run_codex() {
  local sandbox="$1"
  local network="$2"
  local output_args=()

  if [[ "$output_file" != "-" ]]; then
    output_args=(--output-last-message "$output_file")
  fi

  case "$session_mode" in
    new)
      codex exec \
        --cd "$root_dir" \
        --model "$model" \
        --sandbox "$sandbox" \
        --color never \
        -c 'approval_policy="never"' \
        -c "model_reasoning_effort=\"$effort\"" \
        -c "sandbox_workspace_write.network_access=$network" \
        --json \
        "${output_args[@]}" \
        "$prompt_text" | tee "$event_file"
      ;;
    resume)
      [[ -n "$session_id" ]] || {
        printf 'A resumed Codex session requires AGENT_SESSION_ID.\n' >&2
        return 2
      }
      codex exec \
        --cd "$root_dir" \
        --sandbox "$sandbox" \
        --color never \
        -c 'approval_policy="never"' \
        -c "model_reasoning_effort=\"$effort\"" \
        -c "sandbox_workspace_write.network_access=$network" \
        --json \
        resume \
        --model "$model" \
        "${output_args[@]}" \
        "$session_id" "$prompt_text" | tee "$event_file"
      ;;
    ephemeral)
      [[ "$role" == "GENERAL" ]] || {
        printf 'Ephemeral Codex sessions are reserved for GENERAL supervisor events.\n' >&2
        return 2
      }
      codex exec \
        --cd "$root_dir" \
        --model "$model" \
        --sandbox "$sandbox" \
        --ephemeral \
        --color never \
        -c 'approval_policy="never"' \
        -c "model_reasoning_effort=\"$effort\"" \
        -c "sandbox_workspace_write.network_access=$network" \
        --json \
        "${output_args[@]}" \
        "$prompt_text" | tee "$event_file"
      ;;
    *)
      printf 'Invalid AGENT_SESSION_MODE: %s\n' "$session_mode" >&2
      return 2
      ;;
  esac
}

case "$role" in
  IMPLEMENTER)
    run_codex workspace-write true
    ;;
  GENERAL|REVIEWER)
    if [[ "$output_file" == "-" ]]; then
      printf 'Codex %s requires a report output file.\n' "$role" >&2
      exit 2
    fi
    run_codex read-only false
    ;;
  *)
    printf 'Unsupported Codex role: %s\n' "$role" >&2
    exit 2
    ;;
esac
