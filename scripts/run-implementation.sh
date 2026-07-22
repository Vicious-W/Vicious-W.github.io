#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
ARTIFACT_DIR="$AGENT_DIR/artifacts/implementation"
STATE_FILE="$AGENT_DIR/state.env"
TASK_FILE="$AGENT_DIR/next-task.md"
REPORT_FILE="$AGENT_DIR/implementation-report.md"
LOCK_DIR="$AGENT_DIR/.cycle.lock"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-implementation.sh

Runs exactly one non-interactive Claude Code implementation round for the active
.agent/next-task.md. The working tree must start clean. Claude may edit the
workspace but may not stage, commit, push, reset, clean, switch branches, or
deploy. The wrapper validates and creates one local implementation checkpoint.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if (( $# != 0 )); then
  usage >&2
  exit 2
fi

mkdir -p "$ARTIFACT_DIR"

lock_owned=0
if [[ "${AGENT_CYCLE_LOCK_HELD:-0}" != "1" ]]; then
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    printf 'Another Agent workflow appears to be active: %s\n' "$LOCK_DIR" >&2
    exit 2
  fi
  lock_owned=1
fi

cleanup() {
  if (( lock_owned == 1 )); then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

dirty_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
if [[ -n "$dirty_status" ]]; then
  printf 'Refusing Claude implementation because the Git working tree is not clean.\n' >&2
  printf '%s\n' "$dirty_status" >&2
  printf 'Create a safe checkpoint first; this script will not discard or absorb pre-existing changes.\n' >&2
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  printf 'claude CLI is not available on PATH.\n' >&2
  exit 127
fi

if [[ ! -s "$TASK_FILE" ]]; then
  printf 'Active task file is missing or empty: %s\n' "$TASK_FILE" >&2
  exit 2
fi

active_task_id="$(sed -n 's/^ACTIVE_TASK_ID=//p' "$STATE_FILE" | head -n 1)"
active_task_status="$(sed -n 's/^ACTIVE_TASK_STATUS=//p' "$STATE_FILE" | head -n 1)"
current_round="$(sed -n 's/^CURRENT_ROUND=//p' "$STATE_FILE" | head -n 1)"
max_rounds="$(sed -n 's/^MAX_ROUNDS=//p' "$STATE_FILE" | head -n 1)"

[[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
[[ "$max_rounds" =~ ^[1-9][0-9]*$ ]] || max_rounds=3

if [[ -z "$active_task_id" ]]; then
  printf 'ACTIVE_TASK_ID is empty in %s.\n' "$STATE_FILE" >&2
  exit 2
fi
if [[ "$active_task_status" != "READY" && "$active_task_status" != "NEEDS_CHANGES" ]]; then
  printf 'Active task is not ready for implementation: %s\n' "$active_task_status" >&2
  exit 3
fi
if (( current_round >= max_rounds )); then
  printf 'Maximum review rounds reached (%s). Stop and return control to the project owner.\n' "$max_rounds" >&2
  exit 3
fi

implementation_round=$((current_round + 1))
base_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
prompt_file="$ARTIFACT_DIR/prompt-round-${implementation_round}.md"
claude_log="$ARTIFACT_DIR/claude-round-${implementation_round}.log"

cat >"$prompt_file" <<EOF
You are Claude Code, the sole implementation Agent for this repository. Execute
exactly one bounded implementation round for task $active_task_id (round
$implementation_round of at most $max_rounds).

Read, in order: PROJECT_SPEC.md, CLAUDE.md, REVIEW_CONTRACT.md,
.agent/next-task.md, .agent/latest-review.md, .agent/implementation-report.md,
PROJECT.md, the current Git status, and all directly relevant code.

Implement the active task comprehensively. If the latest Codex verdict is
CHANGES_REQUIRED, address every valid Blocker and Major first. Make reasonable
technical decisions within the owner's approved scope; do not invent unrelated
features. For reactor accuracy, research public authoritative sources and record
the selected archetype, URLs, modeling choices, and deliberate abstractions in
PROJECT.md and .agent/implementation-report.md.

You may edit source, styles, tests, project documentation, and validation tooling.
Do not modify PROJECT_SPEC.md, REVIEW_CONTRACT.md, AGENTS.md,
.agent/next-task.md, .agent/latest-review.md, .agent/state.env, or any file under
.agent/review-history/. Do not stage or commit: the outer wrapper creates the Git
checkpoint after validation. Never push, deploy, reset, clean, rebase, switch
branches, delete owner files, or expose credentials.

Run ./scripts/run-validation.sh. Because this task changes page appearance and
behavior, start/reuse the local Vite preview and use Playwright MCP—not a Bash
Playwright script—to exercise the required desktop, tablet, and mobile viewports,
glass dragging/stacking/audio activation, reactor behavior, responsive layout, and
browser console. Preserve evidence in ignored .agent/artifacts paths when useful.

Before finishing, replace .agent/implementation-report.md with a complete report
matching its documented format and update PROJECT.md sections 5 and 7. Report
passes, failures, NOT CONFIGURED items, unverified areas, remaining risks, and the
exact handoff focus for Codex. Then stop. Do not merely describe a plan: implement
and verify as much of the approved task as can be completed safely in this round.

Base commit at launch: $base_commit
EOF

printf 'Starting Claude Code implementation round %s/%s for %s\n' "$implementation_round" "$max_rounds" "$active_task_id"

prompt_text="$(<"$prompt_file")"
claude --print \
  --permission-mode acceptEdits \
  --no-session-persistence \
  --output-format text \
  --allowedTools "Bash(npm run *),Bash(npm install *),Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git rev-parse *),Bash(rg *),Bash(find *),Bash(sed *),Bash(ls *),Bash(curl http://localhost:*)" \
  --disallowedTools "Bash(git add *),Bash(git commit *),Bash(git push *),Bash(git reset *),Bash(git clean *),Bash(git checkout *),Bash(git switch *),Bash(git rebase *),Bash(rm -rf *)" \
  -- "$prompt_text" >"$claude_log" 2>&1
claude_exit=$?

if (( claude_exit != 0 )); then
  printf 'Claude Code failed (exit %s). Changes, if any, were left untouched for inspection.\n' "$claude_exit" >&2
  printf 'Log: %s\n' "$claude_log" >&2
  exit "$claude_exit"
fi

if [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$base_commit" ]]; then
  printf 'Claude changed Git history despite the boundary. Stopping without further mutation.\n' >&2
  exit 4
fi

implementation_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
if [[ -z "$implementation_status" ]]; then
  printf 'Claude completed without producing any repository changes. No checkpoint created.\n' >&2
  exit 5
fi

if grep -Fq 'IMPLEMENTATION_STATUS: NOT_REPORTED' "$REPORT_FILE"; then
  printf 'Claude did not replace the implementation report. Changes were left uncommitted.\n' >&2
  exit 5
fi

if "$ROOT_DIR/scripts/run-validation.sh"; then
  validation_status="PASS"
  validation_exit=0
else
  validation_exit=$?
  validation_status="FAIL"
fi

{
  printf '\n## Automation wrapper result\n\n'
  printf -- '- Base commit: `%s`\n' "$base_commit"
  printf -- '- Claude process: PASS (exit 0)\n'
  printf -- '- Unified validation: %s (exit %s)\n' "$validation_status" "$validation_exit"
  printf -- '- Checkpoint: created by `scripts/run-implementation.sh` after this report\n'
} >>"$REPORT_FILE"

if ! git -C "$ROOT_DIR" add --all; then
  printf 'Could not stage the implementation checkpoint. Changes were preserved.\n' >&2
  exit 4
fi
if git -C "$ROOT_DIR" diff --cached --quiet; then
  printf 'No staged changes remained after implementation.\n' >&2
  exit 5
fi

commit_message="agent: implementation round $implementation_round"
git -C "$ROOT_DIR" commit -m "$commit_message" >"$ARTIFACT_DIR/git-commit-round-${implementation_round}.log" 2>&1
commit_exit=$?
if (( commit_exit != 0 )); then
  printf 'Could not create implementation checkpoint (exit %s). Staged changes were preserved.\n' "$commit_exit" >&2
  printf 'Log: %s\n' "$ARTIFACT_DIR/git-commit-round-${implementation_round}.log" >&2
  exit "$commit_exit"
fi

result_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]]; then
  printf 'Implementation checkpoint was created but the working tree is not clean. Stopping.\n' >&2
  git -C "$ROOT_DIR" status --short >&2
  exit 4
fi

printf 'Claude implementation checkpoint: %s\n' "$result_commit"
printf 'Unified validation before checkpoint: %s\n' "$validation_status"
printf 'Claude log: %s\n' "$claude_log"
