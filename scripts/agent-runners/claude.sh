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

if [[ ! -s "$prompt_file" ]]; then
  printf 'Prompt file is missing or empty: %s\n' "$prompt_file" >&2
  exit 2
fi

prompt_text="$(<"$prompt_file")"

case "$role" in
  IMPLEMENTER)
    exec claude --print \
      --model "$model" \
      --effort "$effort" \
      --permission-mode dontAsk \
      --no-session-persistence \
      --output-format text \
      --allowedTools "Read(./**),Write(./**),Edit(./**),Glob,Grep,Bash(./scripts/run-validation.sh),Bash(npm run *),Bash(npm install *),Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git rev-parse *),Bash(git ls-files *),Bash(rg *),Bash(find *),Bash(sed *),Bash(ls *),Bash(curl http://localhost:*),Bash(curl http://127.0.0.1:*),WebSearch,WebFetch,mcp__playwright__*" \
      --disallowedTools "NotebookEdit,Bash(git add *),Bash(git commit *),Bash(git push *),Bash(git reset *),Bash(git clean *),Bash(git checkout *),Bash(git switch *),Bash(git rebase *),Bash(git rm *),Bash(rm -rf *),Bash(sudo *),Bash(env),Bash(printenv *),Task,Agent" \
      -- "$prompt_text"
    ;;
  REVIEWER|MONITOR)
    if [[ "$output_file" == "-" ]]; then
      printf 'Claude %s requires a report output file.\n' "$role" >&2
      exit 2
    fi
    claude --print \
      --model "$model" \
      --effort "$effort" \
      --permission-mode dontAsk \
      --no-session-persistence \
      --output-format text \
      --allowedTools "Read(./**),Glob,Grep,Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git rev-parse *),Bash(git ls-files *),Bash(rg *),Bash(find *),Bash(sed *),Bash(ls *),Bash(curl http://localhost:*),Bash(curl http://127.0.0.1:*),WebSearch,WebFetch,mcp__playwright__*" \
      --disallowedTools "Write,Edit,NotebookEdit,Bash(npm install *),Bash(git add *),Bash(git commit *),Bash(git push *),Bash(git reset *),Bash(git clean *),Bash(git checkout *),Bash(git switch *),Bash(git rebase *),Bash(git rm *),Bash(rm *),Bash(sudo *),Bash(env),Bash(printenv *),Task,Agent" \
      -- "$prompt_text" >"$output_file"
    ;;
  *)
    printf 'Unsupported Claude role: %s\n' "$role" >&2
    exit 2
    ;;
esac
