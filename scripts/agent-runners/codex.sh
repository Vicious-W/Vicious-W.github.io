#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: codex.sh <IMPLEMENTER|REVIEWER|MONITOR> <model> <effort> <prompt-file> <output-file>

Runs one Codex process using the sandbox profile for the assigned role.
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

case "$role" in
  IMPLEMENTER)
    exec codex exec \
      --cd "$root_dir" \
      --model "$model" \
      --sandbox workspace-write \
      --ephemeral \
      --color never \
      -c 'approval_policy="never"' \
      -c "model_reasoning_effort=\"$effort\"" \
      -c 'sandbox_workspace_write.network_access=true' \
      "$prompt_text"
    ;;
  REVIEWER|MONITOR)
    if [[ "$output_file" == "-" ]]; then
      printf 'Codex %s requires a report output file.\n' "$role" >&2
      exit 2
    fi
    exec codex exec \
      --cd "$root_dir" \
      --model "$model" \
      --sandbox read-only \
      --ephemeral \
      --color never \
      -c 'approval_policy="never"' \
      -c "model_reasoning_effort=\"$effort\"" \
      --output-last-message "$output_file" \
      "$prompt_text"
    ;;
  *)
    printf 'Unsupported Codex role: %s\n' "$role" >&2
    exit 2
    ;;
esac
